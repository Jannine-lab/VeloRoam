import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { attachSegmentTags, rankCandidatesByTags, requestedRouteTags, TaggableCandidate, unknownRouteTags } from './ideaTagPreferences';
import { sanitizeConversationIntent } from './ideaIntent';

test('loads only candidate tags and keeps missing tag rows unknown', async () => {
  const candidates: TaggableCandidate[] = [{ id: 'segment:9007199254740993', type: 'segment' }, { id: 'segment:2', type: 'segment' }, { id: 'point:1', type: 'point' }];
  let parameters: any[] = [];
  const result = await attachSegmentTags(candidates, async (_sql, params) => { parameters = params || []; return { rows: [
    { id: '9007199254740993', tag: 'popular', status: 'matched' }, { id: '2', tag: 'climbing', status: 'not_matched' },
    { id: '2', tag: 'unrecognized', status: 'matched' }, { id: '999', tag: 'loop', status: 'matched' }
  ] }; });
  assert.deepEqual(parameters, ['9007199254740993', '2']);
  assert.equal(result[0].tags?.popular, 'matched');
  assert.equal(result[0].tags?.climbing, 'unknown');
  assert.equal(result[1].tags?.climbing, 'not_matched');
  assert.equal(result[2].tags, undefined);
});

test('missing tag table degrades to unknown but other database errors propagate', async () => {
  const candidates: TaggableCandidate[] = [{ id: 'segment:1', type: 'segment' }];
  const unknown = await attachSegmentTags(candidates, async () => { throw Object.assign(new Error('missing'), { code: 'ER_NO_SUCH_TABLE' }); });
  assert.equal(unknown[0].tags?.popular, 'unknown');
  await assert.rejects(attachSegmentTags(candidates, async () => { throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }); }), /offline/);
});

test('known matching tags rank first, explicit exclusions remove matches, unknown remains', () => {
  const prefs = requestedRouteTags(sanitizeConversationIntent({ mode: 'route', preferences: ['热门', '不要爬坡'] })!);
  const candidates = [
    { id: 'segment:1', type: 'segment' as const, tags: { ...unknownRouteTags(), popular: 'unknown' as const } },
    { id: 'segment:2', type: 'segment' as const, tags: { ...unknownRouteTags(), popular: 'matched' as const, climbing: 'not_matched' as const } },
    { id: 'segment:3', type: 'segment' as const, tags: { ...unknownRouteTags(), popular: 'matched' as const, climbing: 'matched' as const } }
  ];
  assert.deepEqual(rankCandidatesByTags(candidates, prefs).map(value => value.id), ['segment:2', 'segment:1']);
  assert.deepEqual(prefs.preferred, ['popular']);
  assert.deepEqual(prefs.avoid, ['climbing']);
});
