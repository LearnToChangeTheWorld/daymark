import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChaoxingClient, CookieJar, PlatformError, allowedUrl, parseCourses, deadlineInfo, platformTime } from '../collector/chaoxing.mjs';
import { createAccounts } from '../collector/accounts.mjs';
import { windowsVault } from '../collector/windows-vault.mjs';

const coursePage = '<a href="/visit/stucoursemiddle?courseid=10&amp;clazzid=20&amp;cpi=30"><span class="course-name" title="大学物理 &amp; 实验"></span></a>';
const homeworkPage = `<ul><li onclick="goTask(this);" data="${encodeURIComponent('https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?workId=100&enc=rotating')}"><p class="overHidden2 fl">实验报告</p><p class="status fl">未提交</p></li><li onclick="goTask(this);" data="https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?workId=101"><p class="overHidden2 fl">已经交了</p><p class="status fl">待批阅</p></li></ul>`;

function fakePlatform({ expire = false, noCourses = false, brokenCourse = false, verification = false, notices = null } = {}) {
  let loggedIn = false; const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input); calls.push({ url, ...options });
    let text;
    if (url.pathname === '/fanyalogin') { loggedIn = true; assert.ok(!options.body.includes('correct-password')); return new Response('{"status":true}', { headers: { 'set-cookie': 'session=yes; Domain=.chaoxing.com; Path=/; Secure; HttpOnly' } }); }
    if (expire && !loggedIn) return new Response('用户登录');
    if (url.pathname === '/base') text = 'var fid = "123";';
    else if (url.pathname.endsWith('courselistdata')) { assert.equal(url.searchParams.get('courseFid'), '123'); text = noCourses ? '<div>暂无课程</div>' : coursePage; }
    else if (url.pathname.endsWith('stucoursemiddle')) text = verification ? '<form action="/html/processVerify.ac"><img src="/processVerifyPng.ac"><input name="ucode"></form>' : '<input value="worksig" name="workEnc"><input id="enc" value="pagesig"><input value="open" id="openc">';
    else if (url.pathname.endsWith('work/list')) { assert.equal(url.searchParams.get('enc'), 'worksig'); assert.equal(url.searchParams.get('stuenc'), 'pagesig'); text = brokenCourse ? '页面已经改版' : homeworkPage; }
    else if (url.pathname.endsWith('work/task')) text = '<h1>作业详情</h1>实验报告 题量: 1 作答时间: 10-01 08:00 至 10-30 23:59';
    else if (url.pathname.endsWith('getNoticeList')) text = JSON.stringify({ status: true, notices: { list: notices || [{ id: 456, title: '课程通知', content: '<p>下周交报告</p>', sendTime: new Date().toISOString() }], lastPage: true } });
    else throw new Error('unexpected request: ' + url.pathname);
    return new Response(text);
  };
  return { fetchImpl, calls };
}

test('Chaoxing reads pending work and notices, keeps unknown years, and uses stable IDs across signed URLs', async () => {
  const platform = fakePlatform(); const client = new ChaoxingClient(platform);
  await client.login('13800000000', 'correct-password'); const events = [];
  const result = await client.collect('account', async (event) => events.push(event));
  assert.equal(result.courses[0].name, '大学物理 & 实验'); assert.deepEqual(result.warnings, []);
  assert.equal(events.length, 2); assert.equal(events[0].externalId, 'account:work:10:20:100');
  assert.equal(events[0].kind, 'task'); assert.equal(events[1].kind, 'notification');
  assert.ok(events[1].publishedAt); assert.deepEqual([result.stats.tasksRead, result.stats.noticesRead, result.stats.coursesRead], [1, 1, 1]);
  assert.equal(events[0].due, null); assert.equal(events[0].confidence, 'low'); assert.match(events[0].body, /10-30 23:59（缺少年份/);
  assert.match(events[1].body, /下周交报告/); assert.ok(!events[1].body.includes('<p>'));
  assert.ok(platform.calls.filter((call) => call.url.pathname !== '/fanyalogin').every((call) => call.headers.cookie === 'session=yes'));
  assert.ok(!platform.calls.some((call) => /submit|answer|markRead/.test(call.url.href)));
  assert.equal(deadlineInfo('作答时间：2026-01-01 08:00 至 2026-02-30 12:00').due, null);
  assert.equal(deadlineInfo('作答时间：2026-01-01 08:00 至 2026-10-30 12:00').due, '2026-10-30');
  assert.equal(parseCourses(coursePage + coursePage).length, 1);
});

