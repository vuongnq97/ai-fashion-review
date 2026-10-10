'use strict';

const { chromium } = require('playwright');
const path = require('path');
const { startProxyBridge } = require('./services/proxy-bridge');

async function testUploadMultiple() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('flow.google.com'));

  const templateImg = path.resolve(__dirname, 'asset/template.png');
  const heroImg = path.resolve(__dirname, 'downloads/7277168939/1_D2A76D21030C4A5D93561872F8D2EE83.jpeg');
  const altImg = path.resolve(__dirname, 'downloads/7277168939/3_20503D73DCC64845B12884616E8C631E.jpeg');

  console.log('1. Switching to Image mode (Hình ảnh)...');
  const settingsBtn = page.locator('.settings-trigger-button').first();
  const text = await settingsBtn.innerText().catch(() => '');
  if (!text.includes('Hình ảnh')) {
    await settingsBtn.click({ force: true });
    await page.waitForTimeout(600);
    const imgBtn = page.locator('.cdk-overlay-pane button', { hasText: /Hình ảnh/i }).first();
    if (await imgBtn.isVisible()) {
      await imgBtn.click({ force: true });
      await page.waitForTimeout(400);
    }
    const ratio916 = page.locator('.cdk-overlay-pane button', { hasText: /9:16/i }).first();
    if (await ratio916.isVisible()) {
      await ratio916.click({ force: true });
      await page.waitForTimeout(300);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  console.log('2. Opening Add menu...');
  const addBtn = page.locator('button[aria-label="Thêm thành phần vào ô nhập câu lệnh"]').first();
  await addBtn.click();
  await page.waitForTimeout(600);

  const uploadBtn = page.locator('.cdk-overlay-pane button', { hasText: /Tải nội dung nghe nhìn lên/i }).first();
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    uploadBtn.click()
  ]);

  console.log('Is multiple files allowed?', fileChooser.isMultiple());
  console.log('Uploading files in order: Image 1 (template), Image 2 (hero), Image 3 (alt)...');
  await fileChooser.setFiles([templateImg, heroImg, altImg]);

  console.log('Files set. Waiting 5s for uploads to complete...');
  await page.waitForTimeout(5000);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  const chips = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[class*="chip"], [class*="tag"], [class*="pill"], flow-chip, .reference-chip')).map(el => el.innerText.trim().replace(/\n/g, ' '));
  });
  console.log('Attached chips:', chips);
}

testUploadMultiple().catch(console.error);
