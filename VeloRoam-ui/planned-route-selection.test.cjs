const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../VeloRoam-api/node_modules/typescript');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const ast = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = ['dimAllOtherSegments', 'restoreAllSegmentsOpacity'].map(name => {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, `Missing ${name}`);
  return node.getText(ast);
}).join('\n');
const layer = () => ({ style: {}, setStyle(style) { Object.assign(this.style, style); } });
const createSegment = () => {
  const layers = [layer(), layer(), layer(), layer()];
  return { seg: {}, layers, layer: { getLayers: () => layers } };
};
const first = createSegment();
const second = createSegment();
const context = {
  DIMMED_SEGMENT_OPACITY: 0.3,
  SEGMENT_DIMMED_WIDTH: 2, SEGMENT_SELECTED_WIDTH: 4, SEGMENT_LINE_WIDTH: 2.5,
  selectedSegmentId: null, plannedRouteSelected: false,
  loadedStravaSegments: new Map([[1, first], [2, second]]),
  getSegmentDisplayScore: () => 10, isSegmentVisibleAtCurrentZoom: () => true,
  getSegmentColor: () => 'orange', stravaGroup: { removeLayer() {} }
};
vm.createContext(context);
vm.runInContext(functions, context);
context.dimAllOtherSegments(null);
assert.equal(context.plannedRouteSelected, true);
assert.equal(first.layers[0].style.opacity, 0.3);
assert.equal(second.layers[0].style.opacity, 0.3);
context.restoreAllSegmentsOpacity();
assert.equal(context.plannedRouteSelected, false);
assert.equal(first.layers[0].style.opacity, 0.85);
context.dimAllOtherSegments(1);
assert.equal(first.layers[0].style.opacity, 1);
assert.equal(second.layers[0].style.opacity, 0.3);
console.log('Planned route selection checks passed.');
