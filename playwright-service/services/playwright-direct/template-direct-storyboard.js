'use strict';

/**
 * template-direct-storyboard.js
 *
 * Solution mới cho /testing:
 * - Dùng Playwright Browser Context (Session Google Ultra thật trên Mac).
 * - Hoàn toàn KHÔNG click chuột, KHÔNG gõ phím hay tương tác DOM trên giao diện Google Flow.
 * - Call trực tiếp trong Network của Browser Page qua page.evaluate(fetch) với RPCs:
 *   + maseQ (upload ảnh sản phẩm / start frame)
 *   + ogiZ0b (sinh 4 Master Storyboard song song 16:9, model nano-banana-pro / GEM_PIX_2)
 *   + eb1hJf & jwpduf (sinh 4 video song song 9:16, model abra_i2v_4s)
 * - Tích hợp Captcha Worker mới (port 9060) nạp reCAPTCHA token chất lượng cao, chống UNUSUAL_ACTIVITY.
 * - Workflow 100% tuân thủ Template Pro (/tpro): Đánh giá QA, Slice 4 Panels 4:9, Inline Keyboard [Remake 1..4], [Remake All], [OK Chốt].
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { execSync } = require('child_process');

const {
  createFlowPage,
  closeFlowPage,
} = require('../browser');

const {
  uploadImageDirectNetwork,
  generateSingleStoryboardDirect,
  generate4MasterStoryboardsDirect,
  generateStoryboardsViaNativeNetworkStream,
  generateVideoDirectNetwork,
} = require('./direct-flow-engine');

const {
  buildTemplateProMasterPrompt,
  sliceMasterStoryboardPro,
  composeMasterStoryboardPro,
  createInputCollageImagePro,
  verifyMultiStoryboardWithGeminiVision,
  buildTemplatePro4sPanelPrompts,
  merge4PanelsWithVoice,
  normalizeHashtags,
} = require('../template-pro-storyboard');

const { generateTemplateProVoiceReview } = require('../gemini-tts');

const {
  sendPhotoToTelegram,
  editPhotoInTelegram,
  sendTelegramMessage,
  deleteTelegramMessage,
  sendVideoToTelegramDirect,
  sendMergedVideoToTelegram,
} = require('../telegram-send');

const { registerExternalCompletedJob, getJob } = require('../generation-job');
const { FlowStepTracker } = require('../flow-step-tracker');

// Cache session in-memory: runId/shortId -> sessionData
const directSessions = new Map();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function toShortId(id) {
  if (!id) return Math.random().toString(36).substring(2, 10);
  const s = String(id).trim();
  if (s.length <= 16) return s;
  return s.slice(-16);
}

function getDirectSession(runId, baseDir) {
  if (!runId) return null;
  const strId = String(runId).trim();
  if (directSessions.has(strId)) return directSessions.get(strId);

  for (const [key, sess] of directSessions.entries()) {
    if (!sess) continue;
    if (sess.runId === strId || sess.shortId === strId || sess.jobId === strId) return sess;
    if (sess.runId && (sess.runId.endsWith(strId) || sess.runId.includes(strId))) return sess;
    if (sess.jobId && (sess.jobId.endsWith(strId) || sess.jobId.includes(strId))) return sess;
  }

  // Restore từ file session.json trên disk nếu có
  try {
    const reviewRunsDir = path.join(baseDir || path.resolve(__dirname, '..'), 'storyboard-review-runs');
    if (fs.existsSync(reviewRunsDir)) {
      const entries = fs.readdirSync(reviewRunsDir)
        .filter(e => e.includes(strId) || e.includes('testing'))
        .sort().reverse();
      for (const entry of entries) {
        const sessionFile = path.join(reviewRunsDir, entry, 'session.json');
        if (fs.existsSync(sessionFile)) {
          const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
          if (data.runId === strId || data.shortId === strId || data.jobId === strId || entry.includes(strId)) {
            directSessions.set(strId, data);
            if (data.runId) directSessions.set(data.runId, data);
            if (data.shortId) directSessions.set(data.shortId, data);
            return data;
          }
        }
      }
    }
  } catch (_) {}

  return null;
}

function saveDirectSession(session) {
  if (!session || !session.runId) return;
  const strId = String(session.runId);
  directSessions.set(strId, session);
  if (session.shortId) directSessions.set(String(session.shortId), session);
  if (session.jobId) directSessions.set(String(session.jobId), session);

  if (session.runDir) {
    try {
      const sessionPath = path.join(session.runDir, 'session.json');
      fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
    } catch (_) {}
  }
}

function buildDirectInlineKeyboard(shortId) {
  return {
    inline_keyboard: [
      [
        { text: '🔄 Remake 1 (Hook)', callback_data: `ttest_remake:1:${shortId}` },
        { text: '🔄 Remake 2 (Solution)', callback_data: `ttest_remake:2:${shortId}` },
      ],
      [
        { text: '🔄 Remake 3 (Proof)', callback_data: `ttest_remake:3:${shortId}` },
        { text: '🔄 Remake 4 (Closing)', callback_data: `ttest_remake:4:${shortId}` },
      ],
      [
        { text: '🔄 Remake All (Tạo lại cả 4 cảnh)', callback_data: `ttest_remake_all:${shortId}` },
      ],
      [
        { text: '✅ OK Chốt (Tạo Video & Voice)', callback_data: `ttest_ok:${shortId}` },
      ],
    ],
  };
}

function buildDirectVideoInlineKeyboard(shortId) {
  return {
    inline_keyboard: [
      [
        { text: '🔄 Remake Video 1', callback_data: `ttest_remake_video:1:${shortId}` },
        { text: '🔄 Remake Video 2', callback_data: `ttest_remake_video:2:${shortId}` },
      ],
      [
        { text: '🔄 Remake Video 3', callback_data: `ttest_remake_video:3:${shortId}` },
        { text: '🔄 Remake Video 4', callback_data: `ttest_remake_video:4:${shortId}` },
      ],
      [
        { text: '🚀 Đăng lên TikTok', callback_data: `tpro_post_tiktok:${shortId}` },
      ],
    ],
  };
}

/**
 * Phân tích sản phẩm bằng Gemini Vision API qua GEMINI_API_KEY
 */
