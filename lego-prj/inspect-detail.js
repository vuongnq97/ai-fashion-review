const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');
const fs = require('fs');

async function inspectDetailPage() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  const detail = await page.evaluate(() => {
    const video = document.querySelector('video');
    const sources = Array.from(document.querySelectorAll('video source, video')).map(v => v.src);
    const allButtons = Array.from(document.querySelectorAll('button, a')).map(b => ({
      aria: b.getAttribute('aria-label'),
      text: b.innerText.trim(),
      href: b.getAttribute('href')
    }));

    return {
      url: window.location.href,
      hasVideo: !!video,
      videoSrc: video ? video.src : null,
      sources,
      downloadButtons: allButtons.filter(b => (b.aria || '').toLowerCase().includes('tải') || (b.aria || '').toLowerCase().includes('download') || b.text.toLowerCase().includes('tải') || b.text.toLowerCase().includes('download'))
    };
  });

  console.log('Detail Page:', JSON.stringify(detail, null, 2));

  await browser.close();
  process.exit(0);
}

inspectDetailPage();
