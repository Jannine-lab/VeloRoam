import { Request, Response } from 'express';
import axios from 'axios';
import { queryLookup as query } from '../config/db';
import { gcj02ToWgs84, getDistanceMeters } from '../utils/polyline';
import { buildIdeaRoute, CompositeRoute, RouteStop, trajectoryDistanceKm } from '../services/ideaRouteService';
import { clarificationOptions, ConversationIntent, RouteTagStatuses, sanitizeConversationIntent } from '../services/ideaIntent';
import { BudgetFallback, CandidateFailure, budgetDeviations, buildStopVariants, closestBudgetFallback, compareRouteCandidates, routeBoundsFromIntent } from '../services/ideaCandidatePlanner';
import { generateAutonomousRoute } from '../services/ideaAutonomousGenerator';
import { runIdeaGraph, sanitizePlaceContext, PlaceContext } from '../services/ideaAgentGraph';
import { findCandidateById, relatedSearchTerms, searchNamedPlaces, searchRelatedPlaces } from '../services/ideaPlaceSearch';
import { INTENT_PROMPT, LOOP_SELECTION_PROMPT, POINT_SELECTION_PROMPT, SEGMENT_SELECTION_PROMPT, RECOMMENDATION_PROMPT, RELATED_SEARCH_TERMS_PROMPT } from '../prompts/ideaPrompts';
import { createIdeaMetrics, invokeIdeaJson, publicIdeaMetrics } from '../services/ideaModel';
import { NearbyEvidence, runIdeaToolAgent, ToolModelCall, wantsNearbyDiscovery } from '../services/ideaToolAgent';
import { attachSegmentTags, rankCandidatesByTags, requestedRouteTags, tagPreferenceScore } from '../services/ideaTagPreferences';
import { addEnrouteSegments } from '../services/ideaEnrouteSegments';
import { fetchAmapBicyclingCandidates } from '../services/amapFewestSignalService';
import { exploreConfirmedRoute } from '../services/ideaAgentEnroute';
import { buildRequirementState, mergeIntent, RequirementState } from '../services/ideaRequirementState';
import { applyExplicitPriority, routePolicy, RoutePolicy, requiredTagsReason } from '../services/ideaRoutePolicy';
import { compareOptions } from '../services/ideaAgentRouteTools';
import { explicitDiscoveryTheme, fallbackDiscoveryTerms, isThematicDiscovery, rankDiscoveryCandidates, DiscoveryCandidate } from '../services/ideaDiscovery';
import { applyRequirementEdit } from '../services/ideaRequirementEdit';
import { searchSegments, segmentSearchSchema } from '../services/ideaSegmentSearch';
import { searchPoints } from '../services/ideaPointSearch';
import { explainPlanningFailure, PlanningObservation } from '../services/ideaPlanningEvidence';

type Point = { lat: number; lng: number };
export type Candidate = { id: string; type: 'point' | 'segment'; name: string; lat: number; lng: number; category?: string; address?: string; districtName?: string; distanceKm?: number; coordinates?: Point[]; averageGrade?: number | null; elevationGainM?: number | null; athleteCount?: number | null; effortCount?: number | null; starCount?: number | null; hazardous?: boolean | null; recordedDistanceKm?: number | null; score?: number | null; tags?: RouteTagStatuses };
const continuityNote = (route: { continuity?: { maxGapMeters: number } }) => route.continuity && route.continuity.maxGapMeters > 5 ? `轨迹端点与拼接处或途经点最大间隔约 ${Math.ceil(route.continuity.maxGapMeters)} 米，间隔内通行尚未验证。` : '';
const validPoint = (p: any): p is Point => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

/** Only treat a clarification as candidate selection when its options refer to actual retrieved names. */
function isCandidateChoice(options: unknown, candidates: Candidate[]): boolean {
  if (!Array.isArray(options) || !candidates.length) return false;
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]/gu, '');
  return options.some(value => {
    if (typeof value !== 'string' || /先.{0,30}(?:再|后)|之前|之后|全程|到达后|去程|返程|上限|下限/.test(value)) return false;
    const option = normalize(value.replace(/^选择/, ''));
    if (/^第?[一二三四五六123456]个$/.test(option)) return true;
    return candidates.some(candidate => {
      const name = normalize(candidate.name);
      if (option.length >= 2 && name.length >= 2 && (option.includes(name) || name.includes(option))) return true;
      for (let i = 0; i + 6 <= option.length; i++) if (name.includes(option.slice(i, i + 6))) return true;
      return false;
    });
  });
}

function asksCandidateChoice(reply: unknown, options: unknown): boolean {
  return typeof reply === 'string' && Array.isArray(options) && options.length > 0 &&
    /(?:请选择|选一个|选哪|选择其中|选择想骑).{0,25}(?:地点|路段|候选|哪|一处|一个|一项|其一|骑)/.test(reply) &&
    !options.some(value => typeof value === 'string' && /先.{0,30}(?:再|后)|之前|之后|全程|到达后|去程|返程/.test(value));
}

/** A blocking clarification is a separate interaction from ordinary suggestion buttons. */
function clarificationQuestion(kind: 'scope' | 'order' | 'purpose' | 'candidate', options: string[]) {
  return { kind, options: [...new Set(options.filter(option => typeof option === 'string' && !!option.trim()).map(option => option.trim()))].slice(0, 3), allowCustom: true };
}

function routeFailureMessage(failures: CandidateFailure[], hasLimits: boolean): string {
  if (failures.some(item => ['below_distance', 'above_distance', 'below_time', 'above_time'].includes(item.kind))) {
    return '已找到能够连接的候选路线，但实际里程或时间不符合要求。可以调整预算或途经点后再试。';
  }
  const navigation = failures.filter((item): item is Extract<CandidateFailure, { kind: 'navigation' }> => item.kind === 'navigation');
  const stages = new Set(navigation.map(item => item.stage));
  const stage = stages.size === 1 ? navigation[0]?.stage : undefined;
  const stageLabel = stage === 'to_first_stop' ? '前往第一个途经点时，' : stage === 'between_stops' ? '连接途经点时，' : stage === 'to_destination' ? '规划最后一段时，' : '';
  if (navigation.length && navigation.every(item => item.reason === 'rate_limited')) {
    return '地图骑行服务的访问频率已达限制，请稍后再试。';
  }
  if (navigation.length && navigation.every(item => item.reason === 'quota_exhausted')) {
    return '地图骑行服务的调用额度已用完或服务已到期，请检查地图服务配额。';
  }
  if (navigation.length && navigation.every(item => item.reason === 'outside_coverage')) {
    return '地图服务无法覆盖路线中的部分位置，请检查起点和途经点。';
  }
  if (navigation.length && navigation.every(item => item.reason === 'distance_limit')) {
    return '导航请求中的位置相距过远，无法直接规划这一段。可以调整途经点或分段规划。';
  }
  if (navigation.length && navigation.every(item => item.reason === 'temporarily_unavailable')) {
    return '地图骑行服务暂时没有响应，系统已自动重试。请稍后再试。';
  }
  if (navigation.length && navigation.every(item => item.reason === 'not_configured' || item.reason === 'request_rejected')) {
    return '地图骑行服务未能完成请求，请检查地图服务配置或稍后重试。';
  }
  if (navigation.length && navigation.every(item => item.reason === 'endpoint_mismatch' || item.reason === 'junction_gap')) {
    return `${stageLabel}导航轨迹与起终点或途经路段的连接间隔超过 100 米，暂时无法确认是否连通。可以尝试更换途经点或路段。`;
  }
  if (navigation.length && navigation.every(item => item.reason === 'no_route')) {
    return `${stageLabel}地图没有找到连接起终点与所选途经位置的骑行路线，可以尝试更换途经点或路段。`;
  }
  return hasLimits ? '尝试了部分候选，但未能验证满足预算且连通的路线。可以稍后重试，或调整途经点和预算。' : '暂时未能验证完整骑行路线的连接，可以稍后重试或更换途经点。';
}

class IdeaLookupError extends Error {
  constructor(readonly stage: 'search' | 'location' | 'nearby') { super(`idea_${stage}_unavailable`); }
}

function boundedIdeaLookup<T>(work: () => Promise<T>, stage: 'search' | 'location' | 'nearby', timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new IdeaLookupError(stage)), timeoutMs);
    Promise.resolve().then(work).then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); reject(new IdeaLookupError(stage)); });
  });
}


async function resolvePlace(name: string): Promise<Point | null> {
  if (!process.env.AMAP_API_KEY) return null;
  const r = await axios.get('https://restapi.amap.com/v3/assistant/inputtips', { params: { key: process.env.AMAP_API_KEY, keywords: name, city: '上海', citylimit: true }, timeout: 8000 });
  const tip = (r.data?.tips || []).find((x: any) => typeof x.location === 'string' && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(x.location));
  if (!tip) return null;
  const [lng, lat] = tip.location.split(',').map(Number);
  const point = gcj02ToWgs84(lng, lat);
  return validPoint(point) ? point : null;
}

