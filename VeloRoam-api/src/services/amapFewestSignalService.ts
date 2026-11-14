import axios from 'axios';
import { LatLng, encodePolyline, gcj02ToWgs84, wgs84ToGcj02 } from '../utils/polyline';
import { fetchTrafficSignals } from './osmService';
import { RankedSignalRoute, SignalRouteCandidate, selectFewestSignalRoute } from './fewestSignalRanking';

export type AmapFailureCode = 'not_configured' | 'temporarily_unavailable' | 'rate_limited' | 'quota_exhausted' | 'outside_coverage' | 'distance_limit' | 'request_rejected' | 'no_route';
export class AmapBicyclingError extends Error {
  constructor(public readonly reason: AmapFailureCode, public readonly retryable = false) {
    super(`AMap bicycling: ${reason}`);
    this.name = 'AmapBicyclingError';
  }
}

/** Interpret provider status codes without including its response or request URL in logs. */
export function amapStatusError(infoCode: unknown): AmapBicyclingError {
  const code = String(infoCode || '');
  if (['20801', '20802'].includes(code)) return new AmapBicyclingError('no_route');
  if (code === '20803') return new AmapBicyclingError('distance_limit');
  if (['20800', '20011'].includes(code)) return new AmapBicyclingError('outside_coverage');
  if (['10003', '10044', '10045', '40000', '40002', '40003'].includes(code)) return new AmapBicyclingError('quota_exhausted');
  if (code === '10004') return new AmapBicyclingError('rate_limited');
  if (['10014', '10015', '10019', '10020', '10021', '10029'].includes(code)) return new AmapBicyclingError('rate_limited', true);
  if (['10016', '10017'].includes(code)) return new AmapBicyclingError('temporarily_unavailable', true);
  return new AmapBicyclingError('request_rejected');
}

/** Retry only transient transport failures; never retry invalid keys or a provider's no-route response. */
export async function requestBicyclingWithRetry<T>(request: () => Promise<T>, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await request(); } catch (error: any) {
      if (error instanceof AmapBicyclingError) {
        if (!error.retryable || attempt >= 1) throw error;
        await wait(350);
        continue;
      }
      const status = Number(error?.response?.status);
      const code = typeof error?.code === 'string' ? error.code : '';
      const transient = status === 429 || status >= 500 && status <= 599 ||
        ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_NETWORK'].includes(code);
      if (!transient) throw new AmapBicyclingError('request_rejected');
      if (attempt >= 1) throw new AmapBicyclingError(status === 429 ? 'rate_limited' : 'temporarily_unavailable');
      await wait(350);
    }
  }
}

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
  if (!key) throw new AmapBicyclingError('not_configured');

  const start = wgs84ToGcj02(origin.lng, origin.lat);
  const end = wgs84ToGcj02(destination.lng, destination.lat);
  const response = await requestBicyclingWithRetry(async () => {
    const result = await axios.get('https://restapi.amap.com/v5/direction/bicycling', {
      params: { key, origin: `${start.lng.toFixed(6)},${start.lat.toFixed(6)}`, destination: `${end.lng.toFixed(6)},${end.lat.toFixed(6)}`,
        alternative_route: 3, show_fields: 'cost,polyline' },
      timeout: 12000
    });
    if (result.data?.status !== '1') throw amapStatusError(result.data?.infocode);
    return result;
  });

  const paths = response.data?.route?.paths;
  const candidates = (Array.isArray(paths) ? paths : []).map(parseAmapRoute)
    .filter((route): route is SignalRouteCandidate => route !== null);
  if (candidates.length === 0) throw new AmapBicyclingError('no_route');

  return candidates;
}

export async function planAmapFewestSignalRoute(origin: LatLng, destination: LatLng): Promise<RankedSignalRoute> {
  const candidates = await fetchAmapBicyclingCandidates(origin, destination);
  const signalResult = await fetchTrafficSignals(candidates.flatMap(route => route.points));
  const selected = selectFewestSignalRoute(candidates, signalResult.available ? signalResult.signals : null);
  if (!selected) throw new Error('No route remains within distance budget');
  return selected;
}
