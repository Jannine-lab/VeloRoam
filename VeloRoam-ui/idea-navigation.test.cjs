const { test } = require('node:test');
const { strict: assert } = require('node:assert');
const { buildIdeaNavigation } = require('./idea-navigation.js');

function route(start, end, home) {
  return { legs: [{ type: 'segment', points: [start, end] }], stops: [{ point: home }] };
}

test('opens cycling navigation to the segment start with native AMap and converted coordinates', () => {
  const start = { lat: 31.2304, lng: 121.4737 };
  const result = buildIdeaNavigation(route(start, { lat: 31.24, lng: 121.48 }, start), '滨江 & 骑行');
  const url = new URL(result.url);
  assert.equal(url.hostname, 'uri.amap.com');
  assert.equal(url.searchParams.get('mode'), 'ride');
  assert.equal(url.searchParams.get('callnative'), '1');
  assert.equal(url.searchParams.has('from'), false);
  const [lng, lat, name] = url.searchParams.get('to').split(',');
  assert.ok(Math.abs(Number(lng) - start.lng) > .001);
  assert.ok(Math.abs(Number(lat) - start.lat) > .001);
  assert.equal(name, '滨江 & 骑行');
  assert.match(result.note, /路段起点/);
});

test('uses segment endpoints and return point for international cycling directions', () => {
  const result = buildIdeaNavigation(route({ lat: 48.8, lng: 2.2 }, { lat: 48.9, lng: 2.3 }, { lat: 48.85, lng: 2.4 }), '路线');
  const url = new URL(result.url);
  assert.equal(url.hostname, 'www.google.com');
  assert.equal(url.searchParams.get('travelmode'), 'bicycling');
  assert.equal(url.searchParams.get('waypoints'), '48.8,2.2|48.9,2.3');
  assert.equal(url.searchParams.get('destination'), '48.85,2.4');
  assert.match(result.note, /重新规划/);
});

test('rejects missing or invalid route points', () => {
  assert.throws(() => buildIdeaNavigation({ legs: [] }), /起终点/);
  assert.throws(() => buildIdeaNavigation(route({ lat: null, lng: 2 }, { lat: 1, lng: 2 }, { lat: 1, lng: 2 })), /起终点/);
  assert.throws(() => buildIdeaNavigation(route({ lat: 48, lng: 2 }, { lat: 49, lng: 2 }, null)), /返回点/);
});

test('builds platform-specific map links to the segment start', () => {
  const { buildIdeaMapNavigation } = require('./idea-navigation.js');
  const sample = route({ lat: 31.2304, lng: 121.4737 }, { lat: 31.24, lng: 121.48 }, { lat: 31, lng: 121 });
  assert.match(buildIdeaMapNavigation(sample, '骑行', 'amap', 'ios'), /^iosamap:\/\/path\?/);
  assert.match(buildIdeaMapNavigation(sample, '骑行', 'amap', 'android'), /^amapuri:\/\/route\/plan\?/);
  for (const [platform, prefix] of [['ios', 'baidumap://map/ridenavi'], ['android', 'bdapp://map/direction'], ['harmony', 'baidumap://map/bikenavi']]) {
    const link = new URL(buildIdeaMapNavigation(sample, '骑行', 'baidu', platform));
    assert.ok(link.href.startsWith(prefix));
    assert.equal(link.searchParams.get('destination'), '31.2304,121.4737');
    assert.equal(link.searchParams.get('coord_type'), 'wgs84');
  }
  assert.match(buildIdeaMapNavigation(sample, '骑行', 'apple', 'ios'), /^maps:\/\/\?/);
  assert.throws(() => buildIdeaMapNavigation(sample, '骑行', 'apple', 'android'), /仅在 Apple/);
});

test('navigates to the first destination when a complete route has no segment', () => {
  const { buildIdeaMapNavigation } = require('./idea-navigation.js');
  const route = { stops: [{ point: { lat: 31, lng: 121 } }, { point: { lat: 31.2, lng: 121.4 } }], legs: [{ type: 'navigation', points: [{ lat: 31, lng: 121 }, { lat: 31.2, lng: 121.4 }] }] };
  const url = new URL(buildIdeaMapNavigation(route, '路线', 'baidu', 'ios'));
  assert.equal(url.searchParams.get('destination'), '31.2,121.4');
});
