import { Router } from 'express';
import { recommendIdeas } from '../controllers/ideaController';
import { ideaDistanceRecommendations } from '../controllers/ideaDistanceController';
import { ideaGreeting } from '../controllers/ideaGreetingController';
import { planFewestSignals, planRoute } from '../controllers/routeController';
import { getStravaSegments, getStravaSegmentDetail } from '../controllers/stravaController';
import { reverseGeocode, searchAddress } from '../controllers/geocodeController';
import { getHotPoints } from '../controllers/hotPointController';

const router = Router();

// POST /api/routes/plan
router.post('/idea-recommendations', recommendIdeas);
router.post('/idea-distance-recommendations', ideaDistanceRecommendations);
router.post('/idea-greeting', ideaGreeting);
router.post('/plan', planRoute);
router.post('/plan-fewest-signals', planFewestSignals);

// GET /api/routes/strava-segments
router.get('/strava-segments', getStravaSegments);
router.get('/strava-segments/:id', getStravaSegmentDetail);

// GET /api/routes/hot-points
router.get('/hot-points', getHotPoints);

// GET /api/routes/reverse-geocode
router.get('/reverse-geocode', reverseGeocode);

// GET /api/routes/search-address
router.get('/search-address', searchAddress);

export default router;
