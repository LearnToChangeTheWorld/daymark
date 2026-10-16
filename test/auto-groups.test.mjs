import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyGroup, itemRelevance, itemTopic } from '../shared/learning-relevance.mjs';
import { createChatAccounts } from '../collector/chat-accounts.mjs';

test('learning discovery separates ambiguous names and social groups, with course and message evidence', () => {
  for (const name of ['CSU交通院2025级（官方）', '交控2501班', 'C++', '大学物理']) assert.equal(classifyGroup({ name }).relevance, 'learning', name);
  assert.equal(classifyGroup({ name: '食物营养研讨' }, { courses: ['食物营养研讨'] }).relevance, 'learning');
  assert.equal(classifyGroup({ name: '424' }).relevance, 'unknown');
  assert.equal(classifyGroup({ name: '424' }, { messages: ['本周作业：完成习题三'] }).relevance, 'learning');
  assert.equal(classifyGroup({ name: '424' }, { messages: ['谢谢', '得大改。。。'] }).relevance, 'unknown');
  assert.equal(classifyGroup({ name: '游戏开黑群' }, { messages: ['交作业'] }).relevance, 'other');
  assert.equal(itemRelevance({ source: 'qq', category: 'life', body: '快递到了' }), 'other');
  assert.equal(itemRelevance({ source: 'qq', category: 'life', kind: 'task', body: '快递到了' }), 'learning', 'human-confirmed tasks are never hidden');
  assert.equal(itemRelevance({ source: 'wechat', sourceName: '交控2501班', category: 'academic', body: '大家记得智慧学工打卡' }), 'other', 'daily life reminders do not crowd learning review');
  assert.equal(itemRelevance({ source: 'wechat', sourceName: '交控2501班', body: '请提交本周篮球课作业' }), 'learning', 'actual coursework takes precedence over sport keywords');
  assert.equal(itemTopic({ title: '明天考试换教室' }), '考试考务');
});

test('QQ automatically discovers learning groups, preserves collection on failure, persists corrections and isolates accounts', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'auto-groups-'));
  let manager, onEvent, accountId = '123', broken = false;
  const delivered = [], previews = [];
  const qqFactory = (options) => {
    onEvent = options.onEvent;
    return {
      async start() {}, async loginStatus() { return { isLogin: true }; }, async loginInfo() { return { uin: accountId }; }, async remember() {}, async enableEvents() {}, async close() {},
      async action(action, params) {
        if (action === 'get_group_list') { if (broken) throw Error('offline'); return accountId === '123' ? [{ group_id: 1, group_name: '课程群' }, { group_id: 2, group_name: '宿舍群' }, { group_id: 3, group_name: '424' }] : [{ group_id: 9, group_name: '游戏群' }]; }
        previews.push(params.group_id);
        return { messages: params.group_id === '3' ? [{ post_type: 'message', message_type: 'group', self_id: Number(accountId), group_id: 3, message_id: 88, time: Date.now() / 1000, message: '本周作业：第3章习题' }] : [] };
      }
    };
  };
  const create = () => createChatAccounts({ dataDir, qqFactory, autoRestore: false, pollMs: 1e8, deliver: async (event) => delivered.push(event) });
  const ready = async () => { while (manager.view('qq').busy) await new Promise((r) => setTimeout(r, 5)); };
  try {
    manager = await create(); manager.connect('qq'); await ready();
    assert.deepEqual(manager.view('qq').groups.map((g) => g.id), ['1', '3']);
    assert.equal(previews.includes('2'), false, 'social group is never sampled');
    assert.equal(delivered.length, 0, 'discovery samples do not become imported messages');
    await manager.selection('qq', { id: '1', decision: 'exclude' });
    assert.deepEqual(manager.view('qq').groups.map((g) => g.id), ['3']);
    broken = true; await manager.selection('qq', { refresh: true });
    assert.deepEqual(manager.view('qq').groups.map((g) => g.id), ['3']);
    assert.ok(manager.view('qq').selection.error); assert.notEqual(manager.view('qq').status, 'connected');
    broken = false; await manager.close(); manager = await create(); manager.connect('qq'); await ready();
    assert.equal(manager.view('qq').selection.groups.find((g) => g.id === '1').decision, 'exclude');
    accountId = '456'; await manager.tick('qq');
    assert.deepEqual(manager.view('qq').groups, []); assert.equal(manager.view('qq').selection.groups.some((g) => g.id === '1'), false);
    await onEvent({ post_type: 'message', message_type: 'group', self_id: 123, group_id: 3, message_id: 90, time: Date.now() / 1000, message: '作业' });
    assert.equal(delivered.some((e) => e.externalId.startsWith('123:3:90')), false);
  } finally { await manager?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('WeChat automatically reads muted learning groups, samples unknown groups without moving durable cursors', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'auto-wechat-')); let manager;
  const delivered = []; const reads = [];
  const state = { mode: 'local_database', loginState: 'authenticated', readable: true, accountId: 'wxid_self', account: '测试' };
  const wechatFactory = () => ({
    async start() { return state; }, async loginStatus() { return state; }, async close() {},
    async groups() { return { ...state, groups: [{ id: 'a@chatroom', name: '课程群', muted: true }, { id: 'b@chatroom', name: '424' }, { id: 'c@chatroom', name: '宿舍群' }] }; },
    async preview(ids) { assert.deepEqual(ids, ['b@chatroom']); return { ...state, chats: [{ id: ids[0], messages: [{ text: '明天提交实验报告' }] }] }; },
    async read(ids, cursors) { reads.push(ids); assert.deepEqual(cursors['b@chatroom'], {}); return { ...state, chats: ids.map((id) => ({ id, messages: [{ id: '1', text: '明天提交实验报告', publishedAt: new Date().toISOString() }], cursors: { 'message_0.db': 7 }, more: false })) }; }
  });
  try {
    manager = await createChatAccounts({ dataDir, wechatFactory, pollMs: 1e8, deliver: async (e) => delivered.push(e) });
    manager.connect('wechat'); while (manager.view('wechat').busy) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(reads[0], ['a@chatroom', 'b@chatroom']); assert.equal(delivered.length, 2);
    assert.equal(manager.view('wechat').groups[0].muted, true); assert.equal(manager.view('wechat').collectionState, 'collecting');
  } finally { await manager?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
