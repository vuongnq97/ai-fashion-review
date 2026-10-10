'use strict';

const { chromium } = require('playwright');
const { startProxyBridge } = require('./services/proxy-bridge');

async function testClick() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const pages = browser.contexts()[0].pages();
  const page = pages.find(p => p.url().includes('flow.google.com')) || pages[0];

  const settingsBtn = page.locator('.settings-trigger-button').first();
  console.log('Clicking settingsBtn...');
  await settingsBtn.click({ force: true });
  await page.waitForTimeout(1000);

  const buttons = await page.$$('.cdk-overlay-pane button');
  console.log('Buttons inside overlay:', buttons.length);
  for (let i = 0; i < buttons.length; i++) {
    const text = await buttons[i].innerText();
    console.log(`Btn #${i}:`, JSON.stringify(text));
  }

  // Click Video if exists
  const vidBtn = page.locator('.cdk-overlay-pane button', { hasText: /Video/i }).first();
  if (await vidBtn.isVisible()) {
    console.log('Clicking Video button...');
    await vidBtn.click({ force: true });
    await page.waitForTimeout(1000);
    console.log('SettingsBtn text after Video click:', await settingsBtn.innerText());
  } else {
    console.log('Video button not visible!');
  }

  await page.keyboard.press('Escape');
}

testClick().catch(console.error);
