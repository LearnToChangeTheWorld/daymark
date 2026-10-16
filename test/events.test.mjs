import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMessage, cleanItem, validDate, validateEvent } from '../shared/events.mjs';
import { groupEvent, verifySignature } from '../collector/onebot.mjs';
import { createHmac } from 'node:crypto';

test('dates reject impossible calendar days', () => {
  assert.equal(validDate('2028-02-29'), true);
  assert.equal(validDate('2027-02-29'), false);
  assert.equal(validDate('2027-13-01'), false);
});

test('unclassified and ambiguous notices remain flagged for review', () => {
  assert.deepEqual(classifyMessage('周五交实验报告'), { category: 'academic', confidence: 'high' });
  assert.deepEqual(classifyMessage('周五交报告后取快递'), { category: 'unclassified', confidence: 'low' });
  assert.deepEqual(classifyMessage('晚上有空吗'), { category: 'unclassified', confidence: 'low' });
  assert.equal(cleanItem({ title: '需要人工分类' }).confidence, 'low');
});

test('collector event requires a stable source identity and timestamp', () => {
  const event = validateEvent({ source: 'qq', externalId: 'account:group:message', title: '交报告', body: '原文', createdAt: '2026-10-15T10:00:00Z', category: 'academic' });
  assert.equal(event.due, null);
  assert.throws(() => validateEvent({ source: 'qq', title: '缺 ID', createdAt: '2026-10-15' }), /externalId/);
  assert.throws(() => validateEvent({ source: 'qq', externalId: 'x', title: '缺时间' }), /createdAt/);
});

test('OneBot webhook validates signature and filters to configured groups', () => {
  const raw = Buffer.from('{"post_type":"message","message_type":"group"}');
  const secret = 'test-secret';
  const signature = 'sha1=' + createHmac('sha1', secret).update(raw).digest('hex');
  assert.equal(verifySignature(raw, signature, secret), true);
  assert.equal(verifySignature(raw, 'sha1=bad', secret), false);
  const event = groupEvent({ post_type: 'message', message_type: 'group', self_id: 7, group_id: 42, message_id: 9, time: 1792058400, raw_message: '周五提交实验报告' }, ['42']);
  assert.equal(event.source, 'qq');
  assert.equal(event.externalId, '7:42:9');
  assert.equal(event.category, 'academic');
  assert.equal(groupEvent({ post_type: 'message', message_type: 'group', self_id: 7, group_id: 99, message_id: 9, time: 1792058400, raw_message: '你好' }, ['42']), null);
});
