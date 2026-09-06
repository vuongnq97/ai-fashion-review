'use strict';

/**
 * gemini-api.js
 *
 * Pure Node.js client for gemini.google.com — replaces the Python `gemini_webapi` package.
 * Uses Playwright's APIRequestContext so HTTP calls carry Chrome's exact TLS fingerprint.
 *
 * Key endpoints (mirrored from gemini_webapi source):
 *   INIT     GET  https://gemini.google.com/app
 *   UPLOAD   POST https://content-push.googleapis.com/upload
 *   GENERATE POST https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
 *   BATCH    POST https://gemini.google.com/_/BardChatUi/data/batchexecute
 */

const { chromium } = require('playwright');
const path = require('path');
const crypto = require('crypto');

// ─── Constants (from gemini_webapi/constants.py) ────────────────────────────

const ENDPOINT_INIT = 'https://gemini.google.com/app';
const ENDPOINT_GENERATE = 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';
const ENDPOINT_UPLOAD = 'https://content-push.googleapis.com/upload';
const ENDPOINT_BATCH_EXEC = 'https://gemini.google.com/_/BardChatUi/data/batchexecute';

const STREAMING_FLAG_INDEX = 7;
const TEMPORARY_CHAT_FLAG_INDEX = 45;

const DEFAULT_METADATA = ['', '', '', null, null, null, null, null, null, ''];

const GEMINI_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
  'Origin': 'https://gemini.google.com',
  'Referer': 'https://gemini.google.com/',
};
const SAME_DOMAIN_HEADERS = { 'X-Same-Domain': '1' };

// Extra headers required by Gemini (observed from Python package traffic)
const BATCH_EXTRA_HEADERS = {
  'x-goog-ext-525001261-jspb': '[1,null,null,null,null,null,null,null,[4]]',
  'x-goog-ext-73010989-jspb': '[0]',
  'x-goog-ext-73010990-jspb': '[0]',
};

// ─── Frame parser (mirrors gemini_webapi/utils/parsing.py) ──────────────────

/**
 * Parse Google's length-prefixed streaming framing protocol.
 * Each frame: `<UTF-16-code-unit-count>\n<json-payload>`
 * The count uses JavaScript String.length (UTF-16 units, not Unicode code points).
 *
 * @param {string} content - Accumulated response text buffer
 * @returns {{ frames: any[], remaining: string }}
 */
function parseResponseByFrame(content) {
  const frames = [];
  let pos = 0;

  while (pos < content.length) {
    // Skip leading whitespace
    while (pos < content.length && /\s/.test(content[pos])) pos++;
    if (pos >= content.length) break;

    // Match length number followed by newline at current position
    const numMatch = content.slice(pos).match(/^(\d+)\n/);
    if (!numMatch) break;

    const lengthStr = numMatch[1];
    const length = parseInt(lengthStr, 10);       // UTF-16 length of content INCLUDING the '\n' after digits
    const afterDigitsPos = pos + lengthStr.length; // position of the '\n' right after digits

    // Google's length includes content starting from the '\n' position.
    // So actual content ends at: afterDigitsPos + length
    const contentEnd = afterDigitsPos + length;

    if (contentEnd > content.length) {
      // Incomplete frame — wait for more data
      break;
    }

    // The chunk is from after the '\n' (skip it) to contentEnd
    const chunk = content.slice(afterDigitsPos + 1, contentEnd).trim();
    pos = contentEnd;

    if (!chunk) continue;

    try {
      const parsed = JSON.parse(chunk);
      if (Array.isArray(parsed)) {
        frames.push(...parsed);
      } else {
        frames.push(parsed);
      }
    } catch (_) {
      // Ignore unparseable chunks
    }
  }

  return { frames, remaining: content.slice(pos) };
}

/**
 * Extract and normalize JSON from a raw Google API response (handles ")]}'" prefix).
 * @param {string} text
 * @returns {any[]}
 */
