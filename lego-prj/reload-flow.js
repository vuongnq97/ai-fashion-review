const { chromium } = require('playwright');

async function reloadFlow() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];
  console.log('Reloading page...');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);
  const text = await page.evaluate(() => document.body.innerText.slice(0, 300));
  console.log('After reload snippet:\n', text);
  await browser.close();
}

reloadFlow();
