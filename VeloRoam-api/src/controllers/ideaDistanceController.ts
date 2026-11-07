import { Request, Response } from 'express';
import { query } from '../config/db';
import { recommendDistanceRoutes, NearbySegment } from '../services/ideaDistanceRecommendations';

export async function ideaDistanceRecommendations(req: Request, res: Response) {
  console.info('[IdeaDistanceRecommendations] Request received');
  const origin = req.body?.origin;
  if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lng) || Math.abs(origin.lat) > 90 || Math.abs(origin.lng) > 180) return res.status(400).json({ error: '请先设置出发地点。' });
  const stream = (req.get('accept') || '').includes('text/event-stream');
  if (stream) {
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
  }
  const send = (event: string, data: unknown) => {
    if (stream && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  try {
    send('progress', { stage: '正在查找附近路段' });
    const latitude = .7;
    const longitude = Math.min(1.5, latitude / Math.max(.15, Math.cos(origin.lat * Math.PI / 180)));
    const result = await query(`SELECT s.id, s.name, s.raw_score AS score, s.strava_score, s.distance_km,
      COALESCE(d.average_grade, s.avg_grade) AS average_grade, d.maximum_grade, d.total_elevation_gain_m,
      d.elevation_low_m, d.elevation_high_m, COALESCE(d.climb_category, s.climb_category) AS climb_category,
      d.city, d.state, d.country, COALESCE(d.star_count, s.star_count) AS star_count,
      COALESCE(d.athlete_count, s.athlete_count) AS athlete_count, COALESCE(d.effort_count, s.effort_count) AS effort_count,
      ST_AsText(s.geom) AS geometry
      FROM strava_segments s LEFT JOIN strava_segment_details d ON d.segment_id = s.id
      WHERE s.start_lat BETWEEN ? AND ? AND s.start_lng BETWEEN ? AND ?
        AND (d.hazardous IS NULL OR d.hazardous = 0) AND (d.is_private IS NULL OR d.is_private = 0)
      ORDER BY s.raw_score DESC LIMIT 3000`, [origin.lat - latitude, origin.lat + latitude, origin.lng - longitude, origin.lng + longitude]);
    const segments: NearbySegment[] = result.rows.map((row: any) => {
      const body = String(row.geometry || '').match(/^LINESTRING\s*\((.*)\)$/i)?.[1] || '';
      const coordinates = body.split(',').map((pair: string) => { const [lng, lat] = pair.trim().split(/\s+/).map(Number); return { lat, lng }; })
        .filter((point: any) => Number.isFinite(point.lat) && Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180);
      const numberOrNull = (value: unknown) => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
      return { id: String(row.id), name: String(row.name), score: numberOrNull(row.score), coordinates,
        detail: { id: String(row.id), recordedDistanceKm: numberOrNull(row.distance_km), averageGrade: numberOrNull(row.average_grade),
          maximumGrade: numberOrNull(row.maximum_grade), elevationGainM: numberOrNull(row.total_elevation_gain_m),
          elevationLowM: numberOrNull(row.elevation_low_m), elevationHighM: numberOrNull(row.elevation_high_m),
          climbCategory: numberOrNull(row.climb_category), city: row.city || null, state: row.state || null, country: row.country || null,
          starCount: numberOrNull(row.star_count), athleteCount: numberOrNull(row.athlete_count), effortCount: numberOrNull(row.effort_count),
          stravaScore: numberOrNull(row.strava_score) } };
    }).filter((segment: NearbySegment) => segment.coordinates.length >= 2);
    const label = req.body?.originSource === 'manual' ? '所选起点' : req.body?.originSource === 'ip' ? 'IP 大致位置' : req.body?.originSource === 'gps-stale' ? '上次定位位置' : '当前位置';
    const recommendations = await recommendDistanceRoutes(origin, label, segments, undefined, stage => send('progress', { stage }));
    if (stream) { send('result', { recommendations }); return res.end(); }
    return res.json({ recommendations });
  } catch (error: any) {
    console.error('[IdeaDistanceRecommendations] Request failed:', error.code || error.message);
    if (stream) { send('error', { error: '路线推荐暂时不可用，请稍后重试。' }); return res.end(); }
    return res.status(502).json({ error: '路线推荐暂时不可用，请稍后重试。' });
  }
}
