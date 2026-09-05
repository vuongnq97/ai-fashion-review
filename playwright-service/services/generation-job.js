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
const { FlowStepTracker } = require('./flow-step-tracker');
const { buildTemplateOptions } = require('./template-options');
const { downloadProductImages } = require('./product-assets');
const { mergeVideos } = require('./video-merge');
const { getConfig } = require('../utils/config-manager');

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
  const list = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[,\s]+/) : []);
  for (const item of list) {
    const raw = String(item || '').trim();
    if (!raw) continue;
    const cleanTag = raw.replace(/^#+/, '').trim();
    if (!cleanTag) continue;
    const normalized = `#${cleanTag.replace(/\s+/g, '')}`;
    if (!tags.some(existing => existing.toLowerCase() === normalized.toLowerCase())) {
      tags.push(normalized);
    }
  }
  return tags;
}

function getConfigHashtags(job) {
  try {
    const baseDir = job?.baseDir || path.resolve(__dirname, '..');
    const config = getConfig(baseDir);
    if (!config) return [];

    const tmpl = String(job?.template || '').toLowerCase();
    const chatId = String(job?.chatId || '').trim();

    // 1. Check auto settings tương ứng với template hoặc chatId
    let autoKey = null;
    if (tmpl.includes('template3') || config.autoT3Settings?.chatId === chatId) {
      autoKey = 'autoT3Settings';
    } else if (tmpl.includes('template4') || config.autoT4Settings?.chatId === chatId) {
      autoKey = 'autoT4Settings';
    } else if (tmpl.includes('template5') || config.autoT5Settings?.chatId === chatId) {
      autoKey = 'autoT5Settings';
    }

    if (autoKey && config[autoKey]) {
      const tags = config[autoKey].hashtags || config[autoKey].hashtag;
      if (Array.isArray(tags) && tags.length > 0) {
        return normalizeHashtags(tags);
      }
    }

    // 2. Check channel settings
    if (chatId && config.channels?.[chatId]) {
      const channelTags = config.channels[chatId].hashtags || config.channels[chatId].hashtag;
      if (Array.isArray(channelTags) && channelTags.length > 0) {
        return normalizeHashtags(channelTags);
      }
    }

    // 3. Check root level
    const rootTags = config.hashtags || config.hashtag;
    if (Array.isArray(rootTags) && rootTags.length > 0) {
      return normalizeHashtags(rootTags);
    }
  } catch (err) {
    console.warn('[GenerationJob] Error reading config hashtags:', err.message);
  }
  return [];
}

function buildCaption(job, result) {
  const analysis = result?.analysis || job.analysis || {};
  // 1. Tên sản phẩm ưu tiên lấy từ bước phân tích sản phẩm (AI analysis)
  const productName = (analysis.productName || analysis.product_name || job.productTitle || 'Sản phẩm TikTok Shop').trim();

  // Đồng bộ lại job.productTitle để toàn bộ hệ thống (publicJob, Telegram, TikTok Upload) dùng đúng tên chuẩn này
  job.productTitle = productName;

  // 2. Lấy hashtag mặc định từ config (nếu có 2 cái thì lấy 2, nếu rỗng thì 0)
  const configTags = getConfigHashtags(job);
  const finalHashtags = configTags.slice(0, 5);

  // 3. Số lượng hashtag cần lấy thêm để đủ đúng 5 hashtags (nếu có 2 thì thêm 3, nếu rỗng thì thêm 5)
  const needed = Math.max(0, 5 - finalHashtags.length);

  if (needed > 0) {
    const tmpl = String(job.template || '').toLowerCase();
    let templateDefaults = ['#review', '#sanphamchinhhang', '#lifestyle', '#trending', '#xuhuong'];
    if (tmpl.includes('template4')) {
      templateDefaults = ['#GuocNu', '#GiayCaoGot', '#SandalNu', '#ReviewGiayNu', '#TikTokShopVN'];
    } else if (tmpl.includes('template3')) {
      templateDefaults = ['#GiaySneaker', '#GiayTheThao', '#ReviewGiay', '#SneakerVN', '#TikTokShopVN'];
    }

    const candidatePool = [
      ...(Array.isArray(analysis.hashtags) ? analysis.hashtags : []),
      ...(Array.isArray(job.sourceHashtags) ? job.sourceHashtags : []),
      ...templateDefaults,
      '#review', '#sanphamchinhhang', '#xuhuong', '#trending', '#tiktokshop'
    ];

    const normalizedCandidates = normalizeHashtags(candidatePool);
    for (const tag of normalizedCandidates) {
      if (finalHashtags.length >= 5) break;
      if (!finalHashtags.some(existing => existing.toLowerCase() === tag.toLowerCase())) {
        finalHashtags.push(tag);
      }
    }
  }

  const text = [
    productName,
    '',
    finalHashtags.join(' '),
  ].filter((line, i) => i === 1 || Boolean(line)).join('\n');

  const { getCartAnchorText } = require('./cart-cta');
  const aiCta = job.cartAnchorText ||
    analysis?.cartAnchorText ||
    analysis?.analysis?.cartAnchorText ||
    analysis?.cartCTA ||
    analysis?.analysis?.cartCTA;
  const cartAnchorText = (aiCta && typeof aiCta === 'string' && aiCta.trim())
    ? aiCta.trim().slice(0, 30)
    : getCartAnchorText(job.product || { title: productName }, analysis);
  job.cartAnchorText = cartAnchorText;

  return {
    caption: text,
    hashtags: finalHashtags,
    cartAnchorText,
  };
}

