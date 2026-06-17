'use strict';

/**
 * dailyvlog-storyboard.js
 *
 * Daily Vlog pipeline for "Nhi" lifestyle channel.
 * Mirrors the structure of gemini-client/gemini-storyboard.js but uses
 * the daily-vlog prompt templates from docs/daily-vlog/.
 *
 * Steps:
 *   1. buildDailyVlogAnalysisPrompt()  → Gemini → lifestyle analysis JSON
 *   2. buildDailyVlogStoryboardPrompt()→ Gemini → storyboard image (5 panels)
 *   3. buildDailyVlogPanelPrompt() ×5  → Gemini → individual panel images
 *   4. generateVideosFromPanelsDirect()→ video.js → 5 Veo 3 videos
 */

const fs = require('fs');
const path = require('path');

const { GeminiApiClient } = require('./gemini-client/gemini-api');
const { generateVideosFromPanelsDirect } = require('./gemini-webapi-storyboard');
const { getConfig } = require('../utils/config-manager');

const DEFAULT_PANEL_COUNT = 5;

/**
 * Read daily vlog config from config.json → dailyVlogSettings.
 * @param {string} baseDir
 * @returns {{ panelCount: number, sceneRatio: string, nhiReferencePath: string }}
 */
function getDailyVlogConfig(baseDir) {
  const config = getConfig(baseDir);
  const dvs = config.dailyVlogSettings || {};
  return {
    panelCount: Number(dvs.panelCount) || DEFAULT_PANEL_COUNT,
    sceneRatio: dvs.sceneRatio || '9:16',
    nhiReferencePath: dvs.nhiReferencePath || 'assets/nhi',
  };
}
const PANEL_MAX_RETRIES = parseInt(process.env.GEMINI_WEBAPI_PANEL_MAX_RETRIES || '3', 10);
const PANEL_RETRY_DELAY_MS = parseFloat(process.env.GEMINI_WEBAPI_PANEL_RETRY_DELAY || '5') * 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[DailyVlog] ${msg}\n`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getMimeExt(mimeType) {
  return /jpe?g/i.test(String(mimeType || '')) ? '.jpg' : '.png';
}

function stripCodeFence(text) {
  let cleaned = (text || '').trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  return cleaned.trim();
}

function parseJsonObject(text) {
  const cleaned = stripCodeFence(text);
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch (_) {
        throw new Error(`Could not parse JSON from response. First 200 chars: ${cleaned.slice(0, 200)}`);
      }
    }
    throw new Error(`Could not parse JSON from response. First 200 chars: ${cleaned.slice(0, 200)}`);
  }
}

// ─── Step 1: Lifestyle Analysis + Panel Planning Prompt ───────────────────────

/**
 * Builds the lifestyle analysis + panel planning prompt.
 * TEXT-ONLY task — returns JSON with analysis, panels, and veoPrompts.
 * Mirrors the review flow's buildAnalysisPrompt() which returns all planning
 * data in one text-only step, keeping Step 2 purely for image generation.
 */
function buildDailyVlogAnalysisPrompt(panelCount) {
  panelCount = panelCount || DEFAULT_PANEL_COUNT;

  return `TEXT-ONLY TASK. Do not generate images. Do not call image generation. Do not create any visual asset.
You are a senior lifestyle content strategist, product placement director, TikTok lifestyle analyst, and Veo 3 prompt writer.
Analyze the uploaded product images and create a complete daily vlog plan as JSON text only.

Account concept for "Nhi":
* Nhi is a Vietnamese girl, 22-24 years old.
* Cozy lifestyle creator.
* Soft, warm, realistic daily life.
* Products are NEVER reviewed directly.
* Products appear naturally inside Nhi's daily routines.
* Goal: make viewers curious about the product and ask where to buy it.
* Product placement must feel organic and authentic.

Requirements:
* Infer product identity from uploaded images.
* Panel count: exactly ${panelCount}
* Scene ratio for each panel: 9:16
* Do not generate review scripts or sales copy.
* Focus on lifestyle integration.
* Do not ask follow-up questions.
* Return ONLY valid JSON. No markdown, no commentary.
* If you are unable to inspect the images, still return the JSON schema with best-effort assumptions.
* This step is only for text analysis and prompt writing. The actual image generation will happen in a later separate request.

