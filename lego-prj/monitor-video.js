const { chromium } = require('playwright');
const fs = require('fs');
const axios = require('axios');
const https = require('https');

async function monitorVideo() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  console.log('👀 Monitoring video render progress...');

  let finished = false;
  let videoSrc = null;

  for (let i = 0; i < 40; i++) {
    const status = await page.evaluate(() => {
      const text = document.body.innerText;
      const percentMatch = text.match(/(\d+)%\s+A seamless continuous 360/);
      const isComplete = text.includes('A seamless continuous 360') && !percentMatch;
      
      // Look for video element or play button
      const v = document.querySelector('video source, video');
      return {
        percent: percentMatch ? percentMatch[1] + '%' : (isComplete ? '100% / Completed' : 'Waiting...'),
        videoSrc: v ? v.src : null
      };
    });

    console.log(`[${i * 3}s] Progress: ${status.percent}`);

    if (status.percent.includes('100') || status.percent.includes('Completed')) {
      console.log('🎉 Video finished rendering!');
      finished = true;
      break;
    }

    await page.waitForTimeout(3000);
  }

  // Once finished, click on the video tile to open viewer or grab download URL
  if (finished) {
    await page.waitForTimeout(2000);
    
    // Find video tile or card with prompt text and click it
    const clicked = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      for (const el of els) {
        if (el.innerText && el.innerText.includes('A seamless continuous 360') && (el.className.includes('tile') || el.className.includes('card') || el.tagName === 'BUTTON' || el.tagName === 'DIV')) {
          el.click();
          return true;
        }
      }
      return false;
    });

    console.log('Opened video modal/viewer:', clicked);
    await page.waitForTimeout(2000);

    // Get the video URL
    const videoUrl = await page.evaluate(() => {
      const v = document.querySelector('video, source');
      if (v && v.src) return v.src;
      // Check any link with .mp4 or flow-content.google/video
      const links = Array.from(document.querySelectorAll('a, button, source')).map(el => el.src || el.href || '').filter(s => s.includes('.mp4') || s.includes('flow-content.google/video/'));
      return links[0] || null;
    });

    console.log('Detected video URL:', videoUrl);

    if (videoUrl) {
      const dest = './outputs/test_heihei_360.mp4';
      console.log('Downloading video to:', dest);
      const res = await axios.get(videoUrl, {
        responseType: 'arraybuffer',
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
        }
      });
      fs.writeFileSync(dest, Buffer.from(res.data));
      console.log(`✅ DOWNLOADED VIDEO: ${(res.data.length / 1024 / 1024).toFixed(2)} MB`);
    }
  }

  await browser.close();
  process.exit(0);
}

monitorVideo();
