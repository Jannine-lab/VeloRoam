import { strict as assert } from 'assert';
import { test } from 'node:test';
import { clarificationOptions } from './ideaIntent';

test('uses valid model choices, removing duplicates and bounding their number', () => {
  assert.deepEqual(clarificationOptions(['返回起点', ' 返回起点 ', '', null, '前往终点', '其他', '多余'], 'destination'), ['返回起点', '前往终点', '其他']);
});

test('provides context-appropriate choices when the model omits them', () => {
  assert.deepEqual(clarificationOptions([], 'destination'), ['骑完返回起点', '我想指定结束地点']);
  assert.deepEqual(clarificationOptions(null, 'order'), ['先骑路段，再去途经点', '先去途经点，再骑路段']);
  assert.ok(clarificationOptions(null, 'purpose').includes('规划完整骑行路线'));
});
