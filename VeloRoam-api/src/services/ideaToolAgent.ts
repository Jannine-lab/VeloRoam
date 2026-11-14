import { performance } from 'node:perf_hooks';
import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Candidate } from '../controllers/ideaController';
import { INTENT_PROMPT, TOOL_POLICY_PROMPT } from '../prompts/ideaPrompts';
import { candidateIdSchema, createIdeaChatModel, IdeaMetrics, parseIdeaOutput, recordIdeaUsage } from './ideaModel';
import { stableJson } from '../utils/stableJson';
import { getDistanceMeters } from '../utils/polyline';
import type { EnrouteToolResult } from './ideaAgentEnroute';

const searchSchema = z.object({ name: z.string().trim().min(2).max(80), terms: z.array(z.string().trim().min(2).max(80)).max(3) }).strict();
const resolveSchema = z.object({ name: z.string().trim().min(2).max(80) }).strict();
const detailSchema = z.object({ id: candidateIdSchema }).strict();
const nearbySchema = z.object({ centerId: candidateIdSchema.nullable(), radiusKm: z.number().finite().min(1).max(50), type: z.enum(['segment', 'point', 'all']) }).strict();
const planSchema = z.object({}).strict();
export const IDEA_TOOLS = [
  { name: 'search_candidates', description: '按用户提及的真实名称查询公开路段和活跃点位；相关结果不等同于精确匹配。', schema: searchSchema },
  { name: 'resolve_place', description: '通过地图服务解析具体地点。返回唯一位置或未确定，不代表区域边界。', schema: resolveSchema },
  { name: 'get_candidate_detail', description: '按本轮检索或会话已展示的候选ID重新读取公开记录；未找到时不得替换成另一条。', schema: detailSchema },
  { name: 'search_nearby_candidates', description: '按实际位置或已核实候选ID，在指定半径内检索公开骑行路段和活跃点位；结果不证明道路体验或安全。', schema: nearbySchema },
  { name: 'plan_cycling_route', description: '仅在用户确认需求后调用；使用服务端确认的起终点、途经顺序和预算生成完整骑行路线。无需也不允许自行修改参数。', schema: planSchema },
  { name: 'find_enroute_segments', description: '在本次已规划路线的实际连接线上寻找顺路路段，并按确认的预算验证完整路线。必须先成功调用plan_cycling_route。', schema: planSchema }
];
export type ToolModelCall = (messages: BaseMessage[], final: boolean, signal: AbortSignal, required?: boolean) => Promise<AIMessage>;
export type NearbyEvidence = { center: { lat: number; lng: number }; centerSource: string; radiusKm: number; type: 'segment' | 'point' | 'all'; candidates: Candidate[] };
export function wantsNearbyDiscovery(idea: string): boolean {
  return /附近|周边|周围|当前位置.{0,12}(?:公里|千米|km|范围)/i.test(idea) && /路段|地点|点位|补给|咖啡|绿道/.test(idea) &&
    /找|探索|推荐|查询|看看|有哪些/.test(idea) && !/(?:不要|不想|不需要|无需|避免|避开).{0,5}(?:附近|周边|周围)/.test(idea);
}

function bounded<T>(work: () => Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Agent deadline exceeded')); return; }
    const abort = () => finish(new Error('Agent deadline exceeded'));
    const timer = setTimeout(() => finish(new Error('Tool timeout')), timeoutMs);
    const finish = (error: Error | null, value?: T) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value as T);
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(work).then(value => finish(null, value), () => finish(new Error('Tool unavailable')));
  });
}

