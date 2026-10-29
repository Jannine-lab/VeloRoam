import axios from 'axios';
import dotenv from 'dotenv';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchAmapBicyclingCandidates } from '../services/amapFewestSignalService';
import { AuditSignalFeature, auditSignalsAlongRoute, RouteSignalAudit } from '../services/routeSignalAudit';
import { LatLng, gcj02ToWgs84, getDistanceMeters } from '../utils/polyline';
import { AuditReport, AuditSample, renderSignalAuditHtml } from './signalAuditReport';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const AREA_QUERIES: Record<string, string[]> = {
  '浦西中心': ['上海大剧院', '外滩', '静安寺', '上海自然博物馆', '豫园', '复兴公园', '上海图书馆', '鲁迅公园', '虹口足球场', '中山公园'],
  '浦西西南': ['徐家汇', '上海体育场', '龙华寺', '上海植物园', '上海南站', '上海交通大学徐汇校区', '漕河泾开发区', '虹桥火车站', '七宝古镇', '徐汇滨江绿地'],
  '浦东': ['东方明珠', '上海科技馆', '世纪公园', '世博源', '前滩太古里', '张江高科地铁站', '金桥国际商业广场', '浦东美术馆', '上海新国际博览中心', '上海中心大厦']
};

interface Anchor extends LatLng {
  query: string;
  name: string;
  address: string;
  area: string;
}

interface Pair {
  area: string;
  origin: Anchor;
  destination: Anchor;
  directKm: number;
}

interface Options {
  limit: number;
  outputDir: string;
  inputPath?: string;
}

function parseOptions(): Options {
  const args = process.argv.slice(2);
  let limit = 30;
  let inputPath: string | undefined;
  let outputDir = path.resolve(process.cwd(), 'reports/shanghai-signal-audit',
    new Date().toISOString().replace(/[:.]/g, '-'));
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--limit') {
      limit = Number(args[++index]);
    } else if (args[index] === '--output') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('--output requires a directory.');
      outputDir = path.resolve(value);
    } else if (args[index] === '--input') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('--input requires a report.json path.');
      inputPath = path.resolve(value);
    } else {
      throw new Error(`Unknown option: ${args[index]}. Use --limit N, --input FILE, or --output DIR.`);
    }
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 30) {
    throw new Error('--limit must be an integer from 1 to 30.');
  }
  if (inputPath && args.includes('--limit')) throw new Error('--limit cannot be used with --input.');
  return { limit, outputDir, inputPath };
}

async function geocodeAnchor(query: string, area: string, key: string): Promise<Anchor | null> {
  try {
    const response = await axios.get('https://restapi.amap.com/v3/assistant/inputtips', {
      params: { key, keywords: query, city: '上海', citylimit: true },
      timeout: 10000
    });
    if (response.data?.status !== '1') throw new Error(response.data?.info || 'AMap geocoding failed');
    const tips = (Array.isArray(response.data?.tips) ? response.data.tips : [])
      .map((tip: any) => {
        if (typeof tip.location !== 'string') return null;
        const [lng, lat] = tip.location.split(',').map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 30.6 || lat > 31.9 || lng < 120.8 || lng > 122.3) {
          return null;
        }
        const location = gcj02ToWgs84(lng, lat);
        return {
          query, area, name: String(tip.name || query),
          address: Array.isArray(tip.address) ? tip.address.join('') : String(tip.address || ''),
          ...location
        } as Anchor;
      }).filter((tip: Anchor | null): tip is Anchor => tip !== null);
    return tips.find((tip: Anchor) => tip.name === query) || tips[0] || null;
  } catch (error: any) {
    console.warn(`[audit] Could not geocode ${query}: ${error.message}`);
    return null;
  }
}

