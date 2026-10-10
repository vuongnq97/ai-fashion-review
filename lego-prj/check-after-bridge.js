const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');
const fs = require('fs');
const axios = require('axios');
const https = require('https');

async function checkAfterBridge() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  console.log('Checking page text...');
  const text = await page.evaluate(() => document.body.innerText.replace(/\n+/g, ' '));
  console.log('Current text snippet:', text.slice(0, 300));

  // If still 99% or completed:
  const is99 = text.includes('99%');
  const isCompleted = !text.includes('%') && text.includes('A seamless continuous 360');

  console.log(`is99: ${is99} | isCompleted: ${isCompleted}`);

  if (isCompleted || is99) {
    // Check if there is a download button or video element
    const videoUrl = await page.evaluate(() => {
      const v = document.querySelector('video, source');
      if (v && v.src) return v.src;
      
      // Look for any media URLs in the page
      const scripts = Array.from(document.querySelectorAll('script')).map(s => s.innerText);
      for (const s of scripts) {
        const m = s.match(/https:\/\/flow-content\.google\/video\/[^"'\s]+/);
        if (m) return m[0];
      }
      return null;
    });

    console.log('Video URL found:', videoUrl);
  }

  await browser.close();
  process.exit(0);
}

checkAfterBridge();
