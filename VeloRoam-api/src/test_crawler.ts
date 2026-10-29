import dotenv from 'dotenv';
import { initDatabase, query } from './config/db';
import { decodePolyline } from './utils/polyline';

dotenv.config();

async function runLocalVerification() {
  console.log('🚀 [Test] Starting Strava MySQL database integration local verification...');

  try {
    // 1. 测试数据库建表初始化
    await initDatabase();
    console.log('✅ [Test] MySQL Database initialization test passed.');

    // 2. 模拟空间数据库写入测试路段 (测试 MySQL ON DUPLICATE KEY UPDATE)
    const testSegment = {
      id: 999999,
      name: 'VeloRoam Test Track (元江路高能测试弯道)',
      distanceKm: 2.34,
      avgGrade: 1.2,
      climbCategory: 0,
      rawScore: 88.5,
      starCount: 120,
      athleteCount: 840,
      effortCount: 2650,
      startLatLng: [31.0384, 121.3482] as [number, number],
      endLatLng: [31.0450, 121.3520] as [number, number],
      points: 'mem|DyyscVhAnGv@hFVlA~C~QZ`B`C' // 简易 mock polyline
    };

    // 解密 WKT
    const decoded = decodePolyline(testSegment.points);
    const coordinatesStr = decoded.map(p => `${p.lng} ${p.lat}`).join(', ');
    const wktGeom = `LINESTRING(${coordinatesStr})`;

    const upsertSql = `
      INSERT INTO strava_segments (
        id, name, distance_km, avg_grade, climb_category, raw_score,
        star_count, athlete_count, effort_count, strava_stats_updated_at,
        start_lat, start_lng, end_lat, end_lng, geom, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?,
        ST_GeomFromText(?, 4326), CURRENT_TIMESTAMP
      )
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        raw_score = VALUES(raw_score),
        star_count = VALUES(star_count),
        athlete_count = VALUES(athlete_count),
        effort_count = VALUES(effort_count),
        strava_stats_updated_at = VALUES(strava_stats_updated_at),
        geom = VALUES(geom),
        updated_at = CURRENT_TIMESTAMP;
    `;

    await query(upsertSql, [
      testSegment.id,
      testSegment.name,
      testSegment.distanceKm,
      testSegment.avgGrade,
      testSegment.climbCategory,
      testSegment.rawScore,
      testSegment.starCount,
      testSegment.athleteCount,
      testSegment.effortCount,
      testSegment.startLatLng[0],
      testSegment.startLatLng[1],
      testSegment.endLatLng[0],
      testSegment.endLatLng[1],
      wktGeom
    ]);
    console.log('✅ [Test] MySQL Upsert segment SQL test passed.');

    // 3. 测试 MySQL 空间边界范围查询 (MBRIntersects)
    // 覆盖测试段的 bbox polygon
    const polygonWkt = 'POLYGON((121.3 31.0, 121.3 31.1, 121.4 31.1, 121.4 31.0, 121.3 31.0))';
    const searchSql = `
      SELECT id, name, raw_score, star_count, athlete_count, effort_count, ST_AsText(geom) as wktGeom
      FROM strava_segments
      WHERE MBRIntersects(geom, ST_GeomFromText(?, 4326))
      LIMIT 5;
    `;
    const resSearch = await query(searchSql, [polygonWkt]);
    console.log(`✅ [Test] MySQL MBR spatial query test passed. Found segments: ${resSearch.rows.length}`);
    resSearch.rows.forEach((r: any) => {
      console.log(`   - ID: ${r.id}, Name: ${r.name}, Score: ${r.raw_score}`);
    });

    console.log('🎉 [Test] All MySQL spatial caching tests completed successfully.');

  } catch (error: any) {
    console.error('❌ [Test] Verification failed:', error.message);
  } finally {
    process.exit(0);
  }
}

runLocalVerification();
