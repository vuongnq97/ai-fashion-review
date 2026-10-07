const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { getExtensionArgs } = require('../utils/extension-loader');
const { getWindowLaunchConfig, applyWindowBounds, ensureProfileWindowPlacement } = require('../utils/window-config');

function clearCookieCache(cookieDir) {
  if (!fs.existsSync(cookieDir)) return;
  try {
    const files = fs.readdirSync(cookieDir).filter(f => f.startsWith('.cached_cookies_') && f.endsWith('.json'));
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(cookieDir, file));
      } catch (_) {}
    }
  } catch (_) {}
}

function setEnvValue(envPath, key, value) {
  if (!fs.existsSync(envPath)) return;
  try {
    let text = fs.readFileSync(envPath, 'utf8');
    const line = `${key}=${value || ''}`;
    const regex = new RegExp(`^${key}=.*$`, 'gm');
    if (regex.test(text)) {
      let replaced = false;
      text = text.replace(regex, () => {
        if (!replaced) {
          replaced = true;
          return line;
        }
        return '';
      });
      text = text.replace(/\n{3,}/g, '\n\n');
    } else {
      text = text.replace(/\s*$/, '') + `\n${line}\n`;
    }
    fs.writeFileSync(envPath, text, 'utf8');
  } catch (_) {}
}

/**
 * Tự động làm mới và trích xuất cookie Gemini/Google từ chrome-data khi start server
 * 100% tự động, chạy ngầm (headless), không cần thao tác tay.
 */
