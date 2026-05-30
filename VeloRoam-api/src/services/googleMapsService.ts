import { Client, TravelMode } from '@googlemaps/google-maps-services-js';
import { LatLng, encodePolyline, getDistanceMeters } from '../utils/polyline';
import { scoreRoute, ScoredRoute } from './routeScorer';
import axios from 'axios';

const googleMapsClient = new Client({});
const apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
const maxElevationSamples = parseInt(process.env.MAX_ELEVATION_SAMPLES || '100', 10);

export interface ElevationPoint {
  distanceFromStartM: number;
  elevationM: number;
  slopePercent: number;
  lat: number;
  lng: number;
}

export interface PlanRouteResponse {
  polyline: string;
  distanceKm: number;
  durationMin: number;
  totalAscentM: number;
  totalDescentM: number;
  maxSlopePercent: number;
  waypoints: LatLng[];
  elevationPoints: ElevationPoint[];
  elevationAvailable: boolean;
}

import { planAmapRouteService } from './amapService';

/**
 * 核心规划路由服务：融合高德 AMap (中国首选) + Google Directions (海外/备选) + OSRM 免 Key 极速道路，并联动 高程采样与 OSM Overpass 加权评分。
 */
export async function planRouteService(
  origin: LatLng,
  destination: LatLng,
  waypoints: LatLng[],
  preferences?: { supplyType?: string; supplyDistance?: number; autoLoopback?: boolean }
): Promise<ScoredRoute[]> {
  const amapKey = process.env.AMAP_API_KEY || '';
  if (amapKey) {
    console.log(`📡 [GoogleMapsService] AMAP_API_KEY is configured! Attempting High-Precision AMap Bicycling planning.`);
    try {
      const amapRoute = await planAmapRouteService(origin, destination, waypoints, preferences);
      
      // 为保持前台 3 选项卡片设计，自动拉取 OSRM 备选路径来补足剩余卡片
      let otherRoutes: ScoredRoute[] = [];
      try {
        const osrmRoutes = await getOSRMRoutes(origin, destination, waypoints);
        const extraLegs = osrmRoutes.slice(1, 3);
        const planRoutePromises = extraLegs.map(async (route) => {
          const pathPoints = decodePolyline(route.polyline);
          return await scoreRoute(route, pathPoints);
        });
        otherRoutes = await Promise.all(planRoutePromises);
      } catch (osrmAltErr: any) {
        console.warn(`⚠️ [GoogleMapsService] Failed to load OSRM alternatives for AMap:`, osrmAltErr.message);
      }
      
      return [amapRoute, ...otherRoutes];
    } catch (amapErr: any) {
      console.error(`❌ [GoogleMapsService] AMap routing failed:`, amapErr.message);
      console.warn(`💡 [GoogleMapsService] Falling back to the next available engine...`);
    }
  }

  if (!apiKey) {
    console.warn(`⚠️ [GoogleMapsService] GOOGLE_MAPS_API_KEY is not configured!`);
    console.warn(`💡 [GoogleMapsService] Falling back to the OSRM Real Road-Aligned Routing Service...`);
    try {
      const osrmRoutes = await getOSRMRoutes(origin, destination, waypoints);
      const planRoutePromises = osrmRoutes.map(async (route) => {
        const pathPoints = decodePolyline(route.polyline);
        return await scoreRoute(route, pathPoints);
      });
      const scoredRoutes = await Promise.all(planRoutePromises);
      scoredRoutes.sort((a, b) => {
        const scoreA = a.comfortScore * 0.4 + a.scenicRating * 10 * 0.4 + a.continuityScore * 0.2;
        const scoreB = b.comfortScore * 0.4 + b.scenicRating * 10 * 0.4 + b.continuityScore * 0.2;
        return scoreB - scoreA;
      });
      return scoredRoutes;
    } catch (osrmError: any) {
      console.error(`❌ [GoogleMapsService] OSRM fallback routing also failed:`, osrmError.message);
      console.warn(`💡 [GoogleMapsService] Falling back to the Mock engine as the last resort.`);
      return generateMockRoutes(origin, destination, waypoints);
    }
  }

  try {
    // 1. Request Directions from Google, requesting alternatives!
    console.log(`[GoogleMapsService] Requesting Google Directions API (with alternatives: true)...`);
    const directionsResponse = await googleMapsClient.directions({
      params: {
        origin,
        destination,
        waypoints: waypoints.map(w => `${w.lat},${w.lng}`),
        mode: TravelMode.bicycling,
        alternatives: true, // 请求多备选路径！
        key: apiKey
      }
    });

    if (directionsResponse.data.status !== 'OK' || !directionsResponse.data.routes || directionsResponse.data.routes.length === 0) {
      throw new Error(`Google Directions API error: ${directionsResponse.data.status}`);
    }

    const rawRoutes = directionsResponse.data.routes;
    const planRoutePromises = rawRoutes.map(async (route, routeIdx) => {
      const encodedPolyline = route.overview_polyline.points;

      // 计算每个备选 Leg 的总里程与耗时
      let totalDistanceMeters = 0;
      let totalDurationSeconds = 0;
      for (const leg of route.legs) {
        totalDistanceMeters += leg.distance.value;
        totalDurationSeconds += leg.duration.value;
      }

      // 解码折线获取路径点
      const pathPoints = decodePolyline(encodedPolyline);

      // 采样高程高度数据
      const sampledPoints: LatLng[] = [];
      if (pathPoints.length <= maxElevationSamples) {
        sampledPoints.push(...pathPoints);
      } else {
        const step = (pathPoints.length - 1) / (maxElevationSamples - 1);
        for (let i = 0; i < maxElevationSamples; i++) {
          const index = Math.round(i * step);
          sampledPoints.push(pathPoints[index]);
        }
      }

      let elevationAvailable = false;
      let rawElevationData: number[] = [];

      try {
        const elevationResponse = await googleMapsClient.elevation({
          params: {
            locations: sampledPoints,
            key: apiKey
          }
        });

        if (elevationResponse.data.status === 'OK') {
          rawElevationData = elevationResponse.data.results.map(r => r.elevation);
          elevationAvailable = true;
        }
      } catch (eleErr: any) {
        console.error(`[GoogleMapsService] Route [${routeIdx}] failed to retrieve elevation:`, eleErr.message);
      }

      // 计算坡度与高度剖面
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
        // 无高程数据填充平坦数据
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

      const planResponse: PlanRouteResponse = {
        polyline: encodedPolyline,
        distanceKm: parseFloat((totalDistanceMeters / 1000).toFixed(1)),
        durationMin: Math.round(totalDurationSeconds / 60),
        totalAscentM: Math.round(totalAscentM),
        totalDescentM: Math.round(totalDescentM),
        maxSlopePercent: parseFloat(maxSlopePercent.toFixed(1)),
        waypoints,
        elevationPoints,
        elevationAvailable
      };

      // 4. 调用打分服务获取高精加权指数
      return await scoreRoute(planResponse, pathPoints);
    });

    const scoredRoutes = await Promise.all(planRoutePromises);

    // 综合评价打分排序：总体得分 = 舒适度*0.4 + 风景*10*0.4 + 连贯度*0.2
    scoredRoutes.sort((a, b) => {
      const scoreA = a.comfortScore * 0.4 + a.scenicRating * 10 * 0.4 + a.continuityScore * 0.2;
      const scoreB = b.comfortScore * 0.4 + b.scenicRating * 10 * 0.4 + b.continuityScore * 0.2;
      return scoreB - scoreA; // 降序，最优推荐在首位
    });

    return scoredRoutes;

  } catch (error: any) {
    console.warn(`⚠️ [GoogleMapsService] Google Directions API failed or returned ZERO_RESULTS: ${error.message}`);
    console.warn(`💡 [GoogleMapsService] Falling back to the OSRM Real Road-Aligned Routing Service...`);
    
    try {
      // Fetch real street routes from OSRM
      const osrmRoutes = await getOSRMRoutes(origin, destination, waypoints);
      
      const planRoutePromises = osrmRoutes.map(async (route) => {
        const pathPoints = decodePolyline(route.polyline);
        return await scoreRoute(route, pathPoints);
      });
      
      const scoredRoutes = await Promise.all(planRoutePromises);
      
      // Sort scored routes
      scoredRoutes.sort((a, b) => {
        const scoreA = a.comfortScore * 0.4 + a.scenicRating * 10 * 0.4 + a.continuityScore * 0.2;
        const scoreB = b.comfortScore * 0.4 + b.scenicRating * 10 * 0.4 + b.continuityScore * 0.2;
        return scoreB - scoreA;
      });
      
      return scoredRoutes;
    } catch (osrmError: any) {
      console.error(`❌ [GoogleMapsService] OSRM fallback routing also failed:`, osrmError.message);
      console.warn(`💡 [GoogleMapsService] Falling back to the Mock engine as the last resort.`);
      return generateMockRoutes(origin, destination, waypoints);
    }
  }
}

