const { chromium } = require('playwright');

async function checkBody() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];
  const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
  console.log('Body text snippet:\n', text);
  await browser.close();
}

checkBody();
