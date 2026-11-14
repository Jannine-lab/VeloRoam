// Local checkpointing and decoding only. Network responses come from the logged-in map.
import fs from 'node:fs';
import path from 'node:path';
const ZOOM = 13;
const BOUNDS = { south: 31.98, west: 119.58, north: 33.24, east: 120.59 };
const DEFAULT_ROOT = '/Users/jannine/Desktop/VeloRoam/dev/strava-taizhou-z13-2026-11-14';

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
}
function varint(bytes, cursor) {
  let result = 0, scale = 1;
  for (let count = 0; count < 10 && cursor.pos < bytes.length; count++) {
    const byte = bytes[cursor.pos++];
    result += (byte & 127) * scale;
    if (!(byte & 128)) return result;
    scale *= 128;
  }
  throw new Error('Invalid protobuf varint');
}
function fields(bytes) {
  const cursor = { pos: 0 }, out = [];
  while (cursor.pos < bytes.length) {
    const tag = varint(bytes, cursor), field = Math.floor(tag / 8), wire = tag % 8;
    let value;
    if (wire === 0) value = varint(bytes, cursor);
    else if (wire === 2) {
      const size = varint(bytes, cursor);
      if (cursor.pos + size > bytes.length) throw new Error('Truncated protobuf field');
      value = bytes.subarray(cursor.pos, cursor.pos + size);
      cursor.pos += size;
    } else if (wire === 1) { value = bytes.readDoubleLE(cursor.pos); cursor.pos += 8; }
    else if (wire === 5) { value = bytes.readFloatLE(cursor.pos); cursor.pos += 4; }
    else throw new Error(`Unsupported protobuf wire ${wire}`);
    out.push({ field, value });
  }
  return out;
}
function packed(bytes) {
  const cursor = { pos: 0 }, out = [];
  while (cursor.pos < bytes.length) out.push(varint(bytes, cursor));
  return out;
}
function decodeSegments(response) {
  const bytes = Buffer.from(response.body, response.base64Encoded ? 'base64' : 'utf8');
  const segments = new Map();
  for (const layer of fields(bytes).filter(f => f.field === 3)) {
    const all = fields(layer.value);
    if (all.find(f => f.field === 1)?.value.toString('utf8') !== 'segments') continue;
    const keys = all.filter(f => f.field === 3).map(f => f.value.toString('utf8'));
    const values = all.filter(f => f.field === 4).map(f => {
      const v = fields(f.value)[0];
      if (!v) throw new Error('Empty tile value');
      if (v.field === 1) return v.value.toString('utf8');
      if (v.field === 6) return v.value % 2 ? -(v.value + 1) / 2 : v.value / 2;
      return v.value;
    });
    for (const f of all.filter(f => f.field === 2)) {
      const feature = fields(f.value);
      const tags = packed(feature.find(t => t.field === 2)?.value || Buffer.alloc(0));
      if (tags.length % 2) throw new Error('Invalid tile tags');
      const props = {};
      for (let i = 0; i < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      const id = String(props.segmentId);
      if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))
        || !Number.isFinite(props.score) || props.score < 0
        || typeof props.name !== 'string') throw new Error('Invalid segment ID, score, or name');
      segments.set(id, { id, tileScore: props.score, name: props.name,
        distanceM: props.distance, avgGrade: props.avgGrade,
        startLat: props.startXYLat, startLng: props.startXYLng });
    }
  }
  return [...segments.values()];
}
function tileX(lng) { return Math.floor((lng + 180) / 360 * 2 ** ZOOM); }
function tileY(lat) { return Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** ZOOM); }
function longitude(x) { return x / 2 ** ZOOM * 360 - 180; }
function latitude(y) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** ZOOM))) * 180 / Math.PI; }

