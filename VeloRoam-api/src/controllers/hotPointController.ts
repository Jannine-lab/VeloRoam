import { Request, Response } from 'express';
import { query } from '../config/db';

const VALID_CATEGORIES = new Set(['scenic', 'supply', 'rest', 'service', 'start_end']);

type HotPointDisplayMode = 'hidden' | 'heatmap' | 'points';

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
