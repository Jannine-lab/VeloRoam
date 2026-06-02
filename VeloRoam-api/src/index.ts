import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import routeRoutes from './routes/routeRoutes';
import { initDatabase } from './config/db';
import { startStravaCrawler } from './scripts/stravaCrawler';

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/routes', routeRoutes);

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    crawler: process.env.ENABLE_CRAWLER === 'true' ? 'enabled' : 'disabled'
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
  } catch (err: any) {
    console.error('⚠️ [Database] Failed to bootstrap schema/connection. Operating in live routing mode only:', err.message);
  }
});

export default app;
