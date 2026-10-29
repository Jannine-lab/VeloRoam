import 'dotenv/config';
import { initDatabase, pool, query } from '../config/db';
import { fetchStravaSegmentNativeStats, getStravaAccessToken } from '../services/stravaService';

function getPositiveInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function getNonNegativeInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function wait(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

async function backfillStravaNativeStats() {
  const limit = getPositiveInteger(process.env.STRAVA_NATIVE_STATS_BACKFILL_LIMIT, 25, 100);
  const offset = getNonNegativeInteger(process.env.STRAVA_NATIVE_STATS_BACKFILL_OFFSET, 0, 1000000);
  const delayMs = getPositiveInteger(process.env.STRAVA_NATIVE_STATS_BACKFILL_DELAY_MS, 1000, 60000);

  try {
    await initDatabase();

    const { rows } = await query(`
      SELECT id, name
      FROM strava_segments
      WHERE strava_stats_updated_at IS NULL
      ORDER BY raw_score DESC
      LIMIT ${offset}, ${limit}
    `);

    if (rows.length === 0) {
      console.log('[StravaNativeStats] No segments require backfill.');
      return;
    }

    const accessToken = await getStravaAccessToken();
    let updatedCount = 0;

    for (let index = 0; index < rows.length; index++) {
      const segment = rows[index];
      try {
        const stats = await fetchStravaSegmentNativeStats(Number(segment.id), accessToken);
        await query(
          `UPDATE strava_segments
           SET star_count = ?,
               athlete_count = ?,
               effort_count = ?,
               strava_stats_updated_at = ?
           WHERE id = ?`,
          [
            stats.starCount,
            stats.athleteCount,
            stats.effortCount,
            new Date(stats.stravaStatsUpdatedAt),
            segment.id
          ]
        );
        updatedCount++;
        console.log(
          `[StravaNativeStats] ${index + 1}/${rows.length} ${segment.name}: ` +
          `stars=${stats.starCount ?? '-'}, athletes=${stats.athleteCount ?? '-'}, efforts=${stats.effortCount ?? '-'}`
        );
      } catch (error: any) {
        console.warn(`[StravaNativeStats] Failed segment ${segment.id}: ${error.message}`);
        if (error.status === 403) {
          console.warn('[StravaNativeStats] Stopping backfill because the current Strava app cannot access segment details.');
          break;
        }
      }

      if (index < rows.length - 1) {
        await wait(delayMs);
      }
    }

    console.log(`[StravaNativeStats] Backfill complete. Updated ${updatedCount}/${rows.length} segments.`);
  } finally {
    await pool.end();
  }
}

backfillStravaNativeStats().catch((error: any) => {
  console.error('[StravaNativeStats] Backfill failed:', error.message);
  process.exitCode = 1;
});
