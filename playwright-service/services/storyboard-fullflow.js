const fs = require('fs');
const path = require('path');

const { getStoryboardProvider } = require('./storyboard-provider');
const { sendTelegramMessage, sendVideoToTelegramDirect } = require('./telegram-send');
const { runWithShop, getShopNameForChat } = require('../utils/shop-context');

const UPLOAD_MEDIA_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.avif',
  '.mp4',
  '.mov',
  '.webm',
]);

function removeEmptyDirs(dir, rootDir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      removeEmptyDirs(path.join(dir, entry.name), rootDir);
    }
  }

  if (dir !== rootDir && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
  }
}

function cleanupUploadsMedia(baseDir, runId) {
  // If a runId is provided, only clean that specific run's subdirectory.
  // This prevents concurrent runs from deleting each other's files.
  if (runId) {
    const runDir = path.join(baseDir, 'uploads', runId);
    if (fs.existsSync(runDir)) {
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
        console.log(`[FullFlow] Cleaned run directory: ${runDir}`);
      } catch (error) {
        console.warn(`[FullFlow] Could not clean run directory ${runDir}: ${error.message}`);
      }
    }
    return;
  }

  // Fallback: clean all media in uploads (legacy behavior when no runId)
  const uploadsDir = path.join(baseDir, 'uploads');
  if (!fs.existsSync(uploadsDir)) return;

  let deleted = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (UPLOAD_MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        fs.unlinkSync(fullPath);
        deleted++;
      }
    }
  }

  try {
    walk(uploadsDir);
    removeEmptyDirs(uploadsDir, uploadsDir);
    console.log(`[FullFlow] Cleaned uploads media: deleted ${deleted} file(s) from ${uploadsDir}`);
  } catch (error) {
    console.warn(`[FullFlow] Could not fully clean uploads media: ${error.message}`);
  }
}

function normalizeHashtags(value) {
  const input = Array.isArray(value) ? value : [];
  const tags = [];
  for (const item of input) {
    const raw = String(item || '').trim();
    if (!raw) continue;
    const tag = (raw.startsWith('#') ? raw : `#${raw}`).replace(/\s+/g, '');
    if (tag && !tags.some(existing => existing.toLowerCase() === tag.toLowerCase())) {
      tags.push(tag);
    }
    if (tags.length === 5) break;
  }
  while (tags.length < 5) {
    tags.push(`#sanpham${tags.length + 1}`);
  }
  return tags;
}

function buildProductTelegramText(analysis) {
  const info = (analysis && typeof analysis === 'object') ? analysis : {};
  const productName = String(info.productName || info.product_name || info.name || info.type || 'Sản phẩm thời trang').trim();
  const hashtags = normalizeHashtags(info.hashtags);
  return {
    productName,
    hashtags,
    summary: `📌 <b>${productName}</b>\n🏷️ ${hashtags.join(' ')}`,
  };
}

async function runStoryboardFullFlow(chatId, filePayloads, baseDir, options = {}) {
  if (!chatId) throw new Error('chatId is required');
  if (!filePayloads || filePayloads.length === 0) {
    throw new Error('At least one product image is required');
  }

  const shopName = options.shopName || getShopNameForChat(chatId, baseDir);
  return runWithShop(shopName, async () => {
    const runId = options.runId || null;
    if (runId) {
      console.log(`[FullFlow] Starting run ${runId} for chat ${chatId} with ${filePayloads.length} image(s)`);
    }

  try {
    const provider = getStoryboardProvider(baseDir, options);
    console.log(`[FullFlow] Storyboard provider: ${provider.name}`);
    const progress = typeof options.onProgress === 'function' ? options.onProgress : async () => {};
    await progress({
      currentStep: 'product_analyzed',
      stepOrder: 2,
      progressPercent: 25,
      message: `Đã nhận ${filePayloads.length} ảnh local. Đang phân tích bằng ${provider.name}...`,
    });
    if (!options.stepTracker) {
      await sendTelegramMessage(chatId, `Đã nhận ${filePayloads.length} ảnh. Đang tạo storyboard bằng ${provider.name}...`);
    }

    const result = await provider.generateStoryboard(baseDir, filePayloads, {
      ...options,
      chatId,
      telegramChatId: chatId,
      generateVideos: true,
      includeVideoBase64: true,
      aspectRatio: options.aspectRatio || '9:16',
      videoModelKey: options.videoModelKey || null,
      cleanupFiles: options.cleanupFiles,
    });

    await progress({
      currentStep: 'generating_videos',
      stepOrder: 5,
      progressPercent: 72,
      message: 'Storyboard/panels đã xong. Đang kiểm tra video panel...',
    });

    const videos = Array.isArray(result.videos) ? result.videos : [];
    if (videos.length === 0) {
      throw new Error('No videos returned from storyboard/video generation.');
    }
    const productInfo = buildProductTelegramText(result.analysis);

    let sentCount = 0;
    if (options.sendPanelVideos !== false) {
      for (const video of videos) {
        const pIdx = video.panelIndex || (sentCount + 1);
        if (video.error) {
          await sendTelegramMessage(chatId, `⚠️ Lỗi tạo video Cảnh ${pIdx}: ${video.error}\n👉 Nhấn để thử tạo lại cảnh này: /remake_${pIdx}`);
          continue;
        }

        const base64 = video.video?.base64 || video.videoBase64 || null;
        if (!base64) {
          await sendTelegramMessage(chatId, `⚠️ Video Cảnh ${pIdx} thiếu dữ liệu video.\n👉 Nhấn để thử tạo lại cảnh này: /remake_${pIdx}`);
          continue;
        }

        const panelName = `Panel ${pIdx}`;
        const caption = `🎬 Video Cảnh ${pIdx}/${videos.length} hoàn tất.\n👉 Nhấn để tạo lại cảnh này: /remake_${pIdx}`;
        const ok = await sendVideoToTelegramDirect(chatId, base64, pIdx, panelName, caption);
        if (ok) sentCount++;
      }
    }

    if (options.sendSummary !== false && !options.stepTracker) {
      await sendTelegramMessage(chatId, `${productInfo.summary}`);
    }
    return { ...result, sentCount, productInfo };
  } finally {
    if (options.cleanupUploads !== false) {
      cleanupUploadsMedia(baseDir, runId);
    }
  }
  });
}

module.exports = {
  cleanupUploadsMedia,
  runStoryboardFullFlow,
};
