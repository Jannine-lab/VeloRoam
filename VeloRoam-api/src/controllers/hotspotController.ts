import { Request, Response } from 'express';
import axios from 'axios';
import { query } from '../config/db';

const amapApiKey = process.env.AMAP_API_KEY || '';

/**
 * 将高德的 POI 分类映射为我们定义的 5 大骑行点位类别
 */
function mapAmapPoiToCategory(poi: any): string | null {
  const typecode = poi.typecode || '';
  const name = poi.name || '';

  // 1. 自行车店: typecode 061208/073000 开头，或者名字含自行车、单车、车专卖及主流品牌
  if (
    typecode.startsWith('061208') || 
    typecode.startsWith('073000') ||
    name.includes('自行车') || name.includes('单车') || name.includes('车店') || 
    /GIANT|捷安特|MERIDA|美利达|TREK|崔克|Specialized|闪电|SRAM|Shimano|喜德盛/i.test(name)
  ) {
    return 'bike_shop';
  }

  // 2. 咖啡馆: typecode 050500 开头，或者名字含咖啡、Cafe、咖啡厅或主流品牌
  if (
    typecode.startsWith('050500') ||
    name.includes('咖啡') || /cafe|starbucks|luckin|manner/i.test(name)
  ) {
    return 'cafe';
  }

  // 3. 便利店/补给点: typecode 060200, 060101, 060102 开头，或名字包含便利店、小卖部、超市、补给及主流品牌
  if (
    typecode.startsWith('060200') || 
    typecode.startsWith('060101') || 
    typecode.startsWith('060102') ||
    name.includes('便利店') || name.includes('小卖部') || name.includes('超市') || name.includes('补给') ||
    /全家|罗森|7-11|7-Eleven|美宜佳|FamilyMart|Lawson/i.test(name)
  ) {
    return 'supply';
  }

  // 4. 垭口山顶: 风景名胜(11开头) 且名字含山、峰、垭口、顶、岭、岗
  if (
    typecode.startsWith('11') && 
    (name.includes('山') || name.includes('峰') || name.includes('垭口') || name.includes('顶') || name.includes('岭') || name.includes('岗'))
  ) {
    return 'summit';
  }

  // 5. 风景点/观景点: 属于风景名胜(11开头，非山顶类型)，或名字包含观景、展望、拍照、打卡、公园、景区
  if (
    typecode.startsWith('11') ||
    name.includes('观景') || name.includes('展望') || name.includes('拍照') || name.includes('打卡') || name.includes('公园') || name.includes('景区')
  ) {
    return 'viewpoint';
  }

  return null;
}

/**
 * 将从 API 获取的新点位数据批量 Upsert 写入 MySQL
 */
async function asyncUpsertHotspotsToMySql(pois: any[]) {
  for (const poi of pois) {
    try {
      const category = mapAmapPoiToCategory(poi);
      if (!category) continue; // 过滤非车友关注的类型

      const [lngStr, latStr] = poi.location.split(',');
      const lng = parseFloat(lngStr);
      const lat = parseFloat(latStr);
      if (isNaN(lng) || isNaN(lat)) continue;

      const pointGeom = `POINT(${lng} ${lat})`;

      const upsertSql = `
        INSERT INTO map_hotspots (
          id, name, category, lat, lng, geom, address, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ST_GeomFromText(?, 4326), ?, CURRENT_TIMESTAMP
        )
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          category = VALUES(category),
          lat = VALUES(lat),
          lng = VALUES(lng),
          geom = VALUES(geom),
          address = VALUES(address),
          updated_at = CURRENT_TIMESTAMP;
      `;

      await query(upsertSql, [
        poi.id,
        poi.name,
        category,
        lat,
        lng,
        pointGeom,
        poi.address || null
      ]);
    } catch (dbErr: any) {
      console.warn(`[HotspotController] MySQL Async Upsert failed for POI ${poi.id}:`, dbErr.message);
    }
  }
}

/**
 * 从本地数据库检索周边指定距离的点位
 */
async function queryLocalHotspots(lng: number, lat: number, radiusMeters: number): Promise<any[]> {
  const pointWkt = `POINT(${lng} ${lat})`;
  const mysqlSqlQuery = `
    SELECT 
      id, 
      name, 
      category,
      lat,
      lng,
      address,
      ST_Distance_Sphere(geom, ST_GeomFromText(?, 4326)) as distance
    FROM map_hotspots
    WHERE ST_Distance_Sphere(geom, ST_GeomFromText(?, 4326)) <= ?
    ORDER BY distance ASC
    LIMIT 50;
  `;
  const { rows } = await query(mysqlSqlQuery, [pointWkt, pointWkt, radiusMeters]);
  return rows;
}

