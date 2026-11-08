import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { runIdeaToolAgent, ToolModelCall } from './ideaToolAgent';
import { createIdeaMetrics } from './ideaModel';
import type { Candidate } from '../controllers/ideaController';

const candidate: Candidate = { id: 'segment:1', type: 'segment', name: '测试滨江段', lat: 31.2, lng: 121.4, coordinates: [{ lat: 31.2, lng: 121.4 }, { lat: 31.21, lng: 121.41 }] };
const final = () => new AIMessage('{"mode":"route","targetKm":30}');
const calls = (...items: Array<{ name: string; args: object; id: string }>) => new AIMessage({ content: '', tool_calls: items });
const defaults = () => ({ input: { idea: '测试滨江段' }, metrics: createIdeaMetrics(), search: async () => [candidate], resolve: async () => null });

test('executes native tool requests and sends actual bounded evidence back before final output', async () => {
  const options = defaults(); let turns = 0;
  const result = await runIdeaToolAgent({ ...options, callModel: async messages => {
    if (!turns++) return calls({ name: 'search_candidates', args: { name: candidate.name, terms: [] }, id: 'one' });
    const evidence = messages.at(-1)!;
    assert.ok(evidence instanceof ToolMessage);
    assert.match(String(evidence.content), /segment:1/); assert.doesNotMatch(String(evidence.content), /coordinates/);
    return final();
  } });
  assert.equal(result.targetKm, 30); assert.equal(options.metrics.modelCalls, 2); assert.equal(options.metrics.toolCalls[0].status, 'ok');
});
test('requires native grounding when an initial JSON answer bypasses tools for a named lookup', async () => {
  let turns = 0;
  await runIdeaToolAgent({ ...defaults(), callModel: async (_messages, forceFinal, _signal, required) => {
    if (!turns++) return new AIMessage('{"mode":"answer","lookup":{"name":"测试滨江段","terms":[],"kind":"segment"}}');
    if (turns === 2) { assert.equal(required, true); return calls({ name: 'search_candidates', args: { name: candidate.name, terms: [] }, id: 'one' }); }
    assert.equal(forceFinal, true); return final();
  } });
});
test('final model wording cannot erase the lookup associated with retrieved evidence', async () => {
  let turns = 0;
  const result = await runIdeaToolAgent({ ...defaults(), callModel: async () => !turns++
    ? calls({ name: 'search_candidates', args: { name: candidate.name, terms: [] }, id: 'one' })
    : new AIMessage('{"mode":"answer","reply":"待核验描述"}') });
  assert.equal(result.lookup.name, candidate.name);
});
test('unknown tools and malformed arguments never reach backend services', async () => {
  const options = defaults(); let reads = 0; let turns = 0;
  await runIdeaToolAgent({ ...options, search: async () => { reads++; return []; }, callModel: async () => !turns++ ? calls(
    { name: 'execute_sql', args: { sql: 'DROP TABLE x' }, id: 'one' },
    { name: 'search_candidates', args: { name: 42, terms: [] }, id: 'two' }) : final() });
  assert.equal(reads, 0); assert.deepEqual(options.metrics.toolCalls.map(x => x.status), ['invalid', 'invalid']);
});
test('identical calls reuse request-scoped results and still consume the call budget', async () => {
  const options = defaults(); let reads = 0; let turns = 0;
  await runIdeaToolAgent({ ...options, search: async () => { reads++; return [candidate]; }, callModel: async () => !turns++ ? calls(
    { name: 'search_candidates', args: { name: candidate.name, terms: [] }, id: 'one' },
    { name: 'search_candidates', args: { name: candidate.name, terms: [] }, id: 'two' }) : final() });
  assert.equal(reads, 1); assert.deepEqual(options.metrics.toolCalls.map(x => x.status), ['ok', 'cached']);
});
test('a selected id is freshly checked and a missing record is not replaced by a related candidate', async () => {
  let turns = 0;
  await runIdeaToolAgent({ ...defaults(), input: { placeContext: { candidates: [{ id: 'segment:9', name: '已删除路段' }] } },
    callModel: async messages => {
      if (!turns++) return calls({ name: 'get_candidate_detail', args: { id: 'segment:9' }, id: 'one' });
      assert.deepEqual(JSON.parse(String(messages.at(-1)!.content)), { status: 'not_found', candidate: null }); return final();
    } });
});
test('a fabricated id cannot trigger an arbitrary lookup', async () => {
  let reads = 0; let turns = 0;
  await runIdeaToolAgent({ ...defaults(), search: async () => { reads++; return []; },
    callModel: async () => !turns++ ? calls({ name: 'get_candidate_detail', args: { id: 'segment:999' }, id: 'one' }) : final() });
  assert.equal(reads, 0);
});
test('tool failure is reported as unavailable rather than an empty successful retrieval', async () => {
  const options = defaults(); let turns = 0;
  await runIdeaToolAgent({ ...options, search: async () => { throw new Error('credential must not leak'); }, callModel: async messages => {
    if (!turns++) return calls({ name: 'search_candidates', args: { name: candidate.name, terms: [] }, id: 'one' });
    assert.deepEqual(JSON.parse(String(messages.at(-1)!.content)), { error: 'tool_unavailable' }); return final();
  } });
  assert.equal(options.metrics.toolCalls[0].status, 'error');
});
test('times out an unresponsive tool without waiting indefinitely', async () => {
  const options = defaults(); let turns = 0;
  await runIdeaToolAgent({ ...options, toolTimeoutMs: 10, search: () => new Promise(() => {}),
    callModel: async () => !turns++ ? calls({ name: 'search_candidates', args: { name: candidate.name, terms: [] }, id: 'one' }) : final() });
  assert.equal(options.metrics.toolCalls[0].status, 'error');
});
test('bounds backend executions and forces a final model turn after exhausting the tool budget', async () => {
  const options = defaults(); let reads = 0; let turns = 0;
  const callModel: ToolModelCall = async (_messages, forceFinal) => {
    if (turns++) { assert.equal(forceFinal, true); return final(); }
    return calls(...Array.from({ length: 6 }, (_, i) => ({ name: 'search_candidates', args: { name: `地点${i}`, terms: [] }, id: `call${i}` })));
  };
  await runIdeaToolAgent({ ...options, search: async () => { reads++; return []; }, callModel });
  assert.equal(reads, 4); assert.equal(options.metrics.toolCalls.filter(x => x.status === 'budget').length, 2);
});
test('rejects duplicate protocol ids and invalid final output', async () => {
  await assert.rejects(runIdeaToolAgent({ ...defaults(), callModel: async () => calls(
    { name: 'resolve_place', args: { name: '上海' }, id: 'same' }, { name: 'resolve_place', args: { name: '上海' }, id: 'same' }) }), /duplicate/);
  await assert.rejects(runIdeaToolAgent({ ...defaults(), callModel: async () => new AIMessage('{"mode":"route","targetKm":"30"}') }));
});
test('the request deadline aborts model work and is cleaned up after failure', async () => {
  await assert.rejects(runIdeaToolAgent({ ...defaults(), deadlineMs: 10, callModel: async (_messages, _final, signal) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) }), /aborted/);
});
