import axios from 'axios';
import { LatLng, decodePolyline } from '../utils/polyline';

let cachedAccessToken = '';
let tokenExpiresAt = 0; // Epoch timestamp in seconds
let nativeStatsDetailAccessDisabled = false;

export class StravaSegmentDetailError extends Error {
  constructor(message: string, public readonly status?: number, public readonly reason?: string) {
    super(message);
    this.name = 'StravaSegmentDetailError';
  }
}

export async function getStravaAccessToken(): Promise<string> {
  // If cachedAccessToken is not yet set, check if a direct STRAVA_ACCESS_TOKEN is configured in .env
  if (!cachedAccessToken && process.env.STRAVA_ACCESS_TOKEN) {
    cachedAccessToken = process.env.STRAVA_ACCESS_TOKEN.trim();
    // Default expiration to 6 hours from now if loaded from env directly
    tokenExpiresAt = Math.floor(Date.now() / 1000) + 21600;
    console.log(`[StravaService] Loaded STRAVA_ACCESS_TOKEN from .env: ${cachedAccessToken.substring(0, 6)}...${cachedAccessToken.substring(cachedAccessToken.length - 6)}. Expires at: ${new Date(tokenExpiresAt * 1000).toLocaleString()}`);
  }

  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  const refreshToken = process.env.STRAVA_REFRESH_TOKEN;

  // Check if token is still valid (using 5 minute safety buffer)
  const nowInSeconds = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && tokenExpiresAt > nowInSeconds + 300) {
    return cachedAccessToken;
  }

  // If we don't have refresh credentials but do have a cached access token, fall back to it
  if (!clientId || !clientSecret || !refreshToken) {
    if (cachedAccessToken) {
      console.warn(`[StravaService] Access token expired or not set, and refresh credentials are missing. Falling back to cached token.`);
      return cachedAccessToken;
    }
    throw new Error('Strava credentials (STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN) are not configured in .env file.');
  }

  console.log(`[StravaService] Access token expired or not set. Exchanging refresh token...`);

  const tokenUrl = 'https://www.strava.com/oauth/token';
  const payload = {
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  };

  console.log(`[StravaService] OAuth Token Refresh POST Request:`);
  console.log(`  - URL: ${tokenUrl}`);
  console.log('  - Credentials omitted from logs.');

  try {
    const response = await axios.post(tokenUrl, payload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (response.data && response.data.access_token) {
      cachedAccessToken = response.data.access_token;
      tokenExpiresAt = response.data.expires_at;
      if (response.data.refresh_token && response.data.refresh_token !== refreshToken) {
        process.env.STRAVA_REFRESH_TOKEN = response.data.refresh_token;
        console.warn('[StravaService] Strava returned a new refresh token. Update the configured secret before restarting this process.');
      }
      console.log(`[StravaService] Successfully refreshed access token! Expires at: ${new Date(tokenExpiresAt * 1000).toLocaleString()}`);
      return cachedAccessToken;
    } else {
      console.error(`[StravaService] Token refresh response did not contain access_token:`, response.data);
      throw new Error(`Failed to refresh Strava access token: ${JSON.stringify(response.data)}`);
    }
  } catch (error: any) {
    console.error(`[StravaService] Error exchanging refresh token:`);
    if (error.response) {
      console.error(`  - Status Code: ${error.response.status}`);
      console.error(`  - Headers:`, JSON.stringify(error.response.headers));
      console.error(`  - Response Body (error.response.data):`, JSON.stringify(error.response.data));
    } else {
      console.error(`  - Error Message: ${error.message}`);
    }
    throw error;
  }
}

export interface StravaSegment {
  id: number;
  name: string;
  distanceKm: number;
  avgGrade: number;
  climbCategory: number;
  startLatLng: [number, number];
  endLatLng: [number, number];
  coordinates: LatLng[];
  veloRoamScore: number;
  /** @deprecated Legacy API alias for veloRoamScore. */
  rawScore?: number;
  starCount: number | null;
  athleteCount: number | null;
  effortCount: number | null;
  stravaStatsUpdatedAt: string | null;
}

export interface StravaNativeStats {
  starCount: number | null;
  athleteCount: number | null;
  effortCount: number | null;
  stravaStatsUpdatedAt: string;
}