/**
 * GET /api/routes/hotspots
 * 查询视口边界范围内的所有已缓存热点 POI
 */
export const getHotspotsInBounds = async (req: Request, res: Response) => {
  try {
    const { bounds } = req.query;
    if (!bounds || typeof bounds !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid bounds parameter. Expected format: south,west,north,east' });
    }

    const cleanBounds = bounds.replace(/\s+/g, '');
    const boundsParts = cleanBounds.split(',').map(Number);
    if (boundsParts.length !== 4 || boundsParts.some(isNaN)) {
      return res.status(400).json({ error: 'Invalid bounds format. Expected 4 comma-separated numbers: south,west,north,east' });
    }

    const [south, west, north, east] = boundsParts;

    // 构建 MBR 检索多边形
    const polygonWkt = `POLYGON((${west} ${south}, ${west} ${north}, ${east} ${north}, ${east} ${south}, ${west} ${south}))`;

    const mysqlSqlQuery = `
      SELECT 
        id, 
        name, 
        category,
        lat,
        lng,
        address
      FROM map_hotspots
      WHERE MBRIntersects(geom, ST_GeomFromText(?, 4326))
      LIMIT 100;
    `;

    const { rows } = await query(mysqlSqlQuery, [polygonWkt]);
    return res.status(200).json(rows);
  } catch (error: any) {
    console.error(`❌ [HotspotController] getHotspotsInBounds failed:`, error.message);
    return res.status(500).json({ error: 'Failed to fetch hotspots in bounds.', details: error.message });
  }
};

/**
 * GET /api/routes/hotspots/nearby
 * 查询中心点附近 1km 的骑行推荐补给/打卡点 (高德 API + 本地缓存兜底)
 */
export const getNearbyHotspots = async (req: Request, res: Response) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) {
      return res.status(400).json({ error: 'Missing lat or lng query parameters.' });
    }

    const centerLat = parseFloat(lat as string);
    const centerLng = parseFloat(lng as string);
    if (isNaN(centerLat) || isNaN(centerLng)) {
      return res.status(400).json({ error: 'Invalid lat or lng values.' });
    }

    console.log(`🔍 [HotspotController] Querying local DB for hotspots within 1km around (${centerLat}, ${centerLng})`);
    
    // 1. 查询本地数据库 (1000米范围)
    let localHotspots = await queryLocalHotspots(centerLng, centerLat, 1000);

    // 2. 缓存命中判定：若点位数量 >= 4，直接秒返
    if (localHotspots && localHotspots.length >= 4) {
      console.log(`🎯 [HotspotController] Cache Hit. Returning ${localHotspots.length} hotspots from MySQL.`);
      return res.status(200).json(localHotspots);
    }

    // 3. 缓存未命中：若本地数据不足，调用高德周边搜索 API
    if (!amapApiKey) {
      console.warn('⚠️ [HotspotController] AMAP_API_KEY is missing. Returning local hotspots only.');
      return res.status(200).json(localHotspots || []);
    }

    console.log(`⚠️ [HotspotController] Cache Miss (count=${localHotspots.length}). Requesting AMap place/around...`);
    const amapUrl = `https://restapi.amap.com/v3/place/around`;
    
    const response = await axios.get(amapUrl, {
      params: {
        key: amapApiKey,
        location: `${centerLng.toFixed(6)},${centerLat.toFixed(6)}`,
        radius: 1000,
        // 自行车服务、餐饮/咖啡、便利店/超市、风景名胜等大类编码合并
        types: '050500|060200|060101|060102|061208|073000|110000',
        offset: 35,
        page: 1
      }
    });

    if (response.data && response.data.status === '1') {
      const pois = response.data.pois || [];
      console.log(`⚡ [HotspotController] AMap returned ${pois.length} POIs. Writing/updating MySQL cache...`);

      // 4. 同步执行写库，保证后续查询立即生效
      await asyncUpsertHotspotsToMySql(pois);

      // 5. 重新查库，确保空间排序和统一格式完美应用
      const updatedHotspots = await queryLocalHotspots(centerLng, centerLat, 1000);
      return res.status(200).json(updatedHotspots);
    } else {
      console.warn(`[HotspotController] AMap API returned error:`, response.data.info);
      // 高德报错时，优雅降级返回本地已有数据
      return res.status(200).json(localHotspots);
    }

  } catch (error: any) {
    console.error(`❌ [HotspotController] getNearbyHotspots failed:`, error.message);
    return res.status(500).json({ error: 'Failed to fetch nearby hotspots.', details: error.message });
  }
};
