const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const state = require('../utils/state');
const { markShortlinkUploaded } = require('../services/auto-scheduler');
const { getBrowserPage } = require('../services/browser');
const { automateGeneration, prepareGeneration, executeGeneration } = require('../services/image');
const { automateVideoGeneration, prepareVideoGeneration, executeVideoGeneration } = require('../services/video');
const tiktok = require('../services/tiktok');
const { getStoryboardProvider } = require('../services/storyboard-provider');
const { runStoryboardFullFlow } = require('../services/storyboard-fullflow');
const { sendVideoToTelegramDirect } = require('../services/telegram-send');
const { processVideoBase64 } = require('../services/video-resize');
const {
  enqueueGenerationJob,
  getJob,
  getJobResult,
  getLatestCompletedJobForChat,
  publicJob,
  markUpload,
  prepareUploadJob,
  cleanupJob,
  setJobCommand,
  waitForJobCommand,
  remakeJobPanels,
  changeJobTemplate,
} = require('../services/generation-job');
const {
  extractProductAssetsFromHtml,
  extractProductIdFromUrl,
} = require('../services/product-assets');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });
const baseDir = path.resolve(__dirname, '..');

// ═══════════════════════════════════════════════════════════════
// n8n orchestration job routes
// ═══════════════════════════════════════════════════════════════

router.post('/product-assets/extract', async (req, res) => {
  try {
    const { html, productUrl } = req.body || {};
    if (!html) {
      return res.status(400).json({ success: false, error: 'html is required' });
    }
    const assets = extractProductAssetsFromHtml(html, productUrl || '');
    if (!assets.productId && productUrl) {
      assets.productId = extractProductIdFromUrl(productUrl);
    }
    res.json({ success: true, ...assets });
  } catch (error) {
    console.error('[ProductAssets] Extract error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/jobs/enqueue', async (req, res) => {
  try {
    const { job, isOwner } = enqueueGenerationJob(req.body || {}, baseDir);
    res.json({
      success: true,
      jobId: job.jobId,
      isOwner,
      status: job.status,
      currentStep: job.currentStep,
      stepOrder: job.stepOrder,
      progressPercent: job.progressPercent,
    });
  } catch (error) {
    console.error('[Jobs] Enqueue error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

router.get('/jobs/latest', (req, res) => {
  const { chatId } = req.query || {};
  const job = getLatestCompletedJobForChat(chatId);
  if (!job) return res.status(404).json({ success: false, error: 'No completed job found for chatId' });
  res.json({ success: true, ...publicJob(job) });
});

router.post('/jobs/command', (req, res) => {
  try {
    const {
      chatId: rawChatId,
      command,
      targetJobId,
      panels,
      instruction,
      template,
      rawText,
    } = req.body || {};

    if (!command) {
      return res.status(400).json({ success: false, error: 'command is required' });
    }

    let targetJob = targetJobId ? getJob(targetJobId) : null;
    const chatId = rawChatId || targetJob?.chatId;
    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId or targetJobId is required' });
    }

    if (!targetJob && targetJobId) {
      return res.status(404).json({ success: false, error: 'Target job not found' });
    }
    if (!targetJob) {
      targetJob = getLatestCompletedJobForChat(chatId);
    }

    const signal = setJobCommand(chatId, {
      command,
      targetJobId: targetJobId || targetJob?.jobId || null,
      panels: Array.isArray(panels) ? panels : [],
      instruction: instruction || '',
      template: template || null,
      rawText: rawText || '',
    });

    res.json({
      success: true,
      ...signal,
      command,
      chatId: String(chatId),
      jobId: targetJob?.jobId || null,
      message: signal.delivery === 'delivered'
        ? 'Command delivered to waiting workflow execution.'
        : 'Command queued; waiting workflow will pick it up on next poll.',
    });
  } catch (error) {
    console.error('[Jobs] Command signal error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, ...publicJob(job) });
});

router.get('/jobs/:jobId/result', (req, res) => {
  const result = getJobResult(req.params.jobId);
  if (!result) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, ...result });
});

router.get('/jobs/:jobId/assets/inputs', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  const images = (job.sourceImages || []).map((img, idx) => ({
    index: idx + 1,
    name: img.name,
    mimeType: img.mimeType || 'image/jpeg',
    size: img.size || 0,
    sourceUrl: img.sourceUrl || '',
    previewBase64: (img.path && fs.existsSync(img.path) ? `data:${img.mimeType || 'image/jpeg'};base64,${fs.readFileSync(img.path).toString('base64')}` : null),
  }));
  res.json({
    success: true,
    jobId: job.jobId,
    productTitle: job.productTitle || 'TikTok Shop',
    totalImages: images.length,
    images,
  });
});

router.get('/jobs/:jobId/assets/storyboard', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  const sb = job.result?.storyboard || null;
  res.json({
    success: true,
    jobId: job.jobId,
    template: job.template || 'template3',
    storyboard: sb ? {
      sourcePath: sb.sourcePath || '',
      mimeType: sb.mimeType || 'image/png',
      previewBase64: sb.imageBase64 ? `data:image/png;base64,${sb.imageBase64}` : null,
    } : null,
  });
});

router.get('/jobs/:jobId/assets/panels', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  const panels = (job.result?.panels || []).map(p => ({
    index: p.index,
    prompt: p.prompt || '',
    previewBase64: p.imageBase64 ? `data:image/png;base64,${p.imageBase64}` : null,
  }));
  res.json({
    success: true,
    jobId: job.jobId,
    totalPanels: panels.length,
    panels,
  });
});

router.get('/jobs/:jobId/assets/videos', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  const videos = (job.result?.videos || []).map(v => ({
    panelIndex: v.panelIndex,
    videoPath: v.videoPath || '',
    remakeCommand: `/remake_${v.panelIndex}`,
  }));
  res.json({
    success: true,
    jobId: job.jobId,
    totalVideos: videos.length,
    videos,
  });
});

router.get('/jobs/:jobId/assets/input-cover.jpg', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job || !job.sourceImages || job.sourceImages.length === 0) return res.status(404).send('Not found');
  const img = job.sourceImages[0];
  if (img.path && fs.existsSync(img.path)) {
    res.setHeader('Content-Type', img.mimeType || 'image/jpeg');
    return fs.createReadStream(img.path).pipe(res);
  }
  res.status(404).send('Not found');
});

