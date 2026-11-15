const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../VeloRoam-api/node_modules/typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, 'app.js'), 'utf8');
const tree = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let declaration;
function find(node) { if (ts.isVariableDeclaration(node) && node.name?.getText(tree) === 'renderRequirementPanel') declaration = node; ts.forEachChild(node, find); }
find(tree); assert.ok(declaration);
class Element {
  constructor() { this.children = []; this.hidden = false; this.textContent = ''; this.className = ''; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute() {}
  addEventListener() {}
}
test('renders route requirements even when the optional summary element is absent', () => {
  const body = new Element(); const panel = new Element();
  const state = { requirements: { stops: { value: [{ type: 'point', name: '元荡湖' }, { type: 'point', name: '淀山湖' }], status: 'pending' }, returnToStart: { value: true, status: 'pending' } }, candidates: [] };
  const context = { requirementState: state, previousIntent: { requestType: 'route' }, requirementPanel: panel, requirementPanelBody: body,
    requirementPanelSummary: null, historyPanel: { hidden: true }, currentSessionId: 1, document: { createElement: () => new Element() } };
  vm.createContext(context);
  const render = vm.runInContext(`(${declaration.initializer.getText(tree)})`, context);
  assert.doesNotThrow(render);
  assert.equal(panel.hidden, false);
  const stops = body.children.find(row => row.children[0]?.textContent === '途经顺序');
  assert.equal(stops.children[1].textContent, '元荡湖 → 淀山湖');
});
