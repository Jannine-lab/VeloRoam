const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../VeloRoam-api/node_modules/typescript');

const source = fs.readFileSync(require('node:path').join(__dirname, 'app.js'), 'utf8');
const ast = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = ['mapBottomSheetObstruction', 'flyToVisibleMapCenter', 'visibleMapFitOptions', 'routePlanningBottomInset', 'syncRoutePlanningPosition'];
const code = names.map(name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast)).join('\n');

test('half-open sheet shifts location and route bounds into the visible map area', () => {
  const classes = new Set(['is-open']);
  const entry = { classList: { contains: value => classes.has(value) } };
  const detail = { hidden: true };
  let flight;
  const context = {
    window: { innerHeight: 800, matchMedia: () => ({ matches: false }) },
    document: { getElementById: id => id === 'idea-sheet' ? entry : detail },
    getComputedStyle: () => ({ bottom: '0px' }),
    map: {
      getContainer: () => ({ getBoundingClientRect: () => ({ bottom: 800, height: 800 }) }),
      project: () => ({ add: ([x, y]) => ({ x, y }) }),
      unproject: point => point,
      flyTo: (center, zoom) => { flight = { center, zoom }; }
    }
  };
  vm.createContext(context); vm.runInContext(code, context);
  assert.ok(Math.abs(context.mapBottomSheetObstruction() - 472) < 0.01);
  context.flyToVisibleMapCenter([31, 121], 15, {});
  assert.ok(Math.abs(flight.center.y - 236) < 0.01);
  const options = context.visibleMapFitOptions({ padding: [36, 36], maxZoom: 16 });
  assert.ok(Math.abs(options.paddingBottomRight[1] - 508) < 0.01);
  classes.clear();
  assert.equal(context.mapBottomSheetObstruction(), 0);
  assert.ok(Math.abs(context.mapBottomSheetObstruction(true) - 472) < 0.01);
  context.window.matchMedia = () => ({ matches: true });
  assert.equal(context.mapBottomSheetObstruction(true), 0);
});

test('centers the route loading animation above the mobile drawer', () => {
  const properties = {};
  const overlay = { hidden: false, style: {
    setProperty: (key, value) => { properties[key] = value; },
    removeProperty: key => { delete properties[key]; }
  } };
  const sheet = { hidden: false, getBoundingClientRect: () => ({ top: 320 }) };
  const context = {
    window: { innerHeight: 800, matchMedia: () => ({ matches: false }) },
    document: { getElementById: id => id === 'route-planning-status' ? overlay : sheet }
  };
  vm.createContext(context); vm.runInContext(code, context);
  context.syncRoutePlanningPosition();
  assert.equal(properties['--route-planning-bottom'], '480px');
  assert.equal(context.routePlanningBottomInset(800, 0), 672);
  sheet.getBoundingClientRect = () => ({ top: 500 });
  context.syncRoutePlanningPosition();
  assert.equal(properties['--route-planning-bottom'], '300px');
  context.window.matchMedia = () => ({ matches: true });
  context.syncRoutePlanningPosition();
  assert.equal(properties['--route-planning-bottom'], undefined);
});
