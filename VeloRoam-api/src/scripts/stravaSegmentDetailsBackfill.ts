import 'dotenv/config';
import axios from 'axios';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RowDataPacket } from 'mysql2/promise';
import { pool } from '../config/db';
import { getStravaAccessToken } from '../services/stravaService';

const INTERVAL_MS = 10000;
// Classify by the same start-coordinate bounding boxes used by the city crawler.
const CITY_PRIORITY = `CASE
  WHEN s.start_lat BETWEEN 30.80 AND 31.50 AND s.start_lng BETWEEN 121.10 AND 121.70 THEN 0
  WHEN s.start_lat BETWEEN 31.85 AND 32.25 AND s.start_lng BETWEEN 118.50 AND 119.10 THEN 1
  WHEN s.start_lat BETWEEN 39.60 AND 40.20 AND s.start_lng BETWEEN 116.00 AND 116.80 THEN 2
  WHEN s.start_lat BETWEEN 22.40 AND 22.80 AND s.start_lng BETWEEN 113.70 AND 114.50 THEN 3
  ELSE 4 END`;
const CITY_NAMES = ['上海', '南京', '北京', '深圳', '其他地区'];
const sleep = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
const numberOrNull = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
// Strava occasionally returns negative counters; keep them in raw_detail but
// leave unsigned numeric columns empty rather than aborting the whole crawl.
const countOrNull = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const textOrNull = (v: unknown): string | null => typeof v === 'string' ? v : null;
const boolOrNull = (v: unknown): number | null => typeof v === 'boolean' ? Number(v) : null;
const dateOrNull = (v: unknown): Date | null => {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some(a => !/^--limit=[1-9]\d*$/.test(a)) || args.length > 1) {
    throw new Error('Usage: ts-node src/scripts/stravaSegmentDetailsBackfill.ts [--limit=N]');
  }
  const maxAttempts = args.length ? Number(args[0].slice('--limit='.length)) : Infinity;
  if (maxAttempts !== Infinity && !Number.isSafeInteger(maxAttempts)) throw new Error('Invalid limit');
  const conn = await pool.getConnection();
  let lockAcquired = false;
  try {
    const [lock] = await conn.query<RowDataPacket[]>("SELECT GET_LOCK('veloroam_strava_detail_backfill', 0) AS acquired");
    if (Number(lock[0]?.acquired) !== 1) throw new Error('Another detail backfill is already running');
    lockAcquired = true;
    const sql = readFileSync(resolve(__dirname, '../../sql/003_create_strava_segment_details.sql'), 'utf8');
    await conn.query(sql);
    let cursor = '0', cursorPriority = 0, attempts = 0, saved = 0, unavailable = 0;
    let interrupted = false;
    process.once('SIGINT', () => { interrupted = true; console.log('Stopping after current request.'); });
    process.once('SIGTERM', () => { interrupted = true; console.log('Stopping after current request.'); });
    while (!interrupted && attempts < maxAttempts) {
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT CAST(s.id AS CHAR) AS segment_id, ${CITY_PRIORITY} AS priority FROM strava_segments s
         LEFT JOIN strava_segment_details d ON d.segment_id = s.id
         WHERE d.segment_id IS NULL AND (${CITY_PRIORITY} > ? OR (${CITY_PRIORITY} = ? AND s.id > ?))
         ORDER BY priority ASC, s.id ASC LIMIT 1`, [cursorPriority, cursorPriority, cursor]);
      if (rows.length === 0) break;
      const id = String(rows[0].segment_id);
      const priority = Number(rows[0].priority);
      if (attempts > 0) await sleep(INTERVAL_MS);
      if (interrupted) break;
      attempts++;
      try {
        const token = await getStravaAccessToken();
        const response = await axios.get(`https://www.strava.com/api/v3/segments/${id}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: 15000
        });
        const d = response.data;
        if (!d || String(d.id) !== id) throw new Error(`Unexpected detail response for ${id}`);
        await conn.query(`INSERT INTO strava_segment_details
          (segment_id, name, activity_type, distance_m, average_grade, maximum_grade, elevation_high_m,
           elevation_low_m, total_elevation_gain_m, climb_category, city, state, country, is_private,
           hazardous, star_count, athlete_count, effort_count, strava_created_at, strava_updated_at, raw_detail, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON DUPLICATE KEY UPDATE raw_detail=VALUES(raw_detail), fetched_at=VALUES(fetched_at),
           name=VALUES(name), activity_type=VALUES(activity_type), distance_m=VALUES(distance_m),
           average_grade=VALUES(average_grade), maximum_grade=VALUES(maximum_grade), elevation_high_m=VALUES(elevation_high_m),
           elevation_low_m=VALUES(elevation_low_m), total_elevation_gain_m=VALUES(total_elevation_gain_m),
           climb_category=VALUES(climb_category), city=VALUES(city), state=VALUES(state), country=VALUES(country),
           is_private=VALUES(is_private), hazardous=VALUES(hazardous), star_count=VALUES(star_count),
           athlete_count=VALUES(athlete_count), effort_count=VALUES(effort_count),
           strava_created_at=VALUES(strava_created_at), strava_updated_at=VALUES(strava_updated_at)`,
          [id, textOrNull(d.name), textOrNull(d.activity_type), numberOrNull(d.distance), numberOrNull(d.average_grade),
           numberOrNull(d.maximum_grade), numberOrNull(d.elevation_high), numberOrNull(d.elevation_low),
           numberOrNull(d.total_elevation_gain), numberOrNull(d.climb_category), textOrNull(d.city), textOrNull(d.state),
           textOrNull(d.country), boolOrNull(d.private), boolOrNull(d.hazardous), countOrNull(d.star_count),
           countOrNull(d.athlete_count), countOrNull(d.effort_count), dateOrNull(d.created_at), dateOrNull(d.updated_at), JSON.stringify(d)]);
        saved++;
        console.log(`[SegmentDetails] ${CITY_NAMES[priority]}: saved ${saved}, attempts ${attempts}; segment ${id}.`);
      } catch (error: any) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          unavailable++;
          console.warn(`[SegmentDetails] Segment ${id} unavailable (404); skipping this run.`);
        } else {
          const status = axios.isAxiosError(error) ? error.response?.status : undefined;
          throw new Error(`Segment ${id} failed${status ? ` (HTTP ${status})` : `: ${error.message}`}; restart to resume.`);
        }
      }
      cursor = id;
      cursorPriority = priority;
    }
    console.log(`[SegmentDetails] Finished: ${saved} saved, ${unavailable} unavailable, ${attempts} attempts.`);
  } finally {
    if (lockAcquired) await conn.query("SELECT RELEASE_LOCK('veloroam_strava_detail_backfill')");
    conn.release();
    await pool.end();
  }
}
run().catch(error => { console.error('[SegmentDetails]', error.message); process.exitCode = 1; });
