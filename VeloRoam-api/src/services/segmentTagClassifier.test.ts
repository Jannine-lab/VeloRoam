import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildSegmentTagReferences, classifySegmentTags, normalizeSegmentTagRegion, SegmentTagInput, segmentTagPercentile } from './segmentTagClassifier';
import { fingerprint, firstJsonDifference, normalizeSegmentTagSource, prepareStoredEvaluation, SegmentTagSourceRow } from './segmentTagBackfill';

function input(id: string, overrides: Partial<SegmentTagInput> = {}): SegmentTagInput {
  return { id, name: id, activityType: 'Ride', country: 'China', state: 'Shanghai Shi', city: 'Pudong Xinqu',
    averageGrade: 0, elevationGainM: 0, climbCategory: 0, athleteCount: 0, effortCount: 0, starCount: 0,
    sourceFetchedAt: '2026-01-01 00:00:00',
    geometry: { trajectoryDistanceKm: 2, endpointDistanceM: 500, reverseOverlapRatio: null,
      outAndBackMatchRatio: null, geometryReliable: true, lengthReliable: true, issues: [], representativeKey: id }, ...overrides };
}
const status = (item: SegmentTagInput, refs = buildSegmentTagReferences([item])) =>
  Object.fromEntries(classifySegmentTags(item, refs).map(result => [result.tag, result.status]));

test('independent labels distinguish a climbing loop and an out-and-back', () => {
  const geometry = { ...input('1').geometry, trajectoryDistanceKm: 12, endpointDistanceM: 10, reverseOverlapRatio: 0.1 };
  const loop = input('1', { averageGrade: 4, elevationGainM: 200, geometry });
  assert.deepEqual(status(loop), { climbing: 'matched', loop: 'matched', out_and_back: 'not_matched',
    long_distance: 'matched', popular: 'not_matched', highly_starred: 'not_matched' });
  const returning = input('2', { geometry: { ...geometry, reverseOverlapRatio: 0.9, outAndBackMatchRatio: 0.9 } });
  assert.equal(status(returning).out_and_back, 'matched');
  assert.equal(status(returning).loop, 'not_matched');
  const mixed = input('3', { geometry: { ...geometry, reverseOverlapRatio: 0.5 } });
  assert.equal(status(mixed).loop, 'not_matched');
  assert.equal(status(mixed).out_and_back, 'not_matched');
});

test('unknown and known zeros have different semantics for climbing and geometry', () => {
  const missing = input('1', { averageGrade: null, elevationGainM: null, climbCategory: null,
    geometry: { ...input('1').geometry, lengthReliable: false, geometryReliable: false, issues: ['invalid_geometry'] } });
  assert.equal(status(missing).climbing, 'unknown');
  assert.equal(status(missing).loop, 'unknown');
  assert.equal(status(missing).long_distance, 'unknown');
  assert.equal(status(input('2')).climbing, 'not_matched');
  assert.equal(status({ ...missing, climbCategory: 2 }).climbing, 'matched');
  const open = input('3');
  assert.equal(status(open).loop, 'not_matched');
  assert.equal(status(open).out_and_back, 'not_matched');
});

test('midrank handles ties and known zero observations', () => {
  assert.equal(segmentTagPercentile([0, 0, 0, 0], 0), 50);
  assert.equal(segmentTagPercentile([0, 0, 1, 2], 1), 62.5);
  assert.equal(segmentTagPercentile([], 0), null);
});

test('database verification tolerates floating roundoff but rejects changed counts or values', () => {
  assert.equal(firstJsonDifference({ km: 1.0519159155881135 }, { km: 1.0519159155881137 }), null);
  assert.match(firstJsonDifference({ km: 1.0519 }, { km: 1.052 })!, /km/);
  assert.match(firstJsonDifference({ count: 1000000000000000 }, { count: 1000000000000001 })!, /count/);
  assert.match(firstJsonDifference({ items: [] }, { items: {} })!, /different JSON types/);
});

test('normalizes municipality aliases and independently classifies participation and stars', () => {
  assert.deepEqual(normalizeSegmentTagRegion('PRC', 'Shang Hai Shi', 'Pudong Xinqu'),
    { country: 'china', state: 'shanghai', city: 'shanghai' });
  const peers = Array.from({ length: 120 }, (_, i) => input(String(i + 1), {
    country: i % 2 ? 'PRC' : 'China', state: i % 2 ? 'Shanghai' : '上海市',
    athleteCount: i + 50, effortCount: (i + 50) * 2, starCount: i
  }));
  const starsOnly = input('121', { athleteCount: 20, effortCount: 5000, starCount: 500 });
  const popularOnly = input('122', { athleteCount: 5000, effortCount: 10000, starCount: 0 });
  const refs = buildSegmentTagReferences([...peers, starsOnly, popularOnly]);
  assert.equal(status(starsOnly, refs).popular, 'not_matched');
  assert.equal(status(starsOnly, refs).highly_starred, 'matched');
  assert.equal(status(popularOnly, refs).popular, 'matched');
  assert.equal(status(popularOnly, refs).highly_starred, 'not_matched');
  assert.equal(refs.snapshot.cohorts.find(c => c.level === 'city')?.representativeIds.length, 122);
});

