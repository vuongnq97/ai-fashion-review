'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { GeminiApiClient } = require('../gemini-client/gemini-api');
const { createFlowPage, closeFlowPage } = require('../browser');
const { prepareGeneration, executeGeneration } = require('../image');
const { generateVideosFromPanelsDirect } = require('../gemini-webapi-storyboard');

function repairJsonText(text) {
  return String(text || '')
    .replace(/^\uFEFF/u, '')
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/,\s*([}\]])/gu, '$1')
    // Gemini occasionally omits the comma between two array objects/values.
    .replace(/([}\]])(\s*)(?=[{\[])/gu, '$1,$2')
    // It can also omit a comma at a line break between object properties or string array items.
    .replace(/("|\d|true|false|null)(\s*\r?\n\s*)(?=["{\[\d-]|true|false|null)/gu, '$1,$2');
}

function parseJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const candidates = [raw];
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  let lastError = null;
  for (const candidate of candidates) {
    for (const value of [candidate, repairJsonText(candidate)]) {
      try { return JSON.parse(value); } catch (error) { lastError = error; }
    }
  }
  const error = new SyntaxError(`Provider returned invalid JSON after repair: ${lastError?.message || 'unknown parse error'}`);
  error.providerPreview = raw.slice(0, 180);
  throw error;
}

function readReferenceBuffer(reference) {
  if (Buffer.isBuffer(reference?.buffer)) return reference.buffer;
  if (reference?.base64) return Buffer.from(reference.base64, 'base64');
  const filePath = reference?.uri || reference?.path || reference?.imagePath;
  return filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

function createDefaultProviderAdapter(baseDir, options = {}) {
  const cookieFilePath = process.env.GEMINI_COOKIE_PATH
    ? path.resolve(baseDir, process.env.GEMINI_COOKIE_PATH)
    : path.join(baseDir, 'gemini-cookies');
  const gemini = new GeminiApiClient({ cookieFilePath: fs.existsSync(cookieFilePath) ? cookieFilePath : undefined });
  const uploaded = new Map();
  let flowPage = null;
  let initialized = false;

  async function init() {
    if (!initialized) {
      await gemini.init();
      initialized = true;
    }
  }

  async function uploadReferences(references) {
    await init();
    const fileData = [];
    for (const [index, reference] of (references || []).entries()) {
      const buffer = readReferenceBuffer(reference);
      if (!buffer) continue;
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      let url = uploaded.get(hash);
      const filename = reference.name || `reference-${index + 1}.png`;
      const mimeType = reference.mimeType || 'image/png';
      if (!url) {
        url = await gemini.uploadFile(buffer, filename, mimeType);
        uploaded.set(hash, url);
      }
      fileData.push({ url, filename, mimeType });
    }
    return fileData;
  }

  async function analyzeStructured({ prompt, references = [] }) {
    const fileData = await uploadReferences(references);
    let lastError;
    let lastText = '';
    const maxAttempts = Math.max(2, Math.min(5, Number(process.env.STORYBOARD_JSON_RETRIES || 2) + 1));
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const retrySuffix = attempt === 1 ? '' : `
Your previous response could not be parsed as JSON (${lastError?.message || 'invalid syntax'}).
Return ONE compact RFC 8259 JSON object only. No Markdown, comments, ellipsis or prose. Put a comma between every array item and object property. Close every array and object.`;
        const response = await gemini.generateContent({ prompt: `${prompt}${retrySuffix}`, fileData, temporary: true, expectImages: false });
        lastText = response.text || '';
        return parseJson(response.text);
      } catch (error) {
        lastError = error;
      }
    }
    if (lastText && options.diagnosticsDir) {
      try {
        fs.mkdirSync(options.diagnosticsDir, { recursive: true });
        const diagnosticPath = path.join(options.diagnosticsDir, `invalid-json-${Date.now()}.txt`);
        fs.writeFileSync(diagnosticPath, lastText, 'utf8');
        lastError.diagnosticPath = diagnosticPath;
        lastError.message = `${lastError.message} (raw response: ${diagnosticPath})`;
      } catch (_) {}
    }
    throw lastError;
  }

  async function generateImage({ prompt, references = [], aspectRatio = '9:16' }) {
    if (!flowPage) flowPage = await createFlowPage(baseDir);
    const filePayloads = references.map((reference, index) => ({
      name: reference.name || `reference-${index + 1}.png`,
      mimeType: reference.mimeType || 'image/png',
      buffer: readReferenceBuffer(reference),
    })).filter(item => item.buffer);
    const prepared = await prepareGeneration(flowPage, prompt, filePayloads, {
      imageModel: options.imageModel || 'nano-banana-2',
      aspectRatio,
      outputCount: 1,
    }, baseDir);
    const result = await executeGeneration(prepared);
    if (!result?.base64) throw new Error('Image provider returned no image');
    return { buffer: Buffer.from(result.base64, 'base64'), mimeType: result.mimeType || 'image/png' };
  }

  async function inspectImage({ image, prompt, references = [] }) {
    return analyzeStructured({ prompt, references: [{ name: 'generated-panel.png', mimeType: 'image/png', buffer: image }, ...references] });
  }

  async function generateVideos(jobs, videoOptions = {}) {
    return generateVideosFromPanelsDirect(baseDir, jobs, videoOptions);
  }

  async function inspectVideo({ videoPath, prompt, references = [] }) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-v2-videoqa-'));
    try {
      const framePattern = path.join(tmpDir, 'frame-%02d.png');
      execFileSync(ffmpegPath, ['-y', '-i', videoPath, '-vf', 'fps=3/4,scale=540:-2', '-frames:v', '3', framePattern], { stdio: 'pipe', timeout: 30000 });
      const frames = fs.readdirSync(tmpDir).filter(name => name.endsWith('.png')).sort().map(name => ({ name, mimeType: 'image/png', buffer: fs.readFileSync(path.join(tmpDir, name)) }));
      if (!frames.length) throw new Error('Could not extract frames for video QA');
      return analyzeStructured({ prompt, references: [...frames, ...references] });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  async function close() {
    if (flowPage) {
      try { await closeFlowPage(flowPage); } catch (_) {}
      flowPage = null;
    }
    if (initialized) {
      try { await gemini.close(); } catch (_) {}
      initialized = false;
    }
  }

  return {
    analyzeStructured,
    generateImage,
    generateVideos,
    inspectImage,
    inspectVideo,
    close,
    capabilities: {
      maxImageReferences: 4,
      supportsImageEdit: false,
      supportsInpainting: false,
      supportedImageRatios: ['1:1', '9:16', '16:9', '3:4', '4:3'],
      supportedVideoDurations: [4, 8],
    },
  };
}

module.exports = { createDefaultProviderAdapter, parseJson, readReferenceBuffer, repairJsonText };
