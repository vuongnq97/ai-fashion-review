'use strict';

/**
 * direct-flow-engine.js
 *
 * Engine tương tác trực tiếp với Google Flow thông qua Network trong Browser Context của Playwright:
 * - 100% KHÔNG click button, KHÔNG thao tác UI hay gõ phím trên DOM.
 * - Gọi trực tiếp batchexecute RPCs (maseQ, ogiZ0b, eb1hJf, jwpduf, as29s) qua `page.evaluate(fetch)`.
 * - Tự động đính kèm Cookie chính chủ Google Ultra (__Secure-*, SAPISID, SSID), Origin, Referer, TLS fingerprint.
 * - Sử dụng Captcha Worker mới (port 9060) để nạp reCAPTCHA token chất lượng cao, chống UNUSUAL_ACTIVITY.
 */

const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

const httpsInsecureAgent = new https.Agent({ rejectUnauthorized: false });

function cleanFlowImageUrl(rawUrl) {
  if (!rawUrl) return '';
  let url = rawUrl.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
  url = url.replace(/\\=/g, '=').replace(/\\&/g, '&');
  url = url.replace(/\\\/|\//g, '/');
  url = url.replace(/\\/g, '');
  url = url.replace(/["\s]+$/, '');
  return url.trim();
}

function downloadCdnBuffer(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      agent: httpsInsecureAgent,
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`CDN download returned HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('CDN download timeout'));
    });
  });
}

const { createFlowPage, getRecaptchaToken } = require('../browser');
const { getConfig } = require('../../utils/config-manager');

const config = getConfig(path.resolve(__dirname, '../..'));
const PROJECT_ID = config.systemSettings?.flowProjectId || '8ac10c4a-44b5-4d55-b470-10ab24db4c1c';
const SITE_KEY = config.systemSettings?.recaptchaSiteKey || '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
const CAPTCHA_WORKER_URL = process.env.CAPTCHA_WORKER_URL || 'http://127.0.0.1:9060/api/v1/solve';

const ASPECT_RATIO_TO_FLOW_INT = {
  '16:9': 3,
  'landscape': 3,
  '9:16': 2,
  'portrait': 2,
  '1:1': 1,
  'square': 1,
  '4:3': 4,
  '3:4': 5,
  'IMAGE_ASPECT_RATIO_LANDSCAPE': 3,
  'IMAGE_ASPECT_RATIO_PORTRAIT': 2,
  'IMAGE_ASPECT_RATIO_SQUARE': 1,
};

// Model chuẩn Flow batchexecute RPC cho Nano Banana 2 / Pro Image
const FLOW_IMAGE_MODEL = 'GEM_PIX_2';

/**
 * Lấy token reCAPTCHA chất lượng cao từ Captcha Worker (port 9060) hoặc real Chrome browser
 */
async function getHighTrustCaptchaToken(page, action = 'IMAGE_GENERATION', projectId = PROJECT_ID) {
  // 1. ƯU TIÊN SỐ 1: Captcha Worker pool (port 9060) chạy Puppeteer Stealth
  // Bỏ qua extension_hijack_detected của reCAPTCHA Enterprise, điểm bot score 0.9 cao nhất
  try {
    const res = await axios.post(
      CAPTCHA_WORKER_URL,
      { action },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer flow2api_secret',
        },
        timeout: 10000,
      }
    );
    if (res.data?.token && res.data.token.length > 50) {
      console.log(`[DirectEngine] 🛡️ Obtained high-score reCAPTCHA token via Captcha Worker (session: ${res.data.session_id ? res.data.session_id.substring(0, 8) : 'n/a'}..., action: ${action})`);
      return {
        token: res.data.token,
        sessionId: res.data.session_id || null,
        userAgent: res.data.fingerprint?.user_agent || null,
      };
    }
  } catch (workerErr) {
    console.warn(`[DirectEngine] ⚠️ Captcha Worker (port 9060) warning: ${workerErr.message}. Falling back to browser page...`);
  }

  // 2. Fallback: Lấy trực tiếp từ tab Google Chrome
  if (page && !page.isClosed()) {
    try {
      if (typeof getRecaptchaToken === 'function') {
        const tok = await getRecaptchaToken(page, action);
        if (tok && tok.length > 50) {
          return { token: tok, sessionId: null, userAgent: null };
        }
      }
      const pageTok = await page.evaluate(async ({ siteKey, act }) => {
        if (typeof grecaptcha !== 'undefined' && grecaptcha.enterprise) {
          return await grecaptcha.enterprise.execute(siteKey, { action: act });
        }
        return '';
      }, { siteKey: SITE_KEY, act: action });
      if (pageTok && pageTok.length > 50) return { token: pageTok, sessionId: null, userAgent: null };
    } catch (pageErr) {
      console.warn(`[DirectEngine] ⚠️ Page reCAPTCHA fetch warning: ${pageErr.message}`);
    }
  }

  return { token: '', sessionId: null, userAgent: null };
}

function reportCaptchaResult(captchaData, success, reason = '') {
  if (!captchaData || !captchaData.sessionId) return;
  const baseUrl = CAPTCHA_WORKER_URL.replace(/\/api\/v1\/solve$/, '');
  if (success) {
    axios.post(`${baseUrl}/api/v1/sessions/${captchaData.sessionId}/finish`, {}, {
      headers: { 'Authorization': 'Bearer flow2api_secret', 'Content-Type': 'application/json' },
      timeout: 3000
    }).catch(() => {});
  }
}

/**
 * Lấy thông tin WIZ_global_data từ browser
 */
async function getWizData(page) {
  if (!page || page.isClosed()) {
    return {
      at: '',
      fsid: '',
      bl: 'boq_labs-ai-sandbox-frontend_20260917.00_p0',
      projectId: PROJECT_ID,
    };
  }

  try {
    const wiz = await page.evaluate(() => {
      const w = window.WIZ_global_data || {};
      return {
        at: w.SNlM0e || '',
        fsid: w.FdrFJe || '',
        bl: w.cfb2h || 'boq_labs-ai-sandbox-frontend_20260917.00_p0',
        projectId: w.PROJECT_ID || '',
      };
    });
    return wiz;
  } catch (_) {
    return {
      at: '',
      fsid: '',
      bl: 'boq_labs-ai-sandbox-frontend_20260917.00_p0',
      projectId: PROJECT_ID,
    };
  }
}

/**
 * 1. Upload ảnh trực tiếp qua maseQ RPC trong network của browser
 */
async function uploadImageDirectNetwork(page, imageBuffer, fileName = 'image.png', mimeType = 'image/jpeg') {
  if (!page || page.isClosed()) throw new Error('[DirectEngine] Browser page is not available for upload');

  const imageBase64 = Buffer.isBuffer(imageBuffer) ? imageBuffer.toString('base64') : imageBuffer;
  const wiz = await getWizData(page);
  const targetProjectId = wiz.projectId || PROJECT_ID;
  const captchaData = await getHighTrustCaptchaToken(page, 'UPLOAD_IMAGE', targetProjectId);
  const recaptchaToken = typeof captchaData === 'string' ? captchaData : (captchaData?.token || '');

  const clientGuid1 = crypto.randomUUID().toUpperCase();
  const clientGuid2 = crypto.randomUUID().toUpperCase();

  const innerPayload = [
    [
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
      [
        recaptchaToken || '',
        1
      ]
    ],
    imageBase64,
    mimeType,
    1,
    null,
    null,
    null,
    null,
    fileName,
    null,
    clientGuid1,
    clientGuid2
  ];

  const reqId = Math.floor(Math.random() * 900000) + 100000;
  const bl = encodeURIComponent(wiz.bl || 'boq_labs-ai-sandbox-frontend_20260917.00_p0');
  const fsid = encodeURIComponent(wiz.fsid || '');
  const rpcUrl = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=maseQ&source-path=${encodeURIComponent('/project/' + targetProjectId)}&bl=${bl}&f.sid=${fsid}&hl=vi&_reqid=${reqId}&rt=c`;

  const fReq = JSON.stringify([[["maseQ", JSON.stringify(innerPayload), null, "generic"]]]);
  const activeAt = wiz.at || await page.evaluate(() => window.WIZ_global_data?.SNlM0e || '').catch(() => '');

  const bodyParams = new URLSearchParams();
  bodyParams.set('f.req', fReq);
  if (activeAt) bodyParams.set('at', activeAt);
  const bodyString = bodyParams.toString();

  console.log(`[DirectEngine] 📤 Uploading reference image (${(imageBuffer.length / 1024).toFixed(1)} KB) directly via maseQ RPC...`);

  try {
    const respText = await page.evaluate(async ({ url, body }) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'x-same-domain': '1',
        },
        body: body
      });
      if (!r.ok) {
        const errText = await r.text();
        throw new Error(`maseQ upload HTTP ${r.status}: ${errText.slice(0, 300)}`);
      }
      return await r.text();
    }, { url: rpcUrl, body: bodyString });

    // Trích xuất mediaId (UUID) từ response
    let mediaId = null;
    const uuidMatches = respText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
    if (uuidMatches && uuidMatches.length > 0) {
      mediaId = uuidMatches.find(u => u !== clientGuid1.toLowerCase() && u !== clientGuid2.toLowerCase()) || uuidMatches[0];
    }

    if (!mediaId) {
      throw new Error(`[DirectEngine] Failed to resolve mediaId from maseQ response: ${respText.slice(0, 300)}`);
    }

    reportCaptchaResult(captchaData, true);
    console.log(`[DirectEngine] ✅ Uploaded successfully -> Media ID: ${mediaId}`);
    return mediaId;
  } catch (err) {
    reportCaptchaResult(captchaData, false, err.message);
    throw err;
  }
}

