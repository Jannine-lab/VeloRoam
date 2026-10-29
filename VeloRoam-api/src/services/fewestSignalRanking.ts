import { LatLng, getDistanceMeters } from '../utils/polyline';

export interface SignalRouteCandidate {
  distanceKm: number;
  durationMin: number;
  points: LatLng[];
  polyline: string;
}

export interface RankedSignalRoute extends SignalRouteCandidate {
  trafficLightsCount: number | null;
  baselineDistanceKm: number;
  detourPercent: number;
  candidateCount: number;
}

function pointToSegmentDistanceMeters(point: LatLng, start: LatLng, end: LatLng): number {
  const metersPerDegreeLat = 111320;
  const metersPerDegreeLng = metersPerDegreeLat * Math.cos(point.lat * Math.PI / 180);
  const startX = (start.lng - point.lng) * metersPerDegreeLng;
  const startY = (start.lat - point.lat) * metersPerDegreeLat;
  const endX = (end.lng - point.lng) * metersPerDegreeLng;
  const endY = (end.lat - point.lat) * metersPerDegreeLat;
  const dx = endX - startX;
  const dy = endY - startY;
  const fraction = dx * dx + dy * dy > 0
    ? Math.max(0, Math.min(1, -(startX * dx + startY * dy) / (dx * dx + dy * dy)))
    : 0;
  return Math.hypot(startX + fraction * dx, startY + fraction * dy);
}

export function estimateTrafficSignals(points: LatLng[], signals: LatLng[]): number {
  const matched: LatLng[] = [];
  for (const signal of signals) {
    for (let index = 1; index < points.length; index++) {
      if (pointToSegmentDistanceMeters(signal, points[index - 1], points[index]) <= 20) {
        matched.push(signal);
        break;
      }
    }
  }

  const junctions: LatLng[] = [];
  for (const signal of matched) {
    if (junctions.every(junction => getDistanceMeters(junction, signal) > 35)) {
      junctions.push(signal);
    }
  }
  return junctions.length;
}

export function selectFewestSignalRoute(
  candidates: SignalRouteCandidate[],
  signals: LatLng[] | null,
  maxDetourRatio = 0.5
): RankedSignalRoute | null {
  const valid = candidates.filter(route => route.distanceKm > 0 &&
    Number.isFinite(route.distanceKm) && route.points.length >= 2 && route.polyline.length > 0);
  if (valid.length === 0) return null;

  const baselineDistanceKm = Math.min(...valid.map(route => route.distanceKm));
  const withinBudget = valid.filter(route => route.distanceKm <= baselineDistanceKm * (1 + maxDetourRatio) + 1e-8);
  const scored = withinBudget.map(route => ({
    ...route,
    trafficLightsCount: signals ? estimateTrafficSignals(route.points, signals) : null,
    baselineDistanceKm,
    detourPercent: Math.max(0, Math.round((route.distanceKm / baselineDistanceKm - 1) * 100)),
    candidateCount: valid.length
  }));

  scored.sort((a, b) =>
    (a.trafficLightsCount ?? 0) - (b.trafficLightsCount ?? 0) ||
    a.distanceKm - b.distanceKm
  );
  return scored[0];
}