JSON schema:
{
  "analysis": {
    "productName": "Vietnamese product name inferred from the images",
    "category": "",
    "productType": "",
    "productRoleInLife": "emotional role of the product in Nhi's life",
    "visibilityLevel": "low|medium|high",
    "placementStyle": "",
    "mainBenefitsObserved": [],
    "suitableScenes": [],
    "suitableActivities": [],
    "suitableRooms": [],
    "moodFit": [],
    "lifestyleTags": [],
    "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
    "uncertainties": ""
  },
  "placementStrategy": {
    "heroProduct": false,
    "shouldMentionProduct": false,
    "screenPresence": "",
    "naturalInteractionExamples": []
  },
  "script": [
    {
      "id": 1,
      "sceneTitle": "short scene title",
      "timeOfDay": "morning|afternoon|evening|night",
      "activity": "what Nhi is doing",
      "productPlacement": "how the product appears naturally",
      "visualDescription": "detailed visual description for the scene",
      "cameraAction": "detailed camera movement description"
    }
  ],
  "frameData": "Combined text-only visual plan for all panels.",
  "veo3Prompts": [
    "One single-line Vietnamese Veo 3 prompt for panel 1"
  ],
  "captionSuggestions": ["TikTok caption suggestion 1", "caption 2", "caption 3"],
  "storyConcept": "One-line story concept for the vlog"
}

Important:
* "script" and "veo3Prompts" must contain exactly ${panelCount} items.
* Each veo3 prompt must be one line, with no newline characters.
* Each veo3 prompt describes a cinematic lifestyle scene of Nhi with the product appearing naturally.
* Each veo3 prompt must include VISUAL, Tone & Mood, Action timing 0s-4s and 5s-8s.
* suitableScenes should contain realistic daily moments.
* suitableActivities should contain things Nhi naturally does.
* lifestyleTags should describe aesthetic positioning.
* "analysis.hashtags" must contain exactly 5 unique hashtags, each starting with "#".
* Never output marketing language, CTA, or review content.`.trim();
}

// ─── Step 2: Storyboard Image Prompt (image-only, mirrors review flow) ────────

/**
 * Builds the storyboard image generation prompt.
 * IMAGE-ONLY task — generates a single storyboard collage image.
 * All panel planning data comes from Step 1 analysis (text-only).
 * This mirrors the review flow's buildStoryboardPrompt() pattern.
 * @param {object} analysis - Full result from step 1 (includes script[])
 * @param {number} panelCount
 */
function buildDailyVlogStoryboardPrompt(analysis, panelCount) {
  panelCount = panelCount || DEFAULT_PANEL_COUNT;

  // Only include visual/camera scene data — do NOT include veo3Prompts or any
  // video-related keys that could trigger Gemini's video generation mode.
  const sceneData = {
    frameData: analysis.frameData || '',
    storyConcept: analysis.storyConcept || '',
    panels: (analysis.script || []).map((s, i) => ({
      id: s.id || (i + 1),
      sceneTitle: s.sceneTitle || '',
      visualDescription: s.visualDescription || '',
      cameraAction: s.cameraAction || '',
      productPlacement: s.productPlacement || '',
    })),
  };

  return `Generate one clean lifestyle storyboard image (still photo collage, NOT a video) from the uploaded product reference images.

Storyboard requirements:
- Exactly ${panelCount} panels arranged side by side in one single image.
- Each panel frame is optimized for 9:16 aspect ratio.
- Show one coherent daily vlog sequence of a Vietnamese girl (Nhi, 22-24 years old) with the product appearing naturally.
- Preserve product design, color, material, and identity from the reference photos.
- Use cinematic lifestyle lighting, warm natural tones, realistic photography, clean composition.
- No text, labels, captions, UI, logos, or watermarks inside the image.
- Output must be a still photograph/illustration. Do NOT generate or describe a video.

Scene plan:
${JSON.stringify(sceneData, null, 2)}

