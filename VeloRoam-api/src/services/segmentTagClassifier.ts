import { createHash } from 'node:crypto';
import { stableJson } from '../utils/stableJson';

/** Geometry measurements supplied to the classifier; unavailable measurements are null. */
export interface SegmentGeometryFeatures {
  representativeKey: string | null;
  trajectoryDistanceKm: number | null;
  lengthReliable: boolean;
  geometryReliable: boolean;
  endpointDistanceM: number | null;
  reverseOverlapRatio: number | null;
  outAndBackMatchRatio: number | null;
  issues: string[];
}

export const ALGORITHM_VERSION = 'segment-tags-v1.0.0';
export const SEGMENT_TAGS = ['climbing', 'loop', 'out_and_back', 'long_distance', 'popular', 'highly_starred'] as const;
export type SegmentTag = typeof SEGMENT_TAGS[number];
export type SegmentTagStatus = 'matched' | 'not_matched' | 'unknown';

export const SEGMENT_TAG_CONFIG = {
  climbing: { continuousMinKm: 0.5, continuousMinGrade: 3, continuousMinGainM: 30,
    cumulativeMinKm: 2, cumulativeMinGainM: 80, cumulativeMinGainPerKm: 20 },
  shape: { minKm: 1, closureMaxM: 150, closureFraction: 0.03, loopMaxReverseRatio: 0.3,
    returnMinReverseRatio: 0.7, returnMinMatchRatio: 0.8 },
  longDistance: { minKm: 10 },
  popularity: { minReferenceSize: 100, minAthletes: 50, athleteWeight: 0.7, effortWeight: 0.3, minScore: 80 },
  highStars: { minReferenceSize: 100, minStars: 10, minPercentile: 90 },
  reference: { activityType: 'Ride', geometryDeduplication: 'exact-directed-key', missingRegionPolicy: 'same-country-only' }
} as const;

export interface SegmentTagInput {
  id: string;
  name: string;
  activityType: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  averageGrade: number | null;
  elevationGainM: number | null;
  climbCategory: number | null;
  athleteCount: number | null;
  effortCount: number | null;
  starCount: number | null;
  sourceFetchedAt: string | null;
  isPrivate?: boolean | null;
  hazardous?: boolean | null;
  geometry: SegmentGeometryFeatures;
}

export interface SegmentTagEvaluation {
  tag: SegmentTag;
  status: SegmentTagStatus;
  reasonCodes: string[];
  evidence: Record<string, unknown>;
  referenceVersion: string | null;
}

export interface SegmentTagReferenceCohort {
  key: string;
  level: 'city' | 'state' | 'country';
  country: string;
  state: string | null;
  city: string | null;
  representativeIds: string[];
  athleteCounts: number[];
  effortCounts: number[];
  starCounts: number[];
}

export interface SegmentTagReferenceSnapshot {
  schemaVersion: 1;
  algorithmVersion: string;
  config: typeof SEGMENT_TAG_CONFIG;
  counts: {
    inputSegments: number;
    uniqueSegments: number;
    eligibleSegments: number;
    excludedUnknownActivity: number;
    excludedOtherActivity: number;
    excludedPrivate: number;
  };
  cohorts: SegmentTagReferenceCohort[];
}

export interface SegmentTagReferences { version: string; snapshot: SegmentTagReferenceSnapshot; }

type Tri = boolean | null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const nonnegative = (value: unknown): number | null => {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
};
const count = (value: unknown): number | null => {
  const number = nonnegative(value);
  return number !== null && Number.isSafeInteger(number) ? number : null;
};
const ratio = (value: unknown): number | null => {
  const number = nonnegative(value);
  return number !== null && number <= 1 ? number : null;
};
const and = (...conditions: Tri[]): Tri => conditions.includes(false) ? false : conditions.includes(null) ? null : true;
const or = (...conditions: Tri[]): Tri => conditions.includes(true) ? true : conditions.includes(null) ? null : false;
const atLeast = (value: number | null, threshold: number): Tri => value === null ? null : value >= threshold;
const atMost = (value: number | null, threshold: number): Tri => value === null ? null : value <= threshold;
const statusOf = (result: Tri): SegmentTagStatus => result === true ? 'matched' : result === false ? 'not_matched' : 'unknown';
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function normalizedRegion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() || null;
}

