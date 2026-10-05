const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { getExtensionArgs } = require('../utils/extension-loader');
const { getWindowLaunchConfig, applyWindowBounds, ensureProfileWindowPlacement } = require('../utils/window-config');
const { getConfig } = require('../utils/config-manager');

const config = getConfig(path.resolve(__dirname, '..'));

const PROJECT_URL = config.systemSettings.flowProjectUrl || 'https://flow.google.com/project/8ac10c4a-44b5-4d55-b470-10ab24db4c1c';
const PROJECT_ID = config.systemSettings.flowProjectId || '8ac10c4a-44b5-4d55-b470-10ab24db4c1c';
const SITE_KEY = config.systemSettings.recaptchaSiteKey || '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

let globalContext = null;
let globalPage = null;
const tokenInterceptedPages = new WeakSet();

// ── Bearer token management ──────────────────────────────────
let cachedBearerToken = null;
let tokenCapturedAt = 0;
const blacklistedBearerTokens = new Set();

// ── reCAPTCHA high-score token pool (intercepted từ request thật của user) ──
// Token từ browser thật có score cao hơn nhiều so với generate bằng Playwright
const interceptedRecaptchaTokens = [];
const MAX_INTERCEPTED_TOKENS = 20;
const INTERCEPTED_TOKEN_TTL = 90 * 1000; // reCAPTCHA token hết hạn sau ~2 phút

function cacheInterceptedRecaptchaToken(token) {
  if (!token || token.length < 100) return;
  // Không cache token đã có
  if (interceptedRecaptchaTokens.some(t => t.token === token)) return;
  interceptedRecaptchaTokens.push({ token, capturedAt: Date.now() });
  // Giữ tối đa MAX_INTERCEPTED_TOKENS token gần nhất
  if (interceptedRecaptchaTokens.length > MAX_INTERCEPTED_TOKENS) {
    interceptedRecaptchaTokens.splice(0, interceptedRecaptchaTokens.length - MAX_INTERCEPTED_TOKENS);
  }
  console.log('[Browser] 📦 Cached intercepted reCAPTCHA token (' + token.length + ' chars). Pool size: ' + interceptedRecaptchaTokens.length);
}

function popInterceptedRecaptchaToken() {
  const now = Date.now();
  // Lọc token còn hạn
  while (interceptedRecaptchaTokens.length > 0 && (now - interceptedRecaptchaTokens[0].capturedAt) > INTERCEPTED_TOKEN_TTL) {
    interceptedRecaptchaTokens.shift();
  }
  if (interceptedRecaptchaTokens.length === 0) return null;
  // Lấy token mới nhất (cuối mảng) để đảm bảo còn hạn nhất
  const entry = interceptedRecaptchaTokens.pop();
  return entry.token;
}

function attachGlobalRequestInterceptor(context) {
  if (!context || context._hasTokenInterceptor) return;
  context._hasTokenInterceptor = true;
  context.on('request', request => {
    const url = request.url();
    // Widen capture: any googleapis.com or labs.google or flow.google.com request with Bearer auth
    if (url.includes('googleapis.com') || url.includes('labs.google') || url.includes('flow.google.com')) {
      const auth = request.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ')) {
        const token = auth.substring(7);
        if (!blacklistedBearerTokens.has(token)) {
          cachedBearerToken = token;
          tokenCapturedAt = Date.now();
        }
      }

    }
  });
}

function setupTokenInterceptor(page) {
  if (tokenInterceptedPages.has(page)) return;
  tokenInterceptedPages.add(page);
  page.on('request', request => {
    const url = request.url();
    if (url.includes('googleapis.com') || url.includes('labs.google') || url.includes('flow.google.com')) {
      const auth = request.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ')) {
        const token = auth.substring(7);
        if (!blacklistedBearerTokens.has(token)) {
          cachedBearerToken = token;
          tokenCapturedAt = Date.now();
        }
      }

    }
  });
}

async function adoptBrowserPage(context, page) {
  globalContext = context;
  globalPage = page;
  attachGlobalRequestInterceptor(globalContext);
  setupTokenInterceptor(globalPage);
  await handleAuthRedirect(globalPage, globalContext);
  return globalPage;
}

