const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
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

function attachGlobalRequestInterceptor(context) {
  if (!context || context._hasTokenInterceptor) return;
  context._hasTokenInterceptor = true;
  context.on('request', request => {
    const url = request.url();
    if (url.includes('aisandbox-pa.googleapis.com') || url.includes('labs.google')) {
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
    if (url.includes('aisandbox-pa.googleapis.com') || url.includes('labs.google')) {
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

async function getBearerTokenFromSession(context) {
  try {
    const res = await context.request.get('https://labs.google/fx/api/auth/session', {
      headers: {
        'Accept': 'application/json',
      },
      timeout: 10000
    });
    if (!res.ok()) return null;
    const data = await res.json();
    if (data && data.access_token && !data.error) {
      return data.access_token;
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function triggerSilentOAuthRefresh(context, baseDir) {
  console.log('[Browser] Triggering silent NextAuth Google OAuth refresh for Bearer token...');
  const page = await context.newPage();
  try {
    await page.goto('https://labs.google/fx/api/auth/signin/google', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const formSubmitted = await page.evaluate(() => {
      const form = document.querySelector('form[action*="/signin/google"]');
      if (form) {
        form.submit();
        return true;
      }
      return false;
    });

    if (!formSubmitted) {
      const btn = await page.$('button, input[type="submit"]');
      if (btn) await btn.click();
    }

    // Wait for redirect to finish back to labs.google
    await page.waitForURL(url => url.origin === 'https://labs.google' && !url.pathname.includes('/signin'), { timeout: 25000 });
    await page.waitForTimeout(1000);
    console.log('[Browser] Silent OAuth refresh completed. Current URL:', page.url());

    // Save refreshed cookies so session token stays fresh on disk
    try {
      const allCookies = await context.cookies();
      const cookieFile = path.join(baseDir, 'labs.google.cookies.json');
      fs.writeFileSync(cookieFile, JSON.stringify(allCookies, null, 2), 'utf-8');
      console.log(`[Browser] Saved ${allCookies.length} refreshed cookies to labs.google.cookies.json`);
    } catch (_) {}
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

async function ensureBearerToken(page, forceRefresh = false) {
  // 1. Check in-memory cached token (valid for 25 mins if not force-refreshed and not blacklisted)
  if (!forceRefresh && cachedBearerToken && !blacklistedBearerTokens.has(cachedBearerToken) && (Date.now() - tokenCapturedAt) < 25 * 60 * 1000) {
    return cachedBearerToken;
  }

  const context = page ? (typeof page.context === 'function' ? page.context() : page) : globalContext;
  if (!context) {
    throw new Error('[Browser] Cannot ensure Bearer token: context is not available');
  }

  const baseDir = path.resolve(__dirname, '..');

  // Step 1: Check active session token directly from NextAuth session endpoint (if not force-refreshing)
  if (!forceRefresh) {
    console.log('[Browser] Checking NextAuth session for active Bearer token...');
    let token = await getBearerTokenFromSession(context);
    if (token && !blacklistedBearerTokens.has(token)) {
      cachedBearerToken = token;
      tokenCapturedAt = Date.now();
      console.log('[Browser] ✅ Retrieved Bearer token from active session!');
      return cachedBearerToken;
    }
    if (token && blacklistedBearerTokens.has(token)) {
      console.log('[Browser] Stored NextAuth session token is blacklisted/expired, proceeding to refresh...');
    }
  }

  // Step 2: Session token expired, blacklisted, or force-refreshed. Reload latest cookies and refresh via silent OAuth
  console.log('[Browser] Bearer token expired or needs refresh. Reloading latest cookies and refreshing via silent OAuth...');
  try {
    const cookieFile = path.join(baseDir, 'labs.google.cookies.json');
    if (fs.existsSync(cookieFile)) {
      const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf-8'));
      await context.addCookies(cookies);
    }
  } catch (_) {}

  // Step 3: Trigger silent OAuth refresh
  try {
    await triggerSilentOAuthRefresh(context, baseDir);
    const token = await getBearerTokenFromSession(context);
    if (token && !blacklistedBearerTokens.has(token)) {
      cachedBearerToken = token;
      tokenCapturedAt = Date.now();
      console.log('[Browser] ✅ Captured fresh Bearer token after silent OAuth refresh!');
      return cachedBearerToken;
    }
  } catch (refreshErr) {
    console.warn(`[Browser] ⚠️ Silent OAuth refresh warning: ${refreshErr.message}`);
  }

  // Step 4: Fallback - check if cachedBearerToken was set via network interceptor
  if (cachedBearerToken && !blacklistedBearerTokens.has(cachedBearerToken) && (Date.now() - tokenCapturedAt) < 25 * 60 * 1000) {
    return cachedBearerToken;
  }

  // Step 5: Fallback - try page reload if available
  if (page && typeof page.reload === 'function') {
    console.log('[Browser] Falling back to page reload...');
    try {
      await page.reload();
      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(1000);
        if (cachedBearerToken && !blacklistedBearerTokens.has(cachedBearerToken) && (Date.now() - tokenCapturedAt) < 25 * 60 * 1000) {
          break;
        }
      }
    } catch (_) {}
  }

  if (!cachedBearerToken || blacklistedBearerTokens.has(cachedBearerToken)) {
    throw new Error('[Browser] Could not capture valid Bearer token from network requests or session refresh');
  }
  console.log('[Browser] ✅ Captured Bearer token successfully!');
  return cachedBearerToken;
}

// ── reCAPTCHA token ──────────────────────────────────────────
async function getRecaptchaToken(page, action = 'IMAGE_GENERATION') {
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
async function handleAuthRedirect(page, context) {
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
    await page.goto(PROJECT_URL);
    await page.waitForTimeout(6000);

    const retryUrl = page.url();
    if (retryUrl.includes('error=Callback') || retryUrl.includes('signin?error')) {
      console.error('[Browser] ❌ Auth still failing after cookie fix. Session token may be expired — re-export cookies manually.');
      throw new Error('Google Labs authentication failed. Please re-login and export fresh cookies.');
    }
    console.log('[Browser] ✅ Auth recovery successful');
  }
}

// ── Browser page management ──────────────────────────────────
async function getSharedContext(baseDir) {
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

  if (!globalContext) {
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
    if (!isHeadless) {
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

/**
 * Create an isolated browser page (tab) for a concurrent flow.
 * Shares the same browser context (cookies, auth) but each flow
 * gets its own page so they don't interfere with each other.
 * The page navigates to PROJECT_URL and is ready for API use.
 */
async function createFlowPage(baseDir) {
  const context = await getSharedContext(baseDir);
  const winConfig = getWindowLaunchConfig(baseDir);
  const isHeadless = process.env.HEADLESS === 'true';
  const page = await context.newPage();
  if (!isHeadless) {
    await applyWindowBounds(context, winConfig, page);
  }
  setupTokenInterceptor(page);
  await page.goto(PROJECT_URL);
  await page.waitForTimeout(6000);
  await handleAuthRedirect(page, context);
  console.log(`[Browser] Created flow page (tab) — ${page.url().substring(0, 60)}...`);
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
  PROJECT_URL,
  PROJECT_ID,
  SITE_KEY
};
