import { CompositeRoute, RouteStop } from './ideaRouteService';
import { ConversationIntent } from './ideaIntent';

export type RouteCandidate = { stops: RouteStop[]; priority: number };
export type RouteBounds = { minKm?: number | null; maxKm?: number | null; targetKm?: number | null;
  minMinutes?: number | null; maxMinutes?: number | null; targetMinutes?: number | null; stopMinutes?: number | null };
export type CandidateResult = { route: CompositeRoute; stops: RouteStop[]; attempted: number; valid: number };

/** Explicit distance limits win; a standalone distance target allows ±10%. */
export function routeBoundsFromIntent(intent: Pick<ConversationIntent, 'targetKm' | 'minKm' | 'maxKm' | 'targetMinutes' | 'minMinutes' | 'maxMinutes' | 'timeScope' | 'stopMinutes'>): RouteBounds {
  const hasExplicitBounds = intent.minKm !== null || intent.maxKm !== null;
  return {
    targetKm: intent.targetKm,
    minKm: intent.minKm ?? (!hasExplicitBounds && intent.targetKm !== null ? intent.targetKm * 0.9 : null),
    maxKm: intent.maxKm ?? (!hasExplicitBounds && intent.targetKm !== null ? intent.targetKm * 1.1 : null),
    targetMinutes: intent.targetMinutes, minMinutes: intent.minMinutes, maxMinutes: intent.maxMinutes,
    stopMinutes: intent.timeScope === 'total' ? intent.stopMinutes : 0
  };
}

/** Bounded candidate search. Input priority expresses preference fit, not length. */
export async function compareRouteCandidates(
  candidates: RouteCandidate[], bounds: RouteBounds,
  build: (stops: RouteStop[]) => Promise<CompositeRoute>, limit = 6
): Promise<CandidateResult | null> {
  const candidatesToTry = candidates.slice(0, limit);
  const results = await Promise.all(candidatesToTry.map(async candidate => {
    try {
      const route = await build(candidate.stops);
      if (!Number.isFinite(route.distanceKm) || route.distanceKm <= 0) return null;
      if (bounds.minKm != null && route.distanceKm + 1e-9 < bounds.minKm) return null;
      if (bounds.maxKm != null && route.distanceKm - 1e-9 > bounds.maxKm) return null;
      const hasTimeBudget = bounds.minMinutes != null || bounds.maxMinutes != null || bounds.targetMinutes != null;
      if (hasTimeBudget && (!Number.isFinite(route.durationMin) || route.durationMin <= 0)) return null;
      // When stop duration is unknown, riding time is a lower bound on total time.
      const duration = route.durationMin + (bounds.stopMinutes ?? 0);
      if (bounds.minMinutes != null && bounds.stopMinutes !== null && duration + 1e-9 < bounds.minMinutes) return null;
      if (bounds.maxMinutes != null && duration - 1e-9 > bounds.maxMinutes) return null;
      return { route, stops: candidate.stops, priority: candidate.priority };
    } catch { return null; }
  }));
  const valid = results.filter((result): result is NonNullable<typeof result> => result !== null);
  valid.sort((a, b) => a.priority - b.priority ||
    (bounds.targetKm != null ? Math.abs(a.route.distanceKm - bounds.targetKm) - Math.abs(b.route.distanceKm - bounds.targetKm) : 0) ||
    (bounds.targetMinutes != null ? Math.abs(a.route.durationMin + (bounds.stopMinutes ?? 0) - bounds.targetMinutes) - Math.abs(b.route.durationMin + (bounds.stopMinutes ?? 0) - bounds.targetMinutes) : 0));
  const selected = valid[0];
  return selected ? { route: selected.route, stops: selected.stops, attempted: candidatesToTry.length, valid: valid.length } : null;
}
