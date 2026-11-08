import { Request, Response } from 'express';
import axios from 'axios';
import { query } from '../config/db';
import { gcj02ToWgs84, getDistanceMeters } from '../utils/polyline';
import { buildIdeaRoute, RouteStop, trajectoryDistanceKm } from '../services/ideaRouteService';
import { clarificationOptions, ConversationIntent, RouteTagStatuses, sanitizeConversationIntent } from '../services/ideaIntent';
import { compareRouteCandidates, routeBoundsFromIntent } from '../services/ideaCandidatePlanner';
import { generateAutonomousRoute } from '../services/ideaAutonomousGenerator';
import { runIdeaGraph, sanitizePlaceContext, PlaceContext } from '../services/ideaAgentGraph';
import { searchNamedPlaces } from '../services/ideaPlaceSearch';
import { INTENT_PROMPT, LOOP_SELECTION_PROMPT, POINT_SELECTION_PROMPT, SEGMENT_SELECTION_PROMPT, RECOMMENDATION_PROMPT } from '../prompts/ideaPrompts';
import { createIdeaMetrics, invokeIdeaJson, publicIdeaMetrics } from '../services/ideaModel';
import { runIdeaToolAgent, ToolModelCall } from '../services/ideaToolAgent';
import { attachSegmentTags, rankCandidatesByTags, requestedRouteTags, tagPreferenceScore } from '../services/ideaTagPreferences';

type Point = { lat: number; lng: number };
export type Candidate = { id: string; type: 'point' | 'segment'; name: string; lat: number; lng: number; category?: string; distanceKm?: number; coordinates?: Point[]; averageGrade?: number | null; elevationGainM?: number | null; athleteCount?: number | null; effortCount?: number | null; hazardous?: boolean | null; recordedDistanceKm?: number | null; score?: number | null; tags?: RouteTagStatuses };
const continuityNote = (route: { continuity?: { maxGapMeters: number } }) => route.continuity && route.continuity.maxGapMeters > 5 ? `轨迹端点与拼接处或途经点最大间隔约 ${Math.ceil(route.continuity.maxGapMeters)} 米，间隔内通行尚未验证。` : '';
const validPoint = (p: any): p is Point => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;


async function resolvePlace(name: string): Promise<Point | null> {
  if (!process.env.AMAP_API_KEY) return null;
  const r = await axios.get('https://restapi.amap.com/v3/assistant/inputtips', { params: { key: process.env.AMAP_API_KEY, keywords: name, city: '上海', citylimit: true }, timeout: 8000 });
  const tip = (r.data?.tips || []).find((x: any) => typeof x.location === 'string' && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(x.location));
  if (!tip) return null;
  const [lng, lat] = tip.location.split(',').map(Number);
  const point = gcj02ToWgs84(lng, lat);
  return validPoint(point) ? point : null;
}

async function resolveRoutePlace(name: string): Promise<Point | null> {
  if (!process.env.AMAP_API_KEY) return null;
  const response = await axios.get('https://restapi.amap.com/v3/assistant/inputtips', { params: { key: process.env.AMAP_API_KEY, keywords: name, city: '上海', citylimit: true }, timeout: 8000 });
  const matches = (response.data?.tips || []).filter((tip: any) => typeof tip.name === 'string' &&
    (tip.name === name || tip.name.includes(name) || name.includes(tip.name)) &&
    typeof tip.location === 'string' && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(tip.location));
  const exact = matches.filter((tip: any) => tip.name === name);
  const selected = exact.length === 1 ? exact[0] : !exact.length && matches.length === 1 ? matches[0] : null;
  if (!selected) {
    const districtResponse = await axios.get('https://restapi.amap.com/v3/config/district', { params: { key: process.env.AMAP_API_KEY, keywords: name, subdistrict: 0 }, timeout: 8000 });
    if (districtResponse.data?.status !== '1') throw new Error('District lookup unavailable');
    const districts = (districtResponse.data?.districts || []).filter((district: any) => typeof district.name === 'string' &&
      (district.name === name || district.name === name + '区' || district.name === name + '市' || district.name === name + '县') &&
      typeof district.center === 'string' && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(district.center));
    if (districts.length !== 1) return null;
    const [lng, lat] = districts[0].center.split(',').map(Number);
    const point = gcj02ToWgs84(lng, lat);
    return validPoint(point) ? point : null;
  }
  const [lng, lat] = selected.location.split(',').map(Number);
  const point = gcj02ToWgs84(lng, lat);
  return validPoint(point) ? point : null;
}

