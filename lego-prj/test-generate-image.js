const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');
const fs = require('fs');
const https = require('https');

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, { rejectUnauthorized: false }, response => {
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve(destPath));
      });
    }).on('error', err => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function testGenerateImage() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  console.log('1. Waiting for Flow UI to be ready...');
  await page.waitForSelector('.settings-trigger-button, .ProseMirror', { timeout: 25000 });
  await page.waitForTimeout(1000);

  console.log('2. Ensuring Image mode & 9:16 ratio...');
  const settingsBtn = page.locator('.settings-trigger-button').first();
  await settingsBtn.click({ force: true });
  await page.waitForTimeout(800);

  // Switch to Image mode if not already
  const imgRadio = page.locator('.cdk-overlay-pane button', { hasText: /Hình ảnh/i }).first();
  await imgRadio.click({ force: true });
  await page.waitForTimeout(500);

  // Switch to 9:16
  const ratio916 = page.locator('.cdk-overlay-pane button', { hasText: /9:16/i }).first();
  if (await ratio916.isVisible()) {
    await ratio916.click({ force: true });
    await page.waitForTimeout(300);
  }

  // Switch to x1
  const x1Btn = page.locator('.cdk-overlay-pane button', { hasText: /^x1$/i }).first();
  if (await x1Btn.isVisible()) {
    await x1Btn.click({ force: true });
    await page.waitForTimeout(300);
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  console.log('2. Entering prompt into ProseMirror...');
  const editor = page.locator('.ProseMirror').first();
  await editor.click();
  await page.keyboard.press('Meta+A'); // Select all existing text
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('A cute small LEGO parrot sitting on a modern wooden table, shallow depth of field, 8k render, professional product photography');
  await page.waitForTimeout(500);

  console.log('3. Listening for response and clicking Generate...');
  let imageUrl = null;

  // Listen to network responses for image URL
  const responsePromise = new Promise((resolve) => {
    const handler = async (res) => {
      const url = res.url();
      if (url.includes('batchexecute') && (url.includes('ogiZ0b') || url.includes('rpcids='))) {
        try {
          const text = await res.text();
          const match = text.match(/https:(?:\\\/|\/)+flow-content\.google\/image\/[^"\s\\]+/i);
          if (match) {
            let clean = match[0].replace(/\\\/|\//g, '/').replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
            console.log('🎉 FOUND GENERATED IMAGE URL IN BATCHEXECUTE RESPONSE:', clean.slice(0, 100) + '...');
            page.off('response', handler);
            resolve(clean);
          }
        } catch (_) {}
      }
    };
    page.on('response', handler);

    // Timeout after 60s
    setTimeout(() => resolve(null), 60000);
  });

  const submitBtn = page.locator('button[aria-label="Bắt đầu tạo"], button:has-text("arrow_forward")').last();
  await submitBtn.click({ force: true });
  console.log('Clicked Generate! Waiting for result...');

  imageUrl = await responsePromise;

  if (imageUrl) {
    const testOut = './outputs/test_parrot.png';
    fs.mkdirSync('./outputs', { recursive: true });
    await downloadFile(imageUrl, testOut);
    console.log('✅ Successfully downloaded generated image to:', testOut);
  } else {
    console.warn('⚠️ Did not catch image URL within 60s');
  }

  await browser.close();
  process.exit(0);
}

testGenerateImage();
