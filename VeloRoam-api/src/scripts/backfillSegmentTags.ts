/** Preview or atomically persist the six evidence-bearing segment classifications. */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { pool } from '../config/db';
import { ALGORITHM_VERSION, SEGMENT_TAGS, buildSegmentTagReferences, classifySegmentTags } from '../services/segmentTagClassifier';
import { fingerprint, firstJsonDifference, normalizeSegmentTagSource, prepareStoredEvaluation, SegmentTagSourceRow, sourceSnapshotFingerprint, StoredTagEvaluation, summarizeEvaluations } from '../services/segmentTagBackfill';

const SOURCE_SQL = `SELECT CAST(s.id AS CHAR) AS id, s.name, ST_AsGeoJSON(s.geom, 7) AS geo, ST_SRID(s.geom) AS srid,
  s.distance_km AS baseDistanceKm, s.avg_grade AS baseGrade, s.climb_category AS baseClimbCategory,
  s.athlete_count AS baseAthleteCount, s.effort_count AS baseEffortCount, s.star_count AS baseStarCount,
  CAST(s.strava_stats_updated_at AS CHAR) AS baseStatsAt, CAST(s.updated_at AS CHAR) AS baseUpdatedAt,
  d.distance_m AS detailDistanceM, d.average_grade AS detailGrade, d.total_elevation_gain_m AS detailGainM,
  d.climb_category AS detailClimbCategory, d.athlete_count AS detailAthleteCount, d.effort_count AS detailEffortCount,
  d.star_count AS detailStarCount, d.activity_type AS activityType, d.country, d.state, d.city,
  d.is_private AS isPrivate, d.hazardous, CAST(d.fetched_at AS CHAR) AS detailFetchedAt
  FROM strava_segments s LEFT JOIN strava_segment_details d ON d.segment_id = s.id ORDER BY s.id`;