Generate one still storyboard image now.`.trim();
}

// ─── Step 3: Panel Prompt (from step3_dailyvlog.md) ────────────────────────────

/**
 * Builds a per-panel Veo 3 prompt based on step3_dailyvlog.md template.
 * @param {number} panelIndex  - 1-based panel index
 * @param {object} panelData   - Panel data from step 2 storyboard JSON
 */
function buildDailyVlogPanelImagePrompt(panelIndex, panelData, panelCount) {
  panelCount = panelCount || DEFAULT_PANEL_COUNT;
  const source = 'Use the uploaded storyboard image as the main visual reference. Extract only this panel.';
  return `Generate a single polished lifestyle photograph (still image, NOT a video).

Panel: ${panelIndex} of ${panelCount}
Aspect ratio: 9:16

Instructions:
- ${source}
- Keep the product identity exactly consistent with the reference photo(s).
- Keep character (Nhi) identity exactly consistent with the uploaded reference images.
- Do not include text, labels, captions, UI, or watermarks.
- Cinematic lifestyle lighting, vertical frame, warm natural tones.

Scene: ${panelData.sceneTitle || ''}
Time: ${panelData.timeOfDay || ''}
Activity: ${panelData.activity || ''}
Product placement: ${panelData.productPlacement || ''}
Visual: ${panelData.visualDescription || ''}
Camera: ${panelData.cameraAction || ''}

Use the uploaded Nhi reference images. Preserve exact facial identity, hairstyle identity, skin tone, age appearance and body proportions. Same person as all previous panels.

Generate exactly one still image now.`.trim();
}

/**
 * Builds a Veo 3 video prompt using the step3_dailyvlog.md template.
 * @param {number} panelIndex - 1-based panel index
 * @param {object} panelData  - Panel data from step 2 storyboard JSON
 */
function buildDailyVlogVeoPrompt(panelIndex, panelData) {
  const veoPromptFromStep2 = panelData.veoPrompt || '';

  // If step 2 already provided a veoPrompt, use it (with character lock appended)
  if (veoPromptFromStep2) {
    return `${veoPromptFromStep2} Maintain perfect facial consistency with uploaded Nhi reference images. No identity drift. Same person throughout entire video.`;
  }

  // Otherwise build from step3_dailyvlog.md template
  return `Tao video cinematic lifestyle cua Nhi.

NHAN VAT:
Su dung CHINH XAC cac anh tham chieu cua Nhi da upload.
Khoa khuon mat, mau da, toc, do tuoi, ty le co the va nhan dien nhan vat 100%.
Khong tao nguoi khac. Khong thay doi nhan dien. Khong bi drift khuon mat.
Day la cung mot Nhi xuyen suot moi panel.

SAN PHAM:
Su dung CHINH XAC san pham trong anh upload.
Giu nguyen mau sac, hinh dang, chat lieu, kich thuoc va nhan dien san pham.
Khong bien dang. Khong thay doi thiet ke. Khong thay san pham bang vat the khac.

VISUAL:
${panelData.visualDescription || ''}

THOI GIAN:
${panelData.timeOfDay || 'Ban ngay, anh sang tu nhien'}

HOAT DONG:
${panelData.activity || ''}

PRODUCT PLACEMENT:
${panelData.productPlacement || ''}

TONE & MOOD:
${(panelData.moodFit || []).join(', ') || 'cozy, warm, realistic daily life'}

HANH DONG:
0s - 4s: ${panelData.cameraAction || 'Camera chay cham, goc quay tu nhien'}
5s - 8s: San pham hien len tu nhien trong canh

CAMERA:
${panelData.cameraAction || 'Handheld, cinematic lifestyle'}

PHONG CACH:
hyper realistic,
cinematic lifestyle photography,
natural human motion,
warm natural lighting,
realistic skin texture,
shallow depth of field,
premium influencer aesthetic,
daily life storytelling.

QUY TAC BAT BUOC:
* Khong review san pham.
* Khong voice-over.
* Khong noi chuyen.
* Khong CTA.
* Khong ban hang.
* Khong dong chu.
* Khong phu de.
* Khong UI.
* Khong logo.
* Khong watermark.
* Khong gia tien.
* Khong text bat ky dang nao.

