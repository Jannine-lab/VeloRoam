const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../VeloRoam-api/node_modules/typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, 'app.js'), 'utf8');
const ast = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const code = ['prepareMapDetailView', 'syncMapDetailSheet'].map(name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast)).join('\n');
function fixture({ desktop = false } = {}) {
  const classes = initial => {
    const values = new Set(initial);
    return { contains: value => values.has(value), add: value => values.add(value), remove: (...items) => items.forEach(value => values.delete(value)), toggle: (value, on) => { if (on) values.add(value); else values.delete(value); } };
  };
  const element = initial => ({ classList: classes(initial), hidden: false, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; }, getBoundingClientRect() { return {}; } });
  const els = Object.fromEntries(['map-detail-sheet', 'idea-sheet', 'map-detail-handle', 'strava-details-panel', 'place-details-panel', 'idea-route-panel', 'nearby-route-detail', 'map-detail-actions', 'place-detail-actions'].map(id => [id, element([])]));
  els['map-detail-sheet'].hidden = true;
  const events = [];
  const context = { document: { getElementById: id => els[id], body: element([]), dispatchEvent: event => events.push(event.type) }, Event: class { constructor(type) { this.type = type; } }, isDesktopMap: () => desktop, window: { matchMedia: () => ({ matches: desktop }) }, clearTimeout() {}, setTimeout() {}, requestAnimationFrame: callback => callback(), compositeRoutePopover: false, mapDetailHideTimer: null, mapDetailRevision: 0, positionSegmentPopover() {} };
  vm.createContext(context); vm.runInContext(code, context);
  return { context, els, events };
}
test('new details reset full or collapsed state and announce the opening', () => {
  const { context, els, events } = fixture();
  const sheet = els['map-detail-sheet'];
  sheet.classList.add('is-full'); sheet.classList.add('is-collapsed');
  context.prepareMapDetailView();
  assert.equal(sheet.classList.contains('is-full'), false);
  assert.equal(sheet.classList.contains('is-collapsed'), false);
  assert.equal(els['map-detail-handle'].attrs['aria-expanded'], 'true');
  assert.deepEqual(events, ['map-detail-opening']);
});
test('opening a place does not inherit full chat state and keeps the correct actions', () => {
  const { context, els } = fixture();
  els['idea-sheet'].classList.add('is-full');
  els['place-details-panel'].classList.add('active');
  context.prepareMapDetailView(); context.syncMapDetailSheet();
  assert.equal(els['map-detail-sheet'].classList.contains('is-full'), false);
  assert.equal(els['place-detail-actions'].hidden, false);
  assert.equal(els['map-detail-actions'].hidden, true);
  els['map-detail-sheet'].classList.add('is-full');
  context.syncMapDetailSheet();
  assert.equal(els['map-detail-sheet'].classList.contains('is-full'), true, 'updates preserve the user-selected detent');
  els['place-details-panel'].classList.remove('active');
  els['strava-details-panel'].classList.add('active');
  context.prepareMapDetailView(); context.syncMapDetailSheet();
  assert.equal(els['map-detail-sheet'].classList.contains('is-full'), false);
  assert.equal(els['place-detail-actions'].hidden, true);
  assert.equal(els['map-detail-actions'].hidden, false);
});