test('platform dates keep Chinese timezone and historic notices do not become newly published tasks', async () => {
  assert.equal(platformTime({ sendTime: '2025-09-01 09:00:00', insertTime: Date.now() }), '2025-09-01T01:00:00.000Z');
  assert.equal(platformTime({ insertTime: 1791854986000 }), '2026-10-13T01:29:46.000Z');
  assert.equal(platformTime({ sendTime: '未知' }), null);
  const platform = fakePlatform({ noCourses: true, notices: [{ id: 1, title: '旧积分统计', sendTime: '2020-01-01 12:00:00' }, { id: 2, title: '近期通知', sendTime: new Date().toISOString() }, { id: 3, title: '日期未知' }] });
  const events = []; const result = await new ChaoxingClient(platform).collect('account', async (event) => events.push(event));
  assert.deepEqual(events.map((event) => event.title), ['近期通知', '日期未知']);
  assert.equal(events[0].createdAt, events[0].publishedAt); assert.equal(events[1].timestampKind, 'collected');
  assert.equal(result.stats.skippedOld, 1); assert.equal(result.stats.unknownDates, 1);
});

test('verification stops homework requests, still reads notices, and produces an explicit partial result', async () => {
  const platform = fakePlatform({ verification: true }); const events = [];
  const result = await new ChaoxingClient(platform).collect('account', async (event) => events.push(event));
  assert.equal(result.stats.verificationRequired, true); assert.equal(result.stats.coursesRead, 0); assert.equal(result.stats.tasksRead, 0);
  assert.equal(result.stats.noticesRead, 1); assert.match(result.warnings[0], /验证码/);
  assert.equal(platform.calls.filter((call) => call.url.pathname.endsWith('stucoursemiddle')).length, 1);
  assert.ok(events.every((event) => event.kind === 'notification'));
});

test('after human verification, course requests reuse the browser and return its refreshed cookies to the HTTP session', async () => {
  const platform = fakePlatform({ verification: true }); const client = new ChaoxingClient(platform);
  const first = await client.collect('account', async () => {});
  assert.equal(first.stats.verificationRequired, true); assert.match(client.verificationUrl, /stucoursemiddle/);
  const visited = [];
  client.browser = { alive: true, read: async (url) => {
    visited.push(url);
    return { url, cookies: [{ name: 'verified', value: 'yes', domain: 'chaoxing.com', path: '/', hostOnly: false, secure: true, expires: null }],
      text: url.includes('stucoursemiddle') ? '<input name="workEnc" value="verified-sig">' : url.includes('/work/list') ? homeworkPage : '作答时间：2026-10-01 00:00 至 2026-10-30 23:59' };
  } };
  const events = []; const result = await client.collect('account', async (event) => events.push(event));
  assert.equal(result.stats.verificationRequired, false); assert.equal(result.stats.tasksRead, 1); assert.equal(result.stats.coursesRead, 1);
  assert.equal(events[0].due, '2026-10-30'); assert.equal(visited.length, 3);
  assert.equal(platform.calls.filter((call) => call.url.pathname.endsWith('stucoursemiddle')).length, 1, 'blocked HTTP route is not used again');
  assert.equal(platform.calls.at(-1).headers.cookie, 'verified=yes');
  client.browser.alive = false;
  const closed = await client.collect('account', async () => {});
  assert.equal(closed.stats.verificationRequired, true); assert.match(closed.warnings.join(' '), /窗口已关闭/);
});

test('legacy platform HTTP redirects are upgraded before sending session cookies', async () => {
  const calls = []; const client = new ChaoxingClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'http://i.chaoxing.com/base?safe=1' } }) : new Response('school');
  } });
  assert.equal(await client.request('https://i.chaoxing.com/base'), 'school');
  assert.equal(calls[1].url, 'https://i.chaoxing.com/base?safe=1');
});

test('unrecognized course pages are reported as partial failures rather than empty work lists', async () => {
  const events = []; const client = new ChaoxingClient(fakePlatform({ brokenCourse: true }));
  const result = await client.collect('account', async (event) => events.push(event));
  assert.equal(result.warnings.length, 1); assert.match(result.warnings[0], /不能|无法确认/);
  assert.equal(events.length, 1); assert.equal(events[0].title, '课程通知');
});

