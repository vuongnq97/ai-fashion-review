const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');
const fs = require('fs');

async function testDownloadButton() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  const downloadBtn = page.locator('button[aria-label="Tải nội dung nghe nhìn xuống"], button:has-text("download")').first();
  console.log('Found download button. Listening for download event...');

  const destPath = './outputs/downloaded_media_test';
  
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    downloadBtn.click({ force: true })
  ]);

  const filename = download.suggestedFilename();
  console.log('Suggested filename:', filename);
  const finalPath = `./outputs/${filename}`;
  await download.saveAs(finalPath);
  console.log(`✅ DOWNLOADED FILE SUCCESSFULLY TO: ${finalPath}`);

  await browser.close();
  process.exit(0);
}

testDownloadButton();
