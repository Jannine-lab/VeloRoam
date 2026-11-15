import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { pointSearchSchema, searchPoints } from './ideaPointSearch';

const center = { lat: 31.2, lng: 121.4 };
test('searches active places by fuzzy names and category before sorting and pagination', async () => {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const execute: any = async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    return sql.includes('COUNT(*)') ? { rows: [{ total: 11 }] } : { rows: [{ id: '7', name: '浦东公园', category: 'scenic', lat: 31.2, lng: 121.4, address: '示例路', districtName: '浦东新区', score: 80 }] };
  };
  const result = await searchPoints(center, { radiusKm: 20, nameTerms: ['浦东', 'pudong', "a%' OR 1=1"], categories: ['scenic'], sortBy: 'nearest', limit: 5, offset: 5 }, execute);
  assert.equal(result.total, 11); assert.equal(result.hasMore, true); assert.equal(result.candidates[0].id, 'point:7'); assert.equal(result.candidates[0].address, '示例路');
  const sql = calls.find(call => call.sql.includes('districtName'))!;
  assert.match(sql.sql, /status = 'active'/); assert.match(sql.sql, /name LIKE \?/); assert.match(sql.sql, /category IN \(\?\)/);
  assert.ok(sql.params.includes('%pudong%')); assert.ok(sql.params.includes("%a\\%' OR 1=1%")); assert.doesNotMatch(sql.sql, /OR 1=1/);
  assert.deepEqual(sql.params.slice(-4), [121.4, 31.2, 5, 5]);
});
test('limits query radius and rejects unsafe or overly broad input', () => {
  assert.equal(pointSearchSchema.safeParse({ radiusKm: 51 }).success, false);
  assert.equal(pointSearchSchema.safeParse({ radiusKm: 10, nameTerms: ['x'] }).success, false);
  assert.equal(pointSearchSchema.safeParse({ radiusKm: 10, nameTerms: ['江'] }).success, true);
  assert.equal(pointSearchSchema.safeParse({ radiusKm: 10, categories: ['admin'] }).success, false);
});
