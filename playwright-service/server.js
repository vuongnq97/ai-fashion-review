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

// Ensure uploads dir exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

const path = require('path');
const https = require('https');
const http = require('http');

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
  
  // Start the direct Telegram bot update listener
  try {
    const { startTelegramBot } = require('./services/telegram-bot');
    startTelegramBot();
  } catch (err) {
    console.error('Failed to start Telegram bot polling:', err.message);
  }
});

