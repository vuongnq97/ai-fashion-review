'use strict';

const path = require('path');
const fs = require('fs');

const PROJECT_URL = 'https://flow.google.com/project/8ac10c4a-44b5-4d55-b470-10ab24db4c1c';
const BASE_DIR = path.resolve(__dirname, '..');
const USER_DATA_DIR = path.join(BASE_DIR, 'chrome-data');
const COOKIE_FILE = path.join(BASE_DIR, 'labs.google.cookies.json');

async function attachCDP(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');

    cdp.on('Network.requestWillBeSent', event => {
      const url = event.request.url;
      if (url.includes('aisandbox-pa') || url.includes('batchGenerate') || url.includes('flowMedia')) {
        console.log('\n' + '='.repeat(70));
        console.log('*** CDP REQUEST: ' + event.request.method + ' ' + url);
        const headers = event.request.headers;
        const important = ['authorization','content-type','origin','referer','x-browser-channel','x-browser-year','x-browser-copyright'];
        for (const [k, v] of Object.entries(headers)) {
          if (important.includes(k.toLowerCase())) {
            const display = k.toLowerCase() === 'authorization' ? v.substring(0, 60) + '...' : String(v).substring(0, 200);
            console.log('  ' + k + ': ' + display);
          }
        }
        if (event.request.postData) {
          try {
            const parsed = JSON.parse(event.request.postData);
            const s = JSON.stringify(parsed, function(key, val) {
              if (key === 'token' && typeof val === 'string' && val.length > 60) return val.substring(0,40) + '...[' + val.length + 'chars]';
              if (key === 'imageBytes') return '[BASE64]';
              return val;
            }, 2);
            console.log('--- BODY ---\n' + s.substring(0, 3000));
          } catch (_) { console.log('Body:', String(event.request.postData).substring(0, 1000)); }
        }
        console.log('='.repeat(70));
      }
    });

    cdp.on('Network.responseReceived', event => {
      const url = event.response.url;
      if (url.includes('aisandbox-pa') || url.includes('batchGenerate') || url.includes('flowMedia')) {
        console.log('*** RESPONSE: ' + event.response.status + ' ' + url.substring(0, 100));
      }
    });

    return cdp;
  } catch (e) {
    console.warn('[CDP] attach failed:', e.message);
    return null;
  }
}

async function main() {
  const { chromium } = require('playwright');

  console.log('\n=== SNIFF: batchGenerateImages ===');

  try {
    if (fs.existsSync(USER_DATA_DIR)) {
      for (const f of fs.readdirSync(USER_DATA_DIR)) {
        if (f.startsWith('Singleton')) {
          try { fs.unlinkSync(path.join(USER_DATA_DIR, f)); } catch (_) {}
        }
      }
    }
  } catch (_) {}

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: false,
    ignoreHTTPSErrors: true,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: null,
  });

  if (fs.existsSync(COOKIE_FILE)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
      await context.addCookies(cookies);
      console.log('Loaded ' + cookies.length + ' cookies.');
    } catch (e) { console.warn('Cookie fail:', e.message); }
  }

  // Intercept tất cả request từ context
  context.on('request', request => {
    const url = request.url();
    if (url.includes('aisandbox-pa') || url.includes('batchGenerate') || url.includes('flowMedia')) {
      console.log('\n' + '='.repeat(70));
      console.log('[PW] REQUEST: ' + request.method() + ' ' + url);
      const headers = request.headers();
      const important = ['authorization','content-type','origin','referer','x-browser-channel','x-browser-year','x-browser-copyright'];
      for (const [k, v] of Object.entries(headers)) {
        if (important.includes(k.toLowerCase())) {
          console.log('  ' + k + ': ' + String(v).substring(0, 200));
        }
      }
      try {
        const postData = request.postData();
        if (postData) {
          const parsed = JSON.parse(postData);
          const s = JSON.stringify(parsed, function(key, val) {
            if (key === 'token' && typeof val === 'string' && val.length > 60) return val.substring(0,40) + '...[' + val.length + 'chars]';
            if (key === 'imageBytes') return '[BASE64]';
            return val;
          }, 2);
          console.log('[BODY]\n' + s.substring(0, 3000));
        }
      } catch (_) {}
      console.log('='.repeat(70));
    }
  });

  context.on('response', async response => {
    const url = response.url();
    if (url.includes('aisandbox-pa') || url.includes('batchGenerate') || url.includes('flowMedia')) {
      const status = response.status();
      console.log('[PW] RESPONSE: ' + status + ' ' + url.substring(0, 100));
      if (status !== 200) {
        try { console.log(await response.text()); } catch (_) {}
      }
    }
  });

  // Open project page và attach CDP
  const page = await context.newPage();
  await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
    console.warn('Nav warning:', e.message);
  });
  console.log('\nPage loaded:', page.url());
  await attachCDP(page);

  // Watch new tabs
  context.on('page', async newPage => {
    console.log('[NEW TAB]', newPage.url());
    await newPage.waitForLoadState('domcontentloaded').catch(() => {});
    await attachCDP(newPage);
  });

  console.log('\n[READY] Please generate an image now. Waiting 5 minutes...\n');
  await page.waitForTimeout(5 * 60 * 1000).catch(() => {});

  await context.close().catch(() => {});
  console.log('[DONE]');
}

main().catch(err => { console.error(err); process.exit(1); });
