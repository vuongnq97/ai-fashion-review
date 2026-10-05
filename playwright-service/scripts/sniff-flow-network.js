'use strict';

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { chromium } = require('playwright');

const BASE_DIR = path.resolve(__dirname, '..');
const USER_DATA_DIR = path.join(BASE_DIR, 'chrome-data');
const COOKIE_FILE = path.join(BASE_DIR, 'labs.google.cookies.json');
const DEBUG_DIR = path.join(BASE_DIR, 'debug-network');
const PROJECT_URL = 'https://flow.google.com/project/8ac10c4a-44b5-4d55-b470-10ab24db4c1c';

if (!fs.existsSync(DEBUG_DIR)) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

const timestamp = Date.now();
const logFile = path.join(DEBUG_DIR, `sniff-${timestamp}.jsonl`);
const latestCallFile = path.join(DEBUG_DIR, 'latest-captured-request.json');

function logEntry(entry) {
  try {
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (e) {
    console.error('Failed to write log:', e.message);
  }
}

function saveLatestCaptured(data) {
  try {
    fs.writeFileSync(latestCallFile, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`\n💾 ĐÃ LƯU THÔNG TIN REQUEST VÀO: ${path.relative(BASE_DIR, latestCallFile)}\n`);
  } catch (e) {
    console.error('Failed to save latest capture:', e.message);
  }
}

// Clean up Chrome Singleton locks
try {
  if (fs.existsSync(USER_DATA_DIR)) {
    for (const f of fs.readdirSync(USER_DATA_DIR)) {
      if (f.startsWith('Singleton')) {
        try { fs.unlinkSync(path.join(USER_DATA_DIR, f)); } catch (_) {}
      }
    }
  }
} catch (_) {}

async function setupCDP(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');

    cdp.on('Network.requestWillBeSent', event => {
      const url = event.request.url;
      const isTarget = url.includes('aisandbox-pa') || url.includes('batchGenerate') || url.includes('flowMedia') || url.includes('recaptcha');
      if (isTarget) {
        console.log('\n' + '═'.repeat(75));
        console.log(`📡 [CDP REQUEST] ${event.request.method} ${url}`);
        console.log('--- HEADERS ---');
        for (const [k, v] of Object.entries(event.request.headers || {})) {
          console.log(`  ${k}: ${typeof v === 'string' && v.length > 200 ? v.substring(0, 100) + '...' : v}`);
        }
        if (event.request.postData) {
          console.log('--- POST DATA ---');
          try {
            const parsed = JSON.parse(event.request.postData);
            console.log(JSON.stringify(parsed, (k, val) => {
              if (k === 'token' && typeof val === 'string' && val.length > 60) return `${val.substring(0, 20)}...[${val.length} chars]`;
              if (k === 'imageBytes' && typeof val === 'string') return `[BASE64 ${val.length} chars]`;
              return val;
            }, 2));
            saveLatestCaptured({
              timestamp: new Date().toISOString(),
              method: event.request.method,
              url: event.request.url,
              headers: event.request.headers,
              postDataParsed: parsed,
              rawPostData: event.request.postData
            });
          } catch (_) {
            console.log(event.request.postData.substring(0, 1000));
          }
        }
        console.log('═'.repeat(75));

        logEntry({
          source: 'cdp',
          type: 'request',
          timestamp: new Date().toISOString(),
          method: event.request.method,
          url,
          headers: event.request.headers,
          postData: event.request.postData
        });
      }
    });

    cdp.on('Network.responseReceived', async event => {
      const url = event.response.url;
      const isTarget = url.includes('aisandbox-pa') || url.includes('batchGenerate') || url.includes('flowMedia');
      if (isTarget) {
        console.log('\n' + '─'.repeat(75));
        console.log(`📥 [CDP RESPONSE] Status ${event.response.status} (${event.response.statusText}): ${url}`);
        console.log('--- RESPONSE HEADERS ---');
        for (const [k, v] of Object.entries(event.response.headers || {})) {
          if (['content-type', 'access-control-allow-origin', 'date'].includes(k.toLowerCase())) {
            console.log(`  ${k}: ${v}`);
          }
        }
        try {
          const bodyObj = await cdp.send('Network.getResponseBody', { requestId: event.requestId }).catch(() => null);
          if (bodyObj && bodyObj.body) {
            console.log('--- RESPONSE BODY ---');
            console.log(bodyObj.body.substring(0, 1500));
            logEntry({
              source: 'cdp',
              type: 'response',
              timestamp: new Date().toISOString(),
              url,
              status: event.response.status,
              headers: event.response.headers,
              body: bodyObj.body
            });
          }
        } catch (e) {
          console.log(`(Could not read CDP response body: ${e.message})`);
        }
        console.log('─'.repeat(75));
      }
    });

    return cdp;
  } catch (err) {
    console.warn('[CDP Warning]', err.message);
    return null;
  }
}

