'use strict';

/**
 * proxy-bridge.js
 *
 * Local Proxy Bridge chạy tại 127.0.0.1:8888.
 * Tự động gắn Basic Authentication và forward toàn bộ HTTP/HTTPS CONNECT tunnel
 * sang Proxy Pool (assets/proxies.txt) - tránh lỗi 407 Proxy Authentication trên Chrome/Playwright.
 *
 * QUY TRÌNH XOAY PROXY ĐỘNG — ƯU TIÊN MẶC ĐỊNH (DIRECT-FIRST PROXY ROTATION):
 * 1. Ưu tiên sử dụng MẶC ĐỊNH (DIRECT - Không dùng proxy) cho tất cả các flow.
 * 2. Khi MẶC ĐỊNH bị lỗi (429, Unusual Activity, timeout, v.v.):
 *    - Ghi nhận thời điểm lỗi (directFailedAt = Date.now()).
 *    - Kích hoạt thời gian chờ (cooldown) đúng 1 tiếng (3,600,000 ms).
 *    - Lập tức chuyển sang dùng PROXY (tiếp tục proxy tiếp theo trong danh sách, ví dụ proxy 21).
 * 3. Trong 1 tiếng đó:
 *    - Tiếp tục sử dụng proxy. Nếu proxy đang chạy bị lỗi, tự động xoay sang proxy kế tiếp (22, 23...).
 * 4. Sau khi đủ 1 tiếng kể từ lúc mặc định bị lỗi:
 *    - Hệ thống tự động quay lại thử chế độ MẶC ĐỊNH (DIRECT).
 *    - Vị trí proxy vừa dùng (ví dụ proxy 20) được ghi nhớ nguyên vẹn.
 * 5. Khi thử lại MẶC ĐỊNH:
 *    - Nếu MẶC ĐỊNH bị lỗi tiếp: Ghi nhận 1 tiếng cooldown mới và tiếp tục chuyển sang proxy tiếp theo (ví dụ proxy 21).
 *    - Nếu MẶC ĐỊNH không lỗi: Tiếp tục sử dụng MẶC ĐỊNH cho các lượt tiếp theo.
 *    - Sau này khi đang dùng MẶC ĐỊNH mà bị lỗi: Lập tức tiếp tục proxy tiếp theo (ví dụ proxy 21).
 *
 * Chrome/Playwright luôn giữ nguyên kết nối vào 127.0.0.1:8888, không cần khởi động lại browser!
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

let serverInstance = null;
let proxyPool = [];
let lastProxyIndex = 0;
let hasUsedProxy = false;
let isDirect = true; // MẶC ĐỊNH LÀ ƯU TIÊN HÀNG ĐẦU (Không dùng proxy)
let directFailedAt = null;

const STATE_FILE_PATH = path.join(__dirname, '../assets/proxy-state.json');
const DEFAULT_DIRECT_COOLDOWN_MS = 60 * 60 * 1000; // 1 tiếng = 3,600,000 ms

const DIRECT_PROXY = {
  isDirect: true,
  host: 'DIRECT (No Proxy)',
  port: 0,
  user: '',
  pass: '',
  auth: '',
};

function getDirectCooldownMs() {
  if (process.env.DIRECT_COOLDOWN_MS) {
    const val = Number(process.env.DIRECT_COOLDOWN_MS);
    if (!isNaN(val) && val > 0) return val;
  }
  return DEFAULT_DIRECT_COOLDOWN_MS;
}

let lastStateMtime = 0;

function saveProxyState() {
  try {
    const cooldownMs = getDirectCooldownMs();
    const active = isDirect
      ? DIRECT_PROXY
      : (proxyPool[lastProxyIndex] || DIRECT_PROXY);

    const state = {
      isDirect,
      lastProxyIndex,
      hasUsedProxy,
      currentProxyIndex: isDirect ? proxyPool.length : lastProxyIndex,
      directFailedAt,
      directCooldownMs: cooldownMs,
      host: active.host || 'DIRECT (No Proxy)',
      port: active.port || 0,
      proxyCount: proxyPool.length,
      total: proxyPool.length + 1,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf8');
    try {
      lastStateMtime = fs.statSync(STATE_FILE_PATH).mtimeMs;
    } catch (_) {}
  } catch (err) {
    console.warn('[ProxyBridge] ⚠️ Không thể lưu proxy state:', err.message);
  }
}

function checkAndRefreshCooldown() {
  if (!isDirect && directFailedAt) {
    const elapsed = Date.now() - directFailedAt;
    const cooldownMs = getDirectCooldownMs();
    if (elapsed >= cooldownMs) {
      const elapsedMin = Math.round(elapsed / 60000);
      console.log(`[ProxyBridge] ⏰ Đã đủ ${elapsedMin} phút (>= 1 tiếng) kể từ lúc mặc định bị lỗi -> Tự động quay lại thử chế độ MẶC ĐỊNH (DIRECT).`);
      isDirect = true;
      saveProxyState();
      return true;
    }
  }
  return false;
}

function loadProxyState() {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const stat = fs.statSync(STATE_FILE_PATH);
      lastStateMtime = stat.mtimeMs;
      const data = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8'));
      if (typeof data.lastProxyIndex === 'number' && Number.isInteger(data.lastProxyIndex)) {
        lastProxyIndex = data.lastProxyIndex;
      } else if (typeof data.currentProxyIndex === 'number' && Number.isInteger(data.currentProxyIndex)) {
        lastProxyIndex = data.currentProxyIndex >= proxyPool.length ? 0 : data.currentProxyIndex;
      }

      if (typeof data.hasUsedProxy === 'boolean') {
        hasUsedProxy = data.hasUsedProxy;
      } else if (lastProxyIndex > 0) {
        hasUsedProxy = true;
      }

      if (typeof data.directFailedAt === 'number') {
        directFailedAt = data.directFailedAt;
      }

      if (typeof data.isDirect === 'boolean') {
        isDirect = data.isDirect;
      } else {
        isDirect = true; // Mặc định ưu tiên DIRECT
      }

      // Kiểm tra ngay xem đã đủ 1 tiếng để quay lại DIRECT chưa
      checkAndRefreshCooldown();
    }
  } catch (err) {
    console.warn('[ProxyBridge] ⚠️ Lỗi đọc proxy state:', err.message);
  }
}

function syncStateFromFile() {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const stat = fs.statSync(STATE_FILE_PATH);
      if (stat.mtimeMs !== lastStateMtime) {
        loadProxyState();
      }
    }
  } catch (_) {}
}

function loadProxyPool() {
  const proxyFilePath = path.join(__dirname, '../assets/proxies.txt');
  const list = [];
  if (fs.existsSync(proxyFilePath)) {
    const lines = fs.readFileSync(proxyFilePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split(':');
      if (parts.length >= 4) {
        list.push({
          isDirect: false,
          host: parts[0],
          port: Number(parts[1]),
          user: parts[2],
          pass: parts[3],
          auth: 'Basic ' + Buffer.from(`${parts[2]}:${parts[3]}`).toString('base64'),
        });
      }
    }
  }

  if (list.length === 0 && process.env.UPSTREAM_PROXY_HOST) {
    list.push({
      isDirect: false,
      host: process.env.UPSTREAM_PROXY_HOST,
      port: Number(process.env.UPSTREAM_PROXY_PORT || 6754),
      user: process.env.UPSTREAM_PROXY_USER || 'abcde1234',
      pass: process.env.UPSTREAM_PROXY_PASS || 'kmkmkm1234',
      auth: 'Basic ' + Buffer.from(`${process.env.UPSTREAM_PROXY_USER || 'abcde1234'}:${process.env.UPSTREAM_PROXY_PASS || 'kmkmkm1234'}`).toString('base64'),
    });
  }

  proxyPool = list;
  loadProxyState();

  if (isDirect) {
    console.log(`[ProxyBridge] 🌐 Chế độ khởi động: MẶC ĐỊNH (DIRECT - Không dùng proxy, tổng ${list.length} proxy dự phòng).`);
  } else {
    const active = list[lastProxyIndex] || DIRECT_PROXY;
    const cooldownMs = getDirectCooldownMs();
    const elapsed = Date.now() - (directFailedAt || Date.now());
    const remainingMin = Math.max(0, Math.round((cooldownMs - elapsed) / 60000));
    console.log(`[ProxyBridge] 🔄 Chế độ khởi động: Đang trong cooldown mặc định (còn ${remainingMin} phút) -> Sử dụng PROXY #${lastProxyIndex + 1}/${list.length} (${active.host}:${active.port})`);
  }

  return list;
}

function getActiveProxy() {
  if (proxyPool.length === 0) loadProxyPool();
  syncStateFromFile();
  checkAndRefreshCooldown();

  if (isDirect || proxyPool.length === 0) {
    return {
      ...DIRECT_PROXY,
      index: lastProxyIndex,
      proxyCount: proxyPool.length,
      isDirect: true,
    };
  }

  const p = proxyPool[lastProxyIndex] || DIRECT_PROXY;
  return {
    ...p,
    index: lastProxyIndex,
    proxyCount: proxyPool.length,
    isDirect: false,
  };
}

function rotateProxy() {
  if (proxyPool.length === 0) loadProxyPool();
  checkAndRefreshCooldown();

  const cooldownMs = getDirectCooldownMs();

  if (isDirect) {
    // ─── CHẾ ĐỘ MẶC ĐỊNH (DIRECT) BỊ LỖI ───
    directFailedAt = Date.now();
    isDirect = false;

    // Tiếp tục proxy tiếp theo trong danh sách:
    // Nếu trước đó đã từng sử dụng proxy (ví dụ đang ở Proxy #20), tiến sang Proxy #21.
    if (hasUsedProxy) {
      lastProxyIndex = (lastProxyIndex + 1) % proxyPool.length;
    } else {
      // Lần đầu tiên bị lỗi kể từ khi hệ thống chạy:
      lastProxyIndex = 0; // Bắt đầu từ Proxy #1
      hasUsedProxy = true;
    }

    saveProxyState();

    const active = proxyPool[lastProxyIndex] || DIRECT_PROXY;
    const nextRetryTime = new Date(directFailedAt + cooldownMs).toLocaleTimeString();
    console.log(`[ProxyBridge] ❌ Chế độ MẶC ĐỊNH (DIRECT) bị lỗi -> Kích hoạt cooldown 1 tiếng (tới ${nextRetryTime}).`);
    console.log(`[ProxyBridge] 🔄 Tự động chuyển sang tiếp tục PROXY #${lastProxyIndex + 1}/${proxyPool.length} (${active.host}:${active.port})!`);

    return getCurrentProxy();
  } else {
    // ─── ĐANG TRONG 1 TIẾNG SỬ DỤNG PROXY, VÀ PROXY HIỆN TẠI BỊ LỖI ───
    const prevIdx = lastProxyIndex;
    lastProxyIndex = (lastProxyIndex + 1) % proxyPool.length;
    hasUsedProxy = true;
    saveProxyState();

    const active = proxyPool[lastProxyIndex] || DIRECT_PROXY;
    const elapsed = Date.now() - (directFailedAt || Date.now());
    const remainingMin = Math.max(0, Math.round((cooldownMs - elapsed) / 60000));
    console.log(`[ProxyBridge] 🔄 Proxy #${prevIdx + 1}/${proxyPool.length} bị lỗi -> Chuyển sang proxy tiếp theo #${lastProxyIndex + 1}/${proxyPool.length}: ${active.host}:${active.port} (Còn ${remainingMin} phút cooldown mặc định).`);

    return getCurrentProxy();
  }
}

function switchToDirect() {
  if (proxyPool.length === 0) loadProxyPool();
  isDirect = true;
  directFailedAt = null;
  saveProxyState();
  console.log('[ProxyBridge] 🌐 Đã chủ động chuyển sang chế độ MẶC ĐỊNH (DIRECT).');
  return getActiveProxy();
}

function switchToProxies(startIndex = null) {
  if (proxyPool.length === 0) loadProxyPool();
  isDirect = false;
  if (typeof startIndex === 'number' && startIndex >= 0 && startIndex < proxyPool.length) {
    lastProxyIndex = startIndex;
  }
  hasUsedProxy = true;
  if (!directFailedAt) {
    directFailedAt = Date.now();
  }
  saveProxyState();
  const current = proxyPool[lastProxyIndex] || DIRECT_PROXY;
  console.log(`[ProxyBridge] 🔄 Đã chuyển sang dùng PROXY #${lastProxyIndex + 1}/${proxyPool.length}: ${current.host}:${current.port}`);
  return getActiveProxy();
}

function applyProxyPolicy(useProxy, contextLabel = '') {
  checkAndRefreshCooldown();
  const active = getActiveProxy();
  const modeStr = active.isDirect ? 'DIRECT (Mặc định)' : `PROXY #${active.index + 1}/${active.proxyCount} (${active.host}:${active.port})`;
  console.log(`[ProxyBridge] 📡 [${contextLabel || 'Request'}] Trạng thái kết nối: ${modeStr}`);
  return active;
}

function getCurrentProxy() {
  return getActiveProxy();
}

function startProxyBridge(options = {}) {
  if (serverInstance) {
    return Promise.resolve(serverInstance);
  }

  proxyPool = loadProxyPool();
  const localPort = Number(options.localPort || process.env.LOCAL_PROXY_PORT || 8888);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const activeProxy = getActiveProxy();

      // ─── XỬ LÝ CHẾ ĐỘ DIRECT (KHÔNG DÙNG PROXY) ───────────────────────────
      if (activeProxy.isDirect) {
        let parsedUrl;
        try {
          parsedUrl = new URL(req.url.startsWith('http') ? req.url : `http://${req.headers.host || '127.0.0.1'}${req.url}`);
        } catch (_) {
          res.writeHead(400);
          return res.end('Invalid URL');
        }

        const directOpts = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 80,
          path: parsedUrl.pathname + parsedUrl.search,
          method: req.method,
          headers: req.headers,
        };

        const directReq = http.request(directOpts, (directRes) => {
          res.writeHead(directRes.statusCode, directRes.headers);
          directRes.pipe(res, { end: true });
        });

        directReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Direct HTTP error: ' + err.message);
          }
        });

        req.pipe(directReq, { end: true });
        return;
      }

      // ─── XỬ LÝ QUA UPSTREAM PROXY ──────────────────────────────────────────
      const opts = {
        hostname: activeProxy.host,
        port: activeProxy.port,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          'Proxy-Authorization': activeProxy.auth,
        },
      };

      const proxyReq = http.request(opts, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      });

      proxyReq.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(502);
          res.end('Proxy error: ' + err.message);
        }
      });

      req.pipe(proxyReq, { end: true });
    });

    server.on('connect', (req, clientSocket, head) => {
      clientSocket.on('error', () => {});

      const activeProxy = getActiveProxy();
      const targetLog = activeProxy.isDirect ? 'DIRECT' : `${activeProxy.host}:${activeProxy.port}`;
      console.log(`[ProxyBridge] 🔌 CONNECT: ${req.url} -> ${targetLog}`);

      // ─── CHẾ ĐỘ DIRECT CONNECT (TCP TUNNEL TRỰC TIẾP KHÔNG QUA PROXY) ─────
      if (activeProxy.isDirect) {
        const parts = req.url.split(':');
        const targetHost = parts[0];
        const targetPort = Number(parts[1]) || 443;

        const directSocket = net.connect(targetPort, targetHost, () => {
          try {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head && head.length > 0) directSocket.write(head);
            directSocket.pipe(clientSocket);
            clientSocket.pipe(directSocket);
          } catch (_) {}
        });

        directSocket.on('error', () => {
          try {
            clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            clientSocket.end();
          } catch (_) {}
        });

        clientSocket.on('error', () => {
          try { directSocket.destroy(); } catch (_) {}
        });
        return;
      }

      // ─── CHẾ ĐỘ FORWARD CONNECT SANG UPSTREAM PROXY ────────────────────────
      const upstreamReq = http.request({
        host: activeProxy.host,
        port: activeProxy.port,
        method: 'CONNECT',
        path: req.url,
        headers: {
          'Host': req.url,
          'Proxy-Authorization': activeProxy.auth,
        },
      });

      upstreamReq.on('connect', (res, upstreamSocket, upstreamHead) => {
        upstreamSocket.on('error', () => {});

        if (res.statusCode !== 200) {
          console.warn(`[ProxyBridge] ⚠️ Upstream CONNECT refused (${res.statusCode}) for ${req.url} by ${activeProxy.host}:${activeProxy.port}`);
          if (res.statusCode === 402 || res.statusCode === 407) {
            console.warn(`[ProxyBridge] ⚠️ Proxy ${activeProxy.host}:${activeProxy.port} bị lỗi ${res.statusCode} -> Tự động xoay sang proxy tiếp theo!`);
            try { rotateProxy(); } catch (_) {}
          }
          try {
            clientSocket.write(`HTTP/1.1 ${res.statusCode} Connection Failed\r\n\r\n`);
            clientSocket.end();
          } catch (_) {}
          return;
        }

        try {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (upstreamHead && upstreamHead.length > 0) clientSocket.write(upstreamHead);
          if (head && head.length > 0) upstreamSocket.write(head);
          upstreamSocket.pipe(clientSocket);
          clientSocket.pipe(upstreamSocket);
        } catch (_) {}
      });

      upstreamReq.on('error', (err) => {
        console.warn(`[ProxyBridge] ❌ Upstream CONNECT error for ${req.url} via ${activeProxy.host}:${activeProxy.port}: ${err.message}`);
        try {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          clientSocket.end();
        } catch (_) {}
      });

      upstreamReq.end();
    });

    server.on('error', (err) => {
      console.error(`[ProxyBridge] Server error: ${err.message}`);
      reject(err);
    });

    server.listen(localPort, '127.0.0.1', () => {
      const active = getActiveProxy();
      const targetStr = active.isDirect ? 'DIRECT (No Proxy)' : `${active.host}:${active.port}`;
      console.log(`[ProxyBridge] ✅ Local Proxy Bridge listening on 127.0.0.1:${localPort} (active: #${active.index + 1}/${active.proxyCount} [${targetStr}])`);
      serverInstance = server;
      resolve(server);
    });
  });
}

function stopProxyBridge() {
  if (serverInstance) {
    return new Promise((resolve) => {
      serverInstance.close(() => {
        console.log('[ProxyBridge] Proxy bridge stopped.');
        serverInstance = null;
        resolve();
      });
    });
  }
  return Promise.resolve();
}

if (require.main === module) {
  startProxyBridge().catch(console.error);
}

module.exports = {
  startProxyBridge,
  stopProxyBridge,
  rotateProxy,
  switchToDirect,
  switchToProxies,
  getCurrentProxy,
  getActiveProxy,
  applyProxyPolicy,
  getDirectCooldownMs,
  checkAndRefreshCooldown,
};
