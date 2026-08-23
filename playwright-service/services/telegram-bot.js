const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { runStoryboardFullFlow } = require('./storyboard-fullflow');
const { sendVideoToTelegramDirect } = require('./telegram-send');
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
const lastRunByChat = new Map();
const BATCH_WINDOW_MS = 5000;
let isPolling = false;
let pollingOffset = 0;

const RESERVED_COMMANDS = new Set(['start', 'dailyvlog', 'template1', 'template2', 'template3', 'template4', 'template5', 'template5_1', 'template51', 'template5_2', 'template52', 'status', 'remake', 'again', 'redo']);
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
    templateMessage = ' bằng /template3 shop 4 cảnh (top-down 8s + POV ngực 6s + góc hông 4s + đứng thử giày 8s)';
  } else if (selectedTemplate === 'template4') {
    templateMessage = ' bằng /template4 shop pastel nữ 4 cảnh (cận cảnh 8s + POV váy 6s + góc nệm 4s + đứng thử dáng 8s)';
  } else if (selectedTemplate === 'template5') {
    templateMessage = ' bằng /template5 đa ngành hàng 4 cảnh 6s (có chữ tiếng Việt, không tiếng review)';
  } else if (selectedTemplate === 'template5_1' || selectedTemplate === 'template5.1' || selectedTemplate === 'template51') {
    templateMessage = ' bằng /template5_1 đa ngành hàng 4 cảnh 6s (KHÔNG CHỮ, không tiếng review)';
  } else if (selectedTemplate === 'template5_2' || selectedTemplate === 'template5.2' || selectedTemplate === 'template52') {
    templateMessage = ' bằng /template5_2 đa ngành hàng 4 cảnh 6s (KHÔNG CHỮ + CÓ VOICE REVIEW faceless)';
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
      if (result && result.reviewArchive?.root) {
        lastRunByChat.set(String(chatId), {
          runDir: result.reviewArchive.root,
          panelsDir: result.reviewArchive.panelsDir || path.join(result.reviewArchive.root, 'panels'),
          videosDir: path.join(result.reviewArchive.root, 'videos'),
          panels: result.panels,
          template: selectedTemplate,
          analysis: result.analysis,
          baseDir,
        });
      }
      const sent = result && result.sentCount != null ? result.sentCount : '?';
      const summary = result?.productInfo?.summary || result?.analysis?.summary ? `\n${result.productInfo?.summary || result.analysis?.summary}` : '';
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
      '✅ Đã áp dụng /template3 cho album ảnh đang gom: 4 cảnh shop — top-down 8s, POV ngực 6s, góc hông 4s, đứng thử giày 8s.');
    return;
  }

  pendingTemplateByChat.set(chatId, 'template3');
  await sendTelegramMessage(botToken, chatId,
    '✅ Đã bật /template3 cho lượt ảnh kế tiếp: 4 cảnh shop — top-down 8s, POV ngực 6s, góc hông 4s, đứng thử giày 8s.');
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
  await sendTelegramMessage(botToken, chatId,
    '✅ Đã bật /template4 cho lượt ảnh kế tiếp: review giày/dép nữ 4 cảnh boutique pastel — cận cảnh 8s, POV váy 6s, góc nệm 4s, đứng thử dáng 8s.');
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
  await sendTelegramMessage(botToken, chatId,
    '✅ Đã bật /template5 cho lượt ảnh kế tiếp: review đa ngành hàng 4 cảnh 6s tự động phân tích (có chữ tiếng Việt trên panel, không tiếng review).');
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
  await sendTelegramMessage(botToken, chatId,
    '✅ Đã bật /template5_1 cho lượt ảnh kế tiếp: review đa ngành hàng 4 cảnh 6s tự động phân tích (KHÔNG CHỮ / No Text trên storyboard & panel, không tiếng review).');
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
  await sendTelegramMessage(botToken, chatId,
    '✅ Đã bật /template5_2 cho lượt ảnh kế tiếp: review đa ngành hàng 4 cảnh 6s (KHÔNG CHỮ trên panel + CÓ VOICE REVIEW nam/nữ theo sản phẩm, faceless 100%).');
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
      panelCount: 4,
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
    runInfo.runDir && (runInfo.runDir.includes('template5_2') || runInfo.runDir.includes('template5.2')) ? 'template5_2' :
    runInfo.runDir && (runInfo.runDir.includes('template5_1') || runInfo.runDir.includes('template5.1')) ? 'template5_1' :
    runInfo.runDir && runInfo.runDir.includes('template5') ? 'template5' :
    runInfo.runDir && runInfo.runDir.includes('template4') ? 'template4' : 'template3'
  );
  let panelPrompts = [];
  if (template === 'template5' || template === 'template5_1' || template === 'template5.1' || template === 'template51' ||
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
  const { generateVideosFromPanelsDirect } = require('./google-flow-storyboard');
  const validPanels = [];
  const invalidIndices = [];

  for (const idx of numbers) {
    const pPath = path.join(runInfo.panelsDir, `panel-${idx}.png`);
    if (fs.existsSync(pPath)) {
      const buf = fs.readFileSync(pPath);
      let prompt = panelPrompts[idx - 1] || `Tạo video review sản phẩm faceless cảnh ${idx}`;

      if (customInstruction) {
        if (template === 'template5_2' || template === 'template5.2' || template === 'template52') {
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
        panelIndex: idx,
        buffer: buf,
        prompt: prompt,
        videoModelKey: template === 'template2' ? '4s' : ((template === 'template3' || template === 'template4') ? ((idx === 1 || idx === 4) ? '8s' : (idx === 2 ? '6s' : '4s')) : '6s'),
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
    `🔄 Đang tạo lại ${validPanels.length} video cho cảnh ${validPanels.map(p => p.panelIndex).join(', ')}...${customInfo}`);

  const startTime = Date.now();

  flowQueue.enqueue({
    chatId: String(chatId),
    photos: [],
    baseDir,
    templateOptions: buildTemplateOptions(template),
    label: `Remake cảnh ${validPanels.map(p => p.panelIndex).join(', ')}`,
    execute: async () => {
      const videos = await generateVideosFromPanelsDirect(validPanels, {
        outputDir: runInfo.videosDir || path.join(runInfo.runDir, 'videos'),
        concurrency: 2,
      });

      let successCount = 0;
      for (const v of videos) {
        if (!v || !v.videoBuffer) continue;
        const base64 = v.videoBuffer.toString('base64');
        const caption = `🎬 Video Cảnh ${v.panelIndex} (Tạo lại / Remake)\n` +
          `• Template: ${template}\n` +
          `• Thời lượng: ${validPanels.find(p => p.panelIndex === v.panelIndex)?.videoModelKey || '6s'}\n` +
          (customInstruction ? `• Tùy biến: ${customInstruction}\n` : '');

        const ok = await sendVideoToTelegramDirect(chatId, base64, v.panelIndex, `Panel ${v.panelIndex}`, caption);
        if (ok) successCount++;
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (successCount > 0) {
        await sendTelegramMessage(botToken, chatId,
          `✅ Đã tạo lại xong ${successCount} video (${elapsed}s)! Bạn có thể gõ tiếp /remake <số_cảnh> bất cứ lúc nào nếu muốn đổi lại video khác.`);
      }
      return { successCount, videos };
    },
  }).catch(err => {
    console.error(`[Telegram Bot] /remake error for chat ${chatId}:`, err.message);
    sendTelegramMessage(botToken, chatId, `⚠️ Lỗi xử lý /remake: ${err.message}`).catch(() => {});
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
        '👋 Xin chào! Hãy gửi các ảnh sản phẩm qua đây, tôi sẽ tự động phân tích và tạo video review thời trang/sản phẩm cho bạn.\n\n' +
        '📂 Hoặc dùng các lệnh folder trong menu bot để tải ảnh từ thư mục Drive cùng tên.\n' +
        '👟 Dùng /template1 rồi gửi ảnh để tạo review faceless 2 cảnh, không voice-over.\n' +
        '🥿 Dùng /template2 rồi gửi ảnh để tạo review 8 cảnh, mỗi cảnh 4s, không voice-over.\n' +
        '🏬 Dùng /template3 rồi gửi ảnh để tạo review shop 4 cảnh (top-down 8s + POV ngực 6s + góc hông 4s + đứng thử giày 8s), không voice-over.\n' +
        '👠 Dùng /template4 rồi gửi ảnh để tạo review giày/dép nữ shop pastel 4 cảnh (cận cảnh 8s, POV váy 6s, góc nệm 4s, đứng thử dáng 8s), không voice-over.\n' +
        '✨ Dùng /template5 rồi gửi ảnh để tạo review đa ngành hàng 4 cảnh 6s tự động phân tích (có chữ tiếng Việt trên panel, không tiếng review).\n' +
        '💎 Dùng /template5_1 rồi gửi ảnh để tạo review đa ngành hàng 4 cảnh 6s (KHÔNG CHỮ / No Text, không tiếng review).\n' +
        '🎙️ Dùng /template5_2 rồi gửi ảnh để tạo review đa ngành hàng 4 cảnh 6s (KHÔNG CHỮ + CÓ GIỌNG NÓI VOICE-OVER review, faceless 100%).\n' +
        '🔄 Dùng /remake <số_cảnh> [yêu cầu] (VD: /remake 2 hoặc /remake 2 xoay góc 45 độ) để tạo lại video với prompt tùy chỉnh.\n' +
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

    // Folder commands (also handles e.g. /m1@botname sent in groups).
    // Keep reserved commands; ignore commands starting with 'p' (e.g. /p1, /p2); any other alphanumeric command maps to a folder name.
    const folderMatch = text.match(/^\/([a-zA-Z][a-zA-Z0-9_]{0,31})(?:@\S+)?$/);
    if (folderMatch && !RESERVED_COMMANDS.has(folderMatch[1].toLowerCase())) {
      const folderName = folderMatch[1].toLowerCase();
      if (folderName.startsWith('p')) {
        // Bỏ qua các lệnh bắt đầu bằng /p
        return;
      }
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
        receiveMsg = '📥 Đã nhận được hình ảnh. Đang gom album cho /template3 shop 4 cảnh...';
      } else if (selectedTemplate === 'template4') {
        receiveMsg = '📥 Đã nhận được hình ảnh. Đang gom album cho /template4 giày/dép nữ shop pastel 4 cảnh...';
      } else if (selectedTemplate === 'template5') {
        receiveMsg = '📥 Đã nhận được hình ảnh. Đang gom album cho /template5 review đa ngành hàng 4 cảnh 6s (có chữ)...';
      } else if (selectedTemplate === 'template5_1' || selectedTemplate === 'template5.1' || selectedTemplate === 'template51') {
        receiveMsg = '📥 Đã nhận được hình ảnh. Đang gom album cho /template5_1 review đa ngành hàng 4 cảnh 6s (không chữ)...';
      } else if (selectedTemplate === 'template5_2' || selectedTemplate === 'template5.2' || selectedTemplate === 'template52') {
        receiveMsg = '📥 Đã nhận được hình ảnh. Đang gom album cho /template5_2 review đa ngành hàng 4 cảnh 6s (có voice review faceless)...';
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
        templateMessage = ' theo /template3 shop 4 cảnh (top-down 8s + POV ngực 6s + góc hông 4s + đứng thử giày 8s)';
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
  // Bỏ qua tất cả các lệnh bắt đầu bằng 'p' (ví dụ: p1, p2, p3, p_...)
  if (command.startsWith('p')) return null;
  return command;
}

async function buildTelegramCommandsFromDrive() {
  const commands = [
    { command: 'status', description: '📊 Xem trạng thái hàng đợi xử lý' },
    { command: 'template1', description: '👟 Review faceless 2 cảnh, không voice-over' },
    { command: 'template2', description: '🥿 Review 8 cảnh, mỗi cảnh 4s, không voice-over' },
    { command: 'template3', description: '🏬 Review shop 4 cảnh (8s, 6s, 4s, 8s), không voice-over' },
    { command: 'template4', description: '👠 Review giày/dép nữ shop pastel 4 cảnh (8s, 6s, 4s, 8s)' },
    { command: 'template5', description: '✨ Review đa ngành hàng 4 cảnh 6s (có chữ tiếng Việt)' },
    { command: 'template5_1', description: '💎 Review đa ngành hàng 4 cảnh 6s (KHÔNG CHỮ / No Text)' },
    { command: 'template5_2', description: '🎙️ Review đa ngành hàng 4 cảnh 6s (KHÔNG CHỮ + VOICE REVIEW faceless)' },
    { command: 'remake', description: '🔄 Tạo lại video cảnh chưa ưng ý (VD: /remake 2)' },
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
 * Uses the setMyCommands API — called once on startup with retry.
 */
async function registerBotCommands(botToken, retryCount = 2) {
  const commands = await buildTelegramCommandsFromDrive();
  commands.push({ command: 'start', description: 'Bắt đầu / Xem hướng dẫn' });

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      await axios.post(`https://api.telegram.org/bot${botToken}/setMyCommands`, { commands }, {
        timeout: parseInt(process.env.TELEGRAM_COMMANDS_TIMEOUT_MS || '30000', 10)
      });
      console.log(`[Telegram Bot] ✅ Bot commands registered (${commands.length} command(s), menu buttons ready).`);
      return;
    } catch (err) {
      if (attempt < retryCount) {
        console.warn(`[Telegram Bot] ⚠️ Registering bot commands attempt ${attempt} failed (${err.message}). Retrying in 3s...`);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        console.warn('[Telegram Bot] ⚠️ Could not update Telegram menu button list (network timeout), but bot is still fully active and working normally.');
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
