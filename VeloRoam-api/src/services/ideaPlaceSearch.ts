import { query } from '../config/db';
import type { Candidate } from '../controllers/ideaController';
import { trajectoryDistanceKm } from './ideaRouteService';
import { attachSegmentTags } from './ideaTagPreferences';
import { getDistanceMeters } from '../utils/polyline';

const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');
const valid = (p: { lat: number; lng: number }) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
type Query = typeof query;

export function relatedSearchTerms(queryText: string, idea: string, suggestions: unknown): string[] {
  const source = `${queryText} ${idea}`;
  const raw = [queryText, ...(Array.isArray(suggestions) ? suggestions : [])];
  const seen = new Set<string>();
  return raw.flatMap(value => {
    if (typeof value !== 'string') return [];
    const term = value.trim().replace(/\s+/g, ' ');
    const length = Array.from(term).length;
    if (!length || length > 32 || !/^[\p{Script=Han}a-zA-Z0-9\s-]+$/u.test(term) ||
        (length === 1 && (!/\p{Script=Han}/u.test(term) || !source.includes(term)))) return [];
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) return [];
    seen.add(key); return [term];
  }).slice(0, 7);
}

async function mapRows(points: any[], segments: any[], execute: Query): Promise<Candidate[]> {
  const pointItems: Candidate[] = points.map((x: any) => ({ id: `point:${x.id}`, type: 'point' as const, name: String(x.name), category: String(x.category), lat: Number(x.lat), lng: Number(x.lng) })).filter(valid);
  const segmentItems: Candidate[] = segments.map((x: any) => {
    const body = String(x.geometry || '').match(/^LINESTRING\s*\((.*)\)$/i)?.[1] || '';
    const coordinates = body.split(',').map((pair: string) => { const [lng, lat] = pair.trim().split(/\s+/).map(Number); return { lat, lng }; }).filter(valid);
    return { id: `segment:${x.id}`, type: 'segment' as const, name: String(x.name), lat: Number(x.lat), lng: Number(x.lng), coordinates,
      distanceKm: trajectoryDistanceKm(coordinates), recordedDistanceKm: x.recordedDistanceKm == null ? null : Number(x.recordedDistanceKm), score: x.score == null ? null : Number(x.score),
      averageGrade: x.averageGrade == null ? null : Number(x.averageGrade), elevationGainM: x.elevationGainM == null ? null : Number(x.elevationGainM),
      athleteCount: x.athleteCount == null ? null : Number(x.athleteCount), effortCount: x.effortCount == null ? null : Number(x.effortCount), hazardous: x.hazardous == null ? null : Boolean(x.hazardous) };
  }).filter((x: Candidate) => valid(x) && (x.coordinates?.length || 0) >= 2);
  return [...pointItems, ...await attachSegmentTags(segmentItems, execute)];
}

const segmentFields = `CAST(s.id AS CHAR) AS id, s.name, s.distance_km AS recordedDistanceKm, s.raw_score AS score, s.start_lat AS lat, s.start_lng AS lng, ST_AsText(s.geom) AS geometry, d.average_grade AS averageGrade, d.total_elevation_gain_m AS elevationGainM, d.athlete_count AS athleteCount, d.effort_count AS effortCount, d.hazardous`;

/** Re-read a selected result by stable ID and enforce current public/active visibility. */
export async function findCandidateById(id: string, execute: Query = query): Promise<Candidate | null> {
  const match = /^(point|segment):([1-9]\d*)$/.exec(id);
  if (!match) return null;
  if (match[1] === 'point') {
    const result = await execute(`SELECT id, name, category, lat, lng FROM hot_points WHERE id = ? AND status = 'active' LIMIT 1`, [match[2]]);
    return (await mapRows(result.rows, [], execute))[0] || null;
  }
  const result = await execute(`SELECT ${segmentFields} FROM strava_segments s LEFT JOIN strava_segment_details d ON d.segment_id = s.id WHERE s.id = ? AND (d.is_private IS NULL OR d.is_private = 0) LIMIT 1`, [match[2]]);
  const candidate = (await mapRows([], result.rows, execute))[0];
  return candidate && candidate.hazardous !== true ? candidate : null;
}

