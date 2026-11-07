const { strict: assert } = require('node:assert');
const { test } = require('node:test');
const { buildIdeaGPX } = require('./idea-gpx.js');

test('exports each route leg in order and escapes the track name', () => {
  const route = { legs: [
    { points: [{ lat: 31, lng: 121 }, { lat: 31.1, lng: 121.1 }] },
    { points: [{ lat: 31.1, lng: 121.1 }, { lat: 31, lng: 121 }] }
  ] };
  const gpx = buildIdeaGPX(route, 'A & B <环线>');
  assert.match(gpx, /<name>A &amp; B &lt;环线&gt;<\/name>/);
  assert.equal((gpx.match(/<trkseg>/g) || []).length, 2);
  assert.equal((gpx.match(/<trkpt /g) || []).length, 4);
  assert.ok(gpx.indexOf('lat="31.1" lon="121.1"') < gpx.lastIndexOf('lat="31" lon="121"'));
});

test('does not connect across invalid points and rejects missing tracks', () => {
  const gpx = buildIdeaGPX({ legs: [{ points: [
    { lat: 1, lng: 2 }, { lat: 2, lng: 3 }, { lat: null, lng: 3 }, { lat: 3, lng: 4 }, { lat: 4, lng: 5 }
  ] }] }, '路线');
  assert.equal((gpx.match(/<trkseg>/g) || []).length, 2);
  assert.throws(() => buildIdeaGPX({ legs: [{ points: [{ lat: 1, lng: 2 }, { lat: 91, lng: 0 }] }] }), /缺少可导出/);
});
