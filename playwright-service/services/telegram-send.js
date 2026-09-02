const fs = require('fs');
const path = require('path');
const { processVideoBase64 } = require('./video-resize');

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

async function sendTelegramMessage(chatId, text) {
  const botToken = getBotToken();
  if (!botToken) return false;

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(telegramTimeoutMs(15000)),
    });
    if (!response.ok) {
      console.error(`[Telegram] sendMessage HTTP ${response.status}: ${await response.text()}`);
      return false;
    }
    const json = await response.json();
    return json?.result?.message_id || true;
  } catch (err) {
    console.error(`[Telegram] sendMessage error:`, err.message);
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

async function sendPhotoToTelegram(chatId, imageBufferOrBase64, caption = '') {
  const botToken = getBotToken();
  if (!botToken) return null;

  const buf = toBuffer(imageBufferOrBase64);
  if (!buf) return null;

  try {
    const formData = new FormData();
    formData.append('chat_id', chatId);
    const blob = new Blob([buf], { type: 'image/png' });
    formData.append('photo', blob, 'image.png');
    if (caption) formData.append('caption', caption);

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(telegramTimeoutMs(30000)),
    });

    if (!response.ok) {
      console.error(`[Telegram] sendPhoto failed: ${await response.text()}`);
      return null;
    }
    const json = await response.json();
    return json?.result?.message_id || null;
  } catch (err) {
    console.error(`[Telegram] sendPhoto error:`, err.message);
    return null;
  }
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

async function sendVideoToTelegramDirect(chatId, videoBase64, panelIndex, panelName, caption) {
  const botToken = getBotToken();
  if (!botToken) return false;

  const pName = panelName || `Panel ${panelIndex || 1}`;

  try {
    console.log(`[Telegram] Resizing ${pName} before sending...`);
    const resizedBase64 = await processVideoBase64(videoBase64, {
      cropPercent: 0.04,
      aspectRatio: '9:16',
    });

    console.log(`[Telegram] Sending status update to chat ${chatId}...`);
    await sendTelegramMessage(chatId, `${pName} đã resize xong. Đang gửi video về Telegram...`);

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

async function sendMergedVideoToTelegram(chatId, videoPathOrBase64, caption) {
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

module.exports = {
  sendTelegramMessage,
  deleteTelegramMessage,
  sendPhotoToTelegram,
  sendMediaGroupToTelegram,
  sendOrUpdateLivePanel,
  sendVideoToTelegramDirect,
  sendMergedVideoToTelegram,
};
