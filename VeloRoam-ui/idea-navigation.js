(function (root) {
  'use strict';

  function toGcj02(point) {
    const x = point.lng - 105, y = point.lat - 35, pi = Math.PI;
    let lat = -100 + 2 * x + 3 * y + .2 * y * y + .1 * x * y + .2 * Math.sqrt(Math.abs(x));
    lat += (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
    lat += (20 * Math.sin(y * pi) + 40 * Math.sin(y / 3 * pi)) * 2 / 3;
    lat += (160 * Math.sin(y / 12 * pi) + 320 * Math.sin(y * pi / 30)) * 2 / 3;
    let lng = 300 + x + 2 * y + .1 * x * x + .1 * x * y + .1 * Math.sqrt(Math.abs(x));
    lng += (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
    lng += (20 * Math.sin(x * pi) + 40 * Math.sin(x / 3 * pi)) * 2 / 3;
    lng += (150 * Math.sin(x / 12 * pi) + 300 * Math.sin(x / 30 * pi)) * 2 / 3;
    const a = 6378245, ee = .00669342162296594323, radians = point.lat / 180 * pi;
    const magic = 1 - ee * Math.sin(radians) ** 2, rootMagic = Math.sqrt(magic);
    return { lat: point.lat + lat * 180 / ((a * (1 - ee)) / (magic * rootMagic) * pi),
      lng: point.lng + lng * 180 / (a / rootMagic * Math.cos(radians) * pi) };
  }

  function buildIdeaNavigation(route, name) {
    const valid = point => point && point.lat != null && point.lng != null && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng)) && Math.abs(Number(point.lat)) <= 90 && Math.abs(Number(point.lng)) <= 180;
    const leg = route?.legs?.find(item => item.type === 'segment' && Array.isArray(item.points) && item.points.length >= 2);
    const start = leg?.points?.[0], end = leg?.points?.[leg.points.length - 1];
    const destination = route?.stops?.[route.stops.length - 1]?.point;
    if (!valid(start) || !valid(end)) throw new Error('路段起终点不完整，暂时无法导航。');
    const segmentStart = { lat: Number(start.lat), lng: Number(start.lng) };
    const domestic = segmentStart.lng > 73 && segmentStart.lng < 135 && segmentStart.lat > 18 && segmentStart.lat < 53;
    if (domestic) {
      const converted = toGcj02(segmentStart);
      const params = new URLSearchParams({ to: `${converted.lng.toFixed(6)},${converted.lat.toFixed(6)},${name || '路段起点'}`, mode: 'ride', callnative: '1', src: 'VeloRoam' });
      return { url: `https://uri.amap.com/navigation?${params}`, note: '高德地图将导航至路段起点，完整路线可导出 GPX。' };
    }
    if (!valid(destination)) throw new Error('路线返回点不完整，暂时无法导航。');
    const params = new URLSearchParams({ api: '1', destination: `${Number(destination.lat)},${Number(destination.lng)}`,
      waypoints: `${segmentStart.lat},${segmentStart.lng}|${Number(end.lat)},${Number(end.lng)}`, travelmode: 'bicycling' });
    return { url: `https://www.google.com/maps/dir/?${params}`, note: '地图将重新规划途经路段的往返路线，完整轨迹可导出 GPX。' };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { buildIdeaNavigation };
  else root.buildIdeaNavigation = buildIdeaNavigation;
})(typeof globalThis !== 'undefined' ? globalThis : this);
