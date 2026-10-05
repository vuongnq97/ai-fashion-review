const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { writeTempFiles } = require('../utils/helpers');
const { getContext, ensureBearerToken, invalidateBearerToken, getRecaptchaToken, extractProjectIdFromPage, PROJECT_ID, PROJECT_URL } = require('./browser');
const { ensureWorkWindow } = require('../utils/window-config');

const httpsInsecureAgent = new https.Agent({ rejectUnauthorized: false });

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

// ═══════════════════════════════════════════════════════════════
// Aspect ratio mapping: user-friendly → API enum & Flow int
// ═══════════════════════════════════════════════════════════════
const ASPECT_RATIO_MAP = {
  '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
  '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
  '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
  '3:4': 'IMAGE_ASPECT_RATIO_PORTRAIT',
  '4:3': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
};

const ASPECT_RATIO_TO_FLOW_INT = {
  '16:9': 1,
  '4:3': 2,
  '1:1': 3,
  '3:4': 4,
  '9:16': 5,
  'IMAGE_ASPECT_RATIO_LANDSCAPE': 1,
  'IMAGE_ASPECT_RATIO_SQUARE': 3,
  'IMAGE_ASPECT_RATIO_PORTRAIT': 5,
};

// Flow image generation model (confirmed from network capture: ogiZ0b API uses GEM_PIX_2)
const FLOW_IMAGE_MODEL = 'GEM_PIX_2';

// ═══════════════════════════════════════════════════════════════
// Model mapping: user-friendly → API model name
// Confirmed via network capture: Nano Banana 2 → GEM_PIX_2
// ═══════════════════════════════════════════════════════════════
const MODEL_MAP = {
  'nano-banana-2': 'GEM_PIX_2',
  'narwhal': 'GEM_PIX_2',
  'gem-pix-2': 'GEM_PIX_2',
  'nano-banana-pro': 'GEM_PIX_2', // video model alias, use image model for storyboard
};

