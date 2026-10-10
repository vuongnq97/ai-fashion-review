const { startProxyBridge } = require('./services/proxy-bridge');
const { chromium } = require('playwright');

async function printAs29s() {
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

  console.log('Raw respText:', respText);
  await browser.close();
  process.exit(0);
}

printAs29s();
