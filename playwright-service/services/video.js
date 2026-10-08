process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeTempFiles } = require('../utils/helpers');
const { getContext, ensureBearerToken, getRecaptchaToken, extractProjectIdFromPage, PROJECT_URL, PROJECT_ID } = require('./browser');
const { findImageUUID, uploadImages, switchToMode, uploadImageDirect } = require('./image');
const { processVideoBase64 } = require('./video-resize');
const { ensureWorkWindow } = require('../utils/window-config');
const { rotateProxy, getActiveProxy } = require('./proxy-bridge');

// ═══════════════════════════════════════════════════════════════
// Video model mapping
// ═══════════════════════════════════════════════════════════════
const VIDEO_MODEL_MAP = {
  'portrait': 'veo_3_1_i2v_lite_low_priority',
  'landscape': 'veo_3_1_i2v_lite_low_priority',
  'square': 'veo_3_1_i2v_lite_low_priority',
};

const RAW_VIDEO_MODEL_ALIASES = {
  // Abra models (Google Flow native video generation)
  'abra': 'abra_i2v_8s',
  'abra-8s': 'abra_i2v_8s',
  'abra-i2v-8s': 'abra_i2v_8s',
  'abra_i2v_8s': 'abra_i2v_8s',
  'abra-4s': 'abra_i2v_4s',
  'abra-i2v-4s': 'abra_i2v_4s',
  'abra_i2v_4s': 'abra_i2v_4s',
  'abra-t2v-8s': 'abra_t2v_8s_360p',
  'abra_t2v_8s_360p': 'abra_t2v_8s_360p',
  'abra_r2v_8s': 'abra_i2v_8s',   // r2v alias → correct i2v model name (confirmed from Flow UI)
  'abra-r2v-8s': 'abra_i2v_8s',
  'r2v_8s': 'abra_i2v_8s',
  'r2v-8s': 'abra_i2v_8s',
  'abra_r2v_4s': 'abra_i2v_4s',   // r2v alias → correct i2v model name
  'abra-r2v-4s': 'abra_i2v_4s',
  'r2v_4s': 'abra_i2v_4s',
  'r2v-4s': 'abra_i2v_4s',
  // Veo models
  'default': 'veo_3_1_i2v_lite_low_priority',
  'quality': 'veo_3_1_i2v_lite_low_priority',
  'veo-3.1-quality': 'veo_3_1_i2v_lite_low_priority',
  'veo-3.1-quality-lower': 'veo_3_1_i2v_lite_low_priority',
  'veo-3.1-lite-lower': 'veo_3_1_i2v_lite_low_priority',
  'veo-3.1-lite-low-priority': 'veo_3_1_i2v_lite_low_priority',
  'veo_3_1_i2v_lite_low_priority': 'veo_3_1_i2v_lite_low_priority',
  'veo-3.1-fast-lower': 'veo_3_1_i2v_fast_low_priority',
  'veo-3.1-fast-low-priority': 'veo_3_1_i2v_fast_low_priority',
  'veo_3_1_i2v_fast_low_priority': 'veo_3_1_i2v_fast_low_priority',
  'veo-3.1-lite': 'veo_3_1_i2v_lite',
  'veo_3_1_i2v_lite': 'veo_3_1_i2v_lite',
  'veo-3.1-fast': 'veo_3_1_i2v_fast',
  'veo_3_1_i2v_fast': 'veo_3_1_i2v_fast',
  // 4-second video models
  '4s': 'veo_3_1_i2v_s_lite_4s_low_priority',
  'veo-3.1-4s': 'veo_3_1_i2v_s_lite_4s_low_priority',
  'veo-3.1-4s-low-priority': 'veo_3_1_i2v_s_lite_4s_low_priority',
  'veo_3_1_i2v_s_lite_4s_low_priority': 'veo_3_1_i2v_s_lite_4s_low_priority',
  // 6-second video models (Food Review / Veo 3 standard i2v lite)
  '6s': 'veo_3_1_i2v_lite_low_priority',
  'veo-3.1-6s': 'veo_3_1_i2v_lite_low_priority',
  'veo_3_1_i2v_s_lite_6s_low_priority': 'veo_3_1_i2v_lite_low_priority',
  'abra_r2v_6s': 'abra_r2v_4s',
  'abra-r2v-6s': 'abra_r2v_4s',
  'r2v_6s': 'abra_r2v_4s',
  // 8-second video models (tproduct Live Commerce / Veo 3)
  '8s': 'veo_3_1_i2v_lite_low_priority',
  'veo-3.1-8s': 'veo_3_1_i2v_lite_low_priority',
  'veo-3.1-8s-low-priority': 'veo_3_1_i2v_lite_low_priority',
  'veo_3_1_i2v_s_lite_8s_low_priority': 'veo_3_1_i2v_lite_low_priority',
};

const VIDEO_ASPECT_MAP = {
  '9:16': 'VIDEO_ASPECT_RATIO_PORTRAIT',
  '16:9': 'VIDEO_ASPECT_RATIO_LANDSCAPE',
  '1:1': 'VIDEO_ASPECT_RATIO_SQUARE',
};

function getDefaultVideoModelKey(aspectRatio = '9:16') {
  if (aspectRatio === '16:9') return VIDEO_MODEL_MAP.landscape;
  if (aspectRatio === '1:1') return VIDEO_MODEL_MAP.square;
  return VIDEO_MODEL_MAP.portrait;
}

function normalizeVideoModelKey(videoModelKey, aspectRatio = '9:16') {
  const raw = String(videoModelKey || '').trim();
  if (!raw) return getDefaultVideoModelKey(aspectRatio);

  if (/^veo_/.test(raw) || /^abra_/.test(raw)) return raw;

  const normalized = raw.toLowerCase();
  if (RAW_VIDEO_MODEL_ALIASES[normalized]) return RAW_VIDEO_MODEL_ALIASES[normalized];

  if (normalized.includes('lite') && normalized.includes('lower')) return RAW_VIDEO_MODEL_ALIASES['veo-3.1-lite-lower'];
  if (normalized.includes('fast') && normalized.includes('lower')) return RAW_VIDEO_MODEL_ALIASES['veo-3.1-fast-lower'];
  if (normalized.includes('lite')) return RAW_VIDEO_MODEL_ALIASES['veo-3.1-lite'];
  if (normalized.includes('fast')) return RAW_VIDEO_MODEL_ALIASES['veo-3.1-fast'];

  return getDefaultVideoModelKey(aspectRatio);
}

