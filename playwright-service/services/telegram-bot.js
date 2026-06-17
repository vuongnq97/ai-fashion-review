const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { runStoryboardFullFlow } = require('./storyboard-fullflow');
const { runFromDriveFolder } = require('./drive-folder');
const { handleDailyVlogCommand, handleDailyVlogPhoto, isWaitingForDailyVlogPhoto } = require('./dailyvlog-flow');

// Chat-specific batch data accumulator (for the normal photo flow)
const botBatches = new Map();
const BATCH_WINDOW_MS = 5000;
let isPolling = false;
let pollingOffset = 0;

// Prevent concurrent folder-command runs per chat
const activePRuns = new Set();

/**
 * Sends a text message to a specific Telegram Chat ID
 */
async function sendTelegramMessage(botToken, chatId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: text
    }, {
      timeout: parseInt(process.env.TELEGRAM_SEND_TIMEOUT_MS || '15000', 10)
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
 * Handle folder commands such as /p1, /p2, /m1, /m2.
 * Triggers the same drive-folder flow as `node server.js -p <n>` would.
 */
async function handleFolderCommand(botToken, chatId, folderName) {
  const commandName = String(folderName || '').trim().toLowerCase();
  const runKey = `${chatId}:${commandName}`;

  if (activePRuns.has(runKey)) {
    await sendTelegramMessage(botToken, chatId,
      `⏳ Đang chạy /${commandName} rồi, vui lòng chờ hoàn thành trước khi gửi lại.`);
    return;
  }

  activePRuns.add(runKey);
  await sendTelegramMessage(botToken, chatId,
    `📂 Đang khởi động luồng /${commandName} — tìm folder, tải ảnh và tạo video...`);

  const baseDir = path.resolve(__dirname, '..');

  runFromDriveFolder(commandName, baseDir)
    .then((result) => {
      const sent = result && result.sentCount != null ? result.sentCount : '?';
      const summary = result?.productInfo?.summary ? `\n${result.productInfo.summary}` : '';
      console.log(`[Telegram Bot] /${commandName} flow completed for chat ${chatId}. Sent: ${sent}`);
      sendTelegramMessage(botToken, chatId,
        `${summary}`).catch(() => { });
    })
    .catch((err) => {
      console.error(`[Telegram Bot] /${commandName} flow error for chat ${chatId}:`, err.message);
      sendTelegramMessage(botToken, chatId,
        `⚠️ /${commandName} lỗi: ${err.message}`).catch(() => { });
    })
    .finally(() => {
      activePRuns.delete(runKey);
    });
}

/**
 * Process a single Telegram update
 */
async function handleUpdate(botToken, update) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;

  // ── 1. Handle commands ────────────────────────────────────────────────────
  if (message.text) {
    const text = message.text.trim();

    // /start
    if (text.startsWith('/start')) {
      await sendTelegramMessage(botToken, chatId,
        '👋 Xin chào! Hãy gửi các ảnh sản phẩm qua đây, tôi sẽ tự động phân tích và tạo video review thời trang cho bạn.\n\n' +
        '📂 Hoặc dùng lệnh như /p1 /p2 /m1 /m2 để tải ảnh từ thư mục Drive/local cùng tên.\n' +
        '🎬 Dùng /dailyvlog để tạo video lifestyle cho Nhi.'
      );
      return;
    }

    // ── Daily Vlog command ────────────────────────────────────────────────────
    if (text === '/dailyvlog' || text.startsWith('/dailyvlog@')) {
      console.log(`[Telegram Bot] Received /dailyvlog command from chat ${chatId}`);
      await handleDailyVlogCommand(botToken, chatId);
      return;
    }

    // Folder commands (also handles e.g. /p1@botname sent in groups).
    // Keep /start and /dailyvlog reserved; any other alphanumeric command maps to a folder name.
    const folderMatch = text.match(/^\/([a-zA-Z][a-zA-Z0-9_]{0,31})(?:@\S+)?$/);
    if (folderMatch && !['start', 'dailyvlog'].includes(folderMatch[1].toLowerCase())) {
      const folderName = folderMatch[1].toLowerCase();
      console.log(`[Telegram Bot] Received /${folderName} command from chat ${chatId}`);
      await handleFolderCommand(botToken, chatId, folderName);
      return;
    }
  }

  // ── 2. Handle photos ──────────────────────────────────────────────────────
  if (message.photo && message.photo.length > 0) {
    // Get the highest resolution photo (last element in the array)
    const photo = message.photo[message.photo.length - 1];
    const fileId = photo.file_id;

    console.log(`[Telegram Bot] Received photo from chat ${chatId}, file_id: ${fileId}`);

    // ── 2a. Daily Vlog photo: route to dailyvlog handler if waiting ───────────
    if (isWaitingForDailyVlogPhoto(chatId)) {
      downloadTelegramFile(botToken, fileId)
        .then(buffer => {
          const photoName = `dailyvlog_${Date.now()}.png`;
          const consumed = handleDailyVlogPhoto(botToken, chatId, buffer, photoName);
          if (consumed) {
            console.log(`[Telegram Bot] Photo routed to dailyvlog handler for chat ${chatId}`);
          }
        })
        .catch(err => {
          console.error(`[Telegram Bot] Error downloading dailyvlog photo ${fileId}:`, err.message);
        });
      return; // Photo handled by dailyvlog flow
    }

    // If it's a new batch for this chat, notify user and set up map entry
    if (!botBatches.has(chatId)) {
      botBatches.set(chatId, {
        photos: [],
        timer: null
      });
      await sendTelegramMessage(botToken, chatId,
        '📥 Đã nhận được hình ảnh. Đang chuẩn bị tải và gom album...');
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
        await sendTelegramMessage(botToken, chatId,
          '⚠️ Không tải được ảnh nào thành công. Vui lòng thử lại.');
        return;
      }

      await sendTelegramMessage(botToken, chatId,
        `🚀 Đã nhận đủ ${batch.photos.length} ảnh. Đang tạo storyboard và video...`);

      // Trigger the provider-based full flow in the background.
      const baseDir = path.resolve(__dirname, '..');
      runStoryboardFullFlow(chatId, batch.photos, baseDir)
        .then(() => {
          console.log(`[Telegram Bot] Storyboard full flow completed for chat ${chatId}`);
        })
        .catch(err => {
          console.error(`[Telegram Bot] Full flow error for chat ${chatId}:`, err.message);
          sendTelegramMessage(botToken, chatId,
            `⚠️ Lỗi chạy full flow: ${err.message}`).catch(() => { });
        });

    }, BATCH_WINDOW_MS);
  }
}

