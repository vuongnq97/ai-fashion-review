const fs = require('fs');
const path = require('path');
const { processVideoBase64 } = require('./video-resize');

// Cho phép kết nối an toàn qua proxy / self-signed certs tới Telegram API
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function telegramTimeoutMs(defaultMs) {
  return parseInt(process.env.TELEGRAM_SEND_TIMEOUT_MS || String(defaultMs), 10);
}

function getBotToken() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.log('[Telegram] TELEGRAM_BOT_TOKEN is not configured in .env');
    return null;
  }
  return botToken;
}

function toBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') {
    if (data.startsWith('data:')) {
      const b64 = data.split(',')[1];
      return Buffer.from(b64, 'base64');
    }
    // Check if it looks like base64 or file path
    if (fs.existsSync(data)) {
      return fs.readFileSync(data);
    }
    return Buffer.from(data, 'base64');
  }
  return null;
}

function formatReplyMarkup(replyMarkup) {
  if (!replyMarkup) return undefined;
  if (typeof replyMarkup === 'string') {
    try {
      return JSON.parse(replyMarkup);
    } catch (_) {
      return replyMarkup;
    }
  }
  return replyMarkup;
}

async function sendTelegramMessage(chatId, text, options = {}) {
  const botToken = getBotToken();
  if (!botToken) return false;

  try {
    const payload = {
      chat_id: chatId,
      text,
      ...(options.parse_mode ? { parse_mode: options.parse_mode } : {}),
    };
    if (options.reply_markup) {
      payload.reply_markup = formatReplyMarkup(options.reply_markup);
    }
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(telegramTimeoutMs(15000)),
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Telegram] sendMessage HTTP ${response.status}: ${errText}`);
      if (response.status === 400 && errText.includes("can't parse entities") && options.parse_mode) {
        console.warn(`[Telegram] Retrying sendMessage without parse_mode (plain text fallback)...`);
        const fallbackPayload = {
          chat_id: chatId,
          text,
        };
        if (options.reply_markup) {
          fallbackPayload.reply_markup = formatReplyMarkup(options.reply_markup);
        }
        const fallbackRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fallbackPayload),
          signal: AbortSignal.timeout(telegramTimeoutMs(15000)),
        });
        if (fallbackRes.ok) {
          const fallbackJson = await fallbackRes.json();
          return fallbackJson?.result?.message_id || true;
        }
      }
      return false;
    }
    const json = await response.json();
    return json?.result?.message_id || true;
  } catch (err) {
    console.error(`[Telegram] sendMessage error:`, err.message);
    return false;
  }
}

async function editTelegramMessage(chatId, messageId, text, options = {}) {
  const botToken = getBotToken();
  if (!botToken || !messageId) return false;

  try {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(options.parse_mode ? { parse_mode: options.parse_mode } : {}),
    };
    if (options.reply_markup) {
      payload.reply_markup = formatReplyMarkup(options.reply_markup);
    }
    const response = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(telegramTimeoutMs(15000)),
    });
    if (!response.ok) {
      const errText = await response.text();
      if (!errText.includes('message is not modified')) {
        console.warn(`[Telegram] editMessageText HTTP ${response.status}: ${errText}`);
      }
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[Telegram] editMessageText error:`, err.message);
    return false;
  }
}

async function deleteTelegramMessage(chatId, messageId) {
  const botToken = getBotToken();
  if (!botToken || !messageId) return false;

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      signal: AbortSignal.timeout(telegramTimeoutMs(10000)),
    });
    return response.ok;
  } catch (_) {
    return false;
  }
}

function optimizeImageForTelegram(buf) {
  if (!buf || buf.length <= 1024 * 1024) {
    return { buffer: buf, mime: 'image/png', filename: 'image.png' };
  }
  try {
    const ffmpegPath = require('ffmpeg-static');
    const os = require('os');
    const crypto = require('crypto');
    const { execSync } = require('child_process');
    const tmpId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const inTmp = path.join(os.tmpdir(), `raw-tg-${tmpId}.dat`);
    const outTmp = path.join(os.tmpdir(), `opt-tg-${tmpId}.jpg`);
    fs.writeFileSync(inTmp, buf);
    execSync(`"${ffmpegPath}" -y -i "${inTmp}" -q:v 2 -update 1 "${outTmp}"`, { timeout: 10000, stdio: 'pipe' });
    if (fs.existsSync(outTmp)) {
      const optBuf = fs.readFileSync(outTmp);
      try { fs.unlinkSync(inTmp); fs.unlinkSync(outTmp); } catch (_) {}
      if (optBuf && optBuf.length > 0) {
        console.log(`[Telegram] 📦 Compressed large photo: ${(buf.length / 1024 / 1024).toFixed(2)} MB -> ${(optBuf.length / 1024).toFixed(1)} KB`);
        return { buffer: optBuf, mime: 'image/jpeg', filename: 'image.jpg' };
      }
    }
  } catch (err) {
    console.warn(`[Telegram] optimizeImageForTelegram warning: ${err.message}`);
  }
  return { buffer: buf, mime: 'image/png', filename: 'image.png' };
}

