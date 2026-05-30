import { Request, Response } from 'express';
import { exploreStravaSegments } from '../services/stravaService';

export const getStravaSegments = async (req: Request, res: Response) => {
  try {
    const { bounds, zoom } = req.query;

    if (!bounds || typeof bounds !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid bounds parameter. Expected format: south,west,north,east' });
    }

    // Clean all whitespaces, newlines, and carriage returns from the bounds string
    const cleanBounds = bounds.replace(/\s+/g, '');
    console.log(`[StravaController] Raw bounds: ${JSON.stringify(bounds)}, Cleaned bounds: ${JSON.stringify(cleanBounds)}, Zoom: ${zoom}`);

    const boundsParts = cleanBounds.split(',').map(Number);
    if (boundsParts.length !== 4 || boundsParts.some(isNaN)) {
      return res.status(400).json({ error: 'Invalid bounds format. Expected 4 comma-separated numbers: south,west,north,east' });
    }

    const [south, west, north, east] = boundsParts;
    const zoomVal = zoom ? parseInt(zoom as string, 10) : undefined;

    console.log(`[StravaController] Querying segments for bounds: [south:${south}, west:${west}, north:${north}, east:${east}], Zoom: ${zoomVal}`);
    const segments = await exploreStravaSegments(south, west, north, east, zoomVal);

    return res.status(200).json(segments);
  } catch (error: any) {
    console.error(`[StravaController] Error fetching segments:`, error.message);
    return res.status(500).json({
      error: 'Failed to fetch Strava segments.',
      details: error.message
    });
  }
};
