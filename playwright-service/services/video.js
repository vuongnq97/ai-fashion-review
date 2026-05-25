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
  'portrait': 'veo_3_1_i2v_s_portrait',
  'landscape': 'veo_3_1_i2v_s_landscape',
  'square': 'veo_3_1_i2v_s_square',
};

const RAW_VIDEO_MODEL_ALIASES = {
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

  if (/^veo_/.test(raw)) return raw;

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
  videoModelKey = null
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
      startImage: {
        mediaId: startImageMediaId
      }
    }],
    useV2ModelConfig: true
  };

  console.log(`[VideoGen] Calling batchAsyncGenerateVideoStartImage API...`);
  console.log(`[VideoGen]   prompt: "${prompt.substring(0, 80)}..."`);
  console.log(`[VideoGen]   startImage: ${startImageMediaId}`);
  console.log(`[VideoGen]   model: ${videoModelKey}, ratio: ${apiAspect}`);

  const apiUrl = 'https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage';

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
    throw new Error(`[VideoGen] API returned HTTP ${status}: ${body.substring(0, 500)}`);
  }

  const result = JSON.parse(body);
  console.log(`[VideoGen] ✅ Video generation started!`);
  console.log(`[VideoGen] API response: ${JSON.stringify(result).substring(0, 500)}`);

  return result;
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
// Uses cached bearerToken + context.request.fetch
// ═══════════════════════════════════════════════════════════════
async function pollVideoStatusStandalone(context, bearerToken, mediaName, options = {}) {
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

  // Resolve start image UUID
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

  // Start video generation API (with retry)
  const MAX_RETRIES = 3;
  let mediaName = null;

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

  return { context, bearerToken, mediaName, prompt, extendPrompt, config };
}

// ═══════════════════════════════════════════════════════════════
// PHASE 2: Poll + Fetch (NO browser page needed, parallel OK)
// ═══════════════════════════════════════════════════════════════
async function executeVideoGeneration({ context, bearerToken, mediaName, config }) {
  // Poll for completion (standalone — no page needed)
  const completedMedia = await pollVideoStatusStandalone(context, bearerToken, mediaName, {
    requireVideoUrl: false,
  });

  // Extract video URL
  const fifeUrl = findFifeUrl(completedMedia) || await resolveFlowMediaUrl(context, mediaName);
  if (!fifeUrl) {
    console.log('[VideoGen] ⚠️ completedMedia:', JSON.stringify(completedMedia).substring(0, 1000));
    throw new Error('[VideoGen] Could not resolve final video URL');
  }

  // Fetch video as base64
  console.log(`[VideoGen] Fetching video from ${fifeUrl.substring(0, 60)}...`);
  const vidResponse = await context.request.fetch(fifeUrl);
  const vidBuffer = await vidResponse.body();
  let resultBase64 = vidBuffer.toString('base64');
  console.log(`[VideoGen] ✅ Video fetched (base64 length: ${resultBase64.length}).`);

  // Post-process (crop borders + scale)
  try {
    resultBase64 = await processVideoBase64(resultBase64, {
      cropPercent: 0.04, aspectRatio: config.aspectRatio || '9:16'
    });
    console.log(`[VideoGen] ✅ Post-processed (base64 length: ${resultBase64.length}).`);
  } catch (resizeErr) {
    console.error(`[VideoGen] ⚠️ Post-processing failed, using original: ${resizeErr.message}`);
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
  findFifeUrl,
  resolveFlowMediaUrl,
  normalizeVideoModelKey
};
