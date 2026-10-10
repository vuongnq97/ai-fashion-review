const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');

async function traceOptionClick() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  page.on('request', req => {
    console.log(`➡️ [REQ] ${req.method()} ${req.url().slice(0, 150)}`);
  });

  page.on('response', async res => {
    const url = res.url();
    console.log(`⬅️ [RES ${res.status()}] ${url.slice(0, 150)}`);
    if (url.includes('batchexecute') || url.includes('video') || url.includes('storage') || url.includes('download')) {
      try {
        const text = await res.text();
        console.log('   Response snippet:', text.slice(0, 250));
      } catch (_) {}
    }
  });

  const btn = page.locator('button[aria-label="Tải nội dung nghe nhìn xuống"]').first();
  await btn.click({ force: true });
  await page.waitForTimeout(600);

  const option720p = page.locator('.mat-mdc-menu-panel button', { hasText: /720p/i }).first();
  console.log('Clicking 720p option...');
  await option720p.click({ force: true });
  await page.waitForTimeout(4000);

  await browser.close();
  process.exit(0);
}

traceOptionClick();
