/** Import only missing base segments; use API detail geometry, never clipped tile geometry. */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RowDataPacket } from 'mysql2/promise';
import { pool } from '../config/db';
import { getStoredOrFetchStravaSegmentDetail } from '../services/stravaSegmentDetailStore';
import { calculateVeloRoamSegmentScore, StravaSegmentDetailError } from '../services/stravaService';
import { decodePolyline, getDistanceMeters, LatLng } from '../utils/polyline';
import { StravaRateBudget } from '../services/stravaRateBudget';

interface TileSegment { id: string; tileScore: number }
const sleep = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
const countOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

function coordinate(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n))
    && Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180;
}

function validateGeometry(d: Record<string, any>, id: string): LatLng[] {
  if (String(d.id) !== id || d.activity_type !== 'Ride' || typeof d.name !== 'string' || !d.name.trim()
    || typeof d.distance !== 'number' || !Number.isFinite(d.distance) || d.distance <= 0
    || typeof d.average_grade !== 'number' || !Number.isFinite(d.average_grade)
    || !Number.isInteger(d.climb_category) || d.climb_category < 0 || d.climb_category > 5
    || !coordinate(d.start_latlng) || !coordinate(d.end_latlng)
    || typeof d.map?.polyline !== 'string' || !/^[?-~]+$/.test(d.map.polyline)) {
    throw new Error(`Invalid or incomplete riding segment detail: ${id}`);
  }
  const points = decodePolyline(d.map.polyline);
  if (points.length < 2 || points.some(p => !coordinate([p.lat, p.lng]))
    || getDistanceMeters(points[0], { lat: d.start_latlng[0], lng: d.start_latlng[1] }) > 100
    || getDistanceMeters(points[points.length - 1], { lat: d.end_latlng[0], lng: d.end_latlng[1] }) > 100) {
    throw new Error(`Invalid or incomplete segment geometry: ${id}`);
  }
  return points;
}

