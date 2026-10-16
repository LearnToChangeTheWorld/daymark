import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';

const serverFile = fileURLToPath(new URL('../server.mjs', import.meta.url));

async function startServer(dataDir, mode = 'local') {
  const child = spawn(process.execPath, [serverFile], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', STUDENT_INBOX_MODE: mode, STUDENT_INBOX_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 8000;
  while (!output.includes('Access code:')) {
    if (child.exitCode !== null) throw new Error(output);
    if (Date.now() > deadline) { child.kill(); throw new Error('Server startup timed out: ' + output); }
    await delay(25);
  }
  const port = Number(output.match(/127\.0\.0\.1:(\d+)/)?.[1]);
  const accessCode = output.match(/Access code: ([\w-]+)/)?.[1];
  const collectorKey = (await readFile(join(dataDir, 'collector.key'), 'utf8')).trim();
  return { child, base: `http://127.0.0.1:${port}`, accessCode, collectorKey, output: () => output };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), delay(3000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

test('bulk archive is authenticated, atomic, reversible and preserves item content across retries and restarts', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'student-inbox-bulk-archive-')); let server;
  const seed = (id, title, extra = {}) => ({ id, source: 'qq', sourceName: '测试课程群', kind: 'notification', category: 'academic', title, body: title, createdAt: '2026-10-08T10:00:00Z', publishedAt: '2026-10-08T10:00:00Z', read: false, done: false, archived: false, ...extra });
  try {
    await writeFile(join(dataDir, 'inbox.json'), JSON.stringify({ items: [
      seed('abc', '请有意向的同学提交申请材料', { externalId: 'qq:bulk:1' }),
      seed('def', '保留作业原文', { source: 'manual', kind: 'task', due: '2026-10-20', read: true }),
      seed('fed', '未选择的已完成事项', { source: 'manual', kind: 'task', done: true })
    ] }));
    server = await startServer(dataDir);
    const path = '/api/items/archive';
    assert.equal((await fetch(server.base + path, { method: 'POST', body: JSON.stringify({ ids: ['abc'], archived: true }) })).status, 401);
    const login = await fetch(server.base + '/api/pair', { method: 'POST', body: JSON.stringify({ code: server.accessCode }) });
    const cookie = login.headers.get('set-cookie').split(';')[0], headers = { cookie, 'content-type': 'application/json' };
    const state = () => fetch(server.base + '/api/state', { headers }).then(r => r.json());
    const bulk = input => fetch(server.base + path, { method: 'POST', headers, body: JSON.stringify(input) });
    const before = (await state()).items;
    for (const input of [{ ids: [], archived: true }, { ids: ['abc'] }, { ids: ['abc'], archived: 'true' }, { ids: [null], archived: true }, { ids: ['../abc'], archived: true }]) assert.equal((await bulk(input)).status, 400);
    assert.equal((await fetch(server.base + path, { method: 'POST', headers: { ...headers, origin: 'http://other.test' }, body: JSON.stringify({ ids: ['abc'], archived: true }) })).status, 403);
    assert.equal((await bulk({ ids: ['abc', 'bad'], archived: true })).status, 404);
    assert.deepEqual((await state()).items, before, 'invalid or stale selection cannot partially archive');
    const responses = await Promise.all([
      bulk({ ids: ['abc', 'def', 'abc'], archived: true }),
      fetch(server.base + '/api/items/fed', { method: 'PATCH', headers, body: JSON.stringify({ read: true }) })
    ]);
    assert.ok(responses.every(r => r.status === 200));
    assert.deepEqual(await responses[0].json(), { ok: true, ids: ['abc', 'def'], count: 2, archived: true });
    let after = (await state()).items;
    for (const id of ['abc', 'def']) assert.deepEqual(after.find(i => i.id === id), { ...before.find(i => i.id === id), archived: true });
    assert.deepEqual(after.find(i => i.id === 'fed'), { ...before.find(i => i.id === 'fed'), read: true });
    await stopServer(server.child); server = await startServer(dataDir);
    after = (await state()).items;
    assert.equal(after.find(i => i.id === 'abc').archived, true);
    assert.equal(after.find(i => i.id === 'def').archived, true);
    const event = { source: 'qq', sourceName: '测试课程群', externalId: 'qq:bulk:1', title: '请有意向的同学提交申请材料', body: '请有意向的同学提交申请材料', createdAt: '2026-10-08T10:00:00Z' };
    assert.equal((await fetch(server.base + '/api/collector/events', { method: 'POST', headers: { authorization: `Bearer ${server.collectorKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ events: [event] }) })).status, 200);
    assert.equal((await state()).items.find(i => i.id === 'abc').archived, true, 'a repeated message cannot undo archive');
    assert.equal((await bulk({ ids: ['abc', 'bad'], archived: false })).status, 404);
    assert.equal((await state()).items.find(i => i.id === 'abc').archived, true, 'restoring is atomic too');
    assert.equal((await bulk({ ids: ['abc', 'def'], archived: false })).status, 200);
    await stopServer(server.child); server = await startServer(dataDir);
    after = (await state()).items;
    for (const id of ['abc', 'def']) assert.equal(after.find(i => i.id === id).archived, false);
    assert.equal(after.find(i => i.id === 'def').read, true);
    assert.equal(after.find(i => i.id === 'fed').done, true);
  } finally { if (server) await stopServer(server.child); await rm(dataDir, { recursive: true, force: true }); }
});

test('local server rejects remote Hosts for pages and APIs while retaining local access', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'student-inbox-local-access-')); let server;
  try {
    server = await startServer(dataDir, '');
    assert.equal((await fetch(server.base + '/')).status, 200);
    assert.equal((await fetch(server.base + '/api/health')).status, 200);
    const login = await fetch(server.base + '/api/pair', { method: 'POST', body: JSON.stringify({ code: server.accessCode }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const state = await fetch(server.base + '/api/state', { headers: { cookie } }).then(r => r.json());
    assert.equal(state.mode, 'local'); assert.equal(state.localAccountsEnabled, true);
    for (const path of ['/', '/api/health', '/api/state', '/api/collector/events', '/api/pair']) {
      const status = await new Promise((resolve, reject) => {
        const req = request(server.base + path, { headers: { host: 'remote.example', cookie, authorization: `Bearer ${server.collectorKey}` } }, res => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject); req.end();
      });
      assert.equal(status, 403, path + ' must reject a nonlocal Host');
    }
  } finally { if (server) await stopServer(server.child); await rm(dataDir, { recursive: true, force: true }); }
});

test('unsafe local bind configuration stops before creating data or starting collectors', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'student-inbox-bind-'));
  let child;
  try {
    child = spawn(process.execPath, [serverFile], { env: { ...process.env, STUDENT_INBOX_MODE: 'local', HOST: '0.0.0.0', PORT: '0', STUDENT_INBOX_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    await Promise.race([once(child, 'close'), delay(5000).then(() => { if (child.exitCode === null) throw new Error('Invalid configuration did not stop startup'); })]);
    assert.notEqual(child.exitCode, 0); assert.match(output, /本地模式仅允许回环地址/);
    assert.ok(!output.includes('Student Inbox running at'));
    assert.deepEqual(await readdir(dataDir), []);
  } finally { if (child) await stopServer(child); await rm(dataDir, { recursive: true, force: true }); }
});

test('browser login and collector sync are isolated, deduplicated and persisted', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'student-inbox-server-'));
  let server;
  try {
    server = await startServer(dataDir);
    assert.equal((await fetch(server.base + '/api/state')).status, 401);
    const login = await fetch(server.base + '/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: server.accessCode }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const event = { source: 'qq', sourceName: 'QQ群 42', externalId: '7:42:9', title: '提交实验报告', body: '周五前提交', createdAt: '2026-10-15T10:00:00.000Z', category: 'academic', confidence: 'high' };
    const sendEvent = () => fetch(server.base + '/api/collector/events', { method: 'POST', headers: { authorization: `Bearer ${server.collectorKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ events: [event] }) });
    assert.equal((await sendEvent()).status, 200);
    const markDone = await fetch(server.base + '/api/state', { headers: { cookie } }).then((response) => response.json());
    assert.equal(markDone.items.length, 1);
    await fetch(server.base + `/api/items/${markDone.items[0].id}`, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ done: true, read: true }) });
    event.title = '重试不应覆盖用户修改';
    assert.equal((await sendEvent()).status, 200);
    const state = await fetch(server.base + '/api/state', { headers: { cookie } }).then((response) => response.json());
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].done, true);
    assert.equal(state.items[0].title, '提交实验报告');
    // A corrected platform publication time must not overwrite a user's edits.
    event.publishedAt = '2025-09-01T01:00:00.000Z';
    await sendEvent();
    const withDate = await fetch(server.base + '/api/state', { headers: { cookie } }).then((r) => r.json());
    assert.equal(withDate.items[0].createdAt, event.publishedAt);
    assert.equal(withDate.items[0].done, true); assert.equal(withDate.items[0].title, '提交实验报告');
    assert.equal((await fetch(server.base + '/api/collector/events', { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{"events":[]}' })).status, 401);
    const heartbeat = await fetch(server.base + '/api/collector/heartbeat', { method: 'POST', headers: { authorization: `Bearer ${server.collectorKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'test collector', sources: { qq: { status: 'connected', lastSync: event.createdAt } } }) });
    assert.equal(heartbeat.status, 200);
    const withStatus = await fetch(server.base + '/api/state', { headers: { cookie } }).then((response) => response.json());
    assert.equal(withStatus.collector.online, true);
    assert.equal(withStatus.sources.qq.status, 'connected');
    assert.equal(withStatus.sources.chaoxing, undefined);
    const invalid = await fetch(server.base + '/api/items', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: '错误日期', due: '2026-02-30' }) });
    assert.equal(invalid.status, 400);
    const manual = await fetch(server.base + '/api/items', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: '通知转成我的待办', source: 'chaoxing' }) }).then((r) => r.json());
    assert.equal(manual.kind, 'task');
    await fetch(server.base + `/api/items/${manual.id}`, { method: 'DELETE', headers: { cookie } });
    assert.equal((await fetch(server.base + '/api/state', { headers: { authorization: `Bearer ${server.collectorKey}` } })).status, 401);
    assert.equal((await fetch(server.base + '/api/collector/events', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"events":[]}' })).status, 401);
    assert.equal((await fetch(server.base + '/api/items', { method: 'POST', headers: { cookie, origin: 'http://attacker.test', 'content-type': 'application/json' }, body: '{"title":"bad"}' })).status, 403);
    // Persist concurrent collector uploads without losing any completed user changes.
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => fetch(server.base + '/api/collector/events', { method: 'POST', headers: { authorization: `Bearer ${server.collectorKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ events: [{ ...event, externalId: 'parallel-' + index }] }) })));
    assert.ok(responses.every((response) => response.status === 200));
    await stopServer(server.child);
    const saved = JSON.parse(await readFile(join(dataDir, 'inbox.json'), 'utf8'));
    assert.equal(saved.items.length, 9);
    saved.collector.lastSeen = '2020-01-01T00:00:00.000Z';
    saved.sources.qq.lastSeen = '2020-01-01T00:00:00.000Z';
    await writeFile(join(dataDir, 'inbox.json'), JSON.stringify(saved));
    server = await startServer(dataDir);
    const restored = await fetch(server.base + '/api/state', { headers: { cookie } }).then((response) => response.json());
    assert.equal(restored.items.length, 9);
    assert.equal(restored.items.find((item) => item.externalId === '7:42:9').done, true);
    assert.equal(restored.collector.online, false);
    assert.equal(restored.sources.qq.status, 'offline');
  } catch (error) {
    if (server) error.message += '\nChild output:\n' + server.output();
    throw error;
  } finally {
    if (server) await stopServer(server.child);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('uncertain chat candidates need review and a dismissed duplicate stays dismissed across retries and restarts', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'student-inbox-triage-api-')); let server;
  try {
    server = await startServer(dataDir);
    const login = await fetch(server.base + '/api/pair', { method: 'POST', body: JSON.stringify({ code: server.accessCode }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { cookie, 'content-type': 'application/json' };
    const events = [1, 2].map((id) => ({ source: 'qq', sourceName: '班级群', externalId: '42:' + id, title: '请有意向的同学周五前提交申请材料', body: '请有意向的同学周五前提交申请材料', createdAt: '2026-10-15T10:00:00Z' }));
    const send = () => fetch(server.base + '/api/collector/events', { method: 'POST', headers: { authorization: `Bearer ${server.collectorKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ events }) });
    const state = () => fetch(server.base + '/api/state', { headers }).then((r) => r.json());
    assert.equal((await send()).status, 200);
    let items = (await state()).items;
    assert.equal(items.length, 2); assert.ok(items.every((item) => item.kind === 'notification' && item.due === null));
    const first = items.find((item) => item.triage.relatedIds?.length);
    assert.equal(first.triage.kind, 'candidate');
    assert.equal((await fetch(server.base + '/api/items/' + first.id, { method: 'PATCH', headers, body: JSON.stringify({ triageDecision: 'invalid', done: true }) })).status, 400);
    assert.equal((await state()).items.find((item) => item.id === first.id).done, false);
    await fetch(server.base + '/api/items/' + first.id, { method: 'PATCH', headers, body: JSON.stringify({ triageDecision: 'dismissed', read: true }) });
    assert.equal((await send()).status, 200);
    items = (await state()).items;
    assert.equal(items.filter((item) => item.triage.kind === 'candidate' && !item.triage.duplicateOf).length, 0);
    await stopServer(server.child); server = await startServer(dataDir);
    items = (await state()).items;
    assert.equal(items.find((item) => item.id === first.id).triageDecision, 'dismissed');
    assert.equal(items.filter((item) => item.triage.kind === 'candidate' && !item.triage.duplicateOf).length, 0);
    await fetch(server.base + '/api/items/' + first.id, { method: 'PATCH', headers, body: JSON.stringify({ kind: 'task', confirmed: true }) });
    const work = (await state()).items.find((item) => item.id === first.id);
    assert.equal(work.kind, 'task'); assert.equal(work.due, null); assert.equal(work.body, events[0].body);
    assert.equal((await send()).status, 200);
    assert.equal((await state()).items.filter((item) => item.kind === 'task').length, 1);
  } finally { if (server) await stopServer(server.child); await rm(dataDir, { recursive: true, force: true }); }
});

test('review filtering applies to existing and new vague reminders without deleting originals or user tasks', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'student-inbox-review-filter-')); let server;
  const old = { id: 'aaa', source: 'wechat', sourceName: '班级群', externalId: 'old-reminder', title: '@王浩然 @林兆瑞 记得打卡', body: '@王浩然 @林兆瑞 记得打卡', kind: 'notification', category: 'academic', due: null, createdAt: '2026-10-15T10:00:00Z', read: true, done: false, archived: false, triage: { kind: 'candidate' } };
  const confirmed = { ...old, id: 'bbb', externalId: 'my-task', kind: 'task' };
  try {
    await writeFile(join(dataDir, 'inbox.json'), JSON.stringify({ items: [old, confirmed] }));
    server = await startServer(dataDir);
    const login = await fetch(server.base + '/api/pair', { method: 'POST', body: JSON.stringify({ code: server.accessCode }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const state = () => fetch(server.base + '/api/state', { headers: { cookie } }).then(r => r.json());
    const events = [
      { ...old, id: undefined, externalId: 'new-reminder', title: '@陆凯敬 记得打卡', body: '@陆凯敬 记得打卡' },
      { ...old, id: undefined, externalId: 'real-work', title: '请大家周五前提交实验报告', body: '请大家周五前提交实验报告' },
      { ...old, id: undefined, externalId: 'conditional-work', title: '请补做实验的同学完成课本第3章习题', body: '请补做实验的同学完成课本第3章习题' }
    ];
    assert.equal((await fetch(server.base + '/api/collector/events', { method: 'POST', headers: { authorization: `Bearer ${server.collectorKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ events }) })).status, 200);
    let items = (await state()).items;
    assert.equal(items.length, 5);
    assert.equal(items.find(i => i.id === 'aaa').triage.kind, 'conversation');
    assert.equal(items.find(i => i.externalId === 'new-reminder').triage.rule, 'insufficient_context');
    assert.equal(items.find(i => i.id === 'aaa').read, true);
    assert.equal(items.find(i => i.id === 'aaa').body, old.body);
    assert.equal(items.find(i => i.id === 'bbb').kind, 'task');
    assert.equal(items.find(i => i.externalId === 'real-work').kind, 'task');
    assert.equal(items.find(i => i.externalId === 'conditional-work').triage.kind, 'candidate');
    await stopServer(server.child); server = await startServer(dataDir);
    items = (await state()).items;
    assert.equal(items.length, 5);
    assert.equal(items.filter(i => i.triage?.kind === 'candidate').length, 1);
    assert.equal(items.find(i => i.id === 'bbb').kind, 'task');
  } finally { if (server) await stopServer(server.child); await rm(dataDir, { recursive: true, force: true }); }
});