function pickAreaPairs(anchors: Anchor[], count: number): Pair[] {
  const pairs: Pair[] = [];
  for (let first = 0; first < anchors.length; first++) {
    for (let second = first + 1; second < anchors.length; second++) {
      const directKm = getDistanceMeters(anchors[first], anchors[second]) / 1000;
      if (directKm >= 0.8 && directKm <= 16) {
        pairs.push({ area: anchors[first].area, origin: anchors[first], destination: anchors[second], directKm });
      }
    }
  }

  const buckets = [
    { min: 0.8, max: 3.5, target: 4 },
    { min: 3.5, max: 7, target: 4 },
    { min: 7, max: 16, target: 2 }
  ];
  const chosen: Pair[] = [];
  const usedAnchors = new Map<string, number>();
  const chooseFrom = (candidates: Pair[], target: number) => {
    while (target > 0 && candidates.length > 0 && chosen.length < count) {
      candidates.sort((a, b) => {
        const useA = (usedAnchors.get(a.origin.query) || 0) + (usedAnchors.get(a.destination.query) || 0);
        const useB = (usedAnchors.get(b.origin.query) || 0) + (usedAnchors.get(b.destination.query) || 0);
        return useA - useB || a.directKm - b.directKm ||
          `${a.origin.query}${a.destination.query}`.localeCompare(`${b.origin.query}${b.destination.query}`);
      });
      const pair = candidates.shift()!;
      if (chosen.includes(pair)) continue;
      chosen.push(pair);
      usedAnchors.set(pair.origin.query, (usedAnchors.get(pair.origin.query) || 0) + 1);
      usedAnchors.set(pair.destination.query, (usedAnchors.get(pair.destination.query) || 0) + 1);
      target--;
    }
  };

  for (const bucket of buckets) {
    chooseFrom(pairs.filter(pair => pair.directKm >= bucket.min && pair.directKm < bucket.max), bucket.target);
  }
  chooseFrom(pairs.filter(pair => !chosen.includes(pair)), count - chosen.length);
  return chosen;
}

function selectSamples(anchors: Anchor[], limit: number): AuditSample[] {
  const byArea = Object.keys(AREA_QUERIES).map(area =>
    pickAreaPairs(anchors.filter(anchor => anchor.area === area), 10));
  const interleaved: Pair[] = [];
  for (let index = 0; index < 10; index++) {
    for (const pairs of byArea) {
      if (pairs[index]) interleaved.push(pairs[index]);
    }
  }
  return interleaved.slice(0, limit).map((pair, index) => ({
    id: `SH-${String(index + 1).padStart(2, '0')}`,
    area: pair.area,
    origin: pair.origin,
    destination: pair.destination,
    directKm: Number(pair.directKm.toFixed(2)),
    routeStatus: 'pending',
    osmStatus: 'pending',
    candidates: []
  }));
}

function boundingBox(points: LatLng[]): string {
  if (points.length === 0) throw new Error('Cannot query OSM without route geometry.');
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (const point of points) {
    minLat = Math.min(minLat, point.lat);
    minLng = Math.min(minLng, point.lng);
    maxLat = Math.max(maxLat, point.lat);
    maxLng = Math.max(maxLng, point.lng);
  }
  return [minLat - 0.0006, minLng - 0.0006, maxLat + 0.0006, maxLng + 0.0006]
    .map(value => value.toFixed(5)).join(',');
}

async function fetchAreaSignals(points: LatLng[]): Promise<AuditSignalFeature[]> {
  const bounds = boundingBox(points);
  const query = `[out:json][timeout:20];(` +
    `node["highway"="traffic_signals"](${bounds});` +
    `node["crossing"="traffic_signals"](${bounds});` +
    `node["crossing:signals"="yes"](${bounds});` +
    `);out body;`;
  const response = await axios.post(
    process.env.OSM_TRAFFIC_SIGNAL_OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
    `data=${encodeURIComponent(query)}`,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'VeloRoam-signal-audit/1.0'
      },
      timeout: 28000
    }
  );
  if (!Array.isArray(response.data?.elements)) throw new Error('Invalid Overpass response');
  const byId = new Map<number, AuditSignalFeature>();
  for (const node of response.data.elements) {
    if (node.type !== 'node' || !Number.isFinite(node.id) || !Number.isFinite(node.lat) || !Number.isFinite(node.lon)) continue;
    byId.set(node.id, { id: node.id, lat: node.lat, lng: node.lon, tags: node.tags || {} });
  }
  return [...byId.values()];
}

