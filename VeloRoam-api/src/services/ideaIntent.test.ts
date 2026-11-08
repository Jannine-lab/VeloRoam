import { strict as assert } from 'assert';
import { test } from 'node:test';
import { clarificationOptions, sanitizeConversationIntent } from './ideaIntent';

test('uses valid model choices, removing duplicates and bounding their number', () => {
  assert.deepEqual(clarificationOptions(['返回起点', ' 返回起点 ', '', null, '前往终点', '其他', '多余'], 'destination'), ['返回起点', '前往终点', '其他']);
});

test('keeps unspecified constraints empty and preserves explicit time and tag context', () => {
  const empty = sanitizeConversationIntent({ mode: 'route' })!;
  assert.equal(empty.targetKm, null);
  assert.deepEqual(empty.preferences, []);
  const distance = sanitizeConversationIntent({ mode: 'route', targetKm: 50 })!;
  assert.equal(distance.targetKm, 50);
  assert.deepEqual(distance.preferences, []);
  const time = sanitizeConversationIntent({ mode: 'route', targetMinutes: 120, preferences: ['爬坡训练'], preferredTags: ['climbing', 'invalid'], timeScope: 'total', stopMinutes: 20 })!;
  assert.equal(time.targetMinutes, 120);
  assert.equal(time.timeScope, 'total');
  assert.equal(time.stopMinutes, 20);
  assert.deepEqual(time.preferredTags, ['climbing']);
  assert.equal(sanitizeConversationIntent({ mode: 'route', targetMinutes: -1 })?.targetMinutes, null);
});

test('provides context-appropriate choices when the model omits them', () => {
  assert.deepEqual(clarificationOptions([], 'destination'), ['骑完返回起点', '我想指定结束地点']);
  assert.deepEqual(clarificationOptions(null, 'order'), ['先骑路段，再去途经点', '先去途经点，再骑路段']);
  assert.ok(clarificationOptions(null, 'purpose').includes('规划完整骑行路线'));
});
