import { LatLng, getDistanceMeters } from '../utils/polyline';
import { buildIdeaRoute, CompositeRoute, trajectoryDistanceKm } from './ideaRouteService';

export interface NearbySegmentDetail {
  id: string; recordedDistanceKm: number | null; averageGrade: number | null; maximumGrade: number | null;
  elevationGainM: number | null; elevationLowM: number | null; elevationHighM: number | null; climbCategory: number | null;
  city: string | null; state: string | null; country: string | null; starCount: number | null; athleteCount: number | null;
  effortCount: number | null; stravaScore: number | null;
}
export interface NearbySegment { id: string; name: string; score: number | null; coordinates: LatLng[]; detail?: NearbySegmentDetail; }
export interface DistanceRecommendation { targetKm: number; route: CompositeRoute | null; segmentScore: number | null; segmentDetail: NearbySegmentDetail | null; }
export const DISTANCE_TARGETS = [30, 50, 70];

// Rank cheaply before requesting real bicycle navigation; the final distance is
// always checked against the returned routes, not the straight-line estimate.
export async function recommendDistanceRoutes(
  origin: LatLng, originName: string, segments: NearbySegment[],
  build = buildIdeaRoute,
  onProgress: (stage: string) => void = () => {}
): Promise<DistanceRecommendation[]> {
  const ranked = segments.flatMap(segment => {
    if (segment.coordinates.length < 2) return [];
    const first = segment.coordinates[0]; const last = segment.coordinates[segment.coordinates.length - 1];
    const distance = trajectoryDistanceKm(segment.coordinates);
    const lowerBound = (getDistanceMeters(origin, first) + getDistanceMeters(last, origin)) / 1000 + distance;
    const estimate = (lowerBound - distance) * 1.3 + distance;
    return Number.isFinite(estimate) && distance > 0 ? [{ segment, estimate, lowerBound }] : [];
  });
  let active = 0;
  const queue: Array<() => void> = [];
  const withLimit = async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= 3) await new Promise<void>(resolve => queue.push(resolve));
    active++;
    try { return await work(); }
    finally { active--; queue.shift()?.(); }
  };
  // Bound provider calls after ranking by score; validate actual cycling distances below.
  const candidates = ranked.filter(item => item.lowerBound <= 80)
    .sort((a, b) => (b.segment.score ?? -Infinity) - (a.segment.score ?? -Infinity) || a.estimate - b.estimate)
    .filter((item, index, all) => all.findIndex(other => other.segment.id === item.segment.id) === index)
    .slice(0, 15);
  let completed = 0;
  if (candidates.length) onProgress(`正在规划往返路线 0/${candidates.length}`);
  const routes = await Promise.all(candidates.map(async ({ segment }) => {
    const route = await withLimit(() => build(origin, originName, origin, '返回起点', [{ type: 'segment', name: segment.name, coordinates: segment.coordinates }])).catch(() => null);
    onProgress(`正在规划往返路线 ${++completed}/${candidates.length}`);
    if (!route || !Number.isFinite(route.distanceKm) || route.distanceKm < 20 || route.distanceKm > 80) return null;
    return { route, score: segment.score, detail: segment.detail || null };
  }));
  onProgress('正在筛选推荐路线');
  const valid = routes.filter((value): value is { route: CompositeRoute; score: number | null; detail: NearbySegmentDetail | null } => value !== null)
    .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.route.distanceKm - b.route.distanceKm)
    .slice(0, 3);
  return DISTANCE_TARGETS.map((targetKm, index) => ({ targetKm, route: valid[index]?.route || null,
    segmentScore: valid[index]?.score ?? null, segmentDetail: valid[index]?.detail ?? null }));
}