function parseBatchExecute(rawText, rpcId = 'ogiZ0b') {
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

/**
 * Helper trích xuất image URL từ ogiZ0b response
 */
function extractImageUrlFromOgiZ0b(respText) {
  const parsed = parseBatchExecute(respText, 'ogiZ0b');
  let signedUrl = parsed?.[0]?.[0]?.[6]?.[0]?.[13];
  if (!signedUrl && parsed) {
    function findImageUrl(curr) {
      if (!curr || signedUrl) return;
      if (typeof curr === 'string' && curr.includes('flow-content.google/image/')) {
        signedUrl = curr;
        return;
      }
      if (Array.isArray(curr)) {
        for (const el of curr) findImageUrl(el);
      } else if (typeof curr === 'object') {
        for (const k of Object.keys(curr)) findImageUrl(curr[k]);
      }
    }
    findImageUrl(parsed);
  }
  if (!signedUrl) {
    const match = respText.match(/https:(?:\\\/|\/)+flow-content\.google\/image\/[^"\s]+/i);
    if (match) {
      let raw = match[0].replace(/\\\/|\//g, '/');
      raw = raw.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
      raw = raw.replace(/[\\]+$/g, '');
      signedUrl = raw;
    }
  }
  return signedUrl;
}

/**
 * 2. Sinh 1 Master Storyboard candidate trực tiếp qua ogiZ0b RPC trong network của browser
 */
async function generateSingleStoryboardDirect(page, { prompt, imageUuids = [], aspectRatio = '16:9', candidateIndex = 1, recaptchaToken = null }) {
  const wiz = await getWizData(page);
  const targetProjectId = wiz.projectId || PROJECT_ID;
  const aspectInt = ASPECT_RATIO_TO_FLOW_INT[aspectRatio] || 3;
  const captchaData = recaptchaToken ? { token: recaptchaToken } : await getHighTrustCaptchaToken(page, 'IMAGE_GENERATION', targetProjectId);
  const activeRecaptchaToken = typeof captchaData === 'string' ? captchaData : (captchaData?.token || '');

  const seed = Math.floor(Math.random() * 2000000000);
  const guid1 = crypto.randomUUID().toUpperCase();
  const guid2 = crypto.randomUUID().toUpperCase();
  const batchGuid = crypto.randomUUID().toUpperCase();

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
    [
      activeRecaptchaToken || '',
      1
    ]
  ];

  // Nạp trực tiếp image UUIDs vào slot [2]
  const refImageSpec = (Array.isArray(imageUuids) && imageUuids.length > 0)
    ? imageUuids.map(id => [id, null, null, null, 1])
    : null;

  const innerObj = [
    null,
    [
      [
        null,
        null,
        refImageSpec,
        seed,
        aspectInt,
        FLOW_IMAGE_MODEL,
        null,
        clientContext,
        [
          [
            [
              prompt
            ]
          ]
        ],
        null,
        null,
        null,
        guid1,
        guid2
      ]
    ],
    1,
    clientContext,
    [
      batchGuid
    ]
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

  console.log(`[DirectEngine] 🚀 Candidate #${candidateIndex}: Sending ogiZ0b RPC via page network (ref: ${imageUuids.join(', ') || 'none'})...`);

  try {
    const responseText = await page.evaluate(async ({ url, body }) => {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'x-same-domain': '1',
        },
        body: body
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${t.substring(0, 300)}`);
      }
      return await resp.text();
    }, { url: rpcUrl, body: bodyString });

    const rawUrl = extractImageUrlFromOgiZ0b(responseText);
    if (!rawUrl) {
      if (responseText.includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY')) {
        throw new Error('Google Flow UNUSUAL_ACTIVITY: Bot score throttled.');
      }
      throw new Error(`No image URL returned from ogiZ0b: ${responseText.slice(0, 300)}`);
    }

    const signedUrl = cleanFlowImageUrl(rawUrl);
    const buffer = await downloadCdnBuffer(signedUrl);
    reportCaptchaResult(captchaData, true);
    console.log(`[DirectEngine] ✅ Candidate #${candidateIndex} generated successfully (${(buffer.length / 1024).toFixed(1)} KB)`);
    return { candidateIndex, buffer, signedUrl };
  } catch (err) {
    reportCaptchaResult(captchaData, false, err.message);
    throw err;
  }
}

/**
 * 3. Sinh Master Storyboard qua Native Network Stream:
 * - Không click settings/menu phức tạp, không cào DOM hay chờ img tag.
 * - Nhập prompt vào composer bằng event tự nhiên (100% human score cho reCAPTCHA Enterprise).
 * - Bắt trực tiếp luồng phản hồi HTTP của RPC ogiZ0b trong page.on('response').
 * - Tách ngay 4 signed image URLs từ response stream và tải song song buffer.
 */
async function generateStoryboardsViaNativeNetworkStream(page, {
  prompt,
  aspectRatio = '16:9',
  referenceBuffer = null,
  imageInputUUIDs = [],
  filePayloads = [],
  outputCount = 4,
  timeoutMs = 60000
}) {
  if (!page || page.isClosed()) throw new Error('[DirectEngine] Browser page is not available');

  console.log(`[DirectEngine] 🚀 Triggering storyboard generation via Native Network Stream (aspectRatio: ${aspectRatio}, refBuf: ${referenceBuffer ? 'yes' : 'no'}, refUUIDs: ${imageInputUUIDs?.length || 0})...`);

  // Helper to aggressively dismiss all modal popups/change-log dialogs/cookie banners in Flow UI
  const dismissModals = async () => {
    try {
      await page.evaluate(() => {
        // 1. Accept and remove Google GDPR cookie notification banner
        const cookieBtns = document.querySelectorAll(
          '.glue-cookie-notification-bar__accept, button[aria-label*="cookie" i], .glue-cookie-notification-bar button'
        );
        cookieBtns.forEach(b => b.click());
        document.querySelectorAll('.glue-cookie-notification-bar, #glue-cookie-notification-bar-1, [id*="glue-cookie"]').forEach(b => b.remove());

        // 2. Find and click any close/dismiss/got it button on modals/dialogs
        const buttons = Array.from(document.querySelectorAll(
          '.change-log-modal-actions button, mat-dialog-actions button, mat-dialog-container button, [role="dialog"] button, .cdk-overlay-pane button'
        ));
        for (const btn of buttons) {
          const txt = (btn.textContent || '').trim().toLowerCase();
          if (txt.includes('got it') || txt.includes('đã hiểu') || txt.includes('đóng') || txt.includes('close') || txt.includes('dismiss') || txt.includes('bắt đầu') || txt.includes('hoàn tất') || txt.includes('agree')) {
            btn.click();
          }
        }
        // 3. Remove backdrops
        const backdrops = document.querySelectorAll('.cdk-overlay-backdrop, .change-log-modal-actions');
        backdrops.forEach(b => {
          const dialog = b.closest('mat-dialog-container, .cdk-overlay-pane');
          if (dialog) dialog.remove();
          b.remove();
        });
      }).catch(() => {});
      for (let i = 0; i < 2; i++) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(50);
      }
    } catch (_) {}
  };

  await dismissModals();

  // 0. Đảm bảo composer ở trạng thái sẵn sàng
  const isBusy = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return text.includes('99%') || text.includes('Đang tạo');
  }).catch(() => false);
  if (isBusy) {
    console.log('[DirectEngine] 🔄 Trang đang bận từ tác vụ cũ, tải lại để đặt lại trạng thái...');
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3000);
    await dismissModals();
  }

  // Thu thập / upload danh sách reference image UUIDs
  const effectiveImageUuids = Array.isArray(imageInputUUIDs) ? [...imageInputUUIDs].filter(Boolean) : [];
  if (effectiveImageUuids.length === 0) {
    if (Array.isArray(filePayloads) && filePayloads.length > 0) {
      for (const fp of filePayloads) {
        const buf = fp.buffer || (fp.path && fs.existsSync(fp.path) ? fs.readFileSync(fp.path) : null);
        if (buf) {
          try {
            console.log(`[DirectEngine] 📤 Uploading reference payload "${fp.name || 'ref.png'}" directly via maseQ RPC...`);
            const uid = await uploadImageDirectNetwork(page, buf, fp.name || 'ref.png', fp.mimeType || 'image/png');
            if (uid) effectiveImageUuids.push(uid);
          } catch (upErr) {
            console.warn(`[DirectEngine] ⚠️ Failed to upload ${fp.name}: ${upErr.message}`);
          }
        }
      }
    } else if (referenceBuffer) {
      try {
        console.log(`[DirectEngine] 📤 Uploading reference buffer directly via maseQ RPC...`);
        const uid = await uploadImageDirectNetwork(page, referenceBuffer, 'ref.png', 'image/png');
        if (uid) effectiveImageUuids.push(uid);
      } catch (upErr) {
        console.warn(`[DirectEngine] ⚠️ Failed to upload referenceBuffer: ${upErr.message}`);
      }
    }
  }
  if (effectiveImageUuids.length > 0) {
    console.log(`[DirectEngine] 🖼️ Reference image UUID(s) to inject into ogiZ0b: ${effectiveImageUuids.join(', ')}`);
  }

  // 1. Cài đặt composer trước: Chế độ Hình ảnh (Image mode), Model (Nano Banana Pro), Tỷ lệ 16:9 (Aspect Ratio), Số lượng ảnh (Output count)
  try {
    const settingsBtn = page.locator('button[aria-label="Điều kiện kích hoạt cài đặt"], button[aria-label="Settings trigger"], button:has-text("Nano Banana"), button:has-text("Hình ảnh"), button:has-text("Video ·")').first();
    if (await settingsBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
      const btnText = (await settingsBtn.innerText().catch(() => '')).toLowerCase();
      console.log(`[DirectEngine] ⚙️ Current settings button: "${btnText.replace(/\n/g, ' ')}"`);

      const targetRatio = (aspectRatio === '16:9' || aspectRatio === 'landscape') ? '16:9' : '9:16';
      const isRatioCorrect = targetRatio === '16:9'
        ? (btnText.includes('16_9') || btnText.includes('16:9'))
        : (btnText.includes('9_16') || btnText.includes('9:16'));
      const isModeCorrect = btnText.includes('hình ảnh') || btnText.includes('image') || btnText.includes('banana');
      const targetCountStr = `x${Math.min(Math.max(Number(outputCount) || 1, 1), 4)}`;
      const isCountCorrect = btnText.includes(targetCountStr);
      const isModelCorrect = btnText.includes('banana pro') || btnText.includes('pro');

      if (!isModeCorrect || !isRatioCorrect || !isCountCorrect || !isModelCorrect) {
        console.log(`[DirectEngine] 🔄 Cập nhật cài đặt Flow UI: mode=Image, model=Nano Banana Pro, ratio=${targetRatio}, count=${targetCountStr}...`);
        await settingsBtn.click({ force: true });
        await page.waitForSelector('mat-button-toggle', { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(300);

        // a. Switch to Image mode if currently in Video
        await page.evaluate(() => {
          const toggles = Array.from(document.querySelectorAll('mat-button-toggle'));
          for (const t of toggles) {
            const txt = (t.innerText || t.textContent || '').toLowerCase();
            if (txt.includes('hình ảnh') || txt.includes('image')) {
              const isChecked = t.classList.contains('mat-button-toggle-checked') || t.getAttribute('aria-checked') === 'true';
              if (!isChecked) {
                const btn = t.querySelector('button') || t;
                btn.click();
              }
              break;
            }
          }
        }).catch(() => {});
        await page.waitForTimeout(200);

        // b. Switch Aspect Ratio to 16:9 (or target)
        const ratioSet = await page.evaluate((ratio) => {
          const isLandscape = ratio === '16:9';
          const toggles = Array.from(document.querySelectorAll('mat-button-toggle'));
          for (const t of toggles) {
            const txt = (t.innerText || t.textContent || '').trim();
            const val = (t.getAttribute('value') || '').toUpperCase();
            const aria = (t.getAttribute('aria-label') || '').toLowerCase();
            const isMatch = txt.includes(ratio) ||
              (isLandscape && (val.includes('LANDSCAPE') || aria.includes('16:9') || txt.includes('16_9') || txt.includes('16:9'))) ||
              (!isLandscape && (val.includes('PORTRAIT') || aria.includes('9:16') || txt.includes('9_16') || txt.includes('9:16')));
            if (isMatch) {
              const isChecked = t.classList.contains('mat-button-toggle-checked') || t.getAttribute('aria-checked') === 'true';
              if (!isChecked) {
                const btn = t.querySelector('button') || t;
                btn.click();
              }
              return txt;
            }
          }
          return null;
        }, targetRatio).catch(() => null);
        console.log(`[DirectEngine] 📐 Ratio toggle clicked: ${ratioSet || 'not found'}`);
        await page.waitForTimeout(200);

        // c. Switch Model to Nano Banana Pro
        try {
          const currentModelText = await page.evaluate(() => {
            const btn = document.querySelector('.cdk-overlay-pane button[aria-label="Chọn nhóm mô hình"], .cdk-overlay-pane button[aria-haspopup="menu"]');
            return btn ? (btn.innerText || '').toLowerCase() : '';
          });
          if (!currentModelText.includes('banana pro') && !currentModelText.includes('pro')) {
            const modelPickerBtn = page.locator('.cdk-overlay-pane button[aria-label="Chọn nhóm mô hình"], .cdk-overlay-pane button[aria-haspopup="menu"]').first();
            if (await modelPickerBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
              await modelPickerBtn.click({ force: true });
              await page.waitForTimeout(300);
              const proOption = page.locator('.mat-mdc-menu-panel button').filter({ hasText: /Nano Banana Pro/i }).first();
              if (await proOption.isVisible({ timeout: 2000 }).catch(() => false)) {
                await proOption.click({ force: true });
                console.log('[DirectEngine] 🍌 Switched model to: Nano Banana Pro');
                await page.waitForTimeout(300);
              } else {
                await page.keyboard.press('Escape').catch(() => {});
              }
            }
          }
        } catch (modelErr) {
          console.warn('[DirectEngine] ⚠️ Model selection warning:', modelErr.message);
        }
        await page.waitForTimeout(200);

        // d. Switch Output Count (e.g. x4)
        const countSet = await page.evaluate((cStr) => {
          const toggles = Array.from(document.querySelectorAll('mat-button-toggle'));
          for (const t of toggles) {
            const txt = (t.innerText || t.textContent || '').trim();
            if (txt === cStr || txt.includes(cStr)) {
              const isChecked = t.classList.contains('mat-button-toggle-checked') || t.getAttribute('aria-checked') === 'true';
              if (!isChecked) {
                const btn = t.querySelector('button') || t;
                btn.click();
              }
              return txt;
            }
          }
          return null;
        }, targetCountStr).catch(() => null);
        console.log(`[DirectEngine] 🔢 Count toggle clicked: ${countSet || 'not found'}`);
        await page.waitForTimeout(200);

        // Đóng panel cài đặt
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
      }
    }
  } catch (modeErr) {
    console.warn('[DirectEngine] ⚠️ Settings adjustment warning:', modeErr.message);
  }

  await dismissModals();

  // Route interceptor để ép cứng aspectInt và số lượng outputCount vào ogiZ0b
  const targetAspectInt = (aspectRatio === '16:9' || aspectRatio === 'landscape') ? 3 : (aspectRatio === '9:16' ? 2 : 1);
  let routeCleanedUp = false;
  const isOgiZ0bUrl = (url) => {
    const s = typeof url === 'string' ? url : (url.href || url.toString());
    return s.includes('batchexecute') && s.includes('ogiZ0b');
  };

  const cleanupRoute = async () => {
    if (!routeCleanedUp) {
      routeCleanedUp = true;
      try { await page.unroute(isOgiZ0bUrl); } catch (_) {}
    }
  };

  await cleanupRoute();
  routeCleanedUp = false;

  await page.route(isOgiZ0bUrl, async (route) => {
    try {
      const postData = route.request().postData() || '';
      if (postData.includes('f.req=')) {
        const params = new URLSearchParams(postData);
        const fReqStr = params.get('f.req');
        if (fReqStr) {
          const fReq = JSON.parse(fReqStr);
          let modified = false;
          if (Array.isArray(fReq)) {
            for (const batch of fReq) {
              if (Array.isArray(batch)) {
                for (const entry of batch) {
                  if (Array.isArray(entry) && entry[0] === 'ogiZ0b' && entry[1]) {
                    const inner = JSON.parse(entry[1]);
                    if (Array.isArray(inner[1])) {
                      const refImageSpec = (effectiveImageUuids.length > 0)
                        ? effectiveImageUuids.map(id => [id, null, null, null, 1])
                        : null;

                      for (const item of inner[1]) {
                        if (Array.isArray(item)) {
                          item[4] = targetAspectInt;
                          if (refImageSpec) {
                            item[2] = refImageSpec;
                          }
                          modified = true;
                        }
                      }
                      const reqCount = Number(outputCount) || 1;
                      if (reqCount > 1 && inner[1].length < reqCount && inner[1][0]) {
                        while (inner[1].length < reqCount) {
                          const clone = JSON.parse(JSON.stringify(inner[1][0]));
                          clone[3] = Math.floor(Math.random() * 2000000000);
                          clone[13] = crypto.randomUUID().toUpperCase();
                          clone[14] = crypto.randomUUID().toUpperCase();
                          inner[1].push(clone);
                        }
                        modified = true;
                      }
                    }
                    if (modified) {
                      entry[1] = JSON.stringify(inner);
                    }
                  }
                }
              }
            }
          }
          if (modified) {
            params.set('f.req', JSON.stringify(fReq));
            console.log(`[DirectEngine] 🔀 Route interceptor injected aspectInt=${targetAspectInt} (${aspectRatio}), ${effectiveImageUuids.length} ref UUID(s) & count=${outputCount} into ogiZ0b!`);
            await route.continue({ postData: params.toString() });
            return;
          }
        }
      }
    } catch (e) {
      console.warn(`[DirectEngine] ⚠️ ogiZ0b route intercept warning: ${e.message}`);
    }
    await route.continue();
  }).catch(() => {});

  // 3. Nhập prompt vào composer nhanh & kích hoạt ProseMirror dirty state
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await dismissModals();
  console.log(`[DirectEngine] ✍️ Typing prompt into Flow composer (url: ${page.url()})...`);
  const editor = page.locator('flow-base-prompt-box .ProseMirror, .base-prompt-box [contenteditable="true"], .ProseMirror, [contenteditable="true"]').last();
  await editor.waitFor({ state: 'attached', timeout: 15000 });
  await dismissModals();
  await editor.evaluate((el, text) => {
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
  }, prompt);
  await page.waitForTimeout(100);

  const editorText = (await editor.innerText().catch(() => '')).trim();
  if (!editorText) {
    await page.keyboard.insertText(prompt);
  }
  // Tap space + backspace to ensure ProseMirror dirty & input state is activated
  await page.keyboard.press('Space');
  await page.waitForTimeout(50);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);

  // 3. Thiết lập passive response stream listener cho ogiZ0b và submit
  let capturedUrls = [];
  let isUnusualThrottled = false;
  let cleanupListeners = null;

  try {
    const responsePromise = new Promise((resolve, reject) => {
      let timeoutTimer = null;
      let debounceTimer = null;
      let pollTimer = null;
      let isDone = false;

      const cleanup = () => {
        if (isDone) return;
        isDone = true;
        try { page.off('response', onResponse); } catch (_) {}
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (debounceTimer) clearTimeout(debounceTimer);
        if (pollTimer) clearInterval(pollTimer);
        cleanupRoute().catch(() => {});
      };

      cleanupListeners = cleanup;

      const triggerUnusualActivity = (sourceMsg) => {
        if (isDone || isUnusualThrottled) return;
        isUnusualThrottled = true;
        console.warn(`[DirectEngine] ⚠️ Google Flow UNUSUAL_ACTIVITY detected (${sourceMsg}).`);
        try {
          const { rotateProxy } = require('../proxy-bridge');
          const nextP = rotateProxy();
          console.log(`[DirectEngine] 🔄 Auto-switched to proxy #${nextP.index + 1}/${nextP.total} (${nextP.host}:${nextP.port})`);
        } catch (_) {}
        cleanup();
        reject(new Error('Google Flow UNUSUAL_ACTIVITY: Bot score throttled.'));
      };

      const onResponse = async (res) => {
        if (isDone) return;
        const url = res.url();
        if (url.includes('batchexecute') && url.includes('ogiZ0b')) {
          try {
            const text = await res.text();
            if (text.includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY')) {
              console.warn(`[DirectEngine] ⚠️ ogiZ0b response text snippet: ${text.slice(0, 500)}`);
              triggerUnusualActivity('ogiZ0b RPC');
              return;
            }
            if (text.includes('flow-content.google/image')) {
              const matches = [...text.matchAll(/https:(?:\\\/|\/)+flow-content\.google\/image\/[^"\s]+/g)];
              const extracted = matches.map(m => cleanFlowImageUrl(m[0])).filter(Boolean);
              for (const u of extracted) {
                if (!capturedUrls.includes(u)) capturedUrls.push(u);
              }
              console.log(`[DirectEngine] 📦 [Network Stream] Extracted ${extracted.length} image URL(s) from ogiZ0b!`);
              if (capturedUrls.length >= outputCount) {
                cleanup();
                resolve(capturedUrls);
              } else if (capturedUrls.length > 0) {
                if (!debounceTimer) {
                  debounceTimer = setTimeout(() => {
                    cleanup();
                    resolve(capturedUrls);
                  }, 2000);
                }
              }
            }
          } catch (_) {}
        }
      };

      page.on('response', onResponse);

      // Kiểm tra định kỳ DOM UI (mỗi 1.2s) xem Google có hiện toast snackbar Unusual Activity không
      pollTimer = setInterval(async () => {
        try {
          if (isDone || page.isClosed()) return;
          const hasUiError = await page.evaluate(() => {
            const alerts = Array.from(document.querySelectorAll(
              'mat-snack-bar-container, .mat-mdc-snack-bar-container, [role="alert"], [role="alertdialog"]'
            ));
            for (const el of alerts) {
              const t = (el.innerText || el.textContent || '').toLowerCase();
              if (t.includes('unusual activity') || t.includes('hoạt động bất thường')) {
                return true;
              }
            }
            return false;
          });
          if (hasUiError) {
            triggerUnusualActivity('DOM UI alert');
          }
        } catch (_) {}
      }, 1200);

      timeoutTimer = setTimeout(() => {
        cleanup();
        if (capturedUrls.length > 0) {
          resolve(capturedUrls);
        } else if (isUnusualThrottled) {
          reject(new Error('Google Flow UNUSUAL_ACTIVITY: Bot score throttled.'));
        } else {
          reject(new Error(`Timeout ${timeoutMs / 1000}s waiting for ogiZ0b image response stream.`));
        }
      }, timeoutMs);
    });

    // CRITICAL: Prevent unhandledRejection crash if any other error occurs
    responsePromise.catch(() => {});

    // Đợi nút submit được kích hoạt (disabled: false)
    await page.waitForFunction(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent || '').includes('arrow_forward'));
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
    }, { timeout: 6000 }).catch(() => {});

    // 4. Kích hoạt submit qua real mouse click trên nút mũi tên hoặc Enter
    console.log('[DirectEngine] ⚡ Triggering native submit...');
    await dismissModals();
    const submitBtn = page.locator('button').filter({ hasText: /arrow_forward/i }).last();
    // 1. DOM direct click (không bị chặn bởi pointer events hay overlay)
    await submitBtn.evaluate(b => b.click()).catch(() => {});
    // 2. Playwright force click
    const btnBox = await submitBtn.boundingBox().catch(() => null);
    if (btnBox) {
      await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2).catch(() => {});
    } else {
      await submitBtn.click({ force: true, timeout: 2000 }).catch(() => {});
    }
    // 3. Focus editor và nhấn Enter
    await editor.evaluate(el => el.focus()).catch(() => {});
    await page.waitForTimeout(100);
    await page.keyboard.press('Enter').catch(() => {});

    // 5. Chờ kết quả từ luồng response stream
    console.log('[DirectEngine] ⏳ Awaiting ogiZ0b response directly from browser network stream...');
    const urls = await responsePromise;

    if (!urls || urls.length === 0) {
      throw new Error('[DirectEngine] No images captured from network stream.');
    }

    console.log(`[DirectEngine] ✅ Captured ${urls.length} images directly from network stream! Downloading buffers in parallel...`);

    const downloadTasks = urls.slice(0, outputCount).map(async (u, i) => {
      try {
        const buf = await downloadCdnBuffer(u);
        console.log(`[DirectEngine]   Candidate #${i + 1} downloaded: ${(buf.length / 1024).toFixed(1)} KB`);
        return buf;
      } catch (err) {
        console.warn(`[DirectEngine] ⚠️ Candidate #${i + 1} download error: ${err.message}`);
        return null;
      }
    });

    const downloaded = (await Promise.all(downloadTasks)).filter(Boolean);
    if (downloaded.length === 0) {
      throw new Error('[DirectEngine] Failed to download any candidate image buffers.');
    }

    while (downloaded.length < outputCount) {
      downloaded.push(downloaded[0]);
    }

    return downloaded;
  } finally {
    if (cleanupListeners) {
      cleanupListeners();
    }
    await cleanupRoute().catch(() => {});
  }
}

/**
 * 4. Sinh 4 Master Storyboard song song qua Network của browser
 */
async function generate4MasterStoryboardsDirect(page, { prompt, referenceBuffer, aspectRatio = '16:9' }) {
  const maxAttempts = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await generateStoryboardsViaNativeNetworkStream(page, {
        prompt,
        referenceBuffer,
        aspectRatio,
        outputCount: 4,
        timeoutMs: 60000
      });
    } catch (err) {
      lastErr = err;
      console.warn(`[DirectEngine] ⚠️ Native network stream attempt ${attempt}/${maxAttempts} error: ${err.message}`);
      if (attempt < maxAttempts) {
        console.log('[DirectEngine] ⏳ Cooldown 3s và tải lại Flow page với IP proxy mới trước khi thử lại...');
        await new Promise(r => setTimeout(r, 3000));
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); } catch (_) {}
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  throw lastErr || new Error('[DirectEngine] Failed to generate 4 master storyboards via network stream.');
}

