import mysql, { PoolConnection, RowDataPacket } from 'mysql2/promise';
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

dotenv.config();

// 默认使用本地 MySQL 数据库配置作为开发环境降级
const connectionString = process.env.DATABASE_URL || 'mysql://root:root@127.0.0.1:3306/veloroam';

console.log(`🔌 [Database] Connecting to MySQL at: ${connectionString.split('@')[1] || 'default local host'}`);

// 创建具有自适应连接重置的 MySQL 连接池
export const pool = mysql.createPool({
  uri: connectionString,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
});

async function ensureStravaNativeStatsSchema(connection: PoolConnection) {
  const columnMigrations = [
    { name: 'strava_score', definition: 'DOUBLE NULL AFTER raw_score' },
    { name: 'star_count', definition: 'INT UNSIGNED NULL AFTER raw_score' },
    { name: 'athlete_count', definition: 'INT UNSIGNED NULL AFTER star_count' },
    { name: 'effort_count', definition: 'BIGINT UNSIGNED NULL AFTER athlete_count' },
    { name: 'strava_stats_updated_at', definition: 'TIMESTAMP NULL DEFAULT NULL AFTER effort_count' }
  ];

  for (const migration of columnMigrations) {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS column_count
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'strava_segments'
         AND COLUMN_NAME = ?`,
      [migration.name]
    );

    if (Number(rows[0]?.column_count || 0) === 0) {
      await connection.query(
        `ALTER TABLE strava_segments ADD COLUMN ${migration.name} ${migration.definition}`
      );
      console.log(`✅ [Database] Added strava_segments.${migration.name}`);
    }
  }

  const [indexRows] = await connection.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS index_count
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'strava_segments'
       AND INDEX_NAME = 'idx_strava_native_popularity'`
  );

  if (Number(indexRows[0]?.index_count || 0) === 0) {
    await connection.query(
      'ALTER TABLE strava_segments ADD INDEX idx_strava_native_popularity (star_count DESC, athlete_count DESC)'
    );
    console.log('✅ [Database] Added Strava native popularity index.');
  }
}

/**
 * 自动检测并初始化 MySQL 数据表和 SPATIAL 索引结构
 */
export async function initDatabase() {
  let connection;
  try {
    connection = await pool.getConnection();
    console.log('🔄 [Database] Initializing MySQL table and SPATIAL indexes...');

    // 建立 MySQL 空间地理数据表
    // 空间列 geom 必须为 LINESTRING 且 NOT NULL 才能顺利建立 SPATIAL INDEX！
    const createSegmentTableQuery = `
      CREATE TABLE IF NOT EXISTS strava_segments (
        id BIGINT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        distance_km DECIMAL(8, 3) NOT NULL,
        avg_grade DECIMAL(5, 2) NOT NULL,
        climb_category INT NOT NULL DEFAULT 0,
        raw_score DECIMAL(6, 2) NOT NULL,
        strava_score DOUBLE NULL,
        star_count INT UNSIGNED NULL,
        athlete_count INT UNSIGNED NULL,
        effort_count BIGINT UNSIGNED NULL,
        strava_stats_updated_at TIMESTAMP NULL DEFAULT NULL,
        start_lat DOUBLE NOT NULL,
        start_lng DOUBLE NOT NULL,
        end_lat DOUBLE NOT NULL,
        end_lng DOUBLE NOT NULL,
        geom LINESTRING NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        SPATIAL INDEX idx_geom (geom),
        INDEX idx_score (raw_score DESC),
        INDEX idx_strava_native_popularity (star_count DESC, athlete_count DESC)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `;

    await connection.query(createSegmentTableQuery);
    await ensureStravaNativeStatsSchema(connection);
    const detailSchema = readFileSync(resolve(__dirname, '../../sql/003_create_strava_segment_details.sql'), 'utf8');
    await connection.query(detailSchema);
    console.log('🎉 [Database] MySQL database and spatial schema bootstrapped successfully!');
  } catch (error: any) {
    console.error('❌ [Database] Critical database initialization failure:', error.message);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

/**
 * 通用查询执行函数 (封装 Promise 返回，与 postgresql 签名类似)
 */
export async function query(sql: string, params?: any[]): Promise<any> {
  const [rows] = await pool.query(sql, params);
  return { rows: rows as any[] };
}
