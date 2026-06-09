const { getStoryboardProvider } = require('./storyboard-provider');
const { sendTelegramMessage, sendVideoToTelegramDirect } = require('./telegram-send');

async function runStoryboardFullFlow(chatId, filePayloads, baseDir, options = {}) {
  if (!chatId) throw new Error('chatId is required');
  if (!filePayloads || filePayloads.length === 0) {
    throw new Error('At least one product image is required');
  }

  const provider = getStoryboardProvider(baseDir);
  console.log(`[FullFlow] Storyboard provider: ${provider.name}`);
  await sendTelegramMessage(chatId, `Đã nhận ${filePayloads.length} ảnh. Đang tạo storyboard bằng ${provider.name}...`);

  const result = await provider.generateStoryboard(baseDir, filePayloads, {
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

    const ok = await sendVideoToTelegramDirect(chatId, base64, video.panelIndex, `Panel ${video.panelIndex || sentCount + 1}`);
    if (ok) sentCount++;
  }

  await sendTelegramMessage(chatId, `Hoàn tất full flow: đã gửi ${sentCount}/${videos.length} video.`);
  return { ...result, sentCount };
}

module.exports = {
  runStoryboardFullFlow,
};
