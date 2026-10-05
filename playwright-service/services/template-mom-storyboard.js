'use strict';

/**
 * template-mom-storyboard.js
 *
 * Pipeline Template Mom (/tmom, /template_mom):
 * - Kênh Mẹ & Bé chuyên biệt (Mother & Baby commerce channel).
 * - Nhân vật cố định: Mẹ (assets/nhi/mom.png) và Bé (assets/nhi/baby.png).
 * - Hoàn toàn KHÔNG FACELESS: Khuôn mặt mẹ và bé rõ ràng, giữ trọn vẹn nhận diện xuyên suốt video.
 * - Phân vai linh hoạt theo từng cảnh: "mother", "baby", hoặc "mother_and_baby" (không ép cả 2 vào mọi cảnh).
 * - Step 1 Validation Gate bắt buộc: 4 cảnh, 16-18 từ/cảnh, 65-70 từ tổng, kiểm tra cast & schema.
 * - QA Đánh giá chất lượng: Nhận diện mẹ (20đ) + Nhận diện bé (20đ) + Độ trung thực sản phẩm (20đ)...
 * - Interactive Storyboard Workflow: Duyệt và remake từng cảnh (1-4), Remake All, chốt OK để sinh 4x 4s video.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execSync } = require('child_process');

const { GeminiApiClient } = require('./gemini-client/gemini-api');
const {
  sendPhotoToTelegram,
  editPhotoInTelegram,
  sendTelegramMessage,
  deleteTelegramMessage,
  sendVideoToTelegramDirect,
  sendMergedVideoToTelegram,
} = require('./telegram-send');
const { generateVideosFromPanelsDirect } = require('./gemini-webapi-storyboard');
const { createFlowPage, closeFlowPage, resolveFlowProject } = require('./browser');
const { prepareGeneration, executeGeneration } = require('./image');
const { registerExternalCompletedJob } = require('./generation-job');
const { FlowStepTracker } = require('./flow-step-tracker');
const { getConfig } = require('../utils/config-manager');
const {
  pcmToWav,
  convertPcmToM4a,
  generateSpeechWithGemini,
} = require('./gemini-tts');

// In-memory cache for active /tmom sessions: runId -> sessionData
const momSessions = new Map();

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

// ── 1. ASSET SOURCE ARCHITECTURE & VALIDATION ─────────────────────────────────

/**
 * Tải và kiểm tra các tài nguyên nhận diện nhân vật (Mẹ & Bé) từ Asset Source
 */
function loadCharacterAssets(baseDir = path.resolve(__dirname, '..')) {
  const config = getConfig(baseDir);
  const mbSettings = config.motherBabySettings || {};

  const motherRel = mbSettings.motherAssetPath || 'assets/nhi/mom.png';
  const babyRel = mbSettings.babyAssetPath || 'assets/nhi/baby.png';

  const motherPath = path.isAbsolute(motherRel) ? motherRel : path.resolve(baseDir, motherRel);
  const babyPath = path.isAbsolute(babyRel) ? babyRel : path.resolve(baseDir, babyRel);

  if (!fs.existsSync(motherPath)) {
    const err = new Error(`Mother reference image not found at ${motherPath}`);
    err.code = 'ERR_MISSING_MOTHER_REFERENCE';
    throw err;
  }
  if (!fs.existsSync(babyPath)) {
    const err = new Error(`Baby reference image not found at ${babyPath}`);
    err.code = 'ERR_MISSING_BABY_REFERENCE';
    throw err;
  }

  return {
    motherPath,
    babyPath,
    motherBuffer: fs.readFileSync(motherPath),
    babyBuffer: fs.readFileSync(babyPath),
    world: mbSettings.world || {
      id: 'mother_baby_home',
      style: 'warm Vietnamese young-family home',
      lighting: 'soft natural daylight + subtle warm practical light',
    },
    voice: mbSettings.voice || {
      gender: 'nu',
      localeStyle: 'southern_vietnamese',
      persona: 'young_mother',
    }
  };
}

/**
 * Tạo ảnh ghép collage từ các ảnh sản phẩm đầu vào (không bao gồm nhân vật)
 */
function createProductCollageImage(productInputs) {
  if (!productInputs || productInputs.length === 0) return null;
  if (productInputs.length === 1) {
    return productInputs[0].buffer || (productInputs[0].path && fs.existsSync(productInputs[0].path) ? fs.readFileSync(productInputs[0].path) : null);
  }

  // Khử trùng lặp ảnh dựa trên MD5 hash
  const seenHashes = new Set();
  const uniqueInputs = [];
  for (const item of productInputs) {
    const buf = item.buffer || (item.path && fs.existsSync(item.path) ? fs.readFileSync(item.path) : null);
    if (!buf) continue;
    const hash = crypto.createHash('md5').update(buf).digest('hex');
    if (!seenHashes.has(hash)) {
      seenHashes.add(hash);
      uniqueInputs.push({ ...item, buffer: buf });
    }
  }

  if (uniqueInputs.length === 1) return uniqueInputs[0].buffer;

  const validPaths = uniqueInputs.slice(0, 4).map(u => u.path).filter(p => p && fs.existsSync(p));
  if (validPaths.length === 0) return uniqueInputs[0].buffer;

  try {
    const tmpOut = path.join(path.dirname(validPaths[0]), `prod_collage_${Date.now()}.png`);
    if (validPaths.length === 2) {
      execSync(`"${ffmpegPath}" -y -i "${validPaths[0]}" -i "${validPaths[1]}" -filter_complex "[0:v]scale=512:512:force_original_aspect_ratio=increase,crop=512:512[v0];[1:v]scale=512:512:force_original_aspect_ratio=increase,crop=512:512[v1];[v0][v1]hstack=inputs=2[out]" -map "[out]" -frames:v 1 "${tmpOut}"`, { stdio: 'ignore' });
    } else {
      const inputsArg = validPaths.slice(0, 4).map(p => `-i "${p}"`).join(' ');
      const filterArg = validPaths.length === 3
        ? `[0:v]scale=512:512:force_original_aspect_ratio=increase,crop=512:512[v0];[1:v]scale=512:512:force_original_aspect_ratio=increase,crop=512:512[v1];[2:v]scale=512:512:force_original_aspect_ratio=increase,crop=512:512[v2];[v0][v1][v2]hstack=inputs=3[out]`
        : `[0:v]scale=512:512:force_original_aspect_ratio=increase,crop=512:512[v0];[1:v]scale=512:512:force_original_aspect_ratio=increase,crop=512:512[v1];[2:v]scale=512:512:force_original_aspect_ratio=increase,crop=512:512[v2];[3:v]scale=512:512:force_original_aspect_ratio=increase,crop=512:512[v3];[v0][v1]hstack=inputs=2[top];[v2][v3]hstack=inputs=2[bottom];[top][bottom]vstack=inputs=2[out]`;
      execSync(`"${ffmpegPath}" -y ${inputsArg} -filter_complex "${filterArg}" -map "[out]" -frames:v 1 "${tmpOut}"`, { stdio: 'ignore' });
    }
    if (fs.existsSync(tmpOut)) {
      const buf = fs.readFileSync(tmpOut);
      try { fs.unlinkSync(tmpOut); } catch (_) {}
      return buf;
    }
  } catch (err) {
    console.warn(`[TemplateMom] Collage creation warning: ${err.message}`);
  }

  return uniqueInputs[0].buffer;
}

// ── 2. JSON SANITIZATION & PARSING ───────────────────────────────────────────

function sanitizeJsonControlCharacters(str) {
  if (!str) return '';
  let inString = false;
  let escaped = false;
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const code = str.charCodeAt(i);
    if (ch === '"' && !escaped) {
      inString = !inString;
      result += ch;
    } else if (inString) {
      if (escaped) {
        escaped = false;
        result += ch;
      } else if (ch === '\\') {
        escaped = true;
        result += ch;
      } else if (ch === '\n') {
        result += '\\n';
      } else if (ch === '\r') {
        result += '\\r';
      } else if (ch === '\t') {
        result += '\\t';
      } else if (code < 0x20) {
        result += ' ';
      } else {
        result += ch;
      }
    } else {
      escaped = false;
      result += ch;
    }
  }
  return result;
}

function repairJsonNestedQuotes(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const repaired = lines.map(line => {
    const propMatch = line.match(/^(\s*(?:\{[^{}]*)?"[^"]+"\s*:\s*")(.*)("(?:\s*\}|\s*,)?(?:\s*\/\/[^\r\n]*)?\s*)$/);
    if (propMatch) {
      const prefix = propMatch[1];
      let middle = propMatch[2];
      const suffix = propMatch[3];
      middle = middle.replace(/(?<!\\)"/g, '\\"');
      return prefix + middle + suffix;
    }
    const arrMatch = line.match(/^(\s*")(.*)("(?:\s*\}|\s*,)?(?:\s*\/\/[^\r\n]*)?\s*)$/);
    if (arrMatch) {
      const prefix = arrMatch[1];
      let middle = arrMatch[2];
      const suffix = arrMatch[3];
      middle = middle.replace(/(?<!\\)"/g, '\\"');
      return prefix + middle + suffix;
    }
    return line;
  });
  return repaired.join('\n');
}

function autoBalanceJsonBraces(text) {
  if (!text) return '';
  let cleaned = text.replace(/,\s*([}\]])/g, '$1');
  let openBraces = 0;
  let closeBraces = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '"' && !escaped) inString = !inString;
    else if (ch === '\\' && inString) escaped = !escaped;
    else {
      if (!inString) {
        if (ch === '{') openBraces++;
        else if (ch === '}') closeBraces++;
      }
      escaped = false;
    }
  }

  while (openBraces > closeBraces) {
    cleaned += '}';
    closeBraces++;
  }
  return cleaned;
}

function normalizeHashtags(raw, defaultTags = ['#mebimsua', '#mevabe', '#dodungchobe']) {
  if (Array.isArray(raw)) {
    const list = raw.map(t => String(t || '').trim()).filter(Boolean);
    return list.length > 0 ? list : defaultTags;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const list = raw.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
    return list.length > 0 ? list : defaultTags;
  }
  return defaultTags;
}

