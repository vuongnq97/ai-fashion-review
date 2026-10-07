const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');
const os = require('os');

const BASE_DIR = __dirname;
const ROOT_DIR = path.resolve(BASE_DIR, '..');
const ENV_PATH = path.join(BASE_DIR, '.env');
const ENV_EXAMPLE_PATH = path.join(BASE_DIR, '.env.example');

// --yes / -y: chạy không tương tác (tự chọn mặc định, bỏ qua bước nhập token/đăng nhập)
const NON_INTERACTIVE = process.argv.includes('--yes') || process.argv.includes('-y') || !process.stdin.isTTY;
// --sync-credentials: luôn ghi đè credentials n8n bằng tiktok-accounts.json + TELEGRAM_BOT_TOKEN
const FORCE_SYNC_CREDS = process.argv.includes('--sync-credentials');

function askQuestion(query) {
  if (NON_INTERACTIVE) {
    console.log(`${query}(auto)`);
    return Promise.resolve('');
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans.trim());
  }));
}

function hasCommand(cmd) {
  try {
    execSync(process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function findChrome() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32'
      ? [
        path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
      ]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  return candidates.find(p => p && fs.existsSync(p)) || null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function dockerDaemonUp() {
  try { sh('docker info --format "{{.ServerVersion}}"'); return true; } catch (_) { return false; }
}

const N8N_CONTAINER = process.env.N8N_CONTAINER_NAME || 'n8n';
const N8N_TIKTOK_NODE = 'n8n-nodes-social-tiktok';
const N8N_WORKFLOW_FILE = 'TIKTOK UPLOAD ONLY.json';
const N8N_WORKFLOW_NAME = 'TikTok Upload Only';

/**
 * Thiết lập n8n hoàn chỉnh qua Docker (idempotent, không bao giờ làm fail setup):
 *  1. Cài Docker (macOS qua Homebrew, có hỏi xác nhận) nếu chưa có
 *  2. Bật Docker daemon nếu đang tắt
 *  3. Khởi động container n8n (tái sử dụng container cũ nếu có, ngược lại docker compose)
 *  4. Cài community node n8n-nodes-social-tiktok
 *  5. Import workflow "TIKTOK UPLOAD ONLY" (bỏ qua nếu đã có)
 */
async function setupN8nDocker() {
  // 1. Docker CLI
  if (!hasCommand('docker')) {
    console.log('  ℹ️  Máy chưa cài Docker (chỉ cần cho n8n upload TikTok; bot tạo video không cần).');
    if (process.platform === 'darwin' && hasCommand('brew') && !NON_INTERACTIVE) {
      const ans = await askQuestion('   Cài Docker Desktop qua Homebrew ngay? (y/n, mặc định n): ');
      if (ans.toLowerCase().startsWith('y')) {
        try {
          execSync('brew install --cask docker', { stdio: 'inherit' });
        } catch (e) {
          console.warn('  ⚠️  Cài Docker thất bại:', e.message);
        }
      }
    }
    if (!hasCommand('docker')) {
      console.log('  👉 Cài Docker Desktop tại https://www.docker.com/products/docker-desktop/ rồi chạy lại setup.');
      return;
    }
  }

  // 2. Docker daemon
  if (!dockerDaemonUp()) {
    console.log('  ⏳ Docker daemon đang tắt → đang khởi động Docker Desktop...');
    try {
      if (process.platform === 'darwin') sh('open -a Docker');
      else if (process.platform === 'win32') sh('start "" "Docker Desktop"', { shell: 'cmd.exe' });
      else sh('sudo -n systemctl start docker');
    } catch (_) { }
    for (let i = 0; i < 45 && !dockerDaemonUp(); i++) await sleep(2000);
    if (!dockerDaemonUp()) {
      console.warn('  ⚠️  Docker daemon chưa sẵn sàng sau 90s. Mở Docker Desktop thủ công rồi chạy lại setup.');
      return;
    }
  }
  console.log('  ✅ Docker daemon đang chạy.');

  // 3. Container n8n
  let state = '';
  try { state = sh(`docker inspect -f "{{.State.Status}}" ${N8N_CONTAINER}`); } catch (_) { }
  try {
    if (state === 'running') {
      console.log(`  ✅ Container "${N8N_CONTAINER}" đang chạy.`);
    } else if (state) {
      console.log(`  ⏳ Container "${N8N_CONTAINER}" đang ở trạng thái "${state}" → docker start...`);
      sh(`docker start ${N8N_CONTAINER}`);
    } else if (fs.existsSync(path.join(ROOT_DIR, 'docker-compose.yml'))) {
      console.log('  ⏳ Tạo container n8n bằng docker compose...');
      const composeCmd = (() => { try { sh('docker compose version'); return 'docker compose'; } catch (_) { return 'docker-compose'; } })();
      execSync(`${composeCmd} up -d n8n`, { cwd: ROOT_DIR, stdio: 'inherit' });
    } else {
      console.warn('  ⚠️  Không tìm thấy docker-compose.yml ở thư mục gốc. Bỏ qua n8n.');
      return;
    }
  } catch (e) {
    console.warn('  ⚠️  Không khởi động được container n8n:', e.message);
    return;
  }

  // Chờ n8n trả lời HTTP
  let healthy = false;
  for (let i = 0; i < 30 && !healthy; i++) {
    try {
      const code = sh('curl -s -o /dev/null -w "%{http_code}" http://localhost:5678/healthz');
      healthy = code === '200';
    } catch (_) { }
    if (!healthy) await sleep(2000);
  }
  console.log(healthy ? '  ✅ n8n sẵn sàng tại http://localhost:5678' : '  ⚠️  n8n chưa trả lời /healthz (vẫn tiếp tục).');

  // 4. Community node TikTok
  try {
    let installed = false;
    try {
      sh(`docker exec ${N8N_CONTAINER} test -f /home/node/.n8n/nodes/node_modules/${N8N_TIKTOK_NODE}/package.json`);
      installed = true;
    } catch (_) { }
    if (installed) {
      console.log(`  ✅ Community node ${N8N_TIKTOK_NODE} đã cài.`);
    } else {
      console.log(`  ⏳ Cài community node ${N8N_TIKTOK_NODE} vào n8n...`);
      execSync(`docker exec ${N8N_CONTAINER} sh -c "mkdir -p /home/node/.n8n/nodes && cd /home/node/.n8n/nodes && ([ -f package.json ] || echo '{\\"name\\":\\"installed-nodes\\",\\"private\\":true}' > package.json) && npm install ${N8N_TIKTOK_NODE} --audit=false --fund=false --bin-links=false --install-strategy=shallow --ignore-scripts=true --package-lock=false --omit=dev"`, { stdio: 'inherit' });
      console.log('  🔄 Restart n8n để nạp node mới...');
      sh(`docker restart ${N8N_CONTAINER}`);
      await sleep(8000);
      console.log(`  ✅ Đã cài ${N8N_TIKTOK_NODE}.`);
    }
  } catch (e) {
    console.warn(`  ⚠️  Cài ${N8N_TIKTOK_NODE} thất bại (cài tay trong n8n → Settings → Community Nodes):`, e.message);
  }

  // 5. Import workflow
  const wfPath = path.join(ROOT_DIR, 'workflows', N8N_WORKFLOW_FILE);
  if (fs.existsSync(wfPath)) {
    try {
      let existing = '';
      try { existing = sh(`docker exec ${N8N_CONTAINER} n8n list:workflow`); } catch (_) { }
      if (existing.split('\n').some(l => l.includes(`|${N8N_WORKFLOW_NAME}`))) {
        console.log(`  ✅ Workflow "${N8N_WORKFLOW_NAME}" đã có trong n8n.`);
      } else {
        sh(`docker cp "${wfPath}" ${N8N_CONTAINER}:/tmp/tiktok-upload-only.json`);
        sh(`docker exec ${N8N_CONTAINER} n8n import:workflow --input=/tmp/tiktok-upload-only.json`);
        console.log(`  ✅ Đã import workflow "${N8N_WORKFLOW_NAME}".`);
      }
    } catch (e) {
      console.warn('  ⚠️  Import workflow tự động thất bại (thường do n8n chưa tạo owner). Import tay qua UI:', (e.stderr || e.message || '').toString().split('\n')[0]);
    }
  }

  // 6. Đẩy credentials (tiktok-accounts.json + TELEGRAM_BOT_TOKEN) vào n8n
  //    ID trong tiktok-accounts.json trùng với credential ID mà workflow tham chiếu.
  const accountsFile = path.join(BASE_DIR, 'tiktok-accounts.json');
  let needRestart = false;
  let credsImported = false;
  if (fs.existsSync(accountsFile)) {
    let existingTiktokCreds = -1;
    try {
      existingTiktokCreds = Number(sh(`docker exec ${N8N_CONTAINER} node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/home/node/.n8n/database.sqlite',{readOnly:true});console.log(db.prepare(\\"SELECT count(*) c FROM credentials_entity WHERE type='tiktokApi'\\").get().c)"`).split('\n').pop());
    } catch (_) { }

    let doImport = FORCE_SYNC_CREDS || existingTiktokCreds === 0;
    if (!doImport && existingTiktokCreds > 0) {
      console.log(`  ℹ️  n8n đã có ${existingTiktokCreds} credential TikTok.`);
      const ans = await askQuestion('   Ghi đè bằng dữ liệu trong tiktok-accounts.json? (y/n, mặc định n): ');
      doImport = ans.toLowerCase().startsWith('y');
      if (!doImport) console.log('  ⏭️  Giữ nguyên credentials hiện có (ép đồng bộ: node setup.js --sync-credentials).');
    }
    if (doImport) {
      console.log('  ⏳ Đẩy tiktok-accounts.json + Telegram token vào n8n credentials...');
      try {
        execSync('node import-credentials-to-n8n.js', {
          cwd: BASE_DIR,
          stdio: 'inherit',
          env: { ...process.env, N8N_CONTAINER_NAME: N8N_CONTAINER },
        });
        credsImported = true; // script đã tự restart n8n
      } catch (e) {
        console.warn('  ⚠️  Import credentials thất bại:', e.message);
      }
    }
  } else {
    console.log('  ℹ️  Không có playwright-service/tiktok-accounts.json → bỏ qua đẩy credentials.');
  }

  // 7. Publish (Active) workflow
  if (fs.existsSync(wfPath)) {
    try {
      const wfId = JSON.parse(fs.readFileSync(wfPath, 'utf8')).id;
      let isActive = false;
      try {
        isActive = sh(`docker exec ${N8N_CONTAINER} node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/home/node/.n8n/database.sqlite',{readOnly:true});const r=db.prepare('SELECT active FROM workflow_entity WHERE id=?').get('${wfId}');console.log(r&&r.active?1:0)"`).split('\n').pop() === '1';
      } catch (_) { }
      if (isActive) {
        console.log(`  ✅ Workflow "${N8N_WORKFLOW_NAME}" đã được publish (Active).`);
      } else {
        sh(`docker exec ${N8N_CONTAINER} n8n publish:workflow --id=${wfId}`);
        needRestart = true;
        console.log(`  ✅ Đã publish workflow "${N8N_WORKFLOW_NAME}" (id: ${wfId}).`);
      }
    } catch (e) {
      console.warn('  ⚠️  Publish workflow thất bại (bật Active thủ công trên UI):', (e.stderr || e.message || '').toString().split('\n')[0]);
    }
  }

  if (needRestart) {
    console.log('  🔄 Restart n8n để áp dụng...');
    try { sh(`docker restart ${N8N_CONTAINER}`); } catch (_) { }
  }

  console.log('  👉 Kiểm tra lại 1 lần trên UI http://localhost:5678:');
  console.log('     1. Tạo tài khoản owner (nếu là lần đầu).');
  if (!credsImported) console.log('     2. Credential TikTok/Telegram đã đúng (hoặc chạy: node setup.js --sync-credentials).');
  console.log(`     ${credsImported ? 2 : 3}. Workflow "${N8N_WORKFLOW_NAME}" đang Active.`);
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
  ensureDir(path.join(BASE_DIR, 'assets'));
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

  const geminiKeyMatch = envContent.match(/^GEMINI_API_KEY=(.*)$/m);
  if (!geminiKeyMatch || !geminiKeyMatch[1].trim()) {
    console.log('  ⚠️  GEMINI_API_KEY đang trống → phân tích sản phẩm/TTS sẽ không chạy. Điền vào playwright-service/.env.');
  }

  // 5b. Kiểm tra Google Chrome thật (Flow image gen cần Chrome thật mở CDP port 9222 để có reCAPTCHA score cao)
  console.log('\n🔎 Kiểm tra Google Chrome (bắt buộc cho tạo ảnh Flow / Nano Banana Pro)...');
  const chromePath = findChrome();
  if (chromePath) {
    console.log(`  ✅ Tìm thấy Chrome: ${chromePath}`);
    console.log('     Server sẽ tự mở Chrome thật với --remote-debugging-port=9222 khi cần.');
  } else {
    console.warn('  ⚠️  Không tìm thấy Google Chrome. Cài tại https://www.google.com/chrome/ (Chromium của Playwright dễ bị reCAPTCHA chặn).');
  }

  // 5c. ffmpeg: đã bundle qua ffmpeg-static, chỉ cảnh báo nếu thiếu cả hai
  try {
    require.resolve('ffmpeg-static', { paths: [BASE_DIR] });
    console.log('  ✅ ffmpeg-static sẵn sàng (ghép video).');
  } catch (_) {
    if (!hasCommand('ffmpeg')) console.warn('  ⚠️  Không tìm thấy ffmpeg. Chạy lại "npm install" trong playwright-service.');
  }

  // 5d. Proxy (tuỳ chọn)
  const proxyFile = path.join(BASE_DIR, 'assets', 'proxies.txt');
  if (fs.existsSync(proxyFile)) {
    console.log('  ✅ Tìm thấy danh sách proxy (assets/proxies.txt).');
  } else {
    console.log('  ℹ️  Không có proxy list → Proxy Bridge (127.0.0.1:8888) chạy DIRECT. (Tuỳ chọn: thêm assets/proxies.txt, mỗi dòng ip:port:user:pass)');
  }

  // 5e. Flow Captcha Worker (tuỳ chọn, port 9060) — engine tự fallback sang Chrome nếu không có
  const captchaDir = path.join(ROOT_DIR, 'flow-captcha-worker');
  if (fs.existsSync(path.join(captchaDir, 'package.json'))) {
    if (!fs.existsSync(path.join(captchaDir, 'node_modules'))) {
      console.log('\n🛡️  Cài dependencies cho flow-captcha-worker (tuỳ chọn)...');
      try {
        execSync('npm install', { cwd: captchaDir, stdio: 'inherit' });
      } catch (e) {
        console.warn('  ⚠️  Cài flow-captcha-worker thất bại (không bắt buộc):', e.message);
      }
    }
    console.log('  ✅ flow-captcha-worker có sẵn. Chạy song song: cd flow-captcha-worker && npm start');
  }

  // 5f. n8n qua Docker (dùng cho upload TikTok + gắn giỏ hàng)
  console.log('\n🐳 Thiết lập n8n qua Docker (upload TikTok qua workflow)...');
  await setupN8nDocker();

  // 6. Đăng nhập Google (Google Labs / Flow / Gemini)
  console.log('\n5️⃣  Đăng nhập tài khoản Google (Google Flow & Gemini)...');
  console.log('   Bạn có muốn mở trình duyệt ngay bây giờ để đăng nhập Google không? (y/n)');
  const loginAns = await askQuestion('   Lựa chọn (y/n, mặc định y): ');

  if (!NON_INTERACTIVE && (!loginAns || loginAns.toLowerCase().startsWith('y'))) {
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

  // 6b. Đăng nhập Google trong profile Chrome thật (CDP 9222) — profile RIÊNG, khác chrome-data.
  //     Flow tạo ảnh (Nano Banana Pro) chạy trong profile này; máy mới profile sẽ trống → phải login 1 lần.
  const cdpDataDir = process.env.CHROME_CDP_DATA_DIR
    || path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome-CDP');
  const cdpLoggedIn = ['Default/Cookies', 'Default/Network/Cookies']
    .some(p => fs.existsSync(path.join(cdpDataDir, p)));
  console.log('\n🌐 Profile Chrome thật cho Flow (CDP 9222):', cdpDataDir);
  if (cdpLoggedIn) {
    console.log('  ✅ Profile đã có dữ liệu (đã từng đăng nhập).');
  } else if (chromePath && !NON_INTERACTIVE) {
    const ans = await askQuestion('   Profile còn trống. Mở Chrome thật để đăng nhập Google Flow ngay? (y/n, mặc định y): ');
    if (!ans || ans.toLowerCase().startsWith('y')) {
      try {
        fs.mkdirSync(cdpDataDir, { recursive: true });
        const child = require('child_process').spawn(chromePath, [
          `--user-data-dir=${cdpDataDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          'https://labs.google/fx/tools/flow',
        ], { detached: true, stdio: 'ignore' });
        child.unref();
        await askQuestion('   👉 Đăng nhập Google trong cửa sổ Chrome vừa mở, vào được Flow thì ĐÓNG Chrome rồi nhấn ENTER: ');
        console.log('  ✅ Đã lưu session Google vào profile Chrome-CDP.');
      } catch (e) {
        console.warn('  ⚠️  Không mở được Chrome:', e.message);
      }
    }
  } else {
    console.log('  ℹ️  Profile còn trống → lần đầu server mở Chrome (port 9222), hãy đăng nhập Google Flow trong cửa sổ đó.');
  }

  // 7. Hoàn tất
  console.log('\n============================================================');
  console.log('🎉 SETUP HOÀN TẤT! BẠN ĐÃ SẴN SÀNG CHẠY BOT');
  console.log('============================================================');
  console.log('\nĐể khởi động server và bot, chạy lệnh sau:');
  console.log('  cd playwright-service');
  console.log('  npm start        (hoặc: node server.js)\n');
  console.log('Hoặc từ thư mục gốc:');
  console.log('  ./start.sh       (Windows: start.bat)\n');
}

main().catch((err) => {
  console.error('\n❌ Lỗi trong quá trình setup:', err);
  process.exit(1);
});
