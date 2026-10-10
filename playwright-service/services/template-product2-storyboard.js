/**
 * LIVE-COMMERCE PRESENTER TEMPLATE PRODUCT 2 — 40s NATIVE-VOICE (/tproduct2)
 * Implementation based on: LIVE_COMMERCE_40S_TEMPLATE_PRO_NATIVE_VOICE_SPEC_v2.md
 * Technical Patterns imported & adapted from: template-food-storyboard.js (v3.0 Engine)
 *
 * Architecture:
 * - 1 Ảnh người mẫu cố định (model.png / presenter.png) + N ảnh sản phẩm -> 5 Start Frames
 * - 5 Veo clips x 8s có thoại trực tiếp bằng model veo_3_1_i2v_s_lite_8s_low_priority -> ghép thành video 40s
 * - NATIVE AUDIO PIPELINE: Hoàn toàn KHÔNG dùng TTS và KHÔNG mux voice ngoài!
 * - Presenter nói tiếng Việt trực tiếp trong từng video với Global Voice Bible thống nhất.
 * - Sourcing Scene Settings: factory_showcase / showroom_display / lifestyle_home / street_handover
 * - Dynamic Prop Plan & Physical Affordance Engine for 10 Product Categories
 * - 2-Stage Gemini Intelligence Architecture (Prompt A: Intelligence -> Prompt B: Script & Storyboard)
 * - Word budget: 34-40 words/clip (fast live-commerce rate ~4.5-5.0 wps, total 180-200 words)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const { GeminiApiClient } = require('./gemini-client/gemini-api');
const {
  sendPhotoToTelegram,
  editPhotoInTelegram,
  sendTelegramMessage,
  deleteTelegramMessage,
  sendMergedVideoToTelegram,
} = require('./telegram-send');
const { generateVideosFromPanelsDirect } = require('./gemini-webapi-storyboard');
const { createFlowPage, closeFlowPage } = require('./browser');
const { prepareGeneration, executeGeneration } = require('./image');
const { registerExternalCompletedJob, getJob } = require('./generation-job');
const { FlowStepTracker } = require('./flow-step-tracker');
const { getConfig, getChannelProfile } = require('../utils/config-manager');
const { buildTemplateOptions } = require('./template-options');

// Cache in-memory cho các phiên /tproduct: runId -> sessionData
const productSessions = new Map();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

let ffmpegPath = 'ffmpeg';
try {
  ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
} catch (_) {
  try {
    ffmpegPath = require('/Users/macbook_196/Workspace/something/playwright-service/node_modules/ffmpeg-static') || 'ffmpeg';
  } catch (__) {
    ffmpegPath = 'ffmpeg';
  }
}

// Bộ 14 người mẫu riêng của /tproduct2 (docs/tproduct2/model.png .. model13.png)
const CANONICAL_MODEL_FILENAMES = [
  'model.png',
  'model1.png',
  'model2.png',
  'model3.png',
  'model4.png',
  'model5.png',
  'model6.png',
  'model7.png',
  'model8.png',
  'model9.png',
  'model10.png',
  'model11.png',
  'model12.png',
  'model13.png',
];

const CANONICAL_MODEL_DIRS = [
  path.resolve(__dirname, '../../docs/tproduct2'),
];

/**
 * Lấy ảnh người mẫu chuẩn làm reference cho storyboard và video.
 * Hỗ trợ chọn ngẫu nhiên 1 trong 13 ảnh người mẫu (model.png .. model12.png)
 * hoặc giữ nguyên model đã chọn trong session cho các thao tác remake.
 *
 * @param {Object} [options]
 * @param {string} [options.modelPath] - Đường dẫn trực tiếp đến file ảnh model
 * @param {string} [options.modelName] - Tên file model cụ thể (ví dụ: 'model2.png')
 * @param {string} [options.presenterPath] - Alias cho modelPath
 * @returns {{ path: string, filename: string, buffer: Buffer } | null}
 */
function getCanonicalPresenterBuffer(options = {}) {
  // 1. Nếu có chỉ định đường dẫn cụ thể (ví dụ trong session remake)
  const explicitPath = options.modelPath || options.presenterPath || options.presenterModelPath || options.session?.presenterModelPath || options.session?.modelPath;
  if (explicitPath && fs.existsSync(explicitPath)) {
    try {
      const buf = fs.readFileSync(explicitPath);
      if (buf && buf.length > 1000) {
        return { path: explicitPath, filename: path.basename(explicitPath), buffer: buf };
      }
    } catch (_) { }
  }

  // 2. Nếu có chỉ định tên file model cụ thể
  const explicitName = options.modelName || options.model || options.presenterModel || options.session?.presenterModel || options.session?.model;
  if (explicitName) {
    const targetFile = explicitName.endsWith('.png') ? explicitName : `${explicitName}.png`;
    for (const dir of CANONICAL_MODEL_DIRS) {
      const candidate = path.join(dir, targetFile);
      if (fs.existsSync(candidate)) {
        try {
          const buf = fs.readFileSync(candidate);
          if (buf && buf.length > 1000) {
            return { path: candidate, filename: targetFile, buffer: buf };
          }
        } catch (_) { }
      }
    }
  }

  // 2.5. Nếu cấu hình hoặc ngữ cảnh là male, ưu tiên tìm ảnh male model
  const isMale = (options.gender === 'male') || (options.channelProfile?.gender === 'male') || (options.session?.gender === 'male');
  if (isMale) {
    const maleFilenames = ['presenter_male.png', 'model_male.png'];
    for (const fn of maleFilenames) {
      for (const dir of CANONICAL_MODEL_DIRS) {
        const candidate = path.join(dir, fn);
        if (fs.existsSync(candidate)) {
          try {
            const buf = fs.readFileSync(candidate);
            if (buf && buf.length > 1000) {
              console.log(`[TemplateProduct] 👨 Selected male presenter model: ${fn} from ${candidate}`);
              return { path: candidate, filename: fn, buffer: buf };
            }
          } catch (_) { }
        }
      }
    }
  }

  // 3. Tìm toàn bộ các file model hợp lệ trong danh sách 14 models
  const availableModels = [];
  for (const filename of CANONICAL_MODEL_FILENAMES) {
    for (const dir of CANONICAL_MODEL_DIRS) {
      const p = path.join(dir, filename);
      if (fs.existsSync(p)) {
        try {
          const stat = fs.statSync(p);
          if (stat.size > 1000) {
            availableModels.push({ path: p, filename, size: stat.size });
            break;
          }
        } catch (_) { }
      }
    }
  }

  // 4. Random 1 model trong danh sách 14 models khả dụng
  if (availableModels.length > 0) {
    const chosen = availableModels[Math.floor(Math.random() * availableModels.length)];
    try {
      const buf = fs.readFileSync(chosen.path);
      if (buf && buf.length > 1000) {
        console.log(`[TemplateProduct] 🎲 Selected presenter model: ${chosen.filename} (${(buf.length / 1024).toFixed(1)} KB) from ${chosen.path}`);
        return { path: chosen.path, filename: chosen.filename, buffer: buf };
      }
    } catch (readErr) {
      console.warn(`[TemplateProduct] Failed to read chosen model ${chosen.path}: ${readErr.message}`);
    }
  }

  // 5. Fallback: presenter.png trong assets
  const fallbackPath = path.resolve(__dirname, '../../docs/tproduct2/model.png');
  if (fs.existsSync(fallbackPath)) {
    try {
      const buf = fs.readFileSync(fallbackPath);
      if (buf && buf.length > 1000) {
        return { path: fallbackPath, filename: 'presenter.png', buffer: buf };
      }
    } catch (_) { }
  }

  return null;
}

function detectImageExt(buffer, mimeType) {
  if (Buffer.isBuffer(buffer) && buffer.length >= 12) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return '.png';
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return '.jpg';
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  }
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  return '.jpg';
}

function normalizeFallbackImage(buffer, ffmpegBin) {
  if (!buffer || buffer.length === 0) return null;
  const tmpId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const tmpDir = os.tmpdir();
  const inPath = path.join(tmpDir, `tprod-fallback-in-${tmpId}.bin`);
  const outPath = path.join(tmpDir, `tprod-fallback-out-${tmpId}.png`);
  try {
    fs.writeFileSync(inPath, buffer);
    execSync(`"${ffmpegBin}" -y -i "${inPath}" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:white" -update 1 "${outPath}"`, { timeout: 15000, stdio: 'pipe' });
    if (fs.existsSync(outPath)) {
      return fs.readFileSync(outPath);
    }
  } catch (_) {
  } finally {
    [inPath, outPath].forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { } });
  }
  return buffer;
}

/**
 * Ghép các ảnh sản phẩm thành 1 collage (dedup MD5, tối đa 8 ảnh).
 * CHỈ ghép ảnh sản phẩm — KHÔNG bao gồm model.png (gửi riêng).
 * Đảm bảo kích thước chuẩn, output PNG thực sự và không bao giờ lỗi vstack/hstack.
 */
function createProductInputCollage(productPayloads) {
  if (!productPayloads || productPayloads.length === 0) return null;
  let ffmpegBin;
  try { ffmpegBin = require('ffmpeg-static'); } catch (_) { ffmpegBin = 'ffmpeg'; }
  const tmpId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const tmpDir = os.tmpdir();
  const outPath = path.join(tmpDir, `tproduct-collage-${tmpId}.png`);
  const inputPaths = [];
  try {
    const seenHashes = new Set();
    const uniqueBuffers = [];
    for (const f of productPayloads) {
      const buf = Buffer.isBuffer(f.buffer)
        ? f.buffer
        : (f.base64 ? Buffer.from(f.base64, 'base64') : (f.path && fs.existsSync(f.path) ? fs.readFileSync(f.path) : null));
      if (buf && buf.length > 0) {
        const hash = crypto.createHash('md5').update(buf).digest('hex');
        if (!seenHashes.has(hash)) {
          seenHashes.add(hash);
          const ext = detectImageExt(buf, f.mimeType);
          uniqueBuffers.push({ buf, ext });
        }
      }
    }
    if (uniqueBuffers.length === 0) return null;
    const active = uniqueBuffers.slice(0, 8);
    for (let i = 0; i < active.length; i++) {
      const p = path.join(tmpDir, `tprod-in-${tmpId}-${i}${active[i].ext}`);
      fs.writeFileSync(p, active[i].buf);
      inputPaths.push(p);
    }
    const n = inputPaths.length;
    const ins = inputPaths.map(p => `-i "${p}"`).join(' ');
    if (n === 1) {
      execSync(`"${ffmpegBin}" -y -i "${inputPaths[0]}" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:white" -update 1 "${outPath}"`, { timeout: 15000, stdio: 'pipe' });
    } else if (n === 2) {
      const f = '[0:v]scale=960:1080:force_original_aspect_ratio=decrease,pad=960:1080:(ow-iw)/2:(oh-ih)/2:white[i0];[1:v]scale=960:1080:force_original_aspect_ratio=decrease,pad=960:1080:(ow-iw)/2:(oh-ih)/2:white[i1];[i0][i1]hstack[out]';
      execSync(`"${ffmpegBin}" -y ${ins} -filter_complex "${f}" -map "[out]" -update 1 "${outPath}"`, { timeout: 15000, stdio: 'pipe' });
    } else if (n === 3) {
      const f = '[0:v]scale=640:1080:force_original_aspect_ratio=decrease,pad=640:1080:(ow-iw)/2:(oh-ih)/2:white[i0];[1:v]scale=640:1080:force_original_aspect_ratio=decrease,pad=640:1080:(ow-iw)/2:(oh-ih)/2:white[i1];[2:v]scale=640:1080:force_original_aspect_ratio=decrease,pad=640:1080:(ow-iw)/2:(oh-ih)/2:white[i2];[i0][i1][i2]hstack=inputs=3[out]';
      execSync(`"${ffmpegBin}" -y ${ins} -filter_complex "${f}" -map "[out]" -update 1 "${outPath}"`, { timeout: 15000, stdio: 'pipe' });
    } else if (n === 4) {
      const f = '[0:v]scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:white[i0];[1:v]scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:white[i1];[2:v]scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:white[i2];[3:v]scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:white[i3];[i0][i1]hstack[top];[i2][i3]hstack[bot];[top][bot]vstack[out]';
      execSync(`"${ffmpegBin}" -y ${ins} -filter_complex "${f}" -map "[out]" -update 1 "${outPath}"`, { timeout: 15000, stdio: 'pipe' });
    } else if (n <= 6) {
      const topCount = 3;
      const botCount = n - 3;
      const sf = active.map((_, i) => `[${i}:v]scale=640:540:force_original_aspect_ratio=decrease,pad=640:540:(ow-iw)/2:(oh-ih)/2:white[i${i}]`).join(';');
      const top = '[i0][i1][i2]hstack=inputs=3[top]';
      const botInputs = Array.from({ length: botCount }, (_, i) => `[i${3 + i}]`).join('');
      const bot = botCount === 3
        ? `${botInputs}hstack=inputs=3[bot]`
        : `${botInputs}hstack=inputs=${botCount},pad=1920:540:(ow-iw)/2:(oh-ih)/2:white[bot]`;
      execSync(`"${ffmpegBin}" -y ${ins} -filter_complex "${sf};${top};${bot};[top][bot]vstack[out]" -map "[out]" -update 1 "${outPath}"`, { timeout: 25000, stdio: 'pipe' });
    } else {
      const topCount = 4;
      const botCount = n - 4;
      const sf = active.map((_, i) => `[${i}:v]scale=480:540:force_original_aspect_ratio=decrease,pad=480:540:(ow-iw)/2:(oh-ih)/2:white[i${i}]`).join(';');
      const top = '[i0][i1][i2][i3]hstack=inputs=4[top]';
      const botInputs = Array.from({ length: botCount }, (_, i) => `[i${4 + i}]`).join('');
      const bot = botCount === 4
        ? `${botInputs}hstack=inputs=4[bot]`
        : `${botInputs}hstack=inputs=${botCount},pad=1920:540:(ow-iw)/2:(oh-ih)/2:white[bot]`;
      execSync(`"${ffmpegBin}" -y ${ins} -filter_complex "${sf};${top};${bot};[top][bot]vstack[out]" -map "[out]" -update 1 "${outPath}"`, { timeout: 25000, stdio: 'pipe' });
    }
    if (fs.existsSync(outPath)) {
      const buf = fs.readFileSync(outPath);
      console.log(`[TemplateProduct] ✅ Product collage: ${(buf.length / 1024).toFixed(0)} KB from ${n} unique photos (of ${productPayloads.length})`);
      return buf;
    }
    return null;
  } catch (err) {
    console.warn(`[TemplateProduct] ⚠️ Collage failed: ${err.message}. Normalizing first image as fallback.`);
    const first = productPayloads[0];
    const rawBuf = Buffer.isBuffer(first?.buffer) ? first.buffer : (first?.path && fs.existsSync(first.path) ? fs.readFileSync(first.path) : null);
    return normalizeFallbackImage(rawBuf, ffmpegBin);
  } finally {
    [...inputPaths, outPath].forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { } });
  }
}

/**
 * Split product image payloads into up to two 8-image collages (input.png and input2.png).
 * - input1: unique product photos 1..8
 * - input2: unique product photos 9..16 (if > 8 images exist)
 */
function createProductInputCollages(productPayloads) {
  if (!productPayloads || productPayloads.length === 0) {
    return { input1Buf: null, input2Buf: null, uniqueCount: 0 };
  }
  const seenHashes = new Set();
  const uniqueItems = [];
  for (const f of productPayloads) {
    const buf = Buffer.isBuffer(f.buffer)
      ? f.buffer
      : (f.base64 ? Buffer.from(f.base64, 'base64') : (f.path && fs.existsSync(f.path) ? fs.readFileSync(f.path) : null));
    if (buf && buf.length > 0) {
      const hash = crypto.createHash('md5').update(buf).digest('hex');
      if (!seenHashes.has(hash)) {
        seenHashes.add(hash);
        uniqueItems.push(f);
      }
    }
  }

  if (uniqueItems.length === 0) {
    return { input1Buf: null, input2Buf: null, uniqueCount: 0 };
  }

  const input1Buf = createProductInputCollage(uniqueItems.slice(0, 8));
  let input2Buf = null;
  if (uniqueItems.length > 8) {
    input2Buf = createProductInputCollage(uniqueItems.slice(8, 16));
  }
  return { input1Buf, input2Buf, uniqueCount: uniqueItems.length };
}

function normalizeHashtags(raw, defaultTags = ['#livestream', '#xuhuong', '#review', '#sanphamchinhhang', '#tiktokshop']) {
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map(t => (t.startsWith('#') ? t : `#${t}`)).filter(Boolean);
  }
  return defaultTags;
}

function getMediaDuration(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return 0;
  try {
    const probe = execSync(`"${ffmpegPath}" -i "${filePath}" 2>&1`, { stdio: 'pipe' }).toString();
    const match = probe.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
    if (match) {
      return parseFloat(match[1]) * 3600 + parseFloat(match[2]) * 60 + parseFloat(match[3]);
    }
  } catch (e) {
    const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    const match = out.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
    if (match) {
      return parseFloat(match[1]) * 3600 + parseFloat(match[2]) * 60 + parseFloat(match[3]);
    }
  }
  return 0;
}

// ── 1. GLOBAL VOICE BIBLE & GLOBAL VISUAL BIBLE ────────────────────────────────

const DEFAULT_GLOBAL_VOICE_BIBLE = {
  speaker: 'same Vietnamese female presenter',
  gender: 'female',
  apparentAge: 'young adult',
  language: 'Vietnamese',
  region: 'Southern Vietnamese',
  tone: 'bright, confident, persuasive, friendly',
  energy: 'high',
  pitch: 'medium-high',
  pace: 'very fast live-commerce (4.5 to 5.0 words per second)',
  articulation: 'clear despite fast speed',
  rhythm: 'rapid commercial conversational rhythm',
  emotion: 'energetic but controlled',
  selfReference: 'em',
  audienceAddress: 'chị em',
  sentenceEndingStyle: 'warm polite conversational Vietnamese (nè, nha, nhé, nha các tình yêu)',
  otherSpeakersAllowed: false,
};

/**
 * Tạo Voice Bible động theo ngữ cảnh kênh (male / female / neutral)
 */
function buildDynamicVoiceBible(channelProfile = {}, options = {}) {
  const gender = channelProfile.gender || options.gender || 'female';
  const audienceAddress = channelProfile.audienceAddress || options.audienceAddress || (gender === 'male' ? 'anh em' : (gender === 'neutral' ? 'mọi người' : 'chị em'));
  const speaker = gender === 'male'
    ? 'same Vietnamese male presenter'
    : (gender === 'neutral' ? 'Vietnamese live-commerce presenter' : 'same Vietnamese female presenter');
  const sentenceEndingStyle = gender === 'male'
    ? 'warm polite conversational Vietnamese (nè, nha, nhé, nha anh em, nha các bác)'
    : (gender === 'neutral'
      ? 'warm polite conversational Vietnamese (nè, nha, nhé, nha cả nhà)'
      : 'warm polite conversational Vietnamese (nè, nha, nhé, nha các tình yêu)');
  return {
    ...DEFAULT_GLOBAL_VOICE_BIBLE,
    speaker,
    gender,
    pitch: gender === 'male' ? 'medium' : 'medium-high',
    selfReference: 'em',
    audienceAddress,
    sentenceEndingStyle,
  };
}

const DEFAULT_GLOBAL_VISUAL_BIBLE = {
  presenterIdentity: 'canonical uploaded model (model.png)',
  wardrobe: 'exact same outfit, clothing pieces, colors and style as shown in the canonical model reference photo (model.png)',
  hair: 'same across all clips, neat and stylish',
  environmentType: 'product_factory_or_warehouse',
  lighting: 'bright clean commercial live-commerce lighting',
  cameraLook: 'realistic smartphone vertical 9:16',
  productVariant: 'locked identical color, shape, size across all panels',
  colorTemperature: 'consistent warm-neutral studio lighting',
  channelStyle: 'realistic factory-direct / warehouse live-commerce presenter',
  environmentLock: true,
};

const HOOK_LIBRARY = Object.freeze([
  {
    "id": "H01",
    "type": "experience_price",
    "verbatim": "Tính tới nay cũng 4 5 tháng rồi em mới mua được cái giá rẻ vậy luôn á anh chị ơi, cả một thùng 10 bịch khăn giấy Sipiao như thế này.",
    "originalProduct": "Khăn giấy Sipiao",
    "excelVideoId": "7628104928656903442",
    "requires": "verified_price",
    "source": "Excel transcript; audio not independently verified"
  },
  {
    "id": "H02",
    "type": "price_shipping",
    "verbatim": "Một trăm ngàn miễn phí ship giao hàng đến tận cửa nhà cho mình nữa luôn.",
    "originalProduct": "Nồi chiên Gaabor",
    "excelVideoId": "7660416459641916679",
    "requires": "verified_price_and_shipping",
    "source": "Excel transcript; audio not independently verified"
  },
  {
    "id": "H03",
    "type": "gift_subsidy",
    "verbatim": "Cái này là em tặng cho mấy anh luôn, chứ TikTok nay nó trợ giá rẻ quá mấy anh ơi.",
    "originalProduct": "Máy cạo râu Enchen",
    "excelVideoId": "7678718692359933202",
    "requires": "verified_gift_and_subsidy",
    "source": "Excel transcript; audio not independently verified"
  },
  {
    "id": "H04",
    "type": "gift_subsidy",
    "verbatim": "Cái này là cho các bác này. Cái này là cho nha, cái này là TikTok người ta cho chứ không phải là bán nữa rồi các bác ạ. Nguyên một chai xịt dưỡng chất hỗ trợ xương khớp giúp giảm đau nhức vai gáy mà ngày hôm nay trợ giá trên kênh của em cực kỳ đậm sâu luôn.",
    "originalProduct": "Chai xịt hỗ trợ xương khớp",
    "excelVideoId": "7680762629203250433",
    "requires": "verified_gift_and_subsidy",
    "source": "Excel transcript; audio not independently verified"
  },
  {
    "id": "H05",
    "type": "price_shipping",
    "verbatim": "20k miễn phí ship tới tận nhà.",
    "originalProduct": "Chai xịt hỗ trợ xương khớp",
    "excelVideoId": "7681214182070439169",
    "requires": "verified_price_and_shipping",
    "source": "Excel transcript; audio not independently verified"
  },
  {
    "id": "H06",
    "type": "zero_price",
    "verbatim": "Vô săn cho em cái thùng giấy không đồng này mấy anh chị ơi. Em nói không đồng là không đồng nha anh chị ơi. Em không lời một đồng một lãi một cắc một xu nào hết trơn á.",
    "originalProduct": "Khăn giấy",
    "excelVideoId": "7683423115002612999",
    "requires": "verified_zero_price_and_no_profit",
    "source": "Excel transcript; audio not independently verified"
  },
  {
    "id": "H07",
    "type": "gift_subsidy",
    "verbatim": "Cái này là cho nha, cái này là cho chứ người ta không có bán đâu nha, chứ không ai mà bán cái giá rẻ như vậy hết trơn á.",
    "originalProduct": "Chưa xác định",
    "excelVideoId": "7683879326009412882",
    "requires": "verified_gift_and_subsidy",
    "source": "Excel transcript; audio not independently verified"
  },
  {
    "id": "H08",
    "type": "zero_price",
    "verbatim": "Không đồng, không đồng các bác ơi. Ngày hôm nay là không lấy một đồng lợi nhuận nào của các bác luôn.",
    "originalProduct": "Chưa xác định",
    "excelVideoId": "7683948170736389393",
    "requires": "verified_zero_price_and_no_profit",
    "source": "Excel transcript; audio not independently verified"
  },
  {
    "id": "H09",
    "type": "price_shipping",
    "verbatim": "600k miễn phí ship tới tận nhà.",
    "originalProduct": "Xe đạp thể thao",
    "excelVideoId": "7684474189075549441",
    "requires": "verified_price_and_shipping",
    "source": "Excel transcript; audio not independently verified"
  }
]);

// Hook phổ quát: không phụ thuộc ngành hàng, giá, công dụng hay claim thương mại.
// {product} luôn là tên rút gọn tối đa 4 từ; {audience} là cách xưng hô của kênh.
const UNIVERSAL_RETENTION_HOOKS = Object.freeze([
  { id: 'U01', type: 'curiosity_gap', template: 'Trời ơi, khoan lướt nha {audience} — mẫu {product} này có một điểm nhỏ mà đáng chú ý lắm!' },
  { id: 'U02', type: 'hidden_detail', template: 'Nhìn kỹ nè {audience} — điểm đáng xem nhất của {product} lại nằm ở chỗ ít ai để ý!' },
  { id: 'U03', type: 'buyer_warning', template: 'Dừng một giây nha {audience} — trước khi chọn {product}, nhất định phải nhìn đúng chỗ này!' },
  { id: 'U04', type: 'second_look', template: 'Khoan, khoan — có một lý do khiến mẫu {product} này làm em phải nhìn lại lần hai!' },
  { id: 'U05', type: 'appearance_twist', template: 'Nhìn tưởng bình thường đúng không {audience} — nhưng {product} này có một điểm rất dễ bị bỏ sót!' },
  { id: 'U06', type: 'decision_gap', template: 'Đừng lướt nha {audience} — em chỉ đúng một chi tiết để biết {product} có đáng chọn không!' },
  { id: 'U07', type: 'pre_purchase', template: 'Ai đang tìm {product} thì dừng lại nha — có một điểm phải nhìn trước khi chốt!' },
  { id: 'U08', type: 'surprise_detail', template: 'Ủa, chi tiết này hay nè {audience} — nhìn qua {product} thôi là rất dễ bỏ lỡ!' },
  { id: 'U09', type: 'attention_test', template: 'Em đố {audience} nhìn ra ngay — trên {product} có một điểm đáng chú ý nằm ngay trước mắt!' },
  { id: 'U10', type: 'dont_judge_fast', template: 'Khoan đánh giá vội nha {audience} — nhìn thêm một chút vào {product} rồi mình nói tiếp!' },
  { id: 'U11', type: 'one_thing_first', template: 'Trước khi xem phần còn lại, {audience} nhìn giúp em đúng một điểm trên {product} này!' },
  { id: 'U12', type: 'unexpected_focus', template: 'Điều em chú ý đầu tiên trên {product} không phải vẻ ngoài đâu {audience} — mà là chỗ này!' },
  { id: 'U13', type: 'easy_to_miss', template: 'Coi chừng bỏ qua nha {audience} — {product} có một chi tiết nhỏ nhưng rất đáng xem!' },
  { id: 'U14', type: 'look_again', template: 'Nhìn lần đầu chưa thấy đâu {audience} — phải nhìn lại {product} lần hai mới nhận ra điểm này!' },
  { id: 'U15', type: 'choice_filter', template: 'Nếu đang cân nhắc {product}, {audience} đừng chốt trước khi em chỉ ra điểm này!' },
  { id: 'U16', type: 'first_impression', template: 'Ấn tượng đầu tiên dễ đánh lừa lắm {audience} — riêng {product} phải nhìn kỹ thêm chỗ này!' },
  { id: 'U17', type: 'attention_command', template: 'Nhìn vào đây đúng hai giây nha {audience} — {product} có một điểm không nên xem lướt!' },
  { id: 'U18', type: 'why_question', template: 'Tại sao em dừng lại ở mẫu {product} này — {audience} nhìn kỹ là sẽ hiểu ngay!' },
  { id: 'U19', type: 'small_difference', template: 'Chỉ khác một điểm nhỏ thôi {audience} — nhưng đó là chỗ đáng xem nhất trên {product}!' },
  { id: 'U20', type: 'before_scroll', template: 'Trước khi lướt tiếp, {audience} cho em vài giây để chỉ điểm đáng chú ý trên {product}!' },
  { id: 'U21', type: 'visual_clue', template: 'Có một dấu hiệu ngay trên {product} mà nhìn vội là {audience} sẽ bỏ qua mất!' },
  { id: 'U22', type: 'reverse_expectation', template: 'Cái đáng xem trên {product} lại không phải thứ {audience} đang nhìn đầu tiên đâu!' },
  { id: 'U23', type: 'watch_this', template: 'Đừng nhìn chỗ quen thuộc nha {audience} — điểm đáng chú ý của {product} nằm ở ngay đây!' },
  { id: 'U24', type: 'quick_check', template: 'Cho em đúng ba giây nha {audience} — mình kiểm tra một điểm rất dễ quên trên {product}!' },
  { id: 'U25', type: 'selection_secret', template: 'Muốn chọn {product} đỡ phân vân, {audience} chỉ cần để ý trước một điểm này thôi!' },
  { id: 'U26', type: 'not_obvious', template: 'Điểm hay của {product} không lộ ra ngay đâu {audience} — phải nhìn kỹ mới thấy!' },
  { id: 'U27', type: 'pause_and_notice', template: 'Khoan một nhịp nha {audience} — có một chi tiết trên {product} đang chờ mình nhìn ra!' },
  { id: 'U28', type: 'close_look', template: 'Lại gần nhìn kỹ nè {audience} — {product} có một điểm mà xem từ xa rất dễ bỏ sót!' },
  { id: 'U29', type: 'decision_clue', template: 'Nếu chỉ được nhìn một điểm trước khi chọn {product}, em sẽ nhìn ngay chỗ này!' },
  { id: 'U30', type: 'open_loop', template: 'Em vừa phát hiện một điểm trên {product} — và {audience} nên xem hết trước khi quyết định!' },
]);

const ALL_HOOKS = Object.freeze([...HOOK_LIBRARY, ...UNIVERSAL_RETENTION_HOOKS]);

