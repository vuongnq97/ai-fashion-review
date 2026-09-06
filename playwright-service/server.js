process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
require('dotenv').config();
require('./utils/shop-context');
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
          console.log('[Telegram Bot] Gateway mode active. Forwarding Telegram events to n8n;');
        } else {
          console.log('[Telegram Bot] Telegram polling active. Listening for TikTok links & /upload...');
        }


      } catch (err) {
        console.error('Failed to start Telegram bot polling:', err.message);
      }
    }
  });
})();
