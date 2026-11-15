import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { searchSegments, segmentSearchSchema } from './ideaSegmentSearch';

const center = { lat: 31.2, lng: 121.4 };
test('parameterizes combined filters before ordering and pagination', async () => {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const execute: any = async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('tag_evaluations') && !sql.includes('strava_segments')) return { rows: [] };
    if (sql.includes('COUNT(*)')) return { rows: [{ total: 21 }] };
    return { rows: [{ id: '1', name: 'Pudong Loop', lat: 31.2, lng: 121.4, geometry: 'LINESTRING(121.4 31.2,121.41 31.2)', recordedDistanceKm: 10, averageGrade: 2, elevationGainM: 20, starCount: 5, hazardous: 0 }] };
  };
  const result = await searchSegments(center, { radiusKm: 20, nameTerms: ['浦东', 'pudong', "a%' OR 1=1"], minKm: 5, maxKm: 20, maxGrade: 3, maxElevationM: 100, minStars: 3, requiredTags: ['loop'], avoidTags: ['climbing'], sortBy: 'stars', limit: 10, offset: 10 }, execute);
  assert.equal(result.total, 21); assert.equal(result.hasMore, true); assert.equal(result.candidates[0].starCount, 5);
  const select = calls.find(x => x.sql.includes('ST_AsText'))!;
  assert.match(select.sql, /s\.distance_km >= \?/); assert.match(select.sql, /d\.average_grade <= \?/); assert.match(select.sql, /total_elevation_gain_m <= \?/);
  assert.match(select.sql, /EXISTS \(SELECT 1/); assert.match(select.sql, /NOT EXISTS \(SELECT 1/); assert.match(select.sql, /ORDER BY .*star_count/);
  assert.ok(select.params.includes('%pudong%')); assert.ok(select.params.includes("%a\\%' OR 1=1%")); assert.doesNotMatch(select.sql, /OR 1=1/);
  assert.deepEqual(select.params.slice(-2), [10, 10]);
});

test('rejects invalid bounds and restricts broad one-character terms', () => {
  assert.equal(segmentSearchSchema.safeParse({ radiusKm: 20, minKm: 30, maxKm: 5 }).success, false);
  assert.equal(segmentSearchSchema.safeParse({ radiusKm: 100 }).success, false);
  assert.equal(segmentSearchSchema.safeParse({ radiusKm: 10, nameTerms: ['x'] }).success, false);
  assert.equal(segmentSearchSchema.safeParse({ radiusKm: 10, nameTerms: ['江'] }).success, true);
  assert.equal(segmentSearchSchema.safeParse({ radiusKm: 10, sortBy: 'score; DROP TABLE' }).success, false);
});

test('nearest sorting binds the coordinates in both sort expressions', async () => {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const execute: any = async (sql: string, params: any[] = []) => { calls.push({ sql, params }); return { rows: sql.includes('COUNT(*)') ? [{ total: 0 }] : [] }; };
  await searchSegments(center, { radiusKm: 5, sortBy: 'nearest' }, execute);
  const row = calls.find(call => call.sql.includes('ST_AsText'))!;
  assert.deepEqual(row.params.slice(-6), [121.4, 31.2, 121.4, 31.2, 10, 0]);
});
