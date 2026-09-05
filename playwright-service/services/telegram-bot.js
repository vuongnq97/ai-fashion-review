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
const { sendVideoToTelegramDirect, editTelegramMessage } = require('./telegram-send');
const { FlowStepTracker } = require('./flow-step-tracker');
const { handleDailyVlogCommand, handleDailyVlogPhoto, isWaitingForDailyVlogPhoto } = require('./dailyvlog-flow');
const { flowQueue } = require('./flow-queue');
const { generationJobService } = require('./generation-job');
const { extractProductAssetsFromHtml } = require('./product-assets');
const { autoT3Scheduler, autoT4Scheduler, autoT5Scheduler } = require('./auto-template-scheduler');
const { getChannelForChat } = require('../utils/config-manager');
const { normalizeTemplateName } = require('./template-options');

// Chat-specific batch data accumulator (for the normal photo flow)
const botBatches = new Map();
const pendingTemplateByChat = new Map();
const lastRunByChat = new Map();
const BATCH_WINDOW_MS = 5000;
let isPolling = false;
let pollingOffset = 0;

const RESERVED_COMMANDS = new Set([
  'start', 'help', 'menu', 'upload', 'dailyvlog',
  'auto_t3', 'auto_t3_run', 'auto_t3_off',
  'auto_t4', 'auto_t4_run', 'auto_t4_off',
  'auto_t5', 'auto_t5_run', 'auto_t5_off',
  'chatid', 'channel',
  'template1', 'template2', 'template3', 'template4',
  'template5', 'template5_1', 'template51', 'template5_2', 'template52',
  'template5_3', 'template53',
  'template6', 't1', 't2', 't3', 't4', 't5', 't6',
  't51', 't52', 't53', 't5_1', 't5_2', 't5_3',
  'status', 'remake', 'remake_1', 'remake_2', 'remake_3', 'remake_4',
  'again', 'redo'
]);

function classifyTelegramCommand(text = '') {
  const value = String(text || '').trim();
  if (/^\/upload(?:@\w+)?(?:\s|$)/i.test(value)) return 'upload';
  if (/^\/remake(?:[_@\s]|$)/i.test(value)) return 'remake';
  if (/^\/(?:template[0-9_.]+|t[0-9_.]+)(?:@\w+)?(?:\s|$)/i.test(value)) return 'template';
  if (/^\/(start|help|menu)(?:@\w+)?(?:\s|$)/i.test(value)) return 'start';
  if (/^\/status(?:@\w+)?(?:\s|$)/i.test(value)) return 'status';
  if (/^\/dailyvlog(?:@\w+)?(?:\s|$)/i.test(value)) return 'dailyvlog';
  const autoTemplateMatch = value.match(/^\/(auto_t[345])(?:_([a-z0-9]+))?(?:@\w+)?(?:\s|$)/i);
  if (autoTemplateMatch) return autoTemplateMatch[1].toLowerCase();

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
    const res = await tgHttp.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: text,
      ...(options.parse_mode ? { parse_mode: options.parse_mode } : {}),
      ...(options.reply_to_message_id ? { reply_to_message_id: options.reply_to_message_id } : {}),
    }, {
      timeout: parseInt(process.env.TELEGRAM_SEND_TIMEOUT_MS || '15000', 10)
    });
    return res.data?.result?.message_id || true;
  } catch (error) {
    console.error(`[Telegram Bot] Error sending message to ${chatId}:`, error.message);
    return null;
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
  return `✅ Đã bật ${templateName}. Hãy gửi shortlink TikTok Shop (https://vt.tiktok.com/...) để tạo video.\n\n`;
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
      '✅ Đã áp dụng /template5 cho album ảnh đang gom: review đa ngành hàng 4 cảnh (2 video 8s) tự động phân tích (có chữ tiếng Việt chuyển cảnh theo thời gian, không tiếng review).');
    return;
  }

  pendingTemplateByChat.set(chatId, 'template5');
  await sendTelegramMessage(botToken, chatId, buildTemplateReadyMessage('/template5', 'Review đa ngành hàng 4 cảnh (2 video 8s) tự động phân tích (có chữ tiếng Việt trên panel, không tiếng review).'));
}

async function handleTemplate5_1Command(botToken, chatId) {
  const activeBatch = botBatches.get(chatId);
  if (activeBatch) {
    activeBatch.template = 'template5_1';
    await sendTelegramMessage(botToken, chatId,
      '✅ Đã áp dụng /template5_1 cho album ảnh đang gom: review đa ngành hàng 4 cảnh (2 video 8s) (KHÔNG CHỮ / No Text, không tiếng review).');
    return;
  }

  pendingTemplateByChat.set(chatId, 'template5_1');
  await sendTelegramMessage(botToken, chatId, buildTemplateReadyMessage('/template5_1', 'Review đa ngành hàng 4 cảnh (2 video 8s) (KHÔNG CHỮ, không tiếng review).'));
}

