const { chromium } = require('playwright');

async function checkUrl() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const pages = browser.contexts()[0].pages();
  for (let i = 0; i < pages.length; i++) {
    console.log(`Page [${i}]: ${await pages[i].title()} -> ${pages[i].url()}`);
  }
  await browser.close();
}

checkUrl();
