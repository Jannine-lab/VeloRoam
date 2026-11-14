import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { addEnrouteSegments, EnrouteCandidate } from './ideaEnrouteSegments';
import { buildIdeaRoute, RouteStop } from './ideaRouteService';
import { requestedRouteTags } from './ideaTagPreferences';
import { getDistanceMeters } from '../utils/polyline';
import { SignalRouteCandidate } from './fewestSignalRanking';

const point = (lng: number) => ({ lat: 31.2, lng });
const start = point(121.4);
const path = (...lngs: number[]) => lngs.map(point);
const fixed: RouteStop = { type: 'segment', name: '沿江', coordinates: path(121.43, 121.432, 121.434), detail: { id: 'segment:fixed', averageGrade: null, elevationGainM: null, athleteCount: null, effortCount: null, hazardous: false, recordedDistanceKm: null } };
const outbound: EnrouteCandidate = { id: 'segment:out', type: 'segment', name: '去程绿道', coordinates: path(121.408, 121.41, 121.412), score: 90 };
const inbound: EnrouteCandidate = { id: 'segment:in', type: 'segment', name: '返程绿道', coordinates: path(121.424, 121.422, 121.42), score: 85 };
const prefs = requestedRouteTags({ preferences: [], preferredTags: [], avoidTags: [] });
const navigate = async (a: ReturnType<typeof point>, b: ReturnType<typeof point>): Promise<SignalRouteCandidate[]> => [{
  points: [a, b], distanceKm: getDistanceMeters(a, b) / 1000, durationMin: getDistanceMeters(a, b) / 300
} as unknown as SignalRouteCandidate];
const build = (stops: RouteStop[]) => buildIdeaRoute(start, '起点', start, '终点', stops, navigate);
async function setup() {
  const baseline = await build([fixed]);
  return { baseline, stops: [fixed], end: start, bounds: { maxKm: 20 }, preferences: prefs, overlapMode: 'neutral' as const, build };
}

test('adds outward and return segments in direction while retaining the fixed trajectory', async () => {
  const input = await setup();
  const result = await addEnrouteSegments({ ...input, near: async () => [outbound, inbound] });
  assert.deepEqual(result.added, ['去程绿道', '返程绿道']);
  assert.deepEqual(result.stops.map(stop => stop.name), ['去程绿道', '沿江', '返程绿道']);
  assert.deepEqual(result.route.legs.filter(leg => leg.type === 'segment').map(leg => leg.points), [outbound.coordinates, fixed.coordinates, inbound.coordinates]);
});

test('rejects backward, hazardous, low evidence and invalid geometry candidates', async () => {
  const input = await setup();
  const backwards = { ...outbound, coordinates: [...outbound.coordinates!].reverse() };
  const hazardous = { ...outbound, id: 'bad', hazardous: true };
  const unknown = { ...outbound, id: 'unknown', score: null };
  const broken = { ...outbound, id: 'broken', coordinates: path(121.408, 121.42) };
  const result = await addEnrouteSegments({ ...input, near: async () => [backwards, hazardous, unknown, broken] });
  assert.deepEqual(result.stops.map(s => s.name), ['沿江', '去程绿道']);
  const noReturn = { ...input, baseline: { ...input.baseline, legs: input.baseline.legs.slice(0, 2) }, end: fixed.coordinates[fixed.coordinates.length - 1] };
  const rejected = await addEnrouteSegments({ ...noReturn, near: async () => [backwards, hazardous, unknown, broken] });
  assert.deepEqual(rejected.added, []);
});

test('retains baseline when candidates exceed distance or time budget, or navigation fails', async () => {
  const input = await setup();
  const tooLong = await addEnrouteSegments({ ...input, bounds: { maxKm: input.baseline.distanceKm - .01 }, near: async () => [outbound] });
  assert.equal(tooLong.route, input.baseline);
  const tooSlow = await addEnrouteSegments({ ...input, bounds: { maxMinutes: 1, stopMinutes: 10 }, near: async () => [outbound] });
  assert.equal(tooSlow.route, input.baseline);
  const failed = await addEnrouteSegments({ ...input, near: async () => [outbound], build: async () => { throw Error('unavailable'); } });
  assert.equal(failed.route, input.baseline);
  const missing = await addEnrouteSegments({ ...input, near: async () => { throw Error('unavailable'); } });
  assert.equal(missing.route, input.baseline);
});

test('caps extra distance and rejects a result that loses a required stop', async () => {
  const input = await setup();
  const tooFar = await addEnrouteSegments({ ...input, near: async () => [outbound], build: async stops => ({ ...await build(stops), distanceKm: input.baseline.distanceKm + 3 }) });
  assert.equal(tooFar.route, input.baseline);
  const omitted = await addEnrouteSegments({ ...input, near: async () => [outbound], build: async () => build([fixed]) });
  assert.equal(omitted.route, input.baseline);
});

test('keeps the best single segment when a two-segment combination exceeds the detour limit', async () => {
  const input = await setup();
  const result = await addEnrouteSegments({ ...input, near: async () => [outbound, inbound], build: async stops => {
    const route = await build(stops);
    return stops.length > 2 ? { ...route, distanceKm: input.baseline.distanceKm + 3 } : route;
  } });
  assert.deepEqual(result.added, ['去程绿道']);
  assert.deepEqual(result.stops.map(stop => stop.name), ['去程绿道', '沿江']);
});

test('streams at most two distinct, high-scoring alternatives while retaining required stops', async () => {
  const input = await setup();
  const emitted: string[][] = [];
  const duplicate = { ...outbound, id: 'duplicate', name: '重复绿道', score: 89 };
  const low = { ...outbound, id: 'low', name: '低分路段', score: 79 };
  const bad = { ...outbound, id: 'hazard', name: '危险路段', score: 100, hazardous: true };
  const result = await addEnrouteSegments({ ...input, minimumScore: 80,
    near: async () => [outbound, duplicate, inbound, low, bad],
    onAlternative: value => {
      assert.ok(value.route.distanceKm <= input.bounds.maxKm);
      assert.ok(value.stops.some(stop => stop.name === fixed.name));
      emitted.push(value.added);
    }
  });
  assert.deepEqual(emitted, [['去程绿道'], ['返程绿道']]);
  assert.deepEqual(result.added, ['去程绿道']);
});

test('reports failed alternative searches and navigation instead of claiming there are no matches', async () => {
  const input = await setup();
  await assert.rejects(addEnrouteSegments({ ...input, onAlternative: () => {}, near: async () => { throw Error('unavailable'); } }), /enroute_search_unavailable/);
  await assert.rejects(addEnrouteSegments({ ...input, onAlternative: () => {}, near: async () => [outbound], build: async () => { throw Error('unavailable'); } }), /enroute_navigation_unavailable/);
});

test('samples multiple locations along long connections for streaming alternatives', async () => {
  const input = await setup();
  const points: ReturnType<typeof point>[] = [];
  const baseline = { ...input.baseline, legs: input.baseline.legs.map(leg => leg.type === 'connection' ? { ...leg, distanceKm: 45 } : leg) };
  await addEnrouteSegments({ ...input, baseline, onAlternative: () => {}, near: async center => { points.push(center); return []; } });
  assert.equal(points.length, 6);
  assert.notEqual(points[0].lng, points[1].lng);
  assert.notEqual(points[1].lng, points[2].lng);
});
