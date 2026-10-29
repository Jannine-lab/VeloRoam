import { LatLng, getDistanceMeters } from '../utils/polyline';
import { buildIdeaRoute, CompositeRoute, trajectoryDistanceKm } from './ideaRouteService';

export interface NearbySegment { id: string; name: string; score: number | null; coordinates: LatLng[]; }
export interface DistanceRecommendation { targetKm: number; route: CompositeRoute | null; segmentScore: number | null; }
export const DISTANCE_TARGETS = [20, 50, 100];

// Rank cheaply before requesting real bicycle navigation; the final distance is
// always checked against the returned routes, not the straight-line estimate.
export async function recommendDistanceRoutes(
  origin: LatLng, originName: string, segments: NearbySegment[],
  build = buildIdeaRoute
): Promise<DistanceRecommendation[]> {
  const ranked = segments.flatMap(segment => {
    if (segment.coordinates.length < 2) return [];
    const first = segment.coordinates[0]; const last = segment.coordinates[segment.coordinates.length - 1];
    const distance = trajectoryDistanceKm(segment.coordinates);
    const lowerBound = (getDistanceMeters(origin, first) + getDistanceMeters(last, origin)) / 1000 + distance;
    const estimate = (lowerBound - distance) * 1.3 + distance;
    return Number.isFinite(estimate) && distance > 0 ? [{ segment, estimate, lowerBound }] : [];
  });
  const seen = new Set<string>();
  let active = 0;
  const queue: Array<() => void> = [];
  const withLimit = async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= 3) await new Promise<void>(resolve => queue.push(resolve));
    active++;
    try { return await work(); }
    finally { active--; queue.shift()?.(); }
  };
  const cache = new Map<string, Promise<CompositeRoute | null>>();
  return Promise.all(DISTANCE_TARGETS.map(async targetKm => {
    // A broad estimate narrows expensive provider calls; exact distance is checked below.
    const candidates = ranked.filter(item => item.lowerBound <= targetKm * 1.5 && item.estimate >= targetKm * .35)
      .sort((a, b) => (b.segment.score ?? -Infinity) - (a.segment.score ?? -Infinity) || Math.abs(a.estimate - targetKm) - Math.abs(b.estimate - targetKm)).slice(0, 5);
    const routes = await Promise.all(candidates.map(async ({ segment }) => {
      if (!cache.has(segment.id)) cache.set(segment.id, withLimit(() => build(origin, originName, origin, '返回起点', [{ type: 'segment', name: segment.name, coordinates: segment.coordinates }])).catch(() => null));
      const route = await cache.get(segment.id)!;
      if (!route || !Number.isFinite(route.distanceKm) || route.distanceKm < targetKm * .5 || route.distanceKm > targetKm * 1.5) return null;
      return { route, id: segment.id, score: segment.score };
    }));
    const valid = routes.filter((value): value is { route: CompositeRoute; id: string; score: number | null } => value !== null)
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || Math.abs(a.route.distanceKm - targetKm) - Math.abs(b.route.distanceKm - targetKm));
    return { targetKm, choices: valid };
  })).then(groups => groups.map(({ targetKm, choices }) => {
    const chosen = choices.find(choice => !seen.has(choice.id));
    if (chosen) seen.add(chosen.id);
    return { targetKm, route: chosen?.route || null, segmentScore: chosen?.score ?? null };
  }));
}
