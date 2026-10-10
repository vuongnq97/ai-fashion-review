const { chromium } = require('playwright');

async function inspectVideoTiles() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  const info = await page.evaluate(() => {
    // Check first 5 tiles in gallery
    const tiles = Array.from(document.querySelectorAll('[data-tile-id], flow-tile')).slice(0, 5).map(t => ({
      text: t.innerText.replace(/\n+/g, ' '),
      hasProgress: !!t.querySelector('[role="progressbar"], mat-progress-spinner'),
      imgSrc: t.querySelector('img')?.src?.slice(0, 80),
      videoSrc: t.querySelector('video')?.src?.slice(0, 80)
    }));

    const editorText = document.querySelector('.ProseMirror')?.innerText;
    const btnDisabled = document.querySelector('.generate-icon-button')?.disabled;

    return { tiles, editorText, btnDisabled };
  });

  console.log('Video tile inspection:', JSON.stringify(info, null, 2));
  await browser.close();
  process.exit(0);
}

inspectVideoTiles();
