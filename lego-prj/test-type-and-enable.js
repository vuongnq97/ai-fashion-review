const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');

async function testType() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  const editor = page.locator('.ProseMirror').first();
  await editor.click();
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('Professional 8k commercial photography of a LEGO Heihei model on rotating pedestal');
  await page.waitForTimeout(500);

  const btnState = await page.evaluate(() => {
    const btn = document.querySelector('.generate-icon-button, button[aria-label="Bắt đầu tạo"]');
    return {
      disabled: btn ? (btn.disabled || btn.classList.contains('mat-mdc-button-disabled')) : true,
      text: btn ? btn.innerText : null
    };
  });

  console.log('Generate button state after typing:', btnState);
  await browser.close();
  process.exit(0);
}

testType();