async function run(): Promise<void> {
  const options = new Map<string, string>();
  let apply = false;
  let waitForQuota = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply' && !apply) { apply = true; continue; }
    if (arg === '--wait-for-quota' && !waitForQuota) { waitForQuota = true; continue; }
    const match = /^--(input|report|interval-ms)=(.+)$/.exec(arg);
    if (!match || options.has(match[1])) throw new Error('Usage: ts-node src/scripts/importStravaTileSegments.ts --input=FILE [--apply] [--wait-for-quota] [--report=FILE] [--interval-ms=2000]');
    options.set(match[1], match[2]);
  }
  if (!options.has('input')) throw new Error('--input is required');
  const inputPath = resolve(options.get('input')!);
  const reportPath = resolve(options.get('report') || `${inputPath}.import-report.json`);
  if (inputPath === reportPath) throw new Error('Input and report paths must differ');
  const intervalMs = Number(options.get('interval-ms') ?? 2000);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) throw new Error('interval-ms must be between 1000 and 60000');
  const input = JSON.parse(readFileSync(inputPath, 'utf8'));
  if (input.source !== 'strava-map-vector-tile' || !Array.isArray(input.segments) || !input.segments.length) {
    throw new Error('Expected a Strava map tile capture with segments');
  }
  const unique = new Map<string, TileSegment>();
  for (const row of input.segments) {
    const id = String(row.id);
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))
      || typeof row.tileScore !== 'number' || !Number.isFinite(row.tileScore) || row.tileScore < 0) {
      throw new Error('Invalid segment ID or tile score');
    }
    if (unique.has(id) && unique.get(id)!.tileScore !== row.tileScore) throw new Error(`Conflicting scores for ${id}`);
    unique.set(id, { id, tileScore: row.tileScore });
  }

  let conn = await pool.getConnection();
  let hasConnection = true;
  const report = {
    mode: apply ? 'apply' : 'preview', source: inputPath, tile: input.tile,
    status: (apply ? 'running' : 'preview') as 'running' | 'preview' | 'waiting_quota' | 'waiting_database' | 'complete' | 'stopped' | 'failed',
    startedAt: new Date().toISOString(), finishedAt: null as string | null,
    sourceCount: unique.size, existingIds: [] as string[], missingIds: [] as string[],
    imported: [] as Array<{ id: string; name: string; stravaScore: number; rawScore: number; pointCount: number }>,
    skippedConcurrent: [] as string[], failed: [] as Array<{ id: string; reason: string }>,
    verifiedIds: [] as string[], stopped: false, quotaWaits: 0,
    nextRequestAt: null as string | null
  };
  const saveReport = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  let locked = false;
  let interrupted = false;
  const budget = new StravaRateBudget();
  const stop = () => { interrupted = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (apply) {
      const [lock] = await conn.query<RowDataPacket[]>("SELECT GET_LOCK('veloroam_strava_tile_import', 0) AS acquired");
      if (Number(lock[0]?.acquired) !== 1) throw new Error('Another tile import is already running');
      locked = true;
    }
    const ids = [...unique.keys()];
    const placeholders = ids.map(() => '?').join(',');
    const [existing] = await conn.query<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id FROM strava_segments WHERE id IN (${placeholders})`, ids);
    const existingIds = new Set<string>(existing.map(row => String(row.id)));
    report.existingIds = [...existingIds];
    const missing = [...unique.values()].filter(row => !existingIds.has(row.id));
    report.missingIds = missing.map(row => row.id);
    saveReport();
    console.log(`[TileImport] ${ids.length} unique IDs; ${existing.length} existing; ${missing.length} missing; mode=${report.mode}.`);
    if (!apply || !missing.length) { if (apply) report.status = 'complete'; return; }
    const [scoreColumn] = await conn.query<RowDataPacket[]>(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='strava_segments' AND COLUMN_NAME='strava_score'");
    if (!scoreColumn.length) throw new Error('strava_segments.strava_score is required');

    for (let i = 0; i < missing.length; i++) {
      if (i > 0) await sleep(intervalMs);
      if (interrupted) { report.stopped = true; break; }
      if (waitForQuota) {
        const until = budget.nextAllowedAt();
        if (until > Date.now()) {
          report.quotaWaits++;
          report.status = 'waiting_quota';
          report.nextRequestAt = new Date(until).toISOString();
          saveReport();
          console.log(`[TileImport] Waiting for application quota until ${report.nextRequestAt}.`);
          // The remote database may close idle sockets long before the quota window ends.
          // Release the connection and advisory lock rather than retaining a stale socket.
          if (locked) {
            try { await conn.query("SELECT RELEASE_LOCK('veloroam_strava_tile_import')"); }
            catch { console.warn('[TileImport] Database connection closed while releasing the import lock.'); }
            locked = false;
          }
          conn.destroy();
          hasConnection = false;
          while (!interrupted && Date.now() < until) {
            await sleep(Math.min(10000, Math.max(1, until - Date.now())));
          }
          report.nextRequestAt = null;
          if (!interrupted) {
            report.status = 'waiting_database';
            saveReport();
          }
          while (!interrupted && !hasConnection) {
            let candidate;
            try {
              candidate = await pool.getConnection();
              const [lock] = await candidate.query<RowDataPacket[]>("SELECT GET_LOCK('veloroam_strava_tile_import', 0) AS acquired");
              if (Number(lock[0]?.acquired) !== 1) {
                candidate.release();
                console.log('[TileImport] Another import is running; waiting for the import lock.');
              } else {
                conn = candidate;
                hasConnection = true;
                locked = true;
              }
            } catch (error) {
              if (candidate) candidate.destroy();
              console.warn(`[TileImport] Database reconnect failed: ${error instanceof Error ? error.message : 'unknown error'}`);
            }
            if (!hasConnection) await sleep(10000);
          }
          report.status = 'running';
        }
        if (interrupted) { report.stopped = true; break; }
      }
      const segment = missing[i];
      try {
        await getStoredOrFetchStravaSegmentDetail(Number(segment.id), waitForQuota ? (headers, status) => budget.observe(headers, status) : undefined);
        const [details] = await conn.query<RowDataPacket[]>(
          'SELECT raw_detail, fetched_at FROM strava_segment_details WHERE segment_id=?', [segment.id]);
        if (!details.length) throw new Error('Detail was not persisted');
        const detail = typeof details[0].raw_detail === 'string' ? JSON.parse(details[0].raw_detail) : details[0].raw_detail;
        const points = validateGeometry(detail, segment.id);
        // Use the same custom score as the current live importer, with the detail API's grade field mapped explicitly.
        const rawScore = Math.round(calculateVeloRoamSegmentScore({ ...detail, avg_grade: detail.average_grade }) * 100) / 100;
        if (!Number.isFinite(rawScore) || rawScore > 9999.99 || rawScore < -9999.99) throw new Error('Custom score exceeds database range');
        const wkt = `LINESTRING(${points.map(p => `${p.lng} ${p.lat}`).join(',')})`;
        await conn.query(`INSERT INTO strava_segments
          (id,name,distance_km,avg_grade,climb_category,raw_score,strava_score,
           star_count,athlete_count,effort_count,strava_stats_updated_at,
           start_lat,start_lng,end_lat,end_lng,geom,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,ST_GeomFromText(?,4326),CURRENT_TIMESTAMP)`,
          [segment.id, detail.name, Math.round(detail.distance) / 1000, Math.round(detail.average_grade * 100) / 100,
            detail.climb_category, rawScore, segment.tileScore,
            countOrNull(detail.star_count), countOrNull(detail.athlete_count), countOrNull(detail.effort_count),
            details[0].fetched_at, ...detail.start_latlng, ...detail.end_latlng, wkt]);
        report.imported.push({ id: segment.id, name: detail.name, stravaScore: segment.tileScore, rawScore, pointCount: points.length });
        console.log(`[TileImport] ${i + 1}/${missing.length}: inserted ${segment.id}; score=${segment.tileScore}; points=${points.length}.`);
      } catch (error: any) {
        if (waitForQuota && error instanceof StravaSegmentDetailError && error.status === 429) {
          console.warn(`[TileImport] Quota exhausted at ${segment.id}; retaining this ID for retry.`);
          i--;
          continue;
        }
        if (error.code === 'ER_DUP_ENTRY') {
          report.skippedConcurrent.push(segment.id);
        } else {
          report.failed.push({ id: segment.id, reason: error.message });
          console.warn(`[TileImport] ${segment.id}: ${error.message}`);
          if (error instanceof StravaSegmentDetailError && [401, 403, 429].includes(error.status ?? 0)) {
            report.stopped = true;
            break;
          }
        }
      } finally { saveReport(); }
    }

    if (report.imported.length && hasConnection) {
      const insertedIds = report.imported.map(row => row.id);
      const [verified] = await conn.query<RowDataPacket[]>(`SELECT CAST(s.id AS CHAR) AS id,s.strava_score,
        ST_SRID(s.geom) AS srid,ST_NumPoints(s.geom) AS points,JSON_UNQUOTE(JSON_EXTRACT(d.raw_detail,'$.id')) AS detail_id
        FROM strava_segments s JOIN strava_segment_details d ON d.segment_id=s.id
        WHERE s.id IN (${insertedIds.map(() => '?').join(',')})`, insertedIds);
      for (const row of verified) {
        if (String(row.id) !== String(row.detail_id) || row.srid !== 4326 || row.points < 2
          || Number(row.strava_score) !== unique.get(String(row.id))!.tileScore) throw new Error(`Verification failed: ${row.id}`);
        report.verifiedIds.push(String(row.id));
      }
      if (report.verifiedIds.length !== report.imported.length) throw new Error('Inserted rows missing during verification');
    }
    report.status = report.stopped ? 'stopped' : report.failed.length ? 'failed' : 'complete';
    if (report.failed.length || report.stopped) process.exitCode = 1;
  } finally {
    if (report.status === 'running' || report.status === 'waiting_quota' || report.status === 'waiting_database') report.status = interrupted ? 'stopped' : 'failed';
    report.finishedAt = new Date().toISOString();
    saveReport();
    console.log(`[TileImport] Finished: ${report.imported.length} inserted, ${report.verifiedIds.length} verified, ${report.failed.length} failed. Report: ${reportPath}`);
    if (hasConnection) {
      if (locked) {
        try { await conn.query("SELECT RELEASE_LOCK('veloroam_strava_tile_import')"); }
        catch { console.warn('[TileImport] Database connection closed while releasing the import lock.'); }
      }
      conn.release();
    }
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await pool.end();
  }
}
run().catch(error => { console.error('[TileImport]', error.message); process.exitCode = 1; });
