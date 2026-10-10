'use strict';

const { chromium } = require('playwright');
const { startProxyBridge } = require('./services/proxy-bridge');

async function testStartFrame() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('flow.google.com'));

  console.log('1. Checking Start Frame button (Bắt đầu)...');
  const startChip = page.locator('button, div, [class*="chip"]').filter({ hasText: /^Bắt đầu$/i }).first();
  console.log('startChip visible:', await startChip.isVisible());
  if (await startChip.isVisible()) {
    await startChip.click();
    await page.waitForTimeout(1000);
    const options = await page.$$('.cdk-overlay-pane [role="option"], .cdk-overlay-pane button');
    console.log('Options count:', options.length);
    for (let i = 0; i < Math.min(5, options.length); i++) {
      console.log(`Option #${i}:`, await options[i].innerText());
    }
    // Click the first one which is the latest generated panel
    const firstOption = page.locator('.cdk-overlay-pane [role="option"], .cdk-overlay-pane button:has(img)').first();
    if (await firstOption.isVisible()) {
      await firstOption.click();
      console.log('Selected first option as Start Frame!');
      await page.waitForTimeout(1000);
    }
  }

  // Check composer
  const editor = page.locator('.ProseMirror').first();
  console.log('Editor text:', await editor.innerText());
}

testStartFrame().catch(console.error);
