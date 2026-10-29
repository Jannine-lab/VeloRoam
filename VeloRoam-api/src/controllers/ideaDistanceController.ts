import { Request, Response } from 'express';
import { query } from '../config/db';
import { recommendDistanceRoutes, NearbySegment } from '../services/ideaDistanceRecommendations';

export async function ideaDistanceRecommendations(req: Request, res: Response) {
  const origin = req.body?.origin;
  if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lng) || Math.abs(origin.lat) > 90 || Math.abs(origin.lng) > 180) return res.status(400).json({ error: '请先设置出发地点。' });
  try {
    const latitude = .7;
    const longitude = Math.min(1.5, latitude / Math.max(.15, Math.cos(origin.lat * Math.PI / 180)));
    const result = await query(`SELECT s.id, s.name, s.raw_score AS score, ST_AsText(s.geom) AS geometry
      FROM strava_segments s LEFT JOIN strava_segment_details d ON d.segment_id = s.id
      WHERE s.start_lat BETWEEN ? AND ? AND s.start_lng BETWEEN ? AND ?
        AND (d.hazardous IS NULL OR d.hazardous = 0) AND (d.is_private IS NULL OR d.is_private = 0)
      ORDER BY s.raw_score DESC LIMIT 3000`, [origin.lat - latitude, origin.lat + latitude, origin.lng - longitude, origin.lng + longitude]);
    const segments: NearbySegment[] = result.rows.map((row: any) => {
      const body = String(row.geometry || '').match(/^LINESTRING\s*\((.*)\)$/i)?.[1] || '';
      const coordinates = body.split(',').map((pair: string) => { const [lng, lat] = pair.trim().split(/\s+/).map(Number); return { lat, lng }; })
        .filter((point: any) => Number.isFinite(point.lat) && Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180);
      return { id: String(row.id), name: String(row.name), score: row.score == null ? null : Number(row.score), coordinates };
    }).filter((segment: NearbySegment) => segment.coordinates.length >= 2);
    const label = req.body?.originSource === 'manual' ? '所选起点' : req.body?.originSource === 'ip' ? 'IP 大致位置' : req.body?.originSource === 'gps-stale' ? '上次定位位置' : '当前位置';
    const recommendations = await recommendDistanceRoutes(origin, label, segments);
    return res.json({ recommendations });
  } catch (error: any) {
    console.error('[IdeaDistanceRecommendations] Request failed:', error.code || error.message);
    return res.status(502).json({ error: '路线推荐暂时不可用，请稍后重试。' });
  }
}
