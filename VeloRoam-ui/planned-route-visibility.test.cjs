const { strict: assert } = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../VeloRoam-api/node_modules/typescript');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const ast = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = ['hideExplorationSegments', 'restoreExplorationSegments', 'clearIdeaSegmentPreview'].map(name => {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, `Missing ${name}`); return node.getText(ast);
}).join('\n');

function fixture(initiallyVisible = true) {
  const visible = new Set();
  const map = { hasLayer: layer => visible.has(layer), removeLayer: layer => visible.delete(layer) };
  const stravaGroup = { addTo: target => { assert.equal(target, map); visible.add(stravaGroup); } };
  if (initiallyVisible) visible.add(stravaGroup);
  const ideaMapLayer = { cleared: 0, clearLayers() { this.cleared++; } };
  const context = { map, stravaGroup, ideaMapLayer, homeRecommendationRouteLayer: null, plannedRouteLayerOwner: null,
    restoreStravaLayer: false, placeRouteActive: false, syncHomeRecommendationVisibility() {} };
  vm.createContext(context); vm.runInContext(functions, context);
  return { context, visible, stravaGroup };
}

test('hides exploration segments while a planned route is shown and restores them on close', () => {
  const { context, visible, stravaGroup } = fixture();
  context.hideExplorationSegments('idea');
  assert.equal(visible.has(stravaGroup), false);
  context.restoreExplorationSegments('segment');
  assert.equal(visible.has(stravaGroup), false);
  context.restoreExplorationSegments('idea');
  assert.equal(visible.has(stravaGroup), true);
});

test('isolates a viewed segment and restores exploration when that preview closes', () => {
  const { context, visible, stravaGroup } = fixture();
  context.hideExplorationSegments('idea-segment');
  assert.equal(visible.has(stravaGroup), false);
  context.clearIdeaSegmentPreview();
  assert.equal(context.ideaMapLayer.cleared, 1);
  assert.equal(visible.has(stravaGroup), true);
  context.hideExplorationSegments('idea');
  context.clearIdeaSegmentPreview();
  assert.equal(context.ideaMapLayer.cleared, 1);
  assert.equal(visible.has(stravaGroup), false);
});

test('preserves a previously hidden layer and keeps it hidden for place navigation', () => {
  const { context, visible, stravaGroup } = fixture(false);
  context.hideExplorationSegments('segment'); context.restoreExplorationSegments('segment');
  assert.equal(visible.has(stravaGroup), false);
  visible.add(stravaGroup);
  context.hideExplorationSegments('idea'); context.placeRouteActive = true; context.restoreExplorationSegments('idea');
  assert.equal(visible.has(stravaGroup), false);
});
