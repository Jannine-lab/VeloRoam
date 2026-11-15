import { CompositeRoute, RouteConnectionError, RouteConnectionStage, RouteFailureCode, RouteStop } from './ideaRouteService';
import { ConversationIntent } from './ideaIntent';

export type RouteCandidate = { stops: RouteStop[]; priority: number };
export type RouteBounds = { minKm?: number | null; maxKm?: number | null; targetKm?: number | null;
  minMinutes?: number | null; maxMinutes?: number | null; targetMinutes?: number | null; stopMinutes?: number | null };
export type CandidateResult = { route: CompositeRoute; stops: RouteStop[]; attempted: number; valid: number };
export type CandidateFailure = { kind: 'navigation'; reason: RouteFailureCode; stage?: RouteConnectionStage } |
  { kind: 'invalid_result' | 'below_distance' | 'above_distance' | 'below_time' | 'above_time' | 'required_attribute' };
export type BudgetFallback = { route: CompositeRoute; stops: RouteStop[]; priority: number };

/** Keep all distance/time deviations visible; invalid measurements are never fallback routes. */
export function budgetDeviations(route: CompositeRoute, bounds: RouteBounds): Array<{ text: string; ratio: number }> {
  const result: Array<{ text: string; ratio: number }> = [];
  const add = (actual: number, limit: number, unit: string, direction: '超过' | '低于', label: string) => {
    const delta = Math.abs(actual - limit);
    result.push({ text: `${label}约 ${actual.toFixed(1)} ${unit}，${direction}要求的 ${limit.toFixed(1)} ${unit}约 ${delta.toFixed(1)} ${unit}`, ratio: delta / Math.max(limit, 1) });
  };
  if (bounds.minKm != null && route.distanceKm + 1e-9 < bounds.minKm) add(route.distanceKm, bounds.minKm, '公里', '低于', '实际里程');
  if (bounds.maxKm != null && route.distanceKm - 1e-9 > bounds.maxKm) add(route.distanceKm, bounds.maxKm, '公里', '超过', '实际里程');
  const duration = route.durationMin + (bounds.stopMinutes ?? 0);
  const timeLabel = bounds.stopMinutes == null ? '已知骑行时间（不含未知停留）' : bounds.stopMinutes ? '预计总时间' : '预计骑行时间';
  if (bounds.minMinutes != null && bounds.stopMinutes !== null && duration + 1e-9 < bounds.minMinutes) add(duration, bounds.minMinutes, '分钟', '低于', timeLabel);
  if (bounds.maxMinutes != null && duration - 1e-9 > bounds.maxMinutes) add(duration, bounds.maxMinutes, '分钟', '超过', timeLabel);
  return result;
}

export function closestBudgetFallback(candidates: BudgetFallback[], bounds: RouteBounds): BudgetFallback | null {
  return candidates.filter(item => Number.isFinite(item.route.distanceKm) && item.route.distanceKm > 0 &&
    (!(bounds.minMinutes != null || bounds.maxMinutes != null || bounds.targetMinutes != null) || (Number.isFinite(item.route.durationMin) && item.route.durationMin > 0)) && budgetDeviations(item.route, bounds).length > 0)
    .sort((a, b) => budgetDeviations(a.route, bounds).reduce((sum, item) => sum + item.ratio, 0) - budgetDeviations(b.route, bounds).reduce((sum, item) => sum + item.ratio, 0) || a.priority - b.priority)[0] || null;
}

/** Explore single replacements first, then combinations, without changing the confirmed order. */
export function buildStopVariants(stops: RouteStop[], groups: Array<{ index: number; stops: RouteStop[] }>, priority: (stops: RouteStop[]) => number, limit = 6): RouteCandidate[] {
  const valid = groups.filter(group => group.index >= 0 && group.index < stops.length && group.stops.length > 1);
  const results: RouteCandidate[] = [];
  const add = (choices: Array<[number, number]>) => {
    if (results.length >= limit) return;
    const variant = stops.slice();
    choices.forEach(([index, choice]) => { variant[valid[index].index] = valid[index].stops[choice]; });
    results.push({ stops: variant, priority: priority(variant) });
  };
  add([]);
  valid.forEach((_, group) => add([[group, 1]]));
  valid.forEach((_, group) => { for (let other = group + 1; other < valid.length; other++) add([[group, 1], [other, 1]]); });
  valid.forEach((entry, group) => { for (let choice = 2; choice < entry.stops.length; choice++) add([[group, choice]]); });
  return results;
}