function invalidateBearerToken(token) {
  if (token && typeof token === 'string') {
    blacklistedBearerTokens.add(token.trim());
  }
  if (cachedBearerToken) {
    blacklistedBearerTokens.add(cachedBearerToken.trim());
  }
  cachedBearerToken = null;
  tokenCapturedAt = 0;
  console.log(`[Browser] Bearer token invalidated (blacklisted total: ${blacklistedBearerTokens.size}).`);
}

/**
 * Lấy Bearer token từ labs.google NextAuth session API.
 * Chỉ dùng HTTP request (không mở tab). Session cookie trong context có thể còn hợp lệ
 * ngay cả khi trang labs.google visual trông như chưa login.
 */
async function getBearerTokenFromSession(context) {
  try {
    const res = await context.request.get('https://labs.google/fx/api/auth/session', {
      headers: { 'Accept': 'application/json' },
      timeout: 8000
    });
    if (!res.ok()) return null;
    const data = await res.json();
    if (data && data.access_token && !data.error) return data.access_token;
    return null;
  } catch (_) {
    return null;
  }
}
async function ensureBearerToken(page, forceRefresh = false, options = {}) {
  // 1. Check in-memory cached token (valid for 25 mins)
  if (!forceRefresh && cachedBearerToken && !blacklistedBearerTokens.has(cachedBearerToken) && (Date.now() - tokenCapturedAt) < 25 * 60 * 1000) {
    return cachedBearerToken;
  }

  const context = page ? (typeof page.context === 'function' ? page.context() : page) : globalContext;

  // 2. Try labs.google session API (HTTP only, no tab opened)
  // Session cookies may still be valid even if labs.google UI looks not-logged-in.
  if (context && !forceRefresh) {
    const sessionToken = await getBearerTokenFromSession(context);
    if (sessionToken && !blacklistedBearerTokens.has(sessionToken)) {
      cachedBearerToken = sessionToken;
      tokenCapturedAt = Date.now();
      console.log('[Browser] ✅ Bearer token from labs.google session API.');
      return cachedBearerToken;
    }
  }

  // If quick check requested, or token is optional on Flow native RPC, avoid slow disruptive page reloads
  if (options.quick || options.optional) {
    if (cachedBearerToken && !blacklistedBearerTokens.has(cachedBearerToken)) {
      return cachedBearerToken;
    }
    if (options.optional) return null;
  }

  // 3. Fallback: page reload/navigate to trigger network interceptor
  // Note: flow.google.com uses cookie session with batchexecute RPCs (MZZa6b, ogiZ0b, maseQ) rather than REST Bearer tokens.
  const isFlowPage = page && typeof page.url === 'function' && page.url().includes('flow.google.com');
  if (isFlowPage) {
    if (cachedBearerToken && !blacklistedBearerTokens.has(cachedBearerToken)) {
      return cachedBearerToken;
    }
    return null;
  }

  if (page && typeof page.reload === 'function') {
    const currentUrl = page.url();
    const flowUrl = currentUrl.includes('flow.google.com') ? currentUrl : PROJECT_URL;

    console.log('[Browser] Bearer token needs refresh — reloading flow page to capture fresh token...');
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(1000);
        if (cachedBearerToken && !blacklistedBearerTokens.has(cachedBearerToken) && (Date.now() - tokenCapturedAt) < 25 * 60 * 1000) {
          console.log('[Browser] ✅ Captured Bearer token via network interceptor after reload.');
          return cachedBearerToken;
        }
      }
    } catch (_) {}

    // Second attempt: navigate directly to flowUrl
    console.log(`[Browser] Reload did not yield token — navigating fresh to ${flowUrl}...`);
    try {
      await page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      for (let i = 0; i < 15; i++) {
        await page.waitForTimeout(1000);
        if (cachedBearerToken && !blacklistedBearerTokens.has(cachedBearerToken) && (Date.now() - tokenCapturedAt) < 25 * 60 * 1000) {
          console.log('[Browser] ✅ Captured Bearer token via network interceptor after fresh navigation.');
          return cachedBearerToken;
        }
      }
    } catch (_) {}
  }

  if (!cachedBearerToken || blacklistedBearerTokens.has(cachedBearerToken)) {
    if (options.optional) return null;
    throw new Error('[Browser] Could not capture valid Bearer token from network interceptor');
  }
  return cachedBearerToken;
}

