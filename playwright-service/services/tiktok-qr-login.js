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
        } catch (_) { }
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
  } catch (_) { }
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
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-session-crashed-bubble',
        '--hide-crash-restore-bubble',
        '--disable-infobars'
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

    const page = context.pages()[0] || await context.newPage();

    let hasNotifiedScanned = false;
    let qrConfirmed = false;
    let isWaitingForOtp = false;

    // Hàm nhận và điền mã OTP 6 số do người dùng gửi từ Telegram
    sessionObj.submitOtp = async (code) => {
      const cleanCode = String(code).replace(/\D/g, '').trim();
      console.log(`[TikTokQR] 📥 Submitting 2FA code "${cleanCode}" for chat ${key}...`);
      try {
        const otpInput = page.locator('input[placeholder*="6"], input[placeholder*="digit"], input[maxlength="6"], input[type="text"]').first();
        if (!(await otpInput.isVisible().catch(() => false))) {
          return { success: false, error: 'Không tìm thấy ô nhập mã OTP trên màn hình TikTok.' };
        }

        await otpInput.click();
        await otpInput.fill('');
        await page.waitForTimeout(100);
        for (const char of cleanCode) {
          await page.keyboard.press(char);
          await page.waitForTimeout(50);
        }
        await page.waitForTimeout(400);

        // Bấm nút "Tiếp" / "Next" / Submit
        const nextBtn = page.locator('button:has-text("Tiếp"), button:has-text("Next"), button[type="submit"]').first();
        if (await nextBtn.isVisible().catch(() => false)) {
          await nextBtn.click();
          console.log(`[TikTokQR] Clicked "Tiếp" button for chat ${key}`);
        }

        // Đợi 2s xem có thông báo lỗi sai mã không
        await page.waitForTimeout(2000);
        const errEl = page.locator('text=/không chính xác|không đúng|incorrect|invalid|hết hạn|expired/i').first();
        if (await errEl.isVisible().catch(() => false)) {
          const errText = await errEl.innerText().catch(() => 'Mã xác minh không chính xác');
          return { success: false, error: errText };
        }

        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    };

    // Theo dõi điều hướng trang chính
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        const frameUrl = frame.url();
        console.log(`[TikTokQR] 🧭 Page navigated to: ${frameUrl}`);
      }
    });

    // Lắng nghe trực tiếp API kiểm tra trạng thái QR của TikTok
    page.on('response', async res => {
      const url = res.url();
      if (url.includes('check_qrconnect')) {
        try {
          const u = new URL(url);
          const text = await res.text();
          const json = JSON.parse(text);
          const data = json.data || {};
          const status = String(data.status || '').toLowerCase();
          const redirectUrl = data.redirect_url;

          if (json.message === 'success') {
            console.log(`[TikTokQR] 📡 [${u.hostname}] status: "${status}" (redirect: ${Boolean(redirectUrl)}) for chat ${key}`);

            if ((status === 'scanned' || status === 'scan') && !hasNotifiedScanned) {
              hasNotifiedScanned = true;
              console.log(`[TikTokQR] 📱 Phone scanned QR code for chat ${key}! Waiting for confirmation button...`);
              if (typeof callbacks.onScanned === 'function') {
                callbacks.onScanned().catch(() => { });
              }
            } else if (status === 'confirmed' || status === 'confirm' || redirectUrl) {
              qrConfirmed = true;
              console.log(`[TikTokQR] 🎉 Login confirmed on phone for chat ${key}! Extracting session...`);
              if (redirectUrl) {
                const fullRedirect = redirectUrl.startsWith('http') ? redirectUrl : new URL(redirectUrl, 'https://www.tiktok.com').href;
                console.log(`[TikTokQR] Navigating to redirect_url: ${fullRedirect}`);
                page.goto(fullRedirect).catch(e => console.log('[TikTokQR] Redirect note:', e.message));
              }
            }
          } else if (data.error_code) {
            console.log(`[TikTokQR] ⚠️ [${u.hostname}] check_qrconnect error: [code ${data.error_code}] ${data.description || json.message}`);
          }
        } catch (_) { }
      }

      // Bắt Set-Cookie header nếu TikTok trả về sessionid trực tiếp qua API
      try {
        const headers = res.headers();
        const setCookie = headers['set-cookie'];
        if (setCookie && (setCookie.includes('sessionid=') || setCookie.includes('sessionid_ss='))) {
          console.log(`[TikTokQR] 🎯 Detected sessionid in Set-Cookie header from ${res.url().substring(0, 50)}!`);
          qrConfirmed = true;
        }
      } catch (_) { }
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

    // ── Vòng lặp kiểm tra đăng nhập (tối đa 100 giây mặc định, tự động kéo dài nếu cần 2FA) ──
    let maxWaitMs = 100000;
    const POLL_INTERVAL_MS = 2000;
    const startTime = Date.now();
    let loginSuccess = false;
    let savedAccountInfo = null;

    while (Date.now() - startTime < maxWaitMs) {
      if (sessionObj.isCancelled) {
        await closeSessionContext(sessionObj, context);
        return;
      }

      await page.waitForTimeout(POLL_INTERVAL_MS);

      // 1. Kiểm tra xem có popup 2FA "Xác minh danh tính" (mã 6 số) xuất hiện không
      if (!isWaitingForOtp) {
        const otpInput = page.locator('input[placeholder*="6"], input[placeholder*="digit"], input[maxlength="6"]').first();
        const isOtpVisible = await otpInput.isVisible().catch(() => false);
        if (isOtpVisible) {
          isWaitingForOtp = true;
          sessionObj.waitingForOtp = true;

          let hint = '';
          try {
            const bodyText = await page.locator('body').innerText().catch(() => '');
            const emailMatch = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            const phoneMatch = bodyText.match(/\+?\d[\d\s*-]{7,}\d/);
            hint = emailMatch ? emailMatch[0] : (phoneMatch ? phoneMatch[0] : '');
          } catch (_) { }

          console.log(`[TikTokQR] 🔐 2FA verification modal detected for chat ${key}! Hint: ${hint}`);
          // Kéo dài thời gian timeout thêm 150 giây để người dùng có thời gian check mail và nhập
          maxWaitMs = (Date.now() - startTime) + 150000;

          if (typeof callbacks.onNeed2FA === 'function') {
            callbacks.onNeed2FA({ hint }).catch(() => { });
          }
        }
      }

      const currentUrl = page.url();
      const cookies = await context.cookies();
      const sessionCookie = cookies.find(c => (c.name === 'sessionid' || c.name === 'sessionid_ss') && c.value);

      // Nhận diện thành công khi: có sessionid HOẶC trang đã chuyển hướng ra khỏi trang login sau khi confirm
      if (sessionCookie || (qrConfirmed && !currentUrl.includes('/login') && currentUrl.includes('tiktok.com'))) {
        console.log(`[TikTokQR] 🎉 Detected session login for chat ${key}! (url: ${currentUrl}). Verifying profile...`);
        sessionObj.waitingForOtp = false;

        // Đợi thêm 1.5s để các cookies liên quan tải đủ
        await page.waitForTimeout(1500);
        const finalCookies = await context.cookies();

        const cookieMap = {};
        for (const c of finalCookies) {
          cookieMap[c.name] = c.value;
        }

        // Kiểm tra xem đã có sessionid trong cookieMap chưa
        if (!cookieMap['sessionid'] && !cookieMap['sessionid_ss']) {
          console.log(`[TikTokQR] ⏳ Waiting slightly more for sessionid to populate...`);
          await page.waitForTimeout(2000);
          const retryCookies = await context.cookies();
          for (const c of retryCookies) {
            cookieMap[c.name] = c.value;
          }
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

/**
 * Gửi mã xác minh OTP (6 chữ số) vào phiên đăng nhập TikTok đang chờ
 * @param {string|number} chatId
 * @param {string} otpCode
 * @returns {Promise<{ success: boolean, notFound?: boolean, error?: string }>}
 */
async function submitOtpForChat(chatId, otpCode) {
  const key = String(chatId);
  const session = activeQrSessions.get(key);
  if (!session || typeof session.submitOtp !== 'function') {
    return { success: false, notFound: true, error: 'Không tìm thấy phiên đăng nhập TikTok đang chờ mã OTP.' };
  }
  return session.submitOtp(otpCode);
}

/**
 * Kiểm tra xem phiên của chatId có đang đợi mã OTP không
 * @param {string|number} chatId
 * @returns {boolean}
 */
function isChatWaitingForOtp(chatId) {
  const key = String(chatId);
  const session = activeQrSessions.get(key);
  return Boolean(session && session.waitingForOtp);
}

module.exports = {
  startTikTokQrLoginSession,
  cancelSession,
  fetchTikTokUserInfo,
  submitOtpForChat,
  isChatWaitingForOtp
};