async function handleTemplate5_2Command(botToken, chatId) {
  const activeBatch = botBatches.get(chatId);
  if (activeBatch) {
    activeBatch.template = 'template5_2';
    await sendTelegramMessage(botToken, chatId,
      '✅ Đã áp dụng /template5_2 cho album ảnh đang gom: review đa ngành hàng 4 cảnh (2 video 8s) (KHÔNG CHỮ + CÓ VOICE REVIEW faceless).');
    return;
  }

  pendingTemplateByChat.set(chatId, 'template5_2');
  await sendTelegramMessage(botToken, chatId, buildTemplateReadyMessage('/template5_2', 'Review đa ngành hàng 4 cảnh (2 video 8s) (KHÔNG CHỮ + CÓ VOICE REVIEW nam/nữ, faceless 100%).'));
}

async function handleTemplate5_3Command(botToken, chatId) {
  const activeBatch = botBatches.get(chatId);
  if (activeBatch) {
    activeBatch.template = 'template5_3';
    await sendTelegramMessage(botToken, chatId,
      '✅ Đã áp dụng /template5_3 cho album ảnh đang gom: review spam đa ngành hàng 4 cảnh (4 video 4s, model Veo) (KHÔNG CHỮ + CÓ VOICE REVIEW faceless, viền sạch).');
    return;
  }

  pendingTemplateByChat.set(chatId, 'template5_3');
  await sendTelegramMessage(botToken, chatId, buildTemplateReadyMessage('/template5_3', 'Review spam đa ngành hàng 4 cảnh (4 video 4s, model Veo) (KHÔNG CHỮ + CÓ VOICE REVIEW nam/nữ, faceless 100%, viền sạch).'));
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

// Import from shared module to keep single source of truth (also used by generation-job.js)
const { buildTemplateOptions } = require('./template-options');

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
  const rawArgs = text.replace(/^\/(?:remake|again|redo)(?:@\S+)?/i, '').replace(/^_+/, ' ').trim();

  const match = rawArgs.match(/^((?:\d+[\s,]*)+)(.*)$/s);
  let numbers = [];
  let customInstruction = '';

  if (match) {
    numbers = (match[1].match(/\d+/g) || []).map(Number);
    customInstruction = (match[2] || '').replace(/^_+/, '').trim();
  } else {
    numbers = (rawArgs.match(/\d+/g) || []).map(Number);
    customInstruction = rawArgs.replace(/\d+/g, '').replace(/cảnh/gi, '').replace(/^_+/, '').trim();
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
    runInfo.runDir && (runInfo.runDir.includes('template5_3') || runInfo.runDir.includes('template5.3') || runInfo.runDir.includes('template53')) ? 'template5_3' :
      runInfo.runDir && runInfo.runDir.includes('template6') ? 'template6' :
        runInfo.runDir && (runInfo.runDir.includes('template5_2') || runInfo.runDir.includes('template5.2')) ? 'template5_2' :
          runInfo.runDir && (runInfo.runDir.includes('template5_1') || runInfo.runDir.includes('template5.1')) ? 'template5_1' :
            runInfo.runDir && runInfo.runDir.includes('template5') ? 'template5' :
              runInfo.runDir && runInfo.runDir.includes('template4') ? 'template4' : 'template3'
  );
  let panelPrompts = [];
  if (template === 'template5_3' || template === 'template5.3' || template === 'template53') {
    const { getTemplate5_3VideoPrompts } = require('./template5-storyboard');
    panelPrompts = getTemplate5_3VideoPrompts(runInfo.analysis, {
      template: 'template5_3',
      customInstruction,
    });
  } else if (template === 'template6' || template === 'template_6') {
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
        if (template === 'template5_3' || template === 'template5.3' || template === 'template53') {
          const prodName = runInfo.analysis?.productName || 'sản phẩm';
          const isMale = runInfo.analysis?.voicePersona?.gender === 'nam' || runInfo.analysis?.category === 'gadgets';
          const voiceDesc = runInfo.analysis?.voicePersona?.voiceDescription || (isMale ? 'nam miền Nam trầm ấm' : 'nữ miền Nam ngọt ngào');
          const { clampScriptWords } = require('./template5-storyboard');
          const scriptItem = runInfo.analysis?.script?.[idx - 1];
          const vo = scriptItem?.voiceOver ? clampScriptWords(scriptItem.voiceOver, 21) : '';
          const voiceClause = vo ? ` Giọng đọc review: ${voiceDesc}, tốc độ đọc nhanh liên tục dồn dập không ngừng nghỉ. Lời thoại nhân vật đọc liên tục trong 4 giây: "${vo}".` : ` Giọng đọc review: ${voiceDesc}.`;
          prompt = `Tạo video review ${prodName} faceless dài đúng 4 giây từ hình ảnh Cảnh ${idx} đã cung cấp. YÊU CẦU ƯU TIÊN HÀNG ĐẦU: ${customInstruction}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI.${voiceClause} VISUAL VÀ CHUYỂN ĐỘNG: Thực hiện ưu tiên chính xác theo yêu cầu: ${customInstruction}. Cảnh quay chân thực tự nhiên 100% như quay thực tế, không hiệu ứng ảo CGI.`;
        } else if (template === 'template6' || template === 'template_6') {
          const prodName = runInfo.analysis?.productName || 'sản phẩm';
          prompt = `Tạo video review ${prodName} siêu thị góc nhìn thứ nhất (POV) dài đúng 8 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. YÊU CẦU ƯU TIÊN HÀNG ĐẦU: ${customInstruction}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). VISUAL VÀ CHUYỂN ĐỘNG: Thực hiện ưu tiên chính xác theo yêu cầu: ${customInstruction}. Cảnh quay chân thực tự nhiên 100% như quay bằng iPhone 15 Pro ngoài đời thực. Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`;
        } else if (template === 'template5_2' || template === 'template5.2' || template === 'template52') {
          const prodName = runInfo.analysis?.productName || 'sản phẩm';
          const isMale = runInfo.analysis?.voicePersona?.gender === 'nam' || runInfo.analysis?.category === 'gadgets';
          const voiceDesc = runInfo.analysis?.voicePersona?.voiceDescription || (isMale ? 'nam miền Nam trầm ấm' : 'nữ miền Nam ngọt ngào');
          const borderRule = 'KHUNG VIỀN TRẮNG CỐ ĐỊNH (SOLID WHITE BORDER PADDING): Toàn bộ video được bao bọc bởi một khung viền màu trắng tĩnh cố định dày chính xác 12% ở mỗi cạnh: cạnh trên dày 12%, cạnh dưới dày 12%, cạnh trái dày 12%, cạnh phải dày 12% (solid white border frame: 12% top, 12% bottom, 12% left, 12% right padding). Toàn bộ nội dung chuyển động và hình ảnh video chỉ hiển thị chính xác bên trong khung viền trắng này, tuyệt đối không tràn ra ngoài viền trắng, và bên trong nội dung video hoàn toàn liền mạch không có bất kỳ vạch kẻ hay viền trắng nào chia cắt.';
          const { combineTwoSceneScripts } = require('./template5-storyboard');
          const vo = idx === 1
            ? combineTwoSceneScripts(runInfo.analysis?.script?.[0]?.voiceOver, runInfo.analysis?.script?.[1]?.voiceOver, 42)
            : combineTwoSceneScripts(runInfo.analysis?.script?.[2]?.voiceOver, runInfo.analysis?.script?.[3]?.voiceOver, 42);
          const voiceClause = vo ? ` Giọng đọc review: ${voiceDesc}, tốc độ đọc nhanh dồn dập. Lời thoại nhân vật đọc liên tục trong 8 giây (tối đa 42 từ): "${vo}".` : ` Giọng đọc review: ${voiceDesc}.`;
          prompt = `Tạo video review ${prodName} faceless dài đúng 8 giây từ hình ảnh 2 cảnh đã cung cấp. ${borderRule} YÊU CẦU ƯU TIÊN HÀNG ĐẦU: ${customInstruction}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI.${voiceClause} VISUAL VÀ CHUYỂN ĐỘNG: Thực hiện ưu tiên chính xác theo yêu cầu: ${customInstruction}. Cảnh quay chân thực tự nhiên 100% như quay thực tế, không hiệu ứng ảo CGI.`;
        } else if (template === 'template5') {
          const prodName = runInfo.analysis?.productName || 'sản phẩm';
          const borderRule = 'KHUNG VIỀN TRẮNG CỐ ĐỊNH (SOLID WHITE BORDER PADDING): Toàn bộ video được bao bọc bởi một khung viền màu trắng tĩnh cố định dày chính xác 12% ở mỗi cạnh: cạnh trên dày 12%, cạnh dưới dày 12%, cạnh trái dày 12%, cạnh phải dày 12% (solid white border frame: 12% top, 12% bottom, 12% left, 12% right padding). Toàn bộ nội dung chuyển động và hình ảnh video chỉ hiển thị chính xác bên trong khung viền trắng này, tuyệt đối không tràn ra ngoài viền trắng, và bên trong nội dung video hoàn toàn liền mạch không có bất kỳ vạch kẻ hay viền trắng nào chia cắt.';
          const { normalizePanelOverlays } = require('./template5-storyboard');
          const overlays = runInfo.analysis?.panelOverlays || (normalizePanelOverlays ? normalizePanelOverlays(runInfo.analysis || {}) : []);
          const textClause = idx === 1
            ? `HIỂN THỊ CHỮ THEO THỜI GIAN: 4 giây đầu (0s-4s) hiển thị chính xác chữ Cảnh 1 ("${overlays[0]?.headline || 'TIÊU ĐỀ'}"), tại mốc 4 giây chuyển sang hiển thị chính xác chữ Cảnh 2 ("${overlays[1]?.headline || 'GIẢI PHÁP'}").`
            : `HIỂN THỊ CHỮ THEO THỜI GIAN: 4 giây đầu (0s-4s) hiển thị chính xác chữ Cảnh 3 ("${overlays[2]?.headline || 'CHẤT LƯỢNG'}"), tại mốc 4 giây chuyển sang hiển thị chính xác chữ Cảnh 4 ("${overlays[3]?.headline || 'CHỐT ĐƠN'}").`;
          prompt = `Tạo video review ${prodName} faceless dài đúng 8 giây từ hình ảnh 2 cảnh đã cung cấp. ${borderRule} YÊU CẦU ƯU TIÊN HÀNG ĐẦU: ${customInstruction}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. ${textClause} Chữ đúng chính tả tiếng Việt có dấu, tuyệt đối không tự tạo thêm chữ rác khác. VISUAL VÀ CHUYỂN ĐỘNG: Thực hiện ưu tiên chính xác theo yêu cầu: ${customInstruction}. Cảnh quay chân thực tự nhiên 100% như quay thực tế, không hiệu ứng ảo CGI. Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`;
        } else if (template === 'template5_1' || template === 'template5.1' || template === 'template51') {
          const prodName = runInfo.analysis?.productName || 'sản phẩm';
          const borderRule = 'KHUNG VIỀN TRẮNG CỐ ĐỊNH (SOLID WHITE BORDER PADDING): Toàn bộ video được bao bọc bởi một khung viền màu trắng tĩnh cố định dày chính xác 12% ở mỗi cạnh: cạnh trên dày 12%, cạnh dưới dày 12%, cạnh trái dày 12%, cạnh phải dày 12% (solid white border frame: 12% top, 12% bottom, 12% left, 12% right padding). Toàn bộ nội dung chuyển động và hình ảnh video chỉ hiển thị chính xác bên trong khung viền trắng này, tuyệt đối không tràn ra ngoài viền trắng, và bên trong nội dung video hoàn toàn liền mạch không có bất kỳ vạch kẻ hay viền trắng nào chia cắt.';
          prompt = `Tạo video review ${prodName} faceless dài đúng 8 giây từ hình ảnh 2 cảnh đã cung cấp. ${borderRule} YÊU CẦU ƯU TIÊN HÀNG ĐẦU: ${customInstruction}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). VISUAL VÀ CHUYỂN ĐỘNG: Thực hiện ưu tiên chính xác theo yêu cầu: ${customInstruction}. Cảnh quay chân thực tự nhiên 100% như quay thực tế, không hiệu ứng ảo CGI. Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`;
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
        videoModelKey: (template === 'template6' ? '8s' : ((template === 'template2' || template === 'template5_3' || template === 'template5.3' || template === 'template53') ? '4s' : (['template3', 'template4', 'template5', 'template5_1', 'template5_2'].includes(template) ? 'abra_i2v_8s' : '6s'))),
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

  await sendTelegramMessage(botToken, chatId,
    `🔄 Đang tạo lại ${validPanels.length} video cho cảnh ${validPanels.map(p => p.index).join(', ')}...`);

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
        cropPercent: (template === 'template5_3' || template === 'template5.3' || template === 'template53' || template === 'template6') ? undefined : (template.includes('template5') ? 0.12 : undefined),
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
          try { fs.copyFileSync(v.videoPath, targetVideoPath); } catch (_) { }
        }

        // CRITICAL: Đồng bộ video đã remake vào generationJobService để /upload gộp đủ tất cả các cảnh!
        const latestJob = generationJobService.getLatestCompletedJob(String(chatId));
        if (latestJob) {
          if (!latestJob.result) latestJob.result = {};
          if (!Array.isArray(latestJob.result.videos)) latestJob.result.videos = [];

          const vEntry = {
            panelIndex: Number(v.panelIndex),
            videoPath: fs.existsSync(targetVideoPath) ? targetVideoPath : v.videoPath,
            video: v.video || (base64 ? { base64, mimeType: 'video/mp4' } : null),
            prompt: v.prompt,
            status: 'completed',
          };
          delete vEntry.error;

          const existingIdx = latestJob.result.videos.findIndex(item => Number(item?.panelIndex) === Number(v.panelIndex));
          if (existingIdx >= 0) {
            latestJob.result.videos[existingIdx] = vEntry;
          } else {
            latestJob.result.videos.push(vEntry);
          }

          // Xóa finalVideoPath cũ để khi /upload buộc phải ghép lại toàn bộ các panel theo đúng thứ tự
          latestJob.finalVideoPath = null;
          latestJob.finalVideoSize = null;
          latestJob.status = 'completed';
          if (latestJob.upload) {
            latestJob.upload.status = 'pending';
            latestJob.upload.publishId = null;
            latestJob.upload.error = null;
          }
          console.log(`[Telegram Bot] 🔄 Synced remade panel ${v.panelIndex} into job ${latestJob.jobId} (videoPath: ${vEntry.videoPath})`);
        }

        // Cập nhật runInfo trong bộ nhớ
        if (!Array.isArray(runInfo.videos)) runInfo.videos = [];
        const rIdx = runInfo.videos.findIndex(item => Number(item?.panelIndex) === Number(v.panelIndex));
        const rEntry = { panelIndex: Number(v.panelIndex), videoPath: targetVideoPath, status: 'completed' };
        if (rIdx >= 0) runInfo.videos[rIdx] = rEntry;
        else runInfo.videos.push(rEntry);

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
          `✅ Đã tạo lại xong ${successCount} video (${elapsed}s)!\n\n👉 Gõ /upload để ghép đầy đủ các cảnh theo đúng thứ tự và đăng lên TikTok.\n👉 Hoặc gõ /remake [số_cảnh] nếu muốn đổi lại video khác.`);
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
      `❌ Lỗi xử lý /remake cảnh ${validPanels.map(p => p.index).join(', ')}: ${err.message}\n👉 Vui lòng thử lại: /remake ${validPanels.map(p => p.index).join(' ')}`).catch(() => { });
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
  } catch (_) { }

  // 2. Try production webhook
  try {
    const res = await tgHttp.post(prodUrl, payload, { timeout: 3000 });
    if (res.status === 200) {
      console.log('[Telegram Bot] 🚀 Forwarded event to n8n PRODUCTION webhook successfully.');
      return true;
    }
  } catch (_) { }

  return false;
}

