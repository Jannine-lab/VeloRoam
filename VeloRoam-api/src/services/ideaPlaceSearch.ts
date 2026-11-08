import { query } from '../config/db';
import type { Candidate } from '../controllers/ideaController';
import { trajectoryDistanceKm } from './ideaRouteService';
import { attachSegmentTags } from './ideaTagPreferences';

const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');
const valid = (p: { lat: number; lng: number }) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

/** Name search never asserts that fuzzy matches are the same real-world place. */
export async function searchNamedPlaces(name: string, terms: unknown = []): Promise<Candidate[]> {
  const suffix = Array.from(name).length >= 4 ? Array.from(name).slice(-2).join('') : '';
  const names = [...new Set([name, suffix, ...(Array.isArray(terms) ? terms : [])].filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(v => v.length >= 2 && v.length <= 80))].slice(0, 4);
  if (!names.length) return [];
  const clauses = names.map(() => 'name LIKE ?').join(' OR ');
  const params = names.map(v => `%${escapeLike(v)}%`);
  const [points, segments] = await Promise.all([
    query(`SELECT id, name, category, lat, lng FROM hot_points WHERE status = 'active' AND (${clauses}) ORDER BY cyclist_score DESC LIMIT 50`, params),
    query(`SELECT CAST(s.id AS CHAR) AS id, s.name, s.distance_km AS recordedDistanceKm, s.raw_score AS score, s.start_lat AS lat, s.start_lng AS lng, ST_AsText(s.geom) AS geometry, d.average_grade AS averageGrade, d.total_elevation_gain_m AS elevationGainM, d.athlete_count AS athleteCount, d.effort_count AS effortCount, d.hazardous FROM strava_segments s LEFT JOIN strava_segment_details d ON d.segment_id = s.id WHERE (d.is_private IS NULL OR d.is_private = 0) AND (${names.map(() => 's.name LIKE ?').join(' OR ')}) ORDER BY s.raw_score DESC LIMIT 80`, params)
  ]);
  const pointItems: Candidate[] = points.rows.map((x: any) => ({ id: `point:${x.id}`, type: 'point', name: String(x.name), category: String(x.category), lat: Number(x.lat), lng: Number(x.lng) })).filter(valid);
  const segmentItems: Candidate[] = segments.rows.map((x: any) => {
    const body = String(x.geometry || '').match(/^LINESTRING\s*\((.*)\)$/i)?.[1] || '';
    const coordinates = body.split(',').map((pair: string) => { const [lng, lat] = pair.trim().split(/\s+/).map(Number); return { lat, lng }; }).filter(valid);
    return { id: `segment:${x.id}`, type: 'segment', name: String(x.name), lat: Number(x.lat), lng: Number(x.lng), coordinates,
      distanceKm: trajectoryDistanceKm(coordinates), recordedDistanceKm: x.recordedDistanceKm == null ? null : Number(x.recordedDistanceKm), score: x.score == null ? null : Number(x.score),
      averageGrade: x.averageGrade == null ? null : Number(x.averageGrade), elevationGainM: x.elevationGainM == null ? null : Number(x.elevationGainM),
      athleteCount: x.athleteCount == null ? null : Number(x.athleteCount), effortCount: x.effortCount == null ? null : Number(x.effortCount), hazardous: x.hazardous == null ? null : Boolean(x.hazardous) };
  }).filter((x: Candidate) => valid(x) && (x.coordinates?.length || 0) >= 2);
  const relevance = (candidate: Candidate) => {
    if (candidate.name === name) return 1000;
    if (candidate.name.includes(name)) return 500;
    return names.slice(1).reduce((score, term) => score + (candidate.name.includes(term) ? term.length * (name.endsWith(term) ? 3 : 1) : 0), 0);
  };
  return [...pointItems, ...await attachSegmentTags(segmentItems, query)].sort((a, b) => relevance(b) - relevance(a));
}
