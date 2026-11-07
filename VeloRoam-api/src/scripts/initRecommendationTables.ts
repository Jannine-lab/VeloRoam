/** Create the new tables and seed available source records; never fabricate scores. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../config/db';

async function run(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    for (const file of ['004_create_amap_poi_details.sql', '005_create_segment_recommendations.sql']) {
      await conn.query(readFileSync(resolve(__dirname, '../../sql', file), 'utf8'));
    }
    await conn.beginTransaction();
    try {
      const [points] = await conn.query(`INSERT INTO amap_poi_details (hot_point_id, source_type, raw_detail, fetched_at)
        SELECT id, 'search', raw_payload, source_updated_at FROM hot_points
        WHERE source = 'amap' AND raw_payload IS NOT NULL
        ON DUPLICATE KEY UPDATE hot_point_id = amap_poi_details.hot_point_id`);
      const [segments] = await conn.query(`INSERT INTO strava_segment_recommendations (segment_id)
        SELECT s.id FROM strava_segments s JOIN strava_segment_details d ON d.segment_id = s.id
        ON DUPLICATE KEY UPDATE segment_id = strava_segment_recommendations.segment_id`);
      await conn.commit();
      console.log('Point detail backfill:', points);
      console.log('Segment recommendation placeholders:', segments);
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  } finally {
    conn.release();
    await pool.end();
  }
}
run().catch(error => { console.error('Table initialization failed:', error.message); process.exitCode = 1; });
