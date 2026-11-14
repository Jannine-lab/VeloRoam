import { getDistanceMeters, LatLng } from '../utils/polyline';
import { ConversationIntent } from './ideaIntent';
import { routeBoundsFromIntent } from './ideaCandidatePlanner';
import { validateFixedStops } from './ideaAutonomousGenerator';
import { buildIdeaRoute, CompositeRoute, RouteStop } from './ideaRouteService';
import { addEnrouteSegments, EnrouteAlternative, EnrouteCandidate } from './ideaEnrouteSegments';
import { fetchAmapBicyclingCandidates } from './amapFewestSignalService';
import { requestedRouteTags } from './ideaTagPreferences';

type PlanResult = { route?: CompositeRoute; message?: string; distanceNote?: string; note?: string };
export type EnrouteToolResult = { status: 'explored' | 'not_applicable' | 'unavailable'; result: PlanResult; added: string[]; extraKm: number };

/** Restore already validated stops from the authoritative route, without model-supplied coordinates. */
function routeStops(route: CompositeRoute): RouteStop[] | null {
  if (!Array.isArray(route.stops) || route.stops.length < 2 || !Array.isArray(route.legs)) return null;
  const segments = route.legs.filter(leg => leg.type === 'segment');
  let nextSegment = 0;
  const result: RouteStop[] = [];
  for (const marker of route.stops.slice(1, -1)) {
    if (!marker.point || !Number.isFinite(marker.point.lat) || !Number.isFinite(marker.point.lng)) return null;
    if (marker.type === 'point') result.push({ type: 'point', name: marker.name, coordinates: [marker.point] });
    else if (marker.type === 'segment') {
      const leg = segments[nextSegment++];
      if (!leg || leg.name !== marker.name || !leg.points?.length || getDistanceMeters(leg.points[0], marker.point) >= 1) return null;
      result.push({ type: 'segment', name: leg.name, coordinates: leg.points, detail: leg.detail });
    } else return null;
  }
  return nextSegment === segments.length && !validateFixedStops(route, result) ? result : null;
}

/** Apply the same bounded exploration as the fixed planner; return the authoritative route separately from the model summary. */
export async function exploreConfirmedRoute(input: {
  result: PlanResult; intent: ConversationIntent; idea: string;
  near: (point: LatLng, radiusDegrees: number, preferences: ReturnType<typeof requestedRouteTags>) => Promise<EnrouteCandidate[]>;
  build?: typeof buildIdeaRoute;
  onAlternative?: (result: EnrouteToolResult) => void;
  isCancelled?: () => boolean;
}): Promise<EnrouteToolResult> {
  const unchanged: EnrouteToolResult = { status: 'not_applicable', result: input.result, added: [], extraKm: 0 };
  const { intent, result } = input;
  const route = result.route;
  const preferences = requestedRouteTags(intent);
  const estimate = intent.targetKm ?? intent.maxKm ?? intent.minKm ?? intent.targetMinutes ?? intent.maxMinutes ?? intent.minMinutes;
  const hasTarget = !!(intent.place || intent.destination || intent.stops.length || intent.needsSegment || intent.needsPoint);
  if (!route || (!input.onAlternative && (!estimate || !hasTarget)) || preferences.avoid.length || /不要|避开|避免|不经过/.test([...intent.preferences, input.idea.split('\n').filter(Boolean).slice(-1)[0] || ''].join(' '))) return unchanged;
  const stops = routeStops(route);
  if (!stops || !route.legs.some(leg => leg.type === 'connection' && leg.points.length >= 2)) return unchanged;
  const start = route.stops[0], end = route.stops[route.stops.length - 1];
  if (!start.point || !end.point) return unchanged;
  const overlapMode = preferences.preferred.some(tag => tag === 'out_and_back' || tag === 'loop') || /原路|折返|刷圈|绕圈训练/.test([...intent.preferences, input.idea].join(' ')) ? 'neutral' as const : 'minimize' as const;
  const cache = new Map<string, ReturnType<typeof fetchAmapBicyclingCandidates>>();
  const navigate: typeof fetchAmapBicyclingCandidates = (a, b) => {
    const key = `${a.lat.toFixed(6)},${a.lng.toFixed(6)}:${b.lat.toFixed(6)},${b.lng.toFixed(6)}`;
    if (!cache.has(key)) cache.set(key, fetchAmapBicyclingCandidates(a, b));
    return cache.get(key)!;
  };
  const format = (found: EnrouteAlternative): EnrouteToolResult => {
    const note = `沿导航连接路线加入顺路路段：${found.added.map(name => `“${name}”`).join('、')}；与未加入时相比${found.extraKm >= 0 ? '增加' : '减少'}约 ${Math.abs(found.extraKm).toFixed(1)} 公里。路段评分和标签不代表风景或道路安全已验证。`;
    const km = intent.targetKm != null ? `目标约 ${intent.targetKm} 公里${intent.minKm == null && intent.maxKm == null ? '（按上下浮动 10% 搜索）' : ''}，实际约 ${found.route.distanceKm.toFixed(1)} 公里。` : '';
    const time = intent.timeScope === 'total' && intent.stopMinutes != null ? `${intent.targetMinutes != null ? `目标约 ${intent.targetMinutes} 分钟，` : ''}预计骑行 ${Math.round(found.route.durationMin)} 分钟、停留 ${intent.stopMinutes} 分钟，总计约 ${Math.round(found.route.durationMin + intent.stopMinutes)} 分钟。` : intent.targetMinutes != null ? `目标约 ${intent.targetMinutes} 分钟，预计骑行 ${Math.round(found.route.durationMin)} 分钟。` : '';
    const continuity = found.route.continuity && found.route.continuity.maxGapMeters > 5 ? `轨迹端点与拼接处或途经点最大间隔约 ${Math.ceil(found.route.continuity.maxGapMeters)} 米，间隔内通行尚未验证。` : '';
    const previousNote = typeof result.note === 'string' ? result.note.replace(/轨迹端点与拼接处或途经点最大间隔约 \d+ 米，间隔内通行尚未验证。/g, '').trim() : '';
    const estimateNote = found.route.hasEstimatedTime && !previousNote.includes('部分骑行时间按 18 km/h 估算') ? '部分骑行时间按 18 km/h 估算。' : '';
    return { status: 'explored', added: found.added, extraKm: found.extraKm, result: { ...result, route: found.route,
      message: '已生成包含顺路路段的备选路线。', distanceNote: [km, time].filter(Boolean).join(' '), note: [note, previousNote, continuity, estimateNote].filter(Boolean).join(' ') } };
  };
  const found = await addEnrouteSegments({ baseline: route, stops, end: end.point, bounds: routeBoundsFromIntent(intent), preferences, overlapMode,
    near: point => input.near(point, .13, preferences),
    build: variant => (input.build || buildIdeaRoute)(start.point, start.name, end.point, end.name, variant, navigate),
    ...(input.onAlternative ? { minimumScore: 80, onAlternative: (alternative: EnrouteAlternative) => input.onAlternative!(format(alternative)), isCancelled: input.isCancelled } : {}) });
  if (!found.added.length) return { ...unchanged, status: 'explored' };
  return format(found);
}
