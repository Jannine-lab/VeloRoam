import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { resolve } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import axios from 'axios';
import { wgs84ToGcj02 } from './utils/polyline';
import { allowLocalDebug } from './controllers/routeGeneratorDebugController';
import routeRoutes from './routes/routeRoutes';
import crawlerRoutes from './routes/crawlerRoutes';
import { initDatabase, pool } from './config/db';
import { startStravaCrawler } from './scripts/stravaCrawler';
import { startAmapHotPointCrawler } from './scripts/amapHotPointCrawler';

const app = express();
const port = process.env.PORT || 3000;

// Only trust forwarding headers from the local reverse proxy.
app.set('trust proxy', 'loopback');

// Middleware
app.use(cors());
app.use(express.json());

// Authentication is enforced by the server, never by the HTML page.
function observerAuth(req: Request, res: Response, next: NextFunction) {
  res.set('Cache-Control', 'no-store');
  const username = process.env.OBSERVER_USERNAME;
  const password = process.env.OBSERVER_PASSWORD;
  if (!username || !password) return res.status(503).send('Observer is not configured');
  const authorization = req.headers.authorization || '';
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  const supplied = match ? Buffer.from(match[1], 'base64').toString('utf8') : '';
  const separator = supplied.indexOf(':');
  const equal = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
  const validUser = equal(separator < 0 ? '' : supplied.slice(0, separator), username);
  const validPassword = equal(separator < 0 ? '' : supplied.slice(separator + 1), password);
  if (!match || separator < 0 || !validUser || !validPassword) {
    res.set('WWW-Authenticate', 'Basic realm="VeloRoam Observer", charset="UTF-8"');
    return res.status(401).send('Authentication required');
  }
  return next();
}

app.get('/observer', observerAuth, (_req, res) => {
  res.sendFile(resolve(process.env.OBSERVER_HTML_PATH || resolve(__dirname, '../../VeloRoam-ui/observer.html')));
});

app.post('/api/observer/events', async (req, res) => {
  const { type, session, data } = req.body || {};
  if (!['visit', 'route', 'location'].includes(type) || typeof session !== 'string' || !/^[a-f0-9-]{36}$/.test(session) || !data || typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data).length > 20000) return res.status(400).json({ error: 'Invalid event' });
  try {
    await pool.execute('INSERT INTO observer_events (event_type, session_id, data, user_agent) VALUES (?, ?, ?, ?)', [type, session, JSON.stringify({ ...data, clientIp: req.ip || null }), (req.get('user-agent') || '').slice(0, 512)]);
    return res.status(204).end();
  } catch (error) {
    console.error('Observer event storage failed:', error);
    return res.status(503).json({ error: 'Storage unavailable' });
  }
});