/** Explicit distance limits win; a standalone distance target allows ±10%. */
export function routeBoundsFromIntent(intent: Pick<ConversationIntent, 'targetKm' | 'minKm' | 'maxKm' | 'targetMinutes' | 'minMinutes' | 'maxMinutes' | 'timeScope' | 'stopMinutes'>, options: { strictTargetMinutes?: boolean } = {}): RouteBounds {
  const hasExplicitBounds = intent.minKm !== null || intent.maxKm !== null;
  const strictTimeTarget = options.strictTargetMinutes && intent.targetMinutes != null && intent.minMinutes == null && intent.maxMinutes == null;
  return {
    targetKm: intent.targetKm,
    minKm: intent.minKm ?? (!hasExplicitBounds && intent.targetKm !== null ? intent.targetKm * 0.9 : null),
    maxKm: intent.maxKm ?? (!hasExplicitBounds && intent.targetKm !== null ? intent.targetKm * 1.1 : null),
    targetMinutes: intent.targetMinutes, minMinutes: intent.minMinutes ?? (strictTimeTarget ? intent.targetMinutes! * .9 : null), maxMinutes: intent.maxMinutes ?? (strictTimeTarget ? intent.targetMinutes! * 1.1 : null),
    stopMinutes: intent.timeScope === 'total' ? intent.stopMinutes : 0
  };
}

/** Bounded candidate search. Input priority expresses preference fit, not length. */
export async function compareRouteCandidates(
  candidates: RouteCandidate[], bounds: RouteBounds,
  build: (stops: RouteStop[]) => Promise<CompositeRoute>, limit = 6, failures?: CandidateFailure[], validate?: (route: CompositeRoute, stops: RouteStop[]) => string | null, fallbacks?: BudgetFallback[]
): Promise<CandidateResult | null> {
  const candidatesToTry = candidates.slice(0, limit);
  const evaluate = async (candidate: RouteCandidate) => {
    try {
      const route = await build(candidate.stops);
      if (validate?.(route, candidate.stops)) { failures?.push({ kind: 'required_attribute' }); return null; }
      if (!Number.isFinite(route.distanceKm) || route.distanceKm <= 0) { failures?.push({ kind: 'invalid_result' }); return null; }
      const hasTimeBudget = bounds.minMinutes != null || bounds.maxMinutes != null || bounds.targetMinutes != null;
      if (hasTimeBudget && (!Number.isFinite(route.durationMin) || route.durationMin <= 0)) { failures?.push({ kind: 'invalid_result' }); return null; }
      const rejected = (kind: CandidateFailure['kind']) => { failures?.push({ kind } as CandidateFailure); fallbacks?.push({ route, stops: candidate.stops, priority: candidate.priority }); return null; };
      if (bounds.minKm != null && route.distanceKm + 1e-9 < bounds.minKm) return rejected('below_distance');
      if (bounds.maxKm != null && route.distanceKm - 1e-9 > bounds.maxKm) return rejected('above_distance');
      // When stop duration is unknown, riding time is a lower bound on total time.
      const duration = route.durationMin + (bounds.stopMinutes ?? 0);
      if (bounds.minMinutes != null && bounds.stopMinutes !== null && duration + 1e-9 < bounds.minMinutes) return rejected('below_time');
      if (bounds.maxMinutes != null && duration - 1e-9 > bounds.maxMinutes) return rejected('above_time');
      return { route, stops: candidate.stops, priority: candidate.priority };
    } catch (error) {
      failures?.push(error instanceof RouteConnectionError ? { kind: 'navigation', reason: error.reason, stage: error.stage } : { kind: 'navigation', reason: 'unknown' });
      return null;
    }
  };
  // Bound simultaneous route builds to avoid bursting the map provider with all alternatives at once.
  const results: Array<Awaited<ReturnType<typeof evaluate>>> = Array(candidatesToTry.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, candidatesToTry.length) }, async () => {
    while (next < candidatesToTry.length) {
      const index = next++;
      results[index] = await evaluate(candidatesToTry[index]);
    }
  }));
  const valid = results.filter((result): result is NonNullable<typeof result> => result !== null);
  valid.sort((a, b) => a.priority - b.priority ||
    (bounds.targetKm != null ? Math.abs(a.route.distanceKm - bounds.targetKm) - Math.abs(b.route.distanceKm - bounds.targetKm) : 0) ||
    (bounds.targetMinutes != null ? Math.abs(a.route.durationMin + (bounds.stopMinutes ?? 0) - bounds.targetMinutes) - Math.abs(b.route.durationMin + (bounds.stopMinutes ?? 0) - bounds.targetMinutes) : 0));
  const selected = valid[0];
  return selected ? { route: selected.route, stops: selected.stops, attempted: candidatesToTry.length, valid: valid.length } : null;
}