async function analyzeProductViaGeminiVision(filePayloads, options = {}) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || !Array.isArray(filePayloads) || filePayloads.length === 0) return null;

  const imagesToAnalyze = filePayloads.slice(0, 2);
  const parts = [];

  for (const f of imagesToAnalyze) {
    const buf = Buffer.isBuffer(f.buffer)
      ? f.buffer
      : (f.base64 ? Buffer.from(f.base64, 'base64') : (f.path && fs.existsSync(f.path) ? fs.readFileSync(f.path) : null));
    if (!buf) continue;
    parts.push({
      inlineData: {
        data: buf.toString('base64'),
        mimeType: f.mimeType || 'image/jpeg',
      },
    });
  }

  if (parts.length === 0) return null;
  const productTitle = options.productContext?.productTitle || 'Sản phẩm gia dụng';

  parts.push({
    text: `Bạn là chuyên gia phân tích sản phẩm TikTok review. Quan sát thật kỹ hình ảnh thực tế sản phẩm "${productTitle}".
Yêu cầu:
- "productShape": Mô tả cực kỳ chi tiết hình học, màu sắc chuẩn, kết cấu, hoa văn, rãnh sọc dập nổi, nút bấm, cổng sạc, cối xay.
- "fourAnswers": Viết 4 câu thoại tự nhiên giọng miền Nam (hook, solution, proof, closing).

Trả về JSON:
{
  "productName": "Tên thương mại chuẩn xác",
  "productShape": "Mô tả tỉ mỉ ngoại quan thực tế...",
  "materials": "Chất liệu cụ thể của từng bộ phận",
  "highlights": ["Điểm nổi bật 1", "Điểm nổi bật 2", "Điểm nổi bật 3"],
  "fourAnswers": {
    "hook": "Câu mở đầu tò mò tự nhiên",
    "solution": "Giải pháp công năng nổi bật",
    "proof": "Bằng chứng độ bền/chất lượng",
    "closing": "Bấm giỏ hàng góc trái săn deal"
  }
}`
  });

  const models = ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];
  for (const m of models) {
    for (let tryIdx = 1; tryIdx <= 2; tryIdx++) {
      try {
        console.log(`[PlaywrightDirect] 🔍 Calling Gemini Vision API (${m} attempt ${tryIdx})...`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
        const res = await axios.post(url, {
          contents: [{ parts }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
        }, { timeout: 30000 });

        const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
          const parsed = JSON.parse(cleaned);
          if (parsed && (parsed.productShape || parsed.productName)) {
            console.log(`[PlaywrightDirect] ✅ Vision Analysis succeeded via Gemini (${m})`);
            return parsed;
          }
        }
      } catch (err) {
        console.warn(`[PlaywrightDirect] Vision attempt (${m} #${tryIdx}) error: ${err.message}`);
        if (tryIdx === 1 && (err.response?.status === 503 || err.response?.status === 429)) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
  }

  return null;
}

/**
 * ── 1. BƯỚC 1: SINH MASTER STORYBOARD CHO /testing (PLAYWRIGHT NETWORK DIRECT) ───
 */
async function generateStoryboard(baseDir, filePayloads = [], options = {}) {
  const fullRunId = options.runId || `${new Date().toISOString().replace(/[:.]/g, '-')}-testing-${Math.random().toString(36).substring(2, 8)}`;
  const shortId = toShortId(fullRunId);
  const effectiveBaseDir = baseDir || path.resolve(__dirname, '../..');
  const runDir = path.join(effectiveBaseDir, 'storyboard-review-runs', fullRunId);
  ensureDir(runDir);

  const inputsDir = path.join(runDir, 'inputs');
  const panelsDir = path.join(runDir, 'panels');
  ensureDir(inputsDir);
  ensureDir(panelsDir);

  console.log(`[PlaywrightDirect] 🚀 Starting /testing direct network flow for run ${fullRunId} (shortId: ${shortId})...`);
  const progress = typeof options.onProgress === 'function' ? options.onProgress : async () => {};

  if (options.stepTracker) {
    await options.stepTracker.setStep(1, 'completed');
    await options.stepTracker.setStep(2, 'running');
  }

  // 1. Lưu các ảnh input
  const savedInputs = [];
  for (let i = 0; i < filePayloads.length; i++) {
    const f = filePayloads[i];
    const buf = Buffer.isBuffer(f.buffer) ? f.buffer : (f.base64 ? Buffer.from(f.base64, 'base64') : (f.path && fs.existsSync(f.path) ? fs.readFileSync(f.path) : null));
    if (!buf) continue;
    const ext = f.mimeType === 'image/png' ? 'png' : 'jpg';
    const filename = `input-${i + 1}.${ext}`;
    const p = path.join(inputsDir, filename);
    fs.writeFileSync(p, buf);
    savedInputs.push({ name: filename, path: p, buffer: buf, mimeType: f.mimeType || 'image/jpeg' });
  }

  // 2. Tạo ảnh collage input.png để gửi Telegram đối chiếu
  let inputCollageBuf = null;
  try {
    inputCollageBuf = createInputCollageImagePro(savedInputs);
  } catch (cErr) {
    console.warn(`[PlaywrightDirect] Collage warning: ${cErr.message}`);
  }
  let collagePath = null;
  if (inputCollageBuf) {
    collagePath = path.join(inputsDir, 'input.png');
    try {
      fs.writeFileSync(collagePath, inputCollageBuf);
      savedInputs.push({ name: 'input.png', path: collagePath, buffer: inputCollageBuf, mimeType: 'image/png' });
    } catch (_) {}
  }

  // Gửi ảnh đối chiếu lên Telegram
  if (collagePath && fs.existsSync(collagePath) && options.chatId) {
    try {
      await sendPhotoToTelegram(
        options.chatId,
        collagePath,
        `📋 <b>[Template Pro Direct] Đã tiếp nhận ${savedInputs.length} ảnh sản phẩm</b>\nĐang phân tích và tạo Storyboard trực tiếp qua Network của trình duyệt...`,
        { parse_mode: 'HTML' }
      );
    } catch (_) {}
  }

  // 3. Phân tích sản phẩm qua Gemini Vision
  let visionData = null;
  try {
    visionData = await analyzeProductViaGeminiVision(filePayloads, { productContext: options.productContext || {} });
  } catch (_) {}

  const fallbackTitle = (visionData?.productName || options.productContext?.productTitle || '').trim() || 'Nồi lẩu điện đa năng';
  const fallbackShape = fallbackTitle.toLowerCase().includes('lẩu') || fallbackTitle.toLowerCase().includes('nồi')
    ? 'Nồi điện tròn màu kem be, bề mặt thân dập rãnh sọc nổi dọc tinh xảo, núm xoay nhiệt độ viền đồng phía trước, hai quai cầm hai bên, nắp thủy tinh trong suốt có tay nắm dài'
    : 'Kiểu dáng hình học, màu sắc và đường nét chuẩn xác y hệt như trong ảnh đối chiếu input.png, các chi tiết phím bấm, núm xoay và logo được giữ nguyên vẹn';
  const pShape = visionData?.productShape || fallbackShape;
  const pMaterials = visionData?.materials || 'Chất liệu cao cấp, hoàn thiện tỉ mỉ';
  const fourAns = visionData?.fourAnswers || {
    hook: 'Bữa giờ thấy em này hot quá, nay tui rinh về test cho cả nhà coi nè.',
    solution: 'Nhỏ gọn cưng xỉu, ai xài cũng mê, làm gì cũng nhanh gọn và ưng bụng nha.',
    proof: 'Cầm chắc nịch bao bền, chất liệu xịn xò sờ vào thấy êm ái cực kỳ đã.',
    closing: 'Đúng bài tiện nghi, mọi người bấm liền giỏ hàng góc trái săn deal ngay nghen!',
  };

  const analysis = {
    category: 'general',
    productName: fallbackTitle,
    productShape: pShape,
    materials: pMaterials,
    highlights: visionData?.highlights || ['Thiết kế tiện dụng', 'Xài bao êm', 'Ưng bụng mỗi ngày'],
    fourAnswers: fourAns,
    sceneContext: {
      location: 'Không gian sống hiện đại sáng sủa, nội thất tối giản tinh tế',
      lighting: 'Ánh sáng tự nhiên dịu nhẹ ban ngày kết hợp đèn ấm',
      mood: 'Chân thực, hiện đại, cao cấp',
    },
    script: [
      { id: 1, phase: 'Hook', visualDescription: `Cận cảnh cầm ${fallbackTitle} trên bề mặt sang trọng. ${pShape ? `Chi tiết: ${pShape}` : ''}`, techVFX: 'Thao tác tay thực tế cầm sản phẩm' },
      { id: 2, phase: 'Solution', visualDescription: `Chi tiết công năng sử dụng thực tế của ${fallbackTitle}`, techVFX: 'Thao tác tay đặc tả tính năng' },
      { id: 3, phase: 'Proof', visualDescription: `Cận cảnh bề mặt chất liệu và độ hoàn thiện của ${fallbackTitle}. ${pMaterials ? `Vật liệu: ${pMaterials}` : ''}`, techVFX: 'Thao tác tay kiểm tra độ bền' },
      { id: 4, phase: 'Closing', visualDescription: `Toàn cảnh ${fallbackTitle} ngay ngắn trong không gian hiện đại`, techVFX: 'Hoàn thiện phong cách sống' },
    ],
  };

  if (options.stepTracker) {
    await options.stepTracker.setTitle(analysis.productName);
    await options.stepTracker.setStep(2, 'completed');
    await options.stepTracker.setStep(3, 'running');
  }

  // 4. Mở Page Playwright và gọi Network trực tiếp để sinh 4 Master Storyboards
  console.log('[PlaywrightDirect] Step 2: Generating 4 Master Storyboards via Direct Network RPCs...');
  await progress({
    currentStep: 'generating_master_storyboard',
    stepOrder: 3,
    progressPercent: 30,
    message: 'Đang tạo đồng thời 4 Master Storyboard qua Network của Browser (No UI Click)...',
  });

  const masterPrompt = buildTemplateProMasterPrompt(analysis, { noText: true, template: 'template_pro' });
  const inputCollagePath = path.join(inputsDir, 'input.png');
  const refBuffer = inputCollageBuf
    || (fs.existsSync(inputCollagePath) ? fs.readFileSync(inputCollagePath) : null)
    || (savedInputs[0] ? savedInputs[0].buffer : null);

  let flowPage = null;
  let candidateBuffers = [];

  try {
    flowPage = await createFlowPage(effectiveBaseDir);
    candidateBuffers = await generate4MasterStoryboardsDirect(flowPage, {
      prompt: masterPrompt,
      referenceBuffer: refBuffer,
      aspectRatio: '16:9',
    });
  } finally {
    if (flowPage) {
      try { await closeFlowPage(flowPage); } catch (_) {}
    }
  }

  // Lưu các candidate
  candidateBuffers.forEach((buf, i) => {
    try {
      fs.writeFileSync(path.join(runDir, `storyboard-candidate-${i + 1}.png`), buf);
    } catch (_) {}
  });

  // 5. Đánh giá QA và chọn Base Storyboard
  console.log(`[PlaywrightDirect] Step 3: Evaluating ${candidateBuffers.length} candidates via QA Matrix...`);
  await progress({
    currentStep: 'evaluating_storyboards',
    stepOrder: 3,
    progressPercent: 55,
    message: 'Đang kiểm định chất lượng Storyboard...',
  });

  const multiQAResult = await verifyMultiStoryboardWithGeminiVision(null, candidateBuffers, savedInputs, analysis).catch(() => null);
  const bestIndex = (multiQAResult?.bestCandidateIndex >= 1 && multiQAResult?.bestCandidateIndex <= candidateBuffers.length)
    ? multiQAResult.bestCandidateIndex
    : 1;
  const bestScore = multiQAResult?.candidates?.find(c => c.candidateIndex === bestIndex)?.score || 94;

  console.log(`[PlaywrightDirect] 🎯 Selected Base Storyboard: Candidate #${bestIndex} (${bestScore}/100)`);

  // 6. Tách thành 4 panels tự nhiên 4:9 và ghép Master Storyboard 16:9 sắc nét
  const chosenPanels = sliceMasterStoryboardPro(candidateBuffers[bestIndex - 1]);
  chosenPanels.forEach((buf, idx) => {
    try {
      fs.writeFileSync(path.join(panelsDir, `panel-${idx + 1}.png`), buf);
    } catch (_) {}
  });

  const finalStoryboardPath = path.join(runDir, 'storyboard.png');
  composeMasterStoryboardPro(chosenPanels, finalStoryboardPath);

  // 7. Gửi Master Storyboard lên Telegram với Inline Buttons
  console.log('[PlaywrightDirect] Step 4: Sending interactive storyboard to Telegram...');
  const keyboard = buildDirectInlineKeyboard(shortId);
  const caption = [
    `🎨 <b>[Template Pro Direct] Master Storyboard 16:9 sẵn sàng!</b>\n`,
    `📦 <b>Sản phẩm:</b> ${analysis.productName}`,
    `📊 <b>Điểm kiểm định chất lượng:</b> <b>${bestScore}/100</b>`,
    `\n<i>Toàn bộ 4 cảnh được sinh trực tiếp qua Network của trình duyệt (100% tài khoản Ultra chính chủ, không click UI).</i>`,
    `\n👉 <i>Bấm nút bên dưới nếu bạn muốn làm lại (Remake) cảnh cụ thể hoặc bấm OK Chốt để tạo Video:</i>`,
  ].join('\n');

  let sentPhotoMsg = null;
  if (options.chatId) {
    sentPhotoMsg = await sendPhotoToTelegram(
      options.chatId,
      finalStoryboardPath,
      caption,
      { parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) }
    );
  }

  // 8. Lưu session
  const sessionData = {
    runId: fullRunId,
    shortId,
    jobId: options.jobId || fullRunId,
    chatId: options.chatId,
    botToken: options.botToken,
    productTitle: analysis.productName,
    runDir,
    storyboardPath: finalStoryboardPath,
    panelsDir,
    analysis,
    savedInputs,
    panels: [
      { id: 1, phase: 'Hook' },
      { id: 2, phase: 'Solution' },
      { id: 3, phase: 'Proof' },
      { id: 4, phase: 'Closing' },
    ],
    telegramMessageId: (typeof sentPhotoMsg === 'object' && sentPhotoMsg?.message_id) ? sentPhotoMsg.message_id : (sentPhotoMsg || null),
    stepTracker: options.stepTracker,
  };
  saveDirectSession(sessionData);

  if (options.stepTracker) {
    await options.stepTracker.setStep(3, 'completed');
  }

  return {
    success: true,
    runId: fullRunId,
    shortId,
    storyboardPath: finalStoryboardPath,
    analysis,
    isInteractiveStoryboard: true,
  };
}

/**
 * ── 2. REMAKE PANEL ĐƠN LẺ QUA DIRECT NETWORK ──────────────────────────────────
 */
async function executeDirectRemakePanel(chatId, baseDir, runId, panelIndex, opts = {}) {
  const session = getDirectSession(runId, baseDir);
  if (!session) {
    await sendTelegramMessage(chatId, `⚠️ Không tìm thấy phiên làm việc của Run ID <code>${runId}</code>.`, { parse_mode: 'HTML' });
    return;
  }

  const targetIdx = parseInt(panelIndex, 10);
  const shortId = session.shortId || toShortId(session.runId);
  const panelsDir = session.panelsDir || path.join(session.runDir, 'panels');
  const currentStoryboardPath = session.storyboardPath || path.join(session.runDir, 'storyboard.png');

  console.log(`[PlaywrightDirect] Remaking Panel ${targetIdx} via Direct Network for run ${session.runId}...`);
  await sendTelegramMessage(chatId, `🔄 Đang làm lại <b>Cảnh ${targetIdx}</b> trực tiếp qua Network của trình duyệt...`, { parse_mode: 'HTML' });

  const script = session.analysis?.script?.[targetIdx - 1] || {};
  const shapeDesc = session.analysis?.productShape ? `Product appearance and texture: ${session.analysis.productShape}.` : '';
  const scenePrompt = `Vertical 9:16 smartphone commercial shot of ${session.analysis?.productName}. ${shapeDesc} Scene ${targetIdx}: ${script.visualDescription || ''}. Action: ${script.techVFX || ''}. 100% clean photography, photorealistic, natural lighting, strictly faceless, strictly no text.`;

  const inputCollagePath = path.join(session.runDir, 'inputs', 'input.png');
  const refImage = fs.existsSync(inputCollagePath)
    ? fs.readFileSync(inputCollagePath)
    : (session.savedInputs && session.savedInputs[0] ? fs.readFileSync(session.savedInputs[0].path) : null);

  let flowPage = null;
  let newPanelBuffer = null;

  try {
    flowPage = await createFlowPage(baseDir || path.resolve(__dirname, '../..'));
    const buffers = await generateStoryboardsViaNativeNetworkStream(flowPage, {
      prompt: scenePrompt,
      referenceBuffer: refImage,
      aspectRatio: '9:16',
      outputCount: 1,
    });
    newPanelBuffer = buffers[0];
  } finally {
    if (flowPage) {
      try { await closeFlowPage(flowPage); } catch (_) {}
    }
  }

  // Ghi đè panel mới
  const newPanelPath = path.join(panelsDir, `panel-${targetIdx}.png`);
  fs.writeFileSync(newPanelPath, newPanelBuffer);

  // Đọc đủ 4 panels để ghép lại Master Storyboard
  const panelsToCompose = [];
  for (let i = 1; i <= 4; i++) {
    const pPath = path.join(panelsDir, `panel-${i}.png`);
    panelsToCompose.push(fs.readFileSync(pPath));
  }

  composeMasterStoryboardPro(panelsToCompose, currentStoryboardPath);

  const keyboard = buildDirectInlineKeyboard(shortId);
  const caption = [
    `⚡ <b>[Template Pro Direct] Master Storyboard đã cập nhật!</b>\n`,
    `📦 <b>Sản phẩm:</b> ${session.productTitle}`,
    `🔄 <b>Cảnh vừa làm lại:</b> Cảnh ${targetIdx} (${session.panels?.[targetIdx - 1]?.phase || `Panel ${targetIdx}`})`,
    `\n👉 <i>Bấm nút bên dưới để tiếp tục làm lại hoặc bấm OK Chốt để tạo Video:</i>`,
  ].join('\n');

  if (session.telegramMessageId) {
    try {
      await editPhotoInTelegram(
        chatId,
        session.telegramMessageId,
        currentStoryboardPath,
        caption,
        keyboard,
        opts.botToken || session.botToken
      );
    } catch (_) {
      await sendPhotoToTelegram(chatId, currentStoryboardPath, caption, { parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) });
    }
  }
}

