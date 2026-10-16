import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { readAccessCode } from './ui-test-support.mjs';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BROWSER_CHECK_URL || 'http://127.0.0.1:4317';
const code = await readAccessCode();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(); const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await mkdir('artifacts', { recursive: true });
const now = new Date().toISOString();
const items = [
  { id: 'a1', source: 'chaoxing', kind: 'notification', title: '近期课程通知', body: '统计表演示内容 '.repeat(600), category: 'academic', publishedAt: now, createdAt: now, timestampKind: 'published' },
  { id: 'a2', source: 'chaoxing', kind: 'notification', title: '十年前的历史通知', body: '旧记录', category: 'academic', publishedAt: '2016-01-01T00:00:00Z', createdAt: '2016-01-01T00:00:00Z' },
  { id: 'a3', source: 'chaoxing', kind: 'notification', title: '旧版导入时间未知', body: '采集时间不可充当发布时间', category: 'academic', timestampKind: 'collected', createdAt: now },
  { id: 'a4', source: 'manual', kind: 'task', title: '没有截止日期的待办', body: '', category: 'life', createdAt: now, due: null }
];
let operation = { id: null, status: 'idle', stats: null, message: '尚未同步' }; let configured = false; let rejectLogin = true; let sequence = 0; let nextStatus = 'running'; let verificationWindowOpen = false; let rejectVerification = true;
const result = (status) => ({ id: 'operation-' + (++sequence), status, startedAt: now, finishedAt: status === 'running' ? null : now,
  message: status === 'succeeded' ? '2 项未交作业，3 条近期通知；已读取 10/10 门课程的作业' : status === 'failed' ? '无法连接学习通，请检查网络' : status === 'verification_required' ? '通知读取 3 条；作业被安全验证码阻止，已读取 0/10 门课程' : '正在读取课程、作业和近 7 天通知…',
  stats: status === 'running' || status === 'failed' ? null : { tasksRead: status === 'succeeded' ? 2 : 0, noticesRead: 3, noticesDays: 7, coursesRead: status === 'succeeded' ? 10 : 0, coursesTotal: 10, skippedOld: 97 } });
