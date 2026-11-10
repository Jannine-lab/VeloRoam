const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../VeloRoam-api/node_modules/typescript');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const ast = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const previewCode = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'renderNavigationPreview').getText(ast);

test('draft stops are previewed, replaced when removed, and cleared after planning', () => {
  class Path {
    constructor(points, style) { this.points = points; this.style = { ...style }; }
    setStyle(style) { Object.assign(this.style, style); }
    addTo(layer) { layer.items.push(this); return this; }
  }
  class Polyline extends Path {}
  class CircleMarker extends Path {}
  const plannedLine = new Polyline([], { opacity: .96 });
  const plannedMarker = new CircleMarker([], { opacity: 1, fillOpacity: 1 });
  const preview = { items: [], clearLayers() { this.items = []; } };
  const context = {
    L: { Polyline, CircleMarker, polyline: (points, style) => new Polyline(points, style), circleMarker: (point, style) => new CircleMarker(point, style) },
    placeRouteLayer: { eachLayer(callback) { [plannedLine, plannedMarker].forEach(callback); } },
    placeStopPreviewLayer: preview,
    PLANNED_SEGMENT_COLOR: '#00805a'
  };
  vm.createContext(context);
  vm.runInContext(previewCode, context);

  const point = { type: 'point', point: { lat: 31.1, lng: 121.4 } };
  const segment = { type: 'segment', coordinates: [{ lat: 31.1, lng: 121.4 }, { lat: 31.2, lng: 121.5 }] };
  context.renderNavigationPreview([point, segment], true);
  assert.equal(preview.items.length, 2);
  assert.equal(plannedLine.style.opacity, .3);
  assert.equal(plannedMarker.style.fillOpacity, .3);
  assert.equal(preview.items[1].style.dashArray, '8 6');

  context.renderNavigationPreview([point], true);
  assert.equal(preview.items.length, 1);
  assert.ok(preview.items[0] instanceof CircleMarker);

  context.renderNavigationPreview([point], false);
  assert.equal(preview.items.length, 0);
  assert.equal(plannedLine.style.opacity, .96);
  assert.equal(plannedMarker.style.fillOpacity, 1);
});
