import type { Candidate } from '../controllers/ideaController';
import { getDistanceMeters } from '../utils/polyline';
import { relatedSearchTerms } from './ideaPlaceSearch';
import { requestedRouteTags, tagPreferenceScore } from './ideaTagPreferences';

type Point = { lat: number; lng: number };
type Preferences = ReturnType<typeof requestedRouteTags>;
export type DiscoveryCandidate = Candidate & { reason: string; matchKind: 'original' | 'related' | 'attribute' | 'category'; matchedTerm: string | null; distanceFromCenterKm: number };
function termStrength(name: string, term: string): number {
  if (/\p{Script=Han}/u.test(term)) return Array.from(term).length > 1 ? 3 : 1;
  const index = name.indexOf(term);
  if (index < 0) return -1;
  const before = index ? name[index - 1] : '', after = name[index + term.length] || '';
  return !/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after) ? 2 : 0;
}

/** Conservative fallback terms; generated words are search cues, never verified synonyms. */
export function fallbackDiscoveryTerms(query: string, idea: string): string[] {
  const suggestions = /^(沿江|滨江|江边|江滨)$/.test(query) ? ['江', '滨江', '江滨', 'yanjiang', 'jiang', 'river'] :
    /^(沿河|河边|滨河)$/.test(query) ? ['河', '滨河', 'yanhe', 'he', 'river'] :
    /^(沿湖|湖边|环湖)$/.test(query) ? ['湖', '环湖', 'yanhu', 'hu', 'lake'] : [];
  return relatedSearchTerms(query, idea, suggestions);
}

export function isThematicDiscovery(query: string, expand: unknown, idea: string): boolean {
  const positions: number[] = [];
  for (let index = idea.indexOf(query); index >= 0; index = idea.indexOf(query, index + Math.max(1, query.length))) positions.push(index);
  if (positions.length && positions.every(index => /(?:不要|不想|避开|避免|不经过|不去)\s*$/.test(idea.slice(Math.max(0, index - 5), index)))) return false;
  return expand === true || /^(沿江|滨江|江边|江滨|沿河|河边|滨河|沿湖|湖边|环湖)$/.test(query);
}

/** Recover explicit theme words when intent extraction omits the lookup entirely. */
export function explicitDiscoveryTheme(idea: string): string | null {
  if (!/(?:骑行|骑车|骑|路段|路线)/.test(idea) || /(?:是什么|什么意思|定义|解释|科普)/.test(idea)) return null;
  const matches = idea.matchAll(/沿江|滨江|江边|江滨|沿河|河边|滨河|沿湖|湖边|环湖/g);
  for (const match of matches) {
    const prefix = idea.slice(Math.max(0, (match.index || 0) - 5), match.index);
    if (!/(?:不要|不想|避免|避开|不经过|不去)\s*$/.test(prefix)) return match[0];
  }
  return null;
}

/** Merge actual retrieval results, preserving exact evidence and not treating unknown tags as matches. */
export function rankDiscoveryCandidates(input: { original: Candidate[]; related: Candidate[]; attributes: Candidate[]; query: string; terms: string[]; center: Point; radiusKm: number; preferences: Preferences; type?: 'point' | 'segment' | 'all'; pointKind?: string | null }): DiscoveryCandidate[] {
  const entries = new Map<string, DiscoveryCandidate>();
  const desired = input.preferences.preferred;
  for (const [source, candidates] of [['original', input.original], ['related', input.related], ['attribute', input.attributes]] as const) {
    for (const candidate of candidates) {
      if (!candidate || candidate.hazardous === true || !Number.isFinite(candidate.lat) || !Number.isFinite(candidate.lng) || (input.type && input.type !== 'all' && candidate.type !== input.type)) continue;
      if (input.preferences.avoid.some(tag => candidate.tags?.[tag] === 'matched')) continue;
      const km = getDistanceMeters(input.center, candidate) / 1000;
      if (!Number.isFinite(km) || km > input.radiusKm) continue;
      const normalized = candidate.name.toLocaleLowerCase();
      const matchedTerm = input.terms.filter(term => normalized.includes(term.toLocaleLowerCase())).sort((a, b) => termStrength(normalized, b.toLocaleLowerCase()) - termStrength(normalized, a.toLocaleLowerCase()) || b.length - a.length)[0] || null;
      const exact = normalized.includes(input.query.toLocaleLowerCase());
      const matchedAttributes = desired.filter(tag => candidate.tags?.[tag] === 'matched');
      const pointKind = input.pointKind || '';
      const categoryMatch = source === 'attribute' && candidate.type === 'point' && !!pointKind &&
        (/咖啡|coffee|cafe/i.test(pointKind) ? /咖啡|coffee|cafe/i.test(candidate.name) : /补给|便利/.test(pointKind) ? candidate.category === 'supply' : /休息|休憩/.test(pointKind) ? candidate.category === 'rest' : false);
      if (!exact && !matchedTerm && (!matchedAttributes.length || source !== 'attribute') && !categoryMatch) continue;
      const matchKind = exact ? 'original' : matchedTerm ? 'related' : categoryMatch ? 'category' : 'attribute';
      const labels: Record<string, string> = { climbing: '爬坡', loop: '绕圈', out_and_back: '往返', long_distance: '长距离', popular: '热门', highly_starred: '高收藏' };
      const basis = matchKind === 'original' ? `名称包含“${input.query}”` : matchKind === 'related' ? `名称包含关联词“${matchedTerm}”` : matchKind === 'category' ? `名称或类别与“${pointKind}”相关` : `已标记${matchedAttributes.map(tag => labels[tag]).join('、')}属性`;
      const item: DiscoveryCandidate = { ...candidate, matchKind, matchedTerm: exact ? input.query : matchedTerm, distanceFromCenterKm: km,
        reason: `${basis}，距搜索中心约 ${km.toFixed(1)} 公里；名称或标签不能确认实际骑行体验。` };
      const previous = entries.get(candidate.id);
      const tier = { original: 0, related: 1, attribute: 2, category: 2 };
      if (!previous || tier[item.matchKind] < tier[previous.matchKind]) entries.set(candidate.id, item);
    }
  }
  const tier = { original: 0, related: 1, attribute: 2, category: 2 };
  return [...entries.values()].sort((a, b) => tier[a.matchKind] - tier[b.matchKind] ||
    (a.matchKind === 'related' && b.matchKind === 'related' ? termStrength(b.name.toLocaleLowerCase(), b.matchedTerm!.toLocaleLowerCase()) - termStrength(a.name.toLocaleLowerCase(), a.matchedTerm!.toLocaleLowerCase()) : 0) ||
    tagPreferenceScore(b, input.preferences) - tagPreferenceScore(a, input.preferences) || a.distanceFromCenterKm - b.distanceFromCenterKm || a.id.localeCompare(b.id));
}