// ── reCAPTCHA token ─────────────────────────────────────────────
const TOKEN_CACHE_FILE = path.join(path.resolve(__dirname, '..'), 'recaptcha-token-cache.json');

function popTokenFromFileCache() {
  try {
    if (!fs.existsSync(TOKEN_CACHE_FILE)) return null;
    const cache = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf-8'));
    if (!cache.tokens || cache.tokens.length === 0) return null;
    const now = Date.now();
    // Lọc token còn hạn (< 90s)
    const valid = cache.tokens.filter(t => (now - t.capturedAt) < 90000);
    if (valid.length === 0) {
      fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify({ tokens: [] }, null, 2), 'utf-8');
      return null;
    }
    // Lấy token mới nhất
    const entry = valid[valid.length - 1];
    // Xóa khỏi file
    const remaining = valid.slice(0, -1);
    fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify({ tokens: remaining }, null, 2), 'utf-8');
    console.log(`[Browser] 📂 Loaded high-score token from file cache (${entry.token.length} chars). Remaining: ${remaining.length}`);
    return entry.token;
  } catch (_) {
    return null;
  }
}

async function getRecaptchaToken(page, action = 'IMAGE_GENERATION') {
  // ƯU TIÊN 1: dùng intercepted high-score token từ in-memory pool
  const intercepted = popInterceptedRecaptchaToken();
  if (intercepted) {
    console.log('[Browser] ✅ Using intercepted high-score reCAPTCHA token (' + intercepted.length + ' chars) from memory.');
    return intercepted;
  }

  // ƯU TIÊN 2: dùng token từ file cache (warmup-browser.js ghi)
  const fileToken = popTokenFromFileCache();
  if (fileToken) {
    console.log('[Browser] ✅ Using high-score reCAPTCHA token from file cache (' + fileToken.length + ' chars).');
    return fileToken;
  }

  // Fallback: generate token từ page hiện tại (flow.google.com có grecaptcha.enterprise)
  // NOTE: flow.google.com đã xác nhận có site key 6LdsFiUs... và grecaptcha.enterprise loaded

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  }).catch(() => {});

  // Simulate human activity to improve reCAPTCHA Enterprise score
  try {
    const vp = page.viewportSize() || { width: 1280, height: 800 };
    const cx = Math.floor(vp.width * 0.3 + Math.random() * vp.width * 0.4);
    const cy = Math.floor(vp.height * 0.3 + Math.random() * vp.height * 0.4);
    await page.mouse.move(cx, cy, { steps: 8 });
    await page.waitForTimeout(120 + Math.floor(Math.random() * 200));
    await page.mouse.move(cx + 30, cy - 20, { steps: 5 });
    await page.waitForTimeout(80 + Math.floor(Math.random() * 120));
    await page.mouse.move(cx - 10, cy + 15, { steps: 4 });
    await page.waitForTimeout(60 + Math.floor(Math.random() * 100));
    // Light scroll gesture
    await page.mouse.wheel(0, 60 + Math.floor(Math.random() * 40));
    await page.waitForTimeout(100);
    await page.mouse.wheel(0, -(60 + Math.floor(Math.random() * 40)));
    await page.waitForTimeout(150 + Math.floor(Math.random() * 100));
  } catch (_) {}

  // Wait up to 10 seconds for grecaptcha.enterprise to be ready on the page
  try {
    await page.waitForFunction(
      () => typeof grecaptcha !== 'undefined' && typeof grecaptcha.enterprise !== 'undefined',
      { timeout: 10000 }
    );
  } catch (_) {}

  const token = await page.evaluate(async ({ siteKey, action }) => {
    if (typeof grecaptcha === 'undefined' || !grecaptcha.enterprise) {
      throw new Error('grecaptcha.enterprise not loaded');
    }
    return await grecaptcha.enterprise.execute(siteKey, { action });
  }, { siteKey: SITE_KEY, action });
  return token;
}

