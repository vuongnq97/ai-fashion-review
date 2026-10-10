const { chromium } = require('playwright');

async function testSettings() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('flow.google.com'));

  console.log('Clicking settings button...');
  await page.locator('.settings-trigger-button').click();
  await page.waitForTimeout(1000);

  const dialogText = await page.evaluate(() => {
    const pane = document.querySelector('.cdk-overlay-pane, mat-dialog-container, [role="dialog"], [role="menu"]');
    if (!pane) return 'No pane found';
    
    const items = Array.from(pane.querySelectorAll('button, [role="tab"], mat-button-toggle, .mat-mdc-tab, label, mat-slider')).map(el => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      text: el.innerText.trim().replace(/\n/g, ' ')
    }));
    return items;
  });

  console.log('Settings options:', JSON.stringify(dialogText, null, 2));

  // Press escape to close
  await page.keyboard.press('Escape');
  await browser.close();
}

testSettings();
