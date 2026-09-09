'use strict';

/**
 * /tq — Quick Video From Image + Prompt
 *
 * Flow:
 *  1. User gõ /tq → bot gửi hướng dẫn gửi ảnh
 *  2. User gửi 1 hoặc nhiều ảnh (gom trong BATCH_WINDOW_MS)
 *  3. Bot yêu cầu user gửi prompt
 *  4. User gửi prompt (text)
 *  5. Bot gửi inline keyboard chọn thời lượng: 4s / 6s / 8s / 10s
 *  6. User chọn → bot tạo video ngay, gửi kết quả
 */

const fs = require('fs');
const path = require('path');

// Duration → video model key map (same keys used by the main system)
const DURATION_MODEL_MAP = {
  '4s':  'veo_3_1_i2v_s_lite_4s_low_priority',
  '6s':  '6s',
  '8s':  'abra_i2v_8s',
  '10s': '10s',
};

// Per-chat state machine
// State values: 'waiting_photo' | 'waiting_prompt' | 'waiting_duration'
const tqStates = new Map(); // chatId → state object
const BATCH_WINDOW_MS = 5000; // 5 s window to accumulate photos (album)

/**
 * Returns the current /tq state for a chatId, or null.
 * @param {string|number} chatId
 */
function getTqState(chatId) {
  return tqStates.get(String(chatId)) || null;
}

/**
 * Clears /tq state for a chatId (e.g. after completion or cancellation).
 */
function clearTqState(chatId) {
  const state = tqStates.get(String(chatId));
  if (state?.batchTimer) clearTimeout(state.batchTimer);
  tqStates.delete(String(chatId));
}

/**
 * Returns true if the chat is currently in any /tq state.
 */
function isInTqFlow(chatId) {
  return tqStates.has(String(chatId));
}

/**
 * Returns true if the chat is waiting for a text prompt (step 3).
 */
function isWaitingTqPrompt(chatId) {
  const s = getTqState(chatId);
  return s?.step === 'waiting_prompt';
}

/**
 * Returns true if the chat is waiting for a photo (step 2).
 */
function isWaitingTqPhoto(chatId) {
  const s = getTqState(chatId);
  return s?.step === 'waiting_photo';
}

/**
 * Handle the /tq command: send instructions and set state.
 */
async function handleTqCommand(botToken, chatId, sendTelegramMessage) {
  // Reset any existing state
  clearTqState(chatId);

  tqStates.set(String(chatId), {
    step: 'waiting_photo',
    photos: [],
    prompt: null,
    batchTimer: null,
  });

  await sendTelegramMessage(
    botToken,
    chatId,
    '🎬 <b>TẠO VIDEO TỪ ẢNH CỦA BẠN (/tq)</b>\n\n' +
    '📋 <b>Hướng dẫn 2 bước:</b>\n\n' +
    '1️⃣ <b>Gửi ảnh</b> — Gửi 1 hoặc nhiều ảnh (album) vào chat này ngay bây giờ.\n' +
    '2️⃣ <b>Gửi prompt</b> — Sau khi gửi ảnh xong, gửi 1 tin nhắn text mô tả video bạn muốn tạo.\n\n' +
    '⏱️ <i>Bot sẽ hỏi bạn chọn thời lượng video (4s / 6s / 8s / 10s) trước khi tạo.</i>\n\n' +
    '❌ Gõ /cancel để huỷ bất kỳ lúc nào.',
    { parse_mode: 'HTML' }
  );
}

/**
 * Handle incoming photo while in /tq flow.
 * Accumulates photos in a batch window, then transitions to waiting_prompt.
 */
function handleTqPhoto(botToken, chatId, photoBuffer, photoName, sendTelegramMessage) {
  const key = String(chatId);
  const state = tqStates.get(key);
  if (!state || state.step !== 'waiting_photo') return false;

  // Add photo to batch
  state.photos.push({
    name: photoName || `tq_${Date.now()}_${state.photos.length}.png`,
    mimeType: 'image/png',
    buffer: photoBuffer,
  });

  console.log(`[TQ Flow] Chat ${chatId}: received photo #${state.photos.length}`);

  // Reset batch window timer
  if (state.batchTimer) clearTimeout(state.batchTimer);

  state.batchTimer = setTimeout(async () => {
    state.batchTimer = null;
    const photoCount = state.photos.length;

    if (photoCount === 0) {
      await sendTelegramMessage(botToken, chatId,
        '⚠️ Không tải được ảnh nào thành công. Hãy gửi lại ảnh hoặc gõ /tq để bắt đầu lại.');
      clearTqState(chatId);
      return;
    }

    // Transition to waiting_prompt
    state.step = 'waiting_prompt';
    console.log(`[TQ Flow] Chat ${chatId}: batch closed with ${photoCount} photo(s), waiting for prompt`);

    await sendTelegramMessage(
      botToken,
      chatId,
      `✅ Đã nhận <b>${photoCount} ảnh</b>.\n\n` +
      '2️⃣ Bây giờ hãy gửi <b>prompt mô tả video</b> bạn muốn tạo:\n' +
      '<i>(VD: "Tạo video sản phẩm đẹp, chuyển động chậm rãi, ánh sáng tự nhiên, faceless")</i>',
      { parse_mode: 'HTML' }
    );
  }, BATCH_WINDOW_MS);

  return true;
}