// ── Auth redirect recovery ───────────────────────────────────
async function handleAuthRedirect(page, context, targetProjectUrl = null) {
  const currentUrl = page.url();
  const isAuthError = currentUrl.includes('error=Callback') || currentUrl.includes('signin?error');
  const isUnsupported = currentUrl.includes('unsupported-country');

  if (isAuthError || isUnsupported) {
    console.log(`[Browser] ⚠️ Auth redirect detected: ${currentUrl}`);
    console.log('[Browser] Fixing callback-url cookie and retrying...');

    // Fix the callback-url cookie
    await context.addCookies([{
      name: '__Secure-next-auth.callback-url',
      value: 'https%3A%2F%2Flabs.google%2Ffx%2Ftools%2Fimage-fx',
      domain: 'labs.google',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax'
    }]);

    // Clear bad state and retry
    const destination = targetProjectUrl || PROJECT_URL;
    await page.goto(destination);
    await page.waitForTimeout(6000);

    const retryUrl = page.url();
    if (retryUrl.includes('error=Callback') || retryUrl.includes('signin?error')) {
      console.error('[Browser] ❌ Auth still failing after cookie fix. Session token may be expired — re-export cookies manually.');
      throw new Error('Google Labs authentication failed. Please re-login and export fresh cookies.');
    }
    console.log('[Browser] ✅ Auth recovery successful');
  }

  // Handle Google Flow landing page (/about) redirect
  if (page.url().includes('flow.google.com/about') || page.url().endsWith('/about')) {
    console.log('[Browser] ℹ️ Flow landing page detected (/about). Activating studio session...');
    const btn = await page.$('button:has-text("Create with Google Flow"), a:has-text("Create with Google Flow"), button:has-text("Try in Google Flow")').catch(() => null);
    if (btn) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(4000);
      const destination = targetProjectUrl || PROJECT_URL;
      if (destination && !page.url().includes(destination)) {
        console.log(`[Browser] Navigating back to target project: ${destination}`);
        await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);
      }
    }
  }
}

// ── Auto-launch Chrome thật (CDP) ────────────────────────────
// Chrome do Playwright khởi chạy bị Flow chấm điểm reCAPTCHA thấp (PUBLIC_ERROR_UNUSUAL_ACTIVITY),
// còn Chrome thật mở cổng 9222 thì gen bình thường. Nên nếu cổng 9222 đang đóng, tự mở Chrome thật
// (tiến trình tách rời, sống tiếp khi server tắt) rồi kết nối qua CDP.
// Tắt: CHROME_AUTO_CDP=false. Tuỳ chỉnh: CHROME_BINARY, CHROME_CDP_DATA_DIR.
let chromeCdpLaunchPromise = null;

async function isCdpPortOpen(cdpPort) {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch (_) {
    return false;
  }
}

function ensureRealChromeCdp(cdpPort) {
  if (chromeCdpLaunchPromise) return chromeCdpLaunchPromise;
  chromeCdpLaunchPromise = (async () => {
    try {
      if (String(process.env.CHROME_AUTO_CDP || '').toLowerCase() === 'false') return false;
      if (process.env.HEADLESS === 'true') return false;
      if (await isCdpPortOpen(cdpPort)) return true;

      const binary = process.env.CHROME_BINARY
        || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);
      if (!binary || !fs.existsSync(binary)) {
        console.log('[Browser] ℹ️ Không tìm thấy Chrome thật để tự mở CDP — dùng Chrome do Playwright khởi chạy.');
        return false;
      }
      const dataDir = process.env.CHROME_CDP_DATA_DIR
        || path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome-CDP');
      fs.mkdirSync(dataDir, { recursive: true });

      console.log(`[Browser] 🚀 Cổng ${cdpPort} đang đóng — tự mở Chrome thật (profile: ${dataDir})...`);
      const child = spawn(binary, [
        `--user-data-dir=${dataDir}`,
        `--remote-debugging-port=${cdpPort}`,
        '--remote-allow-origins=*',
        '--restore-last-session',
      ], { detached: true, stdio: 'ignore' });
      child.on('error', (e) => console.log(`[Browser] ⚠️ Không mở được Chrome thật: ${e.message}`));
      child.unref();

      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await isCdpPortOpen(cdpPort)) {
          console.log(`[Browser] ✅ Chrome thật đã sẵn sàng tại cổng ${cdpPort}.`);
          return true;
        }
      }
      console.log(`[Browser] ⚠️ Chrome thật chưa mở cổng ${cdpPort} sau 20s — dùng Chrome do Playwright khởi chạy.`);
      return false;
    } catch (e) {
      console.log(`[Browser] ⚠️ ensureRealChromeCdp lỗi: ${e.message}`);
      return false;
    } finally {
      chromeCdpLaunchPromise = null;
    }
  })();
  return chromeCdpLaunchPromise;
}