// ═══════════════════════════════════════════════════════════════
// Start video generation via API
// ═══════════════════════════════════════════════════════════════
async function startVideoGeneration(page, context, {
  prompt,
  startImageMediaId,
  aspectRatio = '9:16',
  videoModelKey = null,
  cropCoordinates = null
}) {
  // Reload page to get fresh reCAPTCHA context
  // (UI interactions like upload/picker contaminate the reCAPTCHA score)
  // console.log('[VideoGen] Reloading page for fresh reCAPTCHA context...');
  // await page.goto(PROJECT_URL);
  // await page.waitForTimeout(5000);

  const bearerToken = await ensureBearerToken(page);
  const recaptchaToken = await getRecaptchaToken(page, 'VIDEO_GENERATION');
  console.log(`[VideoGen]   reCAPTCHA token: ${recaptchaToken.substring(0, 30)}... (${recaptchaToken.length} chars)`);

  const apiAspect = VIDEO_ASPECT_MAP[aspectRatio] || 'VIDEO_ASPECT_RATIO_PORTRAIT';

  videoModelKey = normalizeVideoModelKey(videoModelKey, aspectRatio);

  const seed = Math.floor(Math.random() * 100000);
  const sessionId = `;${Date.now()}`;
  const batchId = crypto.randomUUID();

  const startImage = {
    mediaId: startImageMediaId
  };
  if (cropCoordinates) {
    startImage.cropCoordinates = cropCoordinates;
  }

  const targetProjectId = (page ? extractProjectIdFromPage(page) : PROJECT_ID);

  const requestBody = {
    mediaGenerationContext: {
      batchId: batchId,
      audioFailurePreference: 'BLOCK_SILENCED_VIDEOS'
    },
    clientContext: {
      projectId: targetProjectId,
      tool: 'PINHOLE',
      userPaygateTier: 'PAYGATE_TIER_TWO',
      sessionId: sessionId,
      recaptchaContext: {
        token: recaptchaToken,
        applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB'
      }
    },
    requests: [{
      aspectRatio: apiAspect,
      seed: seed,
      textInput: {
        structuredPrompt: {
          parts: [{ text: prompt }]
        }
      },
      videoModelKey: videoModelKey,
      metadata: {},
      startImage
    }],
    useV2ModelConfig: true
  };

  console.log(`[VideoGen] Calling batchAsyncGenerateVideoStartImage API...`);
  console.log(`[VideoGen]   prompt: "${prompt.substring(0, 80)}..."`);
  console.log(`[VideoGen]   startImage: ${startImageMediaId}`);
  console.log(`[VideoGen]   model: ${videoModelKey}, ratio: ${apiAspect}`);

  const apiUrl = 'https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage';

  let lastError = null;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`[VideoGen] 🔄 Retrying batchAsyncGenerateVideoStartImage API (Attempt ${attempt}/${maxRetries})...`);
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
        timeout: 90000
      });

      const status = response.status();
      const body = await response.text();

      if (status !== 200) {
        let quotaReason = '';
        try {
          const errorBody = JSON.parse(body);
          const reason = errorBody.error?.details?.find(detail => detail.reason)?.reason;
          quotaReason = reason ? ` reason=${reason}` : '';
        } catch (_) {}
        throw new Error(`API returned HTTP ${status}${quotaReason} model=${videoModelKey} ratio=${apiAspect}: ${body.substring(0, 500)}`);
      }

      const result = JSON.parse(body);
      console.log(`[VideoGen] ✅ Video generation started!`);
      console.log(`[VideoGen] API response: ${JSON.stringify(result).substring(0, 500)}`);

      return result;
    } catch (err) {
      lastError = err;
      console.warn(`[VideoGen] ⚠️ startVideoGeneration attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) {
        const waitMs = Math.min(3000 * Math.pow(2, attempt - 1), 12000);
        console.log(`[VideoGen] Waiting ${Math.round(waitMs / 1000)}s before retry...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }

  throw new Error(`[VideoGen] Failed to start video generation after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
}

// ═══════════════════════════════════════════════════════════════
// Poll for video completion via API
// Uses batchCheckAsyncVideoGenerationStatus every 5 seconds
// ═══════════════════════════════════════════════════════════════
async function pollVideoStatus(page, context, mediaName) {
  console.log(`[VideoGen] Polling video status for media: ${mediaName}...`);

  const statusUrl = 'https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus';
  const maxPolls = 120; // 10 minutes max (120 * 5s)

  for (let i = 0; i < maxPolls; i++) {
    await page.waitForTimeout(5000);

    const bearerToken = await ensureBearerToken(page);

    const statusBody = {
      media: [{
        name: mediaName,
        projectId: PROJECT_ID
      }]
    };

    try {
      const response = await context.request.fetch(statusUrl, {
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
        data: JSON.stringify(statusBody),
        timeout: 30000
      });

      const status = response.status();
      const body = await response.text();

      if (status !== 200) {
        console.log(`[VideoGen] Status check HTTP ${status}, retrying...`);
        continue;
      }

      const result = JSON.parse(body);
      const media = result.media?.[0];

      if (!media) {
        console.log(`[VideoGen] No media in status response, retrying...`);
        continue;
      }

      const genStatus = media.mediaMetadata?.mediaStatus?.mediaGenerationStatus;

      if (genStatus === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
        console.log(`[VideoGen] ✅ Video generation completed after ${(i + 1) * 5}s`);
        if (result.remainingCredits !== undefined) {
          console.log(`[VideoGen] Remaining credits: ${result.remainingCredits}`);
        }
        return media;
      }

      if (genStatus === 'MEDIA_GENERATION_STATUS_FAILED') {
        throw new Error(`[VideoGen] ❌ Video generation failed on server`);
      }

      // Still pending
      if ((i + 1) % 12 === 0) {
        console.log(`[VideoGen] Still generating... ${(i + 1) * 5}s elapsed. Status: ${genStatus}`);
      }
    } catch (e) {
      if (e.message.includes('failed on server')) throw e;
      console.log(`[VideoGen] Status check error: ${e.message}, retrying...`);
    }
  }

  throw new Error('[VideoGen] ❌ Timeout: Video generation did not complete after 10 minutes.');
}

// ═══════════════════════════════════════════════════════════════
// Poll for video completion (standalone — no browser page needed)
function parseBatchExecuteResponse(rawText, rpcId) {
  const cleaned = rawText.replace(/^\)\]\}'\s*/, '').trim();
  const lines = cleaned.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (Array.isArray(item)) {
            if (item[1] === rpcId && typeof item[2] === 'string') {
              return JSON.parse(item[2]);
            }
            for (const sub of item) {
              if (Array.isArray(sub) && sub[1] === rpcId && typeof sub[2] === 'string') {
                return JSON.parse(sub[2]);
              }
            }
          }
        }
      }
    } catch (_) {}
  }
  return null;
}

function findMediaNameInBatchResult(obj, inputIds = []) {
  if (!obj) return null;
  const inputSet = new Set((inputIds || []).map(id => String(id).toLowerCase().trim()));
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // 1. Direct extraction from standard Google Flow MZZa6b response:
  // Note: In Google Flow MZZa6b response:
  // - obj[3] contains array of generated video objects: [[videoMediaId, projectId, sceneId, ...]]
  // - obj[2][0][3][4] is also the videoMediaId!
  // - Warning: obj[2][0][0] is the scene/edit session ID, NOT the video media ID!
  if (Array.isArray(obj)) {
    if (obj[3]?.[0]?.[0] && typeof obj[3][0][0] === 'string' && uuidRegex.test(obj[3][0][0])) {
      return obj[3][0][0];
    }
    if (obj[2]?.[0]?.[3]?.[4] && typeof obj[2][0][3][4] === 'string' && uuidRegex.test(obj[2][0][3][4])) {
      return obj[2][0][3][4];
    }
    if (obj[1]?.[0]?.[3]?.[4] && typeof obj[1][0][3][4] === 'string' && uuidRegex.test(obj[1][0][3][4])) {
      return obj[1][0][3][4];
    }
  }

  // 2. Priority 1: full path matching projects/.../media/...
  const pathRegex = /projects\/[a-f0-9-]+\/locations\/[a-z0-9-]+\/media\/[a-f0-9-]+/i;
  let foundPath = null;
  function searchPath(curr) {
    if (!curr || foundPath) return;
    if (typeof curr === 'string') {
      const match = curr.match(pathRegex);
      if (match) {
        foundPath = match[0];
        return;
      }
    } else if (Array.isArray(curr)) {
      for (const elem of curr) searchPath(elem);
    } else if (typeof curr === 'object') {
      for (const key of Object.keys(curr)) searchPath(curr[key]);
    }
  }
  searchPath(obj);
  if (foundPath) return foundPath;

  // 3. Priority 2: any UUID that is NOT one of our input image IDs
  let foundUuid = null;
  function searchUuid(curr) {
    if (!curr || foundUuid) return;
    if (typeof curr === 'string') {
      const val = curr.trim();
      if (uuidRegex.test(val) && !inputSet.has(val.toLowerCase())) {
        foundUuid = val;
        return;
      }
    } else if (Array.isArray(curr)) {
      for (const elem of curr) searchUuid(elem);
    } else if (typeof curr === 'object') {
      for (const key of Object.keys(curr)) searchUuid(curr[key]);
    }
  }
  searchUuid(obj);
  return foundUuid;
}

/**
 * Extract video media UUID from a successful eb1hJf batchexecute response.
 * eb1hJf response structure (success):
 *   [null, <credits>, [[ <sceneUUID>, null, null, [title, time, null, null, <videoUUID>], <projectId> ]], [[ <videoUUID>, <projectId>, <sceneUUID> ]]]
 * CRITICAL:
 *   - parsed[3][0][0] is the VIDEO MEDIA UUID (what jwpduf and as29s expect)
 *   - parsed[2][0][3][4] is also the VIDEO MEDIA UUID
 *   - WARNING: parsed[2][0][0] is the SCENE/SESSION UUID! Polling parsed[2][0][0] causes "Media not found."!
 */
function findMediaNameInEb1hJfResult(parsed, inputIds = []) {
  if (!parsed) return null;
  const inputSet = new Set((inputIds || []).map(id => String(id).toLowerCase().trim()));
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // PRIORITY 1: parsed[3][0][0] — array of generated video objects [[videoMediaId, projectId, sceneId, ...]]
  if (Array.isArray(parsed[3]) && Array.isArray(parsed[3][0])) {
    const candidate = parsed[3][0][0];
    if (typeof candidate === 'string' && uuidRegex.test(candidate) && !inputSet.has(candidate.toLowerCase())) {
      console.log(`[VideoGen-UI] 🎯 Extracted videoMediaId from eb1hJf parsed[3][0][0]: ${candidate}`);
      return candidate;
    }
  }

  // PRIORITY 2: parsed[2][0][3][4] — direct videoMediaId in scene metadata
  if (Array.isArray(parsed[2]) && Array.isArray(parsed[2][0])) {
    const directVideoId = parsed[2][0]?.[3]?.[4];
    if (typeof directVideoId === 'string' && uuidRegex.test(directVideoId) && !inputSet.has(directVideoId.toLowerCase())) {
      console.log(`[VideoGen-UI] 🎯 Extracted videoMediaId from eb1hJf parsed[2][0][3][4]: ${directVideoId}`);
      return directVideoId;
    }
  }

  // PRIORITY 3: Fallback using standard findMediaNameInBatchResult
  const batchCandidate = findMediaNameInBatchResult(parsed, inputIds);
  if (batchCandidate) {
    console.log(`[VideoGen-UI] 🎯 Extracted videoMediaId via findMediaNameInBatchResult: ${batchCandidate}`);
    return batchCandidate;
  }

  // PRIORITY 4: Any UUID in parsed[3]
  if (Array.isArray(parsed[3])) {
    for (const sub of parsed[3]) {
      if (Array.isArray(sub)) {
        for (const item of sub) {
          if (typeof item === 'string' && uuidRegex.test(item) && !inputSet.has(item.toLowerCase())) {
            return item;
          }
        }
      }
    }
  }

  return null;
}

async function startVideoGenerationViaUI({
  page,
  prompt,
  imageMediaIds = [],
  imageBuffer = null,    // raw Buffer of the panel image for UI file-input upload
  imageName = 'panel.png',
  aspectRatio = '9:16',
  videoModelKey = 'abra_r2v_4s',
  targetProjectId,
  outputCount = 1,
  useProxy = true,
}) {
  if (!page || page.isClosed()) return null;

  console.log(`[VideoGen-UI] 🚀 Triggering video generation directly via Flow UI (natural human events)...`);

  // Ensure desktop-width window (>=1280) so Flow UI does not collapse into mobile drawer layout.
  // Dùng cửa sổ thật thay vì giả lập viewport lớn hơn cửa sổ (gây cắt mất phần dưới composer).
  await ensureWorkWindow(page, { minW: 1280, minH: 800 });
  await page.waitForTimeout(300);

  // Helper to aggressively dismiss all modal popups/change-log dialogs in Flow UI
  const dismissModals = async () => {
    try {
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(100);
      }
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll(
          '.change-log-modal-actions button, mat-dialog-actions button, mat-dialog-container button, [role="dialog"] button, .cdk-overlay-pane button'
        ));
        for (const btn of buttons) {
          const txt = (btn.textContent || '').trim().toLowerCase();
          if (txt.includes('got it') || txt.includes('đã hiểu') || txt.includes('đóng') || txt.includes('close') || txt.includes('dismiss') || txt.includes('bắt đầu') || txt.includes('hoàn tất')) {
            btn.click();
          }
        }
        const overlays = document.querySelectorAll('.change-log-modal-actions, .cdk-overlay-backdrop');
        overlays.forEach(o => {
          const container = o.closest('mat-dialog-container, .cdk-overlay-pane');
          if (container) container.remove();
          o.remove();
        });
      }).catch(() => {});
      await page.waitForTimeout(200);
    } catch (_) {}
  };

  await dismissModals();

  // 1. Route interceptor + response listener for eb1hJf
  //
  // WHY route interception: Our image is uploaded via maseQ from Playwright code, not through
  // Flow UI. So Angular's state doesn't contain our imageMediaId when it builds the eb1hJf
  // payload — the request goes out WITHOUT a start frame image.
  //
  // FIX: Intercept the outgoing eb1hJf request, inject our imageMediaId into item[4]
  // (the start frame slot), then let it through. Recaptcha is still Flow-generated (good score).
  let mediaName = null;
  let routeCleanedUp = false;

  const cleanupRoute = async () => {
    if (!routeCleanedUp) {
      routeCleanedUp = true;
      await page.unroute('**eb1hJf**').catch(() => {});
      await page.unroute('**MZZa6b**').catch(() => {});
      await page.unroute('**/batchexecute?rpcids=eb1hJf**').catch(() => {});
      await page.unroute('**/batchexecute?rpcids=MZZa6b**').catch(() => {});
    }
  };

  // Pre-clean any stale interceptors from previous attempts
  await page.unroute('**eb1hJf**').catch(() => {});
  await page.unroute('**MZZa6b**').catch(() => {});
  await page.unroute('**/batchexecute?rpcids=eb1hJf**').catch(() => {});
  await page.unroute('**/batchexecute?rpcids=MZZa6b**').catch(() => {});

  // Install route interceptors to inject imageMediaId into start frame & force i2v model
  if (imageMediaIds && imageMediaIds.length > 0) {
    const targetImageId = imageMediaIds[0];
    const isPortrait = aspectRatio === '9:16';
    const defaultCrop = isPortrait
      ? [0.3701416015625, null, 0.6298583984375, 1]
      : [0.1049382716049383, null, 0.8950617283950617, 1];
    const fallbackModel = String(videoModelKey || '').includes('8s') ? 'abra_i2v_8s' : 'abra_i2v_4s';
    console.log(`[VideoGen-UI] 🔀 Installing eb1hJf+MZZa6b route interceptors — targetImageId: ${targetImageId}, aspectRatio: ${aspectRatio}, model: ${fallbackModel}`);

    // Generic inject handler for eb1hJf
    const makeVideoInterceptor = (rpcId) => async (route) => {
      try {
        const postData = route.request().postData() || '';
        if (postData.includes('f.req=')) {
          const params = new URLSearchParams(postData);
          const fReqStr = params.get('f.req');
          if (fReqStr) {
            const fReq = JSON.parse(fReqStr);
            let rpcEntry = null;
            if (Array.isArray(fReq)) {
              for (const batch of fReq) {
                if (Array.isArray(batch)) {
                  for (const entry of batch) {
                    if (Array.isArray(entry) && entry[0] === rpcId && entry[1]) {
                      rpcEntry = entry;
                      break;
                    }
                  }
                }
              }
            }

            if (rpcEntry && rpcEntry[1]) {
              const inner = JSON.parse(rpcEntry[1]);
              console.log(`[VideoGen-UI] 📦 ${rpcId} raw inner snippet: ${JSON.stringify(inner).substring(0, 400)}`);
              const items = inner[0];
              if (Array.isArray(items) && items.length > 0) {
                let injectedCount = 0;
                items.forEach((item0) => {
                  if (Array.isArray(item0)) {
                    // 1. Force Image-to-Video model (convert _t2v_ -> _i2v_)
                    // CRITICAL: When Flow UI sends _t2v_, Google Veo backend strictly ignores start frame slot!
                    if (typeof item0[1] === 'string') {
                      if (item0[1].includes('_t2v_')) {
                        item0[1] = item0[1].replace('_t2v_', '_i2v_');
                      } else if (!item0[1].includes('_i2v_')) {
                        item0[1] = fallbackModel;
                      }
                    } else {
                      item0[1] = fallbackModel;
                    }

                    // 2. Ensure aspect ratio integer: 1 for 9:16 (Portrait), 2 for 16:9 (Landscape)
                    const targetRatioInt = (aspectRatio === '16:9') ? 2 : 1;
                    item0[2] = targetRatioInt;

                    const activeCrop = (targetRatioInt === 1)
                      ? [0.3701416015625, null, 0.6298583984375, 1]
                      : [0.1049382716049383, null, 0.8950617283950617, 1];

                    // 3. Inject start frame into item0[4]
                    const prevFrame = item0[4];
                    if (Array.isArray(prevFrame)) {
                      prevFrame[1] = targetImageId;
                      if (!prevFrame[5]) {
                        prevFrame[5] = activeCrop; // Only set default crop if none exists
                      }
                    } else {
                      item0[4] = [null, targetImageId, null, null, null, activeCrop];
                    }

                    injectedCount++;
                  }
                });

                if (injectedCount > 0) {
                  rpcEntry[1] = JSON.stringify(inner);
                  params.set('f.req', JSON.stringify(fReq));
                  const loggedRatioInt = (aspectRatio === '16:9') ? 2 : 1;
                  console.log(`[VideoGen-UI] ✅ Successfully injected imageId & i2v model into ${rpcId} for ${injectedCount} candidate(s): model=${items[0]?.[1]}, ratioInt=${loggedRatioInt} (${aspectRatio}), imageId=${targetImageId}`);
                  await route.continue({ postData: params.toString() });
                  return;
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn(`[VideoGen-UI] ⚠️ ${rpcId} route intercept error: ${err.message}`);
      }
      await route.continue();
    };

    await page.route('**eb1hJf**', makeVideoInterceptor('eb1hJf')).catch(() => {});
    await page.route('**MZZa6b**', async (route) => {
      try {
        const postData = route.request().postData() || '';
        if (postData.includes('f.req=')) {
          const params = new URLSearchParams(postData);
          const fReqStr = params.get('f.req');
          if (fReqStr) {
            const fReq = JSON.parse(fReqStr);
            let rpcEntry = null;
            if (Array.isArray(fReq)) {
              for (const batch of fReq) {
                if (Array.isArray(batch)) {
                  for (const entry of batch) {
                    if (Array.isArray(entry) && entry[0] === 'MZZa6b' && entry[1]) {
                      rpcEntry = entry;
                      break;
                    }
                  }
                }
              }
            }

            if (rpcEntry && rpcEntry[1]) {
              const inner = JSON.parse(rpcEntry[1]);
              const items = inner[0];
              console.log(`[VideoGen-UI] 📦 MZZa6b items[0] full: ${JSON.stringify(items?.[0] || []).substring(0, 600)}`);
              if (Array.isArray(items) && items.length > 0) {
                let injectedCount = 0;
                items.forEach((item0) => {
                  if (Array.isArray(item0)) {
                    const targetRatioInt = (aspectRatio === '16:9') ? 2 : 1;
                    if (item0[2] !== undefined) {
                      item0[2] = targetRatioInt;
                    }
                    const startFrameArr = item0[1];
                    if (Array.isArray(startFrameArr) && Array.isArray(startFrameArr[0])) {
                      startFrameArr[0][1] = targetImageId;
                      injectedCount++;
                    } else {
                      item0[1] = [[null, targetImageId, null, null, null, defaultCrop]];
                      injectedCount++;
                    }
                  }
                });
                if (injectedCount > 0) {
                  rpcEntry[1] = JSON.stringify(inner);
                  params.set('f.req', JSON.stringify(fReq));
                  console.log(`[VideoGen-UI] ✅ MZZa6b injected startFrame for ${injectedCount} candidate(s): ${targetImageId}`);
                  await route.continue({ postData: params.toString() });
                  return;
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn(`[VideoGen-UI] ⚠️ MZZa6b intercept error: ${err.message}`);
      }
      await route.continue();
    }).catch(() => {});
  }

  const rpcPromise = new Promise((resolve, reject) => {
    let resolved = false;
    let pollInterval = null;
    let timeoutTimer = null;

    const cleanup = async () => {
      if (resolved) return;
      resolved = true;
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      page.off('response', onResponse);
      await cleanupRoute();
    };

    const triggerUnusualActivity = async (source) => {
      if (resolved) return;
      console.warn(`[VideoGen-UI] ⚠️ Google Flow UNUSUAL_ACTIVITY detected via ${source}!`);
      try {
        const nextP = rotateProxy();
        const targetLog = nextP.isDirect ? 'DIRECT (Mặc định)' : `proxy #${nextP.index + 1}/${nextP.proxyCount || nextP.total} (${nextP.host}:${nextP.port})`;
        console.log(`[VideoGen-UI] 🔄 Chuyển sang kết nối: ${targetLog}`);
      } catch (e) {
        console.warn(`[VideoGen-UI] ⚠️ Proxy rotation error: ${e.message}`);
      }
      await cleanup();
      reject(new Error('Google Flow UNUSUAL_ACTIVITY: Video bot score throttled.'));
    };

    const onResponse = async (res) => {
      if (resolved) return;
      const url = res.url();
      const isEb1hJf = url.includes('eb1hJf');
      const isMZZa6b = url.includes('MZZa6b');
      const isYhhmEf = url.includes('YhhmEf');
      if (!isEb1hJf && !isMZZa6b && !isYhhmEf) return;

      const rpcid = isEb1hJf ? 'eb1hJf' : (isMZZa6b ? 'MZZa6b' : 'YhhmEf');
      const status = res.status();
      console.log(`[VideoGen-UI] 📡 ${rpcid} response received (status ${status})!`);

      try {
        const text = await res.text().catch(() => '');
        console.log(`[VideoGen-UI] ${rpcid} length: ${text.length}, snippet: ${text.substring(0, 200)}`);

        if (text.includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY') || text.includes('unusual activity') || text.includes('UNUSUAL_ACTIVITY')) {
          console.warn(`[VideoGen-UI] ⚠️ ${rpcid} blocked: PUBLIC_ERROR_UNUSUAL_ACTIVITY`);
          await triggerUnusualActivity(`RPC response ${rpcid}`);
          return;
        }

        const parsed = parseBatchExecuteResponse(text, rpcid);
        console.log(`[VideoGen-UI] Parsed ${rpcid}: ${parsed ? 'YES' : 'NULL'}`);

        let foundName = null;
        if (isEb1hJf) {
          foundName = findMediaNameInEb1hJfResult(parsed, imageMediaIds);
        } else {
          foundName = findMediaNameInBatchResult(parsed, imageMediaIds);
        }
        console.log(`[VideoGen-UI] Found mediaName via ${rpcid}: ${foundName}`);

        if (foundName) {
          mediaName = foundName;
          await cleanup();
          resolve(mediaName);
        }
      } catch (pErr) {
        console.log(`[VideoGen-UI] ⚠️ Parse error: ${pErr.message}`);
      }
    };
    page.on('response', onResponse);

    // Fast-poll DOM UI (mỗi 1.2s) để bắt ngay thông báo lỗi nếu Google hiện toast/dialog
    pollInterval = setInterval(async () => {
      try {
        if (resolved || !page || page.isClosed()) return;
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
          await triggerUnusualActivity('DOM alert');
        }
      } catch (_) {}
    }, 1200);

    timeoutTimer = setTimeout(async () => {
      await cleanup();
      resolve(mediaName);
    }, 60000);
  });
  // Prevent unhandled rejection crash if error occurs before rpcPromise is awaited
  rpcPromise.catch(() => {});


  // 2. Open Settings -> Select Video -> duration -> ratio
  console.log('[VideoGen-UI] ⚙️ Checking video settings...');
  let settingsBtn = await page.$('button[aria-label="Điều kiện kích hoạt cài đặt"], button[aria-label="Settings trigger"], button:has-text("Nano Banana"), button:has-text("Video ·"), button:has-text("Hình ảnh")');
  if (settingsBtn) {
    let settingsBtnText = await settingsBtn.textContent().catch(() => '?');
    console.log(`[VideoGen-UI] ⚙️ Settings button found: "${settingsBtnText.trim().substring(0,35)}"`);

    // Helper: test if settings panel is currently open
    const isSettingsPanelOpen = async () => {
      return await page.evaluate(() => {
        const toggles = Array.from(document.querySelectorAll('mat-button-toggle, button[role="tab"], [role="tab"], .mat-mdc-tab'));
        for (const t of toggles) {
          const r = t.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
        return false;
      }).catch(() => false);
    };

    // Open settings panel if not already open (try up to 3 times)
    let panelOpen = await isSettingsPanelOpen();
    if (!panelOpen) {
      for (let openAttempt = 1; openAttempt <= 3; openAttempt++) {
        console.log(`[VideoGen-UI] ⚙️ Opening settings panel (attempt ${openAttempt}/3)...`);
        const trigger = page.locator('button[aria-label="Điều kiện kích hoạt cài đặt"], button[aria-label="Settings trigger"], button:has-text("Nano Banana"), button:has-text("Video ·"), button:has-text("Hình ảnh")').first();
        if (await trigger.isVisible({ timeout: 2000 }).catch(() => false)) {
          await trigger.click({ force: true }).catch(() => {});
        } else {
          await page.evaluate(() => {
            const allBtns = Array.from(document.querySelectorAll('button'));
            for (const b of allBtns) {
              const txt = (b.textContent || '').trim();
              if (txt.includes('Nano Banana') || txt.includes('Video ·')) {
                b.click();
                return;
              }
            }
          }).catch(() => {});
        }

        // Wait up to 1.5s for toggles to become visible
        for (let w = 0; w < 15; w++) {
          await page.waitForTimeout(100);
          panelOpen = await isSettingsPanelOpen();
          if (panelOpen) break;
        }

        if (panelOpen) {
          console.log(`[VideoGen-UI] ✅ Settings panel is open (attempt ${openAttempt})`);
          await page.waitForTimeout(300);
          break;
        }

        console.warn(`[VideoGen-UI] ⚠️ Settings panel did not open on attempt ${openAttempt}, pressing Escape and retrying...`);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(400);
      }
    } else {
      console.log('[VideoGen-UI] ℹ️ Settings panel was already open');
    }

    // 1. Ensure Video mode is active
    console.log('[VideoGen-UI] 🎬 Ensuring Video mode is active...');
    const videoModeSelected = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('mat-button-toggle, button[role="tab"], [role="tab"], .mat-mdc-tab, button'));
      for (const el of candidates) {
        const txt = (el.textContent || '').trim().toLowerCase();
        const val = (el.getAttribute('value') || '').toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        if (txt === 'video' || txt.startsWith('video') || val === 'video' || (aria.includes('video') && !aria.includes('tạo') && !aria.includes('generate'))) {
          const isChecked = el.classList.contains('mat-button-toggle-checked') ||
                            el.getAttribute('aria-checked') === 'true' ||
                            el.getAttribute('aria-selected') === 'true' ||
                            el.classList.contains('mat-mdc-tab-active') ||
                            el.classList.contains('mdc-tab--active');
          if (!isChecked) {
            const btn = el.querySelector('button') || el;
            btn.click();
            return { action: 'clicked', text: (el.textContent || '').trim().substring(0, 30) };
          }
          return { action: 'already_checked', text: (el.textContent || '').trim().substring(0, 30) };
        }
      }
      return { action: 'not_found' };
    }).catch(() => ({ action: 'eval_error' }));
    console.log(`[VideoGen-UI] 🎬 Video mode result: ${JSON.stringify(videoModeSelected)}`);
    if (videoModeSelected.action === 'clicked') {
      await page.waitForTimeout(600);
    }

    // ── Ratio Selection (9:16 or 16:9) ──
    const targetRatio = aspectRatio === '16:9' ? '16:9' : '9:16';
    const isPortraitTarget = targetRatio === '9:16';
    console.log(`[VideoGen-UI] 📐 Selecting video aspect ratio: ${targetRatio}...`);

    let ratioClicked = false;
    const ratioLocators = [
      `mat-button-toggle:has-text("${targetRatio}") button`,
      `mat-button-toggle[value*="${isPortraitTarget ? 'PORTRAIT' : 'LANDSCAPE'}"] button`,
      `mat-button-toggle:has-text("${targetRatio}")`,
      `button:text-is("${targetRatio}")`,
      `button:has-text("${targetRatio}")`,
      `[role="radio"]:has-text("${targetRatio}")`
    ];

    for (const locStr of ratioLocators) {
      const loc = page.locator(locStr).first();
      if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
        await loc.click({ force: true, timeout: 3000 }).catch(() => {});
        ratioClicked = true;
        console.log(`[VideoGen-UI] ✅ Clicked ratio button via locator: ${locStr}`);
        await page.waitForTimeout(300);
        break;
      }
    }

    if (!ratioClicked) {
      ratioClicked = await page.evaluate((target) => {
        const isPortrait = target === '9:16';
        const toggles = Array.from(document.querySelectorAll('mat-button-toggle, [role="radio"], button'));
        for (const el of toggles) {
          const txt = (el.textContent || '').trim();
          const val = (el.getAttribute('value') || '').toUpperCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          if (
            txt === target ||
            txt.includes(target) ||
            (isPortrait && (val.includes('PORTRAIT') || aria.includes('9:16') || aria.includes('dọc'))) ||
            (!isPortrait && (val.includes('LANDSCAPE') || aria.includes('16:9') || aria.includes('ngang')))
          ) {
            const btn = el.querySelector('button') || el;
            btn.click();
            return true;
          }
        }
        return false;
      }, targetRatio).catch(() => false);

      if (ratioClicked) {
        console.log(`[VideoGen-UI] ✅ Clicked ratio button via DOM eval: ${targetRatio}`);
        await page.waitForTimeout(300);
      } else {
        console.warn(`[VideoGen-UI] ⚠️ Could not find ratio button for: ${targetRatio}`);
      }
    }

    // Verify and enforce ratio toggle state in settings DOM
    const ratioStatus = await page.evaluate((target) => {
      const toggles = Array.from(document.querySelectorAll('mat-button-toggle'));
      const ratioToggles = toggles.filter(t => (t.textContent || '').includes('16:9') || (t.textContent || '').includes('9:16'));
      let checkedRatio = null;
      let targetToggle = null;
      for (const t of ratioToggles) {
        const isChecked = t.classList.contains('mat-button-toggle-checked') ||
                          t.getAttribute('aria-checked') === 'true' ||
                          t.querySelector('button')?.getAttribute('aria-pressed') === 'true';
        const text = (t.textContent || '').trim();
        if (isChecked) checkedRatio = text.includes('9:16') ? '9:16' : (text.includes('16:9') ? '16:9' : text);
        if (text.includes(target)) targetToggle = t;
      }
      if (checkedRatio !== target && targetToggle) {
        const btn = targetToggle.querySelector('button') || targetToggle;
        btn.click();
        return { corrected: true, previous: checkedRatio, now: target };
      }
      return { corrected: false, current: checkedRatio };
    }, targetRatio).catch(() => null);
    console.log(`[VideoGen-UI] 🔍 Ratio DOM verification result: ${JSON.stringify(ratioStatus)}`);
    await page.waitForTimeout(300);

    // ── Duration Selection (4s or 8s) ──
    const is4s = String(videoModelKey || '').includes('4s') || String(prompt || '').includes('4 giây');
    const durLabel = is4s ? '4 giây' : '8 giây';
    const durAlt = is4s ? '4s' : '8s';
    console.log(`[VideoGen-UI] ⏱️ Selecting video duration: ${durLabel}...`);

    let durClicked = false;
    const durLocators = [
      `mat-button-toggle:has-text("${durLabel}") button`,
      `mat-button-toggle:has-text("${durAlt}") button`,
      `button:has-text("${durLabel}")`,
      `button:has-text("${durAlt}")`,
      `mat-button-toggle:has-text("${durLabel}")`
    ];

    for (const locStr of durLocators) {
      const loc = page.locator(locStr).first();
      if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
        await loc.click({ force: true, timeout: 3000 }).catch(() => {});
        durClicked = true;
        console.log(`[VideoGen-UI] ✅ Clicked duration button via locator: ${locStr}`);
        await page.waitForTimeout(300);
        break;
      }
    }

    if (!durClicked) {
      durClicked = await page.evaluate(({ label, alt }) => {
        const toggles = Array.from(document.querySelectorAll('mat-button-toggle, [role="radio"], button'));
        for (const el of toggles) {
          const txt = (el.textContent || '').trim().toLowerCase();
          if (txt.includes(label.toLowerCase()) || txt === alt.toLowerCase()) {
            const btn = el.querySelector('button') || el;
            btn.click();
            return true;
          }
        }
        return false;
      }, { label: durLabel, alt: durAlt }).catch(() => false);

      if (durClicked) {
        console.log(`[VideoGen-UI] ✅ Clicked duration button via DOM eval: ${durLabel}`);
        await page.waitForTimeout(300);
      } else {
        console.warn(`[VideoGen-UI] ⚠️ Could not find duration button for: ${durLabel}`);
      }
    }

    // Candidate count (x1, x2, x3, x4) — ALWAYS select x1 for panel videos (1 video candidate = 7 credits, NOT x3/x4 = 21/28 credits)
    const targetCount = Math.min(Math.max(Number(outputCount) || 1, 1), 4);
    const countLabel = `x${targetCount}`;
    console.log(`[VideoGen-UI] 🔢 Setting video output count to ${countLabel}...`);

    let countClicked = false;
    const countBtn = page.locator(`mat-button-toggle:has-text("${countLabel}") button, button:text-is("${countLabel}")`).first();
    if (await countBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await countBtn.click({ force: true, timeout: 3000 }).catch(() => {});
      countClicked = true;
      console.log(`[VideoGen-UI] ✅ Clicked count button via locator: ${countLabel}`);
      await page.waitForTimeout(300);
    }

    if (!countClicked) {
      countClicked = await page.evaluate((target) => {
        const elements = document.querySelectorAll('mat-button-toggle, [role="tab"], [role="radio"], button');
        for (const el of elements) {
          const txt = (el.textContent || '').trim().toLowerCase();
          if (txt === target.toLowerCase()) {
            const btn = el.querySelector('button') || el;
            btn.click();
            return true;
          }
        }
        return false;
      }, countLabel).catch(() => false);
      if (countClicked) {
        console.log(`[VideoGen-UI] ✅ Clicked count button via DOM eval: ${countLabel}`);
        await page.waitForTimeout(300);
      } else {
        console.warn(`[VideoGen-UI] ⚠️ Could not find count button for: ${countLabel}`);
      }
    }

    // Sub-mode: ALWAYS select "Khung hình" (Frames mode / Start-End Frame mode) LAST
    console.log('[VideoGen-UI] 🎬 Ensuring "Khung hình" (Frames) mode...');
    const ensureFramesModeInDialog = async () => {
      return await page.evaluate(() => {
        const toggles = Array.from(document.querySelectorAll('mat-button-toggle'));
        let framesToggle = null;
        let componentsToggle = null;

        for (const t of toggles) {
          const txt = (t.textContent || '').trim().toLowerCase();
          const val = (t.getAttribute('value') || '').toUpperCase();
          if (txt.includes('khung hình') || txt.includes('khung hinh') || txt.includes('frames') || val.includes('FRAME')) {
            framesToggle = t;
          }
          if (txt.includes('thành phần') || txt.includes('thanh phan') || txt.includes('ingredient') || txt.includes('component') || val.includes('INGREDIENT') || val.includes('COMPONENT')) {
            componentsToggle = t;
          }
        }

        if (framesToggle) {
          const isFramesChecked = framesToggle.classList.contains('mat-button-toggle-checked') ||
                                  framesToggle.getAttribute('aria-checked') === 'true' ||
                                  framesToggle.querySelector('button')?.getAttribute('aria-pressed') === 'true';
          if (!isFramesChecked) {
            const btn = framesToggle.querySelector('button') || framesToggle;
            btn.click();
            return { action: 'clicked_frames', checkedNow: true };
          }
          return { action: 'already_checked', checkedNow: true };
        }
        return { action: 'frames_not_found', checkedNow: false };
      }).catch(() => ({ action: 'eval_error', checkedNow: false }));
    };

    let frameRes = await ensureFramesModeInDialog();
    console.log(`[VideoGen-UI] 🎬 "Khung hình" toggle initial check: ${JSON.stringify(frameRes)}`);
    await page.waitForTimeout(300);

    // If still not checked, try direct locator click
    if (!frameRes.checkedNow) {
      const frameModeBtn = page.locator('mat-button-toggle:has-text("Khung hình") button, mat-button-toggle[value*="FRAME"] button, button:has-text("Khung hình")').first();
      if (await frameModeBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await frameModeBtn.click({ force: true, timeout: 3000 }).catch(() => {});
        console.log('[VideoGen-UI] ✅ Clicked "Khung hình" toggle button via locator');
        await page.waitForTimeout(300);
      }
    }

    // Comprehensive Settings Audit inside Dialog DOM before closing
    const preCloseAudit = await page.evaluate((targetRatio) => {
      let fixLog = [];

      // 1. Force Video tab if not checked
      const tabs = Array.from(document.querySelectorAll('.cdk-overlay-pane button[role="tab"], button[role="tab"], [role="tab"], .mat-mdc-tab, mat-button-toggle'));
      for (const t of tabs) {
        const txt = (t.textContent || '').trim().toLowerCase();
        if (txt === 'video' || txt.startsWith('video')) {
          const isSelected = t.getAttribute('aria-selected') === 'true' ||
                             t.classList.contains('mdc-tab--active') ||
                             t.classList.contains('mat-mdc-tab-active') ||
                             t.classList.contains('mat-button-toggle-checked');
          if (!isSelected) {
            (t.querySelector('button') || t).click();
            fixLog.push('force_video');
          }
          break;
        }
      }

      // 2. Toggles audit
      const toggles = Array.from(document.querySelectorAll('mat-button-toggle'));
      for (const t of toggles) {
        const txt = (t.textContent || '').trim().toLowerCase();
        const val = (t.getAttribute('value') || '').toUpperCase();
        const isChecked = t.classList.contains('mat-button-toggle-checked') ||
                          t.getAttribute('aria-checked') === 'true' ||
                          t.querySelector('button')?.getAttribute('aria-pressed') === 'true';

        // Force Ratio if not checked
        const isTargetRatio = txt.includes(targetRatio) || (targetRatio === '9:16' && val.includes('PORTRAIT')) || (targetRatio === '16:9' && val.includes('LANDSCAPE'));
        if (isTargetRatio && !isChecked) {
          (t.querySelector('button') || t).click();
          fixLog.push('force_ratio_' + targetRatio);
        }
        // Force "Khung hình" (Frames) mode if not checked
        const isFrames = txt.includes('khung hình') || txt.includes('khung hinh') || txt.includes('frames') || val.includes('FRAME');
        if (isFrames && !isChecked) {
          (t.querySelector('button') || t).click();
          fixLog.push('force_frames_mode');
        }
        // Force x1 count if not checked
        if ((txt === 'x1' || val === '1') && !isChecked) {
          (t.querySelector('button') || t).click();
          fixLog.push('force_count_x1');
        }
      }
      return fixLog;
    }, targetRatio).catch(() => []);
    if (preCloseAudit && preCloseAudit.length > 0) {
      console.log(`[VideoGen-UI] 🔧 Pre-close settings corrections applied: ${preCloseAudit.join(', ')}`);
      await page.waitForTimeout(300);
    }

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);

    // Verify mode & ratio on trigger button
    const newSettingsBtn = await page.$('button[aria-label="Điều kiện kích hoạt cài đặt"], button[aria-label="Settings trigger"], button:has-text("Video ·"), button:has-text("Nano Banana"), button:has-text("Hình ảnh")');
    const newText = newSettingsBtn ? (await newSettingsBtn.textContent().catch(() => '?')) : '(not found)';
    const isVideoMode = String(newText).toLowerCase().includes('video');
    console.log(`[VideoGen-UI] 🔍 Trigger button after settings: "${newText.trim().substring(0,60)}" → ${isVideoMode ? '✅ VIDEO' : '⚠️ NOT VIDEO'}`);

    // Verify presence of Start Frame slot on main page
    const checkStartSlotVisible = async () => {
      const slot = page.locator('div.frame-trigger button.empty-chip, button.empty-chip, div.frame-trigger, [data-scroll-state="START"]').first();
      return await slot.isVisible({ timeout: 1000 }).catch(() => false);
    };

    let startSlotReady = await checkStartSlotVisible();
    const wrongRatioDetected = isPortraitTarget
      ? (newText.includes('16:9') || newText.includes('crop_16_9'))
      : (newText.includes('9:16') || newText.includes('crop_portrait'));

    // If either not in Video mode, wrong ratio, OR Start Frame slot is missing, re-open settings and enforce all!
    if ((!isVideoMode || wrongRatioDetected || !startSlotReady) && newSettingsBtn) {
      console.warn(`[VideoGen-UI] ⚠️ Re-opening settings: isVideoMode=${isVideoMode}, wrongRatio=${wrongRatioDetected}, startSlotReady=${startSlotReady}...`);
      let retryPanelOpen = await isSettingsPanelOpen();
      if (!retryPanelOpen) {
        for (let rTry = 1; rTry <= 3; rTry++) {
          await newSettingsBtn.click({ force: true, timeout: 3000 }).catch(() => {});
          for (let w = 0; w < 15; w++) {
            await page.waitForTimeout(100);
            if (await isSettingsPanelOpen()) { retryPanelOpen = true; break; }
          }
          if (retryPanelOpen) break;
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(300);
        }
      }
      await page.waitForTimeout(300);

      // Re-apply video tab, ratio, count & frames mode inside opened dialog
      await page.evaluate((targetRatio) => {
        // 1. Click Video tab
        const tabs = Array.from(document.querySelectorAll('.cdk-overlay-pane button[role="tab"], button[role="tab"], [role="tab"], .mat-mdc-tab, mat-button-toggle, button'));
        for (const t of tabs) {
          const txt = (t.textContent || '').trim().toLowerCase();
          if (txt === 'video' || txt.startsWith('video') || txt.includes('video')) {
            const isChecked = t.getAttribute('aria-selected') === 'true' || t.classList.contains('mat-mdc-tab-active') || t.classList.contains('mat-button-toggle-checked');
            if (!isChecked) {
              (t.querySelector('button') || t).click();
            }
            break;
          }
        }

        const toggles = Array.from(document.querySelectorAll('mat-button-toggle'));
        // 2. Click ratio toggle
        for (const t of toggles) {
          const txt = (t.textContent || '').trim().toLowerCase();
          const val = (t.getAttribute('value') || '').toUpperCase();
          const isTarget = txt.includes(targetRatio) || (targetRatio === '9:16' && val.includes('PORTRAIT')) || (targetRatio === '16:9' && val.includes('LANDSCAPE'));
          if (isTarget) {
            (t.querySelector('button') || t).click();
            break;
          }
        }
        // 3. Click count x1 toggle
        for (const t of toggles) {
          const txt = (t.textContent || '').trim().toLowerCase();
          if (txt === 'x1') {
            (t.querySelector('button') || t).click();
            break;
          }
        }
        // 4. Click "Khung hình" toggle LAST
        for (const t of toggles) {
          const txt = (t.textContent || '').trim().toLowerCase();
          const val = (t.getAttribute('value') || '').toUpperCase();
          if (txt.includes('khung hình') || txt.includes('khung hinh') || txt.includes('frames') || val.includes('FRAME')) {
            const isChecked = t.classList.contains('mat-button-toggle-checked') || t.getAttribute('aria-checked') === 'true';
            if (!isChecked) {
              (t.querySelector('button') || t).click();
            }
            break;
          }
        }
      }, targetRatio).catch(() => {});
      await page.waitForTimeout(400);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);

      startSlotReady = await checkStartSlotVisible();
      console.log(`[VideoGen-UI] 🔍 Start slot ready after retry: ${startSlotReady}`);
    }

    // Safety fallback: If trigger button text still shows an unwanted count like x2, x3, or x4, re-open and force select target count
    if (newText.includes('x2') || newText.includes('x3') || newText.includes('x4')) {
      if (!newText.includes(countLabel)) {
        console.warn(`[VideoGen-UI] ⚠️ Trigger button still shows unexpected count: "${newText.trim()}" — re-opening to force ${countLabel}...`);
        if (newSettingsBtn) {
          await newSettingsBtn.click({ force: true, timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(500);
          await page.evaluate((target) => {
            const elements = document.querySelectorAll('mat-button-toggle, [role="tab"], button');
            for (const el of elements) {
              if ((el.textContent || '').trim().toLowerCase() === target.toLowerCase()) {
                const btn = el.querySelector('button') || el;
                btn.click();
                return true;
              }
            }
            return false;
          }, countLabel).catch(() => false);
          await page.waitForTimeout(300);
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(500);
          const finalBtnText = await newSettingsBtn.textContent().catch(() => '');
          console.log(`[VideoGen-UI] 🔍 Trigger button after retry: "${finalBtnText.trim().substring(0,60)}"`);
        }
      }
    }
  } else {
    console.warn('[VideoGen-UI] ⚠️ Settings button not found — cannot switch to video mode');
  }


  // 3. Attach reference image directly to [ Bắt đầu ] start frame slot in "Khung hình" mode
  if (imageMediaIds && imageMediaIds.length > 0) {
    const targetId = imageMediaIds[0];
    const searchName = imageName || 'panel';
    console.log(`[VideoGen-UI] 🖼️ Attaching reference image to [ Bắt đầu ] start frame slot (mediaId: ${targetId}, file: ${searchName})...`);

    // Helper: check if start frame is physically attached in the DOM
    const checkStartFrameAttached = async () => {
      return await page.evaluate(() => {
        // 1. Check div.frame-trigger (current Flow DOM: contains flow-image-ingredient-chip)
        const frameTrigger = document.querySelector('div.frame-trigger');
        if (frameTrigger) {
          const chipImg = frameTrigger.querySelector('flow-image-ingredient-chip img, img.chip-image, img');
          if (chipImg && (chipImg.src || chipImg.currentSrc)) {
            const r = chipImg.getBoundingClientRect();
            return { attached: true, reason: `frame_trigger_chip_img_${Math.round(r.width)}x${Math.round(r.height)}`, src: (chipImg.src || chipImg.currentSrc).substring(0, 80) };
          }
          const chip = frameTrigger.querySelector('flow-image-ingredient-chip');
          if (chip) {
            return { attached: true, reason: 'frame_trigger_chip_element' };
          }
        }

        // 2. Check startSlot by data attribute or class
        const startSlot = document.querySelector('[data-scroll-state="START"]') || document.querySelector('.start-frame-slot');
        if (startSlot) {
          const img = startSlot.querySelector('img');
          if (img && (img.src || img.currentSrc)) {
            const r = img.getBoundingClientRect();
            if (r.width > 10 && r.height > 10) {
              return { attached: true, reason: `img_visible_${Math.round(r.width)}x${Math.round(r.height)}` };
            }
            return { attached: true, reason: 'img_present' };
          }
          const closeBtn = startSlot.querySelector('button, [aria-label*="Xoá" i], [aria-label*="Clear" i], [aria-label*="remove" i], mat-icon');
          if (closeBtn && (closeBtn.innerText.includes('close') || closeBtn.getAttribute('aria-label'))) {
            return { attached: true, reason: 'remove_btn_present' };
          }
          const bg = window.getComputedStyle(startSlot).backgroundImage;
          if (bg && bg !== 'none' && bg.includes('url')) {
            return { attached: true, reason: 'bg_image_present' };
          }
        }

        // 3. Check for any ingredient chip in the composer area
        const composerChips = Array.from(document.querySelectorAll('flow-image-ingredient-chip img, img.chip-image'));
        if (composerChips.length > 0) {
          return { attached: true, reason: `composer_chip_count_${composerChips.length}` };
        }

        return { attached: false, reason: 'no_slot_or_img' };
      }).catch(() => ({ attached: false, reason: 'eval_error' }));
    };

    // Step A: CRITICAL — Forcefully clear any stale frame chip from previous panel runs
    // so we never reuse Panel 1's image for Panel 2, 3, or 4!
    let isAttached = false;
    console.log(`[VideoGen-UI] 🔄 Ensuring clean start frame slot for ${searchName}...`);

    const slotHasChip = () => page.evaluate(() => {
      const ft = document.querySelector('div.frame-trigger');
      if (!ft) return false;
      return !!(ft.querySelector('flow-image-ingredient-chip') || ft.querySelector('img'));
    }).catch(() => false);

    for (let clearTry = 1; clearTry <= 4; clearTry++) {
      if (!(await slotHasChip())) {
        if (clearTry > 1) console.log(`[VideoGen-UI] ✅ Start frame slot is now empty (after ${clearTry - 1} clear attempt(s))`);
        break;
      }
      console.log(`[VideoGen-UI] 🗑️ Stale chip detected in start frame slot — clearing (try ${clearTry}/4)...`);

      // Hover chip first so hover-only remove buttons appear
      await page.locator('div.frame-trigger flow-image-ingredient-chip, div.frame-trigger').first().hover({ force: true, timeout: 1000 }).catch(() => {});
      await page.waitForTimeout(150);

      const cleared = await page.evaluate(() => {
        const matchesRemove = (el) => {
          const txt = (el.textContent || '').trim().toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const cls = (el.className || '').toString().toLowerCase();
          return txt === 'close' || txt === 'clear' || txt === 'cancel' ||
            aria.includes('xoá') || aria.includes('xóa') || aria.includes('remove') || aria.includes('clear') || aria.includes('delete') ||
            cls.includes('remove') || cls.includes('delete') || cls.includes('close');
        };
        // 1. Inside the frame-trigger / chip
        const ft = document.querySelector('div.frame-trigger');
        if (ft) {
          const els = Array.from(ft.querySelectorAll('button, [role="button"], mat-icon, i, span'));
          for (const el of els) {
            if (matchesRemove(el)) { (el.closest('button') || el).click(); return 'in-slot'; }
          }
        }
        // 2. Composer-level clear (the × at the top-right of the prompt box)
        const pm = document.querySelector('.ProseMirror');
        let scope = pm ? (pm.closest('flow-prompt-input, form, .composer') || pm.parentElement?.parentElement?.parentElement) : null;
        if (scope) {
          const els = Array.from(scope.querySelectorAll('button, [role="button"]'));
          for (const el of els) {
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            if (aria.includes('tạo') || aria.includes('generate')) continue;
            if (matchesRemove(el)) { el.click(); return 'composer'; }
          }
        }
        return null;
      }).catch(() => null);

      console.log(`[VideoGen-UI] 🗑️ Clear action result: ${cleared}`);
      await page.waitForTimeout(500);
    }

    // Attachment loop (up to 3 attempts)
    const MAX_ATTACH_RETRIES = 3;

    for (let attachAttempt = 1; attachAttempt <= MAX_ATTACH_RETRIES && !isAttached; attachAttempt++) {
      console.log(`[VideoGen-UI] 🎯 Start frame attachment attempt ${attachAttempt}/${MAX_ATTACH_RETRIES} for ${searchName}...`);

      // ONLY on retry (attempt > 1) do we check if a previous attempt within this call succeeded!
      // NEVER check on attempt 1, because attempt 1 must strictly attach THIS panel's new image!
      if (attachAttempt > 1) {
        const preCheck = await checkStartFrameAttached();
        if (preCheck.attached) {
          isAttached = true;
          console.log(`[VideoGen-UI] ✅ Start frame verified attached on retry (${preCheck.reason})!`);
          break;
        }
      }

      // 1. Click [ Bắt đầu ] (Start frame slot) to open asset picker dialog
      // STRICT: Must click div.frame-trigger button.empty-chip or button.empty-chip!
      // Must NEVER click the Submit button (which has aria-label="Bắt đầu tạo")!
      let slotClicked = false;

      // Strategy A: click the EMPTY slot only. Clicking a filled chip opens no picker.
      if (await slotHasChip()) {
        console.log('[VideoGen-UI] ⚠️ Slot still holds a chip before click — clearing again');
        await page.evaluate(() => {
          const ft = document.querySelector('div.frame-trigger');
          const els = ft ? Array.from(ft.querySelectorAll('button, [role="button"], mat-icon, i')) : [];
          for (const el of els) {
            const t = (el.textContent || '').trim().toLowerCase();
            const a = (el.getAttribute('aria-label') || '').toLowerCase();
            if (t === 'close' || a.includes('remove') || a.includes('xoá') || a.includes('xóa') || a.includes('clear')) {
              (el.closest('button') || el).click();
              return;
            }
          }
        }).catch(() => {});
        await page.waitForTimeout(500);
      }
      const slotLoc = page.locator('div.frame-trigger button.empty-chip, button.empty-chip, div.frame-trigger button:not(:has(img))').first();
      if (await slotLoc.isVisible({ timeout: 1500 }).catch(() => false)) {
        await slotLoc.click({ force: true, timeout: 3000 }).catch(() => {});
        slotClicked = true;
        console.log('[VideoGen-UI] ✅ Clicked [ Bắt đầu ] slot via locator');
        await page.waitForTimeout(800);
      }

      if (!slotClicked) {
        const clickSlotResult = await page.evaluate(() => {
          const isSubmitBtn = (el) => {
            if (!el) return false;
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            if (aria.includes('tạo') || aria.includes('generate')) return true;
            if (el.classList && (el.classList.contains('generate-icon-button') || el.classList.contains('submit-button'))) return true;
            const text = (el.innerText || el.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
            if (text.includes('arrow_forward') || text.includes('bắt đầu tạo') || text.includes('generate')) return true;
            return false;
          };

          // 1. div.frame-trigger button.empty-chip
          const ftChip = document.querySelector('div.frame-trigger button.empty-chip, button.empty-chip');
          if (ftChip && !isSubmitBtn(ftChip)) {
            ftChip.click();
            const r = ftChip.getBoundingClientRect();
            return { clicked: true, method: 'frame-trigger-empty-chip', x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }

          // 2. div.frame-trigger button
          const ft = document.querySelector('div.frame-trigger');
          if (ft) {
            const btn = ft.querySelector('button:not(.chip-container), button, [role="button"]') || ft;
            if (!isSubmitBtn(btn)) {
              btn.click();
              const r = btn.getBoundingClientRect();
              return { clicked: true, method: 'frame-trigger-btn', x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }
          }

          // 3. Button near ProseMirror with text "Bắt đầu"
          const pm = document.querySelector('.ProseMirror');
          if (pm) {
            const composerArea = pm.closest('flow-prompt-input, .composer, form') || pm.parentElement?.parentElement;
            if (composerArea) {
              const buttons = Array.from(composerArea.querySelectorAll('button, [role="button"]'));
              for (const b of buttons) {
                if (isSubmitBtn(b)) continue;
                const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                if (txt === 'bắt đầu' || txt === 'start') {
                  b.click();
                  const r = b.getBoundingClientRect();
                  return { clicked: true, method: 'composer-btn-start', x: r.left + r.width / 2, y: r.top + r.height / 2 };
                }
              }
            }
          }

          return { clicked: false };
        }).catch(() => ({ clicked: false }));

        if (clickSlotResult.clicked) {
          slotClicked = true;
          console.log(`[VideoGen-UI] ✅ Clicked [ Bắt đầu ] slot via DOM (${clickSlotResult.method})`);
          await page.waitForTimeout(800);
        }
      }

      // Check if asset picker modal opened
      let modalOpened = false;
      for (let mWait = 0; mWait < 10; mWait++) {
        modalOpened = await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('body > div, [role="dialog"], mat-dialog-container, .cdk-overlay-pane'));
          for (const el of candidates) {
            const r = el.getBoundingClientRect();
            if (r.width < 100 || r.height < 100) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const txt = (el.textContent || '').toLowerCase();
            if (
              txt.includes('chọn một hình ảnh khung') ||
              txt.includes('chọn một hình ảnh') ||
              txt.includes('select a frame image') ||
              txt.includes('thêm vào câu lệnh') ||
              txt.includes('add to prompt') ||
              txt.includes('tìm kiếm tài nguyên') ||
              txt.includes('search assets') ||
              txt.includes('search for assets') ||
              txt.includes('được dùng nhiều nhất') ||
              txt.includes('most used') ||
              txt.includes('mới nhất') ||
              txt.includes('newest')
            ) {
              return true;
            }
          }
          return false;
        }).catch(() => false);

        if (modalOpened) break;

        const addBtnCheck = page.locator('button:has-text("Thêm vào câu lệnh"), button:has-text("Add to prompt")').first();
        if (await addBtnCheck.isVisible({ timeout: 200 }).catch(() => false)) {
          modalOpened = true;
          break;
        }

        await page.waitForTimeout(300);
      }

      console.log(`[VideoGen-UI] 🪟 Asset picker modal opened: ${modalOpened ? 'YES' : 'NO'}`);

      // 3. Interact with modal
      if (modalOpened) {
        await page.waitForTimeout(500);

        // A. Ensure filter is set to "Mới nhất" (Newest) so newly uploaded panel image is at index 0
        try {
          const filterBtn = page.locator(
            '[role="dialog"] button, mat-dialog-container button, .cdk-overlay-pane button'
          ).filter({ hasText: /Gần đây|Mới nhất|Cũ nhất|Dùng nhiều nhất|Yêu thích|Most used|Newest/i }).first();
          if (await filterBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
            const currentText = (await filterBtn.innerText().catch(() => '')).toLowerCase();
            if (!currentText.includes('mới nhất') && !currentText.includes('newest')) {
              await filterBtn.click({ force: true }).catch(() => {});
              await page.waitForTimeout(400);
              const newestOption = page.locator('[role="menuitem"], [role="option"], button').filter({ hasText: /Mới nhất|Newest/i }).last();
              if (await newestOption.isVisible({ timeout: 1500 }).catch(() => false)) {
                await newestOption.click({ force: true }).catch(() => {});
                console.log('[VideoGen-UI] ⏱️ Switched asset filter to "Mới nhất" (Newest)');
                await page.waitForTimeout(800);
              } else {
                await page.keyboard.press('Escape').catch(() => {});
              }
            }
          }
        } catch (_) {}

        // B. Match & click the asset card
        const searchTerm = path.basename(searchName, path.extname(searchName));
        let cardClicked = false;

        // B1. Priority 1 & 2: Match by UUID or unique name in DOM (or click top item in "Mới nhất")
        try {
          const assetCardResult = await page.evaluate(({ uuid, term }) => {
            const candidates = Array.from(document.querySelectorAll('body > div, [role="dialog"], mat-dialog-container, .cdk-overlay-pane'));
            let modal = null;
            for (const el of candidates) {
              const r = el.getBoundingClientRect();
              if (r.width < 100 || r.height < 100) continue;
              const txt = (el.textContent || '').toLowerCase();
              if (txt.includes('hình ảnh') || txt.includes('frame') || txt.includes('thêm vào câu lệnh') || txt.includes('add to prompt') || txt.includes('chọn một hình ảnh') || txt.includes('select a frame')) {
                modal = el;
                break;
              }
            }
            if (!modal) modal = document;

            // 1. Try match uuid in img src / data attribute / outerHTML
            if (uuid) {
              const imgs = Array.from(modal.querySelectorAll('img'));
              for (const img of imgs) {
                const s = img.getAttribute('src') || img.src || '';
                if (s.includes(uuid)) {
                  (img.closest('[role="option"], [role="listitem"], button, mat-grid-tile') || img).click();
                  return { clicked: true, method: 'matched-uuid-src' };
                }
              }
              const tiles = Array.from(modal.querySelectorAll('[role="option"], [role="listitem"], mat-grid-tile, button'));
              for (const tile of tiles) {
                if (tile.outerHTML && tile.outerHTML.includes(uuid)) {
                  (tile.querySelector('img, button') || tile).click();
                  return { clicked: true, method: 'matched-uuid-outerhtml' };
                }
              }
            }

            // 2. Try match unique name in alt / title
            if (term) {
              const imgs = Array.from(modal.querySelectorAll('img'));
              for (const img of imgs) {
                const alt = (img.getAttribute('alt') || '').toLowerCase();
                const title = (img.getAttribute('title') || '').toLowerCase();
                if (alt.includes(term.toLowerCase()) || title.includes(term.toLowerCase())) {
                  (img.closest('[role="option"], [role="listitem"], button, mat-grid-tile') || img).click();
                  return { clicked: true, method: 'matched-unique-name' };
                }
              }
            }

            // 3. Click first item of list (under "Mới nhất", index 0 is our newly uploaded asset)
            const firstTile = modal.querySelector('[data-testid="virtuoso-scroller"] [data-index="0"], [role="option"] img, [role="listitem"] img, mat-grid-tile img, img.image, .asset-card img, .asset-item-container img, [role="listbox"] img, button img');
            if (firstTile) {
              (firstTile.closest('[role="option"], [role="listitem"], button') || firstTile).click();
              return { clicked: true, method: 'top-item' };
            }

            return { clicked: false, note: 'no_tile_found' };
          }, { uuid: targetId, term: searchTerm }).catch(() => ({ clicked: false }));

          if (assetCardResult && assetCardResult.clicked) {
            cardClicked = true;
            console.log(`[VideoGen-UI] 🎯 Asset card clicked via DOM (${assetCardResult.method}): ${targetId || searchTerm}`);
            await page.waitForTimeout(600);
          }
        } catch (_) {}

        // B2. If not clicked, try search input as fallback
        if (!cardClicked) {
          try {
            const searchInput = page.locator(
              '[role="dialog"] input[placeholder*="Tìm kiếm" i], [role="dialog"] input[placeholder*="Search" i], ' +
              'mat-dialog-container input[placeholder*="Tìm kiếm" i], mat-dialog-container input[placeholder*="Search" i], ' +
              '.cdk-overlay-pane input[placeholder*="Tìm kiếm" i], .cdk-overlay-pane input[placeholder*="Search" i], ' +
              '[role="dialog"] input[type="search"], [role="dialog"] input[type="text"]'
            ).first();

            if (await searchInput.isVisible({ timeout: 1500 }).catch(() => false)) {
              console.log(`[VideoGen-UI] 🔎 Fallback: Filtering modal assets by unique name: "${searchTerm}"...`);
              await searchInput.click().catch(() => {});
              await searchInput.fill(searchTerm).catch(() => {});
              await page.waitForTimeout(800);

              const cardLoc = page.locator(
                '[role="dialog"] [role="option"], ' +
                '[role="dialog"] [role="listitem"], ' +
                'mat-dialog-container [role="option"], ' +
                'mat-dialog-container [role="listitem"], ' +
                '.cdk-overlay-pane [role="option"], ' +
                '.cdk-overlay-pane [role="listitem"], ' +
                '[role="dialog"] button:has(img), ' +
                '[role="dialog"] .asset-item-container, ' +
                '[data-testid="virtuoso-scroller"] [data-index="0"]'
              ).first();

              if (await cardLoc.isVisible({ timeout: 1500 }).catch(() => false)) {
                await cardLoc.click({ force: true }).catch(() => {});
                cardClicked = true;
                console.log('[VideoGen-UI] 🃏 Clicked asset card after search filter');
                await page.waitForTimeout(600);
              } else {
                // Clear search input if no results found
                await searchInput.fill('').catch(() => {});
              }
            }
          } catch (sErr) {
            console.warn(`[VideoGen-UI] ⚠️ Search input fallback note: ${sErr.message}`);
          }
        }

        // B3. Final fallback locator
        if (!cardClicked) {
          try {
            const cardLoc = page.locator(
              '[role="dialog"] [role="option"], ' +
              '[role="dialog"] [role="listitem"], ' +
              'mat-dialog-container [role="option"], ' +
              'mat-dialog-container [role="listitem"], ' +
              '.cdk-overlay-pane [role="option"], ' +
              '.cdk-overlay-pane [role="listitem"], ' +
              '[role="dialog"] button:has(img), ' +
              '[role="dialog"] .asset-item-container, ' +
              '[data-testid="virtuoso-scroller"] [data-index="0"]'
            ).first();

            if (await cardLoc.isVisible({ timeout: 1500 }).catch(() => false)) {
              await cardLoc.click({ force: true }).catch(() => {});
              cardClicked = true;
              console.log('[VideoGen-UI] 🃏 Clicked top asset card via fallback locator');
              await page.waitForTimeout(600);
            }
          } catch (_) {}
        }

        // Click "Add to prompt" / "Thêm vào câu lệnh"
        console.log('[VideoGen-UI] 🔘 Waiting for and clicking "Thêm vào câu lệnh"...');
        let addClicked = false;
        const addBtnLoc = page.locator(
          '[role="dialog"] button, mat-dialog-container button, .cdk-overlay-pane button, body button'
        ).filter({ hasText: /Thêm vào câu lệnh|Add to prompt|Thêm vào lời nhắc|Thêm vào|Chọn|Select/i }).last();

        if (await addBtnLoc.isVisible({ timeout: 4000 }).catch(() => false)) {
          await addBtnLoc.click({ force: true, timeout: 3000 }).catch(() => {});
          addClicked = true;
          console.log('[VideoGen-UI] ✅ Clicked "Thêm vào câu lệnh" button via locator!');
          await page.waitForTimeout(1000);
        }

        if (!addClicked) {
          const addBtnResult = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, [role="button"], .add-to-prompt-button'));
            for (const b of btns) {
              const t = (b.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
              if (
                t === 'add to prompt' ||
                t.includes('add to prompt') ||
                t.includes('thêm vào câu lệnh') ||
                t.includes('thêm vào lời nhắc') ||
                t.includes('thêm vào') ||
                t === 'chọn' ||
                t === 'select'
              ) {
                b.click();
                return t;
              }
            }
            return null;
          }).catch(() => null);

          if (addBtnResult) {
            addClicked = true;
            console.log(`[VideoGen-UI] 🔘 Clicked "${addBtnResult}" button via DOM eval!`);
            await page.waitForTimeout(1000);
          }
        }

        // Wait for modal to close naturally
        for (let waitClose = 0; waitClose < 8; waitClose++) {
          const modalStillOpen = await page.evaluate(() => {
            const candidates = Array.from(document.querySelectorAll('body > div, [role="dialog"], mat-dialog-container, .cdk-overlay-pane'));
            for (const el of candidates) {
              const r = el.getBoundingClientRect();
              if (r.width < 100 || r.height < 100) continue;
              const txt = (el.textContent || '').toLowerCase();
              if (txt.includes('chọn một hình ảnh khung') || txt.includes('select a frame image') || txt.includes('thêm vào câu lệnh')) {
                return true;
              }
            }
            return false;
          }).catch(() => false);

          if (!modalStillOpen) break;
          await page.waitForTimeout(300);
        }

        // Close via Escape if still open
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(400);
      }

      // Check start frame attachment in DOM
      const check = await checkStartFrameAttached();
      if (check.attached) {
        isAttached = true;
        console.log(`[VideoGen-UI] 🖼️ Start frame attachment verification: ✅ CONFIRMED ATTACHED (${check.reason})!`);
        break;
      }

      console.warn(`[VideoGen-UI] ⚠️ Start frame not attached yet (${check.reason}) — retrying...`);
      await page.waitForTimeout(1000);
    }



    // STRICT ENFORCEMENT: If start frame is not attached, ABORT GENERATION!
    if (!isAttached) {
      console.error(`[VideoGen-UI] ❌ CRITICAL: Failed to attach Start Frame image (${searchName}) to [ Bắt đầu ] slot after all retries!`);
      throw new Error(`[VideoGen-UI] Start frame image (${searchName}) could not be attached to [ Bắt đầu ] slot in Flow UI. Aborting to avoid generating Text-to-Video.`);
    }
  }

  // 4. Fill prompt
  console.log('[VideoGen-UI] ✍️ Typing video prompt...');
  const promptEditorResult = await page.evaluate(async (promptText) => {
    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      return r.width > 20; // Don't require strict height or top inside compact/mini window
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

    editor.scrollIntoView({ block: 'nearest' });
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

    const text = (editor.innerText || editor.textContent || editor.value || '').trim();
    return {
      found: true,
      textLength: text.length,
      textSnippet: text.substring(0, 50),
      top: editor.getBoundingClientRect().top
    };
  }, prompt).catch(() => ({ found: false }));

  console.log(`[VideoGen-UI] ✍️ DOM prompt insertion: found=${promptEditorResult?.found}, len=${promptEditorResult?.textLength || 0}, snippet="${promptEditorResult?.textSnippet || ''}"`);

  // Fallback via Playwright locator if text didn't stick
  const editorLocator = page.locator('.ProseMirror, [contenteditable="true"]').filter({
    hasNot: page.locator('input[placeholder*="search" i]')
  }).last();

  if (await editorLocator.isVisible().catch(() => false)) {
    if (!promptEditorResult?.textLength || promptEditorResult.textLength < 10) {
      await editorLocator.scrollIntoViewIfNeeded().catch(() => {});
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

  // Verify prompt is in the editor
  const finalEditorText = await page.evaluate(() => {
    const editors = Array.from(document.querySelectorAll('.ProseMirror, [contenteditable="true"], textarea'))
      .filter(el => !el.closest('header, [role="banner"], flow-app-bar, flow-header, nav, .header'))
      .filter(el => {
        const ph = (el.getAttribute('placeholder') || '').toLowerCase();
        return !ph.includes('search') && !ph.includes('tìm');
      });
    for (const ed of editors) {
      const txt = (ed.innerText || ed.textContent || ed.value || '').trim();
      if (txt.length > 0) return txt;
    }
    if (editors.length === 0) return '';
    editors.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return (editors[0].innerText || editors[0].textContent || editors[0].value || '').trim();
  }).catch(() => '');
  console.log(`[VideoGen-UI] ✍️ Final prompt in editor (${finalEditorText.length} chars): "${finalEditorText.substring(0, 60)}..."`);

  // 5. Click generate button & submit
  console.log('[VideoGen-UI] 🚀 Submitting video generation...');

  // Wait for submit button to be enabled (up to 8s)
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
        if (aria === 'bắt đầu tạo' || aria === 'generate' || aria === 'tạo video' || aria === 'gửi' || aria === 'tạo') {
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
      console.log(`[VideoGen-UI] ✅ Submit button clicked via DOM eval (${status.type})!`);
      break;
    }

    if (status.found && !status.enabled) {
      // Button found but not yet enabled — wait for Flow state to update
      await page.waitForTimeout(500);
      continue;
    }

    await page.waitForTimeout(500);
  }

  // Also try Playwright locator click on arrow button as backup
  if (!submitClicked) {
    const arrowLoc = page.locator('button:has(.google-symbols:has-text("arrow_forward")), button:has(i:has-text("arrow_forward")), button[aria-label="Bắt đầu tạo"], button.generate-icon-button').last();
    if (await arrowLoc.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('[VideoGen-UI] 🖱️ Attempting locator click on arrow submit button...');
      await arrowLoc.click({ force: true, timeout: 3000 }).catch(() => {});
      submitClicked = true;
    }
  }

  // Universal Flow submit shortcut: focus editor and press Enter
  console.log('[VideoGen-UI] ⌨️ Pressing Enter on composer editor to trigger submission...');
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

  // Backup Enter press after 2s if response not received yet
  setTimeout(async () => {
    try {
      if (!mediaName && !page.isClosed()) {
        console.log('[VideoGen-UI] ⏳ Backup Enter press dispatched...');
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
        await page.keyboard.press('Enter').catch(() => {});
      }
    } catch (_) {}
  }, 2000);

  console.log('[VideoGen-UI] ⏳ Submitted video prompt in Flow UI! Waiting for response...');
  const resultMediaName = await rpcPromise;
  if (resultMediaName) {
    console.log(`[VideoGen-UI] ✅ Video generation dispatched via Flow UI! Media: ${resultMediaName}`);
    const wiz = await page.evaluate(() => {
      const w = window.WIZ_global_data || {};
      return {
        at: w.SNlM0e || '',
        fsid: w.FdrFJe || '',
        bl: w.cfb2h || 'boq_labs-ai-sandbox-frontend_20260917.00_p0',
        projectId: w.PROJECT_ID || ''
      };
    }).catch(() => null);
    return { media: [{ name: resultMediaName, projectId: targetProjectId }], wiz: { ...(wiz || {}), projectId: targetProjectId } };
  }

  return null;
}

