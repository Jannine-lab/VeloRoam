import { Request, Response } from 'express';
import { query } from '../config/db';

const VALID_CATEGORIES = new Set(['scenic', 'supply', 'rest', 'service', 'start_end']);

type HotPointDisplayMode = 'hidden' | 'heatmap' | 'points';

export const getScenicMapPoints = async (req: Request, res: Response) => {
  const bounds = typeof req.query.bounds === 'string' ? req.query.bounds.split(',').map(Number) : [];
  const zoom = Number(req.query.zoom);
  if (bounds.length !== 4 || bounds.some(value => !Number.isFinite(value)) ||
      !Number.isFinite(zoom) || zoom < 0 || zoom > 22 ||
      bounds[0] < -90 || bounds[2] > 90 || bounds[1] < -180 || bounds[3] > 180 ||
      bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
    return res.status(400).json({ error: 'Valid bounds and zoom are required.' });
  }
  if (zoom < 12) return res.json([]);
  const minRating = zoom < 13 ? 4.8 : zoom < 14 ? 4.6 : zoom < 15 ? 4.4 : zoom < 16 ? 4 : 0;
  try {
    const ratingText = "JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.biz_ext.rating'))";
    const rating = `CASE WHEN ${ratingText} REGEXP '^[0-9]+([.][0-9]+)?$'
      AND CAST(${ratingText} AS DECIMAL(8,3)) > 0 AND CAST(${ratingText} AS DECIMAL(8,3)) <= 5
      THEN CAST(${ratingText} AS DECIMAL(8,3)) ELSE NULL END`;
    const { rows } = await query(`SELECT * FROM (SELECT id, name, lat, lng, address, district_name,
      amap_type, amap_type_code, ${rating} AS rating FROM hot_points
      WHERE status = 'active' AND source = 'amap' AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
      AND (FIND_IN_SET('110206', REPLACE(amap_type_code, '|', ',')) > 0
        OR FIND_IN_SET('110205', REPLACE(amap_type_code, '|', ',')) > 0
        OR FIND_IN_SET('110105', REPLACE(amap_type_code, '|', ',')) > 0
        OR FIND_IN_SET('110101', REPLACE(amap_type_code, '|', ',')) > 0
        OR FIND_IN_SET('110000', REPLACE(amap_type_code, '|', ',')) > 0)) points
      WHERE rating >= ? OR (? = 0 AND rating IS NULL)
      ORDER BY rating IS NULL, rating DESC, id LIMIT 500`,
    [bounds[0], bounds[2], bounds[1], bounds[3], minRating, minRating]);
    return res.json(rows.map((row: any) => ({ id: String(row.id), name: row.name,
      lat: Number(row.lat), lng: Number(row.lng), address: row.address || row.district_name || '',
      type: row.amap_type || '', typeCode: row.amap_type_code || '',
      rating: row.rating === null ? null : Number(row.rating) })));
  } catch (error) {
    console.error('[HotPoints] Scenic map query failed:', error);
    return res.status(500).json({ error: 'Unable to load map places.' });
  }
};

// Home discoveries are selected by the requested AMap codes, including multi-code POIs.
export const getScenicDiscoveries = async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (typeof req.query.lat !== 'string' || typeof req.query.lng !== 'string' || !req.query.lat.trim() || !req.query.lng.trim() ||
      !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'Valid lat and lng are required.' });
  }
  const latDelta = 15 / 111.32;
  const lngDelta = latDelta / Math.cos(lat * Math.PI / 180);
  try {
    const { rows } = await query(`SELECT id, name, lat, lng, address, district_name, amap_type, amap_type_code
      FROM hot_points WHERE status = 'active' AND source = 'amap'
        AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
        AND (FIND_IN_SET('110206', REPLACE(amap_type_code, '|', ',')) > 0
          OR FIND_IN_SET('110205', REPLACE(amap_type_code, '|', ',')) > 0
          OR FIND_IN_SET('110105', REPLACE(amap_type_code, '|', ',')) > 0
          OR FIND_IN_SET('110101', REPLACE(amap_type_code, '|', ',')) > 0
          OR FIND_IN_SET('110000', REPLACE(amap_type_code, '|', ',')) > 0)
      ORDER BY POW(lat - ?, 2) + POW((lng - ?) * ?, 2), id LIMIT 60`,
    [lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta, lat, lng, Math.cos(lat * Math.PI / 180)]);
    const points = rows.map((row: any) => {
      const rad = Math.PI / 180;
      const dLat = (Number(row.lat) - lat) * rad;
      const dLng = (Number(row.lng) - lng) * rad;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * rad) * Math.cos(Number(row.lat) * rad) * Math.sin(dLng / 2) ** 2;
      return { id: String(row.id), name: row.name, lat: Number(row.lat), lng: Number(row.lng),
        address: row.address || row.district_name || '', type: row.amap_type || '',
        typeCode: row.amap_type_code || '', distanceKm: 12742 * Math.asin(Math.sqrt(Math.min(1, a))) };
    }).filter((point: any) => point.distanceKm <= 15).sort((a: any, b: any) => a.distanceKm - b.distanceKm).slice(0, 8);
    return res.json(points);
  } catch (error) {
    console.error('[HotPoints] Scenic discoveries query failed:', error);
    return res.status(500).json({ error: 'Unable to load nearby places.' });
  }
};

