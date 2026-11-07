import { strict as assert } from 'assert';
import { test } from 'node:test';
import { planSegmentRoundTrip } from './segmentRoundTripController';

const database = require('../config/db') as typeof import('../config/db');
const routeService = require('../services/ideaRouteService') as typeof import('../services/ideaRouteService');
const origin = { lat: 31.2, lng: 121.4 };
const response = () => {
  const result = { statusCode: 200, body: null as any,
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; } };
  return result;
};

test('plans to the selected stored segment, follows its geometry, and returns to the origin', async t => {
  let queriedId: unknown;
  t.mock.method(database, 'query', (async (_sql: string, params: unknown[]) => {
    queriedId = params[0]; return { rows: [{ name: '滨江路段', geometry: 'LINESTRING (121.41 31.21,121.42 31.22)' }] };
  }) as any);
  const route = { legs: [{ type: 'segment' }], distanceKm: 25 };
  t.mock.method(routeService, 'buildIdeaRoute', (async (...args: any[]) => {
    assert.deepEqual(args[0], origin); assert.deepEqual(args[2], origin);
    assert.deepEqual(args[4], [{ type: 'segment', name: '滨江路段', coordinates: [{ lat: 31.21, lng: 121.41 }, { lat: 31.22, lng: 121.42 }] }]);
    return route;
  }) as any);
  const res = response();
  await planSegmentRoundTrip({ body: { origin, segmentId: 'segment:123' } } as any, res as any);
  assert.equal(queriedId, '123'); assert.equal(res.statusCode, 200); assert.deepEqual(res.body.route, route);
});

test('rejects invalid inputs, missing segments and incomplete geometries', async t => {
  let rows: unknown[] = [];
  t.mock.method(database, 'query', (async () => ({ rows })) as any);
  const invalid = response();
  await planSegmentRoundTrip({ body: { origin, segmentId: 'not-an-id' } } as any, invalid as any);
  assert.equal(invalid.statusCode, 400);
  const missing = response();
  await planSegmentRoundTrip({ body: { origin, segmentId: '123' } } as any, missing as any);
  assert.equal(missing.statusCode, 404);
  rows = [{ name: '路段', geometry: 'LINESTRING (121.4 31.2,invalid)' }];
  const malformed = response();
  await planSegmentRoundTrip({ body: { origin, segmentId: '123' } } as any, malformed as any);
  assert.equal(malformed.statusCode, 422);
});