async function startMultiImageVideoGeneration(page, context, {
  prompt,
  imageMediaIds = [],
  imageBuffers = [],      // raw Buffer[] matching imageMediaIds order for UI file-input upload
  imageNames = [],        // filenames for each buffer
  aspectRatio = '9:16',
  videoModelKey = 'abra_r2v_8s',
  voiceId = null,
  projectId = null,
  outputCount = 1,
  useProxy = true,
}) {
  const targetProjectId = projectId || (page ? extractProjectIdFromPage(page) : PROJECT_ID);

  // eb1hJf uses abra_i2v_4s / abra_i2v_8s (i2v = image-to-video)
  const rawModel = String(videoModelKey || '').toLowerCase();
  const modelKey = rawModel.includes('4s') ? 'abra_i2v_4s' : 'abra_i2v_8s';

  console.log(`[VideoGen-Multi] 🎬 Starting video generation via Flow UI (model: ${modelKey}, outputCount: ${outputCount || 1})...`);
  console.log(`[VideoGen-Multi]   prompt: "${prompt.substring(0, 80)}..."`);
  console.log(`[VideoGen-Multi]   imageMediaIds: ${imageMediaIds.join(', ')}`);

  // Google blocks ALL programmatic fetch() calls to eb1hJf/MZZa6b with PUBLIC_ERROR_UNUSUAL_ACTIVITY.
  // The ONLY working approach: let Flow Angular app send eb1hJf natively via real UI interaction.
  if (!page || page.isClosed()) {
    throw new Error('[VideoGen-Multi] No Playwright page available — cannot use UI approach');
  }

  const uiResult = await startVideoGenerationViaUI({
    page,
    prompt,
    imageMediaIds,
    imageBuffer: imageBuffers[0] || null,
    imageName: imageNames[0] || 'panel.png',
    aspectRatio,
    videoModelKey: modelKey,
    targetProjectId,
    outputCount: Number(outputCount) || 1,
    useProxy,
  });

  if (uiResult && uiResult.media?.[0]?.name) {
    console.log(`[VideoGen-Multi] ✅ Video generation started via Flow UI! Media: ${uiResult.media[0].name}`);
    return uiResult;
  }

  throw new Error('[VideoGen-Multi] Flow UI video generation timed out — eb1hJf response not captured.');
}


