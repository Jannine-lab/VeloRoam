import { Request, Response } from 'express';
import { planRouteService } from '../services/googleMapsService';

interface LatLng {
  lat: number;
  lng: number;
}

interface CyclingPreferences {
  supplyType?: string;
  supplyDistance?: number;
  autoLoopback?: boolean;
}

interface PlanRouteRequest {
  origin: LatLng;
  destination: LatLng;
  waypoints?: LatLng[];
  preferences?: CyclingPreferences;
}

export const planRoute = async (req: Request, res: Response) => {
  try {
    const { origin, destination, waypoints, preferences } = req.body as PlanRouteRequest;

    // Validate request
    if (!origin || typeof origin.lat !== 'number' || typeof origin.lng !== 'number') {
      return res.status(400).json({ error: 'Missing or invalid origin coordinates.' });
    }
    if (!destination || typeof destination.lat !== 'number' || typeof destination.lng !== 'number') {
      return res.status(400).json({ error: 'Missing or invalid destination coordinates.' });
    }

    if (waypoints && !Array.isArray(waypoints)) {
      return res.status(400).json({ error: 'Waypoints must be an array of coordinates.' });
    }

    console.log(`[RouteController] Received route request:`, {
      origin,
      destination,
      waypointsCount: waypoints?.length || 0,
      hasPreferences: !!preferences
    });

    const result = await planRouteService(origin, destination, waypoints || [], preferences);
    
    return res.status(200).json(result);
  } catch (error: any) {
    console.error(`[RouteController] Error planning route:`, error.message);
    return res.status(500).json({
      error: 'An internal error occurred while planning the route.',
      details: error.message
    });
  }
};