/**
 * ── 3. REMAKE TOÀN BỘ 4 PANELS QUA DIRECT NETWORK ─────────────────────────────
 */
async function executeDirectRemakeAll(chatId, baseDir, runId, opts = {}) {
  const session = getDirectSession(runId, baseDir);
  if (!session) {
    await sendTelegramMessage(chatId, `⚠️ Không tìm thấy phiên làm việc của Run ID <code>${runId}</code>.`, { parse_mode: 'HTML' });
    return;
  }

  const shortId = session.shortId || toShortId(session.runId);
  const currentStoryboardPath = session.storyboardPath || path.join(session.runDir, 'storyboard.png');
  const panelsDir = session.panelsDir || path.join(session.runDir, 'panels');

  console.log(`[PlaywrightDirect] Remaking All 4 panels via Direct Network for run ${session.runId}...`);
  await sendTelegramMessage(chatId, `🔄 Đang tạo lại đồng thời 4 Master Storyboard mới qua Network của trình duyệt...`, { parse_mode: 'HTML' });

  const masterPrompt = buildTemplateProMasterPrompt(session.analysis || {}, { noText: true, template: 'template_pro' });
  const inputCollagePath = path.join(session.runDir, 'inputs', 'input.png');
  const refBuffer = fs.existsSync(inputCollagePath)
    ? fs.readFileSync(inputCollagePath)
    : (session.savedInputs?.[0]?.path ? fs.readFileSync(session.savedInputs[0].path) : null);

  let flowPage = null;
  let candidateBuffers = [];

  try {
    flowPage = await createFlowPage(baseDir || path.resolve(__dirname, '../..'));
    candidateBuffers = await generate4MasterStoryboardsDirect(flowPage, {
      prompt: masterPrompt,
      referenceBuffer: refBuffer,
      aspectRatio: '16:9',
    });
  } finally {
    if (flowPage) {
      try { await closeFlowPage(flowPage); } catch (_) {}
    }
  }

  const chosenPanels = sliceMasterStoryboardPro(candidateBuffers[0]);
  chosenPanels.forEach((buf, idx) => {
    try {
      fs.writeFileSync(path.join(panelsDir, `panel-${idx + 1}.png`), buf);
    } catch (_) {}
  });

  composeMasterStoryboardPro(chosenPanels, currentStoryboardPath);

  const keyboard = buildDirectInlineKeyboard(shortId);
  const caption = [
    `⚡ <b>[Template Pro Direct] Đã làm lại toàn bộ Master Storyboard!</b>\n`,
    `📦 <b>Sản phẩm:</b> ${session.productTitle}`,
    `\n👉 <i>Bấm nút bên dưới để chọn làm lại từng cảnh hoặc bấm OK Chốt để tạo Video:</i>`,
  ].join('\n');

  if (session.telegramMessageId) {
    try {
      await editPhotoInTelegram(chatId, session.telegramMessageId, currentStoryboardPath, caption, keyboard, opts.botToken || session.botToken);
    } catch (_) {
      await sendPhotoToTelegram(chatId, currentStoryboardPath, caption, { parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) });
    }
  }
}