/** Canonicalize observed Strava location aliases without guessing missing geography. */
export function normalizeSegmentTagRegion(countryValue: string | null, stateValue: string | null, cityValue: string | null): { country: string | null; state: string | null; city: string | null } {
  let country = normalizedRegion(countryValue);
  let state = normalizedRegion(stateValue);
  let city = normalizedRegion(cityValue);
  if (country && ['china', 'prc', 'p.r.c.', "people's republic of china", '中华人民共和国', '中国'].includes(country)) country = 'china';
  if (country !== 'china') return { country, state, city };
  const compact = (value: string) => value.replace(/[\s._-]+/g, '');
  const aliases: Record<string, string> = {
    shanghai: 'shanghai', shanghaishi: 'shanghai', 上海: 'shanghai', 上海市: 'shanghai',
    beijing: 'beijing', beijingshi: 'beijing', 北京: 'beijing', 北京市: 'beijing',
    tianjin: 'tianjin', tianjinshi: 'tianjin', 天津: 'tianjin', 天津市: 'tianjin',
    chongqing: 'chongqing', chongqingshi: 'chongqing', 重庆: 'chongqing', 重庆市: 'chongqing',
    jiangsu: 'jiangsu', jiangsusheng: 'jiangsu', 江苏: 'jiangsu', 江苏省: 'jiangsu',
    zhejiang: 'zhejiang', zhejiangsheng: 'zhejiang', 浙江: 'zhejiang', 浙江省: 'zhejiang'
  };
  if (state) state = aliases[compact(state)] || state;
  const municipalities = new Set(['shanghai', 'beijing', 'tianjin', 'chongqing']);
  if (state && municipalities.has(state)) city = state;
  else if (city) city = aliases[compact(city)] || city;
  return { country, state, city };
}

function compareIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const a = BigInt(left); const b = BigInt(right);
    if (a !== b) return a < b ? -1 : 1;
  }
  return compareText(left, right);
}

function preferenceKey(input: SegmentTagInput): string {
  return JSON.stringify([input.activityType, input.country, input.state, input.city, input.athleteCount,
    input.effortCount, input.starCount, input.geometry.representativeKey]);
}

function compareRepresentatives(left: SegmentTagInput, right: SegmentTagInput): number {
  const parseDate = (value: string | null) => value === null ? NaN : Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(value) ? `${value.replace(' ', 'T')}Z` : value);
  const parsedLeft = parseDate(left.sourceFetchedAt);
  const parsedRight = parseDate(right.sourceFetchedAt);
  const leftTime = Number.isFinite(parsedLeft) ? parsedLeft : -Infinity;
  const rightTime = Number.isFinite(parsedRight) ? parsedRight : -Infinity;
  if (leftTime !== rightTime) return leftTime > rightTime ? -1 : 1;
  return compareIds(left.id, right.id) || compareText(preferenceKey(left), preferenceKey(right));
}

type Region = Pick<SegmentTagReferenceCohort, 'key' | 'level' | 'country' | 'state' | 'city'>;

function regionsFor(input: SegmentTagInput): Region[] {
  const { country, state, city } = normalizeSegmentTagRegion(input.country, input.state, input.city);
  if (!country) return [];
  const regions: Region[] = [];
  if (city) regions.push({ key: JSON.stringify(['city', country, state, city]), level: 'city', country, state, city });
  if (state) regions.push({ key: JSON.stringify(['state', country, state]), level: 'state', country, state, city: null });
  regions.push({ key: JSON.stringify(['country', country]), level: 'country', country, state: null, city: null });
  return regions;
}

