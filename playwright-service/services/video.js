const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeTempFiles } = require('../utils/helpers');
const { getContext, ensureBearerToken, getRecaptchaToken, PROJECT_URL, PROJECT_ID } = require('./browser');
const { findImageUUID, uploadImages, switchToMode, uploadImageDirect } = require('./image');
const { processVideoBase64 } = require('./video-resize');

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
  'abra_r2v_8s': 'abra_r2v_8s',
  'abra-r2v-8s': 'abra_r2v_8s',
  'r2v_8s': 'abra_r2v_8s',
  'r2v-8s': 'abra_r2v_8s',
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

  const requestBody = {
    mediaGenerationContext: {
      batchId: batchId,
      audioFailurePreference: 'BLOCK_SILENCED_VIDEOS'
    },
    clientContext: {
      projectId: PROJECT_ID,
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

async function startMultiImageVideoGeneration(page, context, {
  prompt,
  imageMediaIds = [],
  aspectRatio = '9:16',
  videoModelKey = 'abra_r2v_8s'
}) {
  const bearerToken = await ensureBearerToken(page);
  const recaptchaToken = await getRecaptchaToken(page, 'VIDEO_GENERATION');
  console.log(`[VideoGen-Multi] reCAPTCHA token: ${recaptchaToken.substring(0, 30)}... (${recaptchaToken.length} chars)`);

  const wiz = await page.evaluate(() => {
    const w = window.WIZ_global_data || {};
    return {
      at: w.SNlM0e || '',
      fsid: w.FdrFJe || '',
      bl: w.cfb2h || 'boq_labs-ai-sandbox-frontend_20260903.13_p1'
    };
  });

  const clientGuid1 = crypto.randomUUID().toUpperCase();
  const clientGuid2 = crypto.randomUUID().toUpperCase();
  const clientGuid3 = crypto.randomUUID().toUpperCase();

  const modelKey = videoModelKey || 'abra_r2v_8s';
  const innerPayload = [
    [
      [
        [
          null,
          null,
          [
            [
              [
                prompt
              ]
            ]
          ]
        ],
        imageMediaIds.map(id => [null, id]),
        modelKey,
        1,
        null,
        [
          null,
          null,
          null,
          null,
          clientGuid1,
          clientGuid2
        ]
      ]
    ],
    [
      null,
      22,
      null,
      null,
      null,
      PROJECT_ID,
      null,
      null,
      null,
      null,
      [
        recaptchaToken,
        1
      ]
    ],
    [
      clientGuid3,
      2
    ]
  ];

  const reqId = Math.floor(Math.random() * 900000) + 100000;
  const rpcUrl = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=MZZa6b&source-path=${encodeURIComponent('/project/' + PROJECT_ID)}&bl=${encodeURIComponent(wiz.bl)}&f.sid=${encodeURIComponent(wiz.fsid)}&hl=vi&_reqid=${reqId}&rt=c`;

  const fReq = JSON.stringify([[["MZZa6b", JSON.stringify(innerPayload), null, "generic"]]]);
  const bodyParams = new URLSearchParams();
  bodyParams.set('f.req', fReq);
  if (wiz.at) {
    bodyParams.set('at', wiz.at);
  }
  const bodyString = bodyParams.toString();

  console.log(`[VideoGen-Multi] Sending MZZa6b batchexecute with ${imageMediaIds.length} reference images (model: ${modelKey})...`);
  console.log(`[VideoGen-Multi]   prompt: "${prompt.substring(0, 80)}..."`);
  console.log(`[VideoGen-Multi]   imageMediaIds: ${imageMediaIds.join(', ')}`);

  const maxRetries = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`[VideoGen-Multi] 🔄 Retrying MZZa6b batchexecute (Attempt ${attempt}/${maxRetries})...`);
      }

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

      const parsed = parseBatchExecuteResponse(responseText, 'MZZa6b');
      if (!parsed) {
        throw new Error(`Could not parse MZZa6b response: ${responseText.substring(0, 500)}`);
      }

      const mediaName = findMediaNameInBatchResult(parsed, imageMediaIds);
      if (!mediaName) {
        console.warn('[VideoGen-Multi] Could not find media name in parsed MZZa6b result:', JSON.stringify(parsed).substring(0, 500));
        throw new Error('No media name returned in MZZa6b response');
      }

      console.log(`[VideoGen-Multi] ✅ Video generation started via MZZa6b! Media: ${mediaName}`);
      return { media: [{ name: mediaName }], wiz };
    } catch (err) {
      console.warn(`[VideoGen-Multi] ⚠️ Attempt ${attempt} failed: ${err.message}`);
      lastError = err;
      if (attempt < maxRetries) {
        await page.waitForTimeout(3000);
      }
    }
  }

  throw new Error(`[VideoGen-Multi] Failed to start video generation via MZZa6b: ${lastError?.message || 'Unknown error'}`);
}

async function fetchFlowVideoUrlViaAs29s(context, mediaName, wiz) {
  const reqId = Math.floor(Math.random() * 900000) + 100000;
  const rpcUrl = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=as29s&source-path=${encodeURIComponent('/project/' + PROJECT_ID)}&bl=${encodeURIComponent(wiz?.bl || 'boq_labs-ai-sandbox-frontend_20260903.13_p1')}&f.sid=${encodeURIComponent(wiz?.fsid || '')}&hl=vi&_reqid=${reqId}&rt=c`;

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

    const reqId = Math.floor(Math.random() * 900000) + 100000;
    const rpcUrl = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=jwpduf&source-path=${encodeURIComponent('/project/' + PROJECT_ID)}&bl=${encodeURIComponent(wiz?.bl || 'boq_labs-ai-sandbox-frontend_20260903.13_p1')}&f.sid=${encodeURIComponent(wiz?.fsid || '')}&hl=vi&_reqid=${reqId}&rt=c`;

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
      const item = items.find(it => it[0] === mediaName) || items[0];
      if (!item) continue;

      const meta = item[5] || [];
      const statusArr = Array.isArray(meta[8]) ? meta[8] : meta.find(x => Array.isArray(x) && typeof x[0] === 'number');
      const statusCode = statusArr ? statusArr[0] : null;

      if (statusCode === 3) {
        console.log(`[VideoGen] ✅ Flow video completed via jwpduf after ${(i + 1) * 5}s!`);
        const videoUrl = await fetchFlowVideoUrlViaAs29s(context, mediaName, wiz);
        console.log(`[VideoGen] Resolved Flow video URL: ${videoUrl.substring(0, 80)}...`);
        return {
          name: mediaName,
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

  for (let i = 0; i < maxPolls; i++) {
    await delay(5000);

    const statusBody = {
      media: [{ name: mediaName, projectId: PROJECT_ID }]
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
  aspectRatio = 'VIDEO_ASPECT_RATIO_PORTRAIT'
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

  const requestBody = {
    mediaGenerationContext: {
      batchId: batchId,
      audioFailurePreference: 'BLOCK_SILENCED_VIDEOS'
    },
    clientContext: {
      projectId: PROJECT_ID,
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
  const context = getContext();
  if (!context) throw new Error('[VideoGen] Browser context not available');

  console.log('[VideoGen] Step 1: Getting Bearer token...');
  const bearerToken = await ensureBearerToken(page);

  const isMulti = Boolean(config.multiImageMode || (filePayloads && filePayloads.length > 1) || (config.videoModelKey && config.videoModelKey.includes('r2v')));
  const MAX_RETRIES = 3;
  let mediaName = null;

  if (isMulti) {
    console.log(`[VideoGen-Multi] Preparing multi-image video generation with ${filePayloads.length} images...`);
    const imageMediaIds = [];
    for (let i = 0; i < filePayloads.length; i++) {
      const f = filePayloads[i];
      if (f.mediaId) {
        imageMediaIds.push(f.mediaId);
        console.log(`[VideoGen-Multi] Using provided mediaId [${i + 1}/${filePayloads.length}]: ${f.mediaId} (${f.name || 'image'})`);
      } else if (f.buffer) {
        console.log(`[VideoGen-Multi] Uploading reference image [${i + 1}/${filePayloads.length}]: ${f.name || ('image-' + i)}...`);
        const mid = await uploadImageDirect(context, bearerToken, f.buffer);
        imageMediaIds.push(mid);
        console.log(`[VideoGen-Multi] ✅ Uploaded [${i + 1}/${filePayloads.length}]: ${mid}`);
      }
    }

    if (imageMediaIds.length === 0) {
      throw new Error('[VideoGen-Multi] No valid reference image IDs could be resolved or uploaded');
    }

    let wiz = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[VideoGen-Multi] Start attempt ${attempt}/${MAX_RETRIES}...`);
        const apiResult = await startMultiImageVideoGeneration(page, context, {
          prompt,
          imageMediaIds,
          aspectRatio: config.aspectRatio || '9:16',
          videoModelKey: config.videoModelKey || 'abra_r2v_8s'
        });
        mediaName = apiResult.media?.[0]?.name;
        wiz = apiResult.wiz;
        if (!mediaName) throw new Error('[VideoGen-Multi] No media name in MZZa6b response');
        console.log(`[VideoGen-Multi] ✅ Started! Media: ${mediaName}`);
        break;
      } catch (err) {
        console.log(`[VideoGen-Multi] ❌ Attempt ${attempt} failed: ${err.message}`);
        if (attempt >= MAX_RETRIES) throw err;
        await page.waitForTimeout(5000);
      }
    }

    console.log(`[VideoGen] ✅ Setup complete — releasing browser lock.`);
    return { context, bearerToken, mediaName, prompt, extendPrompt, config, wiz, isFlowRpc: true };
  } else {
    // Single image mode (legacy)
    let startImageMediaId = null;
    if (filePayloads && filePayloads.length > 0) {
      console.log(`[VideoGen] Step 2: Direct uploading start image: ${filePayloads[0].name}...`);
      startImageMediaId = await uploadImageDirect(context, bearerToken, filePayloads[0].buffer);
      console.log(`[VideoGen] ✅ Direct upload success: ${startImageMediaId}`);
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
        console.log(`[VideoGen] Start attempt ${attempt}/${MAX_RETRIES}...`);
        const apiResult = await startVideoGeneration(page, context, {
          prompt, startImageMediaId,
          aspectRatio: config.aspectRatio || '9:16',
          videoModelKey: config.videoModelKey || null
        });
        mediaName = apiResult.media?.[0]?.name;
        if (!mediaName) throw new Error('[VideoGen] No media name in API response');
        console.log(`[VideoGen] ✅ Started! Media: ${mediaName}`);
        break;
      } catch (err) {
        console.log(`[VideoGen] ❌ Attempt ${attempt} failed: ${err.message}`);
        if (attempt >= MAX_RETRIES) throw err;
        await page.waitForTimeout(5000);
      }
    }

    console.log(`[VideoGen] ✅ Setup complete — releasing browser lock.`);
    return { context, bearerToken, mediaName, prompt, extendPrompt, config, isFlowRpc: false };
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
  RAW_VIDEO_MODEL_ALIASES,
  VIDEO_MODEL_MAP,
  findFifeUrl,
  resolveFlowMediaUrl,
  normalizeVideoModelKey
};
