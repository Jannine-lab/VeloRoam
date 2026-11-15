import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { explainPlanningFailure } from './ideaPlanningEvidence';
import type { Candidate } from '../controllers/ideaController';
const center = { lat: 31.2, lng: 121.4 };
const segment: Candidate = { id: 'segment:1', type: 'segment', name: 'Yuandang Loop', ...center };
const point: Candidate = { id: 'point:1', type: 'point', name: '现炒面馆', category: 'supply', ...center };

test('reports only actually searched words and retains each type of candidate on failure', async () => {
  const calls: string[][] = [];
  const result = await explainPlanningFailure({ idea: '元荡湖绕圈然后去现炒浇头面馆', area: '元荡湖',
    observations: [{ kind: 'segment', query: '元荡湖', center, candidates: [segment] }, { kind: 'point', query: '现炒浇头面馆', center, candidates: [point] }],
    expand: async query => query === '元荡湖' ? ['yuandang', 'yuandang lake'] : ['noodle'],
    related: async (_center, terms) => { calls.push(terms); return terms.includes('yuandang') ? [segment] : [point]; } });
  assert.equal(calls.length, 2); assert.ok(calls[0].includes('yuandang')); assert.ok(calls[1].includes('面馆'));
  assert.match(result.text, /yuandang/); assert.match(result.text, /现炒面馆/);
  assert.deepEqual(result.items.map(item => item.id), ['segment:1', 'point:1']);
  assert.ok(result.items.every(item => item.evidenceOnly && /尚未确认/.test(item.reason)));
});

test('reports partial search unavailability instead of claiming no results', async () => {
  const result = await explainPlanningFailure({ idea: '骑元荡湖', area: '元荡湖', observations: [{ kind: 'segment', query: '元荡湖', center, candidates: [segment] }],
    expand: async () => { throw Error('model unavailable'); }, related: async () => { throw Error('database unavailable'); } });
  assert.match(result.text, /关联词检索暂不可用/); assert.equal(result.items[0].id, segment.id);
});

test('retains all retrieved candidates while presenting both types first', async () => {
  const segments = Array.from({ length: 12 }, (_, i) => ({ ...segment, id: `segment:${i + 1}` }));
  const points = Array.from({ length: 9 }, (_, i) => ({ ...point, id: `point:${i + 1}` }));
  const result = await explainPlanningFailure({ idea: '骑一圈', area: null, observations: [
    { kind: 'segment', query: '附近路段', center, candidates: segments }, { kind: 'point', query: '附近途经点', center, candidates: points }
  ], expand: async () => [], related: async () => [] });
  assert.equal(result.items.length, 21);
  assert.deepEqual(result.items.slice(0, 4).map(item => item.type), ['segment', 'point', 'segment', 'point']);
});
