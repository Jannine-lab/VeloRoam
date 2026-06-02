import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

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
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS strava_segments (
        id BIGINT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        distance_km DECIMAL(8, 3) NOT NULL,
        avg_grade DECIMAL(5, 2) NOT NULL,
        climb_category INT NOT NULL DEFAULT 0,
        raw_score DECIMAL(6, 2) NOT NULL,
        start_lat DOUBLE NOT NULL,
        start_lng DOUBLE NOT NULL,
        end_lat DOUBLE NOT NULL,
        end_lng DOUBLE NOT NULL,
        geom LINESTRING NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        SPATIAL INDEX idx_geom (geom),
        INDEX idx_score (raw_score DESC)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `;

    await connection.query(createTableQuery);
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
