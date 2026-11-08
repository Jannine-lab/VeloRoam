import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseIdeaOutput } from './ideaModel';
import { INTENT_PROMPT, RECOMMENDATION_PROMPT, SEGMENT_SELECTION_PROMPT } from '../prompts/ideaPrompts';

test('rejects blank, malformed and typed-wrong intent output instead of silently dropping constraints', () => {
  for (const value of ['', '{', '{"mode":"route","targetKm":"50"}', '{"mode":"route","maxMinutes":-1}', '{"mode":"route","preferredTags":["safe"]}']) {
    assert.throws(() => parseIdeaOutput(INTENT_PROMPT, value, {}));
  }
});
test('preserves simultaneous budget bounds and explicit exclusions without manufacturing defaults', () => {
  const intent = { mode: 'route', targetKm: 50, minKm: 40, maxKm: 60, avoidTags: ['climbing'], targetMinutes: null };
  assert.deepEqual(parseIdeaOutput(INTENT_PROMPT, JSON.stringify(intent), {}), intent);
});
test('rejects hallucinated and duplicate selection ids against the exact supplied evidence', () => {
  const input = { segments: [{ id: 'segment:1' }] };
  assert.throws(() => parseIdeaOutput(SEGMENT_SELECTION_PROMPT, '{"ids":["segment:2"]}', input));
  assert.throws(() => parseIdeaOutput(SEGMENT_SELECTION_PROMPT, '{"ids":["segment:1","segment:1"]}', input));
  assert.deepEqual(parseIdeaOutput(SEGMENT_SELECTION_PROMPT, '{"ids":[]}', input), { ids: [] });
});
test('validates explanation schema and refuses unregistered prompts', () => {
  const output = '{"items":[{"id":"point:1","reason":"补给类别"}]}';
  assert.equal(parseIdeaOutput(RECOMMENDATION_PROMPT, output, { candidates: [{ id: 'point:1' }] }).items.length, 1);
  assert.throws(() => parseIdeaOutput(RECOMMENDATION_PROMPT, output, { candidates: [] }));
  assert.throws(() => parseIdeaOutput('unknown', '{}', {}));
});
