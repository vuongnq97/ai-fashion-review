const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');

function parseBatchExecute(rawText, rpcId = 'eb1hJf') {
  if (!rawText || typeof rawText !== 'string') return null;
  const cleaned = rawText.replace(/^\)\]\}'\s*/, '').trim();
  const lines = cleaned.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (Array.isArray(item) && item[1] === rpcId && typeof item[2] === 'string') {
            return JSON.parse(item[2]);
          }
        }
      }
    } catch (_) {}
  }
  return null;
}

async function testVideoGeneration() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  console.log('1. Waiting for Flow UI...');
  await page.waitForSelector('.settings-trigger-button, .ProseMirror', { timeout: 25000 });
  await page.waitForTimeout(1000);

  console.log('2. Switching to Video mode & 9:16 ratio...');
  const settingsBtn = page.locator('.settings-trigger-button').first();
  await settingsBtn.click({ force: true });
  await page.waitForTimeout(600);

  const vidRadio = page.locator('.cdk-overlay-pane button', { hasText: /Video/i }).first();
  await vidRadio.click({ force: true });
  await page.waitForTimeout(500);

  const ratio916 = page.locator('.cdk-overlay-pane button', { hasText: /9:16/i }).first();
  if (await ratio916.isVisible()) {
    await ratio916.click({ force: true });
    await page.waitForTimeout(300);
  }

  // Duration: 8 giây or 10 giây (Omni Flash)
  const durBtn = page.locator('.cdk-overlay-pane button', { hasText: /8 giây|10 giây/i }).first();
  if (await durBtn.isVisible()) {
    console.log('Selected duration:', await durBtn.innerText());
    await durBtn.click({ force: true });
    await page.waitForTimeout(300);
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  console.log('3. Selecting Start Frame...');
  const startChip = page.locator('button, div, [class*="chip"]').filter({ hasText: /^Bắt đầu$/i }).first();
  if (await startChip.isVisible()) {
    await startChip.click();
    await page.waitForTimeout(800);

    // Click the first available image option (our newly generated HD HeiHei panel)
    const firstOption = page.locator('.cdk-overlay-pane [role="option"], .cdk-overlay-pane button:has(img)').first();
    if (await firstOption.isVisible()) {
      console.log('Clicked first image option as start frame!');
      await firstOption.click();
      await page.waitForTimeout(800);
    }
  }

  console.log('4. Entering 360 motion prompt...');
  const editor = page.locator('.ProseMirror').first();
  await editor.click();
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('A seamless continuous 360-degree clockwise turntable rotation of the LEGO model. Smooth constant speed, perfectly stable tripod camera, razor-sharp focus with specular reflections gliding over glossy LEGO bricks.');
  await page.waitForTimeout(500);

  console.log('5. Listening for video task submission and generating...');
  let videoMediaName = null;
  let videoUrl = null;

  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('batchexecute') && (url.includes('eb1hJf') || url.includes('rpcids='))) {
      try {
        const text = await res.text();
        const parsed = parseBatchExecute(text, 'eb1hJf');
        if (parsed) {
          const vName = parsed?.[3]?.[0]?.[0] || parsed?.[2]?.[0]?.[3]?.[4];
          if (vName) {
            console.log('🎯 Captured videoMediaName:', vName);
            videoMediaName = vName;
          }
        }
      } catch (_) {}
    }
  });

  const submitBtn = page.locator('button[aria-label="Bắt đầu tạo"], button:has-text("arrow_forward")').last();
  await submitBtn.click({ force: true });
  console.log('Clicked Generate Video! Waiting for video task...');

  // Wait for videoMediaName
  for (let i = 0; i < 20; i++) {
    if (videoMediaName) break;
    await page.waitForTimeout(1000);
  }

  if (videoMediaName) {
    console.log(`⏳ Video task ${videoMediaName} is generating. Polling for final video URL...`);
    const wiz = await page.evaluate(() => {
      const w = window.WIZ_global_data || {};
      return {
        at: w.SNlM0e || '',
        fsid: w.FdrFJe || '',
        bl: w.cfb2h || 'boq_labs-ai-sandbox-frontend_20260917.00_p0',
        projectId: '8ac10c4a-44b5-4d55-b470-10ab24db4c1c'
      };
    });

    const pollUrl = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=jwpduf&source-path=${encodeURIComponent('/project/' + wiz.projectId)}&bl=${encodeURIComponent(wiz.bl)}&f.sid=${encodeURIComponent(wiz.fsid)}&hl=vi&_reqid=123456&rt=c`;
    const pollInner = [null, null, [[videoMediaName]]];
    const pollFReq = JSON.stringify([[["jwpduf", JSON.stringify(pollInner), null, "generic"]]]);
    const pollParams = new URLSearchParams();
    pollParams.set('f.req', pollFReq);
    if (wiz.at) pollParams.set('at', wiz.at);

    for (let poll = 1; poll <= 30; poll++) {
      await page.waitForTimeout(5000);
      try {
        const pollText = await page.evaluate(async ({ url, body }) => {
          const r = await fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'x-same-domain': '1',
            },
            body
          });
          return await r.text();
        }, { url: pollUrl, body: pollParams.toString() });

        const match = pollText.match(/https:(?:\\\/|\/)+flow-content\.google\/video\/[^"\s]+/i);
        if (match) {
          let raw = match[0].replace(/\\\/|\//g, '/').replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/[\\]+$/g, '');
          console.log(`🎉 VIDEO COMPLETED! URL: ${raw.slice(0, 100)}...`);
          videoUrl = raw;
          break;
        }

        // Check if status is 3 (completed) -> call as29s
        const parsedJ = parseBatchExecute(pollText, 'jwpduf');
        const items = parsedJ?.[2] || [];
        const item = items.find(it => it && (it[0] === videoMediaName || String(it[0]).includes(videoMediaName)));
        const meta = item?.[5] || [];
        const statusArr = Array.isArray(meta[8]) ? meta[8] : (Array.isArray(meta) ? meta.find(x => Array.isArray(x) && typeof x[0] === 'number') : null);
        const statusCode = statusArr ? statusArr[0] : null;

        console.log(`   [Poll #${poll}/30] Video status code: ${statusCode || 'processing'}`);

        if (statusCode === 3) {
          const as29sUrl = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=as29s&source-path=${encodeURIComponent('/project/' + wiz.projectId)}&bl=${encodeURIComponent(wiz.bl)}&f.sid=${encodeURIComponent(wiz.fsid)}&hl=vi&_reqid=654321&rt=c`;
          const as29sInner = [videoMediaName];
          const as29sParams = new URLSearchParams();
          as29sParams.set('f.req', JSON.stringify([[["as29s", JSON.stringify(as29sInner), null, "generic"]]]));
          if (wiz.at) as29sParams.set('at', wiz.at);

          const as29sText = await page.evaluate(async ({ url, body }) => {
            const r = await fetch(url, {
              method: 'POST',
              headers: {
                'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'x-same-domain': '1',
              },
              body
            });
            return await r.text();
          }, { url: as29sUrl, body: as29sParams.toString() });

          const asMatch = as29sText.match(/https:(?:\\\/|\/)+flow-content\.google\/video\/[^"\s]+/i);
          if (asMatch) {
            let raw = asMatch[0].replace(/\\\/|\//g, '/').replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/[\\]+$/g, '');
            console.log(`🎉 VIDEO COMPLETED (via as29s)! URL: ${raw.slice(0, 100)}...`);
            videoUrl = raw;
            break;
          }
        }
      } catch (pErr) {
        console.warn(`   [Poll #${poll}] error:`, pErr.message);
      }
    }
  }

  if (videoUrl) {
    const videoDest = './outputs/test_heihei_360.mp4';
    console.log('📥 Downloading video to:', videoDest);
    const vidRes = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      }
    });
    fs.writeFileSync(videoDest, Buffer.from(vidRes.data));
    console.log(`✅ Saved video: ${(vidRes.data.length / 1024 / 1024).toFixed(2)} MB`);
  } else {
    console.warn('⚠️ Video generation did not finish in time');
  }

  await browser.close();
  process.exit(0);
}

testVideoGeneration();
