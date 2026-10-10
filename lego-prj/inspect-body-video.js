const { chromium } = require('playwright');

async function inspectBody() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  const text = await page.evaluate(() => document.body.innerText.slice(0, 1000).replace(/\n+/g, ' '));
  console.log('Body text:\n', text);

  // Check all videos on page
  const videos = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('video, source')).map(v => v.src);
  });
  console.log('Videos on page:', videos);

  await browser.close();
  process.exit(0);
}

inspectBody();
