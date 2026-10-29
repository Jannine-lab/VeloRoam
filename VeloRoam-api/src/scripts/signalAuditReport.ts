import { LatLng } from '../utils/polyline';
import { RouteSignalAudit } from '../services/routeSignalAudit';

interface AuditAnchor extends LatLng {
  query: string;
  name: string;
  address: string;
  area: string;
}

interface AuditCandidate {
  alternative: number;
  distanceKm: number;
  durationMin: number;
  points: LatLng[];
  signalAudit?: RouteSignalAudit;
}

export interface AuditSample {
  id: string;
  area: string;
  origin: AuditAnchor;
  destination: AuditAnchor;
  directKm: number;
  routeStatus: 'pending' | 'available' | 'failed';
  osmStatus: 'pending' | 'available' | 'unavailable' | 'not_queried';
  candidates: AuditCandidate[];
  error?: string;
  osmError?: string;
}

export interface AuditReport {
  generatedAt: string;
  sampleTarget: number;
  geocodedAnchors: number;
  samples: AuditSample[];
  reviewSampleIds: string[];
}

export function renderSignalAuditHtml(report: AuditReport): string {
  const serialized = JSON.stringify(report).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>上海骑行路线 · OSM 信号灯抽样核查</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1d2624; background: #f7faf8; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header { padding: 20px clamp(16px, 3vw, 36px) 16px; border-bottom: 1px solid #dce7e1; background: #fff; }
    h1 { margin: 0 0 6px; font-size: 23px; line-height: 1.25; }
    header p, .note { margin: 0; color: #566760; font-size: 13px; line-height: 1.55; }
    main { max-width: 1550px; margin: auto; padding: 18px clamp(16px, 3vw, 36px) 40px; }
    .metrics { display: flex; flex-wrap: wrap; gap: 20px; margin-bottom: 14px; }
    .metric { min-width: 120px; }
    .metric b { display: block; font-size: 22px; }
    .metric span { color: #566760; font-size: 12px; }
    .warning { border-left: 3px solid #d98d00; background: #fff7e7; padding: 10px 12px; margin: 0 0 16px; font-size: 13px; line-height: 1.5; }
    .toolbar { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
    label { display: grid; gap: 5px; font-size: 12px; font-weight: 600; }
    select { min-height: 36px; border: 1px solid #bccdc4; border-radius: 6px; padding: 0 9px; background: #fff; color: #1d2624; font-size: 13px; max-width: min(100%, 490px); }
    a { color: #166649; }
    .links { display: flex; gap: 14px; margin-left: auto; font-size: 13px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(300px, 1fr); gap: 14px; }
    #map { height: min(65vh, 650px); min-height: 390px; background: #e5eee9; border: 1px solid #dce7e1; border-radius: 6px; }
    .side { min-width: 0; }
    #route-summary { border-bottom: 1px solid #dce7e1; padding: 3px 0 12px; font-size: 14px; line-height: 1.5; }
    #route-summary strong { display: block; font-size: 16px; }
    .legend { display: flex; flex-wrap: wrap; gap: 11px; margin: 10px 0; font-size: 12px; color: #42584e; }
    .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; }
    .matched { background: #dc593e; } .nearby { background: #e5ac19; }
    .junction-list { max-height: 520px; overflow: auto; border-top: 1px solid #dce7e1; }
    .junction { padding: 10px 0; border-bottom: 1px solid #e5ede8; font-size: 12px; line-height: 1.45; }
    .junction b { font-size: 13px; }
    .muted { color: #687871; }
    section { margin-top: 22px; }
    h2 { font-size: 17px; margin: 0 0 9px; }
    .table-wrap { overflow-x: auto; border: 1px solid #dce7e1; border-radius: 6px; background: #fff; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #e5ede8; text-align: left; white-space: nowrap; }
    th { background: #eff5f1; color: #3d5348; font-weight: 600; }
    tbody tr { cursor: pointer; }
    tbody tr:hover, tbody tr.active { background: #eaf6ee; }
    .status-ok { color: #13754a; } .status-bad { color: #b44932; }
    @media (max-width: 800px) { .layout { grid-template-columns: 1fr; } .links { margin-left: 0; } #map { height: 45vh; min-height: 300px; } .junction-list { max-height: 230px; } }
  </style>
</head>
<body>
  <header>
    <h1>上海骑行路线 · OSM 信号灯抽样核查</h1>
    <p>生成于 <span id="generated-at"></span>。OSM 匹配数不是实际红绿灯数；未做方向和现场核验。</p>
  </header>
  <main>
    <div class="metrics" id="metrics"></div>
    <div class="warning" id="warning"></div>
    <div class="toolbar">
      <label>抽样路线<select id="sample-select"></select></label>
      <label>高德候选方案<select id="candidate-select"></select></label>
      <div class="links"><a href="summary.csv">汇总 CSV</a><a href="review.csv">复核清单 CSV</a><a href="report.json">完整 JSON</a></div>
    </div>
    <div class="layout">
      <div id="map" role="img" aria-label="抽样骑行路线及 OSM 信号灯位置"></div>
      <div class="side">
        <div id="route-summary"></div>
        <div class="legend"><span><i class="dot matched"></i>匹配路线 20 米内</span><span><i class="dot nearby"></i>邻近 20–45 米</span></div>
        <div class="junction-list" id="junction-list"></div>
      </div>
    </div>
    <section>
      <h2>全部样本</h2>
      <p class="note">点击一行查看路线。每个路口多根灯杆已合并；“0”只表示 OSM 未匹配到标注。</p>
      <div class="table-wrap"><table><thead><tr><th>样本</th><th>区域</th><th>起点 → 终点</th><th>方案</th><th>距离</th><th>OSM 状态</th><th>匹配路口</th><th>邻近待查</th><th>需复核</th></tr></thead><tbody id="sample-rows"></tbody></table></div>
    </section>
    <section>
      <h2>优先复核</h2>
      <p class="note">每个区域先选两条代表路线，再加入疑难路口较多的样本。OSM 不可用时仍保留代表路线，但灯数留空。实际数量和漏标率需独立核验。</p>
      <div class="table-wrap"><table><thead><tr><th>样本</th><th>起点 → 终点</th><th>OSM 状态</th><th>OSM 匹配</th><th>邻近待查</th><th>疑难路口</th></tr></thead><tbody id="review-rows"></tbody></table></div>
    </section>
  </main>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const report = ${serialized};
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
    const sampleSelect = document.getElementById('sample-select');
    const candidateSelect = document.getElementById('candidate-select');
    const mapped = report.samples.filter(sample => sample.candidates.length);
    const osmAvailable = report.samples.filter(sample => sample.osmStatus === 'available').length;
    const osmUnavailable = report.samples.filter(sample => sample.osmStatus === 'unavailable').length;
    document.getElementById('generated-at').textContent = new Date(report.generatedAt).toLocaleString('zh-CN');
    document.getElementById('metrics').innerHTML = [
      [report.samples.length, '抽样路线'],
      [mapped.length, '高德算路成功'],
      [osmAvailable, 'OSM 查询成功'],
      [osmUnavailable, 'OSM 查询失败'],
      [report.reviewSampleIds.length, '优先复核']
    ].map(([value, label]) => '<div class="metric"><b>' + value + '</b><span>' + label + '</span></div>').join('');
    document.getElementById('warning').textContent = osmUnavailable
      ? '部分区域的 Overpass 查询失败：这些路线没有红绿灯估计值，不能记作 0。请检查服务器网络或切换可用的 OSM 查询端点后重跑。'
      : 'OSM 查询成功并不代表要素完整。报告用于找出需复核的位置，不提供真实红绿灯覆盖率或准确性结论。';

    const map = typeof L !== 'undefined' ? L.map('map', { zoomControl: true }).setView([31.23, 121.47], 12) : null;
    const layers = map ? L.layerGroup().addTo(map) : null;
    if (map) L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    else document.getElementById('map').textContent = '地图组件未加载；CSV 和 JSON 报告仍可查看。';

    for (const sample of report.samples) {
      const option = document.createElement('option');
      option.value = sample.id;
      option.textContent = sample.id + ' · ' + sample.area + ' · ' + sample.origin.name + ' → ' + sample.destination.name;
      sampleSelect.appendChild(option);
    }

    function renderJunctions(candidate) {
      const list = document.getElementById('junction-list');
      const junctions = candidate.signalAudit?.junctions || [];
      if (!junctions.length) {
        list.innerHTML = '<div class="junction muted">' +
          (candidate.signalAudit ? 'OSM 未匹配到信号灯标注；不代表实际没有红绿灯。' : 'OSM 数据不可用，无法匹配。') + '</div>';
        return;
      }
      list.innerHTML = junctions.map((junction, index) => {
        const ids = junction.features.map(feature => '<a href="https://www.openstreetmap.org/node/' + Number(feature.id) + '" target="_blank" rel="noopener">#' + Number(feature.id) + '</a>').join('、');
        return '<div class="junction"><b>' + (index + 1) + '. ' +
          (junction.status === 'matched' ? '匹配' : '邻近待查') + '</b> · 沿路线约 ' + junction.alongRouteMeters +
          ' 米 · 距路线 ' + junction.distanceMeters + ' 米<br><span class="muted">' +
          escapeHtml(junction.reviewReasons.join('；') || '尚需独立资料确认') + '</span><br>OSM ' + ids + '</div>';
      }).join('');
    }

    function showSample(id, alternative = 1) {
      const sample = report.samples.find(item => item.id === id);
      if (!sample) return;
      sampleSelect.value = sample.id;
      candidateSelect.replaceChildren();
      for (const item of sample.candidates) {
        const option = document.createElement('option');
        option.value = String(item.alternative);
        option.textContent = '方案 ' + item.alternative + ' · ' + item.distanceKm + ' km';
        candidateSelect.appendChild(option);
      }
      candidateSelect.disabled = sample.candidates.length === 0;
      const candidate = sample.candidates.find(item => item.alternative === Number(alternative)) || sample.candidates[0];
      if (candidate) candidateSelect.value = String(candidate.alternative);
      const audit = candidate?.signalAudit;
      document.getElementById('route-summary').innerHTML = '<strong>' + escapeHtml(sample.origin.name) + ' → ' +
        escapeHtml(sample.destination.name) + '</strong>' + escapeHtml(sample.area) + ' · ' +
        (candidate ? candidate.distanceKm + ' km · 约 ' + candidate.durationMin + ' 分钟' : '高德算路失败') +
        '<br>OSM：' + (sample.osmStatus === 'available' ? '查询成功' : sample.osmStatus === 'unavailable' ? '查询失败' : '未查询') +
        (audit ? ' · 匹配 ' + audit.matchedJunctions + ' 处 · 邻近待查 ' + audit.nearbyJunctions + ' 处' : '') +
        (sample.error || sample.osmError ? '<br><span class="status-bad">' + escapeHtml(sample.error || sample.osmError) + '</span>' : '');
      renderJunctions(candidate || {});
      for (const row of document.querySelectorAll('#sample-rows tr')) row.classList.toggle('active', row.dataset.id === sample.id);
      if (!map || !candidate) return;
      layers.clearLayers();
      const line = L.polyline(candidate.points.map(point => [point.lat, point.lng]), {
        color: '#1ba464', weight: 5, opacity: 0.95
      }).addTo(layers);
      L.circleMarker([sample.origin.lat, sample.origin.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#2185d0', fillOpacity: 1 })
        .bindPopup('起点：' + escapeHtml(sample.origin.name)).addTo(layers);
      L.circleMarker([sample.destination.lat, sample.destination.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#172d42', fillOpacity: 1 })
        .bindPopup('终点：' + escapeHtml(sample.destination.name)).addTo(layers);
      for (const junction of audit?.junctions || []) {
        const marker = L.circleMarker([junction.lat, junction.lng], {
          radius: junction.status === 'matched' ? 6 : 5,
          color: '#fff', weight: 1.5,
          fillColor: junction.status === 'matched' ? '#dc593e' : '#e5ac19', fillOpacity: 0.95
        }).addTo(layers);
        marker.bindPopup((junction.status === 'matched' ? 'OSM 匹配' : '邻近待查') + ' · 距路线 ' +
          junction.distanceMeters + ' 米<br>' + escapeHtml(junction.reviewReasons.join('；')));
      }
      map.fitBounds(line.getBounds(), { padding: [25, 25], maxZoom: 16 });
    }

    document.getElementById('sample-rows').innerHTML = report.samples.map(sample => {
      const first = sample.candidates[0];
      const audit = first?.signalAudit;
      return '<tr data-id="' + escapeHtml(sample.id) + '"><td>' + escapeHtml(sample.id) + '</td><td>' + escapeHtml(sample.area) +
        '</td><td>' + escapeHtml(sample.origin.name) + ' → ' + escapeHtml(sample.destination.name) +
        '</td><td>' + sample.candidates.length + '</td><td>' + (first ? first.distanceKm + ' km' : '—') +
        '</td><td class="' + (sample.osmStatus === 'available' ? 'status-ok' : 'status-bad') + '">' +
        (sample.osmStatus === 'available' ? '成功' : sample.osmStatus === 'unavailable' ? '失败' : '未查询') +
        '</td><td>' + (audit ? audit.matchedJunctions : '—') + '</td><td>' +
        (audit ? audit.nearbyJunctions : '—') + '</td><td>' + (audit ? audit.reviewJunctions : '—') + '</td></tr>';
    }).join('');
    document.getElementById('review-rows').innerHTML = report.reviewSampleIds.map(id => {
      const sample = report.samples.find(item => item.id === id);
      const audit = sample.candidates[0].signalAudit;
      return '<tr data-id="' + escapeHtml(id) + '"><td>' + escapeHtml(id) + '</td><td>' +
        escapeHtml(sample.origin.name) + ' → ' + escapeHtml(sample.destination.name) + '</td><td>' +
        (sample.osmStatus === 'available' ? '成功' : '待重试') + '</td><td>' +
        (audit ? audit.matchedJunctions : '—') + '</td><td>' + (audit ? audit.nearbyJunctions : '—') +
        '</td><td>' + (audit ? audit.reviewJunctions : '—') + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="muted">暂无可复核路线。</td></tr>';
    for (const row of document.querySelectorAll('tbody tr[data-id]')) {
      row.addEventListener('click', () => showSample(row.dataset.id));
    }
    sampleSelect.addEventListener('change', () => showSample(sampleSelect.value));
    candidateSelect.addEventListener('change', () => showSample(sampleSelect.value, Number(candidateSelect.value)));
    if (report.samples.length) showSample(report.samples[0].id);
  </script>
</body>
</html>`;
}