router.get('/jobs/:jobId/assets/storyboard.png', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).send('Job not found');
  const sb = job.result?.storyboard;
  if (sb?.sourcePath && fs.existsSync(sb.sourcePath)) {
    res.setHeader('Content-Type', 'image/png');
    return fs.createReadStream(sb.sourcePath).pipe(res);
  }
  if (sb?.imageBase64) {
    res.setHeader('Content-Type', 'image/png');
    return res.end(Buffer.from(sb.imageBase64, 'base64'));
  }
  // Try fallback in job dir
  const fallback = path.join(job.jobDir, 'run', 'storyboard.png');
  if (fs.existsSync(fallback)) {
    res.setHeader('Content-Type', 'image/png');
    return fs.createReadStream(fallback).pipe(res);
  }
  res.status(404).send('Storyboard not ready');
});

router.get('/jobs/:jobId/assets/panels/:index.png', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).send('Job not found');
  const idx = parseInt(req.params.index || '1', 10);
  const panel = (job.result?.panels || []).find(p => p.index === idx);
  if (panel?.sourcePath && fs.existsSync(panel.sourcePath)) {
    res.setHeader('Content-Type', 'image/png');
    return fs.createReadStream(panel.sourcePath).pipe(res);
  }
  if (panel?.imageBase64) {
    res.setHeader('Content-Type', 'image/png');
    return res.end(Buffer.from(panel.imageBase64, 'base64'));
  }
  const fallback = path.join(job.jobDir, 'run', 'panels', `panel-${idx}.png`);
  if (fs.existsSync(fallback)) {
    res.setHeader('Content-Type', 'image/png');
    return fs.createReadStream(fallback).pipe(res);
  }
  res.status(404).send('Panel not ready');
});

router.get('/jobs/:jobId/assets/videos/:index.mp4', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).send('Job not found');
  const idx = parseInt(req.params.index || '1', 10);
  const video = (job.result?.videos || []).find(v => v.panelIndex === idx);
  if (video?.videoPath && fs.existsSync(video.videoPath)) {
    res.setHeader('Content-Type', 'video/mp4');
    return fs.createReadStream(video.videoPath).pipe(res);
  }
  if (video?.videoBase64) {
    res.setHeader('Content-Type', 'video/mp4');
    return res.end(Buffer.from(video.videoBase64, 'base64'));
  }
  res.status(404).send('Video not ready');
});

