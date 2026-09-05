'use strict';

/**
 * tiktok-qr-login.js
 *
 * Quản lý phiên đăng nhập TikTok bằng mã QR thông qua Playwright.
 * - Mở trình duyệt Chromium tách biệt (isolated context)
 * - Truy cập trang đăng nhập QR của TikTok
 * - Chụp ảnh canvas mã QR gửi về cho Telegram
 * - Polling chờ người dùng quét và bấm xác nhận trên app TikTok
 * - Tự động trích xuất session cookies, lưu vào tiktok-accounts.json
 * - Cập nhật channel trong config.json cho chatId tương ứng
 */

const { chromium } = require('playwright');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { saveAccount } = require('./tiktok-web-upload');
const { updateChannelCredential, getChannelForChat } = require('../utils/config-manager');
const { syncShopToN8n } = require('./n8n-workflow-sync');

// Lưu trữ các phiên quét QR đang hoạt động: chatId -> session info
const activeQrSessions = new Map();

/**
 * Gọi API TikTok để lấy thông tin tài khoản (username, screen_name, user_id)
 * @param {object} cookiesMap
 * @returns {Promise<{ valid: boolean, username?: string, screenName?: string, userId?: string }>}
 */
async function fetchTikTokUserInfo(cookiesMap) {
  return new Promise((resolve) => {
    const cookieStr = Object.entries(cookiesMap)
      .filter(([k, v]) => typeof v === 'string' && v.trim())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    const req = https.request('https://www.tiktok.com/passport/web/account/info/', {
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 10000,
      headers: {
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.data && (json.data.user_id_str || json.data.username)) {
            resolve({
              valid: true,
              username: json.data.username || '',
              screenName: json.data.screen_name || json.data.username || '',
              userId: json.data.user_id_str || ''
            });
            return;
          }
        } catch (_) {}
        resolve({ valid: false });
      });
    });

    req.on('error', () => resolve({ valid: false }));
    req.on('timeout', () => { req.destroy(); resolve({ valid: false }); });
    req.end();
  });
}

/**
 * Hủy một phiên QR đang chạy nếu có
 * @param {string|number} chatId
 */
async function cancelSession(chatId) {
  const key = String(chatId);
  const session = activeQrSessions.get(key);
  if (session) {
    session.isCancelled = true;
    try {
      if (session.browser) await session.browser.close();
    } catch (_) {}
    activeQrSessions.delete(key);
    console.log(`[TikTokQR] Cancelled QR session for chat ${key}`);
  }
}

/**
 * Khởi chạy phiên quét mã QR TikTok cho một Telegram chat
 *
 * @param {string|number} chatId
 * @param {object} callbacks
 * @param {Function} callbacks.onQrReady   - async (qrBuffer) => void
 * @param {Function} callbacks.onSuccess   - async ({ username, screenName, credentialId, label }) => void
 * @param {Function} callbacks.onTimeout   - async () => void
 * @param {Function} callbacks.onError     - async (errorMessage) => void
 * @param {string}   [baseDir]
 */