/** Only accept unambiguous official names or common administrative suffix omissions. */
export function districtNameMatches(query: string, officialName: string): boolean {
  return officialName === query || ['区', '新区', '市', '县'].some(suffix => officialName === query + suffix);
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
      districtNameMatches(name, district.name) &&
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
  const segmentSql = `SELECT CAST(s.id AS CHAR) AS id, s.name, s.distance_km AS recordedDistanceKm, COALESCE(s.strava_score, s.raw_score) AS score, s.start_lat AS lat, s.start_lng AS lng, ST_AsText(s.geom) AS geometry, d.average_grade AS averageGrade, d.total_elevation_gain_m AS elevationGainM, d.athlete_count AS athleteCount, d.effort_count AS effortCount, d.hazardous FROM strava_segments s LEFT JOIN strava_segment_details d ON d.segment_id = s.id WHERE s.start_lat BETWEEN ? AND ? AND s.start_lng BETWEEN ? AND ? AND (d.is_private IS NULL OR d.is_private = 0)`;
  const readSegments = async () => {
    if (preferences.preferred.length) {
      try {
        return await query(`${segmentSql} ORDER BY (SELECT COUNT(*) FROM strava_segment_tag_evaluations t WHERE t.segment_id = s.id AND t.status = 'matched' AND t.tag IN (${preferences.preferred.map(() => '?').join(',')})) DESC, COALESCE(s.strava_score, s.raw_score) DESC LIMIT 500`, [...bounds, ...preferences.preferred]);
      } catch (error: any) { if (error?.code !== 'ER_NO_SUCH_TABLE' && error?.errno !== 1146) throw error; }
    }
    return query(`${segmentSql} ORDER BY COALESCE(s.strava_score, s.raw_score) DESC LIMIT 500`, bounds);
  };
  const [points, segments] = await Promise.all([
    query(`SELECT id, name, category, lat, lng FROM hot_points WHERE status = 'active' AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? ORDER BY cyclist_score DESC LIMIT 30`, bounds),
    readSegments()
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
  navigate?: typeof fetchAmapBicyclingCandidates; disableEnroute?: boolean; policy?: RoutePolicy;
  onEvidence?: (observation: PlanningObservation) => void;
}

export async function planFromIntent(intent: ConversationIntent, idea: string, suppliedOrigin: unknown, originLabel: unknown, progress: (stage: string) => void,
  overrides: Partial<IdeaPlannerDependencies> = {}): Promise<object> {
  const deps: IdeaPlannerDependencies = { resolve: resolveRoutePlace, near: candidatesNear, named: findNamedSegments,
    points: findPointCandidates, model: invokeIdeaJson, build: buildIdeaRoute, generate: generateAutonomousRoute, ...overrides };
  if (deps.policy?.block) return { ...deps.policy.block, items: [] };
  const requiredTags = deps.policy?.requiredTags || [];
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
  const effectiveBounds = routeBoundsFromIntent(intent, { strictTargetMinutes: deps.policy?.strictTargetMinutes });
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
  const startLabel = originName || (originLabel === 'manual' ? '所选起点' : originLabel === 'ip' ? 'IP 大致位置' : originLabel === 'gps-stale' ? '上次定位位置' : '当前位置');
  const optimizeEnroute = async (baseline: CompositeRoute, baseStops: RouteStop[]) => {
    const unchanged = { route: baseline, stops: baseStops, added: [] as string[], extraKm: 0 };
    if (deps.disableEnroute) return unchanged;
    // Avoid conditions cannot yet be checked on every connecting road.
    if (!estimateKm || tagPreferences.avoid.length || /不要|避开|避免|不经过/.test([...intent.preferences, currentIdea].join(' '))) return unchanged;
    if (!baseline.legs.some(leg => leg.type === 'connection' && leg.points.length >= 2)) return unchanged;
    progress('正在沿导航路线探索顺路路段并比较完整里程');
    const cache = new Map<string, ReturnType<typeof fetchAmapBicyclingCandidates>>();
    const navigate: typeof fetchAmapBicyclingCandidates = (a, b) => {
      const key = `${a.lat.toFixed(6)},${a.lng.toFixed(6)}:${b.lat.toFixed(6)},${b.lng.toFixed(6)}`;
      if (!cache.has(key)) cache.set(key, fetchAmapBicyclingCandidates(a, b));
      return cache.get(key)!;
    };
    try {
      return await addEnrouteSegments({ baseline, stops: baseStops, end, bounds: effectiveBounds, preferences: tagPreferences, overlapMode,
        near: center => deps.near(center, .13, tagPreferences),
        build: variant => deps.build(start, startLabel, end, endLabel, variant, navigate) });
    } catch { return unchanged; }
  };
  const enrouteNote = (added: string[], extraKm: number) => added.length
    ? `沿导航连接路线加入顺路路段：${added.map(name => `“${name}”`).join('、')}；与未加入时相比${extraKm >= 0 ? '增加' : '减少'}约 ${Math.abs(extraKm).toFixed(1)} 公里。路段评分和标签不代表风景或道路安全已验证。` : '';
  const stops: RouteStop[] = [];
  const budgetFallbacks: BudgetFallback[] = [];
  const rememberGeneratedFallbacks = (attempts: Awaited<ReturnType<typeof generateAutonomousRoute>>['attempts']) => {
    for (const attempt of attempts) if (attempt.status === 'outside_budget' && attempt.route && !requiredTagsReason(attempt.stops, requiredTags)) {
      budgetFallbacks.push({ route: attempt.route, stops: attempt.stops, priority: 0 });
    }
  };
  const fallbackResult = () => {
    const fallback = closestBudgetFallback(budgetFallbacks, effectiveBounds);
    if (!fallback) return null;
    const deviations = budgetDeviations(fallback.route, effectiveBounds).map(item => item.text).join('；');
    const target = intent.targetKm != null ? `目标约 ${intent.targetKm} 公里${intent.minKm == null && intent.maxKm == null ? '（按上下浮动 10% 搜索）' : ''}。` : '';
    const avoidance = tagPreferences.avoid.length || /不要|避开|避免|不经过/.test([...intent.preferences, currentIdea].join(' ')) ? '提出的避开条件尚未对全部连接道路验证。' : '';
    return { message: `暂未找到满足距离或时间要求的路线，先为你展示一条可连接的参考路线：${deviations}。请确认是否接受这些差异。`, items: [], route: fallback.route, routeOutsideBudget: true,
      distanceNote: `${target}不符合原定距离或时间要求：${deviations}。`, note: [continuityNote(fallback.route), areaConstraintNote, avoidance, fallback.route.hasEstimatedTime ? '部分骑行时间为估算值。' : '', intent.timeScope === 'total' && intent.stopMinutes === null ? '停留时长未知，预计时间仅含骑行。' : '', !originName && originLabel === 'ip' ? '起点使用 IP 大致位置，可能与实际位置有偏差。' : !originName && originLabel === 'gps-stale' ? '起点使用上次定位的位置，请确认是否仍准确。' : ''].filter(Boolean).join(' ') };
  };
  const alternatives: Array<{ index: number; stops: RouteStop[] }> = [];
  const requestedStops = intent.stops.map(stop => ({ ...stop }));
  if (!requestedStops.length) {
    const order = Array.isArray(intent.order) ? intent.order : [];
    if (needsSegment && needsPoint && (order.length !== 2 || new Set(order).size !== 2)) return { message: '你想先骑路段还是先去途经点？', options: ['先骑路段，再去途经点', '先去途经点，再骑路段'], question: clarificationQuestion('order', ['先骑路段，再去途经点', '先去途经点，再骑路段']), items: [] };
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
      const bounds = effectiveBounds;
      if (bounds.minKm != null && bounds.maxKm != null && bounds.minKm > bounds.maxKm) return { message: '里程范围的下限大于上限，请重新告诉我希望骑多少公里。', items: [] };
      if (bounds.minMinutes != null && bounds.maxMinutes != null && bounds.minMinutes > bounds.maxMinutes) return { message: '时间范围的下限大于上限，请重新告诉我希望骑多久。', items: [] };
      const generated = await deps.generate({ start, end, focus: area ? center : null, bounds, targetKm: estimateKm, overlapMode, startLabel: originName || '当前位置', endLabel }, deps.build);
      if (generated.selected?.route) {
        const optimized = area ? await optimizeEnroute(generated.selected.route, generated.selected.stops) : { route: generated.selected.route, added: [] as string[], extraKm: 0 };
        const route = optimized.route;
        const targetNote = intent.targetKm != null ? `目标约 ${intent.targetKm} 公里${intent.minKm == null && intent.maxKm == null ? '（上下浮动 10%）' : ''}，实际约 ${route.distanceKm.toFixed(1)} 公里。` : '';
        return { message: '已自主选择途经位置并生成骑行路线。', items: [], route, distanceNote: targetNote, note: [enrouteNote(optimized.added, optimized.extraKm), area ? `以“${area}”的位置作为方向参考，区域范围未作严格限制。` : '', '途经位置由导航服务连接，骑行体验与连接道路的具体条件尚未完整验证。', continuityNote(route), !originName && originLabel === 'ip' ? '起点使用 IP 大致位置，可能与实际位置有偏差。' : !originName && originLabel === 'gps-stale' ? '起点使用上次定位的位置，请确认是否仍准确。' : '', route.hasEstimatedTime ? '部分骑行时间按 18 km/h 估算。' : '', intent.timeScope === 'total' && intent.stopMinutes === null ? '停留时长未知，预计时间仅含骑行，总时长尚无法确认。' : ''].filter(Boolean).join(' ') };
      }
      rememberGeneratedFallbacks(generated.attempts);
      const fallback = fallbackResult();
      if (fallback) return fallback;
      if (generated.attempts.length) return { message: '已尝试多个自主途经方案，暂时没有找到符合预算且能连通的路线。可以调整距离、时间或目标区域后再试。', options: ['调整距离或时间', '调整目标区域'], items: [] };
    }
    const excludeSegments = /不要.{0,3}路段|不经过.{0,3}路段/.test(preferenceText);
    const excludePoints = /不要.{0,3}(点位|地点|休息|补给)|不经过.{0,3}(点位|地点)/.test(preferenceText);
    const available = rankCandidatesByTags((await deps.near(center, searchRadius, tagPreferences)).filter(candidate => candidate.hazardous !== true && (candidate.type === 'segment' ? !excludeSegments : !excludePoints)), tagPreferences);
    deps.onEvidence?.({ kind: 'segment', query: area || '附近环线路段', center, candidates: available.filter(item => item.type === 'segment') });
    deps.onEvidence?.({ kind: 'point', query: area || '附近环线地点', center, candidates: available.filter(item => item.type === 'point') });
    if (!available.length) return { message: '附近暂时没有可用于规划环线的路段或地点，可以换个起点或放宽要求再试。', options: ['放宽路线要求', '调整出发地点'], items: [] };
    let choice: any;
    try { choice = await deps.model(LOOP_SELECTION_PROMPT, { idea, intent, candidates: available.map(({coordinates, ...candidate}) => ({ ...candidate, distanceFromStartKm: Math.round(getDistanceMeters(start, candidate) / 100) / 10 })) }); }
    catch { return { message: `已检索到 ${available.length} 个环线候选，但候选筛选服务未完成，尚未生成完整路线。`, items: [] }; }
    const ids: string[] = Array.isArray(choice.ids) ? [...new Set<string>(choice.ids.filter((id: unknown): id is string => typeof id === 'string'))].slice(0, 6) : [];
    const modelChosen = ids.flatMap(id => { const candidate = available.find(item => item.id === id); return candidate ? [candidate] : []; });
    const mandatoryCandidates = requiredTags.length ? available.filter(item => item.type === 'segment' && requiredTags.some(tag => item.tags?.[tag] === 'matched')) : [];
    const ranked = rankCandidatesByTags([...modelChosen, ...mandatoryCandidates].filter((item, index, all) => all.findIndex(x => x.id === item.id) === index), tagPreferences).slice(0, 6);
    let candidates: RouteStop[] = ranked.flatMap<RouteStop>(item => {
      if (item.type === 'point') return [{ type: 'point' as const, name: item.name, coordinates: [{ lat: item.lat, lng: item.lng }] }];
      if (!item.coordinates?.length) return [];
      return [{ type: 'segment' as const, name: item.name, coordinates: item.coordinates, detail: { id: item.id, averageGrade: item.averageGrade ?? null, elevationGainM: item.elevationGainM ?? null, athleteCount: item.athleteCount ?? null, effortCount: item.effortCount ?? null, hazardous: item.hazardous ?? null, recordedDistanceKm: item.recordedDistanceKm ?? null, tags: item.tags } }];
    });
    if (requiredTags.length) candidates = candidates.filter(stop => !requiredTagsReason([stop], requiredTags));
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
      if (!point) {
        deps.onEvidence?.({ kind: 'point', query: name, center: anchor, candidates: [], unavailable: true });
        return { message: `地图服务未能唯一确定途经点“${name}”的位置，尚未生成完整路线。`, items: [] };
      }
      stops.push({ type: 'point', name, coordinates: [point] }); anchor = point;
    } else if (requested.type === 'point') {
      const kind = clean(requested.kind);
      progress('正在查找合适的途经点');
      let points: Candidate[];
      try { points = await deps.points(anchor, kind); }
      catch { deps.onEvidence?.({ kind: 'point', query: kind || '附近途经点', center: anchor, candidates: [], unavailable: true }); return { message: `检索“${kind || '途经点'}”附近地点时服务未完成，尚无法确定可选地点，也未生成完整路线。`, items: [] }; }
      deps.onEvidence?.({ kind: 'point', query: kind || '附近途经点', center: anchor, candidates: points });
      if (!points.length) return { message: `已搜索上一途经点附近的地点，但没有查到可用候选，暂时无法确定“${kind || '途经点'}”。`, items: [] };
      let choice: any;
      try { choice = await deps.model(POINT_SELECTION_PROMPT, { idea, intent, points: points.map(x => ({id:x.id, name:x.name, category:x.category, distanceFromPreviousKm:Math.round(getDistanceMeters(anchor, x)/100)/10})) }); }
      catch { return { message: `已检索到 ${points.length} 个附近地点，但地点筛选服务未完成，尚未确定“${kind || '途经点'}”也未生成完整路线。`, items: [] }; }
      const point = points.find(x => x.id === choice?.id);
      if (!point) return { message: `已检索到 ${points.length} 个附近地点，但系统未能确认哪一个符合“${kind || '途经点'}”，因此尚未选择地点，也未生成完整路线。`, items: [] };
      const pointChoices = [point].map(item => ({ type: 'point' as const, name: item.name, coordinates: [{ lat: item.lat, lng: item.lng }] }));
      alternatives.push({ index: stops.length, stops: pointChoices });
      anchor = {lat:point.lat,lng:point.lng}; stops.push(pointChoices[0]);
    } else if (requested.type === 'segment') {
      progress('正在检索路段及其坡度、爬升与热度详情');
      let searchCenter = name ? (await deps.resolve(name)) || anchor : anchor;
      if (!name && clean(intent.place) && !stops.length) {
        const area = await deps.resolve(clean(intent.place));
        if (!area) {
          deps.onEvidence?.({ kind: 'segment', query: clean(intent.place), center: anchor, candidates: [], unavailable: true });
          return { message: `无法确定“${clean(intent.place)}”的搜索中心，尚未在目标区域选择路段，也未生成完整路线。`, items: [] };
        }
        searchCenter = area;
      }
      let segments: Candidate[];
      try { segments = rankCandidatesByTags(name ? await deps.named(searchCenter, name, tagPreferences) : (await deps.near(searchCenter, searchRadius, tagPreferences)).filter(x => x.type === 'segment'), tagPreferences); }
      catch { deps.onEvidence?.({ kind: 'segment', query: name || clean(intent.place) || '附近路段', center: searchCenter, candidates: [], unavailable: true }); return { message: '路段检索服务未完成，暂时无法确定可用路段，也未生成完整路线。', items: [] }; }
      deps.onEvidence?.({ kind: 'segment', query: name || clean(intent.place) || '附近路段', center: searchCenter, candidates: segments });
      if (!segments.length) return { message: name ? `附近没有找到“${name}”路段，请换个名称或地点。` : '附近暂时没有可用路段，请调整要求。', items: [] };
      if (name && deps.policy?.strictNamedStops) {
        const exact = segments.filter(segment => segment.name === name && segment.hazardous !== true);
        if (exact.length !== 1) return { message: exact.length ? `找到多条名为“${name}”的路段，无法确定你选择的是哪一条，请重新选择。` : `未找到与已确认名称“${name}”一致的路段，请重新搜索或选择路段。`, items: [] };
        segments = exact;
      }
      let choice: any;
      try { choice = await deps.model(SEGMENT_SELECTION_PROMPT, { idea, intent, segments: segments.map(({coordinates, ...x}) => ({...x, distanceFromPreviousKm:Math.round(getDistanceMeters(anchor, x)/100)/10})) }); }
      catch { return { message: `已检索到 ${segments.length} 条候选路段，但路段筛选服务未完成，因此尚未生成完整路线。`, items: [] }; }
      const ids: string[] = Array.isArray(choice?.ids) ? [...new Set<string>(choice.ids.filter((id: unknown): id is string => typeof id === 'string'))].slice(0, 6) : [];
      const modelChosen = ids.flatMap(id => { const segment = segments.find(x => x.id === id && x.hazardous !== true); return segment ? [segment] : []; });
      const mandatoryCandidates = name && deps.policy?.strictNamedStops ? segments : requiredTags.length ? segments.filter(item => item.hazardous !== true && requiredTags.some(tag => item.tags?.[tag] === 'matched')) : [];
      const orderedSegments = rankCandidatesByTags([...modelChosen, ...mandatoryCandidates].filter((item, index, all) => all.findIndex(x => x.id === item.id) === index), tagPreferences).slice(0, 6);
      const chosen = orderedSegments.flatMap(segment => { if (!segment.coordinates) return [];
        return [{ type:'segment' as const, name:segment.name, coordinates:segment.coordinates, detail: { id: segment.id, averageGrade: segment.averageGrade ?? null, elevationGainM: segment.elevationGainM ?? null, athleteCount: segment.athleteCount ?? null, effortCount: segment.effortCount ?? null, hazardous: segment.hazardous ?? null, recordedDistanceKm: segment.recordedDistanceKm ?? null, tags: segment.tags } }]; });
      if (!chosen.length) return { message: `已检索到 ${segments.length} 条候选路段，但尚不能确认其中有满足要求且可用于规划的路段，因此未生成完整路线。`, items: [] };
      alternatives.push({ index: stops.length, stops: chosen });
      stops.push(chosen[0]); anchor = chosen[0].coordinates[chosen[0].coordinates.length - 1];
    }
  }
  if (loop && !stops.length) return { message: '暂时没有找到可用的环线候选，可以放宽要求或调整出发地点。', options: ['放宽路线要求', '调整出发地点'], items: [] };
  const bounds = effectiveBounds;
  const { targetKm, minKm, maxKm, minMinutes, maxMinutes, targetMinutes } = bounds;
  const hasExplicitBounds = intent.minKm != null || intent.maxKm != null;
  if (minKm != null && maxKm != null && minKm > maxKm) return { message: '里程范围的下限大于上限，请重新告诉我希望骑多少公里。', items: [] };
  if (minMinutes != null && maxMinutes != null && minMinutes > maxMinutes) return { message: '时间范围的下限大于上限，请重新告诉我希望骑多久。', items: [] };
  const priority = (value: RouteStop[]) => -value.reduce((sum, stop) => sum + (stop.type === 'segment' ? tagPreferenceScore({ id: stop.detail?.id || '', type: 'segment', tags: stop.detail?.tags }, tagPreferences) : 0), 0);
  const variants = buildStopVariants(stops, alternatives, priority, 6);
  if (loop && stops.length >= 1 && estimateKm && !tagPreferences.avoid.length && !/不要|避开|不经过/.test(intent.preferences.join(' '))) {
    progress('正在保留指定途经顺序并生成自主连接点');
    const generated = await deps.generate({ start, end, bounds, targetKm: estimateKm, fixedSegment: stops.length === 1 && stops[0].type === 'segment' ? stops[0] : null, fixedStops: stops, overlapMode, startLabel: originName || '当前位置', endLabel }, deps.build);
    if (generated.selected?.route && !requiredTagsReason(generated.selected.stops, requiredTags)) {
      const optimized = await optimizeEnroute(generated.selected.route, generated.selected.stops);
      const route = optimized.route;
      return { message: `已按顺序经过${stops.map(stop => `“${stop.name}”`).join('、')}，并结合自主途经点生成完整骑行路线。`, items: [], route,
        distanceNote: [targetKm != null ? `目标约 ${targetKm} 公里${!hasExplicitBounds ? '（按上下浮动 10% 搜索）' : ''}，实际约 ${route.distanceKm.toFixed(1)} 公里。` : '',
          intent.timeScope === 'total' && intent.stopMinutes != null ? `预计骑行 ${Math.round(route.durationMin)} 分钟、停留 ${intent.stopMinutes} 分钟，总计约 ${Math.round(route.durationMin + intent.stopMinutes)} 分钟。` : targetMinutes != null ? `目标约 ${targetMinutes} 分钟${deps.policy?.strictTargetMinutes && intent.minMinutes == null && intent.maxMinutes == null ? '（允许上下浮动 10%）' : ''}，预计骑行 ${Math.round(route.durationMin)} 分钟。` : ''].filter(Boolean).join(' '),
        note: [enrouteNote(optimized.added, optimized.extraKm), stops.some(stop => stop.type === 'segment') ? '指定路段按所选轨迹方向连接，骑行体验与连接道路条件尚未完整验证。' : '骑行体验与连接道路条件尚未完整验证。', continuityNote(route), areaConstraintNote, route.hasEstimatedTime ? '部分骑行时间按 18 km/h 估算。' : '', intent.timeScope === 'total' && intent.stopMinutes === null ? '停留时长未知，预计时间仅含骑行，总时长尚无法确认。' : '', !originName && originLabel === 'ip' ? '起点使用 IP 大致位置，可能与实际位置有偏差。' : !originName && originLabel === 'gps-stale' ? '起点使用上次定位的位置，请确认是否仍准确。' : ''].filter(Boolean).join(' ') };
    }
    rememberGeneratedFallbacks(generated.attempts);
  }
  progress(variants.length > 1 ? '正在比较候选路线与实际里程' : '正在规划骑行连接路线');
  const failures: CandidateFailure[] = [];
  const routingCache = new Map<string, ReturnType<typeof fetchAmapBicyclingCandidates>>();
  const navigate: typeof fetchAmapBicyclingCandidates = (a, b) => {
    const key = `${a.lat.toFixed(6)},${a.lng.toFixed(6)}:${b.lat.toFixed(6)},${b.lng.toFixed(6)}`;
    if (!routingCache.has(key)) routingCache.set(key, (deps.navigate || fetchAmapBicyclingCandidates)(a, b).catch(error => { routingCache.delete(key); throw error; }));
    return routingCache.get(key)!;
  };
  const result = await compareRouteCandidates(variants, bounds, variant => deps.build(start, startLabel, end, endLabel, variant, navigate), 6, failures,
    requiredTags.length ? (_route, selectedStops) => requiredTagsReason(selectedStops, requiredTags) : undefined, budgetFallbacks);
  const hasLimits = minKm != null || maxKm != null || minMinutes != null || maxMinutes != null;
  if (!result) {
    const fallback = fallbackResult();
    if (fallback) return fallback;
    // Only log bounded categories, not coordinates, route names, URLs or provider credentials.
    console.warn('[IdeaRoute] Candidate planning failed:', JSON.stringify(failures));
    const attributeFailure = failures.length && failures.every(failure => failure.kind === 'required_attribute');
    return { message: attributeFailure ? `${requiredTagsReason([], requiredTags)} 可以调整路段要求或扩大搜索范围。` : routeFailureMessage(failures, hasLimits), items: [], options: hasLimits ? ['放宽距离或时间要求', '调整途经点'] : ['重试规划', '调整途经点'] };
  }
  const optimized = requestedStops.length || endName || clean(intent.place) ? await optimizeEnroute(result.route, result.stops) : { route: result.route, added: [] as string[], extraKm: 0 };
  const route = optimized.route;
  const distanceNote = targetKm ? `目标约 ${targetKm} 公里${!hasExplicitBounds ? '（按上下浮动 10% 搜索）' : ''}，实际约 ${route.distanceKm.toFixed(1)} 公里。` : '';
  const timeGoal = targetMinutes != null ? `目标约 ${targetMinutes} 分钟${deps.policy?.strictTargetMinutes && intent.minMinutes == null && intent.maxMinutes == null ? '（允许上下浮动 10%）' : ''}，` : '';
  const timeNote = intent.timeScope === 'total' && intent.stopMinutes != null
    ? `${timeGoal}预计骑行 ${Math.round(route.durationMin)} 分钟、停留 ${intent.stopMinutes} 分钟，总计约 ${Math.round(route.durationMin + intent.stopMinutes)} 分钟。`
    : targetMinutes != null ? `${timeGoal}预计骑行 ${Math.round(route.durationMin)} 分钟。` : '';
  const avoidanceNote = tagPreferences.avoid.length ? '已排除标签命中的候选路段；未知标签和连接道路未能完整验证避开条件。' : /不要|避开|避免|不经过/.test([...intent.preferences, currentIdea].join(' ')) ? '提出的避开条件尚未对全部连接道路验证。' : '';
  return { message: autoLoop ? `为你选择了${result.stops[0].name}作为途经${result.stops[0].type === 'segment' ? '路段' : '地点'}，并规划了返回起点的路线。` : '已生成完整骑行路线', items: [], route, distanceNote: [distanceNote, timeNote].filter(Boolean).join(' '), note: [enrouteNote(optimized.added, optimized.extraKm), continuityNote(route), areaConstraintNote, result.stops.some(stop => stop.type === 'segment') ? '路段里程按所用轨迹估算，包含轨迹中的折返和绕圈；轨迹精度可能影响结果。实际通行情况请以现场为准。' : '', route.hasEstimatedTime ? '部分骑行时间按 18 km/h 估算。' : '', intent.timeScope === 'total' && intent.stopMinutes === null ? '停留时长未知，预计时间仅含骑行，总时长尚无法确认。' : '', avoidanceNote, !originName && originLabel === 'ip' ? '起点使用 IP 大致位置，可能与实际位置有偏差。' : !originName && originLabel === 'gps-stale' ? '起点使用上次定位的位置，请确认是否仍准确。' : ''].filter(Boolean).join(' ') };
}