/** A fixed snapshot makes all classifications in one batch use identical distributions. */
export function buildSegmentTagReferences(inputs: readonly SegmentTagInput[]): SegmentTagReferences {
  const unique = new Map<string, SegmentTagInput>();
  for (const input of inputs) {
    const previous = unique.get(input.id);
    if (!previous || compareRepresentatives(input, previous) < 0) unique.set(input.id, input);
  }
  const rows = [...unique.values()].sort((a, b) => compareIds(a.id, b.id));
  const eligible = rows.filter(row => row.activityType === 'Ride' && row.isPrivate !== true);
  const buckets = new Map<string, { region: Region; representatives: Map<string, SegmentTagInput> }>();
  for (const row of eligible) {
    for (const region of regionsFor(row)) {
      let bucket = buckets.get(region.key);
      if (!bucket) {
        bucket = { region, representatives: new Map() };
        buckets.set(region.key, bucket);
      }
      const geometryKey = row.geometry.representativeKey;
      const key = typeof geometryKey === 'string' && geometryKey ? `geometry:${geometryKey}` : `id:${row.id}`;
      const previous = bucket.representatives.get(key);
      if (!previous || compareRepresentatives(row, previous) < 0) bucket.representatives.set(key, row);
    }
  }
  const values = (rowsToRead: SegmentTagInput[], field: 'athleteCount' | 'effortCount' | 'starCount'): number[] =>
    rowsToRead.flatMap(row => { const value = count(row[field]); return value === null ? [] : [value]; }).sort((a, b) => a - b);
  const cohorts: SegmentTagReferenceCohort[] = [...buckets.values()].map(bucket => {
    const representatives = [...bucket.representatives.values()].sort((a, b) => compareIds(a.id, b.id));
    return { ...bucket.region, representativeIds: representatives.map(row => row.id),
      athleteCounts: values(representatives, 'athleteCount'), effortCounts: values(representatives, 'effortCount'),
      starCounts: values(representatives, 'starCount') };
  }).sort((a, b) => compareText(a.key, b.key));
  const snapshot: SegmentTagReferenceSnapshot = {
    schemaVersion: 1, algorithmVersion: ALGORITHM_VERSION, config: SEGMENT_TAG_CONFIG,
    counts: { inputSegments: inputs.length, uniqueSegments: rows.length, eligibleSegments: eligible.length,
      excludedUnknownActivity: rows.filter(row => !row.activityType).length,
      excludedOtherActivity: rows.filter(row => !!row.activityType && row.activityType !== 'Ride').length,
      excludedPrivate: rows.filter(row => row.activityType === 'Ride' && row.isPrivate === true).length },
    cohorts
  };
  return { version: createHash('sha256').update(stableJson(snapshot)).digest('hex'), snapshot };
}

function lowerBound(sorted: readonly number[], value: number, strict: boolean): number {
  let low = 0; let high = sorted.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sorted[middle] < value || (strict && sorted[middle] === value)) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Ties receive their midrank; a set of identical observations all scores 50. */
export function segmentTagPercentile(sorted: readonly number[], value: number): number | null {
  if (!sorted.length || !Number.isFinite(value)) return null;
  const below = lowerBound(sorted, value, false);
  const through = lowerBound(sorted, value, true);
  return 100 * (below + 0.5 * (through - below)) / sorted.length;
}

function selectCohort(input: SegmentTagInput, refs: SegmentTagReferences, purpose: 'popular' | 'highly_starred'): SegmentTagReferenceCohort | null {
  for (const region of regionsFor(input)) {
    const cohort = refs.snapshot.cohorts.find(candidate => candidate.key === region.key);
    if (!cohort) continue;
    if (purpose === 'popular'
      ? cohort.athleteCounts.length >= SEGMENT_TAG_CONFIG.popularity.minReferenceSize && cohort.effortCounts.length >= SEGMENT_TAG_CONFIG.popularity.minReferenceSize
      : cohort.starCounts.length >= SEGMENT_TAG_CONFIG.highStars.minReferenceSize) return cohort;
  }
  return null;
}

