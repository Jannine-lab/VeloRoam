import { Router } from 'express';
import {
  getCrawlerStatus,
  runHotPointCrawlerOnce,
  runStravaCrawlerOnce,
  startHotPointCrawlerScheduler,
  startStravaCrawlerScheduler,
  stopHotPointCrawlerScheduler,
  stopStravaCrawlerScheduler
} from '../controllers/crawlerController';

const router = Router();

router.get('/status', getCrawlerStatus);

router.post('/strava/run', runStravaCrawlerOnce);
router.post('/strava/start', startStravaCrawlerScheduler);
router.post('/strava/stop', stopStravaCrawlerScheduler);

router.post('/hot-points/run', runHotPointCrawlerOnce);
router.post('/hot-points/start', startHotPointCrawlerScheduler);
router.post('/hot-points/stop', stopHotPointCrawlerScheduler);

export default router;