function chooseReviewSamples(samples: AuditSample[]): string[] {
  const mapped = samples.filter(sample => sample.candidates.length > 0);
  const available = samples.filter(sample => sample.osmStatus === 'available' && sample.candidates.length > 0);
  const baseline: AuditSample[] = [];
  for (const area of Object.keys(AREA_QUERIES)) {
    baseline.push(...mapped.filter(sample => sample.area === area).slice(0, 2));
  }
  const chosen = new Set(baseline.map(sample => sample.id));
  const remainder = available.filter(sample => !chosen.has(sample.id)).sort((a, b) => {
    const score = (sample: AuditSample) => {
      const audit = sample.candidates[0].signalAudit;
      return (audit?.nearbyJunctions || 0) * 3 + (audit?.reviewJunctions || 0) * 2 +
        (audit?.matchedJunctions === 0 ? 1 : 0);
    };
    return score(b) - score(a) || a.id.localeCompare(b.id);
  });
  for (const sample of remainder) {
    if (chosen.size >= 10) break;
    chosen.add(sample.id);
  }
  return [...chosen];
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRows(rows: unknown[][]): string {
  return rows.map(row => row.map(csvCell).join(',')).join('\n') + '\n';
}

function summaryCsv(report: AuditReport): string {
  const rows: unknown[][] = [[
    'sample_id', 'area', 'origin', 'destination', 'direct_km', 'route_status', 'osm_status',
    'alternative', 'distance_km', 'duration_min', 'osm_matched_junctions',
    'osm_nearby_junctions', 'needs_review_junctions', 'error'
  ]];
  for (const sample of report.samples) {
    for (const candidate of sample.candidates.length ? sample.candidates : [null]) {
      const audit: RouteSignalAudit | undefined = candidate?.signalAudit;
      rows.push([
        sample.id, sample.area, sample.origin.name, sample.destination.name,
        sample.directKm, sample.routeStatus, sample.osmStatus,
        candidate?.alternative, candidate?.distanceKm, candidate?.durationMin,
        audit?.matchedJunctions, audit?.nearbyJunctions, audit?.reviewJunctions,
        sample.error || sample.osmError || ''
      ]);
    }
  }
  return csvRows(rows);
}

function reviewCsv(report: AuditReport): string {
  const rows: unknown[][] = [[
    'sample_id', 'area', 'origin', 'destination', 'alternative', 'distance_km',
    'osm_matched_junctions', 'osm_nearby_junctions', 'review_reason',
    'verified_actual_junctions', 'verified_missing_junctions', 'verified_false_matches', 'review_notes'
  ]];
  for (const id of report.reviewSampleIds) {
    const sample = report.samples.find(item => item.id === id)!;
    const route = sample.candidates[0];
    rows.push([
      id, sample.area, sample.origin.name, sample.destination.name, route.alternative,
      route.distanceKm, route.signalAudit?.matchedJunctions,
      route.signalAudit?.nearbyJunctions,
      sample.osmStatus !== 'available' ? '代表性样本；OSM 待重试' :
        route.signalAudit?.reviewJunctions ? '存在需核对路口' : '代表性样本', '', '', '', ''
    ]);
  }
  return csvRows(rows);
}

async function main(): Promise<void> {
  const options = parseOptions();
  let report: AuditReport;
  if (options.inputPath) {
    report = JSON.parse(await readFile(options.inputPath, 'utf8')) as AuditReport;
    if (!Array.isArray(report.samples) || report.samples.some(sample => !Array.isArray(sample.candidates))) {
      throw new Error('--input must point to a Shanghai signal audit report.json.');
    }
    console.log(`[audit] Reusing ${report.samples.length} saved samples; querying OSM only.`);
  } else {
    const key = process.env.AMAP_API_KEY;
    if (!key) throw new Error('AMAP_API_KEY is required in VeloRoam-api/.env');
    const anchors: Anchor[] = [];
    for (const [area, queries] of Object.entries(AREA_QUERIES)) {
      for (const query of queries) {
        const anchor = await geocodeAnchor(query, area, key);
        if (anchor) anchors.push(anchor);
      }
    }
    const samples = selectSamples(anchors, options.limit);
    if (samples.length === 0) throw new Error('No usable Shanghai A-to-B samples were geocoded.');
    console.log(`[audit] Geocoded ${anchors.length} anchors; planning ${samples.length} samples.`);

    for (const sample of samples) {
      try {
        const candidates = await fetchAmapBicyclingCandidates(sample.origin, sample.destination);
        sample.candidates = candidates.map((route, index) => ({
          alternative: index + 1,
          distanceKm: Number(route.distanceKm.toFixed(2)),
          durationMin: route.durationMin,
          points: route.points
        }));
        sample.routeStatus = 'available';
      } catch (error: any) {
        sample.routeStatus = 'failed';
        sample.osmStatus = 'not_queried';
        sample.error = error.message;
      }
      console.log(`[audit] ${sample.id} ${sample.origin.name} → ${sample.destination.name}: ${sample.routeStatus}`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    report = {
      generatedAt: new Date().toISOString(),
      sampleTarget: options.limit,
      geocodedAnchors: anchors.length,
      samples,
      reviewSampleIds: []
    };
  }

  const areas = Object.keys(AREA_QUERIES);
  for (const [areaIndex, area] of areas.entries()) {
    const areaSamples = report.samples.filter(sample => sample.area === area &&
      sample.candidates.length > 0 && sample.osmStatus !== 'available');
    if (areaSamples.length === 0) continue;
    const points = areaSamples.flatMap(sample => sample.candidates.flatMap(candidate => candidate.points));
    try {
      const signals = await fetchAreaSignals(points);
      for (const sample of areaSamples) {
        sample.osmStatus = 'available';
        delete sample.osmError;
        for (const candidate of sample.candidates) {
          candidate.signalAudit = auditSignalsAlongRoute(candidate.points, signals);
        }
      }
      console.log(`[audit] ${area}: OSM query succeeded, ${signals.length} tagged nodes in bounds.`);
    } catch (error: any) {
      for (const sample of areaSamples) {
        sample.osmStatus = 'unavailable';
        sample.osmError = error.message;
      }
      console.warn(`[audit] ${area}: OSM unavailable (${error.message}). Counts left blank.`);
      if (areaIndex < areas.length - 1 && [406, 429].includes(error.response?.status)) {
        console.warn('[audit] Overpass is busy; waiting 30 seconds before the next area.');
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }
  }

  report.generatedAt = new Date().toISOString();
  report.reviewSampleIds = chooseReviewSamples(report.samples);
  await mkdir(path.dirname(options.outputDir), { recursive: true });
  await mkdir(options.outputDir);
  await writeFile(path.join(options.outputDir, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(options.outputDir, 'summary.csv'), summaryCsv(report));
  await writeFile(path.join(options.outputDir, 'review.csv'), reviewCsv(report));
  await writeFile(path.join(options.outputDir, 'report.html'), renderSignalAuditHtml(report));
  console.log(`[audit] Report: ${path.join(options.outputDir, 'report.html')}`);
}

// main().catch(error => {
//   console.error(`[audit] ${error.message}`);
//   process.exitCode = 1;
// });
void main;
console.error('[audit] Shanghai signal audit is temporarily disabled.');
process.exitCode = 1;
