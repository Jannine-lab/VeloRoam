import axios from 'axios';
import { LatLng } from '../utils/polyline';

// 本地简易内存缓存，Key 为 "south,west,north,east" 的网格坐标
const cache = new Map<string, any>();

export interface OsmFeatures {
  trafficSignals: LatLng[];
  scenicSpots: LatLng[]; // 绿地及水体中心点集
}

/**
 * 依据一组经纬度坐标集计算 Bounding Box (附带安全 padding)
 */
function getBoundingBox(points: LatLng[], padding = 0.003) {
  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;
  
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  
  return {
    south: parseFloat((minLat - padding).toFixed(4)),
    west: parseFloat((minLng - padding).toFixed(4)),
    north: parseFloat((maxLat + padding).toFixed(4)),
    east: parseFloat((maxLng + padding).toFixed(4))
  };
}

/**
 * 从 OpenStreetMap Overpass API 批量抓取边界框内所有的红绿灯、公园和水体中心
 */
export async function fetchOsmFeatures(points: LatLng[]): Promise<OsmFeatures> {
  const { south, west, north, east } = getBoundingBox(points);
  const cacheKey = `${south},${west},${north},${east}`;
  
  if (cache.has(cacheKey)) {
    console.log(`[OsmService] Hit cache for key: ${cacheKey}`);
    return cache.get(cacheKey);
  }
  
  // Overpass 查询语句：拉取红绿灯、公园和自然水系，且使用 body center 聚合中心点以加速计算
  const query = `[out:json][timeout:5];
(
  node["highway"="traffic_signals"](${south},${west},${north},${east});
  way["leisure"="park"](${south},${west},${north},${east});
  way["natural"="water"](${south},${west},${north},${east});
  relation["leisure"="park"](${south},${west},${north},${east});
  relation["natural"="water"](${south},${west},${north},${east});
);
out center;`;

  const trafficSignals: LatLng[] = [];
  const scenicSpots: LatLng[] = [];
  
  try {
    console.log(`[OsmService] Fetching OSM Overpass features for BBOX: [${south}, ${west}, ${north}, ${east}]...`);
    
    const response = await axios.post(
      'https://overpass-api.de/api/interpreter',
      `data=${encodeURIComponent(query)}`,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 4500 // 4.5s 柔性超时限制
      }
    );
    
    if (response.data && response.data.elements) {
      for (const element of response.data.elements) {
        const lat = element.lat || (element.center ? element.center.lat : null);
        const lng = element.lon || (element.center ? element.center.lon : null);
        
        if (lat !== null && lng !== null) {
          const coord: LatLng = { lat, lng };
          if (element.tags && element.tags.highway === 'traffic_signals') {
            trafficSignals.push(coord);
          } else {
            // 公园和自然水景
            scenicSpots.push(coord);
          }
        }
      }
    }
    
    console.log(`[OsmService] Query Success. Found ${trafficSignals.length} traffic signals and ${scenicSpots.length} scenic areas.`);
    
    const result: OsmFeatures = { trafficSignals, scenicSpots };
    // 写入内存缓存
    cache.set(cacheKey, result);
    return result;
    
  } catch (error: any) {
    console.warn(`⚠️ [OsmService] Overpass API query failed or timed out: ${error.message}. Returning empty placeholders for heuristic calculations.`);
    // 柔性回退：返回空元素，由上游打分器采用启发式概率替代
    return { trafficSignals: [], scenicSpots: [] };
  }
}