function cohortEvidence(cohort: SegmentTagReferenceCohort | null): Record<string, unknown> | null {
  return cohort ? { key: cohort.key, level: cohort.level, country: cohort.country, state: cohort.state, city: cohort.city,
    representativeCount: cohort.representativeIds.length, athleteCountSamples: cohort.athleteCounts.length,
    effortCountSamples: cohort.effortCounts.length, starCountSamples: cohort.starCounts.length } : null;
}

function evaluate(tag: SegmentTag, result: Tri, reasons: string[], evidence: Record<string, unknown>, referenceVersion: string | null = null): SegmentTagEvaluation {
  return { tag, status: statusOf(result), reasonCodes: reasons, evidence, referenceVersion };
}

/** Six independent, evidence-bearing decisions. Missing evidence never turns into a zero. */
export function classifySegmentTags(input: SegmentTagInput, refs: SegmentTagReferences): SegmentTagEvaluation[] {
  if (input.activityType && input.activityType !== 'Ride') return SEGMENT_TAGS.map(tag =>
    evaluate(tag, null, ['unsupported_activity_type'], { activityType: input.activityType }));

  const geometry = input.geometry;
  const rawLength = nonnegative(geometry.trajectoryDistanceKm);
  const length = geometry.lengthReliable && rawLength !== null && rawLength > 0 ? rawLength : null;
  const grade = finite(input.averageGrade);
  const gain = nonnegative(input.elevationGainM);
  const native = Number.isInteger(input.climbCategory) && input.climbCategory !== null
    && input.climbCategory >= 0 && input.climbCategory <= 5 ? input.climbCategory : null;
  const density = gain !== null && length !== null ? gain / length : null;
  const climbing = SEGMENT_TAG_CONFIG.climbing;
  const branches = {
    native: native === null ? null : native > 0,
    continuous: and(atLeast(length, climbing.continuousMinKm), atLeast(grade, climbing.continuousMinGrade), atLeast(gain, climbing.continuousMinGainM)),
    cumulative: and(atLeast(length, climbing.cumulativeMinKm), atLeast(gain, climbing.cumulativeMinGainM), atLeast(density, climbing.cumulativeMinGainPerKm))
  };
  const climbResult = or(branches.native, branches.continuous, branches.cumulative);
  const climbReasons = Object.entries(branches).filter(([, value]) => value === true).map(([key]) => `climbing_${key}`);
  const evaluations = [evaluate('climbing', climbResult, climbReasons.length ? climbReasons
    : [climbResult === null ? 'climbing_evidence_incomplete' : 'climbing_thresholds_not_met'], {
    distanceKm: length, averageGrade: grade, elevationGainM: gain, climbCategory: native, gainPerKm: density,
    branches, thresholds: climbing, geometryIssues: geometry.issues
  })];

  const shape = SEGMENT_TAG_CONFIG.shape;
  const closureThresholdM = length === null ? null : Math.min(shape.closureMaxM, shape.closureFraction * length * 1000);
  const endpointDistanceM = geometry.geometryReliable ? nonnegative(geometry.endpointDistanceM) : null;
  const reverse = geometry.geometryReliable ? ratio(geometry.reverseOverlapRatio) : null;
  const match = geometry.geometryReliable ? ratio(geometry.outAndBackMatchRatio) : null;
  const shapeCommon = and(atLeast(length, shape.minKm), geometry.geometryReliable ? true : null,
    closureThresholdM === null ? null : atMost(endpointDistanceM, closureThresholdM));
  const loop = and(shapeCommon, atMost(reverse, shape.loopMaxReverseRatio));
  const returning = and(shapeCommon, atLeast(reverse, shape.returnMinReverseRatio), atLeast(match, shape.returnMinMatchRatio));
  const shapeEvidence = { distanceKm: length, endpointDistanceM, closureThresholdM, reverseOverlapRatio: reverse,
    outAndBackMatchRatio: match, geometryReliable: geometry.geometryReliable, geometryIssues: geometry.issues, thresholds: shape };
  const shapeReasons = (result: Tri, positive: string): string[] => result === true ? [positive]
    : result === null ? ['shape_evidence_incomplete', ...geometry.issues]
      : length !== null && length < shape.minKm ? ['below_shape_minimum_distance']
        : endpointDistanceM !== null && closureThresholdM !== null && endpointDistanceM > closureThresholdM ? ['not_closed']
          : ['shape_thresholds_not_met'];
  evaluations.push(evaluate('loop', loop, shapeReasons(loop, 'closed_low_reverse_overlap'), shapeEvidence));
  evaluations.push(evaluate('out_and_back', returning, shapeReasons(returning, 'closed_ordered_reverse_traversal'), shapeEvidence));

  const distanceResult = atLeast(length, SEGMENT_TAG_CONFIG.longDistance.minKm);
  evaluations.push(evaluate('long_distance', distanceResult,
    [distanceResult === null ? 'reliable_length_unavailable' : distanceResult ? 'long_distance_threshold_met' : 'below_long_distance_threshold'],
    { distanceKm: length, rawTrajectoryDistanceKm: rawLength, geometryIssues: geometry.issues, thresholds: SEGMENT_TAG_CONFIG.longDistance,
      distanceBand: distanceResult === true && length !== null ? length >= 40 ? '40_plus' : length >= 20 ? '20_to_40' : '10_to_20' : null }));

  const athletes = count(input.athleteCount); const efforts = count(input.effortCount); const stars = count(input.starCount);
  const activityKnown = input.activityType === 'Ride';
  const popularCohort = activityKnown ? selectCohort(input, refs, 'popular') : null;
  const starCohort = activityKnown ? selectCohort(input, refs, 'highly_starred') : null;
  const athletePercentile = athletes !== null && popularCohort ? segmentTagPercentile(popularCohort.athleteCounts, athletes) : null;
  const effortPercentile = efforts !== null && popularCohort ? segmentTagPercentile(popularCohort.effortCounts, efforts) : null;
  const starPercentile = stars !== null && starCohort ? segmentTagPercentile(starCohort.starCounts, stars) : null;
  const popularity = SEGMENT_TAG_CONFIG.popularity;
  const score = athletePercentile !== null && effortPercentile !== null
    ? popularity.athleteWeight * athletePercentile + popularity.effortWeight * effortPercentile : null;
  const popularResult = activityKnown ? and(atLeast(athletes, popularity.minAthletes), atLeast(score, popularity.minScore)) : null;
  const socialReasons = (result: Tri, cohort: SegmentTagReferenceCohort | null, value: number | null, floor: number,
    incomplete: boolean, name: string): string[] => {
    if (!activityKnown) return ['activity_type_unknown'];
    if (result === true) return [`${name}_thresholds_met`];
    if (value !== null && value < floor) return [`below_${name}_absolute_minimum`];
    const reasons: string[] = [];
    if (incomplete) reasons.push(`${name}_metrics_missing`);
    if (!cohort) reasons.push(regionsFor(input).length ? 'regional_reference_insufficient' : 'country_unknown');
    return reasons.length ? reasons : [`${name}_relative_threshold_not_met`];
  };
  evaluations.push(evaluate('popular', popularResult, socialReasons(popularResult, popularCohort, athletes, popularity.minAthletes,
    athletes === null || efforts === null, 'popular'), {
    athleteCount: athletes, effortCount: efforts, athletePercentile, effortPercentile, score,
    reference: cohortEvidence(popularCohort), thresholds: popularity, activityType: input.activityType
  }, refs.version));
  const highStars = SEGMENT_TAG_CONFIG.highStars;
  const starredResult = activityKnown ? and(atLeast(stars, highStars.minStars), atLeast(starPercentile, highStars.minPercentile)) : null;
  evaluations.push(evaluate('highly_starred', starredResult, socialReasons(starredResult, starCohort, stars, highStars.minStars,
    stars === null, 'highly_starred'), {
    starCount: stars, starPercentile, reference: cohortEvidence(starCohort), thresholds: highStars, activityType: input.activityType
  }, refs.version));
  return evaluations;
}
