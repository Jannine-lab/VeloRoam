import { query } from '../config/db';
import { fetchStravaSegmentRawDetail, normalizeStravaSegmentDetail } from './stravaService';

type RawDetail = Record<string, any>;
const pending = new Map<number, Promise<ReturnType<typeof normalizeStravaSegmentDetail>>>();
const numberOrNull = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const textOrNull = (value: unknown): string | null => typeof value === 'string' ? value : null;
const boolOrNull = (value: unknown): number | null => typeof value === 'boolean' ? Number(value) : null;
const dateOrNull = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

async function loadOrFetch(segmentId: number) {
  const result = await query('SELECT raw_detail, fetched_at FROM strava_segment_details WHERE segment_id = ?', [segmentId]);
  if (result.rows.length) {
    const row = result.rows[0];
    const raw = typeof row.raw_detail === 'string' ? JSON.parse(row.raw_detail) : row.raw_detail;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || String(raw.id) !== String(segmentId)) {
      throw new Error('Invalid stored Strava segment detail');
    }
    const fetchedAt = new Date(row.fetched_at);
    if (Number.isNaN(fetchedAt.getTime())) throw new Error('Invalid Strava detail fetch time');
    return normalizeStravaSegmentDetail(segmentId, raw, fetchedAt.toISOString());
  }

  const d: RawDetail = await fetchStravaSegmentRawDetail(segmentId);
  await query(`INSERT INTO strava_segment_details
    (segment_id, name, activity_type, distance_m, average_grade, maximum_grade, elevation_high_m,
     elevation_low_m, total_elevation_gain_m, climb_category, city, state, country, is_private,
     hazardous, star_count, athlete_count, effort_count, strava_created_at, strava_updated_at, raw_detail, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE raw_detail=VALUES(raw_detail), fetched_at=VALUES(fetched_at),
     name=VALUES(name), activity_type=VALUES(activity_type), distance_m=VALUES(distance_m),
     average_grade=VALUES(average_grade), maximum_grade=VALUES(maximum_grade), elevation_high_m=VALUES(elevation_high_m),
     elevation_low_m=VALUES(elevation_low_m), total_elevation_gain_m=VALUES(total_elevation_gain_m),
     climb_category=VALUES(climb_category), city=VALUES(city), state=VALUES(state), country=VALUES(country),
     is_private=VALUES(is_private), hazardous=VALUES(hazardous), star_count=VALUES(star_count),
     athlete_count=VALUES(athlete_count), effort_count=VALUES(effort_count),
     strava_created_at=VALUES(strava_created_at), strava_updated_at=VALUES(strava_updated_at)`,
    [segmentId, textOrNull(d.name), textOrNull(d.activity_type), numberOrNull(d.distance), numberOrNull(d.average_grade),
     numberOrNull(d.maximum_grade), numberOrNull(d.elevation_high), numberOrNull(d.elevation_low),
     numberOrNull(d.total_elevation_gain), numberOrNull(d.climb_category), textOrNull(d.city), textOrNull(d.state),
     textOrNull(d.country), boolOrNull(d.private), boolOrNull(d.hazardous), numberOrNull(d.star_count),
     numberOrNull(d.athlete_count), numberOrNull(d.effort_count), dateOrNull(d.created_at), dateOrNull(d.updated_at), JSON.stringify(d)]);
  return normalizeStravaSegmentDetail(segmentId, d);
}

export function getStoredOrFetchStravaSegmentDetail(segmentId: number) {
  const existing = pending.get(segmentId);
  if (existing) return existing;
  const request = loadOrFetch(segmentId).finally(() => { pending.delete(segmentId); });
  pending.set(segmentId, request);
  return request;
}