function toNullableCount(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

export function extractStravaNativeStats(segment: any): StravaNativeStats | null {
  const starCount = toNullableCount(segment?.star_count);
  const athleteCount = toNullableCount(segment?.athlete_count);
  const effortCount = toNullableCount(segment?.effort_count);

  if (starCount === null && athleteCount === null && effortCount === null) {
    return null;
  }

  return {
    starCount,
    athleteCount,
    effortCount,
    stravaStatsUpdatedAt: new Date().toISOString()
  };
}

export function normalizeStravaSegmentDetail(segmentId: number, segment: any, fetchedAt = new Date().toISOString()) {
  const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    id: segmentId, name: typeof segment.name === 'string' ? segment.name : null,
    distanceKm: number(segment.distance) === null ? null : segment.distance / 1000,
    avgGrade: number(segment.average_grade), maxGrade: number(segment.maximum_grade),
    elevationHigh: number(segment.elevation_high), elevationLow: number(segment.elevation_low),
    totalElevationGain: number(segment.total_elevation_gain), climbCategory: number(segment.climb_category),
    starCount: toNullableCount(segment.star_count), athleteCount: toNullableCount(segment.athlete_count),
    effortCount: toNullableCount(segment.effort_count),
    hazardous: typeof segment.hazardous === 'boolean' ? segment.hazardous : null,
    stravaStatsUpdatedAt: fetchedAt
  };
}

export type StravaResponseObserver = (headers: Record<string, unknown>, status: number) => void;