/**
 * Handle incoming text prompt while in /tq flow (step: waiting_prompt).
 * Saves the prompt and sends the duration selector keyboard.
 */
async function handleTqPrompt(botToken, chatId, promptText, sendTelegramMessage) {
  const key = String(chatId);
  const state = tqStates.get(key);
  if (!state || state.step !== 'waiting_prompt') return false;

  state.prompt = promptText.trim();
  state.step = 'waiting_duration';

  console.log(`[TQ Flow] Chat ${chatId}: received prompt, waiting for duration`);

  const durationKeyboard = {
    inline_keyboard: [
      [
        { text: '⏱ 4 giây', callback_data: `tq_duration:${chatId}:4s` },
        { text: '⏱ 6 giây', callback_data: `tq_duration:${chatId}:6s` },
        { text: '⏱ 8 giây', callback_data: `tq_duration:${chatId}:8s` },
        { text: '⏱ 10 giây', callback_data: `tq_duration:${chatId}:10s` },
      ],
    ],
  };

  await sendTelegramMessage(
    botToken,
    chatId,
    '⏱️ <b>Chọn thời lượng video:</b>',
    { parse_mode: 'HTML', reply_markup: durationKeyboard }
  );

  return true;
}

/**
 * Handle the inline button callback for duration selection.
 * Validates state, then launches video generation.
 *
 * @param {string} botToken
 * @param {object} callbackQuery - Telegram callbackQuery object
 * @param {Function} answerCallbackQuery
 * @param {Function} sendTelegramMessage
 * @param {Function} sendVideoToTelegramDirect
 * @param {string} baseDir
 * @param {object} flowQueue
 */
async function handleTqDurationCallback(
  botToken,
  callbackQuery,
  answerCallbackQuery,
  sendTelegramMessage,
  sendVideoToTelegramDirect,
  baseDir,
  flowQueue
) {
  const queryId = callbackQuery.id;
  const message = callbackQuery.message;
  if (!message) return false;

  const data = String(callbackQuery.data || '');
  // callback_data format: tq_duration:<chatId>:<duration>
  const match = data.match(/^tq_duration:(\d+):(\d+s)$/);
  if (!match) return false;

  const chatId = match[1];
  const duration = match[2]; // '4s' | '6s' | '8s' | '10s'
  const modelKey = DURATION_MODEL_MAP[duration] || 'abra_i2v_8s';

  await answerCallbackQuery(botToken, queryId, `✅ Đã chọn ${duration}!`);

  const state = getTqState(chatId);
  if (!state || state.step !== 'waiting_duration') {
    await sendTelegramMessage(botToken, chatId,
      '⚠️ Phiên /tq đã hết hạn hoặc bị huỷ. Hãy gõ /tq để bắt đầu lại.');
    return true;
  }

  const photos = [...state.photos];
  const prompt = state.prompt;

  // Clear state before async work so user can start new session
  clearTqState(chatId);

  if (!photos || photos.length === 0) {
    await sendTelegramMessage(botToken, chatId,
      '⚠️ Không tìm thấy ảnh trong phiên. Hãy gõ /tq để bắt đầu lại.');
    return true;
  }

  if (!prompt) {
    await sendTelegramMessage(botToken, chatId,
      '⚠️ Không tìm thấy prompt trong phiên. Hãy gõ /tq để bắt đầu lại.');
    return true;
  }

  await sendTelegramMessage(
    botToken,
    chatId,
    `🎬 <b>Đang tạo video ${duration}...</b>\n` +
    `🖼 Ảnh: ${photos.length} ảnh\n` +
    `📝 Prompt: <i>${prompt.slice(0, 120)}${prompt.length > 120 ? '...' : ''}</i>\n\n` +
    '⏳ <i>Quá trình tạo video có thể mất 1–3 phút. Bạn sẽ nhận video ngay khi hoàn tất!</i>',
    { parse_mode: 'HTML' }
  );

  console.log(`[TQ Flow] Chat ${chatId}: launching video generation — duration=${duration}, photos=${photos.length}, prompt="${prompt.slice(0, 80)}..."`);

  // Enqueue the generation job
  flowQueue.enqueue({
    chatId: String(chatId),
    photos,
    baseDir,
    templateOptions: { template: 'tq' },
    label: `TQ video ${duration} (${photos.length} ảnh)`,
    execute: async (runId) => {
      return await runTqVideoGeneration({
        botToken,
        chatId,
        photos,
        prompt,
        modelKey,
        duration,
        baseDir,
        runId,
        sendTelegramMessage,
        sendVideoToTelegramDirect,
      });
    },
  }).catch(async (err) => {
    console.error(`[TQ Flow] Queue error for chat ${chatId}:`, err.message);
    await sendTelegramMessage(botToken, chatId,
      `❌ Lỗi khi tạo video: ${err.message}\n👉 Hãy gõ /tq để thử lại.`);
  });

  return true;
}