async function startTikTokQrLoginSession(chatId, callbacks = {}, baseDir = path.resolve(__dirname, '..')) {
  const key = String(chatId);
  await cancelSession(key);

  const sessionObj = {
    chatId: key,
    browser: null,
    isCancelled: false,
    startedAt: Date.now()
  };
  activeQrSessions.set(key, sessionObj);

  try {
    console.log(`[TikTokQR] Launching browser for chat ${key}...`);
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });
    sessionObj.browser = browser;

    if (sessionObj.isCancelled) {
      await browser.close();
      return;
    }

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();

    console.log(`[TikTokQR] Navigating to https://www.tiktok.com/login for chat ${key}...`);
    await page.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2000);

    if (sessionObj.isCancelled) {
      await browser.close();
      return;
    }

    // Bấm nút "Use QR code"
    const qrBtn = page.getByText('Use QR code', { exact: true }).or(page.getByText('Sử dụng mã QR', { exact: true }));
    if (await qrBtn.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log(`[TikTokQR] Clicking "Use QR code" button for chat ${key}...`);
      await qrBtn.first().click();
    } else {
      console.log(`[TikTokQR] Navigating directly to /login/qrcode for chat ${key}...`);
      await page.goto('https://www.tiktok.com/login/qrcode', { waitUntil: 'domcontentloaded', timeout: 20000 });
    }

    await page.waitForTimeout(2000);

    if (sessionObj.isCancelled) {
      await browser.close();
      return;
    }

    // Chờ canvas QR hiển thị
    console.log(`[TikTokQR] Waiting for QR code canvas for chat ${key}...`);
    const qrCanvas = page.locator('canvas').first();
    await qrCanvas.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(500);

    // Chụp ảnh canvas mã QR
    const qrBuffer = await qrCanvas.screenshot();
    console.log(`[TikTokQR] ✅ Captured QR buffer (${qrBuffer.length} bytes) for chat ${key}`);

    // Gửi ảnh mã QR về cho Telegram
    if (typeof callbacks.onQrReady === 'function') {
      await callbacks.onQrReady(qrBuffer);
    }

    // ── Vòng lặp kiểm tra đăng nhập (tối đa 100 giây, mỗi 2s kiểm tra 1 lần) ──
    const MAX_WAIT_MS = 100000;
    const POLL_INTERVAL_MS = 2000;
    const startTime = Date.now();
    let loginSuccess = false;
    let savedAccountInfo = null;

    while (Date.now() - startTime < MAX_WAIT_MS) {
      if (sessionObj.isCancelled) {
        await browser.close();
        return;
      }

      await page.waitForTimeout(POLL_INTERVAL_MS);

      const cookies = await context.cookies();
      const sessionCookie = cookies.find(c => (c.name === 'sessionid' || c.name === 'sessionid_ss') && c.value);

      if (sessionCookie) {
        console.log(`[TikTokQR] 🎉 Detected sessionid cookie for chat ${key}! Verifying profile...`);

        // Đợi thêm 1s để các cookies liên quan tải đủ
        await page.waitForTimeout(1000);
        const finalCookies = await context.cookies();

        const cookieMap = {};
        for (const c of finalCookies) {
          cookieMap[c.name] = c.value;
        }

        // Lấy thông tin user
        const userInfo = await fetchTikTokUserInfo(cookieMap);
        const username = userInfo.username || 'tiktok_shop_user';
        const screenName = userInfo.screenName || username;
        const userId = userInfo.userId || '';

        // Tạo credentialId ngẫu nhiên 16 ký tự
        const credentialId = crypto.randomBytes(8).toString('hex');

        // Lấy label hiện tại của channel
        const currentChannel = getChannelForChat(baseDir, key);
        const channelLabel = currentChannel.label && currentChannel.label !== 'Shop Chính'
          ? currentChannel.label
          : `Shop @${username}`;

        const accountLabel = `${channelLabel} (@${username})`;

        // Lưu vào tiktok-accounts.json
        saveAccount(credentialId, {
          label: accountLabel,
          ...cookieMap,
          username,
          screenName,
          userId,
          updatedAt: new Date().toISOString()
        });

        // Cập nhật mapping trong config.json
        updateChannelCredential(baseDir, key, credentialId, accountLabel);

        // ── Đồng bộ tự động vào n8n (Solution 2: Credential + Workflow Nodes) ──
        let n8nSyncResult = null;
        try {
          console.log(`[TikTokQR] 🔄 Syncing account to n8n workflow for "${channelLabel}"...`);
          n8nSyncResult = await syncShopToN8n(credentialId, cookieMap, channelLabel);
          console.log(`[TikTokQR] ✅ n8n sync result:`, n8nSyncResult);
        } catch (n8nErr) {
          console.error(`[TikTokQR] ⚠️ Failed to sync to n8n:`, n8nErr.message);
          n8nSyncResult = { success: false, error: n8nErr.message };
        }

        loginSuccess = true;
        savedAccountInfo = {
          username,
          screenName,
          credentialId,
          label: channelLabel,
          n8nSync: n8nSyncResult
        };

        break;
      }
    }

    try {
      await browser.close();
    } catch (_) {}
    activeQrSessions.delete(key);

    if (loginSuccess && savedAccountInfo) {
      console.log(`[TikTokQR] ✅ Successfully linked TikTok @${savedAccountInfo.username} to chat ${key}`);
      if (typeof callbacks.onSuccess === 'function') {
        await callbacks.onSuccess(savedAccountInfo);
      }
    } else {
      console.log(`[TikTokQR] ⏱️ QR login timed out for chat ${key}`);
      if (typeof callbacks.onTimeout === 'function') {
        await callbacks.onTimeout();
      }
    }

  } catch (err) {
    console.error(`[TikTokQR] ❌ Error in QR login for chat ${key}:`, err.message);
    try {
      if (sessionObj.browser) await sessionObj.browser.close();
    } catch (_) {}
    activeQrSessions.delete(key);

    if (typeof callbacks.onError === 'function') {
      await callbacks.onError(err.message);
    }
  }
}

module.exports = {
  startTikTokQrLoginSession,
  cancelSession,
  fetchTikTokUserInfo
};