export interface IdeaControllerDependencies {
  model: typeof invokeIdeaJson; plan: typeof planFromIntent; near: typeof candidatesNear;
  segmentSearch: typeof searchSegments; pointSearch: typeof searchPoints;
  resolve: typeof resolvePlace; search: typeof searchNamedPlaces; related: typeof searchRelatedPlaces; byId: typeof findCandidateById; explore: typeof exploreConfirmedRoute; isConfigured: () => boolean; toolCaller?: ToolModelCall;
  lookupTimeoutMs?: number; heartbeatMs?: number;
}

function routeConfirmation(intent: ConversationIntent, state?: RequirementState | null): object {
  const end = intent.returnToStart ? (intent.origin || '当前位置（返回出发地）') : (intent.destination || '当前位置（默认）');
  const distance = [intent.targetKm != null ? `全程目标约 ${intent.targetKm} 公里` : '', intent.minKm != null ? `不少于 ${intent.minKm} 公里` : '', intent.maxKm != null ? `不超过 ${intent.maxKm} 公里` : ''].filter(Boolean).join('，');
  const time = [intent.targetMinutes != null ? `目标约 ${intent.targetMinutes} 分钟` : '', intent.minMinutes != null ? `不少于 ${intent.minMinutes} 分钟` : '', intent.maxMinutes != null ? `不超过 ${intent.maxMinutes} 分钟` : ''].filter(Boolean).join('，');
  const stops = intent.stops.map(s => s.name || s.kind || (s.type === 'segment' ? '骑行路段' : '途经点'));
  if (!stops.length) {
    if (intent.needsSegment) stops.push(intent.segmentName || '骑行路段');
    if (intent.needsPoint) stops.push(intent.pointName || intent.pointKind || '途经点');
  }
  const lines = [`出发：${intent.origin || '当前位置（默认）'}`, `结束：${end}`];
  if (intent.place) lines.push(`目标区域：${intent.place}${state?.requirements.place.priority === 'required' ? '（必须位于该区域）' : '（作为方向参考）'}`);
  if (stops.length) lines.push(`途经顺序：${stops.join(' → ')}`);
  if (distance) lines.push(`距离：${distance}`);
  if (time) lines.push(`时间：${time}${intent.timeScope === 'total' ? '（含停留）' : intent.timeScope === 'riding' ? '（骑行时间）' : '（默认按骑行时间）'}${state?.requirements.targetMinutes.priority === 'required' && intent.targetMinutes != null && intent.minMinutes == null && intent.maxMinutes == null ? '（必须控制在目标上下浮动 10%）' : ''}`);
  if (intent.stopMinutes != null) lines.push(`停留：${intent.stopMinutes} 分钟`);
  if (intent.preferences.length) lines.push(`${state?.requirements.preferences.priority === 'required' ? '必须满足的体验' : '体验与要求'}：${intent.preferences.join('、')}`);
  const tags: Record<string, string> = { climbing: '爬坡', loop: '绕圈路段', out_and_back: '往返路段', long_distance: '长距离路段', popular: '热门路段', highly_starred: '高评分路段' };
  const requiredTags = intent.preferredTags.filter(tag => state?.tagPriorities?.[tag] === 'required');
  const preferredTags = intent.preferredTags.filter(tag => !requiredTags.includes(tag));
  if (requiredTags.length) lines.push(`必须包含的路段属性：${requiredTags.map(tag => tags[tag]).join('、')}`);
  if (preferredTags.length) lines.push(`偏好路段：${preferredTags.map(tag => tags[tag]).join('、')}`);
  if (intent.avoidTags.length) lines.push(`${state?.requirements.avoidTags.priority === 'required' ? '必须避开' : '希望避开'}：${intent.avoidTags.map(tag => tags[tag]).join('、')}`);
  return { message: `我理解的骑行需求是：\n${lines.join('\n')}\n请确认这些条件，或直接告诉我需要修改的地方。`, options: ['确认，开始规划'], items: [] };
}

