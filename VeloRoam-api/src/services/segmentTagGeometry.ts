import { createHash } from 'node:crypto';

/** Versioned deterministic geometry settings. Distances are metres unless named otherwise. */
export const SEGMENT_TAG_GEOMETRY_CONFIG = Object.freeze({
  version: 'geometry-v1',
  sampleSpacingM: 25,
  coverageSpacingM: 5,
  headingWindowM: 50,
  matchToleranceM: 20,
  nonAdjacentDistanceM: 100,
  oppositeAngleDegrees: 150,
  maximumEdgeM: 500,
  maximumSourcePoints: 200000,
  maximumShapeSamples: 12000,
  maximumSpatialComparisons: 2000000,
  maximumOrderedMatches: 1000000,
  maximumDistanceDiscrepancy: 0.2
});

export interface SegmentGeometryFeatures {
  trajectoryDistanceKm: number | null;
  endpointDistanceM: number | null;
  reverseOverlapRatio: number | null;
  outAndBackMatchRatio: number | null;
  geometryReliable: boolean;
  lengthReliable: boolean;
  issues: string[];
  pointCount: number;
  geometryFingerprint: string | null;
  /** Exact same ordered coordinates only. No fuzzy/topological equivalence is asserted. */
  representativeKey: string | null;
  sampleCount: number;
  maxEdgeM: number | null;
  distanceDiscrepancyRatio: number | null;
  closedCandidate: boolean;
  orderedMatchEvaluated: boolean;
}

type Coordinate = readonly [number, number];
interface XY { x: number; y: number; }
interface Vertex extends XY { distance: number; }
interface Sample extends XY { distance: number; weight: number; dx: number; dy: number; }
const EARTH_RADIUS_M = 6371000;
const RADIANS = Math.PI / 180;
const OPPOSITE_DOT = Math.cos(SEGMENT_TAG_GEOMETRY_CONFIG.oppositeAngleDegrees * RADIANS);

function emptyFeatures(issue: string): SegmentGeometryFeatures {
  return {
    trajectoryDistanceKm: null, endpointDistanceM: null, reverseOverlapRatio: null,
    outAndBackMatchRatio: null, geometryReliable: false, lengthReliable: false,
    issues: [issue], pointCount: 0, geometryFingerprint: null, representativeKey: null,
    sampleCount: 0, maxEdgeM: null, distanceDiscrepancyRatio: null,
    closedCandidate: false, orderedMatchEvaluated: false
  };
}

function parseGeometry(raw: unknown): Coordinate[] {
  let value = raw;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) throw new Error('missing_geometry');
    if (text.startsWith('{')) {
      try { value = JSON.parse(text); } catch { throw new Error('invalid_geojson'); }
    } else {
      // ST_AsText and standard two-dimensional WKT; optional WGS-84 EWKT prefix.
      const wkt = text.match(/^(?:SRID=4326;\s*)?LINESTRING\s*\(([^()]+)\)$/i);
      if (!wkt) throw new Error('invalid_wkt');
      const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
      const coordinates = wkt[1].split(',').map(pair => {
        const numbers = pair.trim().split(/\s+/);
        if (numbers.length !== 2 || !numbers.every(number => numeric.test(number))) throw new Error('invalid_coordinate');
        return numbers.map(Number);
      });
      value = { type: 'LineString', coordinates };
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('missing_geometry');
  const geometry = value as { type?: unknown; coordinates?: unknown };
  if (geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates)) throw new Error('unsupported_geometry');
  if (geometry.coordinates.length > SEGMENT_TAG_GEOMETRY_CONFIG.maximumSourcePoints) throw new Error('source_point_limit');
  if (geometry.coordinates.length < 2) throw new Error('insufficient_coordinates');
  const result: Coordinate[] = [];
  for (const coordinate of geometry.coordinates) {
    if (!Array.isArray(coordinate) || coordinate.length < 2 || coordinate.length > 3 ||
      !Array.from(coordinate).every(number => typeof number === 'number' && Number.isFinite(number)) ||
      Math.abs(coordinate[0]) > 180 || Math.abs(coordinate[1]) > 90) throw new Error('invalid_coordinate');
    const previous = result[result.length - 1];
    if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) result.push([coordinate[0], coordinate[1]]);
  }
  if (result.length < 2) throw new Error('zero_length_geometry');
  return result;
}

