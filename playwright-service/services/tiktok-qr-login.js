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

async function closeSessionContext(sessionObj, context) {
  try {
    if (context) await context.close();
    else if (sessionObj?.context) await sessionObj.context.close();
    else if (sessionObj?.browser) await sessionObj.browser.close();
  } catch (_) {}
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
    await closeSessionContext(session);
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

  const profileDir = path.resolve(baseDir, '.tiktok-login-profile');
  let context = null;

  try {
    console.log(`[TikTokQR] Launching persistent browser for chat ${key}...`);
    const launchOptions = {
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ],
      viewport: { width: 1280, height: 800 },
      locale: 'vi-VN',
      timezoneId: 'Asia/Ho_Chi_Minh'
    };

    try {
      // Dùng Google Chrome thật với profile lưu trữ để vượt qua cơ chế anti-bot của TikTok
      context = await chromium.launchPersistentContext(profileDir, {
        ...launchOptions,
        channel: 'chrome'
      });
    } catch (_) {
      context = await chromium.launchPersistentContext(profileDir, launchOptions);
    }
    sessionObj.context = context;

    if (sessionObj.isCancelled) {
      await context.close();
      return;
    }

    // Stealth: che giấu dấu vết automation để TikTok không giới hạn/block
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    const page = context.pages()[0] || await context.newPage();

    let hasNotifiedScanned = false;
    let qrConfirmed = false;

    // Lắng nghe trực tiếp API kiểm tra trạng thái QR của TikTok
    page.on('response', async res => {
      const url = res.url();
      if (url.includes('check_qrconnect')) {
        try {
          const text = await res.text();
          const json = JSON.parse(text);
          const data = json.data || {};
          const status = String(data.status || '').toLowerCase();
          const redirectUrl = data.redirect_url;

          if (json.message === 'success' || status) {
            console.log(`[TikTokQR] 📡 check_qrconnect status: "${status}" (redirect: ${Boolean(redirectUrl)}) for chat ${key}`);
            if ((status === 'scanned' || status === 'scan') && !hasNotifiedScanned) {
              hasNotifiedScanned = true;
              console.log(`[TikTokQR] 📱 Phone scanned QR code for chat ${key}! Waiting for confirmation button...`);
              if (typeof callbacks.onScanned === 'function') {
                callbacks.onScanned().catch(() => {});
              }
            } else if (status === 'confirmed' || status === 'confirm' || redirectUrl) {
              qrConfirmed = true;
              console.log(`[TikTokQR] 🎉 Login confirmed on phone for chat ${key}! Extracting session...`);
              if (redirectUrl) {
                console.log(`[TikTokQR] Navigating to redirect_url: ${redirectUrl}`);
                page.goto(redirectUrl).catch(() => {});
              }
            }
          }
        } catch (_) {}
      }
    });

    console.log(`[TikTokQR] Navigating directly to https://www.tiktok.com/login/qrcode for chat ${key}...`);
    await page.goto('https://www.tiktok.com/login/qrcode', { waitUntil: 'domcontentloaded', timeout: 35000 });

    if (sessionObj.isCancelled) {
      await context.close();
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
        await closeSessionContext(sessionObj, context);
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

    await closeSessionContext(sessionObj, context);
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
    await closeSessionContext(sessionObj, context);
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
