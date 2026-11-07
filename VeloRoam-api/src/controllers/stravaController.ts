import { Request, Response } from 'express';
import { query } from '../config/db';
import { exploreStravaSegments, StravaSegmentDetailError } from '../services/stravaService';
import { getStoredOrFetchStravaSegmentDetail } from '../services/stravaSegmentDetailStore';
import { getSegmentDisplayScore, getSegmentVisibleFromZoom } from '../services/segmentVisibility';

/**
 * 将 MySQL 返回的 LINESTRING(lng1 lat1, lng2 lat2, ...) WKT 文本解析为前端所需的 [{lat, lng}] 坐标格式
 */
function parseWktLineString(wkt: string): Array<{ lat: number, lng: number }> {
  if (!wkt || !wkt.startsWith('LINESTRING')) return [];

  // 正则提取括号内部的所有坐标对
  const matches = wkt.match(/\(([^)]+)\)/);
  if (!matches || !matches[1]) return [];

  const pairs = matches[1].split(',');
  return pairs.map(pair => {
    const [lngStr, latStr] = pair.trim().split(/\s+/);
    return {
      lat: parseFloat(latStr),
      lng: parseFloat(lngStr)
    };
  });
}

/**
 * 将实时从 API 获取的新段数据异步 Upsert 写入 MySQL
 */
async function asyncUpsertSegmentsToMySql(segments: any[]) {
  for (const seg of segments) {
    if (!seg.coordinates || seg.coordinates.length < 2) continue;
    try {
      // 将 coordinates = [{lat, lng}, ...] 拼装成 LINESTRING WKT 文本
      const wktPoints = seg.coordinates.map((p: any) => `${p.lng} ${p.lat}`).join(', ');
      const wktGeom = `LINESTRING(${wktPoints})`;

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
        seg.distanceKm,
        seg.avgGrade,
        seg.climbCategory || 0,
        seg.veloRoamScore ?? seg.rawScore ?? 0,
        seg.starCount ?? null,
        seg.athleteCount ?? null,
        seg.effortCount ?? null,
        seg.stravaStatsUpdatedAt ? new Date(seg.stravaStatsUpdatedAt) : null,
        seg.startLatLng[0],
        seg.startLatLng[1],
        seg.endLatLng[0],
        seg.endLatLng[1],
        wktGeom
      ]);
    } catch (dbErr: any) {
      console.warn(`[StravaController] MySQL Async Upsert failed:`, dbErr.message);
    }
  }
}

/**
 * 计算两个折线坐标集合的重合度比例
 */
function calculateOverlapRatio(
  coords1: Array<{ lat: number, lng: number }>,
  coords2: Array<{ lat: number, lng: number }>
): number {
  if (!coords1 || !coords2 || coords1.length === 0 || coords2.length === 0) {
    return 0;
  }

  let matchingPoints = 0;
  for (const p1 of coords1) {
    let foundMatch = false;
    for (const p2 of coords2) {
      // 快速判断两点是否在 45 米内 (近似值)
      const dLat = (p2.lat - p1.lat) * 111320;
      const dLng = (p2.lng - p1.lng) * 111320 * Math.cos(p1.lat * Math.PI / 180);
      const dist = Math.sqrt(dLat * dLat + dLng * dLng);
      if (dist < 45) {
        foundMatch = true;
        break;
      }
    }
    if (foundMatch) {
      matchingPoints++;
    }
  }

  return matchingPoints / coords1.length;
}

