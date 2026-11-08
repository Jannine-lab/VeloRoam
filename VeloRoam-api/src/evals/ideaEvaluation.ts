import { isDeepStrictEqual } from 'node:util';

export interface EvalExpectation {
  fields?: Record<string, unknown>; candidateIds?: string[]; toolAnyOf?: string[];
  messagePattern?: string; noRoute?: boolean;
}
export interface IdeaEvalTurn { idea: string; expect: EvalExpectation }
export interface IdeaEvalCase { id: string; category: string; split: 'development' | 'holdout'; turns: IdeaEvalTurn[]; missingRecord?: boolean; unavailable?: boolean }
export interface EvalCheck { name: string; passed: boolean; expected?: unknown; actual?: unknown }
export function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<any>((current, key) => current == null ? undefined : current[key], value);
}
export function evaluateIdeaTurn(status: number, body: any, expected: EvalExpectation): EvalCheck[] {
  const checks: EvalCheck[] = [{ name: 'valid_response', passed: status === 200 && !body?.error && typeof body?.message === 'string' && !!body.message.trim() }];
  for (const [path, target] of Object.entries(expected.fields || {})) {
    const actual = readPath(body, path);
    const passed = Array.isArray(target) && target.length && !path.endsWith('.stops')
      ? Array.isArray(actual) && target.every(item => actual.some(value => isDeepStrictEqual(value, item))) : isDeepStrictEqual(actual, target);
    checks.push({ name: `field:${path}`, passed, expected: target, actual });
  }
  if (expected.candidateIds) {
    const actual: string[] = (body?.items || []).map((item: any) => item.id);
    checks.push({ name: 'candidate_identity', passed: isDeepStrictEqual([...actual].sort(), [...expected.candidateIds].sort()), expected: expected.candidateIds, actual });
  }
  if (expected.toolAnyOf) {
    const actual: string[] = (body?.meta?.toolCalls || []).filter((call: any) => call.status === 'ok' || call.status === 'cached').map((call: any) => call.name);
    checks.push({ name: 'tool_selection', passed: expected.toolAnyOf.some(name => actual.includes(name)), expected: expected.toolAnyOf, actual });
  }
  if (expected.messagePattern) checks.push({ name: 'failure_or_explanation', passed: new RegExp(expected.messagePattern).test(body?.message || ''), expected: expected.messagePattern, actual: body?.message });
  if (expected.noRoute) checks.push({ name: 'no_fabricated_route', passed: !body?.route });
  return checks;
}
/** Nearest-rank percentile; valid for measured samples, not an extrapolated SLA. */
export function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1))];
}
