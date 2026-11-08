import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { evaluateIdeaTurn, percentile } from './ideaEvaluation';

test('an expected refusal cannot turn an HTTP error or blank answer into a successful sample', () => {
  assert.equal(evaluateIdeaTurn(502, { error: 'failed', message: '未找到' }, { noRoute: true })[0].passed, false);
  assert.equal(evaluateIdeaTurn(200, { message: '' }, {})[0].passed, false);
});
test('evaluates constraints and candidate identities independently of free-form wording', () => {
  const body = { message: '完成', contextIntent: { targetKm: 50, avoidTags: ['climbing'] }, items: [{ id: 'segment:1' }] };
  assert.ok(evaluateIdeaTurn(200, body, { fields: { 'contextIntent.targetKm': 50, 'contextIntent.avoidTags': ['climbing'] }, candidateIds: ['segment:1'] }).every(x => x.passed));
  assert.ok(evaluateIdeaTurn(200, body, { fields: { 'contextIntent.targetKm': 30 }, candidateIds: ['segment:2'] }).some(x => !x.passed));
});
test('failed or merely proposed tools never count as successful tool selection', () => {
  assert.equal(evaluateIdeaTurn(200, { message: '完成', meta: { toolCalls: [{ name: 'search_candidates', status: 'error' }] } }, { toolAnyOf: ['search_candidates'] }).at(-1)!.passed, false);
});
test('computes nearest-rank latency percentiles and handles missing observations explicitly', () => {
  assert.equal(percentile([], .95), null); assert.equal(percentile([100, 20, 40, 80], .5), 40); assert.equal(percentile([100, 20, 40, 80], .95), 100);
});
