const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const baseDir = __dirname;
const userDataDir = path.join(baseDir, 'chrome-data');
const labsCookiePath = path.join(baseDir, 'labs.google.cookies.json');
const targetUrl = 'https://flow.google.com/project/8ac10c4a-44b5-4d55-b470-10ab24db4c1c';

// Xóa Singleton locks nếu có
try {
  if (fs.existsSync(userDataDir)) {
    for (const f of fs.readdirSync(userDataDir)) {
      if (f.startsWith('Singleton')) {
        try { fs.unlinkSync(path.join(userDataDir, f)); } catch (_) {}
      }
    }
  }
} catch (_) {}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('🚀 GOOGLE FLOW DIRECT LOGIN (CÁCH 1)');
console.log('═══════════════════════════════════════════════════════════════════');
console.log('📂 Profile: chrome-data');
console.log('⏳ Đang mở trình duyệt Chrome sạch (không load extension lạ)...');

(async () => {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    ignoreHTTPSErrors: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
    ]
  });

  const page = context.pages()[0] || await context.newPage();

  // Bắt các request eb1hJf để thông báo ngay khi tạo video
  context.on('response', async (res) => {
    const url = res.url();
    if (url.includes('eb1hJf')) {
      const status = res.status();
      const text = await res.text().catch(() => '');
      console.log(`\n🎬 [VIDEO RESP] Status: ${status}`);
      if (text.includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY')) {
        console.log('   ❌ Vẫn bị: PUBLIC_ERROR_UNUSUAL_ACTIVITY');
      } else if (status === 200) {
        console.log('   🎉 THÀNH CÔNG RỰC RỠ! Status 200 OK! Video đã được khởi tạo!');
        console.log('   Snippet: ' + text.slice(0, 300));
      }
    }
  });

  console.log(`🌐 Đang mở trang: ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('\n👉 HƯỚNG DẪN THAO TÁC TRÊN TRÌNH DUYỆT VỪA MỞ:');
  console.log('   1. Nếu chưa đăng nhập hoặc đang dùng tài khoản khác, bạn bấm nút Đăng nhập (Sign in) ở góc trên bên phải.');
  console.log('   2. Đăng nhập đúng tài khoản Google có gói ULTRA của bạn.');
  console.log('   3. Sau khi vào được trang Project, bạn nhập prompt và bấm [Generate Video] thử luôn trên cửa sổ này!');
  console.log('   4. Sau khi xong, bạn chỉ cần đóng cửa sổ trình duyệt lại, hệ thống sẽ tự động lưu toàn bộ cookies mới.\n');

  // Đợi người dùng đóng browser
  await new Promise(resolve => context.on('close', resolve));

  console.log('🏁 Trình duyệt đã đóng. Đang lưu cookies...');
  // Lưu cookies mới nhất
  const cookies = await context.cookies().catch(() => []);
  if (cookies.length > 0) {
    fs.writeFileSync(labsCookiePath, JSON.stringify(cookies, null, 2), 'utf8');
    console.log(`✅ Đã lưu ${cookies.length} cookies hợp lệ vào labs.google.cookies.json!`);
  }
})();
