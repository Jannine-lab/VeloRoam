const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../VeloRoam-api/node_modules/typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, 'app.js'), 'utf8');
const tree = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let declaration;
function find(node) { if (ts.isVariableDeclaration(node) && node.name?.getText(tree) === 'renderRouteComparison') declaration = node; ts.forEachChild(node, find); }
find(tree); assert.ok(declaration);
class Element { constructor() { this.children = []; this.textContent = ''; } append(...items) { this.children.push(...items); } }

test('compares actual options once when both stream and final JSON contain the results', () => {
  const content = new Element();
  const context = { comparisonShown: false, content, document: { createElement: () => new Element() } };
  vm.createContext(context);
  const render = vm.runInContext(`(${declaration.initializer.getText(tree)})`, context);
  const options = [{ id: 'baseline', distanceKm: 30, durationMin: 90, added: [], overlap: { fraction: .12 } },
    { id: 'alternative:1', distanceKm: 31, durationMin: 95, hasEstimatedTime: true, extraKm: 1, added: ['绿道'], overlap: { fraction: .08 } }];
  render(options); render(options);
  assert.equal(content.children.length, 1);
  const [heading, list] = content.children[0].children;
  assert.equal(heading.textContent, '方案对比');
  assert.match(list.children[0].textContent, /30\.0 公里/);
  assert.match(list.children[1].textContent, /比首条多 1\.0 公里/);
  assert.match(list.children[1].textContent, /含估算/);
  assert.match(list.children[1].textContent, /重复路段约 8%（估算）/);
});
