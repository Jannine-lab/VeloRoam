import assert from 'node:assert/strict';
import { getSegmentDisplayScore, getSegmentVisibleFromZoom, isCompactRepeatedSegment } from './segmentVisibility';

assert.equal(getSegmentDisplayScore({ stravaScore: 0, rawScore: 99 }), 0);
assert.equal(getSegmentDisplayScore({ stravaScore: null, rawScore: 42 }), 42);
assert.equal(getSegmentDisplayScore({ stravaScore: NaN, rawScore: 42 }), 42);
assert.equal(getSegmentDisplayScore({ stravaScore: null, rawScore: null }), null);

const red = { stravaScore: 120, rawScore: 8 };
assert.equal(getSegmentVisibleFromZoom({ ...red, starCount: 5, effortCount: null }), 10);
assert.equal(getSegmentVisibleFromZoom({ ...red, starCount: 0, effortCount: 10 }), 10);
assert.equal(getSegmentVisibleFromZoom({ ...red, starCount: 4, effortCount: 9 }), 11);
assert.equal(getSegmentVisibleFromZoom({ ...red, starCount: null, effortCount: null }), 11);
assert.equal(getSegmentVisibleFromZoom({ ...red, starCount: null, effortCount: 10 }), 10);
assert.equal(getSegmentVisibleFromZoom({ rawScore: 99.99 }), 11);
assert.equal(getSegmentVisibleFromZoom({ rawScore: 80 }), 11);
assert.equal(getSegmentVisibleFromZoom({ rawScore: 79.99 }), 12);
assert.equal(getSegmentVisibleFromZoom({ rawScore: 100, starCount: 5 }), 10);
assert.equal(getSegmentVisibleFromZoom({ rawScore: 30 }), 12);
assert.equal(getSegmentVisibleFromZoom({ rawScore: 29.99 }), 13);
assert.equal(getSegmentVisibleFromZoom({ rawScore: 0 }), 13);

const smallArea = [{ lat: 31.2, lng: 121.4 }, { lat: 31.201, lng: 121.401 }, { lat: 31.2, lng: 121.4 }];
assert.equal(isCompactRepeatedSegment({ distanceKm: 1, coordinates: smallArea }), true);
assert.equal(getSegmentVisibleFromZoom({ ...red, starCount: 6, distanceKm: 1, coordinates: smallArea }), 11);
assert.equal(getSegmentVisibleFromZoom({ stravaScore: 80, distanceKm: 1, coordinates: smallArea }), 11);
assert.equal(isCompactRepeatedSegment({ distanceKm: 0.5, coordinates: smallArea }), false);
assert.equal(isCompactRepeatedSegment({ distanceKm: 1, coordinates: [{ lat: 31.2, lng: 121.4 }, { lat: 31.2, lng: 121.42 }] }), false);
assert.equal(isCompactRepeatedSegment({ distanceKm: 2, coordinates: [{ lat: 91, lng: 121.4 }, { lat: 31.2, lng: 121.4 }] }), false);
console.log('Segment visibility checks passed.');
