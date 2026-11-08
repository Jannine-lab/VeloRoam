import { ConversationIntent, ROUTE_TAGS, RouteTag, RouteTagStatuses, TagStatus } from './ideaIntent';

export interface TaggableCandidate { id: string; type: 'point' | 'segment'; tags?: RouteTagStatuses; }
type Query = (sql: string, params?: any[]) => Promise<{ rows: any[] }>;

export function unknownRouteTags(): RouteTagStatuses {
  return Object.fromEntries(ROUTE_TAGS.map(tag => [tag, 'unknown'])) as RouteTagStatuses;
}

/** Query only real candidate IDs; absence of a row or table remains unknown. */
export async function attachSegmentTags<T extends TaggableCandidate>(items: T[], query: Query): Promise<T[]> {
  const ids = [...new Set(items.filter(item => item.type === 'segment' && /^segment:[1-9]\d*$/.test(item.id)).map(item => item.id.slice(8)))];
  const byId = new Map(ids.map(id => [id, unknownRouteTags()]));
  if (ids.length) {
    try {
      const result = await query(`SELECT CAST(segment_id AS CHAR) AS id, tag, status FROM strava_segment_tag_evaluations WHERE segment_id IN (${ids.map(() => '?').join(',')})`, ids);
      for (const row of result.rows) {
        const tags = byId.get(String(row.id));
        if (!tags || !(ROUTE_TAGS as readonly string[]).includes(row.tag) || !['matched', 'not_matched', 'unknown'].includes(row.status)) continue;
        tags[row.tag as RouteTag] = row.status as TagStatus;
      }
    } catch (error: any) {
      if (error?.code !== 'ER_NO_SUCH_TABLE' && error?.errno !== 1146) throw error;
    }
  }
  return items.map(item => item.type === 'segment' ? { ...item, tags: byId.get(item.id.slice(8)) || unknownRouteTags() } : item);
}

const tagPatterns: Array<[RouteTag, RegExp]> = [
  ['climbing', /爬坡|爬山|上坡/], ['loop', /绕圈|刷圈|环线训练/], ['out_and_back', /往返路段|折返路段|原路往返/],
  ['long_distance', /长距离路段|长路段|长途路段/], ['popular', /热门|人气|高人气/], ['highly_starred', /高收藏|收藏多|收藏量/]
];

export function requestedRouteTags(intent: Pick<ConversationIntent, 'preferences' | 'preferredTags' | 'avoidTags'>): { preferred: RouteTag[]; avoid: RouteTag[]; leisure: boolean } {
  const preferred = new Set(intent.preferredTags);
  const avoid = new Set(intent.avoidTags);
  const preferenceText = intent.preferences.join(' ');
  for (const [tag, pattern] of tagPatterns) {
    for (const preference of intent.preferences) {
      const match = preference.match(pattern);
      if (!match || match.index === undefined) continue;
      const prefix = preference.slice(Math.max(0, match.index - 5), match.index);
      if (/不|不要|避免|避开|别/.test(prefix)) avoid.add(tag);
      else preferred.add(tag);
    }
  }
  for (const tag of avoid) preferred.delete(tag);
  return { preferred: [...preferred], avoid: [...avoid], leisure: /轻松|休闲|舒适/.test(preferenceText) };
}

export function tagPreferenceScore(candidate: TaggableCandidate, preferences: ReturnType<typeof requestedRouteTags>): number {
  if (candidate.type !== 'segment') return 0;
  const tags = candidate.tags || unknownRouteTags();
  let score = 0;
  for (const tag of preferences.preferred) score += tags[tag] === 'matched' ? 3 : tags[tag] === 'not_matched' ? -1 : 0;
  if (preferences.leisure && !preferences.preferred.includes('climbing') && tags.climbing === 'matched') score--;
  return score;
}

/** Explicit exclusions remove known matches; unknown tags remain unknown. */
export function rankCandidatesByTags<T extends TaggableCandidate>(items: T[], preferences: ReturnType<typeof requestedRouteTags>): T[] {
  return items.map((candidate, index) => ({ candidate, index, score: tagPreferenceScore(candidate, preferences) }))
    .filter(({ candidate }) => candidate.type !== 'segment' || !preferences.avoid.some(tag => candidate.tags?.[tag] === 'matched'))
    .sort((a, b) => b.score - a.score || a.index - b.index).map(({ candidate }) => candidate);
}