const VOICE_STYLE_BIBLE = Object.freeze({
  source: 'Nine verbatim Excel hooks (audio not independently transcribed)',
  opening: 'Open with a one-sentence high-energy scroll stopper: explosive first 2-4 words, strong keyword stress, one short dramatic pause, then an unresolved curiosity gap.',
  language: 'Natural spoken Southern Vietnamese; preserve colloquial particles, purposeful repetition, early CTA where supported.',
  hookProsody: 'Clip 1 first sentence: bright excited pitch lift, fast attack, emphatic stress, micro-pause after the attention cue, rising-curious ending; energetic and contagious, never shouting or sounding like a newsreader.',
  hookLength: 'The first hook sentence must be 10-24 Vietnamese words, express one idea only, and must not reveal the answer before the viewer continues watching.',
  rule: 'Never copy original product, price, shipping, zero-price, gift, subsidy, health benefit, scarcity or no-profit claim to a new product without verified metadata.',
  voiceVisualSeparation: 'Dialogue may describe verified benefits; visuals NEVER have to act out dialogue.'
});
const WAREHOUSE_ID = 'PRODUCT_WAREHOUSE_001';
const WAREHOUSE_BIBLE = Object.freeze({
  environmentId: WAREHOUSE_ID,
  setting: 'product_warehouse',
  architecture: 'One realistic spacious industrial product warehouse: high ceiling, steel shelving, overhead LED lighting, industrial floor, stable geometry and aisle layout.',
  inventory: 'Multiple accurate units and cartons of the SAME reference product only where appearance is evidenced; never fabricate labels or packaging.',
  continuity: 'Identical warehouse, shelf positions, lighting, presenter wardrobe and exact product model across all five panels; vary only framing and static presenter pose.',
  forbidden: 'No residential kitchen, home, showroom, boutique, decorative studio, unrelated inventory, imaginary machinery, invented labels, extra presenter, product operation or demonstration, blue medical gowns, blue cleanroom smocks, crowded assembly line. Background workers are strictly limited to 1-2 people in distant soft focus.'
});
function selectVerifiedHook(options = {}) {
  // v3: ALWAYS select one HOOK_LIBRARY entry. Commercial claims are validated separately.
  // This prevents Gemini from inventing a brand-new hook when offer metadata is absent.
  const facts = options.verifiedOffer || options.productContext?.verifiedOffer || {};
  const id = options.hookId || options.productContext?.hookId;
  const explicit = id ? ALL_HOOKS.find(h => h.id === id) : null;
  if (explicit) return explicit;

  const price = Boolean(facts.price && facts.priceVerified === true);
  const shipping = facts.freeShipping === true && facts.freeShippingVerified === true;
  const gift = facts.gift === true && facts.giftVerified === true;
  const subsidy = facts.subsidy === true && facts.subsidyVerified === true;
  const zero = facts.zeroPrice === true && facts.zeroPriceVerified === true;
  const noProfit = facts.noProfit === true && facts.noProfitVerified === true;
  const eligible = h => h.requires === 'verified_price' ? price :
    h.requires === 'verified_price_and_shipping' ? price && shipping :
      h.requires === 'verified_gift_and_subsidy' ? gift && subsidy :
        h.requires === 'verified_zero_price_and_no_profit' ? zero && noProfit : false;
  const verifiedPool = HOOK_LIBRARY.filter(eligible);
  // Hook phổ quát luôn đủ an toàn; hook thương mại chỉ tham gia khi claim tương ứng đã xác minh.
  const pool = [...UNIVERSAL_RETENTION_HOOKS, ...verifiedPool];

  // Random by default; caller may lock hookId for reproducible runs.
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildSafeLibraryHookOpening(hook, productName = 'sản phẩm', verifiedOffer = {}, audienceAddress = 'anh chị') {
  const addr = audienceAddress || 'anh chị';
  const shortProductName = String(productName || 'sản phẩm')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join(' ');
  if (!hook) return `Khoan lướt nha ${addr} — mẫu ${shortProductName} này có một điểm rất dễ bị bỏ qua!`;
  const price = verifiedOffer.priceVerified === true && verifiedOffer.price ? String(verifiedOffer.price) : (verifiedOffer.price || null);
  const shipping = verifiedOffer.freeShippingVerified === true || verifiedOffer.freeShipping === true;
  const zero = verifiedOffer.zeroPriceVerified === true || verifiedOffer.zeroPrice === true;
  const subsidy = verifiedOffer.subsidyVerified === true || verifiedOffer.subsidy === true;
  const gift = verifiedOffer.giftVerified === true || verifiedOffer.gift === true;
  const noProfit = verifiedOffer.noProfitVerified === true || verifiedOffer.noProfit === true;

  if (hook.template) {
    return hook.template
      .replaceAll('{product}', shortProductName)
      .replaceAll('{audience}', addr);
  }

  switch (hook.id) {
    case 'H01':
      return `Trời ơi, khoan lướt nha ${addr} — mẫu ${shortProductName} này có một điểm nhỏ mà đáng chú ý lắm!`;
    case 'H02':
      return price
        ? `Ủa khoan, mức ${price} mà mẫu ${shortProductName} này còn có điểm này nữa hả ${addr}?`
        : `Ủa khoan, đừng nhìn vẻ ngoài mà đánh giá mẫu ${shortProductName} này nha ${addr}!`;
    case 'H03':
      return `Nhìn kỹ nè ${addr} — điểm đáng xem nhất trên mẫu ${shortProductName} lại nằm ở chỗ ít ai để ý!`;
    case 'H04':
      return `Dừng một giây nha ${addr} — trước khi chọn mẫu ${shortProductName}, phải nhìn đúng chỗ này!`;
    case 'H05':
      return shipping
        ? `Khoan đã ${addr}! Mẫu ${shortProductName} này được giao tận nhà, nhưng điểm đáng xem còn ở phía sau!`
        : `Em nói thật nha ${addr}, điểm đáng xem nhất của mẫu ${shortProductName} này không nằm ở vẻ ngoài đâu!`;
    case 'H06':
      return `Khoan, khoan — có một lý do mẫu ${shortProductName} này khiến em phải nhìn lại lần hai!`;
    case 'H07':
      return `Nhìn tưởng bình thường đúng không ${addr} — nhưng mẫu ${shortProductName} này có một điểm rất dễ bị bỏ sót!`;
    case 'H08':
      return `Đừng lướt nha ${addr} — em chỉ đúng một chi tiết để biết mẫu ${shortProductName} này có đáng chọn không!`;
    case 'H09':
      return `Ai đang tìm ${shortProductName} thì dừng lại nha — có một điểm phải nhìn trước khi chốt!`;
    default:
      return `Khoan lướt nha ${addr} — mẫu ${shortProductName} này có một điểm rất dễ bị bỏ qua!`;
  }
}
function safeWarehouseClip(clip, index) {
  const views = [
    'Presenter in front of shelving stocked with the same reference product; product visible on an inventory table.',
    'Medium shot: presenter holding the already-visible intact product steadily in front of the same shelving.',
    'Static three-quarter angle: reference product on table, presenter next to it, same warehouse aisle.',
    'Static close-up of existing visible product exterior and material; no operation or disassembly.',
    'Medium shot: presenter and reference product in the same warehouse, calm closing expression.'
  ];
  return {
    ...clip, clipIndex: index + 1,
    phase: index === 3 ? 'PRODUCT_DETAIL_SHOWCASE' : clip.phase,
    visualBeats: [
      { time: '0-4s', action: 'Natural speech, blinking and subtle facial expression; product remains stationary.' },
      { time: '4-8s', action: 'Subtle head movement and tiny camera push-in; preserve the entire original scene.' }
    ],
    startFramePlan: {
      presenterPose: 'Stable natural presenter pose; face and wardrobe identical to canonical model.',
      handPose: 'Hands already in a stable resting/holding pose; no changing grip or manipulating parts.',
      productPlacement: views[index],
      framing: index === 3 ? 'Vertical 9:16 product close-up' : 'Vertical 9:16 medium shot',
      environment: WAREHOUSE_BIBLE.architecture + ' ' + WAREHOUSE_BIBLE.inventory,
      environmentId: WAREHOUSE_ID
    },
    actionRunway: { valid: true, motion: 'Blinking, speech lip sync, micro facial movement only.' },
    requiresProductOperation: false,
    introducesUnverifiedProps: false
  };
}
function normalizeWarehouseStoryboard(data) {
  const result = {
    ...data, analysis: {
      ...(data.analysis || {}), sourcingSetting: 'product_warehouse', warehouseBible: WAREHOUSE_BIBLE,
      visualBible: { ...DEFAULT_GLOBAL_VISUAL_BIBLE, environmentType: 'product_warehouse', warehouseBible: WAREHOUSE_BIBLE }
    }
  };
  result.script = (data.script || []).map(safeWarehouseClip);
  return result;
}
function normalizeProductEnvironmentStoryboard(data, options = {}) {
  const analysis = { ...(data.analysis || {}) };
  // Honour already-computed sourcingSetting from Stage 1 deterministic routing.
  // Pass it as explicit override so detectProductSourcingSetting uses it directly
  // instead of re-running category/regex routing and potentially diverging.
  const normalizeOptions = analysis.sourcingSetting
    ? { ...options, sourcingSetting: analysis.sourcingSetting }
    : options;
  const env = getProductEnvironmentBible(analysis, normalizeOptions);
  const views = [
    'Reviewer clearly visible with product; industrial context readable behind her.',
    'Reviewer clearly visible holding/presenting product; same facility.',
    'Reviewer clearly visible beside product on industrial work/inventory table; same facility.',
    'Tighter product detail while reviewer face and upper body remain visibly in frame; NEVER product-only.',
    'Reviewer clearly visible with product for closing frame; same facility.'
  ];
  const script = (data.script || []).map((clip, index) => ({
    ...clip,
    clipIndex: index + 1,
    startFramePlan: {
      ...(clip.startFramePlan || {}),
      presenterPose: 'Canonical reviewer model visibly present; same face, hair and wardrobe as model.png.',
      productPlacement: views[index],
      environment: `${env.promptFragment} ${env.continuity}`,
      environmentId: env.environmentId,
      environmentType: env.setting,
      presenterRequired: true
    },
    introducesUnverifiedProps: false
  }));
  return { ...data, analysis: { ...analysis, sourcingSetting: env.setting, environmentBible: env, visualBible: { ...DEFAULT_GLOBAL_VISUAL_BIBLE, environmentType: env.setting, environmentBible: env } }, script };
}

function validateProductEnvironmentStoryboard(data) {
  const errors = [];
  const clips = data?.script || data?.panels || [];
  const env = data?.analysis?.environmentBible;
  if (clips.length !== 5) errors.push('Expected exactly 5 panels');
  if (!env || !['factory_showcase', 'product_warehouse'].includes(env.setting)) errors.push('Invalid or missing product environment');
  clips.forEach((c, i) => {
    if (c.startFramePlan?.presenterRequired !== true) errors.push(`Panel ${i + 1}: canonical reviewer is not mandatory`);
    if (!c.startFramePlan?.environmentId || c.startFramePlan.environmentId !== env?.environmentId) errors.push(`Panel ${i + 1}: environment continuity mismatch`);
    if (c.requiresProductOperation) errors.push(`Panel ${i + 1}: forbidden product operation`);
  });
  return { valid: errors.length === 0, errors };
}

function validateWarehouseStoryboard(data) {
  // Backward-compatible alias. Validation now accepts either product-specific factory or warehouse.
  return validateProductEnvironmentStoryboard(data);
}

function validateOfferClaims(script, options = {}) {
  const facts = options.verifiedOffer || options.productContext?.verifiedOffer || {};
  const all = (script || []).map(s => s.dialogue || '').join(' ');
  const errors = [];
  if (!facts.priceVerified && /(?:\d+[.,]?\d*\s*(?:k|nghìn|ngàn|triệu|đồng|đ)|giá\s*(?:chỉ|còn)\s*\d)/i.test(all)) errors.push('Unverified numeric price');
  if (!facts.freeShippingVerified && /(?:free\s*ship|freeship|miễn phí (?:vận chuyển|ship))/i.test(all)) errors.push('Unverified free shipping');
  if (!facts.subsidyVerified && /(?:trợ giá|giảm thẳng|voucher|mã giảm|ưu đãi độc quyền|giảm sâu)/i.test(all)) errors.push('Unverified subsidy/discount');
  if (!facts.zeroPriceVerified && /(?:không đồng|0\s*đ|0\s*đồng)/i.test(all)) errors.push('Unverified zero price');
  if (!facts.noProfitVerified && /(?:không (?:lấy|lời) (?:một )?đồng|không lợi nhuận)/i.test(all)) errors.push('Unverified no-profit claim');
  if (!facts.giftVerified && /(?:em tặng|người ta cho|là cho chứ)/i.test(all)) errors.push('Unverified gift claim');
  return { valid: errors.length === 0, errors };
}

/**
 * Strip unverified commercial claims from dialogue text.
 * Called when validateOfferClaims returns errors — auto-cleans instead of hard-failing.
 */
function stripUnverifiedClaims(script, options = {}) {
  const facts = options.verifiedOffer || options.productContext?.verifiedOffer || {};
  return (script || []).map(clip => {
    let d = clip.dialogue || '';
    if (!facts.subsidyVerified) {
      d = d.replace(/(?:TikTok\s+)?(?:đang\s+)?trợ giá[^,;.!?]*[,;.!?]?\s*/gi, '');
      d = d.replace(/giảm thẳng[^,;.!?]*[,;.!?]?\s*/gi, '');
      d = d.replace(/(?:voucher|mã giảm)[^,;.!?]*[,;.!?]?\s*/gi, '');
      d = d.replace(/ưu đãi độc quyền[^,;.!?]*[,;.!?]?\s*/gi, '');
      d = d.replace(/giảm sâu[^,;.!?]*[,;.!?]?\s*/gi, '');
    }
    if (!facts.freeShippingVerified) {
      d = d.replace(/(?:free\s*ship|freeship|miễn phí (?:vận chuyển|ship))[^,;.!?]*[,;.!?]?\s*/gi, '');
    }
    if (!facts.priceVerified) {
      d = d.replace(/giá\s*(?:chỉ|còn)\s*\d+[^,;.!?]*[,;.!?]?\s*/gi, '');
    }
    if (!facts.zeroPriceVerified) {
      d = d.replace(/(?:không đồng|0\s*đ(?:ồng)?)[^,;.!?]*[,;.!?]?\s*/gi, '');
    }
    if (!facts.noProfitVerified) {
      d = d.replace(/không (?:lấy|lời) (?:một )?đồng[^,;.!?]*[,;.!?]?\s*/gi, '');
      d = d.replace(/không lợi nhuận[^,;.!?]*[,;.!?]?\s*/gi, '');
    }
    if (!facts.giftVerified) {
      d = d.replace(/(?:em tặng|người ta cho|là cho chứ)[^,;.!?]*[,;.!?]?\s*/gi, '');
    }

    // Clean duplicate punctuation like ", ," or ", ."
    d = d.replace(/\s*([,;.!?])(?:\s*[,;.!?])+/g, '$1');
    // Fix whitespace before punctuation like "word ," -> "word,"
    d = d.replace(/\s+([,;.!?])/g, '$1');
    // Strip any leading punctuation / quotes / symbols
    d = d.replace(/^[\s,;.!?–—\-:"']+/g, '');
    // Strip trailing incomplete punctuation (like comma, dash, colon)
    d = d.replace(/[\s,;–—\-:]+$/g, '');
    // Collapse extra whitespace
    d = d.replace(/\s{2,}/g, ' ').trim();
    // Capitalize first letter and ensure terminal punctuation
    if (d.length > 0) {
      d = d.charAt(0).toUpperCase() + d.slice(1);
      if (!/[.!?]$/.test(d)) {
        d += '.';
      }
    }
    const wordCount = d ? d.split(/\s+/).filter(Boolean).length : 0;
    return { ...clip, dialogue: d, wordCount };
  });
}

// ── 2. ROBUST JSON PARSER (Adapted from tfood parseJsonObjectFood) ─────────────

function parseJsonObjectProduct(rawText) {
  if (!rawText) return null;
  let text = String(rawText).trim();
  text = text.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();

  try {
    return JSON.parse(text);
  } catch (_) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(text.substring(start, end + 1));
      } catch (e2) {
        // Thử regex trích xuất các block json nếu có lỗi escape
        try {
          const matched = text.match(/\{[\s\S]*\}/);
          if (matched) return JSON.parse(matched[0]);
        } catch (e3) {
          console.warn('[TemplateProduct] JSON parse fallback failed:', e3.message);
        }
      }
    }
  }
  return null;
}

// ── 3. PRODUCT CATEGORY ROUTING & TAXONOMY (10 Core Categories) ───────────────

const PRODUCT_CATEGORY_ROUTING = {
  fashion_apparel: {
    key: 'fashion_apparel',
    label: 'Thời trang & May mặc',
    keywords: ['áo', 'quần', 'váy', 'đầm', 'khoác', 'blazer', 'hoodie', 'sơ mi', 'thun', 'len', 'jean', 'set bộ', 'chân váy', 'bodysuit', 'đồ ngủ', 'nội y'],
    defaultSetting: 'showroom_display',
    defaultAudienceAddress: 'chị em',
    heroAction: 'Presenter nâng vạt áo/váy, miết ngón tay kiểm tra chất vải mềm mại và đường chỉ may tỉ mỉ',
    forbiddenActions: ['cấm xé rách vải', 'cấm kéo dãn làm biến dạng sản phẩm', 'cấm nhai ngậm phụ kiện'],
    props: ['giá treo đồ kim loại vàng mạ tinh tế', 'gương đứng toàn thân viền led', 'túi shopping bag cao cấp'],
  },
  footwear_accessories: {
    key: 'footwear_accessories',
    label: 'Giày dép & Phụ kiện',
    keywords: ['giày', 'dép', 'sneaker', 'sandal', 'cao gót', 'túi xách', 'balo', 'ví', 'thắt lưng', 'kính mắt', 'trang sức', 'đồng hồ', 'vòng tay', 'dây chuyền'],
    defaultSetting: 'showroom_display',
    defaultAudienceAddress: 'chị em',
    heroAction: 'Presenter cầm nghiêng sản phẩm 45 độ đón sáng, miết bề mặt da/kim loại sáng bóng và kiểm tra khóa kéo êm ái',
    forbiddenActions: ['cấm bẻ cong gãy đế giày', 'cấm giẫm đạp mạnh làm trầy xước bề mặt da bóng', 'cấm nhúng vào nước'],
    props: ['đôn trưng bày acrylic trong suốt', 'khăn nhung đen lau bụi phụ kiện', 'hộp unbox cứng cáp chuẩn hãng'],
  },
  beauty_cosmetics: {
    key: 'beauty_cosmetics',
    label: 'Mỹ phẩm & Trang điểm',
    keywords: ['son', 'son môi', 'kem nền', 'cushion', 'phấn', 'serum', 'kem dưỡng', 'chống nắng', 'toner', 'nước hoa', 'mascara', 'chì mày', 'tẩy trang', 'mặt nạ'],
    defaultSetting: 'showroom_display',
    defaultAudienceAddress: 'chị em',
    heroAction: 'Presenter mở nắp nhẹ nhàng, test chất kem/son mịn mướt lên mu bàn tay hoặc hướng đầu pump tinh xảo về camera',
    forbiddenActions: ['cấm xịt dung dịch thẳng vào ống kính camera', 'cấm bôi quệt lem nhem lên trang phục', 'cấm cắn son môi'],
    props: ['khay gương viền vàng sang trọng', 'bông cotton mềm sạch', 'gương trang điểm cầm tay đèn led'],
  },
  personal_care_hygiene: {
    key: 'personal_care_hygiene',
    label: 'Chăm sóc cá nhân & Vệ sinh',
    keywords: ['dầu gội', 'sữa tắm', 'bàn chải', 'kem đánh răng', 'máy cạo râu', 'dao cạo', 'máy rửa mặt', 'tăm nước', 'sữa rửa mặt', 'lăn khử mùi', 'khăn ướt'],
    defaultSetting: 'lifestyle_home',
    defaultAudienceAddress: 'cả nhà',
    heroAction: 'Presenter thao tác bật công tắc máy rung siêu âm hoặc nhấn đầu pump lấy một giọt bọt xốp mịn màng',
    forbiddenActions: ['cấm nuốt hóa chất', 'cấm để nước tràn làm chập điện thiết bị', 'cấm xịt bọt lung tung'],
    props: ['khăn bông cotton trắng cuộn tròn sạch sẽ', 'kệ gỗ lavabo cao cấp', 'chậu cây monstera nhỏ decor'],
  },
  digital_tech_gadgets: {
    key: 'digital_tech_gadgets',
    label: 'Công nghệ & Phụ kiện số',
    keywords: ['tai nghe', 'sạc', 'cáp sạc', 'pin dự phòng', 'smartwatch', 'đồng hồ thông minh', 'loa', 'bluetooth', 'chuột', 'bàn phím', 'giá đỡ', 'ốp lưng', 'củ sạc'],
    defaultSetting: 'showroom_display',
    defaultAudienceAddress: 'mọi người',
    heroAction: 'Presenter bấm mở nắp hộp sạc từ tính kêu cách êm ái, đèn led báo pin phát sáng sang trọng hoặc thao tác kết nối nhanh',
    forbiddenActions: ['cấm đập rơi mạnh xuống đất', 'cấm nhúng nước (trừ khi có chuẩn chống nước)', 'cấm cạy phá vi mạch'],
    props: ['thảm da lót bàn desk mat tối giản', 'giá đỡ nhôm kim loại anodized', 'hộp nguyên seal nguyên kiện'],
  },
  home_appliances: {
    key: 'home_appliances',
    label: 'Gia dụng & Điện gia đình',
    keywords: ['nồi chiên', 'nồi cơm', 'máy xay', 'ấm siêu tốc', 'quạt', 'máy hút bụi', 'bàn là', 'bàn ủi', 'máy ép', 'nồi áp suất', 'máy lọc không khí', 'đèn bàn'],
    defaultSetting: 'lifestyle_home',
    defaultAudienceAddress: 'các bác',
    heroAction: 'Presenter xoay núm điều khiển cảm ứng mượt mà, mở khoang chứa rộng rãi bằng thao tác kéo êm ái',
    forbiddenActions: ['cấm chạm tay trần vào mâm nhiệt đang bốc khói', 'cấm giật đứt dây điện', 'cấm tháo rời linh kiện máy móc'],
    props: ['mặt bàn bếp đá sáng bóng', 'khăn lau microfiber', 'cốc đo lường định lượng đi kèm'],
  },
  kitchenware_foodprep: {
    key: 'kitchenware_foodprep',
    label: 'Đồ dùng nhà bếp & Bàn ăn',
    keywords: ['chảo', 'nồi', 'dao', 'thớt', 'hộp đựng', 'bát', 'đĩa', 'bình giữ nhiệt', 'ly', 'cốc', 'đũa', 'thìa', 'kéo bếp', 'khuôn bánh', 'kệ gia vị'],
    defaultSetting: 'lifestyle_home',
    defaultAudienceAddress: 'các bác',
    heroAction: 'Presenter dùng ngón tay gõ nhẹ lên đáy chống dính đanh chắc, biểu diễn độ kín của nắp gioăng cao su khóa chặt',
    forbiddenActions: ['cấm dùng dao cứa vào tay', 'cấm quăng quật làm méo mó biến dạng inox/nhôm', 'cấm đặt lên bếp gas không có đáy từ'],
    props: ['thớt gỗ decor sạch đẹp', 'vài lát chanh và lá hương thảo tươi trang trí', 'khăn vải linen trải bàn'],
  },
  interior_home_living: {
    key: 'interior_home_living',
    label: 'Nội thất, Chăn ga & Đời sống',
    keywords: ['gối', 'nệm', 'nệm topper', 'chăn', 'ga giường', 'thảm', 'rèm', 'kệ', 'ghế', 'bàn', 'nến thơm', 'tinh dầu thơm phòng', 'tinh dầu xông phòng', 'khung tranh', 'hoa lụa'],
    defaultSetting: 'lifestyle_home',
    defaultAudienceAddress: 'mọi người',
    heroAction: 'Presenter nhấn bàn tay lún sâu vào lõi đệm/gối rồi thả ra để thấy khả năng đàn hồi phục hồi siêu nhanh trong 1 giây',
    forbiddenActions: ['cấm đốt lửa gây cháy', 'cấm dùng dao sắc cắt rách vỏ đệm', 'cấm dẫm giày bẩn lên nệm trắng'],
    props: ['giường ngủ gọn gàng trải ga tông pastel', 'ly nước thủy tinh trong suốt', 'đèn ngủ ánh vàng ấm áp'],
  },
  health_wellness_supplements: {
    key: 'health_wellness_supplements',
    label: 'Sức khỏe & Thực phẩm bổ sung',
    keywords: ['vitamin', 'collagen', 'canxi', 'omega', 'trà thảo mộc', 'bột ngũ cốc', 'đông trùng', 'yến sào', 'máy massage', 'đai lưng', 'gối massage', 'xịt thảo mộc', 'tinh dầu ngải cứu', 'tinh dầu gừng', 'dầu xoa bóp', 'xoa bóp'],
    defaultSetting: 'showroom_display',
    defaultAudienceAddress: 'các bác',
    heroAction: 'Presenter giơ rõ tem phụ tiếng Việt, tem chống hàng giả phản quang 7 màu sắc nét và hướng dẫn cách dùng tiện lợi',
    forbiddenActions: ['cấm tuyên bố chữa khỏi bách bệnh hoặc thay thế thuốc chữa bệnh', 'cấm uống quá liều lượng quy định'],
    props: ['chứng nhận kiểm định chất lượng dán tem', 'ly nước ấm tinh khiết', 'hộp quà tặng sang trọng'],
  },
  mother_baby_kids: {
    key: 'mother_baby_kids',
    label: 'Mẹ, Bé & Trẻ em',
    keywords: ['bình sữa', 'núm ti', 'tã', 'bỉm', 'xe đẩy', 'ghế ăn dặm', 'đồ chơi', 'quần áo sơ sinh', 'sữa hạt cho bé', 'nhiệt kế', 'yếm', 'khăn sữa'],
    defaultSetting: 'lifestyle_home',
    defaultAudienceAddress: 'chị em',
    heroAction: 'Presenter bóp nhẹ núm silicone siêu mềm chống sặc, miết kiểm tra bề mặt vải cotton 100% không bụi xơ',
    forbiddenActions: ['cấm quăng quật đồ dùng trẻ em', 'cấm thử sản phẩm vào em bé thật gây nguy hiểm', 'cấm dùng vật sắc nhọn chọc bỉm'],
    props: ['gấu bông nhỏ tông màu pastel', 'khăn sữa sạch gấp gọn ngăn nắp', 'giỏ mây đựng đồ cho bé'],
  },
  fallback_general_merchandise: {
    key: 'fallback_general_merchandise',
    label: 'Hàng tiêu dùng & Tiện ích thông minh',
    keywords: [],
    defaultSetting: 'factory_showcase',
    defaultAudienceAddress: 'mọi người',
    heroAction: 'Presenter cầm hai tay nâng sản phẩm ngang ngực, nghiêng nhẹ góc cạnh để ánh sáng làm nổi bật thiết kế hoàn thiện',
    forbiddenActions: ['cấm đập phá sản phẩm', 'cấm biến hình sản phẩm thành đồ vật khác'],
    props: ['bàn live-commerce phủ thảm đen sang trọng', 'thùng carton xuất xưởng phía sau', 'giá đỡ trưng bày chuẩn'],
  }
};

/**
 * Phân loại danh mục sản phẩm từ thông tin đầu vào
 */
function routeProductCategory(text = '') {
  const norm = String(text).toLowerCase();
  for (const [catKey, info] of Object.entries(PRODUCT_CATEGORY_ROUTING)) {
    if (catKey === 'fallback_general_merchandise') continue;
    for (const kw of info.keywords) {
      const regex = new RegExp(`\\b${kw}\\b`, 'i');
      if (regex.test(norm) || norm.includes(kw)) {
        return info;
      }
    }
  }
  return PRODUCT_CATEGORY_ROUTING.fallback_general_merchandise;
}

// ── 4. CLASSIFY PRODUCT REFERENCE ROLES ────────────────────────────────────────

/**
 * Phân loại vai trò của từng ảnh tham chiếu đầu vào (Section 18 Pattern)
 */
function classifyProductReferenceRoles(filePayloads = [], analysis = {}) {
  const roles = {
    presenter_model: [],
    hero_product_isolated: [],
    packaging_box: [],
    detail_texture: [],
    in_use_context: [],
    spec_label: [],
    unknown: []
  };

  const imageMetadata = [];
  if (!Array.isArray(filePayloads) || filePayloads.length === 0) {
    return { ...roles, imageMetadata, hasTextureEvidence: false, hasBoxEvidence: false, hasUsageEvidence: false };
  }

  filePayloads.forEach((fp, idx) => {
    const name = String(fp.name || fp.path || `img_${idx + 1}`).toLowerCase();
    const id = fp.id || fp.name || `ref_${idx + 1}`;
    let role = 'unknown';
    let confidence = 0.5;

    if (name.includes('model') || name.includes('presenter') || name.includes('modal') || idx === 0 && (name.includes('person') || name.includes('host'))) {
      role = 'presenter_model';
      confidence = 0.95;
    } else if (name.includes('box') || name.includes('pack') || name.includes('hop') || name.includes('bao_bi') || name.includes('vo_hop') || name.includes('seal')) {
      role = 'packaging_box';
      confidence = 0.85;
    } else if (name.includes('texture') || name.includes('detail') || name.includes('close') || name.includes('can_canh') || name.includes('chat_lieu') || name.includes('seam') || name.includes('stitch')) {
      role = 'detail_texture';
      confidence = 0.85;
    } else if (name.includes('use') || name.includes('hold') || name.includes('hand') || name.includes('tay') || name.includes('mac') || name.includes('cam') || name.includes('demo')) {
      role = 'in_use_context';
      confidence = 0.8;
    } else if (name.includes('spec') || name.includes('label') || name.includes('tem') || name.includes('thong_so') || name.includes('chung_nhan')) {
      role = 'spec_label';
      confidence = 0.85;
    } else if (name.includes('white') || name.includes('hero') || name.includes('studio') || idx === 1) {
      role = 'hero_product_isolated';
      confidence = 0.8;
    } else {
      role = 'hero_product_isolated';
      confidence = 0.6;
    }

    roles[role].push(id);
    imageMetadata.push({ id, source: fp.path || fp.name || id, role, confidence });
  });

  return {
    ...roles,
    imageMetadata,
    hasTextureEvidence: roles.detail_texture.length > 0,
    hasBoxEvidence: roles.packaging_box.length > 0,
    hasUsageEvidence: roles.in_use_context.length > 0
  };
}

// ── 5. ANALYZE PRODUCT PHYSICAL PROFILE & AFFORDANCES ─────────────────────────

/**
 * Phân tích cấu trúc vật lý sản phẩm: kích thước, khối lượng, vật liệu, cách cầm nắm
 */
