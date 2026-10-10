const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');
const fs = require('fs');

async function testDownload720p() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  console.log('1. Opening download menu...');
  const btn = page.locator('button[aria-label="Tải nội dung nghe nhìn xuống"]').first();
  await btn.click({ force: true });
  await page.waitForTimeout(600);

  console.log('2. Clicking "720p Kích thước gốc" and waiting for download...');
  const option720p = page.locator('.mat-mdc-menu-panel button', { hasText: /720p/i }).first();
  
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    option720p.click({ force: true })
  ]);

  const filename = download.suggestedFilename();
  console.log('Download started! Suggested filename:', filename);

  const destPath = `./outputs/heihei_video_360_720p.mp4`;
  await download.saveAs(destPath);

  const stat = fs.statSync(destPath);
  console.log(`🎉 SUCCESS! Downloaded video to ${destPath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

  await browser.close();
  process.exit(0);
}

testDownload720p();
