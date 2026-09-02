const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Allow local proxy/TLS certificates
const telegramAgent = new https.Agent({ rejectUnauthorized: false });
const tgHttp = axios.create({
  httpsAgent: telegramAgent,
  proxy: false,
});

const { runStoryboardFullFlow } = require('./storyboard-fullflow');
const { sendVideoToTelegramDirect } = require('./telegram-send');
const { handleDailyVlogCommand, handleDailyVlogPhoto, isWaitingForDailyVlogPhoto } = require('./dailyvlog-flow');
const { flowQueue } = require('./flow-queue');
const { generationJobService } = require('./generation-job');
const { extractProductAssetsFromHtml } = require('./product-assets');
const { handleAutoT3Command, startAutoT3Scheduler } = require('./auto-t3-scheduler');
const { autoT4Scheduler, autoT5Scheduler } = require('./auto-scheduler');
const { getChannelForChat } = require('../utils/config-manager');

// Chat-specific batch data accumulator (for the normal photo flow)
const botBatches = new Map();
const pendingTemplateByChat = new Map();
const lastRunByChat = new Map();
const BATCH_WINDOW_MS = 5000;
let isPolling = false;
let pollingOffset = 0;

const RESERVED_COMMANDS = new Set(['start', 'upload', 'dailyvlog', 'auto_t3', 'auto_t4', 'auto_t5', 'chatid', 'channel', 'template1', 'template2', 'template3', 'template4', 'template5', 'template5_1', 'template51', 'template5_2', 'template52', 'template6', 'status', 'remake', 'remake_1', 'remake_2', 'remake_3', 'remake_4', 'again', 'redo']);

function classifyTelegramCommand(text = '') {
  const value = String(text || '').trim();
  if (/^\/upload(?:@\w+)?(?:\s|$)/i.test(value)) return 'upload';
  if (/^\/remake(?:[_@\s]|$)/i.test(value)) return 'remake';
  if (/^\/(template[0-9_]+)(?:@\w+)?(?:\s|$)/i.test(value)) return 'template';
  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(value)) return 'start';
  if (/^\/status(?:@\w+)?(?:\s|$)/i.test(value)) return 'status';
  if (/^\/dailyvlog(?:@\w+)?(?:\s|$)/i.test(value)) return 'dailyvlog';
  if (/^\/auto_t3(?:@\w+)?(?:\s|$)/i.test(value)) return 'auto_t3';

  const folderMatch = value.match(/^\/([a-zA-Z][a-zA-Z0-9_]{0,31})(?:@\S+)?$/);
  if (!folderMatch) return null;

  const commandName = folderMatch[1].toLowerCase();
  if (RESERVED_COMMANDS.has(commandName)) return 'reserved';
  if (commandName === 'upload' || commandName.startsWith('upload_')) return 'reserved';
  return 'folder';
}

/**
 * Sends a text message to a specific Telegram Chat ID
 */
