'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { flowQueue } = require('./flow-queue');
const { runStoryboardFullFlow } = require('./storyboard-fullflow');
const {
  sendTelegramMessage,
  sendPhotoToTelegram,
  sendMediaGroupToTelegram,
  sendVideoToTelegramDirect,
  sendMergedVideoToTelegram
} = require('./telegram-send');
const { downloadProductImages } = require('./product-assets');
const { mergeVideos } = require('./video-merge');

const JOB_ROOT = process.env.GENERATION_JOB_ROOT || path.join(os.tmpdir(), 'ai-fashion-review', 'jobs');
const DEFAULT_TEMPLATE = process.env.DEFAULT_STORYBOARD_TEMPLATE || 'template3';
const MAX_IMAGES = Number(process.env.PRODUCT_IMAGE_LIMIT || '8');
const MIN_IMAGES = Number(process.env.PRODUCT_IMAGE_MIN || '1');

const jobs = new Map();
const activeByChatProduct = new Map();
const latestCompletedByChat = new Map();

const STEPS = {
  failed: -1,
  queued: 0,
  product_assets_extracted: 1,
  product_analyzed: 2,
  storyboard_generated: 3,
  panels_generated: 4,
  generating_videos: 5,
  videos_generated: 6,
  completed: 7,
};

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeId(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function makeJobId(chatId, productId) {
  return `tg_${sanitizeId(chatId)}_${sanitizeId(productId)}_${Date.now()}`;
}

function activeKey(chatId, productId) {
  return `${chatId}:${productId}`;
}

function setStep(job, currentStep, message, extra = {}) {
  job.currentStep = currentStep;
  job.stepOrder = STEPS[currentStep] ?? job.stepOrder ?? 0;
  job.progressPercent = extra.progressPercent ?? Math.max(0, Math.min(100, Math.round((job.stepOrder / 7) * 100)));
  job.message = message || job.message || '';
  job.updatedAt = new Date().toISOString();
  if (extra.status) job.status = extra.status;
  if (extra.panels) job.panels = extra.panels;
}

function normalizeHashtags(value) {
  const tags = [];
  for (const item of Array.isArray(value) ? value : []) {
    const tag = String(item || '').trim();
    if (!tag) continue;
    const normalized = (tag.startsWith('#') ? tag : `#${tag}`).replace(/\s+/g, '');
    if (!tags.some(existing => existing.toLowerCase() === normalized.toLowerCase())) {
      tags.push(normalized);
    }
  }
  return tags.slice(0, 8);
}

function buildCaption(job, result) {
  const analysis = result?.analysis || {};
  const productName = analysis.productName || analysis.product_name || job.productTitle || 'Sản phẩm TikTok Shop';
  const hashtags = normalizeHashtags(analysis.hashtags?.length ? analysis.hashtags : job.sourceHashtags);
  const text = [
    productName,
    hashtags.join(' '),
  ].filter(Boolean).join('\n');

  return {
    caption: text,
    hashtags,
  };
}

function getVideoPaths(result) {
  return (Array.isArray(result?.videos) ? result.videos : [])
    .filter(video => !video.error && video.videoPath && fs.existsSync(video.videoPath))
    .sort((a, b) => Number(a.panelIndex || 0) - Number(b.panelIndex || 0))
    .map(video => video.videoPath);
}

async function executeJob(job) {
  try {
    ensureDir(job.jobDir);
    setStep(job, 'product_assets_extracted', 'Đang tải ảnh Product description về local...', { status: 'running', progressPercent: 10 });

    const downloaded = await downloadProductImages(job.productImages, job.jobDir, {
      limit: MAX_IMAGES,
      minImages: MIN_IMAGES,
      timeoutMs: Number(process.env.PRODUCT_IMAGE_DOWNLOAD_TIMEOUT_MS || '15000'),
      maxBytesPerImage: Number(process.env.PRODUCT_IMAGE_MAX_BYTES || String(10 * 1024 * 1024)),
    });

    if (downloaded.files && downloaded.files.length > 0) {
      await sendMediaGroupToTelegram(
        job.chatId,
        downloaded.files,
        `📥 Đã nhận ${downloaded.files.length} ảnh sản phẩm [${job.productTitle || 'TikTok Shop'}]. Đang tiến hành phân tích & tạo video...`
      ).catch(err => console.error('[GenerationJob] sendMediaGroup error:', err.message));
    }

    job.sourceImagesDir = downloaded.dir;
    job.sourceImageErrors = downloaded.errors;
    job.sourceImages = downloaded.files.map(file => ({
      name: file.name,
      path: file.path,
      mimeType: file.mimeType,
      size: file.size,
      sourceUrl: file.sourceUrl,
    }));

    const filePayloads = downloaded.files.map(file => ({
      name: file.name,
      mimeType: file.mimeType,
      buffer: file.buffer,
      path: file.path,
    }));

    setStep(job, 'product_analyzed', 'Đang phân tích sản phẩm bằng Gemini...', { progressPercent: 25 });

    const result = await runStoryboardFullFlow(job.chatId, filePayloads, job.baseDir, {
      ...job.templateOptions,
      runId: job.jobId,
      cleanupUploads: false,
      cleanupFiles: false,
      sendPanelVideos: true,
      sendSummary: false,
      productContext: {
        productId: job.productId,
        productUrl: job.productUrl,
        productTitle: job.productTitle,
        productDescription: job.productDescription,
      },
      onProgress: (event) => {
        if (!event || !event.currentStep) return;
        setStep(job, event.currentStep, event.message, event);
      },
    });

    job.result = result;

    try {
      const { lastRunByChat } = require('./telegram-bot');
      if (lastRunByChat && result && result.reviewArchive?.root) {
        lastRunByChat.set(String(job.chatId), {
          runDir: result.reviewArchive.root,
          panelsDir: result.reviewArchive.panelsDir || path.join(result.reviewArchive.root, 'panels'),
          videosDir: path.join(result.reviewArchive.root, 'videos'),
          panels: result.panels,
          template: job.template,
          analysis: result.analysis,
          baseDir: job.baseDir,
        });
      }
    } catch (_) { }

    const videoPaths = getVideoPaths(result);
    if (videoPaths.length === 0) {
      throw new Error('No completed panel videos found');
    }

    const captionData = buildCaption(job, result);
    job.caption = captionData.caption;
    job.hashtags = captionData.hashtags;
    job.finalVideoPath = null;
    job.finalVideoSize = null;

    setStep(job, 'videos_generated', `Đã tạo ${videoPaths.length} video panel. Đang chờ /remake hoặc /upload.`, {
      progressPercent: 95,
      panels: videoPaths.map((_, index) => ({ index: index + 1, status: 'completed' })),
    });

    const remakeLines = videoPaths.map((_, index) => `  • Cảnh ${index + 1}: /remake_${index + 1}`).join('\n');
    await sendTelegramMessage(
      job.chatId,
      `✅ Đã tạo xong ${videoPaths.length} video panel.\n\n👉 Nhấn lệnh để tạo lại từng cảnh nếu cần:\n${remakeLines}\n\n👉 Gõ /upload để ghép video 9:16 và đăng lên TikTok.`
    );

    latestCompletedByChat.set(String(job.chatId), job.jobId);
    job.status = 'completed';
    setStep(job, 'completed', 'Generation completed. Waiting for /remake or /upload.', { status: 'completed', progressPercent: 100 });
  } catch (error) {
    job.status = 'failed';
    job.error = {
      message: error.message,
      stack: error.stack,
      failedStep: job.currentStep,
    };
    setStep(job, 'failed', error.message, { status: 'failed', progressPercent: job.progressPercent || 0 });
    try {
      await sendTelegramMessage(job.chatId, `⚠️ Generation failed at ${job.error.failedStep}: ${error.message}`);
    } catch (_) { }
  } finally {
    activeByChatProduct.delete(activeKey(job.chatId, job.productId));
  }
}

function enqueueGenerationJob(input, baseDir = path.resolve(__dirname, '..')) {
  const chatId = String(input.chatId || '').trim();
  const productId = String(input.productId || '').trim();
  if (!chatId) throw new Error('chatId is required');
  if (!productId) throw new Error('productId is required');
  if (!Array.isArray(input.productImages) || input.productImages.length === 0) {
    throw new Error('productImages is required');
  }

  const key = activeKey(chatId, productId);
  const existingJobId = activeByChatProduct.get(key);
  if (existingJobId && jobs.has(existingJobId)) {
    return { job: jobs.get(existingJobId), isOwner: false };
  }

  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const jobId = input.jobId ? sanitizeId(input.jobId) : makeJobId(chatId, productId);
  const jobDir = path.join(JOB_ROOT, jobId);
  const template = input.template || DEFAULT_TEMPLATE;
  const job = {
    jobId,
    chatId,
    sourceMessageId: input.sourceMessageId || null,
    shortlink: input.shortlink || null,
    productUrl: input.productUrl || null,
    productId,
    productTitle: input.productTitle || input.title || '',
    productDescription: input.productDescription || '',
    sourceHashtags: normalizeHashtags(input.hashtags),
    productImages: input.productImages.slice(0, MAX_IMAGES),
    template,
    templateOptions: { template },
    baseDir: effectiveBaseDir,
    jobDir,
    status: 'queued',
    currentStep: 'queued',
    stepOrder: STEPS.queued,
    progressPercent: 0,
    message: 'Job queued',
    panels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    upload: {
      status: 'pending',
      publishId: null,
      error: null,
    },
  };

  jobs.set(jobId, job);
  activeByChatProduct.set(key, jobId);

  flowQueue.enqueue({
    chatId,
    photos: [],
    baseDir,
    templateOptions: job.templateOptions,
    label: `Shortlink ${productId}`,
    execute: async () => {
      await executeJob(job);
      if (job.status === 'failed') throw new Error(job.error?.message || 'Generation job failed');
      return job;
    },
  }).catch(() => { });

  return { job, isOwner: true };
}

function publicJob(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    chatId: job.chatId,
    status: job.status,
    currentStep: job.currentStep,
    stepOrder: job.stepOrder,
    progressPercent: job.progressPercent,
    message: job.message,
    panels: job.panels,
    error: job.error ? {
      message: job.error.message,
      failedStep: job.error.failedStep,
    } : null,
    product: {
      productId: job.productId,
      title: job.productTitle,
      productUrl: job.productUrl,
      shortlink: job.shortlink,
    },
    upload: job.upload,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function getJob(jobId) {
  return jobs.get(String(jobId || ''));
}

function getLatestCompletedJobForChat(chatId) {
  const jobId = latestCompletedByChat.get(String(chatId || ''));
  return jobId ? jobs.get(jobId) : null;
}

function getJobResult(jobId) {
  const job = getJob(jobId);
  if (!job) return null;
  return {
    jobId: job.jobId,
    analysis: job.result?.analysis || {},
    caption: job.caption || '',
    hashtags: job.hashtags || [],
    product: {
      productId: job.productId,
      title: job.productTitle,
      productUrl: job.productUrl,
      shortlink: job.shortlink,
    },
    trendingMusic: job.trendingMusic ? {
      title: job.trendingMusic.title,
      authorName: job.trendingMusic.authorName,
      videoUrl: job.trendingMusic.videoUrl,
    } : null,
    finalVideo: job.finalVideoPath ? {
      status: fs.existsSync(job.finalVideoPath) ? 'completed' : 'missing',
      downloadPath: `/api/jobs/${job.jobId}/final-video`,
      size: job.finalVideoSize || null,
    } : null,
  };
}

async function prepareUploadJob(jobId) {
  const job = getJob(jobId);
  if (!job) throw new Error('Job not found');
  if (job.status !== 'completed') {
    throw new Error(`Job is not ready for upload. Current status: ${job.status}`);
  }
  if (!job.result) {
    throw new Error('Job result is missing');
  }

  const videoPaths = getVideoPaths(job.result);
  if (videoPaths.length === 0) {
    throw new Error('No completed panel videos found to merge');
  }

  setStep(job, 'videos_generated', `Đang ghép ${videoPaths.length} video panel và chèn nhạc TikTok trend...`, {
    status: 'preparing_upload',
    progressPercent: 98,
    panels: videoPaths.map((_, index) => ({ index: index + 1, status: 'completed' })),
  });

  const { getRandomTrendingTrackAudio } = require('./tiktok-music-scraper');
  let trendingMusic = null;
  try {
    console.log(`[GenerationJob] 🎵 Selecting random trending music track for job ${jobId}...`);
    trendingMusic = await getRandomTrendingTrackAudio(job.jobDir);
  } catch (mErr) {
    console.warn(`[GenerationJob] ⚠️ Could not fetch trending music: ${mErr.message}`);
  }

  const finalDir = path.join(job.jobDir, 'final');
  ensureDir(finalDir);
  const finalVideoPath = path.join(finalDir, 'final-video.mp4');
  await mergeVideos(videoPaths, finalVideoPath, {
    width: 1080,
    height: 1920,
    aspectRatio: '9:16',
    musicPath: trendingMusic?.audioPath || null,
    muteAudio: true,
  });

  job.finalVideoPath = finalVideoPath;
  job.finalVideoSize = fs.statSync(finalVideoPath).size;
  job.trendingMusic = trendingMusic;
  job.status = 'completed';
  setStep(job, 'completed', 'Final video merged with trending music for upload.', { status: 'completed', progressPercent: 100 });

  const musicInfo = trendingMusic
    ? `\n🎵 Nhạc nền TikTok trend: "${trendingMusic.title}" - ${trendingMusic.authorName}`
    : '';

  try {
    await sendMergedVideoToTelegram(
      job.chatId,
      finalVideoPath,
      `🎬 Video 9:16 hoàn chỉnh đã ghép xong!${musicInfo}\n🛒 Đang xác minh giỏ hàng Affiliate và đăng lên TikTok...`
    );
  } catch (mErr) {
    console.error('[GenerationJob] sendMergedVideo error:', mErr.message);
  }

  return getJobResult(job.jobId);
}

function markUpload(jobId, data = {}) {
  const job = getJob(jobId);
  if (!job) return null;
  job.upload = {
    ...job.upload,
    ...data,
    updatedAt: new Date().toISOString(),
  };
  job.updatedAt = new Date().toISOString();
  return job;
}

function cleanupJob(jobId) {
  const job = getJob(jobId);
  if (!job) return false;
  if (job.jobDir && fs.existsSync(job.jobDir)) {
    fs.rmSync(job.jobDir, { recursive: true, force: true });
  }
  jobs.delete(job.jobId);
  if (latestCompletedByChat.get(String(job.chatId)) === job.jobId) {
    latestCompletedByChat.delete(String(job.chatId));
  }
  return true;
}

const pendingCommandsByChat = new Map();
const commandResolversByChat = new Map();

function setJobCommand(chatId, commandData) {
  const key = String(chatId);
  const data = { ...commandData, timestamp: Date.now() };
  if (commandResolversByChat.has(key)) {
    const resolver = commandResolversByChat.get(key);
    commandResolversByChat.delete(key);
    resolver(data);
    return { success: true, delivery: 'delivered' };
  }
  pendingCommandsByChat.set(key, data);
  return { success: true, delivery: 'queued' };
}

async function waitForJobCommand(jobId, timeoutMs = 10000) {
  const job = getJob(jobId);
  if (!job) return { success: false, error: 'Job not found' };
  const key = String(job.chatId);

  if (pendingCommandsByChat.has(key)) {
    const data = pendingCommandsByChat.get(key);
    pendingCommandsByChat.delete(key);
    return { success: true, ...data };
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      commandResolversByChat.delete(key);
      resolve({ success: true, command: 'wait' });
    }, Math.max(1000, Number(timeoutMs) || 10000));

    commandResolversByChat.set(key, (data) => {
      clearTimeout(timer);
      resolve({ success: true, ...data });
    });
  });
}

