import { ConversationIntent, RouteTag, sanitizeConversationIntent } from './ideaIntent';
import { PlaceContext } from './ideaAgentGraph';
import type { Candidate } from '../controllers/ideaController';

export const REQUIREMENT_FIELDS = ['origin', 'destination', 'returnToStart', 'place', 'needsSegment', 'segmentName', 'needsPoint', 'pointName', 'pointKind', 'order', 'stops', 'preferences', 'preferredTags', 'avoidTags', 'targetKm', 'minKm', 'maxKm', 'targetMinutes', 'minMinutes', 'maxMinutes', 'timeScope', 'stopMinutes'] as const;
export type RequirementField = typeof REQUIREMENT_FIELDS[number];
type RequirementValue = ConversationIntent[RequirementField];
type RequirementEntry = { value: RequirementValue; status: 'unknown' | 'pending' | 'confirmed'; priority: 'required' | 'preferred' | 'unspecified'; prioritySource: 'explicit' | 'default' };
export type RequirementState = { version: 1; requirements: Record<RequirementField, RequirementEntry>; tagPriorities: Partial<Record<RouteTag, 'required' | 'preferred'>>; candidates: Array<{ id: string; name: string; type: 'point' | 'segment'; evidence: 'retrieved_this_turn' | 'reference_only'; selection: 'unselected' | 'pending' | 'confirmed'; facts: { score: number | null; distanceKm: number | null; tags: Candidate['tags'] | null } | null }> };
const soft = new Set<RequirementField>(['place', 'preferences', 'preferredTags', 'targetKm', 'targetMinutes']);
const isEmpty = (value: unknown) => value == null || value === false || Array.isArray(value) && !value.length;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function shownInConfirmation(intent: ConversationIntent, field: RequirementField): boolean {
  const stops = intent.stops;
  if (field === 'destination' && intent.returnToStart) return false;
  if (field === 'timeScope' && intent.targetMinutes == null && intent.minMinutes == null && intent.maxMinutes == null) return false;
  if (field === 'order') return !!stops.length && intent.order.every((type, index) => stops[index]?.type === type);
  if (field === 'needsSegment') return !stops.length || stops.some(stop => stop.type === 'segment');
  if (field === 'needsPoint') return !stops.length || stops.some(stop => stop.type === 'point');
  if (field === 'segmentName') return !stops.length || stops.some(stop => stop.type === 'segment' && stop.name === intent.segmentName);
  if (field === 'pointName') return !stops.length || stops.some(stop => stop.type === 'point' && stop.name === intent.pointName);
  if (field === 'pointKind') return !stops.length || stops.some(stop => stop.type === 'point' && stop.kind === intent.pointKind);
  if (field === 'returnToStart' && intent.returnToStart && intent.origin && intent.destination && intent.origin !== intent.destination) return false;
  return true;
}

/** Nulls and empty collections in a model's full response do not erase earlier requirements.
 * Explicit changes to false/empty/null require a named clearedFields or changedFields entry. */
export function mergeIntent(previous: ConversationIntent | null, raw: any): ConversationIntent | null {
  const current = sanitizeConversationIntent(raw);
  if (!current || !previous || raw?.newConversation === true) return current;
  const result = { ...current };
  const changed = new Set(Array.isArray(raw.changedFields) ? raw.changedFields : []);
  const cleared = new Set(Array.isArray(raw.clearedFields) ? raw.clearedFields : []);
  for (const field of REQUIREMENT_FIELDS) {
    if (cleared.has(field)) {
      (result as any)[field] = Array.isArray(previous[field]) ? [] : typeof previous[field] === 'boolean' ? false : null;
    } else if (isEmpty(current[field]) && !changed.has(field)) (result as any)[field] = previous[field];
  }
  return result;
}

