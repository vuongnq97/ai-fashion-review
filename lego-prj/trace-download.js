const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');

async function traceDownloadButton() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  console.log('Listening to network requests...');
  page.on('request', req => {
    const url = req.url();
    if (!url.endsWith('.js') && !url.endsWith('.css') && !url.includes('google-analytics')) {
      console.log(`➡️ [REQ] ${req.method()} ${url.slice(0, 120)}`);
    }
  });

  page.on('response', async res => {
    const url = res.url();
    if (url.includes('batchexecute') || url.includes('video') || url.includes('download')) {
      console.log(`⬅️ [RES ${res.status()}] ${url.slice(0, 120)}`);
      try {
        const text = await res.text();
        if (text.includes('http') || text.includes('video') || text.includes('mp4')) {
          console.log('   Body preview:', text.slice(0, 200).replace(/\n+/g, ' '));
        }
      } catch (_) {}
    }
  });

  const downloadBtn = page.locator('button[aria-label="Tải nội dung nghe nhìn xuống"], button:has-text("download")').first();
  if (await downloadBtn.isVisible()) {
    console.log('Clicking download button...');
    await downloadBtn.click({ force: true });
    await page.waitForTimeout(4000);
  } else {
    console.log('Download button not visible on current page:', page.url());
  }

  await browser.close();
  process.exit(0);
}

traceDownloadButton();
