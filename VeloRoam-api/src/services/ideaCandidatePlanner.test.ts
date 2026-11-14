import { strict as assert } from 'assert';
import { test } from 'node:test';
import { compareRouteCandidates, routeBoundsFromIntent } from './ideaCandidatePlanner';
import { CompositeRoute, RouteStop } from './ideaRouteService';
import { sanitizeConversationIntent } from './ideaIntent';

const stops = (name: string): RouteStop[] => [{ type: 'point', name, coordinates: [{ lat: 31, lng: 121 }] }];
const route = (km: number): CompositeRoute => ({ legs: [], stops: [], distanceKm: km, durationMin: 1, hasEstimatedTime: false });

test('compares navigated candidates and enforces total-distance constraints before preference rank', async () => {
  const choices = [{ stops: stops('too-long'), priority: 0 }, { stops: stops('best'), priority: 1 }, { stops: stops('closest'), priority: 2 }];
  const distances: Record<string, number> = { 'too-long': 80, best: 72, closest: 50 };
  const result = await compareRouteCandidates(choices, { minKm: 25, maxKm: 75, targetKm: 50 }, async stops => route(distances[stops[0].name]));
  assert.equal(result?.route.distanceKm, 72);
  assert.equal(result?.attempted, 3);
  assert.equal(result?.valid, 2);
});

test('uses ±10% only for a target without explicit distance bounds', async () => {
  const bounds = routeBoundsFromIntent(sanitizeConversationIntent({ mode: 'route', targetKm: 50 })!);
  assert.equal(bounds.minKm, 45);
  assert.equal(bounds.maxKm, 55.00000000000001);
  const choices = [44.99, 45, 55, 55.01].map((km, i) => ({ stops: stops(String(km)), priority: i }));
  const result = await compareRouteCandidates(choices, bounds, async value => route(Number(value[0].name)));
  assert.equal(result?.route.distanceKm, 45);
  assert.equal(result?.valid, 2);
  const explicit = routeBoundsFromIntent(sanitizeConversationIntent({ mode: 'route', targetKm: 50, minKm: 30, maxKm: 70 })!);
  assert.equal(explicit.minKm, 30);
  assert.equal(explicit.maxKm, 70);
  const maximumOnly = routeBoundsFromIntent(sanitizeConversationIntent({ mode: 'route', targetKm: 50, maxKm: 60 })!);
  assert.equal(maximumOnly.minKm, null);
  assert.equal(maximumOnly.maxKm, 60);
});

test('enforces explicit time bounds and includes known stops in total time', async () => {
  const choices = [{ stops: stops('slow'), priority: 0 }, { stops: stops('faster'), priority: 0 }];
  const build = async (value: RouteStop[]) => ({ ...route(30), durationMin: value[0].name === 'slow' ? 100 : 80 });
  const result = await compareRouteCandidates(choices, { maxMinutes: 110, targetMinutes: 100, stopMinutes: 20 }, build);
  assert.equal(result?.stops[0].name, 'faster');
  assert.equal(result?.valid, 1);
  const unknownStops = await compareRouteCandidates(choices, { minMinutes: 110, maxMinutes: 120, stopMinutes: null }, build);
  assert.equal(unknownStops?.valid, 2);
  const knownStops = await compareRouteCandidates(choices, { minMinutes: 110, maxMinutes: 120, stopMinutes: 20 }, build);
  assert.equal(knownStops?.valid, 1);
});

test('continues when one route fails and does not invent a result outside constraints', async () => {
  const choices = [{ stops: stops('failure'), priority: 0 }, { stops: stops('long'), priority: 1 }];
  const result = await compareRouteCandidates(choices, { maxKm: 30 }, async value => {
    if (value[0].name === 'failure') throw new Error('no connection');
    return route(40);
  });
  assert.equal(result, null);
});

test('respects a bounded number of routing attempts', async () => {
  let calls = 0;
  const choices = Array.from({ length: 9 }, (_, i) => ({ stops: stops(String(i)), priority: i }));
  await compareRouteCandidates(choices, {}, async () => { calls++; return route(10); });
  assert.equal(calls, 6);
});

test('retains safe reasons for provider failure and budget rejection', async () => {
  const { RouteConnectionError } = await import('./ideaRouteService');
  const failures: import('./ideaCandidatePlanner').CandidateFailure[] = [];
  const result = await compareRouteCandidates([{ stops: stops('service'), priority: 0 }, { stops: stops('too-long'), priority: 1 }], { maxKm: 30 }, async value => {
    if (value[0].name === 'service') throw new RouteConnectionError('rate_limited', 'to_first_stop', 'secret');
    return route(40);
  }, 6, failures);
  assert.equal(result, null);
  assert.deepEqual(failures, [{ kind: 'navigation', reason: 'rate_limited', stage: 'to_first_stop' }, { kind: 'above_distance' }]);
  assert.doesNotMatch(JSON.stringify(failures), /secret/);
});

test('limits concurrent candidate builds while keeping all six alternatives eligible', async () => {
  const choices = Array.from({ length: 6 }, (_, i) => ({ stops: stops(String(i)), priority: i }));
  let active = 0, maximum = 0, count = 0;
  const result = await compareRouteCandidates(choices, {}, async value => {
    active++; maximum = Math.max(maximum, active); count++;
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; return route(10 + Number(value[0].name));
  });
  assert.equal(count, 6); assert.ok(maximum <= 3); assert.equal(result?.stops[0].name, '0');
});
