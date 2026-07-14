const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { runStoryboardFullFlow } = require('./storyboard-fullflow');
const {
  runFromDriveFolder,
  extractDriveFolderId,
  listDriveChildFolders,
} = require('./drive-folder');
const { handleDailyVlogCommand, handleDailyVlogPhoto, isWaitingForDailyVlogPhoto } = require('./dailyvlog-flow');
const { flowQueue } = require('./flow-queue');

// Chat-specific batch data accumulator (for the normal photo flow)
const botBatches = new Map();
const pendingTemplateByChat = new Map();
const BATCH_WINDOW_MS = 5000;
let isPolling = false;
let pollingOffset = 0;

const RESERVED_COMMANDS = new Set(['start', 'dailyvlog', 'template1', 'template2', 'template3', 'status']);
const driveFolderByCommand = new Map();

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
  const commandName = String(folderName || '').trim().replace(/^\/+/, '').toLowerCase();
  const driveFolderName = driveFolderByCommand.get(commandName) || commandName;

  const selectedTemplate = pendingTemplateByChat.get(chatId) || null;
  if (selectedTemplate) pendingTemplateByChat.delete(chatId);
  const templateOptions = buildTemplateOptions(selectedTemplate);
  let templateMessage = '';
  if (selectedTemplate === 'template1') {
    templateMessage = ' bằng /template1 faceless 2 cảnh';
  } else if (selectedTemplate === 'template2') {
    templateMessage = ' bằng /template2 review 8 cảnh (video 4s)';
  } else if (selectedTemplate === 'template3') {
    templateMessage = ' bằng /template3 shop top-down 2 cảnh';
  }

  await sendTelegramMessage(botToken, chatId,
    `📂 Đang khởi động luồng /${commandName}${templateMessage} — tìm folder, tải ảnh và tạo video...`);

  const baseDir = path.resolve(__dirname, '..');

  // Enqueue through FlowQueue instead of running directly
  flowQueue.enqueue({
    chatId: String(chatId),
    photos: [],  // folder commands load their own images
    baseDir,
    templateOptions,
    label: `Folder /${commandName}`,
    execute: async (runId) => {
      const result = await runFromDriveFolder(driveFolderName, baseDir, { ...templateOptions, runId });
      const sent = result && result.sentCount != null ? result.sentCount : '?';
      const summary = result?.productInfo?.summary ? `\n${result.productInfo.summary}` : '';
      console.log(`[Telegram Bot] /${commandName} flow completed for chat ${chatId}. Sent: ${sent}`);
      await sendTelegramMessage(botToken, chatId, `${summary}`).catch(() => {});
      return result;
    },
  }).catch((err) => {
    console.error(`[Telegram Bot] /${commandName} flow error for chat ${chatId}:`, err.message);
    sendTelegramMessage(botToken, chatId,
      `⚠️ /${commandName} lỗi: ${err.message}`).catch(() => {});
  });
}

async function handleTemplate1Command(botToken, chatId) {
  const activeBatch = botBatches.get(chatId);
  if (activeBatch) {
    activeBatch.template = 'template1';
    await sendTelegramMessage(botToken, chatId,
      '✅ Đã áp dụng /template1 cho album ảnh đang gom: review faceless 2 cảnh, không voice-over.');
    return;
  }

  pendingTemplateByChat.set(chatId, 'template1');
  await sendTelegramMessage(botToken, chatId,
    '✅ Đã bật /template1 cho lượt ảnh kế tiếp: review faceless 2 cảnh, chung bối cảnh random, không voice-over.');
}

async function handleTemplate2Command(botToken, chatId) {
  const activeBatch = botBatches.get(chatId);
  if (activeBatch) {
    activeBatch.template = 'template2';
    await sendTelegramMessage(botToken, chatId,
      '✅ Đã áp dụng /template2 cho album ảnh đang gom: review 8 cảnh, mỗi cảnh 4s, không voice-over.');
    return;
  }

  pendingTemplateByChat.set(chatId, 'template2');
  await sendTelegramMessage(botToken, chatId,
    '✅ Đã bật /template2 cho lượt ảnh kế tiếp: review 8 cảnh, mỗi cảnh 4s, chung bối cảnh random, không voice-over.');
}

async function handleTemplate3Command(botToken, chatId) {
  const activeBatch = botBatches.get(chatId);
  if (activeBatch) {
    activeBatch.template = 'template3';
    await sendTelegramMessage(botToken, chatId,
      '✅ Đã áp dụng /template3 cho album ảnh đang gom: cảnh 1 top-down shop, cảnh 2 POV faceless, không voice-over.');
    return;
  }

  pendingTemplateByChat.set(chatId, 'template3');
  await sendTelegramMessage(botToken, chatId,
    '✅ Đã bật /template3 cho lượt ảnh kế tiếp: cảnh 1 top-down shop, cảnh 2 POV faceless, không voice-over.');
}