export async function runIdeaToolAgent(options: {
  input: object; search: (name: string, terms?: unknown) => Promise<Candidate[]>;
  detail?: (id: string, name: string) => Promise<Candidate | null>;
  resolve: (name: string) => Promise<{ lat: number; lng: number } | null>;
  nearby?: (center: { lat: number; lng: number }, radiusKm: number) => Promise<Candidate[]>;
  location?: { point: { lat: number; lng: number }; source: 'gps' | 'gps-stale' | 'ip' | 'manual' | 'provided_origin' | 'map_center' };
  onNearby?: (result: NearbyEvidence) => void;
  plan?: () => Promise<any>; explore?: () => Promise<EnrouteToolResult | null>; planTimeoutMs?: number;
  metrics: IdeaMetrics; callModel?: ToolModelCall; onProgress?: (stage: string) => void;
  deadlineMs?: number; toolTimeoutMs?: number;
}): Promise<any> {
  const { input, metrics } = options;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), options.deadlineMs ?? 60000);
  const availableTools = IDEA_TOOLS.filter(tool => (tool.name !== 'search_nearby_candidates' || !!options.nearby) &&
    (tool.name !== 'plan_cycling_route' || !!options.plan) && (tool.name !== 'find_enroute_segments' || !!options.explore));
  const callModel: ToolModelCall = options.callModel || ((messages, final, signal, required) => createIdeaChatModel()
    .bindTools(availableTools, { tool_choice: final ? 'none' : required ? 'required' : 'auto' }).invoke(messages, { signal }));
  const planningInstruction = options.plan ? '\n用户已确认路线需求。必须调用 plan_cycling_route，使用后端提供的已确认需求；不得猜测或改动预算、途经顺序和位置。规划成功后，如用户希望探索路线沿途，可调用 find_enroute_segments。其他工具仅在确有必要时使用。' : '';
  const messages: BaseMessage[] = [new SystemMessage(`${INTENT_PROMPT}\n${TOOL_POLICY_PROMPT}${planningInstruction}`), new HumanMessage(JSON.stringify(input))];
  const seen = new Map<string, { name: string }>();
  const context = (input as { placeContext?: { candidates?: Array<{ id: string; name: string }> } }).placeContext;
  for (const ref of context?.candidates || []) if (candidateIdSchema.safeParse(ref.id).success && typeof ref.name === 'string') seen.set(ref.id, ref);
  const cache = new Map<string, unknown>();
  const callIds = new Set<string>();
  let requireTool = false;
  let planCalled = false;
  const idea = typeof (input as { idea?: unknown }).idea === 'string' ? (input as { idea: string }).idea : '';
  const wantsNearby = !!options.nearby && !options.plan && wantsNearbyDiscovery(idea);
  let lookupEvidence: { name: string; terms: string[]; kind: string } | null = null;
  const summary = (item: Candidate) => {
    seen.set(item.id, { name: item.name });
    const { coordinates: _coordinates, ...fields } = item;
    return fields;
  };
  try {
    for (let round = 0; round < 3; round++) {
      const started = performance.now();
      metrics.modelCalls++;
      let message: AIMessage;
      try { message = await callModel(messages, round === 2 || metrics.toolCalls.length >= 4, controller.signal, requireTool); }
      finally { metrics.modelDurationMs += performance.now() - started; }
      recordIdeaUsage(metrics, message);
      if (message.response_metadata?.finish_reason === 'length' || message.invalid_tool_calls?.length) throw new Error('Invalid tool model response');
      const calls = message.tool_calls || [];
      if (!calls.length) {
        const intent = parseIdeaOutput(INTENT_PROMPT, message.content, input);
        if (options.plan && !planCalled && round < 2) {
          messages.push(message, new HumanMessage('已确认路线需求，请先调用 plan_cycling_route，再输出最终JSON。'));
          requireTool = true;
          continue;
        }
        if (wantsNearby && round === 0 && !metrics.toolCalls.length) {
          messages.push(message, new HumanMessage('用户明确要求查询附近候选，请先调用search_nearby_candidates，再输出最终JSON。'));
          requireTool = true;
          continue;
        }
        if (!intent.lookup?.name && lookupEvidence) intent.lookup = lookupEvidence;
        if (!metrics.toolCalls.length && (intent.lookup?.name || intent.selectedCandidateId)) {
          if (round > 0) throw new Error('Required grounding tool was not called');
          // JSON extraction can win over optional tool use. Enforce grounding before accepting it.
          messages.push(message, new HumanMessage('先核实上一条JSON中的具体地点或候选，再输出最终JSON。具名查询调用search_candidates；选择已展示候选调用get_candidate_detail。'));
          lookupEvidence = intent.lookup?.name ? intent.lookup : null;
          requireTool = true;
          continue;
        }
        return intent;
      }
      requireTool = false;
      messages.push(message);
      for (const call of calls) {
        const start = performance.now();
        let result: unknown;
        let status: 'ok' | 'cached' | 'invalid' | 'error' | 'budget' = 'ok';
        const definition = availableTools.find(tool => tool.name === call.name);
        const parsed = definition?.schema.safeParse(call.args);
        if (!call.id || callIds.has(call.id)) throw new Error('Missing or duplicate tool call id');
        callIds.add(call.id);
        if (round === 2 || metrics.toolCalls.length >= 4) { status = 'budget'; result = { error: 'tool_budget_exceeded' }; }
        else if (!definition || !parsed?.success) { status = 'invalid'; result = { error: 'invalid_tool_or_arguments' }; }
        else {
          const args = parsed.data as { name?: string; terms?: string[]; id?: string; centerId?: string | null; radiusKm?: number; type?: 'segment' | 'point' | 'all' };
          const key = `${call.name}:${stableJson(args)}`;
          if (cache.has(key)) { status = 'cached'; result = cache.get(key); }
          else {
            const stage = call.name === 'resolve_place' ? '正在解析地点' : call.name === 'search_nearby_candidates' ? '正在探索附近路段和地点' :
              call.name === 'plan_cycling_route' ? '正在规划并验证骑行路线' : call.name === 'find_enroute_segments' ? '正在探索顺路路段' : '正在核实路段与点位';
            options.onProgress?.(stage);
            try {
              const execute = async () => {
                if (call.name === 'search_candidates') {
                  // Keep the factual query grounded even if the model drops lookup in its final JSON.
                  lookupEvidence ??= { name: args.name!, terms: args.terms || [], kind: 'ambiguous' };
                  const candidates = (await options.search(args.name!, args.terms)).filter(x => x.hazardous !== true).slice(0, 8);
                  return { status: candidates.length ? 'found' : 'not_found', candidates: candidates.map(summary) };
                }
                if (call.name === 'resolve_place') {
                  const point = await options.resolve(args.name!);
                  return { status: point ? 'resolved' : 'unresolved', point };
                }
                if (call.name === 'search_nearby_candidates') {
                  const ref = args.centerId ? seen.get(args.centerId) : null;
                  if (args.centerId && !ref) return { status: 'not_found', candidates: [] };
                  const candidate = ref && args.centerId ? (options.detail ? await options.detail(args.centerId, ref.name) : (await options.search(ref.name, [])).find(item => item.id === args.centerId && item.hazardous !== true)) : null;
                  if (args.centerId && (!candidate || candidate.hazardous === true)) return { status: 'not_found', candidates: [] };
                  const center = candidate ? { lat: candidate.lat, lng: candidate.lng } : options.location?.point;
                  if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng) || Math.abs(center.lat) > 90 || Math.abs(center.lng) > 180) return { status: 'location_required', candidates: [] };
                  const candidates = (await options.nearby!(center, args.radiusKm!)).filter(item => item.hazardous !== true &&
                    (args.type === 'all' || item.type === args.type) && Number.isFinite(item.lat) && Number.isFinite(item.lng) && getDistanceMeters(center, item) <= args.radiusKm! * 1000).slice(0, 8);
                  options.onNearby?.({ center, centerSource: candidate ? 'candidate' : options.location!.source, radiusKm: args.radiusKm!, type: args.type!, candidates });
                  return { status: candidates.length ? 'found' : 'not_found', centerSource: candidate ? 'candidate' : options.location?.source, radiusKm: args.radiusKm, candidates: candidates.map(summary) };
                }
                if (call.name === 'plan_cycling_route') {
                  planCalled = true;
                  const result = await options.plan!();
                  const route = result?.route;
                  if (!route) return { status: 'unavailable', message: typeof result?.message === 'string' ? result.message.slice(0, 200) : '无法生成路线' };
                  return { status: 'planned', distanceKm: route.distanceKm, durationMin: route.durationMin, hasEstimatedTime: route.hasEstimatedTime,
                    stops: Array.isArray(route.stops) ? route.stops.slice(0, 12).map((stop: any) => ({ name: stop.name, type: stop.type })) : [],
                    note: typeof result.note === 'string' ? result.note.slice(0, 500) : '' };
                }
                if (call.name === 'find_enroute_segments') {
                  const exploration = await options.explore!();
                  if (!exploration) return { status: 'plan_required' };
                  return { status: exploration.status, added: exploration.added, extraKm: exploration.extraKm,
                    distanceKm: exploration.result.route?.distanceKm ?? null, durationMin: exploration.result.route?.durationMin ?? null };
                }
                const ref = seen.get(args.id!);
                if (!ref) return { status: 'not_found', candidate: null };
                const candidate = options.detail ? await options.detail(args.id!, ref.name) : (await options.search(ref.name, [])).find(item => item.id === args.id && item.hazardous !== true);
                return { status: candidate ? 'found' : 'not_found', candidate: candidate ? summary(candidate) : null };
              };
              const tool = new DynamicTool({
                name: definition.name,
                description: definition.description,
                func: () => bounded(execute, controller.signal, ['plan_cycling_route', 'find_enroute_segments'].includes(call.name) ? (options.planTimeoutMs ?? 45000) : (options.toolTimeoutMs ?? 8000))
              });
              result = await tool.invoke(JSON.stringify(args), { runName: definition.name });
              if (!(call.name === 'find_enroute_segments' && (result as { status?: string })?.status === 'plan_required')) cache.set(key, result);
            } catch { status = 'error'; result = { error: 'tool_unavailable' }; }
          }
        }
        metrics.toolCalls.push({ name: call.name, status, durationMs: Math.round(performance.now() - start) });
        messages.push(new ToolMessage({ tool_call_id: call.id, content: JSON.stringify(result) }));
      }
    }
    throw new Error('Agent tool budget exceeded');
  } finally { clearTimeout(deadline); controller.abort(); }
}
