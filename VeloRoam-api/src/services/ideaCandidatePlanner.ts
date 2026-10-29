import { CompositeRoute, RouteStop } from './ideaRouteService';

export type RouteCandidate = { stops: RouteStop[]; priority: number };
export type RouteBounds = { minKm?: number | null; maxKm?: number | null; targetKm?: number | null };
export type CandidateResult = { route: CompositeRoute; stops: RouteStop[]; attempted: number; valid: number };

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
      if (bounds.minKm != null && route.distanceKm < bounds.minKm) return null;
      if (bounds.maxKm != null && route.distanceKm > bounds.maxKm) return null;
      return { route, stops: candidate.stops, priority: candidate.priority };
    } catch { return null; }
  }));
  const valid = results.filter((result): result is NonNullable<typeof result> => result !== null);
  valid.sort((a, b) => a.priority - b.priority ||
    (bounds.targetKm != null ? Math.abs(a.route.distanceKm - bounds.targetKm) - Math.abs(b.route.distanceKm - bounds.targetKm) : 0));
  const selected = valid[0];
  return selected ? { route: selected.route, stops: selected.stops, attempted: candidatesToTry.length, valid: valid.length } : null;
}
