import { strict as assert } from 'assert';
import { test } from 'node:test';
import { recommendDistanceRoutes, NearbySegment } from './ideaDistanceRecommendations';
import { CompositeRoute } from './ideaRouteService';

const origin = { lat: 31.2, lng: 121.4 };
const segment = (id: string, lat: number): NearbySegment => ({ id, name: id, score: 50, coordinates: [{ lat, lng: 121.4 }, { lat: lat + .01, lng: 121.4 }] });
const segments = [segment('near', 31.25), segment('mid', 31.30), segment('far', 31.35)];
const fakeRoute = (distanceKm: number): CompositeRoute => ({ legs: [], stops: [], distanceKm, durationMin: 1, hasEstimatedTime: false });

test('returns only real calculated routes within each target range and avoids duplicates', async () => {
  const distances: Record<string, number> = { near: 25, mid: 35, far: 45 };
  const build: any = async (_a: unknown, _b: unknown, _c: unknown, _d: unknown, stops: any[]) => fakeRoute(distances[stops[0].name]);
  const result = await recommendDistanceRoutes(origin, '起点', segments, build);
  assert.deepEqual(result.map(item => item.route?.distanceKm), [25, 35, 45]);
});

test('returns empty slots when navigation fails or distances fall outside tolerance', async () => {
  const build: any = async (_a: unknown, _b: unknown, _c: unknown, _d: unknown, stops: any[]) => {
    if (stops[0].name === 'near') throw new Error('no route');
    return fakeRoute(300);
  };
  const result = await recommendDistanceRoutes(origin, '起点', segments, build);
  assert.deepEqual(result.map(item => item.route), [null, null, null]);
});

test('reports actual completed route calculations, including failed candidates', async () => {
  const stages: string[] = [];
  const build: any = async (_a: unknown, _b: unknown, _c: unknown, _d: unknown, stops: any[]) => {
    if (stops[0].name === 'near') throw new Error('no route');
    return fakeRoute(30);
  };
  await recommendDistanceRoutes(origin, '起点', segments, build, stage => stages.push(stage));
  assert.deepEqual(stages, ['正在规划往返路线 0/3', '正在规划往返路线 1/3', '正在规划往返路线 2/3', '正在规划往返路线 3/3', '正在筛选推荐路线']);
});


test('within the total-distance range selects the higher-scoring segment over the closest distance', async () => {
  const candidates = [{ ...segment('closer', 31.32), score: 50 }, { ...segment('higher', 31.34), score: 95 }];
  const build: any = async (_a: unknown, _b: unknown, _c: unknown, _d: unknown, stops: any[]) => fakeRoute(stops[0].name === 'closer' ? 35 : 45);
  const result = await recommendDistanceRoutes(origin, '起点', candidates, build);
  assert.equal(result[0].route?.distanceKm, 45);
  assert.equal(result[0].segmentScore, 95);
});

test('returns the selected segment detail without mixing it with another candidate', async () => {
  const detail = { id: 'chosen', recordedDistanceKm: 2, averageGrade: 0, maximumGrade: null, elevationGainM: 10,
    elevationLowM: null, elevationHighM: null, climbCategory: 0, city: null, state: null, country: null,
    starCount: 0, athleteCount: null, effortCount: null, stravaScore: null };
  const candidates = [{ ...segment('chosen', 31.25), score: 90, detail }, { ...segment('other', 31.30), score: 20 }];
  const result = await recommendDistanceRoutes(origin, '起点', candidates, async () => fakeRoute(30));
  assert.deepEqual(result[0].segmentDetail, detail);
  assert.equal(result[1].segmentDetail, null);
});

test('ranks the three valid round trips by score across the full 20–80 km range', async () => {
  const candidates = [
    { ...segment('high', 31.25), score: 95 }, { ...segment('middle', 31.30), score: 70 },
    { ...segment('low', 31.35), score: 40 }, { ...segment('too-long', 31.38), score: 99 },
    { ...segment('too-short', 31.27), score: 98 }
  ];
  const distances: Record<string, number> = { high: 80, middle: 20, low: 65, 'too-long': 80.1, 'too-short': 19.9 };
  const build: any = async (_a: unknown, _b: unknown, _c: unknown, _d: unknown, stops: any[]) => fakeRoute(distances[stops[0].name]);
  const result = await recommendDistanceRoutes(origin, '起点', candidates, build);
  assert.deepEqual(result.map(item => item.segmentScore), [95, 70, 40]);
  assert.deepEqual(result.map(item => item.route?.distanceKm), [80, 20, 65]);
});
