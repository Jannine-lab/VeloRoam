import axios from 'axios';
import { query } from '../config/db';
import { decodePolyline } from '../utils/polyline';
import {
  calculateVeloRoamSegmentScore,
  extractStravaNativeStats,
  fetchStravaSegmentNativeStats,
  getStravaAccessToken,
  StravaNativeStats
} from '../services/stravaService';

// ==========================================================================
// 1. Z-Scan 扫描网格空间划分参数 (支持全国 10 大核心骑行城市)
// ==========================================================================
interface CityConfig {
  name: string;
  latNW: number;
  lngNW: number;
  latSE: number;
  lngSE: number;
  step: number;
}

const CITIES: CityConfig[] = [
  { name: '上海', latNW: 31.50, lngNW: 121.10, latSE: 30.80, lngSE: 121.70, step: 0.08 },
  { name: '北京', latNW: 40.20, lngNW: 116.00, latSE: 39.60, lngSE: 116.80, step: 0.08 },
  { name: '南京', latNW: 32.25, lngNW: 118.50, latSE: 31.85, lngSE: 119.10, step: 0.08 },
  { name: '深圳', latNW: 22.80, lngNW: 113.70, latSE: 22.40, lngSE: 114.50, step: 0.08 },
  { name: '广州', latNW: 23.45, lngNW: 113.00, latSE: 22.95, lngSE: 113.60, step: 0.08 },
  { name: '苏州', latNW: 31.55, lngNW: 120.35, latSE: 31.05, lngSE: 120.95, step: 0.08 },
  { name: '成都', latNW: 30.95, lngNW: 103.75, latSE: 30.35, lngSE: 104.35, step: 0.08 },
  { name: '长沙', latNW: 28.45, lngNW: 112.65, latSE: 28.05, lngSE: 113.25, step: 0.08 },
  { name: '武汉', latNW: 30.85, lngNW: 114.00, latSE: 30.35, lngSE: 114.60, step: 0.08 },
  { name: '郑州', latNW: 35.00, lngNW: 113.30, latSE: 34.50, lngSE: 113.90, step: 0.08 }
];

interface GridBounds {
  cityName: string;
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface StravaCrawlerRunResult {
  gridIndex: number;
  cityName: string;
  bounds: Omit<GridBounds, 'cityName'>;
  fetchedCount: number;
  upsertedCount: number;
  nativeStatsAttempts: number;
  startedAt: string;
  finishedAt: string;
}

export interface StravaCrawlerStatus {
  schedulerEnabled: boolean;
  running: boolean;
  currentGridIndex: number;
  totalGrids: number;
  nextGrid: GridBounds | null;
  intervalMs: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastError: string | null;
  lastResult: StravaCrawlerRunResult | null;
}

// 缓存生成的扫描网格序列
const scanGrids: GridBounds[] = [];

for (const city of CITIES) {
  for (let lat = city.latNW; lat > city.latSE; lat -= city.step) {
    for (let lng = city.lngNW; lng < city.lngSE; lng += city.step) {
      scanGrids.push({
        cityName: city.name,
        south: parseFloat((lat - city.step).toFixed(4)),
        west: parseFloat(lng.toFixed(4)),
        north: parseFloat(lat.toFixed(4)),
        east: parseFloat((lng + city.step).toFixed(4))
      });
    }
  }
}

let currentGridIndex = 0;
let crawlerTimer: NodeJS.Timeout | null = null;
let crawlerSchedulerEnabled = false;
let crawlerRunning = false;
let lastStartedAt: string | null = null;
let lastFinishedAt: string | null = null;
let lastError: string | null = null;
let lastResult: StravaCrawlerRunResult | null = null;
const crawlerIntervalMs = 10000;

console.log(`🧭 [Crawler] Generated MySQL Z-Scan grid pattern. Total grids for 10 cities: ${scanGrids.length}`);

/**
 * 将 Encoded Polyline 解密并转换为 MySQL LINESTRING WKT 文本
 */
function polylineToWktLineString(pointsStr: string): string {
  const decoded = decodePolyline(pointsStr);
  if (decoded.length < 2) return '';
  
  // WKT 格式要求: LINESTRING(lng lat, lng lat, ...)
  const coordinates = decoded.map(p => `${p.lng} ${p.lat}`).join(', ');
  return `LINESTRING(${coordinates})`;
}

/**
 * 核心定时抓取同步任务
 */
async function crawlNextGrid(scheduleNextRun: boolean): Promise<StravaCrawlerRunResult | null> {
  if (scanGrids.length === 0 || crawlerRunning) return null;

  const bounds = scanGrids[currentGridIndex];
  const gridIndex = currentGridIndex;
  const startedAt = new Date().toISOString();
  let fetchedCount = 0;
  let upsertedCount = 0;
  let nativeStatsAttempts = 0;
  crawlerRunning = true;
  lastStartedAt = startedAt;
  lastError = null;
  console.log(`📡 [Crawler] MySQL scanning Grid [${currentGridIndex + 1}/${scanGrids.length}] (${bounds.cityName}): Bounds [S:${bounds.south}, W:${bounds.west}, N:${bounds.north}, E:${bounds.east}]`);

  try {
    const accessToken = await getStravaAccessToken();
    const boundsStr = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
    const url = `https://www.strava.com/api/v3/segments/explore?bounds=${boundsStr}&activity_type=riding`;

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });

    const segments = response.data?.segments || [];
    fetchedCount = segments.length;
    console.log(`🔌 [Crawler] Received ${segments.length} segments for this area.`);

    let insertedCount = 0;
    const configuredNativeLimit = Number(process.env.STRAVA_CRAWLER_NATIVE_STATS_LIMIT ?? 0);
    const nativeStatsLimit = Number.isFinite(configuredNativeLimit)
      ? Math.max(0, Math.min(3, Math.floor(configuredNativeLimit)))
      : 0;

    for (const seg of segments) {
      if (!seg.points || !seg.start_latlng || !seg.end_latlng) continue;

      // 打印路段的城市名称、路段名以及经纬度信息
      console.log(`   - 🗺️ [Segment Log] City: ${bounds.cityName}, Name: "${seg.name}", StartLatLng: [${seg.start_latlng.join(', ')}], EndLatLng: [${seg.end_latlng.join(', ')}]`);

      const score = calculateVeloRoamSegmentScore(seg);
      const wktGeom = polylineToWktLineString(seg.points);
      let nativeStats: StravaNativeStats | null = extractStravaNativeStats(seg);

      if (!nativeStats && nativeStatsAttempts < nativeStatsLimit) {
        nativeStatsAttempts++;
        try {
          nativeStats = await fetchStravaSegmentNativeStats(Number(seg.id), accessToken);
        } catch (nativeStatsError: any) {
          console.warn(`[Crawler] Native stats enrichment failed for segment ${seg.id}: ${nativeStatsError.message}`);
        }
      }

      if (!wktGeom) continue;

      // 使用 MySQL 的 ON DUPLICATE KEY UPDATE 语法实现高效排重新增
      const upsertSql = `
        INSERT INTO strava_segments (
          id, name, distance_km, avg_grade, climb_category, raw_score,
          star_count, athlete_count, effort_count, strava_stats_updated_at,
          start_lat, start_lng, end_lat, end_lng, geom, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ST_GeomFromText(?, 4326), CURRENT_TIMESTAMP
        )
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          distance_km = VALUES(distance_km),
          avg_grade = VALUES(avg_grade),
          climb_category = VALUES(climb_category),
          raw_score = VALUES(raw_score),
          star_count = COALESCE(VALUES(star_count), star_count),
          athlete_count = COALESCE(VALUES(athlete_count), athlete_count),
          effort_count = COALESCE(VALUES(effort_count), effort_count),
          strava_stats_updated_at = COALESCE(VALUES(strava_stats_updated_at), strava_stats_updated_at),
          geom = VALUES(geom),
          updated_at = CURRENT_TIMESTAMP;
      `;

      await query(upsertSql, [
        seg.id,
        seg.name,
        parseFloat((seg.distance / 1000).toFixed(3)),
        parseFloat((seg.avg_grade || 0).toFixed(2)),
        seg.climb_category || 0,
        parseFloat(score.toFixed(2)),
        nativeStats?.starCount ?? null,
        nativeStats?.athleteCount ?? null,
        nativeStats?.effortCount ?? null,
        nativeStats?.stravaStatsUpdatedAt ? new Date(nativeStats.stravaStatsUpdatedAt) : null,
        seg.start_latlng[0],
        seg.start_latlng[1],
        seg.end_latlng[0],
        seg.end_latlng[1],
        wktGeom
      ]);
      insertedCount++;
    }