function haversine(a: Coordinate, b: Coordinate): number {
  const deltaLatitude = (b[1] - a[1]) * RADIANS;
  const deltaLongitude = (b[0] - a[0]) * RADIANS;
  const squaredSine = Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(a[1] * RADIANS) * Math.cos(b[1] * RADIANS) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, Math.max(0, squaredSine))));
}

function atDistance(vertices: Vertex[], distance: number): XY {
  if (distance <= 0) return vertices[0];
  const last = vertices[vertices.length - 1];
  if (distance >= last.distance) return last;
  let low = 1;
  let high = vertices.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (vertices[middle].distance < distance) low = middle + 1;
    else high = middle;
  }
  const a = vertices[low - 1];
  const b = vertices[low];
  const fraction = (distance - a.distance) / (b.distance - a.distance);
  return { x: a.x + fraction * (b.x - a.x), y: a.y + fraction * (b.y - a.y) };
}

/** Sample locations follow the original piecewise geometry, never chords between resampled corners. */
function sampleGeometry(vertices: Vertex[], spacing: number, closed: boolean): Sample[] {
  const length = vertices[vertices.length - 1].distance;
  const result: Sample[] = [];
  const pointAt = (distance: number) => atDistance(vertices, closed ? ((distance % length) + length) % length : distance);
  for (let start = 0; start < length; start += spacing) {
    const weight = Math.min(spacing, length - start);
    const distance = start + weight / 2;
    const point = atDistance(vertices, distance);
    const before = pointAt(distance - SEGMENT_TAG_GEOMETRY_CONFIG.headingWindowM / 2);
    const after = pointAt(distance + SEGMENT_TAG_GEOMETRY_CONFIG.headingWindowM / 2);
    const norm = Math.hypot(after.x - before.x, after.y - before.y);
    result.push({ ...point, distance, weight,
      dx: norm > 1e-6 ? (after.x - before.x) / norm : 0,
      dy: norm > 1e-6 ? (after.y - before.y) / norm : 0 });
  }
  return result;
}

function gridKey(x: number, y: number): string { return `${x},${y}`; }

function spatialGrid(samples: Sample[]): Map<string, number[]> {
  const grid = new Map<string, number[]>();
  for (let i = 0; i < samples.length; i++) {
    const key = gridKey(Math.floor(samples[i].x / 20), Math.floor(samples[i].y / 20));
    const indices = grid.get(key);
    if (indices) indices.push(i);
    else grid.set(key, [i]);
  }
  return grid;
}

function reverseCoverage(samples: Sample[], length: number): { ratio: number; ambiguous: boolean; headingReliable: boolean } | null {
  const grid = spatialGrid(samples);
  let comparisons = 0;
  let matchedLength = 0;
  let parallelOffsetLength = 0;
  let directionalLength = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (sample.dx === 0 && sample.dy === 0) continue;
    directionalLength += sample.weight;
    const cellX = Math.floor(sample.x / 20);
    const cellY = Math.floor(sample.y / 20);
    let closestSquared = Infinity;
    let perpendicular = 0;
    for (let x = cellX - 1; x <= cellX + 1; x++) for (let y = cellY - 1; y <= cellY + 1; y++) {
      for (const j of grid.get(gridKey(x, y)) || []) {
        if (++comparisons > SEGMENT_TAG_GEOMETRY_CONFIG.maximumSpatialComparisons) return null;
        const candidate = samples[j];
        const arcDistance = Math.abs(candidate.distance - sample.distance);
        if (Math.min(arcDistance, length - arcDistance) < SEGMENT_TAG_GEOMETRY_CONFIG.nonAdjacentDistanceM) continue;
        if (sample.dx * candidate.dx + sample.dy * candidate.dy > OPPOSITE_DOT) continue;
        const deltaX = candidate.x - sample.x;
        const deltaY = candidate.y - sample.y;
        const squared = deltaX ** 2 + deltaY ** 2;
        if (squared <= SEGMENT_TAG_GEOMETRY_CONFIG.matchToleranceM ** 2 && squared < closestSquared) {
          closestSquared = squared;
          perpendicular = Math.abs(deltaX * sample.dy - deltaY * sample.dx);
        }
      }
    }
    if (closestSquared !== Infinity) {
      matchedLength += sample.weight;
      if (perpendicular > 8) parallelOffsetLength += sample.weight;
    }
  }
  // Sustained offsets of 8–20 m may represent separate parallel roads rather than retracing.
  return { ratio: matchedLength / length, ambiguous: parallelOffsetLength / length >= 0.3,
    headingReliable: directionalLength / length >= 0.8 };
}