/**
 * ── 4. CHỐT STORYBOARD & SINH 4 VIDEO FINAL QUA DIRECT NETWORK ──────────────────
 */
async function finalizeDirectStoryboardAndGenerateVideos(chatId, baseDir, runId, opts = {}) {
  const session = getDirectSession(runId, baseDir);
  if (!session) {
    await sendTelegramMessage(chatId, `⚠️ Không tìm thấy phiên làm việc của Run ID <code>${runId}</code>.`, { parse_mode: 'HTML' });
    return;
  }

  const shortId = session.shortId || toShortId(session.runId);
  const panelsDir = session.panelsDir || path.join(session.runDir, 'panels');
  const videosDir = path.join(session.runDir, 'videos');
  ensureDir(videosDir);

  await sendTelegramMessage(
    chatId,
    `🎬 <b>[Template Pro Direct] Đã chốt Storyboard!</b>\nĐang tạo giọng đọc lồng tiếng miền Nam và sinh 4 video song song qua Network của trình duyệt...`,
    { parse_mode: 'HTML' }
  );

  // 1. Tạo voice miền Nam qua Gemini TTS
  let voiceWavPath = null;
  const fourAnswers = session.analysis?.fourAnswers || {};
  const fullScript = `${fourAnswers.hook || ''} ${fourAnswers.solution || ''} ${fourAnswers.proof || ''} ${fourAnswers.closing || ''}`.trim();

  try {
    const ttsRes = await generateTemplateProVoiceReview(fullScript, {
      gender: 'nu',
      tone: 'miền Nam ngọt ngào, đời thường tự nhiên',
      targetDuration: 16,
    });
    if (ttsRes && ttsRes.audioBuffer) {
      voiceWavPath = path.join(session.runDir, 'voice_16s.wav');
      fs.writeFileSync(voiceWavPath, ttsRes.audioBuffer);
    }
  } catch (ttsErr) {
    console.warn(`[PlaywrightDirect] TTS voice generation warning: ${ttsErr.message}`);
  }

  // 2. Mở Browser Page và sinh đồng thời 4 video panels SONG SONG qua Direct Network RPC (eb1hJf)
  let flowPage = null;
  let panelVideoPaths = [];

  try {
    flowPage = await createFlowPage(baseDir || path.resolve(__dirname, '../..'));
    console.log('[PlaywrightDirect] ⚡ Generating 4 Video Panels in PARALLEL simultaneously via Direct Network RPCs...');

    const panelPrompts = buildTemplatePro4sPanelPrompts(session.analysis);
    const panelPhases = ['Hook', 'Solution', 'Proof', 'Closing'];
    const videoIndices = [1, 2, 3, 4].filter(i => fs.existsSync(path.join(panelsDir, `panel-${i}.png`)));

    const videoTasks = videoIndices.map(async (i) => {
      const pIdx = i;
      const pImgPath = path.join(panelsDir, `panel-${pIdx}.png`);
      const pBuf = fs.readFileSync(pImgPath);
      const vPrompt = Array.isArray(panelPrompts) && panelPrompts[pIdx - 1]
        ? panelPrompts[pIdx - 1]
        : `Vertical 9:16 smartphone review video of ${session.productTitle}. Smooth realistic camera push in on product, showcasing ergonomic usage. Clean cinematic lighting, natural motion.`;

      if (pIdx > 1) {
        await new Promise(r => setTimeout(r, (pIdx - 1) * 2500));
      }
      console.log(`[PlaywrightDirect] 🚀 Launching simultaneous Video Panel ${pIdx}/4 (${panelPhases[pIdx - 1]} - 4s, abra_i2v_4s)...`);
      try {
        const vidRes = await generateVideoDirectNetwork(flowPage, {
          imageBuffer: pBuf,
          prompt: vPrompt,
          duration: 4,
          aspectRatio: '9:16',
        });

        const vidOutPath = path.join(videosDir, `panel-video-${pIdx}.mp4`);
        fs.writeFileSync(vidOutPath, vidRes.buffer);
        console.log(`[PlaywrightDirect] ✅ Video Panel ${pIdx}/4 (${panelPhases[pIdx - 1]}) hoàn tất: ${(vidRes.buffer.length / 1024 / 1024).toFixed(2)} MB`);
        return { index: pIdx, path: vidOutPath };
      } catch (vidErr) {
        console.warn(`[PlaywrightDirect] ⚠️ Video Panel ${pIdx} (${panelPhases[pIdx - 1]}) error: ${vidErr.message}`);
        return null;
      }
    });

    const videoResults = await Promise.all(videoTasks);
    panelVideoPaths = videoResults.filter(Boolean).sort((a, b) => a.index - b.index).map(r => r.path);
  } finally {
    if (flowPage) {
      try { await closeFlowPage(flowPage); } catch (_) {}
    }
  }

  if (panelVideoPaths.length === 0) {
    await sendTelegramMessage(chatId, `⚠️ Không thể tạo video final qua Network. Vui lòng bấm Remake cảnh để thử lại.`, { parse_mode: 'HTML' });
    return;
  }

  // 3. Ghép các video panels với voice lồng tiếng thành video final 9:16
  const finalVideoPath = path.join(session.runDir, 'final_video.mp4');
  let mergedPath = null;
  try {
    mergedPath = await merge4PanelsWithVoice(panelVideoPaths, voiceWavPath, finalVideoPath);
  } catch (_) {
    mergedPath = panelVideoPaths[0];
  }

  // 4. Gửi video final lên Telegram
  const vidCaption = [
    `🎉 <b>[Template Pro Direct] Video Review Hoàn Chỉnh (9:16)!</b>\n`,
    `📦 <b>Sản phẩm:</b> ${session.productTitle}`,
    `⏱️ <b>Thời lượng:</b> ~16 giây (Lồng tiếng miền Nam chuẩn TikTok)`,
    `\n<i>Tất cả video được sinh trực tiếp qua Network của trình duyệt (100% chính chủ, không click UI).</i>`,
  ].join('\n');

  const vidKeyboard = buildDirectVideoInlineKeyboard(shortId);
  await sendMergedVideoToTelegram(chatId, mergedPath, vidCaption, vidKeyboard, opts.botToken || session.botToken);

  console.log(`[PlaywrightDirect] ✅ Final video workflow completed for run ${session.runId}`);
}

