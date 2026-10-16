import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BROWSER_CHECK_URL || 'http://127.0.0.1:4317';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 950 }, timezoneId: 'UTC' });
const page = await context.newPage(); const errors = [];
let failNextCompletion = false;
page.on('pageerror', (error) => errors.push(error.message));
await page.clock.setFixedTime(new Date('2026-10-16T10:00:00Z'));
const item = (id, title, extra = {}) => ({ id, title, source: 'qq', kind: 'task', category: 'academic', body: '模拟数据，不写入事项库', createdAt: '2026-10-01T10:00:00Z', read: false, done: false, archived: false, ...extra });
const items = [
  item('a1', '上周已读但尚未交的作业', { due: '2026-10-14', read: true, publishedAt: '2026-10-08T10:00:00Z', receivedAt: '2026-10-16T09:00:00Z' }),
  item('a2', '今天要交的报告', { due: '2026-10-16', publishedAt: '2026-10-16T09:00:00Z' }),
  item('a3', '三天后到期的作业', { due: '2026-10-19', publishedAt: '2026-10-15T16:05:00Z' }),
  item('a4', '下个月的作业', { due: '2026-11-15', publishedAt: '2026-10-14T03:00:00Z' }),
  item('a5', '需要核对截止日期的待办', { due: null, publishedAt: '2026-10-15T15:50:00Z' }),
  item('a6', '已经交完的作业', { due: '2026-10-14', done: true }),
  item('a7', '已归档的事项', { due: '2026-10-14', archived: true }),
  item('a8', '已读旧通知', { kind: 'notification', read: true }),
  item('a9', '原消息时间未知', { timestampKind: 'collected', createdAt: '2026-10-16T08:00:00Z', receivedAt: '2026-10-16T08:00:00Z' }),
  item('a10', '手动记下的事项', { source: 'manual', createdAt: '2026-10-16T06:00:00Z' }),
  item('a11', '去年保留的待办', { publishedAt: '2025-10-16T10:00:00Z' })
];
await page.route('**/api/state', (route) => route.fulfill({ json: { items, sources: {}, mode: 'local', localAccountsEnabled: false, remindersEnabled: false } }));
await page.route('**/api/items/*', (route) => {
  const entry = items.find((entry) => route.request().url().endsWith('/' + entry.id));
  assert.ok(entry); assert.equal(route.request().method(), 'PATCH');
  if (failNextCompletion) { failNextCompletion = false; return route.fulfill({ status: 500, json: { error: '模拟保存失败' } }); }
  Object.assign(entry, route.request().postDataJSON()); return route.fulfill({ json: { ok: true } });
});
try {
  await page.goto(base);
  await page.locator('#itemList [data-item=a1]').waitFor();
  assert.equal(await page.locator('#pageTitle').textContent(), '待办');
  assert.equal(await page.locator('.main-nav [data-view=today]').count(), 0);
  assert.deepEqual(await page.locator('.main-nav .nav-item>span').allTextContents(), ['待办', '待确认', '通知', '记录']);
  assert.equal(await page.locator('.main-nav [aria-current=page]').getAttribute('data-view'), 'tasks');
  assert.equal(await page.locator('#itemList .item-row').count(), 8, 'merged view contains all unfinished tasks, including distant and unknown deadlines');
  assert.equal(await page.locator('#itemList [data-item=a8]').count(), 0);
  const groupDates = () => page.locator('.message-date-group').evaluateAll(els => els.map(el => el.dataset.messageDate));
  assert.deepEqual(await groupDates(), ['2026-10-16', '2026-10-15', '2026-10-14', '2026-10-08', '2025-10-16', 'unknown']);
  const groupFor = id => page.locator(`#itemList [data-item=${id}]`).evaluate(el => el.closest('[data-message-date]').dataset.messageDate);
  assert.equal(await groupFor('a1'), '2026-10-08', 'history imports retain source time rather than ingestion date or deadline');
  assert.equal(await groupFor('a3'), '2026-10-16', 'midnight uses Beijing time even with a UTC browser');
  assert.equal(await groupFor('a5'), '2026-10-15');
  assert.equal(await groupFor('a9'), 'unknown', 'unknown source timestamps never borrow the import date');
  assert.equal(await groupFor('a10'), '2026-10-16', 'manual entries use their original creation time');
  assert.match(await page.locator('[data-message-date="2026-10-16"] h2').textContent(), /2026年10月16日星期五今天3 项/);
  assert.match(await page.locator('[data-item=a3] .message-time').textContent(), /收到 00:05/);
  assert.match(await page.locator('[data-item=a10] .message-time').textContent(), /记录 14:00/);
  assert.match(await page.locator('[data-item=a2] .row-due').textContent(), /截止 2026-10-16/);
  assert.match(await page.locator('[data-item=a5] .row-due').textContent(), /截止日期待确认/);
  const headingSize = await page.locator('.message-date-heading time').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  const sourceSize = await page.locator('[data-item=a2] .item-subline').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  assert.ok(headingSize >= 19 && headingSize > sourceSize, 'source dates must stand out from row metadata');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/task-message-dates-desktop.png', fullPage: true });
  await page.locator('#searchInput').fill('下个月');
  await page.locator('[data-item=a4]').waitFor();
  assert.deepEqual(await groupDates(), ['2026-10-14']);
  await page.locator('#searchInput').fill('');
  await page.locator('[data-item=a2]').waitFor();
  await page.locator('#itemList [data-item=a2] [data-action=details]').click();
  await page.locator('#detailDialog [data-action=read]').click();
  await page.locator('#itemList [data-item=a2]').waitFor();
  assert.equal(await groupFor('a2'), '2026-10-16', 'marking read cannot change its source date');
  const completeButton = page.locator('#itemList [data-item=a1] [data-action=toggle-done]');
  assert.equal(await completeButton.textContent(), '已完成', 'completion must have a visible label');
  failNextCompletion = true;
  await page.locator('#itemList [data-item=a2] [data-action=toggle-done]').click();
  await page.locator('#toast.show').filter({ hasText: '保存失败，请检查连接' }).waitFor();
  assert.equal(items.find(i => i.id === 'a2').done, false);
  assert.equal(await page.locator('#itemList [data-item=a2]').isVisible(), true, 'failed completion must keep the task');
  await completeButton.click();
  await page.locator('#itemList [data-item=a1]').waitFor({ state: 'hidden' });
  await page.locator('#toast.show').filter({ hasText: '已标记完成，可在“记录 → 已完成”中查看和恢复' }).waitFor();
  await page.reload(); await page.locator('#itemList [data-item=a2]').waitFor();
  assert.equal(await page.locator('#itemList [data-item=a1]').count(), 0);
  await page.locator('.main-nav [data-view=records]').click();
  await page.locator('[data-filter=done]').click();
  const restoreButton = page.locator('#itemList [data-item=a1] [data-action=toggle-done]');
  await restoreButton.waitFor();
  assert.equal(await restoreButton.textContent(), '恢复未完成');
  await restoreButton.click();
  await page.locator('#toast.show').filter({ hasText: '已恢复为未完成' }).waitFor();
  assert.equal(items.find(i => i.id === 'a1').done, false);
  await page.locator('.main-nav [data-view=tasks]').click();
  assert.equal(await groupFor('a1'), '2026-10-08', 'restoring a completed task retains the original date');
  await page.locator('#itemList [data-item=a5] [data-action=details]').click();
  await page.locator('#detailDialog [data-action=edit]').click();
  await page.locator('#itemForm [name=due]').fill('2026-10-20');
  await page.getByRole('button', { name: '保存事项', exact: true }).click();
  await page.locator('#itemDialog[open]').waitFor({ state: 'hidden' });
  assert.equal(items.find(i => i.id === 'a5').due, '2026-10-20');
  assert.equal(await groupFor('a5'), '2026-10-15', 'editing the deadline cannot move a message to another date');
  await page.locator('#itemList [data-item=a4]').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  for (const row of await page.locator('.message-date-group .item-row').all()) {
    assert.equal(await row.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'task timestamps fit on mobile');
    assert.equal(await row.evaluate(el => {
      const main = el.querySelector('.item-open').getBoundingClientRect();
      const dates = el.querySelector('.row-end').getBoundingClientRect();
      return dates.top >= main.bottom - 1;
    }), true, 'dates must not overlap titles or sources');
  }
  assert.equal(await page.locator('.main-nav').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 4);
  await page.screenshot({ path: 'artifacts/task-message-dates-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'labeled completion fits a narrow screen');
  assert.deepEqual(errors, []);
  console.log('Merged tasks UI passed: four views, source-date grouping and order, Beijing midnight, historical imports, manual/unknown dates, separate deadlines, old/read/distant tasks, labeled completion with success/failure, completed records and restore, search, edits, reload and mobile layout. Data/API mocked; no real items changed.');
} finally { await browser.close(); }