function openScan(root = DEFAULT_ROOT) {
  const manifestFile = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    const x0 = tileX(BOUNDS.west), x1 = tileX(BOUNDS.east);
    const y0 = tileY(BOUNDS.north), y1 = tileY(BOUNDS.south);
    const tiles = {}, visits = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      tiles[`${ZOOM}/${x}/${y}`] = { z: ZOOM, x, y, status: 'pending' };
    }
    for (let y = y0, row = 0; y <= y1; y += 2, row++) {
      const xs = [];
      for (let x = x0; x <= x1; x += 2) xs.push(x);
      if (row % 2) xs.reverse();
      for (const x of xs) visits.push({
        x, y, xEnd: Math.min(x + 1, x1), yEnd: Math.min(y + 1, y1),
        centerLng: longitude(x + 1), centerLat: latitude(y + 1)
      });
    }
    atomicJson(manifestFile, { version: 1, zoom: ZOOM, bounds: BOUNDS,
      xRange: [x0, x1], yRange: [y0, y1], createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), tiles, visits, visitLog: [] });
  }
  return new Scan(root, JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
}
class Scan {
  constructor(root, manifest) { this.root = root; this.manifest = manifest; }
  save() {
    this.manifest.updatedAt = new Date().toISOString();
    atomicJson(path.join(this.root, 'manifest.json'), this.manifest);
  }
  ingest(tiles, capturedAt = new Date().toISOString()) {
    let added = 0, ignored = 0, errors = 0;
    for (const tile of tiles) {
      const key = `${tile.z}/${tile.x}/${tile.y}`, entry = this.manifest.tiles[key];
      if (!entry || entry.status === 'complete') { ignored++; continue; }
      try {
        if (tile.status !== undefined && tile.status !== 200) throw new Error(`HTTP ${tile.status}`);
        const segments = decodeSegments(tile.response);
        atomicJson(path.join(this.root, 'tiles', `${tile.z}-${tile.x}-${tile.y}.json`),
          { source: 'strava-map-vector-tile', capturedAt,
            tile: { z: tile.z, x: tile.x, y: tile.y }, segments });
        Object.assign(entry, { status: 'complete', capturedAt, segmentCount: segments.length });
        delete entry.error;
        added++;
      } catch (error) { entry.status = 'error'; entry.error = error.message; errors++; }
    }
    this.save();
    return { added, ignored, errors, ...this.status() };
  }
  status() {
    const tiles = Object.values(this.manifest.tiles);
    return { total: tiles.length, complete: tiles.filter(t => t.status === 'complete').length,
      pending: tiles.filter(t => t.status !== 'complete').length,
      errors: tiles.filter(t => t.status === 'error').length };
  }
  visitComplete(visit) {
    for (let y = visit.y; y <= visit.yEnd; y++) for (let x = visit.x; x <= visit.xEnd; x++) {
      if (this.manifest.tiles[`${ZOOM}/${x}/${y}`]?.status !== 'complete') return false;
    }
    return true;
  }
  nextVisit() {
    const counts = new Map();
    for (const v of this.manifest.visitLog) counts.set(v.key, (counts.get(v.key) || 0) + 1);
    for (const v of this.manifest.visits) {
      const key = `${v.x}/${v.y}`;
      if (!this.visitComplete(v) && (counts.get(key) || 0) < 2) return { ...v, key };
    }
    const missing = Object.values(this.manifest.tiles).find(t => t.status !== 'complete');
    if (!missing) return null;
    return { x: missing.x, y: missing.y, xEnd: missing.x, yEnd: missing.y,
      centerLng: longitude(missing.x + 0.5), centerLat: latitude(missing.y + 0.5), key: `repair/${missing.x}/${missing.y}` };
  }
  logVisit(visit, extra = {}) {
    this.manifest.visitLog.push({ key: visit.key, at: new Date().toISOString(), ...extra });
    this.save();
  }
  exportCandidates() {
    const segments = new Map(), scoreConflicts = [];
    for (const tile of Object.values(this.manifest.tiles).filter(t => t.status === 'complete')) {
      const record = JSON.parse(fs.readFileSync(path.join(this.root, 'tiles', `${ZOOM}-${tile.x}-${tile.y}.json`), 'utf8'));
      for (const segment of record.segments) {
        const previous = segments.get(segment.id);
        if (previous && previous.tileScore !== segment.tileScore) scoreConflicts.push({ id: segment.id, scores: [previous.tileScore, segment.tileScore] });
        // A single capture is retained per ID; conflicts remain reviewable in the report.
        if (!previous) segments.set(segment.id, segment);
      }
    }
    const output = { source: 'strava-map-vector-tile', capturedAt: this.manifest.updatedAt,
      tile: { zoom: ZOOM, bounds: BOUNDS, completeTiles: this.status().complete },
      segments: [...segments.values()].sort((a, b) => Number(a.id) - Number(b.id)) };
    atomicJson(path.join(this.root, 'candidates.json'), output);
    atomicJson(path.join(this.root, 'summary.json'), { ...this.status(), uniqueSegments: segments.size,
      scoreConflicts, updatedAt: this.manifest.updatedAt });
    return { ...this.status(), uniqueSegments: segments.size, scoreConflicts: scoreConflicts.length,
      candidates: path.join(this.root, 'candidates.json') };
  }
}
export { openScan, decodeSegments, DEFAULT_ROOT };
