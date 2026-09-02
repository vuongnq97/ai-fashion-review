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
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(text)) {
      text = text.replace(regex, line);
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
  try {
    console.log('🔄 [AutoCookie] Đang tự động làm mới và trích xuất cookie Google/Gemini...');
    const chromeChannel = process.env.PLAYWRIGHT_CHROME_CHANNEL !== undefined ? (process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined) : 'chrome';
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: chromeChannel,
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        ...getExtensionArgs(baseDir),
      ],
      timeout: 20000,
    });

    const page = await context.newPage();
    // Điều hướng nhanh đến Gemini để làm mới session/timestamp cookie
    try {
      await page.goto('https://gemini.google.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (_) {
      // Dù timeout vẫn lấy được cookie từ profile chrome-data
    }

    const cookies = await context.cookies([
      'https://gemini.google.com',
      'https://accounts.google.com',
      'https://google.com',
    ]);

    const secure1psid = cookies.find(cookie => cookie.name === '__Secure-1PSID');
    const secure1psidts = cookies.find(cookie => cookie.name === '__Secure-1PSIDTS');

    if (secure1psid && secure1psid.value) {
      process.env.GEMINI_SECURE_1PSID = secure1psid.value;
      if (secure1psidts && secure1psidts.value) {
        process.env.GEMINI_SECURE_1PSIDTS = secure1psidts.value;
      }

      setEnvValue(envPath, 'GEMINI_SECURE_1PSID', secure1psid.value);
      setEnvValue(envPath, 'GEMINI_SECURE_1PSIDTS', secure1psidts ? secure1psidts.value : '');
      setEnvValue(envPath, 'GEMINI_COOKIE_PATH', './gemini-cookies');

      fs.mkdirSync(cookieDir, { recursive: true });
      const cookieFilePath = path.join(cookieDir, 'cookies.json');
      fs.writeFileSync(cookieFilePath, JSON.stringify(cookies, null, 2), 'utf8');

      clearCookieCache(cookieDir);
      console.log(`🍪 [AutoCookie] ✅ Đã tự động cập nhật ${cookies.length} cookies mới nhất vào .env & gemini-cookies/cookies.json!`);
      await context.close();
      return true;
    } else {
      console.warn('⚠️ [AutoCookie] Không tìm thấy __Secure-1PSID trong profile chrome-data (giữ nguyên cookie cũ từ .env).');
      await context.close();
      return false;
    }
  } catch (err) {
    console.warn('⚠️ [AutoCookie] Tự động trích xuất cookie gặp sự cố, sử dụng cookie đã lưu:', err.message);
    if (context) {
      try { await context.close(); } catch (_) {}
    }
    return false;
  }
}

module.exports = {
  autoExportCookies,
};
