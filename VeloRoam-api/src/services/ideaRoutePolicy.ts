import { ConversationIntent, RouteTag } from './ideaIntent';
import { RequirementState } from './ideaRequirementState';
import { requestedRouteTags } from './ideaTagPreferences';
import { RouteStop } from './ideaRouteService';

export type RoutePolicy = { requiredTags: RouteTag[]; strictTargetMinutes?: boolean; strictNamedStops?: boolean; block: { message: string; options: string[] } | null };
const labels: Record<RouteTag, string> = { climbing: '爬坡', loop: '绕圈', out_and_back: '往返', long_distance: '长距离', popular: '热门', highly_starred: '高收藏' };
const tagWords: Record<RouteTag, RegExp> = { climbing: /爬坡|爬山|上坡/, loop: /绕圈|刷圈|环线训练/, out_and_back: /往返路段|折返路段/, long_distance: /长距离路段|长途路段/, popular: /热门|人气/, highly_starred: /高收藏|收藏多/ };

/** Correct priority when the latest user message explicitly states its strength. */
export function applyExplicitPriority(idea: string, raw: any): void {
  if (!raw || typeof raw !== 'object') return;
  const clauses = idea.split(/[，。；,;\n]/).map(value => value.trim()).filter(Boolean);
  const required = new Set<string>(Array.isArray(raw.requiredFields) ? raw.requiredFields : []);
  const preferred = new Set<string>(Array.isArray(raw.preferredFields) ? raw.preferredFields : []);
  const requiredTags = new Set<RouteTag>(Array.isArray(raw.requiredRouteTags) ? raw.requiredRouteTags.filter((tag: unknown): tag is RouteTag => typeof tag === 'string' && tag in tagWords) : []);
  const preferredTags = new Set<RouteTag>(Array.isArray(raw.preferredRouteTags) ? raw.preferredRouteTags.filter((tag: unknown): tag is RouteTag => typeof tag === 'string' && tag in tagWords) : []);
  const mark = (field: string, hard: boolean) => { if (hard) { required.add(field); preferred.delete(field); } else { preferred.add(field); required.delete(field); } };
  for (const clause of clauses) {
    if (/不再必须|不用必须|不必|无需必须/.test(clause)) continue;
    const hard = /必须|一定要|务必|禁止|不得/.test(clause);
    const soft = /尽量|最好|优先|希望/.test(clause);
    const tags: RouteTag[] = Array.isArray(raw.preferredTags) ? raw.preferredTags.filter((tag: unknown): tag is RouteTag => typeof tag === 'string' && tag in tagWords) : [];
    const avoids: RouteTag[] = Array.isArray(raw.avoidTags) ? raw.avoidTags.filter((tag: unknown): tag is RouteTag => typeof tag === 'string' && tag in tagWords) : [];
    const expressesAvoidance = /避开|避免|不要|不走|不经过|禁止/.test(clause);
    if (avoids.length && expressesAvoidance && (soft || hard || /不要|不走|不经过/.test(clause))) mark('avoidTags', !soft);
    if (!expressesAvoidance && (hard || soft)) for (const tag of tags.filter(value => tagWords[value].test(clause))) {
      if (hard && !soft) { requiredTags.add(tag); preferredTags.delete(tag); } else { preferredTags.add(tag); requiredTags.delete(tag); }
    }
    if (typeof raw.place === 'string' && raw.place && clause.includes(raw.place) && /必须|一定要|务必|仅限|限定在/.test(clause)) mark('place', true);
    if (typeof raw.targetMinutes === 'number' && /小时|分钟/.test(clause) && hard && !soft && !/以内|以下|不超过|以上|至少/.test(clause)) mark('targetMinutes', true);
    if (hard && !soft && !expressesAvoidance && !tags.some(tag => tagWords[tag].test(clause)) && Array.isArray(raw.preferences) && raw.preferences.some((preference: unknown) => typeof preference === 'string' && preference.length >= 2 && clause.includes(preference))) mark('preferences', true);
  }
  const allTags: RouteTag[] = Array.isArray(raw.preferredTags) ? raw.preferredTags.filter((tag: unknown): tag is RouteTag => typeof tag === 'string' && tag in tagWords) : [];
  if (requiredTags.size && allTags.some(tag => !requiredTags.has(tag))) { required.delete('preferredTags'); preferred.add('preferredTags'); }
  else if (allTags.length && allTags.every(tag => requiredTags.has(tag))) mark('preferredTags', true);
  else if (preferredTags.size && !requiredTags.size) mark('preferredTags', false);
  raw.requiredFields = [...required]; raw.preferredFields = [...preferred];
  raw.requiredRouteTags = [...requiredTags]; raw.preferredRouteTags = [...preferredTags];
}

/** The priority is used only when it refers to the same confirmed intent value. */
export function routePolicy(intent: ConversationIntent, state: RequirementState | null): RoutePolicy {
  const requirements = state?.requirements;
  const required = (key: keyof RequirementState['requirements']) => requirements?.[key]?.priority === 'required' && JSON.stringify(requirements[key].value) === JSON.stringify(intent[key]);
  const preferences = requestedRouteTags(intent);
  if (required('avoidTags') && preferences.avoid.length) return { requiredTags: [], block: {
    message: `你要求必须避开${preferences.avoid.map(tag => `“${labels[tag]}”`).join('、')}，但目前只能检查已有路段标签，不能核实全部连接道路。请调整要求后再规划。`,
    options: ['尽量避开，允许未核实的连接道路', '修改骑行要求'] } };
  if (required('place') && intent.place) return { requiredTags: [], block: {
    message: `你要求路线必须位于“${intent.place}”，但目前没有可用于核实整条路线的区域边界。请调整区域要求后再规划。`,
    options: ['以该区域为方向参考', '修改骑行要求'] } };
  if (required('preferences') && intent.preferences.length) return { requiredTags: [], block: {
    message: `你将“${intent.preferences.join('、')}”设为必须满足，但目前无法对完整路线核实这些体验要求。请调整要求后再规划。`,
    options: ['将体验要求调整为优先考虑', '修改骑行要求'] } };
  if (state && intent.timeScope === 'total' && intent.stopMinutes == null && (intent.maxMinutes != null || intent.minMinutes != null || (required('targetMinutes') && intent.targetMinutes != null))) return { requiredTags: [], block: {
    message: '总时间包含停留，但停留时长尚未确定，暂时无法核实总时间范围。请提供预计停留时间。',
    options: ['不安排停留，停留0分钟', '预计停留20分钟'] } };
  return { requiredTags: state?.tagPriorities ? intent.preferredTags.filter(tag => state.tagPriorities[tag] === 'required') : required('preferredTags') ? intent.preferredTags : [], strictTargetMinutes: required('targetMinutes'), strictNamedStops: !!state && (required('stops') || required('segmentName')), block: null };
}

export function requiredTagsReason(stops: RouteStop[], tags: RouteTag[]): string | null {
  const missing = tags.filter(tag => !stops.some(stop => stop.type === 'segment' && stop.detail?.tags?.[tag] === 'matched'));
  return missing.length ? `暂未找到已确认具有${missing.map(tag => `“${labels[tag]}”`).join('、')}属性的候选路段。` : null;
}
