(function (root) {
  'use strict';

  function buildIdeaGPX(route, name) {
    const escapeXml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
    const segments = [];
    (route?.legs || []).forEach(leg => {
      let points = [];
      const flush = () => { if (points.length >= 2) segments.push(points); points = []; };
      (Array.isArray(leg.points) ? leg.points : []).forEach(point => {
        const lat = Number(point?.lat); const lng = Number(point?.lng);
        if (point?.lat == null || point?.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) { flush(); return; }
        points.push({ lat, lng });
      });
      flush();
    });
    if (!segments.length) throw new Error('路线缺少可导出的轨迹。');
    const track = segments.map(points => `    <trkseg>\n${points.map(point => `      <trkpt lat="${point.lat}" lon="${point.lng}" />`).join('\n')}\n    </trkseg>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="VeloRoam" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk>\n    <name>${escapeXml(name || 'VeloRoam 骑行路线')}</name>\n${track}\n  </trk>\n</gpx>`;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { buildIdeaGPX };
  else root.buildIdeaGPX = buildIdeaGPX;
})(typeof globalThis !== 'undefined' ? globalThis : this);
