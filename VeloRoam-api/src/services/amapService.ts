import axios from 'axios';
import { LatLng, encodePolyline, wgs84ToGcj02, gcj02ToWgs84, getDistanceMeters } from '../utils/polyline';
import { PlanRouteResponse, ElevationPoint } from './googleMapsService';
import { Client } from '@googlemaps/google-maps-services-js';
import { scoreRoute, ScoredRoute } from './routeScorer';

const amapApiKey = process.env.AMAP_API_KEY || '';
const googleApiKey = process.env.GOOGLE_MAPS_API_KEY || '';
const googleMapsClient = new Client({});
const maxElevationSamples = parseInt(process.env.MAX_ELEVATION_SAMPLES || '100', 10);

/**
 * High-Precision AMap (高德地图) bicycling routing service.
 * Supports WGS-84 ⇆ GCJ-02 conversions to prevent offsets, and handles multi-waypoint split-legs concurrent requests.
 */
export async function planAmapRouteService(
  origin: LatLng,
  destination: LatLng,
  waypoints: LatLng[],
  preferences?: { supplyType?: string; supplyDistance?: number; autoLoopback?: boolean }
): Promise<ScoredRoute> {
  if (!amapApiKey) {
    throw new Error('AMAP_API_KEY is not configured.');
  }

  let finalDestination = destination;
  let finalWaypoints = [...waypoints];
  let supplyPointData: any = null;

  // 1. 判断是否有中途美食/补给需求
  if (preferences && preferences.supplyType && preferences.supplyType !== 'none') {
    console.log(`📡 [AMapService] Detecting supply preference: ${preferences.supplyType} around ${preferences.supplyDistance}km.`);
    try {
      // 第一步：先用原起终点和途经点跑一趟基础路线，提取道路折线网格
      const baseLegs = await fetchAmapBicyclingLegs([origin, ...waypoints, destination], amapApiKey);
      const baseGcjPoints: LatLng[] = [];
      baseLegs.forEach((leg) => {
        leg.steps.forEach((step: any) => {
          if (step.polyline) {
            step.polyline.split(';').forEach((coordStr: string) => {
              const parts = coordStr.split(',');
              if (parts.length === 2) {
                const lng = parseFloat(parts[0]);
                const lat = parseFloat(parts[1]);
                if (!isNaN(lat) && !isNaN(lng)) {
                  baseGcjPoints.push({ lat, lng });
                }
              }
            });
          }
        });
      });

      // 第二步：在折线上走步计算，找到最接近 supplyDistance 的 GCJ-02 经纬度 P
      let cumulativeDistM = 0;
      let targetPointGcj = baseGcjPoints[0] || wgs84ToGcj02(origin.lng, origin.lat);
      const targetDistM = (preferences.supplyDistance || 25) * 1000;
      
      for (let k = 1; k < baseGcjPoints.length; k++) {
        cumulativeDistM += getDistanceMeters(baseGcjPoints[k - 1], baseGcjPoints[k]);
        if (cumulativeDistM >= targetDistM) {
          targetPointGcj = baseGcjPoints[k];
          break;
        }
      }

      // 第三步：高德 POI 周边搜索检索匹配商户
      let keywords = '美食|餐饮';
      if (preferences.supplyType === 'mutton') keywords = '羊肉';
      if (preferences.supplyType === 'coffee') keywords = '咖啡';
      if (preferences.supplyType === 'farmhouse') keywords = '农家乐';
      if (preferences.supplyType === 'convenience') keywords = '便利店|超市';

      const poiUrl = `https://restapi.amap.com/v3/place/around?key=${amapApiKey}&location=${targetPointGcj.lng.toFixed(6)},${targetPointGcj.lat.toFixed(6)}&keywords=${encodeURIComponent(keywords)}&radius=5000&sortrule=weight&offset=5&page=1`;
      console.log(`[AMapService] Fetching POIs: ${poiUrl}`);
      const poiRes = await axios.get(poiUrl);

      if (poiRes.data.status === '1' && poiRes.data.pois && poiRes.data.pois.length > 0) {
        const topPoi = poiRes.data.pois[0];
        const [poiLngStr, poiLatStr] = topPoi.location.split(',');
        const poiCoordGcj = { lat: parseFloat(poiLatStr), lng: parseFloat(poiLngStr) };
        const poiCoordWgs = gcj02ToWgs84(poiCoordGcj.lng, poiCoordGcj.lat);

        console.log(`🎯 [AMapService] Found golden POI supply stop: ${topPoi.name} at GCJ: ${topPoi.location}`);

        // 将 POI 插入途经点中，如果是闭环自动返程，终点设为起点
        finalWaypoints.push(poiCoordWgs);
        if (preferences.autoLoopback) {
          finalDestination = origin;
          console.log(`🔄 [AMapService] Auto-loopback enabled. Redirecting destination to origin.`);
        }

        // 保存美食点元数据以供前端标记
        supplyPointData = {
          name: topPoi.name,
          lat: poiCoordWgs.lat,
          lng: poiCoordWgs.lng,
          type: preferences.supplyType
        };
      } else {
        console.warn(`⚠️ [AMapService] No POI found around ${preferences.supplyDistance}km. Falling back to base routing.`);
      }
    } catch (prefErr: any) {
      console.error(`❌ [AMapService] Failed to calculate POI supply waypoint:`, prefErr.message);
    }
  }

  // 2. 正式开始最终全路径规划：拼合 origin -> waypoints (含POI) -> destination
  const allNodes = [origin, ...finalWaypoints, finalDestination];
  console.log(`[AMapService] Re-routing path with ${allNodes.length} nodes...`);
  
  const legsData = await fetchAmapBicyclingLegs(allNodes, amapApiKey);

  // 3. 合并全段轨迹线及属性
  let totalDistanceM = 0;
  let totalDurationS = 0;
  const mergedGcjPoints: LatLng[] = [];

  legsData.forEach((leg) => {
    totalDistanceM += leg.distance;
    totalDurationS += leg.duration;

    leg.steps.forEach((step: any) => {
      if (step.polyline) {
        step.polyline.split(';').forEach((coordStr: string) => {
          const parts = coordStr.split(',');
          if (parts.length === 2) {
            const lng = parseFloat(parts[0]);
            const lat = parseFloat(parts[1]);
            if (!isNaN(lat) && !isNaN(lng)) {
              mergedGcjPoints.push({ lat, lng });
            }
          }
        });
      }
    });
  });

  // 去重相邻坐标点
  const uniqGcjPoints: LatLng[] = [];
  mergedGcjPoints.forEach(p => {
    if (uniqGcjPoints.length === 0) {
      uniqGcjPoints.push(p);
    } else {
      const last = uniqGcjPoints[uniqGcjPoints.length - 1];
      if (Math.abs(last.lat - p.lat) > 1e-6 || Math.abs(last.lng - p.lng) > 1e-6) {
        uniqGcjPoints.push(p);
      }
    }
  });

  // 转回 WGS-84 坐标系，供 Leaflet 底图绘制
  const finalWgsPoints = uniqGcjPoints.map(p => {
    const wgs = gcj02ToWgs84(p.lng, p.lat);
    return { lat: wgs.lat, lng: wgs.lng };
  });

  // 4. 对美食点进行准确的里程定位 (第 X.X km 处)
  if (supplyPointData) {
    // 累加 POI 前所有 Leg 的距离，即为到达美食点的精准里程
    let poiDistM = 0;
    // 美食点被插在最后一处途经点 (index = finalWaypoints.length - 1)
    // 对应的 Leg 索引为 0 到 finalWaypoints.length - 1 的累加
    for (let i = 0; i < finalWaypoints.length; i++) {
      if (legsData[i]) {
        poiDistM += legsData[i].distance;
      }
    }
    supplyPointData.distanceKm = parseFloat((poiDistM / 1000).toFixed(1));
    console.log(`🍜 [AMapService] Supply point ${supplyPointData.name} exact distance calculated: ${supplyPointData.distanceKm} km.`);
  }

  // 5. 高程采样高度数据
  const sampledPoints: LatLng[] = [];
  if (finalWgsPoints.length <= maxElevationSamples) {
    sampledPoints.push(...finalWgsPoints);
  } else {
    const step = (finalWgsPoints.length - 1) / (maxElevationSamples - 1);
    for (let i = 0; i < maxElevationSamples; i++) {
      const index = Math.round(i * step);
      sampledPoints.push(finalWgsPoints[index]);
    }
  }

  // 从谷歌 Elevation API 获取高程（若配置了 Key）
  let elevationAvailable = false;
  let rawElevationData: number[] = [];

  if (googleApiKey) {
    try {
      const elevationResponse = await googleMapsClient.elevation({
        params: {
          locations: sampledPoints,
          key: googleApiKey
        }
      });
      if (elevationResponse.data.status === 'OK') {
        rawElevationData = elevationResponse.data.results.map(r => r.elevation);
        elevationAvailable = true;
      }
    } catch (eleErr: any) {
      console.error(`[AMapService] Failed to retrieve elevation from Google:`, eleErr.message);
    }
  }

  // 计算坡度、爬升与最大坡度
  let elevationPoints: ElevationPoint[] = [];
  let totalAscentM = 0;
  let totalDescentM = 0;
  let maxSlopePercent = 0;

  if (elevationAvailable && rawElevationData.length > 0) {
    const smoothedElevation = smoothArray(rawElevationData, 3);
    let currentDistanceM = 0;

    elevationPoints.push({
      distanceFromStartM: 0,
      elevationM: parseFloat(smoothedElevation[0].toFixed(1)),
      slopePercent: 0,
      lat: sampledPoints[0].lat,
      lng: sampledPoints[0].lng
    });

    for (let i = 1; i < sampledPoints.length; i++) {
      const distDelta = getDistanceMeters(sampledPoints[i - 1], sampledPoints[i]);
      currentDistanceM += distDelta;

      const eleDelta = smoothedElevation[i] - smoothedElevation[i - 1];
      const slope = distDelta > 0 ? (eleDelta / distDelta) * 100 : 0;

      if (eleDelta > 0) {
        totalAscentM += eleDelta;
      } else {
        totalDescentM += Math.abs(eleDelta);
      }

      if (Math.abs(slope) > Math.abs(maxSlopePercent)) {
        maxSlopePercent = slope;
      }

      elevationPoints.push({
        distanceFromStartM: Math.round(currentDistanceM),
        elevationM: parseFloat(smoothedElevation[i].toFixed(1)),
        slopePercent: parseFloat(slope.toFixed(1)),
        lat: sampledPoints[i].lat,
        lng: sampledPoints[i].lng
      });
    }
  } else {
    let currentDistanceM = 0;
    elevationPoints.push({
      distanceFromStartM: 0,
      elevationM: 0,
      slopePercent: 0,
      lat: sampledPoints[0].lat,
      lng: sampledPoints[0].lng
    });
    for (let i = 1; i < sampledPoints.length; i++) {
      const distDelta = getDistanceMeters(sampledPoints[i - 1], sampledPoints[i]);
      currentDistanceM += distDelta;
      elevationPoints.push({
        distanceFromStartM: Math.round(currentDistanceM),
        elevationM: 0,
        slopePercent: 0,
        lat: sampledPoints[i].lat,
        lng: sampledPoints[i].lng
      });
    }
  }

  // 编码最终 WGS-84 polyline 供前端 Leaflet 绘制
  const encodedPolyline = encodePolyline(finalWgsPoints);

  const amapResponse: PlanRouteResponse = {
    polyline: encodedPolyline,
    distanceKm: parseFloat((totalDistanceM / 1000).toFixed(1)),
    durationMin: Math.round(totalDurationS / 60),
    totalAscentM: Math.round(totalAscentM),
    totalDescentM: Math.round(totalDescentM),
    maxSlopePercent: parseFloat(maxSlopePercent.toFixed(1)),
    waypoints: finalWaypoints,
    elevationPoints,
    elevationAvailable
  };

  // 6. 调用评分系统进行打分
  const scoredRoute = await scoreRoute(amapResponse, finalWgsPoints);
  
  return {
    ...scoredRoute,
    comfortScore: Math.min(100, scoredRoute.comfortScore + 5), // 高保真本土绿道具有极高的舒适度
    supplyPoint: supplyPointData // 挂载美食补给黄金店元数据传给前端
  };
}

