const { startProxyBridge, rotateProxy } = require('./services/proxy-bridge');
const { chromium } = require('playwright');

async function testWithProxy() {
  await startProxyBridge(8888);
  
  // Rotate to proxy 21 or first working proxy
  rotateProxy();

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  console.log('Navigating to Flow project with Proxy...');
  await page.goto('https://flow.google.com/project/8ac10c4a-44b5-4d55-b470-10ab24db4c1c', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  for (let i = 0; i < 15; i++) {
    const text = await page.evaluate(() => document.body.innerText.slice(0, 200).replace(/\n+/g, ' '));
    const hasEditor = await page.evaluate(() => !!document.querySelector('.ProseMirror'));
    console.log(`[${i}s] Editor: ${hasEditor} | Text: "${text}"`);
    if (hasEditor) break;
    await page.waitForTimeout(1000);
  }

  await browser.close();
  process.exit(0);
}

testWithProxy();
