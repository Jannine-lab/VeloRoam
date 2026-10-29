import 'dotenv/config';
import axios from 'axios';
import { RowDataPacket } from 'mysql2/promise';
import { pool } from '../config/db';
import { getStravaAccessToken } from '../services/stravaService';

const INTERVAL_MS = 10000;
const LOCK_NAME = 'veloroam_strava_segment_details_cache';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const fields = [
  'id', 'resource_state', 'name', 'activity_type', 'distance', 'average_grade',
  'maximum_grade', 'elevation_high', 'elevation_low', 'start_latlng', 'end_latlng',
  'climb_category', 'city', 'state', 'country', 'private', 'hazardous', 'created_at',
  'updated_at', 'total_elevation_gain', 'map', 'effort_count', 'athlete_count', 'star_count'
] as const;
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function exhausted(headers: Record<string, any>, prefix: string): boolean {
  const limits = String(headers[`x-${prefix}ratelimit-limit`] || '').split(',').map(Number);
  const usage = String(headers[`x-${prefix}ratelimit-usage`] || '').split(',').map(Number);
  return limits.length === 2 && usage.length === 2 && limits.some((limit, i) => limit > 0 && usage[i] >= limit);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--all') || args.length > 1) throw new Error('Usage: ts-node src/scripts/cacheStravaSegmentDetails.ts [--all]');
  const all = args.includes('--all');
  const connection = await pool.getConnection();
  let locked = false;
  let stop = false;
  const stopHandler = () => { stop = true; };
  process.on('SIGINT', stopHandler);
  process.on('SIGTERM', stopHandler);
  try {
    const [lockRows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS acquired', [LOCK_NAME]);
    if (Number(lockRows[0]?.acquired) !== 1) throw new Error('Another detail cache process is already running.');
    locked = true;
    let cursor = '0';
    let saved = 0, unavailable = 0;
    console.log(`Detail cache started: ${all ? 'all existing segments' : 'Shanghai starting points'}, interval ${INTERVAL_MS / 1000}s.`);
    while (!stop) {
      await connection.query('DELETE FROM strava_segment_details_cache WHERE expires_at <= UTC_TIMESTAMP()');
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT CAST(s.id AS CHAR) AS id FROM strava_segments s
         LEFT JOIN strava_segment_details_cache c ON c.segment_id = s.id AND c.expires_at > UTC_TIMESTAMP()
         WHERE s.id > ? AND c.segment_id IS NULL
         ${all ? '' : 'AND s.start_lat BETWEEN 30.8 AND 31.5 AND s.start_lng BETWEEN 121.1 AND 121.7'}
         ORDER BY s.id LIMIT 1`, [cursor]
      );
      if (!rows.length) break;
      const id = String(rows[0].id);
      const token = await getStravaAccessToken();
      let shouldStopForLimit = false;
      try {
        const response = await axios.get(`https://www.strava.com/api/v3/segments/${id}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: 10000
        });
        const detail = response.data;
        if (!detail || String(detail.id) !== id) throw new Error(`Invalid detail response for segment ${id}`);
        const selected: Record<string, unknown> = {};
        for (const field of fields) if (detail[field] !== undefined) selected[field] = detail[field];
        await connection.query(
          `INSERT INTO strava_segment_details_cache
           (segment_id, detail_json, star_count, athlete_count, effort_count, fetched_at, expires_at)
           VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY))
           ON DUPLICATE KEY UPDATE detail_json = VALUES(detail_json), star_count = VALUES(star_count),
             athlete_count = VALUES(athlete_count), effort_count = VALUES(effort_count),
             fetched_at = VALUES(fetched_at), expires_at = VALUES(expires_at)`,
          [id, JSON.stringify(selected), count(detail.star_count), count(detail.athlete_count), count(detail.effort_count)]
        );
        saved++;
        shouldStopForLimit = exhausted(response.headers, 'read') || exhausted(response.headers, '');
        console.log(`Cached segment ${id}; total ${saved}.`);
      } catch (error: any) {
        if (error.response?.status === 404) {
          await connection.query('DELETE FROM strava_segment_details_cache WHERE segment_id = ?', [id]);
          unavailable++;
          console.warn(`Segment ${id} unavailable (404); removed any cached detail.`);
        } else {
          console.error(`Segment ${id} failed (HTTP ${error.response?.status || 'network/database error'}); stopping. Retry by rerunning the script.`);
          throw error;
        }
      }
      cursor = id;
      if (shouldStopForLimit) { console.warn('Strava rate limit reached; stopping. Retry after reset.'); break; }
      if (!stop) await sleep(INTERVAL_MS);
    }
    console.log(`Finished: ${saved} cached, ${unavailable} unavailable.`);
  } finally {
    process.off('SIGINT', stopHandler);
    process.off('SIGTERM', stopHandler);
    if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
    connection.release();
    await pool.end();
  }
}
main().catch((error: any) => { console.error('Detail cache stopped:', error.message); process.exitCode = 1; });
