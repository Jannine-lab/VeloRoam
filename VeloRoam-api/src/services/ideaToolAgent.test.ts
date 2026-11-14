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

test('nearby search uses trusted origin, bounds radius and returns summaries rather than geometry', async () => {
  let turns = 0; let callsMade = 0;
  const center = { lat: 31.2, lng: 121.4 };
  await runIdeaToolAgent({ ...defaults(), location: { point: center, source: 'gps' },
    nearby: async (point, radius) => { callsMade++; assert.deepEqual(point, center); assert.equal(radius, 5); return [candidate, { ...candidate, id: 'segment:2', lat: 32 }]; },
    callModel: async messages => {
      if (!turns++) return calls({ name: 'search_nearby_candidates', args: { centerId: null, radiusKm: 5, type: 'segment' }, id: 'near' });
      const result = JSON.parse(String(messages.at(-1)!.content));
      assert.equal(result.centerSource, 'gps'); assert.deepEqual(result.candidates.map((item: Candidate) => item.id), [candidate.id]);
      assert.doesNotMatch(String(messages.at(-1)!.content), /coordinates/); return final();
    }
  });
  assert.equal(callsMade, 1);
});

test('nearby search rejects untrusted IDs and invalid radius before backend access', async () => {
  let turns = 0, reads = 0;
  const options = defaults();
  await runIdeaToolAgent({ ...options, location: { point: { lat: 31.2, lng: 121.4 }, source: 'map_center' }, nearby: async () => { reads++; return []; },
    callModel: async messages => {
      if (!turns++) return calls(
        { name: 'search_nearby_candidates', args: { centerId: 'segment:999', radiusKm: 5, type: 'all' }, id: 'unknown' },
        { name: 'search_nearby_candidates', args: { centerId: null, radiusKm: 5000, type: 'all' }, id: 'oversized' });
      assert.equal(JSON.parse(String(messages.at(-2)!.content)).status, 'not_found'); return final();
    }
  });
  assert.equal(reads, 0); assert.deepEqual(options.metrics.toolCalls.map(x => x.status), ['ok', 'invalid']);
});

test('planning is unavailable before confirmation and uses only confirmed backend input', async () => {
  let turns = 0;
  const first = defaults();
  await runIdeaToolAgent({ ...first, callModel: async () => !turns++ ? calls({ name: 'plan_cycling_route', args: {}, id: 'not-allowed' }) : final() });
  assert.equal(first.metrics.toolCalls[0].status, 'invalid');
  turns = 0; let plans = 0;
  const confirmed = defaults();
  await runIdeaToolAgent({ ...confirmed, plan: async () => { plans++; return { route: { distanceKm: 30, durationMin: 90, hasEstimatedTime: false, stops: [{ name: '起点', type: 'start', point: { lat: 31, lng: 121 } }] } }; },
    callModel: async messages => {
      if (!turns++) return calls(
        { name: 'plan_cycling_route', args: { maxKm: 900 }, id: 'alter' },
        { name: 'plan_cycling_route', args: {}, id: 'plan' },
        { name: 'plan_cycling_route', args: {}, id: 'cached' });
      const result = JSON.parse(String(messages.at(-2)!.content));
      assert.equal(result.status, 'planned'); assert.equal(result.distanceKm, 30);
      assert.doesNotMatch(String(messages.at(-2)!.content), /lat|lng|coordinates/); return final();
    }
  });
  assert.equal(plans, 1); assert.deepEqual(confirmed.metrics.toolCalls.map(x => x.status), ['invalid', 'ok', 'cached']);
});

test('enroute exploration requires a real planned route and may be retried after planning', async () => {
  const options = defaults(); let turns = 0, planned = false, explored = 0;
  await runIdeaToolAgent({ ...options,
    plan: async () => { planned = true; return { route: { distanceKm: 30, durationMin: 90, stops: [] } }; },
    explore: async () => planned ? (explored++, { status: 'explored', added: ['顺路绿道'], extraKm: 1.2, result: { route: { legs: [], stops: [], distanceKm: 31.2, durationMin: 95, hasEstimatedTime: true } } }) : null,
    callModel: async messages => {
      if (!turns++) return calls(
        { name: 'find_enroute_segments', args: {}, id: 'early' },
        { name: 'plan_cycling_route', args: {}, id: 'plan' },
        { name: 'find_enroute_segments', args: {}, id: 'later' });
      assert.equal(JSON.parse(String(messages.at(-3)!.content)).status, 'plan_required');
      const result = JSON.parse(String(messages.at(-1)!.content));
      assert.equal(result.status, 'explored'); assert.deepEqual(result.added, ['顺路绿道']);
      assert.equal(result.distanceKm, 31.2); assert.doesNotMatch(String(messages.at(-1)!.content), /coordinates|points/);
      return final();
    }
  });
  assert.equal(explored, 1);
});

test('requires a nearby tool call when the model initially skips explicit nearby discovery', async () => {
  let turn = 0, searched = 0;
  const options = defaults();
  await runIdeaToolAgent({ ...options, input: { idea: '请查询当前位置5公里内有哪些路段' },
    location: { point: { lat: 31.2, lng: 121.4 }, source: 'manual' }, nearby: async () => { searched++; return [candidate]; },
    callModel: async (_messages, _final, _signal, required) => {
      if (!turn++) return new AIMessage('{"mode":"recommend"}');
      if (turn === 2) { assert.equal(required, true); return calls({ name: 'search_nearby_candidates', args: { centerId: null, radiusKm: 5, type: 'segment' }, id: 'near' }); }
      return new AIMessage('{"mode":"recommend"}');
    }
  });
  assert.equal(searched, 1);
});

test('nearby search around a known candidate refreshes its identity before use', async () => {
  let turn = 0, details = 0, searches = 0;
  await runIdeaToolAgent({ ...defaults(), input: { placeContext: { candidates: [{ id: candidate.id, name: candidate.name }] } },
    detail: async id => { details++; return id === candidate.id ? candidate : null; },
    nearby: async (center, radius) => { searches++; assert.deepEqual(center, { lat: candidate.lat, lng: candidate.lng }); assert.equal(radius, 10); return [candidate]; },
    callModel: async messages => {
      if (!turn++) return calls({ name: 'search_nearby_candidates', args: { centerId: candidate.id, radiusKm: 10, type: 'all' }, id: 'around' });
      assert.equal(JSON.parse(String(messages.at(-1)!.content)).centerSource, 'candidate'); return final();
    }
  });
  assert.equal(details, 1); assert.equal(searches, 1);
});
