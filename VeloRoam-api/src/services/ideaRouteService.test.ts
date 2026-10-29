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