export async function fetchStravaSegmentRawDetail(segmentId: number, accessToken?: string, observe?: StravaResponseObserver): Promise<Record<string, any>> {
  try {
    const token = accessToken || await getStravaAccessToken();
    const response = await axios.get(`https://www.strava.com/api/v3/segments/${segmentId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: 10000
    });
    observe?.(response.headers, response.status);
    const segment = response.data;
    if (!segment || typeof segment !== 'object' || Array.isArray(segment) || String(segment.id) !== String(segmentId)) {
      throw new Error('Unexpected Strava segment response');
    }
    return segment;
  } catch (error: any) {
    const status = error.response?.status;
    if (error.response) observe?.(error.response.headers, status);
    const errors = Array.isArray(error.response?.data?.errors) ? error.response.data.errors : [];
    const inactive = errors.some((item: any) => item?.resource === 'Application' && item?.field === 'Status' && item?.code === 'Inactive');
    const reason = inactive ? 'application_inactive' : undefined;
    throw new StravaSegmentDetailError(`Strava segment detail unavailable${status ? ` (HTTP ${status})` : ''}${inactive ? ': application inactive' : ''}`, status, reason);
  }
}

export async function fetchStravaSegmentDetail(segmentId: number, accessToken?: string) {
  const segment = await fetchStravaSegmentRawDetail(segmentId, accessToken);
  return normalizeStravaSegmentDetail(segmentId, segment);
}

export async function fetchStravaSegmentNativeStats(segmentId: number, accessToken?: string): Promise<StravaNativeStats> {
  const detail = await fetchStravaSegmentDetail(segmentId, accessToken);
  return { starCount: detail.starCount, athleteCount: detail.athleteCount, effortCount: detail.effortCount, stravaStatsUpdatedAt: detail.stravaStatsUpdatedAt };
}

export function calculateVeloRoamSegmentScore(seg: any): number {
  let score = 0;

  // 1. Distance bonus (longer is preferred)
  const distKm = (seg.distance || 0) / 1000;
  score += distKm * 2; // 2 points per 1km

  // 2. Loop bonus (check if startLatLng and endLatLng are close < 150m)
  if (seg.start_latlng && seg.end_latlng) {
    const dLat = (seg.start_latlng[0] - seg.end_latlng[0]) * 111320;
    const dLng = (seg.start_latlng[1] - seg.end_latlng[1]) * 111320 * Math.cos(seg.start_latlng[0] * Math.PI / 180);
    const distStartEnd = Math.sqrt(dLat * dLat + dLng * dLng);
    if (distStartEnd < 150) {
      score += 15; // Major bonus for loops!
    }
  }

  // 3. Climbing / Clout bonus (avg grade has positive climbing value)
  if (seg.avg_grade && seg.avg_grade > 0) {
    score += seg.avg_grade * 3; // CHALLENGE APPEAL!
  }

  // 4. Climb category bonus (higher climbs are spectacular)
  if (seg.climb_category) {
    score += seg.climb_category * 5;
  }

  return score;
}

function getNativeStatsEnrichmentLimit(): number {
  const configured = Number(process.env.STRAVA_NATIVE_STATS_ENRICH_LIMIT ?? 3);
  if (!Number.isFinite(configured)) return 3;
  return Math.max(0, Math.min(10, Math.floor(configured)));
}

async function enrichSegmentsWithNativeStats(
  segments: StravaSegment[],
  accessToken: string
): Promise<void> {
  const limit = getNativeStatsEnrichmentLimit();
  if (limit === 0 || nativeStatsDetailAccessDisabled) return;

  const targets = segments
    .filter(segment => segment.starCount === null && segment.athleteCount === null && segment.effortCount === null)
    .sort((a, b) => b.veloRoamScore - a.veloRoamScore)
    .slice(0, limit);

  for (const segment of targets) {
    try {
      const stats = await fetchStravaSegmentNativeStats(segment.id, accessToken);
      segment.starCount = stats.starCount;
      segment.athleteCount = stats.athleteCount;
      segment.effortCount = stats.effortCount;
      segment.stravaStatsUpdatedAt = stats.stravaStatsUpdatedAt;
    } catch (error: any) {
      console.warn(`[StravaService] Native stats enrichment failed for segment ${segment.id}: ${error.message}`);
      if (error.status === 403) {
        nativeStatsDetailAccessDisabled = true;
        console.warn('[StravaService] Disabling native stats enrichment for this process after HTTP 403.');
        break;
      }
    }
  }
}

function calculateOverlapRatio(seg1: StravaSegment, seg2: StravaSegment): number {
  if (!seg1.coordinates || !seg2.coordinates || seg1.coordinates.length === 0 || seg2.coordinates.length === 0) {
    return 0;
  }

  let matchingPoints = 0;
  for (const p1 of seg1.coordinates) {
    let foundMatch = false;
    for (const p2 of seg2.coordinates) {
      // Direct fast coordinate approximation (within 45 meters)
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

  return matchingPoints / seg1.coordinates.length;
}

export async function exploreStravaSegments(
  south: number,
  west: number,
  north: number,
  east: number,
  zoom?: number
): Promise<StravaSegment[]> {
  try {
    const latSpan = Math.abs(north - south);
    const lngSpan = Math.abs(east - west);

    // Strava Segment Explore API restricts bounds to a maximum span of about 0.5 degrees.
    // If the user zooms out too far, we return empty results silently to avoid 400 Bad Request errors.
    if (latSpan > 0.5 || lngSpan > 0.5) {
      console.log(`[StravaService] Bounding box is too large (latSpan: ${latSpan.toFixed(4)}, lngSpan: ${lngSpan.toFixed(4)}). Skipping query to avoid Strava API bounds overflow.`);
      return [];
    }

    const accessToken = await getStravaAccessToken();
    const queries: Promise<any[]>[] = [];

    // 1. Zoom level grid subdivision query to increase route count and density (bypass Strava 10-count limit)
    // If zoom level is high (>= 13), subdivide into a 2x2 grid for up to 40 segments.
    const shouldSplitGrid = zoom && zoom >= 13;

    if (shouldSplitGrid) {
      console.log(`[StravaService] Zoom level is high (${zoom}). Splitting bounds into 2x2 grid to fetch up to 40 segments concurrently.`);
      const midLat = south + latSpan / 2;
      const midLng = west + lngSpan / 2;

      // Define 4 sub-boxes
      const subBoxes = [
        [south, west, midLat, midLng], // Bottom-Left
        [south, midLng, midLat, east], // Bottom-Right
        [midLat, west, north, midLng], // Top-Left
        [midLat, midLng, north, east]  // Top-Right
      ];

      for (const box of subBoxes) {
        const subBoundsStr = `${box[0]},${box[1]},${box[2]},${box[3]}`;
        const subUrl = `https://www.strava.com/api/v3/segments/explore?bounds=${subBoundsStr}&activity_type=riding`;
        queries.push(
          axios.get(subUrl, {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
          }).then(res => res.data?.segments || []).catch(err => {
            console.error(`[StravaService] Sub-grid segment query failed:`, err.message);
            return [];
          })
        );
      }
    } else {
      // Standard single query (up to 10 segments)
      const boundsStr = `${south},${west},${north},${east}`;
      const url = `https://www.strava.com/api/v3/segments/explore?bounds=${boundsStr}&activity_type=riding`;
      console.log(`[StravaService] Standard single box query (Zoom: ${zoom}). Fetching up to 10 segments.`);
      queries.push(
        axios.get(url, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
        }).then(res => res.data?.segments || []).catch(err => {
          console.error(`[StravaService] Single box segment query failed:`, err.message);
          return [];
        })
      );
    }

    const segmentsArrays = await Promise.all(queries);

    // 2. Flatten and deduplicate by raw segment ID
    const seenIds = new Set<number>();
    const rawSegments: any[] = [];
    for (const arr of segmentsArrays) {
      for (const seg of arr) {
        if (!seenIds.has(seg.id)) {
          seenIds.add(seg.id);
          rawSegments.push(seg);
        }
      }
    }

    console.log(`[StravaService] Merged segments count from all sub-grids: ${rawSegments.length}`);

    // 3. Map to the VeloRoam segment model. Explore does not expose Strava's
    // native popularity counts, so a small, rate-limited subset is enriched below.
    const decodedSegments: StravaSegment[] = rawSegments.map((seg: any) => {
      const decodedPoints = decodePolyline(seg.points);
      const veloRoamScore = calculateVeloRoamSegmentScore(seg);
      const nativeStats = extractStravaNativeStats(seg);
      return {
        id: seg.id,
        name: seg.name,
        distanceKm: parseFloat((seg.distance / 1000).toFixed(2)),
        avgGrade: parseFloat((seg.avg_grade || 0).toFixed(1)),
        climbCategory: Number(seg.climb_category || 0),
        startLatLng: seg.start_latlng,
        endLatLng: seg.end_latlng,
        coordinates: decodedPoints,
        veloRoamScore,
        // Keep rawScore during the frontend migration; it is not a Strava-native score.
        rawScore: veloRoamScore,
        starCount: nativeStats?.starCount ?? null,
        athleteCount: nativeStats?.athleteCount ?? null,
        effortCount: nativeStats?.effortCount ?? null,
        stravaStatsUpdatedAt: nativeStats?.stravaStatsUpdatedAt ?? null
      };
    });

    await enrichSegmentsWithNativeStats(decodedSegments, accessToken);

    // 4. Sort by the VeloRoam contextual score. Native counts remain separate
    // inputs so the recommendation weighting can evolve without losing raw data.
    decodedSegments.sort((a, b) => b.veloRoamScore - a.veloRoamScore);

    // 5. Greedy spatial deduplication (overlap > 70% removal)
    // Since the segments are pre-sorted in descending order of quality score,
    // this greedy check automatically keeps the best segment as the cluster representative
    // and throws away highly redundant/overlapping segments!
    const uniqueSegments: StravaSegment[] = [];
    for (const seg of decodedSegments) {
      let isDuplicate = false;
      for (const kept of uniqueSegments) {
        // Check overlap ratio in both directions (taking the maximum)
        const overlap = Math.max(calculateOverlapRatio(seg, kept), calculateOverlapRatio(kept, seg));
        if (overlap > 0.70) {
          isDuplicate = true;
          console.log(`[StravaService] Segment "${seg.name}" (ID:${seg.id}, Score:${seg.veloRoamScore.toFixed(1)}) overlaps ${Math.round(overlap * 100)}% with "${kept.name}" (ID:${kept.id}, Score:${kept.veloRoamScore.toFixed(1)}). Discarding duplicate in favor of higher score.`);
          break;
        }
      }
      if (!isDuplicate) {
        uniqueSegments.push(seg);
      }
    }

    console.log(`[StravaService] Finished processing. Raw: ${rawSegments.length}, After Spatial Deduplication: ${uniqueSegments.length}.`);

    // Return the top unique segments (cap at 40 to ensure extreme performance and no frontend lag)
    return uniqueSegments.slice(0, 40);
  } catch (error: any) {
    console.error(`[StravaService] Error exploring segments:`);
    if (error.response) {
      console.error(`  - Status Code: ${error.response.status}`);
      console.error(`  - Headers:`, JSON.stringify(error.response.headers));
      console.error(`  - Response Body (error.response.data):`, JSON.stringify(error.response.data));
    } else {
      console.error(`  - Error Message: ${error.message}`);
    }
    throw error;
  }
}