async function fetchFlowVideoUrlViaAs29s(context, mediaName, wiz, customProjectId = null) {
  const targetProjectId = customProjectId || wiz?.projectId || PROJECT_ID;
  const reqId = Math.floor(Math.random() * 900000) + 100000;
  const rpcUrl = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=as29s&source-path=${encodeURIComponent('/project/' + targetProjectId)}&bl=${encodeURIComponent(wiz?.bl || 'boq_labs-ai-sandbox-frontend_20260903.13_p1')}&f.sid=${encodeURIComponent(wiz?.fsid || '')}&hl=vi&_reqid=${reqId}&rt=c`;

  const innerPayload = [mediaName];
  const fReq = JSON.stringify([[["as29s", JSON.stringify(innerPayload), null, "generic"]]]);
  const bodyParams = new URLSearchParams();
  bodyParams.set('f.req', fReq);
  if (wiz?.at) bodyParams.set('at', wiz.at);

  const resp = await context.request.fetch(rpcUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'origin': 'https://flow.google.com',
      'referer': 'https://flow.google.com/',
      'x-same-domain': '1'
    },
    data: bodyParams.toString(),
    timeout: 30000
  });

  if (resp.status() !== 200) {
    throw new Error(`as29s returned HTTP ${resp.status()}`);
  }

  const text = await resp.text();
  let videoUrl = null;

  // 1. First try parsing the batchexecute JSON cleanly
  const parsedInner = parseBatchExecuteResponse(text, 'as29s');
  if (parsedInner) {
    function findUrl(curr) {
      if (!curr || videoUrl) return;
      if (typeof curr === 'string' && curr.includes('flow-content.google/video/')) {
        videoUrl = curr;
        return;
      }
      if (Array.isArray(curr)) {
        for (const el of curr) findUrl(el);
      } else if (typeof curr === 'object') {
        for (const k of Object.keys(curr)) findUrl(curr[k]);
      }
    }
    findUrl(parsedInner);
  }

  // 2. Fallback to regex extraction without stopping at backslashes
  if (!videoUrl) {
    const match = text.match(/https:(?:\\\/|\/)+flow-content\.google\/video\/[^"\s]+/i);
    if (match) {
      let raw = match[0];
      raw = raw.replace(/\\\/|\//g, '/');
      raw = raw.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
      raw = raw.replace(/[\\]+$/g, '');
      videoUrl = raw;
    }
  }

  if (!videoUrl) {
    throw new Error(`Could not extract video URL from as29s response: ${text.substring(0, 400)}`);
  }

  return videoUrl;
}

async function pollFlowVideoStatusStandalone({ context, mediaName, wiz, options = {} }) {
  console.log(`[VideoGen] 🌊 Polling Flow video status via jwpduf RPC for: ${mediaName}...`);
  const maxPolls = options.maxPolls || 120;
  const delay = ms => new Promise(r => setTimeout(r, ms));

  for (let i = 0; i < maxPolls; i++) {
    await delay(5000);

  const targetProjectId = options?.projectId || wiz?.projectId || PROJECT_ID;
  const reqId = Math.floor(Math.random() * 900000) + 100000;
  const rpcUrl = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=jwpduf&source-path=${encodeURIComponent('/project/' + targetProjectId)}&bl=${encodeURIComponent(wiz?.bl || 'boq_labs-ai-sandbox-frontend_20260903.13_p1')}&f.sid=${encodeURIComponent(wiz?.fsid || '')}&hl=vi&_reqid=${reqId}&rt=c`;

    const innerPayload = [null, null, [[mediaName]]];
    const fReq = JSON.stringify([[["jwpduf", JSON.stringify(innerPayload), null, "generic"]]]);
    const bodyParams = new URLSearchParams();
    bodyParams.set('f.req', fReq);
    if (wiz?.at) bodyParams.set('at', wiz.at);

    try {
      const resp = await context.request.fetch(rpcUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'origin': 'https://flow.google.com',
          'referer': 'https://flow.google.com/',
          'x-same-domain': '1'
        },
        data: bodyParams.toString(),
        timeout: 30000
      });

      if (resp.status() !== 200) {
        console.log(`[VideoGen] Flow jwpduf status check HTTP ${resp.status()}, retrying...`);
        continue;
      }

      const respText = await resp.text();
      const parsedInner = parseBatchExecuteResponse(respText, 'jwpduf');
      if (!parsedInner) continue;

      const items = parsedInner[2] || [];
      const extractUuid = (val) => {
        if (!val || typeof val !== 'string') return null;
        const m = val.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        return m ? m[0].toLowerCase() : null;
      };

      const targetUuid = extractUuid(mediaName);
      const item = items.find(it => {
        if (!it) return false;
        const itemId = it[0];
        if (itemId === mediaName) return true;
        if (typeof itemId === 'string' && typeof mediaName === 'string') {
          if (itemId.includes(mediaName) || mediaName.includes(itemId)) return true;
        }
        if (targetUuid && extractUuid(itemId) === targetUuid) return true;
        return false;
      });

      if (!item) {
        if ((i + 1) % 6 === 0) {
          console.log(`[VideoGen] Waiting for media ${mediaName} in Flow jwpduf items (${items.length} items present)...`);
        }
        continue;
      }

      const meta = item[5] || [];
      const statusArr = Array.isArray(meta[8]) ? meta[8] : meta.find(x => Array.isArray(x) && typeof x[0] === 'number');
      const statusCode = statusArr ? statusArr[0] : null;

      if (statusCode === 3) {
        console.log(`[VideoGen] ✅ Flow video completed via jwpduf after ${(i + 1) * 5}s!`);
        const resolvedMediaName = (typeof item[0] === 'string' && item[0].length > 0) ? item[0] : mediaName;
        const videoUrl = await fetchFlowVideoUrlViaAs29s(context, resolvedMediaName, wiz, targetProjectId);
        console.log(`[VideoGen] Resolved Flow video URL: ${videoUrl.substring(0, 80)}...`);
        return {
          name: resolvedMediaName,
          videoUrl,
          fifeUrl: videoUrl,
          mediaMetadata: {
            mediaStatus: {
              mediaGenerationStatus: 'MEDIA_GENERATION_STATUS_SUCCESSFUL'
            }
          }
        };
      }

      if (statusCode === 4 || statusCode === 5) {
        const errorMsg = statusArr?.[1]?.[1] || statusArr?.[2]?.[0] || `code: ${statusCode}`;
        throw new Error(`[VideoGen] ❌ Flow video generation failed on server (${errorMsg})`);
      }

      if ((i + 1) % 6 === 0) {
        console.log(`[VideoGen] Still generating (Flow jwpduf)... ${(i + 1) * 5}s elapsed (statusCode: ${statusCode || 'pending'}).`);
      }
    } catch (e) {
      if (e.message.includes('failed on server')) throw e;
      console.log(`[VideoGen] Flow poll error: ${e.message}, retrying...`);
    }
  }

  throw new Error('[VideoGen] ❌ Timeout after 10 minutes (Flow jwpduf).');
}

