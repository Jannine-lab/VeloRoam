import 'dotenv/config';
import axios from 'axios';
import { initDatabase, pool, query } from '../config/db';
import {
  HotPointCategory,
  PoiCategoryQuery,
  SHANGHAI_DISTRICTS,
  SHANGHAI_POI_CATEGORY_MAPPINGS,
  ShanghaiDistrict
} from '../config/shanghaiPoiCategories';
import { gcj02ToWgs84 } from '../utils/polyline';

interface AmapPoi {
  id?: string;
  name?: string;
  type?: string;
  typecode?: string;
  location?: string;
  address?: string | unknown[];
  adcode?: string;
  adname?: string;
  business_area?: string | unknown[];
  biz_ext?: {
    rating?: string;
    cost?: string;
  };
  photos?: Array<{
    title?: string;
    url?: string;
  }>;
  [key: string]: any;
}

interface NormalizedHotPoint {
  amapPoiId: string;
  name: string;
  category: HotPointCategory;
  amapType: string;
  amapTypeCode: string;
  lat: number;
  lng: number;
  gcjLat: number;
  gcjLng: number;
  address: string;
  districtAdcode: string;
  districtName: string;
  businessArea: string;
  tags: string[];
  photos: Array<{ title?: string; url?: string }>;
  rawPayload: AmapPoi;
  popularityScore: number;
  cyclistScore: number;
  routeRelevanceScore: number;
  confidenceScore: number;
}