/** Treat client state only as a status hint and never as route facts. Values must match the separately sanitized intent. */
export function buildRequirementState(intent: ConversationIntent | null, priorIntent: ConversationIntent | null, prior: any, confirmed: boolean,
  place: PlaceContext | null, retrieved: Map<string, Candidate>, interpretation?: any): RequirementState | null {
  if (!intent) return null;
  const requirements = {} as RequirementState['requirements'];
  for (const field of REQUIREMENT_FIELDS) {
    const value = intent[field];
    const previous = prior?.version === 1 ? prior.requirements?.[field] : null;
    const requestedPriority = Array.isArray(interpretation?.requiredFields) && interpretation.requiredFields.includes(field) ? 'required' : Array.isArray(interpretation?.preferredFields) && interpretation.preferredFields.includes(field) ? 'preferred' : null;
    const tagStrengthChanged = field === 'preferredTags' && intent.preferredTags.some(tag =>
      (Array.isArray(interpretation?.requiredRouteTags) && interpretation.requiredRouteTags.includes(tag) && prior?.tagPriorities?.[tag] !== 'required') ||
      (Array.isArray(interpretation?.preferredRouteTags) && interpretation.preferredRouteTags.includes(tag) && prior?.tagPriorities?.[tag] !== 'preferred'));
    const wasConfirmed = previous?.status === 'confirmed' && priorIntent && same(previous.value, priorIntent[field]) && same(priorIntent[field], value) && (!requestedPriority || requestedPriority === previous.priority) && !tagStrengthChanged;
    const explicitlyFalse = value === false && (Array.isArray(interpretation?.changedFields) && interpretation.changedFields.includes(field) || previous?.value === false && previous?.status !== 'unknown' && priorIntent && same(priorIntent[field], value));
    const empty = isEmpty(value) && !explicitlyFalse;
    const reviewed = confirmed && priorIntent && same(priorIntent[field], value) && shownInConfirmation(priorIntent, field);
    const status = empty ? 'unknown' : reviewed || wasConfirmed ? 'confirmed' : 'pending';
    const samePrior = priorIntent && same(priorIntent[field], value) && same(previous?.value, value);
    const preservedPriority = samePrior && ['required', 'preferred'].includes(previous?.priority) && !(field === 'place' && previous.priority === 'required' && previous.prioritySource !== 'explicit') ? previous.priority : null;
    requirements[field] = { value, status, priority: empty ? 'unspecified' : requestedPriority || preservedPriority || (soft.has(field) ? 'preferred' : 'required'),
      prioritySource: requestedPriority || (preservedPriority && previous?.prioritySource === 'explicit') ? 'explicit' : 'default' } as RequirementEntry;
  }
  const candidates = (place?.candidates || []).map(item => {
    const candidate = retrieved.get(item.id);
    return { ...item, evidence: candidate ? 'retrieved_this_turn' as const : 'reference_only' as const,
      selection: place?.selectedId === item.id ? (confirmed && candidate ? 'confirmed' as const : 'pending' as const) : 'unselected' as const,
      facts: candidate ? { score: Number.isFinite(candidate.score) ? candidate.score! : null, distanceKm: Number.isFinite(candidate.distanceKm) ? candidate.distanceKm! : null, tags: candidate.tags || null } : null };
  });
  const tagPriorities: RequirementState['tagPriorities'] = {};
  const explicitRequired: unknown[] = Array.isArray(interpretation?.requiredRouteTags) ? interpretation.requiredRouteTags : [];
  const explicitPreferred: unknown[] = Array.isArray(interpretation?.preferredRouteTags) ? interpretation.preferredRouteTags : [];
  for (const tag of intent.preferredTags) {
    const old = priorIntent?.preferredTags.includes(tag) && prior?.version === 1 ? prior.tagPriorities?.[tag] : null;
    tagPriorities[tag] = explicitRequired.includes(tag) ? 'required' : explicitPreferred.includes(tag) ? 'preferred' : old === 'required' || old === 'preferred' ? old :
      requirements.preferredTags.priority === 'required' ? 'required' : 'preferred';
  }
  return { version: 1, requirements, tagPriorities, candidates };
}