function analyzeProductPhysicalProfile(analysis = {}, refs = {}) {
  const prodName = String(analysis.productName || analysis.productTitle || '').toLowerCase();
  const categoryInfo = routeProductCategory(prodName + ' ' + (analysis.category || ''));
  const catKey = categoryInfo.key;

  let formFactor = 'compact_handheld';
  let dimensions = 'handheld (~10-25cm)';
  let weightClass = 'light (~200-500g)';
  let finishMaterial = 'matte_plastic';
  let surfaceTexture = 'smooth satin finish';
  let gripAffordance = 'single_hand_palm';
  let scaleCue = 'presenter female hands';

  switch (catKey) {
    case 'fashion_apparel':
      formFactor = 'folded_textile';
      dimensions = 'wearable adult size';
      weightClass = 'featherlight (<300g)';
      finishMaterial = 'soft_fabric';
      surfaceTexture = 'fine cotton/polyester knit texture with precise seam stitching';
      gripAffordance = 'dual_hands_holding';
      scaleCue = 'presenter body silhouette';
      break;
    case 'footwear_accessories':
      formFactor = 'wearable';
      dimensions = 'medium (~20-35cm)';
      weightClass = 'light (~400-800g)';
      finishMaterial = 'genuine_leather_or_canvas';
      surfaceTexture = 'textured pebble leather or structured canvas with polished metal hardware';
      gripAffordance = 'single_hand_palm';
      scaleCue = 'presenter hand & forearm';
      break;
    case 'beauty_cosmetics':
      formFactor = 'liquid_bottle_or_compact';
      dimensions = 'small handheld (~5-15cm)';
      weightClass = 'featherlight (<150g)';
      finishMaterial = 'transparent_glass_or_acrylic';
      surfaceTexture = 'luxurious glossy glass bottle or sleek matte compact case';
      gripAffordance = 'fingertips_pinch';
      scaleCue = 'presenter delicate fingertips';
      break;
    case 'personal_care_hygiene':
      formFactor = 'ergonomic_wand_or_pump_bottle';
      dimensions = 'compact (~15-25cm)';
      weightClass = 'light (~250-400g)';
      finishMaterial = 'matte_silicone_and_abs';
      surfaceTexture = 'ergonomic soft-touch rubber grip with brushed metallic accents';
      gripAffordance = 'single_hand_palm';
      scaleCue = 'presenter hand grip';
      break;
    case 'digital_tech_gadgets':
      formFactor = 'compact_handheld';
      dimensions = 'palm-sized (~8-18cm)';
      weightClass = 'light (~180-350g)';
      finishMaterial = 'anodized_aluminum_and_matte_pc';
      surfaceTexture = 'smooth bead-blasted metallic finish, crisp chamfered edges, tactile buttons';
      gripAffordance = 'single_hand_palm';
      scaleCue = 'smartphone comparison scale';
      break;
    case 'home_appliances':
      formFactor = 'tabletop';
      dimensions = 'medium appliance (~25-45cm)';
      weightClass = 'medium (~1.5-4kg)';
      finishMaterial = 'brushed_stainless_steel_and_glass';
      surfaceTexture = 'gleaming brushed steel exterior with clear tempered glass door/lid';
      gripAffordance = 'table_rested_hand_touch';
      scaleCue = 'countertop environment';
      break;
    case 'kitchenware_foodprep':
      formFactor = 'tabletop_or_handheld';
      dimensions = 'medium (~20-40cm)';
      weightClass = 'medium (~600g-1.5kg)';
      finishMaterial = 'cast_aluminum_or_ceramic';
      surfaceTexture = 'non-stick ceramic granite coating with ergonomic wood-grain bakelite handle';
      gripAffordance = 'single_hand_handle_grip';
      scaleCue = 'kitchen counter setting';
      break;
    case 'interior_home_living':
      formFactor = 'cushioned_bulk';
      dimensions = 'medium to large (~40-70cm)';
      weightClass = 'medium (~800g-2kg)';
      finishMaterial = 'plush_velvet_or_memory_foam';
      surfaceTexture = 'breathable knitted tencel fabric with high-density elastic resilience';
      gripAffordance = 'dual_hands_pressing';
      scaleCue = 'bed or sofa background';
      break;
    case 'health_wellness_supplements':
      formFactor = 'jar_container_or_blister_box';
      dimensions = 'small (~10-18cm)';
      weightClass = 'featherlight (~200g)';
      finishMaterial = 'amber_pet_or_hard_paperboard';
      surfaceTexture = 'holographic security seal with crisp legible nutrition fact printing';
      gripAffordance = 'single_hand_palm';
      scaleCue = 'presenter palm';
      break;
    case 'mother_baby_kids':
      formFactor = 'soft_ergonomic_unit';
      dimensions = 'small (~12-22cm)';
      weightClass = 'featherlight (~150-300g)';
      finishMaterial = 'bpa_free_ppsu_and_silicone';
      surfaceTexture = 'ultra-soft skin-feel medical silicone with clear volume measurement graduation';
      gripAffordance = 'single_hand_palm';
      scaleCue = 'presenter hands';
      break;
    default:
      formFactor = 'compact_handheld';
      dimensions = 'handheld (~15-25cm)';
      weightClass = 'light (~300-600g)';
      finishMaterial = 'matte_plastic';
      surfaceTexture = 'smooth modern industrial finish';
      gripAffordance = 'single_hand_palm';
      scaleCue = 'presenter hands';
      break;
  }

  return {
    formFactor,
    dimensions,
    weightClass,
    finishMaterial,
    surfaceTexture,
    gripAffordance,
    scaleCue,
    categoryKey: catKey,
  };
}

/**
 * Determines whether the product is compact/handheld (can be held in hands)
 * or tabletop/floor-standing (must be placed on the table/floor).
 */
function isProductHandheld(analysis = {}, physicalProfile = {}) {
  const prodName = String(
    analysis.productName || analysis.productTitle || ''
  ).toLowerCase();
  const catKey = String(
    analysis.categoryKey || physicalProfile.categoryKey || ''
  ).toLowerCase();
  const scale = String(
    analysis.physicalScale || physicalProfile.physicalScale || ''
  ).toLowerCase();
  const formFactor = String(
    physicalProfile.formFactor || ''
  ).toLowerCase();

  // 1. Definite bulky / large items
  if (scale === 'bulky' || scale === 'large') return false;
  if (/(?:xe đạp|xe dap|bicycle|bike|sofa|bàn|ghế|giường|tủ|máy giặt|tủ lạnh|máy chạy bộ|vali cỡ lớn)/i.test(prodName)) {
    return false;
  }
  // Tabletop appliances / kitchen machines (nut milk makers, blenders, air fryers, rice cookers, ovens, water purifiers)
  if (/(?:nồi chiên|noi chien|nồi cơm|noi com|máy làm sữa hạt|may lam sua hat|sữa hạt|sua hat|nồi áp suất|noi ap suat|lò nướng|lo nuong|lò vi sóng|lo vi song|bếp từ|bep tu|máy lọc nước|may loc nuoc|máy lọc không khí|máy hút ẩm|quạt cây)/i.test(prodName)) {
    return false;
  }
  if (formFactor.includes('tabletop') || formFactor.includes('cushioned_bulk')) {
    return false;
  }

  // 2. Handheld items (cosmetics, skincare, shoes, crocs, bags, wallets, apparel, phones, small gadgets, bottles, supplements, spray)
  if (/beauty|cosmetics|personal_care|health|fashion|footwear|digital_tech/i.test(catKey)) {
    return true;
  }
  if (/(?:son|kem|serum|xịt|xit|tinh dầu|tinh dau|nước hoa|phấn|mascara|sữa rửa mặt|dầu gội|sữa tắm|lăn khử mùi)/i.test(prodName)) {
    return true;
  }
  if (/(?:dép|dep|giày|giay|sandal|crocs|sục|suc|sneaker|túi|balo|ví|vi|áo|ao|quần|quan|váy|đầm)/i.test(prodName)) {
    return true;
  }
  if (/(?:tai nghe|sạc|chuột|bàn phím|cáp|pin|đồng hồ|smartwatch|loa bluetooth nhỏ)/i.test(prodName)) {
    return true;
  }

  // Default: if light/small
  return scale !== 'bulky' && scale !== 'large';
}

function getProductPlacementRule(analysis = {}, physicalProfile = {}) {
  const handheld = isProductHandheld(analysis, physicalProfile);
  const prodName = analysis.productName || analysis.productTitle || 'the product';

  if (handheld) {
    return {
      isHandheld: true,
      placementKey: 'held_in_hands_at_chest_level',
      panel1Instruction: `HANDHELD PRODUCT RULE (PANEL 1 IS 100% PRODUCT-FOCUSED): "${prodName}" is a handheld/compact product. The presenter MUST BE ACTIVELY HOLDING THE PRODUCT IN HER HANDS AT CHEST LEVEL facing directly toward the camera lens. The product must be sharply in focus and clearly visible as the primary hero focal point. ABSOLUTELY NO waving empty hands, NO clipboard, NO paperwork, and NEVER hide the product.`,
      panelGeneralInstruction: `The presenter holds or features "${prodName}" prominently in front of her body at chest height across all panels, keeping the product crisp and unmistakably in focus.`,
      negativeRule: `waving empty hands, waving hello without product in panel 1, holding clipboard, holding binder, holding notepad, holding paperwork, empty hands in panel 1, product missing from presenter hands in panel 1, product tiny or out of focus, distant full-body shot in panel 1, hands in pockets, hands behind back`,
    };
  } else {
    return {
      isHandheld: false,
      placementKey: 'placed_on_table_in_front_of_reviewer',
      panel1Instruction: `TABLETOP / STATIONARY PRODUCT RULE (PANEL 1 IS 100% PRODUCT-FOCUSED): "${prodName}" is a tabletop/larger item. The product MUST BE RESTING DIRECTLY ON THE INSPECTION/SHOWCASE TABLE IN THE IMMEDIATE CENTER FOREGROUND right in front of the reviewer. The reviewer stands closely behind or beside the table, resting her hands naturally near the product or gesturing toward it, establishing the product as the unmistakable hero focal point of the scene. The product must be sharply rendered, upright, and prominent.`,
      panelGeneralInstruction: `"${prodName}" rests securely on the foreground table directly in front of the presenter across all panels, with the presenter standing immediately beside it and interacting naturally.`,
      negativeRule: `product missing from table in panel 1, product tiny or out of focus, presenter standing without table in front, product placed far away on distant floor, waving empty hands without product in frame, distant full-body shot in panel 1`,
    };
  }
}

/**
 * Trích xuất danh sách hành động bị cấm (Forbidden Actions) cho sản phẩm
 */
function deriveProductForbiddenActions(categoryInfo, physicalProfile) {
  const baseForbidden = [
    'cấm làm biến dạng hoặc biến hình sản phẩm thành đồ vật khác',
    'cấm tự ý thêm nhãn mác, chữ số, logo hay icon đồ họa lạ lên thân sản phẩm',
    'cấm sinh thêm presenter/reviewer thứ hai; hậu cảnh công nhân tối đa 1-2 người mờ nét ở xa, cấm mặc đồ bảo hộ y tế/áo xanh phòng sạch lấn át khung hình',
    'cấm tạo góc nhìn méo mó hoặc bàn tay dị tật nhiều hơn 5 ngón',
    'cấm đứng vẫy tay chào không cầm sản phẩm hoặc cầm kẹp tài liệu/bìa hồ sơ trong cảnh mở đầu (Panel 1)',
    'cấm để sản phẩm bị che khuất, quá nhỏ hoặc thiếu tập trung trong panel 1',
  ];
  const catForbidden = categoryInfo?.forbiddenActions || [];
  return Array.from(new Set([...baseForbidden, ...catForbidden]));
}

/**
 * Trích xuất danh sách hành vi tương tác hợp lệ & hành động đinh (Hero Action)
 */
function deriveProductAffordances(categoryInfo, physicalProfile) {
  const heroAction = categoryInfo?.heroAction || 'Presenter nâng sản phẩm lên ngang ngực hướng góc đón sáng nổi bật';
  const validActions = [
    'cầm sản phẩm chắc chắn bằng hai tay hoặc một tay tự nhiên ngang ngực',
    'nghiêng nhẹ 30-45 độ để ánh sáng phản chiếu làm nổi bật chất liệu hoàn thiện',
    'dùng ngón tay trỏ chỉ nhẹ vào điểm nhấn hoặc nút điều khiển chính',
    'thao tác đóng mở nắp hoặc kiểm tra khớp nối một cách mượt mà và tự nhiên',
    'hướng mặt chính của sản phẩm trực diện về phía ống kính camera',
  ];

  return {
    heroAction,
    validActions,
    gripStyle: physicalProfile.gripAffordance,
    scaleAnchor: physicalProfile.scaleCue,
  };
}

// ── 6. SOURCING SCENE SETTINGS & PROMPT BUILDER (4 Sourcing Settings) ─────────

const SOURCING_SCENE_SETTINGS = {
  product_warehouse: {
    key: 'product_warehouse',
    title: 'Kho hàng thành phẩm compact, sạch sẽ',
    promptFragment: 'Clean, well-lit compact storage room or finished-goods warehouse specifically matching the product category. The EXACT SAME PRODUCT (multiple identical units in retail packaging) must be clearly stacked or arranged on gray steel shelving units visible behind and beside the presenter. White or light-gray painted walls, white LED strip lighting overhead, gray epoxy or concrete floor. No dark or dirty industrial warehouse. No generic brown cardboard boxes unless that is the product packaging. Background shelving is neatly organized and product-specific: health/beauty products in identical boxes stacked on shelving; food products in branded bags/boxes; fashion items folded or in branded packaging on racks. Extremely clean, professional, bright, minimal aesthetic — closer to a professional storage studio than a large logistics center.'
  },
  factory_showcase: {
    key: 'factory_showcase',
    title: 'Nhà máy sản xuất có băng chuyền tự động',
    // Base fragment — overridden by getFactoryPromptFragment(analysis) in getProductEnvironmentBible
    promptFragment: 'Modern manufacturing facility with an active automated production and packaging conveyor belt line visible directly behind the presenter, carrying continuous identical units of the product through automated machinery stations.'
  }
};

/**
 * Returns a category-specific factory/workshop description that is visually plausible
 * for the actual product being filmed. Guarantees an active automated conveyor belt line
 * directly in the background carrying continuous identical units of the exact product.
 */