// ── Browser page management ──────────────────────────────────
async function getSharedContext(baseDir = path.resolve(__dirname, '..')) {
  const userDataDir = path.join(baseDir, 'chrome-data');
  const cookieFile = path.join(baseDir, 'labs.google.cookies.json');

  if (globalContext) {
    try {
      globalContext.pages();
    } catch (e) {
      console.log('[Browser] Shared context is dead, resetting...');
      globalContext = null;
      globalPage = null;
    }
  }

  const cdpPort = process.env.CHROME_CDP_PORT || '9222';

  // Hot-swap: nếu đang chạy standalone context nhưng port 9222 của Chrome thật vừa bật lên -> chuyển ngay sang Chrome CDP
  if (globalContext && !globalContext._isCdp) {
    try {
      const cdpCheck = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (cdpCheck.ok) {
        console.log(`[Browser] 🔌 Phát hiện Chrome thật đã bật tại port ${cdpPort}. Đang chuyển đổi từ standalone sang Chrome CDP...`);
        try { await globalContext.close(); } catch (_) {}
        globalContext = null;
        globalPage = null;
      }
    } catch (_) {}
  }

  if (!globalContext) {
    // Ưu tiên 0: nếu cổng CDP đóng thì tự mở Chrome thật (chống bị Flow chặn do Chrome Playwright)
    await ensureRealChromeCdp(cdpPort);
    // Ưu tiên 1: Tự động kết nối tới Chrome thật nếu port 9222 đang mở (100% genuine profile)
    try {
      const cdpRes = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (cdpRes.ok) {
        console.log(`[Browser] 🔌 Phát hiện Chrome thật đang chạy tại port ${cdpPort}. Đang kết nối qua CDP...`);
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
        globalContext = browser.contexts()[0];
        globalContext._isCdp = true;
        attachGlobalRequestInterceptor(globalContext);
        console.log('[Browser] ✅ Kết nối CDP thành công! Sử dụng Chrome thật với Profile ULTRA (100% human trust).');
        return globalContext;
      }
    } catch (_) { }

    console.log('[Browser] Launching shared persistent context...');
    const isHeadless = process.env.HEADLESS === 'true';

    // Remove stale locks if present
    try {
      if (fs.existsSync(userDataDir)) {
        for (const f of fs.readdirSync(userDataDir)) {
          if (f.startsWith('Singleton')) {
            try { fs.unlinkSync(path.join(userDataDir, f)); } catch (_) { }
          }
        }
      }
    } catch (_) { }

    // Reset crash status in Preferences so Chrome never shows "Something went wrong when opening your profile"
    try {
      const prefsPath = path.join(userDataDir, 'Default', 'Preferences');
      if (fs.existsSync(prefsPath)) {
        const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
        if (prefs.profile) {
          prefs.profile.exit_type = 'Normal';
          prefs.profile.exited_cleanly = true;
          fs.writeFileSync(prefsPath, JSON.stringify(prefs));
        }
      }
    } catch (_) { }

    const chromeChannel = process.env.PLAYWRIGHT_CHROME_CHANNEL !== undefined ? (process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined) : 'chrome';
    const winConfig = getWindowLaunchConfig(baseDir);
    ensureProfileWindowPlacement(userDataDir, winConfig);

    const launchOptions = {
      channel: chromeChannel,
      headless: isHeadless,
      ignoreHTTPSErrors: true,
      viewport: null,
      args: [
        '--disable-blink-features=AutomationControlled',
        ...winConfig.windowArgs,
        ...getExtensionArgs(baseDir),
      ],
      acceptDownloads: true
    };

    globalContext = await chromium.launchPersistentContext(userDataDir, launchOptions);
    globalContext._isCdp = false;
    attachGlobalRequestInterceptor(globalContext);

    if (!isHeadless) {
      await applyWindowBounds(globalContext, winConfig);
    }

    const targetCookieFile = fs.existsSync(cookieFile)
      ? cookieFile
      : (fs.existsSync(path.join(baseDir, 'gemini-cookies', 'cookies.json')) ? path.join(baseDir, 'gemini-cookies', 'cookies.json') : null);

    if (targetCookieFile) {
      try {
        const cookies = JSON.parse(fs.readFileSync(targetCookieFile, 'utf-8'));
        await globalContext.addCookies(cookies);
        console.log(`[Browser] Loaded ${cookies.length} cookies from ${targetCookieFile}`);
      } catch (e) {
        console.log(`[Browser] Failed to load cookies: ${e.message}`);
      }
    }


  }

  return globalContext;
}

