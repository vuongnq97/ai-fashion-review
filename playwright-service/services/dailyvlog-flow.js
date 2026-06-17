'use strict';

/**
 * dailyvlog-flow.js
 *
 * State machine and flow controller for the Daily Vlog pipeline.
 *
 * Command flow:
 *   1. User sends /dailyvlog → bot saves state, asks for product photo
 *   2. User sends product photo(s) → bot starts pipeline
 *   3. Pipeline generates 5 videos and sends them back to Telegram
 *
 * This module is completely separate from the product review flow
 * (storyboard-fullflow.js). No shared mutable state between the two.
 */

const fs = require('fs');
const path = require('path');

const { runDailyVlogFlow, getDailyVlogConfig } = require('./dailyvlog-storyboard');
const { sendTelegramMessage, sendVideoToTelegramDirect } = require('./telegram-send');

// ─── State Management ─────────────────────────────────────────────────────────

/**
 * Map<chatId, { waiting: boolean, photos: Buffer[], timer: NodeJS.Timeout|null }>
 * Tracks per-chat state for the /dailyvlog command.
 */
const dailyvlogState = new Map();

/** How long (ms) to wait for photo(s) after /dailyvlog command */
const WAIT_FOR_PHOTO_MS = parseInt(process.env.DAILYVLOG_PHOTO_WAIT_MS || '120000', 10); // 2 min default

/** Batch window: accumulate multiple photos sent in quick succession */
const BATCH_WINDOW_MS = parseInt(process.env.DAILYVLOG_BATCH_WINDOW_MS || '5000', 10);

/** Prevent concurrent dailyvlog runs per chat */
const activeRuns = new Set();

// ─── Nhi Reference Images ─────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * Load Nhi reference images from the assets/nhi directory (if it exists).
 * Falls back to an empty array — in that case Gemini uses text description only.
 * @param {string} baseDir - Root of playwright-service
 * @returns {Array<{name, mimeType, buffer}>}
 */
function loadNhiReferenceImages(baseDir) {
  const dvConfig = getDailyVlogConfig(baseDir);
  const nhiFolderPath = path.join(baseDir, dvConfig.nhiReferencePath);

  if (!fs.existsSync(nhiFolderPath)) {
    console.log(`[DailyVlog] ${dvConfig.nhiReferencePath}/ not found. Running without Nhi reference images.`);
    return [];
  }

  const entries = fs.readdirSync(nhiFolderPath);
  const imageFiles = entries.filter(e => IMAGE_EXTENSIONS.has(path.extname(e).toLowerCase()));

  if (imageFiles.length === 0) {
    console.log(`[DailyVlog] ${nhiFolderPath} is empty. Running without Nhi reference images.`);
    return [];
  }

  console.log(`[DailyVlog] Loaded ${imageFiles.length} Nhi reference image(s) from ${nhiFolderPath}`);

  return imageFiles.map(filename => {
    const ext = path.extname(filename).toLowerCase();
    const mimeType =
      ext === '.png' ? 'image/png' :
      ext === '.webp' ? 'image/webp' :
      'image/jpeg';
    const buffer = fs.readFileSync(path.join(nhiFolderPath, filename));
    return { name: filename, mimeType, buffer };
  });
}

// ─── Command Handler ──────────────────────────────────────────────────────────

/**
 * Called when user sends /dailyvlog.
 * Sets up state and asks user to send a product photo.
 *
 * @param {string} botToken
 * @param {string|number} chatId
 */
