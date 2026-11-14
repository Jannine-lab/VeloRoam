import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { exploreConfirmedRoute } from './ideaAgentEnroute';
import { sanitizeConversationIntent } from './ideaIntent';
import { buildIdeaRoute, RouteStop } from './ideaRouteService';
import { getDistanceMeters } from '../utils/polyline';
import { SignalRouteCandidate } from './fewestSignalRanking';

const p = (lng: number) => ({ lat: 31.2, lng });
const start = p(121.4);
const fixed: RouteStop = { type: 'segment', name: '沿江', coordinates: [p(121.43), p(121.432), p(121.434)], detail: { id: 'segment:5', averageGrade: null, elevationGainM: null, athleteCount: null, effortCount: null, hazardous: false, recordedDistanceKm: null } };
const candidate = { id: 'segment:6', type: 'segment' as const, name: '绿道', score: 80, lat: 31.2, lng: 121.408, coordinates: [p(121.408), p(121.41), p(121.412)] };
const navigate = async (a: typeof start, b: typeof start): Promise<SignalRouteCandidate[]> => [{ points: [a, b], distanceKm: getDistanceMeters(a, b) / 1000, durationMin: getDistanceMeters(a, b) / 300 } as unknown as SignalRouteCandidate];
const build: typeof buildIdeaRoute = (a, an, b, bn, stops) => buildIdeaRoute(a, an, b, bn, stops, navigate);

test('reconstructs confirmed stops and reports the updated route rather than exposing raw geometry to the model', async () => {
  const route = await build(start, '起点', start, '终点', [fixed]);
  const intent = sanitizeConversationIntent({ mode: 'route', targetKm: 7, needsSegment: true })!;
  const result = await exploreConfirmedRoute({ result: { route, note: '已有说明。' }, intent, idea: '沿江骑7公里', near: async () => [candidate], build });
  assert.deepEqual(result.added, ['绿道']);
  assert.deepEqual(result.result.route!.legs.filter(leg => leg.type === 'segment').map(leg => leg.name), ['绿道', '沿江']);
  assert.match(result.result.note!, /加入顺路路段.*绿道/);
  assert.match(result.result.distanceNote!, /实际约/);
});

test('keeps the confirmed route for avoidance requests and rejects malformed baseline stops', async () => {
  const route = await build(start, '起点', start, '终点', [fixed]);
  const intent = sanitizeConversationIntent({ mode: 'route', targetKm: 7, needsSegment: true, preferences: ['避开爬坡'] })!;
  let reads = 0;
  const near = async () => { reads++; return [candidate]; };
  assert.equal((await exploreConfirmedRoute({ result: { route }, intent, idea: '避开爬坡', near, build })).result.route, route);
  const clean = sanitizeConversationIntent({ mode: 'route', targetKm: 7, needsSegment: true })!;
  const broken = { ...route, stops: route.stops.map(stop => stop.type === 'segment' ? { ...stop, name: '不匹配' } : stop) };
  assert.equal((await exploreConfirmedRoute({ result: { route: broken }, intent: clean, idea: '沿江', near, build })).result.route, broken);
  assert.equal(reads, 0);
});

test('generates a bounded high-scoring alternative without requiring a distance target', async () => {
  const route = await build(start, '起点', start, '终点', [fixed]);
  const intent = sanitizeConversationIntent({ mode: 'route' })!;
  const alternatives: string[][] = [];
  const result = await exploreConfirmedRoute({ result: { route }, intent, idea: '沿江骑行',
    near: async () => [candidate, { ...candidate, id: 'low', name: '低分路段', score: 79 }], build,
    onAlternative: item => alternatives.push(item.added) });
  assert.deepEqual(alternatives, [['绿道']]);
  assert.deepEqual(result.added, ['绿道']);
});
