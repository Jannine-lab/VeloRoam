import { Router } from 'express';
import { planRoute } from '../controllers/routeController';
import { getStravaSegments } from '../controllers/stravaController';

const router = Router();

// POST /api/routes/plan
router.post('/plan', planRoute);

// GET /api/routes/strava-segments
router.get('/strava-segments', getStravaSegments);

export default router;
