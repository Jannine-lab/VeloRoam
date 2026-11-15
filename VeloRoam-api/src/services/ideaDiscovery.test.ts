import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { fallbackDiscoveryTerms, isThematicDiscovery, rankDiscoveryCandidates } from './ideaDiscovery';
import { requestedRouteTags, unknownRouteTags } from './ideaTagPreferences';
import type { Candidate } from '../controllers/ideaController';
const center = { lat: 31.2, lng: 121.4 };
const make = (id: string, name: string, lat = 31.2): Candidate => ({ id: `segment:${id}`, type: 'segment', name, lat, lng: 121.4 });

test('expands a theme with bounded related words and does not expand negated or concrete names', () => {
  assert.deepEqual(fallbackDiscoveryTerms('沿江', '沿江骑行'), ['沿江', '江', '滨江', '江滨', 'yanjiang', 'jiang', 'river']);
  assert.equal(isThematicDiscovery('沿江', false, '不想沿江骑行'), false);
  assert.equal(isThematicDiscovery('世纪公园', false, '去世纪公园'), false);
  assert.equal(isThematicDiscovery('湖景', true, '想找湖景'), true);
});

test('keeps actual original-name matches ahead of related words and verified attributes within radius', () => {
  const prefs = requestedRouteTags({ preferences: [], preferredTags: ['loop'], avoidTags: ['climbing'] });
  const exact = make('1', '沿江路线', 31.22), related = make('2', 'River 绿道'), far = make('3', '沿江远方', 32);
  const attr = { ...make('4', '公园路'), tags: { ...unknownRouteTags(), loop: 'matched' as const } };
  const excluded = { ...make('5', '沿江上坡'), tags: { ...unknownRouteTags(), climbing: 'matched' as const } };
  const unknown = { ...make('6', '未知道路'), tags: unknownRouteTags() };
  const result = rankDiscoveryCandidates({ original: [exact, far, excluded], related: [related, exact], attributes: [attr, unknown], query: '沿江', terms: ['沿江', '江', 'river'], center, radiusKm: 10, preferences: prefs });
  assert.deepEqual(result.map(item => item.id), [exact.id, related.id, attr.id]);
  assert.match(result[0].reason, /名称包含“沿江”/); assert.match(result[1].reason, /关联词“river”/); assert.match(result[2].reason, /绕圈/);
});

test('category search uses stored type rather than assuming all supply locations are coffee', () => {
  const prefs = requestedRouteTags({ preferences: [], preferredTags: [], avoidTags: [] });
  const items: Candidate[] = [ { id: 'point:1', type: 'point', name: '咖啡站', category: 'supply', ...center }, { id: 'point:2', type: 'point', name: '便利店', category: 'supply', ...center } ];
  const result = rankDiscoveryCandidates({ original: [], related: [], attributes: items, query: '沿江', terms: ['沿江'], center, radiusKm: 5, preferences: prefs, pointKind: '咖啡' });
  assert.deepEqual(result.map(x => x.id), ['point:1']);
});

test('recovers only positive explicit theme words from riding requests', async () => {
  const { explicitDiscoveryTheme } = await import('./ideaDiscovery');
  assert.equal(explicitDiscoveryTheme('帮我规划一条沿江骑行路线'), '沿江');
  assert.equal(explicitDiscoveryTheme('不要沿江，想环湖骑行'), '环湖');
  assert.equal(explicitDiscoveryTheme('沿江骑行是什么意思'), null);
  assert.equal(isThematicDiscovery('环湖', true, '不要沿江，想环湖骑行'), true);
});

test('prefers more specific related words over broad character and partial pinyin matches', () => {
  const prefs = requestedRouteTags({ preferences: [], preferredTags: [], avoidTags: [] });
  const results = rankDiscoveryCandidates({ original: [], related: [make('1', 'Jiangsu Road'), make('2', '滨江绿道', 31.21), make('3', '江路')], attributes: [], query: '沿江', terms: ['沿江', '江', '滨江', 'jiang'], center, radiusKm: 10, preferences: prefs });
  assert.deepEqual(results.map(x => x.id), ['segment:2', 'segment:3', 'segment:1']);
  assert.match(results[0].reason, /滨江/);
});
