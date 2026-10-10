const { chromium } = require('playwright');

async function testImageSettings() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('flow.google.com'));

  console.log('Clicking settings button...');
  await page.locator('.settings-trigger-button').click();
  await page.waitForTimeout(600);

  console.log('Clicking "image Hình ảnh"...');
  await page.locator('button[role="radio"]:has-text("Hình ảnh")').click();
  await page.waitForTimeout(600);

  const dialogText = await page.evaluate(() => {
    const pane = document.querySelector('.cdk-overlay-pane, mat-dialog-container, [role="dialog"], [role="menu"]');
    if (!pane) return [];
    
    return Array.from(pane.querySelectorAll('button, [role="tab"], mat-button-toggle, .mat-mdc-tab')).map(el => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      text: el.innerText.trim().replace(/\n/g, ' ')
    }));
  });

  console.log('Image Settings options:', JSON.stringify(dialogText, null, 2));

  // Press escape to close
  await page.keyboard.press('Escape');
  await browser.close();
}

testImageSettings();
