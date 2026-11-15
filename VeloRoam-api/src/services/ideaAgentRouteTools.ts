import type { Candidate } from '../controllers/ideaController';
import { ConversationIntent, RouteTag } from './ideaIntent';
import { CompositeRoute, RouteStop } from './ideaRouteService';
import { budgetReason, validateFixedStops } from './ideaAutonomousGenerator';
import { RouteBounds, routeBoundsFromIntent } from './ideaCandidatePlanner';
import { estimateRouteOverlap } from './ideaRouteOverlap';
import { getDistanceMeters, LatLng } from '../utils/polyline';
import { requestedRouteTags } from './ideaTagPreferences';

export type RouteOption = { route: CompositeRoute; added?: string[]; extraKm?: number };

/** Search sampled positions and measure proximity against the full route geometry. */
export async function placesAlongRoute(route: CompositeRoute, near: (point: LatLng, radiusKm: number) => Promise<Candidate[]>, radiusKm: number, kind: string | null) {
  const paths = route.legs.map(leg => leg.points).filter(points => points.length > 1);
  const edges = paths.flatMap(points => points.slice(1).map((p, i) => ({ a: points[i], b: p, length: getDistanceMeters(points[i], p) })));
  const total = edges.reduce((sum, edge) => sum + edge.length, 0);
  if (!total || !Number.isFinite(total)) return [];
  const samples: LatLng[] = [];
  const count = Math.min(12, Math.max(1, Math.ceil(total / 10000)));
  for (let n = 0; n < count; n++) {
    let target = total * (n + .5) / count;
    for (const edge of edges) {
      if (target <= edge.length && edge.length > 0) { const t = target / edge.length; samples.push({ lat: edge.a.lat + (edge.b.lat - edge.a.lat) * t, lng: edge.a.lng + (edge.b.lng - edge.a.lng) * t }); break; }
      target -= edge.length;
    }
  }
  const groups = await Promise.all(samples.map(point => near(point, Math.max(radiusKm, 10))));
  const seen = new Set<string>();
  const matchesKind = (item: Candidate) => {
    if (!kind) return true;
    const value = `${item.name} ${item.category || ''}`.toLowerCase();
    if (/咖啡|coffee|cafe/i.test(kind)) return /咖啡|coffee|cafe/.test(value);
    if (/补给|便利/.test(kind)) return item.category === 'supply' || /便利|超市|补给/.test(value);
    if (/休息|休憩/.test(kind)) return item.category === 'rest' || /休息|休憩/.test(value);
    return value.includes(kind.toLowerCase());
  };
  return groups.flat().filter(item => item.type === 'point' && item.hazardous !== true && matchesKind(item) && !seen.has(item.id) && !!seen.add(item.id)).map(item => {
    const cos = Math.cos(item.lat * Math.PI / 180), x = 111200 * cos, y = 111200;
    let min = Infinity;
    for (const { a, b } of edges) {
      const ax = (a.lng - item.lng) * x, ay = (a.lat - item.lat) * y, dx = (b.lng - a.lng) * x, dy = (b.lat - a.lat) * y;
      const d = dx * dx + dy * dy; const t = d ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / d)) : 0;
      min = Math.min(min, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return { ...item, distanceFromRouteKm: min / 1000 };
  }).filter(item => item.distanceFromRouteKm <= radiusKm).sort((a, b) => a.distanceFromRouteKm - b.distanceFromRouteKm).slice(0, 8);
}

export function compareOptions(options: RouteOption[]) {
  return options.map((option, index) => ({ id: index ? `alternative:${index}` : 'baseline', distanceKm: option.route.distanceKm,
    durationMin: option.route.durationMin, hasEstimatedTime: option.route.hasEstimatedTime, added: option.added || [],
    extraKm: option.extraKm ?? (option.route.distanceKm - options[0].route.distanceKm),
    stops: option.route.stops.map(stop => stop.name), overlap: estimateRouteOverlap(option.route) }));
}

export function validateOption(option: RouteOption, baseline: CompositeRoute, intent: ConversationIntent, bounds: RouteBounds = routeBoundsFromIntent(intent)) {
  if (baseline.stops.length < 2 || option.route.stops.length < 2 || !baseline.legs.length || !option.route.legs.length) return { status: 'unknown', reason: '路线数据不完整' };
  const required: RouteStop[] = [];
  let segmentIndex = 0;
  const legs = baseline.legs.filter(leg => leg.type === 'segment');
  for (const marker of baseline.stops.slice(1, -1)) {
    if (marker.type === 'point') required.push({ type: 'point', name: marker.name, coordinates: [marker.point] });
    else if (marker.type === 'segment') {
      const leg = legs[segmentIndex++];
      if (!leg || leg.name !== marker.name) return { status: 'unknown', reason: '无法核实原路线途经路段' };
      required.push({ type: 'segment', name: marker.name, coordinates: leg.points });
    } else return { status: 'unknown', reason: '无法核实原路线途经点' };
  }
  const sameEndpoint = (a: CompositeRoute['stops'][number], b: CompositeRoute['stops'][number]) => !!a?.point && !!b?.point && getDistanceMeters(a.point, b.point) < 1;
  const reason = !sameEndpoint(baseline.stops[0], option.route.stops[0]) || !sameEndpoint(baseline.stops.at(-1)!, option.route.stops.at(-1)!) ? '起点或终点与已确认路线不一致' : budgetReason(option.route, bounds) || validateFixedStops(option.route, required);
  const gap = option.route.continuity;
  const avoidance = requestedRouteTags(intent).avoid.length ? 'unknown' : 'not_requested';
  const time = intent.timeScope === 'total' && intent.stopMinutes === null ? 'stop_duration_unknown' : 'checked';
  return { status: reason || (gap && gap.maxGapMeters > gap.toleranceMeters) ? 'failed' : !gap || gap.maxGapMeters > 5 || avoidance === 'unknown' || time === 'stop_duration_unknown' ? 'unknown' : 'checked', reason,
    continuity: gap || null, avoidance, time };
}

export function attributeMatch(item: Candidate, preferred: RouteTag[], avoid: RouteTag[], minScore: number | null, minKm: number | null, maxKm: number | null) {
  if (item.type !== 'segment' || item.hazardous === true || preferred.some(tag => item.tags?.[tag] !== 'matched') || avoid.some(tag => item.tags?.[tag] === 'matched')) return false;
  if (minScore != null && (item.score == null || item.score < minScore)) return false;
  if ((minKm != null || maxKm != null) && (item.distanceKm == null || !Number.isFinite(item.distanceKm))) return false;
  return !(minKm != null && item.distanceKm! < minKm) && !(maxKm != null && item.distanceKm! > maxKm);
}