router.get('/jobs/:jobId/final-video', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  if (!job.finalVideoPath || !fs.existsSync(job.finalVideoPath)) {
    return res.status(404).json({ success: false, error: 'Final video not found' });
  }
  res.download(job.finalVideoPath, `${job.jobId}-final.mp4`);
});

router.post('/jobs/:jobId/prepare-upload', async (req, res) => {
  try {
    const result = await prepareUploadJob(req.params.jobId);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[Jobs] Prepare-upload error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/jobs/:jobId/upload-state', (req, res) => {
  const job = markUpload(req.params.jobId, req.body || {});
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

  // Nếu upload TikTok thành công → đánh dấu shortlink đã dùng
  const uploadStatus = (req.body || {}).status || '';
  const isSuccess = uploadStatus === 'success' || uploadStatus === 'completed' || uploadStatus === 'uploaded';
  if (isSuccess && job.shortlink) {
    try {
      markShortlinkUploaded(job.shortlink);
    } catch (e) {
      console.warn('[Routes] markShortlinkUploaded error:', e.message);
    }
  }

  res.json({ success: true, upload: job.upload });
});

router.delete('/jobs/:jobId', (req, res) => {
  const ok = cleanupJob(req.params.jobId);
  if (!ok) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true });
});

router.get('/jobs/:jobId/wait-command', async (req, res) => {
  try {
    const timeoutMs = parseInt(req.query.timeout || '10', 10) * 1000;
    const result = await waitForJobCommand(req.params.jobId, timeoutMs);
    res.json(result);
  } catch (error) {
    console.error('[Jobs] Wait-command error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/jobs/:jobId/remake', async (req, res) => {
  try {
    const { panels, instruction } = req.body || {};
    const result = await remakeJobPanels(req.params.jobId, panels, instruction);
    res.json(result);
  } catch (error) {
    console.error('[Jobs] Remake error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/jobs/:jobId/change-template', async (req, res) => {
  try {
    const { template } = req.body || {};
    if (!template) return res.status(400).json({ success: false, error: 'template is required' });
    const result = await changeJobTemplate(req.params.jobId, template);
    res.json(result);
  } catch (error) {
    console.error('[Jobs] Change-template error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

// ── Request Queue for serializing Playwright operations ──
// Only one generation can run at a time since they share a single browser page
let generateQueue = Promise.resolve();
function enqueue(fn) {
  const task = generateQueue.then(fn, fn); // run fn regardless of previous result
  generateQueue = task.then(() => {}, () => {}); // swallow errors in chain
  return task;
}

router.post('/generate', upload.array('images', 5), async (req, res) => {
  const files = req.files;
  const body = req.body || {};

  // Enqueue so setup phase is processed one at a time
  const enqueueResult = enqueue(async () => {
    let imagePathsToClean = [];
    try {
      console.log(JSON.stringify(body).substring(0, 500));
      console.log(`[API] Raw body fileNames:`, body.fileNames);
      const { prompt, base64Images, mode, imageModel, aspectRatio, outputCount, imageSelection, fileNames } = body;

      if (!prompt) {
        res.status(400).json({ error: 'Prompt is required' });
        return;
      }

      let filePayloads = [];

      // Handle physical file uploads
      if (files && files.length > 0) {
        files.forEach((f, idx) => {
          const fPath = path.join(baseDir, f.path);
          imagePathsToClean.push(fPath);
          const name = (fileNames && fileNames[idx]) ? fileNames[idx] : (f.originalname || 'upload.png');
          filePayloads.push({ name, mimeType: f.mimetype, buffer: fs.readFileSync(fPath) });
        });
      }

      // Handle base64 string uploads
      if (base64Images) {
        const b64Array = Array.isArray(base64Images) ? base64Images : [base64Images];
        b64Array.forEach((b64, idx) => {
          const name = (fileNames && fileNames[idx]) ? fileNames[idx] : `b64_${idx}.png`;
          filePayloads.push({ name, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
        });
      }

      const config = {
        mode: mode || 'ingredients-to-image',
        imageModel: imageModel || 'nano-banana-2',
        aspectRatio: aspectRatio || '9:16',
        outputCount: parseInt(outputCount) || 1,
        imageSelection: imageSelection
      };

      console.log(`[API] Received: prompt="${prompt.substring(0, 60)}...", files=${filePayloads.length}, config=${JSON.stringify(config)}`);
      console.log(`[API] imageSelection from body:`, JSON.stringify(imageSelection));
      console.log(`[Queue] Processing request (queue active)...`);

      const page = await getBrowserPage(baseDir);

      // PHASE 1 (inside lock): Setup — upload, resolve UUIDs, get tokens
      const prepared = await prepareGeneration(page, prompt, filePayloads, config, baseDir);
      return prepared; // return prepared data out of enqueue
    } catch (error) {
      console.error('API Error:', error);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: error.message });
      }
    } finally {
      imagePathsToClean.forEach(p => {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { }
      });
    }
  });

  // PHASE 2 (outside lock): API call + fetch result — runs in parallel
  try {
    const prepared = await enqueueResult;
    if (!prepared || res.headersSent) return; // phase 1 failed
    const result = await executeGeneration(prepared);
    res.json({ success: true, image: result });
  } catch (error) {
    console.error('[Gen Phase 2] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

router.post('/generate-video', upload.array('images', 5), async (req, res) => {
  const files = req.files;
  const body = req.body || {};

  // Phase 1 (queued): browser setup + start API call
  const enqueueResult = enqueue(async () => {
    let imagePathsToClean = [];
    try {
      const { prompt, extendPrompt, base64Images, imageSelection, fileNames, aspectRatio, videoModelKey, chatId, panelIndex, panelName } = body;

      if (!prompt) {
        res.status(400).json({ error: 'Prompt is required' });
        return;
      }

      let filePayloads = [];

      if (files && files.length > 0) {
        files.forEach((f, idx) => {
          const fPath = path.join(baseDir, f.path);
          imagePathsToClean.push(fPath);
          const name = (fileNames && fileNames[idx]) ? fileNames[idx] : (f.originalname || 'upload.png');
          filePayloads.push({ name, mimeType: f.mimetype, buffer: fs.readFileSync(fPath) });
        });
      }

      if (base64Images) {
        const b64Array = Array.isArray(base64Images) ? base64Images : [base64Images];
        b64Array.forEach((b64, idx) => {
          const name = (fileNames && fileNames[idx]) ? fileNames[idx] : `b64_${idx}.png`;
          filePayloads.push({ name, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
        });
      }

      console.log(`[VideoGen] Received: prompt="${prompt.substring(0, 60)}...", files=${filePayloads.length}`);

      const page = await getBrowserPage(baseDir);
      const config = { imageSelection, aspectRatio: aspectRatio || '9:16', videoModelKey: videoModelKey || null };
      
      // PHASE 1: Setup + start API (inside lock)
      const prepared = await prepareVideoGeneration(page, prompt, extendPrompt, filePayloads, config, baseDir);
      return prepared;
    } catch (error) {
      console.error('API Error:', error);
      if (!res.headersSent) res.status(500).json({ success: false, error: error.message });
    } finally {
      imagePathsToClean.forEach(p => {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { }
      });
    }
  });

  // Phase 2 (outside lock): poll + fetch — runs in parallel with other videos
  try {
    const prepared = await enqueueResult;
    if (!prepared || res.headersSent) return;
    const resultBase64 = await executeVideoGeneration(prepared);
    if (resultBase64) {
      const { chatId, panelIndex, panelName } = body;
      const targetChatId = chatId || process.env.DEFAULT_TELEGRAM_CHAT_ID;
      if (targetChatId) {
        console.log(`[VideoGen] Sending video directly to Telegram for chatId: ${targetChatId}, panel: ${panelName || panelIndex}`);
        sendVideoToTelegramDirect(targetChatId, resultBase64, panelIndex, panelName).catch(err => {
          console.error('[VideoGen] Direct Telegram send failed:', err.message);
        });
      }
      res.json({ success: true, video: { base64: resultBase64, mimeType: 'video/mp4' } });
    } else {
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Could not extract generated video' });
    }
  } catch (error) {
    console.error('[VideoGen Phase 2] Error:', error);
    if (!res.headersSent) res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// Video Utilities Routes
// ═══════════════════════════════════════════════════════════════

router.post('/resize-video', async (req, res) => {
  const body = req.body || {};
  try {
    const { videoBase64, cropPercent, cropPx, aspectRatio, width, height } = body;
    
    if (!videoBase64) {
      return res.status(400).json({ success: false, error: 'videoBase64 is required' });
    }

    const options = {};
    if (cropPercent !== undefined) options.cropPercent = cropPercent;
    if (cropPx !== undefined) options.cropPx = cropPx;
    if (aspectRatio !== undefined) options.aspectRatio = aspectRatio;
    if (width !== undefined) options.width = width;
    if (height !== undefined) options.height = height;

    console.log(`[API] Resizing video, options:`, options);
    
    const resultBase64 = await processVideoBase64(videoBase64, options);
    
    res.json({ success: true, videoBase64: resultBase64 });
  } catch (error) {
    console.error('[ResizeVideo] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// AI Studio Storyboard Routes (with server-side request batching)
// ═══════════════════════════════════════════════════════════════

// Batch accumulator: groups requests by batchKey (chatId) within a time window
const storyboardBatches = new Map();
const BATCH_WAIT_MS = 5000; // Wait 5 seconds for more images before processing

router.post('/generate-storyboard', upload.array('images', 10), async (req, res) => {
  const files = req.files;
  const body = req.body || {};
  let imagePathsToClean = [];

  try {
    const { base64Images, fileNames, aspectRatio, videoModelKey, generateVideos, includeVideoBase64, batchKey } = body;
    let filePayloads = [];

    // Handle physical file uploads
    if (files && files.length > 0) {
      files.forEach((f, idx) => {
        const fPath = path.join(baseDir, f.path);
        imagePathsToClean.push(fPath);
        const name = (fileNames && fileNames[idx]) ? fileNames[idx] : (f.originalname || 'upload.png');
        filePayloads.push({ name, mimeType: f.mimetype, buffer: fs.readFileSync(fPath) });
      });
    }

    // Handle base64 string uploads
    if (base64Images) {
      const b64Array = Array.isArray(base64Images) ? base64Images : [base64Images];
      b64Array.forEach((b64, idx) => {
        const name = (fileNames && fileNames[idx]) ? fileNames[idx] : `image_${idx}.png`;
        filePayloads.push({ name, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
      });
    }

    if (filePayloads.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one image is required' });
    }

    const options = {
      generateVideos: generateVideos === undefined ? true : String(generateVideos) !== 'false',
      includeVideoBase64: String(includeVideoBase64) === 'true',
      aspectRatio: aspectRatio || '9:16',
      videoModelKey: videoModelKey || null
    };

    // If no batchKey, process immediately (single image, no batching)
    if (!batchKey) {
      console.log(`[API] Storyboard: ${filePayloads.length} image(s) received (no batch)`);
      const provider = getStoryboardProvider(baseDir);
      console.log(`[API] Storyboard provider: ${provider.name}`);
      const results = await provider.generateStoryboard(baseDir, filePayloads, options);
      return res.json({ success: true, results, isPrimary: true });
    }

    // ── Batching logic ───────────────────────────────────────
    console.log(`[API] Storyboard batch "${batchKey}": +${filePayloads.length} image(s)`);

    if (!storyboardBatches.has(batchKey)) {
      storyboardBatches.set(batchKey, {
        images: [],
        waiters: [],
        timer: null,
        options,
        primaryIdx: 0, // first request is primary
      });
    }

    const batch = storyboardBatches.get(batchKey);
    const myIdx = batch.waiters.length;
    batch.images.push(...filePayloads);

    // Create a promise that this request will wait on
    const resultPromise = new Promise((resolve, reject) => {
      batch.waiters.push({ resolve, reject });
    });

    // Reset the batch timer (extend window on each new image)
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(async () => {
      const { images, waiters, options: batchOpts } = batch;
      storyboardBatches.delete(batchKey);

      console.log(`[API] Storyboard batch "${batchKey}": processing ${images.length} image(s) for ${waiters.length} waiter(s)`);

      try {
        const provider = getStoryboardProvider(baseDir);
        console.log(`[API] Storyboard provider: ${provider.name}`);
        const results = await provider.generateStoryboard(baseDir, images, batchOpts);
        waiters.forEach((w, idx) => w.resolve({ results, isPrimary: idx === 0 }));
      } catch (err) {
        waiters.forEach(w => w.reject(err));
      }
    }, BATCH_WAIT_MS);

    // Wait for batch to complete
    const { results, isPrimary } = await resultPromise;
    res.json({ success: true, results, isPrimary });

  } catch (error) {
    console.error('[Storyboard] Error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  } finally {
    imagePathsToClean.forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// Provider-based full-flow automation route
// ═══════════════════════════════════════════════════════════════

const automationBatches = new Map();
const AUTOMATION_BATCH_WAIT_MS = 5000;

router.post('/automate-storyboard', upload.array('images', 10), async (req, res) => {
  const files = req.files;
  const body = req.body || {};
  let imagePathsToClean = [];

  try {
    const { base64Images, fileNames, chatId } = body;
    const targetChatId = chatId || process.env.DEFAULT_TELEGRAM_CHAT_ID || '8724472821';
    let filePayloads = [];

    // Handle physical file uploads
    if (files && files.length > 0) {
      files.forEach((f, idx) => {
        const fPath = path.join(baseDir, f.path);
        imagePathsToClean.push(fPath);
        const name = (fileNames && fileNames[idx]) ? fileNames[idx] : (f.originalname || 'upload.png');
        filePayloads.push({ name, mimeType: f.mimetype, buffer: fs.readFileSync(fPath) });
      });
    }

    // Handle base64 string uploads
    if (base64Images) {
      const b64Array = Array.isArray(base64Images) ? base64Images : [base64Images];
      b64Array.forEach((b64, idx) => {
        const name = (fileNames && fileNames[idx]) ? fileNames[idx] : `image_${idx}.png`;
        filePayloads.push({ name, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
      });
    }

    if (filePayloads.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one image is required' });
    }

    // ── Batching logic ───────────────────────────────────────
    console.log(`[API] Automate batch "${targetChatId}": +${filePayloads.length} image(s)`);

    if (!automationBatches.has(targetChatId)) {
      automationBatches.set(targetChatId, {
        images: [],
        timer: null
      });
    }

    const batch = automationBatches.get(targetChatId);
    batch.images.push(...filePayloads);

    // Reset the batch timer (extend window on each new image)
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(async () => {
      const { images } = batch;
      automationBatches.delete(targetChatId);

      console.log(`[API] Automate batch "${targetChatId}": trigger provider full flow with ${images.length} image(s)...`);
      
      // Asynchronously trigger provider-based full flow in the background.
      runStoryboardFullFlow(targetChatId, images, baseDir).catch(err => {
        console.error(`[API] Background full flow error for ${targetChatId}:`, err.message);
      });
    }, AUTOMATION_BATCH_WAIT_MS);

    // Return immediately to n8n to avoid timeouts
    res.json({ success: true, message: 'Automation triggered' });

  } catch (error) {
    console.error('[Automate API] Error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  } finally {
    imagePathsToClean.forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// TikTok API Routes
// ═══════════════════════════════════════════════════════════════

// GET /api/tiktok/auth — Get OAuth authorization URL (JSON)
router.get('/tiktok/auth', (req, res) => {
    const state = req.query.state || `state_${Date.now()}`;
    const authUrl = tiktok.getAuthUrl(state);
    console.log(`[TikTok] Auth URL generated for state: ${state}`);
    res.json({ success: true, authUrl, state });
});

// GET /api/tiktok/login — Redirect directly to TikTok (For Telegram buttons)
router.get('/tiktok/login', (req, res) => {
    const state = req.query.state || `state_${Date.now()}`;
    const authUrl = tiktok.getAuthUrl(state);
    res.redirect(authUrl);
});

// POST /api/tiktok/callback — Exchange auth code for tokens
router.post('/tiktok/callback', async (req, res) => {
    try {
        const { code, state } = req.body;
        if (!code) {
            return res.status(400).json({ success: false, error: 'Authorization code is required' });
        }
        const tokenData = await tiktok.exchangeCodeForToken(code, state);
        res.json({ success: true, ...tokenData });
    } catch (error) {
        console.error('[TikTok] Callback error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/tiktok/upload — Upload video to TikTok
router.post('/tiktok/upload', async (req, res) => {
    try {
        // Can accept either open_id OR telegram_id (state)
        const { open_id, telegram_id, base64Video, title, privacyLevel } = req.body;
        const lookupId = open_id || telegram_id;

        if (!lookupId || !base64Video) {
            return res.status(400).json({ success: false, error: 'open_id (or telegram_id) and base64Video are required' });
        }

        const accessToken = await tiktok.getValidToken(lookupId);
        const result = await tiktok.uploadVideoBase64(accessToken, base64Video, {
            title: title || 'AI Fashion Video ✨ #fashion #ai #tryon',
            privacyLevel: privacyLevel || 'SELF_ONLY',
        });

        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[TikTok] Upload error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/tiktok/user — Get authenticated user info
router.get('/tiktok/user', async (req, res) => {
    try {
        const { open_id } = req.query;
        if (!open_id) {
            return res.status(400).json({ success: false, error: 'open_id is required' });
        }
        const accessToken = await tiktok.getValidToken(open_id);
        const userInfo = await tiktok.getUserInfo(accessToken);
        res.json({ success: true, user: userInfo });
    } catch (error) {
        console.error('[TikTok] User info error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/tiktok/tokens — Debug: list stored tokens
router.get('/tiktok/tokens', (req, res) => {
    const store = tiktok.getTokenStore();
    const sanitized = Object.entries(store).map(([id, t]) => ({
        open_id: id,
        expires_at: new Date(t.expires_at).toISOString(),
        is_valid: Date.now() < t.expires_at,
    }));
    res.json({ success: true, tokens: sanitized });
});

// GET /api/tiktok/trending-music — Scrape trending music by search query or URL
router.get('/tiktok/trending-music', async (req, res) => {
    try {
        const { scrapeTikTokTrendingMusic } = require('../services/tiktok-music-scraper');
        const query = req.query.q || req.query.url || 'nhạc trend xu hướng 2026 viral viet nam';
        const tracks = await scrapeTikTokTrendingMusic(query, {
            maxScrolls: parseInt(req.query.scrolls || '3', 10),
        });
        res.json({ success: true, query, total: tracks.length, tracks });
    } catch (error) {
        console.error('[TikTokMusic] Trending music scraping error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// Utility Routes
// ═══════════════════════════════════════════════════════════════

// GET /api/export-cookies — Export current browser session cookies to file
router.get('/export-cookies', async (req, res) => {
    try {
        const context = require('../utils/state').getContext?.() || require('../services/browser').getContext();
        if (!context) {
            return res.status(400).json({ success: false, error: 'No browser context running. Start a generation first.' });
        }

        const allCookies = await context.cookies(['https://labs.google']);
        const relevantCookies = allCookies.map(c => {
            const cookie = {
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                expires: c.expires,
                httpOnly: c.httpOnly,
                secure: c.secure,
            };
            if (c.sameSite && c.sameSite !== 'None') {
                cookie.sameSite = c.sameSite;
            }
            return cookie;
        });

        const cookiesPath = path.join(baseDir, 'labs.google.cookies.json');

        // Backup old cookies
        if (fs.existsSync(cookiesPath)) {
            const backupPath = cookiesPath.replace('.json', `.backup-${Date.now()}.json`);
            fs.copyFileSync(cookiesPath, backupPath);
            console.log(`[Cookies] Backed up old cookies to ${path.basename(backupPath)}`);
        }

        fs.writeFileSync(cookiesPath, JSON.stringify(relevantCookies, null, 2));

        const sessionCookie = relevantCookies.find(c => c.name === '__Secure-next-auth.session-token');
        const expiresAt = sessionCookie ? new Date(sessionCookie.expires * 1000).toISOString() : null;

        console.log(`[Cookies] ✅ Exported ${relevantCookies.length} cookies`);
        res.json({
            success: true,
            cookieCount: relevantCookies.length,
            sessionExpires: expiresAt,
            emails: relevantCookies.filter(c => c.name.toLowerCase().includes('email')).map(c => ({ name: c.name, value: decodeURIComponent(c.value) }))
        });
    } catch (error) {
        console.error('[Cookies] Export error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