async function candidatesNear(center: Point, radiusDegrees = 0.13, preferences = requestedRouteTags({ preferences: [], preferredTags: [], avoidTags: [] })): Promise<Candidate[]> {
  const latDelta = Math.max(0.13, Math.min(0.7, radiusDegrees));
  const lngDelta = Math.min(1, latDelta / Math.max(0.15, Math.cos(center.lat * Math.PI / 180)));
  const bounds = [center.lat - latDelta, center.lat + latDelta, center.lng - lngDelta, center.lng + lngDelta];
  const [points, segments] = await Promise.all([
    query(`SELECT id, name, category, lat, lng FROM hot_points WHERE status = 'active' AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? ORDER BY cyclist_score DESC LIMIT 30`, bounds),
    query(`SELECT CAST(s.id AS CHAR) AS id, s.name, s.distance_km AS recordedDistanceKm, s.raw_score AS score, s.start_lat AS lat, s.start_lng AS lng, ST_AsText(s.geom) AS geometry, d.average_grade AS averageGrade, d.total_elevation_gain_m AS elevationGainM, d.athlete_count AS athleteCount, d.effort_count AS effortCount, d.hazardous FROM strava_segments s LEFT JOIN strava_segment_details d ON d.segment_id = s.id WHERE s.start_lat BETWEEN ? AND ? AND s.start_lng BETWEEN ? AND ? AND (d.is_private IS NULL OR d.is_private = 0) ORDER BY s.raw_score DESC LIMIT 500`, bounds)
  ]);
  const pointItems: Candidate[] = points.rows.map((x: any) => ({ id: `point:${x.id}`, type: 'point', name: String(x.name), category: String(x.category), lat: Number(x.lat), lng: Number(x.lng) })).filter(validPoint);
  const segmentItems: Candidate[] = segments.rows.map((x: any) => {
    const body = String(x.geometry || '').match(/^LINESTRING\s*\((.*)\)$/i)?.[1] || '';
    const coordinates = body.split(',').map((pair: string) => { const [lng, lat] = pair.trim().split(/\s+/).map(Number); return { lat, lng }; }).filter(validPoint);
    return { id: `segment:${x.id}`, type: 'segment', name: String(x.name), lat: Number(x.lat), lng: Number(x.lng), distanceKm: trajectoryDistanceKm(coordinates), recordedDistanceKm: x.recordedDistanceKm == null ? null : Number(x.recordedDistanceKm), score: x.score == null ? null : Number(x.score), averageGrade: x.averageGrade == null ? null : Number(x.averageGrade), elevationGainM: x.elevationGainM == null ? null : Number(x.elevationGainM), athleteCount: x.athleteCount == null ? null : Number(x.athleteCount), effortCount: x.effortCount == null ? null : Number(x.effortCount), hazardous: x.hazardous == null ? null : Boolean(x.hazardous), coordinates };
  }).filter((x: Candidate) => validPoint(x) && (x.coordinates?.length || 0) >= 2);
  const tagged = await attachSegmentTags(segmentItems, query);
  return [...pointItems, ...rankCandidatesByTags(tagged, preferences).slice(0, 100)];
}

async function findNamedSegments(center: Point, name: string, preferences = requestedRouteTags({ preferences: [], preferredTags: [], avoidTags: [] })): Promise<Candidate[]> {
  const latDelta = 0.13; const lngDelta = Math.min(1, latDelta / Math.max(0.15, Math.cos(center.lat * Math.PI / 180)));
  const result = await query(`SELECT CAST(s.id AS CHAR) AS id, s.name, s.distance_km AS recordedDistanceKm, s.raw_score AS score, s.start_lat AS lat, s.start_lng AS lng, ST_AsText(s.geom) AS geometry, d.average_grade AS averageGrade, d.total_elevation_gain_m AS elevationGainM, d.athlete_count AS athleteCount, d.effort_count AS effortCount, d.hazardous FROM strava_segments s LEFT JOIN strava_segment_details d ON d.segment_id = s.id WHERE s.start_lat BETWEEN ? AND ? AND s.start_lng BETWEEN ? AND ? AND (d.is_private IS NULL OR d.is_private = 0) AND s.name LIKE ? ORDER BY s.raw_score DESC LIMIT 30`, [center.lat-latDelta, center.lat+latDelta, center.lng-lngDelta, center.lng+lngDelta, `%${name.replace(/[\\%_]/g, '\\$&')}%`]);
  const segments: Candidate[] = result.rows.map((x: any) => {
    const body = String(x.geometry || '').match(/^LINESTRING\s*\((.*)\)$/i)?.[1] || '';
    const coordinates = body.split(',').map((pair: string) => { const [lng,lat] = pair.trim().split(/\s+/).map(Number); return {lat,lng}; }).filter(validPoint);
    return { id:`segment:${x.id}`, type:'segment', name:String(x.name), lat:Number(x.lat), lng:Number(x.lng), distanceKm:trajectoryDistanceKm(coordinates), recordedDistanceKm:x.recordedDistanceKm == null ? null : Number(x.recordedDistanceKm), score:x.score == null ? null : Number(x.score), averageGrade:x.averageGrade == null ? null : Number(x.averageGrade), elevationGainM:x.elevationGainM == null ? null : Number(x.elevationGainM), athleteCount:x.athleteCount == null ? null : Number(x.athleteCount), effortCount:x.effortCount == null ? null : Number(x.effortCount), hazardous:x.hazardous == null ? null : Boolean(x.hazardous), coordinates } as Candidate;
  }).filter((x: Candidate) => validPoint(x) && (x.coordinates?.length || 0) >= 2);
  return rankCandidatesByTags(await attachSegmentTags(segments, query), preferences);
}

async function findPointCandidates(center: Point, kind: string): Promise<Candidate[]> {
  const latDelta = 0.13; const lngDelta = Math.min(1, latDelta / Math.max(0.15, Math.cos(center.lat * Math.PI / 180)));
  let extra = ''; let params: string[] = [];
  if (/咖啡|cafe|coffee/i.test(kind)) { extra = 'AND (name LIKE ? OR name LIKE ? OR name LIKE ? OR amap_type LIKE ? OR tags LIKE ?)'; params = ['%咖啡%', '%coffee%', '%cafe%', '%咖啡%', '%咖啡%']; }
  else if (/休息|休憩/.test(kind)) extra = "AND category IN ('rest','supply')";
  else if (/补给|饮食|餐|便利/.test(kind)) extra = "AND category = 'supply'";
  const result = await query(`SELECT id, name, category, lat, lng FROM hot_points WHERE status = 'active' AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? ${extra} ORDER BY cyclist_score DESC LIMIT 30`, [center.lat-latDelta, center.lat+latDelta, center.lng-lngDelta, center.lng+lngDelta, ...params]);
  return result.rows.map((x: any) => ({ id:`point:${x.id}`, type:'point', name:String(x.name), category:String(x.category), lat:Number(x.lat), lng:Number(x.lng) } as Candidate)).filter(validPoint);
}

