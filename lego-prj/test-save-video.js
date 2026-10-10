const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');
const fs = require('fs');

async function testSaveVideo() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  const dest = './outputs/test_saved_video.mp4';
  let saved = false;

  page.on('response', async res => {
    const url = res.url();
    if (url.includes('flow-content.google/video/') && res.status() === 200) {
      try {
        const buf = await res.body();
        if (buf && buf.length > 50000) { // Valid video buffer > 50KB
          fs.writeFileSync(dest, buf);
          console.log(`🎉 CAPTURED VIDEO BUFFER: ${(buf.length / 1024 / 1024).toFixed(2)} MB -> Saved to ${dest}`);
          saved = true;
        }
      } catch (err) {
        console.warn('Buffer capture error:', err.message);
      }
    }
  });

  const btn = page.locator('button[aria-label="Tải nội dung nghe nhìn xuống"]').first();
  await btn.click({ force: true });
  await page.waitForTimeout(600);

  const option720p = page.locator('.mat-mdc-menu-panel button', { hasText: /720p/i }).first();
  console.log('Clicking 720p to trigger download response stream...');
  await option720p.click({ force: true });

  for (let i = 0; i < 15; i++) {
    if (saved) break;
    await page.waitForTimeout(1000);
  }

  await browser.close();
  process.exit(0);
}

testSaveVideo();
