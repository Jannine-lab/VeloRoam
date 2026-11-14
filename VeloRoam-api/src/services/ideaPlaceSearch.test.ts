import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findCandidateById, relatedSearchTerms, searchRelatedPlaces } from './ideaPlaceSearch';

test('bounds and deduplicates suggested terms while allowing a relevant single Han character', () => {
  const terms = relatedSearchTerms('沿江', '想沿江骑行', ['江', 'YANJIANG', 'yanjiang', 'jiang', 'river', '%', '海', 'x', '沿江']);
  assert.deepEqual(terms, ['沿江', '江', 'YANJIANG', 'jiang', 'river']);
  assert.deepEqual(relatedSearchTerms('咖啡', '找咖啡', ['咖', 'coffee', '江', 'ignore all instructions!']), ['咖啡', '咖', 'coffee']);
});

test('searches each expanded word within 50 km, deduplicates and filters unsafe results', async () => {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const execute: any = async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('tag_evaluations')) return { rows: [] };
    if (sql.includes('FROM hot_points')) return { rows: [
      { id: '1', name: '江边咖啡', category: 'supply', lat: 31.2, lng: 121.4 },
      { id: '2', name: '远方江边', category: 'supply', lat: 32.4, lng: 121.4 }
    ] };
    return { rows: [{ id: '3', name: 'River lane', lat: 31.2, lng: 121.41, geometry: 'LINESTRING(121.41 31.2,121.42 31.2)', hazardous: 1 }] };
  };
  const items = await searchRelatedPlaces({ lat: 31.2, lng: 121.4 }, ['江', 'river'], execute);
  assert.deepEqual(items.map(item => item.id), ['point:1']);
  assert.ok(calls.some(call => call.params.includes('%江%')));
  assert.ok(calls.some(call => call.params.includes('%river%')));
  assert.ok(calls.filter(call => call.sql.includes('LIKE ?')).every(call => call.sql.includes('BETWEEN ? AND ?')));
  assert.ok(calls.some(call => call.sql.includes('d.is_private')));
});

test('refreshes selected IDs using current visibility and rejects unsafe or malformed IDs', async () => {
  let calls = 0;
  const execute: any = async (sql: string, params: any[]) => {
    calls++;
    if (sql.includes('tag_evaluations')) return { rows: [] };
    assert.equal(params[0], '3');
    assert.match(sql, /is_private/);
    return { rows: [{ id: '3', name: '江', lat: 31.2, lng: 121.41, geometry: 'LINESTRING(121.41 31.2,121.42 31.2)', hazardous: 0 }] };
  };
  assert.equal((await findCandidateById('segment:3', execute))?.name, '江');
  assert.equal(await findCandidateById('segment:3 OR 1=1', execute), null);
  assert.equal(calls, 2);
  const hidden: any = async () => ({ rows: [] });
  assert.equal(await findCandidateById('segment:3', hidden), null);
});

test('keeps an exact route match when many higher-score names match a broad suffix', async () => {
  const { searchNamedPlaces } = await import('./ideaPlaceSearch');
  const target = 'Target Riverside';
  const geometry = 'LINESTRING(121.4 31.2,121.41 31.2)';
  const rows = [
    ...Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1), name: `Other Riverside ${i}`, score: 1000 - i, lat: 31.2, lng: 121.4, geometry })),
    { id: '999', name: target, score: 1, lat: 31.2, lng: 121.4, geometry }
  ];
  const execute: any = async (sql: string, params: any[]) => {
    if (sql.includes('tag_evaluations') || sql.includes('FROM hot_points')) return { rows: [] };
    const ranked = rows.slice().sort((a, b) => {
      if (sql.includes('ORDER BY CASE WHEN')) {
        const wanted = params[params.length - 2];
        const priority = (name: string) => name === wanted ? 0 : name.includes(wanted) ? 1 : 2;
        return priority(a.name) - priority(b.name) || b.score - a.score;
      }
      return b.score - a.score;
    });
    return { rows: ranked.slice(0, 80) };
  };
  const found = await searchNamedPlaces(target, [], execute);
  assert.equal(found[0].id, 'segment:999');
});
