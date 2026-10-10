const { chromium } = require('playwright');

async function checkVideoTaskStatus() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  const info = await page.evaluate(async () => {
    const text = document.body.innerText;
    const is99 = text.includes('99%');
    const isFinished = !text.includes('%') && text.includes('A seamless continuous 360');

    // Check all clickable tiles or cards
    const tiles = Array.from(document.querySelectorAll('button, div')).filter(el => 
      el.innerText && el.innerText.includes('A seamless continuous 360')
    ).map(el => ({
      tag: el.tagName,
      class: el.className,
      text: el.innerText.slice(0, 100)
    }));

    return { is99, isFinished, tiles };
  });

  console.log('Status:', JSON.stringify(info, null, 2));

  // Reload the page to see if 99% finishes immediately upon reload!
  console.log('Reloading page to refresh video tile...');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const afterReload = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      has99: text.includes('99%'),
      hasProgress: text.includes('%'),
      snippet: text.slice(0, 500).replace(/\n+/g, ' ')
    };
  });
  console.log('After reload:', afterReload);

  await browser.close();
  process.exit(0);
}

checkVideoTaskStatus();
