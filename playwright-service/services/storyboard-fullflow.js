const fs = require('fs');
const path = require('path');

const { getStoryboardProvider } = require('./storyboard-provider');
const { sendTelegramMessage, sendVideoToTelegramDirect } = require('./telegram-send');

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
    summary: `${productName}\n ${hashtags.join(' ')}`,
  };
}

async function runStoryboardFullFlow(chatId, filePayloads, baseDir, options = {}) {
  if (!chatId) throw new Error('chatId is required');
  if (!filePayloads || filePayloads.length === 0) {
    throw new Error('At least one product image is required');
  }

  const runId = options.runId || null;
  if (runId) {
    console.log(`[FullFlow] Starting run ${runId} for chat ${chatId} with ${filePayloads.length} image(s)`);
  }

  try {
    const provider = getStoryboardProvider(baseDir, options);
    console.log(`[FullFlow] Storyboard provider: ${provider.name}`);
    await sendTelegramMessage(chatId, `Đã nhận ${filePayloads.length} ảnh. Đang tạo storyboard bằng ${provider.name}...`);

    const result = await provider.generateStoryboard(baseDir, filePayloads, {
      ...options,
      generateVideos: true,
      includeVideoBase64: true,
      aspectRatio: options.aspectRatio || '9:16',
      videoModelKey: options.videoModelKey || null,
      cleanupFiles: options.cleanupFiles,
    });

    const videos = Array.isArray(result.videos) ? result.videos : [];
    if (videos.length === 0) {
      throw new Error('No videos returned from storyboard/video generation.');
    }
    const productInfo = buildProductTelegramText(result.analysis);
    if (result.reviewArchive?.root) {
      await sendTelegramMessage(chatId, `Đã lưu prompt + storyboard để review:\n${result.reviewArchive.root}`);
    }

    let sentCount = 0;
    for (const video of videos) {
      if (video.error) {
        await sendTelegramMessage(chatId, `Lỗi tạo video panel ${video.panelIndex || '?'}: ${video.error}`);
        continue;
      }

      const base64 = video.video?.base64 || video.videoBase64 || null;
      if (!base64) {
        await sendTelegramMessage(chatId, `Video panel ${video.panelIndex || '?'} thiếu base64 output.`);
        continue;
      }

      const panelName = `Panel ${video.panelIndex || sentCount + 1}`;
      const caption = `${panelName} đã sẵn sàng.`;
      const ok = await sendVideoToTelegramDirect(chatId, base64, video.panelIndex, panelName, caption);
      if (ok) sentCount++;
    }

    await sendTelegramMessage(chatId, `${productInfo.summary}`);
    return { ...result, sentCount, productInfo };
  } finally {
    if (options.cleanupUploads !== false) {
      cleanupUploadsMedia(baseDir, runId);
    }
  }
}

module.exports = {
  cleanupUploadsMedia,
  runStoryboardFullFlow,
};