function getExpectedPanelIndices(job) {
  const result = job?.result || {};
  let expectedPanels = [];
  if (Array.isArray(result.panels) && result.panels.length > 0) {
    expectedPanels = result.panels.map(p => Number(p.index || p.panelIndex)).filter(n => Number.isInteger(n) && n > 0);
  } else if (Array.isArray(job?.panels) && job.panels.length > 0) {
    expectedPanels = job.panels.map(p => Number(p.index || p.panelIndex)).filter(n => Number.isInteger(n) && n > 0);
  }
  if (expectedPanels.length === 0) {
    const tmpl = String(job?.template || '').toLowerCase();
    let count = 2;
    if (tmpl.includes('dailyvlog')) {
      count = 5;
    } else if (tmpl.includes('5_3') || tmpl.includes('5.3') || tmpl.includes('53')) {
      count = 4;
    }
    expectedPanels = Array.from({ length: count }, (_, i) => i + 1);
  }
  return [...new Set(expectedPanels)].sort((a, b) => a - b);
}

function getOrderedVideoPathsForJob(job) {
  if (!job) return { orderedVideoPaths: [], orderedVideos: [], missingPanels: [], completedPanels: [], expectedPanels: [] };
  const result = job.result || {};
  const expectedPanels = getExpectedPanelIndices(job);

  const searchDirs = [
    result.reviewArchive?.videosDir,
    result.reviewArchive?.root ? path.join(result.reviewArchive.root, 'videos') : null,
    job.jobDir ? path.join(job.jobDir, 'videos') : null,
  ].filter(Boolean);

  try {
    const { lastRunByChat } = require('./telegram-bot');
    const runInfo = lastRunByChat.get(String(job.chatId));
    if (runInfo?.videosDir) searchDirs.push(runInfo.videosDir);
    if (runInfo?.runDir) searchDirs.push(path.join(runInfo.runDir, 'videos'));
  } catch (_) { }

  const orderedVideos = [];
  const missingPanels = [];
  const completedPanels = [];

  if (!Array.isArray(result.videos)) {
    result.videos = [];
  }

  for (const pIdx of expectedPanels) {
    let validPath = null;

    // 1. Kiểm tra video trong result.videos hiện tại
    const inMem = result.videos.find(v => Number(v.panelIndex) === pIdx && !v.error && v.videoPath && fs.existsSync(v.videoPath));
    if (inMem) {
      validPath = inMem.videoPath;
    }

    // 2. Quét tìm file panel-${pIdx}.mp4 trên thư mục của run / archive
    if (!validPath) {
      for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) continue;
        const candidate = path.join(dir, `panel-${pIdx}.mp4`);
        if (fs.existsSync(candidate) && fs.statSync(candidate).size > 1000) {
          validPath = candidate;
          break;
        }
      }
    }

    // 3. Quét tìm file gần nhất trong uploads/aistudio-videos/
    if (!validPath) {
      const uploadVideosDir = path.join(job.baseDir || path.resolve(__dirname, '..'), 'uploads', 'aistudio-videos');
      if (fs.existsSync(uploadVideosDir)) {
        try {
          const files = fs.readdirSync(uploadVideosDir)
            .filter(f => f.startsWith(`panel-${pIdx}-video-`) && f.endsWith('.mp4'))
            .map(f => ({ file: f, path: path.join(uploadVideosDir, f), mtime: fs.statSync(path.join(uploadVideosDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
          if (files.length > 0 && fs.statSync(files[0].path).size > 1000) {
            validPath = files[0].path;
          }
        } catch (_) { }
      }
    }

    if (validPath) {
      orderedVideos.push({
        panelIndex: pIdx,
        videoPath: validPath,
      });
      completedPanels.push(pIdx);

      // Đồng bộ lại vào result.videos để xoá cờ error cũ nếu có
      let vEntry = result.videos.find(v => Number(v.panelIndex) === pIdx);
      if (!vEntry) {
        vEntry = { panelIndex: pIdx };
        result.videos.push(vEntry);
      }
      vEntry.videoPath = validPath;
      delete vEntry.error;
      vEntry.status = 'completed';
    } else {
      missingPanels.push(pIdx);
    }
  }

  // Sắp xếp TUYỆT ĐỐI theo đúng thứ tự cảnh tăng dần (1, 2, 3...)
  orderedVideos.sort((a, b) => a.panelIndex - b.panelIndex);

  return {
    orderedVideoPaths: orderedVideos.map(v => v.videoPath),
    orderedVideos,
    missingPanels,
    completedPanels,
    expectedPanels,
  };
}

function getVideoPaths(result) {
  return (Array.isArray(result?.videos) ? result.videos : [])
    .filter(video => !video.error && video.videoPath && fs.existsSync(video.videoPath))
    .sort((a, b) => Number(a.panelIndex || 0) - Number(b.panelIndex || 0))
    .map(video => video.videoPath);
}

async function executeJob(job) {
  const tracker = job.stepTracker || new FlowStepTracker(job.chatId, { title: job.productTitle });
  job.stepTracker = tracker;

  try {
    ensureDir(job.jobDir);
    setStep(job, 'product_assets_extracted', 'Đang tải ảnh Product description về local...', { status: 'running', progressPercent: 10 });
    await tracker.start(1);

    const downloaded = await downloadProductImages(job.productImages, job.jobDir, {
      limit: MAX_IMAGES,
      minImages: MIN_IMAGES,
      timeoutMs: Number(process.env.PRODUCT_IMAGE_DOWNLOAD_TIMEOUT_MS || '15000'),
      maxBytesPerImage: Number(process.env.PRODUCT_IMAGE_MAX_BYTES || String(10 * 1024 * 1024)),
    });

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

    await tracker.setStep(1, 'completed');
    await tracker.setStep(2, 'running');
    setStep(job, 'product_analyzed', 'Đang phân tích sản phẩm bằng Gemini...', { progressPercent: 25 });

    const result = await runStoryboardFullFlow(job.chatId, filePayloads, job.baseDir, {
      ...job.templateOptions,
      runId: job.jobId,
      cleanupUploads: false,
      cleanupFiles: false,
      sendPanelVideos: true,
      sendSummary: false,
      stepTracker: tracker,
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
    job.analysis = result?.analysis || {};
    const analyzedName = result?.analysis?.productName || result?.analysis?.product_name;
    if (analyzedName) {
      job.productTitle = analyzedName;
      await tracker.setTitle(analyzedName);
    }
    const analyzedCTA = result?.analysis?.cartAnchorText || result?.analysis?.analysis?.cartAnchorText || result?.analysis?.cartCTA;
    if (analyzedCTA && typeof analyzedCTA === 'string' && analyzedCTA.trim()) {
      job.cartAnchorText = analyzedCTA.trim().slice(0, 30);
      console.log(`[Job ${job.jobId}] 🛒 Cart Anchor CTA from AI analysis: "${job.cartAnchorText}"`);
    }

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

    const { orderedVideoPaths, missingPanels, completedPanels, expectedPanels } = getOrderedVideoPathsForJob(job);
    if (completedPanels.length === 0) {
      throw new Error('No completed panel videos found');
    }

    const captionData = buildCaption(job, result);
    job.caption = captionData.caption;
    job.hashtags = captionData.hashtags;
    job.cartAnchorText = captionData.cartAnchorText || null;
    job.finalVideoPath = null;
    job.finalVideoSize = null;

    await tracker.setStep(5, 'completed');

    setStep(job, 'videos_generated', `Đã tạo ${completedPanels.length}/${expectedPanels.length} video panel. Đang chờ /remake hoặc /upload.`, {
      progressPercent: 95,
      panels: expectedPanels.map(idx => ({ index: idx, status: completedPanels.includes(idx) ? 'completed' : 'failed' })),
    });

    // 1. Gửi tin nhắn CHỈ CHỨA TITLE VÀ HASHTAG (để user dễ dàng copy thủ công nếu muốn tự đăng tay)
    const hashtagText = (job.hashtags && job.hashtags.length > 0)
      ? job.hashtags.join(' ')
      : '#review #trending';
    await sendTelegramMessage(
      job.chatId,
      `${job.productTitle} ${hashtagText}`
    );

    // 2. Gửi tin nhắn hướng dẫn và lệnh remake / upload
    if (missingPanels.length > 0) {
      const remakeMissingLines = missingPanels.map(p => `  • Cảnh ${p}: /remake_${p}`).join('\n');
      await sendTelegramMessage(
        job.chatId,
        `⚠️ Đã tạo được ${completedPanels.length}/${expectedPanels.length} video panel (Cảnh ${missingPanels.join(', ')} bị lỗi).\n\n👉 Nhấn lệnh để tạo lại cảnh lỗi:\n${remakeMissingLines}\n\n👉 Sau khi remake đủ các cảnh, gõ /upload để ghép đầy đủ video theo đúng thứ tự 1 -> ${expectedPanels.length} và đăng lên TikTok.`
      );
    } else {
      const allRemakeLines = expectedPanels.map(p => `  • Cảnh ${p}: /remake_${p}`).join('\n');
      await sendTelegramMessage(
        job.chatId,
        `✅ Đã tạo xong toàn bộ ${completedPanels.length} video panel theo thứ tự.\n\n👉 Nhấn lệnh để tạo lại từng cảnh nếu cần:\n${allRemakeLines}\n\n👉 Gõ /upload để ghép video hoàn chỉnh (Cảnh 1 -> Cảnh ${completedPanels.length}) và đăng lên TikTok.`
      );
    }

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
    if (tracker) {
      await tracker.fail(null, error.message);
    }
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
    templateOptions: buildTemplateOptions(template),
    baseDir: effectiveBaseDir,
    jobDir,
    status: 'queued',
    stepTracker: input.stepTracker || null,
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
  const analysis = job.result?.analysis || job.analysis || {};
  const productName = analysis.productName || analysis.product_name || job.productTitle || '';
  return {
    jobId: job.jobId,
    chatId: job.chatId,
    status: job.status,
    currentStep: job.currentStep,
    stepOrder: job.stepOrder,
    progressPercent: job.progressPercent,
    message: job.message,
    panels: job.panels,
    caption: job.caption || '',
    hashtags: job.hashtags || [],
    cartAnchorText: job.cartAnchorText || '',
    analysis,
    error: job.error ? {
      message: job.error.message,
      failedStep: job.error.failedStep,
    } : null,
    product: {
      productId: job.productId,
      title: productName || job.productTitle,
      productName: productName || job.productTitle,
      productUrl: job.productUrl,
      shortlink: job.shortlink,
    },
    trendingMusic: job.trendingMusic ? {
      title: job.trendingMusic.title,
      authorName: job.trendingMusic.authorName,
      videoUrl: job.trendingMusic.videoUrl,
    } : null,
    upload: job.upload,
    uploadMessageId: job.uploadMessageId || null,
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
  const analysis = job.result?.analysis || job.analysis || {};
  const productName = analysis.productName || analysis.product_name || job.productTitle || '';
  return {
    jobId: job.jobId,
    analysis,
    caption: job.caption || '',
    hashtags: job.hashtags || [],
    cartAnchorText: job.cartAnchorText || '',
    uploadMessageId: job.uploadMessageId || null,
    product: {
      productId: job.productId,
      title: productName || job.productTitle,
      productName: productName || job.productTitle,
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

  const { orderedVideoPaths, missingPanels, expectedPanels } = getOrderedVideoPathsForJob(job);
  if (missingPanels.length > 0) {
    throw new Error(`Chưa có đủ video cho tất cả các cảnh (Thiếu Cảnh ${missingPanels.join(', ')} / ${expectedPanels.length}). Vui lòng gõ /remake_${missingPanels[0]} để tạo lại cảnh này trước khi /upload!`);
  }
  if (orderedVideoPaths.length === 0) {
    throw new Error('No completed panel videos found to merge');
  }

  const videoPaths = orderedVideoPaths;
  console.log(`[GenerationJob] 🎬 Merging ${videoPaths.length} videos in strict order: ${videoPaths.map((p, i) => `Cảnh ${i + 1} (${path.basename(p)})`).join(' -> ')}`);

  // Check if template has voice-over script (e.g. template5_2, template5_3, hasVoice)
  const tmpl = String(job.template || '').toLowerCase();
  const isVoiceTemplate = !!(
    tmpl.includes('template5_2') || tmpl.includes('template5.2') || tmpl.includes('template52') ||
    tmpl.includes('template5_3') || tmpl.includes('template5.3') || tmpl.includes('template53') ||
    job.hasVoice === true ||
    job.options?.hasVoice === true
  );

  setStep(job, 'videos_generated', isVoiceTemplate
    ? `Đang ghép ${videoPaths.length} video panel (giữ nguyên giọng lồng tiếng Voice-over)...`
    : `Đang ghép ${videoPaths.length} video panel và chèn nhạc TikTok trend...`, {
    status: 'preparing_upload',
    progressPercent: 98,
    panels: expectedPanels.map((pIdx) => ({ index: pIdx, status: 'completed' })),
  });

  let trendingMusic = null;
  if (!isVoiceTemplate) {
    const { getRandomTrendingTrackAudio } = require('./tiktok-music-scraper');
    try {
      console.log(`[GenerationJob] 🎵 Selecting random trending music track for job ${jobId}...`);
      trendingMusic = await getRandomTrendingTrackAudio(job.jobDir);
    } catch (mErr) {
      console.warn(`[GenerationJob] ⚠️ Could not fetch trending music: ${mErr.message}`);
    }
  } else {
    console.log(`[GenerationJob] 🎙️ Template ${job.template} có voice script — KHÔNG chèn nhạc trending, giữ nguyên voice-over.`);
  }

  const finalDir = path.join(job.jobDir, 'final');
  ensureDir(finalDir);
  const finalVideoPath = path.join(finalDir, 'final-video.mp4');

  await mergeVideos(videoPaths, finalVideoPath, {
    width: 1080,
    height: 1920,
    aspectRatio: '9:16',
    musicPath: trendingMusic?.audioPath || null,
    muteAudio: !trendingMusic && !isVoiceTemplate, // Chỉ mute khi không có nhạc VÀ không phải voice template
  });

  job.finalVideoPath = finalVideoPath;
  job.finalVideoSize = fs.statSync(finalVideoPath).size;
  job.trendingMusic = trendingMusic;
  job.status = 'completed';
  setStep(job, 'completed', isVoiceTemplate
    ? 'Final video merged with original voice-over for upload.'
    : 'Final video merged with trending music for upload.', { status: 'completed', progressPercent: 100 });

  try {
    await sendMergedVideoToTelegram(
      job.chatId,
      finalVideoPath,
      '🎬 Video 9:16 hoàn chỉnh.'
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

    const archiveVideosDir = job.result?.reviewArchive?.videosDir
      || (job.result?.reviewArchive?.root ? path.join(job.result.reviewArchive.root, 'videos') : null)
      || path.join(job.jobDir, 'videos');
    ensureDir(archiveVideosDir);
    const targetVideoPath = path.join(archiveVideosDir, `panel-${v.panelIndex}.mp4`);
    if (v.videoPath && fs.existsSync(v.videoPath)) {
      try { fs.copyFileSync(v.videoPath, targetVideoPath); } catch (_) { }
    }

    const vItem = {
      panelIndex: Number(v.panelIndex),
      videoPath: fs.existsSync(targetVideoPath) ? targetVideoPath : v.videoPath,
      video: v.video,
      prompt: v.prompt,
      status: 'completed',
    };
    delete vItem.error;

    if (!Array.isArray(job.result.videos)) job.result.videos = [];
    const idx = job.result.videos.findIndex(existing => Number(existing.panelIndex) === Number(v.panelIndex));
    if (idx >= 0) job.result.videos[idx] = vItem;
    else job.result.videos.push(vItem);

    // Đồng bộ lại vào lastRunByChat nếu có
    try {
      const { lastRunByChat } = require('./telegram-bot');
      const mem = lastRunByChat.get(String(job.chatId));
      if (mem) {
        if (!Array.isArray(mem.videos)) mem.videos = [];
        const mIdx = mem.videos.findIndex(m => Number(m.panelIndex) === Number(v.panelIndex));
        if (mIdx >= 0) mem.videos[mIdx] = vItem;
        else mem.videos.push(vItem);
      }
    } catch (_) { }

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
    `✅ Đã remake xong cảnh ${numbers.join(', ')}.\n\n👉 Gõ /upload để ghép đầy đủ video theo thứ tự (1 -> 2) và đăng TikTok.\n👉 Nhấn để tạo lại tiếp nếu cần: ${numbers.map(n => `/remake_${n}`).join(' ')}`
  );
  return { success: true, jobId: job.jobId, remadePanels: numbers };
}

async function changeJobTemplate(jobId, newTemplate) {
  const job = getJob(jobId);
  if (!job) throw new Error('Job not found');
  job.template = newTemplate;
  job.templateOptions = buildTemplateOptions(newTemplate);
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
  getOrderedVideoPathsForJob,
  getExpectedPanelIndices,
  STEPS,
};

module.exports = {
  ...generationJobService,
  generationJobService,
  getOrderedVideoPathsForJob,
  getExpectedPanelIndices,
};
