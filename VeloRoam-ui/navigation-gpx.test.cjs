const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../VeloRoam-api/node_modules/typescript');
const { buildIdeaGPX } = require('./idea-gpx.js');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const ast = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const code = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'exportPlaceNavigationGPX').getText(ast);

test('exports all planned legs and blocks exporting stale or loading routes', async () => {
  const stop = { type: 'point' };
  const navigation = {
    startName: '起点/A', endName: '终点&B', stops: [stop], plannedStops: [stop],
    exportRoute: { legs: [
      { points: [{ lat: 31, lng: 121 }, { lat: 31.1, lng: 121.1 }] },
      { points: [{ lat: 31.1, lng: 121.1 }, { lat: 31.2, lng: 121.2 }] }
    ] }
  };
  let blob, clicked = 0, download = '', message = '';
  const context = {
    placeNavigation: navigation, placeRouteRequest: null, window: { buildIdeaGPX }, Blob,
    URL: { createObjectURL(value) { blob = value; return 'blob:route'; }, revokeObjectURL() {} },
    document: { body: { append() {} }, createElement() { return { set download(value) { download = value; }, click() { clicked++; }, remove() {} }; } },
    setTimeout() {}, showAppMessage(value) { message = value; }
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  context.exportPlaceNavigationGPX();
  const gpx = await blob.text();
  assert.equal(clicked, 1);
  assert.equal(download, '起点_A至终点&B.gpx');
  assert.match(gpx, /<name>起点\/A至终点&amp;B<\/name>/);
  assert.equal((gpx.match(/<trkseg>/g) || []).length, 2);
  assert.equal((gpx.match(/<trkpt /g) || []).length, 4);
  assert.equal(message, '');

  navigation.stops.push({ type: 'point' });
  context.exportPlaceNavigationGPX();
  navigation.stops.pop();
  context.placeRouteRequest = {};
  context.exportPlaceNavigationGPX();
  assert.equal(clicked, 1);
});
