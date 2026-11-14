import { strict as assert } from 'assert';
import { test } from 'node:test';
import { buildIdeaRoute } from './ideaRouteService';
import { LatLng, encodePolyline } from '../utils/polyline';

const start = { lat: 31.2, lng: 121.4 };
const segmentStart = { lat: 31.21, lng: 121.41 };
const segmentEnd = { lat: 31.22, lng: 121.42 };
const cafe = { lat: 31.23, lng: 121.43 };
const calls: Array<[LatLng, LatLng]> = [];
const roads = async (a: LatLng, b: LatLng) => {
  calls.push([a, b]);
  return [{ points: [a, b], polyline: encodePolyline([a, b]), distanceKm: 2, durationMin: 10 }];
};

test('assembles connections around the original segment in requested order and returns to start', async () => {
  calls.length = 0;
  const route = await buildIdeaRoute(start, '起点', start, '返回起点', [
    { type: 'segment', name: '热门路段', coordinates: [segmentStart, segmentEnd], distanceKm: 3 },
    { type: 'point', name: '咖啡店', coordinates: [cafe] }
  ], roads);
  assert.deepEqual(calls, [[start, segmentStart], [segmentEnd, cafe], [cafe, start]]);
  assert.deepEqual(route.legs.map(leg => leg.type), ['connection', 'segment', 'connection', 'connection']);
  assert.deepEqual(route.legs[1].points, [segmentStart, segmentEnd]);
  assert.ok(Math.abs(route.distanceKm - (6 + route.legs[1].distanceKm)) < 1e-9);
  assert.notEqual(route.legs[1].distanceKm, 3);
  assert.equal(route.hasEstimatedTime, true);
  assert.deepEqual(route.stops.map(stop => stop.name), ['起点', '热门路段', '咖啡店', '返回起点']);
});

test('honors point before segment without imposing a round trip', async () => {
  calls.length = 0;
  const route = await buildIdeaRoute(start, '起点', segmentEnd, '终点', [
    { type: 'point', name: '咖啡', coordinates: [cafe] },
    { type: 'segment', name: '路段', coordinates: [segmentStart, segmentEnd], distanceKm: 3 }
  ], roads);
  assert.deepEqual(calls, [[start, cafe], [cafe, segmentStart]]);
  assert.deepEqual(route.stops.map(stop => stop.name), ['起点', '咖啡', '路段', '终点']);
});

test('rejects unconnected provider geometry instead of fabricating a link', async () => {
  const farAway = { lat: 32, lng: 122 };
  await assert.rejects(buildIdeaRoute(start, '起点', cafe, '终点', [], async () => [{ points: [farAway, cafe], polyline: 'x', distanceKm: 2, durationMin: 10 }]), /无法连接/);
});

test('estimates time when the provider has no duration', async () => {
  const route = await buildIdeaRoute(start, '起点', cafe, '终点', [], async (a, b) => [{ points: [a, b], polyline: 'x', distanceKm: 9, durationMin: 0 }]);
  assert.equal(route.durationMin, 30);
  assert.equal(route.hasEstimatedTime, true);
});


test('counts each traversal in loop and out-and-back geometry instead of stored distance', async () => {
  const route = await buildIdeaRoute(start, '起点', start, '终点', [
    { type: 'segment', name: '往返两次', coordinates: [start, segmentStart, start, segmentStart, start], distanceKm: 1 }
  ], roads);
  assert.equal(route.legs.length, 1);
  assert.ok(Math.abs(route.distanceKm - 4 * (await buildIdeaRoute(start, '起点', segmentStart, '终点', [{ type: 'segment', name: '单程', coordinates: [start, segmentStart] }], roads)).distanceKm) < 1e-9);
});

test('rejects adjacent legs with a gap even when each provider endpoint is individually near the waypoint', async () => {
  let call = 0;
  const point = { lat: 31.21, lng: 121.41 };
  const shifted = (p: LatLng, delta: number) => ({ lat: p.lat + delta, lng: p.lng });
  const provider = async (a: LatLng, b: LatLng) => {
    const i = call++;
    const points = i === 0 ? [a, shifted(b, .0007)] : [shifted(a, -.0007), b];
    return [{ points, polyline: 'x', distanceKm: 2, durationMin: 10 }];
  };
  await assert.rejects(buildIdeaRoute(start, '起点', cafe, '终点', [{ type: 'point', name: '途经点', coordinates: [point] }], provider), /拼接处超过/);
});

test('reports measured junction gap without fabricating geometry', async () => {
  const point = { lat: 31.21, lng: 121.41 };
  let call = 0;
  const provider = async (a: LatLng, b: LatLng) => {
    const points = call++ === 0 ? [a, { lat: b.lat + .0001, lng: b.lng }] : [a, b];
    return [{ points, polyline: 'x', distanceKm: 2, durationMin: 10 }];
  };
  const route = await buildIdeaRoute(start, '起点', cafe, '终点', [{ type: 'point', name: '途经点', coordinates: [point] }], provider);
  assert.ok(route.continuity!.maxGapMeters > 10 && route.continuity!.maxGapMeters < 15);
  assert.equal(route.legs.length, 2);
});

test('preserves safe provider failure reason and which leg failed', async () => {
  const { AmapBicyclingError } = await import('./amapFewestSignalService');
  const { RouteConnectionError } = await import('./ideaRouteService');
  let count = 0;
  await assert.rejects(buildIdeaRoute(start, '起点', start, '返回起点', [{ type: 'segment', name: '路段', coordinates: [segmentStart, segmentEnd] }], async (a, b) => {
    if (++count === 2) throw new AmapBicyclingError('rate_limited');
    return roads(a, b);
  }), (error: any) => error instanceof RouteConnectionError && error.reason === 'rate_limited' && error.stage === 'to_destination');
});

test('identifies endpoint mismatch rather than silently accepting an unverified gap', async () => {
  const { RouteConnectionError } = await import('./ideaRouteService');
  await assert.rejects(buildIdeaRoute(start, '起点', cafe, '终点', [], async (_a, b) => [{ points: [{ lat: 32, lng: 122 }, b], polyline: 'x', distanceKm: 2, durationMin: 10 }]),
    (error: any) => error instanceof RouteConnectionError && error.reason === 'endpoint_mismatch');
});
