import { Request, Response } from 'express';
import { planRouteService } from '../services/googleMapsService';
import { planAmapFewestSignalRoute } from '../services/amapFewestSignalService';
import { buildIdeaRoute, RouteStop } from '../services/ideaRouteService';
import { query } from '../config/db';
import { parseWktLineString, wgs84ToGcj02 } from '../utils/polyline';

interface LatLng {
  lat: number;
  lng: number;
}

interface CyclingPreferences {
  supplyType?: string;
  supplyDistance?: number;
  autoLoopback?: boolean;
}

interface PlanRouteRequest {
  origin: LatLng;
  destination: LatLng;
  waypoints?: LatLng[];
  preferences?: CyclingPreferences;
}

export const planRoute = async (req: Request, res: Response) => {
  try {
    const { origin, destination, waypoints, preferences } = req.body as PlanRouteRequest;

    // Validate request
    if (!origin || typeof origin.lat !== 'number' || typeof origin.lng !== 'number') {
      return res.status(400).json({ error: 'Missing or invalid origin coordinates.' });
    }
    if (!destination || typeof destination.lat !== 'number' || typeof destination.lng !== 'number') {
      return res.status(400).json({ error: 'Missing or invalid destination coordinates.' });
    }

    if (waypoints && !Array.isArray(waypoints)) {
      return res.status(400).json({ error: 'Waypoints must be an array of coordinates.' });
    }

    console.log(`[RouteController] Received route request:`, {
      origin,
      destination,
      waypointsCount: waypoints?.length || 0,
      hasPreferences: !!preferences
    });

    const result = await planRouteService(origin, destination, waypoints || [], preferences);
    
    return res.status(200).json(result);
  } catch (error: any) {
    console.error(`[RouteController] Error planning route:`, error.message);
    return res.status(500).json({
      error: 'An internal error occurred while planning the route.',
      details: error.message
    });
  }
};

const validPoint = (point: any): point is LatLng => point && Number.isFinite(point.lat) &&
  Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;

export const planFewestSignals = async (req: Request, res: Response) => {
  const { origin, destination } = req.body || {};
  if (!validPoint(origin) || !validPoint(destination)) {
    return res.status(400).json({ error: 'Missing or invalid origin/destination coordinates.' });
  }

  try {
    const route = await planAmapFewestSignalRoute(origin, destination);
    return res.status(200).json({
      polyline: route.polyline,
      navigationCoordinates: {
        origin: wgs84ToGcj02(origin.lng, origin.lat),
        destination: wgs84ToGcj02(destination.lng, destination.lat)
      },
      distanceKm: route.distanceKm,
      durationMin: route.durationMin,
      trafficLightsCount: route.trafficLightsCount,
      baselineDistanceKm: route.baselineDistanceKm,
      detourPercent: route.detourPercent,
      candidateCount: route.candidateCount,
      signalDataSource: route.trafficLightsCount === null ? 'unavailable' : 'osm_estimate'
    });
  } catch (error: any) {
    console.error('[RouteController] Fewest-signals planning failed:', error.message);
    return res.status(502).json({ error: 'Unable to plan a bicycling route right now.' });
  }
};

export async function planRouteWithStops(req: Request, res: Response) {
  const { origin, destination, stops } = req.body || {};
  const validStop = (stop: any) => stop?.type === 'segment'
    ? typeof stop.id === 'string' && /^[1-9]\d{0,19}$/.test(stop.id)
    : stop?.type === 'point' && validPoint(stop.point);
  if (!validPoint(origin) || !validPoint(destination) || !Array.isArray(stops) ||
      !stops.length || stops.length > 5 || !stops.every(validStop)) {
    return res.status(400).json({ error: '请提供有效的起终点和 1 至 5 个途经点。' });
  }

  const label = (value: unknown, fallback: string) => typeof value === 'string' ? value.trim().slice(0, 120) || fallback : fallback;
  try {
    const ids = [...new Set(stops.filter(stop => stop.type === 'segment').map(stop => stop.id))];
    const segments = new Map<string, RouteStop>();
    if (ids.length) {
      const { rows } = await query(`SELECT CAST(s.id AS CHAR) AS id, s.name, ST_AsText(s.geom) AS geometry
        FROM strava_segments s LEFT JOIN strava_segment_details d ON d.segment_id = s.id
        WHERE s.id IN (?) AND (d.is_private IS NULL OR d.is_private = 0)`, [ids]);
      for (const row of rows) {
        const coordinates = parseWktLineString(row.geometry);
        if (coordinates.length >= 2 && coordinates.every(validPoint)) {
          segments.set(row.id, { type: 'segment', name: row.name, coordinates });
        }
      }
      if (segments.size !== ids.length) return res.status(422).json({ error: '有途经路段不可用，请移除后重试。' });
    }
    const orderedStops: RouteStop[] = stops.map(stop => stop.type === 'segment' ? segments.get(stop.id)! : {
      type: 'point', name: label(stop.name, '途经地点'), coordinates: [stop.point]
    });
    const route = await buildIdeaRoute(origin, label(req.body.originName, '起点'), destination,
      label(req.body.destinationName, '终点'), orderedStops);
    return res.json(route);
  } catch (error) {
    console.error('[RouteController] Waypoint planning failed:', error instanceof Error ? error.message : 'unknown error');
    return res.status(502).json({ error: '暂时无法按这个顺序连接路线，请调整途经点或重试。' });
  }
}