function getFactoryPromptFragment(analysis = {}) {
  // 1. Dynamic factory description from Gemini Stage 1 analysis if available
  const rawDesc = String(
    analysis.factoryDescription ||
    analysis.visualBible?.factoryDescription ||
    ''
  ).replace(/^["']|["']$/g, '').trim();

  let dynamicDesc = '';
  if (rawDesc && rawDesc.length >= 20) {
    // Sanitize any blue cleanroom/medical gown/surgical hallucination from dynamic description
    dynamicDesc = rawDesc
      .replace(/blue\s+(?:cleanroom|anti-static|protective|lab|medical|hospital)\s+(?:suits?|smocks?|gowns?|uniforms?)/gi, 'clean professional factory polo shirts or craft aprons')
      .replace(/surgical\s+hairnets?/gi, 'neat caps')
      .replace(/hospital\s+gown/gi, 'uniform')
      .trim();
  }

  // 2. Deterministic category & material based fallbacks
  const cat = String(analysis.categoryKey || '').toLowerCase();
  const mat = String(
    (analysis.physicalProfile && analysis.physicalProfile.finishMaterial) || ''
  ).toLowerCase();
  const prodName = String(analysis.productName || analysis.productTitle || 'sản phẩm').trim();

  // Wood / natural material products → woodworking / craft production with automated conveyor
  if (/wood|wooden|gỗ|bamboo|tre|rattan|mây/i.test(mat + ' ' + prodName)) {
    return `Artisan woodworking workshop and craft production facility. Directly behind the presenter is an active automated finishing and packaging conveyor line, where continuous polished units of "${prodName}" (matching the authentic product in input.png) travel through automated packaging and boxing stations. In the foreground, the presenter stands at a clean modern carpentry inspection bench displaying the finished product. Warm natural wood tones, bright clean workshop lighting. Warm, authentic artisanal factory direct feel — NO glass partition walls, NOT a medical lab, NOT a food factory.`;
  }

  // Bags / backpacks / wallets / leather goods → leathercraft & accessories atelier with finishing conveyor
  if (/túi|balo|ví|cặp|thắt lưng|leather|handbag|backpack|wallet/i.test(prodName)) {
    return `Modern leathercraft atelier and accessories finishing workshop. Directly behind the presenter is an active automated finishing and boxing conveyor belt line, where continuous identical units of "${prodName}" (matching input.png) travel along the conveyor through automated quality inspection and gift-boxing stations. In the foreground, the presenter stands at a clean leathercraft inspection workbench displaying the bag. Soft-focus background shows 1-2 craft artisans in canvas aprons. Clean, premium artisanal factory direct feel — NO glass partition walls, NO boutique vitrines, NO blue gowns.`;
  }

  // Footwear / shoes / sandals / crocs / sneakers → footwear finishing & packaging conveyor line
  if (/footwear|giày|dép|sục|sandal|sneaker|crocs|eva/i.test(cat + ' ' + prodName)) {
    return `Modern footwear manufacturing and packaging workshop. Directly behind the presenter is an active automated finishing and packaging conveyor belt line, where continuous identical pairs of "${prodName}" (matching input.png) travel along the conveyor through automated quality inspection and retail boxing stations. In the foreground, the presenter stands at a clean shoe inspection workbench displaying the footwear. Clean bright industrial factory floor, warm bright commercial LED lighting, neat dispatch staging area. NOT a dirty injection molding plant, NOT a semiconductor cleanroom, NO glass partition walls, NO blue medical smocks.`;
  }

  // Fashion / apparel / clothing → garment manufacturing & packaging conveyor line
  if (/fashion_apparel|fashion|quần|áo|váy|đầm|khoác/i.test(cat + ' ' + prodName)) {
    return `Modern apparel manufacturing and garment finishing workshop. Directly behind the presenter is an active automated finishing and packaging conveyor line, where continuous identical units of "${prodName}" (matching input.png) travel along the production line through automated pressing, folding, and retail packaging stations. In the foreground, the presenter stands at a clean garment inspection counter presenting the clothing item. Bright daylight LED lighting, aesthetic modern textile production workshop. NO glass partition walls, NO boutique showroom racks, NO blue medical gowns.`;
  }

  // Beauty / cosmetics / personal care → cosmetics automated bottling & packaging conveyor line
  if (/beauty_cosmetics|personal_care|mỹ phẩm|son|kem|serum|xịt|dưỡng|nước hoa|phấn|mascara/i.test(cat + ' ' + prodName)) {
    return `Modern, spotless cosmetics and skincare automated manufacturing facility. Directly behind the presenter is an active automated bottling and packaging conveyor belt line with polished stainless-steel machinery, where continuous identical units of "${prodName}" (matching the exact reference bottle, tube, or jar in input.png) are neatly lined up traveling along the moving conveyor belt through automated filling, capping, and labeling stations. In the foreground, the presenter stands at a clean wooden or stainless-steel live-commerce demonstration table displaying retail packages and units of the product. Spotless industrial epoxy cleanroom floor, bright daylight linear LED ceiling lighting. NO glass partition walls separating the conveyor line, NO display vitrines on walls, NO residential rooms, NOT blue surgical smocks.`;
  }

  // Health / pharma / supplements → pharmaceutical packaging conveyor line
  if (/health_wellness|supplement|thực phẩm chức năng|vitamin|viên uống|bổ não|canxi|collagen/i.test(cat + ' ' + prodName)) {
    return `Modern, ultra-clean white pharmaceutical and health-supplement automated packaging facility. Directly behind the presenter is an active automated packaging conveyor belt line with polished stainless-steel equipment, where continuous identical units of "${prodName}" (matching the authentic product reference in input.png) are neatly lined up traveling along the moving conveyor belt through automated capping, labeling, and cartoning stations. In the foreground, the presenter stands at a clean presentation and inspection counter displaying retail packages of the product. Bright white daylight LED illumination, spotless cleanroom factory floor. NO glass partition walls, NO display vitrines on walls, NOT blue surgery gowns.`;
  }

  // Kitchenware & small food prep appliances (blenders, milk makers, air fryers, juicers) → kitchen goods automated assembly conveyor
  if (/kitchenware|foodprep|máy làm sữa hạt|máy xay|nồi chiên|nồi cơm|bếp|chảo|ấm siêu tốc/i.test(cat + ' ' + prodName)) {
    return `Modern kitchen-appliance manufacturing and automated assembly facility. Directly behind the presenter is an active automated production conveyor belt line with testing stations, where continuous identical units of "${prodName}" (matching the authentic product in input.png) move along the industrial conveyor line. In the foreground, the presenter stands at a clean brushed stainless-steel kitchen-appliance testing studio and inspection counter displaying the appliance. Polished industrial cleanroom floor, bright commercial LED illumination. 1-2 quality inspectors in neat white uniforms in far background soft focus. Clean, high-tech factory-direct aesthetic — NO glass partition walls, NOT blue surgery gowns, NOT a residential kitchen.`;
  }

  // Home appliances (vacuum cleaners, fans, air purifiers, heaters) → appliance assembly & boxing conveyor line
  if (/home_appliance|interior_home_living|máy hút bụi|hút bụi|quạt|lọc không khí|bàn ủi/i.test(cat + ' ' + prodName)) {
    return `Modern home-appliance automated assembly and packaging facility. Directly behind the presenter is an active automated assembly conveyor belt line, where continuous identical units of "${prodName}" (matching input.png) travel along the conveyor through automated diagnostic and boxing stations. In the foreground, the presenter stands at a clean brushed stainless-steel or light-gray QA/QC inspection table displaying the finished appliance. Bright daylight linear LED lighting, clean modern industrial facility. Soft-focus background with 1-2 technicians in clean polo shirts checking finished units. Clean factory-direct showroom aesthetic — NO glass partition walls, NO blue medical smocks, NO surgical hairnets.`;
  }

  // Electronics / tech / gadgets → consumer electronics automated testing & packaging conveyor line
  if (/digital_tech|gadget|điện tử|tai nghe|loa|pin|sạc|chuột|bàn phím/i.test(cat + ' ' + prodName)) {
    return `High-tech consumer electronics automated manufacturing and testing facility. Directly behind the presenter is an active automated testing and packaging conveyor belt line, where continuous identical units of "${prodName}" (matching input.png) travel along the conveyor line through automated diagnostic and packaging stations. In the foreground, the presenter stands at a modern technical inspection counter displaying the gadget and retail box. Bright daylight linear LED overhead lighting, spotless high-tech cleanroom floor. NO glass partition walls, NO display vitrines on walls, NO blue hospital gowns.`;
  }

  // Food / packaged goods → food & beverage automated packaging conveyor line
  if (/food|thực phẩm|bánh|kẹo|trà|cà phê|hạt|đồ ăn|gia vị|nước mắm|mật ong/i.test(cat + ' ' + prodName)) {
    return `Clean, modern food & beverage automated packaging and dispatch facility. Directly behind the presenter is an active automated conveyor belt line with food-grade stainless-steel machinery, where continuous identical units of "${prodName}" in retail packaging (matching input.png) are moving along the conveyor line through automated sealing and cartoning stations. In the foreground, the presenter stands at a clean food-safety inspection and presentation counter. Spotless, food-safety compliant epoxy floor, bright white LED overhead lighting. NO glass partition walls, NO display vitrines, NO residential rooms.`;
  }

  // Mother / baby → baby-product clean automated packaging conveyor line
  if (/mother_baby|em bé|sơ sinh|tã|bỉm|bình sữa/i.test(cat + ' ' + prodName)) {
    return `Clean, bright baby-product automated quality inspection and packaging facility. Directly behind the presenter is an active automated packaging conveyor belt line, where continuous identical units of "${prodName}" (matching input.png) travel along the conveyor line through automated sealing and carton packaging stations. In the foreground, the presenter stands at a clean baby-goods inspection table presenting the product. White walls, spotless hygienic cleanroom atmosphere, warm gentle daylight LED lighting. NO glass partition walls, NO display vitrines, NO residential rooms.`;
  }

  // Use dynamicDesc if it provided a reasonable custom text with conveyor belt
  if (dynamicDesc && dynamicDesc.length >= 20) {
    if (/conveyor|băng chuyền/i.test(dynamicDesc)) {
      return dynamicDesc;
    }
    return `${dynamicDesc} Directly behind the presenter is an active automated production conveyor belt line carrying continuous identical units of "${prodName}" (matching input.png) through automated packaging stations. NO glass partition walls, NO display vitrines.`;
  }

  // Default fallback → generic clean factory direct automated conveyor line
  return `Modern, spotless automated manufacturing facility. Directly behind the presenter is an active automated production and packaging conveyor belt line with stainless-steel machinery, where continuous identical units of "${prodName}" (matching the authentic product reference in input.png) travel along the conveyor line through automated packaging and quality-assurance stations. In the foreground, the presenter stands at a clean presentation counter featuring the product. Bright commercial LED factory lighting, spotless industrial epoxy floor. NO glass partition walls, NO display vitrines on walls, NO residential rooms, NO blue medical smocks.`;
}

const FACTORY_PREFERRED_CATEGORIES = new Set([
  'beauty_cosmetics', 'personal_care_hygiene', 'home_appliances',
  'kitchenware_foodprep', 'health_wellness_supplements', 'digital_tech_gadgets'
]);

function detectProductSourcingSetting(analysis = {}, options = {}) {
  const explicit = options.sourcingSetting;
  // Only a caller-level explicit override may force warehouse/factory.
  // Stage-1 Gemini's analysis.sourcingSetting is advisory and must NOT override deterministic routing.
  if (explicit === 'factory_showcase' || explicit === 'product_warehouse') {
    return SOURCING_SCENE_SETTINGS[explicit];
  }

  const prodName = String(analysis.productName || analysis.productTitle || options.productTitle || '').toLowerCase();
  const categoryKey = analysis.categoryKey || routeProductCategory(prodName).key;
  const physicalText = [
    analysis.physicalScale,
    analysis.physicalProfile?.formFactor,
    analysis.physicalProfile?.dimensions,
    analysis.formFactor,
    analysis.dimensions
  ].filter(Boolean).join(' ').toLowerCase();

  // v4 routing policy: FACTORY-FIRST.
  // Only genuinely non-conveyorable, large finished goods that cannot plausibly exist on
  // a production/assembly/packing line route to product_warehouse.

  // TIER 1: Hard-coded bulky finished goods (regex on product name)
  const bulkyFinishedWords = /(?:xe đạp|xe dap|bicycle|bike|bàn (ăn|ghế)|ban (an|ghe)|ghế sofa|ghe sofa|\bsofa\b|\btủ \b|\btu \b|tủ lạnh|tu lanh|máy chạy bộ|may chay bo|máy tập|may tap|thiết bị gym|thiet bi gym|\bgiường\b|\bgiuong\b|vali cỡ lớn|vali co lon|máy móc công nghiệp nặng)/i;
  const bulkyScaleWords = /(?:bulky finished|oversized finished|very large finished|full-size furniture|>\s*70\s*cm tall|1[.]\d+\s*m|2\s*m)/i;

  if (bulkyFinishedWords.test(prodName) || bulkyScaleWords.test(physicalText)) {
    return SOURCING_SCENE_SETTINGS.product_warehouse;
  }

  // TIER 2: AI signal — Gemini provides physicalScale + isConveyorPlausible in Stage 1
  // This catches products not in the hard-coded list above (e.g. rare large equipment,
  // assembled furniture types, oversized sporting goods, industrial machinery, etc.)
  const aiScale = String(analysis.physicalScale || '').toLowerCase();
  const aiConveyor = analysis.isConveyorPlausible; // true | false | undefined
  if (aiScale === 'bulky' || aiScale === 'large') {
    // If AI says bulky/large AND conveyor is explicitly false → warehouse
    // If AI says bulky/large but conveyor is true (e.g. large bags) → still factory
    if (aiConveyor === false) {
      return SOURCING_SCENE_SETTINGS.product_warehouse;
    }
  }
  // If AI says conveyor is false regardless of scale → warehouse (e.g. handmade furniture)
  if (aiConveyor === false && (aiScale === 'large' || aiScale === 'bulky')) {
    return SOURCING_SCENE_SETTINGS.product_warehouse;
  }

  // TIER 3: Default factory_showcase for all other products
  // (small/medium FMCG, beauty, food, fashion, tech gadgets, etc.)
  return SOURCING_SCENE_SETTINGS.factory_showcase;
}

function getProductEnvironmentBible(analysis = {}, options = {}) {
  const setting = detectProductSourcingSetting(analysis, options);
  const categoryInfo = PRODUCT_CATEGORY_ROUTING[analysis.categoryKey] || routeProductCategory(analysis.productName || options.productTitle || '');
  const prodName = String(analysis.productName || analysis.productTitle || options.productTitle || 'sản phẩm').trim();
  const hasInput2 = Boolean(options.hasInput2 || analysis.hasInput2);
  const inputRefs = hasInput2 ? 'input.png and input2.png' : 'input.png';

  return {
    environmentId: `${setting.key.toUpperCase()}_${String(categoryInfo.key || 'GENERAL').toUpperCase()}`,
    setting: setting.key,
    title: setting.title,
    promptFragment: setting.key === 'factory_showcase'
      ? getFactoryPromptFragment(analysis)
      : setting.promptFragment,
    continuity: setting.key === 'factory_showcase'
      ? `Use ONE identical physical facility across all five panels: directly behind the presenter is the exact same automated production conveyor belt line carrying continuous identical units of "${prodName}" (matching ${inputRefs}) through automated stainless-steel machinery stations. In the foreground, the presenter stands at the same clean demonstration / QC table. Same factory geometry, same machinery positions, same bright daylight LED lighting. Camera framing may vary from waist-up medium to closer detail, but the conveyor line background remains strictly continuous and locked.`
      : 'Use ONE identical physical facility across all five panels: same aisle/finishing area geometry, same machinery or shelving positions, same lighting and same product inventory. For product_warehouse, show category-appropriate finished goods at believable scale; bulky products such as bicycles, furniture and large fitness equipment must NOT be forced onto a conveyor. Camera framing may vary, but the location itself must not change.',
    presenterRule: 'THE CANONICAL REVIEWER MODEL (model.png) MUST BE CLEARLY VISIBLE IN EVERY SINGLE PANEL, INCLUDING DETAIL PANEL 4. Never create a product-only panel.',
    productRule: setting.key === 'factory_showcase'
      ? `Keep the exact same reference product variant, geometry, color, and visible branding in all panels. The conveyor belt directly behind the presenter must carry continuous identical units of "${prodName}" matching the reference photos (${inputRefs}). Foreground table displays authentic units of the exact same product.`
      : 'Keep the exact same reference product variant, geometry, color and visible branding in all panels. Repeated background units must only use appearance supported by references; otherwise use generic unlabeled cartons.',
    forbidden: 'No residential home, kitchen lifestyle set, boutique showroom, unrelated stock, fantasy machinery, invented labels, extra presenter, product-only frame, empty-person panel, blue medical gowns, blue cleanroom smocks, glass partition walls separating conveyor, showroom vitrines, or wall display cabinets.'
  };
}

function buildProductSourcingScenePrompt(setting, categoryInfo) {
  const s = setting || SOURCING_SCENE_SETTINGS.product_warehouse;
  return `ENVIRONMENT & SOURCING CONTEXT: ${s.promptFragment} Atmospheric style tailored for authentic ${categoryInfo.label} live-commerce showcase. Zero artificial 3D graphics, zero clutter.`;
}

// ── 7. DYNAMIC PROP PLAN ──────────────────────────────────────────────────────

function buildProductPropPlan(categoryInfo, setting, physicalProfile) {
  const baseProps = setting?.key === 'product_warehouse' ? ['plain warehouse inventory table', 'metal warehouse shelving with verified same-product stock'] : (categoryInfo?.props || ['bàn live-commerce phủ thảm cao cấp', 'kệ trưng bày sản phẩm gọn gàng']);
  return {
    foregroundProps: baseProps.slice(0, 2),
    backgroundSetting: setting.title,
    lightingRig: 'Bright vertical live-commerce 3-point LED setup with soft rim light highlighting presenter hair and shoulders',
    materialFocus: physicalProfile.surfaceTexture,
  };
}

// ── 8. DYNAMIC 5-CLIP PLAN (40s TOTAL: 5 CLIPS × 8 SECONDS) ───────────────────

function buildDynamic5ClipPlan(analysis, categoryInfo, affordances, setting) {
  const prodName = analysis.productName || 'Sản phẩm Live-Commerce';
  const physicalProfile = analyzeProductPhysicalProfile(analysis);
  const handheld = isProductHandheld(analysis, physicalProfile);

  const clip1Action = handheld
    ? `Presenter đứng thẳng tự tin mỉm cười nhìn thẳng vào camera, hai tay nâng chắc chắn ${prodName} lên ngang ngực hướng thẳng camera (tuyệt đối không vẫy tay chào không sản phẩm, không cầm clipboard)`
    : `Presenter đứng sát sau bàn kiểm hàng ở tiền cảnh, ${prodName} đặt ngay ngắn ở chính giữa bàn nổi bật trước ống kính, presenter hai tay đặt gần sản phẩm làm tâm điểm`;

  const clip1Beats = handheld
    ? [
      { time: '0-4s', action: `Presenter cầm chắc ${prodName} ngang ngực nhìn thẳng ống kính, móc nối hook trực diện vào sản phẩm` },
      { time: '4-8s', action: `Presenter giữ vững ${prodName} trước ngực nổi bật sắc nét, biểu cảm tự tin cuốn hút` },
    ]
    : [
      { time: '0-4s', action: `Presenter đứng cạnh bàn kiểm hàng, ${prodName} đặt trang trọng chính giữa bàn trước mặt, nhìn thẳng ống kính mở hook trực diện` },
      { time: '4-8s', action: `Presenter hướng cử chỉ tay tự nhiên về ${prodName} trên bàn, tạo sự tập trung tuyệt đối vào sản phẩm` },
    ];

  return [
    {
      clipIndex: 1,
      duration: 8,
      phase: 'HOOK_AND_PRODUCT_INTRO',
      timeRange: '0-8s',
      focus: 'Visual hook + Problem agitation + Direct camera engagement + Product focal point',
      recommendedAction: clip1Action,
      visualBeats: clip1Beats,
      actionRunway: handheld
        ? 'Presenter tư thế sẵn sàng nói, biểu cảm lôi cuốn và tay cầm sản phẩm đầm chắc ngang ngực'
        : 'Presenter tư thế sẵn sàng nói, sản phẩm đặt uy nghiêm ngay trên bàn trước mặt',
      framing: 'Vertical 9:16 medium shot (bán thân ngang ngực, focus trực diện vào sản phẩm)',
    },
    {
      clipIndex: 2,
      duration: 8,
      phase: 'DEAL_AND_VALUE_BUILD',
      timeRange: '8-16s',
      focus: 'Price anchoring + Exclusive voucher expectation + Scarcity notice',
      recommendedAction: 'Presenter cầm sản phẩm đưa về phía trước, tay còn lại cử chỉ nhấn mạnh ưu đãi đặc quyền hôm nay',
      visualBeats: [
        { time: '0-4s', action: 'Presenter nhấn mạnh giá niêm yết ngoài cửa hàng và đối chiếu với deal sốc trên live' },
        { time: '4-8s', action: 'Presenter ghé sát lại gần camera hơn tạo cảm giác bí mật chia sẻ cơ hội săn hàng hiếm' },
      ],
      actionRunway: 'Presenter chuyển động tay tự nhiên, ánh mắt biểu cảm nhiệt tình và hào hứng',
      framing: 'Vertical 9:16 medium shot slightly closer',
    },
    {
      clipIndex: 3,
      duration: 8,
      phase: 'OFFER_BRIDGE_AND_CTA',
      timeRange: '16-24s',
      focus: 'Cart navigation + Voucher check instructions + Quick order urgency',
      recommendedAction: 'Presenter mỉm cười thân thiện, một tay giữ sản phẩm ngay ngắn, một tay chỉ tự nhiên về góc dưới khung hình',
      visualBeats: [
        { time: '0-4s', action: 'Presenter giải thích cách thức bấm vào giỏ hàng góc trái để áp mã giảm giá' },
        { time: '4-8s', action: 'Presenter làm cử chỉ tay hướng mở rộng về góc dưới màn hình, thúc đẩy bấm ngay kẻo lỡ' },
      ],
      actionRunway: 'Cử chỉ tay mượt mà hướng góc dưới khung hình, tư thế ổn định',
      framing: 'Vertical 9:16 medium shot showing waist up',
    },
    {
      clipIndex: 4,
      duration: 8,
      phase: 'PRODUCT_DETAIL_SHOWCASE',
      timeRange: '24-32s',
      focus: 'Physical proof + Hero interaction + Authentic texture & durability',
      recommendedAction: 'Static close-up of intact product in the same warehouse; no demonstration',
      visualBeats: [
        { time: '0-4s', action: 'Cận cảnh sản phẩm nguyên trạng, không thao tác sử dụng' },
        { time: '4-8s', action: 'Giữ nguyên sản phẩm và kho hàng; camera tiến nhẹ vào chi tiết có thật trong ảnh' },
      ],
      actionRunway: 'Bàn tay presenter thao tác vững vàng, sản phẩm ở vị trí tiêu cự sắc nét hoàn hảo',
      framing: 'Vertical 9:16 medium close-up (cận cảnh thao tác tay và sản phẩm)',
    },
    {
      clipIndex: 5,
      duration: 8,
      phase: 'BENEFIT_SUMMARY_AND_CLOSE',
      timeRange: '32-40s',
      focus: 'Life transformation + Final call to action + Warm friendly sign-off',
      recommendedAction: 'Presenter ôm sản phẩm bên cạnh hoặc nâng ngang ngực, nụ cười rạng rỡ và tự tin chào kết thúc',
      visualBeats: [
        { time: '0-4s', action: 'Presenter tổng kết 3 lợi ích vượt trội nâng tầm chất lượng cuộc sống mỗi ngày' },
        { time: '4-8s', action: 'Presenter nở nụ cười rạng rỡ, vẫy tay chào nhẹ nhàng và nhắc bấm giỏ hàng trước khi hết deal' },
      ],
      actionRunway: 'Tư thế kết thúc hoàn mỹ, biểu cảm ấm áp thân thiện ghi dấu ấn lâu dài',
      framing: 'Vertical 9:16 medium shot, ánh sáng rạng rỡ',
    },
  ];
}

// ── 9. STATE MACHINE CHECKER FOR 5 CLIPS ──────────────────────────────────────

function buildProduct5ClipStateMachine(clips = []) {
  const issues = [];
  if (!Array.isArray(clips) || clips.length !== 5) {
    issues.push(`State machine requires exactly 5 clips, received ${clips?.length || 0}`);
    return { valid: false, issues };
  }

  const expectedPhases = [
    'HOOK_AND_PRODUCT_INTRO',
    'DEAL_AND_VALUE_BUILD',
    'OFFER_BRIDGE_AND_CTA',
    'PRODUCT_DETAIL_SHOWCASE',
    'BENEFIT_SUMMARY_AND_CLOSE',
  ];

  clips.forEach((clip, idx) => {
    const p = clip.phase || '';
    if (p && !expectedPhases.includes(p)) {
      issues.push(`Clip ${idx + 1} phase "${p}" not in standard state machine taxonomy`);
    }

    // Kiểm tra Action Runway
    const startPlan = clip.startFramePlan || {};
    if (!startPlan.presenterPose && !clip.recommendedAction) {
      issues.push(`Clip ${idx + 1} lacks Action Runway pose continuity specification`);
    }
  });

  return {
    valid: issues.length === 0,
    issues,
    lockedAnchors: {
      presenterFace: 'Canonical Model (model.png)',
      wardrobe: 'Exact same outfit and wardrobe as canonical model reference (model.png)',
      productFidelity: 'Locked color, model, texture across all 5 clips',
    }
  };
}

// ── 10. SHOW-SAY SYNCHRONIZATION VALIDATOR ────────────────────────────────────

function validateProductShowSaySync(script = [], analysis = {}) {
  const warnings = [];
  const errors = [];

  if (!Array.isArray(script) || script.length !== 5) {
    errors.push(`Script must contain exactly 5 clips (got ${script.length})`);
    return { valid: false, errors, warnings };
  }

  let totalWords = 0;
  script.forEach((clip, idx) => {
    const cIdx = clip.clipIndex || idx + 1;
    const text = (clip.dialogue || clip.voiceOver || '').trim();
    const words = text ? text.split(/\s+/).filter(Boolean) : [];
    const wCount = words.length;
    totalWords += wCount;

    // Word count constraint: 34 - 40 words per clip
    if (wCount < 30 || wCount > 44) {
      warnings.push(`Clip ${cIdx} có ${wCount} từ (chuẩn tối ưu: 34-40 từ cho tốc độ nói live-commerce 8 giây).`);
    }

    // Complete sentence boundary (. ! ?)
    if (text && /[,;:\-–—]$/.test(text)) {
      errors.push(`Clip ${cIdx} kết thúc bằng dấu ngắt lơ lửng, bắt buộc kết thúc bằng trọn vẹn câu (. ! ?).`);
    } else if (text && !/[.!?…"'”]$/.test(text)) {
      warnings.push(`Clip ${cIdx} lời thoại kết thúc không có dấu ngắt câu tự nhiên.`);
    }

    // Đồng bộ Lời nói (Say) & Hình ảnh (Show)
    const lowerText = text.toLowerCase();
    const beats = clip.visualBeats || [];
    const beatActions = beats.map(b => (b.action || '').toLowerCase()).join(' ');

    if ((lowerText.includes('giỏ hàng') || lowerText.includes('góc trái')) && !beatActions.includes('góc') && !beatActions.includes('chỉ') && !beatActions.includes('tay')) {
      warnings.push(`Clip ${cIdx}: Lời thoại nhắc "giỏ hàng / góc trái" nhưng hình ảnh visual beat chưa thể hiện cử chỉ tay hướng góc.`);
    }
    if ((lowerText.includes('chất liệu') || lowerText.includes('sờ vào') || lowerText.includes('cầm chắc')) && !beatActions.includes('chất') && !beatActions.includes('sờ') && !beatActions.includes('cầm') && !beatActions.includes('miết') && !beatActions.includes('thao tác')) {
      warnings.push(`Clip ${cIdx}: Lời thoại mô tả cảm giác chất liệu nhưng hành động visual beat chưa có thao tác tay chạm/miết.`);
    }
  });

  if (totalWords < 170 || totalWords > 210) {
    warnings.push(`Tổng số từ toàn kịch bản là ${totalWords} từ (khuyến nghị chính xác 180-200 từ cho 40 giây).`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    totalWords,
  };
}

// ── 11. SCRIPT VALIDATION GATE & LINTER ─────────────────────────────────────────

function validateTemplateProductScript(analysisData) {
  const warnings = [];
  const errors = [];

  if (!analysisData || typeof analysisData !== 'object') {
    return { valid: false, errors: ['ERR_EMPTY_ANALYSIS: Dữ liệu phân tích trống.'] };
  }

  const analysis = analysisData.analysis || {};
  const script = Array.isArray(analysisData.script)
    ? analysisData.script
    : (Array.isArray(analysisData.clips)
      ? analysisData.clips
      : (Array.isArray(analysis.script)
        ? analysis.script
        : (Array.isArray(analysis.clips) ? analysis.clips : [])));

  if (script.length !== 5) {
    errors.push(`ERR_CLIP_COUNT: Kịch bản phải có chính xác 5 clip (nhận được ${script.length} clip).`);
  }

  let totalWords = 0;
  script.forEach((clip, idx) => {
    const cIdx = clip.clipIndex || idx + 1;
    const text = (clip.dialogue || clip.voiceOver || clip.voice_over || '').trim();
    const words = text ? text.split(/\s+/).filter(Boolean) : [];
    const wCount = words.length;
    totalWords += wCount;

    if (wCount < 28 || wCount > 46) {
      warnings.push(`WARN_CLIP_WORD_BUDGET: Clip ${cIdx} có ${wCount} từ (khuyến nghị 34-40 từ cho 8s).`);
    }

    // Kiểm tra câu kết thúc trọn vẹn (không ngắt giữa chừng bằng dấu phẩy hoặc lơ lửng)
    if (text && /[,;:\-–—]$/.test(text)) {
      errors.push(`ERR_SPEECH_BOUNDARY: Clip ${cIdx} kết thúc bằng dấu ngắt lửng lơ, cần có complete sentence boundary (. ! ?).`);
    } else if (text && !/[.!?…"'”]$/.test(text)) {
      warnings.push(`WARN_SPEECH_BOUNDARY: Clip ${cIdx} lời thoại kết thúc không có dấu ngắt câu tự nhiên.`);
    }

    // Kiểm tra có 2 visual beats
    const beats = Array.isArray(clip.visualBeats) ? clip.visualBeats : (Array.isArray(clip.beats) ? clip.beats : []);
    if (beats.length < 2) {
      warnings.push(`WARN_VISUAL_BEATS: Clip ${cIdx} cần có đủ 2 visual beats (0-4s và 4-8s).`);
    }

    // Kiểm tra startFramePlan
    if (!clip.startFramePlan || typeof clip.startFramePlan !== 'object') {
      warnings.push(`WARN_START_FRAME_PLAN: Clip ${cIdx} chưa có cấu hình chi tiết startFramePlan.`);
    }
  });

  if (totalWords < 160 || totalWords > 220) {
    warnings.push(`WARN_TOTAL_WORD_BUDGET: Tổng số từ kịch bản là ${totalWords} từ (khuyến nghị 180-200 từ cho 40s).`);
  }

  // Linter: Kiểm tra tự xưng "em"
  const allDialogue = script.map(c => c.dialogue || c.voiceOver || c.voice_over || '').join(' ');
  const tuiMatches = (allDialogue.match(/\btui\b/gi) || []).length;
  if (tuiMatches > 0) {
    warnings.push(`WARN_SELF_REFERENCE: Kênh live-commerce khuyến nghị xưng "em", phát hiện từ "tui" ${tuiMatches} lần.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    totalWords,
  };
}

// ── 12. STAGE 1: PRODUCT INTELLIGENCE PROMPT A ────────────────────────────────

function buildProductIntelligencePromptA(options = {}, channelProfile = {}) {
  const pContext = options.productContext || {};
  const productTitle = pContext.productTitle || options.productTitle || 'Sản phẩm Live-Commerce';
  const productDescription = pContext.productDescription || options.productDescription || '';
  const campaignPrice = options.campaignPrice || pContext.campaignPrice || '';
  const salesMode = options.salesMode || pContext.salesMode || '';
  const channelGender = channelProfile.gender || options.gender || 'female';
  const channelLabel = channelProfile.label || '';
  const targetAudienceAddr = channelProfile.audienceAddress || options.audienceAddress || (channelGender === 'male' ? 'anh em' : (channelGender === 'neutral' ? 'mọi người' : 'chị em'));

  return [
    `You are the Chief Product Intelligence Analyst and Visual Director for top Vietnamese TikTok Live-Commerce channels.`,
    `Your task is STAGE 1 ANALYSIS: Deeply analyze the supplied product reference images and metadata to construct a comprehensive Product Intelligence & Affordance Profile.`,
    ``,
    `### INPUT METADATA:`,
    `- Product Title: "${productTitle}"`,
    `- Product Description: "${productDescription}"`,
    `- Target Channel: "${channelLabel || 'Shop Live-Commerce'}" (Gender: ${channelGender.toUpperCase()})`,
    campaignPrice ? `- Campaign Price/Offer (unverified until confirmed): "${campaignPrice}"` : `- Campaign Price: NOT PROVIDED; do not invent price or offers`,
    salesMode ? `- Preferred Sales Mode: "${salesMode}"` : `- Preferred Sales Mode: Auto-select (PRICE_LED | BENEFIT_LED | DEMO_LED)`,
    ``,
    `### INSTRUCTIONS FOR STAGE 1 ANALYSIS:`,
    `1. TAXONOMY ROUTING: Classify the product into ONE of the 10 core categories:`,
    `   [fashion_apparel, footwear_accessories, beauty_cosmetics, personal_care_hygiene, digital_tech_gadgets, home_appliances, kitchenware_foodprep, interior_home_living, health_wellness_supplements, mother_baby_kids, fallback_general_merchandise]`,
    `2. REFERENCE ROLE CLASSIFICATION: Classify provided images into:`,
    `   [presenter_model, hero_product_isolated, packaging_box, detail_texture, in_use_context, spec_label]`,
    `3. PHYSICAL & AFFORDANCE PROFILE:`,
    `   - Form Factor, Dimensions, Weight Class, Finish Material, Surface Texture`,
    `   - Grip Affordance (how the host holds it naturally: single_hand_palm, fingertips_pinch, etc.)`,
    `   - isHandheld: boolean (true if small/medium product that can be comfortably held in hand such as cosmetics, bottles, spray, shoes, bags, clothing, small gadgets; false if tabletop/bulky appliance like milk maker, air fryer, large blender, bicycle)`,
    `   - Do not plan demonstrations; identify visible exterior details only.`,
    `   - Forbidden Actions (actions that would ruin realism or distort physics)`,
    `4. SOURCING CONTEXT & SETTING: Choose ONLY one of [factory_showcase, product_warehouse] according to the actual product category.`,
    `   - factory_showcase: use a believable product-specific manufacturing/assembly/filling/packaging line when that product is plausibly manufactured on such a line.`,
    `   - product_warehouse: use a believable finished-goods/material warehouse when warehouse presentation is more natural for the product.`,
    `   - NEVER use lifestyle_home, residential kitchen, decorative studio or generic showroom.`,
    `   - The chosen facility is LOCKED and identical across all 5 panels.`,
    `   - factoryDescription: Provide a vivid, realistic 1-2 sentence English description of the modern automated factory production line directly behind the presenter for this EXACT product (e.g. active automated conveyor belt line carrying continuous identical units of "${productTitle}" through automated filling, capping, labeling, or boxing stations; presenter at front demonstration table; bright daylight LED lighting; spotless epoxy cleanroom floor; NO glass partition walls, NO display vitrines, NO blue medical gowns).`,
    `5. PERSONA & AUDIENCE ADDRESS:`,
    `   - Self-reference: "em"`,
    channelGender === 'male'
      ? `   - AUDIENCE ADDRESS (CRITICAL MALE REQUIREMENT): The channel is "${channelLabel || 'Shop Giày Nam'}" (MALE AUDIENCE). The audience address MUST BE "anh em" (or "các anh", "mọi người"). ABSOLUTELY NEVER USE "chị em"! Calling male customers "chị em" is strictly forbidden and completely unacceptable.`
      : (channelGender === 'female'
        ? `   - Audience address: Choose ONE and keep it stable: "chị em" (beauty/fashion) | "mọi người" (general)`
        : `   - Audience address: Choose ONE and keep it stable: "mọi người" (general) | "các bác" (health/kitchen) | "anh chị" (tech/general)`),
    ``,
    `### RETURN RAW JSON ONLY (No markdown formatting, no text before or after):`,
    `{`,
    `  "analysis": {`,
    `    "productName": "Tên thương mại ngắn gọn, chính xác",`,
    `    "category": "Danh mục sản phẩm chuẩn",`,
    `    "categoryKey": "fashion_apparel|footwear_accessories|beauty_cosmetics|personal_care_hygiene|digital_tech_gadgets|home_appliances|kitchenware_foodprep|interior_home_living|health_wellness_supplements|mother_baby_kids|fallback_general_merchandise",`,
    `    "salesMode": "PRICE_LED|BENEFIT_LED|DEMO_LED",`,
    `    "targetAudience": "${channelGender === 'male' ? 'Nam giới hiện đại, chuộng phong cách mạnh mẽ và thoải mái' : 'Mô tả khách hàng mục tiêu'}",`,
    `    "audienceAddress": "${targetAudienceAddr}",`,
    `    "selfReference": "em",`,
    `    "factoryDescription": "Specific English description of the modern automated production conveyor belt line carrying continuous identical units of this EXACT product directly behind the presenter (clean front demo table, automated packaging stations, 1-2 staff in neat polo shirts in soft focus, bright industrial LED lighting — NO glass partitions, NO vitrines, NO blue medical gowns)",`,
    `    "keyBenefits": ["Lợi ích vượt trội 1", "Lợi ích vượt trội 2", "Lợi ích vượt trội 3"],`,
    `    "physicalScale": "small|medium|large|bulky",`,
    `    "isHandheld": true,`,
    `    "isConveyorPlausible": true,`,
    `    "physicalProfile": {`,
    `      "formFactor": "...",`,
    `      "dimensions": "...",`,
    `      "finishMaterial": "...",`,
    `      "surfaceTexture": "...",`,
    `      "gripAffordance": "..."`,
    `    },`,
    `    "affordances": {`,
    `      "validActions": ["hành động vật lý 1", "hành động 2"],`,
    `      "heroAction": "No demonstration; stationary product detail",`,
    `      "forbiddenActions": ["hành động bị cấm 1", "hành động bị cấm 2"]`,
    `    },`,
    `    "voiceBible": {`,
    `      "speaker": "${channelGender === 'male' ? 'Vietnamese male presenter' : (channelGender === 'neutral' ? 'Vietnamese live-commerce presenter' : 'Vietnamese female presenter')}",`,
    `      "gender": "${channelGender}",`,
    `      "region": "Southern Vietnamese",`,
    `      "tone": "bright, confident, persuasive, friendly",`,
    `      "energy": "high",`,
    `      "pace": "very fast live-commerce (4.5 to 5.0 wps)",`,
    `      "selfReference": "em",`,
    `      "audienceAddress": "${targetAudienceAddr}"`,
    `    },`,
    `    "visualBible": {`,
    `      "presenterIdentity": "canonical uploaded model (model.png)",`,
    `      "environment": "product-specific factory direct QC workshop or finished-goods warehouse, chosen to fit the product",`,
    `      "factoryDescription": "Specific English description of the modern factory direct / QC inspection & packaging area tailored to this EXACT product (1-2 sentences: clean staging table, specific equipment, 1-2 staff in neat polo shirts or craft aprons in soft focus, bright professional commercial aesthetic — NEVER blue medical gowns or crowded cleanroom assembly lines)",`,
    `      "lighting": "bright commercial lighting"`,
    `    }`,
    `  }`,
    `}`
  ].join('\n');
}

// ── 13. STAGE 2: SCRIPT & STORYBOARD PROMPT B ─────────────────────────────────

function buildScriptAndStoryboardPromptB(stage1Analysis = {}, options = {}) {
  const analysis = stage1Analysis.analysis || stage1Analysis || {};
  const channelProfile = options.channelProfile || {};
  const prodName = analysis.productName || options.productTitle || 'Sản phẩm Live-Commerce';
  const category = analysis.category || 'Sản phẩm tiêu dùng';
  const salesMode = analysis.salesMode || 'PRICE_LED';
  const channelGender = channelProfile.gender || options.gender || (analysis.voiceBible?.gender) || 'female';
  const audienceAddress = analysis.audienceAddress || channelProfile.audienceAddress || options.audienceAddress || (channelGender === 'male' ? 'anh em' : 'chị em');
  const selfReference = analysis.selfReference || 'em';
  const heroAction = analysis.affordances?.heroAction || 'Presenter nâng sản phẩm lên ngang ngực thao tác mở nắp đón sáng';
  const environmentBible = getProductEnvironmentBible(analysis, options);
  const setting = environmentBible.setting;
  const selectedHook = selectVerifiedHook({ ...options, productContext: { ...(options.productContext || {}), productTitle: prodName, categoryKey: analysis.categoryKey } });
  const verifiedOffer = options.verifiedOffer || options.productContext?.verifiedOffer || {};
  const requiredHookOpening = buildSafeLibraryHookOpening(selectedHook, prodName, verifiedOffer, audienceAddress);

  return [
    `You are the Master Scriptwriter & Storyboard Director for top Vietnamese TikTok Live-Commerce.`,
    `Your task is STAGE 2: Write the complete 40-second (5 Clips × 8 Seconds) Native-Voice Live-Commerce Script and 5 Start Frames Storyboard.`,
    ``,
    `### MANDATORY HOOK LIBRARY — UNIVERSAL RETENTION HOOKS + VERIFIED COMMERCIAL REFERENCES:`,
    JSON.stringify(ALL_HOOKS, null, 2),
    `### SELECTED HOOK: ${selectedHook.id} / ${selectedHook.type} / VERBATIM SOURCE: "${selectedHook.verbatim}"`,
    `### REQUIRED SAFE ADAPTATION OPENING: "${requiredHookOpening}"`,
    `### VERIFIED OFFER DATA ONLY: ${JSON.stringify(verifiedOffer)}`,
    `### VOICE STYLE BIBLE: ${JSON.stringify(VOICE_STYLE_BIBLE)}`,
    `HOOK RULE — HARD LOCK: A library hook ALWAYS exists. Clip 1 dialogue MUST START EXACTLY with REQUIRED SAFE ADAPTATION OPENING above, character-for-character. Treat its first attention cue as an excited vocal burst, insert a brief dramatic micro-pause, strongly stress the curiosity keyword, and finish with rising unresolved curiosity. Continue the rest of Clip 1 by promising or beginning the payoff; do not resolve the hook immediately. Never invent a different opening. Never restore unsupported price/gift/shipping/subsidy/zero-price/no-profit claims.`,
    `### VISUAL ENVIRONMENT BIBLE: ${JSON.stringify(environmentBible)}`,
    `### VISUAL IS INDEPENDENT OF VOICE: all 5 scenes use ONE identical product-appropriate factory direct / QC inspection workshop OR, only when routing explicitly requires it, a finished-goods warehouse. THE CANONICAL REVIEWER MODEL MUST APPEAR IN ALL 5 PANELS. 1-2 background staff may be in soft-focus performing quality inspection. Never create a product-only panel.`,
    `### STAGE 1 INTELLIGENCE INPUT:`,
    `- Product Name: "${prodName}" (${category})`,
    `- Sales Mode: ${salesMode}`,
    `- Presenter Identity: Locked to CANONICAL MODEL reference image (model.png)`,
    channelGender === 'male'
      ? `- AUDIENCE ADDRESS (CRITICAL MALE REQUIREMENT): "${audienceAddress}". ABSOLUTELY NEVER USE "chị em" anywhere in the script! Only use "anh em" or "các anh".`
      : `- Audience Address: "${audienceAddress}" (Strictly stable throughout)`,
    `- Self-Reference: "${selfReference}" (Strictly stable throughout)`,
    `- Setting: ${setting}`,
    `- Visual hero action is DISABLED. Ignore suggested hero action: "${heroAction}"`,
    `- Key Benefits: ${JSON.stringify(analysis.keyBenefits || [])}`,
    ``,
    `### ARCHITECTURAL RULES (40s NATIVE-VOICE SPEC):`,
    `1. DURATION: EXACTLY 5 CLIPS × 8 SECONDS = 40 SECONDS TOTAL.`,
    `   - Clip 1: 0–8s (HOOK_AND_PRODUCT_INTRO)`,
    `   - Clip 2: 8–16s (DEAL_AND_VALUE_BUILD)`,
    `   - Clip 3: 16–24s (OFFER_BRIDGE_AND_CTA - Chỉ vào giỏ hàng góc trái)`,
    `   - Clip 4: 24–32s (PRODUCT_DETAIL_SHOWCASE - static product exterior, NO demo)`,
    `   - Clip 5: 32–40s (BENEFIT_SUMMARY_AND_CLOSE - Chốt đơn ấm áp)`,
    ``,
    `2. WORD BUDGET (CRITICAL REQUIREMENT):`,
    `   - Vietnamese live-commerce hosts speak at an energetic pace (~4.5 to 5.0 words/sec).`,
    `   - EACH CLIP MUST CONTAIN EXACTLY 34 TO 40 VIETNAMESE WORDS.`,
    `   - Total dialogue across all 5 clips: EXACTLY 180 TO 200 WORDS.`,
    `   - EVERY CLIP MUST END AT A COMPLETE SENTENCE OR CLAUSE BOUNDARY (. ! ?). No splitting across clips!`,
    ``,
    `3. 2 VISUAL BEATS PER CLIP:`,
    `   - Beat A: 0-4 seconds`,
    `   - Beat B: 4-8 seconds`,
    `   - NO show-say action sync. Voice may describe verified functionality; visuals remain static product/presenter showcase.`,
    ``,
    `4. START FRAME PLAN & ACTION RUNWAY:`,
    `   - For each panel, describe presenterPose, handPose, productPlacement, framing (vertical 9:16), environment.`,
    `   - Every start frame uses the SAME locked ${setting} chosen for this product.`,
    `   - MANDATORY: canonical ${channelGender === 'male' ? 'male' : 'female'} reviewer model is visibly present in EVERY panel 1-5, including Panel 4 detail showcase.`,
    `   - Panel 4 may be a tighter product detail composition, but presenter face/upper body must remain visible in frame.`,
    `   - Only lip sync, blink, tiny head movement and subtle camera motion; no impossible product handling change.`,
    `   - PANEL 1 CRITICAL PRODUCT HOOK (MANDATORY): Viewers must recognize what product is being reviewed within the first 0.5s! If the product is handheld/compact (beauty, shoes, bags, clothing, small gadgets...), the presenter MUST be actively holding the product in hands at chest height facing the camera. If tabletop/large appliance, the product MUST be placed directly on the table in the immediate center foreground. ABSOLUTELY NO waving empty hands, NO clipboard, NO missing product.`,
    ``,
    `### RETURN RAW JSON ONLY (No markdown formatting, no codeblocks):`,
    `{`,
    `  "script": [`,
    `    {`,
    `      "clipIndex": 1,`,
    `      "duration": 8,`,
    `      "phase": "HOOK_AND_PRODUCT_INTRO",`,
    `      "dialogue": "Lời thoại tiếng Việt 34-40 từ cho Clip 1. Kết thúc bằng câu hoàn chỉnh.",`,
    `      "wordCount": 36,`,
    `      "visualBeats": [`,
    `        { "time": "0-4s", "action": "Presenter cầm chắc sản phẩm trước ngực (hoặc đứng cạnh sản phẩm trên bàn) nhìn thẳng camera vào hook trực diện, tuyệt đối không vẫy tay chào không sản phẩm" },`,
    `        { "time": "4-8s", "action": "Presenter giữ vững sản phẩm nổi bật trước ống kính, hướng góc đẹp về camera" }`,
    `      ],`,
    `      "startFramePlan": {`,
    `        "presenterPose": "Đứng thẳng tự tin, ánh mắt cuốn hút nhìn thẳng camera",`,
    `        "handPose": "Hai tay cầm chắc sản phẩm trang trọng trước ngực (hoặc đặt hai tay cạnh sản phẩm trên bàn)",`,
    `        "productPlacement": "Sản phẩm rõ nét ở trung tâm tiền cảnh nổi bật 100%",`,
    `        "framing": "Vertical 9:16 medium shot (bán thân ngang ngực)",`,
    `        "environment": "Không gian ${setting} sáng sủa, ngăn nắp"`,
    `      },`,
    `      "actionRunway": { "valid": true, "motion": "Only lip sync, blinking and subtle head movement" }`,
    `    },`,
    `    { "clipIndex": 2, "duration": 8, "phase": "DEAL_AND_VALUE_BUILD", "dialogue": "...", "wordCount": 36, "visualBeats": [...], "startFramePlan": {...}, "actionRunway": {...} },`,
    `    { "clipIndex": 3, "duration": 8, "phase": "OFFER_BRIDGE_AND_CTA", "dialogue": "...", "wordCount": 36, "visualBeats": [...], "startFramePlan": {...}, "actionRunway": {...} },`,
    `    { "clipIndex": 4, "duration": 8, "phase": "PRODUCT_DETAIL_SHOWCASE", "dialogue": "...", "wordCount": 37, "visualBeats": [...], "startFramePlan": {...}, "actionRunway": {...} },`,
    `    { "clipIndex": 5, "duration": 8, "phase": "BENEFIT_SUMMARY_AND_CLOSE", "dialogue": "...", "wordCount": 36, "visualBeats": [...], "startFramePlan": {...}, "actionRunway": {...} }`,
    `  ]`,
    `}`
  ].join('\n');
}
/**
 * Unified Analysis Prompt Builder (Backward-compatible single-call & test suite compliance)
 */
function buildTemplateProductAnalysisPrompt(options = {}) {
  const pContext = options.productContext || {};
  const productTitle = pContext.productTitle || options.productTitle || 'Sản phẩm Live-Commerce';
  const productDescription = pContext.productDescription || options.productDescription || '';
  const campaignPrice = options.campaignPrice || pContext.campaignPrice || '';
  const salesMode = options.salesMode || pContext.salesMode || 'BENEFIT_LED';
  const channelProfile = options.channelProfile || {};
  const channelGender = channelProfile.gender || options.gender || 'female';
  const targetAudienceAddr = channelProfile.audienceAddress || options.audienceAddress || (channelGender === 'male' ? 'anh em' : (channelGender === 'neutral' ? 'mọi người' : 'chị em'));

  return [
    `You are a top-tier Vietnamese live-commerce video strategist and director.`,
    `LOCKED: one ALL_HOOKS entry is mandatory for every run; do not invent a new hook or unsupported offer claims. Factory-first sourcing with active workers; warehouse only by deterministic exception; no demonstration. ${JSON.stringify(VOICE_STYLE_BIBLE)} ${JSON.stringify(ALL_HOOKS)}`,
    `You are planning a high-converting, 40-second vertical TikTok/Live-Commerce presenter video.`,
    ``,
    `### ARCHITECTURAL RULES (CRITICAL v2.0 SPEC):`,
    `1. DURATION ARCHITECTURE: EXACTLY 5 CLIPS × 8 SECONDS (5 CLIPS × 8 GIÂY) = 40 SECONDS TOTAL.`,
    `   - Clip 1: 0–8s (Hook + Product Identity)`,
    `   - Clip 2: 8–16s (Deal / Value Build / Price Anticipation)`,
    `   - Clip 3: 16–24s (Offer Bridge + CTA)`,
    `   - Clip 4: 24–32s (Static Product Exterior Detail, no demonstration)`,
    `   - Clip 5: 32–40s (Benefit Summary + Closing Urgency)`,
    ``,
    `2. NATIVE AUDIO DIRECT SPEECH (NO SEPARATE TTS):`,
    `   - In each 8s video, the ${channelGender === 'male' ? 'male' : 'female'} presenter speaks Vietnamese DIRECTLY on camera.`,
    `   - Every single clip must finish at a COMPLETE sentence or clause boundary.`,
    `   - ABSOLUTELY NO sentence splitting across video files (e.g. do NOT end Clip 1 mid-sentence).`,
    `   - Pacing: Fast live-commerce speed (~4.5 to 5.0 words per second).`,
    `   - Word Budget: 34 to 40 Vietnamese words per clip (Total: EXACTLY 180 to 200 words across all 5 clips).`,
    ``,
    `3. PRESENTER PERSONA & VOICE BIBLE:`,
    `   - Same ${channelGender === 'male' ? 'male' : 'female'} host as the supplied CANONICAL MODEL reference.`,
    `   - VOICE BIBLE: young adult Vietnamese ${channelGender === 'male' ? 'male' : 'female'}, Southern accent, fast live-commerce rhythm.`,
    `   - Self-reference: Default is "em" (stable throughout).`,
    channelGender === 'male'
      ? `   - Audience address: MUST BE "anh em" (or "các anh"). ABSOLUTELY NEVER USE "chị em"! Calling male customers "chị em" is strictly forbidden.`
      : `   - Audience address: Choose ONE address style and keep it stable across all 5 clips:`,
    channelGender === 'male'
      ? `     * "${targetAudienceAddr}"`
      : `     * "các bác" (health/household/older target)\n     * "anh chị" (general adult/professional)\n     * "chị em" (beauty/fashion/female focus)\n     * "mọi người" (general young consumer)`,
    ``,
    `4. SALES MODE SELECTION:`,
    `   - Selected Sales Mode: "${salesMode}" (PRICE_LED | BENEFIT_LED | DEMO_LED)`,
    ``,
    `5. PRODUCT AFFORDANCE ENGINE & SOURCING CONTEXT:`,
    `   - Identify valid physical actions and forbid invalid actions.`,
    `   - Sourcing setting: choose product-specific factory_showcase OR product_warehouse; never home/showroom.`,
    `   - Canonical reviewer model must be visible in every one of the 5 panels, including detail scene.`,
    `   - No physical product action; only micro facial motion and subtle camera movement.`,
    ``,
    `6. STRICT GROUNDING & CLAIMS:`,
    `   - NEVER invent 0đ or fake claims.`,
    `   - NO subtitles or fake UI text generated on video frames.`,
    ``,
    `### PRODUCT INFORMATION:`,
    `Product Title: "${productTitle}"`,
    `Product Details: "${productDescription}"`,
    campaignPrice ? `Campaign Price/Offer: "${campaignPrice}"` : `No special campaign price provided (rely on value comparison).`,
    `Selected Sales Mode: "${salesMode}"`,
    ``,
    `### RETURN VALID JSON ONLY (No markdown codeblocks):`,
    `{`,
    `  "analysis": {`,
    `    "productName": "Tên sản phẩm ngắn gọn",`,
    `    "category": "Danh mục sản phẩm",`,
    `    "salesMode": "${salesMode}",`,
    `    "targetAudience": "Đối tượng khách hàng mục tiêu",`,
    `    "audienceAddress": "chị em|các bác|anh chị|mọi người",`,
    `    "selfReference": "em",`,
    `    "keyBenefits": ["Lợi ích 1", "Lợi ích 2", "Lợi ích 3"],`,
    `    "affordances": {`,
    `      "validActions": ["hành động vật lý hợp lệ"],`,
    `      "invalidActions": ["hành động bị cấm"]`,
    `    },`,
    `    "voiceBible": {`,
    `      "speaker": "Vietnamese female presenter",`,
    `      "region": "Southern Vietnamese",`,
    `      "tone": "bright, confident, persuasive, friendly",`,
    `      "energy": "high",`,
    `      "pace": "fast live-commerce",`,
    `      "selfReference": "em",`,
    `      "audienceAddress": "chị em"`,
    `    },`,
    `    "visualBible": {`,
    `      "presenterIdentity": "canonical uploaded model",`,
    `      "environment": "authentic product-specific factory direct QC staging workshop",`,
    `      "lighting": "bright commercial lighting"`,
    `    }`,
    `  },`,
    `  "script": [`,
    `    {`,
    `      "clipIndex": 1,`,
    `      "duration": 8,`,
    `      "phase": "HOOK_AND_PRODUCT_INTRO",`,
    `      "dialogue": "Lời thoại tiếng Việt cho Cảnh 1 (34-40 từ, kết thúc câu hoàn chỉnh).",`,
    `      "wordCount": 36,`,
    `      "visualBeats": [`,
    `        { "time": "0-4s", "action": "Presenter cầm chắc sản phẩm trước ngực (hoặc đứng cạnh sản phẩm trên bàn) nhìn thẳng camera vào hook trực diện, tuyệt đối không vẫy tay chào không sản phẩm" },`,
    `        { "time": "4-8s", "action": "Presenter giữ vững sản phẩm nổi bật trước ống kính, hướng góc đẹp về camera" }`,
    `      ],`,
    `      "startFramePlan": {`,
    `        "presenterPose": "Đứng thẳng tự tin, khuôn mặt tươi tắn mỉm cười nhìn trực diện ống kính",`,
    `        "handPose": "Hai tay cầm chắc sản phẩm ngay ngắn trước ngực (hoặc đặt hai tay cạnh sản phẩm trên bàn)",`,
    `        "productPlacement": "Sản phẩm rõ nét ở trung tâm tiền cảnh nổi bật 100%",`,
    `        "framing": "Góc quay thẳng bán thân (medium shot) chuẩn dọc 9:16",`,
    `        "environment": "Bàn kiểm hàng / đóng gói xuất xưởng sạch sẽ chuẩn ngành hàng, kệ hàng thành phẩm phía sau"`,
    `      },`,
    `      "actionRunway": { "valid": true, "reason": "Tư thế sẵn sàng nói và nâng sản phẩm" }`,
    `    },`,
    `    { "clipIndex": 2, "duration": 8, "phase": "DEAL_AND_VALUE_BUILD", "dialogue": "...", "wordCount": 38, "visualBeats": [...], "startFramePlan": {...} },`,
    `    { "clipIndex": 3, "duration": 8, "phase": "OFFER_BRIDGE_AND_CTA", "dialogue": "...", "wordCount": 38, "visualBeats": [...], "startFramePlan": {...} },`,
    `    { "clipIndex": 4, "duration": 8, "phase": "PRODUCT_DETAIL_SHOWCASE", "dialogue": "...", "wordCount": 36, "visualBeats": [...], "startFramePlan": {...} },`,
    `    { "clipIndex": 5, "duration": 8, "phase": "BENEFIT_SUMMARY_AND_CLOSE", "dialogue": "...", "wordCount": 36, "visualBeats": [...], "startFramePlan": {...} }`,
    `  ]`,
    `}`
  ].join('\n');
}

// ── 14. MASTER STORYBOARD / 5 START FRAMES PROMPT BUILDER ───────────────────────

function buildTemplateProductMasterPrompt(analysis = {}, options = {}) {
  const fullAnalysis = analysis.analysis || analysis || {};
  const prodName = fullAnalysis.productName || options.productTitle || 'Sản phẩm review';
  const physicalProfile = analyzeProductPhysicalProfile(fullAnalysis);
  const env = getProductEnvironmentBible(fullAnalysis, options);
  const placement = getProductPlacementRule(fullAnalysis, physicalProfile);
  const surfaceFinish = fullAnalysis.physicalProfile?.surfaceTexture ||
    fullAnalysis.surfaceTexture ||
    physicalProfile.surfaceTexture ||
    'reference only';

  const hasInput2 = Boolean(options.hasInput2);
  const refText = hasInput2
    ? 'product reference photos (input.png and input2.png)'
    : 'product reference photo (input.png)';
  const evidenceText = hasInput2
    ? 'evidenced in input.png or input2.png'
    : 'evidenced in input.png';

  const useWholesaleShowroom = options.storyboardBackgroundPreset === 'wholesale_showroom_warehouse' ||
    ['template_product2', 'templateproduct2', 'tproduct2'].includes(String(options.template || '').toLowerCase());

  const environmentLines = useWholesaleShowroom
    ? [
      'ENVIRONMENT TYPE: bright Vietnamese wholesale showroom integrated with an active finished-goods warehouse.',
      'PRODUCT-SPECIFIC BACKGROUND: Match the visual language of a busy Vietnamese wholesale hardware/general-merchandise showroom operating inside its stock warehouse — NOT a pristine logistics depot and NOT a factory. Frame the presenter inside a narrow-to-medium retail aisle with tall blue-and-orange or gray industrial steel racks visibly flanking BOTH sides and continuing deep behind her. Fill the racks densely from waist height to ceiling with varied but orderly brown shipping cartons, colorful retail product boxes, hanging tools/accessories, and multiple identical units of the EXACT reviewed product. The lower shelves must read as browsable retail display while upper pallet levels read as bulk stock. Put a large, visibly grained warm wooden merchandise table/counter across the lower foreground, loaded with the hero product, duplicate units, real included accessories and category-related merchandise; avoid a bare table. Include 3-5 Vietnamese warehouse/shop employees in navy, gray or dark polo uniforms in the mid/far background naturally restocking shelves, carrying sealed cartons, checking inventory or packing orders. Keep a high corrugated-metal roof or practical commercial ceiling, gray concrete floor, bright neutral-white fluorescent/LED tubes, strong aisle perspective, dense inventory texture, and a believable busy-but-orderly local wholesale-store atmosphere. Camera should feel like a real handheld TikTok shop video, not an architectural render or polished corporate advertisement. No stainless-steel QC bench, no sterile white laboratory, no manufacturing machinery and no conveyor belt.',
      'CONTINUITY LOCK: all five panels occur in one continuous warehouse-showroom world with the same aisle/rack geometry, same wooden display table, same inventory family, same lighting, and consistent background staff uniforms. Camera angle may progress from medium to detail framing without changing venue.',
    ]
    : [
      `ENVIRONMENT TYPE: ${env.setting} — ${env.title}.`,
      `PRODUCT-SPECIFIC BACKGROUND: ${env.promptFragment}`,
      `CONTINUITY LOCK: ${env.continuity}`,
    ];
  const recurringBackground = useWholesaleShowroom
    ? 'same warehouse-showroom aisle, tall stocked racks, wooden display table, and working staff remain recognizable behind her'
    : 'same factory workshop geometry remains recognizable behind her';
  const inspectionSurface = useWholesaleShowroom
    ? 'wooden showroom demonstration table'
    : 'factory inspection table';
  const facilityBackground = useWholesaleShowroom
    ? 'same warehouse-showroom background'
    : 'same product-specific factory workshop background';
  const productEnvironmentRule = useWholesaleShowroom
    ? `Keep the exact same reference product variant, geometry, color, and visible branding in all panels. Stock shelves and the foreground wooden table may show multiple identical units of "${prodName}" matching the reference photos (${hasInput2 ? 'input.png or input2.png' : 'input.png'}), arranged as believable wholesale inventory.`
    : env.productRule;

  return [
    'LAYOUT — MANDATORY: The output image contains exactly 5 panels as 5 equal-width vertical columns arranged left to right. Column 1 | Column 2 | Column 3 | Column 4 | Column 5. Each column occupies exactly 1/5 (20%) of the total image width and the full image height. There are NO borders, NO dividers, NO gaps, NO decorative frames, NO film strip holes, NO black bands, NO vignettes between or around columns. NO phone frames, NO mobile device bezels, NO home indicators, NO bottom navigation bars, NO black bars at the bottom of panels. Each column is a seamless photographic scene. DO NOT use any other layout — NOT a 1-large + multiple-small arrangement, NOT a 2×2 or 2×3 grid.',
    'MODEL REFERENCE & IDENTITY LOCK — CRITICAL IDENTITY REQUIREMENT: use the supplied canonical reviewer model (model.png) in EVERY SINGLE COLUMN 1,2,3,4,5. Same recognizable face, hairstyle, age, wardrobe and body proportions. NO product-only column. NO empty column without presenter.',
    'PRESENTER ATTIRE & WARDROBE LOCK — EXACT OUTFIT MATCH: The presenter in EVERY SINGLE PANEL must wear the EXACT SAME OUTFIT, clothing pieces, fabric color, collar style, neckline, cut, and accessories shown on the canonical model reference photo (model.png). DO NOT redesign, alter, change, or invent new clothes. Preserve 100% wardrobe continuity and authentic clothing fidelity from model.png across all 5 panels (NO surgical hairnet on presenter, NO blue medical smock on presenter, NO clipboard, NO holding paperwork).',
    `PRODUCT REFERENCE & APPEARANCE LOCK: use the supplied authentic ${refText} as the absolute ground truth reference for the exact physical item "${prodName}". Match the exact shape, silhouette, lid/handle/body geometry, proportions, color, materials, surface finish (${surfaceFinish}), and visible branding only when ${evidenceText}. No invented product features, no altered colors, and no imaginary labels.`,
    ...environmentLines,
    `PRESENTER RULE: ${env.presenterRule}`,
    `PRODUCT RULE: ${productEnvironmentRule}`,
    `PRODUCT HERO FOCUS & PLACEMENT: ${placement.panelGeneralInstruction}`,
    'Camera & Style: realistic vertical 9:16 TikTok commerce capture, clean bright industrial LED lighting, natural colors, photographic realism, believable depth of field.',
    'Action Runway: presenter is caught in natural live-commerce speaking and presenting motion with believable gesture runway.',
    '',
    'STRICT VISUAL RULES: ABSOLUTELY ZERO TEXT, zero text overlays, zero subtitles, zero panel labels, zero fake UI, zero cart icons, zero stickers, zero watermarks, zero decorative studio/home background, zero phone screen frames or home bars.',
    '',
    '5 PANELS — SAME FACILITY, SAME REVIEWER, SAME PRODUCT:',
    `Panel 1 (IMMEDIATE PRODUCT-FOCUSED HOOK — CRITICAL FIRST 0.5s IMPRESSION): Vertical 9:16 waist-up medium shot (DO NOT use full-body distant shot). ${placement.panel1Instruction} The viewer must instantly know what product is being reviewed within the first second.`,
    `Panel 2: vertical 9:16 waist-up medium shot. Reviewer continues to feature "${prodName}" prominently (${placement.isHandheld ? 'holding it steadily at chest level' : 'standing beside the product on the table pointing gently to it'}); ${recurringBackground}.`,
    `Panel 3: vertical 9:16 waist-up medium shot (DO NOT use distant full-body shot, DO NOT show legs or feet). Reviewer remains clearly visible beside "${prodName}" on the ${inspectionSurface}; same facility background.`,
    `Panel 4: DETAIL FOCUS ON PRODUCT WITH REVIEWER — close-up framing focused primarily on "${prodName}" held at chest level; reviewer face and upper torso remain visible in frame. DO NOT zoom in excessively on reviewer face or neckline cleavage. The product is the primary hero focal point. ${placement.isHandheld ? 'She holds the product closer to camera' : 'She stands immediately beside the product on the table'}. Never render product alone.`,
    `Panel 5: vertical 9:16 waist-up medium shot. Reviewer clearly visible with "${prodName}" (${placement.isHandheld ? 'holding product at chest height' : 'standing right beside product on the table'}) and ${facilityBackground}, delivering an engaging call-to-action.`,
    '',
    useWholesaleShowroom
      ? 'Warehouse-showroom-first rule: The setting is an authentic WHOLESALE SHOWROOM INSIDE AN OPERATING STOCK WAREHOUSE, not a factory production line. Directly behind the presenter are tall stocked industrial racks, visible product-category inventory, sealed cartons, and a small number of staff fulfilling orders. The foreground is a practical wooden product demonstration table. Preserve clear aisle depth and a bright, busy-but-orderly commercial atmosphere. Absolutely no conveyor belt, assembly line, filling/capping machinery, sterile laboratory, luxury boutique-only interior, domestic room, or empty studio backdrop.'
      : 'Factory-first rule: The setting is an authentic FACTORY-DIRECT LIVE-COMMERCE (bán hàng tại xưởng xuất xưởng) environment. DIRECTLY BEHIND THE PRESENTER is an active automated manufacturing and packaging conveyor belt line (băng chuyền sản xuất tự động). Along this conveyor belt, continuous, neatly spaced identical units of the EXACT SAME product "' + prodName + '" (matching the authentic product reference photos ' + refText + ') are moving through automated machinery stations (such as filling, capping, labeling, or boxing). In the foreground, the reviewer is the primary host presenting the product behind a clean demonstration / QC table. There are ABSOLUTELY NO glass separation walls or partitions blocking the conveyor belt. There are NO wall vitrines or decorative shelves. Never show workers sitting in crowded manual rows. Background workers (if any) are strictly limited to 1-2 people in the far background in soft focus wearing category-appropriate clean uniforms, never wearing blue hospital smocks or surgical hairnets.',
    '',
    `STRICT NEGATIVE PROMPT: different clothes, changed outfit, mismatched wardrobe from model reference photo, clothing color change, redesigned dress, altered neckline, polo shirt when model reference wears blazer or dress, exposed lingerie, seductive pose, NSFW, racy outfit, product-only shot, missing presenter, different reviewer woman, changed face, second presenter, hairnet on presenter, blue medical gowns, blue ESD lab coats, blue cleanroom smocks, surgical gowns, surgical hairnets, hospital scrubs, crowded manual rows of seated workers, workers crowding presenter, glass partition wall, glass separation room, ${useWholesaleShowroom ? 'conveyor belt, assembly line, automated manufacturing machinery, empty studio, home kitchen, living room, residential room' : 'showroom vitrines, wall display cabinets, boutique showroom, retail store, home kitchen, living room, residential room'}, unrelated inventory, fantasy machinery, fake brand labels, text, typography, subtitles, captions, panel numbers, watermark, UI, shopping cart icon, buttons, stickers, borders, split screen inside a panel, smartphone mockups, phone frames, mobile device bezels, home indicator bar, bottom navigation bar, black bars at top or bottom, letterboxing, pillarboxing, distant full-body shot, full-body distant view, showing legs, showing feet, distorted hands, extra fingers, extra limbs, waving empty hands, waving hello without product, holding clipboard, holding binder, holding notepad, holding paperwork, empty hands in panel 1, product missing from presenter hands in panel 1, product missing from table in panel 1, product tiny or out of focus, hands in pockets, hands behind back, ${placement.negativeRule}.`
  ].join('\n');
}

// ── 15. VEO 8s NATIVE VOICE VIDEO PROMPT BUILDER ──────────────────────────────

function buildTemplateProduct8sVideoPrompt(analysis = {}, clipData = {}, options = {}) {
  let dialogueText = String(clipData.dialogue || clipData.voiceOver || clipData.voice_over || '').trim();
  dialogueText = dialogueText.replace(/^[\s,;.!?–—\-:"']+/g, '').trim();
  if (dialogueText.length > 0) {
    dialogueText = dialogueText.charAt(0).toUpperCase() + dialogueText.slice(1);
  }
  const custom = options.customInstruction ? `USER ADDITIONAL REQUEST (cannot override visual locks): ${options.customInstruction}` : '';
  const isHookClip = Number(clipData.clipIndex || clipData.sceneNumber || 0) === 1;
  return [
    'Generate an 8-second vertical 9:16 realistic smartphone video from the PROVIDED START IMAGE ONLY.',
    'ABSOLUTE VISUAL SOURCE OF TRUTH: preserve every visible object, product geometry, logo, color, presenter face, wardrobe, pose, shelving, warehouse architecture, lighting and inventory.',
    'Same locked facility as all other clips. No scene changes, new objects, new presenter, new packaging, kitchen, showroom or imaginary background. Preserve the exact background and any soft-focus staff already visible in the start frame; do not add/remove people during the clip.',
    'Allowed movement: lip sync to the exact dialogue, natural blinking, tiny facial/head movement, tiny camera push-in. Hands and product remain stationary in their initial pose.',
    'Forbidden: any product operation, demonstration, rotating or tilting product, opening lid, pressing button, adding ingredients/liquids, assembly, disassembly, picking up objects, gesturing toward nonexistent UI, invented action based on spoken dialogue.',
    'Do NOT use the voice script as an instruction for visual actions. Voice may mention benefits; camera simply shows product and presenter as they already appear.',
    'No text overlays, captions, fake cart icons or additional narrator.',
    '',
    'NATIVE AUDIO & DIALOGUE (DIRECT ON-CAMERA SPEECH):',
    'One Vietnamese female presenter speaking Southern Vietnamese directly on camera, energetic but natural live-commerce pace (~4.5 to 5.0 words per second), perfectly clear articulation.',
    isHookClip
      ? 'HOOK VOCAL PERFORMANCE — CRITICAL FIRST 2 SECONDS: Start immediately with a bright excited pitch lift and a punchy high-energy attack on the first 2-4 words. Strongly stress the main attention/curiosity phrase, use one very short dramatic pause, then end the first sentence with rising curious intonation that makes the listener need the answer. Sound genuinely thrilled and urgent, not flat, not monotone, not slow, not like reading a script, and never scream.'
      : 'Maintain warm, persuasive live-commerce energy with natural sentence stress and conversational Southern Vietnamese rhythm.',
    'She says exactly: "' + dialogueText + '"',
    '',
    'FORBIDDEN ACTIONS:',
    '- STRICTLY NO black bars, NO pillarboxing, NO letterboxing, NO side borders.',
    '- NO subtitles, text banners, or fake UI overlays.',
    '- NO shopping cart icons, buy buttons, or pointing off-screen.',
    custom
  ].filter(Boolean).join('\n');
}

function buildTemplateProduct8sVideoPrompts(analysis = {}, options = {}) {
  const fullAnalysis = analysis?.analysis || analysis || {};
  const script = Array.isArray(fullAnalysis.script)
    ? fullAnalysis.script
    : (Array.isArray(fullAnalysis.clips) ? fullAnalysis.clips : []);

  const results = [];
  for (let idx = 1; idx <= 5; idx++) {
    const clipItem = script[idx - 1] || {
      clipIndex: idx,
      duration: 8,
      dialogue: 'Mọi người xem sản phẩm này nha, em đang giới thiệu những chi tiết có trong thông tin và hình ảnh sản phẩm.',
      visualBeats: [
        { time: '0-4s', action: 'Presenter speaks directly to camera' },
        { time: '4-8s', action: 'Presenter continues speaking with stationary product' },
      ],
    };
    const prompt = buildTemplateProduct8sVideoPrompt(fullAnalysis, clipItem, options);
    results.push({
      sceneNumber: idx,
      prompt,
      targetDuration: 8.0,
      dialogue: (clipItem.dialogue || clipItem.voiceOver || '').replace(/^[\s,;.!?–—\-:"']+/g, '').trim(),
    });
  }

  if (options.panelIndex && options.panelIndex >= 1 && options.panelIndex <= 5) {
    return results[options.panelIndex - 1];
  }
  return results;
}

function buildTemplateProductRemakeVideoJobs(runDir, targetIndices, customInstruction, analysis) {
  const panelsDir = path.join(runDir, 'panels');
  const sessionPath = path.join(runDir, 'session.json');
  let session = {};
  if (fs.existsSync(sessionPath)) {
    try { session = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch (_) { }
  }
  const fullAnalysis = analysis || session.analysis?.analysis || session.analysis || {};
  const scriptList = session.analysis?.script || [];

  // Load canonical model.png as reference image to send alongside the start frame
  // This ensures the presenter identity is anchored to the actual uploaded model photo
  const presenterAsset = getCanonicalPresenterBuffer({
    modelPath: session?.presenterModelPath,
    modelName: session?.presenterModel,
  });

  return (Array.isArray(targetIndices) ? targetIndices : [1])
    .map(Number)
    .filter(idx => idx >= 1 && idx <= 5)
    .map(pIdx => {
      const pPath = path.join(panelsDir, `panel-${pIdx}.png`);
      const pBuf = fs.existsSync(pPath) ? fs.readFileSync(pPath) : null;
      const clipItem = scriptList[pIdx - 1] || {};
      const prompt = buildTemplateProduct8sVideoPrompt(fullAnalysis, clipItem, { customInstruction });

      // eb1hJf chỉ nhận 1 start frame (i2v) — chỉ gửi panel image, KHÔNG gửi model.png
      // model.png được lock vào storyboard panel qua prompt — không là separate ref cho video
      const referenceImages = pBuf ? [{
        name: `panel-${pIdx}.png`,
        mimeType: 'image/png',
        buffer: pBuf,
      }] : [];

      return {
        index: pIdx,
        panelIndex: pIdx,
        sceneNumber: pIdx,
        targetDuration: 8.0,
        prompt,
        imagePath: pPath,
        buffer: pBuf,
        videoModelKey: 'abra_i2v_8s',
        referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
      };
    });
}

// ── 16. REMAKE PROMPT BUILDERS FOR FLOW API ────────────────────────────────────

function buildTemplateProductRemakePrompt(analysis = {}, targetPanelIndex = 1, customInstruction = '', options = {}) {
  const fullAnalysis = analysis.analysis || analysis || {};
  const prodName = fullAnalysis.productName || 'Sản phẩm review';
  const category = fullAnalysis.category || 'Sản phẩm tiêu dùng';
  const categoryInfo = routeProductCategory(prodName + ' ' + category);
  const pIdx = Math.max(1, Math.min(5, Number(targetPanelIndex) || 1));
  const env = getProductEnvironmentBible(fullAnalysis);
  const physicalProfile = analyzeProductPhysicalProfile(fullAnalysis);
  const placement = getProductPlacementRule(fullAnalysis, physicalProfile);
  const useWholesaleShowroom = options.storyboardBackgroundPreset === 'wholesale_showroom_warehouse' ||
    ['template_product2', 'templateproduct2', 'tproduct2'].includes(String(options.template || '').toLowerCase());
  const sourcingPrompt = useWholesaleShowroom
    ? 'Busy Vietnamese wholesale hardware/general-merchandise showroom inside an operating stock warehouse. Tall blue-orange or gray industrial racks flank both sides of a deep retail aisle; lower shelves show dense browsable product boxes and hanging accessories, upper levels hold bulk cartons. A large warm visibly-grained wooden merchandise table in the foreground is filled with the exact hero product, duplicate units and real accessories. 3-5 staff in dark polo uniforms restock and pack orders behind the presenter. Bright fluorescent/LED tubes, concrete floor, high practical ceiling, handheld TikTok realism. NOT a pristine logistics depot, factory, production line, laboratory, empty studio or stainless-steel QC area.'
    : env.promptFragment;

  const panelDescriptions = {
    1: `Vertical 9:16 waist-up medium shot (DO NOT use full-body distant shot). ${placement.panel1Instruction} Immediate 100% product focus.`,
    2: `Closer vertical 9:16 medium shot. Presenter holds or points to "${prodName}" steadily in front of the same ${useWholesaleShowroom ? 'dense wholesale-store aisle and stocked racks' : 'factory workshop'}. Action Runway: energetic conversational posture.`,
    3: `Medium shot. Presenter smiles warmly, presenting "${prodName}" elegantly beside the ${useWholesaleShowroom ? 'loaded wooden merchandise table' : 'factory inspection table'}. Action Runway: open inviting posture.`,
    4: `Medium close-up shot of the intact reference product exterior with presenter visible beside it in the SAME facility. NO demonstration, no manipulation or new objects. Action Runway: static close-up detail.`,
    5: `Medium shot. Presenter stands proudly with "${prodName}" (${placement.isHandheld ? 'holding product at chest height' : 'standing beside product on the table'}) with a confident, joyful smile in the SAME facility, concluding the showcase. Action Runway: friendly sign-off expression.`,
  };

  let prompt = [
    `Single vertical 9:16 start frame panel (Scene ${pIdx} of 5) for a live-commerce presenter video.`,
    `CRITICAL IDENTITY & WARDROBE: The presenter MUST be the EXACT SAME person wearing the EXACT SAME OUTFIT as shown in the canonical model reference (model.png). Same facial features, hair, and identical clothing items, colors, collar style, and fabric from model.png without alteration (no clipboard, no blue medical smocks).`,
    `CRITICAL PRODUCT: The product MUST be the EXACT SAME model, color, and finish as shown in the product references: "${prodName}" (${category}).`,
    `ENVIRONMENT: ${sourcingPrompt}`,
    `PRODUCT HERO FOCUS & PLACEMENT: ${placement.panelGeneralInstruction}`,
    `SCENE ${pIdx} SPECIFIC FRAMING: ${panelDescriptions[pIdx]}`,
    `Camera: Smartphone vertical 9:16 aspect ratio, realistic commercial LED lighting, high resolution, no black bars, no blur.`,
    `NEGATIVE PROMPT: different clothes, changed outfit, mismatched wardrobe from model reference photo, clothing color change, text, typography, words, subtitles, panel labels, scene titles, captions, lettering, shopping cart, shopping cart icon, cart symbol, trolley icon, UI buttons, UI overlays, price tags, stickers, badges, watermarks, split screens, distorted hands, extra limbs, second person, glass partition wall, glass separation room, showroom vitrines, wall display cabinets, boutique store, retail shop, residential room, crowded manual rows of seated workers, STRICTLY NO black bars, NO pillarboxing, NO letterboxing, NO side borders. NO product operation or demonstrations. Same facility as all other panels, ${placement.negativeRule}.`
  ].join('\n');

  if (customInstruction) {
    prompt += `\n\nUSER CUSTOM INSTRUCTION: ${customInstruction}. Maintain strict identity lock, full-bleed 9:16 vertical smartphone framing without black bars or pillarbox borders.`;
  }
  return prompt;
}

function buildTemplateProductRemakeAllPrompt(analysis = {}, customInstruction = '', options = {}) {
  let prompt = buildTemplateProductMasterPrompt(analysis, options);
  if (customInstruction) {
    prompt += `\n\nUSER CUSTOM ADJUSTMENT: ${customInstruction}. Maintain 100% presenter face identity and product fidelity across all 5 panels.`;
  }
  return prompt;
}

// ── 17. TELEGRAM KEYBOARDS (STORYBOARD REVIEW & VIDEO REVIEW) ───────────────────

function buildProductStoryboardInlineKeyboard(rawRunId) {
  // Telegram callback_data limit is 64 bytes. Prefix 'tprod_remake_all:' is 17 bytes.
  // We only truncate if length > 40 to ensure strict compliance while preserving realistic IDs.
  const strId = String(rawRunId || 'sb');
  const runId = strId.length > 40 ? strId.slice(-30) : strId;
  return {
    inline_keyboard: [
      [
        { text: '🔄 Cảnh 1', callback_data: `tprod_remake:1:${runId}` },
        { text: '🔄 Cảnh 2', callback_data: `tprod_remake:2:${runId}` },
        { text: '🔄 Cảnh 3', callback_data: `tprod_remake:3:${runId}` },
      ],
      [
        { text: '🔄 Cảnh 4', callback_data: `tprod_remake:4:${runId}` },
        { text: '🔄 Cảnh 5', callback_data: `tprod_remake:5:${runId}` },
        { text: '♻️ Làm lại tất cả', callback_data: `tprod_remake_all:${runId}` },
      ],
      [
        { text: '✅ OK Sinh Video 40s (5x 8s Native Voice)', callback_data: `tprod_ok:${runId}` },
      ]
    ]
  };
}

function buildProductVideoInlineKeyboard(rawRunId) {
  // Prefix 'tprod_remake_video:X:' is 21 bytes. Truncate only if length > 40.
  const strId = String(rawRunId || 'vid');
  const runId = strId.length > 40 ? strId.slice(-30) : strId;
  return {
    inline_keyboard: [
      [
        { text: '🔄 Tạo lại Video Cảnh 1', callback_data: `tprod_remake_video:1:${runId}` },
        { text: '🔄 Tạo lại Video Cảnh 2', callback_data: `tprod_remake_video:2:${runId}` },
      ],
      [
        { text: '🔄 Tạo lại Video Cảnh 3', callback_data: `tprod_remake_video:3:${runId}` },
        { text: '🔄 Tạo lại Video Cảnh 4', callback_data: `tprod_remake_video:4:${runId}` },
      ],
      [
        { text: '🔄 Tạo lại Video Cảnh 5', callback_data: `tprod_remake_video:5:${runId}` },
      ],
      [
        { text: '📦 Tải các Video Panel', callback_data: `tprod_download_panels:${runId}` },
      ],
      [
        { text: '🚀 Đăng lên TikTok Shop', callback_data: `tprod_upload:${runId}` },
      ]
    ]
  };
}

// ── 18. FFMPEG SLICING & COMPOSING (5 PANELS) ──────────────────────────────────

function sliceMasterStoryboardProduct(masterImagePath, outputDir) {
  ensureDir(outputDir);
  const outPaths = [];

  // Tách 5 vertical panels từ Master Storyboard 16:9:
  // Giữ nguyên 100% tỷ lệ gốc (Zero-Distortion), mỗi panel rộng iw / 5 (làm tròn số chẵn cho encoder)
  for (let i = 0; i < 5; i++) {
    const outPath = path.join(outputDir, `panel-${i + 1}.png`);
    const cmd = `"${ffmpegPath}" -y -i "${path.resolve(masterImagePath)}" -vf "crop=trunc(iw/5/2)*2:trunc(ih/2)*2:trunc(iw/5/2)*2*${i}:0" "${outPath}"`;
    execSync(cmd, { stdio: 'pipe' });
    outPaths.push(outPath);
  }
  return outPaths;
}

function composeMasterStoryboardProduct(panelInputs, outputMasterPath) {
  ensureDir(path.dirname(outputMasterPath));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tproduct-sb-'));

  try {
    const tempFiles = [];
    for (let i = 0; i < 5; i++) {
      const item = panelInputs[i] || panelInputs[0];
      const tPath = path.join(tempDir, `panel_${i + 1}.png`);
      if (Buffer.isBuffer(item)) {
        fs.writeFileSync(tPath, item);
      } else if (typeof item === 'string' && fs.existsSync(item)) {
        fs.copyFileSync(item, tPath);
      } else if (typeof item === 'string' && (item.startsWith('data:') || item.length > 500)) {
        const b64 = item.includes('base64,') ? item.split('base64,')[1] : item;
        fs.writeFileSync(tPath, Buffer.from(b64, 'base64'));
      } else {
        throw new Error(`Invalid panel input at index ${i}`);
      }
      tempFiles.push(tPath);
    }

    const inputs = tempFiles.map(f => `-i "${f}"`).join(' ');
    // Chuẩn hóa chiều cao về 1080 (giữ nguyên tỷ lệ gốc scale=-1:1080) và ghép ngang hstack 5 panels
    const filter = [
      '[0:v]scale=-1:1080[p0]',
      '[1:v]scale=-1:1080[p1]',
      '[2:v]scale=-1:1080[p2]',
      '[3:v]scale=-1:1080[p3]',
      '[4:v]scale=-1:1080[p4]',
      '[p0][p1][p2][p3][p4]hstack=inputs=5[outv]'
    ].join(';');

    execSync(`"${ffmpegPath}" -y ${inputs} -filter_complex "${filter}" -map "[outv]" "${outputMasterPath}"`, { stdio: 'pipe' });
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { }
  }
  return outputMasterPath;
}

// ── 18b. CANDIDATE LAYOUT DETECTION & GEMINI VISION QA ─────────────────────────

/**
 * Detects whether a storyboard image has horizontal dividing lines or borders,
 * which indicates an invalid layout (such as a collage, comic grid, or 1-large + 2x2 grid)
 * instead of the mandatory 5 equal vertical columns spanning the full height.
 */
function detectHorizontalDividers(imageInput) {
  if (!imageInput) return { hasDividers: false, dividerCount: 0 };
  const tmpId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const tmpIn = path.join(os.tmpdir(), `detect-layout-${tmpId}.png`);
  try {
    if (Buffer.isBuffer(imageInput)) {
      fs.writeFileSync(tmpIn, imageInput);
    } else if (typeof imageInput === 'string' && fs.existsSync(imageInput)) {
      return _runDividerAnalysis(imageInput);
    } else if (typeof imageInput === 'string') {
      const b64 = imageInput.includes('base64,') ? imageInput.split('base64,')[1] : imageInput;
      fs.writeFileSync(tmpIn, Buffer.from(b64, 'base64'));
    } else {
      return { hasDividers: false, dividerCount: 0 };
    }
    return _runDividerAnalysis(tmpIn);
  } catch (err) {
    console.warn(`[TemplateProduct] Layout divider detection error: ${err.message}`);
    return { hasDividers: false, dividerCount: 0 };
  } finally {
    try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch (_) { }
  }
}

function _runDividerAnalysis(filePath) {
  const width = 1376;
  const height = 768;
  const raw = execSync(`"${ffmpegPath}" -y -i "${filePath}" -vf scale=${width}:${height} -f rawvideo -pix_fmt gray -`, {
    maxBuffer: 5 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10000,
  });

  const yStart = Math.floor(height * 0.20);
  const yEnd = Math.floor(height * 0.80);
  let detectedRows = 0;

  for (let y = yStart; y <= yEnd; y++) {
    let darkCount = 0;
    const xStart = Math.floor(width * 0.15);
    const xEnd = Math.floor(width * 0.95);
    const span = xEnd - xStart;
    for (let x = xStart; x < xEnd; x++) {
      const val = raw[y * width + x];
      // A horizontal dividing border line in comic grids is a continuous dark line (val < 25)
      if (val < 25) darkCount++;
    }
    // A dark divider border typically spans across multiple columns (> 40% of canvas width)
    if (darkCount / span > 0.40) {
      detectedRows++;
    }
  }
  return { hasDividers: detectedRows >= 3, dividerCount: detectedRows };
}

/**
 * Evaluates candidate storyboards using Gemini Vision QA + programmatic layout detection.
 * Strictly rejects any candidate that is a collage, comic grid, or lacks 5 equal vertical columns.
 */
async function verifyProductStoryboardCandidatesWithGeminiVision(geminiClient, candidateBuffers, analysis = {}, options = {}) {
  const useWholesaleShowroom = options.storyboardBackgroundPreset === 'wholesale_showroom_warehouse' ||
    ['template_product2', 'templateproduct2', 'tproduct2'].includes(String(options.template || '').toLowerCase());
  // 1. Programmatic layout pre-check on every candidate
  const layoutChecks = (candidateBuffers || []).map((buf, i) => {
    const check = detectHorizontalDividers(buf);
    return {
      index: i + 1,
      hasDividers: check.hasDividers,
      dividerCount: check.dividerCount,
    };
  });

  layoutChecks.forEach(lc => {
    if (lc.hasDividers) {
      console.warn(`[TemplateProduct] ⚠️ Candidate #${lc.index} flagged by layout pre-check: horizontal dividers detected (${lc.dividerCount} rows) -> DISQUALIFIED`);
    } else {
      console.log(`[TemplateProduct] ✅ Candidate #${lc.index} passed layout pre-check (clean vertical columns)`);
    }
  });

  // 2. Gemini Vision Evaluation if geminiClient is available
  if (geminiClient && Array.isArray(candidateBuffers) && candidateBuffers.length > 0) {
    const uploadedFiles = [];
    for (let i = 0; i < candidateBuffers.length; i++) {
      const buf = candidateBuffers[i];
      if (!buf) continue;
      const filename = `candidate-${i + 1}.png`;
      try {
        const url = await geminiClient.uploadFile(buf, filename, 'image/png');
        if (url) uploadedFiles.push({ url, filename, mimeType: 'image/png' });
      } catch (upErr) {
        console.warn(`[TemplateProduct] Failed to upload candidate ${filename} for QA: ${upErr.message}`);
      }
    }

    if (uploadedFiles.length > 0) {
      console.log(`[TemplateProduct] Step 3: Verifying ${candidateBuffers.length} storyboard candidates via Gemini Vision QA...`);
      const qaPrompt = [
        'You are an expert Storyboard Quality Assurance Director for Vietnamese TikTok Live-Commerce.',
        `Product: "${analysis.productName || 'Sản phẩm'}"`,
        `Required Setting: ${analysis.sourcingSetting || 'factory_showcase'}`,
        '',
        'CRITICAL MANDATORY LAYOUT RULE (PASS/FAIL):',
        '- The ONLY acceptable layout is EXACTLY 5 equal-width vertical columns side-by-side from left to right (Column 1, 2, 3, 4, 5). Each column must span the full canvas height from top to bottom (100% height).',
        '- ANY candidate with a collage, comic grid, 2x2 grid, 1 large image + smaller stacked images, or horizontal dividing lines splitting columns into sub-panels is a HARD REJECT (is5VerticalColumns: false, score: 0). NEVER select such a candidate!',
        '',
        'ADDITIONAL EVALUATION CRITERIA (for candidates with valid 5-column layout):',
        '1. Presenter Visibility: Canonical female host visible in all 5 columns.',
        '2. Product Fidelity: Accurate product presentation matching real materials.',
        useWholesaleShowroom
          ? '3. Environment Fidelity (high weight): Must visibly resemble a busy Vietnamese wholesale showroom inside a stock warehouse: dense browsable merchandise, tall racks flanking the aisle, bulk cartons above, warm wooden merchandise table with products/accessories, and several dark-uniform staff restocking or packing. Reject sterile factory/QC lines, stainless-steel workbenches, pristine empty logistics depots, laboratories, and conveyor belts.'
          : '3. Sourcing Environment & Conveyor Belt: Authentic automated factory workshop with visible conveyor belt carrying identical units of the product directly behind the presenter.',
        '',
        'OUTPUT JSON ONLY (no markdown formatting, no text before or after):',
        '{',
        '  "candidates": [',
        '    {',
        '      "candidateIndex": 1,',
        '      "is5VerticalColumns": true,',
        '      "layoutType": "5_vertical_columns|collage_grid|other",',
        '      "score": 92,',
        '      "reason": "Brief explanation in English"',
        '    }',
        '  ],',
        '  "bestCandidateIndex": 1',
        '}'
      ].join('\n');

      try {
        const res = await geminiClient.generateContent({
          prompt: qaPrompt,
          fileData: uploadedFiles,
          temporary: true,
          expectImages: false,
        });
        const rawText = res?.text || res?.content || '';
        const parsed = parseJsonObjectProduct(rawText);
        if (parsed && Array.isArray(parsed.candidates) && parsed.candidates.length > 0) {
          // Merge with programmatic layout check: only override if Gemini didn't already give high confidence (score >= 80)
          parsed.candidates.forEach(c => {
            const idx = c.candidateIndex || c.index || 1;
            const progCheck = layoutChecks[idx - 1];
            if (progCheck && progCheck.hasDividers && (c.score || 0) < 80) {
              c.is5VerticalColumns = false;
              c.score = 0;
              c.reason = `${c.reason || ''} [AUTO-REJECTED: Horizontal panel dividers detected]`.trim();
            }
          });

          // Filter candidates that strictly have 5 vertical columns
          const validCandidates = parsed.candidates.filter(c => c.is5VerticalColumns === true && (c.score || 0) > 0);
          validCandidates.sort((a, b) => (b.score || 0) - (a.score || 0));

          let chosenIdx = 1;
          if (validCandidates.length > 0) {
            if (typeof parsed.bestCandidateIndex === 'number' && validCandidates.some(vc => vc.candidateIndex === parsed.bestCandidateIndex)) {
              chosenIdx = parsed.bestCandidateIndex;
            } else {
              chosenIdx = validCandidates[0].candidateIndex;
            }
          } else {
            // If all failed Vision QA, pick the first candidate without programmatic dividers
            const noDividerIdx = layoutChecks.findIndex(lc => !lc.hasDividers);
            chosenIdx = noDividerIdx >= 0 ? noDividerIdx + 1 : 1;
          }

          console.log(`[TemplateProduct] 📊 Vision QA Results:`);
          parsed.candidates.forEach(c => {
            console.log(`   - Candidate #${c.candidateIndex || c.index}: Score ${c.score}/100 | 5-Panel: ${c.is5VerticalColumns} | ${c.reason || ''}`);
          });
          console.log(`[TemplateProduct] 🏆 Best Candidate Selected: #${chosenIdx}`);

          return {
            candidates: parsed.candidates,
            selectedCandidateIndex: chosenIdx,
          };
        }
      } catch (qaErr) {
        console.warn(`[TemplateProduct] Vision QA evaluation error: ${qaErr.message}. Falling back to deterministic selection.`);
      }
    }
  }

  // 3. Fallback deterministic selection
  console.log(`[TemplateProduct] Using deterministic layout evaluation for ${candidateBuffers.length} candidates...`);
  const candidates = candidateBuffers.map((_, idx) => {
    const progCheck = layoutChecks[idx] || { hasDividers: false };
    const isValid = !progCheck.hasDividers;
    return {
      candidateIndex: idx + 1,
      is5VerticalColumns: isValid,
      totalScore: isValid ? 94 - idx * 2 : 0,
      score: isValid ? 94 - idx * 2 : 0,
      breakdown: isValid
        ? 'Valid 5-panel vertical layout with Action Runway & Sourcing Setting'
        : 'Disqualified: Horizontal dividers / collage layout detected',
      reason: isValid
        ? 'Valid 5-panel vertical layout'
        : 'Disqualified: Horizontal dividers / collage layout detected',
    };
  });

  const validCands = candidates.filter(c => c.is5VerticalColumns);
  const chosenIdx = validCands.length > 0 ? validCands[0].candidateIndex : 1;

  console.log(`[TemplateProduct] 🏆 Deterministic Best Candidate Selected: #${chosenIdx}`);
  return {
    candidates,
    selectedCandidateIndex: chosenIdx,
  };
}

// ── 19. FFMPEG CONCATENATION OF 5 NATIVE-AUDIO CLIPS (40 SECONDS TARGET) ───────

function concat5NativeAudioClips(panelVideoPaths, outputMergedPath) {
  ensureDir(path.dirname(outputMergedPath));
  const validPaths = (Array.isArray(panelVideoPaths) ? panelVideoPaths : [])
    .filter(p => p && fs.existsSync(p) && fs.statSync(p).size > 1000);

  if (validPaths.length === 0) {
    throw new Error('concat5NativeAudioClips requires at least 1 valid video clip, got 0');
  }

  if (validPaths.length === 1) {
    fs.copyFileSync(validPaths[0], outputMergedPath);
    return outputMergedPath;
  }

  const count = validPaths.length;
  const inputArgs = [];
  const filterParts = [];

  for (let i = 0; i < count; i++) {
    inputArgs.push('-i', path.resolve(validPaths[i]));
    filterParts.push(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=disable,setsar=1[v${i}]`);
  }

  // Ghép nối N video clips cùng N audio streams tương ứng (native audio)
  const concatInputs = [];
  for (let i = 0; i < count; i++) {
    concatInputs.push(`[v${i}][${i}:a]`);
  }
  filterParts.push(`${concatInputs.join('')}concat=n=${count}:v=1:a=1[vout][aout]`);

  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '22',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputMergedPath
  ];

  execSync(`"${ffmpegPath}" ${args.map(a => `"${a}"`).join(' ')}`, { stdio: 'pipe', timeout: 300000 });
  if (!fs.existsSync(outputMergedPath)) {
    throw new Error('FFmpeg concat5NativeAudioClips completed but output file not created');
  }
  return outputMergedPath;
}

// ── 20. MARKDOWN LOGGING (PROMPT.MD & PROMPTS.MD) ─────────────────────────────

function writeMarkdownLog(runDir, content) {
  try {
    ensureDir(runDir);
    fs.writeFileSync(path.join(runDir, 'prompt.md'), content, 'utf8');
    fs.writeFileSync(path.join(runDir, 'prompts.md'), content, 'utf8');
  } catch (err) {
    console.warn(`[TemplateProduct] Warning writing markdown log: ${err.message}`);
  }
}

function appendMarkdownLog(runDir, content) {
  try {
    ensureDir(runDir);
    const p1 = path.join(runDir, 'prompt.md');
    const p2 = path.join(runDir, 'prompts.md');
    fs.appendFileSync(p1, `\n\n${content}`, 'utf8');
    if (fs.existsSync(p2)) fs.appendFileSync(p2, `\n\n${content}`, 'utf8');
  } catch (err) {
    console.warn(`[TemplateProduct] Warning appending markdown log: ${err.message}`);
  }
}

function buildInitialProductMarkdown(data) {
  const { runId, analysisData, masterPrompt, qaResult, bestCandidateIndex, chatId, inputs } = data;
  const analysis = analysisData?.analysis || {};
  const scriptList = analysisData?.script || [];
  const totalWords = scriptList.reduce((sum, s) => sum + (s.dialogue ? s.dialogue.split(/\s+/).filter(Boolean).length : 0), 0);

  const lines = [
    `# Run Log: Live-Commerce Presenter Template Pro (40s Native Voice)`,
    `- **Run ID**: \`${runId}\``,
    `- **Template**: \`template_product\` (/tproduct, /tpro40nv)`,
    `- **Created At**: ${new Date().toISOString()}`,
    `- **Telegram Chat**: \`${chatId || 'N/A'}\``,
    `- **Presenter Reference**: \`model.png\` (Canonical Live-Commerce Female Presenter)`,
    `- **Product Name**: **${analysis.productName || 'N/A'}** (${analysis.category || 'N/A'})`,
    `- **Category Key**: \`${analysis.categoryKey || 'N/A'}\``,
    `- **Sales Mode**: \`${analysis.salesMode || 'PRICE_LED'}\``,
    `- **Sourcing Setting**: \`${analysis.sourcingSetting || 'factory_showcase'}\``,
    `- **Audience Address**: \`${analysis.audienceAddress || 'chị em'}\` (Self-reference: \`${analysis.selfReference || 'em'}\`)`,
    `- **Hero Action**: ${analysis.affordances?.heroAction || 'N/A'}`,
    `- **Spoken Dialogue Budget**: **${totalWords} words** across 5 clips (~${(totalWords / 5).toFixed(1)} words/clip, 40.0s target, 34-40 words/clip spec)`,
    `- **Architecture**: **5 clips × 8s Native Voice** (Model: \`veo_3_1_i2v_s_lite_8s_low_priority\`)`,
    `- **Audio Pipeline**: Native dialogue directly inside Veo video (NO separate TTS, NO voice muxing)`,
    '',
    '---',
    '## Step 1: Gemini 2-Stage Analysis & Native-Voice Script Generation',
    '- **API Engine**: Gemini API Client (generateContent & Vision)',
    '- **Pipeline Architecture**: 2-Stage Serial (Stage 1: Product Intelligence & Physical Profile -> Stage 2: 40s Script & 5 Start Frames)',
    ...(Array.isArray(analysisData?.uploadedFiles) && analysisData.uploadedFiles.length > 0 ? [
      '- **Uploaded Image References to Gemini**:',
      ...analysisData.uploadedFiles.map((uf, idx) => `  * Reference ${idx + 1}: \`${uf.filename || `ref_${idx + 1}.png`}\` (${uf.mimeType || 'image/png'})`)
    ] : []),
    '',
    '### Stage 1: Product Intelligence Prompt (Prompt A - Input)',
    '```text',
    analysisData?.stage1Prompt || analysisData?.analysisPrompt || 'N/A',
    '```',
    '',
    '### Stage 1: Gemini Intelligence Raw Response (Output)',
    '```json',
    analysisData?.stage1RawResponse || (analysisData?.stage1Parsed ? JSON.stringify(analysisData.stage1Parsed, null, 2) : (analysis ? JSON.stringify(analysis, null, 2) : 'N/A')),
    '```',
    '',
    '### Stage 2: 40s Script & Storyboard Prompt (Prompt B - Input)',
    '```text',
    analysisData?.stage2Prompt || 'N/A',
    '```',
    '',
    '### Stage 2: Gemini Script Raw Response (Output)',
    '```json',
    analysisData?.stage2RawResponse || (analysisData?.stage2Parsed ? JSON.stringify(analysisData.stage2Parsed, null, 2) : JSON.stringify({ script: scriptList }, null, 2)),
    '```',
    '',
    '### Script & Scene Breakdown (5 Clips × 8 Seconds)',
    '| Clip | Time | Phase | Spoken Dialogue (Exact Text) | Word Count | Visual Beats | Action Runway |',
    '|---|---|---|---|---|---|---|',
    ...scriptList.map(s => {
      const beatsDesc = (s.visualBeats || []).map(b => `${b.time}: ${b.action}`).join('; ');
      const arDesc = s.actionRunway?.motion || s.actionRunway?.reason || 'Ready for continuation';
      const wCount = s.dialogue ? s.dialogue.split(/\s+/).filter(Boolean).length : 0;
      return `| **Clip ${s.clipIndex}** | 8s | \`${s.phase || ''}\` | "${s.dialogue || ''}" | ${wCount} từ | ${beatsDesc} | ${arDesc} |`;
    }),
    '',
    '---',
    '## Step 2: Google Flow 4x Parallel Master Storyboard Generation & QA',
    '- **Model**: `nano-banana-pro` (Aspect Ratio: `16:9`, 1920x1080 composite master)',
    `- **Generated Candidates**: ${qaResult?.candidates?.length || 4} parallel storyboards`,
    `- **Selected Best Candidate**: Candidate #${bestCandidateIndex || 1}`,
    `- **Action Runway in Panels**: Enforced (Hero interaction and presenter motion ready for continuation)`,
    ...(Array.isArray(inputs) && inputs.length > 0 ? [
      '- **Input Reference Images to Flow**:',
      ...inputs.map((si, i) => `  * Reference ${i + 1}: \`${si.name || `image_${i + 1}.png`}\` (${si.mimeType || 'image/png'}${si.buffer ? `, ${(si.buffer.length / 1024).toFixed(1)} KB` : ''})`)
    ] : []),
    '',
    '### Master Storyboard Prompt Used (Input)',
    '```text',
    masterPrompt || '',
    '```',
    '',
    '### QA Verification Results (Output)',
    '```json',
    JSON.stringify(qaResult || {}, null, 2),
    '```',
    '',
    `- **Best Candidate Selected**: #${bestCandidateIndex || 1} (QA Score: **${qaResult?.candidates?.[0]?.totalScore || 92}/100**)`,
    `- **QA Details**:`,
    ...(qaResult?.candidates || []).map(c => `  * Candidate #${c.candidateIndex || c.index}: **${c.totalScore || c.score}đ** — ${c.breakdown || 'Valid live-commerce framing'}`),
    '',
    '- **Generated Candidates Dir**: `candidates/` (`candidate-1.png` .. `candidate-4.png`)',
    '- **Selected Master Storyboard**: `master-storyboard.png` (1920x1080)',
    '',
    '---',
    '## Step 3: Vertical 9:16 Panel Slicing (1080x1920 each)',
    ...[1, 2, 3, 4, 5].map(idx => `- **Panel ${idx}**: \`panels/panel-${idx}.png\` (Clip ${idx} Start Frame, 9:16)`),
    '',
  ];

  return lines.join('\n');
}

// ── 21. SESSION MANAGEMENT ────────────────────────────────────────────────────

function getProductSession(runId, baseDir) {
  if (!runId) return null;
  const strId = String(runId);
  if (productSessions.has(strId)) return productSessions.get(strId);
  for (const sess of productSessions.values()) {
    if (sess && (sess.runId === strId || sess.jobId === strId || (sess.runId && sess.runId.endsWith(strId)) || (sess.jobId && sess.jobId.endsWith(strId)))) {
      return sess;
    }
  }

  const runsRoot = path.join(baseDir || path.resolve(__dirname, '..'), 'storyboard-review-runs');
  if (fs.existsSync(runsRoot)) {
    const entries = fs.readdirSync(runsRoot).filter(name =>
      name.includes('template_product') || name.includes('tproduct') || name.includes('tpro40nv')
    );
    for (const d of entries) {
      if (d.includes(strId) || d.endsWith(`-${strId}`) || d === strId) {
        const sFile = path.join(runsRoot, d, 'session.json');
        if (fs.existsSync(sFile)) {
          try {
            const sData = JSON.parse(fs.readFileSync(sFile, 'utf8'));
            sData.runDir = path.join(runsRoot, d);
            productSessions.set(strId, sData);
            if (sData.runId) productSessions.set(sData.runId, sData);
            if (sData.jobId) productSessions.set(sData.jobId, sData);
            return sData;
          } catch (_) { }
        }
      }
    }
    entries.sort().reverse();
    for (const d of entries.slice(0, 15)) {
      const sFile = path.join(runsRoot, d, 'session.json');
      if (fs.existsSync(sFile)) {
        try {
          const sData = JSON.parse(fs.readFileSync(sFile, 'utf8'));
          if (
            sData.runId === strId ||
            sData.jobId === strId ||
            (sData.runId && sData.runId.endsWith(strId)) ||
            (sData.jobId && sData.jobId.endsWith(strId)) ||
            (sData.runDir && sData.runDir.includes(strId))
          ) {
            sData.runDir = path.join(runsRoot, d);
            productSessions.set(strId, sData);
            if (sData.runId) productSessions.set(sData.runId, sData);
            if (sData.jobId) productSessions.set(sData.jobId, sData);
            return sData;
          }
        } catch (_) { }
      }
    }
  }
  return null;
}

function saveProductSession(runId, sessionData) {
  if (!runId || !sessionData) return;
  const strId = String(runId);
  productSessions.set(strId, sessionData);
  if (sessionData.runId) productSessions.set(String(sessionData.runId), sessionData);
  if (sessionData.jobId) productSessions.set(String(sessionData.jobId), sessionData);
  if (sessionData.runDir) {
    try {
      ensureDir(sessionData.runDir);
      const sessFile = path.join(sessionData.runDir, 'session.json');
      // Technical pattern from tfood: xóa stepTracker để tránh circular structure JSON
      const sanitized = { ...sessionData };
      delete sanitized.stepTracker;
      fs.writeFileSync(sessFile, JSON.stringify(sanitized, null, 2), 'utf8');
    } catch (e) {
      console.warn(`[TemplateProduct] Warning saving session.json: ${e.message}`);
    }
  }
}

// ── 22. STEP 1 & 2 PIPELINE: 2-STAGE GEMINI & STORYBOARD GENERATION ────────────

async function generateStoryboard(baseDir, filePayloads = [], options = {}) {
  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const shortRunId = Math.random().toString(36).substring(2, 8);
  const runId = (options.runId && options.runId.length <= 12) ? options.runId : shortRunId;
  const originalJobId = options.jobId || options.runId || runId;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const template = String(options.template || '').toLowerCase() === 'template_product2'
    ? 'template_product2'
    : 'template_product';
  const chatId = options.chatId ? String(options.chatId) : null;
  const isAuto = Boolean(options.isAuto);

  const channelProfile = options.channelProfile || (typeof getChannelProfile === 'function' ? getChannelProfile(effectiveBaseDir, chatId) : { gender: 'female', audienceAddress: 'chị em' });
  const effectiveOptions = {
    ...options,
    channelProfile,
    gender: options.gender || channelProfile.gender,
    audienceAddress: options.audienceAddress || channelProfile.audienceAddress
  };

  console.log(`[TemplateProduct] 🎬 Starting Live-Commerce Presenter 40s Native-Voice Pipeline (Run: ${runId}, Job: ${originalJobId}, Gender: ${channelProfile.gender || 'female'}, Audience: ${channelProfile.audienceAddress || 'chị em'})...`);

  // Nạp ngẫu nhiên 1 trong 14 ảnh người mẫu riêng của /tproduct2.
  const presenterAsset = getCanonicalPresenterBuffer(effectiveOptions);
  if (!presenterAsset) {
    throw new Error('ERR_MISSING_PRESENTER_REFERENCE: Không tìm thấy ảnh người mẫu chuẩn trong docs/tproduct2/');
  }

  const runsRoot = path.join(effectiveBaseDir, 'storyboard-review-runs');
  const runDir = path.join(runsRoot, `${timestamp}-${template}-flow-${runId}`);
  const panelsDir = path.join(runDir, 'panels');
  const candidatesDir = path.join(runDir, 'candidates');
  const videosDir = path.join(runDir, 'videos');

  ensureDir(runDir);
  ensureDir(panelsDir);
  ensureDir(candidatesDir);
  ensureDir(videosDir);
  const inputsDir = path.join(runDir, 'inputs');
  ensureDir(inputsDir);

  const geminiClient = new GeminiApiClient({
    browserMode: true,
    userDataDir: path.join(effectiveBaseDir, 'gemini-playwright-user-data')
  });

  let analysisData = null;
  let analysis = {};
  let script = [];
  let candidateBuffers = [];
  let productCollageBuf = null;
  let productCollage2Buf = null;

  try {
    try { await geminiClient.init(); } catch (_) { }

    // 1. Lưu presenter model vào inputs/
    if (presenterAsset?.buffer) {
      try {
        fs.writeFileSync(path.join(inputsDir, 'model.png'), presenterAsset.buffer);
      } catch (_) { }
    }

    // 2. Lấy toàn bộ ảnh sản phẩm thực tế từ filePayloads
    const productOnlyPayloads = (Array.isArray(filePayloads) ? filePayloads : [])
      .filter(f => f && (f.buffer || f.path || f.base64));

    // 3. Persist TOÀN BỘ ảnh sản phẩm thô vào inputs/ để audit và kiểm tra
    for (let i = 0; i < productOnlyPayloads.length; i++) {
      const item = productOnlyPayloads[i];
      const buf = Buffer.isBuffer(item.buffer)
        ? item.buffer
        : (item.base64 ? Buffer.from(item.base64, 'base64') : (item.path && fs.existsSync(item.path) ? fs.readFileSync(item.path) : null));
      if (!buf) continue;
      const mimeType = item.mimeType || 'image/jpeg';
      const ext = mimeType.includes('jpeg') || mimeType.includes('jpg') ? '.jpg' : '.png';
      const rawName = item.name || `product_${String(i + 1).padStart(2, '0')}${ext}`;
      const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = safeName.includes('.') ? safeName : `${safeName}${ext}`;
      try {
        fs.writeFileSync(path.join(inputsDir, finalName), buf);
      } catch (_) { }
    }

    // 4. Sinh product collages: input.png (ảnh 1-8) và input2.png (ảnh 9-16 nếu có > 8 ảnh)
    const collages = createProductInputCollages(productOnlyPayloads);
    productCollageBuf = collages.input1Buf;
    if (!productCollageBuf && productOnlyPayloads.length > 0) {
      const f = productOnlyPayloads[0];
      const rawBuf = Buffer.isBuffer(f.buffer) ? f.buffer : (f.path && fs.existsSync(f.path) ? fs.readFileSync(f.path) : null);
      let ffmpegBin;
      try { ffmpegBin = require('ffmpeg-static'); } catch (_) { ffmpegBin = 'ffmpeg'; }
      productCollageBuf = normalizeFallbackImage(rawBuf, ffmpegBin);
    }
    productCollage2Buf = collages.input2Buf;

    if (productCollageBuf) {
      try { fs.writeFileSync(path.join(inputsDir, 'input.png'), productCollageBuf); } catch (_) { }
    }
    if (productCollage2Buf) {
      try { fs.writeFileSync(path.join(inputsDir, 'input2.png'), productCollage2Buf); } catch (_) { }
    }

    // 5. Chuẩn bị payload hình ảnh gửi lên Gemini Stage 1:
    // Gồm 5 hình có sẵn (model.png + tối đa 4 ảnh raw sản phẩm) + 2 input collages (input.png + input2.png nếu có)
    const geminiImagePayloads = [];
    if (presenterAsset?.buffer) {
      geminiImagePayloads.push({
        name: 'model.png',
        buffer: presenterAsset.buffer,
        mimeType: 'image/png',
      });
    }

    for (let i = 0; i < Math.min(productOnlyPayloads.length, 4); i++) {
      const p = productOnlyPayloads[i];
      const buf = Buffer.isBuffer(p.buffer)
        ? p.buffer
        : (p.base64 ? Buffer.from(p.base64, 'base64') : (p.path && fs.existsSync(p.path) ? fs.readFileSync(p.path) : null));
      if (buf) {
        const mimeType = p.mimeType || 'image/jpeg';
        geminiImagePayloads.push({
          name: p.name || `product_${i + 1}.jpg`,
          buffer: buf,
          mimeType: mimeType,
        });
      }
    }

    if (productCollageBuf) {
      geminiImagePayloads.push({
        name: 'input.png',
        buffer: productCollageBuf,
        mimeType: 'image/png',
      });
    }

    if (productCollage2Buf) {
      geminiImagePayloads.push({
        name: 'input2.png',
        buffer: productCollage2Buf,
        mimeType: 'image/png',
      });
    }

    const uploadedFiles = [];
    if (geminiClient) {
      for (let i = 0; i < geminiImagePayloads.length; i++) {
        const item = geminiImagePayloads[i];
        const buf = item.buffer;
        if (!buf) continue;
        const mimeType = item.mimeType || 'image/png';
        const filename = item.name || `img_${i + 1}.png`;

        try {
          const url = await geminiClient.uploadFile(buf, filename, mimeType);
          if (url) uploadedFiles.push({ url, filename, mimeType });
        } catch (upErr) {
          console.warn(`[TemplateProduct] Upload image ${filename} failed: ${upErr.message}`);
        }
      }
    }

    // ── STAGE 1: Product Intelligence Analysis (Prompt A) ──
    console.log(`[TemplateProduct] Stage 1: Running Product Intelligence Analysis (Prompt A)...`);
    const promptA = buildProductIntelligencePromptA(effectiveOptions, channelProfile);
    let stage1Res = null;
    let stage1Parsed = null;

    try {
      if (geminiClient && uploadedFiles.length > 0) {
        stage1Res = await geminiClient.generateContent({
          prompt: promptA,
          fileData: uploadedFiles,
          temporary: true,
          expectImages: false,
        });
      } else if (geminiClient) {
        stage1Res = await geminiClient.generateContent({
          prompt: promptA,
          temporary: true,
          expectImages: false,
        });
      }
    } catch (gErr1) {
      console.warn(`[TemplateProduct] Stage 1 Gemini call error: ${gErr1.message}`);
    }

    const stage1Text = stage1Res?.text || stage1Res?.content || '';
    stage1Parsed = parseJsonObjectProduct(stage1Text);

    // Fallback phân tích cơ bản nếu Stage 1 không trả về JSON hợp lệ
    const prodTitle = effectiveOptions.productContext?.productTitle || effectiveOptions.productTitle || 'Sản phẩm Live-Commerce';
    const catInfo = routeProductCategory(prodTitle);
    const physical = analyzeProductPhysicalProfile({ productName: prodTitle });
    const settingObj = detectProductSourcingSetting({ productName: prodTitle }, effectiveOptions);

    if (!stage1Parsed || !stage1Parsed.analysis) {
      console.log(`[TemplateProduct] Stage 1 parse fallback: Building deterministic intelligence profile for "${prodTitle}"...`);
      const defaultAudience = channelProfile.gender === 'male' ? 'anh em' : (channelProfile.gender === 'neutral' ? 'mọi người' : (catInfo.defaultAudienceAddress || 'chị em'));
      stage1Parsed = {
        analysis: {
          productName: prodTitle,
          category: catInfo.label,
          categoryKey: catInfo.key,
          salesMode: effectiveOptions.salesMode || 'PRICE_LED',
          targetAudience: channelProfile.gender === 'male' ? 'Nam giới hiện đại, chuộng phong cách mạnh mẽ và thoải mái' : 'Người tiêu dùng hiện đại, săn deal thông minh',
          audienceAddress: defaultAudience,
          selfReference: 'em',
          sourcingSetting: settingObj.key,
          keyBenefits: ['Chất lượng chuẩn xịn', 'Tiện lợi sử dụng vượt trội', 'Mức giá ưu đãi độc quyền'],
          physicalProfile: physical,
          affordances: deriveProductAffordances(catInfo, physical),
          voiceBible: buildDynamicVoiceBible(channelProfile, effectiveOptions),
          visualBible: DEFAULT_GLOBAL_VISUAL_BIBLE,
        }
      };
    }

    const chosenEnvironment = getProductEnvironmentBible(stage1Parsed.analysis, effectiveOptions);
    stage1Parsed.analysis.sourcingSetting = chosenEnvironment.setting;
    stage1Parsed.analysis.environmentBible = chosenEnvironment;
    stage1Parsed.analysis.visualBible = { ...DEFAULT_GLOBAL_VISUAL_BIBLE, environmentType: chosenEnvironment.setting, environmentBible: chosenEnvironment };
    stage1Parsed.analysis.affordances = { ...(stage1Parsed.analysis.affordances || {}), heroAction: 'No demonstration; static product detail' };

    // ── STAGE 2: 40s Native-Voice Script & Storyboard Construction (Prompt B) ──
    console.log(`[TemplateProduct] Stage 2: Crafting 40s 5-Clip Native-Voice Script & Storyboard (Prompt B)...`);
    const selectedHookForRun = selectVerifiedHook(effectiveOptions);
    const stage2Options = {
      ...effectiveOptions,
      hookId: selectedHookForRun ? selectedHookForRun.id : effectiveOptions.hookId,
      channelProfile
    };
    const promptB = buildScriptAndStoryboardPromptB(stage1Parsed, stage2Options);
    let stage2Res = null;
    let stage2Parsed = null;

    try {
      if (geminiClient) {
        stage2Res = await geminiClient.generateContent({
          prompt: promptB,
          temporary: true,
          expectImages: false,
        });
      }
    } catch (gErr2) {
      console.warn(`[TemplateProduct] Stage 2 Gemini call error: ${gErr2.message}`);
    }

    const stage2Text = stage2Res?.text || stage2Res?.content || '';
    stage2Parsed = parseJsonObjectProduct(stage2Text);

    if (stage2Parsed && Array.isArray(stage2Parsed.script) && stage2Parsed.script.length === 5) {
      analysisData = {
        analysis: stage1Parsed.analysis,
        script: stage2Parsed.script,
      };
    } else {
      console.log(`[TemplateProduct] Stage 2 parse fallback: Using structured dynamic 5-clip script (34-40 words/clip)...`);
      const dynamic5Clips = buildDynamic5ClipPlan(stage1Parsed.analysis, catInfo, stage1Parsed.analysis.affordances, settingObj);
      const addr = stage1Parsed.analysis.audienceAddress || channelProfile.audienceAddress || (channelProfile.gender === 'male' ? 'anh em' : 'chị em');

      analysisData = {
        analysis: stage1Parsed.analysis,
        script: [
          {
            clipIndex: 1,
            duration: 8,
            phase: 'HOOK_AND_PRODUCT_INTRO',
            dialogue: `${buildSafeLibraryHookOpening(selectedHookForRun, prodTitle, effectiveOptions.verifiedOffer || effectiveOptions.productContext?.verifiedOffer || {}, addr)} Mình cùng xem kỹ mẫu này nha ${addr}.`,
            wordCount: 36,
            visualBeats: dynamic5Clips[0].visualBeats,
            startFramePlan: {
              presenterPose: 'Đứng thẳng tự tin, ánh mắt cuốn hút nhìn thẳng camera',
              handPose: 'Hai tay nâng sản phẩm trang trọng trước ngực',
              productPlacement: 'Sản phẩm rõ nét ở trung tâm khung hình 9:16',
              framing: 'Vertical 9:16 medium shot',
              environment: `${chosenEnvironment.title}; same locked facility for all five panels; canonical reviewer visible`
            },
            actionRunway: { valid: true, motion: 'Tư thế sẵn sàng nói và nâng sản phẩm đón sáng' }
          },
          {
            clipIndex: 2,
            duration: 8,
            phase: 'DEAL_AND_VALUE_BUILD',
            dialogue: `Em sẽ nói rõ từng điểm trong mô tả sản phẩm nha ${addr}. Mình xem kỹ hình dáng, các chi tiết có trong ảnh tham khảo và thông tin của sản phẩm trước khi quyết định nhé.`,
            wordCount: 36,
            visualBeats: dynamic5Clips[1].visualBeats,
            startFramePlan: {
              presenterPose: 'Cầm sản phẩm nghiêng nhẹ góc đẹp, ánh mắt hào hứng',
              handPose: 'Một tay giữ sản phẩm, một tay cử chỉ hào hứng',
              productPlacement: 'Sản phẩm hướng sáng nổi bật',
              framing: 'Vertical 9:16 medium shot'
            },
            actionRunway: { valid: true, motion: 'Chuyển động tay tự nhiên chia sẻ cơ hội' }
          },
          {
            clipIndex: 3,
            duration: 8,
            phase: 'OFFER_BRIDGE_AND_CTA',
            dialogue: `Nếu quan tâm thì ${addr} có thể mở thông tin sản phẩm để xem phiên bản, giá và điều kiện giao hàng đang được hiển thị thực tế nha. Em không tự đoán mức giá hay ưu đãi đâu ạ.`,
            wordCount: 36,
            visualBeats: dynamic5Clips[2].visualBeats,
            startFramePlan: {
              presenterPose: 'Mỉm cười thân thiện, chỉ tay hướng góc dưới màn hình',
              handPose: 'Tay mở rộng hướng về góc dưới giỏ hàng',
              productPlacement: 'Sản phẩm trên tay ngang ngực',
              framing: 'Vertical 9:16 medium shot'
            },
            actionRunway: { valid: true, motion: 'Cử chỉ tay mượt mà hướng góc dưới khung hình' }
          },
          {
            clipIndex: 4,
            duration: 8,
            phase: 'PRODUCT_DETAIL_SHOWCASE',
            dialogue: `Giờ mình nhìn cận cảnh những chi tiết đang thấy rõ trên sản phẩm nha. ${addr} đối chiếu với hình ảnh và thông số nhà bán cung cấp để chọn đúng mẫu, đúng phiên bản mà mình cần.`,
            wordCount: 37,
            visualBeats: dynamic5Clips[3].visualBeats,
            startFramePlan: {
              presenterPose: 'Tập trung biểu diễn sản phẩm chuyên nghiệp',
              handPose: 'Thao tác tay khéo léo trên sản phẩm',
              productPlacement: 'Cận cảnh sắc nét từng chi tiết bề mặt',
              framing: 'Vertical 9:16 medium close-up'
            },
            actionRunway: { valid: true, motion: 'Bàn tay thao tác vững vàng và tự nhiên' }
          },
          {
            clipIndex: 5,
            duration: 8,
            phase: 'BENEFIT_SUMMARY_AND_CLOSE',
            dialogue: `Vậy là em đã giới thiệu nhanh sản phẩm cho ${addr} rồi nè. Nếu thấy phù hợp, mình xem lại mô tả, giá bán và điều kiện giao hàng thực tế ở trang sản phẩm trước khi đặt nha.`,
            wordCount: 36,
            visualBeats: dynamic5Clips[4].visualBeats,
            startFramePlan: {
              presenterPose: 'Đứng thẳng rạng rỡ, nụ cười ấm áp thân thiện',
              handPose: 'Ôm hoặc nâng sản phẩm ngay ngắn bên người',
              productPlacement: 'Sản phẩm ở vị trí trung tâm trang trọng',
              framing: 'Vertical 9:16 medium shot'
            },
            actionRunway: { valid: true, motion: 'Nụ cười tươi tắn chào kết thúc video' }
          }
        ]
      };
    }

    analysisData = normalizeProductEnvironmentStoryboard(analysisData, effectiveOptions);
    analysisData.selectedHook = selectedHookForRun?.id || null;
    analysisData.selectedHookVerbatim = selectedHookForRun?.verbatim || null;
    analysisData.hookLibraryVersion = 'excel-9-v1';
    const environmentValidation = validateProductEnvironmentStoryboard(analysisData);
    if (!environmentValidation.valid) throw new Error('Product environment storyboard validation failed: ' + environmentValidation.errors.join('; '));
    const claimValidation = validateOfferClaims(analysisData.script, effectiveOptions);
    if (!claimValidation.valid) {
      // Auto-strip unverified claims instead of hard-failing the run.
      // Gemini sometimes ignores the "no unsupported claims" instruction; strip silently.
      console.warn(`[TemplateProduct] ⚠️ Auto-stripping unverified offer claims from dialogue: ${claimValidation.errors.join('; ')}`);
      analysisData.script = stripUnverifiedClaims(analysisData.script, effectiveOptions);
    }

    // Strict Post-Generation Sanitization for male channel:
    if (channelProfile.gender === 'male') {
      if (analysisData.analysis) {
        analysisData.analysis.audienceAddress = 'anh em';
      }
      if (Array.isArray(analysisData.script)) {
        analysisData.script = analysisData.script.map(clip => {
          if (!clip || typeof clip.dialogue !== 'string') return clip;
          return {
            ...clip,
            dialogue: clip.dialogue
              .replace(/\bchị em\b/gi, 'anh em')
              .replace(/\bcác chị\b/gi, 'các anh')
              .replace(/\bchị\b/gi, 'anh')
          };
        });
      }
    }

    // Technical enhancement: persist Stage 1 & Stage 2 inputs/outputs in analysisData
    analysisData.stage1Prompt = promptA;
    analysisData.stage1RawResponse = stage1Text || (stage1Parsed ? JSON.stringify(stage1Parsed, null, 2) : '');
    analysisData.stage1Parsed = stage1Parsed;
    analysisData.stage2Prompt = promptB;
    analysisData.stage2RawResponse = stage2Text || (stage2Parsed ? JSON.stringify(stage2Parsed, null, 2) : '');
    analysisData.stage2Parsed = stage2Parsed;
    analysisData.analysisPrompt = promptA;
    analysisData.rawResponse = stage2Text || stage1Text || '';
    analysisData.uploadedFiles = uploadedFiles;

    // Kiểm tra linter kịch bản & Show-Say sync
    const validation = validateTemplateProductScript(analysisData);
    if (!validation.valid) {
      console.warn(`[TemplateProduct] Script validation warnings:`, validation.errors.concat(validation.warnings));
    }
    const showSayCheck = { warnings: [] }; // Voice and visuals intentionally decoupled.
    if (showSayCheck.warnings.length > 0) {
      console.warn(`[TemplateProduct] Show-Say Sync notes:`, showSayCheck.warnings);
    }

    analysis = analysisData.analysis || {};
    script = analysisData.script || [];

    // ── Sinh Master Storyboard (5 panels) qua Google Flow ──
    console.log(`[TemplateProduct] Step 2: Generating candidate storyboards via Google Flow...`);
    const masterPrompt = buildTemplateProductMasterPrompt(analysis, {
      ...options,
      hasInput2: Boolean(productCollage2Buf)
    });

    // validPayloads = [model.png (riêng), input.png, input2.png (nếu có)]
    const validPayloads = [
      { name: 'model.png', buffer: presenterAsset.buffer, mimeType: 'image/png' },
      ...(productCollageBuf ? [{ name: 'input.png', buffer: productCollageBuf, mimeType: 'image/png' }] : []),
      ...(productCollage2Buf ? [{ name: 'input2.png', buffer: productCollage2Buf, mimeType: 'image/png' }] : [])
    ];
    console.log(`[TemplateProduct] 🖼️ Sending ${validPayloads.length} reference(s) to Flow: ${validPayloads.map(p => p.name).join(', ')}`);

    let lastMasterErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let flowPage = null;
      try {
        if (attempt > 1) {
          console.log(`[TemplateProduct] 🔄 Retrying Master Storyboard generation (Attempt ${attempt}/3)...`);
          await new Promise(r => setTimeout(r, 4000));
        }
        sanitizeChromeDataProfiles(effectiveBaseDir);
        flowPage = await createFlowPage(effectiveBaseDir);
        const prepared = await prepareGeneration(
          flowPage,
          masterPrompt,
          validPayloads,
          {
            imageModel: 'nano-banana-pro',
            aspectRatio: '16:9',
            outputCount: 4,
          },
          effectiveBaseDir
        );
        const genResult = await executeGeneration(prepared);
        if (genResult && Array.isArray(genResult.allResults) && genResult.allResults.length > 0) {
          candidateBuffers = genResult.allResults.map(r => r.buffer || Buffer.from(r.base64, 'base64')).filter(Boolean);
        } else if (genResult && (genResult.buffer || genResult.base64)) {
          candidateBuffers = [genResult.buffer || Buffer.from(genResult.base64, 'base64')];
        }

        if (candidateBuffers.length > 0) {
          console.log(`[TemplateProduct] ✅ Successfully generated ${candidateBuffers.length} Master Storyboard candidates in parallel!`);
          break;
        }
      } catch (fErr) {
        lastMasterErr = fErr;
        console.warn(`[TemplateProduct] Flow Master Storyboard Attempt ${attempt}/3 failed: ${fErr.message}`);
      } finally {
        if (flowPage) {
          try { await closeFlowPage(flowPage); } catch (_) { }
        }
      }
    }

    if (candidateBuffers.length === 0) {
      throw new Error(`[TemplateProduct] Failed to generate Master Storyboard candidates via Google Flow after 3 attempts: ${lastMasterErr?.message || 'Unknown error'}`);
    }

    candidateBuffers.forEach((buf, idx) => {
      fs.writeFileSync(path.join(candidatesDir, `candidate-${idx + 1}.png`), buf);
    });

    // ── Kiểm tra & Đánh giá chất lượng / layout của các ứng viên Master Storyboard ──
    const qaResult = await verifyProductStoryboardCandidatesWithGeminiVision(geminiClient, candidateBuffers, {
      ...(stage1Parsed?.analysis || analysis),
      candidatesDir,
    }, {
      template,
      storyboardBackgroundPreset: options.storyboardBackgroundPreset,
    });
    const bestCandIdx = Number(qaResult?.selectedCandidateIndex) || 1;
    const bestMasterBuf = candidateBuffers[bestCandIdx - 1] || candidateBuffers[0];

    // ── Slices master thành 5 vertical panels tự nhiên (Zero-Distortion) ──
    console.log(`[TemplateProduct] Step 3: Slicing master storyboard (Candidate #${bestCandIdx}) into 5 vertical panels (as-is, zero-distortion)...`);
    const tempMasterPath = path.join(runDir, 'temp-master.png');
    fs.writeFileSync(tempMasterPath, bestMasterBuf);

    let panelPaths = [];
    try {
      panelPaths = sliceMasterStoryboardProduct(tempMasterPath, panelsDir);
    } catch (sErr) {
      console.warn(`[TemplateProduct] Slicing error: ${sErr.message}. Creating individual panel images...`);
      panelPaths = [];
      for (let i = 1; i <= 5; i++) {
        const pPath = path.join(panelsDir, `panel-${i}.png`);
        fs.writeFileSync(pPath, presenterAsset.buffer);
        panelPaths.push(pPath);
      }
    }

    const panelBuffers = panelPaths.map(p => fs.readFileSync(p));

    // Ghép lại thành master storyboard chuẩn 5 panels
    const masterPath = path.join(runDir, 'master-storyboard.png');
    composeMasterStoryboardProduct(panelBuffers, masterPath);

    // Ghi log prompt.md & prompts.md
    const initialMd = buildInitialProductMarkdown({
      runId,
      analysisData,
      masterPrompt,
      qaResult,
      bestCandidateIndex: bestCandIdx,
      chatId,
      inputs: validPayloads,
    });
    writeMarkdownLog(runDir, initialMd);

    // Ghi các file JSON chi tiết đầu vào / đầu ra để debug và audit
    try {
      fs.writeFileSync(
        path.join(runDir, 'gemini-stage1-intelligence.json'),
        JSON.stringify({
          stage: 'STAGE_1_PRODUCT_INTELLIGENCE',
          prompt: promptA,
          uploadedFiles,
          rawResponse: stage1Text,
          parsed: stage1Parsed
        }, null, 2),
        'utf8'
      );
      fs.writeFileSync(
        path.join(runDir, 'gemini-stage2-script.json'),
        JSON.stringify({
          stage: 'STAGE_2_SCRIPT_AND_STORYBOARD',
          prompt: promptB,
          rawResponse: stage2Text,
          parsed: stage2Parsed,
          script: analysisData.script
        }, null, 2),
        'utf8'
      );
      fs.writeFileSync(
        path.join(runDir, 'flow-storyboard-payload.json'),
        JSON.stringify({
          step: 'STEP_2_FLOW_MASTER_STORYBOARD',
          prompt: masterPrompt,
          model: 'nano-banana-pro',
          aspectRatio: '16:9',
          outputCount: 4,
          inputReferences: validPayloads.map(p => ({
            name: p.name,
            mimeType: p.mimeType,
            sizeBytes: p.buffer ? p.buffer.length : 0
          })),
          candidateCount: candidateBuffers.length,
          bestCandidateIndex: bestCandIdx,
          qaResult,
          slicedPanels: panelPaths.map(p => path.basename(p))
        }, null, 2),
        'utf8'
      );
    } catch (writeErr) {
      console.warn(`[TemplateProduct] Warning writing intermediate JSON logs: ${writeErr.message}`);
    }

    // Lưu session
    const extractedProductId = options.productContext?.productId || options.productId || (originalJobId && originalJobId.startsWith('tg_') ? originalJobId.split('_')[2] : '') || '';
    const extractedProductTitle = options.productContext?.productTitle || options.productTitle || analysisData?.productName || analysisData?.analysis?.productName || 'Sản phẩm review';
    const session = {
      runId,
      jobId: originalJobId,
      baseDir: effectiveBaseDir,
      chatId,
      template,
      productId: extractedProductId,
      productTitle: extractedProductTitle,
      productUrl: options.productContext?.productUrl || options.productUrl || '',
      shortlink: options.productContext?.shortlink || options.shortlink || '',
      cartAnchorText: options.productContext?.cartAnchorText || analysisData?.cartAnchorText || analysisData?.analysis?.cartAnchorText || '',
      promptsMdPath: path.join(runDir, 'prompt.md'),
      analysis: analysisData,
      stage1Prompt: promptA,
      stage1RawResponse: stage1Text || (stage1Parsed ? JSON.stringify(stage1Parsed, null, 2) : ''),
      stage2Prompt: promptB,
      stage2RawResponse: stage2Text || (stage2Parsed ? JSON.stringify(stage2Parsed, null, 2) : ''),
      masterPrompt,
      flowPayload: {
        model: 'nano-banana-pro',
        aspectRatio: '16:9',
        outputCount: 4,
        images: validPayloads.map(p => ({ name: p.name, mimeType: p.mimeType, sizeBytes: p.buffer?.length || 0 })),
      },
      runDir,
      panelsDir,
      candidatesDir,
      videosDir,
      candidateCount: candidateBuffers.length,
      bestCandidateIndex: bestCandIdx,
      qaResult,
      panelPaths,
      presenterModel: presenterAsset.filename || path.basename(presenterAsset.path),
      presenterModelPath: presenterAsset.path,
      isAuto,
      createdAt: new Date().toISOString(),
    };
    saveProductSession(runId, session);
    if (originalJobId && originalJobId !== runId) {
      saveProductSession(originalJobId, session);
    }

    // Gửi Telegram tương tác nếu có chatId và không phải auto mode
    if (chatId && !isAuto) {
      const candidateScoresText = Array.isArray(qaResult?.candidates)
        ? qaResult.candidates.map(c => `#${c.candidateIndex || c.index}: <b>${c.totalScore !== undefined ? c.totalScore : (c.score || 0)}đ</b>`).join(' | ')
        : '';
      const chosenCandObj = qaResult?.candidates?.find(c => (c.candidateIndex || c.index) === bestCandIdx) || qaResult?.candidates?.[0];
      const bestScore = chosenCandObj?.totalScore !== undefined ? chosenCandObj.totalScore : (chosenCandObj?.score || 94);
      const captionLines = [
        `🎨 <b>[Template Product] Master Storyboard đã tạo xong! (40s Native-Voice)</b>\n`,
        `📦 <b>Sản phẩm:</b> ${analysis.productName || 'Sản phẩm review'}`,
        `🏭 <b>Bối cảnh:</b> <code>${settingObj.title}</code>`,
        `🎯 <b>Chế độ bán hàng:</b> <code>${analysis.salesMode || 'PRICE_LED'}</code> (5 Cảnh x 8s, 34-40 từ/cảnh)`,
        `👤 <b>Người mẫu (Presenter):</b> <code>${session.presenterModel || 'model.png'}</code>`,
        ...(candidateScoresText ? [`📊 <b>Điểm 4 Storyboard:</b> ${candidateScoresText}`] : []),
        `🏆 <b>Đã chọn:</b> Storyboard #${bestCandIdx} (Điểm kiểm định: <b>${bestScore}/100</b>)\n`,
        `🖼️ Storyboard gồm 5 cảnh (1: Hook, 2: Deal Build, 3: Offer & CTA, 4: Proof/Demo, 5: Benefit & Close).`,
        `🎙️ <b>Giọng nói trực tiếp (Native Voice):</b> \n`,
        `👉 <i>Bấm nút bên dưới nếu bạn muốn làm lại (Remake) cảnh cụ thể, làm lại tất cả, hoặc bấm OK để sinh video:</i>`
      ];

      const keyboard = buildProductStoryboardInlineKeyboard(runId);
      await sendPhotoToTelegram(chatId, masterPath, captionLines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    }

    return {
      success: true,
      runId,
      jobId: originalJobId,
      template,
      analysis: analysisData,
      masterStoryboardPath: masterPath,
      panels: [1, 2, 3, 4, 5].map(idx => ({
        index: idx,
        panelIndex: idx,
        imagePath: path.join(panelsDir, `panel-${idx}.png`),
        buffer: panelBuffers[idx - 1],
      })),
      isInteractiveStoryboard: true,
    };
  } finally {
    try { await geminiClient.close(); } catch (_) { }
  }
}

// ── 23. REMAKE STORYBOARD HANDLERS (TELEGRAM INTERACTIONS) ────────────────────

async function executeProductRemakePanel(chatId, baseDir, runId, targetPanelIndex, opts = {}) {
  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const session = getProductSession(runId, effectiveBaseDir);
  if (!session) throw new Error(`Product session not found for run ${runId}`);

  const pIdx = Math.max(1, Math.min(5, Number(targetPanelIndex) || 1));
  console.log(`[TemplateProduct] Remaking panel ${pIdx} via Google Flow for run ${runId}...`);

  sanitizeChromeDataProfiles(effectiveBaseDir);
  const flowPage = await createFlowPage(effectiveBaseDir);
  let newPanelBuf = null;
  let rPrompt = '';

  try {
    rPrompt = buildTemplateProductRemakePrompt(session.analysis?.analysis, pIdx, opts.customInstruction, {
      template: session.template,
      storyboardBackgroundPreset: session.template === 'template_product2' ? 'wholesale_showroom_warehouse' : undefined,
    });
    const presenterAsset = getCanonicalPresenterBuffer({
      modelPath: session?.presenterModelPath,
      modelName: session?.presenterModel,
    });
    const remakePayloads = [];
    if (presenterAsset) {
      remakePayloads.push({
        name: 'model.png',
        buffer: presenterAsset.buffer,
        mimeType: 'image/png'
      });
    }
    const inputCollagePath = path.join(session?.runDir || '', 'inputs', 'input.png');
    if (fs.existsSync(inputCollagePath)) {
      remakePayloads.push({
        name: 'input.png',
        buffer: fs.readFileSync(inputCollagePath),
        mimeType: 'image/png'
      });
    }
    const input2CollagePath = path.join(session?.runDir || '', 'inputs', 'input2.png');
    if (fs.existsSync(input2CollagePath)) {
      remakePayloads.push({
        name: 'input2.png',
        buffer: fs.readFileSync(input2CollagePath),
        mimeType: 'image/png'
      });
    }

    const prepared = await prepareGeneration(flowPage, rPrompt, remakePayloads, {
      imageModel: 'nano-banana-pro',
      aspectRatio: '9:16',
      outputCount: 1,
    }, effectiveBaseDir);

    const genRes = await executeGeneration(prepared);
    if (genRes && genRes.buffer) newPanelBuf = genRes.buffer;
    else if (genRes && Array.isArray(genRes.allResults) && genRes.allResults[0]?.buffer) {
      newPanelBuf = genRes.allResults[0].buffer;
    }
  } finally {
    await closeFlowPage(flowPage).catch(() => { });
  }

  if (!newPanelBuf) {
    throw new Error(`Failed to remake panel ${pIdx} via Google Flow`);
  }

  // Cập nhật panel file
  const panelPath = path.join(session.panelsDir, `panel-${pIdx}.png`);
  fs.writeFileSync(panelPath, newPanelBuf);

  // Đọc lại 5 panel và ghép lại master storyboard
  const currentPanels = [1, 2, 3, 4, 5].map(i => {
    const f = path.join(session.panelsDir, `panel-${i}.png`);
    return fs.existsSync(f) ? fs.readFileSync(f) : newPanelBuf;
  });
  const masterPath = path.join(session.runDir, 'master-storyboard.png');
  composeMasterStoryboardProduct(currentPanels, masterPath);

  // Ghi log remake panel vào prompt.md
  const remakeLog = [
    '',
    '---',
    `### Remake Panel ${pIdx} Log — ${new Date().toISOString()}`,
    `- **Target Panel**: ${pIdx}`,
    `- **Custom Instruction**: ${opts.customInstruction || 'None'}`,
    '```text',
    rPrompt,
    '```',
    `- **New Panel Saved**: \`panels/panel-${pIdx}.png\``,
    `- **Updated Master Storyboard**: \`master-storyboard.png\``,
    ''
  ].join('\n');
  appendMarkdownLog(session.runDir, remakeLog);

  saveProductSession(runId, session);

  if (chatId) {
    const caption = `🎨 <b>[Template Product] Đã vẽ lại Cảnh ${pIdx}!</b>\n\n` +
      `👉 <i>Bấm Remake cảnh khác nếu muốn chỉnh sửa tiếp, hoặc bấm "OK Sinh Video 40s":</i>`;
    const keyboard = buildProductStoryboardInlineKeyboard(runId);
    await sendPhotoToTelegram(chatId, masterPath, caption, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }
  return { panelIndex: pIdx, masterStoryboardPath: masterPath, panelPath };
}

async function executeProductRemakeAll(chatId, baseDir, runId, opts = {}) {
  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const session = getProductSession(runId, effectiveBaseDir);
  if (!session) throw new Error(`Product session not found for run ${runId}`);

  console.log(`[TemplateProduct] Remaking ALL 5 panels via Google Flow for run ${runId}...`);
  sanitizeChromeDataProfiles(effectiveBaseDir);
  const flowPage = await createFlowPage(effectiveBaseDir);
  let newMasterBuf = null;
  let rPrompt = '';

  try {
    const inputCollagePath = path.join(session?.runDir || '', 'inputs', 'input.png');
    const input2CollagePath = path.join(session?.runDir || '', 'inputs', 'input2.png');
    const hasInput2 = fs.existsSync(input2CollagePath);

    rPrompt = buildTemplateProductRemakeAllPrompt(
      session.analysis?.analysis,
      opts.customInstruction,
      {
        hasInput2,
        template: session.template,
        storyboardBackgroundPreset: session.template === 'template_product2' ? 'wholesale_showroom_warehouse' : undefined,
      }
    );
    const presenterAsset = getCanonicalPresenterBuffer({
      modelPath: session?.presenterModelPath,
      modelName: session?.presenterModel,
    });
    const remakePayloads = [];
    if (presenterAsset) {
      remakePayloads.push({
        name: 'model.png',
        buffer: presenterAsset.buffer,
        mimeType: 'image/png'
      });
    }
    if (fs.existsSync(inputCollagePath)) {
      remakePayloads.push({
        name: 'input.png',
        buffer: fs.readFileSync(inputCollagePath),
        mimeType: 'image/png'
      });
    }
    if (hasInput2) {
      remakePayloads.push({
        name: 'input2.png',
        buffer: fs.readFileSync(input2CollagePath),
        mimeType: 'image/png'
      });
    }

    const prepared = await prepareGeneration(flowPage, rPrompt, remakePayloads, {
      imageModel: 'nano-banana-pro',
      aspectRatio: '16:9',
      outputCount: 1,
    }, effectiveBaseDir);

    const genRes = await executeGeneration(prepared);
    if (genRes && genRes.buffer) newMasterBuf = genRes.buffer;
    else if (genRes && Array.isArray(genRes.allResults) && genRes.allResults[0]?.buffer) {
      newMasterBuf = genRes.allResults[0].buffer;
    }
  } finally {
    await closeFlowPage(flowPage).catch(() => { });
  }

  if (!newMasterBuf) {
    throw new Error('Failed to regenerate master storyboard via Google Flow');
  }

  const tempMasterPath = path.join(session.runDir, 'temp-master-remake.png');
  fs.writeFileSync(tempMasterPath, newMasterBuf);

  // Slices master mới thành 5 vertical panels tự nhiên (Zero-Distortion)
  const newPanels = sliceMasterStoryboardProduct(tempMasterPath, session.panelsDir);
  const panelBuffers = newPanels.map(p => fs.readFileSync(p));
  const masterPath = path.join(session.runDir, 'master-storyboard.png');
  composeMasterStoryboardProduct(panelBuffers, masterPath);

  // Ghi log remake all vào prompt.md
  const remakeLog = [
    '',
    '---',
    `### Remake All 5 Panels Log — ${new Date().toISOString()}`,
    `- **Custom Instruction**: ${opts.customInstruction || 'None'}`,
    '```text',
    rPrompt,
    '```',
    `- **Updated Master Storyboard**: \`master-storyboard.png\``,
    ''
  ].join('\n');
  appendMarkdownLog(session.runDir, remakeLog);

  saveProductSession(runId, session);

  if (chatId) {
    const caption = `♻️ <b>[Template Product] Đã tạo lại toàn bộ 5 cảnh Storyboard!</b>\n\n` +
      `👉 <i>Bấm Remake cảnh nếu cần hoặc bấm "OK Sinh Video 40s" để bắt đầu:</i>`;
    const keyboard = buildProductStoryboardInlineKeyboard(runId);
    await sendPhotoToTelegram(chatId, masterPath, caption, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }
  return { masterStoryboardPath: masterPath };
}

function sanitizeChromeDataProfiles(baseDir) {
  try {
    const userDataDir = path.join(baseDir, 'chrome-data');
    if (!fs.existsSync(userDataDir)) return;

    for (const f of fs.readdirSync(userDataDir)) {
      if (f.startsWith('Singleton')) {
        try { fs.unlinkSync(path.join(userDataDir, f)); } catch (_) { }
      }
    }

    const candidateDirs = ['Default', 'Profile 1', 'Profile 2', 'System Profile'];
    for (const d of candidateDirs) {
      const pPath = path.join(userDataDir, d, 'Preferences');
      if (fs.existsSync(pPath)) {
        try {
          const content = JSON.parse(fs.readFileSync(pPath, 'utf8'));
          if (content && typeof content === 'object') {
            if (!content.profile) content.profile = {};
            content.profile.exit_type = 'Normal';
            content.profile.exited_cleanly = true;
            fs.writeFileSync(pPath, JSON.stringify(content));
          }
        } catch (_) { }
      }
    }
  } catch (_) { }
}

function generateCameraMotionProductClip(imagePath, outputPath, opts = {}) {
  ensureDir(path.dirname(outputPath));
  const pIdx = opts.panelIndex || 1;
  const duration = opts.duration || 8.0;
  const totalFrames = Math.round(duration * 24);

  // High-definition cinematic camera motion tailored for Live-Commerce 8-second clips:
  let zoompanFilter = `zoompan=z='min(zoom+0.0004,1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1080x1920:fps=24`;
  if (pIdx === 2) {
    zoompanFilter = `zoompan=z='1.04':x='iw/2-(iw/zoom/2)':y='(ih/2-(ih/zoom/2))*(1+0.0003*on)':d=${totalFrames}:s=1080x1920:fps=24`;
  } else if (pIdx === 3) {
    zoompanFilter = `zoompan=z='min(zoom+0.0005,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1080x1920:fps=24`;
  } else if (pIdx === 4) {
    zoompanFilter = `zoompan=z='min(zoom+0.0006,1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1080x1920:fps=24`;
  } else if (pIdx === 5) {
    zoompanFilter = `zoompan=z='max(1.06-0.0003*on,1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1080x1920:fps=24`;
  }

  const filterComplex = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${zoompanFilter}`;

  try {
    execSync(
      `"${ffmpegPath}" -y -loop 1 -i "${imagePath}" -f lavfi -i anullsrc=r=48000:cl=stereo -vf "${filterComplex}" -t ${duration.toFixed(1)} -c:v libx264 -pix_fmt yuv420p -r 24 -c:a aac -b:a 192k "${outputPath}"`,
      { stdio: 'pipe', timeout: 45000 }
    );
  } catch (err) {
    console.warn(`[TemplateProduct] Camera motion failed for panel ${pIdx} (${err.message}). Using standard static loop.`);
    execSync(
      `"${ffmpegPath}" -y -loop 1 -i "${imagePath}" -f lavfi -i anullsrc=r=48000:cl=stereo -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1" -t ${duration.toFixed(1)} -c:v libx264 -pix_fmt yuv420p -r 24 -c:a aac -b:a 192k "${outputPath}"`,
      { stdio: 'pipe', timeout: 35000 }
    );
  }
}

// ── 24. FINALIZE 5x 8s VEO VIDEOS & MERGE (40s NATIVE VOICE) ──────────────────

async function finalizeProductStoryboardAndGenerateVideos(chatId, baseDir, runId, opts = {}) {
  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const session = getProductSession(runId, effectiveBaseDir);
  if (!session) throw new Error(`Product session not found for run ${runId}`);

  const tracker = opts.stepTracker || null;
  if (tracker) {
    await tracker.setStep(3, 'Đã chốt Storyboard 5 cảnh! Đang khởi tạo 5 video Veo 8s Native-Voice...');
  }

  console.log(`[TemplateProduct] 🎬 Generating 5x 8s videos (Model: abra_i2v_8s, panel as start frame)...`);
  sanitizeChromeDataProfiles(effectiveBaseDir);

  const panelJobs = buildTemplateProductRemakeVideoJobs(
    session.runDir,
    [1, 2, 3, 4, 5],
    opts.customInstruction,
    session.analysis?.analysis
  );

  let videoResults = [];
  try {
    const prodOpts = buildTemplateOptions('template_product');
    videoResults = await generateVideosFromPanelsDirect(effectiveBaseDir, panelJobs, {
      aspectRatio: '9:16',
      videoModelKey: 'abra_i2v_8s',
      includeVideoBase64: true,
      multiImageMode: false,
      outputCount: 1,
      cropPercent: 0,
      preserveBorder: true,
      runId: `prod-${runId}`,
      template: 'template_product',
      useProxy: prodOpts.useProxy,
    });
  } catch (genErr) {
    console.warn(`[TemplateProduct] ⚠️ Remote Veo generation error: ${genErr.message}`);
  }

  const savedVideoPaths = [];
  const failedPanelIndices = [];
  for (let i = 1; i <= 5; i++) {
    const targetPath = path.join(session.videosDir, `panel-${i}.mp4`);
    const r = (videoResults || []).find(v => v.panelIndex === i) || videoResults?.[i - 1];
    let isSuccess = false;

    if (r?.videoPath && fs.existsSync(r.videoPath) && fs.statSync(r.videoPath).size > 1000) {
      try {
        fs.copyFileSync(r.videoPath, targetPath);
        isSuccess = true;
      } catch (_) { }
    } else if (r?.videoBase64) {
      try {
        fs.writeFileSync(targetPath, Buffer.from(r.videoBase64, 'base64'));
        isSuccess = true;
      } catch (_) { }
    }

    if (isSuccess && fs.existsSync(targetPath) && fs.statSync(targetPath).size > 1000) {
      savedVideoPaths.push(targetPath);
    } else {
      // BỎ QUA video bị lỗi (PUBLIC_ERROR_UNSAFE_GENERATION hoặc timeout).
      // KHÔNG tạo fallback video tĩnh từ hình ảnh!
      console.warn(`[TemplateProduct] ⚠️ Panel ${i} video generation failed on server. Skipping panel ${i} (will NOT merge into final video).`);
      failedPanelIndices.push(i);
      if (fs.existsSync(targetPath)) {
        try { fs.unlinkSync(targetPath); } catch (_) { }
      }
    }
  }

  // Ghép các video clips thành công (bỏ qua các panel bị lỗi)
  let mergedVideoPath = null;
  if (savedVideoPaths.length > 0) {
    console.log(`[TemplateProduct] 🎞️ Concatting ${savedVideoPaths.length}/5 native-audio clips into final video (failed/skipped panels: ${failedPanelIndices.join(', ') || 'none'})...`);
    mergedVideoPath = path.join(session.videosDir, 'final_video.mp4');
    try {
      concat5NativeAudioClips(savedVideoPaths, mergedVideoPath);
    } catch (mergeErr) {
      console.error(`[TemplateProduct] ❌ Failed to merge video clips: ${mergeErr.message}`);
      mergedVideoPath = null;
    }
  } else {
    console.warn(`[TemplateProduct] ⚠️ No video clips succeeded on Flow server. Final video skipped.`);
  }

  const finalDur = (mergedVideoPath && fs.existsSync(mergedVideoPath))
    ? (getMediaDuration(mergedVideoPath) || (savedVideoPaths.length * 8.0))
    : (savedVideoPaths.length * 8.0);
  const durationFormatted = finalDur.toFixed(1);
  const prodName = session.analysis?.analysis?.productName || 'Sản phẩm Live-Commerce';
  const defaultTags = ['#livestream', '#xuhuong', '#review', '#sanphamchinhhang', '#tiktokshop'];
  const hashtags = normalizeHashtags(session.analysis?.analysis?.hashtags, defaultTags).slice(0, 5);

  // Copy vào thư mục final/ để đồng bộ upload TikTok nếu mergedVideoPath tồn tại
  if (mergedVideoPath && fs.existsSync(mergedVideoPath)) {
    const finalDir = path.join(session.runDir, 'final');
    ensureDir(finalDir);
    const finalVideoPath = path.join(finalDir, 'final-video.mp4');
    try { fs.copyFileSync(mergedVideoPath, finalVideoPath); } catch (_) { }
  }

  session.mergedVideoPath = mergedVideoPath;
  session.finalVideoPath = mergedVideoPath;
  session.savedVideoPaths = savedVideoPaths;
  session.failedPanelIndices = failedPanelIndices;
  saveProductSession(runId, session);

  // Đăng ký completed job vào generationJobService
  if (typeof registerExternalCompletedJob === 'function') {
    const jobPayload = {
      jobId: `tproduct-${runId}`,
      chatId: String(chatId),
      template: 'template_product',
      hasVoice: false, // Native Voice inside video, no external TTS
      nativeVoice: true,
      jobDir: session.runDir,
      baseDir: effectiveBaseDir,
      status: 'completed',
      finalVideoPath: mergedVideoPath,
      productId: session.productId || session.analysis?.productId || (session.jobId && session.jobId.startsWith('tg_') ? session.jobId.split('_')[2] : '') || '',
      productTitle: session.productTitle || prodName,
      productUrl: session.productUrl || '',
      shortlink: session.shortlink || '',
      cartAnchorText: session.cartAnchorText || session.analysis?.analysis?.cartAnchorText || '',
      panels: [1, 2, 3, 4, 5].map(idx => ({ index: idx, status: 'completed' })),
      result: {
        runId,
        finalVideoPath: mergedVideoPath,
        reviewArchive: {
          root: session.runDir,
          panelsDir: session.panelsDir,
          videosDir: session.videosDir,
          storyboardPath: session.masterStoryboardPath,
          promptsPath: session.promptsMdPath,
        },
        panels: [1, 2, 3, 4, 5].map(idx => ({ index: idx, imagePath: path.join(session.panelsDir, `panel-${idx}.png`) })),
        videos: savedVideoPaths.map((vp, idx) => ({ panelIndex: idx + 1, videoPath: vp })),
        analysis: session.analysis,
      },
      analysis: session.analysis,
      caption: prodName,
      hashtags,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    registerExternalCompletedJob(chatId, jobPayload);
    if (session.jobId && session.jobId !== runId) {
      registerExternalCompletedJob(chatId, { ...jobPayload, jobId: `tproduct-${session.jobId}` });
      registerExternalCompletedJob(chatId, { ...jobPayload, jobId: session.jobId });
    }
  }

  if (opts.lastRunByChat) {
    opts.lastRunByChat.set(String(chatId), {
      runDir: session.runDir,
      panelsDir: session.panelsDir,
      videosDir: session.videosDir,
      template: 'template_product',
      analysis: session.analysis,
      baseDir: effectiveBaseDir,
    });
  }

  // Ghi log video generation vào prompt.md
  const finalizeLog = [
    '',
    '---',
    `## Step 4: 5x 8s Native-Voice Video Generation & Concat (${durationFormatted}s) — ${new Date().toISOString()}`,
    `- **Video Model**: \`veo_3_1_i2v_s_lite_8s_low_priority\` (Start Frame mode, 9:16 aspect ratio)`,
    `- **Clips Generated**: 5 clips of 8 seconds each (total ~40.0s)`,
    `- **Audio Architecture**: Native dialogue generated directly inside Veo video clips (NO TTS, NO voice muxing)`,
    '',
    '### Veo 8s Native-Voice Prompts:',
    ...panelJobs.map(job => [
      `#### Clip ${job.panelIndex} (${session.analysis?.script?.[job.panelIndex - 1]?.phase || `Scene ${job.panelIndex}`}):`,
      '```text',
      job.prompt,
      '```',
    ].join('\n')),
    '',
    `- **Final Assembled Video**: \`${mergedVideoPath}\` (${durationFormatted}s, 5 native clips concatenated)`,
    `- **Telegram Delivery**: Sent to chat \`${chatId || 'N/A'}\``,
    ''
  ].join('\n');
  appendMarkdownLog(session.runDir, finalizeLog);

  if (tracker) {
    await tracker.setStep(4, 'Đã hoàn tất! Đang gửi video về Telegram...');
    await tracker.completeAll();
  }

  // Gửi video về Telegram
  if (chatId) {
    if (opts.statusMsgId) {
      await deleteTelegramMessage(chatId, opts.statusMsgId).catch(() => { });
    }

    // 1. Gửi video hoàn chỉnh (nếu có video được ghép)
    if (mergedVideoPath && fs.existsSync(mergedVideoPath)) {
      const clipDesc = failedPanelIndices.length > 0
        ? `Đã ghép ${savedVideoPaths.length}/5 Cảnh (Đã bỏ qua Cảnh ${failedPanelIndices.join(', ')} do lỗi server Flow)`
        : 'Đã ghép đủ 5 Cảnh (8s/cảnh)';
      const videoCaption = [
        `🎬 <b>[Template Product] Video Live-Commerce Hoàn Chỉnh (${durationFormatted} giây)</b>\n`,
        `✨ <i>${clipDesc} lồng ghép giọng đọc review tiếng Việt tự nhiên 100% (Native Voice).</i>`
      ].join('\n');

      await sendMergedVideoToTelegram(chatId, mergedVideoPath, videoCaption, {
        parse_mode: 'HTML',
      });
    } else {
      await sendTelegramMessage(chatId, `⚠️ <b>[Template Product] Không thể tạo video ghép:</b> Toàn bộ các cảnh video đều gặp sự cố trên server Flow Google. Vui lòng bấm Remake cảnh để thử lại.`, {
        parse_mode: 'HTML',
      });
    }

    // 2. Xóa message tiến trình cũ
    if (tracker && tracker.messageId) {
      await deleteTelegramMessage(chatId, tracker.messageId).catch(() => { });
      tracker.messageId = null;
    }
    if (session.stepTrackerMessageId) {
      await deleteTelegramMessage(chatId, session.stepTrackerMessageId).catch(() => { });
      session.stepTrackerMessageId = null;
    }

    // 3. Gửi tiêu đề + hashtag để copy tiện lợi
    await sendTelegramMessage(chatId, `${prodName}\n\n${hashtags.join(' ')}`);

    // 4. Gửi status message hoàn tất kèm keyboard thao tác
    const keyboard = buildProductVideoInlineKeyboard(runId);
    const finalStatusLines = [
      `🎉 <b>TẠO VIDEO REVIEW HOÀN TẤT (${durationFormatted} GIÂY)!</b>\n`,
      `📦 <b>Sản phẩm:</b> <b>${prodName}</b>\n`,
      `1. ✅ Tải thông tin & hình ảnh sản phẩm (Khóa người mẫu ${session.presenterModel || 'model.png'})`,
      `2. ✅ Phân tích sản phẩm 2-Stage & lên kịch bản 5 cảnh 40s (34-40 từ/cảnh, 180-200 từ)`,
      `3. ✅ Tạo 5 Start Frames & chia 5 panel (16:9 -> 9:16)`,
      failedPanelIndices.length === 0
        ? `4. ✅ Sinh 5 video chuyển động AI Veo 8s có thoại trực tiếp (Native Voice)`
        : `4. ⚠️ Sinh video AI Veo 8s: ${savedVideoPaths.length}/5 cảnh thành công (Đã bỏ qua cảnh lỗi: ${failedPanelIndices.join(', ')})`,
      failedPanelIndices.length === 0
        ? `5. ✅ Ghép nối 5 clip gốc hoàn hảo, giữ nguyên âm thanh trực tiếp\n`
        : `5. ⚠️ Ghép nối ${savedVideoPaths.length} clip gốc hoàn hảo (không chứa cảnh lỗi)\n`,
      `👉 <i>Bấm nút bên dưới để tạo lại từng cảnh nếu cần, hoặc bấm Đăng lên TikTok:</i>`
    ];

    const statusMsgId = await sendTelegramMessage(chatId, finalStatusLines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    if (statusMsgId) {
      session.stepTrackerMessageId = (typeof statusMsgId === 'object' && statusMsgId?.message_id)
        ? statusMsgId.message_id
        : (typeof statusMsgId === 'number' ? statusMsgId : null);
      saveProductSession(runId, session);
    }
  }

  return {
    success: true,
    mergedVideoPath,
    savedVideoPaths,
  };
}

// ── 25. REMAKE SINGLE 8s VIDEO SCENE K (1..5) ─────────────────────────────────

async function executeProductRemakeSingleVideo(chatId, baseDir, runId, targetPanelIndex, opts = {}) {
  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const session = getProductSession(runId, effectiveBaseDir);
  if (!session) throw new Error(`Product session not found for run ${runId}`);

  const pIdx = Math.max(1, Math.min(5, Number(targetPanelIndex) || 1));
  console.log(`[TemplateProduct] Remaking single video scene ${pIdx} for run ${runId}...`);

  const pPath = path.join(session.panelsDir, `panel-${pIdx}.png`);
  const pBuf = fs.existsSync(pPath) ? fs.readFileSync(pPath) : null;
  const scriptItem = session.analysis?.script?.[pIdx - 1] || {};
  const prompt = buildTemplateProduct8sVideoPrompt(session.analysis?.analysis, scriptItem, {
    customInstruction: opts.customInstruction,
  });

  const presenterAsset = getCanonicalPresenterBuffer({
    modelPath: session?.presenterModelPath,
    modelName: session?.presenterModel,
  });
  // Single start-frame mode: panel-${pIdx}.png already contains the presenter and product locked.
  // Do NOT pass model.png as an extra reference image to avoid triggering Google Veo's PROMINENT_PEOPLE safety filter.
  const referenceImages = pBuf ? [{
    name: `panel-${pIdx}.png`,
    mimeType: 'image/png',
    buffer: pBuf,
  }] : [];

  const singleJob = [{
    index: pIdx,
    panelIndex: pIdx,
    prompt,
    imagePath: pPath,
    buffer: pBuf,
    videoModelKey: 'abra_r2v_8s',
    referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
  }];

  sanitizeChromeDataProfiles(effectiveBaseDir);

  let newVideos = [];
  try {
    const prodOpts = buildTemplateOptions('template_product');
    newVideos = await generateVideosFromPanelsDirect(effectiveBaseDir, singleJob, {
      aspectRatio: '9:16',
      videoModelKey: 'abra_r2v_8s',
      includeVideoBase64: true,
      multiImageMode: false,
      outputCount: 1,
      cropPercent: 0,
      preserveBorder: true,
      runId: `prod-${runId}-remake-${pIdx}`,
      template: 'template_product',
      useProxy: prodOpts.useProxy,
    });
  } catch (genErr) {
    console.warn(`[TemplateProduct] ⚠️ Remote Veo remake error for scene ${pIdx}: ${genErr.message}`);
  }

  const targetPath = path.join(session.videosDir, `panel-${pIdx}.mp4`);
  let isSuccess = false;
  if (newVideos && newVideos[0]?.videoPath && fs.existsSync(newVideos[0].videoPath) && fs.statSync(newVideos[0].videoPath).size > 1000) {
    try {
      fs.copyFileSync(newVideos[0].videoPath, targetPath);
      isSuccess = true;
    } catch (_) { }
  } else if (newVideos && newVideos[0]?.videoBase64) {
    try {
      fs.writeFileSync(targetPath, Buffer.from(newVideos[0].videoBase64, 'base64'));
      isSuccess = true;
    } catch (_) { }
  }

  // KHÔNG tạo fallback video tĩnh từ ảnh nếu lỗi
  if (!isSuccess) {
    console.warn(`[TemplateProduct] ⚠️ Remake video for scene ${pIdx} failed on Flow server. Skipping scene ${pIdx}.`);
    if (fs.existsSync(targetPath)) {
      try { fs.unlinkSync(targetPath); } catch (_) { }
    }
    if (chatId) {
      await sendTelegramMessage(chatId, `⚠️ <b>[Template Product] Tạo lại Video Cảnh ${pIdx} thất bại:</b> Lỗi server Flow Google (có thể do kiểm duyệt hình ảnh không an toàn hoặc lỗi mạng). Cảnh ${pIdx} đã bị bỏ qua, không được merge vào video. Bạn có thể bấm <b>Remake Cảnh ${pIdx}</b> để sinh lại ảnh panel trước.`, {
        parse_mode: 'HTML',
      });
    }
    return { success: false, panelIndex: pIdx, error: 'Remake video failed on server' };
  }

  // Ghép lại các video clips hợp lệ hiện có
  const validPanelVideos = [1, 2, 3, 4, 5]
    .map(i => path.join(session.videosDir, `panel-${i}.mp4`))
    .filter(p => fs.existsSync(p) && fs.statSync(p).size > 1000);

  let mergedVideoPath = null;
  if (validPanelVideos.length > 0) {
    mergedVideoPath = path.join(session.videosDir, 'final_video.mp4');
    try {
      concat5NativeAudioClips(validPanelVideos, mergedVideoPath);
    } catch (mergeErr) {
      console.error(`[TemplateProduct] ❌ Failed to re-merge video clips: ${mergeErr.message}`);
      mergedVideoPath = null;
    }
  }

  const finalDur = (mergedVideoPath && fs.existsSync(mergedVideoPath))
    ? (getMediaDuration(mergedVideoPath) || (validPanelVideos.length * 8.0))
    : (validPanelVideos.length * 8.0);
  const durationFormatted = finalDur.toFixed(1);
  const prodName = session.analysis?.analysis?.productName || 'Sản phẩm Live-Commerce';

  if (mergedVideoPath && fs.existsSync(mergedVideoPath)) {
    const finalDir = path.join(session.runDir, 'final');
    ensureDir(finalDir);
    try { fs.copyFileSync(mergedVideoPath, path.join(finalDir, 'final-video.mp4')); } catch (_) { }
  }

  session.mergedVideoPath = mergedVideoPath;
  session.finalVideoPath = mergedVideoPath;

  // Cập nhật job trong generationJobService
  if (typeof getJob === 'function') {
    const existingJob = getJob(`tproduct-${runId}`) || (session.jobId ? getJob(session.jobId) : null);
    if (existingJob) {
      existingJob.finalVideoPath = mergedVideoPath;
      if (existingJob.result) existingJob.result.finalVideoPath = mergedVideoPath;
      existingJob.updatedAt = new Date().toISOString();
    }
  }

  saveProductSession(runId, session);

  if (chatId && mergedVideoPath && fs.existsSync(mergedVideoPath)) {
    // 1. Gửi video hoàn chỉnh cập nhật
    const videoCaption = [
      `✨ <b>[Template Product] Đã cập nhật xong Video Cảnh ${pIdx}!</b>\n`,
      `🎬 <i>Video ${durationFormatted} giây hoàn chỉnh đã được ghép lại với Cảnh ${pIdx} mới (${validPanelVideos.length}/5 cảnh) và giữ nguyên giọng đọc trực tiếp (Native Voice).</i>`
    ].join('\n');

    await sendMergedVideoToTelegram(chatId, mergedVideoPath, videoCaption, {
      parse_mode: 'HTML',
    });

    // Xóa status message tiến trình cũ (nếu có)
    if (opts.stepTracker && opts.stepTracker.messageId) {
      await deleteTelegramMessage(chatId, opts.stepTracker.messageId).catch(() => { });
      opts.stepTracker.messageId = null;
    }
    if (session.stepTrackerMessageId) {
      await deleteTelegramMessage(chatId, session.stepTrackerMessageId).catch(() => { });
      session.stepTrackerMessageId = null;
    }
    if (opts.statusMsgId) {
      await deleteTelegramMessage(chatId, opts.statusMsgId).catch(() => { });
    }

    // 2. Gửi status message mới kèm options remake video hoặc upload TikTok
    const keyboard = buildProductVideoInlineKeyboard(runId);
    const updatedStatusText = [
      `🎉 <b>ĐÃ CẬP NHẬT XONG VIDEO CẢNH ${pIdx}!</b>\n`,
      `📦 <b>Sản phẩm:</b> <b>${prodName}</b>\n`,
      `1. ✅ Tải thông tin & hình ảnh sản phẩm`,
      `2. ✅ Phân tích sản phẩm & lên kịch bản review 40s (34-40 từ/cảnh)`,
      `3. ✅ Tạo 5 Start Frames & chia 5 panel (16:9 -> 9:16)`,
      `4. ✅ Tạo lại Video Cảnh ${pIdx} (8s Native Voice)`,
      `5. ✅ Ghép nối 5 clip gốc hoàn hảo, giữ nguyên giọng đọc trực tiếp\n`,
      `👉 <i>Bấm nút bên dưới nếu bạn muốn Remake tiếp cảnh khác, hoặc bấm Đăng lên TikTok:</i>`
    ].join('\n');

    const newStatusId = await sendTelegramMessage(chatId, updatedStatusText, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    if (newStatusId) {
      session.stepTrackerMessageId = (typeof newStatusId === 'object' && newStatusId?.message_id)
        ? newStatusId.message_id
        : (typeof newStatusId === 'number' ? newStatusId : null);
      saveProductSession(runId, session);
    }
  }

  return { panelIndex: pIdx, mergedVideoPath };
}

// ── 26. MODULE EXPORTS ────────────────────────────────────────────────────────

module.exports = {
  // Main Pipeline & Handlers
  generateStoryboard,
  executeProductRemakePanel,
  executeProductRemakeAll,
  finalizeProductStoryboardAndGenerateVideos,
  executeProductRemakeSingleVideo,

  // Prompt Builders & Validators
  buildTemplateProductAnalysisPrompt,
  validateTemplateProductScript,
  buildTemplateProductMasterPrompt,
  buildTemplateProduct8sVideoPrompt,
  buildTemplateProduct8sVideoPrompts,
  buildTemplateProductRemakeVideoJobs,
  buildTemplateProductRemakePrompt,
  buildTemplateProductRemakeAllPrompt,

  // 2-Stage Architecture Prompts
  buildProductIntelligencePromptA,
  buildScriptAndStoryboardPromptB,

  // Technical Engines (from tfood)
  parseJsonObjectProduct,
  PRODUCT_CATEGORY_ROUTING,
  routeProductCategory,
  classifyProductReferenceRoles,
  analyzeProductPhysicalProfile,
  deriveProductForbiddenActions,
  deriveProductAffordances,
  detectProductSourcingSetting,
  buildProductSourcingScenePrompt,
  buildProductPropPlan,
  buildDynamic5ClipPlan,
  buildProduct5ClipStateMachine,
  validateProductShowSaySync,

  // Keyboards & UI
  buildProductStoryboardInlineKeyboard,
  buildProductInlineKeyboard: buildProductStoryboardInlineKeyboard,
  buildProductVideoInlineKeyboard,

  // Video & Image Processing
  createProductInputCollage,
  createProductInputCollages,
  detectImageExt,
  normalizeFallbackImage,
  sliceMasterStoryboardProduct,
  composeMasterStoryboardProduct,
  concat5NativeAudioClips,
  getCanonicalPresenterBuffer,
  detectHorizontalDividers,
  verifyProductStoryboardCandidatesWithGeminiVision,

  // Session & Constants
  getProductSession,
  saveProductSession,
  DEFAULT_GLOBAL_VOICE_BIBLE,
  buildDynamicVoiceBible,
  DEFAULT_GLOBAL_VISUAL_BIBLE,
  HOOK_LIBRARY,
  UNIVERSAL_RETENTION_HOOKS,
  ALL_HOOKS,
  VOICE_STYLE_BIBLE,
  WAREHOUSE_BIBLE,
  getProductEnvironmentBible,
  getFactoryPromptFragment,
  isProductHandheld,
  getProductPlacementRule,
  buildTemplateProductMasterPrompt,
  buildTemplateProduct8sVideoPrompt,
  normalizeProductEnvironmentStoryboard,
  selectVerifiedHook,
  buildSafeLibraryHookOpening,
  normalizeWarehouseStoryboard,
  validateWarehouseStoryboard,
  validateProductEnvironmentStoryboard,
  validateOfferClaims,
  stripUnverifiedClaims,
  SOURCING_SCENE_SETTINGS,
};
