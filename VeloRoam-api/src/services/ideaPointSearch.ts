import { z } from 'zod';
import { queryLookup as query } from '../config/db';
import type { Candidate } from '../controllers/ideaController';

export const pointSearchSchema = z.object({
  area: z.string().trim().min(1).max(80).nullable().optional(),
  radiusKm: z.number().finite().min(1).max(50),
  nameTerms: z.array(z.string().trim().min(1).max(32).refine(term => term.length > 1 || /\p{Script=Han}/u.test(term))).max(7).optional(),
  categories: z.array(z.enum(['scenic', 'supply', 'rest', 'service', 'start_end'])).max(5).optional(),
  sortBy: z.enum(['score', 'nearest']).optional(), limit: z.number().int().min(1).max(20).optional(), offset: z.number().int().min(0).max(200).optional()
}).strict();
export type PointSearchInput = z.infer<typeof pointSearchSchema>;

/** Search active local points, using values as parameters and treating related terms as cues, not facts. */
export async function searchPoints(center: { lat: number; lng: number }, input: PointSearchInput, execute: typeof query = query) {
  input = pointSearchSchema.parse(input);
  if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng) || Math.abs(center.lat) > 90 || Math.abs(center.lng) > 180) throw new Error('invalid_center');
  const lat = input.radiusKm / 111 + .002;
  const lng = Math.min(180, lat / Math.max(.01, Math.cos((Math.abs(center.lat) + lat) * Math.PI / 180)));
  const clauses = ["status = 'active'", 'lat BETWEEN ? AND ?', 'lng BETWEEN ? AND ?', 'ST_Distance_Sphere(POINT(lng, lat), POINT(?, ?)) <= ?'];
  const params: any[] = [Math.max(-90, center.lat - lat), Math.min(90, center.lat + lat), Math.max(-180, center.lng - lng), Math.min(180, center.lng + lng), center.lng, center.lat, input.radiusKm * 1000];
  const terms = [...new Set((input.nameTerms || []).map(v => v.trim()).filter(Boolean))];
  if (terms.length) { clauses.push(`(${terms.map(() => 'name LIKE ?').join(' OR ')})`); params.push(...terms.map(term => `%${term.replace(/[\\%_]/g, '\\$&')}%`)); }
  const categories = [...new Set(input.categories || [])];
  if (categories.length) { clauses.push(`category IN (${categories.map(() => '?').join(',')})`); params.push(...categories); }
  const from = `FROM hot_points WHERE ${clauses.join(' AND ')}`;
  const sort = input.sortBy || 'score'; const order = sort === 'nearest' ? 'ST_Distance_Sphere(POINT(lng, lat), POINT(?, ?)) ASC' : 'cyclist_score DESC';
  const limit = input.limit || 10, offset = input.offset || 0;
  const [count, rows] = await Promise.all([
    execute(`SELECT /*+ MAX_EXECUTION_TIME(5000) */ COUNT(*) AS total ${from}`, params),
    execute(`SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(id AS CHAR) AS id, name, category, lat, lng, address, district_name AS districtName, cyclist_score AS score ${from} ORDER BY ${order}, id ASC LIMIT ? OFFSET ?`, [...params, ...(sort === 'nearest' ? [center.lng, center.lat] : []), limit, offset])
  ]);
  const candidates: Candidate[] = rows.rows.flatMap((row: any) => {
    const lat = Number(row.lat), lng = Number(row.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [{ id: `point:${row.id}`, type: 'point' as const, name: String(row.name), category: String(row.category), lat, lng, address: typeof row.address === 'string' ? row.address : undefined, districtName: typeof row.districtName === 'string' ? row.districtName : undefined, score: row.score == null ? null : Number(row.score) }] : [];
  });
  const total = Number(count.rows[0]?.total || 0);
  return { candidates, total, limit, offset, hasMore: offset + limit < total, notes: ['范围按点位至搜索中心的直线距离计算，不代表行政区边界或骑行绕行距离。', '名称关联词仅用于检索，不代表地点属性已确认。', '搜索范围为数据库中状态为 active 的地点，未覆盖全部地图地点。'] };
}
