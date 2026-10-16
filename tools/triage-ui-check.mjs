import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { presentItems, autoPromoteChatTasks } from '../shared/chat-triage.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BROWSER_CHECK_URL || 'http://127.0.0.1:4317';
const now = new Date().toISOString();
const message = (id, text, extra = {}) => ({ id, source: 'qq', sourceName: '示例课程群', kind: 'notification', category: 'academic', title: text, body: text, createdAt: now, publishedAt: now, read: false, done: false, archived: false, ...extra });
const items = [
  message('a1', '谢谢'), message('a2', '得大改。。。'), message('a3', '老师说在维修'), message('a4', '火狐用不了'), message('a5', '[附件]'),
  message('b1', '请有意向的同学周五前提交申请材料'), message('b2', '请有意向的同学周五前提交申请材料'),
  message('c1', '请补做实验的同学完成课本第3章习题', { createdAt: '2020-01-01T10:00:00Z', publishedAt: '2020-01-01T10:00:00Z' }),
  message('d1', '学习通未交作业', { source: 'chaoxing', kind: 'task', due: null }),
  message('e1', '旧课程通知', { source: 'chaoxing', createdAt: '2020-01-01T10:00:00Z', publishedAt: '2020-01-01T10:00:00Z' }),
  message('f1', '请大家周五前提交实验报告')
];
const filtered = [
  message('g1', '@王浩然\u2005@林兆瑞\u2005记得打卡', { source: 'wechat' }),
  message('g2', '@陆凯敬 记得打卡', { source: 'wechat' }),
  message('g3', '@张三 @李四 请抓紧时间填写'),
  message('g4', '愿意报名的请告之我！')
];
items.push(...filtered);
autoPromoteChatTasks(items);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
const page = await context.newPage(); const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/state', (route) => route.fulfill({ json: { items: presentItems(items), sources: {}, localAccountsEnabled: false, remindersEnabled: false, mode: 'local' } }));
await page.route('**/api/items/*', (route) => {
  const item = items.find((item) => route.request().url().endsWith('/' + item.id));
  assert.ok(item); assert.equal(route.request().method(), 'PATCH');
  const patch = route.request().postDataJSON();
  Object.assign(item, patch);
  if (patch.triageDecision === 'dismissed' && item.autoTask) { item.kind = 'notification'; delete item.autoTask; }
  return route.fulfill({ json: { ok: true } });
});
try {
  await page.goto(base); await page.locator('.main-nav [data-view=review]').click();
  await page.locator('#itemList [data-item=b1]').waitFor();
  assert.equal(await page.locator('#metricPending').textContent(), '2');
  assert.equal(await page.locator('#itemList .item-row').count(), 2, 'only two distinct candidates');
  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'b2', 'f1', ...filtered.map(i => i.id)]) assert.equal(await page.locator(`#itemList [data-item=${id}]`).count(), 0, id);
  const row = page.locator('#itemList [data-item=b1]');
  await row.locator('[data-action=details]').click();
  await page.locator('#detailDialog').getByText(/另有 1 条重复消息/).waitFor();
  await page.locator('#detailDialog [data-action=read]').click(); await row.waitFor();
  await row.locator('[data-action=details]').click();
  await page.locator('#detailDialog [data-action=context]').click();
  await page.locator('#rawContext').waitFor({ state: 'visible' });
  await page.locator('#itemList [data-item=a1]').waitFor();
  assert.equal(await page.locator('#itemList [data-item=c1]').count(), 0);
  await page.locator('.main-nav [data-view=review]').click();
  await row.locator('[data-action=make-task]').click();
  await page.locator('#itemForm [data-close]').first().click();
  assert.equal(items.find(i => i.id === 'b1').kind, 'notification');
  await row.locator('[data-action=make-task]').click();
  await page.getByRole('button', { name: '确认加入待办', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#metricPending').textContent === '3');
  assert.equal(items.find(i => i.id === 'b1').due, '');
  assert.equal(await page.locator('#itemList [data-item=b2]').count(), 0);
  await page.locator('#itemList [data-item=c1] [data-action=details]').click();
  await page.locator('#detailDialog [data-action=dismiss-candidate]').click();
  await page.locator('#itemList [data-item=c1]').waitFor({ state: 'hidden' });
  await page.reload(); await page.locator('.main-nav [data-view=review]').click();
  assert.equal(await page.locator('#itemList .item-row').count(), 0);
  await page.locator('.main-nav [data-view=records]').click(); await page.locator('#noticeRange').selectOption('all');
  assert.equal(await page.locator('#itemList .item-row').count(), items.length, 'all originals and platform records remain accessible');
  for (const { id } of filtered) await page.locator(`#itemList [data-item=${id}]`).waitFor();
  await page.locator('[data-filter=other]').click(); await page.locator('#itemList [data-item=a5]').waitFor();
  await page.locator('.main-nav [data-view=tasks]').click();
  assert.equal(await page.locator('#itemList .item-row').count(), 3);
  await page.locator('#itemList [data-item=f1] [data-action=details]').click();
  await page.locator('#detailDialog').getByText(/根据关键词自动加入/).waitFor();
  await page.locator('#detailDialog [data-action=dismiss-candidate]').click();
  await page.locator('#itemList [data-item=f1]').waitFor({ state: 'hidden' });
  assert.equal(items.find(i => i.id === 'f1').triageDecision, 'dismissed');
  autoPromoteChatTasks(items);
  await page.reload(); await page.locator('.main-nav [data-view=tasks]').click();
  assert.equal(await page.locator('#itemList .item-row').count(), 2);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('Triage UI passed: clear requirements go directly to tasks with reasons and lasting correction; uncertain candidates need confirmation; raw/context views, duplicate handling, deadline uncertainty and mobile layout. API data mocked; real items untouched.');
} finally { await browser.close(); }
