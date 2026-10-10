'use strict';

/**
 * proxy-bridge.js (Standalone for lego-prj)
 * 
 * Local Proxy Bridge listening on 127.0.0.1:8888.
 * Routes Chrome traffic either DIRECT (fastest) or through the 50 proxies in proxies.txt.
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

let serverInstance = null;
let proxyPool = [];
let lastProxyIndex = 0;
let isDirect = false; // Flow is geo-blocked in VN -> default to US Proxy Pool from proxies.txt

const PROXY_FILE_PATH = path.join(__dirname, '../proxies.txt');

function loadProxyPool() {
  const list = [];
  if (fs.existsSync(PROXY_FILE_PATH)) {
    const lines = fs.readFileSync(PROXY_FILE_PATH, 'utf8').split('\n');
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
  proxyPool = list;
  console.log(`[ProxyBridge] 🌐 Đã nạp ${list.length} proxy từ proxies.txt (Chế độ hiện tại: ${isDirect ? 'DIRECT' : 'PROXY'}).`);
  return list;
}

function getActiveProxy() {
  if (proxyPool.length === 0) loadProxyPool();
  if (isDirect || proxyPool.length === 0) {
    return { isDirect: true, host: 'DIRECT', port: 0 };
  }
  return proxyPool[lastProxyIndex] || { isDirect: true, host: 'DIRECT', port: 0 };
}

function rotateProxy() {
  if (proxyPool.length === 0) loadProxyPool();
  if (isDirect) {
    isDirect = false;
    lastProxyIndex = 0;
  } else {
    lastProxyIndex = (lastProxyIndex + 1) % proxyPool.length;
  }
  const current = proxyPool[lastProxyIndex];
  console.log(`[ProxyBridge] 🔄 Xoay proxy -> #${lastProxyIndex + 1}/${proxyPool.length} (${current?.host}:${current?.port})`);
  return current;
}

function switchToDirect() {
  isDirect = true;
  console.log('[ProxyBridge] 🌐 Đã chuyển sang chế độ DIRECT (Không qua proxy).');
  return getActiveProxy();
}

function startProxyBridge(port = 8888) {
  if (serverInstance) {
    return Promise.resolve(serverInstance);
  }

  loadProxyPool();

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const activeProxy = getActiveProxy();

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

      // Upstream proxy
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

      // Forward CONNECT to upstream proxy
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

      upstreamReq.on('error', () => {
        try {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          clientSocket.end();
        } catch (_) {}
      });

      upstreamReq.end();
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[ProxyBridge] 🚀 Local Proxy Bridge đang lắng nghe tại http://127.0.0.1:${port}`);
      serverInstance = server;
      resolve(server);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[ProxyBridge] ℹ️ Cổng ${port} đã đang được lắng nghe, tái sử dụng.`);
        resolve(null);
      } else {
        console.error(`[ProxyBridge] ❌ Lỗi khởi động proxy bridge:`, err.message);
        reject(err);
      }
    });
  });
}

function stopProxyBridge() {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
    console.log('[ProxyBridge] 🛑 Đã dừng Local Proxy Bridge.');
  }
}

module.exports = {
  startProxyBridge,
  stopProxyBridge,
  rotateProxy,
  switchToDirect,
  getActiveProxy
};
