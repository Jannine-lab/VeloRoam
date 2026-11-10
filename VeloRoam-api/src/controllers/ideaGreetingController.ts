import { Request, Response } from 'express';
import axios from 'axios';
import { ChatDeepSeek } from '@langchain/deepseek';
import { langSmithProjectCallbacks } from '../config/langsmith';
import { wgs84ToGcj02 } from '../utils/polyline';

type Point = { lat: number; lng: number };
const validPoint = (p: any): p is Point => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

export function describeWeather(code: number): string | null {
  if (code === 0) return '晴';
  if ([1, 2, 3].includes(code)) return '多云';
  if ([45, 48].includes(code)) return '有雾';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return '有雨';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '有雪';
  if ([95, 96, 99].includes(code)) return '雷雨';
  return null;
}

async function weatherNear(point: Point): Promise<{ description: string | null; timezone: string | null } | null> {
  try {
    const response = await axios.get('https://api.open-meteo.com/v1/forecast', { params: {
      latitude: point.lat, longitude: point.lng, current: 'temperature_2m,weather_code', timezone: 'auto', forecast_days: 1
    }, timeout: 5000 });
    const current = response.data?.current;
    const description = Number.isInteger(current?.weather_code) ? describeWeather(current.weather_code) : null;
    const temperature = Number.isFinite(current?.temperature_2m) ? `${Math.round(current.temperature_2m)}°C` : null;
    return { description: [description, temperature].filter(Boolean).join('，') || null, timezone: typeof response.data?.timezone === 'string' ? response.data.timezone : null };
  } catch { return null; }
}

async function cityNear(point: Point): Promise<string | null> {
  if (!process.env.AMAP_API_KEY || point.lat < 18 || point.lat > 54 || point.lng < 73 || point.lng > 135) return null;
  try {
    const gcj = wgs84ToGcj02(point.lng, point.lat);
    const result = await axios.get('https://restapi.amap.com/v3/geocode/regeo', { params: {
      key: process.env.AMAP_API_KEY, location: `${gcj.lng},${gcj.lat}`, extensions: 'base'
    }, timeout: 5000 });
    if (result.data?.status !== '1') return null;
    const component = result.data?.regeocode?.addressComponent;
    const city = typeof component?.city === 'string' && component.city ? component.city : component?.province;
    return typeof city === 'string' && city.trim() ? city.trim().slice(0, 30) : null;
  } catch { return null; }
}

export const ideaGreeting = async (req: Request, res: Response) => {
  if (!process.env.DEEPSEEK_API_KEY) return res.status(503).json({ error: '问候服务尚未配置。' });
  let timezone = typeof req.body?.timezone === 'string' ? req.body.timezone.slice(0, 80) : 'UTC';
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format(); } catch { timezone = 'UTC'; }
  const localTime = new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long' }).format(new Date());
  const source = req.body?.locationSource;
  // Weather and reverse geocoding only need a neighbourhood-level coordinate.
  const position = (source === 'gps' || source === 'ip') && validPoint(req.body?.location)
    ? { lat: Math.round(req.body.location.lat * 100) / 100, lng: Math.round(req.body.location.lng * 100) / 100 }
    : null;
  const [weatherResult, city] = position ? await Promise.all([weatherNear(position), cityNear(position)]) : [null, null];
  const ipCity = source === 'ip' && typeof req.body?.city === 'string' ? req.body.city.trim().slice(0, 30) : '';
  // IP geolocation may identify a proxy in another time zone; don't present it as the rider's location.
  const reliable = source !== 'ip' || Boolean(weatherResult?.timezone && weatherResult.timezone === timezone);
  const location = reliable ? (city || ipCity || null) : null;
  const weather = reliable ? weatherResult?.description || null : null;
  try {
    const model = new ChatDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', temperature: 1.1, timeout: 15000, maxRetries: 0, maxTokens: 120, modelKwargs: { response_format: { type: 'json_object' } } });
    const styles = ['温柔而有留白', '轻快但不热闹', '简洁而富有画面感', '像一位熟悉骑行的朋友', '用自然的疑问开启灵感'];
    const style = styles[Math.floor(Math.random() * styles.length)];
    const response = await model.invoke([
      ['system', '你为骑行应用撰写对话开始前的标题。只输出JSON：{"greeting":"..."}。根据提供的当地时段、城市及当前天气，写一句自然、克制、有质感的中文问候或轻巧的问题，含标点必须为12到20个字符，不用emoji、引号或营销腔。根据给出的表达方向变化句式，不要反复使用“准备出发”或“想去哪骑行”等固定套话。只使用提供的信息；地点或天气为null时不要猜测或提及。天气是附近的模型估计，不要宣称适合安全骑行；遇到雨雪或雷雨不要鼓励立即出发。'],
      ['human', JSON.stringify({ localTime, location, weather, style, locationPrecision: !reliable || !position ? '未知' : source === 'ip' ? '城市大致位置' : '附近' })]
    ], { runName: 'veloroam.idea.greeting', callbacks: langSmithProjectCallbacks() });
    if (typeof response.content !== 'string' || response.response_metadata?.finish_reason === 'length') throw new Error('Invalid greeting');
    const parsed = JSON.parse(response.content);
    const greeting = typeof parsed.greeting === 'string' ? Array.from(parsed.greeting.replace(/[\r\n]+/g, ' ').replace(/^[“”"']+|[“”"']+$/g, '').trim()).slice(0, 20).join('') : '';
    if (Array.from(greeting).length < 12) throw new Error('Greeting too short');
    return res.json({ greeting });
  } catch (error: any) {
    console.warn('[IdeaGreeting] Generation failed:', error.code || error.name);
    return res.status(502).json({ error: '问候暂时不可用。' });
  }
};