/**
 * Register sample bot commands so Telegram shows common folder names as tappable buttons.
 * Uses the setMyCommands API — called once on startup.
 */
async function registerBotCommands(botToken) {
  const commands = [
    { command: 'dailyvlog', description: '🎬 Tạo daily vlog lifestyle cho Nhi từ ảnh sản phẩm' },
    { command: 'p1', description: 'Chạy luồng folder p1' },
    { command: 'p2', description: 'Chạy luồng folder p2' },
    { command: 'p3', description: 'Chạy luồng folder p3' },
    { command: 'p4', description: 'Chạy luồng folder p4' },
    { command: 'p5', description: 'Chạy luồng folder p5' },
    { command: 'p6', description: 'Chạy luồng folder p6' },
    { command: 'p7', description: 'Chạy luồng folder p7' },
    { command: 'p8', description: 'Chạy luồng folder p8' },
    { command: 'p9', description: 'Chạy luồng folder p9' },
    { command: 'p10', description: 'Chạy luồng folder p10' },
    { command: 'm1', description: 'Chạy luồng folder m1' },
    { command: 'm2', description: 'Chạy luồng folder m2' },
    { command: 'start', description: 'Bắt đầu / Xem hướng dẫn' },
  ];
  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/setMyCommands`, { commands }, {
      timeout: parseInt(process.env.TELEGRAM_SEND_TIMEOUT_MS || '15000', 10)
    });
    console.log('[Telegram Bot] ✅ Bot commands registered (menu buttons ready).');
  } catch (err) {
    console.warn('[Telegram Bot] ⚠️ Failed to register bot commands:', err.message);
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

  // Register command menu buttons on startup (fire-and-forget)
  registerBotCommands(botToken);

  isPolling = true;
  console.log('[Telegram Bot] Starting Telegram updates polling loop...');

  // Start polling asynchronously
  (async () => {
    while (isPolling) {
      try {
        const pollTimeoutSeconds = Math.max(
          10,
          parseInt(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS || '50', 10)
        );
        const requestTimeoutMs = Math.max(
          pollTimeoutSeconds * 1000 + 25000,
          parseInt(process.env.TELEGRAM_POLL_REQUEST_TIMEOUT_MS || '75000', 10)
        );
        const response = await axios.get(`https://api.telegram.org/bot${botToken}/getUpdates`, {
          params: {
            offset: pollingOffset,
            timeout: pollTimeoutSeconds,
            allowed_updates: JSON.stringify(['message'])
          },
          timeout: requestTimeoutMs
        });

        const updates = response.data.result || [];
        for (const update of updates) {
          pollingOffset = update.update_id + 1;
          await handleUpdate(botToken, update);
        }
      } catch (error) {
        if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '')) {
          console.warn('[Telegram Bot] Polling request timed out; retrying...');
        } else {
          console.error('[Telegram Bot] Polling error:', error.message);
        }
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
