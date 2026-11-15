const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../VeloRoam-api/node_modules/typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, 'app.js'), 'utf8');
const tree = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let declaration;
function find(node) {
  if (ts.isVariableDeclaration(node) && node.name?.getText(tree) === 'createIdeaQuestion') declaration = node;
  ts.forEachChild(node, find);
}
find(tree);
assert.ok(declaration);
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.events = {}; this.dataset = {}; this.attributes = {}; this.value = ''; this.checked = false; this.disabled = false; }
  append(...items) { this.children.push(...items); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.events[name] = callback; }
  fire(name) { this.events[name]?.({ target: this }); }
  focus() { this.focused = true; }
}
function setup() {
  const sent = [];
  const context = { document: { createElement: tag => new Element(tag) }, nextIdeaQuestion: 0, currentSessionId: 1, ideaSending: false,
    input: { value: '草稿' }, resizeIdeaInput() {}, submitIdeaDirect() { sent.push(context.input.value); } };
  vm.createContext(context);
  const create = vm.runInContext(`(${declaration.initializer.getText(tree)})`, context);
  const card = create({ options: ['先去咖啡店', '先骑路段'], allowCustom: true }, 1);
  const [, status, fieldset, actions] = card.children;
  return { card, status, radios: fieldset.children.slice(1, 4).map(label => label.children[0]), custom: fieldset.children[4], submit: actions.children[0], context, sent };
}

test('question waits for a choice, submits it once and keeps an existing draft', () => {
  const ui = setup(); assert.equal(ui.submit.disabled, true);
  ui.radios[1].checked = true; ui.radios[1].fire('change');
  assert.equal(ui.submit.disabled, false); ui.submit.fire('click');
  assert.deepEqual(ui.sent, ['先骑路段']); assert.equal(ui.context.input.value, '草稿');
  ui.card.setQuestionState('submitting'); ui.submit.fire('click'); assert.equal(ui.sent.length, 1);
  ui.card.setQuestionState('answered', '先骑路段'); assert.equal(ui.status.textContent, '已回答：先骑路段');
});

test('custom answers require text and a failed submission restores the selection', () => {
  const ui = setup(); ui.radios[2].checked = true; ui.radios[2].fire('change');
  assert.equal(ui.custom.hidden, false); assert.equal(ui.custom.focused, true); assert.equal(ui.submit.disabled, true);
  ui.custom.value = '先休息，再骑'; ui.custom.fire('input'); assert.equal(ui.submit.disabled, false);
  ui.card.setQuestionState('submitting'); assert.equal(ui.submit.disabled, true);
  ui.card.setQuestionState('waiting'); assert.equal(ui.submit.disabled, false); ui.submit.fire('click');
  assert.deepEqual(ui.sent, ['先休息，再骑']);
});