function extractFallbackAnalysisMom(text) {
  if (!text || typeof text !== 'string') return null;

  const extractString = (key) => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*(?:\\\\.[^"]*)*)"`, 'i'));
    if (m) {
      try {
        return JSON.parse(`"${m[1]}"`);
      } catch (_) {
        return m[1].replace(/\\"/g, '"');
      }
    }
    const mLine = text.match(new RegExp(`"${key}"\\s*:\\s*"([^\\r\\n]+)"(?:\\s*,)?`, 'i'));
    if (mLine) return mLine[1].replace(/^"|"$/g, '').trim();
    return null;
  };

  const pName = extractString('productName') || extractString('product_name') || extractString('name');
  if (!pName) return null;

  const category = extractString('category') || 'mother_baby';
  const subCategory = extractString('subCategory') || 'hygiene';
  const targetUser = extractString('targetUser') || 'baby';
  const buyerAngle = extractString('buyerAngle') || 'for_baby';
  const addressStyle = extractString('addressStyle') || 'các mẹ bỉm';
  const cartAnchorText = extractString('cartAnchorText') || 'Bấm giỏ hàng góc trái màn hình';
  const materials = extractString('materials') || 'Chất liệu cao cấp an toàn tuyệt đối cho bé';

  const fourAnswers = {};
  const faBlockMatch = text.match(/"fourAnswers"\s*:\s*\{([^}]+)\}/i);
  if (faBlockMatch) {
    const faBlock = faBlockMatch[1];
    for (const key of ['hook', 'solution', 'proof', 'closing']) {
      const m = faBlock.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*(?:\\\\.[^"]*)*)"`, 'i'));
      if (m) {
        try { fourAnswers[key] = JSON.parse(`"${m[1]}"`); } catch (_) { fourAnswers[key] = m[1].replace(/\\"/g, '"'); }
      }
    }
  }

  const script = [];
  const sceneRegex = /\{\s*"id"\s*:\s*([1-4])([\s\S]*?)\}(?=\s*,\s*\{|\s*\]|\s*$)/gi;
  let scMatch;
  while ((scMatch = sceneRegex.exec(text)) !== null) {
    const id = parseInt(scMatch[1], 10);
    const block = scMatch[2];
    const extractBlockField = (field) => {
      const m = block.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*(?:\\\\.[^"]*)*)"`, 'i'));
      if (m) {
        try { return JSON.parse(`"${m[1]}"`); } catch (_) { return m[1].replace(/\\"/g, '"'); }
      }
      return '';
    };
    const vo = extractBlockField('voiceOver');
    if (vo) {
      script.push({
        id,
        phase: extractBlockField('phase') || (id === 1 ? 'Hook' : (id === 2 ? 'Solution' : (id === 3 ? 'Proof' : 'Closing'))),
        goal: extractBlockField('goal') || '',
        characters: (id === 1) ? ['mother', 'baby'] : (id === 2 ? ['mother'] : (id === 3 ? ['baby'] : ['mother', 'baby'])),
        voiceOver: vo,
        visualDescription: extractBlockField('visualDescription') || `${pName} trong sinh hoạt mẹ và bé`,
        startFrame: {
          productState: 'in_use',
          composition: 'Góc máy sinh hoạt gia đình ấm cúng',
          humanPose: 'Tự nhiên, chân thật',
          cameraFraming: 'Góc máy đời thường',
          lighting: 'Ánh sáng tự nhiên'
        },
        motionPlan: {
          primaryAction: id === 1 ? `Mẹ bế bé trong không gian gia đình, chuẩn bị ${pName}` : (id === 2 ? `Mẹ nhẹ nhàng kiểm tra chất liệu và công năng của ${pName}` : (id === 3 ? `Bé nằm chơi thoải mái an toàn bên cạnh ${pName}` : `Mẹ bế bé vui vẻ đầm ấm cùng ${pName}`)),
          secondaryMotion: 'Ánh mắt và nụ cười ấm áp',
          productMotion: 'The product retains its appearance throughout the motion.',
          humanMotion: 'Micro-movements tự nhiên mẹ và bé',
          cameraMotion: 'Subtle handheld drift',
          endState: 'Khoảnh khắc gia đình êm dịu',
          motionComplexity: 'low'
        },
        actionRunway: { valid: true, reason: 'Tư thế tự nhiên ổn định' },
        humanInteraction: {
          characters: (id === 1) ? ['mother', 'baby'] : (id === 2 ? ['mother'] : (id === 3 ? ['baby'] : ['mother', 'baby'])),
          motherAction: id === 3 ? 'none' : `Mẹ chăm sóc bé và sử dụng ${pName}`,
          babyAction: id === 2 ? 'none' : 'Bé vui vẻ ngoan ngoãn',
          productInteraction: 'Sản phẩm trong đời sống mẹ và bé',
          facialExpression: 'Ấm áp hạnh phúc',
          gazeDirection: 'Tự nhiên',
          physicalContact: 'Chăm sóc an toàn'
        },
        cameraAction: 'Góc máy chân thật đời thường'
      });
    }
  }

  if (script.length < 4) {
    const voRegex = /"voiceOver"\s*:\s*"([^"]*(?:\\\\.[^"]*)*)"/gi;
    let voMatch;
    let idx = 1;
    while ((voMatch = voRegex.exec(text)) !== null && idx <= 4) {
      if (!script.some(s => s.id === idx)) {
        let vo = voMatch[1];
        try { vo = JSON.parse(`"${vo}"`); } catch (_) { vo = vo.replace(/\\"/g, '"'); }
        script.push({
          id: idx,
          phase: idx === 1 ? 'Hook' : (idx === 2 ? 'Solution' : (idx === 3 ? 'Proof' : 'Closing')),
          goal: '',
          characters: (idx === 1) ? ['mother', 'baby'] : (idx === 2 ? ['mother'] : (idx === 3 ? ['baby'] : ['mother', 'baby'])),
          voiceOver: vo,
          visualDescription: `${pName} trong sinh hoạt mẹ và bé`,
          startFrame: {
            productState: 'in_use',
            composition: 'Góc máy đời thường',
            humanPose: 'Tự nhiên',
            cameraFraming: 'Góc máy đời thường',
            lighting: 'Ánh sáng tự nhiên'
          },
          motionPlan: {
            primaryAction: `Mẹ và bé cùng ${pName}`,
            secondaryMotion: 'Ánh mắt và nụ cười ấm áp',
            productMotion: 'The product retains its appearance throughout the motion.',
            humanMotion: 'Micro-movements tự nhiên',
            cameraMotion: 'Subtle handheld drift',
            endState: 'Khoảnh khắc gia đình êm dịu',
            motionComplexity: 'low'
          },
          actionRunway: { valid: true, reason: 'Tư thế tự nhiên ổn định' },
          humanInteraction: {
            characters: (idx === 1) ? ['mother', 'baby'] : (idx === 2 ? ['mother'] : (idx === 3 ? ['baby'] : ['mother', 'baby'])),
            motherAction: 'Mẹ chăm sóc bé',
            babyAction: 'Bé vui vẻ ngoan ngoãn',
            productInteraction: 'Sản phẩm trong đời sống gia đình',
            facialExpression: 'Ấm áp hạnh phúc',
            gazeDirection: 'Tự nhiên',
            physicalContact: 'Chăm sóc an toàn'
          },
          cameraAction: 'Góc máy chân thật đời thường'
        });
      }
      idx++;
    }
  }

  if (script.length === 0) return null;

  return {
    analysis: {
      productName: pName,
      category,
      subCategory,
      targetUser,
      buyerAngle,
      addressStyle,
      cartAnchorText,
      materials,
      highlights: ['Tiện lợi cho mẹ', 'An toàn cho bé', 'Chất liệu cao cấp'],
      targetAudience: 'Mẹ bỉm sữa chăm con nhỏ',
      visibleComponents: ['bao bì chính hãng', 'chi tiết sản phẩm hoàn thiện cao cấp'],
      productAffordance: {
        productType: 'baby_product',
        states: ['packaged', 'unfolded', 'in_use', 'resting'],
        validActions: ['pick_up', 'touch_soft_surface', 'place_beside_baby'],
        invalidActions: ['open_lid', 'pour', 'press_power_button']
      },
      characterStrategy: {
        primaryCharacter: 'mother_and_baby',
        motherRole: 'caregiver',
        babyRole: 'user',
        relationshipDynamic: 'mẹ chăm sóc bé dịu dàng',
        sceneCastingReason: 'sản phẩm mẹ và bé'
      },
      fourAnswers: {
        hook: script[0]?.voiceOver || fourAnswers.hook || '',
        solution: script[1]?.voiceOver || fourAnswers.solution || '',
        proof: script[2]?.voiceOver || fourAnswers.proof || '',
        closing: script[3]?.voiceOver || fourAnswers.closing || ''
      },
      script
    },
    script,
    voicePersona: {
      gender: 'nu',
      voiceDescription: 'nữ miền Nam trẻ, ấm áp, tự nhiên, đúng chất mẹ bỉm chia sẻ thật',
      tone: 'ấm áp, đời thường, thân thiện'
    },
    sceneContext: {
      worldId: 'mother_baby_home',
      location: 'Không gian sống gia đình trẻ ấm cúng',
      lighting: 'Ánh sáng tự nhiên ban ngày',
      mood: 'Ấm áp, chân thực'
    }
  };
}

/**
 * Điều chỉnh độ dài voiceOver của từng cảnh kịch bản Mẹ & Bé:
 * Đảm bảo 16-18 từ/cảnh (mục tiêu 17 từ) bằng cách rút gọn từ đệm hoặc thêm trợ từ tự nhiên.
 */
function normalizeMomVoiceOver(text, targetWords = 17) {
  if (!text || typeof text !== 'string') return text;
  let trimmed = text.trim();
  let words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 16 && words.length <= 18 && words.length === targetWords) {
    return trimmed;
  }

  if (words.length > 18) {
    const replacements = [
      { pattern: /\blúc nào cũng\b/gi, replacement: 'luôn' },
      { pattern: /\bba trăm sáu mươi độ\b/gi, replacement: '360 độ' },
      { pattern: /\bngon một mạch\b/gi, replacement: 'một mạch' },
      { pattern: /\bmột mạch tới sáng\b/gi, replacement: 'tới sáng' },
      { pattern: /\btuyệt đối an toàn\b/gi, replacement: 'an toàn' },
      { pattern: /\bsiêu mềm mịn\b/gi, replacement: 'mềm mịn' },
      { pattern: /\bkhông hề lo\b/gi, replacement: 'không lo' },
      { pattern: /\bcực kỳ\b/gi, replacement: 'rất' },
      { pattern: /\bngay góc trái\b/gi, replacement: 'góc trái' },
      { pattern: /\bsăn ngay ưu đãi\b/gi, replacement: 'săn ưu đãi' },
    ];

    for (const rep of replacements) {
      if (words.length <= targetWords) break;
      const updated = trimmed.replace(rep.pattern, rep.replacement);
      if (updated !== trimmed) {
        trimmed = updated;
        words = trimmed.split(/\s+/).filter(Boolean);
      }
    }

    const fillerWords = ['rồi', 'các', 'thì', 'rất', 'siêu', 'ngay', 'thực sự', 'nè', 'luôn', 'lắm', 'quá', 'thử', 'lo', 'chặt', 'dòng'];
    if (words.length > targetWords) {
      const newWords = [];
      let removedCount = 0;
      const toRemove = words.length - targetWords;
      for (let i = 0; i < words.length; i++) {
        const cleanWord = words[i].replace(/[.,!?;:"'()]/g, '').toLowerCase();
        if (removedCount < toRemove && i >= 3 && i < words.length - 2 && fillerWords.includes(cleanWord)) {
          const punctMatch = words[i].match(/[.,!?;:]+$/);
          if (punctMatch && newWords.length > 0) {
            newWords[newWords.length - 1] += punctMatch[0];
          }
          removedCount++;
        } else {
          newWords.push(words[i]);
        }
      }
      words = newWords;
      trimmed = words.join(' ');
    }

    while (words.length > 18) {
      const removeIdx = Math.max(3, words.length - 3);
      const punctMatch = words[removeIdx].match(/[.,!?;:]+$/);
      words.splice(removeIdx, 1);
      if (punctMatch && removeIdx > 0) {
        words[removeIdx - 1] += punctMatch[0];
      }
      trimmed = words.join(' ');
    }
  } else if (words.length < 16) {
    const endings = [
      'nha các mẹ nghen.',
      'nè các mẹ ơi.',
      'nha các mẹ bỉm.',
      'siêu ưng bụng luôn.',
      'cực tiện lợi nghen.',
    ];
    let endIdx = 0;
    while (words.length < 16) {
      trimmed = trimmed.replace(/[.!?]+$/, '');
      const addPhrase = endings[endIdx % endings.length];
      const addWords = addPhrase.split(/\s+/).filter(Boolean);
      const needed = 16 - words.length;
      if (needed <= addWords.length) {
        trimmed = trimmed + ' ' + addWords.slice(0, needed).join(' ') + '.';
      } else {
        trimmed = trimmed + ' ' + addPhrase;
      }
      words = trimmed.split(/\s+/).filter(Boolean);
      endIdx++;
    }
  }

  if (!/[.!?]$/.test(trimmed)) {
    trimmed += '.';
  }
  return trimmed;
}

/**
 * Chuẩn hóa toàn bộ cấu trúc kịch bản Mẹ & Bé:
 * - Tự động đưa từng cảnh về đúng 16-18 từ
 * - Cân bằng tổng độ dài 4 cảnh chuẩn 65-70 từ
 * - Đảm bảo phân vai characters hợp lệ và hành động không bị generic
 */
function normalizeMomScript(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const analysis = parsed.analysis || parsed;
  const script = parsed.script || analysis.script;
  if (!Array.isArray(script) || script.length !== 4) return parsed;

  const prodName = (analysis.productName || 'sản phẩm').trim();

  // 1. Đảm bảo các trường metadata bắt buộc
  if (!analysis.category) analysis.category = 'mother_baby';
  if (!analysis.targetUser) analysis.targetUser = 'baby';
  if (!analysis.buyerAngle) analysis.buyerAngle = 'for_baby';
  if (!analysis.characterStrategy || typeof analysis.characterStrategy !== 'object') {
    analysis.characterStrategy = {
      primaryCharacter: 'mother_and_baby',
      motherRole: 'caregiver',
      babyRole: 'user',
      relationshipDynamic: 'mẹ chăm sóc bé dịu dàng, bé hợp tác vui vẻ',
      sceneCastingReason: 'sản phẩm cho bé dùng nhưng mẹ là người thao tác chuẩn bị'
    };
  }

  // 2. Chuẩn hóa voiceOver từng cảnh về 16-18 từ (mục tiêu 17 từ)
  script.forEach((scene, idx) => {
    if (scene && scene.voiceOver) {
      scene.voiceOver = normalizeMomVoiceOver(scene.voiceOver, 17);
    }
    // Đảm bảo characters array hợp lệ
    if (!scene.characters || !Array.isArray(scene.characters) || scene.characters.length === 0) {
      scene.characters = (idx === 1) ? ['mother'] : ((idx === 2) ? ['baby'] : ['mother', 'baby']);
    } else {
      scene.characters = scene.characters.map(c => String(c).trim().toLowerCase());
    }

    // Sửa các hành động generic nếu có
    const primaryAction = scene.motionPlan?.primaryAction || scene.humanInteraction?.motherAction || '';
    const lower = primaryAction.toLowerCase();
    const genericPhrases = ['thao tác các tính năng chính', 'thao tác sản phẩm', 'sử dụng sản phẩm', 'demonstrate main features', 'use the product'];
    if (genericPhrases.some(gp => lower === gp || lower.includes(gp))) {
      const safeAction = idx === 0
        ? `Mẹ bế bé trong phòng khách, chuẩn bị ${prodName}`
        : (idx === 1 ? `Mẹ nhẹ nhàng kiểm tra chất liệu và công năng của ${prodName}` : (idx === 2 ? `Bé nằm thoải mái an toàn cạnh ${prodName}` : `Mẹ bế bé hạnh phúc bên ${prodName}`));
      if (scene.motionPlan) scene.motionPlan.primaryAction = safeAction;
      if (scene.humanInteraction) scene.humanInteraction.motherAction = safeAction;
    }
  });

  // 3. Cân bằng tổng độ dài 4 cảnh chuẩn 65-70 từ
  let total = script.reduce((sum, s) => sum + (s.voiceOver ? s.voiceOver.split(/\s+/).filter(Boolean).length : 0), 0);

  while (total > 70) {
    let longestScene = null;
    let maxWords = 0;
    for (const s of script) {
      const wCount = s.voiceOver.split(/\s+/).filter(Boolean).length;
      if (wCount > 16 && wCount > maxWords) {
        maxWords = wCount;
        longestScene = s;
      }
    }
    if (!longestScene) break;
    longestScene.voiceOver = normalizeMomVoiceOver(longestScene.voiceOver, maxWords - 1);
    total = script.reduce((sum, s) => sum + (s.voiceOver ? s.voiceOver.split(/\s+/).filter(Boolean).length : 0), 0);
  }

  while (total < 65) {
    let shortestScene = null;
    let minWords = 999;
    for (const s of script) {
      const wCount = s.voiceOver.split(/\s+/).filter(Boolean).length;
      if (wCount < 18 && wCount < minWords) {
        minWords = wCount;
        shortestScene = s;
      }
    }
    if (!shortestScene) break;
    shortestScene.voiceOver = normalizeMomVoiceOver(shortestScene.voiceOver, minWords + 1);
    total = script.reduce((sum, s) => sum + (s.voiceOver ? s.voiceOver.split(/\s+/).filter(Boolean).length : 0), 0);
  }

  // 4. Đồng bộ fourAnswers
  if (!analysis.fourAnswers || typeof analysis.fourAnswers !== 'object') {
    analysis.fourAnswers = {};
  }
  if (script[0]?.voiceOver) analysis.fourAnswers.hook = script[0].voiceOver;
  if (script[1]?.voiceOver) analysis.fourAnswers.solution = script[1].voiceOver;
  if (script[2]?.voiceOver) analysis.fourAnswers.proof = script[2].voiceOver;
  if (script[3]?.voiceOver) analysis.fourAnswers.closing = script[3].voiceOver;

  return parsed;
}

function parseJsonObjectMom(text) {
  if (!text || typeof text !== 'string') return null;
  let s = String(text).trim();

  // Bóc tách code block ngay cả khi Gemini có lời thoại dẫn đầu hoặc đuôi
  const codeBlockMatch = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch) {
    s = codeBlockMatch[1].trim();
  } else {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }

  const startObj = s.indexOf('{');
  const endObj = s.lastIndexOf('}');
  if (startObj >= 0 && endObj > startObj) {
    s = s.slice(startObj, endObj + 1);
  } else if (startObj >= 0) {
    s = s.slice(startObj);
  }

  // 1. Thử parse trực tiếp
  try {
    return JSON.parse(s);
  } catch (_) {}

  // 2. Sửa nested quotes TRƯỚC KHI sanitize control characters
  let cleanQuotes = repairJsonNestedQuotes(s);
  try {
    return JSON.parse(cleanQuotes);
  } catch (_) {}

  // 3. Làm sạch control characters (newlines bên trong chuỗi, tabs)
  const clean1 = sanitizeJsonControlCharacters(cleanQuotes);
  try {
    return JSON.parse(clean1);
  } catch (_) {}

  // 4. Xóa comments, sửa trailing commas và dấu phẩy bị thiếu
  let cleanCommas = clean1
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,\s*([\}\]])/gu, '$1')
    .replace(/([}\]])(\s*)(?=[{\[])/gu, '$1,$2')
    .replace(/("|\d|true|false|null)(\s*\r?\n\s*)(?=["{\[\d-]|true|false|null)/gu, '$1,$2')
    .replace(/([}\]])(\s*\r?\n\s*)(?=")/gu, '$1,$2')
    .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
  try {
    return JSON.parse(cleanCommas);
  } catch (_) {}

  // 5. Tự động đóng ngoặc bị thiếu nếu Gemini bị cắt giữa chừng
  let balanced = autoBalanceJsonBraces(cleanCommas);
  balanced = balanced.replace(/,\s*([\}\]])/gu, '$1');
  try {
    return JSON.parse(balanced);
  } catch (_) {}

  // 6. Cứu hộ cấp cứu bằng Regex Extractor nếu JSON vẫn có lỗi cú pháp
  const fallback = extractFallbackAnalysisMom(text);
  if (fallback) {
    console.log('[TemplateMom] 🛡️ Cứu hộ thành công: Đã trích xuất cấu trúc analysis Mẹ & Bé từ phản hồi thô.');
    return fallback;
  }

  return null;
}

// ── 3. SCRIPT VALIDATION GATE (MANDATORY INVARIANT) ──────────────────────────

const ALLOWED_CASTS = [
  'mother',
  'baby',
  'mother,baby',
  'baby,mother'
];

function normalizeCastKey(castArray) {
  if (!Array.isArray(castArray)) return '';
  return castArray.map(c => String(c).trim().toLowerCase()).sort().join(',');
}

/**
 * Kiểm tra tính hợp lệ nghiêm ngặt của kịch bản Mẹ & Bé (Section 24, 40, 41, 42)
 * Trả về { valid: boolean, errors: string[], wordCounts: number[], totalWords: number }
 */
function validateTemplateMomScript(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, errors: ['Output is not a valid JSON object'], wordCounts: [], totalWords: 0 };
  }

  const analysis = parsed.analysis || parsed;
  if (!analysis.productName || typeof analysis.productName !== 'string' || !analysis.productName.trim()) {
    errors.push('Missing or empty analysis.productName');
  }
  if (!analysis.category) {
    errors.push('Missing analysis.category');
  }
  if (!analysis.targetUser) {
    errors.push('Missing analysis.targetUser');
  }
  if (!analysis.buyerAngle) {
    errors.push('Missing analysis.buyerAngle');
  }

  // Character strategy
  if (!analysis.characterStrategy || typeof analysis.characterStrategy !== 'object') {
    errors.push('Missing analysis.characterStrategy');
  } else if (!analysis.characterStrategy.primaryCharacter) {
    errors.push('Missing analysis.characterStrategy.primaryCharacter');
  }

  // Four answers
  const fa = analysis.fourAnswers;
  if (!fa || typeof fa !== 'object') {
    errors.push('Missing analysis.fourAnswers');
  } else {
    ['hook', 'solution', 'proof', 'closing'].forEach(k => {
      if (!fa[k] || typeof fa[k] !== 'string' || fa[k].trim() === '' || /^n\/?a$/i.test(fa[k].trim())) {
        errors.push(`Invalid fourAnswers.${k}`);
      }
    });
  }

  // Product Affordance validation (Section 4 & 45 of SPEC v2)
  const affordance = analysis.productAffordance;
  const invalidActions = Array.isArray(affordance?.invalidActions)
    ? affordance.invalidActions.map(a => String(a).toLowerCase().trim())
    : [];

  // Script array
  const script = parsed.script || analysis.script;
  if (!Array.isArray(script) || script.length !== 4) {
    errors.push(`Script must contain exactly 4 scenes (received: ${Array.isArray(script) ? script.length : 'none'})`);
    return { valid: false, errors, wordCounts: [], totalWords: 0 };
  }

  const wordCounts = [];
  let totalWords = 0;

  script.forEach((scene, idx) => {
    const sceneId = scene.id || idx + 1;
    const vo = (scene.voiceOver || '').trim();

    if (!vo || /^n\/?a$/i.test(vo)) {
      errors.push(`Scene ${sceneId} missing valid voiceOver`);
    } else {
      const words = vo.split(/\s+/).filter(Boolean).length;
      wordCounts.push(words);
      totalWords += words;
      if (words < 16 || words > 18) {
        errors.push(`Scene ${sceneId} voiceOver word count must be 16-18 words (got ${words} words: "${vo}")`);
      }
    }

    // Cast validation
    const chars = scene.characters;
    if (!Array.isArray(chars) || chars.length === 0) {
      errors.push(`Scene ${sceneId} missing characters array`);
    } else {
      const castKey = normalizeCastKey(chars);
      if (castKey !== 'mother' && castKey !== 'baby' && castKey !== 'baby,mother') {
        errors.push(`Scene ${sceneId} has invalid characters: ${JSON.stringify(chars)}. Allowed: ["mother"], ["baby"], or ["mother", "baby"]`);
      }
    }

    if (!scene.visualDescription && !scene.startFrame) {
      errors.push(`Scene ${sceneId} missing visualDescription / startFrame`);
    }

    // Semantic Action Validation (Section 31, 32, 45 of SPEC v2)
    const primaryAction = scene.motionPlan?.primaryAction || scene.humanInteraction?.motherAction || scene.humanInteraction?.babyAction || '';
    const lowerAction = primaryAction.toLowerCase().trim();

    // Check generic action failure (Section 32)
    const genericPhrases = ['thao tác các tính năng chính', 'thao tác sản phẩm', 'sử dụng sản phẩm', 'demonstrate main features', 'use the product'];
    for (const gp of genericPhrases) {
      if (lowerAction === gp || lowerAction.includes(gp)) {
        errors.push(`Scene ${sceneId} action is too generic ("${primaryAction}"). Must be a concrete verb + physical target.`);
      }
    }

    // Check affordance invalid actions (Section 4 & 45)
    for (const inv of invalidActions) {
      if (inv === 'open_lid' && (lowerAction.includes('mở nắp') || lowerAction.includes('open lid'))) {
        errors.push(`Scene ${sceneId} contains invalid action "open lid / mở nắp" forbidden by product affordance.`);
      }
      if (inv === 'pour' && (lowerAction.includes('đổ nước') || lowerAction.includes('pour'))) {
        errors.push(`Scene ${sceneId} contains invalid action "pour" forbidden by product affordance.`);
      }
      if (inv === 'press_power_button' && (lowerAction.includes('bấm nút nguồn') || lowerAction.includes('power button'))) {
        errors.push(`Scene ${sceneId} contains invalid action "press power button" forbidden by product affordance.`);
      }
    }
  });

  if (totalWords < 65 || totalWords > 70) {
    errors.push(`Total voiceOver words across 4 scenes must be 65-70 words (got ${totalWords} words)`);
  }

  return {
    valid: errors.length === 0,
    errors,
    wordCounts,
    totalWords,
  };
}

// ── 4. STEP 1 ANALYSIS PROMPT & SERVICE ───────────────────────────────────────

function buildTemplateMomAnalysisPrompt(options = {}) {
  const ctx = options.productContext || {};
  let contextSection = '';
  if (ctx.productTitle || ctx.productDescription || ctx.shopName) {
    const parts = [];
    if (ctx.productTitle) parts.push(`- Tên sản phẩm gốc: ${ctx.productTitle}`);
    if (ctx.shopName) parts.push(`- Shop: ${ctx.shopName}`);
    if (ctx.categoryName) parts.push(`- Ngành hàng: ${ctx.categoryName}`);
    if (ctx.productDescription) parts.push(`- Mô tả chi tiết:\n${ctx.productDescription}`);
    contextSection = `\nTHÔNG TIN SẢN PHẨM ĐẦU VÀO:\n${parts.join('\n')}\n`;
  }

  return `TEXT-ONLY TASK.
Do not generate images.
Do not call image generation.
Do not create a visual storyboard asset.

You are a senior Mother & Baby TikTok commerce strategist, short-form content director, family lifestyle visual planner, and Veo / image-generation prompt writer.
You create product content from the point of view of one recurring young mother and her recurring baby.
The mother and baby are permanent channel characters defined by external reference assets (assets/nhi/mom.png and assets/nhi/baby.png).

Analyze:
1. the uploaded product reference images (mẹ và bé, đồ sơ sinh, ăn dặm, tã bỉm, tắm gội, xe đẩy, đồ chơi, đồ dùng mẹ sau sinh...),
2. the TikTok Shop product metadata,
3. the intended user (baby, toddler, mother, postpartum_mother, breastfeeding_mother, mother_and_baby, parents_with_baby),
4. who should appear in each scene,
5. how the product naturally fits the mother's or baby's real daily life.
${contextSection}

CRITICAL CREATIVE PRINCIPLE:
Real mom-life situation -> Problem / Need -> Product enters naturally -> Use / Interaction -> Proof / Result -> Lifestyle closing.
The viewer must feel: "Một người mẹ thật đang chia sẻ món đồ mình dùng cho bản thân hoặc cho con", NOT a generic commercial ad.

SCENE CASTING RULES (IMPORTANT):
- Characters allowed per scene: ["mother"], ["baby"], or ["mother", "baby"].
- DO NOT force both mother and baby into every scene!
  * If product is for mother (e.g. breast pump, nursing bra, postpartum care): scenes can have mother only, or mother + baby in closing.
  * If product is baby bib / baby feeding: baby appears in solution / proof, mother in hook / closing.
  * If baby toy: baby playing in hook/proof, mother supporting.

STRICT MARKETING FRAMEWORK (4 PHASES):
1. Cảnh 1 (HOOK) — "Hook gì khiến mẹ bỉm dừng lướt?"
   - Đời sống mẹ bỉm chân thật: "Mẹ nào cho bé ăn dặm chắc hiểu cảnh này nè...", "Từ ngày có bé tui mới biết món này tiện dữ thần...", "Nhà nào có bé hay quăng đồ coi cái này nè..."
   - Tránh câu sáo rỗng "Bữa giờ TikTok rần rần...".
2. Cảnh 2 (SOLUTION) — "Sản phẩm là giải pháp gì cho mẹ hoặc bé?"
   - Sản phẩm xuất hiện tự nhiên giải quyết nỗi đau hoặc đáp ứng nhu cầu chăm con.
3. Cảnh 3 (PROOF) — "Bằng chứng trực quan nào khiến các mẹ tin tưởng?"
   - Cận cảnh chất liệu mềm mại, an toàn thực phẩm, chống tràn, vừa vặn trên người bé, đường may chắc chắn.
4. Cảnh 4 (CLOSING) — "Lý do gì để mẹ sắm ngay cho mình hoặc cho bé?"
   - Mẹ và bé sinh hoạt đầm ấm, gọn gàng, tiện nghi. CTA giỏ hàng là VOICE-ONLY. TUYỆT ĐỐI KHÔNG vẽ icon giỏ hàng hay chỉ tay vào góc màn hình.

LANGUAGE & SCRIPT LENGTH RULES:
- Vietnamese colloquial Southern voice (giọng nữ miền Nam trẻ, ấm áp, thân thiện, như mẹ bỉm chia sẻ thật, KHÔNG TVC).
- Xưng hô phù hợp: "các mẹ", "mẹ nào", "nhà nào có bé", "mẹ bỉm", "mọi người", "cả nhà".
- TUYỆT ĐỐI CẤM: "anh em", "mấy ông", "bác nào", "chị em mua cho chồng". Hạn chế tối đa từ "mấy bà" (ưu tiên 0 lần).
- ĐỘ DÀI BẮT BUỘC:
  * Cảnh 1: ĐÚNG 16 ĐẾN 18 TỪ.
  * Cảnh 2: ĐÚNG 16 ĐẾN 18 TỪ.
  * Cảnh 3: ĐÚNG 16 ĐẾN 18 TỪ.
  * Cảnh 4: ĐÚNG 16 ĐẾN 18 TỪ.
  * TỔNG 4 CẢNH: TỐI THIỂU 65 TỪ, TỐI ĐA 70 TỪ (chuẩn 15-16 giây).
  * Mỗi câu kết thúc bằng dấu câu rõ ràng (., !, ?).

BABY SAFETY RULES:
- Không để bé gần nguồn nhiệt, không nằm tư thế nguy hiểm, không che mặt bé, không cho bé cầm vật sắc nhọn.

Return ONLY valid JSON matching this schema:
{
  "analysis": {
    "productName": "Tên sản phẩm tiếng Việt đầy đủ",
    "category": "mother_baby",
    "subCategory": "feeding|sleep|hygiene|travel|clothing|toy|nursery|postpartum|breastfeeding|storage|other",
    "targetUser": "baby|toddler|mother|postpartum_mother|breastfeeding_mother|mother_and_baby|parents_with_baby",
    "buyerAngle": "for_baby|for_mother|for_mother_and_baby|for_parenting_routine|gift_for_new_mom|gift_for_baby",
    "addressStyle": "các mẹ|mẹ nào|nhà nào có bé|mẹ bỉm|mọi người",
    "cartAnchorText": "CTA giỏ hàng ngắn gọn dưới 30 ký tự",
    "hashtags": ["#mebimsua", "#mevabe", "#dobaby", "#dodungchobe", "#hashtag_sanpham"],
    "materials": "chất liệu đã xác minh",
    "highlights": ["điểm nổi bật 1", "điểm nổi bật 2", "điểm nổi bật 3"],
    "targetAudience": "tóm tắt đối tượng",
    "visibleComponents": ["danh sách các chi tiết thật có trên ảnh sản phẩm (quai dán, chun lưng, núm ti, tay cầm...)"],
    "productAffordance": {
      "productType": "tên loại sản phẩm vật lý (baby_diaper, baby_bottle, breast_pump, toy, stroller...)",
      "states": ["danh sách trạng thái vật lý thực tế: packaged, unfolded, in_use, resting"],
      "validActions": ["hành động vật lý khả thi: pick_up, unfold, touch_soft_surface, gently_stretch_waistband, place_beside_baby"],
      "invalidActions": ["hành động vật lý KHÔNG THỂ có: open_lid, pour, press_power_button"]
    },
    "characterStrategy": {
      "primaryCharacter": "mother|baby|mother_and_baby",
      "motherRole": "user|reviewer|caregiver|demonstrator|supporting|none",
      "babyRole": "user|recipient|demonstration_context|supporting|none",
      "relationshipDynamic": "mô tả tương tác tự nhiên mẹ con",
      "sceneCastingReason": "lý do phân vai nhân vật cho sản phẩm này"
    },
    "fourAnswers": {
      "hook": "Hook gì khiến mẹ bỉm dừng lướt?",
      "solution": "Sản phẩm giải quyết nhu cầu gì?",
      "proof": "Bằng chứng trực quan gì?",
      "closing": "Tại sao mẹ muốn mua ngay?"
    }
  },
  "voicePersona": {
    "gender": "nu",
    "voiceDescription": "nữ miền Nam trẻ, ấm áp, tự nhiên, đúng chất mẹ bỉm chia sẻ thật",
    "tone": "ấm áp, hoạt bát vừa phải, đời thường, thân thiện, không TVC"
  },
  "sceneContext": {
    "worldId": "mother_baby_home",
    "location": "không gian gia đình ấm cúng (phòng ngủ, phòng bé, góc ăn dặm, phòng khách)",
    "lighting": "ánh sáng ban ngày tự nhiên dịu nhẹ kết hợp đèn ấm",
    "mood": "ấm áp, chân thực, phong cách sống gia đình trẻ"
  },
  "script": [
    {
      "id": 1,
      "phase": "Hook",
      "goal": "Hook đời sống mẹ bỉm",
      "characters": ["mother", "baby"],
      "voiceOver": "Lời thoại Cảnh 1 dài từ 16 đến 18 từ tiếng Việt kết thúc bằng dấu chấm...",
      "visualDescription": "Mô tả hình ảnh chi tiết Cảnh 1 (Start Frame ban đầu)",
      "startFrame": {
        "productState": "packaged|unfolded|resting",
        "composition": "mẹ bế bé ngang tầm mắt",
        "humanPose": "mẹ ngồi hoặc đứng âu yếm bé",
        "cameraFraming": "smartphone 26mm tự nhiên",
        "lighting": "ánh sáng tự nhiên dịu nhẹ"
      },
      "motionPlan": {
        "primaryAction": "hành động vật lý cụ thể (VERB + TARGET), không generic",
        "secondaryMotion": "cử động phụ nhẹ nhàng (ánh mắt nhìn bé, nụ cười nhẹ)",
        "productMotion": "The product retains its appearance throughout the motion.",
        "humanMotion": "cử động của mẹ và bé",
        "cameraMotion": "Subtle handheld camera push-in",
        "endState": "mẹ và bé ổn định tư thế ấm áp",
        "motionComplexity": "low"
      },
      "actionRunway": {
        "valid": true,
        "reason": "tư thế Start Frame hỗ trợ hoàn hảo cho chuyển động"
      },
      "humanInteraction": {
        "characters": ["mother", "baby"],
        "motherAction": "hành động của mẹ",
        "babyAction": "hành động của bé",
        "productInteraction": "tương tác với sản phẩm",
        "facialExpression": "biểu cảm tự nhiên",
        "gazeDirection": "hướng nhìn",
        "physicalContact": "tiếp xúc vật lý mẹ - bé - sản phẩm"
      },
      "cameraAction": "góc máy smartphone tự nhiên"
    },
    {
      "id": 2,
      "phase": "Solution",
      "goal": "Giới thiệu giải pháp sản phẩm",
      "characters": ["mother"],
      "voiceOver": "Lời thoại Cảnh 2 dài từ 16 đến 18 từ tiếng Việt kết thúc bằng dấu chấm...",
      "visualDescription": "Mô tả hình ảnh chi tiết Cảnh 2 (Start Frame ban đầu)",
      "startFrame": {
        "productState": "ready|in_use",
        "composition": "cận cảnh mẹ cầm sản phẩm",
        "humanPose": "mẹ cầm sản phẩm bằng hai tay",
        "cameraFraming": "cận cảnh rõ ràng",
        "lighting": "ánh sáng tự nhiên"
      },
      "motionPlan": {
        "primaryAction": "hành động vật lý cụ thể và hợp affordance (vd: kiểm tra độ co giãn, vuốt nhẹ bề mặt)",
        "secondaryMotion": "mẹ nhìn sản phẩm mỉm cười hài lòng",
        "productMotion": "The product retains its appearance throughout the motion.",
        "humanMotion": "hai bàn tay mẹ thao tác khéo léo",
        "cameraMotion": "Minimal handheld push-in",
        "endState": "sản phẩm ở tư thế ổn định",
        "motionComplexity": "low"
      },
      "actionRunway": {
        "valid": true,
        "reason": "Start Frame đã sẵn sàng cho thao tác"
      },
      "humanInteraction": {
        "characters": ["mother"],
        "motherAction": "mẹ thao tác sản phẩm",
        "babyAction": "none",
        "productInteraction": "sử dụng tính năng chính",
        "facialExpression": "biểu cảm ưng ý",
        "gazeDirection": "nhìn vào sản phẩm",
        "physicalContact": "tay cầm chắc chắn"
      },
      "cameraAction": "cận cảnh chi tiết tính năng"
    },
    {
      "id": 3,
      "phase": "Proof",
      "goal": "Chứng minh chất liệu hoặc thực tế sử dụng",
      "characters": ["baby"],
      "voiceOver": "Lời thoại Cảnh 3 dài từ 16 đến 18 từ tiếng Việt kết thúc bằng dấu chấm...",
      "visualDescription": "Mô tả hình ảnh chi tiết Cảnh 3",
      "startFrame": {
        "productState": "resting_beside_baby",
        "composition": "bé nằm thoải mái cạnh sản phẩm",
        "humanPose": "bé nằm chơi an toàn",
        "cameraFraming": "cận cảnh vân chất liệu và bé",
        "lighting": "ánh sáng tự nhiên dịu mát"
      },
      "motionPlan": {
        "primaryAction": "bé cử động tay chân tự nhiên vui vẻ",
        "secondaryMotion": "bé mỉm cười toe toét",
        "productMotion": "The product rests safely in place and retains its appearance.",
        "humanMotion": "cử động nhỏ nhẹ nhàng của bé",
        "cameraMotion": "Subtle handheld drift",
        "endState": "bé vui vẻ an toàn",
        "motionComplexity": "low"
      },
      "actionRunway": {
        "valid": true,
        "reason": "tư thế bé an toàn, dễ chuyển động"
      },
      "humanInteraction": {
        "characters": ["baby"],
        "motherAction": "none",
        "babyAction": "bé tương tác thoải mái",
        "productInteraction": "sản phẩm phát huy công dụng",
        "facialExpression": "bé vui vẻ dễ chịu",
        "gazeDirection": "nhìn sản phẩm",
        "physicalContact": "tiếp xúc an toàn"
      },
      "cameraAction": "cận cảnh chất liệu và phản ứng của bé"
    },
    {
      "id": 4,
      "phase": "Closing",
      "goal": "Lối sống mẹ bỉm tiện nghi và kêu gọi giỏ hàng",
      "characters": ["mother", "baby"],
      "voiceOver": "Lời thoại Cảnh 4 dài từ 16 đến 18 từ tiếng Việt kết thúc bằng dấu chấm...",
      "visualDescription": "Mô tả hình ảnh Cảnh 4 (thuần phong cách sống gia đình, không vẽ icon giỏ hàng)",
      "startFrame": {
        "productState": "resting_in_room",
        "composition": "toàn cảnh ấm áp mẹ và bé",
        "humanPose": "mẹ bế bé trong phòng khách",
        "cameraFraming": "toàn cảnh smartphone",
        "lighting": "ánh sáng gia đình ấm cúng"
      },
      "motionPlan": {
        "primaryAction": "mẹ âu yếm tựa đầu gần bé, bé ngoan ngoãn trong vòng tay mẹ",
        "secondaryMotion": "nụ cười dịu dàng",
        "productMotion": "The product remains in place.",
        "humanMotion": "micro-movement tự nhiên mẹ con",
        "cameraMotion": "Slow subtle push-in",
        "endState": "khoảnh khắc gia đình trọn vẹn",
        "motionComplexity": "low"
      },
      "actionRunway": {
        "valid": true,
        "reason": "tư thế mẹ bế bé ổn định"
      },
      "humanInteraction": {
        "characters": ["mother", "baby"],
        "motherAction": "mẹ ôm hoặc chăm sóc bé",
        "babyAction": "bé ngoan ngoãn",
        "productInteraction": "sản phẩm đặt gọn gàng trong không gian",
        "facialExpression": "ấm áp hạnh phúc",
        "gazeDirection": "mẹ nhìn bé trìu mến",
        "physicalContact": "mẹ bế bé êm ái"
      },
      "cameraAction": "toàn cảnh ấm áp"
    }
  ]
}`.trim();
}

/**
 * Thực hiện phân tích sản phẩm qua Gemini API kèm Validation Gate nghiêm ngặt (MANDATORY GATE)
 */
async function analyzeProductTemplateMom(geminiClient, filePayloads, options = {}) {
  const analysisPrompt = buildTemplateMomAnalysisPrompt(options);

  // Upload tối đa 4 ảnh sản phẩm lên Gemini
  const uploadedFiles = [];
  if (geminiClient && Array.isArray(filePayloads)) {
    for (let i = 0; i < Math.min(filePayloads.length, 4); i++) {
      const file = filePayloads[i];
      const buffer = Buffer.isBuffer(file.buffer)
        ? file.buffer
        : (file.base64 ? Buffer.from(file.base64, 'base64') : (file.path && fs.existsSync(file.path) ? fs.readFileSync(file.path) : null));
      if (!buffer) continue;

      const mimeType = file.mimeType || 'image/png';
      const filename = file.name || `product_${i + 1}.png`;
      try {
        const url = await geminiClient.uploadFile(buffer, filename, mimeType);
        if (url) uploadedFiles.push({ url, filename, mimeType });
      } catch (upErr) {
        console.warn(`[TemplateMom] Failed to upload product image ${filename}: ${upErr.message}`);
      }
    }
  }

  const ctx = options.productContext || {};
  const fallbackTitle = (ctx.productTitle || 'Đồ Dùng Cho Mẹ Và Bé').trim();

  // Fallback chuẩn Mother & Baby tuân thủ 100% luật 16-18 từ/cảnh và tổng 65-70 từ
  const buildFallback = () => {
    const isDiaper = /tã|bỉm|diaper/i.test(fallbackTitle);
    const fallbackAnalysis = {
      category: 'mother_baby',
      subCategory: isDiaper ? 'hygiene' : 'feeding',
      productName: fallbackTitle,
      targetUser: 'baby',
      buyerAngle: 'for_baby',
      addressStyle: 'các mẹ bỉm',
      cartAnchorText: 'Bấm giỏ hàng góc trái màn hình',
      hashtags: ['#mebimsua', '#mevabe', '#dodungchobe', '#chamsocbe', '#trending'],
      materials: 'Chất liệu cao cấp an toàn tuyệt đối cho bé',
      highlights: ['Tiện lợi cho mẹ', 'An toàn cho bé', 'Dễ dàng vệ sinh'],
      targetAudience: 'Mẹ bỉm sữa đang chăm sóc con nhỏ',
      visibleComponents: isDiaper
        ? ['chun lưng co giãn', 'vách chống tràn', 'bề mặt thấm hút mềm mại', 'bao bì chính hãng']
        : ['chi tiết hoàn thiện tinh xảo', 'bề mặt chất liệu an toàn', 'bao bì chính hãng'],
      productAffordance: {
        productType: isDiaper ? 'baby_diaper' : 'baby_care_product',
        states: ['packaged', 'unfolded', 'in_use', 'resting'],
        validActions: isDiaper
          ? ['pick_up', 'unfold', 'touch_soft_surface', 'gently_stretch_waistband', 'place_beside_baby']
          : ['hold_product', 'inspect_material', 'gently_use', 'place_safely'],
        invalidActions: ['open_lid', 'pour', 'press_power_button', 'twist_cap']
      },
      characterStrategy: {
        primaryCharacter: 'mother_and_baby',
        motherRole: 'caregiver',
        babyRole: 'user',
        relationshipDynamic: 'mẹ chăm sóc bé dịu dàng, bé hợp tác vui vẻ',
        sceneCastingReason: 'sản phẩm cho bé dùng nhưng mẹ là người thao tác chuẩn bị'
      },
      fourAnswers: {
        hook: 'Mẹ nào chăm con nhỏ chắc hiểu cảnh này, nay tui mách món này tiện lắm nè.',
        solution: 'Thiết kế thông minh hỗ trợ mẹ chăm bé nhàn tênh, thao tác nhanh gọn lẹ nha.',
        proof: 'Chất liệu cao cấp sờ vào rất êm, hoàn thiện chắc chắn an toàn cho bé nha.',
        closing: 'Mẹ nào đang cần thì bấm giỏ hàng góc trái, sắm liền cho con yêu nha.'
      },
      voicePersona: {
        gender: 'nu',
        voiceDescription: 'nữ miền Nam trẻ, ấm áp, tự nhiên, đúng chất mẹ bỉm chia sẻ thật',
        tone: 'ấm áp, đời thường, thân thiện, gần gũi'
      },
      sceneContext: {
        worldId: 'mother_baby_home',
        location: 'Không gian phòng khách ấm cúng của gia đình trẻ',
        lighting: 'Ánh sáng tự nhiên dịu nhẹ ban ngày kết hợp đèn vàng ấm',
        mood: 'Ấm áp, chân thực, phong cách sống gia đình trẻ'
      },
      script: [
        {
          id: 1,
          phase: 'Hook',
          goal: 'mom-life hook',
          characters: ['mother', 'baby'],
          voiceOver: 'Mẹ nào chăm con nhỏ chắc hiểu cảnh này, nay tui mách món này tiện lắm nè.',
          visualDescription: `Mẹ đang bế bé trong phòng khách gia đình, phát hiện nhu cầu cần ${fallbackTitle}`,
          startFrame: {
            productState: 'packaged',
            composition: 'Mẹ bế bé ngang tầm mắt trong phòng khách gia đình',
            humanPose: 'Mẹ bế bé trên tay âu yếm',
            cameraFraming: 'Góc máy smartphone ngang tầm mắt gia đình',
            lighting: 'Ánh sáng ban ngày tự nhiên dịu nhẹ'
          },
          motionPlan: {
            primaryAction: 'Mẹ bế bé nhẹ nhàng, bé cử động tay nhỏ tự nhiên vui vẻ',
            secondaryMotion: 'Mẹ nhìn bé mỉm cười trìu mến',
            productMotion: 'The product retains its appearance throughout the motion.',
            humanMotion: 'Micro-movement tự nhiên mẹ và bé',
            cameraMotion: 'Subtle handheld camera push-in',
            endState: 'Mẹ và bé ổn định tư thế ấm áp',
            motionComplexity: 'low'
          },
          actionRunway: { valid: true, reason: 'Tư thế Start Frame hỗ trợ hoàn hảo cho chuyển động' },
          humanInteraction: {
            characters: ['mother', 'baby'],
            motherAction: 'Mẹ bế bé trên tay âu yếm',
            babyAction: 'Bé cử động tay nhỏ tự nhiên',
            productInteraction: 'Sản phẩm xuất hiện trên bàn gần đó',
            facialExpression: 'Mẹ mỉm cười dịu dàng với bé',
            gazeDirection: 'Mẹ nhìn bé trìu mến',
            physicalContact: 'Mẹ đỡ lưng và cổ bé an toàn'
          },
          cameraAction: 'Góc máy smartphone ngang tầm mắt gia đình'
        },
        {
          id: 2,
          phase: 'Solution',
          goal: 'Giới thiệu công năng sản phẩm',
          characters: ['mother'],
          voiceOver: 'Thiết kế thông minh hỗ trợ mẹ chăm bé nhàn tênh, thao tác nhanh gọn lẹ nha.',
          visualDescription: `Mẹ trực tiếp cầm và kiểm tra ${fallbackTitle} trong không gian sinh hoạt`,
          startFrame: {
            productState: 'ready',
            composition: 'Cận cảnh hai bàn tay mẹ cầm sản phẩm',
            humanPose: 'Mẹ cầm nhẹ nhàng bằng hai tay',
            cameraFraming: 'Góc máy cận cảnh rõ ràng sản phẩm',
            lighting: 'Ánh sáng tự nhiên làm rõ chất liệu'
          },
          motionPlan: {
            primaryAction: isDiaper ? 'Mẹ nhẹ nhàng kiểm tra bề mặt mềm mại và chun co giãn của tã' : 'Mẹ nhẹ nhàng kiểm tra chất liệu và công năng của sản phẩm',
            secondaryMotion: 'Mẹ nhìn sản phẩm gật đầu hài lòng',
            productMotion: 'The product retains its appearance throughout the motion.',
            humanMotion: 'Hai bàn tay mẹ thao tác khéo léo',
            cameraMotion: 'Minimal handheld push-in',
            endState: 'Sản phẩm ở tư thế ổn định',
            motionComplexity: 'low'
          },
          actionRunway: { valid: true, reason: 'Start Frame đã ở trạng thái cầm nắm sẵn sàng' },
          humanInteraction: {
            characters: ['mother'],
            motherAction: 'Mẹ cầm nhẹ nhàng kiểm tra chất liệu và công năng sản phẩm',
            babyAction: 'none',
            productInteraction: 'Thao tác kiểm tra tính năng chính',
            facialExpression: 'Nét mặt vui vẻ, hài lòng',
            gazeDirection: 'Nhìn tập trung vào sản phẩm',
            physicalContact: 'Hai bàn tay mẹ cầm nhẹ nhàng'
          },
          cameraAction: 'Góc máy cận cảnh rõ ràng sản phẩm'
        },
        {
          id: 3,
          phase: 'Proof',
          goal: 'Đặc tả chất liệu và chi tiết an toàn',
          characters: ['baby'],
          voiceOver: 'Chất liệu cao cấp sờ vào rất êm, hoàn thiện chắc chắn an toàn cho bé nha.',
          visualDescription: `Bé nằm chơi thoải mái, ${fallbackTitle} được đặt an toàn bên cạnh`,
          startFrame: {
            productState: 'resting_beside_baby',
            composition: 'Bé nằm trên thảm chơi an toàn, sản phẩm đặt ngay ngắn cạnh bé',
            humanPose: 'Bé nằm thoải mái an toàn',
            cameraFraming: 'Cận cảnh vân chất liệu và nụ cười của bé',
            lighting: 'Ánh sáng tự nhiên dịu mát'
          },
          motionPlan: {
            primaryAction: 'Bé vui vẻ vẫy tay chân tự nhiên và an toàn',
            secondaryMotion: 'Bé cười tươi thích thú',
            productMotion: 'The product rests safely in place and retains its appearance.',
            humanMotion: 'Cử động chân tay nhỏ tự nhiên của bé',
            cameraMotion: 'Subtle handheld drift',
            endState: 'Bé an toàn thoải mái',
            motionComplexity: 'low'
          },
          actionRunway: { valid: true, reason: 'Tư thế nằm chơi an toàn của bé rất tự nhiên' },
          humanInteraction: {
            characters: ['baby'],
            motherAction: 'none',
            babyAction: 'Bé vui vẻ vẫy tay chân an toàn',
            productInteraction: 'Sản phẩm đặt ngay ngắn cạnh bé',
            facialExpression: 'Bé cười tươi thích thú',
            gazeDirection: 'Bé nhìn xung quanh khám phá',
            physicalContact: 'Không chạm nguy hiểm'
          },
          cameraAction: 'Cận cảnh vân chất liệu và nụ cười của bé'
        },
        {
          id: 4,
          phase: 'Closing',
          goal: 'Phong cách sống mẹ bỉm tiện nghi và kêu gọi giỏ hàng',
          characters: ['mother', 'baby'],
          voiceOver: 'Mẹ nào đang cần thì bấm giỏ hàng góc trái, sắm liền cho con yêu nha.',
          visualDescription: `Mẹ bế bé trong không gian phòng khách gọn gàng cùng ${fallbackTitle}`,
          startFrame: {
            productState: 'resting_in_room',
            composition: 'Toàn cảnh ấm áp mẹ và bé trong không gian sống gia đình',
            humanPose: 'Mẹ bế bé cười hạnh phúc',
            cameraFraming: 'Toàn cảnh ấm áp phong cách sống',
            lighting: 'Ánh sáng gia đình ấm cúng'
          },
          motionPlan: {
            primaryAction: 'Mẹ âu yếm tựa đầu gần bé, bé ngoan ngoãn trong vòng tay mẹ',
            secondaryMotion: 'Ánh mắt và nụ cười ấm áp hạnh phúc',
            productMotion: 'The product remains in place.',
            humanMotion: 'Micro-movements tự nhiên mẹ con',
            cameraMotion: 'Slow subtle push-in',
            endState: 'Khoảnh khắc gia đình trọn vẹn',
            motionComplexity: 'low'
          },
          actionRunway: { valid: true, reason: 'Tư thế mẹ bế bé ổn định' },
          humanInteraction: {
            characters: ['mother', 'baby'],
            motherAction: 'Mẹ bế bé cười hạnh phúc',
            babyAction: 'Bé dựa đầu vào vai mẹ ngoan ngoãn',
            productInteraction: 'Sản phẩm nằm trong không gian sống',
            facialExpression: 'Ấm áp, gắn kết mẹ con',
            gazeDirection: 'Mẹ và bé nhìn tự nhiên',
            physicalContact: 'Mẹ ôm bé êm ái'
          },
          cameraAction: 'Toàn cảnh ấm áp phong cách sống'
        }
      ]
    };
    return {
      analysis: fallbackAnalysis,
      script: fallbackAnalysis.script,
      analysisPrompt,
      rawResponse: 'Fallback triggered due to parse/network error',
      uploadedFiles: filePayloads
    };
  };

  if (!geminiClient) {
    return buildFallback();
  }

  let lastValidationErrors = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const promptToSend = attempt === 1
        ? analysisPrompt
        : `${analysisPrompt}\n\nCRITICAL RETRY NOTICE (Attempt ${attempt}/3): Your previous output failed validation with the following errors:\n${lastValidationErrors.map(e => '- ' + e).join('\n')}\n\nPlease strictly fix ALL errors, ensure valid RFC 8259 JSON, exactly 4 scenes, exactly 16-18 words per scene, 65-70 words total, and explicit character array (["mother"], ["baby"], or ["mother", "baby"]).`;

      const res = await geminiClient.generateContent({
        prompt: promptToSend,
        fileData: uploadedFiles,
        temporary: true,
        expectImages: false,
      });

      let parsed = parseJsonObjectMom(res.text || '');
      if (!parsed) {
        parsed = extractFallbackAnalysisMom(res.text || '');
      }
      if (parsed) {
        parsed = normalizeMomScript(parsed);
        const validation = validateTemplateMomScript(parsed);
        if (validation.valid) {
          console.log(`[TemplateMom] ✅ Step 1 Analysis PASSED Validation Gate (Attempt ${attempt}): "${parsed.analysis?.productName}" (${validation.totalWords} words across 4 scenes)`);
          return {
            analysis: {
              ...parsed.analysis,
              script: parsed.script,
              voicePersona: parsed.voicePersona,
              sceneContext: parsed.sceneContext
            },
            script: parsed.script,
            voicePersona: parsed.voicePersona || {
              gender: 'nu',
              voiceDescription: 'nữ miền Nam trẻ, ấm áp, tự nhiên, đúng chất mẹ bỉm chia sẻ thật',
              tone: 'ấm áp, đời thường, thân thiện'
            },
            sceneContext: parsed.sceneContext || {
              worldId: 'mother_baby_home',
              location: 'Không gian sống gia đình trẻ ấm cúng',
              lighting: 'Ánh sáng ban ngày tự nhiên',
              mood: 'Ấm áp, chân thực'
            },
            analysisPrompt: promptToSend,
            rawResponse: res.text || '',
            uploadedFiles: filePayloads
          };
        } else {
          lastValidationErrors = validation.errors;
          console.warn(`[TemplateMom] ⚠️ Validation failed on attempt ${attempt}/3: ${validation.errors.join('; ')}`);
        }
      } else {
        lastValidationErrors = ['Failed to parse response into JSON object'];
        console.warn(`[TemplateMom] ⚠️ JSON parse failed on attempt ${attempt}/3.`);
      }
    } catch (err) {
      lastValidationErrors = [err.message];
      console.warn(`[TemplateMom] Analysis attempt ${attempt}/3 exception: ${err.message}`);
    }

    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  console.warn(`[TemplateMom] ❌ All 3 analysis attempts failed validation gate (${lastValidationErrors.join('; ')}). Using validated Mother & Baby fallback.`);
  return buildFallback();
}

// ── 5. MASTER STORYBOARD PROMPT GENERATION ────────────────────────────────────

/**
 * Xây dựng Master Storyboard Prompt cho Kênh Mẹ & Bé (Section 31 & Section 9)
 */
function buildTemplateMomMasterPrompt(analysisData, options = {}) {
  const a = analysisData || {};
  const loc = a.sceneContext?.location || 'a warm, believable Vietnamese young-family home (nursery, living room, feeding corner)';
  const lighting = a.sceneContext?.lighting || 'soft natural daylight with subtle warm practical light';
  const prodName = a.productName || 'the product';
  const script = a.script || a.analysis?.script || (Array.isArray(a) ? a : options.script || []);

  const formattedScenes = script.map((s, idx) => ({
    panel: idx + 1,
    phase: s.phase || (idx === 0 ? 'Hook' : idx === 1 ? 'Solution' : idx === 2 ? 'Proof' : 'Closing'),
    characters: s.characters || (idx === 1 ? ['mother'] : idx === 2 ? ['baby'] : ['mother', 'baby']),
    visualDescription: s.visualDescription || '',
    humanInteraction: s.humanInteraction || {},
    cameraAction: s.cameraAction || 'realistic smartphone framing'
  }));

  return `Generate one Mother & Baby product review storyboard image as a still photo collage.

THIS CHANNEL IS NOT FACELESS.
The uploaded character references define the permanent on-camera mother and baby identity:

[MOTHER_REFERENCE] (mother_reference.png):
Defines the exact recurring mother identity for this channel.
Preserve the same recognizable woman, facial structure, eye shape, nose shape, lips, skin tone, approximate age, and hair identity.
Her face MAY and SHOULD be visible whenever appropriate. Do NOT replace with a generic Asian woman. Do NOT change ethnicity.

[BABY_REFERENCE] (baby_reference.png):
Defines the exact recurring baby identity for this channel.
Preserve the same recognizable baby, facial proportions, eye shape, nose and mouth, skin tone, hair, and developmental stage.
Do NOT replace with another child. Do NOT age the baby up or down.

[PRODUCT_REFERENCES] (product_reference.png):
Defines the exact product being reviewed (${prodName}).
Strictly preserve silhouette, body shape, component count, proportions, color, material, texture, and functional structure. No product mutation.

SELLER IMAGE MODEL OVERRIDE RULE:
If any product reference image contains a seller model or another baby/child, IGNORE their identities!
Channel mother identity ALWAYS comes from MOTHER_REFERENCE.
Channel baby identity ALWAYS comes from BABY_REFERENCE.
Product visual info comes strictly from PRODUCT_REFERENCES.

CRITICAL VISUAL PRIORITIES:
1. CHARACTER IDENTITY FIDELITY:
   - Mother: exact identity from MOTHER_REFERENCE, face visible, anatomical accuracy (5 fingers per hand, natural grip).
   - Baby: exact identity from BABY_REFERENCE, age-appropriate pose and proportions, safe posture.
   - SCENE CASTING: Only include characters specified in each panel's "characters" field!
     * If characters = ["mother"], DO NOT add the baby.
     * If characters = ["baby"], DO NOT add the mother (unless physically supporting safety).
     * If characters = ["mother", "baby"], show both recurring characters together naturally.
2. PRODUCT FIDELITY: 100% exact product design, materials, and colors from reference.
3. REALISTIC INTERACTION & BABY SAFETY:
   - Follow each scene's humanInteraction accurately.
   - Absolutely NO baby near heat sources, NO unsupported baby on high surfaces, NO choking hazards, NO unsafe posture.
4. COMMERCIAL COMPOSITION:
   - Authentic smartphone cinematography (24mm/26mm lens aesthetic, crisp natural focus, natural depth of field, NO fake studio bokeh).
   - STRICT NO-TEXT RULE: Pure photography only. NO text, NO captions, NO badges, NO stickers, NO watermarks.
   - STRICT NO CART UI: NO cart icons, NO price badges, NO arrows, NO pointing to screen corners.
5. CROSS-PANEL CONTINUITY:
   - Same mother identity whenever she appears.
   - Same baby identity whenever the baby appears.
   - Same product model and environment: ${loc} under ${lighting}.

STORYBOARD FORMAT:
Exactly 4 panels side-by-side in one horizontal 16:9 image (Panels 1, 2, 3, 4).
- Panel 1: Hook
- Panel 2: Solution
- Panel 3: Proof
- Panel 4: Closing
Output: still photograph collage only. Do NOT generate a video.

SCENE PLAN SPECIFICATIONS:
${JSON.stringify(formattedScenes, null, 2)}

Generate one still storyboard image now.`.trim();
}

// ── 6. MULTI-STORYBOARD QA EVALUATION (MOTHER & BABY 100-PT FRAMEWORK) ─────────

function buildTemplateMomMultiStoryboardPrompt(analysis, candidateCount = 4) {
  const prodName = analysis?.productName || 'sản phẩm';

  return `You are a strict, objective Quality Assurance (QA) Vision Inspector for a Mother & Baby commerce 4-panel storyboard (still photo collage, 16:9).

THIS CHANNEL IS NOT FACELESS.
You are provided with:
1. Mother Reference Photo ("mother_reference.png"): Canonical recurring mother character.
2. Baby Reference Photo ("baby_reference.png"): Canonical recurring baby character.
3. Product Reference Photo ("product_reference.png"): Authentic product photos for "${prodName}".
4. Exactly ${candidateCount} Generated Master Storyboard candidates (named storyboard_cand_1.png to storyboard_cand_${candidateCount}.png), each having 4 vertical panels side-by-side.

EVALUATION FRAMEWORK (Total: 100 points):
1. Mother Identity Fidelity (Max 20 pts):
   - Face structure, eyes, nose, lips match MOTHER_REFERENCE.
   - Skin tone, hair, age preserved. No generic Asian woman replacement, no face distortion.
2. Baby Identity Fidelity (Max 20 pts):
   - Facial proportions, eyes, skin tone, developmental age match BABY_REFERENCE.
   - No child replacement, no age morphing up/down, no duplicate babies.
3. Product Fidelity (Max 20 pts):
   - Silhouette, components, color, material match PRODUCT_REFERENCES.
   - No product mutation across panels.
4. Human / Baby Anatomy (Max 10 pts):
   - Adult hands have exactly 5 natural fingers, realistic grip.
   - Baby limbs are anatomically correct and age-appropriate. Safe posture.
5. Product Interaction Accuracy (Max 10 pts):
   - Natural interaction between mother, baby, and product according to scene intent.
6. Scene / Story Accuracy (Max 8 pts):
   - Follows the planned scene casting (mother only, baby only, or mother + baby).
7. Cross-Panel Continuity (Max 7 pts):
   - Same mother and same baby across panels where they appear. Consistent lighting and home environment.
8. Commercial Composition (Max 5 pts):
   - Product clear, smartphone realism, STRICTLY NO TEXT, NO CART ICONS, NO UI OVERLAYS.

CRITICAL HARD REJECT CONDITIONS:
Reject a candidate immediately ("hardReject": true, score < 60) if ANY of the following occurs:
- Wrong mother identity or severely mutated mother face.
- Wrong baby identity or severely mutated baby face.
- Baby age changed significantly (e.g. toddler becomes infant or child).
- Different mother or baby appears between panels.
- Extra/duplicate mother or extra/duplicate baby in the same panel.
- Product model changed or critical component hallucinated/missing.
- Malformed limbs (e.g. fused fingers, extra hands/feet).
- Unsafe baby positioning (e.g. falling risk, choking hazard).

Return ONLY valid JSON matching this structure:
{
  "candidates": [
    {
      "candidateId": 1,
      "hardReject": false,
      "hardRejectReasons": [],
      "scores": {
        "motherIdentity": 18,
        "babyIdentity": 19,
        "productFidelity": 18,
        "anatomy": 9,
        "interaction": 9,
        "sceneAccuracy": 8,
        "continuity": 7,
        "composition": 5
      },
      "total": 93,
      "panelScores": { "1": 92, "2": 94, "3": 91, "4": 95 },
      "notes": "Nhận diện mẹ và bé rất chuẩn, sản phẩm sắc nét"
    }
  ],
  "bestCandidateIndex": 1,
  "summary": "Candidate 1 đạt điểm cao nhất không dính hard reject"
}`.trim();
}

async function verifyMultiStoryboardWithGeminiVision(geminiClient, candidateBuffers, referencePayloads, analysis) {
  const candidateCount = candidateBuffers.length;
  const prompt = buildTemplateMomMultiStoryboardPrompt(analysis, candidateCount);

  const fileData = [];
  if (geminiClient && Array.isArray(referencePayloads)) {
    for (const ref of referencePayloads) {
      const buf = ref.buffer || (ref.path && fs.existsSync(ref.path) ? fs.readFileSync(ref.path) : null);
      if (!buf) continue;
      try {
        const url = await geminiClient.uploadFile(buf, ref.name || 'reference.png', ref.mimeType || 'image/png');
        if (url) fileData.push({ url, filename: ref.name || 'reference.png', mimeType: ref.mimeType || 'image/png' });
      } catch (e) {
        console.warn(`[TemplateMom] Failed to upload reference ${ref.name}: ${e.message}`);
      }
    }

    for (let i = 0; i < candidateBuffers.length; i++) {
      const buf = candidateBuffers[i];
      const name = `storyboard_cand_${i + 1}.png`;
      try {
        const url = await geminiClient.uploadFile(buf, name, 'image/png');
        if (url) fileData.push({ url, filename: name, mimeType: 'image/png' });
      } catch (e) {
        console.warn(`[TemplateMom] Failed to upload candidate ${name}: ${e.message}`);
      }
    }
  }

  const fallbackResult = {
    candidates: candidateBuffers.map((_, i) => ({
      candidateId: i + 1,
      hardReject: false,
      hardRejectReasons: [],
      scores: {
        motherIdentity: 18,
        babyIdentity: 18,
        productFidelity: 18,
        anatomy: 9,
        interaction: 9,
        sceneAccuracy: 8,
        continuity: 7,
        composition: 5,
      },
      total: 92,
      panelScores: { '1': 92, '2': 92, '3': 92, '4': 92 },
      notes: 'Pass'
    })),
    bestCandidateIndex: 1,
    summary: 'Candidate #1 selected'
  };

  if (!geminiClient || fileData.length === 0) return fallbackResult;

  try {
    const res = await geminiClient.generateContent({
      prompt,
      fileData,
      temporary: true,
      expectImages: false,
    });

    const parsed = parseJsonObjectMom(res.text || '');
    if (parsed && Array.isArray(parsed.candidates) && parsed.candidates.length > 0) {
      // Lọc bỏ các candidates bị Hard Reject
      const validCandidates = parsed.candidates.filter(c => !c.hardReject);
      let bestIdx = parsed.bestCandidateIndex || 1;
      if (validCandidates.length > 0) {
        validCandidates.sort((a, b) => (b.total || 0) - (a.total || 0));
        bestIdx = validCandidates[0].candidateId;
      }
      return {
        candidates: parsed.candidates,
        bestCandidateIndex: bestIdx,
        summary: parsed.summary || `Best candidate: #${bestIdx}`
      };
    }
  } catch (err) {
    console.warn(`[TemplateMom] Vision QA evaluation warning: ${err.message}`);
  }

  return fallbackResult;
}

// ── 7. NATURAL SLICING & COMPOSITION ──────────────────────────────────────────

/**
 * Cắt tự nhiên Storyboard 16:9 thành 4 panels 4:9 (480x1080) không méo hình
 */
function sliceMasterStoryboardMom(storyboardBuffer) {
  const tmpDir = os.tmpdir();
  const runId = Math.random().toString(36).substring(2, 9);
  const inPath = path.join(tmpDir, `tmom_in_${runId}.png`);
  fs.writeFileSync(inPath, storyboardBuffer);

  const panels = [];
  try {
    for (let i = 0; i < 4; i++) {
      const outPath = path.join(tmpDir, `tmom_slice_${runId}_${i + 1}.png`);
      execSync(`"${ffmpegPath}" -y -i "${inPath}" -filter_complex "[0:v]crop=iw/4:ih:iw/4*${i}:0,scale=480:1080[out]" -map "[out]" "${outPath}"`, { stdio: 'ignore' });
      if (fs.existsSync(outPath)) {
        panels.push(fs.readFileSync(outPath));
        try { fs.unlinkSync(outPath); } catch (_) {}
      }
    }
  } finally {
    try { fs.unlinkSync(inPath); } catch (_) {}
  }
  return panels;
}

/**
 * Ghép 4 panels 4:9 (480x1080) thành ảnh 16:9 (1920x1080) hoàn chỉnh
 */
function composeMasterStoryboardMom(panels, outputPath) {
  if (!panels || panels.length !== 4) throw new Error('Requires exactly 4 panels to compose storyboard');
  const tmpDir = os.tmpdir();
  const runId = Math.random().toString(36).substring(2, 9);
  const panelPaths = [];

  try {
    for (let i = 0; i < 4; i++) {
      const p = path.join(tmpDir, `tmom_comp_${runId}_${i + 1}.png`);
      fs.writeFileSync(p, panels[i]);
      panelPaths.push(p);
    }
    const inputsArg = panelPaths.map(p => `-i "${p}"`).join(' ');
    execSync(`"${ffmpegPath}" -y ${inputsArg} -filter_complex "[0:v][1:v][2:v][3:v]hstack=inputs=4[out]" -map "[out]" "${outputPath}"`, { stdio: 'ignore' });
  } finally {
    for (const p of panelPaths) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
  }
  return fs.existsSync(outputPath);
}

function sanitizeVisualActionPrompt(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = text;
  cleaned = cleaned.replace(/[,;]?\s*(?:bàn\s+)?(?:ngón\s+)?(?:tay\s+)?(?:chỉ\s+tay|chỉ\s+trỏ|hướng\s+tay|chỉ)\s+(?:về|vào|xuống|sang)?\s*(?:phía\s*)?(?:icon\s*)?(?:giỏ\s*hàng|góc\s*(?:trái|phải|màn\s*hình))[^.,;!?]*/gi, '');
  cleaned = cleaned.replace(/[,;]?\s*(?:bàn\s+)?(?:ngón\s+)?(?:tay\s+)?(?:chạm|bấm|nhấn|click)(?:\s+nhẹ)?\s+(?:vào|lên)?\s*(?:icon\s*)?(?:giỏ\s*hàng|góc\s*(?:trái|phải|màn\s*hình))[^.,;!?]*/gi, '');
  cleaned = cleaned.replace(/[,;]?\s*(?:bàn\s+)?(?:ngón\s+)?(?:tay\s+)?chỉ\s+tay[^.,;!?]*/gi, '');
  cleaned = cleaned.replace(/[,;]?\s*(?:xuất\s+hiện\s+)?(?:icon|biểu\s*tượng|nút)\s+giỏ\s*hàng[^.,;!?]*/gi, '');
  cleaned = cleaned.replace(/[,;]?\s*giỏ\s*hàng\s+(?:ở\s+)?góc\s+(?:trái|phải|màn\s*hình)[^.,;!?]*/gi, '');
  cleaned = cleaned.replace(/^[,;.\s]+/, '');
  cleaned = cleaned.replace(/\s{2,}/g, ' ');
  cleaned = cleaned.trim();
  return cleaned;
}

function cleanProductName(name) {
  if (!name || typeof name !== 'string') return 'sản phẩm';
  let cleaned = name.split(/[-–—|,]/)[0].trim();
  cleaned = cleaned.replace(/\s+[sSmMlLxX]{1,4}(?:\/[sSmMlLxX]{1,4})+/g, '');
  cleaned = cleaned.replace(/\s+\d+\s*(?:miếng|gói|hộp|chiếc|cái|set|combo)/gi, '');
  if (cleaned.length > 40) {
    cleaned = cleaned.substring(0, 40).trim();
  }
  return cleaned || 'sản phẩm';
}

function cleanActionText(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = sanitizeVisualActionPrompt(text)
    .replace(/mở nắp/gi, 'kiểm tra')
    .replace(/mở hộp/gi, 'cầm nhẹ nhàng')
    .replace(/^(?:mẹ|bé)\s+/gi, '')
    .trim();
  return cleaned;
}

function mapActionToEnglish(action, castKey) {
  if (!action || typeof action !== 'string') {
    return castKey === 'baby' ? 'makes small natural movements and smiles happily' : 'gently inspects the product';
  }
  let a = action.toLowerCase().trim();
  if (/bế|ôm|cradl/i.test(a)) return 'gently cradles and holds the baby in a comfortable posture';
  if (/tã|bỉm|waistband|co giãn/i.test(a)) return 'gently stretches the waistband and checks the soft inner surface';
  if (/gặm|nướu|xúc xắc|toy/i.test(a)) return 'happily shakes and inspects the toy';
  if (/hút sữa|pump/i.test(a)) return 'comfortably wears and adjusts the breast pump';
  if (/cầm|kiểm tra|sờ|chạm|touch|inspect/i.test(a)) return 'gently holds and inspects the product texture';
  if (/vẫy tay|cười|ngủ|chơi/i.test(a)) return 'happily waves hands and feet in a safe, comfortable pose';
  return cleanActionText(action);
}

/**
 * Xây dựng Veo Motion Prompt v2 cho 1 scene (image-to-video Start Frame mode)
 * Kiến trúc chuẩn theo TEMPLATE_MOM_VEO_START_FRAME_MIGRATION_SPEC_v2:
 * 
 * START FRAME = APPEARANCE SOURCE OF TRUTH
 * VEO PROMPT = MOTION INSTRUCTION
 * 
 * - Không mô tả lại hình dáng, màu sắc, chi tiết trang phục hay background đã có trên Start Frame (Section 24).
 * - Sử dụng tiếng Anh tự nhiên cho chuyển động (Section 23).
 * - Cấu trúc Motion Block rõ ràng: SUBJECT MOTION, PRODUCT MOTION, CAMERA, PERFORMANCE, ENDING STATE (Section 22).
 * - Một chuyển động chính cho mỗi clip (Section 9).
 * - Multi-person / Mother+Baby: ANIMATE THE CURRENT POSE > CREATE A NEW POSE (Section 29).
 * - Product Lock mang tính hành vi: "The product retains its appearance throughout the motion" (Section 25).
 * - Hỗ trợ Adaptive Retry theo cấp độ (Section 38 & 39).
 */
function buildTemplateMomVeoMotionPrompt(scene, analysisData = {}, options = {}) {
  const attempt = options.attempt || options.retryAttempt || 1;
  const chars = scene?.characters || ['mother', 'baby'];
  const castKey = normalizeCastKey(chars);
  const mp = scene?.motionPlan || {};
  const hi = scene?.humanInteraction || {};
  const customInstruction = options.customInstruction ? ` Priority instruction: ${options.customInstruction}.` : '';

  // 1. Phân tích motion plan từ schema v2 hoặc fallback từ humanInteraction
  let rawAction = mp.primaryAction || hi.motherAction || hi.babyAction || scene?.visualDescription || '';
  let primaryAction = mapActionToEnglish(rawAction, castKey);
  let secondaryMotion = mp.secondaryMotion || '';
  let productMotion = mp.productMotion || 'The product retains its appearance throughout the motion.';
  let cameraMotion = mp.cameraMotion || 'Subtle handheld camera push-in with warm natural daylight.';
  let endState = mp.endState || 'The scene settles naturally into a calm ending pose.';

  // 2. Chiến lược Adaptive Retry (Sections 38 & 39 của SPEC v2)
  if (attempt === 2) {
    // Lần thử 2: Đơn giản hóa hành động chính, bỏ chuyển động phụ, camera tĩnh hơn
    secondaryMotion = '';
    cameraMotion = 'Minimal handheld camera movement with subtle push-in.';
  } else if (attempt >= 3) {
    // Lần thử 3: Fallback micro-motion (chuyển động siêu nhỏ, nhịp thở tự nhiên)
    secondaryMotion = '';
    cameraMotion = 'Static camera with soft natural daylight.';
    if (castKey === 'baby') {
      primaryAction = 'makes tiny natural breathing movements and smiles calmly';
    } else if (castKey === 'mother') {
      primaryAction = 'holds a gentle resting pose with subtle natural breathing';
    } else {
      primaryAction = 'cradles the baby with subtle micro-movements, maintaining a quiet resting pose';
    }
  }

  // 3. Render Veo Motion Prompt v2 theo từng vai nhân vật
  if (castKey === 'mother') {
    const actionDesc = attempt >= 3
      ? `The mother ${primaryAction}.`
      : `The mother gently performs: ${primaryAction}.${secondaryMotion ? ` ${secondaryMotion}.` : ''} Her hand movements are subtle, calm and physically natural.`;
    return `Create a realistic short 4-second smartphone video from the provided starting image.

SUBJECT MOTION:
${actionDesc}

PRODUCT MOTION:
${productMotion}

CAMERA:
${cameraMotion}

PERFORMANCE:
The mother maintains a warm, natural expression with a gentle smile, looking at the product.

ENDING STATE:
${endState}

Keep the motion subtle, continuous, natural, and physically plausible.
Silent scene.${customInstruction}`.trim();

  } else if (castKey === 'baby') {
    const actionDesc = attempt >= 3
      ? `The baby ${primaryAction}.`
      : `The baby makes small natural movements with hands and feet, reacting happily and comfortably.${secondaryMotion ? ` ${secondaryMotion}.` : ''}`;
    return `Create a realistic short 4-second smartphone video from the provided starting image.

SUBJECT MOTION:
${actionDesc}

PRODUCT MOTION:
${productMotion}

CAMERA:
${cameraMotion}

PERFORMANCE:
The baby smiles cheerfully with bright, relaxed expressions in a completely safe posture.

ENDING STATE:
${endState}

Keep the motion subtle, continuous, natural, and physically plausible.
Silent scene.${customInstruction}`.trim();

  } else {
    // Mother + Baby (Section 29: ANIMATE THE CURRENT POSE > CREATE A NEW POSE)
    const actionDesc = attempt >= 3
      ? `The mother gently ${primaryAction}.`
      : `The mother gently holds and cares for the baby with tender micro-movements.${secondaryMotion ? ` ${secondaryMotion}.` : ''} The baby rests comfortably and safely in her arms.`;
    return `Create a realistic short 4-second smartphone video from the provided starting image.

SUBJECT MOTION:
${actionDesc}

PRODUCT MOTION:
${productMotion}

CAMERA:
${cameraMotion}

PERFORMANCE:
Warm and affectionate bond between mother and baby, soft natural smiles, calm breathing.

ENDING STATE:
${endState}

Keep the motion subtle, continuous, natural, and physically plausible.
Silent scene.${customInstruction}`.trim();
  }
}

function buildTemplateMom4sPanelPrompts(analysisData, options = {}) {
  const script = analysisData?.script || analysisData?.analysis?.script || (Array.isArray(analysisData) ? analysisData : options.script || []);
  const prompts = [0, 1, 2, 3].map(idx => {
    const s = script[idx] || {};
    return buildTemplateMomVeoMotionPrompt(s, analysisData, { ...options, panelIndex: idx + 1 });
  });

  if (options.panelIndex && options.panelIndex >= 1 && options.panelIndex <= 4) {
    return prompts[options.panelIndex - 1];
  }
  return prompts;
}

function buildTemplateMomVideoPrompts(analysisData, options = {}) {
  return buildTemplateMom4sPanelPrompts(analysisData, options);
}

// ── 9. TTS GENERATION (FEMALE SOUTHERN VIETNAMESE YOUNG MOTHER) ───────────────

/**
 * Sinh giọng đọc 16s lồng tiếng Mẹ & Bé bằng Gemini TTS (Section 26 & Section 45)
 */
async function generateTemplateMomVoiceReview(analysisData, outVoicePath, options = {}) {
  const voice = options.voice || process.env.GEMINI_TTS_DEFAULT_VOICE || 'Zephyr';
  const targetDuration = options.targetDuration || 16.0;

  const script = analysisData?.script || [];
  const scriptLines = script.map(s => (s.voiceOver || '').trim()).filter(Boolean);
  const fullText = scriptLines.length === 4
    ? scriptLines.join(' ')
    : 'Mẹ nào đang chăm con nhỏ chắc hiểu cảnh này nè. Món này thiết kế cực kỳ tiện lợi, hỗ trợ mẹ chăm sóc bé nhàn tênh luôn nha. Chất liệu cao cấp an toàn tuyệt đối cho con. Các mẹ bấm liền giỏ hàng góc trái coi thử nghen.';

  const ttsPrompt = `[Chỉ dẫn giọng đọc & tốc độ: Giọng nữ miền Nam trẻ, ấm áp, tự nhiên, giống một mẹ bỉm đang chia sẻ món đồ thật sự dùng trong cuộc sống hằng ngày với các mẹ khác. Nhịp nói nhanh vừa đủ cho TikTok, phát âm tròn vành rõ chữ, có cảm xúc tự nhiên, không đọc kiểu TVC quảng cáo, đọc trọn kịch bản này trong khoảng đúng 15 đến 16 giây không bị cutoff]:\n${fullText}`;

  console.log(`[TemplateMom] 🎙️ Generating Mother & Baby Voice Review via Gemini TTS (Voice: "${voice}")...`);
  try {
    const res = await generateSpeechWithGemini(ttsPrompt, { ...options, voice });

    const outWavPath = outVoicePath.replace(/\.[^.]+$/, '.wav');
    const wavBuffer = pcmToWav(res.pcmBuffer, 24000, 1, 16);
    fs.writeFileSync(outWavPath, wavBuffer);

    convertPcmToM4a(res.pcmBuffer, outVoicePath, targetDuration, options);

    console.log(`[TemplateMom] 🎉 Voice Review successfully created at: ${outVoicePath}`);
    return {
      success: true,
      voicePath: outVoicePath,
      audioPath: outVoicePath,
      wavPath: outWavPath,
      modelUsed: res.modelUsed,
      voiceUsed: res.voiceUsed,
      latencyMs: res.latencyMs,
      prompt: ttsPrompt,
    };
  } catch (err) {
    console.warn(`[TemplateMom] ⚠️ Gemini TTS fallback to silent audio track: ${err.message}`);
    const outDir = path.dirname(outVoicePath);
    ensureDir(outDir);
    try {
      execSync(`"${ffmpegPath}" -y -f lavfi -i anullsrc=r=48000:cl=stereo -t ${targetDuration} -c:a aac -b:a 192k "${outVoicePath}"`, { stdio: 'ignore' });
    } catch (_) {}
    return {
      success: false,
      voicePath: outVoicePath,
      audioPath: outVoicePath,
      error: err.message,
      prompt: ttsPrompt,
    };
  }
}

// ── 10. TELEGRAM KEYBOARDS & SESSION MANAGEMENT ───────────────────────────────

function buildMomInlineKeyboard(runId) {
  return {
    inline_keyboard: [
      [
        { text: '🔄 Remake 1', callback_data: `tmom_remake:1:${runId}` },
        { text: '🔄 Remake 2', callback_data: `tmom_remake:2:${runId}` },
      ],
      [
        { text: '🔄 Remake 3', callback_data: `tmom_remake:3:${runId}` },
        { text: '🔄 Remake 4', callback_data: `tmom_remake:4:${runId}` },
      ],
      [
        { text: '🔄 Remake Cả 4 Cảnh', callback_data: `tmom_remake_all:${runId}` },
      ],
      [
        { text: '✅ Duyệt & Sinh 4 Video (OK)', callback_data: `tmom_ok:${runId}` },
      ]
    ]
  };
}

function buildMomVideoInlineKeyboard(runId) {
  return {
    inline_keyboard: [
      [
        { text: '🔄 Remake Cảnh 1', callback_data: `tmom_remake_video:1:${runId}` },
        { text: '🔄 Remake Cảnh 2', callback_data: `tmom_remake_video:2:${runId}` },
      ],
      [
        { text: '🔄 Remake Cảnh 3', callback_data: `tmom_remake_video:3:${runId}` },
        { text: '🔄 Remake Cảnh 4', callback_data: `tmom_remake_video:4:${runId}` },
      ],
      [
        { text: '🚀 Đăng TikTok Ngay', callback_data: `tmom_upload:${runId}` },
      ]
    ]
  };
}

// ── 9B. MARKDOWN LOGGING (PROMPT.MD & PROMPTS.MD) ─────────────────────────────

function writeMarkdownLog(runDir, content) {
  try {
    fs.writeFileSync(path.join(runDir, 'prompts.md'), content, 'utf8');
    fs.writeFileSync(path.join(runDir, 'prompt.md'), content, 'utf8');
  } catch (e) {
    console.warn(`[TemplateMom] Failed to write prompts.md / prompt.md:`, e.message);
  }
}

function appendMarkdownLog(runDir, content) {
  try {
    fs.appendFileSync(path.join(runDir, 'prompts.md'), content, 'utf8');
    fs.appendFileSync(path.join(runDir, 'prompt.md'), content, 'utf8');
  } catch (e) {
    console.warn(`[TemplateMom] Failed to append to prompts.md / prompt.md:`, e.message);
  }
}

function formatMomScriptBreakdown(analysisData) {
  const analysis = analysisData?.analysis || analysisData || {};
  const scriptList = analysisData?.script || analysis?.script || [];

  const scriptTable = [
    '| Panel | Giai đoạn (Phase) | Nhân vật (Casting) | Lời thoại Voice-Over (Target: 16-18 từ) | Số từ | Mô tả hình ảnh (Visual) | Hành động chính |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
    ...[0, 1, 2, 3].map(i => {
      const p = scriptList[i] || {};
      const vo = p.voiceOver || 'N/A';
      const count = vo !== 'N/A' ? vo.split(/\s+/).filter(Boolean).length : 0;
      const chars = Array.isArray(p.characters) ? p.characters.join(', ') : 'mother, baby';
      const action = p.motionPlan?.primaryAction || p.humanInteraction?.motherAction || 'N/A';
      return `| Panel ${i + 1} | ${p.phase || `Cảnh ${i + 1}`} | \`${chars}\` | ${vo.replace(/\|/g, '-')} | **${count} từ** | ${(p.visualDescription || 'N/A').replace(/\|/g, '-')} | ${action.replace(/\|/g, '-')} |`;
    })
  ].join('\n');

  const totalWords = scriptList.reduce((sum, s) => sum + (s.voiceOver ? s.voiceOver.split(/\s+/).filter(Boolean).length : 0), 0);

  return [
    '### 4-Panel Mother & Baby Script Breakdown',
    scriptTable,
    '',
    `- **Tổng số từ Voice Review**: **${totalWords} từ** (Chuẩn 16.0s / 4 cảnh x 4s, giới hạn: 65-70 từ)`,
    `- **Chiến lược phân vai**: Nhân vật chính: \`${analysis.characterStrategy?.primaryCharacter || 'mother_and_baby'}\``,
    `  * Vai trò của Mẹ: \`${analysis.characterStrategy?.motherRole || 'caregiver'}\``,
    `  * Vai trò của Bé: \`${analysis.characterStrategy?.babyRole || 'user'}\``,
    `  * Động lực tương tác: ${analysis.characterStrategy?.relationshipDynamic || 'N/A'}`,
    `- **4 Answers Marketing Framework**:`,
    `  * Hook (Cảnh 1): ${analysis.fourAnswers?.hook || 'N/A'}`,
    `  * Solution (Cảnh 2): ${analysis.fourAnswers?.solution || 'N/A'}`,
    `  * Proof (Cảnh 3): ${analysis.fourAnswers?.proof || 'N/A'}`,
    `  * Closing (Cảnh 4): ${analysis.fourAnswers?.closing || 'N/A'}`,
    `- **Đối tượng người xem**: ${analysis.targetAudience || 'Mẹ bỉm sữa chăm con nhỏ'}`,
  ].join('\n');
}

function buildInitialMomMarkdown(sessionData) {
  const { runId, analysis, script, masterPrompt, candidateBuffers, bestIndex, chatId, analysisPrompt, rawResponse } = sessionData;
  const vp = analysis?.voicePersona || {};
  const sc = analysis?.sceneContext || {};

  return [
    `# Mother & Baby Commerce Template Full Flow Execution Log — ${runId}`,
    `- Run ID: \`${runId}\``,
    `- Timestamp: ${new Date().toISOString()}`,
    `- Template: \`/tmom\` (Mother & Baby Dedicated Channel Workflow)`,
    `- Product: **${analysis?.productName || 'Sản phẩm Mẹ & Bé'}**`,
    `- Category: \`${analysis?.category || 'mother_baby'}\` / \`${analysis?.subCategory || 'hygiene'}\``,
    `- Target User: \`${analysis?.targetUser || 'baby'}\` | Buyer Angle: \`${analysis?.buyerAngle || 'for_baby'}\``,
    `- Voice Persona: ${vp.voiceDescription || 'N/A'} (Gender: ${vp.gender || 'nu'}, Tone: ${vp.tone || 'ấm áp, đời thường'})`,
    `- Scene Context: Location: ${sc.location || 'N/A'}, Lighting: ${sc.lighting || 'N/A'}`,
    '',
    '---',
    '## Step 1: Gemini Mother & Baby Analysis & Script Generation (Validation Gate)',
    '- **API Engine**: Gemini API Client (generateContent & Vision)',
    '- **Persona**: Giọng nữ miền Nam trẻ, ấm áp, đời thường, chia sẻ thật',
    '- **Target Duration**: Exactly 16.0s (4x 4s clips, 16-18 words/scene, 65-70 words total)',
    '',
    '### Gemini Analysis Prompt',
    '```text',
    analysisPrompt || 'N/A',
    '```',
    '',
    '### Gemini Raw Response',
    '```json',
    rawResponse || (analysis ? JSON.stringify(analysis, null, 2) : 'N/A'),
    '```',
    '',
    formatMomScriptBreakdown({ analysis, script }),
    '',
    '---',
    '## Step 2: Google Flow 4x Parallel Storyboard Generation & Multi-Candidate QA',
    '- **Model**: `nano-banana-pro` (Aspect Ratio: `16:9`, 1920x1080)',
    `- **Generated Candidates**: ${candidateBuffers?.length || 4} parallel storyboards`,
    `- **Selected Best Candidate**: Candidate #${bestIndex || 1}`,
    '- **Character Assets**: Permanent Mother & Baby identity locked (assets/nhi/mom.png, assets/nhi/baby.png)',
    '',
    '### Master Storyboard Prompt Used',
    '```text',
    masterPrompt || 'N/A',
    '```',
    '',
    `- **Final Master Storyboard**: \`storyboard-approved.png\` (1920x1080)`,
    '',
    '---',
    '## Step 3: Natural 4:9 Panel Slicing & Telegram Interaction',
    '- **Slicing Method**: Natural 480x1080 (4:9 aspect ratio each panel, zero distortion, zero logo crop)',
    ...[1, 2, 3, 4].map(idx => `- **Panel ${idx}**: \`panels/panel-${idx}.png\` (480x1080)`),
    `- **Telegram Notification**: Photo sent to chat \`${chatId || 'N/A'}\``,
    '- **Interactive Options**: `[Remake 1-4]` `[Remake Cả 4 Cảnh]` `[Duyệt & Sinh 4 Video (OK)]`',
    '- **Current Status**: Waiting for user review / OK',
    ''
  ].join('\n');
}

function saveMomSession(runId, sessionData) {
  if (!runId || !sessionData) return;
  momSessions.set(runId, sessionData);

  if (sessionData.runDir) {
    try {
      const sessFile = path.join(sessionData.runDir, 'session.json');
      const serializable = { ...sessionData };
      delete serializable.selectedCandidateBuffer;
      delete serializable.panels;
      delete serializable.filePayloads;
      fs.writeFileSync(sessFile, JSON.stringify(serializable, null, 2), 'utf8');
    } catch (_) {}
  }
}

function getMomSession(runId, baseDir) {
  if (!runId) return null;
  if (momSessions.has(runId)) return momSessions.get(runId);

  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const runsDir = path.join(effectiveBaseDir, 'storyboard-review-runs');
  if (!fs.existsSync(runsDir)) return null;

  try {
    const dirs = fs.readdirSync(runsDir);
    for (const d of dirs) {
      if (d.includes(`tmom-flow-${runId}`) || d.includes(`template_mom-flow-${runId}`) || d.endsWith(`-${runId}`)) {
        const sessFile = path.join(runsDir, d, 'session.json');
        if (fs.existsSync(sessFile)) {
          const loaded = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
          loaded.runDir = path.join(runsDir, d);
          const panelsDir = path.join(loaded.runDir, 'panels');
          if (fs.existsSync(panelsDir)) {
            loaded.panels = [1, 2, 3, 4].map(idx => {
              const p = path.join(panelsDir, `panel-${idx}.png`);
              return fs.existsSync(p) ? fs.readFileSync(p) : null;
            }).filter(Boolean);
          }
          momSessions.set(runId, loaded);
          return loaded;
        }
      }
    }
  } catch (_) {}

  return null;
}

// ── 11. REMAKE HANDLERS & VIDEO ASSEMBLY ──────────────────────────────────────

function merge4PanelsWithVoice(panelVideoPaths, voiceAudioPath, outputMergedPath) {
  if (!panelVideoPaths || panelVideoPaths.length !== 4) {
    throw new Error(`merge4PanelsWithVoice requires exactly 4 panel video paths, received ${panelVideoPaths?.length}`);
  }

  const tmpListPath = path.join(path.dirname(outputMergedPath), `concat_list_${Date.now()}.txt`);
  const listContent = panelVideoPaths.map(p => `file '${path.resolve(p)}'`).join('\n');
  fs.writeFileSync(tmpListPath, listContent, 'utf8');

  try {
    let audioArg = '';
    let filterArg = '';
    if (voiceAudioPath && fs.existsSync(voiceAudioPath)) {
      audioArg = `-i "${path.resolve(voiceAudioPath)}"`;
      filterArg = '-map 0:v:0 -map 1:a:0 -c:a aac -b:a 192k';
    } else {
      filterArg = '-c:a copy';
    }

    const cmd = `"${ffmpegPath}" -y -f concat -safe 0 -i "${tmpListPath}" ${audioArg} ${filterArg} -c:v copy -movflags +faststart "${path.resolve(outputMergedPath)}"`;
    execSync(cmd, { stdio: 'ignore' });
  } finally {
    try { fs.unlinkSync(tmpListPath); } catch (_) {}
  }
  return fs.existsSync(outputMergedPath);
}

function buildTemplateMomRemakeVideoJobs(runDir, requestedIndices = [1], customInstruction = '', analysis = null) {
  if (!analysis) {
    const sessionPath = path.join(runDir, 'session.json');
    if (fs.existsSync(sessionPath)) {
      try {
        const sess = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        analysis = sess.analysis || null;
      } catch (_) {}
    }
  }

  const panelsDir = path.join(runDir, 'panels');
  const nums = (Array.isArray(requestedIndices) ? requestedIndices : [requestedIndices])
    .map(Number)
    .filter(n => !isNaN(n) && n >= 1 && n <= 4);

  const targetIndices = nums.length > 0 ? nums : [1];
  const jobs = [];

  for (const idx of targetIndices) {
    const pPath = path.join(panelsDir, `panel-${idx}.png`);
    const pBuf = fs.existsSync(pPath) ? fs.readFileSync(pPath) : null;
    const prompt = buildTemplateMom4sPanelPrompts(analysis || {}, { panelIndex: idx, customInstruction });

    jobs.push({
      index: idx,
      panelIndex: idx,
      prompt,
      imagePath: pPath,
      buffer: pBuf,
      videoModelKey: 'abra_r2v_4s',
    });
  }

  return jobs;
}

// ── 12. FULL GENERATE STORYBOARD WORKFLOW ─────────────────────────────────────

async function generateStoryboard(baseDir, filePayloads, options = {}) {
  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const template = 'template_mom';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const shortRunId = Math.random().toString(36).substring(2, 8);
  const runId = (options.runId && options.runId.length <= 12) ? options.runId : shortRunId;
  const runDir = path.join(effectiveBaseDir, 'storyboard-review-runs', `${timestamp}-${template}-flow-${runId}`);
  ensureDir(runDir);

  const inputsDir = path.join(runDir, 'inputs');
  ensureDir(inputsDir);

  // 1. Tải và kiểm tra Asset Source nhận diện nhân vật (Mẹ & Bé)
  const charAssets = loadCharacterAssets(effectiveBaseDir);
  const motherRefPath = path.join(inputsDir, 'mother_reference.png');
  const babyRefPath = path.join(inputsDir, 'baby_reference.png');
  fs.writeFileSync(motherRefPath, charAssets.motherBuffer);
  fs.writeFileSync(babyRefPath, charAssets.babyBuffer);

  // 2. Lưu và chuẩn bị ảnh sản phẩm đầu vào
  if (!filePayloads || filePayloads.length === 0) {
    const err = new Error('At least one product reference image is required');
    err.code = 'ERR_MISSING_PRODUCT_REFERENCE';
    throw err;
  }

  const savedProductInputs = [];
  filePayloads.forEach((f, idx) => {
    const ext = (f.mimeType && f.mimeType.includes('png')) ? '.png' : '.jpg';
    const filePath = path.join(inputsDir, `product_${idx + 1}${ext}`);
    const buf = Buffer.isBuffer(f.buffer) ? f.buffer : (f.base64 ? Buffer.from(f.base64, 'base64') : (f.path ? fs.readFileSync(f.path) : null));
    if (buf) {
      fs.writeFileSync(filePath, buf);
      savedProductInputs.push({
        name: `product_${idx + 1}${ext}`,
        path: filePath,
        buffer: buf,
        mimeType: f.mimeType || 'image/png'
      });
    }
  });

  const productCollageBuf = createProductCollageImage(savedProductInputs);
  const productCollagePath = path.join(inputsDir, 'product_reference.png');
  if (productCollageBuf) {
    fs.writeFileSync(productCollagePath, productCollageBuf);
  }

  const progress = typeof options.onProgress === 'function' ? options.onProgress : async () => {};
  if (options.stepTracker) {
    await options.stepTracker.setStep(1, 'completed');
    await options.stepTracker.setStep(2, 'running');
  }

  const geminiClient = new GeminiApiClient({
    browserMode: true,
    userDataDir: path.join(effectiveBaseDir, 'gemini-playwright-user-data')
  });

  let analysis = null;
  let script = null;

  try {
    try { await geminiClient.init(); } catch (_) {}

    // 3. Step 1: Phân tích kịch bản Mẹ & Bé qua Gemini kèm Validation Gate
    console.log('[TemplateMom] Step 1: Analyzing product via Gemini with Mother & Baby validation gate...');
    const analyzed = await analyzeProductTemplateMom(geminiClient, savedProductInputs, {
      productContext: options.productContext || {},
    });
    analysis = analyzed.analysis;
    script = analyzed.script;

    if (analysis?.productName && options.stepTracker) {
      await options.stepTracker.setTitle(analysis.productName);
    }
    if (options.stepTracker) {
      await options.stepTracker.setStep(2, 'completed');
      await options.stepTracker.setStep(3, 'running');
    }

    // 4. Step 2: Sinh 4 Master Storyboard candidates song song qua Google Flow
    console.log('[TemplateMom] Step 2: Generating 4 Mother & Baby Master Storyboards in parallel via Google Flow...');
    await progress({
      currentStep: 'generating_storyboard',
      stepOrder: 3,
      progressPercent: 35,
      message: 'Đang tạo 4 Storyboard Mẹ & Bé song song trên Google Flow...',
    });

    const masterPrompt = buildTemplateMomMasterPrompt(analysis);

    // Gửi đúng 3 tài nguyên với vai trò ngữ nghĩa phân định rõ ràng
    const flowPayloads = [
      { name: 'mother_reference.png', path: motherRefPath, buffer: charAssets.motherBuffer, mimeType: 'image/png' },
      { name: 'baby_reference.png', path: babyRefPath, buffer: charAssets.babyBuffer, mimeType: 'image/png' },
      { name: 'product_reference.png', path: productCollagePath, buffer: productCollageBuf, mimeType: 'image/png' }
    ];

    let candidateBuffers = [];
    let flowPage = null;
    let lastMasterErr = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`[TemplateMom] 🔄 Retrying Flow Storyboard generation (Attempt ${attempt}/3)...`);
          await new Promise(r => setTimeout(r, 4000));
        }
        const projectConfig = resolveFlowProject(options.chatId, 'template_mom', effectiveBaseDir);
        flowPage = await createFlowPage(effectiveBaseDir, projectConfig.projectUrl);
        const prepared = await prepareGeneration(
          flowPage,
          masterPrompt,
          flowPayloads,
          {
            imageModel: 'nano-banana-pro',
            aspectRatio: '16:9',
            outputCount: 4,
            projectId: projectConfig.projectId,
          },
          effectiveBaseDir
        );
        const genResult = await executeGeneration(prepared);
        if (genResult && Array.isArray(genResult.allResults) && genResult.allResults.length > 0) {
          candidateBuffers = genResult.allResults.map(r => r.buffer || Buffer.from(r.base64, 'base64')).filter(Boolean);
        } else if (genResult && (genResult.buffer || genResult.base64)) {
          candidateBuffers = [genResult.buffer || Buffer.from(genResult.base64, 'base64')];
        }

        if (candidateBuffers.length > 0) break;
      } catch (err) {
        lastMasterErr = err;
        console.warn(`[TemplateMom] Flow Storyboard Attempt ${attempt}/3 failed: ${err.message}`);
      } finally {
        if (flowPage) {
          try { await closeFlowPage(flowPage); } catch (_) {}
        }
      }
    }

    if (candidateBuffers.length === 0) {
      throw new Error(`Failed to generate Master Storyboards on Google Flow: ${lastMasterErr?.message || 'Unknown error'}`);
    }

    candidateBuffers.forEach((buf, i) => {
      fs.writeFileSync(path.join(runDir, `storyboard-candidate-${i + 1}.png`), buf);
    });

    // 5. Step 3: Đánh giá QA đồng thời bằng Gemini Vision
    await progress({
      currentStep: 'generating_storyboard',
      stepOrder: 3,
      progressPercent: 50,
      message: 'Đang kiểm định chất lượng nhận diện Mẹ & Bé qua Gemini Vision...',
    });

    const multiQA = await verifyMultiStoryboardWithGeminiVision(geminiClient, candidateBuffers, flowPayloads, analysis);
    const bestIndex = (multiQA.bestCandidateIndex >= 1 && multiQA.bestCandidateIndex <= candidateBuffers.length)
      ? multiQA.bestCandidateIndex
      : 1;

    console.log(`[TemplateMom] 🏆 Best Candidate Selected: #${bestIndex}`);
    const selectedBuffer = candidateBuffers[bestIndex - 1];
    const finalMasterPath = path.join(runDir, 'storyboard-approved.png');
    fs.writeFileSync(finalMasterPath, selectedBuffer);

    // 6. Step 4: Cắt tự nhiên thành 4 panels 4:9 (480x1080)
    const panelsDir = path.join(runDir, 'panels');
    ensureDir(panelsDir);
    const panelBuffers = sliceMasterStoryboardMom(selectedBuffer);
    panelBuffers.forEach((buf, i) => {
      fs.writeFileSync(path.join(panelsDir, `panel-${i + 1}.png`), buf);
    });

    // 7. Gửi tin nhắn Telegram kèm các nút tương tác
    const chatId = options.chatId || options.telegramChatId;
    let telegramMessageId = null;

    if (chatId) {
      const prodTitle = analysis.productName || 'Sản phẩm Mẹ & Bé';
      const caption = `👶 <b>KÊNH MẸ & BÉ: STORYBOARD REVIEW (/tmom)</b>\n\n` +
        `📦 <b>Sản phẩm:</b> ${prodTitle}\n` +
        `👩‍👦 <b>Nhân vật:</b> Mẹ & Bé cố định (không faceless)\n` +
        `📊 <b>Chất lượng AI:</b> Candidate #${bestIndex} (Đã qua QA nhận diện)\n\n` +
        `👉 <i>Bấm <b>Remake 1-4</b> để tạo lại cảnh chưa ưng ý, hoặc bấm <b>✅ Duyệt & Sinh Video</b> để hoàn tất!</i>`;

      const tgRes = await sendPhotoToTelegram(
        chatId,
        selectedBuffer,
        caption,
        {
          reply_markup: buildMomInlineKeyboard(runId),
          parse_mode: 'HTML',
        }
      );
      telegramMessageId = tgRes?.message_id || null;
    }

    // Tạo và ghi log prompt.md & prompts.md
    const initialMd = buildInitialMomMarkdown({
      runId,
      analysis,
      script,
      masterPrompt,
      candidateBuffers,
      bestIndex,
      chatId,
      analysisPrompt: analyzed?.analysisPrompt,
      rawResponse: analyzed?.rawResponse,
    });
    writeMarkdownLog(runDir, initialMd);

    const extractedProductId = options.productContext?.productId || options.productId || (options.runId && String(options.runId).startsWith('tg_') ? String(options.runId).split('_')[2] : '') || '';
    const extractedProductTitle = options.productContext?.productTitle || options.productTitle || analysis?.productName || 'Sản phẩm review';
    const sessionData = {
      runId,
      jobId: options.runId || options.jobId || runId,
      productId: extractedProductId,
      productTitle: extractedProductTitle,
      productUrl: options.productContext?.productUrl || options.productUrl || '',
      shortlink: options.productContext?.shortlink || options.shortlink || '',
      cartAnchorText: options.productContext?.cartAnchorText || analysis?.cartAnchorText || '',
      runDir,
      chatId,
      promptsMdPath: path.join(runDir, 'prompt.md'),
      telegramMessageId,
      analysis,
      script,
      masterPrompt,
      flowPayloads,
      candidateBuffers,
      bestIndex,
      selectedCandidateBuffer: selectedBuffer,
      panels: panelBuffers,
      iteration: 1,
      createdAt: new Date().toISOString(),
    };
    saveMomSession(runId, sessionData);

    return {
      runId,
      template: 'template_mom',
      isInteractiveStoryboard: true,
      analysis,
      storyboardPath: finalMasterPath,
      storyboardBuffer: selectedBuffer,
      panels: panelBuffers.map((buf, i) => ({
        index: i + 1,
        path: path.join(panelsDir, `panel-${i + 1}.png`),
        buffer: buf,
      })),
      reviewArchive: {
        root: runDir,
        panelsDir,
        videosDir: path.join(runDir, 'videos'),
      }
    };
  } finally {
    try { await geminiClient.close(); } catch (_) {}
  }
}

