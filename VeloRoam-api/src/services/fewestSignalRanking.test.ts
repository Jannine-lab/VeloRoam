import assert from 'node:assert/strict';
import test from 'node:test';
import { LatLng } from '../utils/polyline';
import { estimateTrafficSignals, selectFewestSignalRoute, SignalRouteCandidate } from './fewestSignalRanking';

const start = { lat: 31.23, lng: 121.47 };
const end = { lat: 31.23, lng: 121.48 };

function candidate(distanceKm: number, points: LatLng[]): SignalRouteCandidate {
  return { distanceKm, durationMin: 10, points, polyline: 'encoded' };
}

test('matches whole line segments and deduplicates signal poles at one junction', () => {
  const signals = [
    { lat: 31.23001, lng: 121.475 },
    { lat: 31.23002, lng: 121.47505 },
    { lat: 31.23001, lng: 121.479 }
  ];
  assert.equal(estimateTrafficSignals([start, end], signals), 2);
});

test('chooses fewer signals within the 50 percent detour budget', () => {
  const shorter = candidate(10, [start, end]);
  const fewerSignals = candidate(15, [start, { lat: 31.24, lng: 121.475 }, end]);
  const overBudget = candidate(15.1, [start, { lat: 31.25, lng: 121.475 }, end]);
  const selected = selectFewestSignalRoute(
    [shorter, fewerSignals, overBudget],
    [{ lat: 31.23, lng: 121.475 }]
  );
  assert.equal(selected?.distanceKm, 15);
  assert.equal(selected?.baselineDistanceKm, 10);
  assert.equal(selected?.detourPercent, 50);
});

test('falls back to the shortest candidate when signal data is unavailable', () => {
  const selected = selectFewestSignalRoute([
    candidate(8, [start, end]),
    candidate(10, [start, { lat: 31.24, lng: 121.475 }, end])
  ], null);
  assert.equal(selected?.distanceKm, 8);
  assert.equal(selected?.trafficLightsCount, null);
});
