import { performance } from 'node:perf_hooks';
import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Candidate } from '../controllers/ideaController';
import { INTENT_PROMPT, TOOL_POLICY_PROMPT } from '../prompts/ideaPrompts';
import { candidateIdSchema, createIdeaChatModel, IdeaMetrics, parseIdeaOutput, recordIdeaUsage } from './ideaModel';
import { stableJson } from '../utils/stableJson';

const searchSchema = z.object({ name: z.string().trim().min(2).max(80), terms: z.array(z.string().trim().min(2).max(80)).max(3) }).strict();
const resolveSchema = z.object({ name: z.string().trim().min(2).max(80) }).strict();
const detailSchema = z.object({ id: candidateIdSchema }).strict();
export const IDEA_TOOLS = [
  { name: 'search_candidates', description: '按用户提及的真实名称查询公开路段和活跃点位；相关结果不等同于精确匹配。', schema: searchSchema },
  { name: 'resolve_place', description: '通过地图服务解析具体地点。返回唯一位置或未确定，不代表区域边界。', schema: resolveSchema },
  { name: 'get_candidate_detail', description: '按本轮检索或会话已展示的候选ID重新读取公开记录；未找到时不得替换成另一条。', schema: detailSchema }
];
export type ToolModelCall = (messages: BaseMessage[], final: boolean, signal: AbortSignal, required?: boolean) => Promise<AIMessage>;
const nativeCall: ToolModelCall = (messages, final, signal, required) => createIdeaChatModel()
  .bindTools(IDEA_TOOLS, { tool_choice: final ? 'none' : required ? 'required' : 'auto' }).invoke(messages, { signal });

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
  resolve: (name: string) => Promise<{ lat: number; lng: number } | null>;
  metrics: IdeaMetrics; callModel?: ToolModelCall; onProgress?: (stage: string) => void;
  deadlineMs?: number; toolTimeoutMs?: number;
}): Promise<any> {
  const { input, metrics } = options;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), options.deadlineMs ?? 60000);
  const callModel = options.callModel || nativeCall;
  const messages: BaseMessage[] = [new SystemMessage(`${INTENT_PROMPT}\n${TOOL_POLICY_PROMPT}`), new HumanMessage(JSON.stringify(input))];
  const seen = new Map<string, { name: string }>();
  const context = (input as { placeContext?: { candidates?: Array<{ id: string; name: string }> } }).placeContext;
  for (const ref of context?.candidates || []) if (candidateIdSchema.safeParse(ref.id).success && typeof ref.name === 'string') seen.set(ref.id, ref);
  const cache = new Map<string, unknown>();
  const callIds = new Set<string>();
  let requireTool = false;
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
        const definition = IDEA_TOOLS.find(tool => tool.name === call.name);
        const parsed = definition?.schema.safeParse(call.args);
        if (!call.id || callIds.has(call.id)) throw new Error('Missing or duplicate tool call id');
        callIds.add(call.id);
        if (round === 2 || metrics.toolCalls.length >= 4) { status = 'budget'; result = { error: 'tool_budget_exceeded' }; }
        else if (!definition || !parsed?.success) { status = 'invalid'; result = { error: 'invalid_tool_or_arguments' }; }
        else {
          const args = parsed.data as { name?: string; terms?: string[]; id?: string };
          const key = `${call.name}:${stableJson(args)}`;
          if (cache.has(key)) { status = 'cached'; result = cache.get(key); }
          else {
            options.onProgress?.(call.name === 'resolve_place' ? '正在解析地点' : '正在核实路段与点位');
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
                const ref = seen.get(args.id!);
                if (!ref) return { status: 'not_found', candidate: null };
                const candidate = (await options.search(ref.name, [])).find(item => item.id === args.id && item.hazardous !== true);
                return { status: candidate ? 'found' : 'not_found', candidate: candidate ? summary(candidate) : null };
              };
              const tool = new DynamicTool({
                name: definition.name,
                description: definition.description,
                func: () => bounded(execute, controller.signal, options.toolTimeoutMs ?? 8000)
              });
              result = await tool.invoke(JSON.stringify(args), { runName: definition.name });
              cache.set(key, result);
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