function buildTemplateOptions(template) {
  if (template === 'template1') {
    return {
      template: 'template1',
      panelCount: 2,
    };
  }
  if (template === 'template2') {
    return {
      template: 'template2',
      panelCount: 8,
      videoModelKey: '4s',
    };
  }
  if (template === 'template3') {
    return {
      template: 'template3',
      panelCount: 2,
    };
  }
  return {};
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
        '📂 Hoặc dùng các lệnh folder trong menu bot để tải ảnh từ thư mục Drive cùng tên.\n' +
        '👟 Dùng /template1 rồi gửi ảnh để tạo review faceless 2 cảnh, không voice-over.\n' +
        '🥿 Dùng /template2 rồi gửi ảnh để tạo review 8 cảnh, mỗi cảnh 4s, không voice-over.\n' +
        '🏬 Dùng /template3 rồi gửi ảnh để tạo review shop top-down 2 cảnh, không voice-over.\n' +
        '🎬 Dùng /dailyvlog để tạo video lifestyle cho Nhi.\n' +
        '📊 Dùng /status để xem hàng đợi xử lý.'
      );
      return;
    }

    // ── Status command ───────────────────────────────────────────────────────
    if (text === '/status' || text.startsWith('/status@')) {
      console.log(`[Telegram Bot] Received /status command from chat ${chatId}`);
      const { summary } = flowQueue.getStatus();
      await sendTelegramMessage(botToken, chatId, `📊 Trạng thái hàng đợi:\n${summary}`);
      return;
    }

    // ── Template 1 command ───────────────────────────────────────────────────
    if (text === '/template1' || text.startsWith('/template1@')) {
      console.log(`[Telegram Bot] Received /template1 command from chat ${chatId}`);
      await handleTemplate1Command(botToken, chatId);
      return;
    }

    // ── Template 2 command ───────────────────────────────────────────────────
    if (text === '/template2' || text.startsWith('/template2@')) {
      console.log(`[Telegram Bot] Received /template2 command from chat ${chatId}`);
      await handleTemplate2Command(botToken, chatId);
      return;
    }

    // ── Template 3 command ───────────────────────────────────────────────────
    if (text === '/template3' || text.startsWith('/template3@')) {
      console.log(`[Telegram Bot] Received /template3 command from chat ${chatId}`);
      await handleTemplate3Command(botToken, chatId);
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
    if (folderMatch && !RESERVED_COMMANDS.has(folderMatch[1].toLowerCase())) {
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
      const selectedTemplate = pendingTemplateByChat.get(chatId) || null;
      if (selectedTemplate) pendingTemplateByChat.delete(chatId);

      botBatches.set(chatId, {
        photos: [],
        timer: null,
        template: selectedTemplate
      });
      let receiveMsg = '📥 Đã nhận được hình ảnh. Đang chuẩn bị tải và gom album...';
      if (selectedTemplate === 'template1') {
        receiveMsg = '📥 Đã nhận được hình ảnh. Đang gom album cho /template1 faceless 2 cảnh...';
      } else if (selectedTemplate === 'template2') {
        receiveMsg = '📥 Đã nhận được hình ảnh. Đang gom album cho /template2 review 8 cảnh (video 4s)...';
      } else if (selectedTemplate === 'template3') {
        receiveMsg = '📥 Đã nhận được hình ảnh. Đang gom album cho /template3 shop top-down 2 cảnh...';
      }
      await sendTelegramMessage(botToken, chatId, receiveMsg);
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
      // Clean up the batch map entry immediately so new photos create a new batch
      botBatches.delete(chatId);

      console.log(`[Telegram Bot] Batch timed out for chat ${chatId}. Checking downloads...`);

      // Give active downloads 2 seconds to finish up
      await new Promise(resolve => setTimeout(resolve, 2000));

      if (batch.photos.length === 0) {
        await sendTelegramMessage(botToken, chatId,
          '⚠️ Không tải được ảnh nào thành công. Vui lòng thử lại.');
        return;
      }

      const templateOptions = buildTemplateOptions(batch.template);
      let templateMessage = '';
      if (batch.template === 'template1') {
        templateMessage = ' theo /template1 faceless 2 cảnh';
      } else if (batch.template === 'template2') {
        templateMessage = ' theo /template2 review 8 cảnh (video 4s)';
      } else if (batch.template === 'template3') {
        templateMessage = ' theo /template3 shop top-down 2 cảnh';
      }

      await sendTelegramMessage(botToken, chatId,
        `🚀 Đã nhận đủ ${batch.photos.length} ảnh. Đang tạo storyboard và video${templateMessage}...`);

      // Snapshot the photos — batch map entry is already deleted so user can
      // send a new album immediately. The job is enqueued and will run when
      // a slot opens up.
      const photosCopy = [...batch.photos];
      const baseDir = path.resolve(__dirname, '..');

      flowQueue.enqueue({
        chatId: String(chatId),
        photos: photosCopy,
        baseDir,
        templateOptions,
        label: `Album ${photosCopy.length} ảnh${templateMessage}`,
        execute: async (runId) => {
          return runStoryboardFullFlow(chatId, photosCopy, baseDir, { ...templateOptions, runId });
        },
      })
        .then(() => {
          console.log(`[Telegram Bot] Storyboard full flow completed for chat ${chatId}`);
        })
        .catch(err => {
          console.error(`[Telegram Bot] Full flow error for chat ${chatId}:`, err.message);
          sendTelegramMessage(botToken, chatId,
            `⚠️ Lỗi chạy full flow: ${err.message}`).catch(() => {});
        });

    }, BATCH_WINDOW_MS);
  }
}