function getDisplayModeForZoom(zoom?: number): HotPointDisplayMode {
  if (!zoom || zoom <= 11) return 'hidden';
  if (zoom <= 14) return 'heatmap';
  return 'points';
}

function getMinPointScoreForZoom(zoom?: number): number {
  if (!zoom || zoom <= 11) return 100;
  if (zoom === 12) return 88;
  if (zoom === 13) return 82;
  if (zoom === 14) return 72;
  return 0;
}

function getLimitForZoom(zoom?: number): number {
  if (!zoom || zoom <= 11) return 0;
  if (zoom <= 14) return 220;
  if (zoom === 15) return 72;
  return 96;
}

function getCategoryCapForZoom(zoom?: number): number {
  if (!zoom || zoom <= 11) return 10;
  if (zoom <= 14) return 70;
  if (zoom === 15) return 18;
  return 24;
}

function getSourceCapForZoom(source: string, zoom?: number): number {
  if (!zoom || zoom <= 11) {
    return 0;
  }
  if (zoom <= 14) {
    return source === 'map_hotspots' ? 80 : 180;
  }
  if (source === 'map_hotspots') return 0;
  if (zoom === 15) return 72;
  return 96;
}

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export const getHotPoints = async (req: Request, res: Response) => {
  try {
    const { bounds, zoom, categories } = req.query;

    if (!bounds || typeof bounds !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid bounds parameter. Expected format: south,west,north,east' });
    }

    const boundsParts = bounds.replace(/\s+/g, '').split(',').map(Number);
    if (boundsParts.length !== 4 || boundsParts.some(Number.isNaN)) {
      return res.status(400).json({ error: 'Invalid bounds format. Expected 4 comma-separated numbers: south,west,north,east' });
    }

    const [south, west, north, east] = boundsParts;
    const zoomVal = zoom ? parseInt(String(zoom), 10) : undefined;
    const displayMode = getDisplayModeForZoom(zoomVal);
    if (displayMode === 'hidden') {
      return res.status(200).json([]);
    }

    const minPointScore = getMinPointScoreForZoom(zoomVal);
    const limit = getLimitForZoom(zoomVal);
    const rawLimit = displayMode === 'heatmap' ? limit * 20 : limit * 3;
    const categoryCap = getCategoryCapForZoom(zoomVal);
    const categoryFilter = typeof categories === 'string'
      ? new Set(categories.split(',').map(item => item.trim()).filter(item => VALID_CATEGORIES.has(item)))
      : null;

    const sql = `
      SELECT *
      FROM (
        SELECT
          CONCAT('hot_point:', id) AS id,
          'hot_points' AS source,
          name,
          category,
          category AS original_category,
          lat,
          lng,
          address,
          district_name,
          business_area,
          tags,
          photos,
          popularity_score,
          cyclist_score,
          route_relevance_score,
          confidence_score,
          nearby_segment_count,
          nearest_segment_distance_m,
          best_nearby_segment_score,
          avg_nearby_segment_score
        FROM hot_points
        WHERE
          status = 'active'
          AND lat BETWEEN ? AND ?
          AND lng BETWEEN ? AND ?

        UNION ALL

        SELECT
          CONCAT('map_hotspot:', id) AS id,
          'map_hotspots' AS source,
          name,
          CASE
            WHEN category IN ('viewpoint', 'summit') THEN 'scenic'
            WHEN category = 'cafe' THEN 'supply'
            WHEN category = 'bike_shop' THEN 'service'
            ELSE category
          END AS category,
          category AS original_category,
          lat,
          lng,
          address,
          NULL AS district_name,
          NULL AS business_area,
          JSON_ARRAY(category) AS tags,
          JSON_ARRAY() AS photos,
          CASE
            WHEN category IN ('viewpoint', 'summit') THEN 72
            WHEN category = 'cafe' THEN 64
            WHEN category = 'bike_shop' THEN 58
            ELSE 56
          END AS popularity_score,
          CASE
            WHEN category IN ('viewpoint', 'summit') THEN 74
            WHEN category = 'bike_shop' THEN 78
            WHEN category IN ('cafe', 'supply') THEN 68
            ELSE 60
          END AS cyclist_score,
          CASE
            WHEN category IN ('viewpoint', 'summit') THEN 76
            WHEN category = 'bike_shop' THEN 72
            WHEN category IN ('cafe', 'supply') THEN 68
            ELSE 60
          END AS route_relevance_score,
          72 AS confidence_score,
          0 AS nearby_segment_count,
          NULL AS nearest_segment_distance_m,
          NULL AS best_nearby_segment_score,
          NULL AS avg_nearby_segment_score
        FROM map_hotspots
        WHERE
          lat BETWEEN ? AND ?
          AND lng BETWEEN ? AND ?
      ) AS merged_hot_points
      WHERE
        (
          (? = 'heatmap' AND (source = 'map_hotspots' OR route_relevance_score >= ?))
          OR (? = 'points' AND source = 'hot_points' AND route_relevance_score >= ?)
        )
      ORDER BY route_relevance_score DESC, cyclist_score DESC, popularity_score DESC
      LIMIT ?;
    `;

    const { rows } = await query(sql, [
      south,
      north,
      west,
      east,
      south,
      north,
      west,
      east,
      displayMode,
      minPointScore,
      displayMode,
      minPointScore,
      rawLimit
    ]);

    const formatted = rows
      .map((row: any) => ({
        id: row.id,
        source: row.source,
        name: row.name,
        category: row.category,
        originalCategory: row.original_category,
        lat: Number(row.lat),
        lng: Number(row.lng),
        address: row.address || '',
        districtName: row.district_name || '',
        businessArea: row.business_area || '',
        tags: parseJsonField<string[]>(row.tags, []),
        photos: parseJsonField<Array<{ title?: string; url?: string }>>(row.photos, []),
        popularityScore: Number(row.popularity_score || 0),
        cyclistScore: Number(row.cyclist_score || 0),
        routeRelevanceScore: Number(row.route_relevance_score || 0),
        confidenceScore: Number(row.confidence_score || 0),
        nearbySegmentCount: Number(row.nearby_segment_count || 0),
        nearestSegmentDistanceM: row.nearest_segment_distance_m === null ? null : Number(row.nearest_segment_distance_m),
        bestNearbySegmentScore: row.best_nearby_segment_score === null ? null : Number(row.best_nearby_segment_score),
        avgNearbySegmentScore: row.avg_nearby_segment_score === null ? null : Number(row.avg_nearby_segment_score)
      }))
      .filter((point: any) => !categoryFilter || categoryFilter.has(point.category));

    const categoryCounts = new Map<string, number>();
    const sourceCounts = new Map<string, number>();
    const balanced = [];
    for (const point of formatted) {
      const count = categoryCounts.get(point.category) || 0;
      const sourceCount = sourceCounts.get(point.source) || 0;
      if (!categoryFilter && count >= categoryCap) continue;
      if (sourceCount >= getSourceCapForZoom(point.source, zoomVal)) continue;

      balanced.push(point);
      categoryCounts.set(point.category, count + 1);
      sourceCounts.set(point.source, sourceCount + 1);
      if (balanced.length >= limit) break;
    }

    return res.status(200).json(balanced);
  } catch (error: any) {
    console.error('[HotPointController] Failed to fetch hot points:', error.message);
    return res.status(500).json({
      error: 'Failed to fetch hot points.',
      details: error.message
    });
  }
};