const account = () => ({ configured, verificationAvailable: operation.status === 'verification_required', verificationWindowOpen, loginState: configured ? 'authenticated' : 'disconnected', busy: operation.status === 'running', account: configured ? '138****0000' : '', remembered: true, canRemember: true, operation, courses: configured ? Array.from({ length: 10 }, (_, i) => ({ name: '演示课程 ' + (i + 1) })) : [], warnings: operation.status === 'verification_required' ? ['学习通要求安全验证码，作业读取已暂停'] : [] });
await page.route('**/api/state', (route) => route.fulfill({ json: { items, sources: { chaoxing: { status: 'partial', message: operation.message, busy: operation.status === 'running', operationId: operation.id } }, collector: null, localCollection: configured, localAccountsEnabled: true, mode: 'local', updatedAt: now } }));
await page.route('**/api/accounts/chaoxing', async (route) => {
  if (route.request().method() === 'POST') {
    if (rejectLogin) return route.fulfill({ status: 422, json: { error: '需要验证码（界面测试）' } });
    configured = true; operation = result('running');
  }
  return route.fulfill({ json: account() });
});
await page.route('**/api/accounts/chaoxing/sync', (route) => { operation = result(nextStatus); return route.fulfill({ status: 202, json: account() }); });
await page.route('**/api/accounts/chaoxing/verification', (route) => {
  if (rejectVerification) return route.fulfill({ status: 422, json: { error: 'Edge 窗口启动失败（界面测试）' } });
  verificationWindowOpen = true; return route.fulfill({ json: { ...account(), verificationMessage: '请在 Edge 完成验证码，然后回到软件继续同步。' } });
});
try {
  // Account/state responses are mocked below; pair the real browser session first.
  const pairing = await context.request.post(base + '/api/pair', { data: { code } }); assert.equal(pairing.status(), 200);
  await page.goto(base); await page.locator('.main-nav [data-view=notices]').click();
  await page.getByText('近期课程通知', { exact: true }).waitFor();
  assert.equal(await page.getByText('十年前的历史通知', { exact: true }).count(), 0);
  assert.equal(await page.getByText('旧版导入时间未知', { exact: true }).count(), 0);
  assert.equal(await page.locator('#metricPending').textContent(), '1');
  const row = page.locator('[data-item=a1]');
  assert.equal(await row.locator('.notice-body').textContent(), items[0].body.trim(), 'full notice is directly readable');
  assert.equal(await row.locator('.notice-body').evaluate((el) => el.scrollHeight <= el.clientHeight + 1), true, 'notice is not clipped');
  await row.locator('[data-action=details]').click(); await page.waitForTimeout(1600);
  assert.equal(await page.locator('#detailDialog').evaluate(el => el.open), true);
  await page.locator('#detailDialog [data-close]').click();
  await page.locator('#noticeRange').selectOption('all');
  await page.getByText('十年前的历史通知', { exact: true }).waitFor();
  await page.getByText('旧版导入时间未知', { exact: true }).waitFor();
  await page.locator('[data-view=tasks]').click();
  await page.locator('#itemList').getByText('没有截止日期的待办', { exact: true }).waitFor();
  assert.equal(await page.locator('#itemList').getByText('近期课程通知', { exact: true }).count(), 0);
  await page.locator('[data-view=notices]').click(); await page.locator('#noticeRange').selectOption('7');
  await page.locator('#connectSourcesBtn').click(); await page.locator('#settingsDialog [data-connect-chaoxing]').click();
  await page.locator('#accountForm [name=phone]').waitFor({ state: 'visible' });
  await page.locator('#accountForm [name=phone]').fill('13800000000'); await page.locator('#accountForm [name=password]').fill('test-placeholder');
  await page.locator('#accountLoginBtn').click();
  await page.getByText('登录失败：需要验证码（界面测试）', { exact: true }).waitFor();
  assert.equal(await page.locator('#accountForm [name=password]').inputValue(), '');
  rejectLogin = false;
  await page.locator('#accountForm [name=password]').fill('test-placeholder'); await page.locator('#accountLoginBtn').click();
  await page.locator('#accountOutcomeTitle').getByText('正在同步学习通', { exact: true }).waitFor();
  await page.locator('#accountDialog [data-close]').click();
  operation = result('verification_required');
  await page.locator('#operationTitle').getByText('需要学习通安全验证', { exact: true }).waitFor();
  await page.locator('#operationNotice [data-connect-chaoxing]').click();
  await page.locator('#accountOutcomeTitle').getByText('需要学习通安全验证', { exact: true }).waitFor();
  assert.match(await page.locator('#accountStatus').textContent(), /账号已登录/);
  assert.match(await page.locator('#accountOutcomeMessage').textContent(), /0\/10/);
  assert.equal(await page.locator('#accountResults details[open]').count(), 0);
  await page.locator('#accountVerifyBtn').click();
  await page.locator('#accountError').getByText('无法打开验证窗口：Edge 窗口启动失败（界面测试）', { exact: true }).waitFor();
  rejectVerification = false; await page.locator('#accountVerifyBtn').click();
  await page.locator('#verificationMessage').getByText('请在 Edge 完成验证码，然后回到软件继续同步。', { exact: true }).waitFor();
  assert.equal(await page.locator('#accountSyncBtn').textContent(), '已完成验证，继续同步');
  await page.screenshot({ path: 'artifacts/chaoxing-desktop.png', fullPage: true });
  nextStatus = 'succeeded'; await page.locator('#accountSyncBtn').click();
  await page.locator('#accountOutcomeTitle').getByText('同步完成', { exact: true }).waitFor();
  assert.equal(await page.locator('#accountSyncBtn').textContent(), '立即同步');
  nextStatus = 'failed'; await page.locator('#accountSyncBtn').click();
  await page.locator('#accountOutcomeTitle').getByText('同步失败', { exact: true }).waitFor();
  await page.locator('#accountOutcomeMessage').getByText('无法连接学习通，请检查网络', { exact: true }).waitFor();
  nextStatus = 'verification_required'; await page.locator('#accountSyncBtn').click();
  await page.locator('#accountOutcomeTitle').getByText('需要学习通安全验证', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/chaoxing-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.evaluate(() => document.querySelector('#accountDialog').scrollWidth <= document.querySelector('#accountDialog').clientWidth), true);
  assert.deepEqual(errors, []);
  console.log('UI checks passed: publication-date filters, notice/task separation, undated tasks, expanded notice content, login rejection, progress, completion, failure, verification warning after modal closes, and mobile layout. Platform responses were mocked; no account was changed.');
} finally { await browser.close(); }
