import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { analyzeSegmentGeometry, SEGMENT_TAG_GEOMETRY_CONFIG } from './segmentTagGeometry';

type XY = readonly [number, number];
const earth = 6371000;
const radians = Math.PI / 180;
const toCoordinate = ([x, y]: XY): [number, number] => [121 + x / (earth * Math.cos(31 * radians)) / radians, 31 + y / earth / radians];
const geometry = (points: XY[]) => ({ type: 'LineString', coordinates: points.map(toCoordinate) });
const circle = (radius = 500, count = 256, laps = 1): XY[] => Array.from({ length: count * laps + 1 }, (_, i) => {
  const angle = 2 * Math.PI * i / count;
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
});
const line = (start: XY, end: XY, count = 100): XY[] => Array.from({ length: count + 1 }, (_, i) => [
  start[0] + (end[0] - start[0]) * i / count,
  start[1] + (end[1] - start[1]) * i / count
]);

test('a circle is closed and has little reverse coverage', () => {
  const result = analyzeSegmentGeometry(geometry(circle()), Math.PI);
  assert.equal(result.geometryReliable, true);
  assert.equal(result.lengthReliable, true);
  assert.equal(result.closedCandidate, true);
  assert.ok(Math.abs(result.trajectoryDistanceKm! - Math.PI) < 0.01);
  assert.ok(result.reverseOverlapRatio! < 0.05);
  assert.equal(result.outAndBackMatchRatio, null);
  assert.equal(result.orderedMatchEvaluated, false);
});

test('an original-path out-and-back has high reverse and ordered coverage', () => {
  const outward = line([0, 0], [2000, 0]);
  const result = analyzeSegmentGeometry(geometry([...outward, ...outward.slice(0, -1).reverse()]), 4);
  assert.equal(result.geometryReliable, true);
  assert.ok(result.reverseOverlapRatio! > 0.9, JSON.stringify(result));
  assert.ok(result.outAndBackMatchRatio! > 0.95, JSON.stringify(result));
  assert.equal(result.orderedMatchEvaluated, true);
});

test('a short final sampling cell does not prevent an ordered out-and-back match', () => {
  const outward = line([0, 0], [2017, 400], 200);
  const result = analyzeSegmentGeometry(geometry([...outward, ...outward.slice(0, -1).reverse()]), null);
  assert.equal(result.geometryReliable, true);
  assert.ok(result.reverseOverlapRatio! > 0.9);
  assert.ok(result.outAndBackMatchRatio! > 0.95, JSON.stringify(result));
});

test('a reliable open line skips unneeded shape metrics without inventing zero values', () => {
  const result = analyzeSegmentGeometry(geometry(line([0, 0], [2000, 0])), 2);
  assert.equal(result.geometryReliable, true);
  assert.equal(result.closedCandidate, false);
  assert.equal(result.reverseOverlapRatio, null);
  assert.equal(result.outAndBackMatchRatio, null);
  assert.equal(result.sampleCount, 0);
});

test('same-direction repeated laps preserve their full length without becoming an out-and-back', () => {
  const one = analyzeSegmentGeometry(geometry(circle()), null);
  const two = analyzeSegmentGeometry(geometry(circle(500, 256, 2)), null);
  assert.equal(two.geometryReliable, true);
  assert.ok(Math.abs(two.trajectoryDistanceKm! / one.trajectoryDistanceKm! - 2) < 1e-8);
  assert.ok(two.reverseOverlapRatio! < 0.05);
});

test('a figure-eight crossing does not turn the whole geometry into reverse coverage', () => {
  const points: XY[] = Array.from({ length: 513 }, (_, i) => {
    const angle = 2 * Math.PI * i / 512;
    return [600 * Math.sin(angle), 300 * Math.sin(2 * angle)];
  });
  const result = analyzeSegmentGeometry(geometry(points), null);
  assert.equal(result.geometryReliable, true);
  assert.ok(result.reverseOverlapRatio! < 0.15, JSON.stringify(result));
});

test('a substantial shared stem plus circuit produces mixed shape coverage', () => {
  const stem = line([0, 0], [1500, 0]);
  const circuit: XY[] = Array.from({ length: 257 }, (_, i) => {
    const angle = Math.PI + 2 * Math.PI * i / 256;
    return [2000 + 500 * Math.cos(angle), 500 * Math.sin(angle)];
  });
  const result = analyzeSegmentGeometry(geometry([...stem, ...circuit.slice(1), ...stem.slice(0, -1).reverse()]), null);
  assert.equal(result.geometryReliable, true);
  assert.ok(result.reverseOverlapRatio! > 0.3 && result.reverseOverlapRatio! < 0.7, JSON.stringify(result));
});