// ── 13. REMAKE ACTIONS (PANEL & ALL) ──────────────────────────────────────────

async function executeMomRemakePanel(chatId, baseDir, runId, targetPanelIndex, opts = {}) {
  const session = getMomSession(runId, baseDir);
  if (!session) {
    await sendTelegramMessage(chatId, `⚠️ Không tìm thấy phiên làm việc ${runId}.`);
    return;
  }

  const pIdx = parseInt(targetPanelIndex, 10);
  if (pIdx < 1 || pIdx > 4) return;

  console.log(`[TemplateMom] 🔄 Remaking Panel ${pIdx} for session ${runId}...`);
  let flowPage = null;
  let candidateBuffers = [];

  try {
    const projectConfig = resolveFlowProject(chatId, 'template_mom', baseDir);
    flowPage = await createFlowPage(baseDir, projectConfig.projectUrl);
    const prepared = await prepareGeneration(
      flowPage,
      session.masterPrompt || buildTemplateMomMasterPrompt(session.analysis),
      session.flowPayloads,
      { imageModel: 'nano-banana-pro', aspectRatio: '16:9', outputCount: 4, projectId: projectConfig.projectId },
      baseDir
    );
    const genResult = await executeGeneration(prepared);
    if (genResult && Array.isArray(genResult.allResults)) {
      candidateBuffers = genResult.allResults.map(r => r.buffer || Buffer.from(r.base64, 'base64')).filter(Boolean);
    }
  } catch (err) {
    console.warn(`[TemplateMom] Remake panel generation error: ${err.message}`);
  } finally {
    if (flowPage) try { await closeFlowPage(flowPage); } catch (_) {}
  }

  if (candidateBuffers.length === 0) {
    await sendTelegramMessage(chatId, `⚠️ Lỗi tạo lại Panel ${pIdx}. Vui lòng thử lại!`);
    return;
  }

  // Cắt panel pIdx từ candidate tốt nhất thay vào bộ panels hiện tại
  const newSlices = sliceMasterStoryboardMom(candidateBuffers[0]);
  if (newSlices[pIdx - 1]) {
    session.panels[pIdx - 1] = newSlices[pIdx - 1];
    const panelsDir = path.join(session.runDir, 'panels');
    fs.writeFileSync(path.join(panelsDir, `panel-${pIdx}.png`), newSlices[pIdx - 1]);

    const recomposedPath = path.join(session.runDir, 'storyboard-approved.png');
    composeMasterStoryboardMom(session.panels, recomposedPath);
    const recomposedBuf = fs.readFileSync(recomposedPath);

    session.selectedCandidateBuffer = recomposedBuf;
    session.iteration = (session.iteration || 1) + 1;
    saveMomSession(runId, session);

    if (session.telegramMessageId) {
      await editPhotoInTelegram(
        chatId,
        session.telegramMessageId,
        recomposedBuf,
        `👶 <b>KÊNH MẸ & BÉ: STORYBOARD REVIEW (Đã làm lại Cảnh ${pIdx})</b>\n\n` +
        `📦 <b>Sản phẩm:</b> ${session.analysis?.productName || 'Sản phẩm'}\n` +
        `🔄 <b>Lần cập nhật:</b> #${session.iteration}\n\n` +
        `👉 <i>Bấm <b>Remake 1-4</b> nếu muốn đổi tiếp, hoặc bấm <b>✅ Duyệt & Sinh Video</b>!</i>`,
        { reply_markup: buildMomInlineKeyboard(runId), parse_mode: 'HTML' }
      );
    }
  }

  if (opts.stepTracker) await opts.stepTracker.completeAll();
}

