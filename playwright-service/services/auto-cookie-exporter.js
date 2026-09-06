const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { getExtensionArgs } = require('../utils/extension-loader');

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

  if (!fs.existsSync(userDataDir)) {
    console.warn('ℹ️ [AutoCookie] Chưa có thư mục chrome-data, bỏ qua trích xuất cookie.');
    return false;
  }

  // Xóa file lock cũ nếu có
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

    // 1. Nếu services/browser.js đã có BrowserContext đang mở chrome-data, tái sử dụng luôn để không bị khoá profile
    try {
      const { getContext } = require('./browser');
      const existing = getContext();
      if (existing) {
        existing.pages(); // Kiểm tra context còn sống không
        context = existing;
        isSharedContext = true;
        console.log('🔄 [AutoCookie] Tái sử dụng BrowserContext đang mở để trích xuất cookie...');
      }
    } catch (_) {}

    // 2. Nếu chưa có context nào chạy, mới khởi chạy persistent context riêng
    if (!context) {
      const chromeChannel = process.env.PLAYWRIGHT_CHROME_CHANNEL !== undefined ? (process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined) : 'chrome';
      const isHeadless = process.env.HEADLESS === 'true';
      context = await chromium.launchPersistentContext(userDataDir, {
        channel: chromeChannel,
        headless: isHeadless,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
        ],
        timeout: 15000,
      });
    }

    page = await context.newPage();
    // Điều hướng nhanh đến Gemini & Labs Flow để làm mới session/timestamp cookie
    let isLoggedOut = false;
    try {
      await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 12000 });
      await page.waitForTimeout(2000);
      const geminiUrl = page.url() || '';
      if (
        geminiUrl.includes('accounts.google.com/signin') ||
        geminiUrl.includes('accounts.google.com/ServiceLogin') ||
        geminiUrl.includes('accounts.google.com/InteractiveLogin') ||
        geminiUrl.includes('accounts.google.com/v3/signin')
      ) {
        isLoggedOut = true;
      } else {
        // Chỉ coi là logged out nếu có nút/link đăng nhập rõ ràng (tránh nhầm SignOutOptions)
        const signInBtn = await page.$(
          'a[href*="ServiceLogin"], a[href*="/signin/challenge"], button:has-text("Sign in"), button:has-text("Đăng nhập")'
        ).catch(() => null);
        if (signInBtn) isLoggedOut = true;
      }
    } catch (_) {}

    if (isLoggedOut) {
      console.warn(`⚠️ [AutoCookie] Tài khoản Google đang ở trạng thái ĐĂNG XUẤT. Cần chạy "node login.js" để đăng nhập lại!`);
      if (page && !page.isClosed()) try { await page.close(); } catch (_) {}
      if (!isSharedContext && context) try { await context.close(); } catch (_) {}
      return false;
    }

    try {
      await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.waitForTimeout(2000);
    } catch (_) {}

    const currentUrl = page.url() || '';
    if (
      currentUrl.includes('accounts.google.com/signin') ||
      currentUrl.includes('accounts.google.com/ServiceLogin') ||
      currentUrl.includes('accounts.google.com/InteractiveLogin')
    ) {
      console.warn(`⚠️ [AutoCookie] Google đang yêu cầu đăng nhập (${currentUrl}). KHÔNG ghi đè cookie cũ!`);
      if (page && !page.isClosed()) try { await page.close(); } catch (_) {}
      if (!isSharedContext && context) try { await context.close(); } catch (_) {}
      return false;
    }

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
