const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');

async function inspectDownloadClick() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  const downloadBtn = page.locator('button[aria-label="Tải nội dung nghe nhìn xuống"]').first();
  await downloadBtn.click();
  await page.waitForTimeout(1000);

  const menuInfo = await page.evaluate(() => {
    const pane = document.querySelector('.cdk-overlay-pane, [role="menu"]');
    if (!pane) return 'No pane';
    return Array.from(pane.querySelectorAll('button, a, [role="menuitem"]')).map(el => ({
      text: el.innerText.trim(),
      href: el.getAttribute('href')
    }));
  });

  console.log('Download menu items:', menuInfo);

  // Also check if any downloads folder in Mac ~/Downloads got a new file
  await browser.close();
  process.exit(0);
}

inspectDownloadClick();
