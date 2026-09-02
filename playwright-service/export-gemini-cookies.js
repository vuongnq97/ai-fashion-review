const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getExtensionArgs } = require('./utils/extension-loader');

function clearCookieCache(cookieDir) {
  if (!fs.existsSync(cookieDir)) return;
  const files = fs.readdirSync(cookieDir).filter(f => f.startsWith('.cached_cookies_') && f.endsWith('.json'));
  for (const file of files) {
    try {
      fs.unlinkSync(path.join(cookieDir, file));
      console.log(`[GeminiCookies] Deleted stale cache: ${file}`);
    } catch (e) {
      console.log(`[GeminiCookies] ⚠️ Could not delete cache file ${file}: ${e.message}`);
    }
  }
  if (files.length === 0) console.log('[GeminiCookies] No stale cache files found.');
}

function setEnvValue(envPath, key, value) {
  let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `${key}=${value || ''}`;
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(text)) {
    text = text.replace(regex, line);
  } else {
    text = text.replace(/\s*$/, '') + `\n${line}\n`;
  }
  fs.writeFileSync(envPath, text, 'utf8');
}

function getEnvValue(envPath, key) {
  if (!fs.existsSync(envPath)) return '';
  const text = fs.readFileSync(envPath, 'utf8');
  const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : '';
}

async function waitForEnter(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

(async () => {
  const baseDir = __dirname;
  const userDataDir = path.join(baseDir, 'chrome-data');
  const envPath = path.join(baseDir, '.env');

  try {
    if (fs.existsSync(userDataDir)) {
      for (const f of fs.readdirSync(userDataDir)) {
        if (f.startsWith('Singleton')) {
          try { fs.unlinkSync(path.join(userDataDir, f)); } catch (_) {}
        }
      }
    }
  } catch (_) {}

  console.log('[GeminiCookies] Opening Playwright persistent profile: chrome-data');
  console.log('[GeminiCookies] This is the same profile used by the automation service.');

  const chromeChannel = process.env.PLAYWRIGHT_CHROME_CHANNEL !== undefined ? (process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined) : 'chrome';
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: chromeChannel,
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      ...getExtensionArgs(baseDir),
    ],
  });

  const page = await context.newPage();
  await page.goto('https://gemini.google.com', { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('');
  console.log('Open Gemini in the browser window.');
  console.log('If Google asks you to sign in, confirm, or accept Gemini terms, finish that first.');
  console.log('No cookie values will be printed.');
  console.log('');

  await waitForEnter('Press Enter here after Gemini is accessible in that browser...');

  const cookies = await context.cookies([
    'https://gemini.google.com',
    'https://accounts.google.com',
    'https://google.com',
  ]);

  const secure1psid = cookies.find(cookie => cookie.name === '__Secure-1PSID');
  const secure1psidts = cookies.find(cookie => cookie.name === '__Secure-1PSIDTS');

  if (!secure1psid) {
    await context.close();
    throw new Error('Could not find __Secure-1PSID. Gemini/Google login is not available in this profile.');
  }

  setEnvValue(envPath, 'GEMINI_SECURE_1PSID', secure1psid.value);
  setEnvValue(envPath, 'GEMINI_SECURE_1PSIDTS', secure1psidts ? secure1psidts.value : '');
  setEnvValue(envPath, 'GEMINI_COOKIE_PATH', './gemini-cookies');

  const currentImpl = getEnvValue(envPath, 'GEMINI_WEBAPI_IMPL');
  if (!currentImpl) {
    setEnvValue(envPath, 'GEMINI_WEBAPI_IMPL', process.platform === 'win32' ? 'python' : 'node');
  }

  // Save ALL cookies to gemini-cookies/cookies.json so gemini-api.js can load them
  const cookieDir = path.join(baseDir, 'gemini-cookies');
  fs.mkdirSync(cookieDir, { recursive: true });
  const cookieFilePath = path.join(cookieDir, 'cookies.json');
  fs.writeFileSync(cookieFilePath, JSON.stringify(cookies, null, 2), 'utf8');
  console.log(`[GeminiCookies] Saved ${cookies.length} cookies → ${cookieFilePath}`);

  console.log(`[GeminiCookies] Exported Gemini cookies to ${envPath}`);
  console.log(`[GeminiCookies] __Secure-1PSIDTS found: ${secure1psidts ? 'yes' : 'no'}`);

  // Clear stale gemini_webapi cookie cache so the next run uses fresh cookies
  clearCookieCache(cookieDir);
  console.log('[GeminiCookies] ✅ Done. Restart the server to apply new cookies.');

  await context.close();
})().catch(error => {
  console.error(`[GeminiCookies] ERROR: ${error.message}`);
  process.exit(1);
});
