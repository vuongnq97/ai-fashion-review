const fs = require('fs');
const path = require('path');
const { writeTempFiles } = require('../utils/helpers');
const { getContext, ensureBearerToken, getRecaptchaToken, PROJECT_URL, PROJECT_ID } = require('./browser');
const { findImageUUID, uploadImages, switchToMode } = require('./image');
const { processVideoBase64 } = require('./video-resize');

// ═══════════════════════════════════════════════════════════════
// Video model mapping
// ═══════════════════════════════════════════════════════════════
const VIDEO_MODEL_MAP = {
  'portrait': 'veo_3_1_i2v_s_portrait',
  'landscape': 'veo_3_1_i2v_s_landscape',
  'square': 'veo_3_1_i2v_s_square',
};

const VIDEO_ASPECT_MAP = {
  '9:16': 'VIDEO_ASPECT_RATIO_PORTRAIT',
  '16:9': 'VIDEO_ASPECT_RATIO_LANDSCAPE',
  '1:1': 'VIDEO_ASPECT_RATIO_SQUARE',
};



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

  // Auto-select model based on aspect ratio
  if (!videoModelKey) {
    if (aspectRatio === '16:9') videoModelKey = 'veo_3_1_i2v_s_landscape';
    else if (aspectRatio === '1:1') videoModelKey = 'veo_3_1_i2v_s_square';
    else videoModelKey = 'veo_3_1_i2v_s_portrait';
  }

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
function findFifeUrl(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (let key in obj) {
    if (key === 'fifeUrl' && typeof obj[key] === 'string') return obj[key];
    const res = findFifeUrl(obj[key]);
    if (res) return res;
  }
  return null;
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
// MAIN: automateVideoGeneration
// ═══════════════════════════════════════════════════════════════
async function automateVideoGeneration(page, prompt, extendPrompt, filePayloads, config, baseDir) {
  const { imageSelection } = config;
  const context = getContext();
  if (!context) throw new Error('[VideoGen] Browser context not available');

  let tempFilePaths = [];
  let resultBase64 = null;

  try {
    // ── Step 1: Navigate to project page ──
    // Images from previous gen node already exist in the project gallery
    // No upload or mode switch needed — API calls don’t depend on UI mode
    console.log('[VideoGen] Navigating to Google Labs project...');
    await page.goto(PROJECT_URL);
    await page.waitForTimeout(6000);

    // ── Step 2: Resolve start image UUID ──
    // Image already exists from previous generation node
    console.log('[VideoGen] Switching to Video mode for picker...');
    await switchToMode(page, 'video');

    // ── Step 1b: Upload images if needed ──
    if (filePayloads && filePayloads.length > 0) {
      console.log(`[VideoGen] Uploading ${filePayloads.length} image(s)...`);
      tempFilePaths = await uploadImages(page, filePayloads, baseDir);
    }

    let startImageMediaId = null;
    const selections = imageSelection || tempFilePaths.map(p => `name:${path.basename(p)}`);

    if (selections && selections.length > 0) {
      const sel = selections[0]; // Video uses first image as start frame
      console.log(`[VideoGen] Resolving start image: "${sel}"...`);
      if (sel.startsWith('name:')) {
        const name = sel.split('name:')[1];
        startImageMediaId = await findImageUUID(page, name, 'video');
      } else if (sel.startsWith('uuid:')) {
        startImageMediaId = sel.split('uuid:')[1];
      }
    }

    if (!startImageMediaId) {
      throw new Error('[VideoGen] Could not resolve start image UUID');
    }

    // ── Step 4 & 5: Start generation + Poll status (with retry) ──
    const MAX_GEN_RETRIES = 5;
    let completedMedia = null;
    let mediaName = null;

    for (let attempt = 1; attempt <= MAX_GEN_RETRIES; attempt++) {
      try {
        console.log(`[VideoGen] Generation attempt ${attempt}/${MAX_GEN_RETRIES}...`);

        const apiResult = await startVideoGeneration(page, context, {
          prompt,
          startImageMediaId,
          aspectRatio: config.aspectRatio || '9:16',
          videoModelKey: config.videoModelKey || null
        });

        // Extract media name from API response for polling
        mediaName = apiResult.media?.[0]?.name;
        if (!mediaName) {
          console.log(`[VideoGen] API response: ${JSON.stringify(apiResult).substring(0, 500)}`);
          throw new Error('[VideoGen] Could not extract media name from API response');
        }
        console.log(`[VideoGen] Media name for polling: ${mediaName}`);

        // Poll for video completion via API
        completedMedia = await pollVideoStatus(page, context, mediaName);
        console.log(`[VideoGen] ✅ Generation succeeded on attempt ${attempt}.`);
        break; // Success — exit retry loop

      } catch (err) {
        console.log(`[VideoGen] ❌ Attempt ${attempt}/${MAX_GEN_RETRIES} failed: ${err.message}`);
        if (attempt >= MAX_GEN_RETRIES) {
          throw new Error(`[VideoGen] ❌ All ${MAX_GEN_RETRIES} generation attempts failed. Last error: ${err.message}`);
        }
        console.log(`[VideoGen] Waiting 5s before retry...`);
        await page.waitForTimeout(5000);
      }
    }

    // ── Step 6: Extend video (if requested) ──
    let finalMediaName = mediaName;
    let extendMediaName = null;

    if (extendPrompt) {
      const workflowId = completedMedia.mediaMetadata?.requestData?.videoGenerationRequestData?.videoModelControlInput
        ? completedMedia.workflowId
        : null;
      // Try multiple paths for workflowId
      const wfId = workflowId
        || completedMedia.workflowId
        || completedMedia.mediaMetadata?.requestData?.clientPlatform; // fallback

      console.log(`[VideoGen] workflowId: ${wfId}`);

      const MAX_EXTEND_RETRIES = 5;

      for (let attempt = 1; attempt <= MAX_EXTEND_RETRIES; attempt++) {
        try {
          console.log(`[VideoGen] Extend attempt ${attempt}/${MAX_EXTEND_RETRIES}...`);
          extendMediaName = await extendVideo(page, context, {
            extendPrompt,
            videoMediaId: mediaName,
            workflowId: wfId || '',
            aspectRatio: VIDEO_ASPECT_MAP[config.aspectRatio || '9:16'] || 'VIDEO_ASPECT_RATIO_PORTRAIT'
          });

          // Poll for extend completion
          const extendedMedia = await pollVideoStatus(page, context, extendMediaName);
          finalMediaName = extendMediaName;
          console.log(`[VideoGen] ✅ Extend succeeded on attempt ${attempt}.`);
          break;

        } catch (err) {
          console.log(`[VideoGen] ❌ Extend attempt ${attempt}/${MAX_EXTEND_RETRIES} failed: ${err.message}`);
          if (attempt >= MAX_EXTEND_RETRIES) {
            console.log(`[VideoGen] ⚠️ All extend attempts failed. Using original video.`);
          } else {
            await page.waitForTimeout(5000);
          }
        }
      }
    }

    // ── Step 7: Fetch video as base64 ──
    let finalVideoUrl = null;
    let finalBase64 = null;
    
    if (extendMediaName) {
      console.log('[VideoGen] Calling Concatenation API for 16s video...');
      const concatResult = await concatenateVideos(page, context, mediaName, extendMediaName);
      if (concatResult && concatResult.base64) {
        finalBase64 = concatResult.base64;
      } else {
        finalVideoUrl = concatResult;
      }
    } else {
      console.log('[VideoGen] Fetching fifeUrl from initial generation...');
      // Re-poll the first video to get its fifeUrl
      const media = await pollVideoStatus(page, context, mediaName);
      finalVideoUrl = findFifeUrl(media);
    }

    if (finalBase64) {
      resultBase64 = finalBase64;
      console.log(`[VideoGen] ✅ Video concatenated (base64 length: ${resultBase64.length}).`);
    } else {
      if (!finalVideoUrl) {
        throw new Error('[VideoGen] Could not resolve final video URL');
      }
      console.log(`[VideoGen] Fetching video as base64 from API URL...`);
      const vidResponse = await context.request.fetch(finalVideoUrl);
      const vidBuffer = await vidResponse.body();
      resultBase64 = vidBuffer.toString('base64');
      console.log(`[VideoGen] ✅ Video fetched (base64 length: ${resultBase64.length}).`);
    }

    // ── Step 8: Post-process video (crop borders + scale) ──
    console.log('[VideoGen] Post-processing video with ffmpeg (crop + scale)...');
    try {
      resultBase64 = await processVideoBase64(resultBase64, {
        cropPx: 60,
        aspectRatio: config.aspectRatio || '9:16'
      });
      console.log(`[VideoGen] ✅ Video post-processed (base64 length: ${resultBase64.length}).`);
    } catch (resizeErr) {
      console.error(`[VideoGen] ⚠️ Post-processing failed, using original video: ${resizeErr.message}`);
      // Continue with unprocessed video rather than failing entirely
    }

  } catch (err) {
    console.error('[VideoGen] Playwright execution error:', err);
    throw err;
  } finally {
    tempFilePaths.forEach(p => { if (fs.existsSync(p)) fs.unlinkSync(p); });
  }

  return resultBase64;
}

module.exports = {
  automateVideoGeneration
};
