const { chromium } = require('playwright');

async function testImageModeUI() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('flow.google.com'));

  console.log('1. Opening settings...');
  await page.locator('.settings-trigger-button').first().click({ force: true });
  await page.waitForTimeout(600);

  console.log('2. Clicking "Hình ảnh"...');
  const imgBtn = page.locator('.cdk-overlay-pane button', { hasText: /Hình ảnh/i }).first();
  await imgBtn.click({ force: true });
  await page.waitForTimeout(600);

  console.log('3. Selecting 9:16...');
  const ratio916 = page.locator('.cdk-overlay-pane button', { hasText: /9:16/i }).first();
  if (await ratio916.isVisible()) {
    await ratio916.click({ force: true });
  }

  // Check model button in settings
  const modelBtnText = await page.evaluate(() => {
    const pane = document.querySelector('.cdk-overlay-pane');
    return pane ? pane.innerText : '';
  });
  console.log('Settings Pane Content:\n', modelBtnText);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Check composer chips in Image mode
  const chips = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, .empty-chip, [class*="chip"]')).map(b => ({
      text: b.innerText.trim(),
      aria: b.getAttribute('aria-label')
    })).filter(b => b.text || b.aria).slice(-10);
  });
  console.log('\nComposer chips after switching to Image mode:', JSON.stringify(chips, null, 2));

  await browser.close();
}

testImageModeUI();