export interface IdeaPlannerDependencies {
  resolve: typeof resolveRoutePlace; near: typeof candidatesNear; named: typeof findNamedSegments;
  points: typeof findPointCandidates; model: typeof invokeIdeaJson; build: typeof buildIdeaRoute; generate: typeof generateAutonomousRoute;
}

export async function planFromIntent(intent: ConversationIntent, idea: string, suppliedOrigin: unknown, originLabel: unknown, progress: (stage: string) => void,
  overrides: Partial<IdeaPlannerDependencies> = {}): Promise<object> {
  const deps: IdeaPlannerDependencies = { resolve: resolveRoutePlace, near: candidatesNear, named: findNamedSegments,
    points: findPointCandidates, model: invokeIdeaJson, build: buildIdeaRoute, generate: generateAutonomousRoute, ...overrides };
  const clean = (x: unknown) => typeof x === 'string' ? x.trim().slice(0, 80) : '';
  const currentIdea = idea.split('\n').filter(Boolean).slice(-1)[0] || '';
  const returnRequirements = [...intent.preferences, currentIdea].join(' ');
  const explicitOriginalReturn = [...returnRequirements.matchAll(/原路返回|原路往返(?!路段|路|段)|原路骑回|按原路(?:返回|回)/g)].some(match => !/(?:不|不要|不想|避免|别|无需)\s*$/.test(returnRequirements.slice(Math.max(0, (match.index || 0) - 6), match.index)));
  if (explicitOriginalReturn) return { message: '目前还无法验证返程是否全程沿原路且符合道路通行方向，暂时不能保证这项要求。你可以改为允许返程走其他骑行道路。', options: ['允许返程走其他骑行道路'], items: [] };
  const originName = clean(intent.origin);
  const endName = clean(intent.destination);
  const segmentName = clean(intent.segmentName);
  const pointName = clean(intent.pointName);
  const pointKind = clean(intent.pointKind);
  const needsSegment = intent.needsSegment === true;
  const needsPoint = intent.needsPoint === true;
  const tagPreferences = requestedRouteTags(intent);
  const overlapMode = tagPreferences.preferred.some(tag => tag === 'out_and_back' || tag === 'loop') || /原路|折返|刷圈|绕圈训练/.test([...intent.preferences, currentIdea].join(' ')) ? 'neutral' as const : 'minimize' as const;
  const estimateMinutes = intent.targetMinutes ?? intent.maxMinutes ?? intent.minMinutes;
  const estimateKm = intent.targetKm ?? intent.maxKm ?? intent.minKm ?? (estimateMinutes ? estimateMinutes * 18 / 60 : null);
  const searchRadius = estimateKm ? Math.min(.7, Math.max(.13, estimateKm / 180)) : .13;
  let start: Point;
  if (originName) {
    progress('正在查找出发地点');
    const resolved = await deps.resolve(originName);
    if (!resolved) return { message: `无法确定出发地“${originName}”，请换个更具体的上海地点。`, items: [] };
    start = resolved;
  } else {
    if (!validPoint(suppliedOrigin)) return { message: '请先获取当前位置或设置起点，再为你规划完整路线。', needsOrigin: true, items: [] };
    start = suppliedOrigin;
  }
  let end = start;
  let endLabel = '返回起点';
  if (!intent.returnToStart && endName) {
    progress('正在查找目的地');
    const resolved = await deps.resolve(endName);
    if (!resolved) return { message: `无法确定目的地“${endName}”，请换个更具体的上海地点。`, items: [] };
    end = resolved; endLabel = endName;
  } else if (!intent.returnToStart && originName) {
    if (!validPoint(suppliedOrigin)) return { message: '请先获取当前位置，作为默认结束地点，或告诉我具体终点。', needsOrigin: true, items: [] };
    end = suppliedOrigin; endLabel = originLabel === 'manual' ? '所选位置' : '当前位置';
  }
  const loop = getDistanceMeters(start, end) < 5;
  const stops: RouteStop[] = [];
  const alternatives: Array<{ index: number; stops: RouteStop[] }> = [];
  const requestedStops = intent.stops.map(stop => ({ ...stop }));
  if (!requestedStops.length) {
    const order = Array.isArray(intent.order) ? intent.order : [];
    if (needsSegment && needsPoint && (order.length !== 2 || new Set(order).size !== 2)) return { message: '你想先骑路段还是先去途经点？', options: ['先骑路段，再去途经点', '先去途经点，再骑路段'], items: [] };
    for (const type of order.length ? order : needsSegment ? ['segment'] : needsPoint ? ['point'] : []) {
      if (type === 'segment' && needsSegment) requestedStops.push({ type, name: segmentName || null, kind: null });
      if (type === 'point' && needsPoint) requestedStops.push({ type, name: pointName || null, kind: pointKind || null });
    }
  }
  const autoLoop = loop && requestedStops.length === 0;
  const areaConstraintNote = clean(intent.place) && requestedStops.length ? '尚未验证指定区域与所有固定途经点能否同时满足。' : '';
  if (autoLoop) {
    progress('正在寻找适合作为环线途经的路段和地点');
    const area = clean(intent.place);
    const center = area ? await deps.resolve(area) : start;
    if (!center) return { message: `无法确定“${area}”的位置，请换个更具体的区域，或选择起点附近。`, options: ['在起点附近推荐环线'], items: [] };
    const preferenceText = Array.isArray(intent.preferences) ? intent.preferences.join(' ') : '';
    if (estimateKm && !tagPreferences.preferred.length && !tagPreferences.avoid.length && !/不要|避开|不经过/.test(preferenceText)) {
      progress('正在自主生成途经位置并验证骑行道路');
      const bounds = routeBoundsFromIntent(intent);
      if (bounds.minKm != null && bounds.maxKm != null && bounds.minKm > bounds.maxKm) return { message: '里程范围的下限大于上限，请重新告诉我希望骑多少公里。', items: [] };
      if (bounds.minMinutes != null && bounds.maxMinutes != null && bounds.minMinutes > bounds.maxMinutes) return { message: '时间范围的下限大于上限，请重新告诉我希望骑多久。', items: [] };
      const generated = await deps.generate({ start, end, focus: area ? center : null, bounds, targetKm: estimateKm, overlapMode, startLabel: originName || '当前位置', endLabel }, deps.build);
      if (generated.selected?.route) {
        const route = generated.selected.route;
        const targetNote = intent.targetKm != null ? `目标约 ${intent.targetKm} 公里${intent.minKm == null && intent.maxKm == null ? '（上下浮动 10%）' : ''}，实际约 ${route.distanceKm.toFixed(1)} 公里。` : '';
        return { message: '已自主选择途经位置并生成骑行路线。', items: [], route, distanceNote: targetNote, note: [area ? `以“${area}”的位置作为方向参考，区域范围未作严格限制。` : '', '途经位置由导航服务连接，骑行体验与连接道路的具体条件尚未完整验证。', continuityNote(route), !originName && originLabel === 'ip' ? '起点使用 IP 大致位置，可能与实际位置有偏差。' : !originName && originLabel === 'gps-stale' ? '起点使用上次定位的位置，请确认是否仍准确。' : '', route.hasEstimatedTime ? '部分骑行时间按 18 km/h 估算。' : '', intent.timeScope === 'total' && intent.stopMinutes === null ? '停留时长未知，预计时间仅含骑行，总时长尚无法确认。' : ''].filter(Boolean).join(' ') };
      }
      if (generated.attempts.length) return { message: '已尝试多个自主途经方案，暂时没有找到符合预算且能连通的路线。可以调整距离、时间或目标区域后再试。', options: ['调整距离或时间', '调整目标区域'], items: [] };
    }
    const excludeSegments = /不要.{0,3}路段|不经过.{0,3}路段/.test(preferenceText);
    const excludePoints = /不要.{0,3}(点位|地点|休息|补给)|不经过.{0,3}(点位|地点)/.test(preferenceText);
    const available = rankCandidatesByTags((await deps.near(center, searchRadius, tagPreferences)).filter(candidate => candidate.hazardous !== true && (candidate.type === 'segment' ? !excludeSegments : !excludePoints)), tagPreferences);
    if (!available.length) return { message: '附近暂时没有可用于规划环线的路段或地点，可以换个起点或放宽要求再试。', options: ['放宽路线要求', '调整出发地点'], items: [] };
    const choice = await deps.model(LOOP_SELECTION_PROMPT, { idea, intent, candidates: available.map(({coordinates, ...candidate}) => ({ ...candidate, distanceFromStartKm: Math.round(getDistanceMeters(start, candidate) / 100) / 10 })) });
    const ids: string[] = Array.isArray(choice.ids) ? [...new Set<string>(choice.ids.filter((id: unknown): id is string => typeof id === 'string'))].slice(0, 6) : [];
    const ranked = rankCandidatesByTags(ids.flatMap(id => { const candidate = available.find(item => item.id === id); return candidate ? [candidate] : []; }), tagPreferences);
    const candidates: RouteStop[] = ranked.flatMap<RouteStop>(item => {
      if (item.type === 'point') return [{ type: 'point' as const, name: item.name, coordinates: [{ lat: item.lat, lng: item.lng }] }];
      if (!item.coordinates?.length) return [];
      return [{ type: 'segment' as const, name: item.name, coordinates: item.coordinates, detail: { id: item.id, averageGrade: item.averageGrade ?? null, elevationGainM: item.elevationGainM ?? null, athleteCount: item.athleteCount ?? null, effortCount: item.effortCount ?? null, hazardous: item.hazardous ?? null, recordedDistanceKm: item.recordedDistanceKm ?? null, tags: item.tags } }];
    });
    if (!candidates.length) return { message: '暂时没有找到符合要求的环线候选，可以放宽要求或调整出发地点。', options: ['放宽路线要求', '调整出发地点'], items: [] };
    alternatives.push({ index: 0, stops: candidates });
    stops.push(candidates[0]);
  }
  let anchor = start;
  for (const requested of requestedStops.slice(0, 8)) {
    const name = clean(requested.name);
    if (requested.type === 'point' && name) {
      progress(`正在查找途经点：${name}`);
      const point = await deps.resolve(name);
      if (!point) return { message: `无法确定途经点“${name}”，请提供更具体的上海地点。`, items: [] };
      stops.push({ type: 'point', name, coordinates: [point] }); anchor = point;
    } else if (requested.type === 'point') {
      const kind = clean(requested.kind);
      progress('正在查找合适的途经点');
      const points = await deps.points(anchor, kind);
      if (!points.length) return { message: `附近没有找到符合“${kind || '途经点'}”要求的点位，请调整要求。`, items: [] };
      const choice = await deps.model(POINT_SELECTION_PROMPT, { idea, intent, points: points.map(x => ({id:x.id, name:x.name, category:x.category, distanceFromPreviousKm:Math.round(getDistanceMeters(anchor, x)/100)/10})) });
      const point = points.find(x => x.id === choice.id);
      if (!point) return { message: '没有找到符合要求的途经点，请换个描述试试。', items: [] };
      anchor = {lat:point.lat,lng:point.lng}; stops.push({ type:'point', name:point.name, coordinates:[anchor] });
    } else if (requested.type === 'segment') {
      progress('正在检索路段及其坡度、爬升与热度详情');
      const searchCenter = name ? (await deps.resolve(name)) || anchor : anchor;
      const segments = rankCandidatesByTags(name ? await deps.named(searchCenter, name, tagPreferences) : (await deps.near(anchor, searchRadius, tagPreferences)).filter(x => x.type === 'segment'), tagPreferences);
      if (!segments.length) return { message: name ? `附近没有找到“${name}”路段，请换个名称或地点。` : '附近暂时没有可用路段，请调整要求。', items: [] };
      const choice = await deps.model(SEGMENT_SELECTION_PROMPT, { idea, intent, segments: segments.map(({coordinates, ...x}) => ({...x, distanceFromPreviousKm:Math.round(getDistanceMeters(anchor, x)/100)/10})) });
      const ids: string[] = Array.isArray(choice.ids) ? [...new Set<string>(choice.ids.filter((id: unknown): id is string => typeof id === 'string'))].slice(0, 6) : [];
      const orderedSegments = rankCandidatesByTags(ids.flatMap(id => { const segment = segments.find(x => x.id === id && x.hazardous !== true); return segment ? [segment] : []; }), tagPreferences);
      const chosen = orderedSegments.flatMap(segment => { if (!segment.coordinates) return [];
        return [{ type:'segment' as const, name:segment.name, coordinates:segment.coordinates, detail: { id: segment.id, averageGrade: segment.averageGrade ?? null, elevationGainM: segment.elevationGainM ?? null, athleteCount: segment.athleteCount ?? null, effortCount: segment.effortCount ?? null, hazardous: segment.hazardous ?? null, recordedDistanceKm: segment.recordedDistanceKm ?? null, tags: segment.tags } }]; });
      if (!chosen.length) return { message: '没有找到符合要求的路段，请换个描述试试。', items: [] };
      alternatives.push({ index: stops.length, stops: chosen });
      stops.push(chosen[0]); anchor = chosen[0].coordinates[chosen[0].coordinates.length - 1];
    }
  }
  if (loop && !stops.length) return { message: '暂时没有找到可用的环线候选，可以放宽要求或调整出发地点。', options: ['放宽路线要求', '调整出发地点'], items: [] };
  const bounds = routeBoundsFromIntent(intent);
  const { targetKm, minKm, maxKm, minMinutes, maxMinutes, targetMinutes } = bounds;
  const hasExplicitBounds = intent.minKm != null || intent.maxKm != null;
  if (minKm != null && maxKm != null && minKm > maxKm) return { message: '里程范围的下限大于上限，请重新告诉我希望骑多少公里。', items: [] };
  if (minMinutes != null && maxMinutes != null && minMinutes > maxMinutes) return { message: '时间范围的下限大于上限，请重新告诉我希望骑多久。', items: [] };
  const priority = (value: RouteStop[]) => -value.reduce((sum, stop) => sum + (stop.type === 'segment' ? tagPreferenceScore({ id: stop.detail?.id || '', type: 'segment', tags: stop.detail?.tags }, tagPreferences) : 0), 0);
  const variants = [{ stops, priority: priority(stops) }];
  for (const group of alternatives) for (let i = 1; i < group.stops.length && variants.length < 6; i++) {
    const variant = stops.slice(); variant[group.index] = group.stops[i]; variants.push({ stops: variant, priority: priority(variant) });
  }
  if (loop && stops.length >= 1 && estimateKm && !tagPreferences.avoid.length && !/不要|避开|不经过/.test(intent.preferences.join(' '))) {
    progress('正在保留指定途经顺序并生成自主连接点');
    const generated = await deps.generate({ start, end, bounds, targetKm: estimateKm, fixedSegment: stops.length === 1 && stops[0].type === 'segment' ? stops[0] : null, fixedStops: stops, overlapMode, startLabel: originName || '当前位置', endLabel }, deps.build);
    if (generated.selected?.route) {
      const route = generated.selected.route;
      return { message: `已按顺序经过${stops.map(stop => `“${stop.name}”`).join('、')}，并结合自主途经点生成完整骑行路线。`, items: [], route,
        distanceNote: [targetKm != null ? `目标约 ${targetKm} 公里${!hasExplicitBounds ? '（按上下浮动 10% 搜索）' : ''}，实际约 ${route.distanceKm.toFixed(1)} 公里。` : '',
          intent.timeScope === 'total' && intent.stopMinutes != null ? `预计骑行 ${Math.round(route.durationMin)} 分钟、停留 ${intent.stopMinutes} 分钟，总计约 ${Math.round(route.durationMin + intent.stopMinutes)} 分钟。` : targetMinutes != null ? `目标约 ${targetMinutes} 分钟，预计骑行 ${Math.round(route.durationMin)} 分钟。` : ''].filter(Boolean).join(' '),
        note: [stops.some(stop => stop.type === 'segment') ? '指定路段按所选轨迹方向连接，骑行体验与连接道路条件尚未完整验证。' : '骑行体验与连接道路条件尚未完整验证。', continuityNote(route), areaConstraintNote, route.hasEstimatedTime ? '部分骑行时间按 18 km/h 估算。' : '', intent.timeScope === 'total' && intent.stopMinutes === null ? '停留时长未知，预计时间仅含骑行，总时长尚无法确认。' : '', !originName && originLabel === 'ip' ? '起点使用 IP 大致位置，可能与实际位置有偏差。' : !originName && originLabel === 'gps-stale' ? '起点使用上次定位的位置，请确认是否仍准确。' : ''].filter(Boolean).join(' ') };
    }
  }
  progress(variants.length > 1 ? '正在比较候选路线与实际里程' : '正在规划骑行连接路线');
  const startLabel = originName || (originLabel === 'manual' ? '所选起点' : originLabel === 'ip' ? 'IP 大致位置' : originLabel === 'gps-stale' ? '上次定位位置' : '当前位置');
  const result = await compareRouteCandidates(variants, bounds, variant => deps.build(start, startLabel, end, endLabel, variant));
  const hasLimits = minKm != null || maxKm != null || minMinutes != null || maxMinutes != null;
  if (!result) return { message: hasLimits ? '尝试了部分候选路线，但没有找到符合里程或时间要求且能够连通的方案。可以放宽要求或调整途经点。' : '尝试了部分候选路线，但暂时无法连接成完整路线，请调整途经点后重试。', items: [], options: hasLimits ? ['放宽距离或时间要求', '调整途经点'] : [] };
  const route = result.route;
  const distanceNote = targetKm ? `目标约 ${targetKm} 公里${!hasExplicitBounds ? '（按上下浮动 10% 搜索）' : ''}，实际约 ${route.distanceKm.toFixed(1)} 公里。` : '';
  const timeGoal = targetMinutes != null ? `目标约 ${targetMinutes} 分钟，` : '';
  const timeNote = intent.timeScope === 'total' && intent.stopMinutes != null
    ? `${timeGoal}预计骑行 ${Math.round(route.durationMin)} 分钟、停留 ${intent.stopMinutes} 分钟，总计约 ${Math.round(route.durationMin + intent.stopMinutes)} 分钟。`
    : targetMinutes != null ? `${timeGoal}预计骑行 ${Math.round(route.durationMin)} 分钟。` : '';
  const avoidanceNote = tagPreferences.avoid.length ? '已排除标签命中的候选路段；未知标签和连接道路未能完整验证避开条件。' : /不要|避开|避免|不经过/.test([...intent.preferences, currentIdea].join(' ')) ? '提出的避开条件尚未对全部连接道路验证。' : '';
  return { message: autoLoop ? `为你选择了${result.stops[0].name}作为途经${result.stops[0].type === 'segment' ? '路段' : '地点'}，并规划了返回起点的路线。` : '已生成完整骑行路线', items: [], route, distanceNote: [distanceNote, timeNote].filter(Boolean).join(' '), note: [continuityNote(route), areaConstraintNote, result.stops.some(stop => stop.type === 'segment') ? '路段里程按所用轨迹估算，包含轨迹中的折返和绕圈；轨迹精度可能影响结果。实际通行情况请以现场为准。' : '', route.hasEstimatedTime ? '部分骑行时间按 18 km/h 估算。' : '', intent.timeScope === 'total' && intent.stopMinutes === null ? '停留时长未知，预计时间仅含骑行，总时长尚无法确认。' : '', avoidanceNote, !originName && originLabel === 'ip' ? '起点使用 IP 大致位置，可能与实际位置有偏差。' : !originName && originLabel === 'gps-stale' ? '起点使用上次定位的位置，请确认是否仍准确。' : ''].filter(Boolean).join(' ') };
}

