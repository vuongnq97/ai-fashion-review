const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');
const fs = require('fs');

async function testClickThumbnail() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  console.log('Clicking first img.thumbnail...');
  const thumb = page.locator('img.thumbnail').first();
  await thumb.click({ force: true });
  await page.waitForTimeout(2000);

  // Inspect the open modal or viewer
  const modalInfo = await page.evaluate(() => {
    const dialog = document.querySelector('mat-dialog-container, .cdk-overlay-pane, [role="dialog"], .media-viewer');
    const video = document.querySelector('video');
    const sources = Array.from(document.querySelectorAll('video, video source')).map(v => v.src);
    const buttons = Array.from(document.querySelectorAll('button, a')).map(b => ({
      aria: b.getAttribute('aria-label'),
      text: b.innerText.trim(),
      href: b.getAttribute('href')
    })).filter(b => b.aria || b.href || b.text.includes('Tải') || b.text.includes('Download'));

    return {
      hasDialog: !!dialog,
      hasVideo: !!video,
      videoSrc: video ? video.src : null,
      sources,
      buttons: buttons.slice(0, 10)
    };
  });

  console.log('Modal Info after click:', JSON.stringify(modalInfo, null, 2));

  await browser.close();
  process.exit(0);
}

testClickThumbnail();