test('references exclude private routes and deduplicate exact directed geometry', () => {
  const older = input('2', { geometry: { ...input('2').geometry, representativeKey: 'same' }, sourceFetchedAt: '2025-01-01 00:00:00' });
  const newer = input('1', { geometry: { ...input('1').geometry, representativeKey: 'same' }, sourceFetchedAt: '2026-01-01 00:00:00' });
  const privateItem = input('3', { isPrivate: true });
  const refs = buildSegmentTagReferences([older, newer, privateItem]);
  assert.deepEqual(refs.snapshot.cohorts.find(c => c.level === 'city')?.representativeIds, ['1']);
  assert.equal(refs.snapshot.counts.excludedPrivate, 1);
});

test('uses province reference when city sample is too small and does not mix countries', () => {
  const peers = Array.from({ length: 100 }, (_, i) => input(String(i + 1), {
    state: 'Jiang Su Sheng', city: i < 50 ? 'Suzhou' : 'Nanjing',
    athleteCount: 50 + i, effortCount: 100 + i, starCount: i
  }));
  const target = input('101', { state: 'Jiangsu', city: 'Suzhou', athleteCount: 999, effortCount: 999, starCount: 999 });
  const refs = buildSegmentTagReferences([...peers, target]);
  const popular = classifySegmentTags(target, refs).find(result => result.tag === 'popular')!;
  assert.equal(popular.status, 'matched');
  assert.equal((popular.evidence.reference as { level: string }).level, 'state');
  const foreign = input('102', { country: 'United States', state: 'California', city: 'Los Angeles',
    athleteCount: 999, effortCount: 999, starCount: 999 });
  assert.equal(status(foreign, refs).popular, 'unknown');
  assert.equal(status(foreign, refs).highly_starred, 'unknown');
});

test('missing social metrics never create a label from a single percentile', () => {
  const peers = Array.from({ length: 100 }, (_, i) => input(String(i + 1), {
    athleteCount: i + 100, effortCount: i + 1000, starCount: i
  }));
  const missingEfforts = input('101', { athleteCount: 10000, effortCount: null, starCount: null });
  const refs = buildSegmentTagReferences([...peers, missingEfforts]);
  assert.equal(status(missingEfforts, refs).popular, 'unknown');
  assert.equal(status(missingEfforts, refs).highly_starred, 'unknown');
  const unknownActivity = input('102', { activityType: null, athleteCount: 10000, effortCount: 10000, starCount: 10000 });
  assert.equal(status(unknownActivity, refs).popular, 'unknown');
});

test('normalization retains true detail zeros and does not invent base zero values', () => {
  const row: SegmentTagSourceRow = { id: '9007199254740993', name: 'test', geo: { type: 'LineString', coordinates: [[121,31], [121.01,31]] }, srid: 4326,
    baseDistanceKm: 1, baseGrade: 0, baseClimbCategory: 0, baseAthleteCount: null, baseEffortCount: null, baseStarCount: 0,
    baseStatsAt: null, baseUpdatedAt: null, detailDistanceM: null, detailGrade: null, detailGainM: null, detailClimbCategory: null,
    detailAthleteCount: null, detailEffortCount: null, detailStarCount: null, activityType: null, country: null, state: null, city: null,
    isPrivate: null, hazardous: null, detailFetchedAt: null };
  const missing = normalizeSegmentTagSource(row);
  assert.equal(missing.input.id, '9007199254740993');
  assert.equal(missing.input.averageGrade, null);
  assert.equal(missing.input.climbCategory, null);
  assert.equal(missing.input.starCount, 0);
  const known = normalizeSegmentTagSource({ ...row, detailGrade: 0, detailClimbCategory: 0, detailGainM: 0 });
  assert.equal(known.input.averageGrade, 0);
  assert.equal(known.input.climbCategory, 0);
  assert.equal(known.input.elevationGainM, 0);
  const evaluation = classifySegmentTags(known.input, buildSegmentTagReferences([known.input]))[0];
  const prepared = prepareStoredEvaluation(known, evaluation, 'test-v1');
  const { evaluationFingerprint, ...storedContent } = prepared;
  assert.equal(evaluationFingerprint, fingerprint(JSON.parse(JSON.stringify(storedContent))));
  assert.equal(fingerprint({ a: 1, b: { c: 2, d: 3 } }), fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
});