/**
 * 封装高德骑行规划多 Leg 分段请求核心工具函数
 */
async function fetchAmapBicyclingLegs(nodesWgs84: LatLng[], apiKey: string): Promise<any[]> {
  const gcjNodes = nodesWgs84.map(node => wgs84ToGcj02(node.lng, node.lat));
  const legPromises = [];
  
  for (let i = 0; i < gcjNodes.length - 1; i++) {
    const legOrigin = gcjNodes[i];
    const legDest = gcjNodes[i + 1];
    const url = `https://restapi.amap.com/v4/direction/bicycling?origin=${legOrigin.lng.toFixed(6)},${legOrigin.lat.toFixed(6)}&destination=${legDest.lng.toFixed(6)},${legDest.lat.toFixed(6)}&key=${apiKey}`;
    
    legPromises.push(
      axios.get(url).then(res => {
        if (res.data.errcode !== 0 || !res.data.data || !res.data.data.paths || res.data.data.paths.length === 0) {
          throw new Error(`AMap routing API error: ${res.data.errmsg || 'Unknown error'} (Code: ${res.data.errcode})`);
        }
        return res.data.data.paths[0]; // 获取该路段的最优骑行路径
      })
    );
  }

  console.log(`[AMapService] Concurrently requesting ${legPromises.length} AMap Bicycling legs...`);
  return await Promise.all(legPromises);
}

function smoothArray(arr: number[], windowSize: number): number[] {
  const result: number[] = [];
  const half = Math.floor(windowSize / 2);
  
  for (let i = 0; i < arr.length; i++) {
    let sum = 0;
    let count = 0;
    for (let w = -half; w <= half; w++) {
      const idx = i + w;
      if (idx >= 0 && idx < arr.length) {
        sum += arr[idx];
        count++;
      }
    }
    result.push(sum / count);
  }
  return result;
}