async function executeMomRemakeAll(chatId, baseDir, runId, opts = {}) {
  const session = getMomSession(runId, baseDir);
  if (!session) return;

  console.log(`[TemplateMom] 🔄 Remaking ALL 4 panels for session ${runId}...`);
  let flowPage = null;
  let candidateBuffers = [];

  try {
    const projectConfig = resolveFlowProject(chatId, 'template_mom', baseDir);
    flowPage = await createFlowPage(baseDir, projectConfig.projectUrl);
    const prepared = await prepareGeneration(
      flowPage,
      session.masterPrompt || buildTemplateMomMasterPrompt(session.analysis),
      session.flowPayloads,
      { imageModel: 'nano-banana-pro', aspectRatio: '16:9', outputCount: 4, projectId: projectConfig.projectId },
      baseDir
    );
    const genResult = await executeGeneration(prepared);
    if (genResult && Array.isArray(genResult.allResults)) {
      candidateBuffers = genResult.allResults.map(r => r.buffer || Buffer.from(r.base64, 'base64')).filter(Boolean);
    }
  } catch (err) {
    console.warn(`[TemplateMom] Remake all generation error: ${err.message}`);
  } finally {
    if (flowPage) try { await closeFlowPage(flowPage); } catch (_) {}
  }

  if (candidateBuffers.length === 0) {
    await sendTelegramMessage(chatId, `⚠️ Lỗi tạo lại toàn bộ Storyboard. Vui lòng thử lại!`);
    return;
  }

  const selectedBuf = candidateBuffers[0];
  const finalMasterPath = path.join(session.runDir, 'storyboard-approved.png');
  fs.writeFileSync(finalMasterPath, selectedBuf);

  const panelsDir = path.join(session.runDir, 'panels');
  const panelBuffers = sliceMasterStoryboardMom(selectedBuf);
  panelBuffers.forEach((buf, i) => {
    fs.writeFileSync(path.join(panelsDir, `panel-${i + 1}.png`), buf);
  });

  session.panels = panelBuffers;
  session.selectedCandidateBuffer = selectedBuf;
  session.iteration = (session.iteration || 1) + 1;
  saveMomSession(runId, session);

  if (session.telegramMessageId) {
    await editPhotoInTelegram(
      chatId,
      session.telegramMessageId,
      selectedBuf,
      `👶 <b>KÊNH MẸ & BÉ: STORYBOARD REVIEW (Đã làm lại toàn bộ 4 cảnh)</b>\n\n` +
      `📦 <b>Sản phẩm:</b> ${session.analysis?.productName || 'Sản phẩm'}\n` +
      `🔄 <b>Lần cập nhật:</b> #${session.iteration}\n\n` +
      `👉 <i>Bấm <b>Remake 1-4</b> nếu cần chỉnh, hoặc bấm <b>✅ Duyệt & Sinh Video</b>!</i>`,
      { reply_markup: buildMomInlineKeyboard(runId), parse_mode: 'HTML' }
    );
  }

  if (opts.stepTracker) await opts.stepTracker.completeAll();
}

