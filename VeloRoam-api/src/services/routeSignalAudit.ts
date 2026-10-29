import { LatLng, getDistanceMeters } from '../utils/polyline';

export interface AuditSignalFeature extends LatLng {
  id: number;
  tags: Record<string, string>;
}

export interface SignalAuditJunction {
  lat: number;
  lng: number;
  alongRouteMeters: number;
  distanceMeters: number;
  status: 'matched' | 'nearby';
  reviewReasons: string[];
  features: AuditSignalFeature[];
}

export interface RouteSignalAudit {
  matchedJunctions: number;
  nearbyJunctions: number;
  reviewJunctions: number;
  junctions: SignalAuditJunction[];
}

interface ProjectedFeature {
  feature: AuditSignalFeature;
  distanceMeters: number;
  alongRouteMeters: number;
}

function nearestRoutePosition(point: LatLng, route: LatLng[]): { distanceMeters: number; alongRouteMeters: number } {
  let nearestDistance = Infinity;
  let nearestAlong = 0;
  let traversed = 0;
  const metersPerDegreeLat = 111320;
  const metersPerDegreeLng = metersPerDegreeLat * Math.cos(point.lat * Math.PI / 180);

  for (let index = 1; index < route.length; index++) {
    const start = route[index - 1];
    const end = route[index];
    const startX = (start.lng - point.lng) * metersPerDegreeLng;
    const startY = (start.lat - point.lat) * metersPerDegreeLat;
    const dx = (end.lng - start.lng) * metersPerDegreeLng;
    const dy = (end.lat - start.lat) * metersPerDegreeLat;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared > 0
      ? Math.max(0, Math.min(1, -(startX * dx + startY * dy) / lengthSquared))
      : 0;
    const distance = Math.hypot(startX + fraction * dx, startY + fraction * dy);
    const segmentLength = getDistanceMeters(start, end);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestAlong = traversed + fraction * segmentLength;
    }
    traversed += segmentLength;
  }

  return { distanceMeters: nearestDistance, alongRouteMeters: nearestAlong };
}

export function auditSignalsAlongRoute(route: LatLng[], features: AuditSignalFeature[]): RouteSignalAudit {
  if (route.length < 2) return { matchedJunctions: 0, nearbyJunctions: 0, reviewJunctions: 0, junctions: [] };

  const projected: ProjectedFeature[] = features.map(feature => ({
    feature,
    ...nearestRoutePosition(feature, route)
  })).filter(item => item.distanceMeters <= 45)
    .sort((a, b) => a.alongRouteMeters - b.alongRouteMeters);

  const groups: ProjectedFeature[][] = [];
  for (const item of projected) {
    const group = groups.find(candidate => candidate.some(member =>
      Math.abs(member.alongRouteMeters - item.alongRouteMeters) <= 55 &&
      getDistanceMeters(member.feature, item.feature) <= 35
    ));
    if (group) group.push(item);
    else groups.push([item]);
  }

  const junctions = groups.map(group => {
    const closest = group.reduce((best, item) => item.distanceMeters < best.distanceMeters ? item : best);
    const matched = group.some(item => item.distanceMeters <= 20);
    const reasons: string[] = [];
    if (!matched) reasons.push('距路线20–45米，可能是邻近道路');
    if (group.length > 1) reasons.push('同一路口有多个OSM标注，已合并计数');
    if (group.some(item => item.feature.tags['crossing:signals'] === 'yes' ||
      item.feature.tags.crossing === 'traffic_signals')) reasons.push('过街信号是否约束骑行方向待核对');
    if (group.some(item => item.feature.tags['traffic_signals:direction'] || item.feature.tags.direction)) {
      reasons.push('信号灯方向尚未与道路拓扑核对');
    }
    if (closest.distanceMeters > 12 && matched) reasons.push('信号灯距路线超过12米，需排除平行道路');

    return {
      lat: closest.feature.lat,
      lng: closest.feature.lng,
      alongRouteMeters: Math.round(closest.alongRouteMeters),
      distanceMeters: Math.round(closest.distanceMeters),
      status: matched ? 'matched' as const : 'nearby' as const,
      reviewReasons: reasons,
      features: group.map(item => item.feature)
    };
  });

  return {
    matchedJunctions: junctions.filter(item => item.status === 'matched').length,
    nearbyJunctions: junctions.filter(item => item.status === 'nearby').length,
    reviewJunctions: junctions.filter(item => item.reviewReasons.length > 0).length,
    junctions
  };
}