// Uses cached bearerToken + context.request.fetch, with Flow RPC support
// ═══════════════════════════════════════════════════════════════
async function pollVideoStatusStandalone(context, bearerToken, mediaName, options = {}) {
  if (options.isFlowRpc) {
    return await pollFlowVideoStatusStandalone({ context, mediaName, wiz: options.wiz, options });
  }
  console.log(`[VideoGen] Polling video status (standalone) for: ${mediaName}...`);

  const statusUrl = 'https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus';
  const maxPolls = 120;
  const requireVideoUrl = options.requireVideoUrl !== false;
  const debugPrefix = options.debugPrefix || '[VideoGen]';
  const delay = ms => new Promise(r => setTimeout(r, ms));

  const targetProjectId = options.projectId || PROJECT_ID;

  for (let i = 0; i < maxPolls; i++) {
    await delay(5000);

    const statusBody = {
      media: [{ name: mediaName, projectId: targetProjectId }]
    };

    try {
      const response = await context.request.fetch(statusUrl, {
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
        data: JSON.stringify(statusBody),
        timeout: 30000
      });

      const status = response.status();
      const body = await response.text();

      if (status !== 200) {
        console.log(`[VideoGen] Status check HTTP ${status}, retrying...`);
        continue;
      }

      const result = JSON.parse(body);
      const media = result.media?.[0];
      if (!media) {
        if ((i + 1) % 6 === 0) {
          console.log(`${debugPrefix} Status poll ${(i + 1) * 5}s: no media in response. topKeys=${Object.keys(result || {}).join(',')}`);
        }
        continue;
      }

      const genStatus = media.mediaMetadata?.mediaStatus?.mediaGenerationStatus;

      if (genStatus === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
        const videoUrl = findFifeUrl(media) || findFifeUrl(result);
        if (requireVideoUrl && !videoUrl) {
          if ((i + 1) % 3 === 0) {
            console.log(`${debugPrefix} Status successful but video URL not ready yet... ${(i + 1) * 5}s elapsed.`);
            console.log(`${debugPrefix} Status snapshot: ${summarizeVideoStatusResponse(result, media)}`);
          }
          continue;
        }
        console.log(`[VideoGen] ✅ Video completed after ${(i + 1) * 5}s`);
        if (videoUrl) {
          console.log(`${debugPrefix} Resolved video URL: ${sanitizeUrlForLog(videoUrl)}`);
        } else {
          console.log(`${debugPrefix} Status successful; resolving media URL via Flow redirect endpoint.`);
        }
        return videoUrl && !findFifeUrl(media) ? result : media;
      }
      if (genStatus === 'MEDIA_GENERATION_STATUS_FAILED') {
        const failureStr = JSON.stringify(media.mediaMetadata?.mediaStatus || {});
        if (failureStr.includes('Media not found.') && options.wiz) {
          console.log(`[VideoGen] 🔄 aisandbox returned "Media not found." — switching to Flow jwpduf RPC for: ${mediaName}...`);
          return await pollFlowVideoStatusStandalone({ context, mediaName, wiz: options.wiz, options });
        }
        console.log(`${debugPrefix} Failed status snapshot: ${summarizeVideoStatusResponse(result, media)}`);
        throw new Error(`[VideoGen] ❌ Video generation failed on server`);
      }
      if ((i + 1) % 12 === 0) {
        console.log(`[VideoGen] Still generating... ${(i + 1) * 5}s elapsed. Status: ${genStatus || 'unknown'}`);
      }
    } catch (e) {
      if (e.message.includes('failed on server')) throw e;
      console.log(`[VideoGen] Status check error: ${e.message}, retrying...`);
    }
  }
  throw new Error('[VideoGen] ❌ Timeout after 10 minutes.');
}

