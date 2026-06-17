'use strict';

/**
 * gemini-storyboard.js
 *
 * Node.js equivalent of the Python gemini-webapi-bridge/gemini_storyboard.py.
 * Accepts the same JSON input/output format so the calling code in
 * gemini-webapi-storyboard.js can be swapped with minimal changes.
 *
 * Flow:
 *   1. Upload product images
 *   2. generateContent(analysisPrompt) → parse JSON → analysis + veo3Prompts
 *   3. generateContent(storyboardPrompt, files) → download storyboard image
 *   4. For each panel: generateContent(panelPrompt, storyboard files) → download panel image
 *   5. Return result JSON matching Python bridge output format
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GeminiApiClient } = require('./gemini-api');

const PANEL_MAX_RETRIES = parseInt(process.env.GEMINI_WEBAPI_PANEL_MAX_RETRIES || '3', 10);
const PANEL_RETRY_DELAY_MS = parseFloat(process.env.GEMINI_WEBAPI_PANEL_RETRY_DELAY || '5') * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[GeminiJS] ${msg}\n`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  } catch (_) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error('Could not parse JSON from response: ' + cleaned.slice(0, 200));
  }
}

function normalizePrompt(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeHashtag(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const tag = raw.startsWith('#') ? raw : `#${raw}`;
  return tag
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}_#]/gu, '')
    .replace(/^#+/, '#');
}

function slugToHashtag(value) {
  const raw = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .trim();
  return raw ? `#${raw}` : '';
}

function normalizeProductMetadata(analysis, category) {
  const source = (analysis && typeof analysis === 'object') ? analysis : {};
  const productName = normalizePrompt(source.productName || source.product_name || source.name || category || 'San pham thoi trang');
  const providedTags = Array.isArray(source.hashtags) ? source.hashtags : [];
  const fallbackTags = [
    productName,
    category || 'Fashion product',
    source.type,
    'thoi trang',
    'review san pham',
    'fashion review',
  ];

  const hashtags = [];
  for (const value of [...providedTags, ...fallbackTags]) {
    const normalized = normalizeHashtag(value) || slugToHashtag(value);
    if (normalized && !hashtags.some(tag => tag.toLowerCase() === normalized.toLowerCase())) {
      hashtags.push(normalized);
    }
    if (hashtags.length === 5) break;
  }

  while (hashtags.length < 5) {
    hashtags.push(`#sanpham${hashtags.length + 1}`);
  }

  return { productName, hashtags };
}

function getMimeExt(mimeType) {
  return /jpe?g/i.test(String(mimeType || '')) ? '.jpg' : '.png';
}

// ─── Prompt builders (mirrors gemini_storyboard.py) ──────────────────────────

function buildAnalysisPrompt(options = {}) {
  const panelCount = parseInt(options.panelCount || 3, 10);
  const sceneRatio = options.sceneRatio || options.aspectRatio || '9:16';
  const category = options.category || 'Fashion product';
  const vietnameseModel = options.useVietnameseModel !== false;
  const styleFast = options.styleCuonHut !== false;

  const modelLine = vietnameseModel
    ? 'Use a young Vietnamese model when a human model is needed.'
    : 'Use a professional fashion model when a human model is needed.';
  const paceLine = styleFast
    ? 'Voice-over must be short, punchy, curiosity-driven, 24-30 Vietnamese words per panel.'
    : 'Voice-over must feel natural, clear, 18-24 Vietnamese words per panel.';

  return `TEXT-ONLY TASK. Do not generate images. Do not call image generation. Do not create a visual storyboard asset.
You are a senior fashion product analyst, text storyboard planner, and Veo 3 prompt writer.
Analyze the uploaded product reference images and write a Vietnamese review plan as JSON text only.

Requirements:
- Category: ${category}
- Panel count: exactly ${panelCount}
- Scene ratio for each panel: ${sceneRatio}
- ${modelLine}
- ${paceLine}
- Product identity must remain consistent across all panels.
- Do not ask follow-up questions.
- Return ONLY valid JSON. No markdown, no commentary.
- If you are unable to inspect the images, still return the JSON schema with best-effort assumptions. Never mention image quota, limits, usage, or settings.
- This step is only for text analysis and prompt writing. The actual image generation will happen in a later separate request.

JSON schema:
{
  "analysis": {
    "productName": "Vietnamese product name inferred from the images",
    "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
    "type": "string",
    "materials": "string",
    "highlights": ["string"],
    "styling": "string",
    "uncertainties": "string",
    "gender": "male|female|unisex"
  },
  "script": [
    {
      "id": 1,
      "duration": "00:00-00:08",
      "voiceOver": "Vietnamese voice-over",
      "goal": "Hook|Value|Twist|CTA",
      "visualDescription": "detailed visual",
      "cameraAction": "detailed camera movement"
    }
  ],
  "frameData": "Combined text-only visual plan for all panels.",
  "cropTemplate": "Text-only notes for panel composition/cropping.",
  "veo3Prompts": [
    "One single-line Vietnamese Veo 3 prompt for panel 1"
  ]
}

Important:
- Infer "analysis.productName" from visible product information, product type, design, and labels/text in the images.
- Extract existing hashtags from the images if visible. If fewer than 5 are visible, add relevant Vietnamese/TikTok-friendly fashion hashtags until there are exactly 5.
- "analysis.hashtags" must contain exactly 5 unique hashtags, each starting with "#".
- "script" and "veo3Prompts" must contain exactly ${panelCount} items.
- Each veo3 prompt must be one line, with no newline characters.
- Each veo3 prompt must include VISUAL, Tone & Mood, Action timing 0s-4s and 5s-8s, and Script nhan vat.`.trim();
}

function buildStoryboardPrompt(analysis, options = {}) {
  const panelCount = parseInt(options.panelCount || 3, 10);
  const sceneRatio = options.sceneRatio || options.aspectRatio || '9:16';
  const noText = options.noTextInImage !== false;
  const textRule = noText
    ? 'No text, labels, captions, UI, logos, or watermarks inside the image.'
    : 'Avoid unnecessary text.';

  // Only include visual/camera scene data — do NOT include veo3Prompts or any
  // video-related keys that could trigger Gemini's video generation mode instead
  // of image generation.
  const sceneData = {
    frameData: analysis.frameData || '',
    cropTemplate: analysis.cropTemplate || '',
    panels: (analysis.script || []).map((s, i) => ({
      id: s.id || (i + 1),
      visualDescription: s.visualDescription || '',
      cameraAction: s.cameraAction || '',
    })),
  };

  return `Generate one clean fashion storyboard image (still photo collage, NOT a video) from the uploaded product reference images.

Storyboard requirements:
- Exactly ${panelCount} panels arranged side by side in one single image.
- Each panel frame is optimized for ${sceneRatio} aspect ratio.
- Show one coherent Vietnamese fashion product review photo sequence.
- Preserve product design, color, material, and identity from the reference photos.
- Use cinematic commercial lighting, realistic fashion photography, clean composition.
- ${textRule}
- Output must be a still photograph/illustration. Do NOT generate or describe a video.

Scene plan:
${JSON.stringify(sceneData, null, 2)}

Generate one still storyboard image now.`.trim();
}

function buildPanelPrompt(storyboardAvailable, panelIndex, panelCount, scriptItem, veoPrompt, options = {}) {
  const sceneRatio = options.sceneRatio || options.aspectRatio || '9:16';
  const source = storyboardAvailable
    ? 'Use the uploaded storyboard image as the main visual reference and extract/recreate only this panel.'
    : 'Use the uploaded product images as visual references and create this panel directly.';

  // Keep the panel prompt focused on still image generation.
  // Do NOT mention Veo 3 / video by name to avoid triggering video mode.
  return `Generate a single polished fashion photograph (still image, NOT a video).

Panel: ${panelIndex} of ${panelCount}
Aspect ratio: ${sceneRatio}
Instructions:
- ${source}
- Keep the product identity exactly consistent with the reference photo(s).
- Do not include text, labels, captions, UI, or watermarks.
- Cinematic commercial lighting, vertical frame, clean background.

Scene description:
- Visual: ${scriptItem.visualDescription || ''}
- Camera: ${scriptItem.cameraAction || ''}

Shot concept:
${veoPrompt}

Generate exactly one still image now.`.trim();
}

// ─── Normalize analysis (mirrors Python normalize_analysis) ───────────────────

function normalizeAnalysis(data, panelCount) {
  const script = Array.isArray(data.script) ? data.script : [];
  const prompts = Array.isArray(data.veo3Prompts) ? data.veo3Prompts : [];
  const rawAnalysis = (typeof data.analysis === 'object' && data.analysis) ? data.analysis : {};
  const productMetadata = normalizeProductMetadata(rawAnalysis, rawAnalysis.type || 'Fashion product');

  const normalizedScript = [];
  for (let idx = 0; idx < panelCount; idx++) {
    const item = (idx < script.length && typeof script[idx] === 'object') ? script[idx] : {};
    normalizedScript.push({
      id: parseInt(item.id || idx + 1, 10),
      duration: String(item.duration || `00:${String(idx * 8).padStart(2, '0')}-00:${String((idx + 1) * 8).padStart(2, '0')}`),
      voiceOver: String(item.voiceOver || ''),
      goal: String(item.goal || ''),
      visualDescription: String(item.visualDescription || ''),
      cameraAction: String(item.cameraAction || ''),
    });
  }

  const normalizedPrompts = [];
  for (let idx = 0; idx < panelCount; idx++) {
    if (idx < prompts.length) {
      normalizedPrompts.push(normalizePrompt(prompts[idx]));
    } else {
      const item = normalizedScript[idx];
      normalizedPrompts.push(normalizePrompt(
        `Create an 8-second Vietnamese fashion review video. VISUAL: ${item.visualDescription}. ` +
        `Tone & Mood: premium, clear, engaging. Action: 0s-4s ${item.cameraAction}; ` +
        `5s-8s show product detail and model reaction. Script nhan vat: "${item.voiceOver}"`
      ));
    }
  }

  return {
    ...data,
    script: normalizedScript,
    veo3Prompts: normalizedPrompts,
    analysis: {
      ...rawAnalysis,
      ...productMetadata,
    },
    frameData: data.frameData || '',
    cropTemplate: data.cropTemplate || '',
  };
}

// ─── Main run function ────────────────────────────────────────────────────────

/**
 * Run the full storyboard generation pipeline.
 * @param {object} request   - Same format as Python bridge input JSON
 * @param {string} workDir   - Working directory for temporary files
 * @returns {Promise<object>} - Same format as Python bridge output JSON
 */
