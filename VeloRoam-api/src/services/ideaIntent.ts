export type ClarificationKind = 'purpose' | 'destination' | 'order' | 'preference' | 'budget' | 'budget_and_preference' | 'scope';

export const ROUTE_TAGS = ['climbing', 'loop', 'out_and_back', 'long_distance', 'popular', 'highly_starred'] as const;
export type RouteTag = typeof ROUTE_TAGS[number];
export type TagStatus = 'matched' | 'not_matched' | 'unknown';
export type RouteTagStatuses = Record<RouteTag, TagStatus>;
export interface ConversationIntent {
  confirmationPending: boolean;
  mode: 'route' | 'recommend' | 'clarify';
  requestType: 'route' | 'recommend' | null;
  place: string | null; origin: string | null; destination: string | null; returnToStart: boolean;
  needsSegment: boolean; segmentName: string | null; needsPoint: boolean; pointName: string | null; pointKind: string | null;
  order: Array<'segment' | 'point'>;
  stops: Array<{ type: 'segment' | 'point'; name: string | null; kind: string | null }>;
  preferences: string[]; preferredTags: RouteTag[]; avoidTags: RouteTag[];
  targetKm: number | null; minKm: number | null; maxKm: number | null;
  targetMinutes: number | null; minMinutes: number | null; maxMinutes: number | null;
  timeScope: 'riding' | 'total' | null; stopMinutes: number | null;
}

const text = (v: unknown): string | null => typeof v === 'string' ? v.trim().slice(0, 80) || null : null;
const numberInRange = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
const tagArray = (value: unknown): RouteTag[] => Array.isArray(value)
  ? [...new Set<RouteTag>(value.filter((tag: unknown): tag is RouteTag => typeof tag === 'string' && (ROUTE_TAGS as readonly string[]).includes(tag)))].slice(0, ROUTE_TAGS.length) : [];

/** Bound the model/client context before storing it or using it for route planning. */
export function sanitizeConversationIntent(value: any): ConversationIntent | null {
  if (!value || !['route', 'recommend', 'clarify'].includes(value.mode)) return null;
  const requestType = value.requestType === 'route' || value.requestType === 'recommend' ? value.requestType :
    value.mode === 'route' || value.mode === 'recommend' ? value.mode : null;
  const preferences: string[] = Array.isArray(value.preferences) ? value.preferences.filter((v: unknown): v is string => typeof v === 'string' && !!v.trim()).slice(0, 8).map((v: string) => v.trim().slice(0, 80)) : [];
  return {
    confirmationPending: value.confirmationPending === true,
    mode: value.mode, requestType, place: text(value.place), origin: text(value.origin), destination: text(value.destination),
    returnToStart: value.returnToStart === true, needsSegment: value.needsSegment === true,
    segmentName: text(value.segmentName), needsPoint: value.needsPoint === true,
    pointName: text(value.pointName), pointKind: text(value.pointKind),
    order: Array.isArray(value.order) ? value.order.filter((v: unknown): v is 'segment' | 'point' => v === 'segment' || v === 'point').slice(0, 2) : [],
    stops: Array.isArray(value.stops) ? value.stops.filter((stop: any) => stop && (stop.type === 'point' || stop.type === 'segment')).slice(0, 8).map((stop: any) => ({ type: stop.type, name: text(stop.name), kind: text(stop.kind) })) : [],
    preferences, preferredTags: tagArray(value.preferredTags), avoidTags: tagArray(value.avoidTags),
    minKm: numberInRange(value.minKm, 0, 1000), maxKm: numberInRange(value.maxKm, Number.MIN_VALUE, 1000),
    targetKm: numberInRange(value.targetKm, Number.MIN_VALUE, 1000),
    targetMinutes: numberInRange(value.targetMinutes, Number.MIN_VALUE, 10080),
    minMinutes: numberInRange(value.minMinutes, 0, 10080), maxMinutes: numberInRange(value.maxMinutes, Number.MIN_VALUE, 10080),
    timeScope: value.timeScope === 'riding' || value.timeScope === 'total' ? value.timeScope : null,
    stopMinutes: numberInRange(value.stopMinutes, 0, 10080)
  };
}

// Fallbacks are only used when the model asks a question but omits usable choices.
export function clarificationOptions(value: unknown, kind: unknown): string[] {
  const options = Array.isArray(value) ? value.filter((option): option is string => typeof option === 'string' && !!option.trim()).map(option => option.trim().slice(0, 80)) : [];
  if (options.length) return [...new Set(options)].slice(0, 3);
  switch (kind as ClarificationKind) {
    case 'destination': return ['骑完返回起点', '我想指定结束地点'];
    case 'order': return ['先骑路段，再去途经点', '先去途经点，再骑路段'];
    case 'preference': return ['轻松休闲骑行', '想骑热门路段', '希望途中有休息补给'];
    case 'budget': return ['约30公里', '约50公里', '约两小时'];
    case 'budget_and_preference': return ['轻松骑约30公里', '骑热门路段约50公里', '爬坡训练约两小时'];
    case 'scope': return ['这是全程里程', '这是到达后骑行的里程'];
    default: return ['规划完整骑行路线', '推荐骑行路段', '推荐休息补给点'];
  }
}