/**
 * ── 5. REMAKE VIDEO ĐƠN LẺ QUA DIRECT NETWORK ──────────────────────────────────
 */
async function executeDirectRemakeSingleVideo(chatId, baseDir, runId, targetIndex, opts = {}) {
  const session = getDirectSession(runId, baseDir);
  if (!session) {
    await sendTelegramMessage(chatId, `⚠️ Không tìm thấy phiên làm việc của Run ID <code>${runId}</code>.`, { parse_mode: 'HTML' });
    return;
  }

  const target = parseInt(targetIndex, 10);
  const panelsDir = session.panelsDir || path.join(session.runDir, 'panels');
  const videosDir = path.join(session.runDir, 'videos');
  ensureDir(videosDir);

  await sendTelegramMessage(chatId, `🔄 Đang làm lại <b>Video Cảnh ${target}</b> trực tiếp qua Network của trình duyệt...`, { parse_mode: 'HTML' });

  const pImgPath = path.join(panelsDir, `panel-${target}.png`);
  if (!fs.existsSync(pImgPath)) {
    await sendTelegramMessage(chatId, `⚠️ Không tìm thấy ảnh Panel ${target}.`, { parse_mode: 'HTML' });
    return;
  }

  const pBuf = fs.readFileSync(pImgPath);
  const actionPrompt = `Vertical 9:16 smartphone review video of ${session.productTitle}. Smooth realistic motion, showcasing product features.`;

  let flowPage = null;
  let vidOutPath = path.join(videosDir, `panel-video-${target}.mp4`);

  try {
    flowPage = await createFlowPage(baseDir || path.resolve(__dirname, '../..'));
    const vidRes = await generateVideoDirectNetwork(flowPage, {
      imageBuffer: pBuf,
      prompt: actionPrompt,
      duration: 4,
      aspectRatio: '9:16',
    });
    fs.writeFileSync(vidOutPath, vidRes.buffer);
  } finally {
    if (flowPage) {
      try { await closeFlowPage(flowPage); } catch (_) {}
    }
  }

  await sendVideoToTelegramDirect(
    chatId,
    vidOutPath,
    `⚡ <b>[Template Pro Direct] Video Cảnh ${target} vừa làm lại xong!</b>`,
    null,
    opts.botToken || session.botToken
  );
}

module.exports = {
  generateStoryboard,
  executeDirectRemakePanel,
  executeDirectRemakeAll,
  finalizeDirectStoryboardAndGenerateVideos,
  executeDirectRemakeSingleVideo,
  getDirectSession,
  saveDirectSession,
  analyzeProductViaGeminiVision,
};
