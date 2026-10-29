import { fetchAmapBicyclingCandidates } from './amapFewestSignalService';
import { LatLng, getDistanceMeters } from '../utils/polyline';
import { SignalRouteCandidate } from './fewestSignalRanking';

export interface SegmentDetail { id: string; averageGrade: number | null; elevationGainM: number | null; athleteCount: number | null; effortCount: number | null; hazardous: boolean | null; recordedDistanceKm: number | null; }
export interface RouteStop { type: 'point' | 'segment'; name: string; coordinates: LatLng[]; distanceKm?: number; detail?: SegmentDetail; }
export interface CompositeLeg { type: 'connection' | 'segment'; name: string; points: LatLng[]; distanceKm: number; durationMin: number; estimated: boolean; detail?: SegmentDetail; }
export interface CompositeRoute { legs: CompositeLeg[]; stops: Array<{ name: string; type: string; point: LatLng }>; distanceKm: number; durationMin: number; hasEstimatedTime: boolean; }

export function trajectoryDistanceKm(points: LatLng[]): number {
  return points.slice(1).reduce((sum, point, index) => sum + getDistanceMeters(points[index], point), 0) / 1000;
}

// Every connection is returned by the routing provider; no mock fallback.
export async function buildIdeaRoute(
  start: LatLng, startName: string, end: LatLng, endName: string, stops: RouteStop[],
  fetchRoutes: (a: LatLng, b: LatLng) => Promise<SignalRouteCandidate[]> = fetchAmapBicyclingCandidates
): Promise<CompositeRoute> {
  const legs: CompositeLeg[] = [];
  const markers: CompositeRoute['stops'] = [{ name: startName, type: 'start', point: start }];
  let current = start;
  const connect = async (target: LatLng, name: string) => {
    if (getDistanceMeters(current, target) < 5) { current = target; return; }
    const candidates = await fetchRoutes(current, target);
    const usable = candidates.filter(r => r.points.length >= 2 && Number.isFinite(r.distanceKm) && r.distanceKm > 0 &&
      getDistanceMeters(r.points[0], current) <= 100 && getDistanceMeters(r.points[r.points.length - 1], target) <= 100);
    if (!usable.length) throw new Error('无法连接路线中的位置，请尝试更换地点。');
    const route = usable.sort((a, b) => a.distanceKm - b.distanceKm)[0];
    const estimated = !Number.isFinite(route.durationMin) || route.durationMin <= 0;
    legs.push({ type: 'connection', name, points: route.points, distanceKm: route.distanceKm, durationMin: estimated ? route.distanceKm / 18 * 60 : route.durationMin, estimated });
    current = target;
  };
  for (const stop of stops) {
    if (!stop.coordinates.length) throw new Error('途经地点缺少有效坐标。');
    const first = stop.coordinates[0];
    await connect(first, `前往${stop.name}`);
    markers.push({ name: stop.name, type: stop.type, point: first });
    if (stop.type === 'segment') {
      const distanceKm = trajectoryDistanceKm(stop.coordinates);
      if (stop.coordinates.length < 2 || !Number.isFinite(distanceKm) || distanceKm <= 0) throw new Error('路段缺少有效轨迹或距离。');
      legs.push({ type: 'segment', name: stop.name, points: stop.coordinates, distanceKm, durationMin: distanceKm / 18 * 60, estimated: true, ...(stop.detail ? { detail: stop.detail } : {}) });
      current = stop.coordinates[stop.coordinates.length - 1];
    }
  }
  await connect(end, `前往${endName}`);
  markers.push({ name: endName, type: 'end', point: end });
  if (!legs.length) throw new Error('起点和终点太近，请添加途经地点。');
  return { legs, stops: markers, distanceKm: legs.reduce((sum, leg) => sum + leg.distanceKm, 0), durationMin: legs.reduce((sum, leg) => sum + leg.durationMin, 0), hasEstimatedTime: legs.some(leg => leg.estimated) };
}
