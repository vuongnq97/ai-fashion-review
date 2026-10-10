const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const https = require('https');

function parseBatchExecute(rawText, rpcId = 'as29s') {
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

async function testAs29s() {
  await startProxyBridge(8888);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages()[0];

  const mediaName = '9ee2bbfc-0fd3-4021-b3c9-8b07f38ee951';

  const wiz = await page.evaluate(() => {
    const w = window.WIZ_global_data || {};
    return {
      at: w.SNlM0e || '',
      fsid: w.FdrFJe || '',
      bl: w.cfb2h || 'boq_labs-ai-sandbox-frontend_20260917.00_p0',
      projectId: '8ac10c4a-44b5-4d55-b470-10ab24db4c1c'
    };
  });

  console.log('Calling as29s RPC in browser for media:', mediaName);
  const reqId = Math.floor(Math.random() * 900000) + 100000;
  const as29sUrl = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=as29s&source-path=${encodeURIComponent('/project/' + wiz.projectId)}&bl=${encodeURIComponent(wiz.bl)}&f.sid=${encodeURIComponent(wiz.fsid)}&hl=vi&_reqid=${reqId}&rt=c`;
  
  const innerPayload = [mediaName];
  const fReq = JSON.stringify([[["as29s", JSON.stringify(innerPayload), null, "generic"]]]);
  const bodyParams = new URLSearchParams();
  bodyParams.set('f.req', fReq);
  if (wiz.at) bodyParams.set('at', wiz.at);

  const respText = await page.evaluate(async ({ url, body }) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'x-same-domain': '1',
      },
      body
    });
    return await r.text();
  }, { url: as29sUrl, body: bodyParams.toString() });

  console.log('as29s response length:', respText.length);

  let videoUrl = null;
  const parsed = parseBatchExecute(respText, 'as29s');
  if (parsed) {
    function findUrl(node) {
      if (!node || videoUrl) return;
      if (typeof node === 'string' && (node.startsWith('https://flow-content.google') || node.startsWith('https://storage.googleapis.com'))) {
        videoUrl = node;
        return;
      }
      if (Array.isArray(node)) {
        for (const el of node) findUrl(el);
      } else if (typeof node === 'object') {
        for (const k of Object.keys(node)) findUrl(node[k]);
      }
    }
    findUrl(parsed);
  }

  if (!videoUrl) {
    const m = respText.match(/https:(?:\\\/|\/)+flow-content\.google\/video\/[^"\s]+/i);
    if (m) {
      videoUrl = m[0].replace(/\\\/|\//g, '/').replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/[\\]+$/g, '');
    }
  }

  console.log('Video URL resolved:', videoUrl);

  if (videoUrl) {
    const dest = './outputs/test_360_heihei.mp4';
    console.log('Downloading MP4 to:', dest);
    const dlRes = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      }
    });

    fs.writeFileSync(dest, Buffer.from(dlRes.data));
    console.log(`🎉 SUCCESS! SAVED VIDEO TO ${dest} (${(dlRes.data.length / 1024 / 1024).toFixed(2)} MB)`);
  }

  await browser.close();
  process.exit(0);
}

testAs29s();
