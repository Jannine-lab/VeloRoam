import { CompositeRoute } from './ideaRouteService';
import { getDistanceMeters, LatLng } from '../utils/polyline';

/** Approximate repeated traversal in 30 m cells. Nearby parallel roads can be conflated. */
export function estimateRouteOverlap(route: CompositeRoute): { repeatedKm: number; fraction: number } | null {
  const seen = new Set<string>();
  let lastCell: string | null = null, revisiting = false, repeatedMeters = 0, sampledMeters = 0;
  const points = route.legs.flatMap(leg => leg.points);
  if (points.length < 2) return null;
  const referenceLat = points[0].lat * Math.PI / 180;
  const cellFor = (p: LatLng) => `${Math.floor(p.lng * 111200 * Math.cos(referenceLat) / 30)}:${Math.floor(p.lat * 111200 / 30)}`;
  for (const leg of route.legs) {
    for (let i = 1; i < leg.points.length; i++) {
      const a = leg.points[i - 1], b = leg.points[i];
      const length = getDistanceMeters(a, b);
      if (!Number.isFinite(length) || length <= 0 || length > 100000) continue;
      const count = Math.min(10000, Math.ceil(length / 15));
      const increment = length / count;
      for (let j = 0; j < count; j++) {
        const t = (j + .5) / count;
        const cell = cellFor({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
        // Samples remaining inside the cell during a single visit are not revisits.
        const active = cell === lastCell;
        if (!active) { revisiting = seen.has(cell); seen.add(cell); lastCell = cell; }
        if (revisiting) repeatedMeters += increment;
        sampledMeters += increment;
      }
    }
  }
  if (!sampledMeters) return null;
  return { repeatedKm: repeatedMeters / 1000, fraction: Math.min(1, repeatedMeters / sampledMeters) };
}