async function handleDailyVlogCommand(botToken, chatId) {
  const key = String(chatId);

  if (activeRuns.has(key)) {
    await sendTelegramMessage(chatId,
      '⏳ Đang chạy daily vlog rồi, vui lòng chờ hoàn thành trước khi gửi lại.');
    return;
  }

  // Clear any previous waiting state for this chat
  const existing = dailyvlogState.get(key);
  if (existing?.timer) clearTimeout(existing.timer);

  // Set waiting state
  dailyvlogState.set(key, {
    waiting: true,
    photos: [],
    batchTimer: null,
  });

  // Auto-cancel if no photo received within WAIT_FOR_PHOTO_MS
  const cancelTimer = setTimeout(() => {
    const state = dailyvlogState.get(key);
    if (state?.waiting) {
      dailyvlogState.delete(key);
      sendTelegramMessage(chatId,
        '⏰ Hết thời gian chờ ảnh. Gõ /dailyvlog để thử lại nhé.').catch(() => {});
    }
  }, WAIT_FOR_PHOTO_MS);

  // Store the cancel timer so it can be cleared when photo arrives
  dailyvlogState.get(key).cancelTimer = cancelTimer;

  await sendTelegramMessage(chatId,
    '🎬 Đã nhận lệnh Daily Vlog!\n\n' +
    '📸 Vui lòng gửi ảnh sản phẩm bạn muốn đưa vào vlog của Nhi.\n' +
    '(Có thể gửi nhiều ảnh cùng lúc)\n\n' +
    '⏳ Bạn có 2 phút để gửi ảnh.'
  );

  console.log(`[DailyVlog] State set for chat ${chatId}: waiting for product photo.`);
}

// ─── Photo Handler ────────────────────────────────────────────────────────────

/**
 * Called when user sends a photo and that chat has dailyvlog state.
 * Accumulates photos and starts the pipeline after BATCH_WINDOW_MS.
 *
 * @param {string} botToken
 * @param {string|number} chatId
 * @param {Buffer} photoBuffer   - Downloaded photo buffer
 * @param {string} photoName     - Filename
 */
function handleDailyVlogPhoto(botToken, chatId, photoBuffer, photoName) {
  const key = String(chatId);
  const state = dailyvlogState.get(key);

  if (!state || !state.waiting) return false; // Not in dailyvlog mode

  // Cancel the "no photo" timeout since we got a photo
  if (state.cancelTimer) clearTimeout(state.cancelTimer);

  // Add photo to batch
  state.photos.push({
    name: photoName || `product_${Date.now()}_${state.photos.length}.png`,
    mimeType: 'image/png',
    buffer: photoBuffer,
  });

  console.log(`[DailyVlog] Received photo #${state.photos.length} for chat ${chatId}`);

  // Reset batch window timer
  if (state.batchTimer) clearTimeout(state.batchTimer);

  state.batchTimer = setTimeout(async () => {
    // Grab photos and clear state
    const photos = [...state.photos];
    dailyvlogState.delete(key);

    if (photos.length === 0) {
      await sendTelegramMessage(chatId, '⚠️ Không tải được ảnh nào. Vui lòng thử lại với /dailyvlog.');
      return;
    }

    console.log(`[DailyVlog] Starting pipeline for chat ${chatId} with ${photos.length} photo(s).`);
    await runDailyVlogPipeline(botToken, chatId, photos);

  }, BATCH_WINDOW_MS);

  return true; // Consumed by dailyvlog handler
}

// ─── Full Pipeline ────────────────────────────────────────────────────────────

/**
 * Runs the complete daily vlog pipeline and sends videos back to Telegram.
 *
 * @param {string}   botToken
 * @param {string|number} chatId
 * @param {Array<{name, mimeType, buffer}>} productPhotos
 */