test('automatic chat tasks migrate the review backlog, deduplicate, persist and allow lasting correction', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'student-inbox-autotask-api-')); let server;
  const old = { source: 'wechat', sourceName: '大学物理课程群', externalId: 'wechat:old', id: 'aaa', kind: 'notification', category: 'academic', title: '本周作业：课本第3章1—5题', body: '本周作业：课本第3章1—5题', createdAt: '2026-10-09T10:00:00Z', due: null, read: true, done: false, archived: false };
  try {
    await writeFile(join(dataDir, 'inbox.json'), JSON.stringify({ items: [old] }));
    server = await startServer(dataDir);
    const login = await fetch(server.base + '/api/pair', { method: 'POST', body: JSON.stringify({ code: server.accessCode }) });
    const cookie = login.headers.get('set-cookie').split(';')[0], headers = { cookie, 'content-type': 'application/json' };
    const state = () => fetch(server.base + '/api/state', { headers }).then((r) => r.json());
    const send = (events) => fetch(server.base + '/api/collector/events', { method: 'POST', headers: { authorization: `Bearer ${server.collectorKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ events }) });
    const patch = (id, data) => fetch(server.base + '/api/items/' + id, { method: 'PATCH', headers, body: JSON.stringify(data) });
    let migrated = (await state()).items.find((i) => i.id === 'aaa');
    assert.equal(migrated.kind, 'task'); assert.ok(migrated.autoTask.reason);
    assert.equal(migrated.due, null); assert.equal(migrated.read, true); assert.equal(migrated.body, old.body);
    const event = { source: 'qq', sourceName: '班级群', externalId: 'qq:auto:1', title: '请大家周五前提交实验报告', body: '请大家周五前提交实验报告', createdAt: '2026-10-15T10:00:00Z' };
    assert.equal((await send([event, { ...event, externalId: 'qq:auto:2' }])).status, 200);
    let rows = (await state()).items.filter((i) => i.source === 'qq');
    assert.equal(rows.filter((i) => i.kind === 'task').length, 1);
    const task = rows.find((i) => i.kind === 'task');
    assert.equal(task.triage.relatedIds.length, 1);
    await patch(task.id, { done: true });
    await send([{ ...event, externalId: 'qq:auto:3' }]);
    assert.equal((await state()).items.filter((i) => i.source === 'qq' && i.kind === 'task').length, 1);
    assert.equal((await patch('aaa', { triageDecision: 'dismissed' })).status, 200);
    migrated = (await state()).items.find((i) => i.id === 'aaa');
    assert.equal(migrated.kind, 'notification'); assert.equal(migrated.autoTask, undefined);
    await stopServer(server.child); server = await startServer(dataDir);
    await send([{ ...old, id: undefined, externalId: 'wechat:repeat' }]);
    const restored = (await state()).items;
    assert.equal(restored.find((i) => i.id === 'aaa').kind, 'notification');
    assert.equal(restored.filter((i) => i.source === 'wechat' && i.kind === 'task').length, 0);
    assert.equal(restored.find((i) => i.id === task.id).done, true);
  } finally { if (server) await stopServer(server.child); await rm(dataDir, { recursive: true, force: true }); }
});

test('account management requires a browser session and a loopback host; cloud mode never accepts credentials', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'student-inbox-account-api-')); let server;
  try {
    server = await startServer(dataDir);
    assert.equal((await fetch(server.base + '/api/accounts/chaoxing')).status, 401);
    const login = await fetch(server.base + '/api/pair', { method: 'POST', body: JSON.stringify({ code: server.accessCode }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const info = await fetch(server.base + '/api/accounts/chaoxing', { headers: { cookie } }).then((r) => r.json());
    for (const source of ['qq', 'wechat']) {
      assert.equal((await fetch(server.base + `/api/accounts/${source}/qr.png`)).status, 401);
      const chat = await fetch(server.base + `/api/accounts/${source}`, { headers: { cookie } }).then((r) => r.json());
      assert.equal(chat.loginState, 'disconnected');
      assert.equal((await fetch(server.base + `/api/accounts/${source}/groups`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: '{"groups":[],"remember":true}' })).status, 422);
      assert.equal((await fetch(server.base + `/api/accounts/${source}/check`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 422);
      assert.equal((await fetch(server.base + `/api/accounts/${source}/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
      assert.equal((await fetch(server.base + `/api/accounts/${source}/history`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 422);
      const forged = await new Promise((resolve, reject) => { const req = request(server.base + `/api/accounts/${source}/qr.png`, { headers: { cookie, host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
      assert.equal(forged, 403);
    }
    assert.equal(info.configured, false); assert.ok(!('password' in info)); assert.ok(!('cookies' in info));
    assert.equal((await fetch(server.base + '/api/accounts/chaoxing', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"phone":"invalid","password":"test"}' })).status, 400);
    assert.equal((await fetch(server.base + '/api/accounts/chaoxing', { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await fetch(server.base + '/api/accounts/chaoxing/verification', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 409);
    // Undici owns the Host header; use http.request to test a real forged Host.
    const forgedHostStatus = await new Promise((resolve, reject) => {
      const req = request(server.base + '/api/accounts/chaoxing', { headers: { cookie, host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(forgedHostStatus, 403);
    await stopServer(server.child); server = await startServer(dataDir, 'cloud');
    const headers = { cookie, 'x-forwarded-proto': 'https', 'content-type': 'application/json' };
    for (const source of ['qq', 'wechat']) for (const action of ['qr', 'check', 'history', 'acknowledge']) assert.equal((await fetch(server.base + `/api/accounts/${source}/${action}`, { method: 'POST', headers, body: '{}' })).status, 403);
    assert.equal((await fetch(server.base + '/api/accounts/chaoxing', { method: 'POST', headers, body: '{}' })).status, 403);
    assert.equal((await fetch(server.base + '/api/accounts/chaoxing/verification', { method: 'POST', headers, body: '{}' })).status, 403);
    const state = await fetch(server.base + '/api/state', { headers }).then((r) => r.json());
    assert.equal(state.localAccountsEnabled, false); assert.equal(state.mode, 'cloud');
    assert.equal((await fetch(server.base + '/api/state', { headers: { cookie } })).status, 426);
    // Preserve the future website's authenticated upload and browser-read contract.
    const event = { source: 'rainclass', externalId: 'future-website:1', title: '同步接口兼容检查', body: '测试接口，不代表已实现雨课堂采集器', createdAt: '2026-10-16T00:00:00Z' };
    const uploadHeaders = { 'x-forwarded-proto': 'https', authorization: `Bearer ${server.collectorKey}`, 'content-type': 'application/json' };
    const uploaded = await fetch(server.base + '/api/collector/events', { method: 'POST', headers: uploadHeaders, body: JSON.stringify({ events: [event] }) });
    assert.equal(uploaded.status, 200);
    assert.deepEqual((await uploaded.json()).accepted, [event.externalId]);
    assert.equal((await fetch(server.base + '/api/collector/heartbeat', { method: 'POST', headers: uploadHeaders, body: JSON.stringify({ name: 'future Windows collector', sources: {} }) })).status, 200);
    const synced = await fetch(server.base + '/api/state', { headers }).then(r => r.json());
    assert.equal(synced.items.find(item => item.externalId === event.externalId).title, event.title);
    assert.equal(synced.collector.online, true);
  } finally { if (server) await stopServer(server.child); await rm(dataDir, { recursive: true, force: true }); }
});
