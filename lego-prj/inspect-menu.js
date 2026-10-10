const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');

async function inspectMenu() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  const btn = page.locator('button[aria-label="Tải nội dung nghe nhìn xuống"]').first();
  await btn.click({ force: true });
  await page.waitForTimeout(600);

  const menuItems = await page.evaluate(() => {
    const pane = document.querySelector('.mat-mdc-menu-panel, .cdk-overlay-pane');
    if (!pane) return [];
    return Array.from(pane.querySelectorAll('button, a')).map(el => ({
      text: el.innerText.trim(),
      href: el.getAttribute('href'),
      aria: el.getAttribute('aria-label')
    }));
  });

  console.log('Menu items:', JSON.stringify(menuItems, null, 2));

  await browser.close();
  process.exit(0);
}

inspectMenu();