async function autoExportCookies(baseDir = path.resolve(__dirname, '..')) {
  const userDataDir = path.join(baseDir, 'chrome-data');
  const envPath = path.join(baseDir, '.env');
  const cookieDir = path.join(baseDir, 'gemini-cookies');

  // Xóa file lock cũ nếu có thư mục chrome-data
  try {
    if (fs.existsSync(userDataDir)) {
      for (const f of fs.readdirSync(userDataDir)) {
        if (f.startsWith('Singleton')) {
          try { fs.unlinkSync(path.join(userDataDir, f)); } catch (_) {}
        }
      }
    }
  } catch (_) {}

  let context = null;
  let isSharedContext = false;
  let page = null;

  try {
    console.log('🔄 [AutoCookie] Đang tự động làm mới và trích xuất cookie Google/Gemini...');

    // 1. Tái sử dụng BrowserContext từ services/browser.js (CDP nếu Chrome thật đang chạy, hoặc persistent context)
    try {
      const { getSharedContext } = require('./browser');
      const shared = await getSharedContext(baseDir);
      if (shared) {
        context = shared;
        isSharedContext = true;
        console.log('🔄 [AutoCookie] Tái sử dụng BrowserContext từ browser service (CDP/Shared) để trích xuất cookie...');
      }
    } catch (_) {}

    // 2. Nếu chưa có context nào chạy và có chrome-data, mới khởi chạy persistent context riêng
    if (!context) {
      if (!fs.existsSync(userDataDir)) {
        console.warn('ℹ️ [AutoCookie] Chưa có thư mục chrome-data và Chrome CDP không chạy, bỏ qua.');
        return false;
      }
      const chromeChannel = process.env.PLAYWRIGHT_CHROME_CHANNEL !== undefined ? (process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined) : 'chrome';
      const isHeadless = process.env.AUTO_COOKIE_HEADLESS !== undefined
        ? process.env.AUTO_COOKIE_HEADLESS === 'true'
        : (process.env.HEADLESS === 'true');

      const winConfig = getWindowLaunchConfig(baseDir);
      ensureProfileWindowPlacement(userDataDir, winConfig);

      context = await chromium.launchPersistentContext(userDataDir, {
        channel: chromeChannel,
        headless: isHeadless,
        viewport: winConfig.viewport,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          ...winConfig.windowArgs,
          ...getExtensionArgs(baseDir),
        ],
        timeout: 15000,
      });

      if (!isHeadless) {
        await applyWindowBounds(context, winConfig);
      }
    }

    // Luôn tạo tab mới riêng biệt để làm mới session, tránh chiếm tab làm việc đang mở của user
    page = await context.newPage();

    // 1. Điều hướng đến Google Flow trước để kích hoạt và làm mới session SSO trên toàn bộ hệ thống Google
    let isLoggedOut = false;
    try {
      await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);
      const flowUrl = page.url() || '';
      if (
        flowUrl.includes('accounts.google.com/signin') ||
        flowUrl.includes('accounts.google.com/v3/signin') ||
        flowUrl.includes('accounts.google.com/InteractiveLogin')
      ) {
        isLoggedOut = true;
      }
    } catch (_) {}

    if (isLoggedOut) {
      console.warn(`⚠️ [AutoCookie] Google Flow yêu cầu đăng nhập. Cần chạy "node login.js" để đăng nhập lại!`);
      if (page && !page.isClosed()) try { await page.close(); } catch (_) {}
      if (!isSharedContext && context) try { await context.close(); } catch (_) {}
      return false;
    }

    // 2. Tiếp theo điều hướng đến Gemini để lấy session token SNlM0e & cập nhật cookie Gemini
    let geminiAuthed = false;
    try {
      await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);
      const geminiUrl = page.url() || '';
      
      const authInfo = await page.evaluate(() => {
        const snlm0e = window.WIZ_global_data?.SNlM0e;
        const profile = document.querySelector('a[aria-label*="Google Account"], img[alt*="Google Account"], a[href*="SignOutOptions"], button[aria-label*="Google Account"]');
        return {
          hasSnlm0e: Boolean(snlm0e),
          hasProfile: Boolean(profile)
        };
      }).catch(() => ({ hasSnlm0e: false, hasProfile: false }));

      if (authInfo.hasSnlm0e || authInfo.hasProfile || geminiUrl.includes('/app')) {
        geminiAuthed = true;
      }
    } catch (_) {}

    // Lấy toàn bộ cookies trong context để không bỏ sót các domain .google.com
    const cookies = await context.cookies();

    const secure1psid = cookies.find(cookie => cookie.name === '__Secure-1PSID' && cookie.domain.includes('google.com'))
      || cookies.find(cookie => cookie.name === '__Secure-1PSID');
    const secure1psidts = cookies.find(cookie => cookie.name === '__Secure-1PSIDTS');

    if (secure1psid && secure1psid.value) {
      process.env.GEMINI_SECURE_1PSID = secure1psid.value;
      if (secure1psidts && secure1psidts.value) {
        process.env.GEMINI_SECURE_1PSIDTS = secure1psidts.value;
      }

      setEnvValue(envPath, 'GEMINI_COOKIE_PATH', './gemini-cookies');

      fs.mkdirSync(cookieDir, { recursive: true });
      const cookieFilePath = path.join(cookieDir, 'cookies.json');
      fs.writeFileSync(cookieFilePath, JSON.stringify(cookies, null, 2), 'utf8');

      // Đồng bộ ra labs.google.cookies.json cho services/browser.js (Google Flow)
      const labsCookiePath = path.join(baseDir, 'labs.google.cookies.json');
      fs.writeFileSync(labsCookiePath, JSON.stringify(cookies, null, 2), 'utf8');

      clearCookieCache(cookieDir);
      console.log(`🍪 [AutoCookie] ✅ Đã tự động cập nhật ${cookies.length} cookies mới nhất vào gemini-cookies & labs.google.cookies.json!`);
      if (page && !page.isClosed()) try { await page.close(); } catch (_) {}
      if (!isSharedContext && context) try { await context.close(); } catch (_) {}
      return true;
    } else {
      console.warn('⚠️ [AutoCookie] Không tìm thấy __Secure-1PSID trong profile chrome-data (giữ nguyên cookie cũ từ .env).');
      if (page && !page.isClosed()) try { await page.close(); } catch (_) {}
      if (!isSharedContext && context) try { await context.close(); } catch (_) {}
      return false;
    }
  } catch (err) {
    console.warn('⚠️ [AutoCookie] Tự động trích xuất cookie gặp sự cố, sử dụng cookie đã lưu:', err.message);
    if (page && !page.isClosed()) {
      try { await page.close(); } catch (_) {}
    }
    if (!isSharedContext && context) {
      try { await context.close(); } catch (_) {}
    }
    return false;
  }
}

module.exports = {
  autoExportCookies,
};