/**
 * Fetch real street-aligned routes from OSRM public API.
 */
async function getOSRMRoutes(
  origin: LatLng,
  destination: LatLng,
  waypoints: LatLng[]
): Promise<PlanRouteResponse[]> {
  const coordsStr = [origin, ...waypoints, destination]
    .map(c => `${c.lng},${c.lat}`)
    .join(';');
  
  const url = `http://router.project-osrm.org/route/v1/bicycle/${coordsStr}?overview=full&geometries=polyline&steps=true&alternatives=true`;
  
  console.log(`[GoogleMapsService] Fetching OSRM fallback routes: ${url}`);
  const response = await axios.get(url);
  
  if (response.data.code !== 'Ok' || !response.data.routes || response.data.routes.length === 0) {
    throw new Error(`OSRM API error: ${response.data.code}`);
  }
  
  const rawRoutes = response.data.routes;
  const result: PlanRouteResponse[] = [];
  
  for (const route of rawRoutes) {
    const encodedPolyline = route.geometry;
    const distanceKm = route.distance / 1000;
    const durationMin = Math.round(route.duration / 60);
    
    // Decode polyline to get coordinates
    const pathPoints = decodePolyline(encodedPolyline);
    const sampledPoints: LatLng[] = [];
    if (pathPoints.length <= maxElevationSamples) {
      sampledPoints.push(...pathPoints);
    } else {
      const step = (pathPoints.length - 1) / (maxElevationSamples - 1);
      for (let i = 0; i < maxElevationSamples; i++) {
        const index = Math.round(i * step);
        sampledPoints.push(pathPoints[index]);
      }
    }
    
    let elevationAvailable = false;
    let rawElevationData: number[] = [];
    
    if (apiKey) {
      try {
        const elevationResponse = await googleMapsClient.elevation({
          params: {
            locations: sampledPoints,
            key: apiKey
          }
        });
        if (elevationResponse.data.status === 'OK') {
          rawElevationData = elevationResponse.data.results.map(r => r.elevation);
          elevationAvailable = true;
        }
      } catch (eleErr: any) {
        console.error(`[GoogleMapsService] OSRM route failed to retrieve elevation:`, eleErr.message);
      }
    }
    
    // Calculate slopes
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
    
    result.push({
      polyline: encodedPolyline,
      distanceKm: parseFloat(distanceKm.toFixed(1)),
      durationMin: durationMin,
      totalAscentM: Math.round(totalAscentM),
      totalDescentM: Math.round(totalDescentM),
      maxSlopePercent: parseFloat(maxSlopePercent.toFixed(1)),
      waypoints,
      elevationPoints,
      elevationAvailable
    });
  }
  
  return result;
}