    if (insertedCount > 0) {
      console.log(`💾 [Crawler] Upserted ${insertedCount} segments successfully into MySQL table.`);
    }

    upsertedCount = insertedCount;
    const finishedAt = new Date().toISOString();
    lastResult = {
      gridIndex,
      cityName: bounds.cityName,
      bounds: {
        south: bounds.south,
        west: bounds.west,
        north: bounds.north,
        east: bounds.east
      },
      fetchedCount,
      upsertedCount,
      nativeStatsAttempts,
      startedAt,
      finishedAt
    };
    return lastResult;

  } catch (error: any) {
    lastError = error.message;
    console.error(`❌ [Crawler] Synchronizer execution failed in Grid ${currentGridIndex + 1}:`, error.message);
    return null;
  } finally {
    // 平移网格指针，到末尾后自动重置回 0 形成闭环循环
    currentGridIndex = (currentGridIndex + 1) % scanGrids.length;
    crawlerRunning = false;
    lastFinishedAt = new Date().toISOString();

    // 🚀 严格的 10 秒速率限制自递归，彻底避免被 Strava 限流惩罚
    if (scheduleNextRun && crawlerSchedulerEnabled) {
      crawlerTimer = setTimeout(() => {
        crawlerTimer = null;
        void crawlNextGrid(true);
      }, crawlerIntervalMs);
    }
  }
}

/**
 * 启动爬虫
 */
export function startStravaCrawler(): boolean {
  if (crawlerSchedulerEnabled || crawlerRunning) {
    console.warn('⚠️ [Crawler] Crawler process is already running.');
    return false;
  }
  crawlerSchedulerEnabled = true;
  console.log('🚀 [Crawler] Spawning auto grid synchronization crawler (10s intervals)...');
  void crawlNextGrid(true);
  return true;
}

/**
 * 停止爬虫
 */
export function stopStravaCrawler(): boolean {
  const wasEnabled = crawlerSchedulerEnabled || crawlerTimer !== null;
  crawlerSchedulerEnabled = false;
  if (crawlerTimer) {
    clearTimeout(crawlerTimer);
    crawlerTimer = null;
  }
  console.log('🛑 [Crawler] Grid crawling synchronizer has been stopped.');
  return wasEnabled;
}

/**
 * 手动抓取当前网格一次，不开启循环定时任务。
 */
export function triggerStravaCrawlerRunOnce(): boolean {
  if (crawlerRunning || crawlerSchedulerEnabled) {
    return false;
  }

  void crawlNextGrid(false);
  return true;
}

export function getStravaCrawlerStatus(): StravaCrawlerStatus {
  return {
    schedulerEnabled: crawlerSchedulerEnabled,
    running: crawlerRunning,
    currentGridIndex,
    totalGrids: scanGrids.length,
    nextGrid: scanGrids[currentGridIndex] || null,
    intervalMs: crawlerIntervalMs,
    lastStartedAt,
    lastFinishedAt,
    lastError,
    lastResult
  };
}
