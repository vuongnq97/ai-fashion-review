const path = require('path');
const { chromium } = require('playwright');

const userDataDir = path.join(__dirname, 'chrome-data');
const url = process.argv[2] ||
  'https://ai.studio/apps/67340c71-44d0-4210-a324-33525f7e1ecb?fullscreenApplet=true';

(async () => {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

  console.log('[Browser] Opened:', url);
  console.log('[Browser] You can use this window normally. Close it when done.');

  await new Promise((resolve) => context.on('close', resolve));
})();
