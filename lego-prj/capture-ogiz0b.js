const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');
const fs = require('fs');

function parseBatchExecute(rawText, rpcId = 'ogiZ0b') {
  if (!rawText || typeof rawText !== 'string') return null;
  const cleaned = rawText.replace(/^\)\]\}'\s*/, '').trim();
  const lines = cleaned.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (Array.isArray(item) && item[1] === rpcId && typeof item[2] === 'string') {
            return JSON.parse(item[2]);
          }
        }
      }
    } catch (_) {}
  }
  return null;
}

async function captureOgiZ0b() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  console.log('Listening for ogiZ0b response...');
  let responseData = null;

  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('batchexecute') && (url.includes('ogiZ0b') || url.includes('rpcids='))) {
      try {
        const text = await res.text();
        const parsed = parseBatchExecute(text, 'ogiZ0b');
        if (parsed) {
          console.log('✅ Captured parsed ogiZ0b!');
          responseData = parsed;
          fs.writeFileSync('./outputs/last_ogiz0b.json', JSON.stringify(parsed, null, 2), 'utf8');
        }
      } catch (_) {}
    }
  });

  const submitBtn = page.locator('button[aria-label="Bắt đầu tạo"], button:has-text("arrow_forward")').last();
  await submitBtn.click({ force: true });
  console.log('Clicked generate. Waiting up to 45s...');

  for (let i = 0; i < 45; i++) {
    if (responseData) break;
    await page.waitForTimeout(1000);
  }

  if (responseData) {
    console.log('Saved ogiZ0b JSON to ./outputs/last_ogiz0b.json');
  } else {
    console.log('No ogiZ0b captured');
  }

  await browser.close();
  process.exit(0);
}

captureOgiZ0b();