async function getBrowserPage(baseDir) {
  const context = await getSharedContext(baseDir);
  const cookieFile = path.join(baseDir, 'labs.google.cookies.json');

  if (!globalPage || globalPage.isClosed()) {
    console.log('[Browser] Getting or creating page...');
    try {
      const existingPages = context.pages();
      globalPage = existingPages.length > 0 ? existingPages[0] : await context.newPage();
    } catch (e) {
      console.log('[Browser] Page acquisition failed, reloading context...');
      try { await context.close(); } catch (_) { }
      globalContext = null;

      const newContext = await getSharedContext(baseDir);
      const newPages = newContext.pages();
      globalPage = newPages.length > 0 ? newPages[0] : await newContext.newPage();
    }
    setupTokenInterceptor(globalPage);
    const isHeadless = process.env.HEADLESS === 'true';
    if (!isHeadless) {
      const winConfig = getWindowLaunchConfig(baseDir);
      await applyWindowBounds(context, winConfig, globalPage);
    }
    await globalPage.goto(PROJECT_URL);
    await globalPage.waitForTimeout(6000);
    await handleAuthRedirect(globalPage, context);
  } else {
    if (!globalPage.url().includes(PROJECT_URL)) {
      await globalPage.goto(PROJECT_URL);
      await globalPage.waitForTimeout(5000);
      await handleAuthRedirect(globalPage, context);
    } else {
      await globalPage.keyboard.press('Escape');
      await globalPage.waitForTimeout(500);
    }
  }
  return globalPage;
}