// ═══════════════════════════════════════════════════════════════
// Extend video via API (batchAsyncGenerateVideoExtendVideo)
// ═══════════════════════════════════════════════════════════════

const EXTEND_MODEL_MAP = {
  'VIDEO_ASPECT_RATIO_PORTRAIT': 'veo_3_1_extend_portrait',
  'VIDEO_ASPECT_RATIO_LANDSCAPE': 'veo_3_1_extend_landscape',
  'VIDEO_ASPECT_RATIO_SQUARE': 'veo_3_1_extend_square',
};

async function extendVideo(page, context, {
  extendPrompt,
  videoMediaId,
  workflowId,
  aspectRatio = 'VIDEO_ASPECT_RATIO_PORTRAIT',
  projectId = null
}) {
  console.log(`[VideoGen] Extending video via API...`);
  console.log(`[VideoGen]   videoMediaId: ${videoMediaId}`);
  console.log(`[VideoGen]   workflowId: ${workflowId}`);
  console.log(`[VideoGen]   extendPrompt: "${extendPrompt.substring(0, 80)}..."`);

  // Reload page for fresh reCAPTCHA context
  await page.goto(PROJECT_URL);
  await page.waitForTimeout(5000);

  const bearerToken = await ensureBearerToken(page);
  const recaptchaToken = await getRecaptchaToken(page, 'VIDEO_GENERATION');

  const extendModelKey = EXTEND_MODEL_MAP[aspectRatio] || 'veo_3_1_extend_portrait';
  const seed = Math.floor(Math.random() * 100000);
  const sessionId = `;${Date.now()}`;
  const batchId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const targetProjectId = projectId || (page ? extractProjectIdFromPage(page) : PROJECT_ID);

  const requestBody = {
    mediaGenerationContext: {
      batchId: batchId,
      audioFailurePreference: 'BLOCK_SILENCED_VIDEOS'
    },
    clientContext: {
      projectId: targetProjectId,
      tool: 'PINHOLE',
      userPaygateTier: 'PAYGATE_TIER_TWO',
      sessionId: sessionId,
      recaptchaContext: {
        token: recaptchaToken,
        applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB'
      }
    },
    requests: [{
      aspectRatio: aspectRatio,
      seed: seed,
      textInput: {
        structuredPrompt: {
          parts: [{ text: extendPrompt }]
        }
      },
      videoModelKey: extendModelKey,
      metadata: {
        workflowId: workflowId
      },
      videoInput: {
        mediaId: videoMediaId
      }
    }],
    useV2ModelConfig: true
  };

  const apiUrl = 'https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoExtendVideo';

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
    timeout: 60000
  });

  const status = response.status();
  const body = await response.text();

  if (status !== 200) {
    throw new Error(`[VideoGen] Extend API returned HTTP ${status}: ${body.substring(0, 500)}`);
  }

  const result = JSON.parse(body);
  const extendMediaName = result.media?.[0]?.name;
  if (!extendMediaName) {
    throw new Error('[VideoGen] Could not extract media name from extend API response');
  }

  console.log(`[VideoGen] ✅ Extend started! Media name: ${extendMediaName}`);
  return extendMediaName;
}