export function createIdeaController(overrides: Partial<IdeaControllerDependencies> = {}) {
  const baseDeps: IdeaControllerDependencies = { model: invokeIdeaJson, plan: planFromIntent, near: candidatesNear,
    resolve: resolveRoutePlace, search: searchNamedPlaces, related: searchRelatedPlaces, byId: findCandidateById, explore: exploreConfirmedRoute, segmentSearch: searchSegments, pointSearch: searchPoints, isConfigured: () => !!process.env.DEEPSEEK_API_KEY, ...overrides };
  return async (req: Request, res: Response) => {
  const metrics = createIdeaMetrics();
  const model = overrides.model || ((system: string, input: object) => invokeIdeaJson(system, input, metrics));
  const deps: IdeaControllerDependencies = { ...baseDeps, model, plan: overrides.plan || ((intent, idea, origin, label, progress, plannerOverrides) =>
    planFromIntent(intent, idea, origin, label, progress, { model, ...plannerOverrides })) };
  // Per-request caches avoid repeating reads already performed by native tools.
  const searches = new Map<string, Promise<Candidate[]>>();
  const retrieved = new Map<string, Candidate>();
  const rememberCandidates = (items: Candidate[]) => { for (const item of items) retrieved.set(item.id, item); return items; };
  const places = new Map<string, Promise<Point | null>>();
  const search = (name: string, terms: unknown = []) => {
    const key = JSON.stringify([name, terms]);
    if (!searches.has(key)) searches.set(key, boundedIdeaLookup(() => deps.search(name, terms), 'search', overrides.lookupTimeoutMs ?? 7000).then(rememberCandidates));
    return searches.get(key)!;
  };
  const resolve = (name: string) => {
    if (!places.has(name)) places.set(name, boundedIdeaLookup(() => deps.resolve(name), 'location', overrides.lookupTimeoutMs ?? 12000));
    return places.get(name)!;
  };
  const details = new Map<string, Promise<Candidate | null>>();
  const detail = (id: string, name: string) => {
    if (!details.has(id)) details.set(id, (overrides.search && !overrides.byId
      ? search(name).then(items => items.find(item => item.id === id && item.hazardous !== true) || null)
      : deps.byId(id)).then(item => { if (item) rememberCandidates([item]); return item; }));
    return details.get(id)!;
  };
  const originSource = ['gps', 'gps-stale', 'ip', 'manual'].includes(req.body?.originSource) ? req.body.originSource : 'provided_origin';
  const agentLocation = validPoint(req.body?.origin) ? { point: req.body.origin as Point, source: originSource as 'gps' | 'gps-stale' | 'ip' | 'manual' | 'provided_origin' } :
    { point: req.body?.center as Point, source: 'map_center' as const };
  const agentNearby = (center: Point, radiusKm: number) => deps.near(center, radiusKm / 111.2,
    requestedRouteTags(conversationIntent || { preferences: [], preferredTags: [], avoidTags: [] }));
  const attributeNearby = (center: Point, radiusKm: number, preferred: ConversationIntent['preferredTags'], avoid: ConversationIntent['avoidTags']) =>
    deps.near(center, radiusKm / 111.2, { preferred, avoid, leisure: false });
  const discoveryCache = new Map<string, Promise<{ terms: string[]; candidates: DiscoveryCandidate[]; partial: boolean }>>();
  const discover = (queryText: string, center: Point, radiusKm: number, type: 'segment' | 'point' | 'all', intent: ConversationIntent | null) => {
    const preferences = requestedRouteTags(intent || { preferences: [], preferredTags: [], avoidTags: [] });
    const key = JSON.stringify([queryText, center, radiusKm, type, preferences, intent?.pointKind]);
    if (!discoveryCache.has(key)) discoveryCache.set(key, (async () => {
      sendEvent('progress', { stage: '正在扩展关键词并搜索附近候选' });
      let terms = fallbackDiscoveryTerms(queryText, idea);
      let partial = false;
      if (terms.length < 2) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const expanded = await Promise.race([model(RELATED_SEARCH_TERMS_PROMPT, { query: queryText, idea }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('expansion_timeout')), 5000); })]);
          terms = relatedSearchTerms(queryText, idea, expanded?.terms);
        } catch { partial = true; } finally { if (timer) clearTimeout(timer); }
      }
      const results = await Promise.allSettled([
        search(queryText),
        // A substituted search dependency must not unexpectedly access the real database in isolated callers.
        overrides.search && !overrides.related ? Promise.resolve([] as Candidate[]) : deps.related(center, terms),
        preferences.preferred.length || intent?.pointKind ? deps.near(center, radiusKm / 111.2, preferences) : Promise.resolve([] as Candidate[])
      ]);
      if (results[0].status === 'rejected' && results[1].status === 'rejected' && (!(preferences.preferred.length || intent?.pointKind) || results[2].status === 'rejected')) throw new Error('discovery_unavailable');
      if (results.some(result => result.status === 'rejected')) partial = true;
      const list = (index: number) => results[index].status === 'fulfilled' ? (results[index] as PromiseFulfilledResult<Candidate[]>).value : [];
      const candidates = rankDiscoveryCandidates({ original: list(0), related: list(1), attributes: list(2), query: queryText, terms, center, radiusKm, preferences, type, pointKind: intent?.pointKind });
      rememberCandidates(candidates);
      return { terms, candidates, partial };
    })());
    return discoveryCache.get(key)!;
  };
  let nearbyEvidence: NearbyEvidence | null = null;
  const interpret = async (input: object) => {
    const result = await (overrides.model && !overrides.toolCaller ? model(INTENT_PROMPT, input) : runIdeaToolAgent({
    input, search, resolve, detail, nearby: agentNearby, attributeNearby, segmentSearch: deps.segmentSearch, pointSearch: deps.pointSearch, location: agentLocation, metrics, callModel: overrides.toolCaller,
    expanded: (query, radiusKm, type) => discover(query, agentLocation.point, radiusKm, type, conversationIntent),
    onNearby: evidence => { nearbyEvidence = evidence; rememberCandidates(evidence.candidates); },
    onProgress: stage => sendEvent('progress', { stage })
    }));
    const theme = explicitDiscoveryTheme(idea);
    if (theme && !result.lookup?.name && !result.selectedCandidateId && !placeContext) {
      result.lookup = { name: theme, terms: [], kind: 'ambiguous', expand: true };
      if (result.mode === 'answer' && /规划|设计|安排/.test(idea)) { result.mode = 'route'; result.requestType = 'route'; }
      else if (result.mode === 'answer' && /推荐|查找|找找|有哪些/.test(idea)) { result.mode = 'recommend'; result.requestType = 'recommend'; }
    }
    applyExplicitPriority(idea, result);
    return result;
  };
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
  let initialIntent = conversationIntent;
  let lastInterpretation: any = null;
  let placeContext: PlaceContext | null = sanitizePlaceContext(req.body?.placeContext);
  let previousRequirementState = buildRequirementState(conversationIntent, conversationIntent, req.body?.requirementState, false, placeContext, new Map());
  const confirmed = !req.body?.requirementEdit && conversationIntent?.confirmationPending === true && /^(确认，开始规划|确认,开始规划|确认|确定|是的|没错|可以|好|好的|对|对的|行|开始规划)[。！!\s]*$/.test(idea);
  const stream = (req.get('accept') || '').includes('text/event-stream');
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stopHeartbeat = () => { if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined; } };
  if (stream) {
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n'); }, overrides.heartbeatMs ?? 10000);
    heartbeat.unref();
    if (typeof res.on === 'function') res.on('close', stopHeartbeat);
  }
  const sendEvent = (event: string, data: object) => {
    if (stream && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const finish = (data: object, status = 200) => {
    stopHeartbeat();
    const items = (data as { items?: unknown }).items;
    if (Array.isArray(items)) rememberCandidates(items.filter((item): item is Candidate => item && typeof item.id === 'string' && (item.type === 'point' || item.type === 'segment')));
    const requirementState = buildRequirementState(conversationIntent, initialIntent, previousRequirementState, confirmed, placeContext, retrieved, lastInterpretation);
    const payload = { ...data, meta: publicIdeaMetrics(metrics), ...(conversationTitle ? { title: conversationTitle } : {}), contextIntent: conversationIntent, placeContext, requirementState };
    if (stream) { sendEvent(status >= 400 ? 'error' : 'result', payload); return res.end(); }
    return res.status(status).json(payload);
  };
  try {
    if (req.body?.requirementEdit) {
      try {
        if (req.body.requirementEdit.field === 'place' && req.body.hasPendingQuestion === true && placeContext && !placeContext.selectedId) {
          throw new Error('请先回答当前地点选择问题，再修改目标区域。');
        }
        const updated = applyRequirementEdit(conversationIntent, req.body.requirementEdit, previousRequirementState);
        conversationIntent = updated.intent; lastInterpretation = updated.interpretation;
        if (req.body.requirementEdit.field === 'place' && !placeContext?.selectedId) placeContext = null;
        if (req.body.hasPendingQuestion === true) {
          conversationIntent.confirmationPending = false;
          return finish({ message: '已更新骑行需求，请继续回答上一个问题。', items: [] });
        }
        return finish(routeConfirmation(conversationIntent, buildRequirementState(conversationIntent, initialIntent, previousRequirementState, false, placeContext, retrieved, lastInterpretation)));
      } catch (error: any) { return finish({ error: typeof error?.message === 'string' ? error.message : '暂时无法修改需求，请重试。' }, 400); }
    }
    if (req.body?.moreSearch) {
      const request = req.body.moreSearch;
      const queryText = typeof request.query === 'string' ? request.query.trim().slice(0, 80) : '';
      const originalIdea = typeof request.idea === 'string' ? request.idea.trim().slice(0, 500) : '';
      const center = validPoint(request.center) ? request.center : null;
      const radiusKm = typeof request.radiusKm === 'number' && Number.isFinite(request.radiusKm) ? Math.max(1, Math.min(50, request.radiusKm)) : 50;
      const requestedType = request.type === 'segment' || request.type === 'point' ? request.type : 'all';
      if (!queryText || !center) return finish({ error: '扩展搜索缺少关键词或搜索中心，请重新查询。' }, 400);
      if (request.segmentFilters) {
        const parsed = segmentSearchSchema.safeParse(request.segmentFilters);
        if (!parsed.success) return finish({ error: '路段筛选条件无效，请重新搜索。' }, 400);
        sendEvent('progress', { stage: '正在按原条件查找更多路段' });
        const filters = { ...parsed.data, limit: 6 };
        const found = await deps.segmentSearch(center, filters);
        const previousIds = new Set(placeContext?.seenCandidateIds?.length ? placeContext.seenCandidateIds : placeContext?.candidates.map(item => item.id) || []);
        const items = found.candidates.filter(item => !previousIds.has(item.id)).map(item => ({ ...item, reason: '符合原先的路段筛选条件；距搜索中心为起点直线距离。' }));
        const seen = [...previousIds, ...items.map(item => item.id)].slice(-200);
        placeContext = { query: queryText, terms: filters.nameTerms || [], area: placeContext?.area || null, selectedId: null, seenCandidateIds: seen,
          candidates: [...items.map(item => ({ id: item.id, type: item.type, name: item.name })), ...(placeContext?.candidates || []).filter(item => !items.some(next => next.id === item.id))].slice(0, 12) };
        const nextOffset = found.offset + found.candidates.length;
        const hasMore = nextOffset < found.total && nextOffset <= 200 && found.candidates.length > 0;
        return finish({ message: items.length ? `按原条件又找到 ${items.length} 条路段，共有 ${found.total} 条匹配。` : '这一页没有新的匹配路段。', items,
          options: items.slice(0, 3).map(item => `选择${item.name}`), segmentSearch: { total: found.total, offset: found.offset, returned: items.length, hasMore },
          ...(hasMore ? { moreSearch: { query: queryText, idea: originalIdea, center, segmentFilters: { ...filters, offset: nextOffset } } } : {}) });
      }
      sendEvent('progress', { stage: '正在生成关联检索词' });
      const expanded = await model(RELATED_SEARCH_TERMS_PROMPT, { query: queryText, idea: originalIdea });
      const terms = relatedSearchTerms(queryText, originalIdea, expanded?.terms);
      if (!terms.length) return finish({ error: '暂时无法生成可用的关联词，请换个描述重试。' }, 502);
      sendEvent('progress', { stage: '正在附近检索关联路段和地点' });
      const previousIds = new Set(placeContext?.seenCandidateIds?.length ? placeContext.seenCandidateIds : placeContext?.candidates.map(item => item.id) || []);
      const preferences = requestedRouteTags(conversationIntent || { preferences: [], preferredTags: [], avoidTags: [] });
      const seenIds = new Set(previousIds);
      const matches = rankCandidatesByTags(await deps.related(center, terms), preferences)
        .filter(candidate => { if (seenIds.has(candidate.id) || candidate.hazardous === true || (requestedType !== 'all' && candidate.type !== requestedType) || getDistanceMeters(center, candidate) > radiusKm * 1000) return false; seenIds.add(candidate.id); return true; })
        .sort((a, b) => Number(b.name.toLocaleLowerCase().includes(queryText.toLocaleLowerCase())) - Number(a.name.toLocaleLowerCase().includes(queryText.toLocaleLowerCase())) ||
          tagPreferenceScore(b, preferences) - tagPreferenceScore(a, preferences) || getDistanceMeters(center, a) - getDistanceMeters(center, b));
      const items = matches.slice(0, 6).map(candidate => {
        const matched = terms.find(term => candidate.name.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
        return { ...candidate, reason: `${matched ? `名称包含“${matched}”` : '名称与关联词匹配'}，距搜索中心约 ${(getDistanceMeters(center, candidate) / 1000).toFixed(1)} 公里；相关词不代表已确认实际位置或骑行体验。` };
      });
      const shownIds = [...previousIds, ...items.map(item => item.id)].slice(-200);
      placeContext = { query: queryText, terms, area: placeContext?.area || null, selectedId: null, seenCandidateIds: shownIds,
        candidates: [...items.map(item => ({ id: item.id, type: item.type, name: item.name })), ...(placeContext?.candidates || []).filter(item => !items.some(next => next.id === item.id))].slice(0, 12) };
      const options = items.slice(0, 3).map(item => `选择${item.name}`);
      return finish({ message: items.length ? `已在搜索中心 ${radiusKm} 公里内扩展检索：${terms.join('、')}。以下是名称相关的更多候选，请核实是否符合你的想法。` : `已使用 ${terms.join('、')} 在搜索中心 ${radiusKm} 公里内检索，暂未找到新的相关结果。`, items, options, ...(conversationIntent?.requestType === 'route' && options.length ? { question: clarificationQuestion('candidate', options) } : {}), ...(matches.length > items.length ? { moreSearch: { query: queryText, idea: originalIdea, center, radiusKm, type: requestedType } } : {}) });
    }
    sendEvent('progress', { stage: '理解你的消息' });
    const result = await runIdeaGraph({
    interpret: () => confirmed ? Promise.resolve({ ...conversationIntent, mode: 'route', confirmationPending: false, selectedCandidateId: placeContext?.selectedId || null }) : interpret({ previousIntent: conversationIntent, requirementState: previousRequirementState, placeContext, history, idea }),
    shouldGround: intent => { if (intent.newConversation === true) { placeContext = null; conversationIntent = null; initialIntent = null; previousRequirementState = null; retrieved.clear(); } return Boolean((intent.lookup && typeof intent.lookup.name === 'string' && intent.lookup.name.trim()) || intent.selectedCandidateId || (placeContext && ['route', 'recommend'].includes(intent.mode))); },
    ground: async intent => {
      const lookupName = typeof intent.lookup?.name === 'string' ? intent.lookup.name.trim().slice(0, 80) : '';
      const selectedRef = typeof intent.selectedCandidateId === 'string' ? placeContext?.candidates.find(x => x.id === intent.selectedCandidateId) : undefined;
      const name = lookupName || selectedRef?.name || placeContext?.query || '';
      if (!name) return null;
      sendEvent('progress', { stage: '正在检索地点、路段和点位' });
      // Confirmation already carries a selected ID: re-read that record directly without repeating broad name or map searches.
      if (confirmed && selectedRef && placeContext) {
        const selected = await detail(selectedRef.id, selectedRef.name);
        if (!selected || selected.id !== selectedRef.id || selected.type !== selectedRef.type || selected.hazardous === true) {
          placeContext = { ...placeContext, selectedId: null, candidates: placeContext.candidates.filter(item => item.id !== selectedRef.id) };
          return { candidates: [], matches: [], areaPoint: null, lookupName: '', selected: null, missingSelected: true };
        }
        placeContext = { ...placeContext, selectedId: selected.id, candidates: placeContext.candidates.map(item => item.id === selected.id ? { id: selected.id, type: selected.type, name: selected.name } : item) };
        return { candidates: [selected], matches: [selected], areaPoint: null, lookupName: '', selected, missingSelected: false };
      }
      let terms = lookupName && Array.isArray(intent.lookup?.terms) ? intent.lookup.terms.filter((term: unknown): term is string => typeof term === 'string' && term.trim().length >= 2 && term.trim().length <= 80).slice(0, 3) : (placeContext?.terms || []);
      const isExplicitArea = intent.place === name && !intent.needsSegment && !intent.needsPoint;
      const isTheme = !!lookupName && !selectedRef && !isExplicitArea && !(intent.lookup?.kind === 'area' && nearbyEvidence && intent.lookup?.expand !== true) && isThematicDiscovery(name, intent.lookup?.expand, idea);
      const matchingRequest = isTheme ? null : search(name, terms).then(value => ({ value, error: null }), error => ({ value: null, error }));
      const areaPoint = isTheme ? null : await resolve(name);
      const evidence = nearbyEvidence as NearbyEvidence | null;
      let discovery: Awaited<ReturnType<typeof discover>> | null = null;
      let discoveryCenter = agentLocation.point;
      if (isTheme && typeof intent.place === 'string' && intent.place.trim() && intent.place !== name) {
        const location = await resolve(intent.place);
        if (!location) return { candidates: [], matches: [], areaPoint: null, lookupName: name, selected: null, unresolvedArea: intent.place };
        discoveryCenter = location;
      }
      const explicitRadius = idea.match(/(?:附近|周边|周围|当前位置|范围内)[^\d]{0,5}(\d+(?:\.\d+)?)\s*(?:公里|千米|km)|(?:半径|范围)\s*(\d+(?:\.\d+)?)\s*(?:公里|千米|km)/i);
      const radiusKm = evidence?.radiusKm || (explicitRadius ? Math.min(50, Math.max(1, Number(explicitRadius[1] || explicitRadius[2]))) : 50);
      if (isTheme) {
        discovery = await discover(name, evidence?.center || discoveryCenter, radiusKm, evidence?.type || 'all', sanitizeConversationIntent(intent) || conversationIntent);
        terms = discovery.terms;
      }
      const matchingResult = matchingRequest ? await matchingRequest : null;
      if (matchingResult?.error) throw matchingResult.error;
      const matched = discovery ? discovery.candidates : matchingResult!.value!;
      const scopedCenter = areaPoint || evidence?.center;
      const matches = evidence && scopedCenter ? matched.filter(item => (evidence.type === 'all' || item.type === evidence.type) && getDistanceMeters(scopedCenter, item) <= evidence.radiusKm * 1000) : matched;
      const nearby = evidence && scopedCenter ? getDistanceMeters(scopedCenter, evidence.center) < 100 ? evidence.candidates :
        (await boundedIdeaLookup(() => deps.near(scopedCenter, evidence.radiusKm / 111.2), 'nearby', overrides.lookupTimeoutMs ?? 10000)).filter(item => (evidence.type === 'all' || item.type === evidence.type) && getDistanceMeters(scopedCenter, item) <= evidence.radiusKm * 1000) : areaPoint ? await boundedIdeaLookup(() => deps.near(areaPoint), 'nearby', overrides.lookupTimeoutMs ?? 10000) : [];
      const tagPreferences = requestedRouteTags(sanitizeConversationIntent(intent) || conversationIntent || { preferences: [], preferredTags: [], avoidTags: [] });
      const existing = evidence?.sourceTool === 'segments' || evidence?.sourceTool === 'places' ? evidence.candidates : discovery ? matches : [...matches, ...nearby];
      rememberCandidates(existing);
      const reloaded = selectedRef ? await detail(selectedRef.id, selectedRef.name) : null;
      const refreshedSelection = reloaded && reloaded.id === selectedRef?.id && reloaded.type === selectedRef.type && reloaded.hazardous !== true ? reloaded : null;
      if (selectedRef) for (let index = existing.length - 1; index >= 0; index--) if (existing[index].id === selectedRef.id) existing.splice(index, 1);
      const unique = [...(refreshedSelection ? [refreshedSelection] : []), ...existing].filter((item, index, all) => item.hazardous !== true && all.findIndex(x => x.id === item.id) === index);
      const ordered = discovery || evidence?.sourceTool === 'segments' || evidence?.sourceTool === 'places' ? unique : rankCandidatesByTags(unique, tagPreferences);
      const preferSegments = intent.needsSegment === true || (intent.requestType === 'route' && intent.lookup?.kind !== 'point');
      const sorted = preferSegments ? [...ordered.filter(x => x.type === 'segment'), ...ordered.filter(x => x.type !== 'segment')] : ordered;
      const selectedCandidate = selectedRef && sorted.find(x => x.id === selectedRef.id);
      const candidates = (selectedCandidate ? [selectedCandidate, ...sorted.filter(x => x.id !== selectedCandidate.id)] : sorted).slice(0, 12);
      const selectedId = typeof intent.selectedCandidateId === 'string' && placeContext?.candidates.some(x => x.id === intent.selectedCandidateId) && candidates.some(x => x.id === intent.selectedCandidateId) ? intent.selectedCandidateId : null;
      const inheritedId = !lookupName && placeContext?.selectedId && candidates.some(x => x.id === placeContext?.selectedId) ? placeContext.selectedId : null;
      const exactSegments = matches.filter(x => x.type === 'segment' && x.name === name && x.hazardous !== true);
      const exactId = !isTheme && intent.lookup?.kind === 'segment' && exactSegments.length === 1 ? exactSegments[0].id : null;
      placeContext = { query: name, terms, candidates: candidates.map(x => ({ id: x.id, type: x.type, name: x.name })), selectedId: selectedId || inheritedId || (candidates.some(x => x.id === exactId) ? exactId : null), area: areaPoint ? name : null, seenCandidateIds: isTheme ? [] : placeContext?.seenCandidateIds || [] };
      const centerLabel = evidence ? ({ gps: '当前位置', 'gps-stale': '上次定位', ip: 'IP 大致位置', manual: '所选起点', provided_origin: '出发位置', candidate: '所选地点', map_center: '地图中心' } as Record<string, string>)[evidence.centerSource] || '搜索位置' : discoveryCenter !== agentLocation.point ? '指定区域的位置' : ({ gps: '当前位置', 'gps-stale': '上次定位', ip: 'IP 大致位置', manual: '所选起点', provided_origin: '出发位置', map_center: '地图中心' } as Record<string, string>)[agentLocation.source] || '搜索位置';
      return { candidates, matches, areaPoint, lookupName, discovery, discoveryCenter: evidence?.center || discoveryCenter, centerLabel, radiusKm, discoveryType: evidence?.type || 'all', selected: candidates.find(x => x.id === placeContext?.selectedId) || null };
    },
    respond: async (intent, grounding) => {
    lastInterpretation = confirmed ? null : intent;
    if (intent.mode === 'answer' && (wantsNearbyDiscovery(idea) || ['attributes', 'segments', 'places'].includes((nearbyEvidence as NearbyEvidence | null)?.sourceTool || '')) && metrics.toolCalls.some(call => ['search_nearby_candidates', 'search_segments_by_attributes', 'search_segments', 'search_places'].includes(call.name))) {
      intent = { ...intent, mode: 'recommend', requestType: 'recommend' };
    }
    const updatedIntent = mergeIntent(conversationIntent, intent);
    if (updatedIntent && !updatedIntent.requestType && intent.mode === 'clarify' && conversationIntent?.requestType && ['budget', 'budget_and_preference', 'preference', 'order', 'destination', 'scope'].includes(intent.clarificationKind)) updatedIntent.requestType = conversationIntent.requestType;
    if (updatedIntent) conversationIntent = { ...updatedIntent, confirmationPending: false };
    if (typeof intent.title === 'string') {
      const rawTitle = intent.title.replace(/[\r\n]/g, ' ').trim();
      conversationTitle = Array.from(rawTitle).slice(0, 20).join('');
      if (conversationTitle && !history.length) sendEvent('title', { title: conversationTitle });
    }
    if (!['answer', 'clarify', 'route', 'recommend'].includes(intent.mode)) return { message: '你希望我帮你规划路线，还是推荐骑行路段或休息点？', options: clarificationOptions(null, 'purpose'), items: [] };
    const routeRequest = !!conversationIntent && (intent.mode === 'route' || (intent.mode === 'clarify' && conversationIntent.requestType === 'route'));
    if (grounding?.unresolvedArea) return { message: `暂时无法确定“${grounding.unresolvedArea}”的位置，请提供更具体的地点后再搜索。`, items: [] };
    if (routeRequest && conversationIntent && ((conversationIntent.minKm != null && conversationIntent.maxKm != null && conversationIntent.minKm > conversationIntent.maxKm) || (conversationIntent.minMinutes != null && conversationIntent.maxMinutes != null && conversationIntent.minMinutes > conversationIntent.maxMinutes))) {
      conversationIntent.confirmationPending = false;
      return { message: '当前距离或时间的下限高于上限，请调整范围后再规划。', items: [] };
    }
    if (routeRequest && grounding?.missingSelected) {
      return { message: '之前选择的路段或地点已不可用，请重新搜索或选择其他候选后再规划。', items: [], options: ['重新搜索', '选择其他候选'] };
    }
    if (!routeRequest && intent.mode !== 'clarify' && wantsNearbyDiscovery(idea) && !nearbyEvidence && (!overrides.model || overrides.toolCaller)) {
      return { message: '附近候选暂时无法核实，请稍后重试或指定更明确的地点。', items: [] };
    }
    if (intent.mode === 'clarify' && grounding && !grounding.selected && grounding.candidates.length && !(routeRequest && grounding.areaPoint && intent.place === grounding.lookupName && !intent.needsSegment && !intent.needsPoint) &&
        (isCandidateChoice(intent.options, grounding.candidates) || asksCandidateChoice(intent.reply, intent.options))) {
      const candidates: Candidate[] = grounding.candidates.slice(0, grounding.discovery ? 3 : 6);
      const query = grounding.lookupName || placeContext?.query;
      if (query && placeContext) {
        placeContext = { ...placeContext, candidates: candidates.map(item => ({ id: item.id, type: item.type, name: item.name })), seenCandidateIds: candidates.map(item => item.id) };
        const options = candidates.slice(0, 3).map(item => `选择${item.name}`);
        return { message: `找到与“${query}”有关的候选${grounding.discovery ? `（以${grounding.centerLabel}为中心、${grounding.radiusKm} 公里内）` : ''}，请选择想要的路段或地点，或继续说明具体位置。${grounding.discovery?.partial ? '部分扩展检索暂不可用。' : ''}`,
          options, question: clarificationQuestion('candidate', options), items: grounding.discovery ? candidates : [],
          moreSearch: { query, idea, center: grounding.discoveryCenter || grounding.areaPoint || (nearbyEvidence as NearbyEvidence | null)?.center || req.body.center, ...(grounding.discovery ? { radiusKm: grounding.radiusKm, type: grounding.discoveryType } : {}) } };
      }
    }
    if (grounding && (grounding.lookupName || grounding.selected) && !routeRequest && intent.mode !== 'clarify') {
      const candidates: Candidate[] = grounding.selected ? [grounding.selected] : grounding.candidates;
      const searched = (nearbyEvidence as NearbyEvidence | null)?.sourceTool === 'segments' ? nearbyEvidence as NearbyEvidence : null;
      const moreSearch = !searched && grounding.lookupName && !grounding.selected ? { query: grounding.lookupName, idea, center: grounding.discoveryCenter || grounding.areaPoint || (nearbyEvidence as NearbyEvidence | null)?.center || req.body.center, ...(grounding.discovery ? { radiusKm: grounding.radiusKm, type: grounding.discoveryType } : {}) } : undefined;
      if (!candidates.length) return { message: grounding.discovery?.partial ? `部分扩展检索暂不可用，暂时无法完整核实“${placeContext?.query}”的相关候选。请稍后重试。` : `暂未找到与“${placeContext?.query}”相关的可用路段或点位，也无法确认具体位置。可以提供所在区域或更具体的名称。`, items: [], moreSearch };
      const items = candidates.slice(0, 6).map(candidate => ({ ...candidate, reason: (candidate as DiscoveryCandidate).reason || (grounding.matches.some((match: Candidate) => match.id === candidate.id) ? '名称相关的数据库记录' : '地点附近的数据库记录') }));
      const nextOffset = (searched?.offset || 0) + items.length;
      const moreSegments = searched?.filters && nextOffset < (searched.total || 0) && nextOffset <= 200 ? { query: grounding.lookupName || idea.slice(0, 80), idea, center: searched.center, segmentFilters: { ...searched.filters, offset: nextOffset } } : undefined;
      placeContext = { ...placeContext!, candidates: items.map(x => ({ id: x.id, name: x.name, type: x.type })), seenCandidateIds: items.map(x => x.id) };
      return { message: searched ? `按所选条件找到 ${searched.total} 条路段，本次展示 ${items.length} 条；范围按路段起点的直线距离计算，不代表行政区边界。名称关联词仅用于检索。` : `找到与“${placeContext.query}”名称相关的数据库记录或地点附近的路段和点位；名称相近不一定是同一个地点，附近不代表处于区域边界内。你可以选择一个，或继续说明想去的区域。`, items, options: items.slice(0, 3).map(x => `选择${x.name}`), moreSearch: moreSegments || moreSearch, ...(searched ? { segmentSearch: { total: searched.total, hasMore: !!moreSegments, offset: searched.offset, returned: items.length } } : {}) };
    }
    if (intent.mode === 'answer' || (intent.mode === 'clarify' && (!routeRequest || intent.clarificationKind === 'order' || intent.clarificationKind === 'scope'))) {
      const reply = typeof intent.reply === 'string' ? intent.reply.trim().slice(0, 1200) : '';
      const options = intent.mode === 'clarify' ? clarificationOptions(intent.options, intent.clarificationKind) : [];
      const kind = intent.clarificationKind === 'order' || intent.clarificationKind === 'scope' ? intent.clarificationKind : 'purpose';
      return { message: reply || '能再具体说说你的想法吗？', options, ...(intent.mode === 'clarify' && options.length ? { question: clarificationQuestion(kind, options) } : {}), items: [] };
    }
    // Selection sees all recent user preferences, not only an elliptical follow-up.
    const combinedIdea = [...history.filter((turn: { role: string }) => turn.role === 'user').map((turn: { content: string }) => turn.content), idea].join('\n').slice(-5000);
    sendEvent('progress', { stage: '整理骑行需求与途经顺序' });
    if (routeRequest && conversationIntent) {
      const planConfirmed = async (action: (deferEnroute: boolean, policy?: RoutePolicy, onEvidence?: IdeaPlannerDependencies['onEvidence']) => Promise<object>): Promise<any> => {
        if (!confirmed) return action(false);
        const policy = routePolicy(conversationIntent!, req.body?.requirementState ? previousRequirementState : null);
        if (policy.block) return { ...policy.block, question: clarificationQuestion('purpose', policy.block.options), items: [] };
        let pending: Promise<object> | undefined;
        let baselineRoute: CompositeRoute | undefined;
        let routePlaces: Array<Candidate & { reason: string }> = [];
        const routeAnalysis: Record<string, unknown> = {};
        let exploration: ReturnType<typeof exploreConfirmedRoute> | undefined;
        const alternatives: Array<{ message?: string; route?: CompositeRoute; distanceNote?: string; note?: string; added: string[]; extraKm: number }> = [];
        const observations: PlanningObservation[] = [];
        const seenAlternatives = new Set<string>();
        const addAlternative = (value: Awaited<ReturnType<typeof exploreConfirmedRoute>>) => {
          if (!value.result.route || !value.added.length || alternatives.length >= 2) return;
          const key = [...value.added].sort().join('\u0000');
          if (seenAlternatives.has(key)) return;
          seenAlternatives.add(key);
          const alternative = { ...value.result, added: value.added, extraKm: value.extraKm };
          alternatives.push(alternative);
          sendEvent('route_alternative', { index: alternatives.length, ...alternative });
        };
        const plan = () => pending ||= action(true, policy, value => observations.push(value)).then((result: any) => {
          if (result?.route) {
            baselineRoute = result.route;
            sendEvent('route_first', result);
            sendEvent('route_alternatives_progress', { stage: '正在生成其他路线' });
            void explore();
          }
          return result;
        });
        const explore = () => {
          if (!pending) return Promise.resolve(null);
          if (!exploration) exploration = pending.then(result => (result as any).routeOutsideBudget ? { status: 'not_applicable' as const, result, added: [], extraKm: 0 } : deps.explore({ result, intent: conversationIntent!, idea: combinedIdea, near: deps.near,
            bounds: routeBoundsFromIntent(conversationIntent!, { strictTargetMinutes: policy.strictTargetMinutes }), onAlternative: addAlternative, isCancelled: () => stream && res.destroyed }))
            .catch(async () => ({ status: 'unavailable' as const, result: await plan(), added: [], extraKm: 0 }));
          return exploration!;
        };
        sendEvent('progress', { stage: '正在根据已确认需求调用骑行路线规划' });
        if (!overrides.model || overrides.toolCaller) {
          try {
            await runIdeaToolAgent({ input: { idea: combinedIdea, previousIntent: conversationIntent, placeContext, confirmed: true }, search, resolve, detail,
              nearby: agentNearby, attributeNearby, location: agentLocation, plan, explore, metrics, callModel: overrides.toolCaller,
              routeIntent: conversationIntent!, routeBounds: routeBoundsFromIntent(conversationIntent!, { strictTargetMinutes: policy.strictTargetMinutes }), routeOptions: () => baselineRoute ? [{ route: baselineRoute }, ...alternatives.filter((item): item is typeof item & { route: CompositeRoute } => !!item.route)] : [],
              onRoutePlaces: items => { routePlaces = items.map(item => ({ ...item, reason: `距路线轨迹直线约 ${item.distanceFromRouteKm.toFixed(1)} 公里，实际绕行距离尚未核实。` })); },
              onRouteAnalysis: (kind, value) => { routeAnalysis[kind] = value; },
              onProgress: stage => sendEvent('progress', { stage }) });
          } catch { /* The confirmed planner remains available if the model or tool call fails. */ }
        }
        const baseline: any = await plan();
        if (!baseline?.route) {
          if (!observations.length || baseline?.question) return baseline;
          sendEvent('progress', { stage: '正在整理已找到的路段、地点和未完成的原因' });
          const evidence = await explainPlanningFailure({ idea: combinedIdea, area: conversationIntent?.place || null, observations,
            related: (center, terms) => boundedIdeaLookup(() => deps.related(center, terms), 'search', overrides.lookupTimeoutMs ?? 7000),
            expand: query => boundedIdeaLookup(() => deps.model(RELATED_SEARCH_TERMS_PROMPT, { query, idea: combinedIdea }).then(result => result?.terms), 'search', 3000) });
          return { ...baseline, message: [baseline.message, evidence.text].filter(Boolean).join('\n\n'), items: evidence.items, evidenceOnly: true };
        }
        const optimized = await explore();
        if (optimized?.added.length) addAlternative(optimized);
        const alternativeStatus = optimized?.status || 'unavailable';
        const routeComparison = compareOptions([{ route: baseline.route }, ...alternatives.filter((item): item is typeof item & { route: CompositeRoute } => !!item.route)]);
        sendEvent('route_alternatives_done', { count: alternatives.length, status: alternativeStatus, comparison: routeComparison });
        return { ...baseline, ...(routePlaces.length ? { items: routePlaces } : {}), ...(Object.keys(routeAnalysis).length ? { routeAnalysis } : {}), alternatives, alternativeStatus, routeComparison };
      };
      const selected: Candidate | null = grounding?.selected || null;
      const focus = placeContext?.query;
      if (selected) {
        const type = selected.type;
        const originalStops = conversationIntent.stops;
        const matches = originalStops.map((stop, index) => ({ stop, index })).filter(({ stop }) => stop.type === type && (!stop.name || stop.name === focus || stop.name === selected.name));
        if (matches.length > 1 || (!matches.length && originalStops.length)) return { message: '已选中该地点；请告诉我它在其他途经点之前还是之后。', items: [] };
        const selectedStop = { type, name: selected.name, kind: null };
        const preservedStops = originalStops.length ? originalStops.map((stop, index) => index === matches[0].index ? selectedStop : stop) : [selectedStop];
        conversationIntent = { ...conversationIntent, needsSegment: type === 'segment' || conversationIntent.needsSegment, segmentName: type === 'segment' ? selected.name : conversationIntent.segmentName, needsPoint: type === 'point' || conversationIntent.needsPoint, pointName: type === 'point' ? selected.name : conversationIntent.pointName, stops: preservedStops, order: preservedStops.map(stop => stop.type).slice(0, 2) };
        if (!confirmed) { conversationIntent.confirmationPending = true; return routeConfirmation(conversationIntent, buildRequirementState(conversationIntent, initialIntent, previousRequirementState, false, placeContext, retrieved, lastInterpretation)); }
        return planConfirmed((deferEnroute, policy, onEvidence) => deps.plan(conversationIntent!, combinedIdea, req.body.origin, req.body.originSource, stage => sendEvent('progress', { stage }), {
          named: async (center, name, preferences) => type === 'segment' && name === selected.name ? [selected] : findNamedSegments(center, name, preferences),
          model: async (system, input) => type === 'segment' && Array.isArray((input as any).segments) && (input as any).segments.some((item: any) => item.id === selected.id) ? { ids: [selected.id] } : deps.model(system, input),
          resolve: async name => name === selected.name ? { lat: selected.lat, lng: selected.lng } : resolveRoutePlace(name), disableEnroute: deferEnroute, policy, onEvidence
        }));
      }
      if (focus && conversationIntent.segmentName === focus && placeContext?.area) {
        conversationIntent = { ...conversationIntent, place: focus, needsSegment: false, segmentName: null, stops: conversationIntent.stops.filter(stop => stop.type !== 'segment' || stop.name !== focus), order: conversationIntent.order.filter(type => type !== 'segment') };
      } else if (focus && !placeContext?.area) {
        const candidates: Candidate[] = (grounding?.candidates || []).slice(0, 3);
        if (placeContext && grounding?.discovery) placeContext = { ...placeContext, candidates: candidates.map(item => ({ id: item.id, name: item.name, type: item.type })), seenCandidateIds: candidates.map(item => item.id) };
        const options = (placeContext?.candidates || []).slice(0, 3).map(x => `选择${x.name}`);
        return { message: `还无法确定“${focus}”具体指哪个路段或地点${grounding?.discovery ? `；以下候选以${grounding.centerLabel}为中心，在 ${grounding.radiusKm} 公里内检索` : ''}。请从候选中选择，或提供更具体的位置。${grounding?.discovery?.partial ? '部分扩展检索暂不可用。' : ''}`, options, ...(options.length ? { question: clarificationQuestion('candidate', options) } : {}), items: [],
          moreSearch: { query: focus, idea: combinedIdea, center: grounding?.discoveryCenter || grounding?.areaPoint || (nearbyEvidence as NearbyEvidence | null)?.center || req.body.center, ...(grounding?.discovery ? { radiusKm: grounding.radiusKm, type: grounding.discoveryType } : {}) }, ...(grounding?.discovery ? { items: candidates } : {}) };
      }
      if (focus && placeContext?.area && !conversationIntent.place) conversationIntent = { ...conversationIntent, place: focus };
      if (!confirmed) { conversationIntent.confirmationPending = true; return routeConfirmation(conversationIntent, buildRequirementState(conversationIntent, initialIntent, previousRequirementState, false, placeContext, retrieved, lastInterpretation)); }
      const planned: any = await planConfirmed((deferEnroute, policy, onEvidence) => deps.plan(conversationIntent!, combinedIdea, req.body.origin, req.body.originSource, stage => sendEvent('progress', { stage }), { disableEnroute: deferEnroute, policy, onEvidence }));
      if (focus && placeContext?.area && planned.route) planned.note = [planned.note, '候选按地点中心附近检索，尚未校验行政区边界或区域内绕圈。'].filter(Boolean).join(' ');
      return planned;
    }
    let center: Point = req.body.center;
    let area = '当前地图中心附近';
    if (typeof intent.place === 'string' && intent.place.trim()) {
      sendEvent('progress', { stage: '正在查找指定地点' });
      const found = await deps.resolve(intent.place.trim().slice(0, 80));
      if (!found) return { message: `暂时无法找到“${intent.place.slice(0, 80)}”，请尝试更具体的上海地点。`, items: [] };
      center = found;
      area = `${intent.place.slice(0, 80)}附近`;
    }
    const nearby = nearbyEvidence as NearbyEvidence | null;
    if (!nearby && metrics.toolCalls.some(call => ['search_nearby_candidates', 'search_segments_by_attributes', 'search_segments', 'search_places'].includes(call.name))) return { message: '附近候选暂时无法核实，请稍后重试或指定更明确的地点。', items: [] };
    if (nearby && !intent.place) {
      center = nearby.center;
      area = ({ gps: '当前位置附近', 'gps-stale': '上次定位位置附近', ip: 'IP 大致位置附近', manual: '所选位置附近', provided_origin: '出发位置附近', candidate: '所选候选附近', map_center: '当前地图中心附近' } as Record<string, string>)[nearby.centerSource] || '搜索位置附近';
    }
    sendEvent('progress', { stage: '正在检索附近点位与骑行路段' });
    const tagPreferences = requestedRouteTags(conversationIntent || { preferences: [], preferredTags: [], avoidTags: [] });
    const nearbyItems = nearby ? getDistanceMeters(center, nearby.center) < 100 && (nearby.sourceTool === 'attributes' || nearby.sourceTool === 'segments' || nearby.sourceTool === 'places' || (!tagPreferences.preferred.length && !tagPreferences.avoid.length)) ? nearby.candidates :
      (await deps.near(center, nearby.radiusKm / 111.2, tagPreferences)).filter(item => (nearby.type === 'all' || item.type === nearby.type) && getDistanceMeters(center, item) <= nearby.radiusKm * 1000) : await deps.near(center, .13, tagPreferences);
    const candidates = rankCandidatesByTags(nearbyItems.filter(item => item.hazardous !== true), tagPreferences);
    const moreSearch = { query: (typeof intent.place === 'string' && intent.place.trim()) || idea.slice(0, 80), idea, center };
    if (!candidates.length) {
      placeContext = { query: moreSearch.query, terms: [], area: null, selectedId: null, candidates: [] };
      return { message: `${area}暂时没有可推荐的点位或路段，请移动地图或换个地点试试。`, items: [], moreSearch };
    }
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
    placeContext = { query: rankedItems.length ? area : moreSearch.query, terms: [], area: null, selectedId: null, candidates: rankedItems.map(x => ({ id: x.id, type: x.type, name: x.name })) };
    const moreSegments = nearby?.sourceTool === 'segments' && nearby.filters && rankedItems.length < (nearby.total || 0) ? { query: moreSearch.query, idea, center: nearby.center, segmentFilters: { ...nearby.filters, offset: nearby.offset || 0 } } : undefined;
    return { message: rankedItems.length ? nearby?.sourceTool === 'segments' ? `按所选条件找到 ${nearby.total} 条路段，本次展示 ${rankedItems.length} 条；按路段起点直线距离筛选，不代表行政区边界。` : `为你找到${area}的推荐` : '暂时没有找到符合想法的结果，请换个描述试试。', center, area, items: rankedItems, moreSearch: nearby?.sourceTool === 'segments' ? moreSegments : moreSearch, ...(nearby?.sourceTool === 'segments' ? { segmentSearch: { total: nearby.total, hasMore: !!moreSegments, offset: nearby.offset, returned: rankedItems.length } } : {}) };
    }
    }, metrics.requestId);
    return finish(result);
  } catch (error: any) {
    console.error('[IdeaRecommendation] Request failed:', error.code || error.message);
    const message = error instanceof IdeaLookupError ? error.stage === 'location' ? '地点解析暂时不可用，请稍后重试。' : '路段与点位检索暂时不可用，请稍后重试。' : '推荐暂时不可用，请稍后重试。';
    return finish({ error: message }, 502);
  }
  };
}

export const recommendIdeas = createIdeaController();