async function sendPhotoToTelegram(chatId, imageBufferOrBase64, caption = '', options = {}) {
  const botToken = getBotToken();
  if (!botToken) return null;

  const rawBuf = toBuffer(imageBufferOrBase64);
  if (!rawBuf) return null;

  const { buffer: buf, mime, filename } = optimizeImageForTelegram(rawBuf);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const formData = new FormData();
      formData.append('chat_id', chatId);
      const blob = new Blob([buf], { type: mime });
      formData.append('photo', blob, filename);
      if (caption) formData.append('caption', caption);
      if (options.parse_mode) formData.append('parse_mode', options.parse_mode);
      if (options.reply_markup) {
        formData.append(
          'reply_markup',
          typeof options.reply_markup === 'string'
            ? options.reply_markup
            : JSON.stringify(options.reply_markup)
        );
      }

      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(telegramTimeoutMs(90000)),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[Telegram] sendPhoto failed (attempt ${attempt}/2): ${errText}`);
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        return null;
      }
      const json = await response.json();
      return json?.result?.message_id || null;
    } catch (err) {
      console.error(`[Telegram] sendPhoto error (attempt ${attempt}/2):`, err.message);
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  return null;
}

async function sendMediaGroupToTelegram(chatId, images = [], caption = '') {
  const botToken = getBotToken();
  if (!botToken || !images || images.length === 0) return false;

  try {
    const formData = new FormData();
    formData.append('chat_id', chatId);

    const media = [];
    const maxImages = Math.min(images.length, 8);

    for (let i = 0; i < maxImages; i++) {
      const item = images[i];
      const buf = toBuffer(item.buffer || item.base64 || item.path || item);
      if (!buf) continue;

      const fieldName = `photo_${i}`;
      const blob = new Blob([buf], { type: 'image/jpeg' });
      formData.append(fieldName, blob, `input_${i + 1}.jpg`);

      media.push({
        type: 'photo',
        media: `attach://${fieldName}`,
        caption: i === 0 ? caption : undefined,
      });
    }

    if (media.length === 0) return false;

    formData.append('media', JSON.stringify(media));

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMediaGroup`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(telegramTimeoutMs(60000)),
    });

    if (!response.ok) {
      console.error(`[Telegram] sendMediaGroup failed: ${await response.text()}`);
      return false;
    }
    console.log(`[Telegram] ✅ Successfully sent ${media.length} input images as media group.`);
    return true;
  } catch (err) {
    console.error(`[Telegram] sendMediaGroup error:`, err.message);
    return false;
  }
}

async function sendOrUpdateLivePanel(chatId, previousMessageId, imageBufferOrBase64, panelIndex, totalPanels = 4) {
  const botToken = getBotToken();
  if (!botToken) return null;

  const buf = toBuffer(imageBufferOrBase64);
  if (!buf) return previousMessageId;

  const isFinalPanel = panelIndex >= totalPanels;
  const caption = isFinalPanel
    ? `🖼️ Đã hoàn thành cả ${totalPanels} Panel ảnh (9:16)!\n⏳ Chuẩn bị gửi yêu cầu render video Veo 3...`
    : `🖼️ Đang sinh ảnh: Panel ${panelIndex}/${totalPanels} hoàn tất (tự động cập nhật panel tiếp theo)...`;

  if (previousMessageId) {
    try {
      const formData = new FormData();
      formData.append('chat_id', chatId);
      formData.append('message_id', previousMessageId);

      const blob = new Blob([buf], { type: 'image/png' });
      formData.append('panel_file', blob, `panel_${panelIndex}.png`);

      formData.append('media', JSON.stringify({
        type: 'photo',
        media: 'attach://panel_file',
        caption,
      }));

      const response = await fetch(`https://api.telegram.org/bot${botToken}/editMessageMedia`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(telegramTimeoutMs(20000)),
      });

      if (response.ok) {
        console.log(`[Telegram] 🔄 Updated Live Panel ${panelIndex}/${totalPanels} in-place.`);
        return previousMessageId;
      }
      // If edit fails, delete old message and send fresh
      await deleteTelegramMessage(chatId, previousMessageId);
    } catch (_) {
      await deleteTelegramMessage(chatId, previousMessageId);
    }
  }

  // Send new photo
  const newMsgId = await sendPhotoToTelegram(chatId, buf, caption);
  return newMsgId;
}