// ═══════════════════════════════════════════════════════════════
// Concatenate Videos API
// ═══════════════════════════════════════════════════════════════
function collectVideoUrlCandidates(obj) {
  const seen = new Set();
  const candidates = [];

  const visit = (value, keyPath = '') => {
    if (!value) return;

    if (typeof value === 'string') {
      const str = value.trim();
      if (!/^https?:\/\//i.test(str)) return;

      const key = keyPath.toLowerCase();
      let score = 0;
      if (key.endsWith('fifeurl') || key.includes('.fifeurl')) score += 100;
      if (/video|movie|mp4|download|playback|source|generated/.test(key)) score += 40;
      if (/\.mp4(\?|$)/i.test(str)) score += 30;
      if (/videoplayback|fife|googleusercontent|googlevideo/i.test(str)) score += 20;
      if (/thumbnail|thumb|image|poster/i.test(key)) score -= 50;
      if (score > 0) candidates.push({ url: str, score });
      return;
    }

    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    for (const [key, child] of Object.entries(value)) {
      visit(child, keyPath ? `${keyPath}.${key}` : key);
    }
  };

  visit(obj);
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function sanitizeUrlForLog(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.substring(0, 120)}${parsed.search ? '?…' : ''}`;
  } catch (_) {
    return String(url).substring(0, 160);
  }
}

function summarizeVideoStatusResponse(result, media) {
  const candidates = collectVideoUrlCandidates(result)
    .slice(0, 5)
    .map(item => `${item.score}:${sanitizeUrlForLog(item.url)}`);
  return JSON.stringify({
    status: media?.mediaMetadata?.mediaStatus?.mediaGenerationStatus || null,
    error: media?.mediaMetadata?.mediaStatus?.error || null,
    failureReasons: media?.mediaMetadata?.mediaStatus?.failureReasons || null,
    candidates
  }).substring(0, 1500);
}

function findFifeUrl(obj) {
  const candidates = collectVideoUrlCandidates(obj);
  return candidates[0]?.url || null;
}

async function resolveFlowMediaUrl(context, mediaName, mediaUrlType = '') {
  const url = new URL('https://labs.google/fx/api/trpc/media.getMediaUrlRedirect');
  url.searchParams.set('name', mediaName);
  if (mediaUrlType) url.searchParams.set('mediaUrlType', mediaUrlType);

  const response = await context.request.fetch(url.toString(), {
    method: 'GET',
    maxRedirects: 0,
    headers: {
      'Referer': 'https://labs.google/fx/',
      'Origin': 'https://labs.google',
    },
    timeout: 30000,
  });

  const status = response.status();
  const location = response.headers().location;
  if (status >= 300 && status < 400 && location) return location;

  const body = await response.text().catch(() => '');
  throw new Error(`[VideoGen] Could not resolve Flow media URL for ${mediaName}. HTTP ${status}: ${body.substring(0, 300)}`);
}

async function concatenateVideos(page, context, mediaId1, mediaId2) {
  const uuid1 = mediaId1.split('/').pop();
  const uuid2 = mediaId2.split('/').pop();
  console.log(`[VideoGen] Concatenating videos: ${uuid1} + ${uuid2}...`);
  const bearerToken = await ensureBearerToken(page);

  const concatUrl = 'https://aisandbox-pa.googleapis.com/v1:runVideoFxConcatenation';
  const concatBody = {
    inputVideos: [
      { mediaGenerationId: uuid1, lengthNanos: 8000, startTimeOffset: "0s", endTimeOffset: "8s" },
      { mediaGenerationId: uuid2, lengthNanos: 8000, startTimeOffset: "1s", endTimeOffset: "8s" }
    ]
  };

  let res = await context.request.fetch(concatUrl, {
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
    data: JSON.stringify(concatBody)
  });

  let json = await res.json();
  const operationName = json.name || json.operation?.name || (json.operation && json.operation.operation ? json.operation.operation.name : null);
  if (!operationName) throw new Error("[VideoGen] Could not find operation name for concatenation: " + JSON.stringify(json));

  console.log(`[VideoGen] Concatenation started: ${operationName}`);

  const statusUrl = 'https://aisandbox-pa.googleapis.com/v1:runVideoFxCheckConcatenationStatus';
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(5000);
    const token = await ensureBearerToken(page);

    res = await context.request.fetch(statusUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://labs.google',
        'Referer': 'https://labs.google/',
        'x-browser-channel': 'stable',
        'x-browser-copyright': 'Copyright 2026 Google LLC. All Rights Reserved.',
        'x-browser-year': '2026'
      },
      data: JSON.stringify({ operation: { operation: { name: operationName } } })
    });

    json = await res.json();

    if (json.status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' && json.encodedVideo) {
      console.log(`[VideoGen] ✅ Concatenation complete!`);
      return { base64: json.encodedVideo };
    } else if (json.status === 'MEDIA_GENERATION_STATUS_FAILED' || json.error) {
      throw new Error("[VideoGen] Concatenation failed: " + JSON.stringify(json));
    }

    console.log(`[VideoGen] Concatenation status: ${json.status || 'PENDING'}...`);
  }
  throw new Error("[VideoGen] Concatenation timed out");
}

// ═══════════════════════════════════════════════════════════════
// PHASE 1: Setup + Start API (needs browser page lock)
// ═══════════════════════════════════════════════════════════════
async function prepareVideoGeneration(page, prompt, extendPrompt, filePayloads, config, baseDir) {
  const { imageSelection } = config;
  const context = getContext() || (page ? page.context() : null);
  if (!context) throw new Error('[VideoGen] Browser context not available');

  console.log('[VideoGen] Step 1: Getting Bearer token (optional for Flow native RPC)...');
  let bearerToken = null;
  try {
    bearerToken = await ensureBearerToken(page, false, { optional: true, quick: true });
  } catch (tErr) {
    console.warn(`[VideoGen] ⚠️ Bearer token capture note: ${tErr.message} (will proceed with Flow native RPC)`);
  }

  const isMulti = Boolean(
    config.multiImageMode ||
    (filePayloads && filePayloads.length > 1) ||
    (config.videoModelKey && (config.videoModelKey.includes('r2v') || config.videoModelKey.includes('abra')))
  );
  const MAX_RETRIES = 11;
  let mediaName = null;

  const targetProjectId = config.projectId || (page ? extractProjectIdFromPage(page) : PROJECT_ID);

  if (isMulti) {
    console.log(`[VideoGen-Multi] Preparing multi-image video generation with ${filePayloads.length} images (project: ${targetProjectId})...`);
    const imageMediaIds = [];
    for (let i = 0; i < filePayloads.length; i++) {
      const f = filePayloads[i];
      if (f.mediaId) {
        imageMediaIds.push(f.mediaId);
        console.log(`[VideoGen-Multi] Using provided mediaId [${i + 1}/${filePayloads.length}]: ${f.mediaId} (${f.name || 'image'})`);
      } else if (f.buffer) {
        console.log(`[VideoGen-Multi] Uploading reference image [${i + 1}/${filePayloads.length}]: ${f.name || ('image-' + i)}...`);
        const mid = await uploadImageDirect(context, bearerToken, f.buffer, page, baseDir, targetProjectId, f.name || `panel-${i + 1}.png`, f.mimeType || 'image/png');
        imageMediaIds.push(mid);
        f.mediaId = mid;
        console.log(`[VideoGen-Multi] ✅ Uploaded [${i + 1}/${filePayloads.length}]: ${mid}`);
        if (page && typeof page.waitForTimeout === 'function') {
          await page.waitForTimeout(1500);
        }
      }
    }

    if (imageMediaIds.length === 0) {
      throw new Error('[VideoGen-Multi] No valid reference image IDs could be resolved or uploaded');
    }

    // Build imageBuffers + imageNames from filePayloads for UI file-input upload
    const imageBuffers = filePayloads.map(f => f.buffer || null).filter(Boolean);
    const imageNames = filePayloads.map((f, i) => f.name || `panel-${i + 1}.png`);

    let wiz = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[VideoGen-Multi] Start attempt ${attempt}/${MAX_RETRIES}...`);
        const apiResult = await startMultiImageVideoGeneration(page, context, {
          prompt,
          imageMediaIds,
          imageBuffers,
          imageNames,
          aspectRatio: config.aspectRatio || '9:16',
          videoModelKey: config.videoModelKey || 'abra_r2v_8s',
          voiceId: config.voiceId !== undefined ? config.voiceId : (config.hasVoice ? 'laomedeia' : null),
          projectId: targetProjectId,
          outputCount: config.outputCount || 1,
          useProxy: config.useProxy !== false,
        });
        mediaName = apiResult?.media?.[0]?.name;
        wiz = apiResult?.wiz;
        if (!mediaName) throw new Error('[VideoGen-Multi] No media name in MZZa6b/eb1hJf response');
        console.log(`[VideoGen-Multi] ✅ Started! Media: ${mediaName}`);
        break;
      } catch (err) {
        console.log(`[VideoGen-Multi] ❌ Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt >= MAX_RETRIES) throw err;

        try {
          const nextP = rotateProxy();
          const targetLog = nextP.isDirect ? 'DIRECT (Mặc định)' : `proxy #${nextP.index + 1}/${nextP.proxyCount || nextP.total} (${nextP.host}:${nextP.port})`;
          console.log(`[VideoGen-Multi] 🔄 Chuyển sang kết nối: ${targetLog}`);
        } catch (_) {}

        console.log(`[VideoGen-Multi] ⏳ Cooldown 3s & reloading Flow project page (${targetProjectId}) for new proxy session...`);
        await new Promise(r => setTimeout(r, 3000));
        if (page && !page.isClosed()) {
          try {
            const projectUrl = `https://flow.google.com/project/${targetProjectId}`;
            const currentUrl = page.url();
            if (currentUrl.includes(`/project/${targetProjectId}`)) {
              await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
            } else {
              await page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            }
            await page.waitForTimeout(3000);
          } catch (rErr) {
            console.warn(`[VideoGen-Multi] ⚠️ Page reload warning: ${rErr.message}`);
          }
        }
      }
    }

    console.log(`[VideoGen] ✅ Setup complete — releasing browser lock.`);
    return { context, bearerToken, mediaName, prompt, extendPrompt, config, wiz, isFlowRpc: true, imageMediaIds };
  } else {
    // Single image mode (legacy)
    let startImageMediaId = null;
    if (filePayloads && filePayloads.length > 0) {
      if (filePayloads[0].mediaId) {
        startImageMediaId = filePayloads[0].mediaId;
        console.log(`[VideoGen] Using provided start image mediaId: ${startImageMediaId}`);
      } else {
        console.log(`[VideoGen] Step 2: Direct uploading start image: ${filePayloads[0].name}...`);
        startImageMediaId = await uploadImageDirect(context, bearerToken, filePayloads[0].buffer, page, baseDir, targetProjectId, filePayloads[0].name || 'panel.png', filePayloads[0].mimeType || 'image/png');
        console.log(`[VideoGen] ✅ Direct upload success: ${startImageMediaId}`);
        filePayloads[0].mediaId = startImageMediaId;
        if (page && typeof page.waitForTimeout === 'function') {
          await page.waitForTimeout(1500);
        }
      }
    } else {
      const selections = imageSelection;
      if (selections && selections.length > 0) {
        const sel = selections[0];
        console.log(`[VideoGen] Resolving start image: "${sel}"...`);
        if (sel.startsWith('name:')) {
          startImageMediaId = await findImageUUID(page, sel.split('name:')[1], 'video');
        } else if (sel.startsWith('uuid:')) {
          startImageMediaId = sel.split('uuid:')[1];
        }
      }
    }
    if (!startImageMediaId) throw new Error('[VideoGen] Could not resolve start image UUID');

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[VideoGen] Start attempt ${attempt}/${MAX_RETRIES} (native Flow MZZa6b)...`);
        const targetModel = config.videoModelKey || 'veo_3_1_i2v_lite_low_priority';
        const flowResult = await startMultiImageVideoGeneration(page, context, {
          prompt,
          imageMediaIds: [startImageMediaId],
          imageBuffers: filePayloads && filePayloads[0]?.buffer ? [filePayloads[0].buffer] : [],
          imageNames: filePayloads && filePayloads[0]?.name ? [filePayloads[0].name] : ['panel.png'],
          aspectRatio: config.aspectRatio || '9:16',
          videoModelKey: targetModel,
          projectId: targetProjectId,
          outputCount: config.outputCount || 1,
        });
        mediaName = flowResult?.media?.[0]?.name;
        const wiz = flowResult?.wiz;
        if (!mediaName) throw new Error('[VideoGen] No media name in MZZa6b response');
        console.log(`[VideoGen] ✅ Started via MZZa6b! Media: ${mediaName}`);
        console.log(`[VideoGen] ✅ Setup complete — releasing browser lock.`);
        return { context, bearerToken, mediaName, prompt, extendPrompt, config, wiz, isFlowRpc: true };
      } catch (err) {
        console.log(`[VideoGen] ❌ Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt >= MAX_RETRIES) throw err;

        console.log(`[VideoGen] ⏳ Cooldown 3s & reloading Flow project page (${targetProjectId}) for new proxy session...`);
        await new Promise(r => setTimeout(r, 3000));
        if (page && !page.isClosed()) {
          try {
            const projectUrl = `https://flow.google.com/project/${targetProjectId}`;
            const currentUrl = page.url();
            if (currentUrl.includes(`/project/${targetProjectId}`)) {
              await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
            } else {
              await page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            }
            await page.waitForTimeout(3000);
          } catch (rErr) {
            console.warn(`[VideoGen] ⚠️ Page reload warning: ${rErr.message}`);
          }
        }
      }
    }
    return { context, bearerToken, mediaName, prompt, extendPrompt, config, isFlowRpc: true };
  }
}

