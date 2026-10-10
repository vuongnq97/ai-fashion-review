const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');

async function testVideoUI() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  console.log('1. Switching to Video mode & 10s duration...');
  const settingsBtn = page.locator('.settings-trigger-button').first();
  await settingsBtn.click({ force: true });
  await page.waitForTimeout(600);

  // Switch to Video mode
  const vidRadio = page.locator('.cdk-overlay-pane button', { hasText: /Video/i }).first();
  await vidRadio.click({ force: true });
  await page.waitForTimeout(500);

  // Switch to 9:16
  const ratio916 = page.locator('.cdk-overlay-pane button', { hasText: /9:16/i }).first();
  if (await ratio916.isVisible()) {
    await ratio916.click({ force: true });
    await page.waitForTimeout(300);
  }

  // Switch to 10s if available
  const sec10 = page.locator('.cdk-overlay-pane button', { hasText: /10 giây|8 giây/i }).first();
  if (await sec10.isVisible()) {
    console.log('Selecting duration:', await sec10.innerText());
    await sec10.click({ force: true });
    await page.waitForTimeout(300);
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  console.log('2. Clicking "Bắt đầu" (Start frame chip)...');
  const startChip = page.locator('button, div, [class*="chip"]').filter({ hasText: /^Bắt đầu$/i }).first();
  if (await startChip.isVisible()) {
    await startChip.click();
    await page.waitForTimeout(600);

    const items = await page.evaluate(() => {
      const pane = document.querySelector('.cdk-overlay-pane');
      if (!pane) return [];
      return Array.from(pane.querySelectorAll('button, [role="option"], [role="menuitem"]')).map(el => el.innerText.trim().replace(/\n/g, ' '));
    });
    console.log('Options in Start Frame menu:', items.slice(0, 10));

    // Select the first image in menu (the latest generated image)
    const firstOption = page.locator('.cdk-overlay-pane [role="option"], .cdk-overlay-pane button:has(img)').first();
    if (await firstOption.isVisible()) {
      console.log('Selecting latest image as start frame...');
      await firstOption.click();
      await page.waitForTimeout(800);
    }
  }

  // Check composer chips
  const composerChips = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[class*="chip"], [class*="tag"]')).map(el => el.innerText.trim());
  });
  console.log('Composer chips after selecting Start frame:', composerChips);

  await browser.close();
  process.exit(0);
}

testVideoUI();
