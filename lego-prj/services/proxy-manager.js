'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

class ProxyManager {
  constructor(proxyFilePath = null) {
    this.proxyFilePath = proxyFilePath || path.resolve(__dirname, '../proxies.txt');
    this.proxies = [];
    this.currentIndex = 0;
    this.useProxy = process.env.USE_PROXY !== 'false';
    this.loadProxies();
  }

  loadProxies() {
    try {
      if (!fs.existsSync(this.proxyFilePath)) {
        console.warn(`[ProxyManager] ⚠️ Không tìm thấy file proxy: ${this.proxyFilePath}`);
        this.proxies = [];
        return;
      }
      const raw = fs.readFileSync(this.proxyFilePath, 'utf8');
      const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));

      this.proxies = lines.map(line => {
        const parts = line.split(':');
        if (parts.length >= 4) {
          const [ip, port, user, pass] = parts;
          return {
            ip,
            port: parseInt(port, 10),
            user,
            pass,
            url: `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${ip}:${port}`,
            auth: Buffer.from(`${user}:${pass}`).toString('base64')
          };
        } else if (parts.length === 2) {
          const [ip, port] = parts;
          return {
            ip,
            port: parseInt(port, 10),
            user: null,
            pass: null,
            url: `http://${ip}:${port}`,
            auth: null
          };
        }
        return null;
      }).filter(Boolean);

      console.log(`[ProxyManager] ✅ Đã nạp ${this.proxies.length} proxy từ ${path.basename(this.proxyFilePath)}`);
    } catch (err) {
      console.error(`[ProxyManager] ❌ Lỗi đọc file proxy:`, err.message);
      this.proxies = [];
    }
  }

  getNextProxy() {
    if (!this.useProxy || this.proxies.length === 0) return null;
    const proxy = this.proxies[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
    return proxy;
  }

  getRandomProxy() {
    if (!this.useProxy || this.proxies.length === 0) return null;
    const idx = Math.floor(Math.random() * this.proxies.length);
    return this.proxies[idx];
  }

  /**
   * Tạo https agent hỗ trợ proxy (hoặc direct fallback)
   */
  getHttpsAgent(proxy = null) {
    const p = proxy || this.getNextProxy();
    if (!p) {
      return new https.Agent({ rejectUnauthorized: false });
    }

    try {
      return new HttpsProxyAgent(p.url, {
        rejectUnauthorized: false,
        timeout: 15000
      });
    } catch (err) {
      console.warn(`[ProxyManager] ⚠️ Lỗi tạo proxy agent: ${err.message}. Dùng direct.`);
      return new https.Agent({ rejectUnauthorized: false });
    }
  }

  /**
   * Kiểm tra nhanh một proxy có sống không
   */
  async testProxy(proxy, timeoutMs = 5000) {
    if (!proxy) return false;
    return new Promise((resolve) => {
      const req = http.request({
        host: proxy.ip,
        port: proxy.port,
        method: 'CONNECT',
        path: 'www.google.com:443',
        headers: proxy.auth ? { 'Proxy-Authorization': `Basic ${proxy.auth}` } : {},
        timeout: timeoutMs
      });

      req.on('connect', (res, socket) => {
        socket.destroy();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }
}

const defaultManager = new ProxyManager();

module.exports = {
  ProxyManager,
  proxyManager: defaultManager
};