async function sendTelegramMessage(botToken, chatId, text, options = {}) {
  try {
    await tgHttp.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: text,
      ...(options.parse_mode ? { parse_mode: options.parse_mode } : {}),
      ...(options.reply_to_message_id ? { reply_to_message_id: options.reply_to_message_id } : {}),
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
  const fileInfoRes = await tgHttp.get(`https://api.telegram.org/bot${botToken}/getFile`, {
    params: { file_id: fileId }
  });

  if (!fileInfoRes.data || !fileInfoRes.data.ok) {
    throw new Error(`Telegram getFile API failed: ${JSON.stringify(fileInfoRes.data)}`);
  }

  const filePath = fileInfoRes.data.result.file_path;
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

  // 2. Download the binary file data
  const downloadRes = await tgHttp.get(downloadUrl, { responseType: 'arraybuffer' });
  return Buffer.from(downloadRes.data);
}

function buildTemplateReadyMessage(templateName, description) {
  return `✅ Đã bật ${templateName}. Hãy gửi shortlink TikTok Shop (https://vt.tiktok.com/...) để tạo video.\n\n📝 ${description}`;
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
  await sendTelegramMessage(botToken, chatId, buildTemplateReadyMessage('/template1', 'Review faceless 2 cảnh, không voice-over.'));
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
  await sendTelegramMessage(botToken, chatId, buildTemplateReadyMessage('/template2', 'Review 8 cảnh, mỗi cảnh 4s, không voice-over.'));
}

async function handleTemplate3Command(botToken, chatId) {
  const activeBatch = botBatches.get(chatId);
  if (activeBatch) {
    activeBatch.template = 'template3';
    await sendTelegramMessage(botToken, chatId,
      '✅ Đã áp dụng /template3 cho album ảnh đang gom: 3 cảnh shop — top-down 8s, góc hông 4s, đứng thử giày 8s.');
    return;
  }

  pendingTemplateByChat.set(chatId, 'template3');
  await sendTelegramMessage(botToken, chatId, buildTemplateReadyMessage('/template3', '3 cảnh shop — top-down 8s, góc hông 4s, đứng thử giày 8s.'));
}

async function handleTemplate4Command(botToken, chatId) {
  const activeBatch = botBatches.get(chatId);
  if (activeBatch) {
    activeBatch.template = 'template4';
    await sendTelegramMessage(botToken, chatId,
      '✅ Đã áp dụng /template4 cho album ảnh đang gom: review giày/dép nữ 4 cảnh boutique pastel — cận cảnh 8s, POV váy 6s, góc nệm 4s, đứng thử dáng 8s.');
    return;
  }

  pendingTemplateByChat.set(chatId, 'template4');
  await sendTelegramMessage(botToken, chatId, buildTemplateReadyMessage('/template4', 'Review giày/dép nữ 4 cảnh boutique pastel — cận cảnh 8s, POV váy 6s, góc nệm 4s, đứng thử dáng 8s.'));
}

async function handleTemplate5Command(botToken, chatId) {
  const activeBatch = botBatches.get(chatId);
  if (activeBatch) {
    activeBatch.template = 'template5';
    await sendTelegramMessage(botToken, chatId,
      '✅ Đã áp dụng /template5 cho album ảnh đang gom: review đa ngành hàng 4 cảnh 6s tự động phân tích (có chữ tiếng Việt, không tiếng review).');
    return;
  }

  pendingTemplateByChat.set(chatId, 'template5');
  await sendTelegramMessage(botToken, chatId, buildTemplateReadyMessage('/template5', 'Review đa ngành hàng 4 cảnh 6s tự động phân tích (có chữ tiếng Việt trên panel).'));
}

async function handleTemplate5_1Command(botToken, chatId) {
  const activeBatch = botBatches.get(chatId);
  if (activeBatch) {
    activeBatch.template = 'template5_1';
    await sendTelegramMessage(botToken, chatId,
      '✅ Đã áp dụng /template5_1 cho album ảnh đang gom: review đa ngành hàng 4 cảnh 6s (KHÔNG CHỮ / No Text, không tiếng review).');
    return;
  }

  pendingTemplateByChat.set(chatId, 'template5_1');
  await sendTelegramMessage(botToken, chatId, buildTemplateReadyMessage('/template5_1', 'Review đa ngành hàng 4 cảnh 6s (KHÔNG CHỮ, không tiếng review).'));
}

async function handleTemplate5_2Command(botToken, chatId) {
  const activeBatch = botBatches.get(chatId);
  if (activeBatch) {
    activeBatch.template = 'template5_2';
    await sendTelegramMessage(botToken, chatId,
      '✅ Đã áp dụng /template5_2 cho album ảnh đang gom: review đa ngành hàng 4 cảnh 6s (KHÔNG CHỮ + CÓ VOICE REVIEW faceless).');
    return;
  }

  pendingTemplateByChat.set(chatId, 'template5_2');
  await sendTelegramMessage(botToken, chatId, buildTemplateReadyMessage('/template5_2', 'Review đa ngành hàng 4 cảnh 6s (KHÔNG CHỮ + CÓ VOICE REVIEW nam/nữ, faceless 100%).'));
}

async function handleTemplate6Command(botToken, chatId) {
  const activeBatch = botBatches.get(chatId);
  if (activeBatch) {
    activeBatch.template = 'template6';
    await sendTelegramMessage(botToken, chatId,
      '✅ Đã áp dụng /template6 cho album ảnh đang gom: review siêu thị POV 2 cảnh 8s (Bách Hóa Xanh / WinMart, không chữ, không tiếng).');
    return;
  }

  pendingTemplateByChat.set(chatId, 'template6');
  await sendTelegramMessage(botToken, chatId, buildTemplateReadyMessage('/template6', 'Review siêu thị POV 2 cảnh 8s (Bách Hóa Xanh / WinMart ngẫu nhiên, không chữ, không tiếng).'));
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
      panelCount: 3,
    };
  }
  if (template === 'template4') {
    return {
      template: 'template4',
      panelCount: 4,
    };
  }
  if (template === 'template5') {
    return {
      template: 'template5',
      panelCount: 4,
    };
  }
  if (template === 'template5_1' || template === 'template5.1' || template === 'template51') {
    return {
      template: 'template5_1',
      panelCount: 4,
      noText: true,
    };
  }
  if (template === 'template5_2' || template === 'template5.2' || template === 'template52') {
    return {
      template: 'template5_2',
      panelCount: 4,
      noText: true,
      hasVoice: true,
    };
  }
  if (template === 'template6' || template === 'template_6') {
    return {
      template: 'template6',
      panelCount: 2,
      noText: true,
    };
  }
  return {};
}