// ═══════════════════════════════════════════════════════════════
// PHASE 2: Poll + Fetch (NO browser page needed, parallel OK)
// ═══════════════════════════════════════════════════════════════
async function executeVideoGeneration({ context, bearerToken, mediaName, config, wiz, isFlowRpc }) {
  // Poll for completion (standalone — no page needed)
  const completedMedia = await pollVideoStatusStandalone(context, bearerToken, mediaName, {
    requireVideoUrl: false,
    isFlowRpc,
    wiz,
    projectId: config?.projectId || wiz?.projectId
  });

  // Extract video URL
  const fifeUrl = completedMedia.videoUrl || findFifeUrl(completedMedia) || await resolveFlowMediaUrl(context, mediaName);
  if (!fifeUrl) {
    console.log('[VideoGen] ⚠️ completedMedia:', JSON.stringify(completedMedia).substring(0, 1000));
    throw new Error('[VideoGen] Could not resolve final video URL');
  }

  // Fetch video as base64
  console.log(`[VideoGen] Fetching video from ${fifeUrl.substring(0, 60)}...`);
  const vidResponse = await context.request.fetch(fifeUrl);
  if (vidResponse.status() !== 200) {
    const errBody = await vidResponse.text().catch(() => '');
    throw new Error(`[VideoGen] CDN download returned HTTP ${vidResponse.status()}: ${errBody.substring(0, 300)}`);
  }

  const vidBuffer = await vidResponse.body();
  if (vidBuffer.length < 1000) {
    const textPreview = vidBuffer.toString('utf8');
    if (textPreview.includes('<Error>') || textPreview.includes('AccessDenied')) {
      throw new Error(`[VideoGen] CDN returned AccessDenied error instead of video: ${textPreview.substring(0, 300)}`);
    }
  }

  let resultBase64 = vidBuffer.toString('base64');
  console.log(`[VideoGen] ✅ Video fetched (base64 length: ${resultBase64.length}, raw bytes: ${vidBuffer.length}).`);

  // Post-process (crop borders + scale)
  if (config.preserveBorder || config.skipPostProcess || config.cropPercent === 0) {
    console.log(`[VideoGen] ℹ️ Preserving white borders as requested (skipping crop).`);
  } else {
    try {
      resultBase64 = await processVideoBase64(resultBase64, {
        cropPercent: typeof config.cropPercent === 'number' ? config.cropPercent : 0.12,
        aspectRatio: config.aspectRatio || '9:16'
      });
      console.log(`[VideoGen] ✅ Post-processed (base64 length: ${resultBase64.length}).`);
    } catch (resizeErr) {
      console.error(`[VideoGen] ⚠️ Post-processing failed, using original: ${resizeErr.message}`);
    }
  }

  return resultBase64;
}

// ═══════════════════════════════════════════════════════════════
// Legacy wrapper (backward compat)
// ═══════════════════════════════════════════════════════════════
async function automateVideoGeneration(page, prompt, extendPrompt, filePayloads, config, baseDir) {
  const prepared = await prepareVideoGeneration(page, prompt, extendPrompt, filePayloads, config, baseDir);
  return await executeVideoGeneration(prepared);
}

module.exports = {
  automateVideoGeneration,
  prepareVideoGeneration,
  executeVideoGeneration,
  pollVideoStatusStandalone,
  pollFlowVideoStatusStandalone,
  startMultiImageVideoGeneration,
  startVideoGenerationViaUI,
  parseBatchExecuteResponse,
  findMediaNameInBatchResult,
  RAW_VIDEO_MODEL_ALIASES,
  VIDEO_MODEL_MAP,
  findFifeUrl,
  resolveFlowMediaUrl,
  normalizeVideoModelKey
};
