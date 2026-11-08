import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { sampleTrajectory } from './ideaWaypointSampling';

const a = { lat: 31.2, lng: 121.4 }, b = { lat: 31.2, lng: 121.41 }, c = { lat: 31.2, lng: 121.44 };
test('samples by travelled distance instead of point index', () => {
  const samples = sampleTrajectory([a, b, c], c, a, .75);
  const selected = samples.find(x => x.status === 'selected')!;
  assert.equal(selected.fraction, .75);
  assert.ok(Math.abs(selected.point.lng - 121.43) < .0001);
  assert.ok(selected.alongMeters > 2000);
});
test('keeps the target-direction reference close to the requested location', () => {
  const samples = sampleTrajectory([a, c], c, a, .65, 100);
  assert.equal(samples.find(x => x.status === 'selected')?.fraction, 1);
  assert.ok(samples.some(x => x.status === 'rejected' && /偏离目标方向/.test(x.reason)));
});
test('rejects points close to the current anchor and invalid geometry', () => {
  const samples = sampleTrajectory([a, c], c, c, 1);
  assert.equal(samples.find(x => x.fraction === 1)?.status, 'rejected');
  assert.notEqual(samples.find(x => x.status === 'selected')?.fraction, 1);
  assert.deepEqual(sampleTrajectory([a, a], a, a, .85), []);
});
