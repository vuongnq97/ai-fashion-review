'use strict';

/**
 * TikTok Web Upload Service
 * Upload video sử dụng web session cookies (giống n8n-nodes-social-tiktok)
 * Không cần OAuth app — chỉ cần sessionid từ browser đã đăng nhập.
 *
 * Cách lấy cookies:
 * 1. Đăng nhập TikTok trên browser
 * 2. F12 → Application → Cookies → tiktok.com
 * 3. Copy sessionid, uid_tt, tt_csrf_token
 * 4. Lưu vào tiktok-accounts.json hoặc .env
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');
const FormData = require('form-data');

const ACCOUNTS_FILE = path.join(__dirname, '..', 'tiktok-accounts.json');

const httpClient = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  proxy: false,
  timeout: 60000,
});

// ── Load accounts ─────────────────────────────────────────────────────────────

function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[TikTokWeb] Error loading tiktok-accounts.json:', e.message);
  }
  return {};
}

function saveAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

/**
 * Lấy account config theo credentialId (dùng trong channels config)
 * @param {string} credentialId - e.g. "WIFMkBwL39jBHjxo"
 */
function getAccount(credentialId) {
  const accounts = loadAccounts();
  return accounts[credentialId] || null;
}

/**
 * Lưu/cập nhật account cookies
 * @param {string} credentialId 
 * @param {{ sessionid, uid_tt, tt_csrf_token, ...cookies }} cookieData
 */
function saveAccount(credentialId, cookieData) {
  const accounts = loadAccounts();
  accounts[credentialId] = {
    ...cookieData,
    updatedAt: new Date().toISOString(),
  };
  saveAccounts(accounts);
  console.log(`[TikTokWeb] ✅ Saved account: ${credentialId}`);
}

// ── Build cookie string ────────────────────────────────────────────────────────

function buildCookieString(cookieObj) {
  return Object.entries(cookieObj)
    .filter(([k]) => !['updatedAt', 'label', 'credentialName'].includes(k))
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

// ── Verify session is still valid ─────────────────────────────────────────────

async function verifySession(credentialId) {
  const account = getAccount(credentialId);
  if (!account) throw new Error(`Account ${credentialId} not found in tiktok-accounts.json`);

  const cookieStr = buildCookieString(account);
  const resp = await httpClient.get('https://www.tiktok.com/api/user/settings/', {
    params: { app_language: 'en', app_name: 'tiktok_web' },
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Cookie': cookieStr,
      'Referer': 'https://www.tiktok.com/',
    },
    validateStatus: () => true,
  });

  const data = resp.data;
  if (data?.statusCode === 0 && data?.data?.user?.uid) {
    console.log(`[TikTokWeb] ✅ Session valid for ${credentialId} — user: ${data.data.user.uniqueId}`);
    return true;
  }
  throw new Error(`Session expired or invalid for ${credentialId}`);
}

// ── Upload video via TikTok Creator Center API ────────────────────────────────

/**
 * Upload video lên TikTok dùng web session cookie.
 * @param {string} credentialId - ID trong channels config
 * @param {Buffer} videoBuffer - Video buffer
 * @param {object} options - { title, caption, privacy }
 * @returns {object} - { publishId, status }
 */
async function uploadVideoWithCookie(credentialId, videoBuffer, options = {}) {
  const account = getAccount(credentialId);
  if (!account) throw new Error(`Account ${credentialId} not found. Add cookies to tiktok-accounts.json first.`);

  const cookieStr = buildCookieString(account);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Cookie': cookieStr,
    'Referer': 'https://www.tiktok.com/creator-center/upload',
    'Origin': 'https://www.tiktok.com',
  };

  // Step 1: Init upload
  console.log(`[TikTokWeb] Step 1: Initializing upload for ${credentialId}...`);
  const videoSize = videoBuffer.length;

  const initResp = await httpClient.post(
    'https://www.tiktok.com/api/upload/v2/init/',
    {
      video_size: videoSize,
      chunk_size: videoSize,
      total_chunk_count: 1,
    },
    {
      headers: { ...headers, 'Content-Type': 'application/json' },
      params: { app_name: 'tiktok_web', channel: 'tiktok_web' },
      validateStatus: () => true,
    }
  );

  const initData = initResp.data;
  if (!initData?.uploadId && !initData?.upload_id) {
    console.warn('[TikTokWeb] Init response:', JSON.stringify(initData).slice(0, 200));
    throw new Error('Upload init failed: no uploadId returned');
  }

  const uploadId = initData.uploadId || initData.upload_id;
  console.log(`[TikTokWeb] Upload ID: ${uploadId}`);

  // Step 2: Upload chunk
  console.log('[TikTokWeb] Step 2: Uploading video chunk...');
  const form = new FormData();
  form.append('video', videoBuffer, {
    filename: 'video.mp4',
    contentType: 'video/mp4',
    knownLength: videoBuffer.length,
  });

  const uploadResp = await httpClient.post(
    `https://www.tiktok.com/api/upload/v2/chunk/?upload_id=${uploadId}&chunk_index=0`,
    form,
    {
      headers: { ...headers, ...form.getHeaders() },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    }
  );

  console.log('[TikTokWeb] Upload chunk response:', JSON.stringify(uploadResp.data).slice(0, 200));

  // Step 3: Publish
  console.log('[TikTokWeb] Step 3: Publishing video...');
  const caption = options.caption || options.title || '';
  const publishResp = await httpClient.post(
    'https://www.tiktok.com/api/video/publish/',
    {
      upload_id: uploadId,
      text: caption.slice(0, 2200),
      privacy_level: options.privacy || 'PUBLIC_TO_EVERYONE',
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
      video_uses_ai_generated_content: false,
    },
    {
      headers: { ...headers, 'Content-Type': 'application/json' },
      params: { app_name: 'tiktok_web', channel: 'tiktok_web' },
      validateStatus: () => true,
    }
  );

  const publishData = publishResp.data;
  console.log('[TikTokWeb] Publish response:', JSON.stringify(publishData).slice(0, 300));

  if (publishData?.statusCode !== 0 && publishData?.status_code !== 0) {
    throw new Error(`Publish failed: ${JSON.stringify(publishData)}`);
  }

  return {
    success: true,
    publishId: publishData.publishId || publishData.publish_id || uploadId,
    message: 'Video uploaded successfully',
  };
}

/**
 * Upload từ base64 string
 */
async function uploadVideoBase64WithCookie(credentialId, base64Video, options = {}) {
  const videoBuffer = Buffer.from(base64Video, 'base64');
  return uploadVideoWithCookie(credentialId, videoBuffer, options);
}

// ── List all accounts ────────────────────────────────────────────────────────

function listAccounts() {
  const accounts = loadAccounts();
  return Object.entries(accounts).map(([id, data]) => ({
    credentialId: id,
    label: data.label || id,
    sessionId: data.sessionid ? data.sessionid.slice(0, 8) + '...' : 'N/A',
    updatedAt: data.updatedAt || 'N/A',
  }));
}

module.exports = {
  getAccount,
  saveAccount,
  verifySession,
  uploadVideoWithCookie,
  uploadVideoBase64WithCookie,
  listAccounts,
  buildCookieString,
};