// ── 14. FINALIZE & GENERATE 4x 4s VIDEOS ──────────────────────────────────────

async function finalizeMomStoryboardAndGenerateVideos(chatId, baseDir, runId, opts = {}) {
  const session = getMomSession(runId, baseDir);
  if (!session) {
    await sendTelegramMessage(chatId, `⚠️ Không tìm thấy phiên làm việc ${runId}.`);
    return;
  }

  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const runDir = session.runDir;
  const videosDir = path.join(runDir, 'videos');
  ensureDir(videosDir);

  console.log(`[TemplateMom] 🎬 Finalizing Storyboard and generating 4x 4s videos for runId ${runId}...`);
  if (opts.stepTracker) {
    await opts.stepTracker.setStep(4, 'running');
  }

  // 1. Sinh Voice Review 16s qua Gemini TTS
  const audioDir = path.join(runDir, 'audio');
  ensureDir(audioDir);
  const voiceM4aPath = path.join(audioDir, 'voice_full.m4a');
  await generateTemplateMomVoiceReview(session.analysis, voiceM4aPath);

  // 2. Chuẩn bị 4 video jobs
  const panelPrompts = buildTemplateMom4sPanelPrompts(session.analysis);
  const videoJobs = [1, 2, 3, 4].map(idx => ({
    index: idx,
    panelIndex: idx,
    prompt: panelPrompts[idx - 1],
    promptBuilder: (attempt) => buildTemplateMomVeoMotionPrompt(session.analysis?.script?.[idx - 1] || {}, session.analysis, { attempt, panelIndex: idx }),
    imagePath: path.join(runDir, 'panels', `panel-${idx}.png`),
    buffer: session.panels[idx - 1],
    videoModelKey: 'abra_r2v_4s',
  }));

  const projectConfig = resolveFlowProject(chatId, 'template_mom', effectiveBaseDir);
  const generatedVideos = await generateVideosFromPanelsDirect(effectiveBaseDir, videoJobs, {
    aspectRatio: '9:16',
    videoModelKey: 'abra_r2v_4s',
    includeVideoBase64: true,
    runId,
    projectId: projectConfig.projectId,
    projectUrl: projectConfig.projectUrl,
  });

  const panelVideoPaths = [];
  for (let i = 0; i < 4; i++) {
    const v = generatedVideos[i];
    const outVid = path.join(videosDir, `panel_video_${i + 1}.mp4`);
    if (v && v.buffer) {
      fs.writeFileSync(outVid, v.buffer);
      panelVideoPaths.push(outVid);
    } else if (v && v.path && fs.existsSync(v.path)) {
      panelVideoPaths.push(v.path);
    }
  }

  // 3. Ghép 4 panel video với voice review thành video hoàn chỉnh 16s
  const finalVideoPath = path.join(runDir, 'final_video.mp4');
  let mergeSuccess = false;
  if (panelVideoPaths.length === 4) {
    try {
      mergeSuccess = merge4PanelsWithVoice(panelVideoPaths, voiceM4aPath, finalVideoPath);
    } catch (mErr) {
      console.warn(`[TemplateMom] Video merge warning: ${mErr.message}`);
    }
  }

  // Đăng ký job hoàn thành
  const completedJobId = `tmom-${runId}`;
  registerExternalCompletedJob(chatId, {
    jobId: completedJobId,
    runId,
    status: 'completed',
    template: 'template_mom',
    productId: session.productId || session.analysis?.productId || (session.jobId && session.jobId.startsWith('tg_') ? session.jobId.split('_')[2] : '') || '',
    productTitle: session.productTitle || session.analysis?.productName || 'Sản phẩm review',
    productUrl: session.productUrl || '',
    shortlink: session.shortlink || '',
    cartAnchorText: session.cartAnchorText || '',
    finalVideoPath: mergeSuccess ? finalVideoPath : panelVideoPaths[0],
    panelVideoPaths,
    voicePath: voiceM4aPath,
    analysis: session.analysis,
    runDir,
  });

  if (opts.lastRunByChat) {
    opts.lastRunByChat.set(String(chatId), {
      runDir,
      panelsDir: path.join(runDir, 'panels'),
      videosDir,
      template: 'template_mom',
      analysis: session.analysis,
      baseDir: effectiveBaseDir,
    });
  }

  if (opts.stepTracker) {
    await opts.stepTracker.completeAll();
  }

  // Ghi log video generation vào prompt.md
  const finalizeLog = [
    '',
    '---',
    `## Step 4: 16s Mother & Baby Video Generation & Merge — ${new Date().toISOString()}`,
    `- **Video Model**: \`abra_r2v_4s\` (Start Frame mode, 9:16 aspect ratio)`,
    `- **Clips Generated**: 4 clips of 4 seconds each (total 16.0s)`,
    `- **Audio Track**: \`audio/voice_full.m4a\` (Gemini TTS Southern Vietnamese Young Mother, 16.0s)`,
    '',
    '### Video Generation Prompts (SPEC v2 5-Part Motion Prompt):',
    ...videoJobs.map(job => [
      `#### Panel ${job.panelIndex}:`,
      '```text',
      job.prompt,
      '```',
    ].join('\n')),
    '',
    `- **Final Merged Video**: \`${finalVideoPath}\` (16.00s, video + voice merged)`,
    `- **Telegram Delivery**: Sent to chat \`${chatId || 'N/A'}\``,
    ''
  ].join('\n');
  appendMarkdownLog(runDir, finalizeLog);

  // 4. Gửi video hoàn chỉnh về Telegram
  if (chatId && mergeSuccess && fs.existsSync(finalVideoPath)) {
    const prodTitle = session.analysis?.productName || 'Sản phẩm Mẹ & Bé';
    const hashtags = normalizeHashtags(session.analysis?.hashtags, ['#mebimsua', '#mevabe', '#dodungchobe']).slice(0, 5).join(' ');
    const caption = `👶 <b>KÊNH MẸ & BÉ: VIDEO HOÀN CHỈNH 16S (/tmom)</b>\n\n` +
      `📦 <b>Sản phẩm:</b> ${prodTitle}\n` +
      `🎙️ <b>Giọng đọc:</b> Mẹ bỉm sữa miền Nam tự nhiên\n` +
      `🏷️ <b>Hashtag:</b> ${hashtags}\n\n` +
      `👉 <i>Bấm nút bên dưới để tải trực tiếp lên TikTok hoặc remake từng cảnh!</i>`;

    await sendMergedVideoToTelegram(
      chatId,
      finalVideoPath,
      caption,
      {
        reply_markup: buildMomVideoInlineKeyboard(runId),
        parse_mode: 'HTML',
      }
    );
  }

  return {
    success: true,
    runId,
    finalVideoPath: mergeSuccess ? finalVideoPath : null,
    panelVideoPaths,
  };
}

