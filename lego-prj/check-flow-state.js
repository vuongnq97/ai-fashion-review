'use strict';

const { chromium } = require('playwright');
const { startProxyBridge } = require('./services/proxy-bridge');

async function check() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const pages = browser.contexts()[0].pages();
  const page = pages.find(p => p.url().includes('flow.google.com')) || pages[0];
  console.log('Page URL:', page.url());
  console.log('Page Title:', await page.title());
  
  const settingsBtn = await page.$('.settings-trigger-button');
  console.log('settingsBtn exists:', !!settingsBtn);
  if (settingsBtn) {
    console.log('settingsBtn text:', await settingsBtn.innerText());
  }

  const overlays = await page.$$('.cdk-overlay-pane');
  console.log('Overlays count:', overlays.length);
  for (let i = 0; i < overlays.length; i++) {
    const text = await overlays[i].innerText();
    console.log(`Overlay #${i}:`, text.slice(0, 100));
  }

  const editor = await page.$('.ProseMirror');
  console.log('Editor exists:', !!editor);

  await page.screenshot({ path: 'flow-current.png' });
  console.log('Saved flow-current.png');
}

check().catch(console.error);
