const { strict: assert } = require('node:assert');
const { test } = require('node:test');
const { createIdeaRecommendationCache } = require('./idea-recommendation-cache.js');

const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
};
const distance = (lat1, lng1, lat2, lng2) => Math.hypot(lat2 - lat1, lng2 - lng1) * 100000;
const location = { lat: 31, lng: 121, source: 'gps' };
const data = { recommendations: [{ route: { distanceKm: 30, legs: [] } }] };

test('reuses successful results across recreated caches and small GPS changes', async () => {
  const store = storage();
  let calls = 0;
  const fetch = async () => { calls++; return data; };
  const first = createIdeaRecommendationCache(store, distance);
  const result = await first.load(location, fetch);
  assert.deepEqual(result.data, data);
  const next = createIdeaRecommendationCache(store, distance);
  const reused = await next.load({ ...location, lat: 31.001 }, fetch);
  assert.equal(calls, 1);
  assert.deepEqual(reused.location, location);
  await next.load({ ...location, lat: 31.003 }, fetch);
  await next.load({ ...location, source: 'manual' }, fetch);
  assert.equal(calls, 3);
});

test('shares in-flight work and retries failures or empty recommendations', async () => {
  const cache = createIdeaRecommendationCache(storage(), distance);
  let calls = 0;
  const fetch = async () => { calls++; return data; };
  await Promise.all([cache.load(location, fetch), cache.load(location, fetch)]);
  assert.equal(calls, 1);
  const retryCache = createIdeaRecommendationCache(storage(), distance);
  await assert.rejects(retryCache.load(location, async () => { throw new Error('offline'); }));
  await retryCache.load(location, async () => ({ recommendations: [] }));
  await retryCache.load(location, fetch);
  assert.equal(calls, 2);
});

test('does not replace a newer location with a slower old response', async () => {
  const cache = createIdeaRecommendationCache(storage(), distance);
  let finishOld;
  const old = cache.load(location, () => new Promise(resolve => { finishOld = resolve; }));
  await Promise.resolve();
  const newer = { ...location, lat: 32 };
  await cache.load(newer, async () => data);
  finishOld(data);
  await old;
  let calls = 0;
  await cache.load(newer, async () => { calls++; return data; });
  assert.equal(calls, 0);
});

test('caches recommendations above 50 km within the new range', async () => {
  const store = storage();
  const route = { recommendations: [{ route: { distanceKm: 80, legs: [] } }] };
  await createIdeaRecommendationCache(store, distance).load(location, async () => route);
  let calls = 0;
  const cached = await createIdeaRecommendationCache(store, distance).load(location, async () => { calls++; return data; });
  assert.deepEqual(cached.data, route);
  assert.equal(calls, 0);
});
