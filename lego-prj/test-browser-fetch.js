const { chromium } = require('playwright');
const fs = require('fs');

async function testFetchInBrowser() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  // Find image URL from the DOM!
  // In Flow, the generated image appears in the gallery or grid!
  const imgUrls = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img')).map(i => i.src).filter(s => s && s.includes('flow-content.google/image/'));
    return imgs;
  });

  console.log('Found image URLs on page:', imgUrls.length);
  if (imgUrls.length > 0) {
    const targetUrl = imgUrls[0];
    console.log('Target URL:', targetUrl.slice(0, 100));

    // Fetch in browser context (always authenticated and authorized)
    const base64Data = await page.evaluate(async (url) => {
      const res = await fetch(url);
      const blob = await res.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }, targetUrl);

    const base64Content = base64Data.split(',')[1];
    const buffer = Buffer.from(base64Content, 'base64');
    fs.writeFileSync('./outputs/test_parrot_clean.png', buffer);
    console.log(`✅ Saved image to ./outputs/test_parrot_clean.png (${(buffer.length / 1024).toFixed(1)} KB)`);
  }

  await browser.close();
  process.exit(0);
}

testFetchInBrowser();
