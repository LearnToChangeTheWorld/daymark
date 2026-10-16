import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatAccounts } from '../collector/chat-accounts.mjs';

test('WeChat database history preserves published time, whitelist, durable cursor, retry and account isolation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wechat-db-'));
  const events = new Map(); let manager; let accountId = 'wxid_self'; let unreadable = false; let fail = false; let errors = []; let reads = 0; let starts = 0;
  const publishedAt = new Date(Date.now() - 6 * 86400_000).toISOString();
  const status = () => ({ loginState: unreadable ? 'needs_key' : 'authenticated', readable: !unreadable, accountId, account: accountId, mode: 'local_database', supportsHistory: true });
  const factory = () => ({
    async start() { starts++; return status(); }, async loginStatus() { return status(); }, async close() {},
    async groups() { return { groups: [{ id: '123@chatroom', name: '班群', muted: true }] }; },
    async read(groups, cursors) {
      reads++; assert.deepEqual(groups, ['123@chatroom']);
      const after = cursors['123@chatroom']?.['message_0.db'] || 0;
      return { ...status(), chats: [{ id: '123@chatroom', messages: after ? [] : [{ id: 'server:9001', text: '请提交本周作业', publishedAt }], cursors: { 'message_0.db': 4 }, more: false }], errors };
    }
  });
  const create = () => createChatAccounts({ autoSelectGroups: false, dataDir, wechatFactory: factory, pollMs: 1e7, deliver: async (event) => { if (fail) throw new Error('disk'); events.set(event.externalId, event); } });
  const ready = async () => { for (let i = 0; i < 100 && manager.view('wechat').busy; i++) await new Promise((r) => setTimeout(r, 5)); assert.equal(manager.view('wechat').busy, false); };
  try {
    manager = await create(); manager.connect('wechat'); await ready();
    assert.equal(manager.view('wechat').collectionState, 'needs_groups');
    await assert.rejects(() => manager.configure('wechat', { groups: [{ id: '999@chatroom' }], remember: true }), /已不可用/);
    fail = true;
    await manager.configure('wechat', { groups: [{ id: '123@chatroom', name: 'forged' }], remember: true });
    assert.equal(manager.view('wechat').status, 'error');
    const saved = JSON.parse(await readFile(join(dataDir, 'chats.json')));
    assert.deepEqual(saved.wechat.history, {}, 'failed delivery cannot advance the durable position');
    fail = false; await manager.check('wechat');
    assert.equal(events.size, 1);
    assert.equal([...events.values()][0].publishedAt, publishedAt);
    assert.equal([...events.values()][0].sourceName, '微信 · 班群');
    assert.equal([...events.values()][0].kind, 'notification');
    assert.equal(manager.view('wechat').history.status, 'completed');
    assert.equal(manager.view('wechat').history.groups[0].status, 'available', 'local cache exhaustion is never claimed as complete server history');
    await manager.check('wechat'); assert.equal(events.size, 1);
    await manager.close(); manager = await create(); await ready();
    assert.equal(starts, 1, 'server restart must not launch or restart official WeChat');
    assert.equal(events.size, 1); assert.ok(reads >= 3);
    await manager.history('wechat'); assert.equal(events.size, 1, 'manual history retries use the same external ID');
    errors = ['message_0.db：页面校验失败']; await manager.check('wechat');
    assert.equal(manager.view('wechat').status, 'partial'); assert.equal(manager.view('wechat').history.status, 'partial');
    errors = []; unreadable = true; await manager.check('wechat'); assert.equal(manager.view('wechat').collectionState, 'stopped');
    unreadable = false; accountId = 'wxid_other'; await manager.check('wechat');
    assert.deepEqual(manager.view('wechat').groups, []); assert.equal(manager.view('wechat').collectionState, 'needs_groups');
  } finally { await manager?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('background WeChat reads keep the completed status visible and manual checks return a final result', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wechat-status-'));
  let manager; let reads = 0; let pause; let release; let errors = []; let failure = false; let authenticated = true;
  const status = () => ({ loginState: authenticated ? 'authenticated' : 'waiting_scan', readable: authenticated, accountId: 'wxid_self', account: 'wxid_self', mode: 'local_database', supportsHistory: true, message: authenticated ? '已连接本机消息库' : '请重新登录微信' });
  const until = async (condition) => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(condition(), 'expected collector state was not reached');
  };
  try {
    manager = await createChatAccounts({
      dataDir, autoSelectGroups: false, autoRestore: false, pollMs: 40, deliver: async () => {},
      wechatFactory: () => ({
        async start() { return status(); }, async loginStatus() { return status(); }, async close() {},
        async groups() { return { groups: [{ id: '42@chatroom', name: '课程群' }] }; },
        async read() {
          reads++;
          if (pause) await pause;
          if (failure) throw new Error('read failed');
          return { ...status(), chats: [{ id: '42@chatroom', messages: [], cursors: {}, more: false }], errors };
        }
      })
    });
    manager.connect('wechat'); await until(() => !manager.view('wechat').busy);
    await manager.configure('wechat', { groups: [{ id: '42@chatroom' }], remember: true });
    const completed = manager.view('wechat');
    assert.equal(completed.status, 'connected');
    pause = new Promise((resolve) => { release = resolve; });
    await until(() => manager.view('wechat').backgroundChecking);
    await until(() => reads > 1);
    const during = manager.view('wechat');
    assert.equal(during.busy, false, 'routine polling must not make the connection UI busy');
    assert.equal(during.status, 'connected'); assert.equal(during.collectionState, 'collecting');
    assert.equal(during.message, completed.message, 'an intermediate login result must not overwrite the completed collection result');
    assert.deepEqual(during.groupStatus, completed.groupStatus, 'keep completed per-group health while reading');
    const activeReads = reads;
    const checking = manager.check('wechat');
    release(); pause = null;
    const checked = await checking;
    assert.equal(reads, activeReads, 'manual check reuses the in-flight read instead of starting another pass');
    assert.equal(checked.checkResult.status, 'succeeded'); assert.ok(checked.checkResult.finishedAt);
    assert.equal(checked.checkResult.message, checked.message);
    errors = ['课程群：缓存读取失败'];
    assert.equal((await manager.check('wechat')).checkResult.status, 'partial');
    errors = []; failure = true;
    assert.equal((await manager.check('wechat')).checkResult.status, 'failed');
    assert.equal(manager.view('wechat').collectionState, 'error');
    failure = false;
    assert.equal((await manager.check('wechat')).checkResult.status, 'succeeded');
    authenticated = false;
    const loggedOut = await manager.check('wechat');
    assert.equal(loggedOut.checkResult.status, 'failed');
    assert.equal(loggedOut.loginState, 'waiting_scan'); assert.equal(loggedOut.collectionState, 'stopped');
    assert.equal(loggedOut.message, '请重新登录微信'); assert.deepEqual(loggedOut.groupStatus, []);
  } finally { release?.(); await manager?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
