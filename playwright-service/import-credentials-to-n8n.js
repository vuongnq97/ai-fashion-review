/**
 * import-credentials-to-n8n.js
 * Tự động mã hoá và import toàn bộ credentials Telegram và TikTok Shop
 * từ .env và tiktok-accounts.json vào n8n SQLite.
 *
 * - tiktokSession được dựng ĐẦY ĐỦ theo chuẩn n8n-nodes-social-tiktok
 *   ({ http: {type,url,method,timestamp,headers,params,cookies,body}, ws: {...} }).
 *   Nếu trong n8n có sẵn 1 credential tiktokApi "chuẩn" (tạo từ UI), nó được dùng làm
 *   template cho các field phụ thuộc thiết bị (device_id, access_key, headers...).
 * - shared_credentials dùng role 'credential:owner' (role hợp lệ của n8n).
 *
 * Usage: node import-credentials-to-n8n.js [--template <credentialId>]
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const ACCOUNTS_FILE = path.join(__dirname, 'tiktok-accounts.json');
const CONTAINER = process.env.N8N_CONTAINER_NAME || 'n8n';

const accounts = fs.existsSync(ACCOUNTS_FILE)
  ? JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'))
  : {};

const tplArgIdx = process.argv.indexOf('--template');
const templateId = tplArgIdx > -1 ? process.argv[tplArgIdx + 1] : (process.env.N8N_TIKTOK_TEMPLATE_CRED_ID || 'waMts0FrkIYhCuzv');

const payload = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  accounts,
  templateId
};

// Ghi payload ra file tạm
const payloadPath = path.join(__dirname, 'scratch_payload.json');
fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2), 'utf8');

// Script chạy bên trong container n8n
const containerScript = `
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const payload = JSON.parse(fs.readFileSync('/tmp/creds_payload.json', 'utf8'));
const config = JSON.parse(fs.readFileSync('/home/node/.n8n/config', 'utf8'));
const encryptionKey = config.encryptionKey;

function evpKey(password, salt) {
  let keyAndIv = Buffer.alloc(0);
  let currentHash = Buffer.alloc(0);
  while (keyAndIv.length < 48) {
    currentHash = crypto.createHash('md5').update(currentHash).update(password).update(salt).digest();
    keyAndIv = Buffer.concat([keyAndIv, currentHash]);
  }
  return { key: keyAndIv.subarray(0, 32), iv: keyAndIv.subarray(32, 48) };
}
function encryptOpenSSL(plainText, password) {
  const salt = crypto.randomBytes(8);
  const { key, iv } = evpKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const cipherText = Buffer.concat([cipher.update(Buffer.from(plainText, 'utf8')), cipher.final()]);
  return Buffer.concat([Buffer.from('Salted__', 'utf8'), salt, cipherText]).toString('base64');
}
function decryptOpenSSL(b64, password) {
  const buf = Buffer.from(b64, 'base64');
  const { key, iv } = evpKey(password, buf.subarray(8, 16));
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([d.update(buf.subarray(16)), d.final()]).toString('utf8');
}

const db = new DatabaseSync('/home/node/.n8n/database.sqlite');

const project = db.prepare("SELECT id FROM project WHERE type = 'personal' LIMIT 1").get();
if (!project) {
  console.error('Không tìm thấy personal project trong n8n!');
  process.exit(1);
}
const projectId = project.id;
const NOW = "STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')";

function upsertCredential(id, name, type, encData) {
  const exists = db.prepare('SELECT id FROM credentials_entity WHERE id = ?').get(id);
  if (exists) {
    db.prepare('UPDATE credentials_entity SET name = ?, type = ?, data = ?, updatedAt = ' + NOW + ' WHERE id = ?')
      .run(name, type, encData, id);
  } else {
    db.prepare('INSERT INTO credentials_entity (id, name, data, type, isManaged, isGlobal, isResolvable, resolvableAllowFallback, usageScope, createdAt, updatedAt) ' +
      "VALUES (?, ?, ?, ?, 0, 0, 0, 0, 'project', " + NOW + ', ' + NOW + ')')
      .run(id, name, encData, type);
  }
  // Fix role: n8n chỉ chấp nhận 'credential:owner' / 'credential:user'
  db.prepare('DELETE FROM shared_credentials WHERE credentialsId = ?').run(id);
  db.prepare("INSERT INTO shared_credentials (credentialsId, projectId, role, createdAt, updatedAt) VALUES (?, ?, 'credential:owner', " + NOW + ', ' + NOW + ')')
    .run(id, projectId);
}

// ---------- Template (credential tạo chuẩn từ UI) ----------
let tpl = null;
try {
  const row = db.prepare("SELECT data FROM credentials_entity WHERE id = ? AND type = 'tiktokApi'").get(payload.templateId);
  if (row) {
    const d = JSON.parse(decryptOpenSSL(row.data, encryptionKey));
    const s = typeof d.tiktokSession === 'string' ? JSON.parse(d.tiktokSession) : d.tiktokSession;
    if (s && s.http && s.http.headers && s.http.params) tpl = s;
  }
} catch (e) { console.error('⚠️ Không đọc được template:', e.message); }
console.log(tpl ? '📐 Dùng template từ credential ' + payload.templateId : '📐 Không có template, dùng mặc định');

const UA = (tpl && tpl.http.headers['User-Agent']) ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const NON_COOKIE = ['label', 'updatedAt', 'userId', 'user_id', 'username', 'screenName', 'credentialName', 'id', 'name', 'nickname'];

function buildSession(acc) {
  const cookies = {};
  for (const [k, v] of Object.entries(acc)) {
    if (NON_COOKIE.includes(k) || typeof v !== 'string') continue;
    cookies[k] = v.trim();
  }
  let userId = acc.userId || acc.user_id || '';
  if (!userId && cookies.multi_sids) {
    const m = decodeURIComponent(cookies.multi_sids).match(/^(\\d+):/);
    if (m) userId = m[1];
  }
  const cookieStr = Object.entries(cookies).map(([k, v]) => k + '=' + v).join('; ');
  const ts = new Date().toISOString();

  // ----- HTTP -----
  const baseHttpUrl = tpl ? tpl.http.url.split('?')[0] : 'https://www.tiktok.com/api/user/settings/';
  const params = Object.assign({
    WebIdLastTime: String(Math.floor(Date.now() / 1000)),
    aid: '1988', app_language: 'en', app_name: 'tiktok_web', browser_language: 'en-US',
    browser_name: 'Mozilla', browser_online: 'true', browser_platform: 'MacIntel',
    browser_version: UA.replace(/^Mozilla\\//, ''), channel: 'tiktok_web', cookie_enabled: 'true',
    data_collection_enabled: 'true', device_id: '7681919433773811201', device_platform: 'web_pc',
    focus_state: 'true', from_page: 'fyp', history_len: '2', is_fullscreen: 'false',
    is_page_visible: 'true', os: 'mac', priority_region: 'VN', referer: '', region: 'VN',
    root_referer: 'https://www.tiktok.com/', screen_height: '900', screen_width: '1440',
    tz_name: 'Asia/Saigon', user_is_login: 'true', webcast_language: 'en'
  }, tpl ? tpl.http.params : {});
  // Ghi đè các tham số phụ thuộc tài khoản
  params.odinId = userId;
  params.user_id = userId;
  params.verifyFp = cookies.s_v_web_id || '';
  params.msToken = cookies.msToken || '';
  // Bỏ chữ ký request của template (gắn với tài khoản/URL cũ)
  delete params['X-Bogus']; delete params['X-Gnarly']; delete params['X-Dynosaur'];

  const httpHeaders = Object.assign({
    'User-Agent': UA,
    'Accept': '*/*',
    'Referer': 'https://www.tiktok.com/',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9'
  }, tpl ? tpl.http.headers : {});
  httpHeaders.Cookie = cookieStr;

  const http = {
    type: 'xmlhttprequest',
    url: baseHttpUrl + '?' + new URLSearchParams(params).toString(),
    method: 'GET',
    timestamp: ts,
    headers: httpHeaders,
    params,
    cookies,
    body: null
  };

  // ----- WS -----
  const wsCookieKeys = tpl ? Object.keys(tpl.ws.cookies) : Object.keys(cookies);
  const wsCookies = {};
  for (const k of wsCookieKeys) if (cookies[k] !== undefined) wsCookies[k] = cookies[k];
  const wsCookieStr = Object.entries(wsCookies).map(([k, v]) => k + '=' + v).join('; ');
  const ttwidDecoded = cookies.ttwid ? decodeURIComponent(cookies.ttwid) : '';
  const wsParams = Object.assign({ aid: '1459', fpid: '9', access_key: '', device_platform: 'web' }, tpl ? tpl.ws.params : {});
  wsParams.ttwid = ttwidDecoded;
  wsParams['Web-Sdk-Ms-Token'] = cookies.msToken || '';
  const wsBase = tpl ? tpl.ws.url.split('?')[0] : 'wss://im-ws-sg.tiktok.com/ws/v2';
  const wsHeaders = Object.assign({
    'User-Agent': UA, 'Upgrade': 'websocket', 'Connection': 'Upgrade',
    'Origin': 'https://www.tiktok.com', 'Sec-WebSocket-Version': '13',
    'Accept-Encoding': 'gzip, deflate, br, zstd', 'Accept-Language': 'en-US,en;q=0.9'
  }, tpl ? tpl.ws.headers : {});
  wsHeaders.Cookie = wsCookieStr;

  const ws = {
    type: 'websocket',
    url: wsBase + '?' + new URLSearchParams(wsParams).toString(),
    method: 'GET',
    timestamp: ts,
    headers: wsHeaders,
    params: wsParams,
    cookies: wsCookies,
    body: null
  };

  return { session: { http, ws }, userId, cookieCount: Object.keys(cookies).length };
}