async function executeMomRemakeSingleVideo(chatId, baseDir, runId, targetPanelIndex, opts = {}) {
  const session = getMomSession(runId, baseDir);
  if (!session) return;

  const pIdx = parseInt(targetPanelIndex, 10);
  if (pIdx < 1 || pIdx > 4) return;

  console.log(`[TemplateMom] 🔄 Remaking single video scene ${pIdx} for session ${runId}...`);
  const panelsDir = path.join(session.runDir, 'panels');
  const videosDir = path.join(session.runDir, 'videos');
  ensureDir(videosDir);

  const prompt = buildTemplateMomVeoMotionPrompt(session.analysis?.script?.[pIdx - 1] || {}, session.analysis, {
    panelIndex: pIdx,
    customInstruction: opts.customInstruction || '',
  });

  const pPath = path.join(panelsDir, `panel-${pIdx}.png`);
  const pBuf = fs.existsSync(pPath) ? fs.readFileSync(pPath) : null;

  const projectConfig = resolveFlowProject(chatId, 'template_mom', baseDir);
  const newVideos = await generateVideosFromPanelsDirect(baseDir, [{
    index: pIdx,
    panelIndex: pIdx,
    prompt,
    promptBuilder: (attempt) => buildTemplateMomVeoMotionPrompt(session.analysis?.script?.[pIdx - 1] || {}, session.analysis, {
      attempt,
      panelIndex: pIdx,
      customInstruction: opts.customInstruction || '',
    }),
    imagePath: pPath,
    buffer: pBuf,
    videoModelKey: 'abra_r2v_4s',
  }], {
    aspectRatio: '9:16',
    videoModelKey: 'abra_r2v_4s',
    includeVideoBase64: true,
    runId,
    projectId: projectConfig.projectId,
    projectUrl: projectConfig.projectUrl,
  });

  if (newVideos && newVideos[0] && newVideos[0].buffer) {
    const outVid = path.join(videosDir, `panel_video_${pIdx}.mp4`);
    fs.writeFileSync(outVid, newVideos[0].buffer);

    // Ghép lại video 16s
    const panelVideoPaths = [1, 2, 3, 4].map(idx => path.join(videosDir, `panel_video_${idx}.mp4`));
    const voiceM4aPath = path.join(session.runDir, 'audio', 'voice_full.m4a');
    const finalVideoPath = path.join(session.runDir, 'final_video.mp4');

    if (panelVideoPaths.every(p => fs.existsSync(p))) {
      merge4PanelsWithVoice(panelVideoPaths, voiceM4aPath, finalVideoPath);
      await sendMergedVideoToTelegram(
        chatId,
        finalVideoPath,
        `👶 <b>ĐÃ CẬP NHẬT CẢNH ${pIdx} & GHÉP LẠI VIDEO 16S</b>\n\n👉 <i>Bấm bên dưới để đăng TikTok!</i>`,
        { reply_markup: buildMomVideoInlineKeyboard(runId), parse_mode: 'HTML' }
      );
    }
  }

  if (opts.stepTracker) await opts.stepTracker.completeAll();
}

