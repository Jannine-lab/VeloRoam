import { Router } from 'express';
import { planRoute } from '../controllers/routeController';
import { getStravaSegments } from '../controllers/stravaController';
import { reverseGeocode, searchAddress } from '../controllers/geocodeController';
import { getHotspotsInBounds, getNearbyHotspots } from '../controllers/hotspotController';

const router = Router();

// POST /api/routes/plan
router.post('/plan', planRoute);

// GET /api/routes/strava-segments
router.get('/strava-segments', getStravaSegments);

// GET /api/routes/reverse-geocode
router.get('/reverse-geocode', reverseGeocode);

// GET /api/routes/search-address
router.get('/search-address', searchAddress);

// GET /api/routes/hotspots
router.get('/hotspots', getHotspotsInBounds);

// GET /api/routes/hotspots/nearby
router.get('/hotspots/nearby', getNearbyHotspots);

export default router;
