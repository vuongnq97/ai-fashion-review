const { getStoryboardProvider } = require('./storyboard-provider');
const { sendTelegramMessage, sendVideoToTelegramDirect } = require('./telegram-send');

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
  const productInfo = buildProductTelegramText(result.analysis);

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
    const caption = `${panelName} đã sẵn sàng.\n${productInfo.summary}`;
    const ok = await sendVideoToTelegramDirect(chatId, base64, video.panelIndex, panelName, caption);
    if (ok) sentCount++;
  }

  await sendTelegramMessage(chatId, `Hoàn tất full flow: đã gửi ${sentCount}/${videos.length} video.\n${productInfo.summary}`);
  return { ...result, sentCount, productInfo };
}

module.exports = {
  runStoryboardFullFlow,
};
