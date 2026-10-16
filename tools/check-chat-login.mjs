import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { readAccessCode } from './ui-test-support.mjs';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BROWSER_CHECK_URL || 'http://127.0.0.1:4317';
const code = await readAccessCode();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await context.newPage(); const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await mkdir('artifacts', { recursive: true });
try {
  assert.equal((await context.request.post(base + '/api/pair', { data: { code } })).status(), 200);
  await page.goto(base); await page.locator('#serverLabel').getByText('事项服务已连接').waitFor();
  // Opening official WeChat is interactive. Opt in explicitly when a person
  // is ready to scan; the default check must not open desktop login windows.
  const sources = process.argv.includes('--wechat-login') ? ['qq', 'wechat'] : ['qq'];
  for (const source of sources) {
    await page.locator(`.source-nav [data-connect-chat=${source}]`).click();
    const before = await context.request.get(base + '/api/accounts/' + source).then((r) => r.json());
    if (before.loginState !== 'authenticated' && (!before.qrAvailable || Date.parse(before.qrExpiresAt) <= Date.now())) await page.locator('#chatStart').click();
    await page.waitForFunction(() => document.querySelector('#chatQr').hidden === false || document.querySelector('#chatGroupsSection').hidden === false || document.querySelector('#chatOutcome').dataset.status === 'failed', null, { timeout: 60_000 });
    const info = await context.request.get(base + '/api/accounts/' + source).then((r) => r.json());
    console.log(JSON.stringify({ source, loginState: info.loginState, qrAvailable: info.qrAvailable, status: info.status, message: info.message }));
    assert.ok(info.qrAvailable || info.loginState === 'authenticated', source + ': real login must offer a QR or existing valid session');
    if (info.qrAvailable) { await page.locator('#chatQrImage').waitFor({ state: 'visible' }); await page.waitForFunction(() => document.querySelector('#chatQrImage').naturalWidth > 0); }
    await page.screenshot({ path: `artifacts/${source}-qr-desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `artifacts/${source}-qr-mobile.png` });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.locator('#chatDialog [data-close]').click();
  }
  assert.deepEqual(errors, []);
  console.log(`Real ${sources.join(' and ')} login presentation checked; this command alone does not verify live delivery or history completeness.`);
} finally { await browser.close(); }