/** Name search never asserts that fuzzy matches are the same real-world place. */
export async function searchNamedPlaces(name: string, terms: unknown = [], execute: Query = query): Promise<Candidate[]> {
  const suffix = Array.from(name).length >= 4 ? Array.from(name).slice(-2).join('') : '';
  const names = [...new Set([name, suffix, ...(Array.isArray(terms) ? terms : [])].filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(v => v.length >= 2 && v.length <= 80))].slice(0, 4);
  if (!names.length) return [];
  const clauses = names.map(() => 'name LIKE ?').join(' OR ');
  const params = names.map(v => `%${escapeLike(v)}%`);
  // Prioritize the full name before limiting rows; a broad suffix can match thousands of unrelated records.
  const rankedParams = [...params, name.trim(), `%${escapeLike(name.trim())}%`];
  const [points, segments] = await Promise.all([
    execute(`SELECT id, name, category, lat, lng FROM hot_points WHERE status = 'active' AND (${clauses}) ORDER BY CASE WHEN name = ? THEN 0 WHEN name LIKE ? THEN 1 ELSE 2 END, cyclist_score DESC LIMIT 50`, rankedParams),
    execute(`SELECT ${segmentFields} FROM strava_segments s LEFT JOIN strava_segment_details d ON d.segment_id = s.id WHERE (d.is_private IS NULL OR d.is_private = 0) AND (${names.map(() => 's.name LIKE ?').join(' OR ')}) ORDER BY CASE WHEN s.name = ? THEN 0 WHEN s.name LIKE ? THEN 1 ELSE 2 END, s.raw_score DESC LIMIT 80`, rankedParams)
  ]);
  const candidates = await mapRows(points.rows, segments.rows, execute);
  const relevance = (candidate: Candidate) => {
    if (candidate.name === name) return 1000;
    if (candidate.name.includes(name)) return 500;
    return names.slice(1).reduce((score, term) => score + (candidate.name.includes(term) ? term.length * (name.endsWith(term) ? 3 : 1) : 0), 0);
  };
  return candidates.sort((a, b) => relevance(b) - relevance(a));
}

/** Related terms are suggestions, never verified aliases; bound all broad queries geographically. */
export async function searchRelatedPlaces(center: { lat: number; lng: number }, terms: string[], execute: Query = query): Promise<Candidate[]> {
  if (!valid(center)) return [];
  const latitude = 50 / 111.2;
  const longitude = Math.min(180, latitude / Math.max(.15, Math.cos(center.lat * Math.PI / 180)));
  const bounds = [center.lat - latitude, center.lat + latitude, center.lng - longitude, center.lng + longitude];
  const batches = await Promise.all(terms.slice(0, 7).map(async term => {
    const params = [...bounds, `%${escapeLike(term)}%`];
    return Promise.all([
      execute(`SELECT id, name, category, lat, lng FROM hot_points WHERE status = 'active' AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? AND name LIKE ? ORDER BY cyclist_score DESC LIMIT 20`, params),
      execute(`SELECT ${segmentFields} FROM strava_segments s LEFT JOIN strava_segment_details d ON d.segment_id = s.id WHERE s.start_lat BETWEEN ? AND ? AND s.start_lng BETWEEN ? AND ? AND (d.is_private IS NULL OR d.is_private = 0) AND s.name LIKE ? ORDER BY s.raw_score DESC LIMIT 20`, params)
    ]);
  }));
  const candidates = await mapRows(batches.flatMap(pair => pair[0].rows), batches.flatMap(pair => pair[1].rows), execute);
  const ids = new Set<string>();
  return candidates.filter(candidate => {
    if (candidate.hazardous === true || ids.has(candidate.id) || getDistanceMeters(center, candidate) > 50000) return false;
    ids.add(candidate.id); return true;
  });
}