class MaximumFenwickTree {
  private readonly values: Float64Array;
  constructor(size: number) { this.values = new Float64Array(size + 1); }
  query(index: number): number {
    let result = 0;
    for (let i = index; i > 0; i -= i & -i) result = Math.max(result, this.values[i]);
    return result;
  }
  update(index: number, value: number): void {
    for (let i = index; i < this.values.length; i += i & -i) this.values[i] = Math.max(this.values[i], value);
  }
}

/**
 * Sparse weighted LCS against the reversed whole sequence. Querying prefix (k, n-k)
 * gives the best ordered pairing for that split, so every sampled split is checked
 * in one sweep rather than running a separate quadratic DP for every turnaround.
 */
function orderedReverseMatch(samples: Sample[], length: number): number | null {
  const grid = spatialGrid(samples);
  const tree = new MaximumFenwickTree(samples.length);
  let comparisons = 0;
  let matches = 0;
  let prefixLength = 0;
  let best = 0;
  for (let i = 0; i < samples.length && prefixLength <= length * 0.65; i++) {
    const sample = samples[i];
    const cellX = Math.floor(sample.x / 20);
    const cellY = Math.floor(sample.y / 20);
    const updates: Array<[number, number]> = [];
    for (let x = cellX - 1; x <= cellX + 1; x++) for (let y = cellY - 1; y <= cellY + 1; y++) {
      for (const j of grid.get(gridKey(x, y)) || []) {
        if (++comparisons > SEGMENT_TAG_GEOMETRY_CONFIG.maximumSpatialComparisons) return null;
        const candidate = samples[j];
        if ((candidate.x - sample.x) ** 2 + (candidate.y - sample.y) ** 2 > SEGMENT_TAG_GEOMETRY_CONFIG.matchToleranceM ** 2) continue;
        if (++matches > SEGMENT_TAG_GEOMETRY_CONFIG.maximumOrderedMatches) return null;
        const reverseIndex = samples.length - j;
        updates.push([reverseIndex, tree.query(reverseIndex - 1) + Math.min(sample.weight, candidate.weight)]);
      }
    }
    // Apply after evaluating the row to prevent one original sample matching multiple times.
    for (const [index, value] of updates) tree.update(index, value);
    prefixLength += sample.weight;
    if (prefixLength < length * 0.35 || prefixLength > length * 0.65) continue;
    const matchedLength = tree.query(samples.length - i - 1);
    const coverage = matchedLength / Math.max(prefixLength, length - prefixLength);
    best = Math.max(best, coverage);
  }
  return Math.min(1, best);
}

