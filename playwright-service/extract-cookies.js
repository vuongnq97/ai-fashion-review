/**
 * Extract fresh cookies from the persistent browser context.
 * Opens browser with chrome-data, navigates to labs.google to trigger login,
 * then extracts and saves cookies.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { getExtensionArgs } = require('./utils/extension-loader');

const BASE_DIR = __dirname;
const USER_DATA_DIR = path.join(BASE_DIR, 'chrome-data');
const COOKIE_FILE = path.join(BASE_DIR, 'labs.google.cookies.json');

try { fs.unlinkSync(path.join(USER_DATA_DIR, 'SingletonLock')); } catch (_) {}

async function main() {
  console.log('🔍 Opening browser to extract cookies...');
  console.log('⏳ Please login to Google if needed. The script will wait 30s then extract cookies.');
  
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      ...getExtensionArgs(BASE_DIR),
    ],
  });

  const pages = context.pages();
  let page = pages.find(p => p.url().includes('labs.google'));
  
  if (!page) {
    page = pages[0] || await context.newPage();
    await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'networkidle', timeout: 60000 });
  }
  
  // Wait for page to fully load
  await page.waitForTimeout(5000);
  console.log(`📄 Current URL: ${page.url()}`);
  
  // Check if we need to wait for login
  const isLoggedIn = await page.evaluate(() => {
    // Check for 401 errors or login indicators
    const hasUnauthorized = document.body?.textContent?.includes('Unauthorized') || false;
    const hasLoginButton = !!document.querySelector('a[href*="accounts.google"]');
    return !hasUnauthorized && !hasLoginButton;
  });
  
  if (!isLoggedIn) {
    console.log('⚠️ Not logged in. Please login in the browser window.');
    console.log('   Waiting up to 120s for login...');
    
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(5000);
      const loggedIn = await page.evaluate(() => {
        return !document.body?.textContent?.includes('Unauthorized');
      });
      if (loggedIn) {
        console.log('✅ Login detected!');
        break;
      }
      console.log(`   Still waiting... ${(i+1)*5}s`);
    }
  }

  // Extract cookies
  const cookies = await context.cookies('https://labs.google');
  const googleCookies = await context.cookies('https://accounts.google.com');
  const allCookies = [...cookies, ...googleCookies];
  
  // Filter relevant cookies
  const relevantDomains = ['.google.com', '.labs.google', 'labs.google', '.google.com'];
  const filtered = allCookies.filter(c => 
    relevantDomains.some(d => c.domain.includes(d.replace(/^\./, '')))
  );

  // Deduplicate
  const seen = new Set();
  const unique = filtered.filter(c => {
    const key = `${c.name}:${c.domain}:${c.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Save
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(unique, null, 2));
  console.log(`\n✅ Saved ${unique.length} cookies to ${COOKIE_FILE}`);
  console.log(`   Domains: ${[...new Set(unique.map(c => c.domain))].join(', ')}`);
  
  // Verify key cookies
  const keyNames = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID'];
  for (const name of keyNames) {
    const found = unique.find(c => c.name === name);
    console.log(`   ${found ? '✅' : '❌'} ${name}`);
  }

  await context.close();
  console.log('\n🎉 Done! You can now run the test again.');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
