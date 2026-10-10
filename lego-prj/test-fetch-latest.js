const { chromium } = require('playwright');
const fs = require('fs');

async function testFetchLatestImage() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  // The latest generated image is the first image tile in the gallery
  const latestImg = await page.evaluate(() => {
    const img = document.querySelector('flow-tile img, [data-tile-id] img, img.image, img.thumbnail');
    return img ? img.src : null;
  });

  console.log('Latest image src on Flow DOM:', latestImg);

  if (latestImg) {
    // Fetch directly inside the page context (it's hosted on flow.google.com/asb/...)
    const base64 = await page.evaluate(async (src) => {
      const res = await fetch(src);
      const blob = await res.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    }, latestImg);

    const buf = Buffer.from(base64.split(',')[1], 'base64');
    fs.writeFileSync('./outputs/latest_flow_img.png', buf);
    console.log(`✅ Saved latest image from DOM: ${(buf.length / 1024).toFixed(1)} KB`);
  }

  await browser.close();
  process.exit(0);
}

testFetchLatestImage();