Muc tieu:
Tao cam giac day la mot khoanh khac that trong cuoc song cua Nhi.
Nguoi xem tu nhin thay san pham va chu dong muon tim hieu them.`.trim();
}

// ─── Storyboard JSON parser ───────────────────────────────────────────────────

function parseStoryboardJson(text, panelCount) {
  panelCount = panelCount || DEFAULT_PANEL_COUNT;
  try {
    return parseJsonObject(text);
  } catch (_) {
    log('Warning: Could not parse storyboard JSON from Gemini response. Using fallback panels.');
    return {
      storyConcept: 'Daily vlog với sản phẩm',
      panels: Array.from({ length: panelCount }, (_, i) => ({
        id: i + 1,
        sceneTitle: `Cảnh ${i + 1}`,
        timeOfDay: 'Buổi sáng',
        activity: 'Sinh hoạt hàng ngày',
        productPlacement: 'Sản phẩm xuất hiện tự nhiên',
        visualDescription: 'Nhi trong không gian sống ấm cúng',
        cameraAction: 'Camera chạy chậm, góc quay tự nhiên',
        imagePrompt: '',
        veoPrompt: '',
      })),
      captionSuggestions: [],
      hashtags: ['#dailyvlog', '#lifestyle', '#cozy', '#nhi', '#tiktok'],
    };
  }
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

/**
 * Run the full daily vlog pipeline.
 *
 * @param {string}   baseDir       - Root of playwright-service
 * @param {object[]} filePayloads  - Product images: { name, mimeType, buffer }
 * @param {object[]} nhiPayloads   - Nhi reference images: { name, mimeType, buffer }
 * @param {object}   options
 * @returns {Promise<{panels, videos, analysis, captionSuggestions, hashtags}>}
 */
async function runDailyVlogFlow(baseDir, filePayloads, nhiPayloads, options = {}) {
  if (!filePayloads || filePayloads.length === 0) {
    throw new Error('At least one product image is required for daily vlog');
  }

  if (!process.env.GEMINI_SECURE_1PSID) {
    throw new Error('GEMINI_SECURE_1PSID is required (same as normal storyboard flow)');
  }

  // Read daily vlog config
  const dvConfig = getDailyVlogConfig(baseDir);
  const panelCount = options.panelCount || dvConfig.panelCount;
  log(`Config: panelCount=${panelCount}, sceneRatio=${dvConfig.sceneRatio}`);

  const outputDir = path.join(baseDir, 'uploads', 'dailyvlog-outputs');
  ensureDir(outputDir);

  const secure1Psid = (process.env.GEMINI_SECURE_1PSID || '').trim();
  const secure1Psidts = (process.env.GEMINI_SECURE_1PSIDTS || '').trim();
  const cookieFilePath = process.env.GEMINI_COOKIE_PATH
    ? path.resolve(process.env.GEMINI_COOKIE_PATH)
    : null;

  const client = new GeminiApiClient({ secure1Psid, secure1Psidts, cookieFilePath });

  try {
    log('Initializing Gemini client...');
    await client.init();

    // ── Upload product images ──────────────────────────────────────────────────
    log(`Uploading ${filePayloads.length} product image(s)...`);
    const productFileData = [];
    for (const file of filePayloads) {
      const url = await client.uploadFile(file.buffer, file.name, file.mimeType);
      productFileData.push({ url, filename: file.name, mimeType: file.mimeType });
      log(`  Uploaded product: ${file.name} → ${url.slice(0, 60)}...`);
    }

    // ── Upload Nhi reference images (if any) ───────────────────────────────────
    const nhiFileData = [];
    if (nhiPayloads && nhiPayloads.length > 0) {
      log(`Uploading ${nhiPayloads.length} Nhi reference image(s)...`);
      for (const file of nhiPayloads) {
        const url = await client.uploadFile(file.buffer, file.name, file.mimeType);
        nhiFileData.push({ url, filename: file.name, mimeType: file.mimeType });
        log(`  Uploaded Nhi ref: ${file.name} → ${url.slice(0, 60)}...`);
      }
    } else {
      log('No Nhi reference images found. Storyboard will use text description for character.');
    }

    // ── Step 1: Lifestyle Analysis ─────────────────────────────────────────────
    log('Step 1: Generating lifestyle analysis...');
    const step1MaxRetries = parseInt(process.env.GEMINI_WEBAPI_ANALYSIS_MAX_RETRIES || '3', 10);
    let analysisRaw;
    let lastAnalysisError;

    for (let attempt = 1; attempt <= step1MaxRetries; attempt++) {
      const retryLine = attempt === 1
        ? ''
        : '\n\nYour previous response was not valid parseable JSON. Return the complete JSON object only.';
      try {
        const result = await client.generateContent({
          prompt: buildDailyVlogAnalysisPrompt(panelCount) + retryLine,
          fileData: productFileData,
          temporary: true,
        });
        analysisRaw = parseJsonObject(result.text || '');
        break;
      } catch (err) {
        lastAnalysisError = err;
        if (attempt < step1MaxRetries) {
          log(`Step 1 parse failed (attempt ${attempt}/${step1MaxRetries}): ${err.message}. Retrying...`);
          await sleep(PANEL_RETRY_DELAY_MS * attempt);
        }
      }
    }

    if (!analysisRaw) throw lastAnalysisError || new Error('Step 1 lifestyle analysis failed');
    log(`Step 1 done. Product: ${analysisRaw.analysis?.productName || 'unknown'}, Script: ${(analysisRaw.script || []).length} panels, Veo3: ${(analysisRaw.veo3Prompts || []).length} prompts`);

    // Panel data now comes from Step 1 analysis (text-only)
    const panels = analysisRaw.script || [];
    const veo3Prompts = analysisRaw.veo3Prompts || [];

    // ── Step 2: Storyboard Image (image-only, no JSON) ────────────────────────
    log(`Step 2: Generating ${panelCount}-panel storyboard for Nhi...`);
    const allFileData = [...productFileData, ...nhiFileData];
    const storyboardResult = await client.generateContent({
      prompt: buildDailyVlogStoryboardPrompt(analysisRaw, panelCount),
      fileData: allFileData,
      temporary: true,
      expectImages: true,
    });

    // Step 2 is image-only — no JSON parsing needed (panels come from Step 1)

    // Save storyboard image if returned
    let storyboardB64 = null;
    let storyboardUrl = null;
    if (storyboardResult.images && storyboardResult.images.length > 0) {
      const imgBuf = await client.downloadImage(storyboardResult.images[0].url);
      const storyboardPath = path.join(outputDir, `storyboard-${Date.now()}.png`);
      fs.writeFileSync(storyboardPath, imgBuf);
      storyboardB64 = imgBuf.toString('base64');
      log(`Step 2 storyboard image saved: ${storyboardPath}`);

      // Upload storyboard for panel generation
      storyboardUrl = await client.uploadFile(imgBuf, 'dailyvlog_storyboard.png', 'image/png');
      log(`Storyboard uploaded for panels: ${storyboardUrl.slice(0, 60)}...`);
    } else {
      log('Warning: Gemini did not return a storyboard image. Panels will use product images directly (this is OK).');
    }

    // ── Step 3: Generate 5 panel images in parallel ────────────────────────────
    log(`Step 3: Generating ${panelCount} panel images in parallel...`);

    const panelFileData = storyboardUrl
      ? [{ url: storyboardUrl, filename: 'dailyvlog_storyboard.png', mimeType: 'image/png' }, ...nhiFileData]
      : [...productFileData, ...nhiFileData];

    const panelConcurrency = Math.min(
      panelCount,
      Math.max(1, parseInt(process.env.GEMINI_WEBAPI_PANEL_CONCURRENCY || String(panelCount), 10))
    );

    async function generatePanelImage(idx) {
      const panelIndex = idx + 1;
      const panelData = panels[idx] || { id: panelIndex };
      let lastErr;

      for (let attempt = 1; attempt <= PANEL_MAX_RETRIES; attempt++) {
        const startedAt = Date.now();
        log(`[Panel ${panelIndex}] Requesting image (attempt ${attempt}/${PANEL_MAX_RETRIES})...`);
        try {
          const result = await client.generateContent({
            prompt: buildDailyVlogPanelImagePrompt(panelIndex, panelData, panelCount),
            fileData: panelFileData,
            temporary: true,
            expectImages: true,
          });

          const imgBuf = await client.downloadImage(result.images[0].url);
          const panelPath = path.join(outputDir, `panel-${panelIndex}-${Date.now()}.png`);
          fs.writeFileSync(panelPath, imgBuf);
          log(`[Panel ${panelIndex}] Done after ${Math.round((Date.now() - startedAt) / 1000)}s`);

          // Use veo3Prompt from Step 1 analysis if available, fallback to buildDailyVlogVeoPrompt
          const veoPrompt = (veo3Prompts[idx] || '') || buildDailyVlogVeoPrompt(panelIndex, panelData);

          return {
            index: panelIndex,
            prompt: veoPrompt,
            imageBase64: imgBuf.toString('base64'),
            imagePath: panelPath,
            mimeType: 'image/png',
            panelData,
          };
        } catch (err) {
          lastErr = err;
          if (attempt < PANEL_MAX_RETRIES) {
            const delay = PANEL_RETRY_DELAY_MS * attempt;
            log(`[Panel ${panelIndex}] Attempt ${attempt} failed: ${err.message}. Retrying in ${Math.round(delay / 1000)}s...`);
            await sleep(delay);
          }
        }
      }
      throw lastErr;
    }

    const allIndices = Array.from({ length: panelCount }, (_, i) => i);
    const panelResults = [];

    for (let start = 0; start < panelCount; start += panelConcurrency) {
      const batch = allIndices.slice(start, start + panelConcurrency);
      log(`Starting panel batch [${batch.map(i => i + 1).join(', ')}]...`);

      const settled = await Promise.allSettled(batch.map(idx => generatePanelImage(idx)));

      for (let bi = 0; bi < settled.length; bi++) {
        const panelIndex = batch[bi] + 1;
        if (settled[bi].status === 'fulfilled') {
          panelResults.push(settled[bi].value);
        } else {
          log(`[Panel ${panelIndex}] Failed: ${settled[bi].reason?.message}`);
          panelResults.push({
            index: panelIndex,
            prompt: (veo3Prompts[batch[bi]] || '') || buildDailyVlogVeoPrompt(panelIndex, panels[batch[bi]] || {}),
            error: settled[bi].reason?.message,
          });
        }
      }
    }

    const successPanels = panelResults.filter(p => !p.error);
    successPanels.sort((a, b) => a.index - b.index);
    log(`Step 3 done. ${successPanels.length}/${panelCount} panels generated.`);

    // ── Step 4: Generate Videos ────────────────────────────────────────────────
    log('Step 4: Generating videos for each panel...');
    const videos = await generateVideosFromPanelsDirect(baseDir, successPanels, {
      aspectRatio: options.aspectRatio || '9:16',
      videoModelKey: options.videoModelKey || null,
      includeVideoBase64: true,
    });
    log(`Step 4 done. ${videos.filter(v => !v.error).length}/${videos.length} videos generated.`);

    return {
      analysis: analysisRaw.analysis || {},
      placementStrategy: analysisRaw.placementStrategy || {},
      storyboard: {
        imageBase64: storyboardB64,
        mimeType: storyboardB64 ? 'image/png' : null,
      },
      panels: panelResults,
      videos,
      captionSuggestions: analysisRaw.captionSuggestions || [],
      hashtags: (analysisRaw.analysis || {}).hashtags || [],
      storyConcept: analysisRaw.storyConcept || '',
    };

  } finally {
    try { await client.close(); } catch (_) {}
  }
}

module.exports = {
  runDailyVlogFlow,
  getDailyVlogConfig,
  buildDailyVlogAnalysisPrompt,
  buildDailyVlogStoryboardPrompt,
  buildDailyVlogPanelImagePrompt,
  buildDailyVlogVeoPrompt,
  DEFAULT_PANEL_COUNT,
};
