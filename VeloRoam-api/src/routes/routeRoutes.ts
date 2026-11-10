import { Router } from 'express';
import { routeGeneratorDebug } from '../controllers/routeGeneratorDebugController';
import { recommendIdeas } from '../controllers/ideaController';
import { ideaDistanceRecommendations } from '../controllers/ideaDistanceController';
import { ideaGreeting } from '../controllers/ideaGreetingController';
import { planSegmentRoundTrip } from '../controllers/segmentRoundTripController';
import { planFewestSignals, planRoute, planRouteWithStops } from '../controllers/routeController';
import { getStravaSegments, getStravaSegmentDetail, searchStravaSegments } from '../controllers/stravaController';
import { reverseGeocode, searchAddress } from '../controllers/geocodeController';
import { getHotPoints, getScenicDiscoveries, getScenicMapPoints } from '../controllers/hotPointController';

const router = Router();

// POST /api/routes/plan
router.post('/debug/route-generator', routeGeneratorDebug);
router.post('/idea-recommendations', recommendIdeas);
router.post('/idea-distance-recommendations', ideaDistanceRecommendations);
router.post('/idea-greeting', ideaGreeting);
router.post('/segment-round-trip', planSegmentRoundTrip);
router.post('/plan', planRoute);
router.post('/plan-fewest-signals', planFewestSignals);
router.post('/plan-with-stops', planRouteWithStops);

// GET /api/routes/strava-segments
router.get('/strava-segments', getStravaSegments);
router.get('/strava-segments/search', searchStravaSegments);
router.get('/strava-segments/:id', getStravaSegmentDetail);

// GET /api/routes/hot-points
router.get('/hot-points', getHotPoints);
router.get('/scenic-discoveries', getScenicDiscoveries);
router.get('/scenic-map-points', getScenicMapPoints);

// GET /api/routes/reverse-geocode
router.get('/reverse-geocode', reverseGeocode);

// GET /api/routes/search-address
router.get('/search-address', searchAddress);

export default router;