function extractProjectIdFromPage(page, fallback = PROJECT_ID) {
  if (!page) return fallback;
  try {
    const url = typeof page.url === 'function' ? page.url() : String(page);
    const match = url.match(/\/project\/([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      return match[1];
    }
  } catch (_) {}
  return fallback;
}

function resolveFlowProject(chatId = null, template = null, baseDir = null) {
  const cfg = getConfig(baseDir || path.resolve(__dirname, '..'));
  if (chatId && cfg.channels && cfg.channels[String(chatId)]?.flowProjectId) {
    const ch = cfg.channels[String(chatId)];
    return {
      projectId: ch.flowProjectId,
      projectUrl: ch.flowProjectUrl || `https://flow.google.com/project/${ch.flowProjectId}`
    };
  }
  if (template === 'template_mom' || template === 'tmom' || template === 'templatemom') {
    if (cfg.motherBabySettings?.flowProjectId) {
      return {
        projectId: cfg.motherBabySettings.flowProjectId,
        projectUrl: cfg.motherBabySettings.flowProjectUrl || `https://flow.google.com/project/${cfg.motherBabySettings.flowProjectId}`
      };
    }
  }
  const defaultProjectId = cfg.systemSettings?.flowProjectId || '8ac10c4a-44b5-4d55-b470-10ab24db4c1c';
  const defaultProjectUrl = cfg.systemSettings?.flowProjectUrl || `https://flow.google.com/project/${defaultProjectId}`;
  return {
    projectId: defaultProjectId,
    projectUrl: defaultProjectUrl
  };
}

/**
 * Create an isolated browser page (tab) for a concurrent flow.
 * Shares the same browser context (cookies, auth) but each flow
 * gets its own page so they don't interfere with each other.
 * The page navigates to target project URL and is ready for API use.
 */
async function createFlowPage(baseDir, customProjectUrl = null) {
  const context = await getSharedContext(baseDir);
  const winConfig = getWindowLaunchConfig(baseDir);
  const isHeadless = process.env.HEADLESS === 'true';
  const page = await context.newPage();
  if (!isHeadless && !context._isCdp) {
    await applyWindowBounds(context, winConfig, page);
  }
  setupTokenInterceptor(page);
  const targetUrl = customProjectUrl || PROJECT_URL;
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (navErr) {
    if (page.url().includes('flow.google.com')) {
      console.log(`[Browser] Flow page reached ${page.url()}, proceeding...`);
    } else {
      throw navErr;
    }
  }
  // Quick check for Bearer token — flow.google.com uses native cookie RPC, Bearer is optional
  let tokenReady = false;
  for (let i = 0; i < 2; i++) {
    if (cachedBearerToken && !blacklistedBearerTokens.has(cachedBearerToken)) {
      tokenReady = true;
      console.log(`[Browser] ✅ Bearer token captured during page load (${i + 1}s).`);
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!tokenReady) {
    console.log('[Browser] ℹ️ Flow page ready with native session cookies (Bearer token optional).');
  }
  await handleAuthRedirect(page, context, targetUrl);

  // Warm up reCAPTCHA score with realistic UI interactions
  // (reCAPTCHA Enterprise scores are session-based — interactions accumulate trust)
  try {
    const vp = page.viewportSize() || { width: 1280, height: 800 };
    // Simulate natural browsing: move mouse around, scroll, click background
    await page.mouse.move(
      Math.floor(vp.width * 0.4 + Math.random() * vp.width * 0.2),
      Math.floor(vp.height * 0.3 + Math.random() * vp.height * 0.2),
      { steps: 12 }
    );
    await page.waitForTimeout(400 + Math.floor(Math.random() * 300));
    await page.mouse.wheel(0, 80);
    await page.waitForTimeout(200);
    await page.mouse.wheel(0, -80);
    await page.waitForTimeout(300 + Math.floor(Math.random() * 200));
    // Click on a safe background area to register user gesture
    await page.mouse.click(
      Math.floor(vp.width * 0.5 + Math.random() * 100 - 50),
      Math.floor(vp.height * 0.6 + Math.random() * 80 - 40)
    );
    await page.waitForTimeout(500 + Math.floor(Math.random() * 300));
    await page.mouse.move(
      Math.floor(vp.width * 0.3 + Math.random() * vp.width * 0.4),
      Math.floor(vp.height * 0.4 + Math.random() * vp.height * 0.3),
      { steps: 8 }
    );
    await page.waitForTimeout(300 + Math.floor(Math.random() * 200));
  } catch (_) {}

  const detectedProjectId = extractProjectIdFromPage(page);
  console.log(`[Browser] Created flow page (tab) [project: ${detectedProjectId}] — ${page.url().substring(0, 60)}...`);
  return page;
}

/**
 * Close a flow-specific page (tab) quietly.
 */
async function closeFlowPage(page) {
  try {
    if (page && !page.isClosed()) {
      await page.close();
      console.log('[Browser] Closed flow page (tab).');
    }
  } catch (err) {
    console.log(`[Browser] ⚠️ Could not close flow page: ${err.message}`);
  }
}

function getContext() {
  return globalContext;
}

module.exports = {
  getBrowserPage,
  getSharedContext,
  createFlowPage,
  closeFlowPage,
  adoptBrowserPage,
  getContext,
  ensureBearerToken,
  invalidateBearerToken,
  getRecaptchaToken,
  popInterceptedRecaptchaToken,
  cacheInterceptedRecaptchaToken,
  extractProjectIdFromPage,
  resolveFlowProject,
  PROJECT_URL,
  PROJECT_ID,
  SITE_KEY
};
