import { strict as assert } from 'assert';
import { test } from 'node:test';
import { ideaDistanceRecommendations } from './ideaDistanceController';

const database = require('../config/db') as typeof import('../config/db');
const service = require('../services/ideaDistanceRecommendations') as typeof import('../services/ideaDistanceRecommendations');
const origin = { lat: 31.2, lng: 121.4 };

function response() {
  return {
    statusCode: 200, headers: {} as Record<string, string>, events: '', body: null as any, destroyed: false, ended: false,
    status(code: number) { this.statusCode = code; return this; },
    set(headers: Record<string, string>) { this.headers = headers; return this; },
    flushHeaders() {},
    write(value: string) { this.events += value; return true; },
    json(value: unknown) { this.body = value; return this; },
    end() { this.ended = true; return this; }
  };
}

test('streams real stages and result while preserving JSON responses', async t => {
  t.mock.method(database, 'query', (async () => ({ rows: [] })) as any);
  const recommendations = [{ targetKm: 30, route: null, segmentScore: null, segmentDetail: null }];
  t.mock.method(service, 'recommendDistanceRoutes', (async (_origin: unknown, _name: unknown, _segments: unknown, _build: unknown, onProgress: (stage: string) => void) => {
    onProgress('正在筛选推荐路线'); return recommendations;
  }) as any);
  const streamed = response();
  await ideaDistanceRecommendations({ body: { origin }, get: () => 'text/event-stream' } as any, streamed as any);
  assert.match(streamed.headers['Content-Type'], /text\/event-stream/);
  assert.match(streamed.events, /正在查找附近路段/);
  assert.match(streamed.events, /正在筛选推荐路线/);
  assert.match(streamed.events, /event: result/);
  assert.ok(streamed.ended);
  const json = response();
  await ideaDistanceRecommendations({ body: { origin }, get: () => 'application/json' } as any, json as any);
  assert.deepEqual(json.body, { recommendations });
});
