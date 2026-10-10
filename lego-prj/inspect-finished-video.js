const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');
const fs = require('fs');

async function inspectFinishedVideo() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  console.log('Waiting for project tiles to render...');
  await page.waitForSelector('.ProseMirror', { timeout: 25000 });
  await page.waitForTimeout(2000);

  const tilesInfo = await page.evaluate(() => {
    const text = document.body.innerText;
    const isGenerating = text.includes('%');
    
    // Find all tiles or items
    const items = Array.from(document.querySelectorAll('button, div, [role="button"]')).filter(el => 
      el.innerText && el.innerText.includes('A seamless continuous 360')
    ).map(el => ({
      tag: el.tagName,
      class: el.className,
      text: el.innerText.slice(0, 120).replace(/\n+/g, ' ')
    }));

    // Find all video elements or thumbnails
    const videoThumbnails = Array.from(document.querySelectorAll('img.thumbnail, img[alt*="video" i]')).map(img => img.src);

    return { isGenerating, itemsCount: items.length, sampleItem: items[0], videoThumbnails };
  });

  console.log('Tiles Info:', JSON.stringify(tilesInfo, null, 2));

  // Click the video item to open viewer modal
  console.log('Clicking the video tile to open playback modal...');
  const clicked = await page.evaluate(() => {
    // Look for tile with the prompt text
    const elements = Array.from(document.querySelectorAll('button, div, a'));
    for (const el of elements) {
      if (el.innerText && el.innerText.includes('A seamless continuous 360') && (el.className.includes('container') || el.className.includes('tile') || el.getAttribute('role') === 'button')) {
        el.click();
        return true;
      }
    }
    return false;
  });
  console.log('Clicked result:', clicked);

  await page.waitForTimeout(2000);

  // In the playback modal, find the video src or download button
  const videoDetails = await page.evaluate(() => {
    const v = document.querySelector('video');
    const sources = Array.from(document.querySelectorAll('video source, video')).map(el => el.src);
    const downloadBtns = Array.from(document.querySelectorAll('button, a')).filter(el => {
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const txt = (el.innerText || '').toLowerCase();
      return aria.includes('tải') || aria.includes('download') || txt.includes('tải') || txt.includes('download');
    }).map(el => ({
      text: el.innerText.trim(),
      aria: el.getAttribute('aria-label'),
      href: el.getAttribute('href')
    }));

    return {
      hasVideoTag: !!v,
      sources,
      downloadBtns
    };
  });

  console.log('Video Modal Details:', JSON.stringify(videoDetails, null, 2));

  await browser.close();
  process.exit(0);
}

inspectFinishedVideo();
