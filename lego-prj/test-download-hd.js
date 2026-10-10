const { chromium } = require('playwright');
const fs = require('fs');

async function testDownload() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  const url = "https://flow-content.google/image/3b85828a-0e26-4476-a55a-993d88a93bb8?Expires=1791494366&KeyName=labs-flow-prod-cdn-key&Signature=tvOFEDCFRykZNALjxFt6BPXEaPE";

  const base64 = await page.evaluate(async (targetUrl) => {
    const r = await fetch(targetUrl);
    if (!r.ok) throw new Error('Fetch failed: ' + r.status);
    const blob = await r.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }, url);

  const buf = Buffer.from(base64.split(',')[1], 'base64');
  fs.writeFileSync('./outputs/heihei_panel_hd.png', buf);
  console.log(`✅ DOWNLOADED FULL HD PANEL: ${(buf.length / 1024).toFixed(1)} KB`);

  await browser.close();
  process.exit(0);
}

testDownload();
