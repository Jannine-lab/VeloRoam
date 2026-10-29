import { strict as assert } from 'assert';
import { test } from 'node:test';
import { recommendDistanceRoutes, NearbySegment } from './ideaDistanceRecommendations';
import { CompositeRoute } from './ideaRouteService';

const origin = { lat: 31.2, lng: 121.4 };
const segment = (id: string, lat: number): NearbySegment => ({ id, name: id, score: 50, coordinates: [{ lat, lng: 121.4 }, { lat: lat + .01, lng: 121.4 }] });
const segments = [segment('near', 31.25), segment('mid', 31.35), segment('far', 31.5)];
const fakeRoute = (distanceKm: number): CompositeRoute => ({ legs: [], stops: [], distanceKm, durationMin: 1, hasEstimatedTime: false });

test('returns only real calculated routes within each target range and avoids duplicates', async () => {
  const distances: Record<string, number> = { near: 19, mid: 55, far: 95 };
  const build: any = async (_a: unknown, _b: unknown, _c: unknown, _d: unknown, stops: any[]) => fakeRoute(distances[stops[0].name]);
  const result = await recommendDistanceRoutes(origin, '起点', segments, build);
  assert.deepEqual(result.map(item => item.route?.distanceKm), [19, 55, 95]);
});

test('returns empty slots when navigation fails or distances fall outside tolerance', async () => {
  const build: any = async (_a: unknown, _b: unknown, _c: unknown, _d: unknown, stops: any[]) => {
    if (stops[0].name === 'near') throw new Error('no route');
    return fakeRoute(300);
  };
  const result = await recommendDistanceRoutes(origin, '起点', segments, build);
  assert.deepEqual(result.map(item => item.route), [null, null, null]);
});


test('within the total-distance range selects the higher-scoring segment over the closest distance', async () => {
  const candidates = [{ ...segment('closer', 31.32), score: 50 }, { ...segment('higher', 31.34), score: 95 }];
  const build: any = async (_a: unknown, _b: unknown, _c: unknown, _d: unknown, stops: any[]) => fakeRoute(stops[0].name === 'closer' ? 50 : 72);
  const result = await recommendDistanceRoutes(origin, '起点', candidates, build);
  assert.equal(result[1].route?.distanceKm, 72);
  assert.equal(result[1].segmentScore, 95);
});
