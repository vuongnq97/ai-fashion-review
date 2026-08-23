require('dotenv').config();
const express = require('express');
const fs = require('fs');
const cors = require('cors');
const morgan = require('morgan');
const apiRoutes = require('./routes/index');

// ─── CLI argument parsing ────────────────────────────────────────────────────
// Usage: node server.js -p 1
//   -p <folder>  Load images from local folder "p<folder>" instead of Telegram
const cliArgs = process.argv.slice(2);
const pIndex = cliArgs.indexOf('-p');
const pFolder = pIndex !== -1 && cliArgs[pIndex + 1] ? cliArgs[pIndex + 1] : null;
if (pFolder) {
  console.log(`📁 CLI mode: -p "${pFolder}" detected. Will load images from folder p${pFolder} instead of Telegram.`);
}
// ─────────────────────────────────────────────────────────────────────────────

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

server.listen(port, () => {
  console.log(`🚀 Playwright Automation Server listening on port ${port}`);

  if (pFolder) {
    // ─── -p mode: read images from local/Drive-synced folder ─────────────────
    const { runFromDriveFolder } = require('./services/drive-folder');
    console.log(`[Server] Starting drive-folder mode for folder: p${pFolder}`);
    runFromDriveFolder(pFolder, path.resolve(__dirname))
      .catch(err => console.error('[Server] Drive folder flow error:', err.message));
  } else {
    // ─── Normal mode: start Telegram bot long-polling ─────────────────────────
    try {
      const { startTelegramBot } = require('./services/telegram-bot');
      startTelegramBot();
    } catch (err) {
      console.error('Failed to start Telegram bot polling:', err.message);
    }
  }
});

