import axios from 'axios';
import { LatLng, decodePolyline } from '../utils/polyline';

let cachedAccessToken = '';
let tokenExpiresAt = 0; // Epoch timestamp in seconds

async function getStravaAccessToken(): Promise<string> {
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
  console.log(`  - Payload (Redacted):`, {
    client_id: clientId,
    client_secret: clientSecret ? `${clientSecret.substring(0, 4)}...${clientSecret.substring(clientSecret.length - 4)}` : undefined,
    grant_type: 'refresh_token',
    refresh_token: refreshToken ? `${refreshToken.substring(0, 4)}...${refreshToken.substring(refreshToken.length - 4)}` : undefined
  });

  try {
    const response = await axios.post(tokenUrl, payload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (response.data && response.data.access_token) {
      cachedAccessToken = response.data.access_token;
      tokenExpiresAt = response.data.expires_at;
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
  startLatLng: [number, number];
  endLatLng: [number, number];
  coordinates: LatLng[];
}

function calculateSegmentScore(seg: any): number {
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
    // If zoom level is high (>= 14) and the viewport is detailed, subdivide into 2x2 grid for up to 40 concurrent segments!
    const shouldSplitGrid = zoom && zoom >= 14;

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

    // 3. Map to rich StravaSegment structure, computing raw score for popularity, loops, and climbing challenge
    const decodedSegments: StravaSegment[] = rawSegments.map((seg: any) => {
      const decodedPoints = decodePolyline(seg.points);
      return {
        id: seg.id,
        name: seg.name,
        distanceKm: parseFloat((seg.distance / 1000).toFixed(2)),
        avgGrade: parseFloat((seg.avg_grade || 0).toFixed(1)),
        startLatLng: seg.start_latlng,
        endLatLng: seg.end_latlng,
        coordinates: decodedPoints,
        // Inject computed quality score for sorting
        rawScore: calculateSegmentScore(seg)
      } as any;
    });

    // 4. Sort segments by calculated score in descending order
    decodedSegments.sort((a: any, b: any) => b.rawScore - a.rawScore);

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
          console.log(`[StravaService] Segment "${seg.name}" (ID:${seg.id}, Score:${seg.rawScore.toFixed(1)}) overlaps ${Math.round(overlap * 100)}% with "${kept.name}" (ID:${kept.id}, Score:${kept.rawScore.toFixed(1)}). Discarding duplicate in favor of higher score.`);
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