let count = 0;

// 1. Telegram Credential (id: Cu3VpvmssPyMCFeo)
if (payload.telegramToken) {
  const tgEnc = encryptOpenSSL(JSON.stringify({ accessToken: payload.telegramToken }), encryptionKey);
  upsertCredential('Cu3VpvmssPyMCFeo', 'Telegram account', 'telegramApi', tgEnc);
  count++;
  console.log("✅ Telegram: [Cu3VpvmssPyMCFeo] 'Telegram account'");
}

// 2. TikTok Credentials
for (const [id, acc] of Object.entries(payload.accounts)) {
  if (!acc.sessionid && !acc.sid_tt) {
    console.log('⏭️  Bỏ qua [' + id + '] (không có sessionid)');
    continue;
  }
  const { session, userId, cookieCount } = buildSession(acc);
  const enc = encryptOpenSSL(JSON.stringify({ tiktokSession: JSON.stringify(session, null, 2) }), encryptionKey);
  upsertCredential(id, acc.label || 'TikTok Account', 'tiktokApi', enc);
  count++;
  console.log("✅ TikTok: [" + id + "] '" + acc.label + "' (userId=" + userId + ", " + cookieCount + " cookies)");
}

console.log('🎉 Hoàn tất! Đã import ' + count + ' credentials vào n8n.');
`;

const containerScriptPath = path.join(__dirname, 'scratch_container_script.js');
fs.writeFileSync(containerScriptPath, containerScript, 'utf8');

try {
  console.log('💾 Backup database n8n...');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  execSync(`docker exec ${CONTAINER} cp /home/node/.n8n/database.sqlite /home/node/.n8n/database.sqlite.bak-${stamp}`);

  console.log('🔄 Đang copy script và dữ liệu vào n8n container...');
  execSync(`docker cp "${payloadPath}" ${CONTAINER}:/tmp/creds_payload.json`);
  execSync(`docker cp "${containerScriptPath}" ${CONTAINER}:/tmp/import_script.js`);

  console.log('🔄 Đang thực thi import trong container...');
  const result = execSync(`docker exec ${CONTAINER} node /tmp/import_script.js`, { encoding: 'utf8' });
  console.log(result);

  console.log('🔄 Đang khởi động lại n8n để nạp credentials vào bộ nhớ...');
  execSync(`docker restart ${CONTAINER}`, { stdio: 'inherit' });
  console.log('🎉 Hoàn tất nạp credentials vào n8n thành công!');
} catch (err) {
  console.error('❌ Lỗi:', err.message);
  process.exitCode = 1;
} finally {
  try { execSync(`docker exec -u root ${CONTAINER} rm -f /tmp/creds_payload.json /tmp/import_script.js`); } catch {}
  try { fs.unlinkSync(payloadPath); } catch {}
  try { fs.unlinkSync(containerScriptPath); } catch {}
}
