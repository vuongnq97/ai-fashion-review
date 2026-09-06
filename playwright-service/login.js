const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { EXTENSION_ID, getExtensionArgs } = require('./utils/extension-loader');

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

async function waitForEnter(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

(async () => {
  const baseDir = __dirname;
  const userDataDir = path.join(baseDir, 'chrome-data');
  const envPath = path.join(baseDir, '.env');
  const cookieDir = path.join(baseDir, 'gemini-cookies');
  const labsCookiePath = path.join(baseDir, 'labs.google.cookies.json');

  // Xóa các lock file cũ nếu có
  try {
    if (fs.existsSync(userDataDir)) {
      for (const f of fs.readdirSync(userDataDir)) {
        if (f.startsWith('Singleton')) {
          try { fs.unlinkSync(path.join(userDataDir, f)); } catch (_) {}
        }
      }
    }
  } catch (_) {}

  console.log('----------------------------------------------------');
  console.log('🚀 Mở trình duyệt để bạn đăng nhập tài khoản Google.');
  console.log('   - Vui lòng chọn tài khoản và đăng nhập trên cả 2 tab: Google Labs & Gemini.');
  console.log('   - Sau khi đăng nhập xong, quay lại đây và nhấn phím ENTER.');
  console.log('----------------------------------------------------');

  const chromeChannel = process.env.PLAYWRIGHT_CHROME_CHANNEL !== undefined ? (process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined) : 'chrome';
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: chromeChannel,
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      ...getExtensionArgs(baseDir),
    ],
  });

  // Tab 1: Google Flow / Google Labs
  const flowPage = await context.newPage();
  console.log('🌐 Đang mở Google Labs Flow...');
  try {
    await flowPage.goto('https://labs.google/fx/tools/flow', { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    console.log(`⚠️ Lưu ý khi mở Flow: ${e.message}`);
  }

  // Tab 2: Gemini
  const geminiPage = await context.newPage();
  console.log('🌐 Đang mở Google Gemini...');
  try {
    await geminiPage.goto('https://gemini.google.com', { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    console.log(`⚠️ Lưu ý khi mở Gemini: ${e.message}`);
  }

  // Tab 3: Extension (tùy chọn, không bắt buộc)
  try {
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${EXTENSION_ID}/popup.html?skipIntro=1&tab=control-tab&mode=frame-to-video&defaults=1`, { timeout: 5000 });
    console.log('🧩 Đã mở extension Frame to Video.');
  } catch (_) {
    // Bỏ qua nếu Chrome chặn mở trực tiếp extension popup
  }

  console.log('\n👉 Bấm chọn tài khoản và hoàn tất đăng nhập trên trình duyệt vừa mở.');
  await waitForEnter('\n⌨️  Nhấn phím [ENTER] tại đây sau khi bạn đã đăng nhập thành công... ');

  console.log('\n📦 Đang trích xuất và lưu toàn bộ cookies mới nhất...');
  const cookies = await context.cookies();

  // 1. Lưu labs.google.cookies.json
  fs.writeFileSync(labsCookiePath, JSON.stringify(cookies, null, 2), 'utf8');
  console.log(`✅ Đã lưu ${cookies.length} cookies vào ${path.basename(labsCookiePath)}`);

  // 2. Lưu gemini-cookies/cookies.json
  fs.mkdirSync(cookieDir, { recursive: true });
  const geminiCookiePath = path.join(cookieDir, 'cookies.json');
  fs.writeFileSync(geminiCookiePath, JSON.stringify(cookies, null, 2), 'utf8');
  console.log(`✅ Đã lưu ${cookies.length} cookies vào ${path.basename(cookieDir)}/cookies.json`);

  // 3. Cập nhật .env với token mới
  const secure1psid = cookies.find(cookie => cookie.name === '__Secure-1PSID' && cookie.domain.includes('google.com'))
    || cookies.find(cookie => cookie.name === '__Secure-1PSID');
  const secure1psidts = cookies.find(cookie => cookie.name === '__Secure-1PSIDTS');

  setEnvValue(envPath, 'GEMINI_COOKIE_PATH', './gemini-cookies');
  console.log('✅ Đã cấu hình GEMINI_COOKIE_PATH=./gemini-cookies trong .env');

  const nextAuth = cookies.find(c => c.name === '__Secure-next-auth.session-token');
  if (nextAuth) {
    console.log('🎉 Google Labs Session Token: Hợp lệ!');
  } else {
    console.warn('⚠️ Chưa tìm thấy Google Labs session token, có thể bạn chưa bấm vào trang Labs.');
  }

  await context.close();
  console.log('\n✨ Hoàn tất đăng nhập! Bạn có thể bật lại server bằng lệnh: node server.js\n');
})().catch(error => {
  console.error(`❌ Lỗi login: ${error.message}`);
  process.exit(1);
});
