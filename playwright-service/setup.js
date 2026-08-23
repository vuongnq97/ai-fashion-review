const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

const BASE_DIR = __dirname;
const ENV_PATH = path.join(BASE_DIR, '.env');
const ENV_EXAMPLE_PATH = path.join(BASE_DIR, '.env.example');

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans.trim());
  }));
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`  📁 Đã tạo thư mục: ${path.relative(BASE_DIR, dirPath) || dirPath}`);
  }
}

async function main() {
  console.log('\n============================================================');
  console.log('🚀 [AI Fashion Review] SETUP TỰ ĐỘNG CHO MÁY MỚI');
  console.log('============================================================\n');

  // 1. Kiểm tra Node.js version
  const nodeVersion = process.versions.node;
  const majorVersion = parseInt(nodeVersion.split('.')[0], 10);
  console.log(`📦 Node.js hiện tại: v${nodeVersion}`);
  if (majorVersion < 18) {
    console.warn('⚠️  Cảnh báo: Khuyến nghị sử dụng Node.js version 18+ hoặc 20+ để ổn định nhất.');
  }

  // 2. Tạo các thư mục cần thiết
  console.log('\n1️⃣  Khởi tạo các thư mục lưu trữ...');
  ensureDir(path.join(BASE_DIR, 'chrome-data'));
  ensureDir(path.join(BASE_DIR, 'gemini-cookies'));
  ensureDir(path.join(BASE_DIR, 'uploads'));
  ensureDir(path.join(BASE_DIR, 'storyboard-review-runs'));
  console.log('  ✅ Các thư mục dữ liệu đã sẵn sàng!');

  // 3. Cài đặt Yarn & dependencies
  console.log('\n2️⃣  Cài đặt các gói dependencies qua Yarn (yarn install)...');
  try {
    try {
      execSync('yarn --version', { stdio: 'ignore' });
    } catch (_) {
      console.log('  📦 Đang cài đặt Yarn toàn cục...');
      execSync('npm install -g yarn', { stdio: 'inherit' });
    }
    execSync('yarn install', { cwd: BASE_DIR, stdio: 'inherit' });
    console.log('  ✅ yarn install hoàn tất!');
  } catch (err) {
    console.warn('  ⚠️ Lỗi khi chạy yarn install, đang thử lại với npm install...', err.message);
    try {
      execSync('npm install', { cwd: BASE_DIR, stdio: 'inherit' });
      console.log('  ✅ npm install hoàn tất!');
    } catch (npmErr) {
      console.error('  ❌ Lỗi khi cài đặt dependencies:', npmErr.message);
      process.exit(1);
    }
  }

  // 4. Cài đặt Playwright Chromium
  console.log('\n3️⃣  Cài đặt Playwright Chromium Browser...');
  try {
    try {
      execSync('yarn playwright install chromium', { cwd: BASE_DIR, stdio: 'inherit' });
    } catch (_) {
      execSync('npx playwright install chromium', { cwd: BASE_DIR, stdio: 'inherit' });
    }
    console.log('  ✅ Playwright Chromium đã cài đặt thành công!');
  } catch (err) {
    console.error('  ❌ Lỗi khi cài đặt Playwright Chromium:', err.message);
    process.exit(1);
  }

  // 5. Cấu hình file .env
  console.log('\n4️⃣  Kiểm tra cấu hình file .env...');
  if (!fs.existsSync(ENV_PATH)) {
    if (fs.existsSync(ENV_EXAMPLE_PATH)) {
      fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
      console.log('  📄 Đã tạo file .env từ .env.example.');
    } else {
      fs.writeFileSync(ENV_PATH, 'PORT=3000\nTELEGRAM_BOT_TOKEN=\n');
      console.log('  📄 Đã tạo file .env mới.');
    }
  } else {
    console.log('  📄 Đã tìm thấy file .env hiện có.');
  }

  // Đọc nội dung .env
  let envContent = fs.readFileSync(ENV_PATH, 'utf8');
  const tokenMatch = envContent.match(/^TELEGRAM_BOT_TOKEN=(.*)$/m);
  const currentToken = tokenMatch ? tokenMatch[1].trim() : '';

  if (!currentToken || currentToken === 'your_telegram_bot_token') {
    console.log('\n👉 Vui lòng nhập TELEGRAM_BOT_TOKEN cho máy này (từ @BotFather):');
    const inputToken = await askQuestion('   Token: ');
    if (inputToken) {
      if (/^TELEGRAM_BOT_TOKEN=/m.test(envContent)) {
        envContent = envContent.replace(/^TELEGRAM_BOT_TOKEN=.*$/m, `TELEGRAM_BOT_TOKEN=${inputToken}`);
      } else {
        envContent += `\nTELEGRAM_BOT_TOKEN=${inputToken}\n`;
      }
      fs.writeFileSync(ENV_PATH, envContent, 'utf8');
      console.log('  ✅ Đã lưu TELEGRAM_BOT_TOKEN vào .env!');
    } else {
      console.log('  ⚠️  Chưa nhập token. Bạn có thể mở file .env để điền TELEGRAM_BOT_TOKEN sau.');
    }
  } else {
    console.log(`  ✅ TELEGRAM_BOT_TOKEN hiện tại: ${currentToken.substring(0, 10)}...`);
  }

  // 6. Đăng nhập Google (Google Labs / Flow / Gemini)
  console.log('\n5️⃣  Đăng nhập tài khoản Google (Google Flow & Gemini)...');
  console.log('   Bạn có muốn mở trình duyệt ngay bây giờ để đăng nhập Google không? (y/n)');
  const loginAns = await askQuestion('   Lựa chọn (y/n, mặc định y): ');

  if (!loginAns || loginAns.toLowerCase().startsWith('y')) {
    console.log('\n   🌐 Đang mở trình duyệt Google Labs & Gemini...');
    console.log('   👉 Hướng dẫn trong trình duyệt:');
    console.log('      1. Đăng nhập tài khoản Google của bạn.');
    console.log('      2. Vào https://labs.google.com/fx và https://gemini.google.com.');
    console.log('      3. Sau khi trang tải xong, đóng trình duyệt để hoàn tất lưu session.');
    console.log('------------------------------------------------------------\n');

    try {
      execSync('node login.js', { cwd: BASE_DIR, stdio: 'inherit' });
      console.log('\n  ✅ Session Google đã được lưu vào thư mục chrome-data!');
    } catch (err) {
      console.log('  ℹ️  Đã đóng trình duyệt đăng nhập.');
    }

    // Tự động trích xuất cookie ngay lập tức sau khi đăng nhập
    try {
      const { autoExportCookies } = require('./services/auto-cookie-exporter');
      await autoExportCookies(BASE_DIR);
    } catch (_) {}
  } else {
    console.log('  ℹ️  Bỏ qua bước đăng nhập. Bạn có thể chạy "node login.js" bất cứ lúc nào.');
  }

  // 7. Hoàn tất
  console.log('\n============================================================');
  console.log('🎉 SETUP HOÀN TẤT! BẠN ĐÃ SẴN SÀNG CHẠY BOT');
  console.log('============================================================');
  console.log('\nĐể khởi động server và bot, chạy lệnh sau:');
  console.log('  cd playwright-service');
  console.log('  node server.js\n');
  console.log('Hoặc từ thư mục gốc:');
  console.log('  npm start\n');
}

main().catch((err) => {
  console.error('\n❌ Lỗi trong quá trình setup:', err);
  process.exit(1);
});