/** Analyze a single complete route geometry; never repairs or silently drops invalid vertices. */
export function analyzeSegmentGeometry(raw: unknown, recordedDistanceKm: number | null): SegmentGeometryFeatures {
  let coordinates: Coordinate[];
  try { coordinates = parseGeometry(raw); }
  catch (error) { return emptyFeatures(error instanceof Error ? error.message : 'invalid_geometry'); }
  const fingerprint = createHash('sha256').update(JSON.stringify(coordinates)).digest('hex');
  const result: SegmentGeometryFeatures = { ...emptyFeatures(''), issues: [], pointCount: coordinates.length,
    geometryFingerprint: fingerprint, representativeKey: fingerprint };
  const cumulative = [0];
  let maxEdge = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const distance = haversine(coordinates[i - 1], coordinates[i]);
    cumulative.push(cumulative[i - 1] + distance);
    maxEdge = Math.max(maxEdge, distance);
  }
  const length = cumulative[cumulative.length - 1];
  if (!(length > 0) || !Number.isFinite(length)) return { ...result, issues: ['zero_length_geometry'] };
  result.trajectoryDistanceKm = length / 1000;
  result.endpointDistanceM = haversine(coordinates[0], coordinates[coordinates.length - 1]);
  result.maxEdgeM = maxEdge;
  result.lengthReliable = true;
  result.geometryReliable = true;
  result.closedCandidate = result.endpointDistanceM <= Math.min(150, length * 0.03);
  if (recordedDistanceKm !== null && Number.isFinite(recordedDistanceKm) && recordedDistanceKm > 0) {
    result.distanceDiscrepancyRatio = Math.abs(result.trajectoryDistanceKm - recordedDistanceKm) / recordedDistanceKm;
    if (result.distanceDiscrepancyRatio > SEGMENT_TAG_GEOMETRY_CONFIG.maximumDistanceDiscrepancy) {
      result.lengthReliable = false;
      result.geometryReliable = false;
      result.issues.push('recorded_distance_mismatch');
    }
  }
  if (maxEdge > SEGMENT_TAG_GEOMETRY_CONFIG.maximumEdgeM) {
    result.geometryReliable = false;
    result.issues.push('sparse_geometry');
  }
  if (coordinates.length < 3) {
    result.geometryReliable = false;
    result.issues.push('insufficient_shape_points');
  }
  // Open and short paths can be rejected by the classifier without inventing uncomputed R/M.
  if (!result.geometryReliable || length < 1000 || !result.closedCandidate) return result;
  if (Math.ceil(length / SEGMENT_TAG_GEOMETRY_CONFIG.sampleSpacingM) > SEGMENT_TAG_GEOMETRY_CONFIG.maximumShapeSamples) {
    result.geometryReliable = false;
    result.issues.push('shape_sample_limit');
    return result;
  }
  const meanLatitude = coordinates.reduce((sum, coordinate) => sum + coordinate[1], 0) / coordinates.length;
  const longitudeOrigin = coordinates[0][0];
  const latitudeOrigin = coordinates[0][1];
  const cosine = Math.cos(meanLatitude * RADIANS);
  if (Math.abs(meanLatitude) > 80 || coordinates.some(coordinate => Math.abs(coordinate[0] - longitudeOrigin) > 3 || Math.abs(coordinate[1] - latitudeOrigin) > 3)) {
    result.geometryReliable = false;
    result.issues.push('projection_extent_limit');
    return result;
  }
  const vertices: Vertex[] = coordinates.map((coordinate, index) => ({
    x: (coordinate[0] - longitudeOrigin) * RADIANS * EARTH_RADIUS_M * cosine,
    y: (coordinate[1] - latitudeOrigin) * RADIANS * EARTH_RADIUS_M,
    distance: cumulative[index]
  }));
  const coverageSamples = sampleGeometry(vertices, SEGMENT_TAG_GEOMETRY_CONFIG.coverageSpacingM, true);
  const coverage = reverseCoverage(coverageSamples, length);
  result.sampleCount = Math.ceil(length / SEGMENT_TAG_GEOMETRY_CONFIG.sampleSpacingM);
  if (coverage === null) {
    result.geometryReliable = false;
    result.issues.push('reverse_match_resource_limit');
    return result;
  }
  result.reverseOverlapRatio = coverage.ratio;
  if (!coverage.headingReliable) {
    result.geometryReliable = false;
    result.reverseOverlapRatio = null;
    result.issues.push('ambiguous_heading');
    return result;
  }
  if (coverage.ambiguous) {
    result.geometryReliable = false;
    result.issues.push('parallel_road_ambiguity');
    return result;
  }
  if (coverage.ratio >= 0.7) {
    const samples = sampleGeometry(vertices, SEGMENT_TAG_GEOMETRY_CONFIG.sampleSpacingM, true);
    result.outAndBackMatchRatio = orderedReverseMatch(samples, length);
    result.orderedMatchEvaluated = true;
    if (result.outAndBackMatchRatio === null) {
      result.geometryReliable = false;
      result.issues.push('ordered_match_resource_limit');
    }
  }
  return result;
}
