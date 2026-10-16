import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { readAccessCode } from './ui-test-support.mjs';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BROWSER_CHECK_URL || 'http://127.0.0.1:4317';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' });
const page = await context.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const code = await readAccessCode();
await mkdir('artifacts', { recursive: true });
const now = new Date().toISOString(), today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const entry = (id, fields) => ({ id, kind: 'notification', category: 'academic', relevance: 'learning', createdAt: now, publishedAt: now, source: 'qq', sourceName: 'QQ · 班级群', ...fields });
let items = [
  entry('old-work', { kind: 'task', title: '一周前布置的实验报告', body: '报告原文', due: today, read: true, publishedAt: '2025-01-01T00:00:00Z' }),
  entry('unknown-date', { kind: 'task', title: '确认报名材料', due: null }),
  entry('candidate', { title: '请提交本周作业', body: '请提交本周作业，截止日期以课程页面为准。', triage: { kind: 'candidate', reason: '文字含行动要求' } }),
  entry('social', { title: '晚上一起打游戏', relevance: 'other', category: 'life', triage: { kind: 'conversation' } }),
  entry('notice', { source: 'chaoxing', title: '明天考试更换教室', body: '原文详情 '.repeat(1200), topic: '考试考务' }),
  entry('archived', { title: '旧记录已归档', archived: true, publishedAt: '2020-01-01T00:00:00Z' })
];
let info = { source: 'qq', enabled: true, remembered: true, loginState: 'authenticated', collectionState: 'collecting', status: 'connected', account: '测试账号', groups: [{ id: '1', name: '课程群' }], selection: { mode: 'auto', included: 1, unknown: 1, pending: 0, lastScan: now, groups: [{ id: '1', name: '课程群', relevance: 'learning', included: true, decision: 'auto', reason: '群名包含课程' }, { id: '2', name: '424', relevance: 'unknown', included: false, decision: 'auto', reason: '现有消息不足以判断' }] } };
let corrections = 0, qrCalls = 0;
try {
  assert.equal((await context.request.post(base + '/api/pair', { data: { code } })).status(), 200);
  await page.route('**/api/state', (r) => r.fulfill({ json: { items, sources: { qq: info }, localAccountsEnabled: true, localCollection: true, mode: 'local' } }));
  await page.route('**/api/items/*', (r) => { const item = items.find((i) => i.id === r.request().url().split('/').at(-1)); Object.assign(item, r.request().postDataJSON()); return r.fulfill({ json: item }); });
  await page.route('**/api/accounts/qq', (r) => r.fulfill({ json: info }));
  await page.route('**/api/accounts/qq/qr', (r) => { qrCalls++; return r.fulfill({ json: info }); });
  await page.route('**/api/accounts/qq/selection', (r) => { corrections++; const input = r.request().postDataJSON(); if (input.id) { const g = info.selection.groups.find((g) => g.id === input.id); g.decision = input.decision; g.included = input.decision === 'include'; } if (input.remember !== undefined) info.remembered = input.remember; return r.fulfill({ json: info }); });
  await page.goto(base);
  await page.locator('#itemList [data-item="old-work"]').waitFor();
  assert.deepEqual(await page.locator('.main-nav .nav-item>span').allTextContents(), ['待办', '待确认', '通知', '记录']);
  assert.equal(await page.locator('#itemList [data-item=social]').count(), 0);
  await page.locator('.main-nav [data-view=tasks]').click();
  await page.locator('#itemList [data-item=unknown-date]').waitFor();
  assert.match(await page.locator('#itemList').textContent(), /日期待确认/);
  await page.locator('.main-nav [data-view=review]').click();
  assert.equal(await page.locator('#itemList .item-row').count(), 1);
  await page.locator('#itemList [data-action=details]').click();
  assert.equal(await page.locator('#detailDialog').evaluate((el) => el.open), true);
  await page.locator('#detailDialog [data-action=make-task]').click();
  await page.locator('#itemForm [name=due]').fill(today);
  await page.locator('#itemForm [type=submit]').click();
  await page.locator('#itemDialog').waitFor({ state: 'hidden' });
  assert.equal(items.find((i) => i.id === 'candidate').kind, 'task');
  await page.locator('.main-nav [data-view=notices]').click();
  assert.equal(await page.locator('#itemList .item-row').count(), 1);
  assert.ok((await page.locator('#itemList .notice-body').textContent()).length > 1000, 'full notice is visible without opening details');
  assert.equal(await page.locator('#itemList .notice-body').evaluate((el) => el.scrollHeight <= el.clientHeight + 1), true, 'notice text has no internal clipping');
  await page.locator('#itemList [data-action=details]').click();
  assert.ok((await page.locator('.detail-body').textContent()).length > 1000);
  await page.locator('#detailDialog [data-close]').click();
  await page.locator('#topicFilter').selectOption('课程安排'); assert.equal(await page.locator('#itemList .item-row').count(), 0);
  const detailedNotices = [
    entry('learning-notice', { source: 'chaoxing', title: '您有一个学习任务,请及时查看', body: '课程名称：人工智能基础及应用（通识课A）,任务名称：第三章 课前预习' }),
    entry('exam-notice', { source: 'chaoxing', title: '考试通知', body: '课程名称：人工智能基础及应用（通识课A） 考试名称：第3.2章 强化学习 考试时间：10-09 00:00 至 10-11 23:59 考试时长：60分钟 考试形式：自主考试' }),
    entry('missing-notice', { source: 'chaoxing', title: '教师通知', body: '本条时间为首次采集时间。' }),
    entry('quoted-notice', { source: 'chaoxing', title: '安全显示正文', body: '<img src=x onerror="alert(1)">正文末尾' })
  ];
  items.push(...detailedNotices);
  await page.reload(); await page.locator('.main-nav [data-view=notices]').click();
  await page.locator('#topicFilter').selectOption('all');
  await page.locator('[data-item=learning-notice] .notice-title').filter({ hasText: '第三章 课前预习' }).waitFor();
  const exam = page.locator('[data-item=exam-notice]');
  assert.match(await exam.locator('.notice-title').textContent(), /第3.2章 强化学习/);
  assert.match(await exam.locator('.notice-body').textContent(), /考试时间：10-09 00:00 至 10-11 23:59\n考试时长：60分钟/);
  assert.match(await page.locator('[data-item=missing-notice] .notice-body').textContent(), /尚未读取到通知正文/);
  assert.equal(await page.locator('[data-item=quoted-notice] img').count(), 0, 'source text is escaped');
  assert.match(await page.locator('[data-item=quoted-notice] .notice-body').textContent(), /<img/);
  await exam.locator('[data-action=read]').click();
  await exam.locator('[data-action=read]').waitFor({ state: 'detached' });
  assert.equal(items.find(i => i.id === 'exam-notice').read, true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'full notice fits mobile');
  for (const body of await page.locator('.notice-body').all()) assert.equal(await body.evaluate(el => el.scrollHeight <= el.clientHeight + 1), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  items = items.filter(i => !detailedNotices.some(n => n.id === i.id));
  await page.locator('.main-nav [data-view=records]').click();
  await page.locator('[data-filter=other]').click(); assert.equal(await page.locator('#itemList .item-row').count(), 1);
  await page.locator('[data-filter=archived]').click(); await page.locator('[data-item=archived]').waitFor();
  await page.locator('[data-connect-chat=qq]').first().click();
  await page.locator('#chatSelectionSummary').filter({ hasText: '已自动接入 1 个群' }).waitFor();
  assert.equal(await page.locator('#chatGroupList input[type=checkbox]').count(), 0);
  assert.equal(qrCalls, 0, 'opening source management never starts login');
  await page.locator('#chatSelectionDetails summary').click();
  await page.locator('[data-group-decision="2"]').selectOption('include');
  await page.getByText('识别纠正已保存，采集范围已更新。', { exact: true }).waitFor();
  assert.equal(corrections, 1);
  await page.locator('#chatRemember').uncheck(); await page.locator('#chatSaveGroups').click();
  await page.getByText('连接设置已保存。', { exact: true }).waitFor(); assert.equal(info.remembered, false);
  await page.locator('#chatDialog [data-close]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const view of ['tasks', 'review', 'notices', 'records']) {
    await page.locator(`.main-nav [data-view=${view}]`).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, view + ' must fit mobile');
  }
  assert.equal(await page.locator('.main-nav .nav-item').evaluateAll((els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().top))).size), 1, 'four mobile navigation buttons must fit one row');
  assert.deepEqual(errors, []);
  console.log('Workspace UI passed: four views, merged tasks, source-date groups, old tasks, expanded notice bodies, meaningful task/exam titles and field formatting, missing body, escaped text, read action, topics, record filters, automatic groups, mobile.');
  await page.unrouteAll();
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(base);
  await page.locator('#pageTitle').filter({ hasText: '待办' }).waitFor();
  await page.screenshot({ path: 'artifacts/workspace-desktop.png', fullPage: true });
  await page.locator('.main-nav [data-view=review]').click();
  await page.screenshot({ path: 'artifacts/workspace-review.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/workspace-mobile.png', fullPage: true });
} finally { await browser.close(); }
