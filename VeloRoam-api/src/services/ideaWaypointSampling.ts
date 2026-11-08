import { LatLng, getDistanceMeters } from '../utils/polyline';

export interface WaypointSample {
  point: LatLng; fraction: number; alongMeters: number; distanceToTargetMeters: number;
  status: 'selected' | 'eligible' | 'rejected'; reason: string;
}

/** Samples by cumulative trajectory distance; these are not inferred road junctions. */
export function sampleTrajectory(points: LatLng[], target: LatLng, anchor: LatLng, preferredFraction: number, maxTargetOffsetMeters: number | null = null): WaypointSample[] {
  if (points.length < 2) return [];
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const length = getDistanceMeters(points[i - 1], points[i]);
    if (!Number.isFinite(length) || length > 100000) return [];
    lengths.push(length); total += length;
  }
  if (total < 10) return [];
  const result: WaypointSample[] = [];
  for (const fraction of [.65, .75, .85, .93, 1]) {
    const wanted = total * fraction;
    let traversed = 0;
    let point = points[points.length - 1];
    for (let i = 0; i < lengths.length; i++) {
      const length = lengths[i];
      if (length > 0 && traversed + length >= wanted) {
        const t = (wanted - traversed) / length;
        point = { lat: points[i].lat + (points[i + 1].lat - points[i].lat) * t, lng: points[i].lng + (points[i + 1].lng - points[i].lng) * t };
        break;
      }
      traversed += length;
    }
    const distanceToTargetMeters = getDistanceMeters(point, target);
    const tooClose = getDistanceMeters(anchor, point) < Math.min(100, Math.max(5, total * .2));
    const tooFar = maxTargetOffsetMeters != null && distanceToTargetMeters > maxTargetOffsetMeters;
    const duplicate = result.some(item => getDistanceMeters(item.point, point) < 20);
    const reason = tooClose ? '离前一个位置过近' : tooFar ? '偏离目标方向参考位置过远' : duplicate ? '与其他候选点过近' : '可用于路线连接，待比较';
    result.push({ point, fraction, alongMeters: wanted, distanceToTargetMeters, status: tooClose || tooFar || duplicate ? 'rejected' : 'eligible', reason });
  }
  const available = result.filter(item => item.status === 'eligible');
  available.sort((a, b) => Math.abs(a.fraction - preferredFraction) - Math.abs(b.fraction - preferredFraction) || a.distanceToTargetMeters - b.distanceToTargetMeters);
  if (available[0]) { available[0].status = 'selected'; available[0].reason = '符合空间约束，最接近本次目标轨迹比例'; }
  return result;
}