async function sendVideoToTelegramDirect(chatId, videoBase64, panelIndex, panelName, caption, options = {}) {
  const botToken = getBotToken();
  if (!botToken) return false;

  const pName = panelName || `Panel ${panelIndex || 1}`;

  try {
    const cropPct = typeof options.cropPercent === 'number' ? options.cropPercent : 0;
    console.log(`[Telegram] Preparing ${pName} before sending (crop: ${cropPct * 100}%)...`);
    const resizedBase64 = await processVideoBase64(videoBase64, {
      cropPercent: cropPct,
      aspectRatio: '9:16',
    });

    console.log(`[Telegram] Sending status update to chat ${chatId}...`);
    await sendTelegramMessage(chatId, `${pName} đã sẵn sàng. Đang gửi video về Telegram...`);

    console.log(`[Telegram] Uploading video to chat ${chatId}...`);
    const videoBuffer = Buffer.from(resizedBase64, 'base64');
    const blob = new Blob([videoBuffer], { type: 'video/mp4' });

    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('video', blob, `${pName.toLowerCase().replace(/\s+/g, '_')}_resized.mp4`);
    formData.append('width', '1080');
    formData.append('height', '1920');
    formData.append('supports_streaming', 'true');
    formData.append('caption', caption || `${pName} đã sẵn sàng.`);

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendVideo`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(telegramTimeoutMs(120000)),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Telegram API returned HTTP ${response.status}: ${errText}`);
    }

    console.log(`[Telegram] Successfully sent ${pName} to Telegram.`);
    return true;
  } catch (error) {
    console.error(`[Telegram] Failed to send ${pName} to Telegram:`, error.message);
    try {
      await sendTelegramMessage(chatId, `Lỗi gửi ${pName} về Telegram: ${error.message}`);
    } catch (_) {}
    return false;
  }
}

async function sendMergedVideoToTelegram(chatId, videoPathOrBase64, caption, options = {}) {
  const botToken = getBotToken();
  if (!botToken) return false;

  try {
    let videoBuffer = null;
    if (Buffer.isBuffer(videoPathOrBase64)) {
      videoBuffer = videoPathOrBase64;
    } else if (typeof videoPathOrBase64 === 'string') {
      if (fs.existsSync(videoPathOrBase64)) {
        videoBuffer = fs.readFileSync(videoPathOrBase64);
      } else {
        videoBuffer = Buffer.from(videoPathOrBase64, 'base64');
      }
    }
    if (!videoBuffer) return false;

    console.log(`[Telegram] Uploading final 9:16 merged video to chat ${chatId}...`);
    const blob = new Blob([videoBuffer], { type: 'video/mp4' });

    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('video', blob, `final_merged_9_16.mp4`);
    formData.append('width', '1080');
    formData.append('height', '1920');
    formData.append('supports_streaming', 'true');
    formData.append('caption', caption || '🎬 Video 9:16 hoàn chỉnh đã ghép xong.');
    if (options && options.parse_mode) {
      formData.append('parse_mode', options.parse_mode);
    }
    if (options && options.reply_markup) {
      formData.append('reply_markup', typeof options.reply_markup === 'string' ? options.reply_markup : JSON.stringify(options.reply_markup));
    }

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendVideo`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(telegramTimeoutMs(180000)),
    });

    if (!response.ok) {
      console.error(`[Telegram] sendMergedVideo failed: ${await response.text()}`);
      return false;
    }
    console.log(`[Telegram] ✅ Successfully sent final merged video to Telegram.`);
    return true;
  } catch (err) {
    console.error(`[Telegram] sendMergedVideo error:`, err.message);
    return false;
  }
}

/**
 * Edit photo of an existing message (replaces image in-place via editMessageMedia)
 */
async function editPhotoInTelegram(chatId, messageId, imageBufferOrBase64, caption = '', options = {}) {
  const botToken = getBotToken();
  if (!botToken || !chatId || !messageId) return false;

  const rawBuf = toBuffer(imageBufferOrBase64);
  if (!rawBuf) return false;

  const { buffer: buf, mime, filename } = optimizeImageForTelegram(rawBuf);

  try {
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('message_id', messageId);

    const blob = new Blob([buf], { type: mime });
    formData.append('photo_file', blob, filename);

    const mediaObj = {
      type: 'photo',
      media: 'attach://photo_file',
      ...(caption ? { caption } : {}),
      ...(options.parse_mode ? { parse_mode: options.parse_mode } : {}),
    };
    formData.append('media', JSON.stringify(mediaObj));

    if (options.reply_markup) {
      formData.append(
        'reply_markup',
        typeof options.reply_markup === 'string'
          ? options.reply_markup
          : JSON.stringify(options.reply_markup)
      );
    }

    const response = await fetch(`https://api.telegram.org/bot${botToken}/editMessageMedia`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(telegramTimeoutMs(90000)),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[Telegram] editMessageMedia failed (${response.status}): ${errText}`);
      return false;
    }
    console.log(`[Telegram] 🔄 Successfully replaced photo in message ${messageId}`);
    return true;
  } catch (err) {
    console.error(`[Telegram] editPhotoInTelegram error:`, err.message);
    return false;
  }
}

module.exports = {
  sendTelegramMessage,
  editTelegramMessage,
  deleteTelegramMessage,
  sendPhotoToTelegram,
  editPhotoInTelegram,
  sendMediaGroupToTelegram,
  sendOrUpdateLivePanel,
  sendVideoToTelegramDirect,
  sendMergedVideoToTelegram,
};