async function runDailyVlogPipeline(botToken, chatId, productPhotos) {
  const key = String(chatId);

  if (activeRuns.has(key)) {
    await sendTelegramMessage(chatId, '⏳ Đang chạy daily vlog rồi, vui lòng chờ...');
    return;
  }

  activeRuns.add(key);

  try {
    const baseDir = path.resolve(__dirname, '..');
    const dvConfig = getDailyVlogConfig(baseDir);
    const nhiPayloads = loadNhiReferenceImages(baseDir);

    await sendTelegramMessage(chatId,
      `🚀 Đã nhận ${productPhotos.length} ảnh sản phẩm!\n` +
      '⏳ Đang bắt đầu tạo Daily Vlog cho Nhi...\n\n' +
      'Quá trình này gồm 4 bước:\n' +
      '1️⃣ Phân tích sản phẩm lifestyle\n' +
      `2️⃣ Tạo storyboard ${dvConfig.panelCount} cảnh cho Nhi\n` +
      '3️⃣ Vẽ từng cảnh\n' +
      `4️⃣ Tạo ${dvConfig.panelCount} video Veo 3\n\n` +
      'Có thể mất 10-20 phút, bạn sẽ nhận video khi xong! ☕'
    );

    if (nhiPayloads.length > 0) {
      await sendTelegramMessage(chatId,
        `✅ Tìm thấy ${nhiPayloads.length} ảnh tham chiếu của Nhi trong server.`);
    } else {
      await sendTelegramMessage(chatId,
        `💡 Không tìm thấy ảnh Nhi trong server. Gemini sẽ tạo nhân vật dựa trên mô tả văn bản.\n` +
        `(Đặt ảnh Nhi vào thư mục ${dvConfig.nhiReferencePath}/ để kết quả tốt hơn)`);
    }

    // Step 1 notify
    await sendTelegramMessage(chatId, '1️⃣ Đang phân tích sản phẩm theo phong cách lifestyle...');

    const result = await runDailyVlogFlow(baseDir, productPhotos, nhiPayloads, {
      aspectRatio: '9:16',
    });

    // Notify step completion
    const productName = result.analysis?.productName || 'Sản phẩm';
    await sendTelegramMessage(chatId,
      `✅ Pipeline hoàn tất!\n` +
      `📦 Sản phẩm: ${productName}\n` +
      `🎬 Tạo được ${result.videos?.filter(v => !v.error).length || 0}/${result.videos?.length || 0} video\n\n` +
      '📤 Đang gửi video về Telegram...'
    );

    // Send caption suggestions if any
    if (result.captionSuggestions && result.captionSuggestions.length > 0) {
      await sendTelegramMessage(chatId,
        '💬 Gợi ý caption:\n' + result.captionSuggestions.slice(0, 3).map((c, i) => `${i + 1}. ${c}`).join('\n')
      );
    }

    // Send hashtags
    const hashtags = (result.hashtags || []).join(' ');
    if (hashtags) {
      await sendTelegramMessage(chatId, `#️⃣ Hashtags: ${hashtags}`);
    }

    // Send videos
    const videos = Array.isArray(result.videos) ? result.videos : [];
    let sentCount = 0;

    for (const video of videos) {
      if (video.error) {
        await sendTelegramMessage(chatId,
          `⚠️ Lỗi tạo video cảnh ${video.panelIndex || '?'}: ${video.error}`);
        continue;
      }

      const base64 = video.video?.base64 || video.videoBase64 || null;
      if (!base64) {
        await sendTelegramMessage(chatId,
          `⚠️ Video cảnh ${video.panelIndex || '?'} không có dữ liệu.`);
        continue;
      }

      const panelName = `Cảnh ${video.panelIndex || sentCount + 1}`;
      const panelData = result.panels?.find(p => p.index === video.panelIndex);
      const caption = panelData?.panelData?.sceneTitle
        ? `${panelName} — ${panelData.panelData.sceneTitle}`
        : `${panelName} đã sẵn sàng.`;

      const ok = await sendVideoToTelegramDirect(chatId, base64, video.panelIndex, panelName, caption);
      if (ok) sentCount++;
    }

    await sendTelegramMessage(chatId,
      `🎉 Daily Vlog hoàn tất!\n` +
      `Đã gửi ${sentCount}/${videos.length} video về Telegram.\n\n` +
      `${productName}\n${hashtags}`
    );

  } catch (err) {
    console.error(`[DailyVlog] Pipeline error for chat ${chatId}:`, err.message);
    try {
      await sendTelegramMessage(chatId,
        `❌ Lỗi tạo Daily Vlog: ${err.message}\n\nVui lòng thử lại với /dailyvlog.`);
    } catch (_) {}
  } finally {
    activeRuns.delete(key);
  }
}

// ─── State Query ──────────────────────────────────────────────────────────────

/**
 * Check if a chat is currently waiting for a dailyvlog photo.
 * @param {string|number} chatId
 * @returns {boolean}
 */
function isWaitingForDailyVlogPhoto(chatId) {
  const state = dailyvlogState.get(String(chatId));
  return !!(state && state.waiting);
}

module.exports = {
  handleDailyVlogCommand,
  handleDailyVlogPhoto,
  isWaitingForDailyVlogPhoto,
};
