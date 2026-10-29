import { strict as assert } from 'assert';
import { test } from 'node:test';
import { compareRouteCandidates } from './ideaCandidatePlanner';
import { CompositeRoute, RouteStop } from './ideaRouteService';

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