async function handleTikTokDirectFlow(botToken, chatId, messageId, shortlink, template = process.env.DEFAULT_STORYBOARD_TEMPLATE || 'template3') {
  const tracker = new FlowStepTracker(chatId, { title: 'Đang tải thông tin sản phẩm...' });
  try {
    await tracker.start(1, 'Đang đọc link TikTok Shop...');
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
      await tracker.fail(1, 'Không thể lấy thông tin sản phẩm hoặc ảnh từ link này.');
      return;
    }

    if (assets.title) {
      await tracker.setTitle(assets.title);
    }

    generationJobService.enqueueJob({
      chatId: String(chatId),
      sourceMessageId: messageId,
      shortlink,
      productUrl,
      template,
      productId: assets.productId,
      productTitle: assets.title,
      productDescription: assets.productDescription,
      productImages: assets.productImages.slice(0, 8),
      stepTracker: tracker,
    });
  } catch (err) {
    console.error('[Telegram Bot] Direct TikTok flow error:', err.message);
    await tracker.fail(1, err.message);
  }
}

async function handleUploadDirectCommand(botToken, chatId, targetJobId, uploadMsgId) {
  const job = targetJobId ? generationJobService.getJob(targetJobId) : generationJobService.getLatestCompletedJob(String(chatId));
  if (!job || job.status !== 'completed') {
    await sendTelegramMessage(botToken, chatId, '⚠️ Không tìm thấy video đã hoàn tất gần đây của bạn. Vui lòng gửi link TikTok Shop để tạo video trước.');
    return;
  }
  if (job.upload?.status === 'published') {
    await sendTelegramMessage(botToken, chatId, `ℹ️ Video này đã được đăng thành công trước đó (Publish ID: ${job.upload?.publishId || 'OK'}). Bỏ qua.`);
    return;
  }
  if (uploadMsgId) {
    job.uploadMessageId = uploadMsgId;
  } else if (!job.uploadMessageId) {
    const msgId = await sendTelegramMessage(botToken, chatId, '⏳ Đang upload...');
    if (msgId) job.uploadMessageId = msgId;
  }
  try {
    const { prepareUploadJob } = require('./generation-job');
    await prepareUploadJob(job.jobId);
    if (job.uploadMessageId) {
      await editTelegramMessage(chatId, job.uploadMessageId, '✅ Upload thành công lên TikTok!');
    }
  } catch (err) {
    console.error('[Telegram Bot] Direct upload error:', err.message);
    if (job.uploadMessageId) {
      await editTelegramMessage(chatId, job.uploadMessageId, `❌ Lỗi upload: ${err.message}`);
    } else {
      await sendTelegramMessage(botToken, chatId, `⚠️ Lỗi chuẩn bị upload: ${err.message}`);
    }
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

      // Gửi ngay tin nhắn "⏳ Đang upload..." và lưu lại message_id
      const uploadMsgId = await sendTelegramMessage(botToken, chatId, '⏳ Đang upload...');
      if (uploadMsgId) {
        job.uploadMessageId = uploadMsgId;
      }

      const signal = generationJobService.setJobCommand(chatId, {
        command: 'upload',
        targetJobId: targetJobId || job?.jobId || null,
        uploadMessageId: uploadMsgId || null,
        rawText: text,
      });

      if (signal.delivery === 'delivered') {
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
        uploadMessageId: uploadMsgId || null,
        targetJobId: targetJobId || job?.jobId || null,
        tiktokCredentialId: uploadChannel.tiktokCredentialId,
        tiktokCredentialName: uploadChannel.tiktokCredentialName,
        timestamp: Date.now()
      };

      const forwarded = await forwardToN8nWebhook(payload);
      if (!forwarded) {
        await handleUploadDirectCommand(botToken, chatId, payload.targetJobId, uploadMsgId);
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

    const autoSchedulers = {
      auto_t3: autoT3Scheduler,
      auto_t4: autoT4Scheduler,
      auto_t5: autoT5Scheduler,
    };
    if (autoSchedulers[commandKind]) {
      console.log(`[Telegram Bot] Received /${commandKind} command from chat ${chatId}: ${text}`);
      const baseDir = path.resolve(__dirname, '..');
      await autoSchedulers[commandKind].handleCommand(botToken, chatId, text, baseDir);
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
      const templateMatch = text.match(/\/(template[0-9_.]+|t[0-9_.]+)/i);
      if (templateMatch) {
        template = normalizeTemplateName(templateMatch[1]);
      }

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

    // /start or /help or /menu
    const isStartCmd = /^\/(start|help|menu)(?:@\w+)?(?:\s|$)/i.test(text) ||
      /^(start|help|menu|hướng dẫn|huong dan)$/i.test(text.trim());
    if (isStartCmd) {
      await sendTelegramMessage(botToken, chatId,
        '🚀 <b>LỆNH BẮT ĐẦU:</b> /start (Bấm vào để mở lại menu bất kỳ lúc nào)\n\n' +
        '👋 <b>Xin chào!</b> Hãy gửi link TikTok Shop (vd: <code>https://vt.tiktok.com/...</code>) qua đây, bot sẽ tự động phân tích sản phẩm và tạo video review cho bạn.\n\n' +
        '📌 <b>LỆNH HỆ THỐNG:</b>\n' +
        '• /start — Bắt đầu / Xem lại hướng dẫn & danh sách tất cả các lệnh\n\n' +
        '🤖 <b>CÁC LỆNH TỰ ĐỘNG CHẠY THEO LỊCH (AUTO SCHEDULE):</b>\n' +
        '• <b>Template 3:</b> /auto_t3 (Bật) | /auto_t3_run (Chạy ngay) | /auto_t3_off (Tắt)\n' +
        '• <b>Template 4:</b> /auto_t4 (Bật) | /auto_t4_run (Chạy ngay) | /auto_t4_off (Tắt)\n' +
        '• <b>Template 5:</b> /auto_t5 (Bật) | /auto_t5_run (Chạy ngay) | /auto_t5_off (Tắt)\n\n' +
        '🎬 <b>CÁC LỆNH TẠO VIDEO THEO TEMPLATE (Thủ công - có thể gõ /t ngắn):</b>\n' +
        '• /t1 (hoặc /template1) — Review faceless 2 cảnh (không voice-over)\n' +
        '• /t2 (hoặc /template2) — Review 8 cảnh 4s (không voice-over)\n' +
        '• /t3 (hoặc /template3) — Review shop 3 cảnh (top-down 8s + góc hông 4s + thử giày 8s)\n' +
        '• /t4 (hoặc /template4) — Review giày/dép pastel 4 cảnh (cận cảnh 8s, POV váy 6s, nệm 4s, thử dáng 8s)\n' +
        '• /t5 (hoặc /template5) — Review đa ngành hàng (2 video 8s, có chữ tiếng Việt theo thời gian)\n' +
        '• /t51 (hoặc /template5_1) — Review đa ngành hàng (2 video 8s, KHÔNG CHỮ / No Text)\n' +
        '• /t52 (hoặc /template5_2) — Review đa ngành hàng (2 video 8s, KHÔNG CHỮ + VOICE REVIEW faceless)\n' +
        '• /t53 (hoặc /template5_3) — Review spam đa ngành hàng (4 video 4s, model Veo, KHÔNG CHỮ + VOICE REVIEW faceless)\n' +
        '• /t6 (hoặc /template6) — Review siêu thị POV 2 cảnh 8s (Bách Hóa Xanh / WinMart)\n\n' +
        '⚡ <b>CÁC LỆNH ĐIỀU KHIỂN & HỖ TRỢ:</b>\n' +
        '• /upload — Ghép các cảnh video thành video 9:16 và đăng lên TikTok\n' +
        '• /remake [số_cảnh] — Tạo lại cảnh video chưa ưng ý (VD: /remake 1 hoặc /remake_2)\n' +
        '• /status — Xem trạng thái hàng đợi xử lý\n' +
        '• /chatid — Xem Chat ID và tài khoản TikTok đang liên kết',
        { parse_mode: 'HTML' }
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
    if (/^\/(template1|t1)(?:@\w+)?(?:\s|$)/i.test(text)) {
      console.log(`[Telegram Bot] Received Template 1 command (${text}) from chat ${chatId}`);
      await handleTemplate1Command(botToken, chatId);
      return;
    }

    // ── Template 2 command ───────────────────────────────────────────────────
    if (/^\/(template2|t2)(?:@\w+)?(?:\s|$)/i.test(text)) {
      console.log(`[Telegram Bot] Received Template 2 command (${text}) from chat ${chatId}`);
      await handleTemplate2Command(botToken, chatId);
      return;
    }

    // ── Template 3 command ───────────────────────────────────────────────────
    if (/^\/(template3|t3)(?:@\w+)?(?:\s|$)/i.test(text)) {
      console.log(`[Telegram Bot] Received Template 3 command (${text}) from chat ${chatId}`);
      await handleTemplate3Command(botToken, chatId);
      return;
    }

    // ── Template 4 command ───────────────────────────────────────────────────
    if (/^\/(template4|t4)(?:@\w+)?(?:\s|$)/i.test(text)) {
      console.log(`[Telegram Bot] Received Template 4 command (${text}) from chat ${chatId}`);
      await handleTemplate4Command(botToken, chatId);
      return;
    }

    // ── Template 5.1 command (No Text) ───────────────────────────────────────
    if (/^\/(template5[._]?1|t5[._]?1)(?:@\w+)?(?:\s|$)/i.test(text)) {
      console.log(`[Telegram Bot] Received Template 5.1 command (${text}) from chat ${chatId}`);
      await handleTemplate5_1Command(botToken, chatId);
      return;
    }

    // ── Template 5.2 command (No Text + Voice) ───────────────────────────────
    if (/^\/(template5[._]?2|t5[._]?2)(?:@\w+)?(?:\s|$)/i.test(text)) {
      console.log(`[Telegram Bot] Received Template 5.2 command (${text}) from chat ${chatId}`);
      await handleTemplate5_2Command(botToken, chatId);
      return;
    }

    // ── Template 5.3 command (No Text + Voice, 4x4s Veo Spam Video) ──────────
    if (/^\/(template5[._]?3|t5[._]?3)(?:@\w+)?(?:\s|$)/i.test(text)) {
      console.log(`[Telegram Bot] Received Template 5.3 command (${text}) from chat ${chatId}`);
      await handleTemplate5_3Command(botToken, chatId);
      return;
    }

    // ── Template 5 command ───────────────────────────────────────────────────
    if (/^\/(template5|t5)(?:@\w+)?(?:\s|$)/i.test(text)) {
      console.log(`[Telegram Bot] Received Template 5 command (${text}) from chat ${chatId}`);
      await handleTemplate5Command(botToken, chatId);
      return;
    }

    // ── Template 6 command (Supermarket POV) ──────────────────────────────────
    if (/^\/(template6|template_6|t6)(?:@\w+)?(?:\s|$)/i.test(text)) {
      console.log(`[Telegram Bot] Received Template 6 command (${text}) from chat ${chatId}`);
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

    // ── Fallback cho lệnh lạ hoặc tin nhắn text chưa xác định ────────────────
    if (text.startsWith('/')) {
      await sendTelegramMessage(botToken, chatId,
        `⚠️ Lệnh <code>${text}</code> không hợp lệ.\n\n👉 Bấm /start để xem toàn bộ danh sách lệnh và hướng dẫn!`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    await sendTelegramMessage(botToken, chatId,
      '💡 <b>Hướng dẫn:</b> Hãy gửi link sản phẩm TikTok Shop (vd: <code>https://vt.tiktok.com/...</code>) để tạo video review.\n\n👉 Bấm /start để xem toàn bộ danh sách lệnh!',
      { parse_mode: 'HTML' }
    );
    return;
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

    // All templates now use TikTok Shop shortlink as input
    await sendTelegramMessage(
      botToken,
      chatId,
      '⚠️ Bot hiện tại đã chuyển sang nhận input bằng shortlink TikTok Shop.\nVui lòng gửi link sản phẩm (VD: https://vt.tiktok.com/...) để tạo video review!'
    );
    return;

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
        templateMessage = ' theo /template5 đa ngành hàng 4 cảnh (2 video 8s) (có chữ tiếng Việt chuyển cảnh theo thời gian, không tiếng review)';
      } else if (batch.template === 'template5_1' || batch.template === 'template5.1' || batch.template === 'template51') {
        templateMessage = ' theo /template5_1 đa ngành hàng 4 cảnh (2 video 8s) (KHÔNG CHỮ, không tiếng review)';
      } else if (batch.template === 'template5_2' || batch.template === 'template5.2' || batch.template === 'template52') {
        templateMessage = ' theo /template5_2 đa ngành hàng 4 cảnh (2 video 8s) (KHÔNG CHỮ + CÓ VOICE REVIEW faceless)';
      } else if (batch.template === 'template5_3' || batch.template === 'template5.3' || batch.template === 'template53') {
        templateMessage = ' theo /template5_3 spam đa ngành hàng 4 cảnh (4 video 4s, model Veo) (KHÔNG CHỮ + CÓ VOICE REVIEW faceless)';
      }

      const tracker = new FlowStepTracker(chatId, { title: 'Tạo video từ ảnh tải lên' });
      await tracker.start(2);

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
          const res = await runStoryboardFullFlow(chatId, photosCopy, baseDir, {
            ...templateOptions,
            runId,
            stepTracker: tracker,
          });
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

          await tracker.completeAll();

          // 1. Gửi tin nhắn CHỈ CHỨA TITLE VÀ HASHTAG (để user dễ dàng copy thủ công nếu muốn tự đăng tay)
          const analyzedTitle = res.analysis?.productName || res.analysis?.product_name || 'Sản phẩm review';
          const defaultTags = ['#review', '#sanphamchinhhang', '#trending', '#xuhuong', '#tiktokshop'];
          const hashtags = (Array.isArray(res.analysis?.hashtags) && res.analysis.hashtags.length > 0)
            ? res.analysis.hashtags.slice(0, 5)
            : defaultTags;
          await sendTelegramMessage(botToken, chatId, `${analyzedTitle}\n\n${hashtags.join(' ')}`);

          // 2. Gửi tin nhắn hướng dẫn và lệnh remake / upload
          const videoCount = (Array.isArray(res.videos) ? res.videos.length : 2);
          const remakeLines = Array.from({ length: videoCount }, (_, i) => `  • Cảnh ${i + 1}: /remake_${i + 1}`).join('\n');
          await sendTelegramMessage(
            botToken,
            chatId,
            `✅ Đã tạo xong ${videoCount} video panel.\n\n👉 Nhấn lệnh để tạo lại từng cảnh nếu cần:\n${remakeLines}\n\n👉 Gõ /upload để ghép video và đăng lên TikTok.\n👉 Gõ /start để xem toàn bộ danh sách lệnh.`
          );

          return res;
        },
      })
        .then(() => {
          console.log(`[Telegram Bot] Storyboard full flow completed for chat ${chatId}`);
        })
        .catch(async (err) => {
          console.error(`[Telegram Bot] Full flow error for chat ${chatId}:`, err.message);
          await tracker.fail(null, err.message);
          sendTelegramMessage(botToken, chatId,
            `⚠️ Lỗi chạy full flow: ${err.message}`).catch(() => { });
        });

    }, BATCH_WINDOW_MS);
  }
}

function buildTelegramCommands() {
  return [
    { command: 'start', description: '🚀 Bắt đầu / Xem toàn bộ hướng dẫn & lệnh' },
    { command: 'help', description: '❓ Hướng dẫn sử dụng & danh sách lệnh' },
    { command: 'auto_t3', description: '🤖 Bật auto Template 3 theo lịch' },
    { command: 'auto_t3_run', description: '▶️ Chạy thử ngay 1 video Template 3' },
    { command: 'auto_t3_off', description: '⏸️ Tắt tự động chạy Template 3' },
    { command: 'auto_t4', description: '🤖 Bật auto Template 4 theo lịch' },
    { command: 'auto_t4_run', description: '▶️ Chạy thử ngay 1 video Template 4' },
    { command: 'auto_t4_off', description: '⏸️ Tắt tự động chạy Template 4' },
    { command: 'auto_t5', description: '🤖 Bật auto Template 5 theo lịch' },
    { command: 'auto_t5_run', description: '▶️ Chạy thử ngay 1 video Template 5' },
    { command: 'auto_t5_off', description: '⏸️ Tắt tự động chạy Template 5' },
    { command: 't3', description: '🏬 Review shop 3 cảnh (8s, 4s, 8s)' },
    { command: 't4', description: '👠 Review giày/dép pastel 4 cảnh (8s, 6s, 4s, 8s)' },
    { command: 't5', description: '✨ Review đa ngành hàng (2 video 8s, có chữ)' },
    { command: 't5_1', description: '💎 Review đa ngành hàng (2 video 8s, KHÔNG CHỮ)' },
    { command: 't5_2', description: '🎙️ Review đa ngành hàng (2 video 8s, CÓ VOICE)' },
    { command: 't5_3', description: '⚡ Spam đa ngành hàng (4 video 4s, CÓ VOICE)' },
    { command: 't6', description: '🛒 Review siêu thị POV 2 cảnh 8s' },
    { command: 't1', description: '👟 Review faceless 2 cảnh' },
    { command: 't2', description: '🥿 Review 8 cảnh 4s' },
    { command: 'upload', description: '🚀 Ghép video 9:16 & đăng lên TikTok' },
    { command: 'remake', description: '🔄 Tạo lại video cảnh chưa ưng ý (VD: /remake 1)' },
    { command: 'status', description: '📊 Xem trạng thái hàng đợi xử lý' },
    { command: 'chatid', description: '🔑 Xem Chat ID & TikTok account đang gán' },
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
  autoT3Scheduler.startScheduler(path.resolve(__dirname, '..'));
  autoT4Scheduler.startScheduler(path.resolve(__dirname, '..'));
  autoT5Scheduler.startScheduler(path.resolve(__dirname, '..'));

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
  registerBotCommands,
  buildTelegramCommands,
  lastRunByChat,
  _test: {
    classifyTelegramCommand,
  },
};