test('cookies obey domain, path, expiry and HTTPS boundaries', () => {
  const jar = new CookieJar(); const base = new URL('https://passport2.chaoxing.com/login');
  jar.accept(base, ['host=a; Path=/; Secure', 'shared=b; Domain=.chaoxing.com; Path=/pc', 'bad=c; Domain=example.com', 'dead=d; Max-Age=-1']);
  assert.equal(jar.header(new URL('https://notice.chaoxing.com/pc/list')), 'shared=b');
  assert.equal(jar.header(new URL('https://notice.chaoxing.com/pc-other')), '');
  assert.equal(jar.header(new URL('http://passport2.chaoxing.com/')), '');
  assert.equal(jar.header(new URL('https://evil-chaoxing.com/pc/list')), '');
  const credentialUrl = new URL('https://i.chaoxing.com/');
  credentialUrl.username = 'user'; credentialUrl.password = 'pass';
  for (const url of ['https://evil.com/', 'https://chaoxing.com.evil.com/', 'http://i.chaoxing.com/', credentialUrl.href, 'https://i.chaoxing.com:8443/']) assert.throws(() => allowedUrl(url));
});

test('login denial never becomes a successful connection', async () => {
  const client = new ChaoxingClient({ fetchImpl: async () => new Response('{"status":false,"msg2":"需要验证码"}') });
  await assert.rejects(client.login('13800000000', 'wrong'), (error) => error.code === 'needs_login' && /验证码/.test(error.message));
});

test('a login link on an authenticated course page does not expire the session; reviewed work is excluded', async () => {
  const client = new ChaoxingClient({ fetchImpl: async () => new Response('<title>课程学习</title><a href="https://passport2.chaoxing.com/login">用户登录</a><input name="workEnc" value="ok">') });
  assert.match(await client.request('https://mooc1.chaoxing.com/course'), /workEnc/);
  const platform = fakePlatform(); const fetchOriginal = platform.fetchImpl;
  platform.fetchImpl = async (url, options) => url.includes('/work/list') ? new Response(homeworkPage.replace('待批阅', '已互评')) : fetchOriginal(url, options);
  const events = []; const result = await new ChaoxingClient(platform).collect('account', async (event) => events.push(event));
  assert.equal(result.stats.tasksRead, 1); assert.equal(events.filter((event) => event.kind === 'task').length, 1);
});

test('account manager persists an encrypted session, relogs once, and retries durable outbox after a crash', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'student-inbox-accounts-')); const managers = [];
  const vault = async (mode, value) => mode === 'protect' ? Buffer.from(value).toString('base64') : Buffer.from(value, 'base64').toString('utf8'); // test double only
  let offline = true; let delivered = [];
  const deliver = async (event) => { if (offline) throw new Error('disk offline'); delivered.push(event); };
  const factory = () => new ChaoxingClient(fakePlatform({ expire: true }));
  try {
    const manager = await createAccounts({ dataDir, deliver, vault, clientFactory: factory }); managers.push(manager);
    await manager.sync();
    await manager.connect({ phone: '13800000000', password: 'secret', remember: true }); await manager.sync();
    assert.equal(manager.view().status, 'error'); assert.equal((await readdir(join(dataDir, 'chaoxing-outbox'))).length, 2);
    const saved = await readFile(join(dataDir, 'chaoxing.dpapi'), 'utf8'); assert.ok(!saved.includes('secret'));
    assert.ok(!JSON.stringify(manager.view()).includes('secret')); assert.equal(manager.view().account, '138****0000');
    manager.close(); offline = false;
    const restored = await createAccounts({ dataDir, deliver, vault, clientFactory: factory }); managers.push(restored); await restored.sync();
    assert.equal(restored.view().status, 'connected'); assert.equal((await readdir(join(dataDir, 'chaoxing-outbox'))).length, 0);
    assert.equal(new Set(delivered.map((item) => item.externalId)).size, 2);
    await restored.disconnect(); assert.equal(restored.view().configured, false);
    await assert.rejects(readFile(join(dataDir, 'chaoxing.dpapi')), { code: 'ENOENT' });
  } finally { managers.forEach((m) => m.close()); await rm(dataDir, { recursive: true, force: true }); }
});

test('Windows DPAPI round trip encrypts secret material', { skip: process.platform !== 'win32' }, async () => {
  const source = JSON.stringify({ password: 'test-secret-not-a-real-account', cookies: [] });
  const encrypted = await windowsVault('protect', source);
  assert.ok(!encrypted.includes('test-secret')); assert.notEqual(encrypted, Buffer.from(source).toString('base64'));
  assert.equal(await windowsVault('unprotect', encrypted), source);
});
