import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { sanitizeConversationIntent } from './ideaIntent';
import { buildRequirementState, mergeIntent } from './ideaRequirementState';

const intent = (value: object) => sanitizeConversationIntent({ mode: 'route', ...value })!;

test('keeps omitted or empty requirements and allows explicit removal and replacement', () => {
  const previous = intent({ targetKm: 30, maxKm: 50, preferences: ['轻松'], returnToStart: true, stops: [{ type: 'point', name: '公园' }] });
  const edited = mergeIntent(previous, { mode: 'route', targetKm: 40, maxKm: null, preferences: [], stops: [], returnToStart: false })!;
  assert.equal(edited.targetKm, 40); assert.equal(edited.maxKm, 50);
  assert.deepEqual(edited.preferences, ['轻松']); assert.equal(edited.stops[0].name, '公园'); assert.equal(edited.returnToStart, true);
  const cleared = mergeIntent(edited, { mode: 'route', clearedFields: ['maxKm', 'preferences', 'stops'], changedFields: ['returnToStart'], returnToStart: false })!;
  assert.equal(cleared.maxKm, null); assert.deepEqual(cleared.preferences, []); assert.deepEqual(cleared.stops, []); assert.equal(cleared.returnToStart, false); assert.equal(cleared.targetKm, 40);
  const fresh = mergeIntent(previous, { mode: 'route', newConversation: true, targetKm: 20 })!;
  assert.equal(fresh.maxKm, null); assert.deepEqual(fresh.preferences, []);
});

test('tracks pending, confirmed, changed and unknown requirements without trusting mismatched prior state', () => {
  const first = intent({ targetKm: 30, maxKm: 50, preferences: ['轻松'] });
  const pending = buildRequirementState(first, null, null, false, null, new Map())!;
  assert.equal(pending.requirements.targetKm.status, 'pending'); assert.equal(pending.requirements.maxKm.priority, 'required');
  assert.equal(pending.requirements.destination.status, 'unknown');
  const confirmed = buildRequirementState(first, first, pending, true, null, new Map())!;
  assert.equal(confirmed.requirements.targetKm.status, 'confirmed');
  const edited = intent({ targetKm: 40, maxKm: 50, preferences: ['轻松'] });
  const state = buildRequirementState(edited, first, confirmed, false, null, new Map())!;
  assert.equal(state.requirements.targetKm.status, 'pending'); assert.equal(state.requirements.maxKm.status, 'confirmed');
  const fake = { ...confirmed, requirements: { ...confirmed.requirements, targetKm: { ...confirmed.requirements.targetKm, value: 40 } } };
  assert.equal(buildRequirementState(edited, first, fake, false, null, new Map())!.requirements.targetKm.status, 'pending');
});

test('candidate facts are only exposed from current retrieved records and selection requires confirmation', () => {
  const i = intent({ needsSegment: true });
  const candidate = { id: 'segment:1', type: 'segment' as const, name: '绿道', lat: 31, lng: 121, score: 90 };
  const place = { query: '绿道', terms: [], candidates: [{ id: candidate.id, type: candidate.type, name: candidate.name }], selectedId: candidate.id, area: null };
  const state = buildRequirementState(i, null, null, false, place, new Map([[candidate.id, candidate]]))!;
  assert.equal(state.candidates[0].selection, 'pending'); assert.equal(state.candidates[0].facts?.score, 90);
  const reference = buildRequirementState(i, i, state, true, place, new Map())!;
  assert.equal(reference.candidates[0].evidence, 'reference_only'); assert.equal(reference.candidates[0].selection, 'pending'); assert.equal(reference.candidates[0].facts, null);
});
