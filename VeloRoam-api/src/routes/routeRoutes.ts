import { Router } from 'express';
import { planRoute } from '../controllers/routeController';
import { getStravaSegments } from '../controllers/stravaController';
import { reverseGeocode, searchAddress } from '../controllers/geocodeController';
import { getHotPoints } from '../controllers/hotPointController';

const router = Router();

// POST /api/routes/plan
router.post('/plan', planRoute);

// GET /api/routes/strava-segments
router.get('/strava-segments', getStravaSegments);

// GET /api/routes/hot-points
router.get('/hot-points', getHotPoints);

// GET /api/routes/reverse-geocode
router.get('/reverse-geocode', reverseGeocode);

// GET /api/routes/search-address
router.get('/search-address', searchAddress);

export default router;
