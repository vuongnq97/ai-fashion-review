const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { runStoryboardAutomation } = require('./automation');

// Chat-specific batch data accumulator
const botBatches = new Map();
const BATCH_WINDOW_MS = 5000;
let isPolling = false;
let pollingOffset = 0;

/**
 * Sends a text message to a specific Telegram Chat ID
 */
async function sendTelegramMessage(botToken, chatId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: text
    });
  } catch (error) {
    console.error(`[Telegram Bot] Error sending message to ${chatId}:`, error.message);
  }
}

/**
 * Downloads a photo from Telegram by file_id and returns the binary Buffer
 */
async function downloadTelegramFile(botToken, fileId) {
  // 1. Get file path
  const fileInfoRes = await axios.get(`https://api.telegram.org/bot${botToken}/getFile`, {
    params: { file_id: fileId }
  });

  if (!fileInfoRes.data || !fileInfoRes.data.ok) {
    throw new Error(`Telegram getFile API failed: ${JSON.stringify(fileInfoRes.data)}`);
  }

  const filePath = fileInfoRes.data.result.file_path;
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

  // 2. Download the binary file data
  const downloadRes = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
  return Buffer.from(downloadRes.data);
}

/**
 * Process a single Telegram update
 */
async function handleUpdate(botToken, update) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;

  // 1. Handle commands
  if (message.text && message.text.startsWith('/start')) {
    await sendTelegramMessage(botToken, chatId, "👋 Xin chào! Hãy gửi các ảnh sản phẩm qua đây, tôi sẽ tự động phân tích và tạo video review thời trang cho bạn.");
    return;
  }

  // 2. Handle photos
  if (message.photo && message.photo.length > 0) {
    // Get the highest resolution photo (last element in the array)
    const photo = message.photo[message.photo.length - 1];
    const fileId = photo.file_id;

    console.log(`[Telegram Bot] Received photo from chat ${chatId}, file_id: ${fileId}`);

    // If it's a new batch for this chat, notify user and set up map entry
    if (!botBatches.has(chatId)) {
      botBatches.set(chatId, {
        photos: [],
        timer: null
      });
      await sendTelegramMessage(botToken, chatId, "📥 Đã nhận được hình ảnh. Đang chuẩn bị tải và gom album...");
    }

    const batch = botBatches.get(chatId);

    // Download the photo in the background and store it in the batch
    downloadTelegramFile(botToken, fileId)
      .then(buffer => {
        batch.photos.push({
          name: `tele_${Date.now()}_${batch.photos.length}.png`,
          mimeType: 'image/png',
          buffer: buffer
        });
        console.log(`[Telegram Bot] Downloaded image #${batch.photos.length} for chat ${chatId}`);
      })
      .catch(err => {
        console.error(`[Telegram Bot] Error downloading file ${fileId}:`, err.message);
      });

    // Reset the batch window timer
    if (batch.timer) clearTimeout(batch.timer);

    batch.timer = setTimeout(async () => {
      // Clean up the batch map entry
      botBatches.delete(chatId);

      console.log(`[Telegram Bot] Batch timed out for chat ${chatId}. Checking downloads...`);
      
      // Give active downloads 2 seconds to finish up
      await new Promise(resolve => setTimeout(resolve, 2000));

      if (batch.photos.length === 0) {
        await sendTelegramMessage(botToken, chatId, "⚠️ Không tải được ảnh nào thành công. Vui lòng thử lại.");
        return;
      }

      await sendTelegramMessage(botToken, chatId, `🚀 Đã nhận đủ ${batch.photos.length} ảnh. Đang mở trình duyệt tự động để tạo Storyboard...`);

      // Trigger the Playwright automation in the background
      const baseDir = path.resolve(__dirname, '..');
      runStoryboardAutomation(chatId, batch.photos, baseDir)
        .then(() => {
          console.log(`[Telegram Bot] Storyboard automation completed for chat ${chatId}`);
        })
        .catch(err => {
          console.error(`[Telegram Bot] Playwright execution error for chat ${chatId}:`, err.message);
          sendTelegramMessage(botToken, chatId, `⚠️ Lỗi chạy tự động: ${err.message}`).catch(() => {});
        });

    }, BATCH_WINDOW_MS);
  }
}

/**
 * Starts the Telegram Bot Long Polling loop
 */
function startTelegramBot() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.warn('[Telegram Bot] ⚠️ TELEGRAM_BOT_TOKEN is not configured in .env. Bot listener is disabled.');
    return;
  }

  if (isPolling) {
    console.log('[Telegram Bot] Bot is already polling.');
    return;
  }

  isPolling = true;
  console.log('[Telegram Bot] Starting Telegram updates polling loop...');

  // Start polling asynchronously
  (async () => {
    while (isPolling) {
      try {
        const response = await axios.get(`https://api.telegram.org/bot${botToken}/getUpdates`, {
          params: {
            offset: pollingOffset,
            timeout: 30,
            allowed_updates: JSON.stringify(['message'])
          },
          timeout: 35000 // Timeout slightly longer than the Telegram API timeout (30s)
        });

        const updates = response.data.result || [];
        for (const update of updates) {
          pollingOffset = update.update_id + 1;
          await handleUpdate(botToken, update);
        }
      } catch (error) {
        console.error('[Telegram Bot] Polling error:', error.message);
        // Wait 5 seconds on failure before retrying to avoid high CPU loop
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  })();
}

/**
 * Stops the Telegram Bot Polling loop
 */
function stopTelegramBot() {
  isPolling = false;
  console.log('[Telegram Bot] Stopped Telegram updates polling loop.');
}

module.exports = {
  startTelegramBot,
  stopTelegramBot
};
