import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ChatDeepSeek } from '@langchain/deepseek';
import { z } from 'zod';
import { ROUTE_TAGS } from './ideaIntent';
import { IDEA_PROMPT_VERSION, INTENT_PROMPT, LOOP_SELECTION_PROMPT, POINT_SELECTION_PROMPT, SEGMENT_SELECTION_PROMPT, RECOMMENDATION_PROMPT } from '../prompts/ideaPrompts';

export interface ToolTrace { name: string; status: 'ok' | 'cached' | 'invalid' | 'error' | 'budget'; durationMs: number }
export interface IdeaMetrics {
  requestId: string; startedAt: number; modelCalls: number; inputTokens: number; outputTokens: number;
  modelDurationMs: number; toolCalls: ToolTrace[];
}
export function createIdeaMetrics(): IdeaMetrics {
  return { requestId: randomUUID(), startedAt: performance.now(), modelCalls: 0, inputTokens: 0, outputTokens: 0, modelDurationMs: 0, toolCalls: [] };
}
export function publicIdeaMetrics(metrics: IdeaMetrics) {
  return { requestId: metrics.requestId, promptVersion: IDEA_PROMPT_VERSION, model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    modelCalls: metrics.modelCalls, inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens,
    modelDurationMs: Math.round(metrics.modelDurationMs), elapsedMs: Math.round(performance.now() - metrics.startedAt), toolCalls: metrics.toolCalls };
}
export function recordIdeaUsage(metrics: IdeaMetrics, message: { usage_metadata?: { input_tokens?: number; output_tokens?: number } }) {
  metrics.inputTokens += message.usage_metadata?.input_tokens || 0;
  metrics.outputTokens += message.usage_metadata?.output_tokens || 0;
}
export function createIdeaChatModel(json = false) {
  return new ChatDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    temperature: 0, timeout: 25000, maxRetries: 0, maxTokens: 2400,
    modelKwargs: { thinking: { type: 'disabled' }, ...(json ? { response_format: { type: 'json_object' } } : {}) } });
}

const text = z.string().max(80).nullable().optional();
const distance = z.number().finite().min(0).max(1000).nullable().optional();
const minutes = z.number().finite().min(0).max(10080).nullable().optional();
export const candidateIdSchema = z.string().regex(/^(point|segment):[a-zA-Z0-9_-]{1,80}$/);
export const ideaIntentSchema = z.object({
  mode: z.enum(['route', 'recommend', 'answer', 'clarify']),
  requestType: z.enum(['route', 'recommend']).nullable().optional(), newConversation: z.boolean().optional(),
  lookup: z.object({ name: text, terms: z.array(z.string().min(2).max(80)).max(3), kind: z.enum(['area', 'segment', 'point', 'ambiguous']) }).nullable().optional(),
  selectedCandidateId: candidateIdSchema.nullable().optional(), title: z.string().max(80).optional(),
  reply: z.string().max(1200).nullable().optional(), options: z.array(z.string().max(80)).max(3).optional(),
  clarificationKind: z.enum(['budget', 'budget_and_preference', 'destination', 'order', 'preference', 'purpose']).nullable().optional(),
  preferences: z.array(z.string().max(80)).max(8).optional(), preferredTags: z.array(z.enum(ROUTE_TAGS)).max(6).optional(), avoidTags: z.array(z.enum(ROUTE_TAGS)).max(6).optional(),
  stops: z.array(z.object({ type: z.enum(['point', 'segment']), name: text, kind: text }).strict()).max(8).optional(),
  place: text, origin: text, destination: text, returnToStart: z.boolean().optional(), needsSegment: z.boolean().optional(),
  segmentName: text, needsPoint: z.boolean().optional(), pointName: text, pointKind: text,
  order: z.array(z.enum(['point', 'segment'])).max(2).optional(),
  targetKm: distance, minKm: distance, maxKm: distance, targetMinutes: minutes, minMinutes: minutes, maxMinutes: minutes,
  timeScope: z.enum(['riding', 'total']).nullable().optional(), stopMinutes: minutes
}).strict();

/** Validate syntax, types and candidate identity; a JSON-mode response alone is insufficient. */
export function parseIdeaOutput(prompt: string, content: unknown, input: object): any {
  if (typeof content !== 'string' || !content.trim()) throw new Error('Empty AI response');
  const value: unknown = JSON.parse(content);
  if (prompt === INTENT_PROMPT) return ideaIntentSchema.parse(value);
  const ids = z.array(candidateIdSchema).max(6);
  let parsed: any;
  if (prompt === POINT_SELECTION_PROMPT) parsed = z.object({ id: candidateIdSchema.nullable() }).strict().parse(value);
  else if (prompt === LOOP_SELECTION_PROMPT || prompt === SEGMENT_SELECTION_PROMPT) parsed = z.object({ ids }).strict().parse(value);
  else if (prompt === RECOMMENDATION_PROMPT) parsed = z.object({ message: z.string().max(1200).optional(), items: z.array(z.object({ id: candidateIdSchema, reason: z.string().max(120) }).strict()).max(3) }).strict().parse(value);
  else throw new Error('Unregistered idea prompt');
  const data = input as Record<string, any>;
  const candidates: Array<{ id: string }> = data.candidates || data.points || data.segments || [];
  const allowed = new Set(candidates.map(item => item.id));
  const selected: string[] = parsed.ids || parsed.items?.map((item: { id: string }) => item.id) || (parsed.id ? [parsed.id] : []);
  if (new Set(selected).size !== selected.length || selected.some(id => !allowed.has(id))) throw new Error('AI selected an unknown or duplicate candidate');
  return parsed;
}

export async function invokeIdeaJson(system: string, input: object, metrics?: IdeaMetrics): Promise<any> {
  const started = performance.now();
  if (metrics) metrics.modelCalls++;
  try {
    const result = await createIdeaChatModel(true).invoke([['system', system], ['human', JSON.stringify(input)]]);
    if (metrics) recordIdeaUsage(metrics, result);
    if (result.response_metadata?.finish_reason === 'length') throw new Error('Truncated AI response');
    return parseIdeaOutput(system, result.content, input);
  } finally { if (metrics) metrics.modelDurationMs += performance.now() - started; }
}
