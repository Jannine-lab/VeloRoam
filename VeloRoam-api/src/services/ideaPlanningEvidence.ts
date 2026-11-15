import type { Candidate } from '../controllers/ideaController';
import { relatedSearchTerms } from './ideaPlaceSearch';
import { fallbackDiscoveryTerms } from './ideaDiscovery';

type Point = { lat: number; lng: number };
export type PlanningObservation = { kind: 'segment' | 'point'; query: string; center: Point; candidates: Candidate[]; unavailable?: boolean };
export type PlanningEvidenceItem = Candidate & { reason: string; evidenceOnly: true };

/** Preserve retrieved evidence while keeping uncertain name matches distinct from confirmed requirements. */
export async function explainPlanningFailure(input: {
  idea: string; area: string | null; observations: PlanningObservation[];
  related: (center: Point, terms: string[]) => Promise<Candidate[]>;
  expand: (query: string) => Promise<unknown>;
}): Promise<{ text: string; items: PlanningEvidenceItem[] }> {
  const entries: Array<{ candidate: Candidate; reason: string; relevance: number }> = [];
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: Candidate, reason: string, relevance = 0) => {
    if (!candidate || candidate.hazardous === true || !['point', 'segment'].includes(candidate.type)) return;
    if (seen.has(candidate.id)) {
      const existing = entries.find(entry => entry.candidate.id === candidate.id);
      if (existing && relevance > existing.relevance) { existing.reason = reason; existing.relevance = relevance; }
      return;
    }
    seen.add(candidate.id); entries.push({ candidate, reason, relevance });
  };
  for (const observed of input.observations) {
    const safe = observed.candidates.filter(item => item.type === observed.kind && item.hazardous !== true);
    const label = observed.kind === 'segment' ? '路段' : '地点';
    if (observed.unavailable) { lines.push(`规划阶段“${observed.query}”附近的${label}检索未完成，不能据此判断是否有候选。`); continue; }
    lines.push(`规划阶段在“${observed.query}”附近检索到 ${safe.length} 个${label}候选${safe.length ? `，包括${safe.slice(0, 3).map(item => `“${item.name}”`).join('、')}` : ''}；候选尚未逐一核实是否满足全部要求。`);
    for (const candidate of safe) add(candidate, `规划时在“${observed.query}”附近检索到的${label}候选；尚未确认满足全部要求或能连接成路线。`);
  }
  const searches: Array<{ query: string; center: Point; centerLabel: string }> = [];
  const area = input.area?.trim();
  const segmentObservation = input.observations.find(item => item.kind === 'segment');
  if (area && segmentObservation) searches.push({ query: area, center: segmentObservation.center, centerLabel: segmentObservation.unavailable ? '出发位置（目标区域尚未定位）' : `“${area}”的搜索位置` });
  const pointObservation = input.observations.find(item => item.kind === 'point' && item.query !== '附近途经点');
  if (pointObservation && !searches.some(item => item.query === pointObservation.query)) searches.push({ query: pointObservation.query, center: pointObservation.center, centerLabel: '上一个途经位置' });
  const relatedResults = await Promise.all(searches.slice(0, 2).map(async ({ query, center, centerLabel }) => {
    const pieces = ['面馆', '面条', '浇头', '现炒', '咖啡', '公园', '湖'].filter(term => query.includes(term));
    let suggestions: unknown = [];
    try { suggestions = await input.expand(query); } catch { /* Original and explicit fragments remain useful. */ }
    const fallback = fallbackDiscoveryTerms(query, input.idea);
    const terms = relatedSearchTerms(query, input.idea, [...fallback, ...pieces, ...(Array.isArray(suggestions) ? suggestions : [])]).slice(0, 5);
    try { return { query, terms, centerLabel, candidates: await input.related(center, terms), unavailable: false }; }
    catch { return { query, terms, centerLabel, candidates: [] as Candidate[], unavailable: true }; }
  }));
  for (const result of relatedResults) {
    if (result.unavailable) { lines.push(`“${result.query}”的关联词检索暂不可用，不能据此判断是否有结果。`); continue; }
    const segments = result.candidates.filter(item => item.type === 'segment' && item.hazardous !== true);
    const points = result.candidates.filter(item => item.type === 'point' && item.hazardous !== true);
    const examples = [...segments.slice(0, 3), ...points.slice(0, 3)].map(item => `“${item.name}”`).join('、');
    lines.push(`以${result.centerLabel}为搜索中心，在 50 公里内按 ${result.terms.map(term => `“${term}”`).join('、')} 检索本地数据库，查到 ${segments.length} 条路段和 ${points.length} 个地点${examples ? `，包括${examples}` : ''}；关联词匹配不代表已经符合要求。`);
    for (const candidate of result.candidates) {
      const matched = result.terms.find(term => candidate.name.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
      const unknown = candidate.type === 'point' ? '具体位置、营业及是否符合要求尚未确认。' : '实际通行、路线连接及是否符合要求尚未确认。';
      add(candidate, `“${result.query}”搜索中心附近的名称关联候选${matched ? `，名称包含“${matched}”` : ''}；${unknown}`, matched ? 1 : 0);
    }
  }
  const segments = entries.filter(item => item.candidate.type === 'segment').sort((a, b) => b.relevance - a.relevance);
  const points = entries.filter(item => item.candidate.type === 'point').sort((a, b) => b.relevance - a.relevance);
  if (entries.length) lines.push(`下面列出本次已取得的 ${segments.length} 条路段和 ${points.length} 个地点候选；这不是数据库的全量结果。`);
  const mixed = Array.from({ length: Math.max(segments.length, points.length) }, (_, index) => [segments[index], points[index]]).flat().filter((item): item is typeof entries[number] => !!item);
  return { text: lines.join('\n'), items: mixed.map(({ candidate, reason }) => ({ ...candidate, reason, evidenceOnly: true as const })) };
}