function extractJsonFromResponse(text) {
  let content = typeof text === 'string' ? text : '';
  if (content.startsWith(")]}'")) content = content.slice(4);
  content = content.trimStart();

  const { frames } = parseResponseByFrame(content);
  if (frames.length > 0) return frames;

  // Fallback: parse whole thing
  try {
    const parsed = JSON.parse(content.trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) {}

  return [];
}

/**
 * Safely navigate a nested list/object by a path of indices/keys.
 * @param {any} data
 * @param {(number|string)[]} pathArr
 * @param {any} [defaultVal]
 * @returns {any}
 */
function getNestedValue(data, pathArr, defaultVal = null) {
  let current = data;
  for (const key of pathArr) {
    if (current == null) return defaultVal;
    if (typeof key === 'number') {
      if (!Array.isArray(current) || key < 0 || key >= current.length) return defaultVal;
      current = current[key];
    } else {
      if (typeof current !== 'object' || !(key in current)) return defaultVal;
      current = current[key];
    }
  }
  return current ?? defaultVal;
}

// ─── URL encode helper ───────────────────────────────────────────────────────

function buildFormBody(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ─── Multipart builder (for file upload) ─────────────────────────────────────

/**
 * Build a multipart/form-data body for uploading a single file.
 * @param {Buffer} fileBuffer
 * @param {string} filename
 * @param {string} mimeType
 * @returns {{ body: Buffer, contentType: string }}
 */
function buildMultipartBody(fileBuffer, filename, mimeType) {
  const boundary = `----FormBoundary${crypto.randomBytes(16).toString('hex')}`;
  const parts = [];

  // File part
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  ));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function isAuthenticationError(errorMessage = '') {
  const msg = String(errorMessage || '').toLowerCase();
  return (
    msg.includes('1100') ||
    msg.includes('cookiemismatch') ||
    msg.includes('snlm0e') ||
    msg.includes('unauthenticated') ||
    msg.includes('session rejected') ||
    msg.includes('autherror') ||
    msg.includes('http 401') ||
    msg.includes('http 403') ||
    msg.includes('logged out')
  );
}

// ─── GeminiApiClient ─────────────────────────────────────────────────────────

class GeminiApiClient {
  /**
   * @param {object} opts
   * @param {string} opts.secure1Psid   - __Secure-1PSID cookie value
   * @param {string} [opts.secure1Psidts] - __Secure-1PSIDTS cookie value
   * @param {string} [opts.cookieFilePath] - Path to a JSON cookie file (Netscape/array format)
   */
  constructor({ secure1Psid = '', secure1Psidts = '', cookieFilePath = null } = {}) {
    const fs = require('fs');
    const path = require('path');
    const defaultCookieDir = process.env.GEMINI_COOKIE_PATH
      ? path.resolve(process.env.GEMINI_COOKIE_PATH)
      : path.resolve(__dirname, '..', '..', 'gemini-cookies');

    this.cookieFilePath = cookieFilePath || (fs.existsSync(defaultCookieDir) ? defaultCookieDir : null);
    this.secure1Psid = secure1Psid || process.env.GEMINI_SECURE_1PSID || '';
    this.secure1Psidts = secure1Psidts || process.env.GEMINI_SECURE_1PSIDTS || '';

    // Session state (populated after init())
    this.accessToken = null;   // SNlM0e
    this.buildLabel = null;    // cfb2h
    this.sessionId = null;     // FdrFJe
    this.language = 'en';      // TuX5cc
    this.pushId = 'feeds/mcudyrk2a4khkz'; // qKIAYe
    this.uiModelContextId = process.env.GEMINI_UI_MODEL_CONTEXT_ID || '56fdd199312815e2';
    this.uiClientInstanceId = process.env.GEMINI_UI_CLIENT_INSTANCE_ID || crypto.randomUUID().toUpperCase();

    this._reqid = Math.floor(Math.random() * 90000) + 10000;
    this._apiContext = null;   // Playwright APIRequestContext
    this._browser = null;      // Playwright Browser
    this._initialized = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Build cookies array for Playwright APIRequestContext.
   * @returns {object[]}
   */
  _buildCookies() {
    const cookies = [];
    const cookieNames = new Set();

    const addCookie = (cookie) => {
      const key = `${cookie.name}|${cookie.domain || '.google.com'}|${cookie.path || '/'}`;
      if (cookieNames.has(key)) return;
      cookieNames.add(key);
      cookies.push(cookie);
    };

    // Playwright requires: name, value, domain, path — plus optional httpOnly, secure, sameSite, expires
    // sameSite must be exactly 'Strict'|'Lax'|'None' (capital first letter)
    const normalizeSameSite = (s) => {
      if (!s) return 'Lax';
      const v = String(s).toLowerCase();
      if (v === 'strict') return 'Strict';
      if (v === 'none') return 'None';
      return 'Lax';
    };

    const normalizeCookie = (c) => {
      const name = String(c.name || '');
      const sameSite = normalizeSameSite(c.sameSite);
      const cookie = {
        name,
        value: c.value,
        domain: c.domain || '.google.com',
        path: c.path || '/',
        secure: c.secure !== undefined ? !!c.secure : name.startsWith('__Secure-') || sameSite === 'None',
        httpOnly: c.httpOnly !== undefined ? !!c.httpOnly : false,
        sameSite,
      };
      if (c.expires && typeof c.expires === 'number' && c.expires > 0) {
        cookie.expires = c.expires;
      }
      return cookie;
    };

    let loadedCookieFile = false;

    // Load extra cookies from file if provided
    if (this.cookieFilePath) {
      try {
        const fs = require('fs');
        if (fs.existsSync(this.cookieFilePath)) {
          let resolvedCookieFile = this.cookieFilePath;

          // If path is a directory, auto-detect the first .json file inside it
          const stat = fs.statSync(this.cookieFilePath);
          if (!stat.isFile()) {
            const entries = fs.readdirSync(this.cookieFilePath)
              .filter(f => f.endsWith('.json'))
              .sort();
            if (entries.length > 0) {
              resolvedCookieFile = require('path').join(this.cookieFilePath, entries[0]);
              console.warn(`[GeminiAPI] GEMINI_COOKIE_PATH is a directory — auto-loading: ${resolvedCookieFile}`);
            } else {
              console.warn(`[GeminiAPI] GEMINI_COOKIE_PATH "${this.cookieFilePath}" is a directory with no .json files — skipping cookie file load.`);
              resolvedCookieFile = null;
            }
          }

          if (resolvedCookieFile) {
            const raw = JSON.parse(fs.readFileSync(resolvedCookieFile, 'utf8'));
            for (const c of raw) {
              if (!c.name || !c.value) continue;
              addCookie(normalizeCookie(c));
            }
            loadedCookieFile = true;

            const file1Psid = raw.find(c => c.name === '__Secure-1PSID')?.value || '';
            const file1Psidts = raw.find(c => c.name === '__Secure-1PSIDTS')?.value || '';
            if (file1Psid) this.secure1Psid = file1Psid;
            if (file1Psidts) this.secure1Psidts = file1Psidts;
            console.warn(`[GeminiAPI] Loaded ${raw.length} cookies from: ${resolvedCookieFile}`);
          }
        }
      } catch (e) {
        console.error('[GeminiAPI] Failed to load cookie file:', e.message);
      }
    }

    if (!loadedCookieFile) {
      if (this.secure1Psid) {
        addCookie({
          name: '__Secure-1PSID',
          value: this.secure1Psid,
          domain: '.google.com',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        });
      }
      if (this.secure1Psidts) {
        addCookie({
          name: '__Secure-1PSIDTS',
          value: this.secure1Psidts,
          domain: '.google.com',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        });
      }
    } else {
      const hasCookie = (name) => cookies.some(cookie => cookie.name === name);
      if (!hasCookie('__Secure-1PSID') && this.secure1Psid) {
        console.warn('[GeminiAPI] Cookie file has no __Secure-1PSID; falling back to .env value.');
        addCookie({
          name: '__Secure-1PSID',
          value: this.secure1Psid,
          domain: '.google.com',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        });
      }
      if (!hasCookie('__Secure-1PSIDTS') && this.secure1Psidts) {
        console.warn('[GeminiAPI] Cookie file has no __Secure-1PSIDTS; falling back to .env value.');
        addCookie({
          name: '__Secure-1PSIDTS',
          value: this.secure1Psidts,
          domain: '.google.com',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        });
      }
    }

    // ── Filter to ONLY essential cookies needed for gemini.google.com ──
    // Non-essential cookies (NID, COMPASS, _ga*, _gcl*, accounts.google.com cookies, etc.)
    // are huge (several KB) and cause Google's response headers to exceed Node.js's
    // 16 KB default limit, triggering "Parse Error: Header overflow".
    const ESSENTIAL_COOKIE_NAMES = new Set([
      '__Secure-1PSID',
      '__Secure-1PSIDTS',
      '__Secure-1PSIDCC',
      '__Secure-1PAPISID',
      'SAPISID',
      'SID',
      'HSID',
      'SSID',
      'APISID',
      'SIDCC',
    ]);

    const filtered = cookies.filter(c => {
      if (!ESSENTIAL_COOKIE_NAMES.has(c.name)) return false;
      if (c.domain && c.domain.includes('accounts.google.com')) return false;
      return true;
    });

    if (filtered.length < cookies.length) {
      console.log(`[GeminiAPI] Filtered cookies: ${cookies.length} → ${filtered.length} (kept only essential auth cookies: ${filtered.map(c => c.name).join(', ')})`);
    }

    return filtered;
  }

  /**
   * Launch a headless Chromium and create an APIRequestContext with correct cookies.
   * Using Playwright gives us Chrome's exact TLS fingerprint, avoiding Google's bot detection.
   */
  async init() {
    if (this._initialized) return;

    for (let initAttempt = 1; initAttempt <= 2; initAttempt++) {
      try {
        const cookies = this._buildCookies();
        if (!cookies.length) {
          throw new Error('[GeminiAPI] No cookies found. Please check gemini-cookies/cookies.json or run "node login.js" to authenticate.');
        }

        await this.close();

        // Launch headless browser — needed for Playwright's APIRequestContext TLS stack
        const chromeChannel = process.env.PLAYWRIGHT_CHROME_CHANNEL !== undefined ? (process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined) : 'chrome';
        this._browser = await chromium.launch({
          channel: chromeChannel,
          headless: true,
        });
        const browserContext = await this._browser.newContext({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          ignoreHTTPSErrors: true,
        });
        await browserContext.addCookies(cookies);

        this._apiContext = browserContext.request;
        this._browserCtx = browserContext;

        // Get SNlM0e and session metadata
        await this._fetchAccessToken();

        // Warmup RPC calls (mirrors Python _init_rpc)
        await this._sendBardActivity();

        this._initialized = true;
        return;
      } catch (err) {
        const isAuthErr = isAuthenticationError(err.message);
        if (isAuthErr && initAttempt < 2) {
          console.warn(`[GeminiAPI] Init failed with auth error (${err.message}). Auto-refreshing cookies from chrome-data...`);
          try {
            const { refreshCookiesOnAuthError } = require('../gemini-cookie-refresher');
            const ok = await refreshCookiesOnAuthError(undefined, err.message);
            if (ok) {
              continue;
            }
          } catch (refErr) {
            console.warn(`[GeminiAPI] Auto-cookie refresh failed during init: ${refErr.message}`);
          }
        }
        await this.close();
        throw err;
      }
    }
  }

  async close() {
    this._initialized = false;
    try { if (this._browserCtx) await this._browserCtx.close(); } catch (_) {}
    try { if (this._browser) await this._browser.close(); } catch (_) {}
    this._apiContext = null;
    this._browser = null;
    this._browserCtx = null;
  }

  // ── Warmup helpers ────────────────────────────────────────────────────────

  /**
   * Send bard_activity_enabled warmup (mirrors Python _send_bard_activity).
   * Must be called before file uploads and content generation.
   */
  async _sendBardActivity() {
    try {
      await this._batchExecute('ESY5D', '[[[\'bard_activity_enabled\']]]');
    } catch (_) {
      // Non-fatal warmup call
    }
  }

  // ── Access Token ───────────────────────────────────────────────────────────

  /**
   * GET gemini.google.com/app to extract SNlM0e and session identifiers.
   * Uses the Playwright browser page to navigate directly, which bypasses Node.js HTTP
   * parser header size limits (avoiding "Parse Error: Header overflow" on large Google Set-Cookie headers).
   */
  async _fetchAccessToken() {
    let html = '';

    // Primary method: Navigate using Playwright browser page (immune to Node.js HTTP header overflow)
    if (this._browserCtx) {
      try {
        const page = await this._browserCtx.newPage();
        try {
          await page.goto(ENDPOINT_INIT, { waitUntil: 'domcontentloaded', timeout: 30000 });
          html = await page.content();
        } finally {
          await page.close().catch(() => {});
        }
      } catch (pageErr) {
        console.warn(`[GeminiAPI] Page navigation attempt failed (${pageErr.message}) — falling back to apiContext.get...`);
      }
    }

    // Fallback: APIRequestContext GET
    if (!html && this._apiContext) {
      const response = await this._apiContext.get(ENDPOINT_INIT, {
        headers: GEMINI_HEADERS,
      });

      if (!response.ok()) {
        throw new Error(`[GeminiAPI] Init failed: HTTP ${response.status()}`);
      }

      html = await response.text();
    }

    if (!html) {
      throw new Error('[GeminiAPI] Could not retrieve HTML from Gemini page.');
    }

    const match = (pattern) => {
      const m = html.match(pattern);
      return m ? m[1] : null;
    };

    this.accessToken = match(/"SNlM0e":\s*"(.*?)"/);
    this.buildLabel = match(/"cfb2h":\s*"(.*?)"/);
    this.sessionId = match(/"FdrFJe":\s*"(.*?)"/);
    this.language = match(/"TuX5cc":\s*"(.*?)"/) || 'en';
    this.pushId = match(/"qKIAYe":\s*"(.*?)"/) || 'feeds/mcudyrk2a4khkz';

    if (!this.accessToken) {
      throw new Error(
        '[GeminiAPI] Could not extract session token (SNlM0e) from Gemini page. ' +
        'Google account is logged out or cookies expired (CookieMismatch) — please run "node login.js" to re-login.'
      );
    }
  }

  // ── File Upload ────────────────────────────────────────────────────────────

  /**
   * Upload a single file to Google's Bard storage and return the URL identifier.
   * Mirrors gemini_webapi/utils/upload_file.py
   *
   * @param {Buffer} fileBuffer
   * @param {string} filename  - e.g. "image-01.png"
   * @param {string} mimeType  - e.g. "image/png"
   * @returns {Promise<string>} URL identifier e.g. "/contrib_service/ttl_1d/..."
   */
  async uploadFile(fileBuffer, filename, mimeType) {
    if (!this._initialized || !this._apiContext) {
      throw new Error('[GeminiAPI] Client chưa được khởi tạo (apiContext is null). Call init() first.');
    }
    const { body, contentType } = buildMultipartBody(fileBuffer, filename, mimeType);

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this._apiContext.post(ENDPOINT_UPLOAD, {
          headers: {
            'Origin': 'https://gemini.google.com',
            'Referer': 'https://gemini.google.com/',
            'X-Tenant-Id': 'bard-storage',
            'Push-ID': this.pushId,
            'Content-Type': contentType,
          },
          data: body,
          timeout: 30000,
        });

        if (!response.ok()) {
          const errText = await response.text().catch(() => '');
          throw new Error(`[GeminiAPI] Upload failed: HTTP ${response.status()} ${errText.slice(0, 200)}`);
        }

        return await response.text();
      } catch (err) {
        lastError = err;
        console.warn(`[GeminiAPI] Upload attempt ${attempt}/3 failed (${filename}): ${err.message}`);

        if (isAuthenticationError(err.message) && attempt < 3) {
          console.warn(`[GeminiAPI] 🚨 Auth error detected during upload (${filename}). Auto-refreshing cookies...`);
          try {
            const { refreshCookiesOnAuthError } = require('../gemini-cookie-refresher');
            const refreshed = await refreshCookiesOnAuthError(undefined, err.message);
            if (refreshed) {
              console.log('[GeminiAPI] 🔄 Re-initializing Gemini client for upload retry...');
              await this.close();
              await this.init();
              continue;
            }
          } catch (refErr) {
            console.warn(`[GeminiAPI] Auto-cookie refresh failed during upload: ${refErr.message}`);
          }
        }

        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
    }

    throw lastError;
  }

  _formatFileData(fileData, uiImageShape = false) {
    if (!fileData) return null;
    const items = Array.isArray(fileData) ? fileData : [fileData];

    return items.map((item) => {
      if (Array.isArray(item)) {
        const url = Array.isArray(item[0]) ? item[0][0] : item[0];
        const filename = item[1] || 'upload.png';
        const mimeType = item[2] || item.mimeType || 'image/png';
        return [[url, 1, null, mimeType], filename, null, null, null, null, null, null, [0]];
      }

      return [
        [item.url, 1, null, item.mimeType || 'image/png'],
        item.filename || item.name || 'upload.png',
        null,
        null,
        null,
        null,
        null,
        null,
        [0],
      ];
    });
  }

  // ── Generate Content ───────────────────────────────────────────────────────

  /**
   * Send a generate request and return the full collected response.
   * Mirrors gemini_webapi client._generate()
   *
   * @param {object} opts
   * @param {string} opts.prompt
   * @param {Array}  [opts.fileData]     - Already-uploaded file URL arrays: [[[url], filename], ...]
   * @param {boolean} [opts.temporary]  - If true, don't save to history
   * @returns {Promise<{ text: string, images: Array<{url:string}> }>}
   */
  async generateContent({ prompt, fileData = null, temporary = false, expectImages = false } = {}) {
    if (!this._initialized) throw new Error('[GeminiAPI] Call init() first.');
    if (!prompt) throw new Error('[GeminiAPI] Prompt cannot be empty.');

    const MAX_RETRIES = Math.max(1, parseInt(process.env.GEMINI_WEBAPI_GENERATE_MAX_RETRIES || '3', 10));
    let lastError;

    // Single warmup before all retries
    await this._sendBardActivity();

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this._doGenerateContent({ prompt, fileData, temporary, expectImages });
      } catch (err) {
        lastError = err;
        const msg = err.message || '';

        // Check for Auth error: auto-refresh cookies & re-init
        if (isAuthenticationError(msg) && attempt < MAX_RETRIES) {
          console.warn(`[GeminiAPI] 🚨 Auth error detected on attempt ${attempt}/${MAX_RETRIES} (${msg.split('\n')[0]}). Auto-refreshing cookies...`);
          try {
            const { refreshCookiesOnAuthError } = require('../gemini-cookie-refresher');
            const refreshed = await refreshCookiesOnAuthError(undefined, msg);
            if (refreshed) {
              console.log('[GeminiAPI] 🔄 Re-initializing Gemini client with fresh cookies...');
              await this.close();
              await this.init();
              continue;
            }
          } catch (refErr) {
            console.warn(`[GeminiAPI] Auto-cookie refresh failed: ${refErr.message}`);
          }
        }

        // Retry on temporary Gemini errors (1076, 1013)
        // Do NOT retry 'EmptyText' — that's a real image-only response being misidentified
        const isRetryable = msg.includes('error code') ||
                            msg.includes('temporary error') ||
                            msg.includes('Empty response') ||
                            msg.toLowerCase().includes('timeout');
        if (isRetryable && attempt < MAX_RETRIES) {
          // Exponential backoff with jitter: 8s, 12s, 16s, 20s...
          const baseDelay = 8000;
          const jitter = Math.floor(Math.random() * 2000);
          const delay = Math.min(baseDelay * attempt + jitter, 60000);
          console.error(`[GeminiAPI] Temporary error (attempt ${attempt}/${MAX_RETRIES}): ${msg.split('\n')[0]}. Retrying in ${Math.round(delay/1000)}s...`);
          await new Promise(r => setTimeout(r, delay));

          // Every 3 attempts, refresh session tokens (SNlM0e / cfb2h / FdrFJe may have expired)
          if (attempt % 3 === 0) {
            try {
              console.error(`[GeminiAPI] Refreshing session tokens (attempt ${attempt})...`);
              await this._fetchAccessToken();
              console.error(`[GeminiAPI] Session tokens refreshed.`);
            } catch (refreshErr) {
              console.error(`[GeminiAPI] Token refresh failed: ${refreshErr.message}`);
            }
          }

          // Re-warmup after a wait
          await this._sendBardActivity();
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /**
   * Internal single-attempt generate call.
   */
  async _doGenerateContent({ prompt, fileData = null, temporary = false, expectImages = false } = {}) {
    const reqid = this._reqid;
    this._reqid += 100000;
    const uuidVal = crypto.randomUUID().toUpperCase();

    const formattedFileData = this._formatFileData(fileData, expectImages);
    const messageContent = [prompt, 0, null, formattedFileData, null, null, 0];
    const innerReqList = new Array(expectImages ? 81 : 69).fill(null);
    innerReqList[0] = messageContent;
    innerReqList[1] = [this.language];
    innerReqList[2] = DEFAULT_METADATA;
    innerReqList[6] = [expectImages ? 0 : 1];
    innerReqList[STREAMING_FLAG_INDEX] = 1;  // index 7
    innerReqList[10] = 1;
    innerReqList[11] = 0;
    innerReqList[17] = [[0]];
    innerReqList[18] = 0;
    innerReqList[27] = 1;
    innerReqList[30] = [4];
    innerReqList[41] = [1];
    if (temporary) innerReqList[TEMPORARY_CHAT_FLAG_INDEX] = 1;  // index 45
    innerReqList[53] = 0;
    innerReqList[59] = uuidVal;
    innerReqList[61] = [];
    innerReqList[68] = expectImages ? 1 : 2;
    if (expectImages) {
      innerReqList[4] = crypto.randomBytes(16).toString('hex');
      innerReqList[79] = 1;
      innerReqList[80] = 1;
    }

    const fReq = JSON.stringify([null, JSON.stringify(innerReqList)]);

    const params = new URLSearchParams({
      hl: this.language,
      _reqid: String(reqid),
      rt: 'c',
    });
    if (this.buildLabel) params.set('bl', this.buildLabel);
    if (this.sessionId) params.set('f.sid', this.sessionId);

    const requestHeaders = {
      ...GEMINI_HEADERS,
      ...SAME_DOMAIN_HEADERS,
      'x-goog-ext-525005358-jspb': `["${uuidVal}",1]`,
      'x-goog-ext-73010989-jspb': '[0]',
      'x-goog-ext-73010990-jspb': expectImages ? '[0,0,0]' : '[0]',
    };
    if (expectImages) {
      requestHeaders['x-goog-ext-525001261-jspb'] = JSON.stringify([
        1,
        null,
        null,
        null,
        this.uiModelContextId,
        null,
        null,
        0,
        [4, 5, 6, 8],
        null,
        null,
        3,
        null,
        null,
        1,
        1,
        this.uiClientInstanceId,
      ]);
    }

    const bodyStr = buildFormBody({
      at: this.accessToken || '',
      'f.req': fReq,
    });

    const defaultTimeoutMs = expectImages ? 120000 : 300000;
    const GENERATE_TIMEOUT_MS = parseInt(process.env.GEMINI_GENERATE_TIMEOUT_MS || String(defaultTimeoutMs), 10);

    const response = await this._apiContext.post(
      `${ENDPOINT_GENERATE}?${params.toString()}`,
      {
        headers: requestHeaders,
        data: bodyStr,
        timeout: GENERATE_TIMEOUT_MS,
      }
    );

    if (!response.ok()) {
      const errText = await response.text().catch(() => '');
      throw new Error(
        `[GeminiAPI] StreamGenerate failed: HTTP ${response.status()}\n${errText.slice(0, 500)}`
      );
    }

    const rawText = await response.text();

    // Detect API error codes in response (e.g. 1076 = temporary error, 1100 = unauthenticated/session rejected)
    const errorCodeMatch = rawText.match(/BardErrorInfo"[^\]]*\[(\d+)\]/);
    if (errorCodeMatch) {
      const errCode = parseInt(errorCodeMatch[1], 10);
      if (errCode === 1100) {
        throw new Error('[GeminiAPI] Gemini API error 1100: Session rejected or unauthenticated. Google account logged out — please run "node login.js".');
      }
      throw new Error(`[GeminiAPI] Gemini API error code ${errCode} (temporary error, will retry)`);
    }

    const result = this._parseGenerateResponse(rawText);

    // Guard: if expecting images but got none, log raw response to diagnose path issues
    if (expectImages && result.images.length === 0) {
      const snippet = rawText.slice(0, 800);
      console.error('[GeminiAPI] ⚠️  Image expected but none found in response. Raw snippet:');
      console.error(snippet);
      console.error('[GeminiAPI] Text returned:', result.text.slice(0, 200) || '(empty)');

      // Detect Gemini switching to video generation mode instead of returning a still image.
      // When this happens the response is a polite refusal text, not a transient error —
      // retrying will not help and just wastes time. Throw a non-retryable error.
      const lowerText = result.text.toLowerCase();
      const isImageLimitResponse =
        lowerText.includes('create more images as soon as your limit resets') ||
        lowerText.includes('check your usage in settings') ||
        lowerText.includes('image limit') ||
        lowerText.includes('usage limit') ||
        lowerText.includes('limit resets') ||
        lowerText.includes('quota');

      if (isImageLimitResponse) {
        throw new Error(
          '[GeminiAPI] Gemini image generation limit reached for this account/session. ' +
          'Open AI Studio/Gemini Settings to check usage or wait for the image limit to reset.'
        );
      }

      const isVideoModeResponse =
        // Gemini saying it's generating a video
        lowerText.includes('đang tạo video') ||
        lowerText.includes('tôi đang tạo') ||
        lowerText.includes('creating video') ||
        lowerText.includes('generating video') ||
        lowerText.includes('video will be ready') ||
        // Gemini asking user to check back later
        lowerText.includes('kiểm tra lại') ||
        lowerText.includes('check back') ||
        // Gemini saying it misunderstood and offering image option instead
        lowerText.includes('tôi đã hiểu nhầm') ||
        lowerText.includes('i misunderstood') ||
        lowerText.includes('tạo hình ảnh') ||
        // Gemini mentioning video in a response when we expected an image
        (lowerText.includes('video') && lowerText.includes('vui lòng')) ||
        (lowerText.includes('video') && lowerText.includes('please'));

      if (isVideoModeResponse) {
        throw new Error(
          '[GeminiAPI] Gemini switched to video-generation mode instead of returning a still image. ' +
          'Non-retryable — adjust the prompt to avoid video triggers.'
        );
      }

      // Otherwise treat as a transient rate-limit / temporary error and allow retry
      throw new Error('[GeminiAPI] Image generation returned no images (temporary error, will retry)');
    }

    // Guard: text-only requests should not return completely empty
    if (!expectImages && !result.text && result.images.length === 0) {
      console.error('[GeminiAPI] ⚠️  Text-only request returned empty. Raw snippet:');
      console.error(rawText.slice(0, 1000));
      if (rawText.includes('BardErrorInfo') || rawText.includes('1100')) {
        throw new Error('[GeminiAPI] BardErrorInfo 1100: Session rejected or unauthenticated (AuthError)');
      }
      throw new Error('[GeminiAPI] Empty response received (temporary error, will retry)');
    }

    return result;
  }

  // ── Response Parsing ───────────────────────────────────────────────────────

  /**
   * Parse the streaming response from StreamGenerate.
   * Extracts text and generated images from the last complete candidate.
   *
   * @param {string} rawText
   * @returns {{ text: string, images: Array<{url: string}> }}
   */
  _parseGenerateResponse(rawText) {
    const parts = extractJsonFromResponse(rawText);
    const debugMode = process.env.GEMINI_DEBUG === '1';

    if (debugMode) {
      console.error(`[GeminiAPI debug] rawText length=${rawText.length}, parts=${parts.length}`);
      for (let i = 0; i < Math.min(parts.length, 6); i++) {
        const p = parts[i];
        const isArr = Array.isArray(p);
        console.error(`  part[${i}] isArr=${isArr} f[0]=${JSON.stringify(isArr ? p[0] : p)?.slice(0, 30)} f[2] type=${isArr ? typeof p[2] : 'N/A'}`);
        if (isArr && typeof p[2] === 'string' && p[2].length > 2) {
          try {
            const inner = JSON.parse(p[2]);
            console.error(`    inner[4] isArr=${Array.isArray(inner[4])} len=${Array.isArray(inner[4]) ? inner[4].length : 'N/A'}`);
            if (Array.isArray(inner[4]) && inner[4].length > 0) {
              console.error(`    cand[0][1][0]=${JSON.stringify(inner[4][0]?.[1]?.[0])?.slice(0, 100)}`);
            }
          } catch (e) { console.error(`    inner parse err: ${e.message}`); }
        }
      }
    }

    let text = '';
    const images = [];

    for (const part of parts) {
      // Each top-level part is an array like: ["wrb.fr", null, "<json_string>"]
      // The third element (index 2) is the stringified inner JSON
      if (!Array.isArray(part)) continue;

      const innerStr = getNestedValue(part, [2]);
      if (!innerStr || typeof innerStr !== 'string') continue;

      let innerJson;
      try { innerJson = JSON.parse(innerStr); } catch (_) { continue; }

      // innerJson structure (from debug observation):
      // [null, [cid, rid], {...metadata}, null, [[rcid, [text], ...]]]
      // candidates_list = innerJson[4]
      const candidatesList = getNestedValue(innerJson, [4], []);
      if (!Array.isArray(candidatesList) || candidatesList.length === 0) continue;

      for (const candidateData of candidatesList) {
        if (!Array.isArray(candidateData)) continue;

        // candidateData[1] = [text] — the main text response
        const candidateText = getNestedValue(candidateData, [1, 0], '');
        if (typeof candidateText === 'string' && candidateText.length > text.length) {
          text = candidateText;
        }

        // Generated images: candidateData[12][7][0] (plain generation)
        const genImgList = getNestedValue(candidateData, [12, 7, 0], []);
        if (Array.isArray(genImgList)) {
          for (const genImgData of genImgList) {
            const url = getNestedValue(genImgData, [0, 3, 3]);
            if (url && typeof url === 'string') {
              images.push({ url });
            }
          }
        }

        // Image-to-image variant: candidateData[12][0]["8"][0]
        const i2iImgList = getNestedValue(candidateData, [12, 0, '8', 0], []);
        if (Array.isArray(i2iImgList)) {
          for (const genImgData of i2iImgList) {
            const url = getNestedValue(genImgData, [0, 3, 3]);
            if (url && typeof url === 'string') {
              images.push({ url });
            }
          }
        }
      }
    }

    // Clean up googleusercontent artifact patterns
    text = text.replace(/http:\/\/googleusercontent\.com\/\w+\/\d+\n*/g, '');

    return { text, images };
  }

  // ── Image Download ─────────────────────────────────────────────────────────

  /**
   * Download a generated image URL with authentication cookies.
   * Appends =s2048-rj for full-size like gemini_webapi GeneratedImage._perform_save().
   *
   * @param {string} url
   * @returns {Promise<Buffer>} PNG/JPEG buffer
   */
  async downloadImage(url) {
    if (!this._initialized) throw new Error('[GeminiAPI] Call init() first.');

    // Upgrade to full size (mirrors GeneratedImage._perform_save full_size=True)
    let fetchUrl = url;
    if (!fetchUrl.includes('=s2048-rj') && !fetchUrl.includes('=s1024-rj')) {
      fetchUrl = fetchUrl + '=s2048-rj';
    } else if (fetchUrl.includes('=s1024-rj')) {
      fetchUrl = fetchUrl.replace('=s1024-rj', '=s2048-rj');
    }

    const urls = [...new Set([fetchUrl, url])];
    const headers = {
      'Origin': 'https://gemini.google.com',
      'Referer': 'https://gemini.google.com/',
    };
    const attempts = Math.max(1, parseInt(process.env.GEMINI_IMAGE_DOWNLOAD_RETRIES || '5', 10));
    const timeout = Math.max(10000, parseInt(process.env.GEMINI_IMAGE_DOWNLOAD_TIMEOUT_MS || '60000', 10));
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      for (const candidateUrl of urls) {
        try {
          const response = await this._apiContext.get(candidateUrl, { headers, timeout });
          if (response.ok()) {
            return Buffer.from(await response.body());
          }
          lastError = new Error(`HTTP ${response.status()}`);
        } catch (error) {
          lastError = error;
        }
      }

      if (attempt < attempts) {
        const waitMs = Math.min(1500 * attempt + Math.floor(Math.random() * 500), 8000);
        console.warn(
          `[GeminiAPI] Image download attempt ${attempt}/${attempts} failed: ` +
          `${lastError?.message || lastError}. Retrying in ${Math.round(waitMs / 1000)}s...`
        );
        await delay(waitMs);
      }
    }

    throw new Error(`[GeminiAPI] Image download failed after ${attempts} attempt(s): ${lastError?.message || lastError}`);
  }

  // ── Batch Execute (bard settings warmup) ──────────────────────────────────

  /**
   * Send a batchexecute call (used for warmup/settings by gemini_webapi).
   * We keep a lightweight version for _sendBardActivity warmup before uploads.
   * @param {string} rpcid
   * @param {string} payload
   */
  async _batchExecute(rpcid, payload) {
    const reqid = this._reqid;
    this._reqid += 100000;

    const params = new URLSearchParams({
      rpcids: rpcid,
      hl: this.language,
      _reqid: String(reqid),
      rt: 'c',
      'source-path': '/app',
    });
    if (this.buildLabel) params.set('bl', this.buildLabel);
    if (this.sessionId) params.set('f.sid', this.sessionId);

    const fReq = JSON.stringify([[[rpcid, payload, null, 'generic']]]);

    const bodyStr = buildFormBody({
      at: this.accessToken || '',
      'f.req': fReq,
    });

    const response = await this._apiContext.post(
      `${ENDPOINT_BATCH_EXEC}?${params.toString()}`,
      {
        headers: {
          ...GEMINI_HEADERS,
          'x-goog-ext-525001261-jspb': '[1,null,null,null,null,null,null,null,[4]]',
          'x-goog-ext-73010989-jspb': '[0]',
          ...SAME_DOMAIN_HEADERS,
        },
        data: Buffer.from(bodyStr, 'utf8'),
      }
    );

    // Non-fatal — batch execute is only a warmup
    return response;
  }
}

module.exports = { GeminiApiClient, parseResponseByFrame, extractJsonFromResponse, getNestedValue };
