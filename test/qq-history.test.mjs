import test from 'node:test';
import assert from 'node:assert/strict';
import { readHistoryPage, historySummary } from '../collector/qq-history.mjs';

test('QQ history pages back across a week, retains source time, filters groups and handles overlap', async () => {
  const now = Date.parse('2026-10-15T11:00:00Z'); const groups = [{ id: '42', name: '课程群' }]; const history = {}; const events = new Map();
  const msg = (id, days, extra = {}) => ({ self_id: 123, group_id: 42, message_type: 'group', post_type: 'message', time: (now - days * 86400_000) / 1000, message_id: id, message_seq: id, raw_message: '下周交作业', ...extra });
  const pages = [[msg(3, 1), msg(2, 6), msg(50, 1, { group_id: 99 })], [msg(2, 6), msg(1, 8)]];
  const client = { async action(action, params) { assert.equal(action, 'get_group_msg_history'); assert.equal(params.group_id, '42'); assert.equal(params.disable_get_url, true); assert.equal(params.message_seq, pages.length === 2 ? undefined : '2'); return { messages: pages.shift() }; } };
  const page = () => readHistoryPage({ client, accountId: '123', groups, history, now, deliver: async (event) => events.set(event.externalId, event) });
  await page(); assert.equal(historySummary(groups, history).status, 'running');
  await page(); assert.equal(historySummary(groups, history).status, 'completed'); assert.equal(events.size, 2);
  assert.equal(history['42'].kept, 2); assert.equal(history['42'].scanned, 3);
  assert.equal(events.get('123:42:2').publishedAt, new Date(now - 6 * 86400_000).toISOString());
  assert.equal(events.get('123:42:2').kind, 'notification');
  const saved = JSON.parse(JSON.stringify(history)); await readHistoryPage({ client, accountId: '123', groups, history: saved, now, deliver: async () => assert.fail('completed history must not reimport') });
});

test('QQ history makes unavailable or failed ranges explicit and preserves progress on failure', async () => {
  const groups = [{ id: '42', name: '课程群' }]; const history = {}; const now = Date.now(); let fail = true;
  const client = { async action() { return { messages: [{ self_id: 123, group_id: 42, message_type: 'group', post_type: 'message', time: now / 1000, message_id: 1, message_seq: 1, raw_message: '作业' }] }; } };
  const page = () => readHistoryPage({ client, accountId: '123', groups, history, now, deliver: async () => { if (fail) throw new Error('disk'); } });
  await page(); assert.equal(history['42'].status, 'partial'); assert.equal(history['42'].cursor, undefined); assert.equal(history['42'].kept, 0);
  fail = false; history['42'].status = 'running'; await page(); await page();
  assert.equal(history['42'].status, 'available'); assert.match(history['42'].message, /无法确认历史完整/);
  assert.equal(history['42'].kept, 1);
});

test('QQ history fairly processes groups instead of allowing one busy group to block all others', async () => {
  const groups = [{ id: '1', name: 'A' }, { id: '2', name: 'B' }]; const history = {}; const called = [];
  const now = Date.now(); const client = { async action(action, params) { called.push(params.group_id); return { messages: [{ self_id: 123, group_id: params.group_id, message_type: 'group', post_type: 'message', time: now / 1000, message_id: 1, raw_message: '作业' }] }; } };
  for (let n = 0; n < 2; n++) await readHistoryPage({ client, accountId: '123', groups, history, now, deliver: async () => {} });
  assert.deepEqual(called, ['1', '2']);
});
