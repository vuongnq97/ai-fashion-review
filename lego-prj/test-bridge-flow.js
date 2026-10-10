const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');

async function testBridgeAndReload() {
  await startProxyBridge(8888);

  console.log('Connecting to Chrome CDP...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  console.log('Reloading Flow page through proxy bridge...');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const title = await page.title();
  console.log('Page Title after reload:', title);

  const snippet = await page.evaluate(() => document.body.innerText.slice(0, 300));
  console.log('Page body snippet:\n', snippet);

  await browser.close();
  process.exit(0);
}

testBridgeAndReload();
