'use strict';

const { chromium } = require('playwright');

async function inspectTiles() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('flow.google.com'));
  const tiles = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('flow-tile, [data-tile-id]')).map(t => ({
      text: t.innerText.slice(0, 100),
      img: t.querySelector('img')?.src?.slice(0, 80)
    }));
  });
  console.log('Tiles count:', tiles.length);
  for (let i = 0; i < Math.min(5, tiles.length); i++) {
    console.log('Tile #' + i + ':', JSON.stringify(tiles[i]));
  }
}

inspectTiles().catch(console.error);