function parseBatchExecute(rawText, rpcId = 'ogiZ0b') {
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

function parseOgiZ0bResponse(rawText) {
  return parseBatchExecute(rawText, 'ogiZ0b');
}

// ═══════════════════════════════════════════════════════════════
// Switch between Image and Video mode via settings popup
// ═══════════════════════════════════════════════════════════════
async function switchToMode(page, targetMode = 'image') {
  // Click the settings trigger button at the bottom bar
  // Find the container that holds the submit button
  const submitBtn = page.locator('button:has(i:text("arrow_forward"))').last();
  await submitBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => { });

  const container = page.locator('div').filter({ has: submitBtn }).last();
  const triggerBtn = container.locator('button[aria-haspopup="menu"]').first();

  if (!(await triggerBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
    console.log(`[Mode] ⚠️ Settings trigger button not found, skipping mode switch`);
    return;
  }

  // Click trigger button and ensure popup opens
  for (let i = 0; i < 3; i++) {
    await triggerBtn.click({ force: true });
    await page.waitForTimeout(1000);
    const anyTab = page.locator('button[role="tab"]').first();
    if (await anyTab.isVisible().catch(() => false)) {
      break;
    }
    console.log(`[Mode] ⚠️ Popup not open yet, retrying click...`);
  }

  // Click the correct tab in the popup
  if (targetMode === 'image') {
    const imageTab = page.locator('button[role="tab"]', { hasText: /Hình ảnh/i }).first();
    if (await imageTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await imageTab.click();
      console.log(`[Mode] ✅ Switched to Image mode`);
      await page.waitForTimeout(800);
    } else {
      console.log(`[Mode] Image tab not found (may already be in image mode)`);
    }
  } else {
    const videoTab = page.locator('button[role="tab"]', { hasText: /Video/i }).first();
    if (await videoTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await videoTab.click();
      console.log(`[Mode] ✅ Switched to Video mode`);
      await page.waitForTimeout(800);
    } else {
      console.log(`[Mode] Video tab not found (may already be in video mode)`);
    }
  }

  // Close the popup
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

// ═══════════════════════════════════════════════════════════════
// Direct API upload (bypasses DOM)
// ═══════════════════════════════════════════════════════════════

/**
 * Upload image via native Flow batchexecute RPC (maseQ).
 * 100% cookie session & WIZ_global_data, no Bearer token needed.
 */
async function uploadImageViaMaseQ(page, buffer, targetProjectId, fileName = 'image.png', mimeType = 'image/png') {
  const imageBase64 = buffer.toString('base64');
  let wiz = null;
  try {
    wiz = await page.evaluate(() => {
      const w = window.WIZ_global_data || {};
      return {
        at: w.SNlM0e || '',
        fsid: w.FdrFJe || '',
        bl: w.cfb2h || 'boq_labs-ai-sandbox-frontend_20260917.00_p0'
      };
    });
  } catch (_) {}

  const effectiveWiz = wiz || {
    bl: 'boq_labs-ai-sandbox-frontend_20260917.00_p0',
    fsid: '',
    at: ''
  };

  let recaptchaToken = '';
  try {
    recaptchaToken = await getRecaptchaToken(page, 'IMAGE_GENERATION');
  } catch (_) {}

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
  const bl = encodeURIComponent(effectiveWiz.bl || 'boq_labs-ai-sandbox-frontend_20260917.00_p0');
  const fsid = encodeURIComponent(effectiveWiz.fsid || '');
  const rpcUrl = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=maseQ&source-path=${encodeURIComponent('/project/' + targetProjectId)}&bl=${bl}&f.sid=${fsid}&hl=vi&_reqid=${reqId}&rt=c`;

  const fReq = JSON.stringify([[["maseQ", JSON.stringify(innerPayload), null, "generic"]]]);
  let activeAt = effectiveWiz.at || await page.evaluate(() => window.WIZ_global_data?.SNlM0e || '').catch(() => '');

  for (let attempt = 1; attempt <= 2; attempt++) {
    const bodyParams = new URLSearchParams();
    bodyParams.set('f.req', fReq);
    if (activeAt) {
      bodyParams.set('at', activeAt);
    }
    const bodyString = bodyParams.toString();

    const respText = await page.evaluate(async ({ url, body }) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'x-same-domain': '1',
        },
        body: body
      });
      return await r.text();
    }, { url: rpcUrl, body: bodyString });

    // Check if Google returned fresh xsrf token in 400 response
    const xsrfMatch = respText.match(/\["xsrf","([^"]+)"/);
    if (xsrfMatch && xsrfMatch[1] && attempt === 1 && (!activeAt || activeAt !== xsrfMatch[1])) {
      console.log(`[UploadDirect] 🔄 Recovered fresh xsrf token from Google response, retrying maseQ...`);
      activeAt = xsrfMatch[1];
      continue;
    }

    const parsedInner = parseBatchExecute(respText, 'maseQ');
    const mediaId = parsedInner?.[0]?.[0];
    if (mediaId) {
      return mediaId;
    }
    if (attempt === 2 || !xsrfMatch) {
      throw new Error(`maseQ did not return mediaId in response: ${respText.substring(0, 300)}`);
    }
  }
}

async function uploadImageDirect(context, bearerToken, buffer, page = null, baseDir = null, customProjectId = null, fileName = 'image.png', mimeType = 'image/png') {
  const targetProjectId = customProjectId || (page ? extractProjectIdFromPage(page) : PROJECT_ID);

  // 1. Ưu tiên cao nhất: upload qua maseQ batchexecute RPC trực tiếp trên browser page của Flow (100% cookie session, không phụ thuộc REST Bearer token)
  if (page && typeof page.evaluate === 'function' && !page.isClosed()) {
    try {
      console.log(`[UploadDirect] 🚀 Uploading image (${(buffer.length / 1024).toFixed(1)} KB, "${fileName}") via maseQ RPC...`);
      const mediaId = await uploadImageViaMaseQ(page, buffer, targetProjectId, fileName, mimeType);
      if (mediaId) {
        console.log(`[UploadDirect] ✅ maseQ direct upload success: ${mediaId}`);
        return mediaId;
      }
    } catch (maseQErr) {
      console.warn(`[UploadDirect] ⚠️ maseQ upload failed: ${maseQErr.message}. Trying REST API fallback...`);
    }
  }

  // 2. Fallback: REST API upload (nếu có bearerToken)
  if (!bearerToken) {
    throw new Error('[UploadDirect] Cannot fallback to REST upload without Bearer token and maseQ failed');
  }

  const imageBase64 = buffer.toString('base64');
  const apiUrl = 'https://aisandbox-pa.googleapis.com/v1/flow/uploadImage';
  const requestBody = {
    clientContext: {
      projectId: targetProjectId,
      tool: 'PINHOLE'
    },
    imageBytes: imageBase64
  };

  console.log('[UploadDirect] Sending POST to uploadImage API...');
  const response = await context.request.fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'Authorization': `Bearer ${bearerToken}`,
      'Origin': 'https://labs.google',
      'Referer': 'https://labs.google/',
      'x-browser-channel': 'stable',
    },
    data: JSON.stringify(requestBody),
    timeout: 60000 // 60s
  });

  const status = response.status();
  const bodyText = await response.text();
  if (status !== 200) {
    if (status === 401) {
      console.warn('[UploadDirect] ⚠️ 401 Unauthorized detected — invalidating cached Bearer token.');
      invalidateBearerToken(bearerToken);
      const target = page || context;
      if (target) {
        try {
          console.log('[UploadDirect] 🔄 Requesting fresh Bearer token after 401...');
          const freshToken = await ensureBearerToken(target, true);
          if (freshToken && freshToken !== bearerToken) {
            console.log('[UploadDirect] 🔄 Retrying direct upload with refreshed Bearer token...');
            return await uploadImageDirect(context, freshToken, buffer, null, baseDir, customProjectId, fileName, mimeType);
          }
        } catch (refreshErr) {
          console.warn(`[UploadDirect] Token refresh retry failed: ${refreshErr.message}`);
        }
      }
    }
    throw new Error(`[UploadDirect] API returned HTTP ${status}: ${bodyText.substring(0, 500)}`);
  }

  const result = JSON.parse(bodyText);
  const mediaId = result.media?.name;
  if (!mediaId) {
    throw new Error('[UploadDirect] API response did not contain media.name');
  }

  return mediaId;
}

// ═══════════════════════════════════════════════════════════════
// Upload images via file input (simplest reliable method)
// Returns after upload completes in the project gallery
// ═══════════════════════════════════════════════════════════════
async function uploadImages(page, filePayloads, baseDir) {
  if (!filePayloads || filePayloads.length === 0) return [];

  console.log(`[Gen] Uploading ${filePayloads.length} image(s) via file input...`);
  const tempFilePaths = writeTempFiles(filePayloads, baseDir);

  let fileInput = page.locator('input[type="file"]');
  const inputCount = await fileInput.count().catch(() => 0);
  if (inputCount === 0) {
    const addBtn = page.locator('button').filter({ hasText: /^add$/i }).first();
    if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await addBtn.click();
      await page.waitForTimeout(1000);
      const uploadBtn = page.locator('button').filter({ hasText: /Tải lên|Upload/i }).first();
      if (await uploadBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        try {
          const [fileChooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 8000 }),
            uploadBtn.click()
          ]);
          await fileChooser.setFiles(tempFilePaths);
        } catch (_) {}
      }
    }
  }

  try {
    await page.locator('input[type="file"]').first().setInputFiles(tempFilePaths, { timeout: 10000 });
  } catch (_) {}

  await page.waitForTimeout(4000);

  // Wait for upload spinners/placeholders to disappear
  for (let wait = 0; wait < 30; wait++) {
    const hasIndicator = await page.evaluate(() => {
      const spinners = document.querySelectorAll('[role="progressbar"], mat-progress-spinner');
      if (spinners.length > 0) return true;

      const cells = Array.from(document.querySelectorAll('[data-tile-id]'));
      const hasText = cells.some(cell => {
        const text = (cell.innerText || '').toLowerCase();
        return text.includes('đang tải') || text.includes('tải lên') || text.includes('uploading') || text.includes('%');
      });
      if (hasText) return true;

      const imgs = Array.from(document.querySelectorAll('[data-tile-id] img'));
      const hasPlaceholder = imgs.some(img => {
        return img.style.opacity === '0' || window.getComputedStyle(img).opacity === '0';
      });
      if (hasPlaceholder) return true;

      return false;
    });
    if (!hasIndicator) break;
    if (wait === 29) console.log(`[Gen]   Warning: Upload indicators did not disappear after 30s.`);
    await page.waitForTimeout(1000);
  }

  await page.waitForTimeout(2000);
  console.log(`[Gen] ✅ Upload complete.`);
  return tempFilePaths;
}

// ═══════════════════════════════════════════════════════════════
// Find image UUID by name in the project gallery
// ═══════════════════════════════════════════════════════════════
async function findImageUUID(page, searchTerm, mode = 'image') {
  console.log(`[Gen] Looking up UUID for "${searchTerm}"...`);

  // Open the picker
  let addBtn;
  if (mode === 'video') {
    addBtn = page.locator('div[aria-haspopup="dialog"]:text("Bắt đầu")');
  } else {
    addBtn = page.locator('button:has(i:text("add_2"))');
  }

  await addBtn.waitFor({ state: 'visible', timeout: 10000 });
  await addBtn.click();
  await page.waitForTimeout(2000);

  // Set filter to "Mới nhất"
  const filterBtn = page.locator('[role="dialog"] button', { hasText: /Gần đây|Mới nhất|Cũ nhất|Dùng nhiều nhất|Yêu thích/i }).first();
  if (await filterBtn.isVisible().catch(() => false)) {
    const currentText = await filterBtn.innerText();
    if (!currentText.includes('Mới nhất')) {
      await filterBtn.click();
      await page.waitForTimeout(500);
      const newestOption = page.locator('text="Mới nhất"').last();
      if (await newestOption.isVisible().catch(() => false)) {
        await newestOption.click();
        await page.waitForTimeout(1500);
      } else {
        await page.keyboard.press('Escape');
      }
    }
  }

  // Wait for placeholders to finish
  for (let wait = 0; wait < 20; wait++) {
    const hasSpinner = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return true;
      const spinners = dialog.querySelectorAll('[role="progressbar"]');
      if (spinners.length > 0) return true;
      const imgs = Array.from(dialog.querySelectorAll('img'));
      return imgs.some(img => img.style.opacity === '0' || window.getComputedStyle(img).opacity === '0');
    });
    if (!hasSpinner) break;
    await page.waitForTimeout(1000);
  }

  // Search for the image by name
  const nameWithoutExt = searchTerm.replace(/\.[^/.]+$/, '');
  const PICKER = '[data-testid="virtuoso-scroller"]';
  let uuid = null;

  const searchInput = page.locator('input[placeholder*="Tìm kiếm"]').first();
  if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await searchInput.click();
    await searchInput.fill(nameWithoutExt);
    await page.waitForTimeout(1500);

    // Extract UUID from the matched row's image src
    uuid = await page.evaluate(({ picker, term }) => {
      const rows = document.querySelectorAll(`${picker} [data-index]`);
      for (const row of rows) {
        const img = row.querySelector(`img[alt*="${term}" i]`);
        if (img && img.src) {
          try {
            const url = new URL(img.src, window.location.origin);
            return url.searchParams.get('name') || null;
          } catch (e) { }
        }
      }
      return null;
    }, { picker: PICKER, term: nameWithoutExt });

    await searchInput.fill('').catch(() => { });
  }

  // Close picker
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  if (uuid) {
    console.log(`[Gen] ✅ Found UUID for "${searchTerm}": ${uuid}`);
  } else {
    console.log(`[Gen] ⚠️ Could not find UUID for "${searchTerm}"`);
  }
  return uuid;
}

// ═══════════════════════════════════════════════════════════════
// PHASE 1: Setup (needs browser page lock)
// Navigate, upload, resolve UUIDs, get tokens
// ═══════════════════════════════════════════════════════════════
async function prepareGeneration(page, prompt, filePayloads, config, baseDir) {
  const {
    imageModel = 'nano-banana-2',
    aspectRatio = '9:16',
    outputCount = 1,
  } = config;

  const context = getContext();
  if (!context) throw new Error('[Gen] Browser context not available');

  console.log(`[Gen] model=${imageModel} ratio=${aspectRatio} outputs=${outputCount}`);

  console.log('[Gen] Step 1: Getting Bearer token (optional for RPC)...');
  let bearerToken = null;
  try {
    bearerToken = await ensureBearerToken(page, false, { optional: true, quick: true });
  } catch (tErr) {
    console.warn(`[Gen] ⚠️ Bearer token capture note: ${tErr.message} (will proceed with native RPC)`);
  }

  const targetProjectId = config?.projectId || (page ? extractProjectIdFromPage(page) : PROJECT_ID);

  let imageInputUUIDs = [];
  if (filePayloads && filePayloads.length > 0) {
    console.log(`[Gen] Step 2: Uploading ${filePayloads.length} image(s) directly via API (project: ${targetProjectId})...`);
    try {
      for (const fp of filePayloads) {
        const uuid = await uploadImageDirect(context, bearerToken, fp.buffer, page, baseDir, targetProjectId, fp.name || 'image.png', fp.mimeType || 'image/png');
        console.log(`[Gen]   Uploaded: ${fp.name} -> ${uuid}`);
        imageInputUUIDs.push(uuid);
      }
    } catch (uploadErr) {
      console.warn(`[Gen] ⚠️ Direct API upload failed: ${uploadErr.message}. Falling back to DOM upload...`);
      imageInputUUIDs = [];
      await uploadImages(page, filePayloads, baseDir);
      for (const fp of filePayloads) {
        const uuid = await findImageUUID(page, fp.name);
        if (uuid) {
          imageInputUUIDs.push(uuid);
        } else {
          throw new Error(`[Gen] Failed to resolve UUID for uploaded image "${fp.name}" after DOM upload`);
        }
      }
    }
  } else if (config.imageSelection && config.imageSelection.length > 0) {
    console.log(`[Gen] Step 3: Resolving ${config.imageSelection.length} image reference(s)...`);
    for (const sel of config.imageSelection) {
      if (sel.startsWith('name:')) {
        const name = sel.split('name:')[1];
        const uuid = await findImageUUID(page, name);
        if (uuid) imageInputUUIDs.push(uuid);
        else console.log(`[Gen] ⚠️ Skipping unresolved: "${sel}"`);
      } else if (sel.startsWith('uuid:')) {
        imageInputUUIDs.push(sel.split('uuid:')[1]);
      }
    }
    console.log(`[Gen] Resolved ${imageInputUUIDs.length} UUID(s): ${imageInputUUIDs.join(', ')}`);
  }

  console.log('[Gen] Step 4: Getting reCAPTCHA tokens...');
  const reqCount = Number(outputCount) > 1 ? Number(outputCount) : 1;
  const recaptchaTokens = [];
  const maxAttempts = reqCount * 3;
  for (let i = 0; i < maxAttempts && recaptchaTokens.length < reqCount; i++) {
    try {
      const tok = await getRecaptchaToken(page, 'IMAGE_GENERATION');
      if (tok && !recaptchaTokens.includes(tok)) {
        recaptchaTokens.push(tok);
      }
      if (recaptchaTokens.length < reqCount) {
        await page.waitForTimeout(600);
      }
    } catch (err) {
      console.warn(`[Gen] Error getting reCAPTCHA token: ${err.message}`);
    }
  }

  const recaptchaToken = recaptchaTokens[0];
  console.log(`[Gen]   reCAPTCHA: ${recaptchaToken ? recaptchaToken.substring(0, 30) : 'none'}... (${recaptchaToken ? recaptchaToken.length : 0} chars, unique tokens: ${recaptchaTokens.length}/${reqCount})`);

  const wiz = await page.evaluate(() => {
    const w = window.WIZ_global_data || {};
    return {
      at: w.SNlM0e || '',
      fsid: w.FdrFJe || '',
      bl: w.cfb2h || 'boq_labs-ai-sandbox-frontend_20260917.00_p0',
      projectId: w.PROJECT_ID || ''
    };
  }).catch(() => null);

  console.log(`[Gen] ✅ Setup complete — releasing browser lock.`);

  // Dùng UI path để có reCAPTCHA score tốt (chống UNUSUAL_ACTIVITY).
  // ogiZ0b route interceptor sẽ inject đúng imageInputUUIDs vào payload trước khi gửi lên Flow backend.
  // KHÔNG skip UI path dù có imageInputUUIDs — reCAPTCHA từ UI submission mới đáng tin cậy.
  return { context, bearerToken, recaptchaToken, recaptchaTokens, imageInputUUIDs, prompt, aspectRatio, imageModel, outputCount: reqCount, projectId: targetProjectId, wiz, page, filePayloads };
}

function cleanFlowImageUrl(rawUrl) {
  if (!rawUrl) return '';
  let url = rawUrl.replace(/\\\/|\//g, '/');
  url = url.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
  url = url.replace(/\\/g, '');
  url = url.replace(/["\s]+$/, '');
  return url;
}

// ═══════════════════════════════════════════════════════════════
// UI-based Generation (100% human trust, avoids bot detection)
// ═══════════════════════════════════════════════════════════════
async function generateImagesViaUI({ page, context, prompt, outputCount = 1, aspectRatio = '16:9', imageInputUUIDs = [], filePayloads = [] }) {
  if (!page || page.isClosed()) return null;

  try {
    console.log(`[Gen-UI] 🚀 Triggering generation directly via Flow UI (natural human events)...`);
    const count = Number(outputCount) > 1 ? Number(outputCount) : 1;

    // 0. Ensure ample viewport and clean popups
    // Phóng to cửa sổ thật (không giả lập viewport) để Flow hiển thị đầy đủ UI, không bị cắt composer
    await ensureWorkWindow(page, { minW: 1280, minH: 800 });
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);

    // 1. Setup response listener for ogiZ0b (Flow batchexecute RPC containing newly generated images)
    let signedUrls = [];
    let rpcResponsePromise = new Promise((resolve) => {
      const onResponse = async (res) => {
        const url = res.url();
        // Strictly listen to ogiZ0b RPC responses (NOT GET requests for existing flow-content images)
        if (url.includes('ogiZ0b')) {
          try {
            const text = await res.text().catch(() => '');
            if (text.includes('flow-content.google/image')) {
              const matches = [...text.matchAll(/https:(?:\\\/|\/)+flow-content\.google\/image\/[^"\s]+/g)];
              const extracted = matches.map(m => cleanFlowImageUrl(m[0])).filter(Boolean);
              for (const u of extracted) {
                if (!signedUrls.includes(u)) signedUrls.push(u);
              }
              console.log(`[Gen-UI] 📦 Extracted ${extracted.length} new image URL(s) from ogiZ0b response (total: ${signedUrls.length}/${count})`);
              if (signedUrls.length >= count) {
                page.off('response', onResponse);
                resolve(signedUrls);
              }
            }
          } catch (_) {}
        }
      };
      page.on('response', onResponse);
      setTimeout(() => {
        page.off('response', onResponse);
        resolve(signedUrls);
      }, 60000);
    });

    // 1b. Route interceptor: patch aspectInt AND inject correct imageInputUUIDs in ogiZ0b payload.
    //     This ensures that even if the UI attached the wrong asset (e.g. old image from a previous
    //     session), the RPC payload is corrected before Angular sends it to Flow's backend.
    const targetAspectInt = ASPECT_RATIO_TO_FLOW_INT[aspectRatio] || 2;
    const ogiZ0bHandler = async (route) => {
      try {
        const postData = route.request().postData() || '';
        const params = new URLSearchParams(postData);
        const fReqStr = params.get('f.req');
        if (fReqStr) {
          // outer = [[["ogiZ0b", "<inner json>", null, "generic"]]]
          const outer = JSON.parse(fReqStr);
          const innerStr = outer?.[0]?.[0]?.[1];
          if (innerStr) {
            const inner = JSON.parse(innerStr);
            let patched = false;

            // 🔍 LOG FULL inner[1][0] structure to debug field positions
            if (inner?.[1]?.[0]) {
              const item0 = inner[1][0];
              console.log(`[Gen-UI] 📦 ogiZ0b inner[1][0] length=${item0.length}: ` +
                item0.map((v, i) => `[${i}]=${v === null ? 'null' : Array.isArray(v) ? 'Array(' + v.length + ')' : JSON.stringify(v).substring(0, 40)}`).join(' | '));
            }

            // Log natural aspectInt from UI
            if (inner?.[1]?.[0] && inner[1][0][4] !== undefined) {
              console.log(`[Gen-UI] ℹ️ ogiZ0b natural aspectInt: ${inner[1][0][4]} (requested: ${aspectRatio})`);
            }

            // Inject correct image UUIDs: inner[1][i][2] = [[uuid, null, null, null, 1], ...]
            // MUST iterate all candidate items in inner[1] so all 4 parallel candidates get the reference image
            if (imageInputUUIDs && imageInputUUIDs.length > 0 && Array.isArray(inner?.[1])) {
              const expectedRef = imageInputUUIDs.map(id => [id, null, null, null, 1]);
              const expectedIds = imageInputUUIDs;

              inner[1].forEach((item, idx) => {
                if (Array.isArray(item)) {
                  const currentRef = item[2];
                  const currentIds = Array.isArray(currentRef) ? currentRef.map(r => r?.[0]).filter(Boolean) : [];
                  const mismatch = currentIds.length !== expectedIds.length || expectedIds.some((id, i) => currentIds[i] !== id);
                  if (mismatch || !currentRef) {
                    const prevIds = JSON.stringify(currentIds);
                    item[2] = expectedRef;
                    console.log(`[Gen-UI] 🔧 ogiZ0b injected imageUUIDs at [1][${idx}][2]: [${prevIds}]→[${JSON.stringify(expectedIds)}]`);
                    patched = true;
                  } else {
                    console.log(`[Gen-UI] ✅ ogiZ0b imageUUIDs already correct at [1][${idx}][2]: ${JSON.stringify(currentIds)}`);
                  }
                }
              });
            }

            if (patched) {
              outer[0][0][1] = JSON.stringify(inner);
              params.set('f.req', JSON.stringify(outer));
              await route.continue({ postData: params.toString() });
              return;
            }
          }
        }
      } catch (err) {
        console.warn(`[Gen-UI] ⚠️ ogiZ0b intercept error: ${err.message}`);
      }
      await route.continue();
    };
    await page.route('**ogiZ0b**', ogiZ0bHandler).catch(() => {});

    // 2. Open settings and configure mode, ratio, and count

    console.log('[Gen-UI] ⚙️ Checking image settings in Flow UI...');
    const settingsBtn = page.locator('button.settings-trigger-button, button[aria-label="Điều kiện kích hoạt cài đặt"], button[aria-label="Settings trigger"], button:has-text("Nano Banana"), button:has-text("Video ·"), button:has-text("Hình ảnh ·")').first();
    if (await settingsBtn.isVisible().catch(() => false)) {
      await settingsBtn.click({ force: true, timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);

      // Select Hình ảnh (Image)
      const imgToggle = page.locator('mat-button-toggle:has-text("Hình ảnh") button, mat-button-toggle:has-text("Image") button, button:has-text("Hình ảnh"), button:has-text("Image")').first();
      if (await imgToggle.isVisible().catch(() => false)) {
        await imgToggle.click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
      }

      // Select ratio (16:9 or 9:16)
      const ratioLabel = aspectRatio === '9:16' ? '9:16' : '16:9';
      let ratioClicked = false;
      const ratioBtn = page.locator(`mat-button-toggle:has-text("${ratioLabel}") button, button:text-is("${ratioLabel}")`).first();
      if (await ratioBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await ratioBtn.click({ force: true }).catch(() => {});
        ratioClicked = true;
        await page.waitForTimeout(300);
      }
      if (!ratioClicked) {
        ratioClicked = await page.evaluate((label) => {
          const elements = Array.from(document.querySelectorAll('button, mat-button-toggle, [role="radio"]'));
          for (const el of elements) {
            const txt = (el.textContent || '').trim();
            if (txt === label || txt.includes(label)) {
              (el.querySelector('button') || el).click();
              return true;
            }
          }
          return false;
        }, ratioLabel).catch(() => false);
        if (ratioClicked) await page.waitForTimeout(300);
      }
      console.log(`[Gen-UI] 📐 Selected ratio ${ratioLabel} (clicked: ${ratioClicked})`);

      // Select count (x1, x2, x3, x4)
      const countLabel = `x${Math.min(Math.max(count, 1), 4)}`;
      let countClicked = false;
      const countBtn = page.locator(`mat-button-toggle:has-text("${countLabel}") button, button:text-is("${countLabel}")`).first();
      if (await countBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await countBtn.click({ force: true }).catch(() => {});
        countClicked = true;
        await page.waitForTimeout(300);
      }
      if (!countClicked) {
        countClicked = await page.evaluate((label) => {
          const elements = Array.from(document.querySelectorAll('button, mat-button-toggle, [role="radio"]'));
          for (const el of elements) {
            const txt = (el.textContent || '').trim();
            if (txt === label) {
              (el.querySelector('button') || el).click();
              return true;
            }
          }
          return false;
        }, countLabel).catch(() => false);
        if (countClicked) await page.waitForTimeout(300);
      }

      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(400);

      // Verify trigger button text
      const newSettingsText = await settingsBtn.textContent().catch(() => '');
      console.log(`[Gen-UI] 🔍 Settings button after config: "${(newSettingsText || '').trim().substring(0, 60)}"`);
    }

    // 3. Attach reference image — MUST be the correct image (no silent wrong-asset fallback)
    const hasFilesToAttach = (filePayloads && filePayloads.length > 0) || (imageInputUUIDs && imageInputUUIDs.length > 0);
    if (hasFilesToAttach) {
      console.log('[Gen-UI] 🖼️ Attaching reference image in Flow UI...');
      const targetUUID = imageInputUUIDs[0] || null;
      const refFile = filePayloads?.[0] || null;

      const addBtn = page.locator('button[aria-label="Thêm thành phần vào ô nhập câu lệnh"], button[aria-label="Add components to prompt input"]').first();
      if (await addBtn.isVisible().catch(() => false)) {
        await addBtn.click({ force: true, timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(600);

        // Wait for asset panel to appear
        await page.waitForSelector(
          '.asset-item-container, flow-add-menu-asset-list img, [role="listbox"] img',
          { timeout: 5000 }
        ).catch(() => {});
        await page.waitForTimeout(400);

        // Match asset in DOM: by UUID in outerHTML, by filename, or pick top item
        const searchName = refFile?.name || 'input.png';
        const attachResult = await page.evaluate(({ uuid, name }) => {
          const containers = document.querySelectorAll(
            '.asset-item-container, flow-add-menu-asset-list .asset-item, [role="listbox"] [role="option"]'
          );
          if (!containers || containers.length === 0) return null;

          // 1. Try matching uuid in outerHTML if present
          if (uuid) {
            for (const el of containers) {
              if (el.outerHTML.includes(uuid)) {
                (el.querySelector('img') || el.querySelector('button') || el).click();
                return 'matched-uuid';
              }
            }
          }

          // 2. Try matching file name in text
          if (name) {
            const cleanName = name.toLowerCase().replace(/\.[^.]+$/, '');
            for (const el of containers) {
              const txt = (el.innerText || '').toLowerCase();
              if (txt.includes(name.toLowerCase()) || txt.includes(cleanName)) {
                (el.querySelector('img') || el.querySelector('button') || el).click();
                return 'matched-name';
              }
            }
          }

          // 3. Fallback: newly uploaded asset is always the first item in the list
          const first = containers[0];
          (first.querySelector('img') || first.querySelector('button') || first).click();
          return 'first-item';
        }, { uuid: targetUUID, name: searchName }).catch(() => null);

        if (attachResult) {
          console.log(`[Gen-UI] ✅ Attached reference image (${attachResult}, UUID: ${targetUUID})`);
        } else {
          console.log(`[Gen-UI] ℹ️ Closed asset panel; route interceptor will inject UUID: ${targetUUID}`);
        }
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(600);
      }
    }

    // 4. Enter prompt and submit
    console.log('[Gen-UI] ✍️ Typing image prompt in ProseMirror...');
    const promptEditorResult = await page.evaluate(async (promptText) => {
      const isVisible = (el) => {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        return r.width > 40 && r.height > 15 && r.bottom > 0 && r.top < window.innerHeight;
      };

      const candidates = Array.from(document.querySelectorAll(
        '.ProseMirror, [data-slate-editor="true"], [contenteditable="true"], textarea'
      )).filter(isVisible).filter(el => {
        if (el.closest('header, [role="banner"], flow-app-bar, flow-header, nav, .header')) return false; // Exclude top project header / title
        const ph = (el.getAttribute('placeholder') || '').toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        if (ph.includes('search') || ph.includes('tìm') || aria.includes('search') || aria.includes('tìm')) return false;
        return true;
      });

      if (candidates.length === 0) return { found: false };

      // Closest to bottom of viewport = composer
      candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      const editor = candidates[0];

      editor.focus();

      // Clear content
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete', false);
      } catch (_) {}

      // Insert text via execCommand
      try {
        document.execCommand('insertText', false, promptText);
      } catch (_) {}

      // Trigger events for Angular / ProseMirror
      editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

      const text = editor.innerText || editor.textContent || editor.value || '';
      return {
        found: true,
        textLength: text.length,
        textSnippet: text.substring(0, 50),
        top: editor.getBoundingClientRect().top
      };
    }, prompt).catch(() => ({ found: false }));

    console.log(`[Gen-UI] ✍️ DOM prompt insertion: found=${promptEditorResult?.found}, len=${promptEditorResult?.textLength || 0}, snippet="${promptEditorResult?.textSnippet || ''}"`);

    // Fallback via Playwright locator if text didn't stick
    const editorLocator = page.locator('.ProseMirror, [contenteditable="true"]').filter({
      hasNot: page.locator('input[placeholder*="search" i]')
    }).last();

    if (await editorLocator.isVisible().catch(() => false)) {
      if (!promptEditorResult?.textLength || promptEditorResult.textLength < 10) {
        await editorLocator.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(200);
        await page.keyboard.press('Meta+A').catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await page.waitForTimeout(100);
        try {
          await page.keyboard.insertText(prompt);
        } catch (_) {
          try { await page.keyboard.type(prompt); } catch (__) {}
        }
        await page.waitForTimeout(400);
      }
    }

    // 5. Submit
    console.log('[Gen-UI] 🚀 Submitting image generation...');
    let submitClicked = false;
    for (let c = 0; c < 16; c++) {
      const status = await page.evaluate(() => {
        const isVisible = (el) => {
          if (!el || !el.isConnected) return false;
          const style = window.getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
          const r = el.getBoundingClientRect();
          return r.width >= 16 && r.height >= 16 && r.bottom > 0 && r.top < window.innerHeight;
        };
        const isEnabled = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.classList.contains('disabled');

        // Only search buttons in composer area (not in top header/nav)
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
          .filter(isVisible)
          .filter(b => !b.closest('header, [role="banner"], flow-app-bar, flow-header, nav, .header'));

        // 1. Arrow forward button
        for (const b of buttons) {
          const icon = b.querySelector('.google-symbols, mat-icon, i, span');
          const iconText = (icon?.textContent || '').trim().toLowerCase();
          const bText = (b.textContent || '').trim().toLowerCase();
          if (iconText === 'arrow_forward' || bText === 'arrow_forward' || bText.includes('arrow_forward')) {
            if (isEnabled(b)) {
              b.click();
              return { found: true, enabled: true, clicked: true, type: 'arrow_forward' };
            }
            return { found: true, enabled: false, clicked: false, type: 'arrow_forward' };
          }
        }

        // 2. Specific aria-label submit buttons (exact or tight match)
        for (const b of buttons) {
          const aria = (b.getAttribute('aria-label') || '').toLowerCase().trim();
          if (aria === 'bắt đầu tạo' || aria === 'generate' || aria === 'tạo hình ảnh' || aria === 'gửi' || aria === 'tạo') {
            if (isEnabled(b)) {
              b.click();
              return { found: true, enabled: true, clicked: true, type: `aria:${aria}` };
            }
            return { found: true, enabled: false, clicked: false, type: `aria:${aria}` };
          }
        }

        return { found: false };
      }).catch(() => ({ found: false }));

      if (status.clicked) {
        submitClicked = true;
        console.log(`[Gen-UI] ✅ Submit button clicked via DOM eval (${status.type})!`);
        break;
      }

      if (status.found && !status.enabled) {
        await page.waitForTimeout(500);
        continue;
      }

      await page.waitForTimeout(500);
    }

    if (!submitClicked) {
      const arrowLoc = page.locator('button:has(.google-symbols:has-text("arrow_forward")), button:has(i:has-text("arrow_forward")), button[aria-label="Bắt đầu tạo"], button.generate-icon-button').last();
      if (await arrowLoc.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('[Gen-UI] 🖱️ Attempting locator click on arrow submit button...');
        await arrowLoc.click({ force: true, timeout: 3000 }).catch(() => {});
        submitClicked = true;
      }
    }

    // Universal Flow submit shortcut: focus editor and press Enter
    console.log('[Gen-UI] ⌨️ Pressing Enter on composer editor to trigger submission...');
    await page.evaluate(() => {
      const editors = Array.from(document.querySelectorAll('.ProseMirror, [contenteditable="true"], textarea'))
        .filter(el => !el.closest('header, [role="banner"], flow-app-bar, flow-header, nav, .header'))
        .filter(el => {
          const ph = (el.getAttribute('placeholder') || '').toLowerCase();
          return !ph.includes('search') && !ph.includes('tìm');
        });
      if (editors.length > 0) {
        editors.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
        editors[0].focus();
      }
    }).catch(() => {});
    await page.waitForTimeout(100);
    await page.keyboard.press('Enter').catch(() => {});

    console.log('[Gen-UI] ⏳ Submitted prompt in Flow UI! Waiting for images...');

    // 6. Wait for signedUrls from network OR poll DOM
    let urls = await rpcResponsePromise;

    // Fallback: poll DOM for flow-image-tile images if network missed some
    if (!urls || urls.length < count) {
      console.log(`[Gen-UI] Polling DOM for generated images (currently have ${urls?.length || 0}/${count})...`);
      for (let p = 0; p < 15; p++) {
        await page.waitForTimeout(2000);
        const domUrls = await page.evaluate(() => {
          const tiles = document.querySelectorAll('flow-image-tile img[src*="flow-content.google/image"]');
          return Array.from(tiles).slice(0, 8).map(img => img.src);
        }).catch(() => []);
        for (const du of domUrls) {
          const cleaned = cleanFlowImageUrl(du);
          if (cleaned && !signedUrls.includes(cleaned)) {
            signedUrls.push(cleaned);
          }
        }
        if (signedUrls.length >= count) {
          urls = signedUrls;
          break;
        }
      }
    }

    urls = signedUrls;
    if (!urls || urls.length === 0) {
      throw new Error('Timeout waiting for Flow UI image generation response (60s limit)');
    }

    console.log(`[Gen-UI] 🎉 Captured ${urls.length} image URL(s) from UI generation!`);
    const results = [];
    for (let i = 0; i < urls.length; i++) {
      const u = urls[i];
      try {
        const buf = await downloadCdnBuffer(u, 60000);
        if (buf && buf.length > 0) {
          results.push({
            base64: buf.toString('base64'),
            buffer: buf,
            mimeType: 'image/png',
            imageName: u.match(/image\/([0-9a-f-]+)/i)?.[1] || `image_${i + 1}`,
            signedUrl: u
          });
        }
      } catch (fErr) {
        console.warn(`[Gen-UI] ⚠️ Failed downloading candidate #${i + 1}: ${fErr.message}`);
      }
    }

    if (results.length > 0) {
      console.log(`[Gen-UI] ✅ Successfully downloaded ${results.length} candidate(s)!`);
      return {
        base64: results[0].base64,
        buffer: results[0].buffer,
        mimeType: results[0].mimeType,
        imageName: results[0].imageName,
        allResults: results
      };
    }
    return null;
  } catch (err) {
    console.warn(`[Gen-UI] ⚠️ UI generation encountered error: ${err.message}. Falling back to API...`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// PHASE 2: Execute API call (Flow ogiZ0b batchexecute RPC)
// ═══════════════════════════════════════════════════════════════
async function executeGeneration({
  context,
  bearerToken,
  recaptchaToken,
  recaptchaTokens,
  imageInputUUIDs = [],
  prompt,
  aspectRatio = '9:16',
  imageModel = 'nano-banana-2',
  outputCount = 1,
  projectId = null,
  wiz = null,
  page = null,
  filePayloads = [],
  skipUi = false,  // When true: skip UI button-click path but keep page for page.evaluate() fetch
}) {
  const targetProjectId = projectId || wiz?.projectId || PROJECT_ID;
  const count = Number(outputCount) > 1 ? Number(outputCount) : 1;

  // 1. UI path: uses human-like UI interaction (buttons, reCAPTCHA) but may apply wrong ratio.
  //    Skip when skipUi=true — caller will rely on page.evaluate() fetch with explicit payload.
  if (!skipUi && page && !page.isClosed()) {
    try {
      const uiResult = await generateImagesViaUI({
        page,
        context,
        prompt,
        outputCount: count,
        aspectRatio,
        imageInputUUIDs,
        filePayloads
      });
      if (uiResult && uiResult.allResults && uiResult.allResults.length > 0) {
        console.log(`[Gen] ✅ UI-based generation successful! Generated ${uiResult.allResults.length} image(s).`);
        return uiResult;
      }
    } catch (uiErr) {
      console.warn(`[Gen] UI generation fallback to direct RPC: ${uiErr.message}`);
    }
  }

  console.log(`[Gen] Step 5: Calling Flow ogiZ0b batchexecute (outputCount=${count}, project: ${targetProjectId})...`);

  const aspectInt = ASPECT_RATIO_TO_FLOW_INT[aspectRatio] || 2;
  const batchGuid = crypto.randomUUID().toUpperCase();

  let effectiveWiz = wiz;
  if (!effectiveWiz && page && !page.isClosed()) {
    try {
      effectiveWiz = await page.evaluate(() => {
        const w = window.WIZ_global_data || {};
        return {
          at: w.SNlM0e || '',
          fsid: w.FdrFJe || '',
          bl: w.cfb2h || 'boq_labs-ai-sandbox-frontend_20260917.00_p0',
          projectId: w.PROJECT_ID || ''
        };
      });
    } catch (_) {}
  }
  if (!effectiveWiz) {
    effectiveWiz = {
      bl: 'boq_labs-ai-sandbox-frontend_20260917.00_p0',
      fsid: '',
      at: '',
      projectId: targetProjectId
    };
  }

  // Mỗi slot song song cần token riêng
  const tokens = (Array.isArray(recaptchaTokens) && recaptchaTokens.length >= count)
    ? recaptchaTokens.slice(0, count)
    : (recaptchaTokens || []).concat(Array.from({ length: count - (recaptchaTokens?.length || 0) }, () => recaptchaToken));

  async function generateSingleImage(itemIndex, tokenForCall) {
    const maxRetries = 3;
    let lastError = null;
    let currentToken = tokenForCall;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const seed = Math.floor(Math.random() * 2000000000);
        const guid1 = crypto.randomUUID().toUpperCase();
        const guid2 = crypto.randomUUID().toUpperCase();

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
            currentToken,
            1
          ]
        ];

        // Reference images for ogiZ0b: placed at position [2] of the generation item
        // Format confirmed from Flow UI capture: [[uuid, null, null, null, 1], ...]
        const refImageSpec = (imageInputUUIDs && imageInputUUIDs.length > 0)
          ? imageInputUUIDs.map(id => [id, null, null, null, 1])
          : null;

        const innerObj = [
          null,
          [
            [
              null,
              null,
              refImageSpec,   // [2]: reference image UUIDs (null = text-only)
              seed,
              aspectInt,
              (MODEL_MAP[imageModel] || FLOW_IMAGE_MODEL), // use resolved model from param
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
        const bl = encodeURIComponent(effectiveWiz.bl || 'boq_labs-ai-sandbox-frontend_20260917.00_p0');
        const fsid = encodeURIComponent(effectiveWiz.fsid || '');
        const rpcUrl = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=ogiZ0b&source-path=${encodeURIComponent('/project/' + targetProjectId)}&bl=${bl}&f.sid=${fsid}&hl=en-US&_reqid=${reqId}&rt=c`;

        const fReq = JSON.stringify([[["ogiZ0b", JSON.stringify(innerObj), null, "generic"]]]);
        const bodyParams = new URLSearchParams();
        bodyParams.set('f.req', fReq);
        if (effectiveWiz.at) {
          bodyParams.set('at', effectiveWiz.at);
        }
        const bodyString = bodyParams.toString();

        if (attempt > 1) {
          console.log(`[Gen #${itemIndex}] 🔄 Retrying ogiZ0b API (Attempt ${attempt}/${maxRetries})...`);
        }

        let responseText;
        if (page && !page.isClosed()) {
          responseText = await page.evaluate(async ({ url, body }) => {
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
        } else {
          const resp = await context.request.fetch(rpcUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'origin': 'https://flow.google.com',
              'referer': 'https://flow.google.com/',
              'x-same-domain': '1'
            },
            data: bodyString,
            timeout: 60000
          });
          if (resp.status() !== 200) {
            const t = await resp.text();
            throw new Error(`HTTP ${resp.status}: ${t.substring(0, 300)}`);
          }
          responseText = await resp.text();
        }

        const parsedData = parseOgiZ0bResponse(responseText);
        let signedUrl = parsedData?.[0]?.[0]?.[6]?.[0]?.[13];
        if (!signedUrl && parsedData) {
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
          findImageUrl(parsedData);
        }

        if (!signedUrl) {
          const m = responseText.match(/https:(?:\\\/|\/)+flow-content\.google\/image\/[^"\s]+/i);
          if (m) {
            let raw = m[0].replace(/\\\/|\//g, '/');
            raw = raw.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
            raw = raw.replace(/[\\]+$/g, '');
            signedUrl = raw;
          }
        }

        if (!signedUrl) {
          if (responseText.includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY')) {
            throw new Error('PUBLIC_ERROR_UNUSUAL_ACTIVITY (Google Flow chặn do nghi ngờ bot/reCAPTCHA score thấp - cần nghỉ cooldown)');
          }
          throw new Error(`Could not find image signedUrl in ogiZ0b response: ${responseText.substring(0, 400)}`);
        }

        const generatedName = parsedData?.[0]?.[0]?.[0] || (signedUrl.match(/image\/([0-9a-f-]+)/i)?.[1]) || null;

        // Download image buffer directly from CDN
        let imgBuffer = null;
        for (let imgAttempt = 1; imgAttempt <= 3; imgAttempt++) {
          try {
            imgBuffer = await downloadCdnBuffer(signedUrl, 60000);
            if (imgBuffer && imgBuffer.length > 0) break;
          } catch (fetchErr) {
            if (imgAttempt === 3) throw fetchErr;
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        if (!imgBuffer) {
          throw new Error('Failed to download generated image buffer from signedUrl');
        }

        const resultBase64 = imgBuffer.toString('base64');
        return {
          base64: resultBase64,
          buffer: imgBuffer,
          mimeType: 'image/png',
          imageName: generatedName,
          seed,
          signedUrl
        };
      } catch (err) {
        lastError = err;
        console.warn(`[Gen #${itemIndex}] ⚠️ Attempt ${attempt}/${maxRetries} failed: ${err.message}`);
        if (attempt < maxRetries) {
          if (page && !page.isClosed()) {
            try {
              const freshTok = await getRecaptchaToken(page, 'IMAGE_GENERATION');
              if (freshTok) currentToken = freshTok;
            } catch (_) {}
          }
          const isUnusual = String(err?.message || '').includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY');
          const waitMs = isUnusual ? 15000 : Math.min(2000 * attempt, 8000);
          if (isUnusual) {
            console.log(`[Gen #${itemIndex}] ⏳ Chờ cooldown 15s để giải tỏa rate-limit Google...`);
          }
          await new Promise(r => setTimeout(r, waitMs));
        }
      }
    }

    throw new Error(`[Gen #${itemIndex}] Failed after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
  }

  if (count === 1) {
    const single = await generateSingleImage(1, tokens[0]);
    console.log(`[Gen] ✅ Done! Returning 1 result (Name: ${single.imageName}).`);
    return {
      base64: single.base64,
      buffer: single.buffer,
      mimeType: single.mimeType,
      imageName: single.imageName,
      allResults: [single]
    };
  }

  console.log(`[Gen] 🚀 Generating ${count} image candidates in parallel via Promise.all (staggered 1200ms)...`);
  const parallelTasks = tokens.slice(0, count).map((tok, idx) => {
    return (async () => {
      if (idx > 0) await new Promise(r => setTimeout(r, idx * 1200));
      return generateSingleImage(idx + 1, tok);
    })();
  });
  const settled = await Promise.allSettled(parallelTasks);

  const succeeded = [];
  settled.forEach((res, i) => {
    if (res.status === 'fulfilled' && res.value) {
      succeeded.push(res.value);
    } else {
      console.warn(`[Gen] Candidate #${i + 1} failed: ${res.reason?.message}`);
    }
  });

  if (succeeded.length === 0) {
    throw new Error(`[Gen] All ${count} image generations failed!`);
  }

  console.log(`[Gen] ✅ Successfully generated ${succeeded.length}/${count} parallel image candidates!`);
  return {
    base64: succeeded[0].base64,
    buffer: succeeded[0].buffer,
    mimeType: succeeded[0].mimeType,
    imageName: succeeded[0].imageName,
    allResults: succeeded
  };
}

// Legacy wrapper (backward compat)
async function automateGeneration(page, prompt, filePayloads, config, baseDir) {
  const prepared = await prepareGeneration(page, prompt, filePayloads, config, baseDir);
  return await executeGeneration(prepared);
}

module.exports = {
  automateGeneration,
  prepareGeneration,
  executeGeneration,
  findImageUUID,
  switchToMode,
  uploadImages,
  uploadImageDirect,
  generateImagesViaUI
};
