import { Request, Response } from 'express';
import { query } from '../config/db';
import { buildIdeaRoute } from '../services/ideaRouteService';

export async function planSegmentRoundTrip(req: Request, res: Response) {
  const origin = req.body?.origin;
  const segmentId = String(req.body?.segmentId || '').replace(/^segment:/, '');
  if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lng) || Math.abs(origin.lat) > 90 || Math.abs(origin.lng) > 180 || !/^[1-9]\d{0,19}$/.test(segmentId)) {
    return res.status(400).json({ error: '请提供当前位置和有效的路段。' });
  }
  try {
    const result = await query(`SELECT s.name, ST_AsText(s.geom) AS geometry FROM strava_segments s
      LEFT JOIN strava_segment_details d ON d.segment_id = s.id
      WHERE s.id = ? AND (d.is_private IS NULL OR d.is_private = 0) LIMIT 1`, [segmentId]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: '未找到可用路段。' });
    const body = String(row.geometry || '').match(/^LINESTRING\s*\((.*)\)$/i)?.[1];
    const coordinates = body ? body.split(',').map((pair: string) => {
      const [lng, lat] = pair.trim().split(/\s+/).map(Number); return { lat, lng };
    }) : [];
    if (coordinates.length < 2 || coordinates.some((point: { lat: number; lng: number }) => !Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180)) {
      return res.status(422).json({ error: '路段轨迹不完整，暂时无法规划。' });
    }
    const route = await buildIdeaRoute(origin, '当前位置', origin, '返回起点', [{ type: 'segment', name: String(row.name || '骑行路段'), coordinates }]);
    return res.json({ route });
  } catch (error: any) {
    console.error('[SegmentRoundTrip] Request failed:', error.code || error.message);
    return res.status(502).json({ error: '往返路线规划暂时不可用，请重试。' });
  }
}
