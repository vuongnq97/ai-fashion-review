const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');

async function inspectDownloadBtnHTML() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  const info = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Tải nội dung nghe nhìn xuống"]');
    if (!btn) return 'Not found';
    return {
      outerHTML: btn.outerHTML,
      disabled: btn.disabled,
      classes: btn.className,
      parentHTML: btn.parentElement ? btn.parentElement.outerHTML.slice(0, 300) : null
    };
  });

  console.log('Download button HTML:', JSON.stringify(info, null, 2));
  await browser.close();
  process.exit(0);
}

inspectDownloadBtnHTML();
