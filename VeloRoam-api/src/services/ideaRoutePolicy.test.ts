import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { sanitizeConversationIntent } from './ideaIntent';
import { buildRequirementState } from './ideaRequirementState';
import { routePolicy, requiredTagsReason } from './ideaRoutePolicy';
import { RouteStop } from './ideaRouteService';
import { unknownRouteTags } from './ideaTagPreferences';
const intent = (value: object) => sanitizeConversationIntent({ mode: 'route', ...value })!;
const state = (value: ReturnType<typeof intent>, fields: string[] = []) => buildRequirementState(value, null, null, false, null, new Map(), { requiredFields: fields })!;

test('known hard segment attributes must be matched, while unknown is not treated as a match', () => {
  const i = intent({ preferredTags: ['climbing'] });
  const policy = routePolicy(i, state(i, ['preferredTags']));
  const stop: RouteStop = { type: 'segment', name: '路段', coordinates: [{ lat: 31, lng: 121 }, { lat: 31.01, lng: 121.01 }], detail: { id: 'segment:1', averageGrade: null, elevationGainM: null, athleteCount: null, effortCount: null, hazardous: false, recordedDistanceKm: null, tags: unknownRouteTags() } };
  assert.match(requiredTagsReason([stop], policy.requiredTags)!, /爬坡/);
  stop.detail!.tags!.climbing = 'matched'; assert.equal(requiredTagsReason([stop], policy.requiredTags), null);
  assert.deepEqual(routePolicy(i, state(i)).requiredTags, []);
});

test('blocks unverified mandatory avoidance and region, preserves optional preferences', () => {
  const avoid = intent({ avoidTags: ['climbing'] });
  assert.match(routePolicy(avoid, state(avoid)).block!.message, /不能核实全部连接道路/);
  const area = intent({ place: '上海' });
  assert.equal(routePolicy(area, state(area)).block, null);
  assert.match(routePolicy(area, state(area, ['place'])).block!.message, /区域边界/);
});

test('requires stop duration when an explicit total-time bound cannot be verified', () => {
  const i = intent({ maxMinutes: 120, timeScope: 'total' });
  assert.match(routePolicy(i, state(i)).block!.message, /停留时长尚未确定/);
  const known = intent({ maxMinutes: 120, timeScope: 'total', stopMinutes: 20 });
  assert.equal(routePolicy(known, state(known)).block, null);
});

test('explicit must and optional tag strengths stay distinct across confirmation', async () => {
  const { applyExplicitPriority } = await import('./ideaRoutePolicy');
  const raw: any = { mode: 'route', preferredTags: ['climbing', 'popular'] };
  applyExplicitPriority('必须经过爬坡路段，最好热门一点', raw);
  assert.deepEqual(raw.requiredRouteTags, ['climbing']); assert.deepEqual(raw.preferredRouteTags, ['popular']);
  const i = intent(raw);
  const first = buildRequirementState(i, null, null, false, null, new Map(), raw)!;
  assert.equal(first.tagPriorities.climbing, 'required'); assert.equal(first.tagPriorities.popular, 'preferred');
  const confirmed = buildRequirementState(i, i, first, true, null, new Map())!;
  assert.deepEqual(routePolicy(i, confirmed).requiredTags, ['climbing']);
});

test('explicit relaxation of avoidance is recorded as preferred', async () => {
  const { applyExplicitPriority } = await import('./ideaRoutePolicy');
  const raw: any = { mode: 'route', avoidTags: ['climbing'] };
  applyExplicitPriority('尽量避开爬坡，允许未核实的连接道路', raw);
  const i = intent(raw); const requirements = buildRequirementState(i, null, null, false, null, new Map(), raw)!;
  assert.equal(requirements.requirements.avoidTags.priority, 'preferred'); assert.equal(routePolicy(i, requirements).block, null);
});
