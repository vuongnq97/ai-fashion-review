const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');
const fs = require('fs');
const axios = require('axios');
const https = require('https');

async function reloadAndCheck() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  console.log('Reloading page...');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  const text = await page.evaluate(() => document.body.innerText.replace(/\n+/g, ' '));
  console.log('Page text after reload:\n', text.slice(0, 400));

  await browser.close();
  process.exit(0);
}

reloadAndCheck();
