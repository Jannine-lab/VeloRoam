import { z } from 'zod';
import { queryLookup as query } from '../config/db';
import { ROUTE_TAGS } from './ideaIntent';
import { mapRows } from './ideaPlaceSearch';

const nonnegative = z.number().finite().min(0);
const optionalNumber = nonnegative.nullable().optional();
export const segmentSearchSchema = z.object({
  area: z.string().trim().min(1).max(80).nullable().optional(),
  radiusKm: z.number().finite().min(1).max(50),
  nameTerms: z.array(z.string().trim().min(1).max(32).refine(term => term.length > 1 || /\p{Script=Han}/u.test(term))).max(6).optional(),
  minKm: optionalNumber, maxKm: optionalNumber,
  minGrade: z.number().finite().min(-100).max(100).nullable().optional(), maxGrade: z.number().finite().min(-100).max(100).nullable().optional(),
  minElevationM: optionalNumber, maxElevationM: optionalNumber,
  minScore: optionalNumber, minAthletes: optionalNumber, minStars: optionalNumber, minEfforts: optionalNumber,
  requiredTags: z.array(z.enum(ROUTE_TAGS)).max(6).optional(), avoidTags: z.array(z.enum(ROUTE_TAGS)).max(6).optional(),
  sortBy: z.enum(['score', 'athletes', 'stars', 'efforts', 'distance', 'elevation', 'nearest']).optional(),
  direction: z.enum(['asc', 'desc']).optional(), limit: z.number().int().min(1).max(20).optional(), offset: z.number().int().min(0).max(200).optional()
}).strict().refine(v => [[v.minKm, v.maxKm], [v.minGrade, v.maxGrade], [v.minElevationM, v.maxElevationM]].every(([min, max]) => min == null || max == null || min <= max));
export type SegmentSearchInput = z.infer<typeof segmentSearchSchema>;
type Center = { lat: number; lng: number };
type Query = typeof query;

/** The backend owns every SQL identifier and operator; model-supplied values are parameters. */
export async function searchSegments(center: Center, input: SegmentSearchInput, execute: Query = query) {
  input = segmentSearchSchema.parse(input);
  if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng) || Math.abs(center.lat) > 90 || Math.abs(center.lng) > 180) throw new Error('invalid_center');
  const lat = input.radiusKm / 111 + .002;
  const lng = Math.min(180, lat / Math.max(.01, Math.cos((Math.abs(center.lat) + lat) * Math.PI / 180)));
  const clauses = ['s.start_lat BETWEEN ? AND ?', 's.start_lng BETWEEN ? AND ?', '(d.is_private IS NULL OR d.is_private = 0)', '(d.hazardous IS NULL OR d.hazardous = 0)', 'ST_NumPoints(s.geom) >= 2', 'ST_Distance_Sphere(POINT(s.start_lng, s.start_lat), POINT(?, ?)) <= ?'];
  const params: any[] = [Math.max(-90, center.lat-lat), Math.min(90, center.lat+lat), Math.max(-180, center.lng-lng), Math.min(180, center.lng+lng), center.lng, center.lat, input.radiusKm * 1000];
  const terms = [...new Set((input.nameTerms || []).map(term => term.trim()).filter(Boolean))];
  if (terms.length) { clauses.push(`(${terms.map(() => 's.name LIKE ?').join(' OR ')})`); params.push(...terms.map(term => `%${term.replace(/[\\%_]/g, '\\$&')}%`)); }
  const numeric: Array<[unknown, string, string]> = [
    [input.minKm, 's.distance_km', '>='], [input.maxKm, 's.distance_km', '<='],
    [input.minGrade, 'd.average_grade', '>='], [input.maxGrade, 'd.average_grade', '<='],
    [input.minElevationM, 'd.total_elevation_gain_m', '>='], [input.maxElevationM, 'd.total_elevation_gain_m', '<='],
    [input.minScore, 'COALESCE(s.strava_score, s.raw_score)', '>='],
    [input.minAthletes, 'COALESCE(d.athlete_count, s.athlete_count)', '>='], [input.minStars, 'COALESCE(d.star_count, s.star_count)', '>='], [input.minEfforts, 'COALESCE(d.effort_count, s.effort_count)', '>=']
  ];
  for (const [value, column, op] of numeric) if (value != null) { clauses.push(`${column} ${op} ?`); params.push(value); }
  for (const tag of new Set(input.requiredTags || [])) { clauses.push("EXISTS (SELECT 1 FROM strava_segment_tag_evaluations t WHERE t.segment_id = s.id AND t.tag = ? AND t.status = 'matched')"); params.push(tag); }
  for (const tag of new Set(input.avoidTags || [])) { clauses.push("NOT EXISTS (SELECT 1 FROM strava_segment_tag_evaluations t WHERE t.segment_id = s.id AND t.tag = ? AND t.status = 'matched')"); params.push(tag); }
  const from = `FROM strava_segments s LEFT JOIN strava_segment_details d ON d.segment_id = s.id WHERE ${clauses.join(' AND ')}`;
  const fields = `CAST(s.id AS CHAR) AS id, s.name, s.distance_km AS recordedDistanceKm, COALESCE(s.strava_score, s.raw_score) AS score, s.start_lat AS lat, s.start_lng AS lng, ST_AsText(s.geom) AS geometry, d.average_grade AS averageGrade, d.total_elevation_gain_m AS elevationGainM, COALESCE(d.athlete_count, s.athlete_count) AS athleteCount, COALESCE(d.star_count, s.star_count) AS starCount, COALESCE(d.effort_count, s.effort_count) AS effortCount, d.hazardous`;
  const sorts = { score: 'COALESCE(s.strava_score, s.raw_score)', athletes: 'COALESCE(d.athlete_count, s.athlete_count)', stars: 'COALESCE(d.star_count, s.star_count)', efforts: 'COALESCE(d.effort_count, s.effort_count)', distance: 's.distance_km', elevation: 'd.total_elevation_gain_m', nearest: 'ST_Distance_Sphere(POINT(s.start_lng, s.start_lat), POINT(?, ?))' } as const;
  const sortBy = input.sortBy || 'score'; const column = sorts[sortBy];
  const direction = input.direction || (sortBy === 'nearest' ? 'asc' : 'desc');
  const limit = input.limit || 10; const offset = input.offset || 0;
  const sortParams = sortBy === 'nearest' ? [center.lng, center.lat] : [];
  const [counts, rows] = await Promise.all([
    execute(`SELECT /*+ MAX_EXECUTION_TIME(5000) */ COUNT(*) AS total ${from}`, params),
    execute(`SELECT /*+ MAX_EXECUTION_TIME(5000) */ ${fields} ${from} ORDER BY (${column}) IS NULL ASC, ${column} ${direction.toUpperCase()}, s.id ASC LIMIT ? OFFSET ?`, [...params, ...sortParams, ...sortParams, limit, offset])
  ]);
  const candidates = await mapRows([], rows.rows, execute);
  const total = Number(counts.rows[0]?.total || 0);
  return { candidates, total, limit, offset, hasMore: offset + limit < total, sortBy, direction,
    notes: ['距离筛选使用数据库记录里程；展示的轨迹里程可能不同。', '以路段起点到搜索中心的直线距离筛选，不代表行政区边界或骑行距离。', '缺失的数值不会满足数值筛选；避让标签未知不等于已核实安全。', '名称关联词仅用于检索，不代表地点或骑行体验已证实。'] };
}