export interface IdeaControllerDependencies {
  model: typeof invokeIdeaJson; plan: typeof planFromIntent; near: typeof candidatesNear;
  resolve: typeof resolvePlace; search: typeof searchNamedPlaces; isConfigured: () => boolean; toolCaller?: ToolModelCall;
}

export function createIdeaController(overrides: Partial<IdeaControllerDependencies> = {}) {
  const baseDeps: IdeaControllerDependencies = { model: invokeIdeaJson, plan: planFromIntent, near: candidatesNear,
    resolve: resolveRoutePlace, search: searchNamedPlaces, isConfigured: () => !!process.env.DEEPSEEK_API_KEY, ...overrides };
  return async (req: Request, res: Response) => {
  const metrics = createIdeaMetrics();
  const model = overrides.model || ((system: string, input: object) => invokeIdeaJson(system, input, metrics));
  const deps: IdeaControllerDependencies = { ...baseDeps, model, plan: overrides.plan || ((intent, idea, origin, label, progress, plannerOverrides) =>
    planFromIntent(intent, idea, origin, label, progress, { model, ...plannerOverrides })) };
  // Per-request caches avoid repeating reads already performed by native tools.
  const searches = new Map<string, Promise<Candidate[]>>();
  const places = new Map<string, Promise<Point | null>>();
  const search = (name: string, terms: unknown = []) => {
    const key = JSON.stringify([name, terms]);
    if (!searches.has(key)) searches.set(key, deps.search(name, terms));
    return searches.get(key)!;
  };
  const resolve = (name: string) => {
    if (!places.has(name)) places.set(name, deps.resolve(name));
    return places.get(name)!;
  };
  const interpret = (input: object) => overrides.model ? model(INTENT_PROMPT, input) : runIdeaToolAgent({
    input, search, resolve, metrics, callModel: overrides.toolCaller,
    onProgress: stage => sendEvent('progress', { stage })
  });
  const idea = typeof req.body?.idea === 'string' ? req.body.idea.trim() : '';
  if (!idea || idea.length > 500 || !validPoint(req.body?.center)) return res.status(400).json({ error: '请输入 500 字以内的想法，并提供有效的地图中心。' });
  if (!deps.isConfigured()) return res.status(503).json({ error: '推荐服务尚未配置。' });
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-12).flatMap((turn: any) => {
    if (!turn || (turn.role !== 'user' && turn.role !== 'assistant') || typeof turn.content !== 'string') return [];
    const content = turn.content.trim().slice(0, 1000);
    return content ? [{ role: turn.role, content }] : [];
  }) : [];
  let conversationTitle = '';
  let conversationIntent = sanitizeConversationIntent(req.body?.previousIntent);
  let placeContext: PlaceContext | null = sanitizePlaceContext(req.body?.placeContext);
  const stream = (req.get('accept') || '').includes('text/event-stream');
  if (stream) {
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
  }
  const sendEvent = (event: string, data: object) => {
    if (stream && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const finish = (data: object, status = 200) => {
    const payload = { ...data, meta: publicIdeaMetrics(metrics), ...(conversationTitle ? { title: conversationTitle } : {}), contextIntent: conversationIntent, placeContext };
    if (stream) { sendEvent(status >= 400 ? 'error' : 'result', payload); return res.end(); }
    return res.status(status).json(payload);
  };
  try {
    sendEvent('progress', { stage: '理解你的消息' });
    return await runIdeaGraph({
    interpret: () => interpret({ previousIntent: conversationIntent, placeContext, history, idea }),
    shouldGround: intent => { if (intent.newConversation === true) { placeContext = null; conversationIntent = null; } return Boolean((intent.lookup && typeof intent.lookup.name === 'string' && intent.lookup.name.trim()) || intent.selectedCandidateId || (placeContext && ['route', 'recommend'].includes(intent.mode))); },
    ground: async intent => {
      const lookupName = typeof intent.lookup?.name === 'string' ? intent.lookup.name.trim().slice(0, 80) : '';
      const selectedRef = typeof intent.selectedCandidateId === 'string' ? placeContext?.candidates.find(x => x.id === intent.selectedCandidateId) : undefined;
      const name = lookupName || selectedRef?.name || placeContext?.query || '';
      if (!name) return null;
      sendEvent('progress', { stage: '正在检索地点、路段和点位' });
      const terms = lookupName && Array.isArray(intent.lookup?.terms) ? intent.lookup.terms.filter((term: unknown): term is string => typeof term === 'string' && term.trim().length >= 2 && term.trim().length <= 80).slice(0, 3) : (placeContext?.terms || []);
      const matches = await search(name, terms);
      const areaPoint = await resolve(name);
      const nearby = areaPoint ? await deps.near(areaPoint) : [];
      const tagPreferences = requestedRouteTags(sanitizeConversationIntent(intent) || conversationIntent || { preferences: [], preferredTags: [], avoidTags: [] });
      const ordered = rankCandidatesByTags([...matches, ...nearby].filter((item, index, all) => item.hazardous !== true && all.findIndex(x => x.id === item.id) === index), tagPreferences);
      const candidates = (intent.needsSegment === true ? [...ordered.filter(x => x.type === 'segment'), ...ordered.filter(x => x.type !== 'segment')] : ordered).slice(0, 12);
      const selectedId = typeof intent.selectedCandidateId === 'string' && placeContext?.candidates.some(x => x.id === intent.selectedCandidateId) && candidates.some(x => x.id === intent.selectedCandidateId) ? intent.selectedCandidateId : null;
      const inheritedId = !lookupName && placeContext?.selectedId && candidates.some(x => x.id === placeContext?.selectedId) ? placeContext.selectedId : null;
      const exactSegments = matches.filter(x => x.type === 'segment' && x.name === name && x.hazardous !== true);
      const exactId = intent.lookup?.kind === 'segment' && exactSegments.length === 1 ? exactSegments[0].id : null;
      placeContext = { query: name, terms, candidates: candidates.map(x => ({ id: x.id, type: x.type, name: x.name })), selectedId: selectedId || inheritedId || (candidates.some(x => x.id === exactId) ? exactId : null), area: areaPoint ? name : null };
      return { candidates, matches, areaPoint, lookupName, selected: candidates.find(x => x.id === placeContext?.selectedId) || null };
    },
    respond: async (intent, grounding) => {
    const updatedIntent = sanitizeConversationIntent(intent);
    if (updatedIntent && !updatedIntent.requestType && intent.mode === 'clarify' && conversationIntent?.requestType && ['budget', 'budget_and_preference', 'preference', 'order', 'destination'].includes(intent.clarificationKind)) updatedIntent.requestType = conversationIntent.requestType;
    if (updatedIntent) conversationIntent = updatedIntent;
    if (typeof intent.title === 'string') {
      const rawTitle = intent.title.replace(/[\r\n]/g, ' ').trim();
      conversationTitle = Array.from(rawTitle).slice(0, 20).join('');
      if (conversationTitle && !history.length) sendEvent('title', { title: conversationTitle });
    }
    if (!['answer', 'clarify', 'route', 'recommend'].includes(intent.mode)) return finish({ message: '你希望我帮你规划路线，还是推荐骑行路段或休息点？', options: clarificationOptions(null, 'purpose'), items: [] });
    const routeRequest = !!conversationIntent && (intent.mode === 'route' || (intent.mode === 'clarify' && conversationIntent.requestType === 'route'));
    if (grounding && (grounding.lookupName || grounding.selected) && !routeRequest && intent.mode !== 'clarify') {
      const candidates: Candidate[] = grounding.selected ? [grounding.selected] : grounding.candidates;
      if (!candidates.length) return finish({ message: `暂未找到与“${placeContext?.query}”相关的可用路段或点位，也无法确认具体位置。可以提供所在区域或更具体的名称。`, items: [] });
      const items = candidates.slice(0, 6).map(candidate => ({ ...candidate, reason: grounding.matches.some((match: Candidate) => match.id === candidate.id) ? '名称相关的数据库记录' : '地点附近的数据库记录' }));
      placeContext = { ...placeContext!, candidates: items.map(x => ({ id: x.id, name: x.name, type: x.type })) };
      return finish({ message: `找到与“${placeContext.query}”名称相关的数据库记录或地点附近的路段和点位；名称相近不一定是同一个地点，附近不代表处于区域边界内。你可以选择一个，或继续说明想去的区域。`, items, options: items.slice(0, 3).map(x => `选择${x.name}`) });
    }
    if (intent.mode === 'answer' || (intent.mode === 'clarify' && (!routeRequest || intent.clarificationKind === 'order'))) {
      const reply = typeof intent.reply === 'string' ? intent.reply.trim().slice(0, 1200) : '';
      return finish({ message: reply || '能再具体说说你的想法吗？', options: intent.mode === 'clarify' ? clarificationOptions(intent.options, intent.clarificationKind) : [], items: [] });
    }
    // Selection sees all recent user preferences, not only an elliptical follow-up.
    const combinedIdea = [...history.filter((turn: { role: string }) => turn.role === 'user').map((turn: { content: string }) => turn.content), idea].join('\n').slice(-5000);
    sendEvent('progress', { stage: '整理骑行需求与途经顺序' });
    if (routeRequest && conversationIntent) {
      const selected: Candidate | null = grounding?.selected || null;
      const focus = placeContext?.query;
      if (selected) {
        const type = selected.type;
        const originalStops = conversationIntent.stops;
        const matches = originalStops.map((stop, index) => ({ stop, index })).filter(({ stop }) => stop.type === type && (!stop.name || stop.name === focus || stop.name === selected.name));
        if (matches.length > 1 || (!matches.length && originalStops.length)) return finish({ message: '已选中该地点；请告诉我它在其他途经点之前还是之后。', items: [] });
        const selectedStop = { type, name: selected.name, kind: null };
        const preservedStops = originalStops.length ? originalStops.map((stop, index) => index === matches[0].index ? selectedStop : stop) : [selectedStop];
        conversationIntent = { ...conversationIntent, needsSegment: type === 'segment' || conversationIntent.needsSegment, segmentName: type === 'segment' ? selected.name : conversationIntent.segmentName, needsPoint: type === 'point' || conversationIntent.needsPoint, pointName: type === 'point' ? selected.name : conversationIntent.pointName, stops: preservedStops, order: preservedStops.map(stop => stop.type).slice(0, 2) };
        return finish(await deps.plan(conversationIntent, combinedIdea, req.body.origin, req.body.originSource, stage => sendEvent('progress', { stage }), {
          named: async (center, name, preferences) => type === 'segment' && name === selected.name ? [selected] : findNamedSegments(center, name, preferences),
          model: async (system, input) => type === 'segment' && Array.isArray((input as any).segments) && (input as any).segments.some((item: any) => item.id === selected.id) ? { ids: [selected.id] } : deps.model(system, input),
          resolve: async name => name === selected.name ? { lat: selected.lat, lng: selected.lng } : resolveRoutePlace(name)
        }));
      }
      if (focus && conversationIntent.segmentName === focus && placeContext?.area) {
        conversationIntent = { ...conversationIntent, place: focus, needsSegment: false, segmentName: null, stops: conversationIntent.stops.filter(stop => stop.type !== 'segment' || stop.name !== focus), order: conversationIntent.order.filter(type => type !== 'segment') };
      } else if (focus && !placeContext?.area) {
        return finish({ message: `还无法确定“${focus}”具体指哪个路段或地点，请从已检索到的候选中选择，或提供更具体的位置。`, options: (placeContext?.candidates || []).slice(0, 3).map(x => `选择${x.name}`), items: [] });
      }
      if (focus && placeContext?.area && !conversationIntent.place) conversationIntent = { ...conversationIntent, place: focus };
      const planned: any = await deps.plan(conversationIntent, combinedIdea, req.body.origin, req.body.originSource, stage => sendEvent('progress', { stage }));
      if (focus && placeContext?.area && planned.route) planned.note = [planned.note, '候选按地点中心附近检索，尚未校验行政区边界或区域内绕圈。'].filter(Boolean).join(' ');
      return finish(planned);
    }
    let center: Point = req.body.center;
    let area = '当前地图中心附近';
    if (typeof intent.place === 'string' && intent.place.trim()) {
      sendEvent('progress', { stage: '正在查找指定地点' });
      const found = await deps.resolve(intent.place.trim().slice(0, 80));
      if (!found) return finish({ message: `暂时无法找到“${intent.place.slice(0, 80)}”，请尝试更具体的上海地点。`, items: [] });
      center = found;
      area = `${intent.place.slice(0, 80)}附近`;
    }
    sendEvent('progress', { stage: '正在检索附近点位与骑行路段' });
    const tagPreferences = requestedRouteTags(conversationIntent || { preferences: [], preferredTags: [], avoidTags: [] });
    const candidates = rankCandidatesByTags(await deps.near(center, .13, tagPreferences), tagPreferences);
    if (!candidates.length) return finish({ message: `${area}暂时没有可推荐的点位或路段，请移动地图或换个地点试试。`, items: [] });
    sendEvent('progress', { stage: '正在结合想法筛选推荐' });
    const selection = await deps.model(RECOMMENDATION_PROMPT, { intent, idea: combinedIdea, area, candidates: candidates.map(({ coordinates, ...candidate }) => candidate) });
    const ids = new Set<string>();
    const items: Array<Candidate & { reason: string }> = (Array.isArray(selection.items) ? selection.items : []).slice(0, 3).flatMap((item: any) => {
      const candidate = candidates.find(c => c.id === item?.id);
      if (!candidate || ids.has(candidate.id)) return [];
      ids.add(candidate.id);
      return [{ ...candidate, reason: typeof item.reason === 'string' ? item.reason.slice(0, 120) : '' }];
    });
    const rankedItems = rankCandidatesByTags(items, tagPreferences);
    if (rankedItems.length) placeContext = { query: area, terms: [], area: null, selectedId: null, candidates: rankedItems.map(x => ({ id: x.id, type: x.type, name: x.name })) };
    return finish({ message: rankedItems.length ? `为你找到${area}的推荐` : '暂时没有找到符合想法的结果，请换个描述试试。', center, area, items: rankedItems });
    }
    });
  } catch (error: any) {
    console.error('[IdeaRecommendation] Request failed:', error.code || error.message);
    return finish({ error: '推荐暂时不可用，请稍后重试。' }, 502);
  }
  };
}

export const recommendIdeas = createIdeaController();
