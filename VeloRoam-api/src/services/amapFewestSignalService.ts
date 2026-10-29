import axios from 'axios';
import { LatLng, encodePolyline, gcj02ToWgs84, wgs84ToGcj02 } from '../utils/polyline';
import { fetchTrafficSignals } from './osmService';
import { RankedSignalRoute, SignalRouteCandidate, selectFewestSignalRoute } from './fewestSignalRanking';

function parseAmapRoute(path: any): SignalRouteCandidate | null {
  const distanceKm = Number(path.distance) / 1000;
  const durationMin = Math.round(Number(path.cost?.duration ?? path.duration ?? 0) / 60);
  if (!Number.isFinite(distanceKm) || distanceKm <= 0 || !Array.isArray(path.steps)) return null;

  const points: LatLng[] = [];
  for (const step of path.steps) {
    if (typeof step.polyline !== 'string') continue;
    for (const pair of step.polyline.split(';')) {
      const [lng, lat] = pair.split(',').map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const point = gcj02ToWgs84(lng, lat);
      const previous = points[points.length - 1];
      if (!previous || Math.abs(previous.lat - point.lat) > 1e-7 || Math.abs(previous.lng - point.lng) > 1e-7) {
        points.push(point);
      }
    }
  }
  if (points.length < 2) return null;
  return { distanceKm, durationMin, points, polyline: encodePolyline(points) };
}

export async function fetchAmapBicyclingCandidates(origin: LatLng, destination: LatLng): Promise<SignalRouteCandidate[]> {
  const key = process.env.AMAP_API_KEY;
  if (!key) throw new Error('AMAP_API_KEY is not configured.');

  const start = wgs84ToGcj02(origin.lng, origin.lat);
  const end = wgs84ToGcj02(destination.lng, destination.lat);
  const response = await axios.get('https://restapi.amap.com/v5/direction/bicycling', {
    params: {
      key,
      origin: `${start.lng.toFixed(6)},${start.lat.toFixed(6)}`,
      destination: `${end.lng.toFixed(6)},${end.lat.toFixed(6)}`,
      alternative_route: 3,
      show_fields: 'cost,polyline'
    },
    timeout: 12000
  });
  if (response.data?.status !== '1') {
    throw new Error(`AMap bicycling failed: ${response.data?.info || 'Unknown error'}`);
  }

  const paths = response.data?.route?.paths;
  const candidates = (Array.isArray(paths) ? paths : []).map(parseAmapRoute)
    .filter((route): route is SignalRouteCandidate => route !== null);
  if (candidates.length === 0) throw new Error('AMap returned no usable bicycling route');

  return candidates;
}

export async function planAmapFewestSignalRoute(origin: LatLng, destination: LatLng): Promise<RankedSignalRoute> {
  const candidates = await fetchAmapBicyclingCandidates(origin, destination);
  const signalResult = await fetchTrafficSignals(candidates.flatMap(route => route.points));
  const selected = selectFewestSignalRoute(candidates, signalResult.available ? signalResult.signals : null);
  if (!selected) throw new Error('No route remains within distance budget');
  return selected;
}
