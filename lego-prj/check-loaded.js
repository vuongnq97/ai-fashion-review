const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');

async function checkLoadedFlow() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  await page.waitForTimeout(3000);

  const info = await page.evaluate(() => {
    const editor = document.querySelector('.ProseMirror');
    const settingsBtn = document.querySelector('.settings-trigger-button');
    const generateBtn = document.querySelector('.generate-icon-button, button[aria-label="Bắt đầu tạo"]');
    return {
      hasEditor: !!editor,
      settingsText: settingsBtn ? settingsBtn.innerText.replace(/\n/g, ' ') : null,
      generateBtnState: generateBtn ? {
        disabled: generateBtn.disabled || generateBtn.classList.contains('mat-mdc-button-disabled'),
        aria: generateBtn.getAttribute('aria-label')
      } : null
    };
  });

  console.log('Flow UI Info:', info);
  await browser.close();
  process.exit(0);
}

checkLoadedFlow();