/**
 * Core video generation logic for /tq.
 * Uses multi-image upload mode (same as t52) via generateVideosFromPanelsDirect.
 */
async function runTqVideoGeneration({
  botToken,
  chatId,
  photos,
  prompt,
  modelKey,
  duration,
  baseDir,
  runId,
  sendTelegramMessage,
  sendVideoToTelegramDirect,
}) {
  const { generateVideosFromPanelsDirect } = require('./gemini-webapi-storyboard');

  // Build a single "panel" that carries all user photos as referenceImages
  // This mirrors template5_2's multi-image upload mode
  const referenceImages = photos.map((photo, idx) => ({
    name: photo.name || `tq-img-${idx + 1}.png`,
    mimeType: photo.mimeType || 'image/png',
    buffer: photo.buffer,
  }));

  // The panel uses the first image as primary imagePath placeholder,
  // and all images as referenceImages (multi-image upload mode)
  const panels = [
    {
      index: 1,
      panelIndex: 1,
      prompt,
      buffer: photos[0].buffer,
      mimeType: photos[0].mimeType || 'image/png',
      imagePath: null, // buffer provided directly
      videoModelKey: modelKey,
      referenceImages,
    },
  ];

  const tag = runId || `tq-${Date.now()}`;

  const videos = await generateVideosFromPanelsDirect(baseDir, panels, {
    aspectRatio: '9:16',
    includeVideoBase64: true,
    multiImageMode: true,
    runId: tag,
    // t52 uses 0.12 crop border
    // /tq — no border (user-provided prompt, not product review)
  });

  if (!videos || videos.length === 0) {
    await sendTelegramMessage(botToken, chatId,
      '❌ Không tạo được video nào. Hãy gõ /tq để thử lại.');
    return;
  }

  let successCount = 0;
  for (const v of videos) {
    if (!v || v.error) {
      const errMsg = v?.error || 'Lỗi không xác định';
      console.error(`[TQ Flow] Video error for chat ${chatId}:`, errMsg);
      await sendTelegramMessage(botToken, chatId,
        `❌ Lỗi tạo video: ${errMsg}\n👉 Hãy gõ /tq để thử lại.`);
      continue;
    }

    const base64 = v.video?.base64 ||
      (v.videoPath && fs.existsSync(v.videoPath)
        ? fs.readFileSync(v.videoPath).toString('base64')
        : null);

    if (!base64) {
      await sendTelegramMessage(botToken, chatId,
        '❌ Video được tạo nhưng không đọc được file. Hãy gõ /tq để thử lại.');
      continue;
    }

    const videoBuffer = Buffer.from(base64, 'base64');
    try {
      await sendVideoToTelegramDirect(
        chatId,
        videoBuffer,
        `✅ Video ${duration} hoàn tất! 🎬\n👉 Gõ /tq để tạo video mới.`
      );
      successCount++;
      console.log(`[TQ Flow] ✅ Video ${duration} sent to chat ${chatId} successfully`);
    } catch (sendErr) {
      console.error(`[TQ Flow] Error sending video to chat ${chatId}:`, sendErr.message);
      await sendTelegramMessage(botToken, chatId,
        `⚠️ Video đã tạo nhưng gửi thất bại: ${sendErr.message}\n👉 Hãy gõ /tq để thử lại.`);
    }
  }

  if (successCount === 0) {
    await sendTelegramMessage(botToken, chatId,
      '❌ Tất cả video đều thất bại. Hãy gõ /tq để thử lại.');
  }
}

/**
 * Handle /cancel command (or any cancel-like action) to abort current /tq session.
 * Returns true if there was an active session to cancel.
 */
async function handleTqCancel(botToken, chatId, sendTelegramMessage) {
  if (!isInTqFlow(chatId)) return false;
  clearTqState(chatId);
  await sendTelegramMessage(botToken, chatId,
    '❌ Đã huỷ phiên /tq. Gõ /tq để bắt đầu lại bất kỳ lúc nào!');
  return true;
}

module.exports = {
  handleTqCommand,
  handleTqPhoto,
  handleTqPrompt,
  handleTqDurationCallback,
  handleTqCancel,
  isInTqFlow,
  isWaitingTqPhoto,
  isWaitingTqPrompt,
  getTqState,
  clearTqState,
};
