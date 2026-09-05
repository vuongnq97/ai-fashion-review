const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { getExtensionArgs } = require('../utils/extension-loader');
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

function setupTokenInterceptor(page) {
  if (tokenInterceptedPages.has(page)) return;
  tokenInterceptedPages.add(page);
  page.on('request', request => {
    const url = request.url();
    if (url.includes('aisandbox-pa.googleapis.com')) {
      const auth = request.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ')) {
        cachedBearerToken = auth.substring(7);
        tokenCapturedAt = Date.now();
      }
    }
  });
}

async function adoptBrowserPage(context, page) {
  globalContext = context;
  globalPage = page;
  setupTokenInterceptor(globalPage);
  await handleAuthRedirect(globalPage, globalContext);
  return globalPage;
}

function invalidateBearerToken() {
  cachedBearerToken = null;
  tokenCapturedAt = 0;
  console.log('[Browser] Bearer token invalidated.');
}

async function ensureBearerToken(page) {
  // Token valid for 30 minutes
  if (cachedBearerToken && (Date.now() - tokenCapturedAt) < 30 * 60 * 1000) {
    return cachedBearerToken;
  }

  console.log('[Browser] Bearer token expired or missing. Refreshing via labs.google/fx/tools/flow...');
  const context = page.context();
  const tokenPage = await context.newPage();
  setupTokenInterceptor(tokenPage);
  try {
    await tokenPage.goto('https://labs.google/fx/tools/flow', { waitUntil: 'domcontentloaded', timeout: 30000 });
    for (let i = 0; i < 30; i++) {
      if (cachedBearerToken && (Date.now() - tokenCapturedAt) < 30 * 60 * 1000) {
        break;
      }
      await tokenPage.waitForTimeout(500);
    }
  } catch (err) {
    console.warn(`[Browser] ⚠️ Token page navigation warning: ${err.message}`);
  } finally {
    try { await tokenPage.close(); } catch (_) {}
  }

  if (!cachedBearerToken) {
    // Fallback: try reloading page directly
    console.log('[Browser] Falling back to page reload...');
    await page.reload();
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1000);
      if (cachedBearerToken && (Date.now() - tokenCapturedAt) < 30 * 60 * 1000) {
        break;
      }
    }
  }

  if (!cachedBearerToken) {
    throw new Error('[Browser] Could not capture Bearer token from network requests');
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
    globalContext = await chromium.launchPersistentContext(userDataDir, {
      channel: chromeChannel,
      headless: isHeadless,
      ignoreHTTPSErrors: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        ...getExtensionArgs(baseDir),
      ],
      acceptDownloads: true
    });

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
    console.log('[Browser] Creating new page...');
    try {
      globalPage = await context.newPage();
    } catch (e) {
      console.log('[Browser] newPage() failed, reloading context...');
      try { await context.close(); } catch (_) { }
      globalContext = null;

      const newContext = await getSharedContext(baseDir);
      globalPage = await newContext.newPage();
    }
    setupTokenInterceptor(globalPage);
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
  const page = await context.newPage();
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
