import assert from 'node:assert/strict';
import { StravaRateBudget } from './stravaRateBudget';

let now = Date.parse('2026-11-03T05:01:00Z');
const budget = new StravaRateBudget(() => now);
budget.observe({ 'x-readratelimit-limit': '100,1000', 'x-readratelimit-usage': '89,50' }, 200);
assert.equal(budget.nextAllowedAt(), now);
budget.observe({ 'x-readratelimit-limit': '100,1000', 'x-readratelimit-usage': '90,50' }, 200);
assert.equal(budget.nextAllowedAt(), Date.parse('2026-11-03T05:15:03Z'));
now = Date.parse('2026-11-03T05:15:04Z');
assert.equal(budget.nextAllowedAt(), now);
budget.observe({ 'x-readratelimit-limit': '100,1000', 'x-readratelimit-usage': '1,980' }, 200);
assert.equal(budget.nextAllowedAt(), Date.parse('2026-11-04T00:00:03Z'));

const shared = new StravaRateBudget(() => now);
shared.observe({ 'x-readratelimit-limit': '100,1000', 'x-readratelimit-usage': '5,10',
  'x-ratelimit-limit': '200,2000', 'x-ratelimit-usage': '180,20' }, 200);
assert.equal(shared.nextAllowedAt(), Date.parse('2026-11-03T05:30:03Z'));

const retry = new StravaRateBudget(() => now);
retry.observe({ 'retry-after': '120' }, 429);
assert.equal(retry.nextAllowedAt(), now + 123000);
console.log('Strava request budget checks passed.');