const amapApiKey = process.env.AMAP_API_KEY || '';
const requestDelayMs = parseInt(process.env.AMAP_HOT_POINT_REQUEST_DELAY_MS || '500', 10);
const maxPages = parseInt(process.env.AMAP_HOT_POINT_MAX_PAGES || '3', 10);
const pageSize = Math.min(parseInt(process.env.AMAP_HOT_POINT_PAGE_SIZE || '25', 10), 25);
const segmentLinkRadiusM = parseInt(process.env.HOT_POINT_SEGMENT_LINK_RADIUS_M || '1500', 10);
const maxSegmentLinksPerPoint = parseInt(process.env.HOT_POINT_SEGMENT_LINK_LIMIT || '3', 10);
const crawlerIntervalHours = parseFloat(process.env.AMAP_HOT_POINT_CRAWLER_INTERVAL_HOURS || '24');
const skipSchemaInit = process.env.HOT_POINT_SKIP_SCHEMA_INIT !== 'false';
const dryRun = process.env.HOT_POINT_DRY_RUN === 'true';
let hotPointCrawlerTimer: NodeJS.Timeout | null = null;
let hotPointCrawlerRunning = false;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeText(value: any): string {
  if (Array.isArray(value)) return value.filter(Boolean).join(',');
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function parseAmapLocation(location?: string): { gcjLng: number; gcjLat: number } | null {
  if (!location) return null;
  const [lngStr, latStr] = location.split(',');
  const gcjLng = parseFloat(lngStr);
  const gcjLat = parseFloat(latStr);
  if (Number.isNaN(gcjLng) || Number.isNaN(gcjLat)) return null;
  return { gcjLng, gcjLat };
}

function parseRating(poi: AmapPoi): number {
  const rating = parseFloat(poi.biz_ext?.rating || '');
  return Number.isNaN(rating) ? 0 : rating;
}

function uniqueTags(tags: string[]): string[] {
  return Array.from(new Set(tags.filter(Boolean)));
}

function inferTags(poi: AmapPoi): string[] {
  const text = `${poi.name || ''} ${poi.type || ''}`.toLowerCase();
  const tags: string[] = [];

  if (/公园|绿地|绿道|湿地|滨江|森林|步道/.test(text)) tags.push('scenic');
  if (/咖啡|便利店|超市|餐饮|面包|轻食|饮用水/.test(text)) tags.push('supply');
  if (/厕所|洗手间|卫生间|休息|游客中心/.test(text)) tags.push('rest');
  if (/自行车|骑行|修车|维修|打气|非机动车/.test(text)) tags.push('bike_friendly');
  if (/入口|驿站|集合|广场/.test(text)) tags.push('start_end_candidate');

  return tags;
}

function calculateScores(poi: AmapPoi, categoryQuery: PoiCategoryQuery, page: number, indexInPage: number) {
  const rankBonus = Math.max(0, 22 - (page - 1) * 4 - indexInPage * 0.7);
  const photoBonus = Math.min(8, (poi.photos?.length || 0) * 2);
  const businessBonus = normalizeText(poi.business_area) ? 4 : 0;
  const rating = parseRating(poi);
  const ratingBonus = rating > 0 ? clamp((rating - 3.5) * 8, 0, 8) : 0;

  const text = `${poi.name || ''} ${poi.type || ''}`;
  let cyclistKeywordBonus = 0;
  if (/自行车|骑行|绿道|滨江|公园|步道/.test(text)) cyclistKeywordBonus += 10;
  if (/厕所|便利店|咖啡|修车|打气|驿站/.test(text)) cyclistKeywordBonus += 6;

  const popularityScore = clamp(
    categoryQuery.basePopularity + rankBonus + photoBonus + businessBonus + ratingBonus
  );
  const cyclistScore = clamp(
    categoryQuery.baseCyclist + rankBonus * 0.35 + cyclistKeywordBonus + categoryQuery.baseService * 0.08
  );
  const routeRelevanceScore = clamp(
    cyclistScore * 0.62 + popularityScore * 0.26 + categoryQuery.baseService * 0.12
  );
  const confidenceScore = clamp(
    52 +
      (poi.location ? 16 : 0) +
      (poi.typecode ? 8 : 0) +
      (normalizeText(poi.address) ? 5 : 0) +
      (poi.photos?.length ? 5 : 0) +
      (rating > 0 ? 4 : 0)
  );

  return {
    popularityScore: parseFloat(popularityScore.toFixed(2)),
    cyclistScore: parseFloat(cyclistScore.toFixed(2)),
    routeRelevanceScore: parseFloat(routeRelevanceScore.toFixed(2)),
    confidenceScore: parseFloat(confidenceScore.toFixed(2))
  };
}

function normalizePoi(
  poi: AmapPoi,
  category: HotPointCategory,
  categoryQuery: PoiCategoryQuery,
  fallbackDistrict: ShanghaiDistrict,
  page: number,
  indexInPage: number
): NormalizedHotPoint | null {
  const parsedLocation = parseAmapLocation(poi.location);
  if (!parsedLocation || !poi.name) return null;

  const wgs = gcj02ToWgs84(parsedLocation.gcjLng, parsedLocation.gcjLat);
  const tags = uniqueTags([...categoryQuery.tags, ...inferTags(poi)]);
  const scores = calculateScores(poi, categoryQuery, page, indexInPage);
  const amapPoiId = poi.id || `amap_fallback_${poi.name}_${poi.location}`.replace(/\s+/g, '_');

  return {
    amapPoiId,
    name: normalizeText(poi.name),
    category,
    amapType: normalizeText(poi.type),
    amapTypeCode: normalizeText(poi.typecode),
    lat: parseFloat(wgs.lat.toFixed(7)),
    lng: parseFloat(wgs.lng.toFixed(7)),
    gcjLat: parseFloat(parsedLocation.gcjLat.toFixed(7)),
    gcjLng: parseFloat(parsedLocation.gcjLng.toFixed(7)),
    address: normalizeText(poi.address),
    districtAdcode: normalizeText(poi.adcode) || fallbackDistrict.adcode,
    districtName: normalizeText(poi.adname) || fallbackDistrict.name,
    businessArea: normalizeText(poi.business_area),
    tags,
    photos: Array.isArray(poi.photos) ? poi.photos.slice(0, 5) : [],
    rawPayload: poi,
    ...scores
  };
}

function selectedDistricts(): ShanghaiDistrict[] {
  const envValue = process.env.AMAP_HOT_POINT_DISTRICTS;
  if (!envValue) return SHANGHAI_DISTRICTS;

  const wanted = new Set(envValue.split(',').map(item => item.trim()).filter(Boolean));
  return SHANGHAI_DISTRICTS.filter(district => wanted.has(district.name) || wanted.has(district.adcode));
}

function selectedMappings() {
  const envValue = process.env.AMAP_HOT_POINT_CATEGORIES;
  if (!envValue) return SHANGHAI_POI_CATEGORY_MAPPINGS;

  const wanted = new Set(envValue.split(',').map(item => item.trim()).filter(Boolean));
  return SHANGHAI_POI_CATEGORY_MAPPINGS.filter(mapping => wanted.has(mapping.category));
}

async function fetchAmapPois(
  district: ShanghaiDistrict,
  categoryQuery: PoiCategoryQuery,
  page: number
): Promise<{ pois: AmapPoi[]; count: number }> {
  const response = await axios.get('https://restapi.amap.com/v3/place/text', {
    params: {
      key: amapApiKey,
      keywords: categoryQuery.keywords,
      types: categoryQuery.types,
      city: district.adcode,
      citylimit: true,
      offset: pageSize,
      page,
      extensions: 'all',
      sortrule: 'weight'
    },
    timeout: 15000
  });

  const data = response.data;
  if (data.status !== '1') {
    throw new Error(`AMap POI request failed: infocode=${data.infocode}, info=${data.info}`);
  }

  return {
    pois: Array.isArray(data.pois) ? data.pois : [],
    count: parseInt(data.count || '0', 10) || 0
  };
}

async function upsertHotPoint(point: NormalizedHotPoint): Promise<number | null> {
  if (dryRun) {
    console.log(`[HotPointCrawler] DRY_RUN ${point.name} (${point.category}) ${point.lng},${point.lat}`);
    return null;
  }

  const pointWkt = `POINT(${point.lng} ${point.lat})`;
  const upsertSql = `
    INSERT INTO hot_points (
      amap_poi_id, name, category, amap_type, amap_type_code,
      lat, lng, gcj_lat, gcj_lng, geom,
      address, district_adcode, district_name, business_area,
      tags, photos, raw_payload,
      popularity_score, cyclist_score, route_relevance_score, confidence_score,
      source, status, source_updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ST_GeomFromText(?, 4326),
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      'amap', 'active', CURRENT_TIMESTAMP
    )
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      category = IF(VALUES(cyclist_score) >= cyclist_score, VALUES(category), category),
      amap_type = VALUES(amap_type),
      amap_type_code = VALUES(amap_type_code),
      lat = VALUES(lat),
      lng = VALUES(lng),
      gcj_lat = VALUES(gcj_lat),
      gcj_lng = VALUES(gcj_lng),
      geom = VALUES(geom),
      address = VALUES(address),
      district_adcode = VALUES(district_adcode),
      district_name = VALUES(district_name),
      business_area = VALUES(business_area),
      tags = IF(VALUES(cyclist_score) >= cyclist_score, VALUES(tags), tags),
      photos = IF(JSON_LENGTH(VALUES(photos)) > JSON_LENGTH(COALESCE(photos, JSON_ARRAY())), VALUES(photos), photos),
      raw_payload = VALUES(raw_payload),
      popularity_score = GREATEST(popularity_score, VALUES(popularity_score)),
      cyclist_score = GREATEST(cyclist_score, VALUES(cyclist_score)),
      route_relevance_score = GREATEST(route_relevance_score, VALUES(route_relevance_score)),
      confidence_score = GREATEST(confidence_score, VALUES(confidence_score)),
      status = 'active',
      source_updated_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP;
  `;

  await query(upsertSql, [
    point.amapPoiId,
    point.name,
    point.category,
    point.amapType,
    point.amapTypeCode,
    point.lat,
    point.lng,
    point.gcjLat,
    point.gcjLng,
    pointWkt,
    point.address,
    point.districtAdcode,
    point.districtName,
    point.businessArea,
    JSON.stringify(point.tags),
    JSON.stringify(point.photos),
    JSON.stringify(point.rawPayload),
    point.popularityScore,
    point.cyclistScore,
    point.routeRelevanceScore,
    point.confidenceScore
  ]);

  const { rows } = await query('SELECT id FROM hot_points WHERE amap_poi_id = ? LIMIT 1', [point.amapPoiId]);
  return rows[0]?.id ? Number(rows[0].id) : null;
}

async function refreshSegmentLinks(hotPointIds: number[]) {
  if (dryRun || hotPointIds.length === 0) return;

  const uniqueIds = Array.from(new Set(hotPointIds));
  console.log(`[HotPointCrawler] Refreshing nearby Strava segment links for ${uniqueIds.length} hot points...`);

  for (const hotPointId of uniqueIds) {
    const { rows: pointRows } = await query(
      'SELECT id, lat, lng, popularity_score, cyclist_score FROM hot_points WHERE id = ? LIMIT 1',
      [hotPointId]
    );
    const point = pointRows[0];
    if (!point) continue;

    const lat = Number(point.lat);
    const lng = Number(point.lng);
    const latDelta = segmentLinkRadiusM / 111320;
    const lngDelta = segmentLinkRadiusM / (111320 * Math.cos(lat * Math.PI / 180));
    const pointWkt = `POINT(${lng} ${lat})`;

    const { rows: segmentRows } = await query(
      `
        SELECT
          id,
          raw_score,
          LEAST(
            ST_Distance_Sphere(ST_GeomFromText(?, 4326), ST_GeomFromText(CONCAT('POINT(', start_lng, ' ', start_lat, ')'), 4326)),
            ST_Distance_Sphere(ST_GeomFromText(?, 4326), ST_GeomFromText(CONCAT('POINT(', end_lng, ' ', end_lat, ')'), 4326))
          ) AS distance_m,
          CASE
            WHEN ST_Distance_Sphere(ST_GeomFromText(?, 4326), ST_GeomFromText(CONCAT('POINT(', start_lng, ' ', start_lat, ')'), 4326))
              <= ST_Distance_Sphere(ST_GeomFromText(?, 4326), ST_GeomFromText(CONCAT('POINT(', end_lng, ' ', end_lat, ')'), 4326))
            THEN 'nearby_start'
            ELSE 'nearby_end'
          END AS relation_type
        FROM strava_segments
        WHERE
          (
            start_lat BETWEEN ? AND ?
            AND start_lng BETWEEN ? AND ?
          )
          OR
          (
            end_lat BETWEEN ? AND ?
            AND end_lng BETWEEN ? AND ?
          )
        HAVING distance_m <= ?
        ORDER BY distance_m ASC, raw_score DESC
        LIMIT ?;
      `,
      [
        pointWkt,
        pointWkt,
        pointWkt,
        pointWkt,
        lat - latDelta,
        lat + latDelta,
        lng - lngDelta,
        lng + lngDelta,
        lat - latDelta,
        lat + latDelta,
        lng - lngDelta,
        lng + lngDelta,
        segmentLinkRadiusM,
        maxSegmentLinksPerPoint
      ]
    );

    await query('DELETE FROM hot_point_segment_links WHERE hot_point_id = ?', [hotPointId]);

    for (const segment of segmentRows) {
      await query(
        `
          INSERT INTO hot_point_segment_links (
            hot_point_id, strava_segment_id, distance_m, segment_score, relation_type
          ) VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            distance_m = VALUES(distance_m),
            segment_score = VALUES(segment_score),
            relation_type = VALUES(relation_type),
            updated_at = CURRENT_TIMESTAMP;
        `,
        [
          hotPointId,
          Number(segment.id),
          parseFloat(Number(segment.distance_m).toFixed(2)),
          parseFloat(Number(segment.raw_score || 0).toFixed(2)),
          segment.relation_type
        ]
      );
    }

    const distances = segmentRows.map((row: any) => Number(row.distance_m));
    const scores = segmentRows.map((row: any) => Number(row.raw_score || 0));
    const nearest = distances.length ? Math.min(...distances) : null;
    const bestScore = scores.length ? Math.max(...scores) : null;
    const avgScore = scores.length ? scores.reduce((sum: number, score: number) => sum + score, 0) / scores.length : null;

    const proximityBonus = nearest !== null ? clamp((segmentLinkRadiusM - nearest) / segmentLinkRadiusM * 10, 0, 10) : 0;
    const segmentScoreBonus = bestScore !== null ? clamp(bestScore * 0.45, 0, 18) : 0;
    const currentCyclistScore = Number(point.cyclist_score);
    const popularityScore = Number(point.popularity_score);
    const enhancedCyclistScore = clamp(Math.max(
      currentCyclistScore,
      currentCyclistScore * 0.72 + segmentScoreBonus + proximityBonus + 18
    ));
    const routeRelevanceScore = clamp(
      enhancedCyclistScore * 0.58 + popularityScore * 0.24 + segmentScoreBonus + proximityBonus
    );

    await query(
      `
        UPDATE hot_points
        SET
          nearby_segment_count = ?,
          nearest_segment_distance_m = ?,
          best_nearby_segment_score = ?,
          avg_nearby_segment_score = ?,
          cyclist_score = ?,
          route_relevance_score = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?;
      `,
      [
        segmentRows.length,
        nearest === null ? null : parseFloat(nearest.toFixed(2)),
        bestScore === null ? null : parseFloat(bestScore.toFixed(2)),
        avgScore === null ? null : parseFloat(avgScore.toFixed(2)),
        parseFloat(enhancedCyclistScore.toFixed(2)),
        parseFloat(routeRelevanceScore.toFixed(2)),
        hotPointId
      ]
    );
  }
}

export async function crawlShanghaiHotPoints() {
  if (!amapApiKey) {
    throw new Error('AMAP_API_KEY is not configured. Add it to VeloRoam-api/.env before running this crawler.');
  }

  if (!skipSchemaInit) {
    await initDatabase();
  } else {
    console.log('[HotPointCrawler] HOT_POINT_SKIP_SCHEMA_INIT=true. Skipping schema bootstrap.');
  }

  const districts = selectedDistricts();
  const mappings = selectedMappings();
  const touchedHotPointIds: number[] = [];
  let fetchedCount = 0;
  let normalizedCount = 0;
  let upsertedCount = 0;

  console.log(`[HotPointCrawler] Starting Shanghai hot point crawl.`);
  console.log(`[HotPointCrawler] Districts=${districts.map(d => d.name).join(', ')}`);
  console.log(`[HotPointCrawler] Categories=${mappings.map(m => m.category).join(', ')}`);
  console.log(`[HotPointCrawler] maxPages=${maxPages}, pageSize=${pageSize}, dryRun=${dryRun}`);

  for (const district of districts) {
    for (const mapping of mappings) {
      for (const categoryQuery of mapping.queries) {
        for (let page = 1; page <= maxPages; page++) {
          console.log(
            `[HotPointCrawler] Fetching ${district.name}/${mapping.displayName}/page=${page}: ${categoryQuery.keywords}`
          );

          try {
            const { pois, count } = await fetchAmapPois(district, categoryQuery, page);
            fetchedCount += pois.length;

            for (let index = 0; index < pois.length; index++) {
              const normalized = normalizePoi(pois[index], mapping.category, categoryQuery, district, page, index);
              if (!normalized) continue;

              normalizedCount++;
              const hotPointId = await upsertHotPoint(normalized);
              if (hotPointId) {
                touchedHotPointIds.push(hotPointId);
                upsertedCount++;
              }
            }

            if (count <= page * pageSize || pois.length === 0) break;
          } catch (error: any) {
            console.error(
              `[HotPointCrawler] Failed ${district.name}/${mapping.category}/page=${page}: ${error.message}`
            );
            break;
          }

          await sleep(requestDelayMs);
        }
      }
    }
  }

  await refreshSegmentLinks(touchedHotPointIds);

  console.log(`[HotPointCrawler] Finished.`);
  console.log(`[HotPointCrawler] fetched=${fetchedCount}, normalized=${normalizedCount}, upserted=${upsertedCount}`);
}

async function runCrawlerCycle() {
  if (hotPointCrawlerRunning) {
    console.warn('[HotPointCrawler] Previous crawl is still running. Skipping this cycle.');
    return;
  }

  hotPointCrawlerRunning = true;
  try {
    await crawlShanghaiHotPoints();
  } catch (error: any) {
    console.error('[HotPointCrawler] Cycle failed:', error.message);
  } finally {
    hotPointCrawlerRunning = false;
  }
}

export function startAmapHotPointCrawler() {
  if (hotPointCrawlerTimer) {
    console.warn('[HotPointCrawler] Scheduler is already running.');
    return;
  }

  const intervalMs = Math.max(crawlerIntervalHours, 1) * 60 * 60 * 1000;
  console.log(`[HotPointCrawler] Scheduler enabled. First run starts now, interval=${crawlerIntervalHours}h.`);
  runCrawlerCycle();
  hotPointCrawlerTimer = setInterval(runCrawlerCycle, intervalMs);
}

export function stopAmapHotPointCrawler() {
  if (hotPointCrawlerTimer) {
    clearInterval(hotPointCrawlerTimer);
    hotPointCrawlerTimer = null;
    console.log('[HotPointCrawler] Scheduler stopped.');
  }
}

if (require.main === module) {
  crawlShanghaiHotPoints()
    .catch(error => {
      console.error('[HotPointCrawler] Fatal error:', error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
