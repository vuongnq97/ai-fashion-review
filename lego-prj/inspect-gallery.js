const { chromium } = require('playwright');

async function inspectGallery() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  const info = await page.evaluate(() => {
    const tiles = Array.from(document.querySelectorAll('[data-tile-id], flow-tile, flow-grid-item, [class*="tile"], [class*="card"]'));
    const allImgs = Array.from(document.querySelectorAll('img')).map(i => ({
      src: i.src ? i.src.slice(0, 100) : '',
      alt: i.alt || '',
      class: i.className
    }));
    const bgElements = Array.from(document.querySelectorAll('*')).filter(el => {
      const bg = window.getComputedStyle(el).backgroundImage;
      return bg && bg.includes('url(');
    }).map(el => ({
      tag: el.tagName,
      bg: window.getComputedStyle(el).backgroundImage.slice(0, 100)
    }));

    return {
      tilesCount: tiles.length,
      allImgs,
      bgElements
    };
  });

  console.log(JSON.stringify(info, null, 2));
  await browser.close();
  process.exit(0);
}

inspectGallery();