interface Options { apply: boolean; limit: number | null; report: string; expectedSourceHash: string | null; }
function parseOptions(args: string[]): Options {
  const apply = args.includes('--apply');
  const reports = args.filter(arg => arg.startsWith('--report='));
  const limits = args.filter(arg => arg.startsWith('--limit='));
  const hashes = args.filter(arg => arg.startsWith('--expected-source-hash='));
  if (reports.length !== 1 || limits.length > 1 || hashes.length > 1 || args.filter(arg => arg === '--apply').length > 1 ||
      args.some(arg => arg !== '--apply' && !arg.startsWith('--report=') && !arg.startsWith('--limit=') && !arg.startsWith('--expected-source-hash='))) {
    throw new Error('Usage: backfillSegmentTags --report=NEW_FILE [--limit=N] [--expected-source-hash=SHA256] [--apply]');
  }
  const reportName = reports[0].slice('--report='.length);
  if (!reportName) throw new Error('Report path is required');
  const limit = limits.length ? Number(limits[0].slice('--limit='.length)) : null;
  if (limit !== null && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error('Limit must be a positive integer');
  const expectedSourceHash = hashes.length ? hashes[0].slice('--expected-source-hash='.length) : null;
  if (expectedSourceHash !== null && !/^[a-f0-9]{64}$/.test(expectedSourceHash)) throw new Error('Invalid expected source hash');
  return { apply, limit, report: resolve(reportName), expectedSourceHash };
}

async function loadSources(connection: PoolConnection, lock = false): Promise<SegmentTagSourceRow[]> {
  const [rows] = await connection.query<RowDataPacket[]>(SOURCE_SQL + (lock ? ' LOCK IN SHARE MODE' : ''));
  return rows as SegmentTagSourceRow[];
}

async function tableExists(connection: PoolConnection, table: string): Promise<boolean> {
  const [rows] = await connection.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?', [table]);
  return Number(rows[0].n) > 0;
}

type Existing = { status: string; evaluationFingerprint: string };
async function loadExisting(connection: PoolConnection, ids: readonly string[]): Promise<Map<string, Existing>> {
  const existing = new Map<string, Existing>();
  for (let start = 0; start < ids.length; start += 1000) {
    const chunk = ids.slice(start, start + 1000);
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT CAST(segment_id AS CHAR) AS id, tag, status, evaluation_fingerprint AS evaluationFingerprint
       FROM strava_segment_tag_evaluations WHERE segment_id IN (${chunk.map(() => '?').join(',')})
       AND tag IN (${SEGMENT_TAGS.map(() => '?').join(',')})`, [...chunk, ...SEGMENT_TAGS]);
    for (const row of rows) existing.set(`${row.id}:${row.tag}`, { status: String(row.status), evaluationFingerprint: String(row.evaluationFingerprint) });
  }
  return existing;
}

const changedEvaluations = (rows: readonly StoredTagEvaluation[], existing: Map<string, Existing>): StoredTagEvaluation[] =>
  rows.filter(row => {
    const old = existing.get(`${row.segmentId}:${row.tag}`);
    return !old || old.status !== row.status || old.evaluationFingerprint !== row.evaluationFingerprint;
  });

const sqlUtcNow = (): string => new Date().toISOString().replace('T', ' ').replace('Z', '');

async function createSchema(connection: PoolConnection): Promise<void> {
  for (const file of ['006_create_segment_tag_runs.sql', '007_create_segment_tag_evaluations.sql']) {
    await connection.query(readFileSync(resolve(__dirname, '../../sql', file), 'utf8'));
  }
}

async function writeEvaluations(connection: PoolConnection, rows: readonly StoredTagEvaluation[], runId: string, calculatedAt: string): Promise<void> {
  let batch: unknown[][] = [];
  let estimatedBytes = 0;
  let written = 0;
  let lastProgress = 0;
  const flush = async () => {
    if (!batch.length) return;
    await connection.query(`INSERT INTO strava_segment_tag_evaluations
      (segment_id,tag,status,reason_codes,evidence,algorithm_version,reference_version,source_fingerprint,evaluation_fingerprint,source_fetched_at,calculated_at,run_id)
      VALUES ? ON DUPLICATE KEY UPDATE status=VALUES(status),reason_codes=VALUES(reason_codes),evidence=VALUES(evidence),
      algorithm_version=VALUES(algorithm_version),reference_version=VALUES(reference_version),source_fingerprint=VALUES(source_fingerprint),
      evaluation_fingerprint=VALUES(evaluation_fingerprint),source_fetched_at=VALUES(source_fetched_at),calculated_at=VALUES(calculated_at),run_id=VALUES(run_id)`, [batch]);
    written += batch.length;
    if (written === rows.length || written - lastProgress >= 5000) {
      console.log(`[SegmentTags] Written ${written}/${rows.length}`);
      lastProgress = written;
    }
    batch = [];
    estimatedBytes = 0;
  };
  for (const row of rows) {
    const values = [row.segmentId, row.tag, row.status, JSON.stringify(row.reasonCodes), JSON.stringify(row.evidence),
      row.algorithmVersion, row.referenceVersion, row.sourceFingerprint, row.evaluationFingerprint, row.sourceFetchedAt, calculatedAt, runId];
    // Account conservatively for SQL escaping, and stay below typical 4 MiB server limits.
    const size = Buffer.byteLength(JSON.stringify(values), 'utf8') * 2 + 128;
    if (size > 2 * 1024 * 1024) throw new Error(`Tag evidence is too large for ${row.segmentId}:${row.tag}`);
    if (batch.length >= 2500 || estimatedBytes + size > 2 * 1024 * 1024) await flush();
    batch.push(values);
    estimatedBytes += size;
  }
  await flush();
}

/** Compare the actual JSON and provenance, not only the stored fingerprint. */
async function verifyEvaluations(connection: PoolConnection, expected: readonly StoredTagEvaluation[], ids: readonly string[]): Promise<number> {
  const byKey = new Map(expected.map(row => [`${row.segmentId}:${row.tag}`, row]));
  let verified = 0;
  const json = (value: unknown): unknown => typeof value === 'string' ? JSON.parse(value) : value;
  for (let start = 0; start < ids.length; start += 1000) {
    const chunk = ids.slice(start, start + 1000);
    const [rows] = await connection.query<RowDataPacket[]>(`SELECT CAST(segment_id AS CHAR) AS segmentId,tag,status,
      reason_codes AS reasonCodes,evidence,algorithm_version AS algorithmVersion,reference_version AS referenceVersion,
      source_fingerprint AS sourceFingerprint,evaluation_fingerprint AS evaluationFingerprint,CAST(source_fetched_at AS CHAR) AS sourceFetchedAt
      FROM strava_segment_tag_evaluations WHERE segment_id IN (${chunk.map(() => '?').join(',')})
      AND tag IN (${SEGMENT_TAGS.map(() => '?').join(',')})`, [...chunk, ...SEGMENT_TAGS]);
    for (const row of rows) {
      const key = `${row.segmentId}:${row.tag}`;
      const target = byKey.get(key);
      if (!target) throw new Error(`Unexpected tag evaluation ${key}`);
      const actual = { segmentId: String(row.segmentId), tag: row.tag, status: row.status,
        reasonCodes: json(row.reasonCodes), evidence: json(row.evidence), algorithmVersion: row.algorithmVersion,
        referenceVersion: row.referenceVersion, sourceFingerprint: row.sourceFingerprint, sourceFetchedAt: row.sourceFetchedAt };
      const { evaluationFingerprint: ignored, ...expectedContent } = target;
      void ignored;
      const difference = firstJsonDifference(expectedContent, actual);
      if (row.evaluationFingerprint !== target.evaluationFingerprint || difference) {
        throw new Error(`Verification mismatch for ${key}: ${difference || 'fingerprint differs'}`);
      }
      byKey.delete(key);
      verified++;
    }
    console.log(`[SegmentTags] Verified ${verified}/${expected.length}`);
  }
  if (byKey.size) throw new Error(`Missing ${byKey.size} tag evaluations after write`);
  return verified;
}

async function run(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  // Reserve a new report before any database mutation, without overwriting existing files.
  const reportFd = openSync(options.report, 'wx');
  const startedAt = sqlUtcNow();
  let connection: PoolConnection | null = null;
  let transactionOpen = false;
  let advisoryLock = false;
  try {
    connection = await pool.getConnection();
    const sourceRows = await loadSources(connection);
    const sourceHash = sourceSnapshotFingerprint(sourceRows);
    if (options.expectedSourceHash && options.expectedSourceHash !== sourceHash) throw new Error('Source changed since preview; run a new preview');
    console.log(`[SegmentTags] Loaded ${sourceRows.length} segments, calculating geometry`);
    const normalized = sourceRows.map((row, index) => {
      if (index > 0 && index % 1000 === 0) console.log(`[SegmentTags] Geometry ${index}/${sourceRows.length}`);
      return normalizeSegmentTagSource(row);
    });
    const refs = buildSegmentTagReferences(normalized.map(row => row.input));
    const targets = options.limit === null ? normalized : normalized.slice(0, options.limit);
    const evaluations = targets.flatMap(source => classifySegmentTags(source.input, refs)
      .map(evaluation => prepareStoredEvaluation(source, evaluation, ALGORITHM_VERSION)));
    if (evaluations.length !== targets.length * SEGMENT_TAGS.length) throw new Error('Unexpected evaluation count');
    const ids = targets.map(row => row.input.id);
    const initialExisting = await tableExists(connection, 'strava_segment_tag_evaluations') ? await loadExisting(connection, ids) : new Map<string, Existing>();
    const summary = summarizeEvaluations(evaluations);
    const issues: Record<string, number> = {};
    for (const source of targets) for (const issue of source.input.geometry.issues) issues[issue] = (issues[issue] || 0) + 1;
    const runId = options.apply ? randomUUID() : null;
    const report: Record<string, unknown> = { mode: options.apply ? 'apply' : 'preview', runId, algorithmVersion: ALGORITHM_VERSION,
      sourceSnapshotHash: sourceHash, referenceSourceSnapshotHash: sourceHash, referenceVersion: refs.version, sourceCount: sourceRows.length, targetCount: targets.length,
      evaluationCount: evaluations.length, wouldChange: changedEvaluations(evaluations, initialExisting).length,
      referenceCounts: refs.snapshot.counts,
      referenceCohorts: refs.snapshot.cohorts.map(cohort => ({ key: cohort.key, level: cohort.level,
        representatives: cohort.representativeIds.length, athletes: cohort.athleteCounts.length, efforts: cohort.effortCounts.length, stars: cohort.starCounts.length })),
      geometryIssues: issues, summary, startedAt, completedAt: null };
    if (options.apply) {
      const [lockRows] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK('veloroam_segment_tag_backfill', 0) AS acquired");
      if (Number(lockRows[0].acquired) !== 1) throw new Error('Another segment tag backfill is running');
      advisoryLock = true;
      await createSchema(connection);
      await connection.beginTransaction();
      transactionOpen = true;
      const lockedSourceRows = await loadSources(connection, true);
      const lockedSourceHash = sourceSnapshotFingerprint(lockedSourceRows);
      if (options.expectedSourceHash && lockedSourceHash !== options.expectedSourceHash) throw new Error('Source changed since preview; transaction aborted');
      let currentTargets = targets;
      let currentEvaluations = evaluations;
      let currentIds = ids;
      if (lockedSourceHash !== sourceHash) {
        // The reference distribution stays immutable. Recompute changed records against
        // that recorded distribution after acquiring source locks, so active imports
        // cannot make a freshly persisted individual classification stale.
        const previous = new Map(normalized.map(row => [row.input.id, row]));
        const current = lockedSourceRows.map(row => {
          const old = previous.get(String(row.id));
          return old && old.sourceFingerprint === fingerprint(row) ? old : normalizeSegmentTagSource(row);
        });
        currentTargets = options.limit === null ? current : current.slice(0, options.limit);
        currentEvaluations = currentTargets.flatMap(source => classifySegmentTags(source.input, refs)
          .map(evaluation => prepareStoredEvaluation(source, evaluation, ALGORITHM_VERSION)));
        currentIds = currentTargets.map(row => row.input.id);
        const currentIssues: Record<string, number> = {};
        for (const source of currentTargets) for (const issue of source.input.geometry.issues) currentIssues[issue] = (currentIssues[issue] || 0) + 1;
        report.sourceSnapshotHash = lockedSourceHash;
        report.sourceCount = lockedSourceRows.length;
        report.targetCount = currentTargets.length;
        report.evaluationCount = currentEvaluations.length;
        report.geometryIssues = currentIssues;
        report.summary = summarizeEvaluations(currentEvaluations);
        report.sourceChangedDuringCalculation = true;
      }
      if (currentEvaluations.length !== currentTargets.length * SEGMENT_TAGS.length) throw new Error('Unexpected current evaluation count');
      const existing = await loadExisting(connection, currentIds);
      const changed = changedEvaluations(currentEvaluations, existing);
      report.wouldChange = changed.length;
      report.changed = changed.length;
      report.unchanged = currentEvaluations.length - changed.length;
      report.completedAt = sqlUtcNow();
      await connection.query(`INSERT INTO strava_segment_tag_runs
        (run_id,algorithm_version,reference_version,reference_source_snapshot_hash,source_snapshot_hash,source_count,target_count,changed_count,reference_snapshot,summary,started_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [runId, ALGORITHM_VERSION, refs.version, sourceHash, lockedSourceHash, lockedSourceRows.length, currentTargets.length,
        changed.length, JSON.stringify(refs.snapshot), JSON.stringify(report), startedAt, report.completedAt]);
      console.log(`[SegmentTags] Writing ${changed.length} evaluations in one transaction`);
      await writeEvaluations(connection, changed, runId!, String(report.completedAt));
      const verified = await verifyEvaluations(connection, currentEvaluations, currentIds);
      if (verified !== currentEvaluations.length) throw new Error('Evaluation count verification failed');
      report.verified = verified;
      report.completedAt = sqlUtcNow();
      await connection.query('UPDATE strava_segment_tag_runs SET summary=?, completed_at=? WHERE run_id=?',
        [JSON.stringify(report), report.completedAt, runId]);
      await connection.commit();
      transactionOpen = false;
    } else report.completedAt = sqlUtcNow();
    writeFileSync(reportFd, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ mode: report.mode, runId, sourceCount: report.sourceCount, targetCount: report.targetCount,
      evaluationCount: report.evaluationCount, wouldChange: report.wouldChange, changed: report.changed,
      unchanged: report.unchanged, verified: report.verified, sourceSnapshotHash: report.sourceSnapshotHash,
      referenceSourceSnapshotHash: report.referenceSourceSnapshotHash, referenceVersion: refs.version,
      counts: (report.summary as { counts: unknown }).counts, geometryIssues: report.geometryIssues, report: options.report }, null, 2));
  } catch (error) {
    if (transactionOpen && connection) await connection.rollback();
    writeFileSync(reportFd, JSON.stringify({ mode: options.apply ? 'apply' : 'preview', failed: true,
      error: error instanceof Error ? error.message : 'Unknown error', rolledBack: transactionOpen }, null, 2) + '\n');
    throw error;
  } finally {
    if (advisoryLock && connection) await connection.query("SELECT RELEASE_LOCK('veloroam_segment_tag_backfill')").catch(() => undefined);
    if (connection) connection.release();
    closeSync(reportFd);
    await pool.end();
  }
}

run().catch(error => { console.error('[SegmentTags]', error instanceof Error ? error.message : 'Unknown error'); process.exitCode = 1; });
