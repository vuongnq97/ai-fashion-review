const fs = require('fs');
const path = require('path');
const { writeTempFiles } = require('../utils/helpers');
const { getContext, ensureBearerToken, invalidateBearerToken, getRecaptchaToken, PROJECT_ID, PROJECT_URL } = require('./browser');

// ═══════════════════════════════════════════════════════════════
// Aspect ratio mapping: user-friendly → API enum
// ═══════════════════════════════════════════════════════════════
const ASPECT_RATIO_MAP = {
  '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
  '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
  '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
  '3:4': 'IMAGE_ASPECT_RATIO_PORTRAIT',
  '4:3': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
};

// ═══════════════════════════════════════════════════════════════
// Model mapping: user-friendly → API model name
// ═══════════════════════════════════════════════════════════════
const MODEL_MAP = {
  'nano-banana-2': 'NARWHAL',
  'narwhal': 'NARWHAL',
};

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
async function uploadImageDirect(context, bearerToken, buffer) {
  const imageBase64 = buffer.toString('base64');
  const apiUrl = 'https://aisandbox-pa.googleapis.com/v1/flow/uploadImage';
  const requestBody = {
    clientContext: {
      projectId: PROJECT_ID,
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
      invalidateBearerToken();
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

  const fileInput = page.locator('input[type="file"][accept="image/*"]');
  await fileInput.setInputFiles(tempFilePaths);

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

  console.log('[Gen] Step 1: Getting Bearer token...');
  const bearerToken = await ensureBearerToken(page);

  let imageInputUUIDs = [];
  if (filePayloads && filePayloads.length > 0) {
    console.log(`[Gen] Step 2: Uploading ${filePayloads.length} image(s) directly via API...`);
    for (const fp of filePayloads) {
      const uuid = await uploadImageDirect(context, bearerToken, fp.buffer);
      console.log(`[Gen]   Uploaded: ${fp.name} -> ${uuid}`);
      imageInputUUIDs.push(uuid);
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

  console.log('[Gen] Step 4: Getting reCAPTCHA token...');
  const recaptchaToken = await getRecaptchaToken(page, 'IMAGE_GENERATION');
  console.log(`[Gen]   reCAPTCHA: ${recaptchaToken.substring(0, 30)}... (${recaptchaToken.length} chars)`);
  console.log(`[Gen] ✅ Setup complete — releasing browser lock.`);

  return { context, bearerToken, recaptchaToken, imageInputUUIDs, prompt, aspectRatio, imageModel, outputCount };
}

// ═══════════════════════════════════════════════════════════════
// PHASE 2: Execute API call (NO browser page needed, parallel OK)
// ═══════════════════════════════════════════════════════════════
async function executeGeneration({ context, bearerToken, recaptchaToken, imageInputUUIDs, prompt, aspectRatio, imageModel, outputCount }) {
  console.log('[Gen] Step 5: Calling batchGenerateImages API...');

  const apiAspectRatio = ASPECT_RATIO_MAP[aspectRatio] || 'IMAGE_ASPECT_RATIO_SQUARE';
  const apiModelName = MODEL_MAP[imageModel] || 'NARWHAL';
  const apiUrl = `https://aisandbox-pa.googleapis.com/v1/projects/${PROJECT_ID}/flowMedia:batchGenerateImages`;

  let lastError = null;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const seed = Math.floor(Math.random() * 1000000);
      const sessionId = `;${Date.now()}`;
      const batchId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      const requestBody = {
        clientContext: {
          recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
          projectId: PROJECT_ID, tool: 'PINHOLE', sessionId
        },
        mediaGenerationContext: { batchId },
        useNewMedia: true,
        requests: [{
          clientContext: {
            recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
            projectId: PROJECT_ID, tool: 'PINHOLE', sessionId
          },
          imageModelName: apiModelName,
          imageAspectRatio: apiAspectRatio,
          structuredPrompt: { parts: [{ text: prompt }] },
          seed,
          imageInputs: imageInputUUIDs.map(name => ({ imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE', name }))
        }]
      };

      if (attempt > 1) {
        console.log(`[Gen] 🔄 Retrying batchGenerateImages API (Attempt ${attempt}/${maxRetries})...`);
      }

      const response = await context.request.fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'Authorization': `Bearer ${bearerToken}`,
          'Origin': 'https://labs.google',
          'Referer': 'https://labs.google/',
          'x-browser-channel': 'stable',
          'x-browser-copyright': 'Copyright 2026 Google LLC. All Rights Reserved.',
          'x-browser-year': '2026'
        },
        data: JSON.stringify(requestBody),
        timeout: 180000
      });

      const status = response.status();
      const body = await response.text();
      if (status !== 200) {
        throw new Error(`API returned HTTP ${status}: ${body.substring(0, 500)}`);
      }

      const result = JSON.parse(body);
      console.log(`[Gen] ✅ API returned successfully!`);

      const media = result.media || [];
      if (media.length === 0) {
        throw new Error('API returned no media in response');
      }

      const mainMedia = media[0];
      const fifeUrl = mainMedia.image?.generatedImage?.fifeUrl;
      const generatedName = mainMedia.name;
      if (!fifeUrl) {
        throw new Error('No fifeUrl in API response');
      }

      // Fetch image with retry
      let imgBuffer = null;
      for (let imgAttempt = 1; imgAttempt <= 3; imgAttempt++) {
        try {
          const imgResponse = await context.request.fetch(fifeUrl, { timeout: 60000 });
          if (imgResponse.status() === 200) {
            imgBuffer = await imgResponse.body();
            break;
          }
        } catch (fetchErr) {
          if (imgAttempt === 3) throw fetchErr;
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      if (!imgBuffer) {
        throw new Error('Failed to download generated image buffer from fifeUrl');
      }

      const resultBase64 = imgBuffer.toString('base64');
      console.log(`[Gen]   ✅ Image fetched (base64 length: ${resultBase64.length}).`);

      let allResults = [];
      if (outputCount > 1 && media.length > 1) {
        for (const m of media) {
          const url = m.image?.generatedImage?.fifeUrl;
          if (url) {
            try {
              const r = await context.request.fetch(url, { timeout: 60000 });
              const buf = await r.body();
              allResults.push({ base64: buf.toString('base64'), mimeType: 'image/png' });
            } catch (_) {}
          }
        }
      }

      console.log(`[Gen] ✅ Done! Returning result (Name: ${generatedName}).`);
      return { base64: resultBase64, mimeType: 'image/png', imageName: generatedName, allResults: allResults.length > 0 ? allResults : undefined };
    } catch (err) {
      lastError = err;
      console.warn(`[Gen] ⚠️ batchGenerateImages attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) {
        const waitMs = Math.min(3000 * Math.pow(2, attempt - 1), 12000);
        console.log(`[Gen] Waiting ${Math.round(waitMs / 1000)}s before retry...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }

  throw new Error(`[Gen] Failed to execute generation after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
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
  uploadImageDirect
};
