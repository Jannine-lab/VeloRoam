import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { attributeMatch, placesAlongRoute, compareOptions, validateOption } from './ideaAgentRouteTools';
import { unknownRouteTags } from './ideaTagPreferences';
import { sanitizeConversationIntent } from './ideaIntent';
import { CompositeRoute } from './ideaRouteService';
import { Candidate } from '../controllers/ideaController';

const a = { lat: 31.2, lng: 121.4 }, b = { lat: 31.2, lng: 121.42 };
const route: CompositeRoute = { distanceKm: 10, durationMin: 40, hasEstimatedTime: false, continuity: { maxGapMeters: 3, toleranceMeters: 100 }, stops: [{ name: '起点', type: 'point', point: a }, { name: '终点', type: 'point', point: b }], legs: [{ type: 'connection', name: '连接', distanceKm: 10, durationMin: 40, points: [a, b], estimated: false }] };
const segment: Candidate = { id: 'segment:1', type: 'segment', name: '公园路', lat: a.lat, lng: a.lng, score: 90, distanceKm: 2, tags: { ...unknownRouteTags(), loop: 'matched' } };

test('attribute search requires positive tag evidence and checks score and length', () => {
  assert.equal(attributeMatch(segment, ['loop'], [], 80, 1, 3), true);
  assert.equal(attributeMatch(segment, ['climbing'], [], 80, 1, 3), false);
  assert.equal(attributeMatch(segment, ['loop'], ['loop'], null, null, null), false);
  assert.equal(attributeMatch({ ...segment, score: null }, ['loop'], [], 80, null, null), false);
});

test('along-route points use distance to route, exclude far points, deduplicate and filter kind', async () => {
  const near = { id: 'point:1', type: 'point' as const, name: '咖啡站', lat: 31.201, lng: 121.41 };
  const far = { ...near, id: 'point:2', lat: 31.23 };
  const items = await placesAlongRoute(route, async () => [near, near, far], .5, '咖啡');
  assert.deepEqual(items.map(item => item.id), ['point:1']);
  assert.ok(items[0].distanceFromRouteKm < .2);
});

test('compares the actual options and rejects changed destination or exceeded budget', () => {
  const longer = { ...route, distanceKm: 12, durationMin: 50 };
  assert.equal(compareOptions([{ route }, { route: longer, added: ['绿道'], extraKm: 2 }])[1].extraKm, 2);
  const intent = sanitizeConversationIntent({ mode: 'route', maxKm: 11 })!;
  assert.equal(validateOption({ route: longer }, route, intent).status, 'failed');
  assert.equal(validateOption({ route }, route, intent).status, 'checked');
  const changed = { ...route, stops: [route.stops[0], { ...route.stops[1], point: a }] };
  assert.match(validateOption({ route: changed }, route, intent).reason!, /终点/);
});
