import assert from 'node:assert/strict';
import test from 'node:test';
import { auditSignalsAlongRoute, AuditSignalFeature } from './routeSignalAudit';

const route = [
  { lat: 31.2300, lng: 121.4700 },
  { lat: 31.2300, lng: 121.4800 }
];

function signal(id: number, lat: number, lng: number, tags: Record<string, string> = {}): AuditSignalFeature {
  return { id, lat, lng, tags: { highway: 'traffic_signals', ...tags } };
}

test('matches a signal to the middle of a long route segment', () => {
  const result = auditSignalsAlongRoute(route, [signal(1, 31.23005, 121.475)]);
  assert.equal(result.matchedJunctions, 1);
  assert.equal(result.nearbyJunctions, 0);
  assert.equal(result.junctions[0].status, 'matched');
});

test('merges poles at one junction and highlights direction ambiguity', () => {
  const result = auditSignalsAlongRoute(route, [
    signal(1, 31.2300, 121.475, { 'traffic_signals:direction': 'forward' }),
    signal(2, 31.2301, 121.4751)
  ]);
  assert.equal(result.matchedJunctions, 1);
  assert.equal(result.junctions[0].features.length, 2);
  assert.ok(result.junctions[0].reviewReasons.some(reason => reason.includes('方向')));
});

test('keeps nearby but unconfirmed signals out of the matched count', () => {
  const result = auditSignalsAlongRoute(route, [signal(1, 31.2303, 121.475)]);
  assert.equal(result.matchedJunctions, 0);
  assert.equal(result.nearbyJunctions, 1);
  assert.equal(result.reviewJunctions, 1);
});

test('does not include signals outside the review corridor', () => {
  const result = auditSignalsAlongRoute(route, [signal(1, 31.231, 121.475)]);
  assert.equal(result.junctions.length, 0);
});
