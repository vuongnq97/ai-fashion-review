/**
 * sync-tiktok-accounts.js
 * Tự động trích xuất, giải mã credentials TikTok từ n8n SQLite
 * và đồng bộ cập nhật vào tiktok-accounts.json
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ACCOUNTS_FILE = path.join(__dirname, 'tiktok-accounts.json');

// Script Node chạy bên trong container n8n để trích xuất và giải mã credentials
const DOCKER_NODE_SCRIPT = `
const fs = require("fs");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const config = JSON.parse(fs.readFileSync("/home/node/.n8n/config", "utf8"));
const encryptionKey = config.encryptionKey;

function decryptOpenSSL(dataBase64, password) {
  const cipherData = Buffer.from(dataBase64, "base64");
  const salt = cipherData.subarray(8, 16);
  const cipherText = cipherData.subarray(16);
  let keyAndIv = Buffer.alloc(0);
  let currentHash = Buffer.alloc(0);
  while (keyAndIv.length < 48) {
    const hash = crypto.createHash("md5");
    hash.update(currentHash);
    hash.update(password);
    hash.update(salt);
    currentHash = hash.digest();
    keyAndIv = Buffer.concat([keyAndIv, currentHash]);
  }
  const key = keyAndIv.subarray(0, 32);
  const iv = keyAndIv.subarray(32, 48);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(cipherText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString("utf8");
}

const db = new DatabaseSync("/home/node/.n8n/database.sqlite");
const rows = db.prepare("SELECT id, name, type, data FROM credentials_entity WHERE type = 'tiktokApi'").all();

const accounts = {};

for (const r of rows) {
  try {
    const dec = JSON.parse(decryptOpenSSL(r.data, encryptionKey));
    let session = dec.tiktokSession;
    if (typeof session === "string") {
      try { session = JSON.parse(session); } catch {}
    }
    const cookies = (session && session.http && session.http.cookies) || (session && session.cookies) || {};
    accounts[r.id] = {
      id: r.id,
      name: r.name,
      cookies: cookies,
      timestamp: (session && session.http && session.http.timestamp) || new Date().toISOString()
    };
  } catch (err) {
    console.error("Error decrypting " + r.id + ":", err.message);
  }
}

console.log(JSON.stringify(accounts));
`;

async function fetchTikTokUserInfo(cookies) {
  return new Promise((resolve) => {
    const cookieStr = Object.entries(cookies)
      .filter(([k, v]) => typeof v === 'string' && v.trim())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    const req = https.request('https://www.tiktok.com/passport/web/account/info/', {
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 10000,
      headers: {
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
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
              username: json.data.username,
              screenName: json.data.screen_name,
              userId: json.data.user_id_str
            });
            return;
          }
        } catch {}
        resolve({ valid: false });
      });
    });

    req.on('error', () => resolve({ valid: false }));
    req.on('timeout', () => { req.destroy(); resolve({ valid: false }); });
    req.end();
  });
}

async function syncAccounts() {
  console.log('🔄 Đang kết nối tới n8n container để lấy credentials TikTok...');

  let rawOutput = '';
  try {
    rawOutput = execSync('docker exec -i n8n node', {
      input: DOCKER_NODE_SCRIPT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (err) {
    console.error('❌ Lỗi khi thực thi lệnh trích xuất từ docker n8n:', err.message);
    process.exit(1);
  }

  let n8nAccounts = {};
  try {
    n8nAccounts = JSON.parse(rawOutput.trim());
  } catch (err) {
    console.error('❌ Lỗi parse JSON từ n8n output:', err.message, rawOutput);
    process.exit(1);
  }

  const accountIds = Object.keys(n8nAccounts);
  console.log(`📦 Tìm thấy ${accountIds.length} credentials tiktokApi trong n8n.`);

  const existingAccounts = fs.existsSync(ACCOUNTS_FILE)
    ? JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'))
    : {};

  const updatedAccounts = {};

  const defaultLabels = {
    'cJDNuW2i1tFFXivi': 'Men Shop',
    'WIFMkBwL39jBHjxo': 'Lady Shop (ladystore2000)',
    'Q9JStYDsDEzn5Tg3': 'Nhi Shop (nhi_giadung)'
  };

  for (const id of accountIds) {
    const item = n8nAccounts[id];
    const cookies = item.cookies || {};
    console.log(`\n🔍 Kiểm tra credential [${id}] - "${item.name}"...`);

    const userInfo = await fetchTikTokUserInfo(cookies);
    let label = defaultLabels[id] || item.name;
    if (userInfo.valid) {
      console.log(`   ✅ Session TikTok hợp lệ: @${userInfo.username} (${userInfo.screenName}) [UID: ${userInfo.userId}]`);
      if (!defaultLabels[id]) {
        label = `${item.name} (@${userInfo.username})`;
      }
    } else {
      console.log(`   ⚠️ Không xác thực được qua TikTok Passport API (vẫn giữ cookies).`);
    }

    // Thứ tự các trường cookie phổ biến
    const formattedAccount = {
      label: label,
      ...(cookies._ttp ? { _ttp: cookies._ttp } : {}),
      ...(cookies.tt_chain_token ? { tt_chain_token: cookies.tt_chain_token } : {}),
      ...(cookies.tt_csrf_token ? { tt_csrf_token: cookies.tt_csrf_token } : {}),
      ...(cookies.s_v_web_id ? { s_v_web_id: cookies.s_v_web_id } : {}),
      ...(cookies.d_ticket ? { d_ticket: cookies.d_ticket } : {}),
      ...(cookies.uid_tt ? { uid_tt: cookies.uid_tt } : {}),
      ...(cookies.uid_tt_ss ? { uid_tt_ss: cookies.uid_tt_ss } : {}),
      ...(cookies.sid_tt ? { sid_tt: cookies.sid_tt } : {}),
      ...(cookies.sessionid ? { sessionid: cookies.sessionid } : {}),
      ...(cookies.sessionid_ss ? { sessionid_ss: cookies.sessionid_ss } : {}),
      ...(cookies.sid_guard ? { sid_guard: cookies.sid_guard } : {}),
      ...(cookies.msToken ? { msToken: cookies.msToken } : {}),
      ...(cookies.ttwid ? { ttwid: cookies.ttwid } : {}),
      ...(cookies.odin_tt ? { odin_tt: cookies.odin_tt } : {}),
      updatedAt: item.timestamp || new Date().toISOString()
    };

    updatedAccounts[id] = formattedAccount;
  }

  // Backup file cũ
  if (fs.existsSync(ACCOUNTS_FILE)) {
    const backupFile = ACCOUNTS_FILE.replace('.json', `.backup-${Date.now()}.json`);
    fs.copyFileSync(ACCOUNTS_FILE, backupFile);
    console.log(`\n💾 Đã backup tiktok-accounts.json cũ -> ${path.basename(backupFile)}`);
  }

  // Lưu file mới
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(updatedAccounts, null, 2), 'utf8');
  console.log(`🎉 Đã cập nhật thành công ${Object.keys(updatedAccounts).length} accounts vào tiktok-accounts.json!\n`);
}

syncAccounts().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