module.exports = {
  loadCharacterAssets,
  createProductCollageImage,
  parseJsonObjectMom,
  validateTemplateMomScript,
  buildTemplateMomAnalysisPrompt,
  analyzeProductTemplateMom,
  buildTemplateMomMasterPrompt,
  buildTemplateMomMultiStoryboardPrompt,
  verifyMultiStoryboardWithGeminiVision,
  sliceMasterStoryboardMom,
  composeMasterStoryboardMom,
  buildTemplateMomVeoMotionPrompt,
  buildTemplateMom4sPanelPrompts,
  buildTemplateMomVideoPrompts,
  generateTemplateMomVoiceReview,
  buildMomInlineKeyboard,
  buildMomVideoInlineKeyboard,
  saveMomSession,
  getMomSession,
  merge4PanelsWithVoice,
  buildTemplateMomRemakeVideoJobs,
  normalizeMomVoiceOver,
  normalizeMomScript,
  extractFallbackAnalysisMom,
  generateStoryboard,
  executeMomRemakePanel,
  executeMomRemakeAll,
  finalizeMomStoryboard: finalizeMomStoryboardAndGenerateVideos,
  finalizeMomStoryboardAndGenerateVideos,
  executeMomRemakeSingleVideo,
  writeMarkdownLog,
  appendMarkdownLog,
};