app.get('/api/observer/events', observerAuth, async (req, res) => {
  const conditions: string[] = [], params: (string | number)[] = [];
  const str = (key: string) => typeof req.query[key] === 'string' ? String(req.query[key]).trim().slice(0, 100) : '';
  const start = str('start'), end = str('end'), type = str('type'), id = str('id'), ip = str('ip'), coordinates = str('coordinates');
  const datePattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  if ((start && !datePattern.test(start)) || (end && !datePattern.test(end)) || (id && !/^\d+$/.test(id)) || (type && !['visit', 'location', 'route'].includes(type))) return res.status(400).json({ error: 'Invalid filter' });
  if (start) { conditions.push('created_at >= ?'); params.push(start); }
  if (end) { conditions.push('created_at <= ?'); params.push(end); }
  if (type) { conditions.push('event_type = ?'); params.push(type); }
  if (id) { conditions.push('id = ?'); params.push(id); }
  if (ip) { conditions.push("JSON_UNQUOTE(JSON_EXTRACT(data, '$.clientIp')) LIKE ?"); params.push(`%${ip.replace(/[\\%_]/g, '\\$&')}%`); }
  if (coordinates) { conditions.push("CONCAT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data, '$.latitude')), ''), ',', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data, '$.longitude')), '')) LIKE ?"); params.push(`%${coordinates.replace(/[\\%_]/g, '\\$&')}%`); }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const page = Math.max(1, Math.min(1000000, Math.floor(Number(str('page')) || 1)));
  const size = Math.max(1, Math.min(500, Math.floor(Number(str('size')) || 50)));
  try {
    const [rows] = await pool.query(`SELECT id, created_at, event_type, session_id, data, user_agent FROM observer_events${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size]);
    const [counts] = await pool.query<any[]>(`SELECT COUNT(*) AS total, SUM(event_type='visit') AS visits, SUM(event_type='location') AS locations, SUM(event_type='route') AS routes FROM observer_events${where}`, params);
    return res.json({ events: rows, summary: counts[0], page, size });
  } catch (error) {
    console.error('Observer read failed:', error);
    return res.status(503).json({ error: 'Storage unavailable' });
  }
});

// Resolve locations only for an authenticated administrator.
app.get('/api/observer/geocode', observerAuth, async (req, res) => {
  const key = process.env.AMAP_API_KEY;
  if (!key) return res.status(503).json({ error: 'AMAP_API_KEY is not configured' });
  const ip = typeof req.query.ip === 'string' ? req.query.ip.replace(/^::ffff:/, '') : '';
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  const isCoordinate = req.query.lat !== undefined && req.query.lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if (!isCoordinate && isIP(ip) !== 4) return res.status(400).json({ error: 'Invalid coordinates or IPv4 address' });
  try {
    const point = isCoordinate ? wgs84ToGcj02(lng, lat) : null;
    const response = await axios.get(isCoordinate ? 'https://restapi.amap.com/v3/geocode/regeo' : 'https://restapi.amap.com/v3/ip', {
      params: point ? { key, location: `${point.lng.toFixed(6)},${point.lat.toFixed(6)}` } : { key, ip }, timeout: 8000
    });
    if (response.data?.status !== '1') return res.status(502).json({ error: 'AMap lookup failed' });
    const result = response.data;
    const address = isCoordinate ? result.regeocode?.formatted_address : [result.province, result.city].filter((x: unknown) => typeof x === 'string' && x).filter((x: string, i: number, a: string[]) => a.indexOf(x) === i).join(' ');
    return res.json({ address: address || null });
  } catch (_error) { return res.status(502).json({ error: 'AMap lookup unavailable' }); }
});

// Local-only, explicitly enabled development visualizer.
app.get('/dev/route-generator', (req, res) => {
  if (!allowLocalDebug(req)) return res.status(404).send('Not found');
  return res.sendFile(resolve(__dirname, '../../dev/route-generator.html'));
});

// Routes
app.use('/api/routes', routeRoutes);
app.use('/api/crawlers', crawlerRoutes);

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    crawler: process.env.ENABLE_CRAWLER === 'true' ? 'enabled' : 'disabled',
    hotPointCrawler: process.env.ENABLE_HOT_POINT_CRAWLER === 'true' ? 'enabled' : 'disabled'
  });
});

// Start server
app.listen(Number(port), '0.0.0.0', async () => {
  console.log(`========================================`);
  console.log(`🚴 VeloRoam API Server is running!`);
  console.log(`🔌 Port: ${port}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`========================================`);

  // 🔄 异步初始化数据库，防止 DB 连不上阻塞 Web 进程启动
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS observer_events (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, event_type VARCHAR(16) NOT NULL, session_id CHAR(36) NOT NULL, data JSON NOT NULL, user_agent VARCHAR(512) NOT NULL, INDEX (created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await initDatabase();
    
    // 如果配置了启用爬虫，则拉起后台扫描任务
    if (process.env.ENABLE_CRAWLER === 'true') {
      startStravaCrawler();
    } else {
      console.log('💡 [Crawler] ENABLE_CRAWLER is not set to "true". Skipping scheduler.');
    }

    if (process.env.ENABLE_HOT_POINT_CRAWLER === 'true') {
      startAmapHotPointCrawler();
    } else {
      console.log('💡 [HotPointCrawler] ENABLE_HOT_POINT_CRAWLER is not set to "true". Skipping scheduler.');
    }
  } catch (err: any) {
    console.error('⚠️ [Database] Failed to bootstrap schema/connection. Operating in live routing mode only:', err.message);
  }
});

export default app;
