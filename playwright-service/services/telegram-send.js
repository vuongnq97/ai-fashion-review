const { processVideoBase64 } = require('./video-resize');

async function sendTelegramMessage(chatId, text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.log('[Telegram] TELEGRAM_BOT_TOKEN is not configured in .env');
    return false;
  }

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return true;
}

async function sendVideoToTelegramDirect(chatId, videoBase64, panelIndex, panelName) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.log('[Telegram] TELEGRAM_BOT_TOKEN is not configured in .env');
    return false;
  }

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
    formData.append('caption', `${pName} đã sẵn sàng.`);

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendVideo`, {
      method: 'POST',
      body: formData,
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

module.exports = {
  sendTelegramMessage,
  sendVideoToTelegramDirect,
};
