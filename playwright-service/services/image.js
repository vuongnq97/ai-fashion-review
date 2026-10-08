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
  console.log(`[Mode] 🔄 Requesting mode switch to: "${targetMode}"...`);

  // Direct trigger button locator (strictly targets settings button, never more_vert 3-dots menu)
  let triggerBtn = page.locator('button[aria-label="Điều kiện kích hoạt cài đặt"], button[aria-label="Settings trigger"], button:has-text("Nano Banana"), button:has-text("Video ·"), button:has-text("Hình ảnh")').first();
  if (!(await triggerBtn.isVisible({ timeout: 2500 }).catch(() => false))) {
    // Fallback: Find container holding submit button
    const submitBtn = page.locator('button:has(i:text("arrow_forward")), button:has(mat-icon:has-text("arrow_forward")), button[aria-label*="tạo" i], button[aria-label*="generate" i]').last();
    await submitBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const container = page.locator('div').filter({ has: submitBtn }).last();
    triggerBtn = container.locator('button[aria-haspopup="menu"]').first();
  }

  if (!(await triggerBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
    console.warn(`[Mode] ⚠️ Settings trigger button not found, skipping mode switch`);
    return false;
  }

  // Click trigger button and ensure popup opens (up to 3 tries)
  let popupOpen = false;
  for (let i = 1; i <= 3; i++) {
    const isAlreadyOpen = await page.evaluate(() => {
      const pane = document.querySelector('.cdk-overlay-pane:not([style*="display: none"]), mat-dialog-container, [role="dialog"], [role="menu"]');
      return !!(pane && pane.querySelectorAll('button[role="tab"], [role="tab"], .mat-mdc-tab, mat-button-toggle, button').length > 0);
    }).catch(() => false);

    if (isAlreadyOpen) {
      popupOpen = true;
      break;
    }

    await triggerBtn.click({ force: true }).catch(() => {});
    popupOpen = await page.waitForSelector('.cdk-overlay-pane button[role="tab"], button[role="tab"], [role="tab"], .mat-mdc-tab, mat-button-toggle', { timeout: 2000 })
      .then(() => true)
      .catch(() => false);

    if (popupOpen) {
      await page.waitForTimeout(400);
      break;
    }
    console.log(`[Mode] ⚠️ Popup not open yet on attempt ${i}, retrying click...`);
    await page.waitForTimeout(500);
  }

  if (!popupOpen) {
    console.warn(`[Mode] ⚠️ Could not open settings popup after 3 attempts`);
    return false;
  }

  let switched = false;
  if (targetMode === 'image') {
    const imageTab = page.locator('.cdk-overlay-pane button[role="tab"], button[role="tab"], [role="tab"], .mat-mdc-tab, mat-button-toggle, button', { hasText: /Hình ảnh|Image/i }).first();
    if (await imageTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await imageTab.click({ force: true });
      console.log(`[Mode] ✅ Switched to Image mode via locator`);
      switched = true;
    } else {
      switched = await page.evaluate(() => {
        const tabs = document.querySelectorAll('.cdk-overlay-pane button[role="tab"], button[role="tab"], [role="tab"], .mat-mdc-tab, mat-button-toggle, button');
        for (const t of tabs) {
          const txt = (t.textContent || '').trim().toLowerCase();
          if (txt.includes('hình ảnh') || txt.includes('image')) {
            const btn = t.querySelector('button') || t;
            btn.click();
            return true;
          }
        }
        return false;
      }).catch(() => false);
      if (switched) console.log(`[Mode] ✅ Switched to Image mode via DOM eval`);
    }
  } else {
    const videoTab = page.locator('.cdk-overlay-pane button[role="tab"], button[role="tab"], [role="tab"], .mat-mdc-tab, mat-button-toggle, button', { hasText: /Video/i }).first();
    if (await videoTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await videoTab.click({ force: true });
      console.log(`[Mode] ✅ Switched to Video mode via locator`);
      switched = true;
    } else {
      switched = await page.evaluate(() => {
        const tabs = document.querySelectorAll('.cdk-overlay-pane button[role="tab"], button[role="tab"], [role="tab"], .mat-mdc-tab, mat-button-toggle, button');
        for (const t of tabs) {
          const txt = (t.textContent || '').trim().toLowerCase();
          if (txt === 'video' || txt.startsWith('video') || txt.includes('video')) {
            const btn = t.querySelector('button') || t;
            btn.click();
            return true;
          }
        }
        return false;
      }).catch(() => false);
      if (switched) console.log(`[Mode] ✅ Switched to Video mode via DOM eval`);
    }
  }

  await page.waitForTimeout(600);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);

  // Quick check of resulting button text
  const currentBtnText = await triggerBtn.textContent().catch(() => '');
  console.log(`[Mode] 🔍 Button text after mode switch: "${(currentBtnText || '').trim().substring(0, 35)}"`);
  return switched;
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
    addBtn = page.locator('button').filter({ hasText: /^add$/i }).or(
      page.locator('button:has(i:text("add_2")), button:has(i:text("add")), button:has(.google-symbols:has-text("add")), button[aria-label*="thêm" i]')
    ).last();
  }

  const isAddVisible = await addBtn.isVisible({ timeout: 3000 }).catch(() => false);
  if (!isAddVisible) {
    console.warn(`[Gen] ⚠️ Add button for gallery picker not visible, skipping UUID lookup for "${searchTerm}"`);
    return null;
  }
  await addBtn.click({ force: true }).catch(() => {});
  await page.waitForTimeout(1500);

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
      console.warn(`[Gen] ⚠️ Direct API upload failed: ${uploadErr.message}. Falling back to DOM/UI upload...`);
      imageInputUUIDs = [];
      try {
        await uploadImages(page, filePayloads, baseDir);
        for (const fp of filePayloads) {
          const uuid = await findImageUUID(page, fp.name);
          if (uuid) {
            imageInputUUIDs.push(uuid);
          } else {
            console.warn(`[Gen] ⚠️ Could not resolve UUID for "${fp.name}" (will rely on direct UI reference attachment).`);
          }
        }
      } catch (domErr) {
        console.warn(`[Gen] ⚠️ DOM upload/UUID fallback warning: ${domErr.message} (will rely on direct UI reference attachment).`);
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

  console.log('[Gen] Step 4: Getting reCAPTCHA token (quick)...');
  const reqCount = Number(outputCount) > 1 ? Number(outputCount) : 1;
  const recaptchaTokens = [];
  try {
    const tok = await getRecaptchaToken(page, 'IMAGE_GENERATION');
    if (tok) recaptchaTokens.push(tok);
  } catch (err) {
    console.warn(`[Gen] Error getting reCAPTCHA token: ${err.message}`);
  }
  const recaptchaToken = recaptchaTokens[0] || '';
  console.log(`[Gen]   reCAPTCHA: ${recaptchaToken ? recaptchaToken.substring(0, 30) : 'none'}... (${recaptchaToken ? recaptchaToken.length : 0} chars)`);

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
  return { context, bearerToken, recaptchaToken, recaptchaTokens, imageInputUUIDs, prompt, aspectRatio, imageModel, outputCount: reqCount, projectId: targetProjectId, wiz, page, filePayloads, useProxy: config.useProxy };
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
// Direct Network Stream Generation (100% human trust, zero UI click / tamper)
// ═══════════════════════════════════════════════════════════════
async function generateImagesViaUI({ page, context, prompt, outputCount = 1, aspectRatio = '16:9', imageInputUUIDs = [], filePayloads = [], useProxy = true }) {
  if (!page || page.isClosed()) return null;

  const { applyProxyPolicy } = require('./proxy-bridge');
  applyProxyPolicy(useProxy !== false, 'ImageGen - Flow');

  const count = Number(outputCount) > 1 ? Number(outputCount) : 1;
  const { generateStoryboardsViaNativeNetworkStream } = require('./playwright-direct/direct-flow-engine');

  const refBuffer = (filePayloads && filePayloads.length > 0 && filePayloads[0]?.buffer)
    ? filePayloads[0].buffer
    : null;

  const maxAttempts = 11;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[Gen-DirectNetwork] 🚀 Generating ${count} image(s) via Native Network Stream (attempt ${attempt}/${maxAttempts}, ratio: ${aspectRatio}, refs: ${imageInputUUIDs?.length || 0})...`);

      const buffers = await generateStoryboardsViaNativeNetworkStream(page, {
        prompt,
        aspectRatio,
        referenceBuffer: refBuffer,
        imageInputUUIDs,
        filePayloads,
        outputCount: count,
        timeoutMs: 60000,
      });

      if (buffers && buffers.length > 0) {
        const results = buffers.map((buf, i) => ({
          base64: buf.toString('base64'),
          buffer: buf,
          mimeType: 'image/png',
          imageName: `img_${Date.now()}_${i + 1}`,
          signedUrl: ''
        }));

        console.log(`[Gen-DirectNetwork] ✅ Successfully generated and downloaded ${results.length} candidate(s)!`);
        return {
          base64: results[0].base64,
          buffer: results[0].buffer,
          mimeType: results[0].mimeType,
          imageName: results[0].imageName,
          allResults: results
        };
      }
    } catch (err) {
      lastErr = err;
      console.warn(`[Gen-DirectNetwork] ⚠️ Attempt ${attempt}/${maxAttempts} failed: ${err.message}`);

      if (attempt < maxAttempts) {
        try {
          const { rotateProxy } = require('./proxy-bridge');
          const nextP = rotateProxy();
          const targetLog = nextP.isDirect ? 'DIRECT (Mặc định)' : `proxy #${nextP.index + 1}/${nextP.proxyCount || nextP.total} (${nextP.host}:${nextP.port})`;
          console.log(`[Gen-DirectNetwork] 🔄 Chuyển sang kết nối: ${targetLog}`);
        } catch (rotErr) {
          console.warn('[Gen-DirectNetwork] ⚠️ Proxy rotation error:', rotErr.message);
        }

        console.log('[Gen-DirectNetwork] ⏳ Cooldown 3s và tải lại Flow page để áp dụng proxy/session mới...');
        await new Promise(r => setTimeout(r, 3000));
        try {
          const currentUrl = page.url();
          if (currentUrl.includes('flow.google.com/project/')) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 });
          } else {
            const projectUrl = `https://flow.google.com/project/${PROJECT_ID}`;
            await page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          }
        } catch (_) {}
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  throw lastErr || new Error(`[Gen-DirectNetwork] All ${maxAttempts} attempts failed.`);
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
  useProxy = true,
}) {
  const targetProjectId = projectId || wiz?.projectId || PROJECT_ID;
  const count = Number(outputCount) > 1 ? Number(outputCount) : 1;

  // 1. Direct Network Stream path: uses native human event for composer input/submit,
  //    captures ogiZ0b RPC response stream directly from network, downloads CDN buffers.
  //    Tự động xoay vòng proxy pool khi gặp UNUSUAL_ACTIVITY và reload trang để retry.
  if (!skipUi && page && !page.isClosed()) {
    try {
      const uiResult = await generateImagesViaUI({
        page,
        context,
        prompt,
        outputCount: count,
        aspectRatio,
        imageInputUUIDs,
        filePayloads,
        useProxy,
      });
      if (uiResult && uiResult.allResults && uiResult.allResults.length > 0) {
        console.log(`[Gen] ✅ Direct network stream generation successful! Generated ${uiResult.allResults.length} image(s).`);
        return uiResult;
      }
    } catch (uiErr) {
      console.error(`[Gen] ❌ Native network stream generation failed after proxy rotation retries: ${uiErr.message}`);
      throw uiErr;
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
