import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatAccounts } from '../collector/chat-accounts.mjs';

test('concurrent live/history messages persist without queue races and history rechecks after restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chat-history-race-'));
  let manager; let onEvent; let live; let pages = 0;
  const saved = new Map();
  const messages = Array.from({ length: 20 }, (_, i) => ({ post_type: 'message', message_type: 'group', group_id: 42, self_id: 123, message_id: i + 1, message_seq: i + 1, time: Date.now() / 1000 - (i === 19 ? 8 * 86400 : i), raw_message: '提交作业 ' + i }));
  const qqFactory = (options) => { onEvent = options.onEvent; return {
    async start() {}, async loginStatus() { return { isLogin: true }; },
    async loginInfo() { return { uin: 123 }; }, async remember() {}, async enableEvents() {}, async close() {},
    async action(action) {
      if (action === 'get_group_list') return [{ group_id: 42, group_name: '班级群' }];
      assert.equal(action, 'get_group_msg_history'); pages++;
      live = Promise.all(messages.slice(0, 19).map(onEvent));
      return { messages };
    }
  }; };
  const create = () => createChatAccounts({ autoSelectGroups: false, dataDir, qqFactory, pollMs: 1e7, deliver: async (event) => { saved.set(event.externalId, event); } });
  const ready = async () => { for (let i = 0; i < 100 && manager.view('qq').busy; i++) await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(manager.view('qq').busy, false); };
  try {
    manager = await create(); manager.connect('qq'); await ready();
    await manager.configure('qq', { groups: [{ id: '42', name: '班级群' }], remember: true }); await live;
    assert.equal(saved.size, 19); assert.equal(manager.view('qq').status, 'connected');
    assert.equal(manager.view('qq').history.kept, 19); assert.equal(pages, 1);
    await manager.close(); manager = await create(); await ready(); await live;
    assert.equal(saved.size, 19); assert.equal(pages, 2, 'restart must recheck history for offline messages');
    assert.equal(manager.view('qq').history.status, 'completed');
  } finally { await manager?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
