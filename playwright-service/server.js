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

// ─── Dọn dẹp các thư mục tạm khi khởi động server (> 24 giờ) ─────────────────
const storyboardRunsDir = path.join(__dirname, 'storyboard-review-runs');
if (fs.existsSync(storyboardRunsDir)) {
  try {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24h
    const entries = fs.readdirSync(storyboardRunsDir);
    let cleaned = 0;
    for (const entry of entries) {
      const entryPath = path.join(storyboardRunsDir, entry);
      try {
        const stat = fs.statSync(entryPath);
        if (now - stat.mtimeMs > maxAge) {
          fs.rmSync(entryPath, { recursive: true, force: true });
          cleaned++;
        }
      } catch (_) {}
    }
    if (cleaned > 0) {
      console.log(`🧹 [Startup] Đã dọn dẹp ${cleaned} thư mục storyboard-review-runs cũ (> 24h).`);
    }
  } catch (err) {
    console.warn('⚠️ [Startup] Không thể dọn dẹp storyboard-review-runs:', err.message);
  }
} else {
  fs.mkdirSync(storyboardRunsDir, { recursive: true });
}

// Ensure uploads dir exists (clean only stale temp uploads > 24h)
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

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