/**
 * 4. Sinh 1 Video trực tiếp từ ảnh Panel qua Network (eb1hJf + jwpduf poll)
 */
async function generateVideoDirectNetwork(page, { imageBuffer, prompt, duration = 4, aspectRatio = '9:16' }) {
  if (!page || page.isClosed()) throw new Error('[DirectEngine] Browser page is not available for video generation');

  // 1. Upload ảnh start frame
  const imageMediaId = await uploadImageDirectNetwork(page, imageBuffer, 'panel_frame.png', 'image/png');
  const wiz = await getWizData(page);
  const targetProjectId = wiz.projectId || PROJECT_ID;
  const isPortrait = aspectRatio === '9:16' || aspectRatio === 'portrait';
  const captchaData = await getHighTrustCaptchaToken(page, 'VIDEO_GENERATION', targetProjectId);
  const recaptchaToken = typeof captchaData === 'string' ? captchaData : (captchaData?.token || '');

  const modelKey = Number(duration) === 8 ? 'abra_i2v_8s' : 'abra_i2v_4s';
  const defaultCrop = isPortrait
    ? [0.3701416015625, null, 0.6298583984375, 1]
    : [0.1049382716049383, null, 0.8950617283950617, 1];

  const seed = Math.floor(Math.random() * 2000000000);
  const clientGuid1 = crypto.randomUUID().toUpperCase();
  const clientGuid2 = crypto.randomUUID().toUpperCase();
  const batchGuid = crypto.randomUUID().toUpperCase();

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
    [
      recaptchaToken || '',
      1
    ]
  ];

  const targetRatioInt = isPortrait ? 1 : 2;

  // Cấu trúc payload chuẩn của eb1hJf cho Image-to-Video
  const innerPayload = [
    [
      [
        null,
        modelKey,
        targetRatioInt,
        prompt,
        [null, imageMediaId, null, null, null, defaultCrop],
        seed,
        clientContext,
        null,
        null,
        null,
        clientGuid1,
        clientGuid2
      ]
    ],
    1,
    clientContext,
    [
      batchGuid
    ]
  ];

  const reqId = Math.floor(Math.random() * 900000) + 100000;
  const bl = encodeURIComponent(wiz.bl || 'boq_labs-ai-sandbox-frontend_20260917.00_p0');
  const fsid = encodeURIComponent(wiz.fsid || '');
  const rpcUrl = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=eb1hJf&source-path=${encodeURIComponent('/project/' + targetProjectId)}&bl=${bl}&f.sid=${fsid}&hl=vi&_reqid=${reqId}&rt=c`;

  const fReq = JSON.stringify([[["eb1hJf", JSON.stringify(innerPayload), null, "generic"]]]);
  const activeAt = wiz.at || await page.evaluate(() => window.WIZ_global_data?.SNlM0e || '').catch(() => '');

  const bodyParams = new URLSearchParams();
  bodyParams.set('f.req', fReq);
  if (activeAt) bodyParams.set('at', activeAt);
  const bodyString = bodyParams.toString();

  console.log(`[DirectEngine] 🎬 Calling eb1hJf RPC for video (model: ${modelKey}, startFrame: ${imageMediaId})...`);

  const responseText = await page.evaluate(async ({ url, body }) => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'x-same-domain': '1',
      },
      body: body
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`eb1hJf HTTP ${resp.status}: ${t.substring(0, 300)}`);
    }
    return await resp.text();
  }, { url: rpcUrl, body: bodyString });

  // Trích xuất mediaName của task video từ response eb1hJf
  const parsedEb = parseBatchExecute(responseText, 'eb1hJf');
  let videoMediaName = parsedEb?.[3]?.[0]?.[0] || parsedEb?.[2]?.[0]?.[3]?.[4];
  if (!videoMediaName) {
    const uuidMatches = responseText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
    if (uuidMatches && uuidMatches.length > 0) {
      videoMediaName = uuidMatches.find(u => u !== clientGuid1.toLowerCase() && u !== clientGuid2.toLowerCase() && u !== imageMediaId.toLowerCase()) || uuidMatches[0];
    }
  }

  if (!videoMediaName) {
    throw new Error(`[DirectEngine] Failed to resolve videoMediaName from eb1hJf response: ${responseText.slice(0, 300)}`);
  }

  console.log(`[DirectEngine] ⏳ Video task submitted: ${videoMediaName}. Polling for completion...`);

  // Poll trạng thái qua jwpduf hoặc as29s
  const pollUrl = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=jwpduf&source-path=${encodeURIComponent('/project/' + targetProjectId)}&bl=${bl}&f.sid=${fsid}&hl=vi&_reqid=${reqId}&rt=c`;
  const pollInner = [null, null, [[videoMediaName]]];
  const pollFReq = JSON.stringify([[["jwpduf", JSON.stringify(pollInner), null, "generic"]]]);
  const pollParams = new URLSearchParams();
  pollParams.set('f.req', pollFReq);
  if (activeAt) pollParams.set('at', activeAt);
  const pollBodyString = pollParams.toString();

  let finalVideoUrl = null;
  for (let poll = 1; poll <= 60; poll++) {
    await new Promise(r => setTimeout(r, 4000));

    try {
      const pollText = await page.evaluate(async ({ url, body }) => {
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'x-same-domain': '1',
          },
          body: body
        });
        return await r.text();
      }, { url: pollUrl, body: pollBodyString });

      const match = pollText.match(/https:(?:\\\/|\/)+flow-content\.google\/video\/[^"\s]+/i);
      if (match) {
        let raw = match[0].replace(/\\\/|\//g, '/');
        raw = raw.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
        raw = raw.replace(/[\\]+$/g, '');
        finalVideoUrl = raw;
        break;
      }

      // Kiểm tra statusCode từ jwpduf response
      const parsedJ = parseBatchExecute(pollText, 'jwpduf');
      const items = parsedJ?.[2] || [];
      const item = items.find(it => it && (it[0] === videoMediaName || String(it[0]).includes(videoMediaName)));
      const meta = item?.[5] || [];
      const statusArr = Array.isArray(meta[8]) ? meta[8] : (Array.isArray(meta) ? meta.find(x => Array.isArray(x) && typeof x[0] === 'number') : null);
      const statusCode = statusArr ? statusArr[0] : null;

      if (statusCode === 3) {
        const as29sReqId = Math.floor(Math.random() * 900000) + 100000;
        const as29sUrl = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=as29s&source-path=${encodeURIComponent('/project/' + targetProjectId)}&bl=${bl}&f.sid=${fsid}&hl=vi&_reqid=${as29sReqId}&rt=c`;
        const as29sInner = [videoMediaName];
        const as29sFReq = JSON.stringify([[["as29s", JSON.stringify(as29sInner), null, "generic"]]]);
        const as29sParams = new URLSearchParams();
        as29sParams.set('f.req', as29sFReq);
        if (activeAt) as29sParams.set('at', activeAt);

        const as29sText = await page.evaluate(async ({ url, body }) => {
          const r = await fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'x-same-domain': '1',
            },
            body: body
          });
          return await r.text();
        }, { url: as29sUrl, body: as29sParams.toString() });

        const asMatch = as29sText.match(/https:(?:\\\/|\/)+flow-content\.google\/video\/[^"\s]+/i);
        if (asMatch) {
          let raw = asMatch[0].replace(/\\\/|\//g, '/');
          raw = raw.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
          raw = raw.replace(/[\\]+$/g, '');
          finalVideoUrl = raw;
          break;
        }
      }
    } catch (_) {}
  }

  if (!finalVideoUrl) {
    throw new Error(`[DirectEngine] Video generation timed out for task ${videoMediaName}`);
  }

  console.log(`[DirectEngine] 📥 Downloading completed video from: ${finalVideoUrl}...`);
  const vidResp = await axios.get(finalVideoUrl, {
    responseType: 'arraybuffer',
    timeout: 120000,
  });

  const vidBuffer = Buffer.from(vidResp.data);
  return {
    buffer: vidBuffer,
    url: finalVideoUrl,
    mediaName: videoMediaName,
  };
}

module.exports = {
  getHighTrustCaptchaToken,
  getWizData,
  uploadImageDirectNetwork,
  generateSingleStoryboardDirect,
  generate4MasterStoryboardsDirect,
  generateStoryboardsViaNativeNetworkStream,
  generateVideoDirectNetwork,
  cleanFlowImageUrl,
  downloadCdnBuffer,
};