function getDriveParentFolderIdFromEnv() {
  const parentFolder = (
    process.env.DRIVE_PARENT_FOLDER_ID ||
    process.env.DRIVE_PARENT_FOLDER_URL ||
    process.env.DRIVE_PARENT_FOLDER ||
    ''
  ).trim();
  return extractDriveFolderId(parentFolder);
}

function folderNameToTelegramCommand(folderName) {
  const command = String(folderName || '')
    .trim()
    .replace(/^\/+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);

  // Telegram bot commands support lowercase letters, digits and underscores.
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(command)) return null;
  if (RESERVED_COMMANDS.has(command)) return null;
  return command;
}

async function buildTelegramCommandsFromDrive() {
  const commands = [
    { command: 'status', description: '📊 Xem trạng thái hàng đợi xử lý' },
    { command: 'template1', description: '👟 Review faceless 2 cảnh, không voice-over' },
    { command: 'template2', description: '🥿 Review 8 cảnh, mỗi cảnh 4s, không voice-over' },
    { command: 'template3', description: '🏬 Review shop top-down 2 cảnh, không voice-over' },
    { command: 'dailyvlog', description: '🎬 Tạo daily vlog lifestyle cho Nhi từ ảnh sản phẩm' },
  ];

  const parentFolderId = getDriveParentFolderIdFromEnv();
  if (!parentFolderId) {
    console.warn('[Telegram Bot] DRIVE_PARENT_FOLDER_ID/URL is not configured; folder command menu will only include built-in commands.');
    return commands;
  }

  try {
    const folders = await listDriveChildFolders(parentFolderId);
    const seen = new Set(commands.map(item => item.command));
    driveFolderByCommand.clear();

    for (const folder of folders) {
      const command = folderNameToTelegramCommand(folder.name);
      if (!command) {
        console.warn(`[Telegram Bot] Skipping Drive folder "${folder.name}" because it is not a valid Telegram command name.`);
        continue;
      }
      if (seen.has(command)) continue;

      commands.push({
        command,
        description: `Chạy luồng folder ${folder.name}`,
      });
      seen.add(command);
      driveFolderByCommand.set(command, folder.name);

      // Telegram Bot API allows up to 100 commands. Keep room for /start below.
      if (commands.length >= 99) {
        console.warn('[Telegram Bot] Command menu reached Telegram limit; remaining Drive folders are not shown.');
        break;
      }
    }

    console.log(`[Telegram Bot] Loaded ${Math.max(0, commands.length - 2)} folder command(s) from Drive parent ${parentFolderId}.`);
  } catch (err) {
    console.warn('[Telegram Bot] ⚠️ Could not load Drive folder commands:', err.message);
  }

  return commands;
}

/**
 * Register bot commands so Telegram shows Drive folder names as tappable buttons.
 * Uses the setMyCommands API — called once on startup.
 */
async function registerBotCommands(botToken) {
  const commands = await buildTelegramCommandsFromDrive();
  commands.push({ command: 'start', description: 'Bắt đầu / Xem hướng dẫn' });

  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/setMyCommands`, { commands }, {
      timeout: parseInt(process.env.TELEGRAM_SEND_TIMEOUT_MS || '15000', 10)
    });
    console.log(`[Telegram Bot] ✅ Bot commands registered (${commands.length} command(s), menu buttons ready).`);
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
