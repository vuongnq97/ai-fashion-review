const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { createFlowPage, closeFlowPage } = require('../services/browser');

async function main() {
  const baseDir = path.resolve(__dirname, '..');
  const PROJECT_ID = '8ac10c4a-44b5-4d55-b470-10ab24db4c1c';

  console.log('1. Connecting to Chrome on port 9222...');
  const page = await createFlowPage(baseDir);

  try {
    console.log('2. Requesting fresh token from Captcha Worker (port 9060)...');
    const capRes = await axios.post('http://127.0.0.1:9060/api/v1/solve', {
      action: 'IMAGE_GENERATION'
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer flow2api_secret'
      },
      timeout: 15000
    });
    const recaptchaToken = capRes.data?.token;
    console.log(`✅ Token received: ${recaptchaToken.substring(0, 30)}... (${recaptchaToken.length} chars)`);

    const wiz = await page.evaluate(() => {
      const w = window.WIZ_global_data || {};
      return {
        at: w.SNlM0e || '',
        fsid: w.FdrFJe || '',
        bl: w.cfb2h || 'boq_labs-ai-sandbox-frontend_20260917.00_p0',
        projectId: w.PROJECT_ID || '',
      };
    });

    const targetProjectId = wiz.projectId || PROJECT_ID;
    const sessionId = crypto.randomUUID().toUpperCase();
    const guid2 = crypto.randomUUID().toUpperCase();
    const seed = Math.floor(Math.random() * 2147483647) + 1;

    const clientContext = [
      null,
      22,
      null,
      null,
      null,
      targetProjectId,
      null,
      null,
      null,
      null,
      [recaptchaToken, 1]
    ];

    const prompt = 'A realistic portrait photo of a modern electric kettle on a marble kitchen countertop, natural daylight, high resolution.';

    // EXACT structure from flow_frontend.py:
    const request = [
      null,                          // 0
      null,                          // 1
      null,                          // 2 (refImageSpec, none for this test)
      seed,                          // 3
      3,                             // 4 (aspectInt: 3 = 16:9)
      'GEM_PIX_2',                   // 5
      null,                          // 6
      clientContext,                 // 7
      [[[prompt]]],                  // 8
      null,                          // 9
      null,                          // 10
      null,                          // 11
      null,                          // 12
      sessionId,                     // 13
      guid2                          // 14
    ];

    const innerObj = [
      null,
      [request],
      1,
      clientContext,
      [sessionId]
    ];

    const reqId = Math.floor(Math.random() * 900000) + 100000;
    const bl = encodeURIComponent(wiz.bl || 'boq_labs-ai-sandbox-frontend_20260917.00_p0');
    const fsid = encodeURIComponent(wiz.fsid || '');
    const rpcUrl = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=ogiZ0b&source-path=${encodeURIComponent('/project/' + targetProjectId)}&bl=${bl}&f.sid=${fsid}&hl=en-US&_reqid=${reqId}&rt=c`;

    const fReq = JSON.stringify([[["ogiZ0b", JSON.stringify(innerObj), null, "generic"]]]);
    const activeAt = wiz.at || await page.evaluate(() => window.WIZ_global_data?.SNlM0e || '').catch(() => '');

    const bodyParams = new URLSearchParams();
    bodyParams.set('f.req', fReq);
    if (activeAt) bodyParams.set('at', activeAt);
    const bodyString = bodyParams.toString();

    console.log('3. Sending exact ogiZ0b RPC via page network...');
    const responseText = await page.evaluate(async ({ url, body }) => {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'x-same-domain': '1',
        },
        body: body
      });
      return await resp.text();
    }, { url: rpcUrl, body: bodyString });

    console.log('Response length:', responseText.length);
    console.log('Response preview:', responseText.substring(0, 500));

    if (responseText.includes('flow-content.google/image')) {
      console.log('🎉 SUCCESS! Found flow-content image URL in response!');
      const matches = [...responseText.matchAll(/https:(?:\\\/|\/)+flow-content\.google\/image\/[^"\s]+/g)];
      console.log('Extracted URLs:', matches.map(m => m[0]));
    } else if (responseText.includes('PUBLIC_ERROR')) {
      console.error('❌ Server returned error:', responseText.match(/PUBLIC_ERROR_[A-Z_]+/)?.[0]);
    }
  } finally {
    await closeFlowPage(page);
  }
}

main().catch(console.error);
