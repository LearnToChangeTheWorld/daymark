import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatAccounts, snapshotDelta } from '../collector/chat-accounts.mjs';
import { groupEvent } from '../collector/onebot.mjs';

const waitReady = async (manager, source) => { for (let i = 0; i < 100 && manager.view(source).busy; i++) await new Promise((r) => setTimeout(r, 5)); assert.equal(manager.view(source).busy, false); };
test('snapshot starts without importing history, preserves repeated new posts and reports missing overlap', () => {
  assert.deepEqual(snapshotDelta(undefined, ['old']), { added: [], gap: false, baseline: true });
  assert.deepEqual(snapshotDelta([], ['new']).added, ['new']);
  assert.deepEqual(snapshotDelta(['x'], ['x', 'x']).added, ['x']);
  assert.deepEqual(snapshotDelta(['old', 'anchor'], ['anchor', 'new']).added, ['new']);
  assert.equal(snapshotDelta(['old'], ['unrelated']).gap, true);
});
test('QQ QR, remembered account, whitelist, expiry and new account isolation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chat-qq-')); let manager; let handler; let online = false; let id = '123'; let remembered; const delivered = [];
  const qqFactory = (options) => { handler = options.onEvent; return {
    async start() {}, async loginStatus() { return { isLogin: online, qrcodeurl: 'private-scan-token' }; }, async qrImage() { return Buffer.from('PNG'); },
    async refreshQr() {}, async loginInfo() { return { uin: id, nick: '测试账号' }; }, async remember(uin, enabled) { remembered = enabled ? uin : ''; },
    async enableEvents() {}, async action(action) { if (action === 'get_group_msg_history') return { messages: [] }; assert.equal(action, 'get_group_list'); return [{ group_id: 42, group_name: '课程群' }]; }, async close() {}
  }; };
  try {
    manager = await createChatAccounts({ autoSelectGroups: false, dataDir, qqFactory, deliver: async (event) => delivered.push(event), pollMs: 1e7 });
    manager.connect('qq', { remember: true }); await waitReady(manager, 'qq');
    assert.equal(manager.view('qq').qrAvailable, true); assert.equal(JSON.stringify(manager.view('qq')).includes('private-scan-token'), false);
    assert.equal(manager.view('qq').loginState, 'waiting_scan');
    manager.connect('qq', { remember: true }); await waitReady(manager, 'qq');
    assert.equal(manager.view('qq').qrAvailable, true, 'reconnecting must restore an unchanged QR image');
    assert.equal(manager.image('qq').toString(), 'PNG');
    online = true; await manager.tick('qq'); assert.equal(manager.view('qq').loginState, 'authenticated'); assert.equal(manager.view('qq').collectionState, 'needs_groups');
    assert.throws(() => manager.image('qq'), /失效/);
    await manager.configure('qq', { groups: [{ id: '42', name: 'forged name' }], remember: true });
    assert.equal(remembered, '123'); assert.equal(manager.view('qq').groups[0].name, '课程群');
    const message = { post_type: 'message', message_type: 'group', group_id: 42, self_id: 123, message_id: 9, time: Date.now() / 1000, message: [{ type: 'text', data: { text: '提交作业' } }, { type: 'image', data: { file: 'privateurl' } }] };
    await handler({ ...message, group_id: 99 }); await handler({ ...message, message_type: 'private' }); await handler({ ...message, self_id: 999 }); assert.equal(delivered.length, 0);
    await handler(message); assert.equal(delivered.length, 1); assert.equal(delivered[0].body, '提交作业[图片]'); assert.equal(delivered[0].kind, 'notification');
    assert.equal(delivered[0].category, 'academic'); assert.ok(delivered[0].publishedAt);
    await handler({ ...message, post_type: 'message_sent', message_id: 10 }); assert.equal(delivered.length, 2, 'messages sent from the account on another device are collected too');
    await manager.close();
    manager = await createChatAccounts({ autoSelectGroups: false, dataDir, qqFactory, deliver: async () => {}, pollMs: 1e7 }); await waitReady(manager, 'qq');
    assert.equal(manager.view('qq').collectionState, 'collecting'); assert.equal(manager.view('qq').groups[0].id, '42');
    online = false; await manager.tick('qq'); assert.notEqual(manager.view('qq').status, 'connected');
    id = '456'; online = true; await manager.tick('qq'); assert.deepEqual(manager.view('qq').groups, []);
    await manager.disconnect('qq'); assert.equal(remembered, ''); assert.equal(manager.view('qq').remembered, false);
    assert.equal(JSON.parse(await readFile(join(dataDir, 'chats.json'), 'utf8')).qq.enabled, false);
  } finally { await manager?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
test('WeChat captures only selected new messages, survives restart and keeps failures visible', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chat-wechat-')); let manager; let contents = ['旧通知']; let readable = true; let errors = []; let fail = false; let missing = false;
  const events = new Map();
  const wechatFactory = () => ({ async start() { return {}; }, async loginStatus() { return { loginState: 'authenticated', readable, account: '本人' }; }, async groups() { return { groups: [{ id: '班群', name: '班群' }] }; }, async read() { return { loginState: 'authenticated', readable, chats: missing ? [] : [{ id: '班群', messages: contents.map((text) => ({ text })) }], errors }; }, async close() {} });
  const deliver = async (event) => { if (fail) throw new Error('disk failure'); events.set(event.externalId, event); };
  try {
    manager = await createChatAccounts({ autoSelectGroups: false, dataDir, deliver, wechatFactory, pollMs: 1e7 });
    manager.connect('wechat'); await waitReady(manager, 'wechat');
    await manager.configure('wechat', { groups: [{ id: '班群', name: '班群' }], remember: true }); assert.equal(events.size, 0);
    assert.equal(manager.view('wechat').groupStatus[0].ready, true);
    contents = []; await manager.check('wechat'); assert.equal(manager.view('wechat').status, 'partial');
    contents = ['旧通知']; await manager.tick('wechat'); assert.equal(events.size, 0, 'an empty accessibility tree must not cause history to be reimported');
    contents.push('明天交作业'); await manager.tick('wechat'); assert.equal(events.size, 1); assert.equal([...events.values()][0].timestampKind, 'observed');
    await manager.tick('wechat'); assert.equal(events.size, 1);
    assert.ok(manager.view('wechat').lastMessageAt); assert.ok(manager.view('wechat').lastCheckedAt);
    await manager.close(); manager = await createChatAccounts({ autoSelectGroups: false, dataDir, deliver, wechatFactory, pollMs: 1e7 }); await waitReady(manager, 'wechat'); assert.equal(events.size, 1);
    contents.push('取快递'); fail = true; await manager.tick('wechat'); assert.equal(manager.view('wechat').status, 'error');
    await manager.close(); fail = false; manager = await createChatAccounts({ autoSelectGroups: false, dataDir, deliver, wechatFactory, pollMs: 1e7 }); await waitReady(manager, 'wechat'); assert.equal(events.size, 2);
    errors = ['班群：窗口已关闭']; await manager.tick('wechat'); assert.equal(manager.view('wechat').status, 'partial'); assert.equal(manager.view('wechat').errors.length, 1);
    errors = []; missing = true; await manager.tick('wechat');
    assert.equal(manager.view('wechat').collectionState, 'partial'); assert.equal(manager.view('wechat').groupStatus[0].ready, false);
    assert.match(manager.view('wechat').errors[0], /未读取到该群窗口/); missing = false;
    contents = ['无衔接的消息']; errors = []; await manager.tick('wechat'); assert.equal(events.size, 2); assert.match(manager.view('wechat').errors[0], /可能漏读/);
    await manager.tick('wechat'); assert.equal(manager.view('wechat').hasGaps, true); assert.equal(manager.view('wechat').status, 'partial');
    await manager.close(); manager = await createChatAccounts({ autoSelectGroups: false, dataDir, deliver, wechatFactory, pollMs: 1e7 }); await waitReady(manager, 'wechat');
    assert.equal(manager.view('wechat').hasGaps, true, 'missed-message warnings must survive restart');
    await manager.acknowledge('wechat'); assert.equal(manager.view('wechat').hasGaps, false); assert.equal(manager.view('wechat').status, 'connected');
    readable = false; await manager.tick('wechat'); assert.equal(manager.view('wechat').loginState, 'authenticated'); assert.equal(manager.view('wechat').collectionState, 'unsupported');
  } finally { await manager?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
test('remembered WeChat restores collection without launching or foregrounding its login window', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chat-quiet-')); let manager; let starts = 0; let statusChecks = 0;
  const wechatFactory = () => ({
    async start() { starts++; return {}; },
    async loginStatus() { statusChecks++; return { loginState: 'not_running', readable: false, message: '微信尚未打开' }; },
    async close() {}
  });
  try {
    await writeFile(join(dataDir, 'chats.json'), JSON.stringify({ wechat: { enabled: true, remember: true } }));
    manager = await createChatAccounts({ autoSelectGroups: false, dataDir, wechatFactory, deliver: async () => {}, pollMs: 1e7 });
    await waitReady(manager, 'wechat');
    await manager.check('wechat'); await manager.check('wechat');
    assert.equal(starts, 0); assert.ok(statusChecks >= 3);
    assert.equal(manager.view('wechat').loginState, 'not_running');
    manager.connect('wechat'); await waitReady(manager, 'wechat');
    assert.equal(starts, 1, 'only an explicit login action opens the client');
  } finally { await manager?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('OneBot arrays never embed attachment download URLs in the inbox', () => {
  const event = groupEvent({ post_type: 'message', message_type: 'group', self_id: 1, group_id: 2, message_id: 3, time: 1, message: [{ type: 'file', data: { url: 'secret', name: 'x' } }] }, ['2']);
  assert.equal(event.body, '[文件：x]');
});
