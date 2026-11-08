import { Request, Response } from 'express';
import { generateAutonomousRoute } from '../services/ideaAutonomousGenerator';
import { query } from '../config/db';
import { RouteStop } from '../services/ideaRouteService';
import { LatLng } from '../utils/polyline';

export function allowLocalDebug(req: Request): boolean {
  if (process.env.ENABLE_ROUTE_DEBUG !== 'true') return false;
  const address = req.socket.remoteAddress || '';
  if (!['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(address)) return false;
  const origin = req.get('origin');
  if (!origin) return true;
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname); } catch { return false; }
}
const valid = (value: any): value is LatLng => value && typeof value.lat === 'number' && typeof value.lng === 'number' && Number.isFinite(value.lat) && Number.isFinite(value.lng) && Math.abs(value.lat) <= 85 && Math.abs(value.lng) <= 180;

export async function routeGeneratorDebug(req: Request, res: Response) {
  if (!allowLocalDebug(req)) return res.status(404).json({ error: 'Not found' });
  const { start, focus, targetKm, segmentId, pointId, pointOrder } = req.body || {};
  if (!valid(start) || (focus != null && !valid(focus)) || typeof targetKm !== 'number' || !Number.isFinite(targetKm) || targetKm < 5 || targetKm > 200) {
    return res.status(400).json({ error: '请输入有效坐标与 5～200 公里的目标距离。' });
  }
  if (segmentId != null && (typeof segmentId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(segmentId))) return res.status(400).json({ error: '路段 ID 必须是正整数。' });
  if (pointId != null && (typeof pointId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(pointId))) return res.status(400).json({ error: '点位 ID 必须是正整数。' });
  if (pointOrder != null && pointOrder !== 'before' && pointOrder !== 'after') return res.status(400).json({ error: '途经顺序无效。' });
  if (!process.env.AMAP_API_KEY) return res.status(503).json({ error: '未配置骑行导航服务。' });
  try {
    let fixedSegment: RouteStop | null = null;
    if (segmentId) {
      const result = await query("SELECT s.name, ST_AsText(s.geom) AS geometry FROM strava_segments s LEFT JOIN strava_segment_details d ON d.segment_id = s.id WHERE s.id = ? AND (d.is_private IS NULL OR d.is_private = 0) AND (d.hazardous IS NULL OR d.hazardous = 0) LIMIT 1", [segmentId]);
      const row = result.rows[0];
      if (!row) return res.status(404).json({ error: '未找到可用的公开路段。' });
      const text = String(row.geometry || '').match(/^LINESTRING\s*\((.*)\)$/i)?.[1] || '';
      const coordinates = text.split(',').map((part: string) => { const [lng, lat] = part.trim().split(/\s+/).map(Number); return { lat, lng }; }).filter(valid);
      if (coordinates.length < 2) return res.status(422).json({ error: '此路段没有有效的轨迹。' });
      fixedSegment = { type: 'segment', name: String(row.name), coordinates, detail: { id: `segment:${segmentId}`, averageGrade: null, elevationGainM: null, athleteCount: null, effortCount: null, hazardous: null, recordedDistanceKm: null } };
    }
    let fixedPoint: RouteStop | null = null;
    if (pointId) {
      const result = await query("SELECT name, lat, lng FROM hot_points WHERE id = ? AND status = 'active' LIMIT 1", [pointId]);
      const row = result.rows[0];
      const point = row && { lat: Number(row.lat), lng: Number(row.lng) };
      if (!valid(point)) return res.status(404).json({ error: '未找到可用的活跃点位。' });
      fixedPoint = { type: 'point', name: String(row.name), coordinates: [point] };
    }
    const fixedStops = [fixedSegment, fixedPoint].filter((stop): stop is RouteStop => stop !== null);
    if (fixedPoint && fixedSegment && pointOrder === 'before') fixedStops.reverse();
    const bounds = { targetKm, minKm: targetKm * .9, maxKm: targetKm * 1.1, stopMinutes: 0 };
    const result = await generateAutonomousRoute({ start, end: start, focus, bounds, targetKm, fixedSegment, fixedStops });
    return res.json({ start, focus: focus || null, segment: fixedSegment ? { id: segmentId, name: fixedSegment.name } : null, point: fixedPoint ? { id: pointId, name: fixedPoint.name } : null, requiredOrder: fixedStops.map(stop => ({ name: stop.name, type: stop.type })), bounds, ...result });
  } catch {
    return res.status(502).json({ error: '候选路线生成失败，请查看后端服务状态。' });
  }
}
