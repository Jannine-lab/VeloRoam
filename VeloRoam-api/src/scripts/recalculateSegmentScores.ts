/**
 * Preview a provisional 0–100 score, or apply it with --apply.
 * Backups are written once per row; repeated runs do not replace the original.
 * Stop all other segment writers and confirm the Strava data-use terms first.
 * ALTER TABLE is committed separately by MySQL; score updates are transactional.
 */
import 'dotenv/config';
import { RowDataPacket } from 'mysql2/promise';
import { pool } from '../config/db';
import { calculateSegmentScore, SegmentScoreInput } from '../services/segmentScore';

interface SegmentRow extends RowDataPacket {
  segmentId: string; distanceKm: string | number | null; avgGrade: string | number | null;
  starCount: string | number | null; athleteCount: string | number | null;
  effortCount: string | number | null; rawScore: string | number;
}

function optionalNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function scoreInput(row: SegmentRow): SegmentScoreInput {
  return { distanceKm: optionalNumber(row.distanceKm), avgGrade: optionalNumber(row.avgGrade),
    starCount: optionalNumber(row.starCount), athleteCount: optionalNumber(row.athleteCount),
    effortCount: optionalNumber(row.effortCount) };
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply') || args.length > 1) {
    throw new Error('Usage: ts-node src/scripts/recalculateSegmentScores.ts [--apply]');
  }
  const apply = args.includes('--apply');
  const conn = await pool.getConnection();
  try {
    if (apply) {
      const [columns] = await conn.query<RowDataPacket[]>(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'strava_segments' AND COLUMN_NAME = 'old_raw_score'`
      );
      if (columns.length === 0) {
        await conn.query('ALTER TABLE strava_segments ADD COLUMN old_raw_score DECIMAL(6,2) NULL AFTER raw_score');
        console.log('Added old_raw_score (DDL is committed separately).');
      }
      await conn.beginTransaction();
    }
    try {
      const [rows] = await conn.query<SegmentRow[]>(
        `SELECT CAST(id AS CHAR) AS segmentId, distance_km AS distanceKm, avg_grade AS avgGrade,
                star_count AS starCount, athlete_count AS athleteCount, effort_count AS effortCount,
                raw_score AS rawScore FROM strava_segments${apply ? ' FOR UPDATE' : ''}`
      );
      let min = Infinity, max = -Infinity, sum = 0, missingPopularity = 0;
      const buckets = [0, 0, 0, 0, 0];
      for (const row of rows) {
        const result = calculateSegmentScore(scoreInput(row));
        if (result.total === null) throw new Error(`No valid scoring input for segment ${row.segmentId}`);
        min = Math.min(min, result.total); max = Math.max(max, result.total); sum += result.total;
        if (result.popularity === null) missingPopularity++;
        buckets[Math.min(4, Math.floor(result.total / 20))]++;
        if (apply) {
          await conn.query(
            `UPDATE strava_segments SET old_raw_score = COALESCE(old_raw_score, raw_score), raw_score = ? WHERE id = ?`,
            [result.total, row.segmentId]
          );
        }
      }
      if (apply) await conn.commit();
      console.log(JSON.stringify({ mode: apply ? 'applied' : 'preview', scoreVersion: 'v1-provisional',
        count: rows.length, missingPopularity, min: rows.length ? min : null, max: rows.length ? max : null,
        average: rows.length ? Math.round(sum / rows.length * 100) / 100 : null,
        buckets: { '0–<20': buckets[0], '20–<40': buckets[1], '40–<60': buckets[2], '60–<80': buckets[3], '80–100': buckets[4] } }, null, 2));
    } catch (error) {
      if (apply) await conn.rollback();
      throw error;
    }
  } finally {
    conn.release();
    await pool.end();
  }
}
run().catch(error => { console.error('Score recalculation failed:', error.message); process.exitCode = 1; });
