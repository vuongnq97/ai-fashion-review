'use strict';

/**
 * proxy-bridge.js
 *
 * Local Proxy Bridge chạy tại 127.0.0.1:8888.
 * Tự động gắn Basic Authentication và forward toàn bộ HTTP/HTTPS CONNECT tunnel
 * sang Webshare Proxy Pool (10 proxies) - tránh lỗi 407 Proxy Authentication trên Chrome/Playwright.
 *
 * Hỗ trợ xoay proxy động (rotateProxy):
 * - Tuần tự qua 10 proxies (#1 -> #10).
 * - Khi hết cả 10 proxies (lỗi hết proxy): tự động chuyển sang DIRECT (Không dùng proxy).
 * - Khi đang ở DIRECT mà bị lỗi: tự động quay lại dùng 10 proxies (bắt đầu lại từ Proxy #1).
 *
 * Chrome/Playwright luôn giữ nguyên kết nối vào 127.0.0.1:8888, không cần khởi động lại browser!
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

let serverInstance = null;
let currentProxyIndex = 0;
let proxyPool = [];
const STATE_FILE_PATH = path.join(__dirname, '../assets/proxy-state.json');

function saveProxyState() {
  try {
    const active = proxyPool[currentProxyIndex] || {};
    const proxyCount = proxyPool.filter(p => !p.isDirect).length;
    const state = {
      currentProxyIndex,
      isDirect: !!active.isDirect,
      host: active.host || '',
      port: active.port || 0,
      proxyCount,
      total: proxyPool.length,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn('[ProxyBridge] ⚠️ Không thể lưu proxy state:', err.message);
  }
}

function loadProxyStateIndex() {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8'));
      if (typeof data.currentProxyIndex === 'number' && Number.isInteger(data.currentProxyIndex)) {
        return data.currentProxyIndex;
      }
    }
  } catch (err) {
    console.warn('[ProxyBridge] ⚠️ Lỗi đọc proxy state:', err.message);
  }
  return null;
}

function loadProxyPool() {
  const proxyFilePath = path.join(__dirname, '../assets/Webshare 10 proxies.txt');
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

  // Thêm chế độ DIRECT (Không dùng proxy) sau khi đã thử hết các proxies
  list.push({
    isDirect: true,
    host: 'DIRECT (No Proxy)',
    port: 0,
    user: '',
    pass: '',
    auth: '',
  });

  proxyPool = list;

  // Khôi phục proxy trước đó từ file nếu có
  const savedIdx = loadProxyStateIndex();
  if (savedIdx !== null && savedIdx >= 0 && savedIdx < list.length) {
    currentProxyIndex = savedIdx;
    const active = list[currentProxyIndex];
    const proxyCount = list.filter(p => !p.isDirect).length;
    if (active.isDirect) {
      console.log(`[ProxyBridge] 📂 Khôi phục proxy trước đó: DIRECT (Không dùng proxy)`);
    } else {
      console.log(`[ProxyBridge] 📂 Khôi phục proxy trước đó: #${currentProxyIndex + 1}/${proxyCount} (${active.host}:${active.port})`);
    }
  } else {
    currentProxyIndex = 0;
    saveProxyState();
  }

  return list;
}

function getActiveProxy() {
  if (proxyPool.length === 0) proxyPool = loadProxyPool();
  const savedIdx = loadProxyStateIndex();
  if (savedIdx !== null && savedIdx >= 0 && savedIdx < proxyPool.length && savedIdx !== currentProxyIndex) {
    currentProxyIndex = savedIdx;
  }
  return proxyPool[currentProxyIndex] || proxyPool[0];
}

function rotateProxy() {
  if (proxyPool.length === 0) proxyPool = loadProxyPool();
  const savedIdx = loadProxyStateIndex();
  if (savedIdx !== null && savedIdx >= 0 && savedIdx < proxyPool.length) {
    currentProxyIndex = savedIdx;
  }

  const previous = proxyPool[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % proxyPool.length;
  const current = proxyPool[currentProxyIndex];

  const proxyCount = proxyPool.filter(p => !p.isDirect).length;

  if (current.isDirect) {
    console.log(`[ProxyBridge] 🌐 Đã thử hết ${proxyCount} proxy -> Tự động chuyển sang chế độ DIRECT (Không sử dụng proxy)!`);
  } else if (previous && previous.isDirect) {
    console.log(`[ProxyBridge] 🔄 Bị lỗi khi chạy DIRECT -> Tự động quay lại dùng danh sách ${proxyCount} proxy (bắt đầu từ Proxy #1: ${current.host}:${current.port})!`);
  } else {
    console.log(`[ProxyBridge] 🔄 Chuyển sang proxy tiếp theo #${currentProxyIndex + 1}/${proxyCount}: ${current.host}:${current.port}`);
  }

  saveProxyState();

  return {
    ...current,
    index: currentProxyIndex,
    total: proxyPool.length,
    proxyCount,
  };
}

function switchToDirect() {
  if (proxyPool.length === 0) proxyPool = loadProxyPool();
  const directIdx = proxyPool.findIndex(p => p.isDirect);
  if (directIdx !== -1) {
    currentProxyIndex = directIdx;
    saveProxyState();
    console.log(`[ProxyBridge] 🌐 Đã chuyển sang chế độ DIRECT (Không sử dụng proxy).`);
  }
  return getCurrentProxy();
}

function switchToProxies(startIndex = 0) {
  if (proxyPool.length === 0) proxyPool = loadProxyPool();
  currentProxyIndex = startIndex >= 0 && startIndex < proxyPool.length ? startIndex : 0;
  saveProxyState();
  const current = proxyPool[currentProxyIndex];
  console.log(`[ProxyBridge] 🔄 Đã chuyển sang dùng proxy #${currentProxyIndex + 1}: ${current.host}:${current.port}`);
  return getCurrentProxy();
}

function getCurrentProxy() {
  const active = getActiveProxy();
  const proxyCount = proxyPool.filter(p => !p.isDirect).length;
  return {
    ...active,
    index: currentProxyIndex,
    total: proxyPool.length,
    proxyCount,
  };
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
      console.log(`[ProxyBridge] 🔌 CONNECT: ${req.url} -> ${activeProxy.host}:${activeProxy.port}`);

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
          if (res.statusCode === 402) {
            console.warn(`[ProxyBridge] ⚠️ Proxy ${activeProxy.host}:${activeProxy.port} bị lỗi 402 (Hết hạn gói) -> Tự động chuyển sang DIRECT!`);
            try { switchToDirect(); } catch (_) {}
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
      const proxyCount = proxyPool.filter(p => !p.isDirect).length;
      const targetStr = active.isDirect ? 'DIRECT (No Proxy)' : `${active.host}:${active.port}`;
      console.log(`[ProxyBridge] ✅ Local Proxy Bridge listening on 127.0.0.1:${localPort} (active: #${currentProxyIndex + 1}/${proxyPool.length} [${targetStr}], total proxies: ${proxyCount})`);
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
};