function getLatestRunDirectory(baseDir) {
  const runsDir = path.join(baseDir, 'storyboard-review-runs');
  if (!fs.existsSync(runsDir)) return null;
  const entries = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({
      name: d.name,
      path: path.join(runsDir, d.name),
      mtime: fs.statSync(path.join(runsDir, d.name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return entries.length > 0 ? entries[0].path : null;
}

function getLastRunForChat(chatId, baseDir) {
  const mem = lastRunByChat.get(String(chatId));
  if (mem && mem.panelsDir && fs.existsSync(mem.panelsDir)) {
    return mem;
  }

  const latestDir = getLatestRunDirectory(baseDir);
  if (latestDir) {
    const panelsDir = path.join(latestDir, 'panels');
    const videosDir = path.join(latestDir, 'videos');
    if (fs.existsSync(panelsDir)) {
      return {
        runDir: latestDir,
        panelsDir,
        videosDir,
      };
    }
  }
  return null;
}

async function handleRemakeCommand(botToken, chatId, text, baseDir) {
  const rawArgs = text.replace(/^\/(?:remake|again|redo)(?:@\S+)?/i, '').trim();

  const match = rawArgs.match(/^((?:\d+[\s,]*)+)(.*)$/s);
  let numbers = [];
  let customInstruction = '';

  if (match) {
    numbers = (match[1].match(/\d+/g) || []).map(Number);
    customInstruction = (match[2] || '').trim();
  } else {
    numbers = (rawArgs.match(/\d+/g) || []).map(Number);
    customInstruction = rawArgs.replace(/\d+/g, '').replace(/cảnh/gi, '').trim();
  }

  if (numbers.length === 0) {
    await sendTelegramMessage(botToken, chatId,
      '💡 Cú pháp dùng lệnh /remake để tạo lại video:\n' +
      '• /remake 1 — Tạo lại video cảnh 1 (sử dụng prompt chuẩn)\n' +
      '• /remake 2 tạo lại cảnh khác cho panel — Tạo lại cảnh 2 với yêu cầu tùy chỉnh ưu tiên\n' +
      '• /remake 2 4 — Tạo lại nhiều video cùng lúc (VD: cảnh 2 và 4)\n' +
      '• /remake 3 xoay nhẹ góc 45 độ — Tùy biến góc máy / hành động theo ý muốn'
    );
    return;
  }

  const runInfo = getLastRunForChat(chatId, baseDir);
  if (!runInfo || !runInfo.panelsDir || !fs.existsSync(runInfo.panelsDir)) {
    await sendTelegramMessage(botToken, chatId,
      '⚠️ Chưa có dữ liệu video nào được tạo trước đó để chạy lại. Hãy gửi ảnh hoặc dùng lệnh folder để tạo mới trước nhé!');
    return;
  }

  const template = runInfo.template || (
    runInfo.runDir && runInfo.runDir.includes('template6') ? 'template6' :
    runInfo.runDir && (runInfo.runDir.includes('template5_2') || runInfo.runDir.includes('template5.2')) ? 'template5_2' :
    runInfo.runDir && (runInfo.runDir.includes('template5_1') || runInfo.runDir.includes('template5.1')) ? 'template5_1' :
    runInfo.runDir && runInfo.runDir.includes('template5') ? 'template5' :
    runInfo.runDir && runInfo.runDir.includes('template4') ? 'template4' : 'template3'
  );
  let panelPrompts = [];
  if (template === 'template6' || template === 'template_6') {
    const { getTemplate6VideoPrompts } = require('./template6-storyboard');
    panelPrompts = getTemplate6VideoPrompts(runInfo.analysis, {
      template: 'template6',
      customInstruction,
    });
  } else if (template === 'template5' || template === 'template5_1' || template === 'template5.1' || template === 'template51' ||
      template === 'template5_2' || template === 'template5.2' || template === 'template52') {
    const { getTemplate5VideoPrompts } = require('./template5-storyboard');
    panelPrompts = getTemplate5VideoPrompts(runInfo.analysis, {
      template,
      noText: template.includes('5_1') || template.includes('5.1') || template.includes('51') || template.includes('5_2') || template.includes('5.2') || template.includes('52'),
      hasVoice: template.includes('5_2') || template.includes('5.2') || template.includes('52'),
    });
  } else {
    const { getPanelPrompts } = require('./google-flow-storyboard');
    panelPrompts = getPanelPrompts(template);
  }
  const { generateVideosFromPanelsDirect } = require('./gemini-webapi-storyboard');
  const validPanels = [];
  const invalidIndices = [];

  for (const idx of numbers) {
    const pPath = path.join(runInfo.panelsDir, `panel-${idx}.png`);
    if (fs.existsSync(pPath)) {
      const buf = fs.readFileSync(pPath);
      let prompt = panelPrompts[idx - 1] || `Tạo video review sản phẩm faceless cảnh ${idx}`;

      if (customInstruction) {
        if (template === 'template6' || template === 'template_6') {
          const prodName = runInfo.analysis?.productName || 'sản phẩm';
          prompt = `Tạo video review ${prodName} siêu thị góc nhìn thứ nhất (POV) dài đúng 8 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. YÊU CẦU ƯU TIÊN HÀNG ĐẦU: ${customInstruction}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). VISUAL VÀ CHUYỂN ĐỘNG: Thực hiện ưu tiên chính xác theo yêu cầu: ${customInstruction}. Cảnh quay chân thực tự nhiên 100% như quay bằng iPhone 15 Pro ngoài đời thực. Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`;
        } else if (template === 'template5_2' || template === 'template5.2' || template === 'template52') {
          const prodName = runInfo.analysis?.productName || 'sản phẩm';
          const isMale = runInfo.analysis?.voicePersona?.gender === 'nam' || runInfo.analysis?.category === 'gadgets';
          const voiceDesc = runInfo.analysis?.voicePersona?.voiceDescription || (isMale ? 'nam miền Nam trầm ấm' : 'nữ miền Nam ngọt ngào');
          const vo = runInfo.analysis?.script?.[idx - 1]?.voiceOver;
          const voiceClause = vo ? ` Giọng đọc review: ${voiceDesc}. Lời thoại nhân vật: "${vo}".` : ` Giọng đọc review: ${voiceDesc}.`;
          prompt = `Tạo video review ${prodName} faceless dài đúng 6 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. YÊU CẦU ƯU TIÊN HÀNG ĐẦU: ${customInstruction}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI.${voiceClause} VISUAL VÀ CHUYỂN ĐỘNG: Thực hiện ưu tiên chính xác theo yêu cầu: ${customInstruction}. Cảnh quay chân thực tự nhiên 100% như quay thực tế, không hiệu ứng ảo CGI.`;
        } else if (template === 'template5' || template === 'template5_1' || template === 'template5.1' || template === 'template51') {
          const prodName = runInfo.analysis?.productName || 'sản phẩm';
          prompt = `Tạo video review ${prodName} faceless dài đúng 6 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. YÊU CẦU ƯU TIÊN HÀNG ĐẦU: ${customInstruction}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). VISUAL VÀ CHUYỂN ĐỘNG: Thực hiện ưu tiên chính xác theo yêu cầu: ${customInstruction}. Cảnh quay chân thực tự nhiên 100% như quay thực tế, không hiệu ứng ảo CGI. Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`;
        } else {
          prompt = `Tạo video review giày dép faceless dài đúng 6 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. YÊU CẦU ƯU TIÊN HÀNG ĐẦU: ${customInstruction}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC: Giữ nguyên người mẫu, trang phục, sản phẩm, không gian cửa hàng và ánh sáng. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). Thực hiện chính xác góc máy và chuyển động: ${customInstruction}. Cảnh quay chân thực tự nhiên 100% như quay thực tế. Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`;
        }
      }

      validPanels.push({
        index: idx,
        panelIndex: idx,
        imagePath: pPath,
        buffer: buf,
        prompt: prompt,
        videoModelKey: template === 'template6' ? '8s' : (template === 'template2' ? '4s' : (template === 'template3' ? ((idx === 1 || idx === 3) ? '8s' : '4s') : (template === 'template4' ? ((idx === 1 || idx === 4) ? '8s' : (idx === 2 ? '6s' : '4s')) : '6s'))),
      });
    } else {
      invalidIndices.push(idx);
    }
  }

  if (validPanels.length === 0) {
    await sendTelegramMessage(botToken, chatId,
      `⚠️ Không tìm thấy ảnh panel cho cảnh: ${numbers.join(', ')}. Hãy kiểm tra lại số cảnh!`);
    return;
  }

  const customInfo = customInstruction ? `\n🎯 Yêu cầu tùy biến: "${customInstruction}"` : '';
  await sendTelegramMessage(botToken, chatId,
    `🔄 Đang tạo lại ${validPanels.length} video cho cảnh ${validPanels.map(p => p.index).join(', ')}...${customInfo}`);

  const startTime = Date.now();

  flowQueue.enqueue({
    chatId: String(chatId),
    photos: [],
    baseDir,
    templateOptions: buildTemplateOptions(template),
    label: `Remake cảnh ${validPanels.map(p => p.index).join(', ')}`,
    execute: async () => {
      const videos = await generateVideosFromPanelsDirect(baseDir, validPanels, {
        aspectRatio: '9:16',
        includeVideoBase64: true,
      });

      let successCount = 0;
      const failedPanels = [];

      if (!videos || !Array.isArray(videos) || videos.length === 0) {
        const errMsg = 'Server không trả về kết quả video nào.';
        console.error(`[Telegram Bot] /remake no videos returned for chat ${chatId}`);
        await sendTelegramMessage(botToken, chatId,
          `❌ Tạo lại video thất bại: ${errMsg}\n👉 Bạn vui lòng thử lại bằng lệnh: /remake ${validPanels.map(p => p.index).join(' ')}`);
        return { successCount: 0, failedPanels: validPanels.map(p => ({ panelIndex: p.index, error: errMsg })), videos: [] };
      }

      for (const v of videos) {
        const pIdx = v?.panelIndex || '?';
        if (!v || v.error) {
          const errDetail = v?.error || 'Lỗi không xác định khi tạo video';
          console.error(`[Telegram Bot] /remake video error for panel ${pIdx}:`, errDetail);
          failedPanels.push({ panelIndex: pIdx, error: errDetail });
          await sendTelegramMessage(botToken, chatId,
            `❌ Lỗi tạo lại video cảnh ${pIdx}: ${errDetail}\n👉 Bạn có thể thử lại ngay bằng lệnh: /remake ${pIdx}`);
          continue;
        }

        const base64 = v.video?.base64 || (v.videoPath && fs.existsSync(v.videoPath) ? fs.readFileSync(v.videoPath).toString('base64') : null);
        if (!base64) {
          const errDetail = 'Thiếu dữ liệu video đầu ra (base64 rỗng)';
          console.error(`[Telegram Bot] /remake video missing base64 for panel ${pIdx}`);
          failedPanels.push({ panelIndex: pIdx, error: errDetail });
          await sendTelegramMessage(botToken, chatId,
            `❌ Lỗi video cảnh ${pIdx}: ${errDetail}\n👉 Bạn có thể thử lại bằng lệnh: /remake ${pIdx}`);
          continue;
        }

        // Copy video into run's videosDir
        const targetVideosDir = runInfo.videosDir || path.join(runInfo.runDir, 'videos');
        if (!fs.existsSync(targetVideosDir)) fs.mkdirSync(targetVideosDir, { recursive: true });
        const targetVideoPath = path.join(targetVideosDir, `panel-${v.panelIndex}.mp4`);
        if (v.videoPath && fs.existsSync(v.videoPath)) {
          try { fs.copyFileSync(v.videoPath, targetVideoPath); } catch (_) {}
        }

        const caption = `🎬 Video Cảnh ${v.panelIndex} (Tạo lại / Remake)\n` +
          `• Template: ${template}\n` +
          `• Thời lượng: ${validPanels.find(p => p.index === v.panelIndex)?.videoModelKey || '6s'}\n` +
          (customInstruction ? `• Tùy biến: ${customInstruction}\n` : '');

        const ok = await sendVideoToTelegramDirect(chatId, base64, v.panelIndex, `Panel ${v.panelIndex}`, caption);
        if (ok) {
          successCount++;
        } else {
          failedPanels.push({ panelIndex: v.panelIndex, error: 'Gửi video qua Telegram thất bại' });
          await sendTelegramMessage(botToken, chatId,
            `❌ Gửi video cảnh ${v.panelIndex} qua Telegram thất bại.\n👉 Bạn có thể thử lại bằng lệnh: /remake ${v.panelIndex}`);
        }
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (successCount > 0 && failedPanels.length === 0) {
        await sendTelegramMessage(botToken, chatId,
          `✅ Đã tạo lại xong ${successCount} video (${elapsed}s)! Bạn có thể gõ tiếp /remake [số_cảnh] bất cứ lúc nào nếu muốn đổi lại video khác.`);
      } else if (successCount > 0 && failedPanels.length > 0) {
        await sendTelegramMessage(botToken, chatId,
          `⚠️ Đã hoàn thành ${successCount} video, nhưng có ${failedPanels.length} cảnh bị lỗi (${elapsed}s).\n👉 Gõ /remake ${failedPanels.map(f => f.panelIndex).join(' ')} để tạo lại các cảnh lỗi.`);
      } else {
        await sendTelegramMessage(botToken, chatId,
          `❌ Tất cả ${validPanels.length} cảnh remake đều thất bại (${elapsed}s).\n👉 Bạn hãy thử remake lại: /remake ${validPanels.map(p => p.index).join(' ')}`);
      }
      return { successCount, failedPanels, videos };
    },
  }).catch(err => {
    console.error(`[Telegram Bot] /remake unhandled error for chat ${chatId}:`, err.message);
    sendTelegramMessage(botToken, chatId,
      `❌ Lỗi xử lý /remake cảnh ${validPanels.map(p => p.index).join(', ')}: ${err.message}\n👉 Vui lòng thử lại: /remake ${validPanels.map(p => p.index).join(' ')}`).catch(() => {});
  });
}

async function forwardToN8nWebhook(payload) {
  const n8nBaseUrl = process.env.N8N_WEBHOOK_BASE_URL || 'http://localhost:5678';
  const testUrl = `${n8nBaseUrl}/webhook-test/tiktok-task`;
  const prodUrl = `${n8nBaseUrl}/webhook/tiktok-task`;

  // 1. Try test webhook first (if user is debugging in n8n Editor)
  try {
    const res = await tgHttp.post(testUrl, payload, { timeout: 3000 });
    if (res.status === 200) {
      console.log('[Telegram Bot] 🚀 Forwarded event to n8n TEST webhook successfully.');
      return true;
    }
  } catch (_) {}

  // 2. Try production webhook
  try {
    const res = await tgHttp.post(prodUrl, payload, { timeout: 3000 });
    if (res.status === 200) {
      console.log('[Telegram Bot] 🚀 Forwarded event to n8n PRODUCTION webhook successfully.');
      return true;
    }
  } catch (_) {}

  return false;
}

async function handleTikTokDirectFlow(botToken, chatId, messageId, shortlink, template = process.env.DEFAULT_STORYBOARD_TEMPLATE || 'template3') {
  try {
    await sendTelegramMessage(botToken, chatId, `🔍 Đang tải thông tin sản phẩm từ link TikTok Shop...`);
    const resp = await tgHttp.get(shortlink, {
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const productUrl = resp.request?.res?.responseUrl || shortlink;
    const assets = extractProductAssetsFromHtml(resp.data, productUrl);
    if (!assets.title && assets.productImages.length === 0) {
      await sendTelegramMessage(botToken, chatId, `⚠️ Không thể lấy thông tin sản phẩm hoặc ảnh từ link này.`);
      return;
    }

    const enqueueResult = generationJobService.enqueueJob({
      chatId: String(chatId),
      sourceMessageId: messageId,
      shortlink,
      productUrl,
      template,
      productId: assets.productId,
      productTitle: assets.title,
      productDescription: assets.productDescription,
      productImages: assets.productImages.slice(0, 8),
    });
    const job = enqueueResult.job || enqueueResult;

    await sendTelegramMessage(botToken, chatId, `✅ Đã tiếp nhận sản phẩm [${assets.title || 'TikTok Shop'}]. Đang khởi tạo pipeline tạo video (Job ID: ${job.jobId})...`);

    const checkInterval = setInterval(async () => {
      const current = generationJobService.getJob(job.jobId);
      if (!current) {
        clearInterval(checkInterval);
        return;
      }
      if (current.status === 'completed') {
        clearInterval(checkInterval);
        await sendTelegramMessage(botToken, chatId, `🎬 Video review hoàn chỉnh đã xong!\n\n🛒 Tên: ${current.product?.title}\n💬 Caption: ${current.caption}\n\n👉 Gõ /upload để đăng lên TikTok.`);
      } else if (current.status === 'failed') {
        clearInterval(checkInterval);
        await sendTelegramMessage(botToken, chatId, `⚠️ Quá trình tạo video thất bại: ${current.error?.message || 'Lỗi không xác định'}`);
      }
    }, 5000);
  } catch (err) {
    console.error('[Telegram Bot] Direct TikTok flow error:', err.message);
    await sendTelegramMessage(botToken, chatId, `⚠️ Lỗi xử lý link: ${err.message}`);
  }
}

async function handleUploadDirectCommand(botToken, chatId, targetJobId) {
  const job = targetJobId ? generationJobService.getJob(targetJobId) : generationJobService.getLatestCompletedJob(String(chatId));
  if (!job || job.status !== 'completed') {
    await sendTelegramMessage(botToken, chatId, '⚠️ Không tìm thấy video đã hoàn tất gần đây của bạn. Vui lòng gửi link TikTok Shop để tạo video trước.');
    return;
  }
  if (job.upload?.status === 'published') {
    await sendTelegramMessage(botToken, chatId, `ℹ️ Video này đã được đăng thành công trước đó (Publish ID: ${job.upload?.publishId || 'OK'}). Bỏ qua.`);
    return;
  }
  await sendTelegramMessage(botToken, chatId, `🚀 Đang chuẩn bị ghép final video 9:16 và upload lên TikTok cho [${job.product?.title || 'Sản phẩm'}]...`);
  try {
    const { prepareUploadJob } = require('./generation-job');
    await prepareUploadJob(job.jobId);
  } catch (err) {
    console.error('[Telegram Bot] Direct upload error:', err.message);
    await sendTelegramMessage(botToken, chatId, `⚠️ Lỗi chuẩn bị upload: ${err.message}`);
  }
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

    // ── Check if message contains TikTok shortlink or /upload ──────────────────
    const urlMatch = text.match(/(https?:\/\/(?:vt\.tiktok\.com|www\.tiktok\.com|shop\.tiktok\.com)\/[^\s]+)/i);
    const commandKind = classifyTelegramCommand(text);
    const isUploadCmd = commandKind === 'upload';
    const isRemakeCmd = commandKind === 'remake';
    const templateCmdMatch = text.match(/^\/(template[0-9_]+)/i);

    if (isUploadCmd) {
      const targetJobId = text.split(/\s+/)[1] || null;
      const job = targetJobId
        ? generationJobService.getJob(targetJobId)
        : generationJobService.getLatestCompletedJob(String(chatId));

      if (!job || job.status !== 'completed') {
        await sendTelegramMessage(botToken, chatId, '⚠️ Đã nhận /upload nhưng chưa tìm thấy video đã hoàn tất gần đây. Vui lòng gửi shortlink TikTok Shop để tạo video trước.');
        return;
      }

      const signal = generationJobService.setJobCommand(chatId, {
        command: 'upload',
        targetJobId: targetJobId || job?.jobId || null,
        rawText: text,
      });

      if (signal.delivery === 'delivered') {
        await sendTelegramMessage(
          botToken,
          chatId,
          '✅ Đã nhận /upload. Workflow đang tiếp tục: ghép final video 9:16, kiểm tra giỏ hàng rồi upload TikTok.'
        );
        return;
      }

      // If no active execution was waiting, forward to n8n webhook to execute upload pipeline
      const uploadChannel = getChannelForChat(path.resolve(__dirname, '..'), chatId);
      const payload = {
        route: 'command',
        command: 'upload',
        text,
        chatId: String(chatId),
        messageId: message.message_id || null,
        targetJobId: targetJobId || job?.jobId || null,
        tiktokCredentialId: uploadChannel.tiktokCredentialId,
        tiktokCredentialName: uploadChannel.tiktokCredentialName,
        timestamp: Date.now()
      };

      const forwarded = await forwardToN8nWebhook(payload);
      if (!forwarded) {
        await sendTelegramMessage(
          botToken,
          chatId,
          '✅ Đã nhận /upload. Đang xử lý đăng video lên TikTok...'
        );
      }
      return;
    } else if (isRemakeCmd) {
      let numbers = [];
      let customInstruction = '';
      const underscoreMatch = text.match(/^\/remake_([0-9_]+)(?:@\w+)?(?:\s+(.*))?$/i);
      if (underscoreMatch) {
        numbers = underscoreMatch[1].split('_').map(d => parseInt(d, 10)).filter(n => !isNaN(n) && n > 0 && n <= 10);
        customInstruction = (underscoreMatch[2] || '').trim();
      } else {
        const parts = text.replace(/^\/remake(?:@\w+)?\s*/i, '').trim();
        const tokens = parts ? parts.split(/\s+/) : [];
        const remaining = [];
        for (const tok of tokens) {
          const n = parseInt(tok, 10);
          if (!isNaN(n) && n > 0 && n <= 10 && remaining.length === 0) {
            numbers.push(n);
          } else if (tok) {
            remaining.push(tok);
          }
        }
        customInstruction = remaining.join(' ').trim();
      }
      if (numbers.length === 0) numbers = [1];

      const latestJob = generationJobService.getLatestCompletedJob(String(chatId));
      if (latestJob) {
        const signal = generationJobService.setJobCommand(chatId, {
          command: 'remake',
          targetJobId: latestJob.jobId,
          panels: numbers,
          instruction: customInstruction,
          rawText: text,
        });

        if (signal.delivery === 'delivered') {
          await sendTelegramMessage(
            botToken,
            chatId,
            `✅ Đã nhận /remake${numbers.length ? ` cảnh ${numbers.join(', ')}` : ''}. Workflow đang tạo lại panel.`
          );
          return;
        }

        // ── Fallback: n8n không còn execution đang chờ → xử lý trực tiếp ──
        console.log(`[Telegram Bot] /remake: no active n8n execution waiting, falling back to direct handleRemakeCommand`);
        const remakeBaseDir = path.resolve(__dirname, '..');
        await handleRemakeCommand(botToken, chatId, text, remakeBaseDir);
        return;
      }
    } else if (templateCmdMatch) {
      const latestJob = generationJobService.getLatestCompletedJob(String(chatId));
      if (latestJob) {
        generationJobService.setJobCommand(chatId, {
          command: 'template',
          targetJobId: latestJob.jobId,
          template: templateCmdMatch[1],
          rawText: text,
        });
      }
    }

    if (commandKind === 'auto_t3') {
      console.log(`[Telegram Bot] Received /auto_t3 command from chat ${chatId}: ${text}`);
      const baseDir = path.resolve(__dirname, '..');
      await handleAutoT3Command(botToken, chatId, text, baseDir);
      return;
    }

    // ── /auto_t4 — Lady Shop, template4 ────────────────────────────────────
    if (/^\/auto_t4(?:@\S+)?(?:\s|$)/i.test(text)) {
      console.log(`[Telegram Bot] Received /auto_t4 command from chat ${chatId}: ${text}`);
      const baseDir = path.resolve(__dirname, '..');
      await autoT4Scheduler.handleCommand(botToken, chatId, text, baseDir);
      return;
    }

    // ── /auto_t5 — Gia dụng, template5_2 ────────────────────────────────
    if (/^\/auto_t5(?:@\S+)?(?:\s|$)/i.test(text)) {
      console.log(`[Telegram Bot] Received /auto_t5 command from chat ${chatId}: ${text}`);
      const baseDir = path.resolve(__dirname, '..');
      await autoT5Scheduler.handleCommand(botToken, chatId, text, baseDir);
      return;
    }

    // ── /chatid — Trả về Chat ID và kênh TikTok đang dùng ───────────────────
    if (/^\/chatid(?:@\S+)?(?:\s|$)/i.test(text) || /^\/channel(?:@\S+)?(?:\s|$)/i.test(text)) {
      const baseDir = path.resolve(__dirname, '..');
      const channel = getChannelForChat(baseDir, chatId);
      const chatType = message.chat.type || 'unknown';
      const chatTitle = message.chat.title || message.chat.first_name || '';
      await sendTelegramMessage(
        botToken,
        chatId,
        `🔑 <b>Chat ID:</b> <code>${chatId}</code>\n` +
        `📌 <b>Loại chat:</b> ${chatType}${chatTitle ? ` — ${chatTitle}` : ''}\n\n` +
        `🛍️ <b>Kênh TikTok đang dùng:</b>\n` +
        `• Tên: <b>${channel.label}</b>\n` +
        `• Credential ID: <code>${channel.tiktokCredentialId}</code>\n` +
        `• Credential Name: ${channel.tiktokCredentialName}\n\n` +
        `👉 Copy <code>${chatId}</code> vào <code>config.json → channels</code> để gán TikTok account cho chat này.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (urlMatch || isUploadCmd) {
      console.log(`[Telegram Bot] Received TikTok / Upload command from chat ${chatId}: ${text}`);
      let template = pendingTemplateByChat.get(chatId) || process.env.DEFAULT_STORYBOARD_TEMPLATE || 'template3';
      const templateMatch = text.match(/\/(template[0-9_]+)/i);
      if (templateMatch) template = templateMatch[1];

      const channel = getChannelForChat(path.resolve(__dirname, '..'), chatId);

      if (isUploadCmd) {
        // /upload → forward tới n8n (upload-only workflow)
        const payload = {
          route: 'upload',
          text,
          chatId: String(chatId),
          messageId: message.message_id || null,
          targetJobId: text.split(/\s+/)[1] || null,
          template,
          channelId: channel.channelId,
          tiktokCredentialId: channel.tiktokCredentialId,
          tiktokCredentialName: channel.tiktokCredentialName,
          timestamp: Date.now()
        };
        const forwarded = await forwardToN8nWebhook(payload);
        if (!forwarded) {
          await handleUploadDirectCommand(botToken, chatId, payload.targetJobId);
        }
      } else if (urlMatch) {
        // shortlink → xử lý trực tiếp tại server (n8n mới không handle generate)
        if (pendingTemplateByChat.has(chatId)) {
          pendingTemplateByChat.delete(chatId); // clear sau khi dùng
        }
        await handleTikTokDirectFlow(botToken, chatId, message.message_id, urlMatch[1], template);
      }
      return;
    }

    // /start
    if (text.startsWith('/start')) {
      await sendTelegramMessage(botToken, chatId,
        '👋 Xin chào! Hãy gửi link TikTok Shop hoặc gửi ảnh sản phẩm qua đây, tôi sẽ tự động phân tích và tạo video review thời trang/sản phẩm cho bạn.\n\n' +
        '👟 Dùng /template1 rồi gửi ảnh để tạo review faceless 2 cảnh, không voice-over.\n' +
        '🥿 Dùng /template2 rồi gửi ảnh để tạo review 8 cảnh, mỗi cảnh 4s, không voice-over.\n' +
        '🏬 Dùng /template3 rồi gửi link/ảnh để tạo review shop 3 cảnh (top-down 8s + góc hông 4s + đứng thử giày 8s), không voice-over.\n' +
        '👠 Dùng /template4 rồi gửi ảnh để tạo review giày/dép nữ shop pastel 4 cảnh (cận cảnh 8s, POV váy 6s, góc nệm 4s, đứng thử dáng 8s), không voice-over.\n' +
        '✨ Dùng /template5 rồi gửi ảnh để tạo review đa ngành hàng 4 cảnh 6s tự động phân tích (có chữ tiếng Việt trên panel, không tiếng review).\n' +
        '💎 Dùng /template5_1 rồi gửi ảnh để tạo review đa ngành hàng 4 cảnh 6s (KHÔNG CHỮ / No Text, không tiếng review).\n' +
        '🎙️ Dùng /template5_2 rồi gửi ảnh để tạo review đa ngành hàng 4 cảnh 6s (KHÔNG CHỮ + CÓ GIỌNG NÓI VOICE-OVER review, faceless 100%).\n' +
        '🔄 Dùng /remake [số_cảnh] [yêu cầu] (VD: /remake 2 hoặc /remake 2 xoay góc 45 độ) để tạo lại video với prompt tùy chỉnh.\n' +
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

    // ── Template 4 command ───────────────────────────────────────────────────
    if (text === '/template4' || text.startsWith('/template4@')) {
      console.log(`[Telegram Bot] Received /template4 command from chat ${chatId}`);
      await handleTemplate4Command(botToken, chatId);
      return;
    }

    // ── Template 5 command ───────────────────────────────────────────────────
    if (text === '/template5' || text.startsWith('/template5@')) {
      console.log(`[Telegram Bot] Received /template5 command from chat ${chatId}`);
      await handleTemplate5Command(botToken, chatId);
      return;
    }

    // ── Template 5.1 command (No Text) ───────────────────────────────────────
    if (text === '/template5_1' || text === '/template5.1' || text === '/template51' ||
        text.startsWith('/template5_1@') || text.startsWith('/template5.1@') || text.startsWith('/template51@')) {
      console.log(`[Telegram Bot] Received /template5_1 command from chat ${chatId}`);
      await handleTemplate5_1Command(botToken, chatId);
      return;
    }

    // ── Template 5.2 command (No Text + Voice) ───────────────────────────────
    if (text === '/template5_2' || text === '/template5.2' || text === '/template52' ||
        text.startsWith('/template5_2@') || text.startsWith('/template5.2@') || text.startsWith('/template52@')) {
      console.log(`[Telegram Bot] Received /template5_2 command from chat ${chatId}`);
      await handleTemplate5_2Command(botToken, chatId);
      return;
    }

    // ── Template 6 command (Supermarket POV) ──────────────────────────────────
    if (text === '/template6' || text === '/template_6' || text.startsWith('/template6@') || text.startsWith('/template_6@')) {
      console.log(`[Telegram Bot] Received /template6 command from chat ${chatId}`);
      await handleTemplate6Command(botToken, chatId);
      return;
    }

    // ── Remake / Again / Redo command ─────────────────────────────────────────
    if (text === '/remake' || text.startsWith('/remake ') || text.startsWith('/remake@') || /^\/remake\d+/i.test(text) ||
        text === '/again' || text.startsWith('/again ') || text.startsWith('/again@') || /^\/again\d+/i.test(text) ||
        text === '/redo' || text.startsWith('/redo ') || text.startsWith('/redo@') || /^\/redo\d+/i.test(text)) {
      console.log(`[Telegram Bot] Received remake command from chat ${chatId}: ${text}`);
      const baseDir = path.resolve(__dirname, '..');
      await handleRemakeCommand(botToken, chatId, text, baseDir);
      return;
    }

    // ── Daily Vlog command ────────────────────────────────────────────────────
    if (text === '/dailyvlog' || text.startsWith('/dailyvlog@')) {
      console.log(`[Telegram Bot] Received /dailyvlog command from chat ${chatId}`);
      await handleDailyVlogCommand(botToken, chatId);
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
        receiveMsg = '📥 Đã nhận được hình ảnh. Đang gom album cho /template3 shop 3 cảnh...';
      } else if (selectedTemplate === 'template4') {
        receiveMsg = '📥 Đã nhận được hình ảnh. Đang gom album cho /template4 giày/dép nữ shop pastel 4 cảnh...';
      } else if (selectedTemplate === 'template5') {
        receiveMsg = '📥 Đã nhận được hình ảnh. Đang gom album cho /template5 review đa ngành hàng 4 cảnh 6s (có chữ)...';
      } else if (selectedTemplate === 'template5_1' || selectedTemplate === 'template5.1' || selectedTemplate === 'template51') {
        receiveMsg = '📥 Đã nhận được hình ảnh. Đang gom album cho /template5_1 review đa ngành hàng 4 cảnh 6s (không chữ)...';
      } else if (selectedTemplate === 'template5_2' || selectedTemplate === 'template5.2' || selectedTemplate === 'template52') {
        receiveMsg = '📥 Đã nhận được hình ảnh. Đang gom album cho /template5_2 review đa ngành hàng 4 cảnh 6s (có voice review faceless)...';
      } else if (selectedTemplate === 'template6' || selectedTemplate === 'template_6') {
        receiveMsg = '📥 Đã nhận được hình ảnh. Đang gom album cho /template6 review siêu thị POV 2 cảnh 8s (không chữ, không tiếng)...';
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
        templateMessage = ' theo /template3 shop 3 cảnh (top-down 8s + góc hông 4s + đứng thử giày 8s)';
      } else if (batch.template === 'template4') {
        templateMessage = ' theo /template4 shop pastel nữ 4 cảnh (cận cảnh 8s + POV váy 6s + góc nệm 4s + đứng thử dáng 8s)';
      } else if (batch.template === 'template5') {
        templateMessage = ' theo /template5 đa ngành hàng 4 cảnh 6s (có chữ tiếng Việt, không tiếng review)';
      } else if (batch.template === 'template5_1' || batch.template === 'template5.1' || batch.template === 'template51') {
        templateMessage = ' theo /template5_1 đa ngành hàng 4 cảnh 6s (KHÔNG CHỮ, không tiếng review)';
      } else if (batch.template === 'template5_2' || batch.template === 'template5.2' || batch.template === 'template52') {
        templateMessage = ' theo /template5_2 đa ngành hàng 4 cảnh 6s (KHÔNG CHỮ + CÓ VOICE REVIEW faceless)';
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
          const res = await runStoryboardFullFlow(chatId, photosCopy, baseDir, { ...templateOptions, runId });
          if (res && res.reviewArchive?.root) {
            lastRunByChat.set(String(chatId), {
              runDir: res.reviewArchive.root,
              panelsDir: res.reviewArchive.panelsDir || path.join(res.reviewArchive.root, 'panels'),
              videosDir: path.join(res.reviewArchive.root, 'videos'),
              panels: res.panels,
              template: batch.template,
              analysis: res.analysis,
              baseDir,
            });
          }
          return res;
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

function buildTelegramCommands() {
  return [
    { command: 'start', description: '👋 Bắt đầu / Xem hướng dẫn' },
    { command: 'status', description: '📊 Xem trạng thái hàng đợi xử lý' },
    { command: 'template1', description: '👟 Review faceless 2 cảnh, không voice-over' },
    { command: 'template2', description: '🥿 Review 8 cảnh, mỗi cảnh 4s, không voice-over' },
    { command: 'template3', description: '🏬 Review shop 3 cảnh (8s, 4s, 8s), không voice-over' },
    { command: 'auto_t3', description: '🤖 Tự động chạy template3 theo lịch config' },
    { command: 'template4', description: '👠 Review giày/dép nữ shop pastel 4 cảnh (8s, 6s, 4s, 8s)' },
    { command: 'template5', description: '✨ Review đa ngành hàng 4 cảnh 6s (có chữ tiếng Việt)' },
    { command: 'template5_1', description: '💎 Review đa ngành hàng 4 cảnh 6s (KHÔNG CHỮ / No Text)' },
    { command: 'template5_2', description: '🎙️ Review đa ngành hàng 4 cảnh 6s (KHÔNG CHỮ + VOICE REVIEW faceless)' },
    { command: 'template6', description: '🛒 Review siêu thị POV 2 cảnh 8s (Bách Hóa Xanh/WinMart)' },
    { command: 'remake', description: '🔄 Tạo lại video cảnh chưa ưng ý (VD: /remake 2)' },
    { command: 'upload', description: '🚀 Đăng video review hoàn chỉnh lên TikTok' },
    { command: 'dailyvlog', description: '🎬 Tạo daily vlog lifestyle cho Nhi từ ảnh sản phẩm' },
  ];
}

/**
 * Register bot commands so Telegram shows command menu buttons.
 * Uses the setMyCommands API — called once on startup with retry.
 */
async function registerBotCommands(botToken, retryCount = 2) {
  const commands = buildTelegramCommands();

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      await tgHttp.post(`https://api.telegram.org/bot${botToken}/setMyCommands`, { commands }, {
        timeout: parseInt(process.env.TELEGRAM_COMMANDS_TIMEOUT_MS || '30000', 10)
      });
      return;
    } catch (err) {
      if (attempt < retryCount) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
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

  if (isPolling) return;

  // Register command menu buttons on startup (fire-and-forget)
  registerBotCommands(botToken);
  startAutoT3Scheduler(path.resolve(__dirname, '..'));

  isPolling = true;

  // Start polling asynchronously
  (async () => {
    while (isPolling) {
      try {
        const pollTimeoutSeconds = Math.max(
          5,
          parseInt(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS || '20', 10)
        );
        const requestTimeoutMs = Math.max(
          pollTimeoutSeconds * 1000 + 15000,
          parseInt(process.env.TELEGRAM_POLL_REQUEST_TIMEOUT_MS || '45000', 10)
        );
        const response = await tgHttp.get(`https://api.telegram.org/bot${botToken}/getUpdates`, {
          params: {
            offset: pollingOffset,
            timeout: pollTimeoutSeconds,
            allowed_updates: JSON.stringify(['message'])
          },
          timeout: requestTimeoutMs
        });

        const updates = response.data.result || [];
        if (updates.length > 0) {
          console.log(`[Telegram Bot] 📥 Nhận ${updates.length} update(s) mới từ Telegram...`);
        }
        for (const update of updates) {
          pollingOffset = update.update_id + 1;
          await handleUpdate(botToken, update);
        }

        // Small 1s cooldown between poll requests to prevent Telegram TCP overlap
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        const isConflict = error.response?.status === 409 || /409/i.test(error.message || '');
        const isTimeout = error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '');

        if (isTimeout) {
          // Normal timeout on long-polling — wait 1s before next cycle
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else if (isConflict) {
          // Wait 2s for previous session to terminate gracefully
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          console.error('[Telegram Bot] Polling error:', error.message);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
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
  stopTelegramBot,
  lastRunByChat,
  _test: {
    classifyTelegramCommand,
  },
};