/**
 * Decodes Google's Encoded Polyline string.
 */
function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0, len = encoded.length;
  let lat = 0, lng = 0;

  while (index < len) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += dlng;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return points;
}

/**
 * Simple moving average smoothing to eliminate sudden elevation spikes.
 */
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

/**
 * VeloRoam 多方案高仿 Mock 引擎
 * 模拟出具有截然不同骑行特征（山地爬坡、沿江风景道、城市干道）的 3 条独立路线
 */
async function generateMockRoutes(
  origin: LatLng,
  destination: LatLng,
  waypoints: LatLng[]
): Promise<ScoredRoute[]> {
  const routesData = [
    { name: 'VeloRoam 绿道首选', type: 'scenic', curveAmplitude: 0.0018, eleBase: 60, eleAmp: 60 },
    { name: '避堵爬坡路线', type: 'climb', curveAmplitude: -0.0025, eleBase: 120, eleAmp: 180 },
    { name: '省时直达路线', type: 'flat', curveAmplitude: 0.0002, eleBase: 35, eleAmp: 5 }
  ];

  const scoredRoutesPromises = routesData.map(async (config, routeIdx) => {
    const nodes = [origin, ...waypoints, destination];
    const pathPoints: LatLng[] = [];
    const stepsPerLeg = 15;

    // 根据不同路线偏好插值不同的曲线轨迹
    for (let l = 0; l < nodes.length - 1; l++) {
      const start = nodes[l];
      const end = nodes[l + 1];
      
      for (let i = 0; i < stepsPerLeg; i++) {
        const t = i / stepsPerLeg;
        
        // 加入不同的曲线抖动幅度，模拟出 3 条在地图上相互分离的道路线
        const lat = start.lat + (end.lat - start.lat) * t + Math.sin(t * Math.PI) * config.curveAmplitude * (l % 2 === 0 ? 1 : -1) * (routeIdx + 1);
        const lng = start.lng + (end.lng - start.lng) * t + Math.cos(t * Math.PI) * config.curveAmplitude * (l % 2 === 0 ? -1 : 1) * (routeIdx + 1);
        pathPoints.push({ lat, lng });
      }
    }
    pathPoints.push(destination);

    // 里程计算
    let cumulativeDistanceM = 0;
    const distances: number[] = [0];
    for (let i = 1; i < pathPoints.length; i++) {
      const d = getDistanceMeters(pathPoints[i - 1], pathPoints[i]);
      cumulativeDistanceM += d;
      distances.push(cumulativeDistanceM);
    }

    // 根据配置定制独特高程图
    const rawElevations: number[] = [];
    for (let i = 0; i < pathPoints.length; i++) {
      const progress = i / (pathPoints.length - 1);
      
      let height = config.eleBase;
      if (config.type === 'climb') {
        // 山地大爬坡：巨大单峰曲线
        height += config.eleAmp * Math.sin(progress * Math.PI) + 30 * Math.sin(progress * Math.PI * 8);
      } else if (config.type === 'scenic') {
        // 风景路：连绵起伏小丘陵
        height += config.eleAmp * Math.sin(progress * Math.PI * 1.5) + 15 * Math.cos(progress * Math.PI * 6);
      } else {
        // 全平直达：极少起伏
        height += config.eleAmp * Math.sin(progress * Math.PI * 10);
      }
      
      rawElevations.push(Math.max(5, height));
    }

    const smoothedElevations = smoothArray(rawElevations, 5);

    let totalAscentM = 0;
    let totalDescentM = 0;
    let maxSlopePercent = 0;
    const elevationPoints: ElevationPoint[] = [];

    elevationPoints.push({
      distanceFromStartM: 0,
      elevationM: parseFloat(smoothedElevations[0].toFixed(1)),
      slopePercent: 0,
      lat: pathPoints[0].lat,
      lng: pathPoints[0].lng
    });

    for (let i = 1; i < pathPoints.length; i++) {
      const distDelta = distances[i] - distances[i - 1];
      const eleDelta = smoothedElevations[i] - smoothedElevations[i - 1];
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
        distanceFromStartM: Math.round(distances[i]),
        elevationM: parseFloat(smoothedElevations[i].toFixed(1)),
        slopePercent: parseFloat(slope.toFixed(1)),
        lat: pathPoints[i].lat,
        lng: pathPoints[i].lng
      });
    }

    const distanceKm = cumulativeDistanceM / 1000;
    const durationMin = Math.round((distanceKm / 18) * 60 + (totalAscentM / 100) * 10);
    const polyline = encodePolyline(pathPoints);

    const baseResponse: PlanRouteResponse = {
      polyline,
      distanceKm: parseFloat(distanceKm.toFixed(1)),
      durationMin: Math.max(2, durationMin),
      totalAscentM: Math.round(totalAscentM),
      totalDescentM: Math.round(totalDescentM),
      maxSlopePercent: parseFloat(maxSlopePercent.toFixed(1)),
      waypoints,
      elevationPoints,
      elevationAvailable: true
    };

    // 给予特定 Mock 的打分配置，方便测试渲染！
    let comfortScore = 85;
    let scenicRating = 4.2;
    let trafficLightsCount = 3;
    let continuityScore = 90;

    if (config.type === 'climb') {
      comfortScore = 65; // 多陡坡，舒适度下降
      scenicRating = 4.7; // 山上风景好
      trafficLightsCount = 0; // 山路无红绿灯
      continuityScore = 100; // 连贯性极佳
    } else if (config.type === 'flat') {
      comfortScore = 95; // 平坦柏油马路，非常舒服
      scenicRating = 2.8; // 城市干道风景中等
      trafficLightsCount = Math.max(4, Math.round(distanceKm * 1.5)); // 红绿灯密集
      continuityScore = 55; // 连贯性低，常起步
    }

    return {
      ...baseResponse,
      comfortScore,
      scenicRating,
      trafficLightsCount,
      continuityScore
    };
  });

  const mockScoredRoutes = await Promise.all(scoredRoutesPromises);

  // 根据舒适度与风景度排序，使默认绿道在首位
  mockScoredRoutes.sort((a, b) => {
    const scoreA = a.comfortScore * 0.4 + a.scenicRating * 10 * 0.4 + a.continuityScore * 0.2;
    const scoreB = b.comfortScore * 0.4 + b.scenicRating * 10 * 0.4 + b.continuityScore * 0.2;
    return scoreB - scoreA;
  });

  return mockScoredRoutes;
}
