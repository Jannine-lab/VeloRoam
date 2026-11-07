import { createHash } from 'node:crypto';
import { analyzeSegmentGeometry } from './segmentTagGeometry';
import { SegmentTagInput, SegmentTagEvaluation, SEGMENT_TAGS } from './segmentTagClassifier';
import { stableJson } from '../utils/stableJson';

/** Values have already been selected with explicit aliases from a single database snapshot. */
export interface SegmentTagSourceRow {
  id: string; name: string; geo: unknown; srid: number | null;
  baseDistanceKm: unknown; baseGrade: unknown; baseClimbCategory: unknown;
  baseAthleteCount: unknown; baseEffortCount: unknown; baseStarCount: unknown;
  baseStatsAt: string | null; baseUpdatedAt: string | null;
  detailDistanceM: unknown; detailGrade: unknown; detailGainM: unknown; detailClimbCategory: unknown;
  detailAthleteCount: unknown; detailEffortCount: unknown; detailStarCount: unknown;
  activityType: string | null; country: string | null; state: string | null; city: string | null;
  isPrivate: unknown; hazardous: unknown; detailFetchedAt: string | null;
}

export interface NormalizedSegmentTagSource {
  input: SegmentTagInput;
  sourceFingerprint: string;
  sources: Record<string, string | null>;
}

export const fingerprint = (value: unknown): string => createHash('sha256').update(stableJson(value)).digest('hex');

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value !== 'number' && typeof value !== 'string')) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function nonnegative(value: unknown): number | null {
  const number = numberOrNull(value);
  return number !== null && number >= 0 ? number : null;
}
function count(value: unknown): number | null {
  const number = nonnegative(value);
  return number !== null && Number.isSafeInteger(number) ? number : null;
}
function bool(value: unknown): boolean | null {
  return value === true || value === 1 || value === '1' ? true : value === false || value === 0 || value === '0' ? false : null;
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Never interpret fabricated base-table grade/category defaults as known zero. */
export function normalizeSegmentTagSource(row: SegmentTagSourceRow): NormalizedSegmentTagSource {
  const sources: Record<string, string | null> = {};
  const choose = (key: string, detail: number | null, base: number | null): number | null => {
    if (detail !== null) { sources[key] = 'strava_segment_details'; return detail; }
    if (base !== null) { sources[key] = 'strava_segments'; return base; }
    sources[key] = null; return null;
  };
  const detailDistanceM = nonnegative(row.detailDistanceM);
  const baseDistance = nonnegative(row.baseDistanceKm);
  const recordedDistance = choose('recordedDistanceKm', detailDistanceM !== null && detailDistanceM > 0 ? detailDistanceM / 1000 : null,
    baseDistance !== null && baseDistance > 0 ? baseDistance : null);
  const detailGrade = numberOrNull(row.detailGrade);
  const baseGrade = numberOrNull(row.baseGrade);
  const grade = choose('averageGrade', detailGrade, baseGrade !== 0 ? baseGrade : null);
  const nativeDetail = nonnegative(row.detailClimbCategory);
  const nativeBase = nonnegative(row.baseClimbCategory);
  const native = choose('climbCategory', nativeDetail !== null && Number.isInteger(nativeDetail) && nativeDetail <= 5 ? nativeDetail : null,
    nativeBase !== null && Number.isInteger(nativeBase) && nativeBase > 0 && nativeBase <= 5 ? nativeBase : null);
  const gain = nonnegative(row.detailGainM);
  sources.elevationGainM = gain === null ? null : 'strava_segment_details';
  const athleteCount = choose('athleteCount', count(row.detailAthleteCount), count(row.baseAthleteCount));
  const effortCount = choose('effortCount', count(row.detailEffortCount), count(row.baseEffortCount));
  const starCount = choose('starCount', count(row.detailStarCount), count(row.baseStarCount));
  const srid = numberOrNull(row.srid);
  const geometry = analyzeSegmentGeometry(srid === 0 || srid === 4326 ? row.geo : null, recordedDistance);
  if (srid !== 0 && srid !== 4326) geometry.issues.push('unsupported_geometry_srid');
  const input: SegmentTagInput = {
    id: String(row.id), name: String(row.name || ''), activityType: text(row.activityType),
    country: text(row.country), state: text(row.state), city: text(row.city),
    averageGrade: grade, elevationGainM: gain, climbCategory: native,
    athleteCount, effortCount, starCount, sourceFetchedAt: text(row.detailFetchedAt),
    isPrivate: bool(row.isPrivate), hazardous: bool(row.hazardous), geometry
  };
  if (!/^[1-9]\d*$/.test(input.id)) throw new Error(`Invalid segment ID ${input.id}`);
  return { input, sourceFingerprint: fingerprint(row), sources };
}

export function sourceSnapshotFingerprint(rows: readonly SegmentTagSourceRow[]): string {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(`${row.id}:${fingerprint(row)}\n`);
  return hash.digest('hex');
}

export interface StoredTagEvaluation {
  segmentId: string; tag: string; status: string; reasonCodes: string[]; evidence: Record<string, unknown>;
  algorithmVersion: string; referenceVersion: string | null; sourceFingerprint: string;
  evaluationFingerprint: string; sourceFetchedAt: string | null;
}

export function prepareStoredEvaluation(source: NormalizedSegmentTagSource, evaluation: SegmentTagEvaluation, algorithmVersion: string): StoredTagEvaluation {
  const result = {
    segmentId: source.input.id, tag: evaluation.tag, status: evaluation.status,
    reasonCodes: evaluation.reasonCodes, evidence: { ...evaluation.evidence, sourceFields: source.sources },
    algorithmVersion, referenceVersion: evaluation.referenceVersion, sourceFingerprint: source.sourceFingerprint,
    sourceFetchedAt: source.input.sourceFetchedAt
  };
  return { ...result, evaluationFingerprint: fingerprint(result) };
}

export function summarizeEvaluations(rows: readonly StoredTagEvaluation[]): Record<string, unknown> {
  const counts: Record<string, Record<string, number>> = {};
  const samples: Record<string, Record<string, Array<{ id: string; reasons: string[] }>>> = {};
  for (const tag of SEGMENT_TAGS) {
    counts[tag] = { matched: 0, not_matched: 0, unknown: 0 };
    samples[tag] = { matched: [], not_matched: [], unknown: [] };
  }
  for (const row of rows) {
    if (!counts[row.tag] || !(row.status in counts[row.tag])) throw new Error('Invalid classification output');
    counts[row.tag][row.status]++;
    if (samples[row.tag][row.status].length < 5) samples[row.tag][row.status].push({ id: row.segmentId, reasons: row.reasonCodes });
  }
  return { counts, samples };
}
