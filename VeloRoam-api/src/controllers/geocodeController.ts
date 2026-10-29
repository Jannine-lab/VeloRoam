import { Request, Response } from 'express';
import axios from 'axios';
import { gcj02ToWgs84 } from '../utils/polyline';

const amapApiKey = process.env.AMAP_API_KEY || '';

/**
 * GET /api/routes/reverse-geocode
 * Query parameters: lat, lng
 */
export const reverseGeocode = async (req: Request, res: Response) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) {
      return res.status(400).json({ error: 'Missing lat or lng query parameters.' });
    }

    if (!amapApiKey) {
      return res.status(500).json({ error: 'AMAP_API_KEY is not configured on the server.' });
    }

    const url = `https://restapi.amap.com/v3/geocode/regeo?key=${amapApiKey}&location=${lng},${lat}`;
    console.log(`[GeocodeController] Requesting AMap regeo: location=${lng},${lat}`);

    const response = await axios.get(url);
    if (response.data && response.data.status === '1') {
      const regeocode = response.data.regeocode;
      const formattedAddress = regeocode.formatted_address || '未知位置';
      return res.status(200).json({ address: formattedAddress });
    } else {
      console.warn(`[GeocodeController] AMap regeo returned error:`, response.data);
      return res.status(400).json({ error: `AMap API returned error: ${response.data.info}` });
    }
  } catch (error: any) {
    console.error(`[GeocodeController] Reverse geocoding error:`, error.message);
    return res.status(500).json({ error: 'Failed to perform reverse geocoding.', details: error.message });
  }
};

/**
 * GET /api/routes/search-address
 * Query parameters: q
 */
export const searchAddress = async (req: Request, res: Response) => {
  try {
    const { q } = req.query;
    if (!q || typeof q !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid q query parameter.' });
    }

    if (!amapApiKey) {
      return res.status(500).json({ error: 'AMAP_API_KEY is not configured on the server.' });
    }

    const url = `https://restapi.amap.com/v3/assistant/inputtips?key=${amapApiKey}&keywords=${encodeURIComponent(q)}&city=上海&citylimit=true`;
    console.log(`[GeocodeController] Requesting AMap inputtips for: "${q}"`);

    const response = await axios.get(url);
    if (response.data && response.data.status === '1') {
      const tips = response.data.tips || [];
      // Map AMap tips format to unified suggestion format
      const suggestions = tips
        .filter((tip: any) => tip.location && typeof tip.location === 'string' && tip.location.includes(','))
        .map((tip: any) => {
          const [lonStr, latStr] = tip.location.split(',');
          const locationWgs84 = gcj02ToWgs84(parseFloat(lonStr), parseFloat(latStr));
          return {
            name: tip.name,
            address: Array.isArray(tip.address) ? tip.address.join('') : (tip.address || tip.district || ''),
            // 高德返回 GCJ-02；统一转为 WGS-84，确保 Leaflet 底图定位不偏移。
            lat: locationWgs84.lat,
            lon: locationWgs84.lng
          };
        });
      return res.status(200).json(suggestions);
    } else {
      console.warn(`[GeocodeController] AMap inputtips returned error:`, response.data);
      return res.status(400).json({ error: `AMap API returned error: ${response.data.info}` });
    }
  } catch (error: any) {
    console.error(`[GeocodeController] Search address error:`, error.message);
    return res.status(500).json({ error: 'Failed to perform address search.', details: error.message });
  }
};
