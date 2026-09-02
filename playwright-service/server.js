process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const cors = require('cors');
const morgan = require('morgan');
const apiRoutes = require('./routes/index');



const app = express();
const port = 3000;

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'ngrok-skip-browser-warning']
}));
app.use(morgan('dev'));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const path = require('path');
const https = require('https');
const http = require('http');

// ─── Dọn dẹp các thư mục tạm khi khởi động server ───────────────────────────
const storyboardRunsDir = path.join(__dirname, 'storyboard-review-runs');
if (fs.existsSync(storyboardRunsDir)) {
  try {
    fs.rmSync(storyboardRunsDir, { recursive: true, force: true });
    console.log('🧹 [Startup] Đã xóa dọn sạch thư mục storyboard-review-runs cũ.');
  } catch (err) {
    console.warn('⚠️ [Startup] Không thể xóa storyboard-review-runs:', err.message);
  }
}
fs.mkdirSync(storyboardRunsDir, { recursive: true });

// Ensure clean uploads dir exists
const uploadsDir = path.join(__dirname, 'uploads');
if (fs.existsSync(uploadsDir)) {
  try {
    fs.rmSync(uploadsDir, { recursive: true, force: true });
    console.log('🧹 [Startup] Đã xóa dọn sạch thư mục uploads tạm cũ.');
  } catch (err) {
    console.warn('⚠️ [Startup] Không thể xóa uploads:', err.message);
  }
}
fs.mkdirSync(uploadsDir, { recursive: true });

app.use('/api', apiRoutes);

const keyPath = path.join(__dirname, 'key.pem');
const certPath = path.join(__dirname, 'cert.pem');
let server;

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  const options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
  server = https.createServer(options, app);
  console.log(`🔒 SSL Certificates found. Starting server in HTTPS mode.`);
} else {
  server = http.createServer(app);
  console.log(`🔓 SSL Certificates not found. Starting server in HTTP mode.`);
}

(async () => {
  // ─── Chạy export-gemini-cookies.js trước, chờ tối đa 10s ────────────────
  await new Promise((resolve) => {
    console.log('🍪 [Startup] Đang chạy export-gemini-cookies.js (chờ tối đa 10s)...');
    const { spawn } = require('child_process');
    const cookieProc = spawn(process.execPath, [
      path.join(__dirname, 'export-gemini-cookies.js')
    ], {
      stdio: 'inherit',
      cwd: __dirname,
      env: { ...process.env },
    });

    const timeout = setTimeout(() => {
      console.log('⏱️  [Startup] export-gemini-cookies.js đã chạy đủ 10s, tiếp tục khởi động server...');
      cookieProc.kill('SIGTERM');
      resolve();
    }, 10000);

    cookieProc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        console.log('✅ [Startup] export-gemini-cookies.js hoàn thành.');
      } else if (code !== null) {
        console.warn(`⚠️ [Startup] export-gemini-cookies.js thoát với code ${code}.`);
      }
      resolve();
    });

    cookieProc.on('error', (err) => {
      clearTimeout(timeout);
      console.warn('⚠️ [Startup] Không thể chạy export-gemini-cookies.js:', err.message);
      resolve();
    });
  });

  // ─── Tự động làm mới và xuất cookie Google/Gemini từ chrome-data ──────────
  try {
    const { autoExportCookies } = require('./services/auto-cookie-exporter');
    await autoExportCookies(__dirname);
    // Đánh dấu đã export xong — schedulers sẽ bỏ qua trong 45 phút tới
    const { markExportedNow } = require('./services/gemini-cookie-refresher');
    markExportedNow();
  } catch (err) {
    console.warn('⚠️ [Startup] Auto-cookie export skipped:', err.message);
  }

  server.listen(port, () => {
    console.log(`🚀 Playwright Automation Server listening on port ${port}`);

    if (String(process.env.TELEGRAM_POLLING_DISABLED || '').toLowerCase() === 'true') {
      console.log('[Telegram Bot] TELEGRAM_POLLING_DISABLED=true; Telegram polling is disabled.');
    } else {
      try {
        const { startTelegramBot } = require('./services/telegram-bot');
        startTelegramBot();
        if (String(process.env.N8N_ORCHESTRATION || '').toLowerCase() === 'true') {
          console.log('[Telegram Bot] Gateway mode active. Forwarding Telegram events to n8n; legacy /upload folder flow is disabled.');
        } else {
          console.log('[Telegram Bot] Telegram polling active. Listening for TikTok links & /upload...');
        }

        // ─── Đăng ký command menu với Telegram ──────────────────────────────
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (botToken) {
          const https = require('https');
          const commands = [
            { command: 'auto_t3',    description: '🤖 Tự động chạy template3 theo lịch config (Men Shop)' },
            { command: 'auto_t4',    description: '👠 Tự động chạy template4 theo lịch config (Lady Shop)' },
            { command: 'auto_t5',    description: '🏠 Tự động chạy template5_2 theo lịch config (Gia dụng)' },
            { command: 'template3',  description: '🏬 Review shop 3 cảnh (8s+4s+8s), không voice-over' },
            { command: 'template4',  description: '👠 Review giày/dép nữ pastel 4 cảnh (8s,6s,4s,8s)' },
            { command: 'template5',  description: '✨ Review đa ngành 4 cảnh 6s (có chữ tiếng Việt)' },
            { command: 'template5_1',description: '💎 Review đa ngành 4 cảnh 6s (KHÔNG CHỮ)' },
            { command: 'template5_2',description: '🎙️ Review đa ngành 4 cảnh 6s (KHÔNG CHỮ + VOICE-OVER)' },
            { command: 'template6',  description: '🛒 Review siêu thị POV 2 cảnh 8s' },
            { command: 'template1',  description: '👟 Review faceless 2 cảnh, không voice-over' },
            { command: 'template2',  description: '👟 Review 8 cảnh, mỗi cảnh 4s, không voice-over' },
            { command: 'upload',     description: '🚀 Đăng video review hoàn chỉnh lên TikTok' },
            { command: 'remake',     description: '🔄 Tạo lại cảnh chưa ưng ý (VD: /remake 2)' },
            { command: 'chatid',     description: '🔑 Xem Chat ID và kênh TikTok của group này' },
            { command: 'status',     description: '📊 Xem trạng thái hàng đợi xử lý' },
            { command: 'dailyvlog',  description: '🎬 Tạo daily vlog lifestyle' },
          ];
          const body = JSON.stringify({ commands });
          const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${botToken}/setMyCommands`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            rejectUnauthorized: false,
          }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
              try {
                const result = JSON.parse(data);
                if (result.ok) console.log(`[Telegram Bot] ✅ Đã đăng ký ${commands.length} commands vào menu bot.`);
                else console.warn('[Telegram Bot] ⚠️ setMyCommands failed:', result.description);
              } catch (_) {}
            });
          });
          req.on('error', () => {});
          req.write(body);
          req.end();
        }
      } catch (err) {
        console.error('Failed to start Telegram bot polling:', err.message);
      }
    }
  });
})();
