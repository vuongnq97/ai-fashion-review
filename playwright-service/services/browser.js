const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { getExtensionArgs } = require('../utils/extension-loader');

const PROJECT_URL = 'https://labs.google/fx/vi/tools/flow/project/022f171a-baeb-4a4a-8561-51d0c992f3a1';
const PROJECT_ID = '022f171a-baeb-4a4a-8561-51d0c992f3a1';
const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

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

async function ensureBearerToken(page) {
  // Token valid for 30 minutes
  if (cachedBearerToken && (Date.now() - tokenCapturedAt) < 30 * 60 * 1000) {
    return cachedBearerToken;
  }
  // Reload page to trigger auth requests
  console.log('[Browser] Bearer token expired or missing. Reloading page...');
  await page.reload();
  await page.waitForTimeout(6000);
  if (!cachedBearerToken) {
    throw new Error('[Browser] Could not capture Bearer token from network requests');
  }
  return cachedBearerToken;
}

// ── reCAPTCHA token ──────────────────────────────────────────
async function getRecaptchaToken(page, action = 'IMAGE_GENERATION') {
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
    
    // Remove stale lock if present
    try { fs.unlinkSync(path.join(userDataDir, 'SingletonLock')); } catch (_) {}
    
    globalContext = await chromium.launchPersistentContext(userDataDir, {
      headless: isHeadless,
      args: [
        '--disable-blink-features=AutomationControlled',
        ...getExtensionArgs(baseDir),
      ],
      acceptDownloads: true
    });

    if (fs.existsSync(cookieFile)) {
      try {
        const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf-8'));
        await globalContext.addCookies(cookies);
        console.log(`[Browser] Loaded ${cookies.length} cookies from ${cookieFile}`);
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

function getContext() {
  return globalContext;
}

module.exports = {
  getBrowserPage,
  getSharedContext,
  adoptBrowserPage,
  getContext,
  ensureBearerToken,
  getRecaptchaToken,
  PROJECT_URL,
  PROJECT_ID,
  SITE_KEY
};
