'use strict';

/**
 * WARM-UP BROWSER — Mở browser, bạn generate ảnh, token được cache vào file
 * để app dùng lại (score cao hơn Playwright tự generate).
 *
 * Chạy: node scripts/warmup-browser.js
 * Giữ chạy trong background, app sẽ đọc token từ file cache.
 */

const path = require('path');
const fs = require('fs');

const PROJECT_URL = 'https://labs.google/fx/tools/image-fx';
const BASE_DIR = path.resolve(__dirname, '..');
const USER_DATA_DIR = path.join(BASE_DIR, 'chrome-data');
const COOKIE_FILE = path.join(BASE_DIR, 'labs.google.cookies.json');
// File chia sẻ token giữa warmup script và app
const TOKEN_CACHE_FILE = path.join(BASE_DIR, 'recaptcha-token-cache.json');

function loadTokenCache() {
  try {
    if (fs.existsSync(TOKEN_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf-8'));
    }
  } catch (_) {}
  return { tokens: [] };
}

function saveTokenToCache(token) {
  const cache = loadTokenCache();
  const now = Date.now();
  // Xóa token đã hết hạn (>90s)
  cache.tokens = cache.tokens.filter(t => (now - t.capturedAt) < 90000);
  // Không cache trùng
  if (!cache.tokens.some(t => t.token === token)) {
    cache.tokens.push({ token, capturedAt: now });
    if (cache.tokens.length > 20) cache.tokens = cache.tokens.slice(-20);
  }
  fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  console.log(`[Warmup] 💾 Token cached to file! Pool: ${cache.tokens.length} tokens`);
}

async function main() {
  const { chromium } = require('playwright');

  console.log('\n============================================================');
  console.log('  WARMUP BROWSER — Generate ảnh để cache high-score tokens');
  console.log('============================================================');
  console.log('Browser sẽ mở tại:', PROJECT_URL);
  console.log('Token cache file:', TOKEN_CACHE_FILE);
  console.log('\n👉 Thao tác: Gõ prompt bất kỳ rồi nhấn Generate trên browser');
  console.log('   Mỗi lần Generate = 1 token được lưu vào file cache');
  console.log('   App sẽ tự động dùng token đó thay vì tự generate\n');

  // Remove stale locks
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
      console.log(`[Warmup] Loaded ${cookies.length} cookies.`);
    } catch (e) { console.warn('[Warmup] Cookie fail:', e.message); }
  }

  const page = await context.newPage();
  let capturedCount = 0;

  // Intercept batchGenerateImages request → extract reCAPTCHA token
  context.on('request', request => {
    const url = request.url();
    if (url.includes('batchGenerateImages') || url.includes('aisandbox-pa.googleapis.com')) {
      try {
        const postData = request.postData();
        if (postData) {
          const parsed = JSON.parse(postData);
          const rcToken = parsed?.clientContext?.recaptchaContext?.token ||
                         parsed?.requests?.[0]?.clientContext?.recaptchaContext?.token;
          if (rcToken && rcToken.length > 100) {
            capturedCount++;
            console.log(`\n[Warmup] ✅ Token #${capturedCount} captured! (${rcToken.length} chars)`);
            saveTokenToCache(rcToken);
          }
        }
      } catch (_) {}
    }
  });

  context.on('response', async response => {
    const url = response.url();
    if (url.includes('batchGenerateImages') || url.includes('aisandbox-pa.googleapis.com')) {
      const status = response.status();
      if (status === 200) {
        console.log('[Warmup] ✅ Image generated successfully!');
      } else {
        console.log(`[Warmup] ⚠️ Response: ${status}`);
      }
    }
  });

  await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
    console.warn('[Warmup] Nav warning:', e.message);
  });

  console.log('[Warmup] ✅ Browser ready! URL:', page.url());
  console.log('[Warmup] Generate ảnh bất kỳ trên browser. Script sẽ capture token.\n');

  // Keep running indefinitely until Ctrl+C
  await new Promise(() => {}); // Block forever
}

main().catch(err => {
  console.error('[Warmup] Error:', err.message);
  process.exit(1);
});
