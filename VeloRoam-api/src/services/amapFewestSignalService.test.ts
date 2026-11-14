import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AmapBicyclingError, amapStatusError, requestBicyclingWithRetry } from './amapFewestSignalService';

const noDelay = async () => {};

test('retries a transient connection error once and returns the real provider response', async () => {
  let calls = 0;
  const result = await requestBicyclingWithRetry(async () => {
    if (++calls === 1) throw Object.assign(new Error('network error'), { code: 'ECONNRESET' });
    return { status: 'ok' };
  }, noDelay);
  assert.equal(calls, 2); assert.deepEqual(result, { status: 'ok' });
});

test('caps retry count and classifies network and quota errors without exposing provider URLs', async () => {
  let calls = 0;
  await assert.rejects(requestBicyclingWithRetry(async () => { calls++; throw Object.assign(new Error('secret-url'), { code: 'ETIMEDOUT' }); }, noDelay), (error: any) => {
    assert.ok(error instanceof AmapBicyclingError); assert.equal(error.reason, 'temporarily_unavailable'); assert.doesNotMatch(error.message, /secret-url/); return true;
  });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(requestBicyclingWithRetry(async () => { calls++; throw Object.assign(new Error('bad credentials'), { response: { status: 403 } }); }, noDelay), (error: any) => error.reason === 'request_rejected');
  assert.equal(calls, 1);
});

test('distinguishes provider no-road, range, quota, rate and temporary failures', async () => {
  assert.equal(amapStatusError('20801').reason, 'no_route');
  assert.equal(amapStatusError('20802').reason, 'no_route');
  assert.equal(amapStatusError('20803').reason, 'distance_limit');
  assert.equal(amapStatusError('20800').reason, 'outside_coverage');
  assert.equal(amapStatusError('10003').reason, 'quota_exhausted');
  assert.equal(amapStatusError('10004').reason, 'rate_limited');
  assert.equal(amapStatusError('10001').reason, 'request_rejected');
  let calls = 0;
  await assert.rejects(requestBicyclingWithRetry(async () => { calls++; throw amapStatusError('10004'); }, noDelay), (error: any) => error.reason === 'rate_limited');
  assert.equal(calls, 1);
  calls = 0;
  const value = await requestBicyclingWithRetry(async () => { if (++calls === 1) throw amapStatusError('10020'); return 'ok'; }, noDelay);
  assert.equal(value, 'ok'); assert.equal(calls, 2);
});
