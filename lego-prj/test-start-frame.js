const { chromium } = require('playwright');

async function testStartFrameChip() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('flow.google.com'));

  // Switch to Video mode first if not in video mode
  console.log('1. Checking settings button...');
  const settingsBtn = page.locator('.settings-trigger-button').first();
  const text = await settingsBtn.innerText();
  console.log('Current text:', text.replace(/\n/g, ' '));

  if (!text.toLowerCase().includes('video')) {
    await settingsBtn.click();
    await page.waitForTimeout(500);
    const vidTab = page.locator('.cdk-overlay-pane button', { hasText: /Video/i }).first();
    await vidTab.click();
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  // Click the "Bắt đầu" chip
  console.log('2. Clicking "Bắt đầu" chip...');
  const startChip = page.locator('button, div, [class*="chip"]').filter({ hasText: /^Bắt đầu$/i }).first();
  if (await startChip.isVisible()) {
    await startChip.click();
    await page.waitForTimeout(800);

    const menu = await page.evaluate(() => {
      const pane = document.querySelector('.cdk-overlay-pane, [role="menu"]');
      if (!pane) return 'No pane';
      return Array.from(pane.querySelectorAll('button, [role="menuitem"], [role="option"]')).map(el => ({
        text: el.innerText.trim().replace(/\n/g, ' '),
        role: el.getAttribute('role')
      }));
    });
    console.log('Menu after clicking "Bắt đầu":', JSON.stringify(menu, null, 2));
    await page.keyboard.press('Escape');
  } else {
    console.log('"Bắt đầu" chip not visible');
  }

  await browser.close();
}

testStartFrameChip();
