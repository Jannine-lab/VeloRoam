(function (root) {
  'use strict';

  function createIdeaRecommendationCache(storage, distanceMeters) {
    const key = 'idea-distance-recommendations-v2';
    let cached = null;
    let pending = null;
    let requestVersion = 0;
    const valid = entry => entry && Number.isFinite(entry.location?.lat) && Number.isFinite(entry.location?.lng) &&
      ['gps', 'manual', 'ip'].includes(entry.location?.source) && Array.isArray(entry.data?.recommendations) &&
      entry.data.recommendations.some(item => item?.route && Number.isFinite(Number(item.route.distanceKm)) &&
        Number(item.route.distanceKm) >= 20 && Number(item.route.distanceKm) <= 80 && Array.isArray(item.route.legs));
    const matches = (left, right) => Boolean(left && right && left.source === right.source &&
      Number.isFinite(left.lat) && Number.isFinite(left.lng) && Number.isFinite(right.lat) && Number.isFinite(right.lng) &&
      distanceMeters(left.lat, left.lng, right.lat, right.lng) <= (left.source === 'manual' ? 20 : 200));
    try { const saved = JSON.parse(storage?.getItem(key) || 'null'); if (valid(saved)) cached = saved; } catch (_) { /* Storage is optional. */ }
    return {
      matches,
      async load(location, fetchData) {
        if (cached && matches(cached.location, location)) return cached;
        if (pending && matches(pending.location, location)) return pending.promise;
        const version = ++requestVersion;
        const promise = Promise.resolve().then(fetchData).then(data => {
          const entry = { location: { ...location }, data };
          if (valid(entry) && version === requestVersion) {
            cached = entry;
            try { storage?.setItem(key, JSON.stringify(entry)); } catch (_) { /* Keep the in-memory copy. */ }
          }
          return entry;
        }).finally(() => { if (pending?.promise === promise) pending = null; });
        pending = { location: { ...location }, promise };
        return promise;
      }
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createIdeaRecommendationCache };
  else root.createIdeaRecommendationCache = createIdeaRecommendationCache;
})(typeof globalThis !== 'undefined' ? globalThis : this);