async function main() {
  console.log('🚀 Đang khởi động trình duyệt Chrome thật (Non-Headless) với profile lưu trữ...');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled'
    ],
  });

  if (fs.existsSync(COOKIE_FILE)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
      await context.addCookies(cookies);
      console.log(`🍪 Đã nạp ${cookies.length} cookies.`);
    } catch (e) {
      console.warn('⚠️ Lỗi nạp cookies:', e.message);
    }
  }

  // Intercept via Playwright context
  context.on('request', request => {
    const url = request.url();
    if (url.includes('aisandbox-pa') || url.includes('batchGenerate') || url.includes('flowMedia')) {
      console.log(`\n🎯 [PW REQUEST] ${request.method()} ${url}`);
      logEntry({
        source: 'playwright',
        type: 'request',
        timestamp: new Date().toISOString(),
        method: request.method(),
        url,
        headers: request.headers(),
        postData: request.postData()
      });
    }
  });

  context.on('response', async response => {
    const url = response.url();
    if (url.includes('aisandbox-pa') || url.includes('batchGenerate') || url.includes('flowMedia')) {
      const status = response.status();
      console.log(`\n📬 [PW RESPONSE] HTTP ${status}: ${url}`);
      try {
        const text = await response.text();
        console.log(`   Preview: ${text.substring(0, 300)}`);
        logEntry({
          source: 'playwright',
          type: 'response',
          timestamp: new Date().toISOString(),
          url,
          status,
          headers: response.headers(),
          body: text
        });
      } catch (_) {}
    }
  });

  context.on('requestfailed', request => {
    const url = request.url();
    if (url.includes('aisandbox-pa') || url.includes('batchGenerate') || url.includes('flowMedia')) {
      console.error(`\n❌ [PW REQUEST FAILED] ${request.method()} ${url}:`, request.failure()?.errorText);
      logEntry({
        source: 'playwright',
        type: 'requestfailed',
        timestamp: new Date().toISOString(),
        method: request.method(),
        url,
        failure: request.failure()
      });
    }
  });

  const page = await context.newPage();
  await setupCDP(page);

  context.on('page', async newPage => {
    console.log(`📑 Mở tab mới: ${newPage.url()}`);
    await setupCDP(newPage);
  });

  console.log(`🌐 Đang mở Project Flow: ${PROJECT_URL}...`);
  try {
    await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err) {
    console.warn('⚠️ Điều hướng warning:', err.message);
  }

  console.log('\n' + '⭐'.repeat(30));
  console.log('✅ TRÌNH DUYỆT ĐÃ SẴN SÀNG TRÊN MÀN HÌNH CỦA BẠN!');
  console.log('👉 Bạn hãy thực hiện thao tác tạo ảnh (Generate Image) thật trên web.');
  console.log('👉 Toàn bộ Network Request, Headers, reCAPTCHA token & API Payload sẽ được ghi lại tự động.');
  console.log('👉 Khi hoàn tất, bạn có thể quay lại terminal nhấn ENTER hoặc báo lại Antigravity.');
  console.log('⭐'.repeat(30) + '\n');

  // Wait for user input or 15 minutes timeout
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      console.log('⏰ Hết thời gian chờ (15 phút).');
      rl.close();
      resolve();
    }, 15 * 60 * 1000);

    rl.question('Nhấn [ENTER] tại đây sau khi bạn đã thao tác xong để đóng trình duyệt...\n', () => {
      clearTimeout(timer);
      rl.close();
      resolve();
    });
  });

  await context.close().catch(() => {});
  console.log('🏁 Đã đóng trình duyệt. Sẵn sàng reverse engineer!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