test('near parallel opposite roads remain uncertain instead of being confidently collapsed', () => {
  const points = [
    ...line([0, 0], [2000, 0]),
    ...line([2000, 0], [2000, 12], 4).slice(1),
    ...line([2000, 12], [0, 12]).slice(1),
    ...line([0, 12], [0, 0], 4).slice(1)
  ];
  const result = analyzeSegmentGeometry(geometry(points), null);
  assert.equal(result.lengthReliable, true);
  assert.equal(result.geometryReliable, false);
  assert.ok(result.issues.includes('parallel_road_ambiguity'));
});

test('short repeated shuttles with a cancelling heading window are uncertain, not circular', () => {
  const points: XY[] = Array.from({ length: 81 }, (_, i) => [i % 2 ? 25 : 0, 0]);
  const result = analyzeSegmentGeometry(geometry(points), null);
  assert.equal(result.lengthReliable, true);
  assert.equal(result.geometryReliable, false);
  assert.equal(result.reverseOverlapRatio, null);
  assert.ok(result.issues.includes('ambiguous_heading'));
});

test('malformed vertices are rejected rather than dropped or joined across', () => {
  for (const raw of [
    { type: 'LineString', coordinates: [[121, 31], null, [121.01, 31]] },
    { type: 'LineString', coordinates: [[121, 31], [121.01, NaN], [121.02, 31]] },
    { type: 'LineString', coordinates: [[121, 31], [121.01, , 3], [121.02, 31]] },
    { type: 'LineString', coordinates: [[121, 31], ['121.01', 31]] },
    { type: 'LineString', coordinates: [[121, 31], [181, 31]] },
    'LINESTRING(121 31, garbage, 121.01 31)',
    'SRID=3857;LINESTRING(121 31,121.01 31)',
    { type: 'MultiLineString', coordinates: [[[121, 31], [121.01, 31]]] }
  ]) {
    const result = analyzeSegmentGeometry(raw, null);
    assert.equal(result.lengthReliable, false, JSON.stringify(raw));
    assert.equal(result.trajectoryDistanceKm, null, JSON.stringify(raw));
    assert.equal(result.geometryFingerprint, null);
  }
});

test('GeoJSON, JSON text and WKT agree; fingerprint preserves travel direction and removes only consecutive duplicates', () => {
  const shape = geometry(circle());
  const object = analyzeSegmentGeometry(shape, null);
  const text = analyzeSegmentGeometry(JSON.stringify(shape), null);
  const wkt = analyzeSegmentGeometry(`LINESTRING(${shape.coordinates.map(point => point.join(' ')).join(',')})`, null);
  const duplicated = analyzeSegmentGeometry({ ...shape, coordinates: [shape.coordinates[0], ...shape.coordinates] }, null);
  const reversed = analyzeSegmentGeometry({ ...shape, coordinates: [...shape.coordinates].reverse() }, null);
  assert.equal(text.geometryFingerprint, object.geometryFingerprint);
  assert.equal(wkt.geometryFingerprint, object.geometryFingerprint);
  assert.equal(duplicated.geometryFingerprint, object.geometryFingerprint);
  assert.notEqual(reversed.geometryFingerprint, object.geometryFingerprint);
  assert.equal(object.representativeKey, object.geometryFingerprint);
});

test('distance disagreement makes dependent length and shape uncertain', () => {
  const result = analyzeSegmentGeometry(geometry(circle()), 1);
  assert.equal(result.lengthReliable, false);
  assert.equal(result.geometryReliable, false);
  assert.ok(result.trajectoryDistanceKm! > 3);
  assert.ok(result.issues.includes('recorded_distance_mismatch'));
});

test('sparse shape retains a computable traversal length', () => {
  const result = analyzeSegmentGeometry(geometry([[0, 0], [5000, 0], [0, 0]]), 10);
  assert.equal(result.lengthReliable, true);
  assert.equal(result.geometryReliable, false);
  assert.ok(result.issues.includes('sparse_geometry'));
  assert.ok(Math.abs(result.trajectoryDistanceKm! - 10) < 0.01);
});

test('resource limits preserve length but expose unknown shape', () => {
  const result = analyzeSegmentGeometry(geometry(circle(10000, 1024, 5)), null);
  assert.ok(result.trajectoryDistanceKm! * 1000 / SEGMENT_TAG_GEOMETRY_CONFIG.sampleSpacingM > SEGMENT_TAG_GEOMETRY_CONFIG.maximumShapeSamples);
  assert.equal(result.lengthReliable, true);
  assert.equal(result.geometryReliable, false);
  assert.equal(result.reverseOverlapRatio, null);
  assert.ok(result.issues.includes('shape_sample_limit'));
});
