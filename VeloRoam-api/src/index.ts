import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { resolve } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { allowLocalDebug } from './controllers/routeGeneratorDebugController';
import routeRoutes from './routes/routeRoutes';
import crawlerRoutes from './routes/crawlerRoutes';
import { initDatabase } from './config/db';
import { startStravaCrawler } from './scripts/stravaCrawler';
import { startAmapHotPointCrawler } from './scripts/amapHotPointCrawler';

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Authentication is enforced by the server, never by the HTML page.
app.get('/observer', (req, res) => {
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
  return res.sendFile(resolve(process.env.OBSERVER_HTML_PATH || resolve(__dirname, '../../VeloRoam-ui/observer.html')));
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
