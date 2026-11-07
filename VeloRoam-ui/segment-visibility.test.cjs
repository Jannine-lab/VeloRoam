const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../VeloRoam-api/node_modules/typescript');

// Exercise the actual browser helpers without initializing Leaflet or contacting services.
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const ast = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = ['getMinScoreForZoom', 'getSegmentDisplayScore', 'isSegmentVisibleAtCurrentZoom'];
const helpers = names.map(name => {
  const node = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(node, `Missing browser helper ${name}`);
  return node.getText(ast);
}).join('\n');
const context = { map: { getZoom: () => 10 }, minScoreFilter: 100 };
vm.createContext(context);
vm.runInContext(helpers, context);
const visibleAt = (zoom, segment) => {
  context.map.getZoom = () => zoom;
  context.minScoreFilter = context.getMinScoreForZoom(zoom);
  return context.isSegmentVisibleAtCurrentZoom(segment);
};

assert.equal(context.getSegmentDisplayScore({ stravaScore: 0, rawScore: 99 }), 0);
assert.equal(context.getSegmentDisplayScore({ stravaScore: null, rawScore: 75 }), 75);
assert.equal(visibleAt(10, { stravaScore: 100, rawScore: 5, starCount: 5 }), true);
assert.equal(visibleAt(10, { stravaScore: 100, rawScore: 5, starCount: 0, effortCount: 10 }), true);
assert.equal(visibleAt(10, { stravaScore: 100, starCount: 4, effortCount: 9 }), false);
assert.equal(visibleAt(10, { stravaScore: 100, starCount: null, effortCount: null }), false);
assert.equal(visibleAt(10, { stravaScore: 100, starCount: 10, visibleFromZoom: 11 }), false);
assert.equal(visibleAt(11, { stravaScore: 100, starCount: 0, effortCount: 0, visibleFromZoom: 11 }), true);
assert.equal(visibleAt(10, { stravaScore: 0, rawScore: 100, starCount: 10 }), false);
assert.equal(visibleAt(10, { stravaScore: null, rawScore: 99.99 }), false);
assert.equal(visibleAt(11, { rawScore: 100 }), true);
assert.equal(visibleAt(11, { rawScore: 80 }), true);
assert.equal(visibleAt(11, { rawScore: 79.99 }), false);
assert.equal(visibleAt(12, { rawScore: 30 }), true);
assert.equal(visibleAt(12, { rawScore: 29.99 }), false);
assert.equal(visibleAt(13, { rawScore: 0 }), true);
assert.equal(visibleAt(13, { rawScore: null }), true);
console.log('Browser segment display checks passed.');
