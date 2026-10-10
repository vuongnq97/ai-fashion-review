const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');

async function waitForProject() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  for (let i = 0; i < 20; i++) {
    const text = await page.evaluate(() => document.body.innerText.slice(0, 200).replace(/\n+/g, ' '));
    const hasEditor = await page.evaluate(() => !!document.querySelector('.ProseMirror'));
    console.log(`[${i}s] Editor: ${hasEditor} | Text: "${text}"`);
    if (hasEditor) break;
    await page.waitForTimeout(1000);
  }

  await browser.close();
  process.exit(0);
}

waitForProject();