export const getStravaSegments = async (req: Request, res: Response) => {
  try {
    const { bounds, zoom } = req.query;

    if (!bounds || typeof bounds !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid bounds parameter. Expected format: south,west,north,east' });
    }

    // 清洗坐标中的换行与空格
    const cleanBounds = bounds.replace(/\s+/g, '');
    const boundsParts = cleanBounds.split(',').map(Number);
    if (boundsParts.length !== 4 || boundsParts.some(isNaN)) {
      return res.status(400).json({ error: 'Invalid bounds format. Expected 4 comma-separated numbers: south,west,north,east' });
    }

    const [south, west, north, east] = boundsParts;
    const zoomVal = zoom ? parseInt(zoom as string, 10) : undefined;

    console.log(`🔍 [StravaController] Querying MySQL for bounds: [S:${south}, W:${west}, N:${north}, E:${east}]`);

    // 1. 在 MySQL 中使用 MBR 闭合空间多边形检索相交几何体 (利用 SPATIAL 索引)
    // 构造 Polygon WKT: POLYGON((west south, west north, east north, east south, west south))
    const polygonWkt = `POLYGON((${west} ${south}, ${west} ${north}, ${east} ${north}, ${east} ${south}, ${west} ${south}))`;

    const mysqlSqlQuery = `
      SELECT 
        s.id,
        s.name,
        s.distance_km as "distanceKm",
        s.avg_grade as "avgGrade",
        s.climb_category as "climbCategory",
        s.raw_score as "rawScore",
        s.strava_score as "stravaScore",
        COALESCE(d.star_count, s.star_count) as "starCount",
        COALESCE(d.athlete_count, s.athlete_count) as "athleteCount",
        COALESCE(d.effort_count, s.effort_count) as "effortCount",
        s.strava_stats_updated_at as "stravaStatsUpdatedAt",
        s.start_lat as "startLat",
        s.start_lng as "startLng",
        s.end_lat as "endLat",
        s.end_lng as "endLng",
        ST_AsText(s.geom) as "wktGeom"
      FROM strava_segments s
      LEFT JOIN strava_segment_details d ON d.segment_id = s.id
      WHERE MBRIntersects(s.geom, ST_GeomFromText(?, 4326))
      ORDER BY CASE WHEN ? <= 10 AND COALESCE(s.strava_score, s.raw_score) >= 100
        AND COALESCE(d.star_count, s.star_count, -1) < 5
        AND COALESCE(d.effort_count, s.effort_count, -1) < 10 THEN 1 ELSE 0 END,
        COALESCE(s.strava_score, s.raw_score) DESC
      LIMIT 200;
    `;

    const { rows } = await query(mysqlSqlQuery, [polygonWkt, zoomVal ?? 13]);

    // 2. 命中本地 MySQL 缓存判定 (缓存路段数 >= 3，则直接进行秒级返回)
    if (rows && rows.length >= 3) {
      const formattedSegments = rows.map((row: any) => {
        const coordinates = parseWktLineString(row.wktGeom);
        return {
          id: Number(row.id),
          name: row.name,
          distanceKm: Number(row.distanceKm),
          avgGrade: Number(row.avgGrade),
          climbCategory: Number(row.climbCategory),
          veloRoamScore: Number(row.rawScore),
          rawScore: Number(row.rawScore),
          stravaScore: row.stravaScore === null ? null : Number(row.stravaScore),
          starCount: row.starCount === null ? null : Number(row.starCount),
          athleteCount: row.athleteCount === null ? null : Number(row.athleteCount),
          effortCount: row.effortCount === null ? null : Number(row.effortCount),
          stravaStatsUpdatedAt: row.stravaStatsUpdatedAt
            ? new Date(row.stravaStatsUpdatedAt).toISOString()
            : null,
          startLatLng: [Number(row.startLat), Number(row.startLng)],
          endLatLng: [Number(row.endLat), Number(row.endLng)],
          coordinates
        };
      }).map((segment: any) => ({ ...segment, visibleFromZoom: getSegmentVisibleFromZoom(segment) }));

      // Keep candidates visible at this zoom ahead of delayed red segments before overlap filtering.
      formattedSegments.sort((a: any, b: any) =>
        Number((zoomVal ?? 13) >= b.visibleFromZoom) - Number((zoomVal ?? 13) >= a.visibleFromZoom)
        || (getSegmentDisplayScore(b) ?? -Infinity) - (getSegmentDisplayScore(a) ?? -Infinity));

      // 运行空间去重 (重合度 > 70% 过滤)，以防数据库里存有重叠路段导致前端重复渲染
      const uniqueSegments: any[] = [];
      for (const seg of formattedSegments) {
        let isDuplicate = false;
        for (const kept of uniqueSegments) {
          const overlap = Math.max(
            calculateOverlapRatio(seg.coordinates, kept.coordinates),
            calculateOverlapRatio(kept.coordinates, seg.coordinates)
          );
          if (overlap > 0.70) {
            isDuplicate = true;
            break;
          }
        }
        if (!isDuplicate) {
          uniqueSegments.push(seg);
          if (uniqueSegments.length >= 35) break;
        }
      }

      console.log(`🎯 [StravaController] Hit local MySQL DB. Returned ${uniqueSegments.length} unique segments (filtered from ${formattedSegments.length}).`);
      return res.status(200).json(uniqueSegments);
    }

    // 3. Fallback 兜底：如果本地缓存过少，自适应请求外部 API
    console.log(`⚠️ [StravaController] MySQL Cache Miss. Querying live API proxy...`);
    const liveSegments = (await exploreStravaSegments(south, west, north, east, zoomVal))
      .map(segment => ({ ...segment, stravaScore: null, visibleFromZoom: getSegmentVisibleFromZoom(segment) }));

    // 4. 异步 Lazy Load 写入 MySQL，保障主请求无阻塞秒返
    if (liveSegments.length > 0) {
      asyncUpsertSegmentsToMySql(liveSegments).catch(err => {
        console.error('[StravaController] Async upsert fallback segments failed:', err.message);
      });
    }

    return res.status(200).json(liveSegments);

  } catch (error: any) {
    console.error(`❌ [StravaController] MySQL query segments failed:`, error.message);
    return res.status(500).json({
      error: 'Failed to fetch Strava segments.',
      details: error.message
    });
  }
};

export async function getStravaSegmentDetail(req: Request, res: Response) {
  const rawId = req.params.id;
  const id = Number(rawId);
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id)) {
    return res.status(400).json({ error: '无效的路段 ID。' });
  }
  try {
    const detail = await getStoredOrFetchStravaSegmentDetail(id);
    res.set('Cache-Control', 'private, max-age=300');
    return res.json(detail);
  } catch (error) {
    const detailError = error instanceof StravaSegmentDetailError ? error : undefined;
    const status = detailError?.status;
    if (!detailError) {
      console.error('[StravaController] Segment detail storage failed:', error instanceof Error ? error.message : 'unknown error');
      return res.status(503).json({ error: '路段详情数据库暂时不可用，请稍后重试。' });
    }
    console.warn('[StravaController] Segment detail failed:', detailError?.reason || (status ? `upstream HTTP ${status}` : 'connection or credentials error'));
    if (detailError?.reason === 'application_inactive') return res.status(503).json({ error: 'Strava 应用当前未激活，暂时无法获取路段详情。请联系应用管理员检查 Strava API 应用状态。' });
    if (status === 401 || status === 403) return res.status(503).json({ error: 'Strava 授权或应用权限不可用，请联系应用管理员检查配置。' });
    if (status === 404) return res.status(404).json({ error: '未找到该路段或无权查看。' });
    if (status === 429) return res.status(429).json({ error: 'Strava 请求次数已达上限，请稍后重试。' });
    return res.status(502).json({ error: '暂时无法获取 Strava 路段详情，请稍后重试。' });
  }
}