async function remakeJobPanels(jobId, panelIndices = [], customInstruction = '') {
  const job = getJob(jobId);
  if (!job) throw new Error('Job not found');
  const numbers = (Array.isArray(panelIndices) ? panelIndices : [panelIndices])
    .map(Number)
    .filter(n => Number.isInteger(n) && n > 0);
  if (numbers.length === 0) throw new Error('Valid panel indices are required');

  const { generateVideosFromPanelsDirect } = require('./gemini-webapi-storyboard');
  const baseDir = job.baseDir || path.resolve(__dirname, '..');
  const result = job.result || {};
  const panels = result.panels || [];
  const targetPanels = panels.filter(p => numbers.includes(p.index));

  if (targetPanels.length === 0) {
    throw new Error(`Panels ${numbers.join(', ')} not found in job`);
  }

  setStep(job, 'generating_videos', `Đang tạo lại ${targetPanels.length} video cảnh ${numbers.join(', ')}...`, { status: 'running' });

  if (customInstruction) {
    targetPanels.forEach(p => { p.customInstruction = customInstruction; });
  }

  const newVideos = await generateVideosFromPanelsDirect(baseDir, targetPanels, {
    aspectRatio: '9:16',
    includeVideoBase64: true,
  });

  for (const v of newVideos) {
    if (v.error) {
      await sendTelegramMessage(job.chatId, `⚠️ Lỗi tạo lại Video Cảnh ${v.panelIndex}: ${v.error}\n👉 Nhấn để thử tạo lại: /remake_${v.panelIndex}`);
      continue;
    }

    const idx = job.result.videos.findIndex(existing => existing.panelIndex === v.panelIndex);
    if (idx >= 0) job.result.videos[idx] = v;
    else job.result.videos.push(v);

    const base64 = v.video?.base64 || (v.videoPath && fs.existsSync(v.videoPath) ? fs.readFileSync(v.videoPath).toString('base64') : null);
    if (base64) {
      await sendVideoToTelegramDirect(job.chatId, base64, v.panelIndex, `Panel ${v.panelIndex}`, `🎬 Video Cảnh ${v.panelIndex} đã tạo lại xong.\n👉 Nhấn để tạo lại tiếp: /remake_${v.panelIndex}`);
    }
  }

  job.finalVideoPath = null;
  job.finalVideoSize = null;
  job.upload = {
    status: 'pending',
    publishId: null,
    error: null,
  };

  job.status = 'completed';
  setStep(job, 'completed', 'Remake completed. Waiting for /remake or /upload.', { status: 'completed', progressPercent: 100 });
  await sendTelegramMessage(
    job.chatId,
    `✅ Đã remake xong cảnh ${numbers.join(', ')}.\n\n👉 Nhấn để tạo lại tiếp nếu cần: ${numbers.map(n => `/remake_${n}`).join(' ')}\n👉 Gõ /upload để ghép video 9:16 và đăng TikTok.`
  );
  return { success: true, jobId: job.jobId, remadePanels: numbers };
}

async function changeJobTemplate(jobId, newTemplate) {
  const job = getJob(jobId);
  if (!job) throw new Error('Job not found');
  job.template = newTemplate;
  job.templateOptions = { template: newTemplate };
  job.status = 'queued';
  setStep(job, 'queued', `Đang đổi template sang ${newTemplate}...`, { status: 'running', progressPercent: 10 });
  await executeJob(job);
  return { success: true, jobId: job.jobId, template: newTemplate };
}

const generationJobService = {
  enqueueJob: enqueueGenerationJob,
  enqueueGenerationJob,
  getJob,
  getJobResult,
  getLatestCompletedJob: getLatestCompletedJobForChat,
  getLatestCompletedJobForChat,
  publicJob,
  markUpload,
  prepareUploadJob,
  cleanupJob,
  setJobCommand,
  waitForJobCommand,
  remakeJobPanels,
  changeJobTemplate,
  STEPS,
};

module.exports = {
  ...generationJobService,
  generationJobService,
};