async function run(request, workDir) {
  const secure1Psid = (process.env.GEMINI_SECURE_1PSID || '').trim();
  const secure1Psidts = (process.env.GEMINI_SECURE_1PSIDTS || '').trim();
  const cookieFilePath = process.env.GEMINI_COOKIE_PATH
    ? path.resolve(process.env.GEMINI_COOKIE_PATH)
    : null;

  if (!secure1Psid) {
    throw new Error('GEMINI_SECURE_1PSID environment variable is required');
  }

  const options = request.options || {};
  const panelCount = parseInt(options.panelCount || 3, 10);

  const outputDir = path.join(workDir, 'outputs');
  const inputDir = path.join(workDir, 'inputs');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(inputDir, { recursive: true });

  // Save input images to disk and collect metadata
  const inputFiles = [];
  for (let idx = 0; idx < (request.images || []).length; idx++) {
    const image = request.images[idx];
    const mimeType = image.mimeType || 'image/png';
    const safeName = (image.name || `image-${idx + 1}`).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || `image-${idx + 1}`;
    const ext = getMimeExt(mimeType);
    const filename = `${String(idx + 1).padStart(2, '0')}-${path.parse(safeName).name}${ext}`;
    const filePath = path.join(inputDir, filename);
    fs.writeFileSync(filePath, Buffer.from(image.base64 || '', 'base64'));
    inputFiles.push({ filePath, filename, mimeType, buffer: fs.readFileSync(filePath) });
  }

  if (inputFiles.length === 0) {
    throw new Error('At least one input image is required');
  }

  const client = new GeminiApiClient({ secure1Psid, secure1Psidts, cookieFilePath });

  try {
    log('Initializing Gemini client...');
    await client.init();

    // ── 1. Upload all input images ──────────────────────────────────────────
    log(`Uploading ${inputFiles.length} image(s)...`);
    const uploadedUrls = [];
    for (const file of inputFiles) {
      const url = await client.uploadFile(file.buffer, file.filename, file.mimeType);
      uploadedUrls.push(url);
      log(`  Uploaded: ${file.filename} → ${url.slice(0, 60)}...`);
    }

    const fileData = uploadedUrls.map((url, i) => ({
      url,
      filename: inputFiles[i].filename,
      mimeType: inputFiles[i].mimeType,
    }));

    // ── 2. Analysis ─────────────────────────────────────────────────────────
    log('Generating analysis and Veo prompts...');
    const analysisResult = await client.generateContent({
      prompt: buildAnalysisPrompt(options),
      fileData,
      temporary: true,
    });

    const analysisRaw = parseJsonObject(analysisResult.text || '');
    const analysis = normalizeAnalysis(analysisRaw, panelCount);
    log(`Analysis done. Panels: ${analysis.script.length}, Prompts: ${analysis.veo3Prompts.length}`);

    // ── 3. Storyboard image ─────────────────────────────────────────────────
    log('Generating full storyboard image...');
    const storyboardResult = await client.generateContent({
      prompt: buildStoryboardPrompt(analysis, options),
      fileData,
      temporary: true,
      expectImages: true,
    });

    if (storyboardResult.images.length === 0) {
      throw new Error('Gemini did not return a storyboard image; stopping before panel generation.');
    }

    const imgBuf = await client.downloadImage(storyboardResult.images[0].url);
    const storyboardPath = path.join(outputDir, 'storyboard.png');
    fs.writeFileSync(storyboardPath, imgBuf);
    const storyboardB64 = imgBuf.toString('base64');
    log(`Storyboard saved: ${storyboardPath}`);

    // ── 4. Panel images (PARALLEL) ────────────────────────────────────────────
    // Dùng chung 1 client cho tất cả panels — APIRequestContext xử lý concurrent
    // requests tốt. Mỗi request đã có reqid và uuidVal riêng nên không conflict.
    const panelConcurrency = Math.min(
      panelCount,
      Math.max(1, parseInt(process.env.GEMINI_WEBAPI_PANEL_CONCURRENCY || String(panelCount), 10))
    );
    log(`Generating ${panelCount} panel image(s) in parallel (concurrency=${panelConcurrency})...`);

    // Upload storyboard 1 lần, dùng chung cho tất cả panels.
    const sbBuf = fs.readFileSync(storyboardPath);
    const sbUrl = await client.uploadFile(sbBuf, 'storyboard.png', 'image/png');
    const panelFileData = [{ url: sbUrl, filename: 'storyboard.png', mimeType: 'image/png' }];

    /**
     * Generate one panel image using the shared client.
     * @param {number} idx  0-based panel index
     */
    async function generatePanelParallel(idx) {
      const panelIndex = idx + 1;
      const prompt = analysis.veo3Prompts[idx];
      log(`[Panel ${panelIndex}] Requesting image...`);

      const result = await client.generateContent({
        prompt: buildPanelPrompt(
          !!storyboardPath,
          panelIndex,
          panelCount,
          analysis.script[idx],
          prompt,
          options
        ),
        fileData: panelFileData,
        temporary: true,
        expectImages: true,
      });

      const imgBuf = await client.downloadImage(result.images[0].url);
      const panelPath = path.join(outputDir, `panel-${panelIndex}.png`);
      fs.writeFileSync(panelPath, imgBuf);
      log(`[Panel ${panelIndex}] ✅ Done`);

      return {
        index: panelIndex,
        prompt,
        imageBase64: imgBuf.toString('base64'),
        mimeType: 'image/png',
        sourcePath: panelPath,
      };
    }

    // ── Concurrency pool ──────────────────────────────────────────────────────
    const allIndices = Array.from({ length: panelCount }, (_, i) => i);
    const panelResults = [];

    for (let start = 0; start < panelCount; start += panelConcurrency) {
      const batch = allIndices.slice(start, start + panelConcurrency);
      log(`Starting panel batch [${batch.map(i => i + 1).join(', ')}]...`);

      const settled = await Promise.allSettled(batch.map(idx => generatePanelParallel(idx)));

      for (let bi = 0; bi < settled.length; bi++) {
        const panelIndex = batch[bi] + 1;
        if (settled[bi].status === 'fulfilled') {
          panelResults.push(settled[bi].value);
        } else {
          log(`[Panel ${panelIndex}] ❌ Failed: ${settled[bi].reason?.message}`);
          panelResults.push({
            index: panelIndex,
            prompt: analysis.veo3Prompts[batch[bi]],
            error: settled[bi].reason?.message,
          });
        }
      }
    }

    const panels = panelResults.filter(p => !p.error);
    panels.sort((a, b) => a.index - b.index);

    return {
      analysis: analysis.analysis || {},
      script: analysis.script,
      frameData: analysis.frameData || '',
      cropTemplate: analysis.cropTemplate || '',
      veo3Prompts: analysis.veo3Prompts,
      storyboard: {
        imageBase64: storyboardB64,
        mimeType: storyboardB64 ? 'image/png' : null,
        sourcePath: storyboardPath,
      },
      panels,
    };

  } finally {
    try { await client.close(); } catch (_) {}
  }
}

module.exports = { run };
