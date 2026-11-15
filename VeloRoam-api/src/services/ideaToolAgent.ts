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
import { ROUTE_TAGS, RouteTag } from './ideaIntent';
import { attributeMatch, placesAlongRoute, compareOptions, validateOption, RouteOption } from './ideaAgentRouteTools';
import type { ConversationIntent } from './ideaIntent';
import type { RouteBounds } from './ideaCandidatePlanner';
import { segmentSearchSchema, SegmentSearchInput, searchSegments } from './ideaSegmentSearch';
import { pointSearchSchema, PointSearchInput, searchPoints } from './ideaPointSearch';

const searchSchema = z.object({ name: z.string().trim().min(2).max(80), terms: z.array(z.string().trim().min(2).max(80)).max(3) }).strict();
const resolveSchema = z.object({ name: z.string().trim().min(2).max(80) }).strict();
const detailSchema = z.object({ id: candidateIdSchema }).strict();
const nearbySchema = z.object({ centerId: candidateIdSchema.nullable(), radiusKm: z.number().finite().min(1).max(50), type: z.enum(['segment', 'point', 'all']) }).strict();
const planSchema = z.object({}).strict();
const attributeSchema = z.object({ radiusKm: z.number().finite().min(1).max(50), preferred: z.array(z.enum(ROUTE_TAGS)).max(6), avoid: z.array(z.enum(ROUTE_TAGS)).max(6), minScore: z.number().finite().min(0).max(10000).nullable(), minKm: z.number().finite().min(0).max(1000).nullable(), maxKm: z.number().finite().min(0).max(1000).nullable() }).strict().refine(x => x.minKm == null || x.maxKm == null || x.minKm <= x.maxKm);
const alongSchema = z.object({ routeId: z.string().regex(/^(baseline|alternative:[12])$/), radiusKm: z.number().finite().min(.1).max(5), kind: z.string().trim().min(1).max(40).nullable() }).strict();
const routeIdSchema = z.object({ routeId: z.string().regex(/^(baseline|alternative:[12])$/) }).strict();
const expandedSchema = z.object({ query: z.string().trim().min(2).max(32), radiusKm: z.number().finite().min(1).max(50), type: z.enum(['segment', 'point', 'all']) }).strict();
export const IDEA_TOOLS = [
  { name: 'search_candidates', description: '按用户提及的真实名称查询公开路段和活跃点位；相关结果不等同于精确匹配。', schema: searchSchema },
  { name: 'search_expanded_candidates', description: '按用户表达的骑行主题，在提供的位置范围内使用关联词探索候选；名称相关不代表实际骑行体验已核实。', schema: expandedSchema },
  { name: 'resolve_place', description: '通过地图服务解析具体地点。返回唯一位置或未确定，不代表区域边界。', schema: resolveSchema },
  { name: 'get_candidate_detail', description: '按本轮检索或会话已展示的候选ID重新读取公开记录；未找到时不得替换成另一条。', schema: detailSchema },
  { name: 'search_nearby_candidates', description: '按实际位置或已核实候选ID，在指定半径内检索公开骑行路段和活跃点位；结果不证明道路体验或安全。', schema: nearbySchema },
  { name: 'plan_cycling_route', description: '仅在用户确认需求后调用；使用服务端确认的起终点、途经顺序和预算生成完整骑行路线。无需也不允许自行修改参数。', schema: planSchema },
  { name: 'find_enroute_segments', description: '在本次已规划路线的实际连接线上寻找顺路路段，并按确认的预算验证完整路线。必须先成功调用plan_cycling_route。', schema: planSchema },
  { name: 'search_segments_by_attributes', description: '在当前位置附近按已核实路段属性、评分及长度搜索；属性未知不能作为匹配。', schema: attributeSchema },
  { name: 'search_segments', description: '组合名称关联词、区域或当前位置、路段记录距离、平均坡度、爬升、评分、人数、收藏、标签、排序和分页搜索路段；名称词是检索线索，未知值不会满足数值条件。area须来自用户原话或已确认区域，半径以区域中心或当前位置起点直线距离衡量。', schema: segmentSearchSchema },
  { name: 'search_places', description: '模糊搜索本地活跃地点：可组合用户附近或指定区域、中文拼音英文名称关联词、地点类别、直线半径、排序和分页；名称线索不是地点事实，结果不是地图全部地点。', schema: pointSearchSchema },
  { name: 'search_places_along_route', description: '在本次生成的路线附近搜索地点；routeId 使用 baseline 或 alternative:1、alternative:2，距离为直线偏离而非导航绕行。', schema: alongSchema },
  { name: 'compare_route_options', description: '比较本次已生成的路线方案，包括里程、时间、途经路段及估算重叠。', schema: planSchema },
  { name: 'validate_route_constraints', description: '检查本次生成的路线预算、原始途经顺序和轨迹间隙，未核实的条件标记为未知。', schema: routeIdSchema }
];
export type ToolModelCall = (messages: BaseMessage[], final: boolean, signal: AbortSignal, required?: boolean) => Promise<AIMessage>;
export type NearbyEvidence = { center: { lat: number; lng: number }; centerSource: string; radiusKm: number; type: 'segment' | 'point' | 'all'; candidates: Candidate[]; sourceTool?: 'attributes' | 'segments' | 'places'; total?: number; hasMore?: boolean; offset?: number; filters?: SegmentSearchInput; pointFilters?: PointSearchInput };
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
  attributeNearby?: (center: { lat: number; lng: number }, radiusKm: number, preferred: RouteTag[], avoid: RouteTag[]) => Promise<Candidate[]>;
  segmentSearch?: typeof searchSegments;
  pointSearch?: typeof searchPoints;
  expanded?: (query: string, radiusKm: number, type: 'segment' | 'point' | 'all') => Promise<{ terms: string[]; candidates: Candidate[]; partial: boolean }>;
  routeOptions?: () => RouteOption[]; routeIntent?: ConversationIntent; routeBounds?: RouteBounds;
  onRoutePlaces?: (items: Array<Candidate & { distanceFromRouteKm: number }>) => void;
  onRouteAnalysis?: (kind: 'comparison' | 'validation', data: unknown) => void;
  plan?: () => Promise<any>; explore?: () => Promise<EnrouteToolResult | null>; planTimeoutMs?: number;
  metrics: IdeaMetrics; callModel?: ToolModelCall; onProgress?: (stage: string) => void;
  deadlineMs?: number; toolTimeoutMs?: number;
}): Promise<any> {
  const { input, metrics } = options;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), options.deadlineMs ?? 60000);
  const idea = typeof (input as { idea?: unknown }).idea === 'string' ? (input as { idea: string }).idea : '';
  const wantsFilteredSegments = !!options.segmentSearch && !options.plan && /路段/.test(idea) && /找|搜索|检索|查询|推荐|有哪些|看看/.test(idea) &&
    /名称|名字|包含|拼音|评分|高分|热门|热度|人气|参与|收藏|坡度|爬升|爬坡|绕圈|刷圈|公里|千米|km|长度|距离|最短|最长/i.test(idea) && !/咖啡|补给|休息点|点位/.test(idea);
  const availableTools = IDEA_TOOLS.filter(tool => (tool.name !== 'search_nearby_candidates' || !!options.nearby) &&
    (tool.name !== 'search_segments_by_attributes' || !!options.attributeNearby && !!options.location) &&
    (tool.name !== 'search_segments' || !!options.segmentSearch && !!options.location && !options.plan) &&
    (tool.name !== 'search_places' || !!options.pointSearch && !!options.location && !options.plan) &&
    (tool.name !== 'search_expanded_candidates' || !!options.expanded && !!options.location && !options.plan) &&
    (!['search_places_along_route', 'compare_route_options', 'validate_route_constraints'].includes(tool.name) || !!options.routeOptions && !!options.routeIntent) &&
    (tool.name !== 'plan_cycling_route' || !!options.plan) && (tool.name !== 'find_enroute_segments' || !!options.explore));
  const advertisedTools = wantsFilteredSegments ? availableTools.filter(tool => !['search_nearby_candidates', 'search_segments_by_attributes'].includes(tool.name)) : availableTools;
  const callModel: ToolModelCall = options.callModel || ((messages, final, signal, required) => createIdeaChatModel()
    .bindTools(advertisedTools, { tool_choice: final ? 'none' : required ? 'required' : 'auto' }).invoke(messages, { signal }));
  const planningInstruction = options.plan ? '\n用户已确认路线需求。必须调用 plan_cycling_route，使用后端提供的已确认需求；不得猜测或改动预算、途经顺序和位置。规划成功后，如用户希望探索路线沿途，可调用 find_enroute_segments。其他工具仅在确有必要时使用。' : '';
  const segmentInstruction = '\n用户要求查找或推荐路段时，可使用 search_segments；需要地点时可使用 search_places。含糊的地点或骑行主题应同时考虑地点与路段，优先使用 search_candidates 或 search_expanded_candidates 获取两类证据，不要把地点等同于路段。area 仅填用户明确提及或已确认的区域，未指定则用当前位置。nameTerms 可以包含有依据的中文、拼音和英文关联词，仅作为检索线索；不要把 east bound 解释为浦东。requiredTags 只填必须匹配的路段属性，排序偏好用 sortBy；未要求的字段省略。minKm/maxKm 是单条路段数据库记录长度，不是整条骑行路线预算。先依据 total、hasMore 和未知数据说明结果，不够时可用 offset 查看下一页或解释并放宽条件，不得声称未知字段已满足。';
  const messages: BaseMessage[] = [new SystemMessage(`${INTENT_PROMPT}\n${TOOL_POLICY_PROMPT}${segmentInstruction}${planningInstruction}`), new HumanMessage(JSON.stringify(input))];
  const seen = new Map<string, { name: string }>();
  const context = (input as { placeContext?: { candidates?: Array<{ id: string; name: string }> } }).placeContext;
  for (const ref of context?.candidates || []) if (candidateIdSchema.safeParse(ref.id).success && typeof ref.name === 'string') seen.set(ref.id, ref);
  const cache = new Map<string, unknown>();
  const callIds = new Set<string>();
  let requireTool = false;
  let planCalled = false;
  const wantsNearby = !!options.nearby && !options.plan && wantsNearbyDiscovery(idea);
  let lookupEvidence: { name: string; terms: string[]; kind: string; expand?: boolean } | null = null;
  const summary = (item: Candidate) => {
    seen.set(item.id, { name: item.name });
    const { coordinates: _coordinates, ...fields } = item;
    return fields;
  };
  const groupedCandidates = (candidates: Candidate[]) => {
    const usable = candidates.filter(item => item.hazardous !== true);
    const segments = usable.filter(item => item.type === 'segment');
    const places = usable.filter(item => item.type === 'point');
    const selected = [...segments.slice(0, 8), ...places.slice(0, 8)];
    const summarized = selected.map(summary);
    return { candidates: summarized, segments: summarized.filter(item => item.type === 'segment'), places: summarized.filter(item => item.type === 'point'),
      counts: { segmentsFound: segments.length, placesFound: places.length, segmentsReturned: Math.min(segments.length, 8), placesReturned: Math.min(places.length, 8) },
      note: '数量为本次有限候选中的数量，不代表数据库完整总数；名称相关不等于已确认地点或骑行体验。地点 score 是点位骑行相关评分，与路段 score 不是同一指标。' };
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
        if ((wantsNearby || wantsFilteredSegments) && round === 0 && !metrics.toolCalls.length) {
          messages.push(message, new HumanMessage(wantsFilteredSegments ? '用户明确要求按条件查找路段，请先调用 search_segments，再输出最终JSON。' : '用户明确要求查询附近候选，请先调用search_nearby_candidates，再输出最终JSON。'));
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
          const args = parsed.data as { name?: string; query?: string; terms?: string[]; id?: string; centerId?: string | null; radiusKm?: number; type?: 'segment' | 'point' | 'all'; preferred?: RouteTag[]; avoid?: RouteTag[]; minScore?: number | null; minKm?: number | null; maxKm?: number | null; routeId?: string; kind?: string | null };
          const key = `${call.name}:${stableJson(args)}`;
          if (cache.has(key)) { status = 'cached'; result = cache.get(key); }
          else {
            const stage = call.name === 'resolve_place' ? '正在解析地点' : call.name === 'search_nearby_candidates' ? '正在探索附近路段和地点' :
              call.name === 'plan_cycling_route' ? '正在规划并验证骑行路线' : call.name === 'find_enroute_segments' ? '正在探索顺路路段' : '正在核实路段与点位';
            options.onProgress?.(stage);
            try {
              const execute = async () => {
                if (call.name === 'search_expanded_candidates') {
                  const query = args.query!;
                  const knownQuery = (input as { placeContext?: { query?: string } }).placeContext?.query;
                  if (!idea.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && knownQuery !== query) return { status: 'unverified_query', candidates: [] };
                  const found = await options.expanded!(query, args.radiusKm!, args.type!);
                  lookupEvidence ??= { name: query, terms: [], kind: 'ambiguous', expand: true };
                  return { status: found.partial ? 'partial' : found.candidates.length ? 'found' : 'not_found', terms: found.terms, centerSource: options.location!.source, radiusKm: args.radiusKm, ...groupedCandidates(found.candidates) };
                }
                if (call.name === 'search_places') {
                  const filters = pointSearchSchema.parse(call.args);
                  const requestedArea = filters.area?.trim();
                  const previousArea = (input as { previousIntent?: { place?: string | null }; placeContext?: { area?: string | null } }).previousIntent?.place || (input as { placeContext?: { area?: string | null } }).placeContext?.area;
                  const alias = requestedArea?.replace(/(?:新区|区|市|县)$/, '');
                  if (requestedArea && !idea.includes(requestedArea) && !(alias && alias.length >= 2 && idea.includes(alias)) && requestedArea !== previousArea) return { status: 'unverified_area', candidates: [] };
                  const center = requestedArea ? await options.resolve(requestedArea) : options.location!.point;
                  if (!center) return { status: 'unresolved_area', candidates: [], area: requestedArea };
                  const found = await options.pointSearch!(center, filters);
                  const source = requestedArea ? 'area_reference' : options.location!.source;
                  options.onNearby?.({ center, centerSource: source, radiusKm: filters.radiusKm, type: 'point', candidates: found.candidates, sourceTool: 'places', total: found.total, hasMore: found.hasMore, offset: found.offset, pointFilters: filters });
                  return { status: found.candidates.length ? 'found' : 'not_found', area: requestedArea || null, centerSource: source, filters, total: found.total, limit: found.limit, offset: found.offset, hasMore: found.hasMore, notes: found.notes, ...groupedCandidates(found.candidates) };
                }
                if (call.name === 'search_segments') {
                  const filters = segmentSearchSchema.parse(call.args);
                  const requestedArea = filters.area?.trim();
                  const previousArea = (input as { previousIntent?: { place?: string | null }; placeContext?: { area?: string | null } }).previousIntent?.place || (input as { placeContext?: { area?: string | null } }).placeContext?.area;
                  const areaAlias = requestedArea?.replace(/(?:新区|区|市|县)$/, '');
                  if (requestedArea && !idea.includes(requestedArea) && !(areaAlias && areaAlias.length >= 2 && idea.includes(areaAlias)) && requestedArea !== previousArea) return { status: 'unverified_area', candidates: [] };
                  const center = requestedArea ? await options.resolve(requestedArea) : options.location!.point;
                  if (!center) return { status: 'unresolved_area', candidates: [], area: requestedArea };
                  const found = await options.segmentSearch!(center, filters);
                  const source = requestedArea ? 'area_reference' : options.location!.source;
                  options.onNearby?.({ center, centerSource: source, radiusKm: filters.radiusKm, type: 'segment', candidates: found.candidates, sourceTool: 'segments', total: found.total, hasMore: found.hasMore, offset: found.offset, filters });
                  return { status: found.candidates.length ? 'found' : 'not_found', area: requestedArea || null, centerSource: source, filters, total: found.total, limit: found.limit, offset: found.offset, hasMore: found.hasMore, notes: found.notes, candidates: found.candidates.map(summary) };
                }
                if (call.name === 'search_segments_by_attributes') {
                  const center = options.location!.point;
                  const candidates = (await options.attributeNearby!(center, args.radiusKm!, args.preferred!, args.avoid!)).filter(item => getDistanceMeters(center, item) <= args.radiusKm! * 1000 && attributeMatch(item, args.preferred!, args.avoid!, args.minScore ?? null, args.minKm ?? null, args.maxKm ?? null)).slice(0, 8);
                  options.onNearby?.({ center, centerSource: options.location!.source, radiusKm: args.radiusKm!, type: 'segment', candidates, sourceTool: 'attributes' });
                  return { status: candidates.length ? 'found' : 'not_found', centerSource: options.location!.source, radiusKm: args.radiusKm, candidates: candidates.map(summary) };
                }
                if (['search_places_along_route', 'compare_route_options', 'validate_route_constraints'].includes(call.name)) {
                  const routes = options.routeOptions!();
                  if (!routes.length) return { status: 'plan_required' };
                  if (call.name === 'compare_route_options') { const result = { status: 'ok', routes: compareOptions(routes) }; options.onRouteAnalysis?.('comparison', result); return result; }
                  const index = args.routeId === 'baseline' ? 0 : Number(args.routeId!.split(':')[1]);
                  if (!routes[index]) return { status: 'not_found' };
                  if (call.name === 'validate_route_constraints') { const result = { routeId: args.routeId, ...validateOption(routes[index], routes[0].route, options.routeIntent!, options.routeBounds) }; options.onRouteAnalysis?.('validation', result); return result; }
                  if (!options.nearby) return { status: 'unavailable' };
                  const points = await placesAlongRoute(routes[index].route, options.nearby, args.radiusKm!, args.kind ?? null);
                  options.onRoutePlaces?.(points);
                  return { status: points.length ? 'found' : 'not_found', distanceMeaning: 'straight_line_to_route', candidates: points.map(summary) };
                }
                if (call.name === 'search_candidates') {
                  // Keep the factual query grounded even if the model drops lookup in its final JSON.
                  lookupEvidence ??= { name: args.name!, terms: args.terms || [], kind: 'ambiguous' };
                  const candidates = (await options.search(args.name!, args.terms)).filter(x => x.hazardous !== true);
                  return { status: candidates.length ? 'found' : 'not_found', ...groupedCandidates(candidates) };
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
                    (args.type === 'all' || item.type === args.type) && Number.isFinite(item.lat) && Number.isFinite(item.lng) && getDistanceMeters(center, item) <= args.radiusKm! * 1000);
                  const selected = [...candidates.filter(item => item.type === 'segment').slice(0, 8), ...candidates.filter(item => item.type === 'point').slice(0, 8)];
                  options.onNearby?.({ center, centerSource: candidate ? 'candidate' : options.location!.source, radiusKm: args.radiusKm!, type: args.type!, candidates: selected });
                  return { status: candidates.length ? 'found' : 'not_found', centerSource: candidate ? 'candidate' : options.location?.source, radiusKm: args.radiusKm, ...groupedCandidates(candidates) };
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
                func: () => bounded(execute, controller.signal, ['plan_cycling_route', 'find_enroute_segments'].includes(call.name) ? (options.planTimeoutMs ?? 45000) : (options.toolTimeoutMs ?? (['search_segments', 'search_places'].includes(call.name) ? 15000 : 8000)))
              });
              result = await tool.invoke(JSON.stringify(args), { runName: definition.name });
              if (!['find_enroute_segments', 'compare_route_options', 'search_places_along_route', 'validate_route_constraints'].includes(call.name)) cache.set(key, result);
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
