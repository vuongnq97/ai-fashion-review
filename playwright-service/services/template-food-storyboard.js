'use strict';

/**
 * template-food-storyboard.js
 *
 * Pipeline Template Food Review (/tfood, /template_food):
 * - Kênh Review Đồ Ăn & Thức Uống (Food & Beverage Review channel).
 * - Định dạng: 4 cảnh × 6 giây = 24 giây tổng.
 * - Khung kịch bản: Discovery (Cảnh 1) → Show (Cảnh 2) → Experience (Cảnh 3) → Verdict (Cảnh 4).
 * - Bắt buộc có Hero Interaction ở Cảnh 3 (bẻ, xé, kéo, chấm, rót, tách nhân...).
 * - Start Frame tuân thủ Action Runway: vẽ lúc chuẩn bị thao tác để chừa không gian chuyển động 6s.
 * - Ngôn ngữ trải nghiệm tự nhiên miền Tây / Nam Bộ nhẹ nhàng, xưng "tui", không quảng cáo thô thiển.
 * - Gemini TTS giọng Zephyr / Leda với Director Prompt 24s (Section 29).
 * - Sinh video với model Veo 3 (veo_3_1_i2v_lite_low_priority) theo yêu cầu hệ thống.
 * - Interactive Storyboard Workflow: Duyệt và remake từng cảnh (1-4), Remake All, chốt OK để sinh 4 video 6s và ghép 24s.
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
const { createFlowPage, closeFlowPage } = require('./browser');
const { prepareGeneration, executeGeneration } = require('./image');
const { registerExternalCompletedJob, getJob } = require('./generation-job');
const { FlowStepTracker } = require('./flow-step-tracker');
const { getConfig } = require('../utils/config-manager');
const {
  pcmToWav,
  convertPcmToM4a,
  generateSpeechWithGemini,
  buildFoodReviewTtsPrompt,
  generateTemplateFoodVoiceReview,
} = require('./gemini-tts');

function normalizeHashtags(raw, defaultTags = ['#reviewdoan', '#foodreview', '#anngon', '#tiktokshop', '#trending']) {
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map(t => (t.startsWith('#') ? t : `#${t}`)).filter(Boolean);
  }
  return defaultTags;
}

// In-memory cache for active /tfood sessions: runId -> sessionData
const foodSessions = new Map();

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

// ── 1. SESSION MANAGEMENT ─────────────────────────────────────────────────────

function saveFoodSession(runId, sessionData) {
  if (!runId || !sessionData) return;
  const strId = String(runId);
  foodSessions.set(strId, sessionData);
  if (sessionData.jobId && String(sessionData.jobId) !== strId) {
    foodSessions.set(String(sessionData.jobId), sessionData);
  }
  if (sessionData.runDir) {
    try {
      const sessFile = path.join(sessionData.runDir, 'session.json');
      const sanitized = { ...sessionData };
      delete sanitized.stepTracker;
      fs.writeFileSync(sessFile, JSON.stringify(sanitized, null, 2), 'utf8');
    } catch (_) {}
  }
}

function getFoodSession(runId, baseDir = null) {
  if (!runId) return null;
  const strId = String(runId);
  if (foodSessions.has(strId)) return foodSessions.get(strId);

  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const runsDir = path.join(effectiveBaseDir, 'storyboard-review-runs');
  if (!fs.existsSync(runsDir)) return null;

  try {
    const dirs = fs.readdirSync(runsDir);
    for (const d of dirs) {
      if (d.includes(`tfood-flow-${strId}`) || d.includes(`template_food-flow-${strId}`) || d.endsWith(`-${strId}`) || d === strId) {
        const sessFile = path.join(runsDir, d, 'session.json');
        if (fs.existsSync(sessFile)) {
          const loaded = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
          loaded.runDir = path.join(runsDir, d);
          foodSessions.set(strId, loaded);
          if (loaded.runId) foodSessions.set(loaded.runId, loaded);
          if (loaded.jobId) foodSessions.set(loaded.jobId, loaded);
          return loaded;
        }
      }
    }
    // Fallback: check latest session.json files
    for (const d of dirs.reverse().slice(0, 15)) {
      const sessFile = path.join(runsDir, d, 'session.json');
      if (fs.existsSync(sessFile)) {
        try {
          const loaded = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
          if (loaded.runId === strId || loaded.jobId === strId || (loaded.runDir && loaded.runDir.includes(strId))) {
            loaded.runDir = path.join(runsDir, d);
            foodSessions.set(strId, loaded);
            return loaded;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  return null;
}

// ── 2. JSON PARSING & SCRIPT VALIDATION ──────────────────────────────────────

function parseJsonObjectFood(rawText) {
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
        console.warn('[TemplateFood] JSON parse fallback failed:', e2.message);
      }
    }
  }
  return null;
}

// ── 2.1 FOOD FORM TAXONOMY & PHYSICAL ENGINE (SPEC v3) ───────────────────────

const FOOD_FORM_TAXONOMY = [
  'whole_small_unit',
  'whole_medium_unit',
  'bar_block',
  'slice',
  'filled_pastry',
  'crispy_sheet',
  'dried_strip',
  'shredded_food',
  'granular_food',
  'paste',
  'sauce',
  'spread',
  'powder',
  'liquid',
  'jelly',
  'noodle',
  'rice_topping',
  'mixed_snack',
  'fresh_fruit',
  'dried_fruit',
  'nuts_seeds',
  'candy',
];

/**
 * Phân loại vai trò của các ảnh tham chiếu (Section 18)
 */
function classifyReferenceRoles(filePayloads = [], analysis = {}) {
  // Spec §5.2: roles must match FoodProductEvidence schema
  // packaging | product_whole | product_opened | texture | prepared | usage | environment | unknown
  const specRoles = {
    packaging: [],
    product_whole: [],
    product_opened: [],
    texture: [],
    prepared: [],
    usage: [],
    environment: [],
    unknown: []
  };
  // Per-image metadata for confidence-aware planning (spec §19 / v2-spec §19)
  const imageMetadata = [];

  if (!Array.isArray(filePayloads) || filePayloads.length === 0) {
    return {
      ...specRoles,
      // backward-compat aliases for existing call sites
      package: [], foodCloseup: [], serving: [], interaction: [],
      imageMetadata,
      hasInteriorEvidence: false,
      hasTextureEvidence: false,
      hasPreparedEvidence: false
    };
  }

  filePayloads.forEach((fp, idx) => {
    const name = String(fp.name || fp.path || `ref_${idx + 1}`).toLowerCase();
    const id = fp.id || fp.name || `ref_${idx + 1}`;
    let assignedRole = 'unknown';
    let confidence = 0.5;
    const verifiedObservations = [];

    if (name.includes('open') || name.includes('inside') || name.includes('nhan') || name.includes('filling') || name.includes('interior') || name.includes('cut')) {
      assignedRole = 'product_opened';
      confidence = 0.85;
      verifiedObservations.push('interior_visible');
    } else if (name.includes('texture') || name.includes('macro') || name.includes('close') || name.includes('can') || name.includes('detail')) {
      assignedRole = 'texture';
      confidence = 0.8;
      verifiedObservations.push('texture_detail_visible');
    } else if (name.includes('serve') || name.includes('dia') || name.includes('dish') || name.includes('plate') || name.includes('bowl') || name.includes('prep')) {
      assignedRole = 'prepared';
      confidence = 0.75;
      verifiedObservations.push('served_state_visible');
    } else if (name.includes('hand') || name.includes('tay') || name.includes('action') || name.includes('grip') || name.includes('use') || name.includes('demo')) {
      assignedRole = 'usage';
      confidence = 0.8;
      verifiedObservations.push('hand_interaction_visible');
    } else if (name.includes('env') || name.includes('scene') || name.includes('room') || name.includes('store') || name.includes('shop')) {
      assignedRole = 'environment';
      confidence = 0.75;
      verifiedObservations.push('environment_context_visible');
    } else if (name.includes('pack') || name.includes('box') || name.includes('bao') || name.includes('tui') || name.includes('hop') || name.includes('label') || idx === 0) {
      assignedRole = 'packaging';
      confidence = idx === 0 ? 0.7 : 0.8;
      verifiedObservations.push('packaging_visible');
    } else if (idx > 0) {
      assignedRole = 'product_whole';
      confidence = 0.5;
      verifiedObservations.push('product_visible');
    } else {
      assignedRole = 'unknown';
      confidence = 0.3;
    }

    specRoles[assignedRole].push(id);
    imageMetadata.push({ id, source: fp.path || fp.name || id, role: assignedRole, confidence, verifiedObservations });
  });

  const hasInteriorEvidence = specRoles.product_opened.length > 0;
  const hasTextureEvidence = specRoles.texture.length > 0;
  const hasPreparedEvidence = specRoles.prepared.length > 0;

  return {
    ...specRoles,
    // backward-compat aliases for existing call sites
    package: specRoles.packaging,
    foodCloseup: [...specRoles.texture, ...specRoles.product_whole],
    serving: specRoles.prepared,
    interaction: specRoles.usage,
    imageMetadata,
    hasInteriorEvidence,
    hasTextureEvidence,
    hasPreparedEvidence
  };
}


/**
 * Phân tích cấu trúc vật lý thực phẩm (Food Physical Profile - Section 5)
 */
function analyzeFoodPhysicalProfile(analysis = {}, refs = {}) {
  const prodName = String(analysis.productName || '').toLowerCase();
  const cat = String(analysis.foodCategory || '').toLowerCase();
  const desc = String(analysis.originStory || analysis.primarySensoryAngle || '').toLowerCase();
  const combined = `${prodName} ${cat} ${desc}`;

  let form = 'whole_small_unit';
  let unitScale = 'small';
  let isBreakableByHand = false;
  let isTearableByHand = false;
  let isSqueezableMeaningfully = false;
  let isScoopable = false;
  let isSpreadable = false;
  let isPourable = false;
  let isDippable = false;
  let hasInteriorReveal = false;
  let hasFilling = false;
  let hasShell = false;
  let cohesion = 'medium';
  let hardness = 'medium';
  let brittleness = 'medium';
  let viscosity = 'none';
  let servedWith = [];
  let scaleCueNeeded = false;

  // 1. Món mì / bún / phở / miến / hủ tiếu / pasta / ramen (Noodles - Bắt buộc dùng đũa/nĩa, cấm bốc tay)
  if (
    combined.includes('mì') || combined.includes('mi ') || combined.includes('mì tươi') ||
    combined.includes('mì gói') || combined.includes('mì tôm') || combined.includes('mì xào') ||
    combined.includes('phở') || combined.includes('pho') ||
    combined.includes('bún') || combined.includes('bun') ||
    combined.includes('miến') || combined.includes('mien') ||
    combined.includes('hủ tiếu') || combined.includes('hu tieu') ||
    combined.includes('bánh canh') || combined.includes('banh canh') ||
    combined.includes('noodle') || combined.includes('ramen') || combined.includes('udon') ||
    combined.includes('soba') || combined.includes('spaghetti') || combined.includes('pasta')
  ) {
    form = 'noodle';
    unitScale = 'bulk';
    isBreakableByHand = false;
    isTearableByHand = false;
    isSqueezableMeaningfully = false;
    isScoopable = true;
    cohesion = 'long_strands';
    viscosity = 'sauced_or_broth';
    hardness = 'soft_chewy';
    brittleness = 'chewy_elastic';
    servedWith = ['đôi đũa gỗ', 'bát tô sứ sâu lòng', 'thìa múc xốt'];
    scaleCueNeeded = true;
  }
  // 2. Món ăn nấu chín nóng / cơm / cháo / súp / lẩu / món kho / món xào
  else if (
    combined.includes('cơm') || combined.includes('com ') || combined.includes('cháo') ||
    combined.includes('chao ') || combined.includes('súp') || combined.includes('sup ') ||
    combined.includes('lẩu') || combined.includes('thịt kho') || combined.includes('món xào') ||
    combined.includes('món kho')
  ) {
    form = 'cooked_dish';
    unitScale = 'bulk';
    isBreakableByHand = false;
    isTearableByHand = false;
    isSqueezableMeaningfully = false;
    isScoopable = true;
    cohesion = 'dense_chunks';
    viscosity = 'sauced';
    servedWith = ['thìa sứ', 'đũa gỗ', 'chén cơm trắng'];
    scaleCueNeeded = true;
  }
  // 3. Dạng hạt nhỏ (nuts_seeds, coated peanuts, seeds)
  else if (combined.includes('đậu phộng') || combined.includes('dau phong') || combined.includes('hạt điều') || combined.includes('macca') || combined.includes('hướng dương') || combined.includes('peanut') || combined.includes('nut') || combined.includes('seed')) {
    form = 'nuts_seeds';
    unitScale = 'tiny';
    isBreakableByHand = false;
    isTearableByHand = false;
    isSqueezableMeaningfully = false;
    isPourable = true;
    scaleCueNeeded = true;
    hardness = 'hard';
    brittleness = 'crispy';
    servedWith = ['trà nóng', 'nước giải khát'];
  }
  // 4. Món mặn ăn kèm / topping cơm / thịt chưng / mắm tép / ruốc / chà bông
  else if (combined.includes('mắm tép') || combined.includes('mam tep') || combined.includes('thịt chưng') || combined.includes('chà bông') || combined.includes('ruốc') || combined.includes('kho quẹt')) {
    form = 'rice_topping';
    unitScale = 'bulk';
    isScoopable = true;
    isSpreadable = true;
    isBreakableByHand = false;
    isTearableByHand = false;
    isSqueezableMeaningfully = false;
    cohesion = 'loose_shreds';
    viscosity = 'moist';
    servedWith = ['cơm trắng nóng', 'xôi', 'cháo trắng'];
  }
  // 5. Bánh có nhân bên trong (filled_pastry, bánh pía, bánh bao, bánh trung thu)
  else if (combined.includes('bánh pía') || combined.includes('banh pia') || combined.includes('trung thu') || combined.includes('bánh bao') || combined.includes('pastry') || combined.includes('nhân') || combined.includes('filled')) {
    form = 'filled_pastry';
    unitScale = 'small';
    isBreakableByHand = true;
    hasInteriorReveal = true;
    hasFilling = true;
    cohesion = 'soft_dense';
    brittleness = 'soft_flaky';
    servedWith = ['trà lài nóng', 'trà ô long'];
  }
  // 6. Đồ khô dạng thanh / dải (khô bò, khô gà, mứt dẻo, khoai lang sấy dẻo)
  else if (combined.includes('khô bò') || combined.includes('khô gà') || combined.includes('thanh') || combined.includes('sấy dẻo') || combined.includes('strip')) {
    form = 'dried_strip';
    unitScale = 'medium';
    isTearableByHand = true;
    isDippable = true;
    isBreakableByHand = false;
    isSqueezableMeaningfully = false;
    cohesion = 'fibrous';
    servedWith = ['tương ớt', 'chanh tắc'];
  }
  // 7. Đồ uống / chất lỏng
  else if (cat.includes('drink') || combined.includes('trà') || combined.includes('cà phê') || combined.includes('nước') || combined.includes('sữa')) {
    form = 'liquid';
    unitScale = 'liquid';
    isPourable = true;
    isBreakableByHand = false;
    isTearableByHand = false;
    isSqueezableMeaningfully = false;
    viscosity = 'fluid';
  }
  // 8. Sốt / tương chấm
  else if (cat.includes('sauce') || combined.includes('sốt') || combined.includes('tương') || combined.includes('chấm')) {
    form = 'sauce';
    unitScale = 'liquid';
    isScoopable = true;
    isSpreadable = true;
    isPourable = true;
    isDippable = true;
    isBreakableByHand = false;
    isTearableByHand = false;
    isSqueezableMeaningfully = false;
    viscosity = 'viscous';
  }
  // 9. Mặc định bánh kẹo snack thông thường
  else {
    form = 'whole_small_unit';
    unitScale = 'small';
    isBreakableByHand = (cat.includes('cake') || cat.includes('pastry') || cat.includes('bánh'));
    isSqueezableMeaningfully = false;
    servedWith = ['trà nóng'];
  }

  return {
    form,
    unitScale,
    cohesion,
    hardness,
    brittleness,
    viscosity,
    hasInteriorReveal,
    hasFilling,
    hasShell,
    isPourable,
    isScoopable,
    isSpreadable,
    isDippable,
    isBreakableByHand,
    isTearableByHand,
    isSqueezableMeaningfully,
    servedWith,
    scaleCueNeeded,
  };
}

/**
 * Trích xuất danh sách hành động cấm theo đặc tính thực phẩm (Section 6, 7, 8)
 */
function deriveForbiddenFoodActions(profile = {}) {
  const forbidden = ['invent_new_form', 'cgi_look', 'unnatural_morph'];
  const unitScale = profile.unitScale || 'medium';
  const form = profile.form || '';

  // Món mì, bún, phở, đồ nấu chín: CẤM TUYỆT ĐỐI dùng tay trần bốc/nhón/nắm/bẻ/bóp
  if (form === 'noodle' || form === 'cooked_dish') {
    forbidden.push(
      'bare_hand_contact',
      'pick_with_fingers',
      'hand_grab',
      'bare_hands_on_food',
      'eating_noodles_with_bare_hands',
      'pinching_food_directly',
      'break',
      'tear',
      'squeeze',
      'crush'
    );
  }

  // Hạt nhỏ: cấm bẻ, xé, bóp, nghiền nát, cưỡng ép xem nhân
  if (unitScale === 'tiny' || form === 'nuts_seeds') {
    forbidden.push('break', 'tear', 'squeeze', 'crush', 'force_interior_reveal');
  }

  // Món mặn / cơm / sốt sệt: cấm bẻ, cấm biến thành khối bánh cứng
  if (form === 'rice_topping' || form === 'paste' || form === 'granular_food' || form === 'shredded_food') {
    forbidden.push('break', 'tear', 'crack', 'chunk_mutation', 'squeeze');
  }

  // Chất lỏng: cấm bẻ, xé, nhai
  if (form === 'liquid') {
    forbidden.push('break', 'tear', 'squeeze', 'chew', 'pick');
  }

  // Nếu không thể bẻ bằng tay
  if (!profile.isBreakableByHand && !forbidden.includes('break')) {
    forbidden.push('break');
  }

  // Nếu không thể bóp có ý nghĩa
  if (!profile.isSqueezableMeaningfully && !forbidden.includes('squeeze')) {
    forbidden.push('squeeze');
  }

  return [...new Set(forbidden)];
}

/**
 * Động cơ Affordance: Chọn hành vi hợp lý nhất cho món ăn (Section 6, 12)
 */
function deriveFoodAffordances(profile = {}, refs = {}) {
  const form = profile.form || 'whole_small_unit';
  const unitScale = profile.unitScale || 'small';
  const forbiddenActions = deriveForbiddenFoodActions(profile);

  let recommendedActions = [];
  let allowedActions = [];
  let heroAction = 'inspect';
  let heroActionReason = 'Quan sát cận cảnh chất lượng và màu sắc sản phẩm';
  let sensoryEvidence = 'bề mặt và chi tiết chân thực';

  if (form === 'noodle') {
    recommendedActions = ['lift_with_chopsticks', 'twirl_with_fork', 'scoop_with_spoon'];
    allowedActions = ['lift_with_chopsticks', 'twirl_with_fork', 'scoop_with_spoon', 'stir_with_chopsticks', 'lift_bowl'];
    heroAction = 'lift_with_chopsticks';
    heroActionReason = 'Dùng đôi đũa gỗ gắp một vắt mì tươi óng ả nâng nhẹ lên cao từ bát/đĩa, sợi mì dai mướt bốc khói nhẹ quyện xốt đậm đà; TUYỆT ĐỐI KHÔNG dùng tay bốc mì, tay chỉ cầm đũa ở phía trên.';
    sensoryEvidence = 'sợi mì tươi dai mướt, bóng bẩy ngập tràn xốt bò đậm đà và bốc khói nghi ngút';
  } else if (form === 'cooked_dish') {
    recommendedActions = ['scoop_with_spoon', 'lift_with_chopsticks'];
    allowedActions = ['scoop_with_spoon', 'lift_with_chopsticks', 'stir'];
    heroAction = 'scoop_with_spoon';
    heroActionReason = 'Dùng thìa sứ hoặc đũa gỗ múc/gắp món ăn nóng hổi; tuyệt đối không dùng tay trần bốc thức ăn.';
    sensoryEvidence = 'độ mềm mọng, đậm đà, bóng bẩy và bốc khói thơm phức';
  } else if (unitScale === 'tiny' || form === 'nuts_seeds') {
    recommendedActions = ['pick', 'rotate', 'pour', 'show_handful', 'show_scale'];
    allowedActions = ['pick', 'rotate', 'pour', 'show_handful', 'show_scale', 'shake', 'macro_surface'];
    heroAction = 'pick';
    heroActionReason = 'Nhón một hạt giữa ngón cái và ngón trỏ, xoay nhẹ trước camera để khoe lớp vỏ áo đều và kích cỡ hạt.';
    sensoryEvidence = 'lớp vỏ giòn rụm áo đều và tỷ lệ hạt nhỏ gọn vừa miệng';
  } else if (form === 'rice_topping' || form === 'paste' || form === 'granular_food') {
    recommendedActions = ['scoop', 'spread', 'lift', 'mix_with_rice'];
    allowedActions = ['scoop', 'spread', 'lift', 'mix_with_rice', 'stir', 'drizzle'];
    heroAction = 'scoop';
    heroActionReason = 'Dùng thìa múc một lượng vừa vặn từ hũ để lộ độ tơi xốp, đậm đà và ánh dầu hấp dẫn.';
    sensoryEvidence = 'thớ thịt/topping ẩm mọng, tơi xốp, đậm đà óng ánh';
  } else if (form === 'filled_pastry' || profile.hasInteriorReveal) {
    recommendedActions = ['break_open', 'break', 'pull', 'peel'];
    allowedActions = ['break_open', 'break', 'pull', 'peel', 'lift', 'show_scale'];
    heroAction = 'break_open';
    heroActionReason = 'Hai tay nhẹ nhàng bẻ đôi chiếc bánh làm lộ rõ lớp nhân dẻo ngập tràn bên trong.';
    sensoryEvidence = 'lớp nhân đầy đặn, mềm dẻo và vỏ bánh xốp mịn';
  } else if (form === 'dried_strip') {
    recommendedActions = ['tear', 'dip', 'pull'];
    allowedActions = ['tear', 'dip', 'pull', 'lift', 'rotate'];
    heroAction = 'tear';
    heroActionReason = 'Dùng tay xé nhẹ theo thớ thịt để chứng minh độ dai mềm tự nhiên.';
    sensoryEvidence = 'thớ thịt dai mềm óng ả không bị khô cứng';
  } else if (form === 'liquid') {
    recommendedActions = ['open', 'pour', 'show_flow', 'swirl'];
    allowedActions = ['open', 'pour', 'show_flow', 'swirl', 'lift_glass'];
    heroAction = 'pour';
    heroActionReason = 'Rót dòng nước sóng sánh vào ly thủy tinh đá lạnh để khoe màu sắc và độ tươi mát.';
    sensoryEvidence = 'độ sóng sánh, bọt mịn và màu sắc tươi mát';
  } else {
    recommendedActions = ['rotate', 'lift', 'show_scale'];
    allowedActions = ['rotate', 'lift', 'show_scale', 'pick'];
    heroAction = 'rotate';
    heroActionReason = 'Xoay nhẹ sản phẩm trước camera để thấy rõ độ hoàn thiện và chi tiết bề mặt.';
    sensoryEvidence = 'chi tiết bề mặt giòn rụm và màu sắc bắt mắt';
  }

  return {
    recommendedActions,
    allowedActions,
    forbiddenActions,
    heroAction,
    heroActionReason,
    sensoryEvidence,
  };
}

/**
 * Chọn Hero Interaction tối ưu (Section 12)
 */
function chooseHeroInteraction(profile = {}, affordance = {}, refs = {}) {
  const action = affordance.heroAction || 'inspect';

  // Spec §6 — Hero Interaction must include startState, fallbackAction, claimIds, referenceIds
  // startState: what the product looks like before the action begins (action runway §8.3 0-1s)
  const startStateMap = {
    break_open:           'Whole product on surface, both hands positioned on opposite sides, light contact — ready to pull apart',
    tear:                 'Product held firmly at both ends, slight tension applied at center — fibres about to separate',
    pour:                 'Container tilted 30° over receiving vessel, product just reaching the lip — flow about to begin',
    scoop:                'Spoon inserted under product inside container, slightly loaded — ready to lift',
    pick:                 'One unit naturally pinched between thumb and index finger with clearance to rotate',
    rotate:               'Product held lightly between fingertips, camera at macro distance — ready to turn',
    lift_with_chopsticks: 'Chopsticks gripping a portion in bowl, still touching surface — ready to raise',
    dip:                  'Food piece held above sauce at slight angle — wrist oriented for downward motion',
    lift:                 'Hand beneath product, fingers spread for stable grip — beginning upward motion',
    show_scale:           'One unit held flat in open palm close to camera — scale reference ready',
    show_handful:         'Open palm with multiple units near camera at comfortable angle',
    inspect:              'Product on surface, hand hovering nearby — reviewer leaning in for close look'
  };

  // fallbackAction: safe conservative action when hero action is not physically feasible
  const fallbackMap = {
    break_open:           refs.hasInteriorEvidence ? 'lift' : 'rotate',
    tear:                 'lift',
    pour:                 'show_handful',
    scoop:                'show_scale',
    pick:                 'show_handful',
    rotate:               'show_scale',
    lift_with_chopsticks: 'show_scale',
    dip:                  'lift',
    lift:                 'rotate',
    show_scale:           'rotate',
    show_handful:         'show_scale',
    inspect:              'show_scale'
  };

  // referenceIds: which reference images support this interaction choice
  const referenceIds = [];
  if (refs && refs.imageMetadata) {
    refs.imageMetadata.forEach(img => {
      if (['texture', 'product_opened', 'usage', 'prepared'].includes(img.role) && img.confidence >= 0.6) {
        referenceIds.push(img.id);
      }
    });
  }
  if (referenceIds.length === 0 && refs && refs.imageMetadata && refs.imageMetadata.length > 0) {
    referenceIds.push(refs.imageMetadata[0].id);
  }

  // claimIds: which evidence claims this interaction proves (spec §6 Hero Interaction contract)
  const claimIds = [];
  if (action === 'break_open' || action === 'tear') { claimIds.push('interior_visible', 'texture_real'); }
  if (action === 'pour' || action === 'show_handful') { claimIds.push('quantity_visible', 'portionable'); }
  if (action === 'scoop') { claimIds.push('texture_real', 'scoopable'); }
  if (action === 'pick' || action === 'rotate') { claimIds.push('unit_scale_visible', 'coating_visible'); }
  if (action === 'lift_with_chopsticks') { claimIds.push('noodle_texture', 'sauce_coating'); }
  if (action === 'dip') { claimIds.push('dippable', 'sauce_visible'); }

  return {
    action,
    actionReason:   affordance.heroActionReason || 'Thao tác tự nhiên làm nổi bật chất lượng món ăn',
    sensoryTarget:  affordance.sensoryEvidence || 'đặc tính vị giác hấp dẫn',
    visualTarget:   affordance.sensoryEvidence || 'kết cấu chân thực',
    performedBy:    'reviewer_hand',
    shotType:       'macro',
    scene:          3,
    // Spec §6 additions
    startState:     startStateMap[action] || `Product in natural resting state — action "${action}" about to begin`,
    fallbackAction: fallbackMap[action] || 'rotate',
    claimIds,
    referenceIds
  };
}


/**
 * Xây dựng Product State Machine (Section 14)
 */
function buildProductStateMachine(profile = {}, heroAction = '', dynamicPlan = {}) {
  const form = profile.form || 'snack';
  const unitScale = profile.unitScale || 'medium';

  if (form === 'noodle') {
    return {
      initial: 'Gói/hộp mì còn nguyên vẹn trên bàn gỗ tự nhiên cạnh bát tô và đôi đũa.',
      scene1End: 'Bao bì gói mì được tay người review nâng nhẹ giới thiệu trước ống kính.',
      scene2End: 'Bát mì chín vàng óng đậm đà bốc khói nhẹ, đôi đũa gỗ đặt ngay ngắn kế bên.',
      scene3End: 'Đôi đũa gỗ gắp một vắt mì tươi óng ánh nâng lên cao từ bát, sợi mì dai mướt đẫm xốt bốc khói.',
      scene4End: 'Bát mì thơm lừng đặt cạnh đũa trên bàn ăn ấm cúng, kết thúc ngon mắt.'
    };
  } else if (form === 'cooked_dish') {
    return {
      initial: 'Nguyên liệu/hộp sản phẩm trên bàn gỗ ấm áp.',
      scene1End: 'Giới thiệu món ăn đặc sản trước camera.',
      scene2End: 'Món ăn nấu chín nóng hổi bày ra đĩa sâu lòng.',
      scene3End: 'Dùng thìa sứ hoặc đũa nâng phần thức ăn thơm ngon bốc khói.',
      scene4End: 'Món ăn hoàn tất mời gọi bên mâm cơm ấm cúng.'
    };
  } else if (unitScale === 'tiny' || form === 'nuts_seeds') {
    return {
      initial: 'Gói sản phẩm còn nguyên vẹn trên bàn gỗ tự nhiên cạnh tách trà.',
      scene1End: 'Bao bì được tay người review giới thiệu trước ống kính, khơi gợi tò mò.',
      scene2End: 'Một nắm hạt được trút ra đĩa gốm mộc, phô bày kích thước đồng đều và lớp vỏ áo giòn.',
      scene3End: 'Một hạt được nhón giữa hai đầu ngón tay xoay chậm cận cảnh macro.',
      scene4End: 'Nắm hạt trong lòng bàn tay đưa gần camera, hoàn tất bằng lời rủ rê ăn vặt hấp dẫn.'
    };
  } else if (form === 'rice_topping' || form === 'paste' || form === 'granular_food') {
    return {
      initial: 'Hũ sản phẩm đậy kín nắp đặt ngay ngắn trên bàn ăn gia đình.',
      scene1End: 'Hũ sản phẩm được tay người review nâng nhẹ khoe nhãn mác đặc sản.',
      scene2End: 'Nắp hũ mở ra để lộ thớ món ăn đậm đà, óng ánh thơm phức.',
      scene3End: 'Chiếc thìa gỗ múc một phần đầy đặn nâng lên từ lòng hũ.',
      scene4End: 'Thìa món ăn rưới lên bát cơm trắng nóng hổi bốc khói nhẹ, kích thích vị giác cực độ.'
    };
  } else if (form === 'filled_pastry' || profile.hasInteriorReveal) {
    return {
      initial: 'Hộp hoặc gói bánh nguyên bản trên bàn gỗ ấm áp.',
      scene1End: 'Bao bì bánh được khoe tự nhiên trước camera.',
      scene2End: 'Một chiếc bánh vàng ươm đặt trên đĩa sứ mộc, thấy rõ lớp vỏ hoàn thiện.',
      scene3End: 'Hai bàn tay nhẹ nhàng bẻ đôi chiếc bánh, tách mở phần nhân mềm dẻo béo ngậy.',
      scene4End: 'Hai nửa chiếc bánh đẫm nhân đưa sát camera mời gọi thưởng thức.'
    };
  }

  return {
    initial: 'Bao bì sản phẩm nguyên vẹn trên bàn gỗ tự nhiên.',
    scene1End: 'Bao bì được tay người review giới thiệu tạo tò mò.',
    scene2End: 'Món ăn bày trên đĩa quan sát độ dày và lớp phủ ngoài.',
    scene3End: `Thao tác ${heroAction || 'thưởng thức'} làm lộ rõ kết cấu chân thực.`,
    scene4End: 'Món ăn hoàn thiện giơ cận cảnh chào đón người xem trải nghiệm.'
  };
}

/**
 * Xây dựng Food Review World Bible (Section 4 - Chuẩn Visual DNA Kênh Review Tạp Hoá Tuổi Thơ & Góc Bàn Trà)
 */
function getFoodEnvironmentBible(analysis = {}, options = {}) {
  const fullAnalysis = analysis.analysis || analysis || {};
  const prodName = fullAnalysis.productName || options.productTitle || '';
  const category = fullAnalysis.foodCategory || '';
  const settingKey = options.sourcingSetting || fullAnalysis.sourcingSetting || detectSourcingSetting(prodName, category, options);

  const environments = {
    tea_table: {
      key: 'tea_table',
      title: 'Cozy Vietnamese Tea Table Tasting Corner',
      surface: 'warm natural honey-oak wooden dining table with visible rich wood grain',
      promptFragment: 'Cozy authentic Vietnamese home tea table and tasting corner. In the background bokeh: an elegant slender white ceramic vase with fresh blooming flowers (white roses, baby breath, or daisies), a small ceramic pot with lush green lucky bamboo (cây phát tài), and a traditional rustic ceramic teapot with warm golden tea in small matching cups, illuminated by soft natural side-window sunlight.',
      continuity: 'Use ONE identical physical tasting corner across all 4 panels: same honey-oak wooden tabletop surface, same background prop arrangement (white ceramic vase with fresh blooming flowers, potted lucky bamboo, and ceramic teapot set), same warm natural window daylight. Panel 1 presents the unopened product packaging in front of this cozy tea table; Panel 2 shows the food unpackaged and arranged on the table serving plate; Panel 3 shows close-up food interaction on this table; Panel 4 shows the appetizing bite presented beside the teacup. ABSOLUTELY ZERO room changes or background drift.',
      forbidden: 'sterile white backdrop, modern luxury marble restaurant, CGI kitchen, outdoor street scene, floating frames, black borders.'
    },
    specialty_shop: {
      key: 'specialty_shop',
      title: 'Specialty Vietnamese Snack Shop & Retail Counter',
      surface: 'light natural wood or clean white retail tasting counter',
      promptFragment: 'Specialty Vietnamese snack store and traditional dry-goods retail shop (Tạp Hoá Cóc style). In the background: floor-to-ceiling wooden merchandise shelves neatly organized with transparent plastic containers with bright red lids, standing kraft and silver zip pouches of dried delicacies, sampling wicker baskets, and an open airy shopfront with soft natural daylight.',
      continuity: 'Use ONE identical specialty snack shop interior across all 4 panels: same background merchandise shelves with red-lid snack containers and standing pouches, same counter surface, same authentic retail lighting. Panel 1 showcases the package against the shelves; Panel 2 shows the product arranged on the shop tasting tray; Panel 3 shows texture inspection at the counter; Panel 4 presents the delicious snack ready to enjoy. ABSOLUTELY ZERO switching between shop and unrelated rooms.',
      forbidden: 'sterile studio, empty table, unrelated home kitchen, dark warehouse, black borders.'
    },
    bakery_workshop: {
      key: 'bakery_workshop',
      title: 'Artisan Vietnamese Bakery Production Workshop',
      surface: 'clean stainless steel bakery prep table or wooden baker cutting board',
      promptFragment: 'Artisan Vietnamese commercial bakery production workshop. In the background: large commercial stainless steel multi-deck baking ovens with warm interior glow, tall rolling multi-tier bakery racks holding baking trays full of golden round freshly baked pastries, clean workshop lighting, and bakery staff wearing sanitary white shirts and blue hairnets.',
      continuity: 'Use ONE identical artisan bakery workshop across all 4 panels: same commercial baking ovens and tall rolling racks with trays of golden pastries in the background, clean bright workshop lighting. Panel 1 presents the freshly packed pastry bag in front of the bakery ovens; Panel 2 displays the golden pastries on a baking tray; Panel 3 breaks open the warm pastry revealing rich filling; Panel 4 presents the mouth-watering pastry cross-section. ABSOLUTELY ZERO scene jumping.',
      forbidden: 'sterile studio, residential living room, tea table with unrelated tea cups, black borders.'
    },
    market_stall: {
      key: 'market_stall',
      title: 'Traditional Vietnamese Wet Market Stall',
      surface: 'rustic wooden stall counter or traditional woven bamboo wicker tray (mẹt tre)',
      promptFragment: 'Authentic traditional Vietnamese wet market stall (sạp đồ khô / sạp mắm chợ truyền thống). In the background: corrugated metal market roof rafters, open burlap sacks and round woven bamboo baskets overflowing with regional dried specialties, shelves with bottles of fish sauce and fermented jars with red plastic handles, hanging product signage in Vietnamese, and soft ambient market light.',
      continuity: 'Use ONE identical traditional market stall across all 4 panels: same open burlap sacks, woven wicker baskets of dried goods, and authentic market stall display in the background. Panel 1 showcases the package in front of the stall display; Panel 2 shows the food presented on a traditional bamboo tray/banana leaf; Panel 3 shows hands interacting with the food; Panel 4 presents the appetizing portion ready to eat. ABSOLUTELY ZERO scene jumping.',
      forbidden: 'sterile studio, sterile modern supermarket, high-tech kitchen, black borders.'
    },
    home_kitchen: {
      key: 'home_kitchen',
      title: 'Vietnamese Home Cooking Kitchen',
      surface: 'warm domestic kitchen counter with wooden cutting board and clean tile backsplash',
      promptFragment: 'Lived-in cozy Vietnamese domestic home kitchen. In the background: a large stainless steel cooking pot on a domestic cooktop, stainless steel ladle, clean kitchen tile backsplash, glass dessert bowls, and warm natural kitchen lighting.',
      continuity: 'Use ONE identical home kitchen counter across all 4 panels: same cooking pot, ladle, and clean domestic kitchen counter in the background. Panel 1 presents the package of ingredients next to the pot; Panel 2 shows the freshly cooked dish in a bowl/pot; Panel 3 ladles or scoops the glistening food; Panel 4 presents a delicious spoonful ready to taste. ABSOLUTELY ZERO scene jumping.',
      forbidden: 'sterile studio, commercial restaurant kitchen, empty table, black borders.'
    }
  };

  return environments[settingKey] || environments.tea_table;
}

/**
 * Xây dựng Food Review World Bible (Section 4 - Chuẩn Visual DNA Kênh Review Tạp Hoá Tuổi Thơ & Góc Bàn Trà)
 */
function buildFoodReviewWorld(productCategory = '', options = {}) {
  const env = getFoodEnvironmentBible({ foodCategory: productCategory }, options);
  return {
    environment: env.key === 'tea_table' ? 'cozy Vietnamese home tea & snack tasting corner (lifestyle reviewer set)' : env.title,
    surface: env.surface,
    backgroundDecor: env.promptFragment,
    beverageProps: 'traditional white ceramic teapot with warm golden tea in small ceramic cups, tall glass of iced soy milk with straw, or clear glass pitcher of iced lemon tea with lemon slices',
    servingVessels: 'hand-woven round bamboo tray (mẹt tre) lined with clean green banana leaf, cute scalloped white porcelain dipping saucer with red chili sauce, and rustic stoneware plates',
    lighting: 'bright soft natural side-window daylight streaming across the wooden table, gentle golden rim highlights on food surface, creamy natural depth of field (bokeh)',
    cameraLook: 'authentic 4K smartphone food review, natural handheld feel, macro sharpness on food, zero artificial studio filter',
    depth: 'foreground food and reviewer hands ultra-sharp, background softly readable with natural organic bokeh',
    propDensity: 'medium',
    propLayers: {
      foreground: 'product packaging / freshly served food piece / manicured female hand interaction',
      midground: 'round woven bamboo tray (mẹt tre) / scalloped dipping saucer / ceramic serving plate',
      background: env.promptFragment,
    },
    forbiddenLook: [
      'empty studio table',
      'luxury restaurant plating',
      'commercial catalogue backdrop',
      'CGI kitchen',
      'overdecorated influencer set',
      'sterile seamless background',
      'bare modern marble table',
      'black borders between panels'
    ]
  };
}

/**
 * Tự động phát hiện bối cảnh ẩm thực (Food Environment Setting)
 * Lấy cảm hứng từ 21 hình ảnh thực tế kênh Tạp Hoá Cóc:
 * - bakery_workshop: Lò nướng bánh công nghiệp, xe đẩy khay bánh pía vàng ươm, thợ làm bánh (Ảnh 148, 151)
 * - market_stall: Quầy hàng chợ truyền thống, thúng nan, sạp cá khô, sạp mắm, người đi chợ (Ảnh 150, 161)
 * - specialty_shop: Tiệm bánh kẹo đặc sản / đồ khô với kệ hũ nắp đỏ, túi zip, quầy mở ra phố (Ảnh 149, 167, 168)
 * - home_kitchen: Gian bếp gia đình nấu chè, súp, canh (Ảnh 159, 160)
 * - tea_table: Bàn trà gỗ sồi ấm cúng với bình hoa tươi, chậu cây phát tài và bộ ấm chén nước chè (Ảnh 153, 154, 157, 158, 164)
 */
function detectSourcingSetting(productName = '', foodCategory = '', options = {}) {
  if (options && options.sourcingSetting) return options.sourcingSetting;
  const name = String(productName || '').toLowerCase();
  const cat = String(foodCategory || '').toLowerCase();

  // Bánh nướng, bánh pía, bánh ngọt tươi -> Lò làm bánh / xưởng sản xuất
  if (name.includes('bánh pía') || name.includes('bánh dừa') || name.includes('lò bánh') || cat.includes('fresh_bakery') || cat.includes('pastry')) {
    return 'bakery_workshop';
  }
  // Hải sản khô, mắm cá, cá sụn, ba khía, tôm khô -> Sạp chợ truyền thống
  if (name.includes('mắm') || name.includes('cá sụn') || name.includes('khô cá') || name.includes('tôm khô') || name.includes('ba khía') || cat.includes('seafood') || cat.includes('fermented')) {
    return 'market_stall';
  }
  // Trái cây sấy, khoai lang dẻo, mực cán, me dốt, đồ ăn vặt túi/hũ nắp đỏ -> Tiệm đặc sản / tiệm đồ khô
  if (name.includes('khoai lang') || name.includes('mực cán') || name.includes('me dốt') || name.includes('trái cây sấy') || name.includes('ô mai') || cat.includes('dried_fruit')) {
    return 'specialty_shop';
  }
  // Chè, súp, canh, món nấu gia đình -> Gian bếp gia đình
  if (name.includes('chè') || name.includes('hạt sen') || name.includes('long nhãn') || name.includes('súp') || cat.includes('soup') || cat.includes('sweet_soup')) {
    return 'home_kitchen';
  }
  // Mặc định cho bánh kẹo tuổi thơ, kẹo lạc, bánh dồi, bánh đậu phộng, snack ăn vặt, trà, hạt rang -> Bàn trà thưởng thức ấm cúng Tạp Hoá Cóc
  return 'tea_table';
}

/**
 * Xây dựng prompt chi tiết cho bối cảnh nguồn gốc (Cảnh 1)
 */
function buildSourcingScenePrompt(sourcingSetting = 'tea_table', prodName = '', category = '') {
  switch (sourcingSetting) {
    case 'bakery_workshop':
      return {
        settingKey: 'bakery_workshop',
        settingName: 'Artisan Bakery Production Workshop',
        masterPrompt: `Subject: A young Vietnamese woman's well-groomed female hand holds up a fresh transparent package of "${prodName}" (${category}) inside an active artisan commercial bakery workshop. In the background: large commercial stainless steel ovens with warm interior light, tall rolling multi-tier bakery racks loaded with baking trays of golden pastries, and bakery staff in white uniforms with blue hairnets. Foreground package takes 55-70% of frame, background: bakery ovens and racks.`,
        videoPrompt: `Reviewer hand holds and rotates the fresh package of "${prodName}" inside the active artisan bakery workshop, with industrial baking ovens and bakers in white aprons tending multi-tier racks of golden pastries in the background. Full-bleed 9:16 vertical canvas.`
      };
    case 'market_stall':
      return {
        settingKey: 'market_stall',
        settingName: 'Traditional Vietnamese Wet Market Stall',
        masterPrompt: `Subject: A young Vietnamese woman's hand holds up the package of "${prodName}" (${category}) directly in front of an authentic traditional Vietnamese market stall (sạp đồ khô/mắm chợ truyền thống). In the bustling background: round woven wicker baskets and open burlap sacks overflowing with dried regional ingredients, packages hanging from ceiling rafters, hand-painted stall signage, and hanging bulbs. Foreground package takes 55-70% of frame, background: market stall display.`,
        videoPrompt: `Reviewer hand lifts and showcases the package of "${prodName}" in front of the traditional Vietnamese market stall, with woven baskets of dried goods, hanging merchandise, and shoppers moving through the market aisle in the background. Full-bleed 9:16 vertical canvas.`
      };
    case 'specialty_shop':
      return {
        settingKey: 'specialty_shop',
        settingName: 'Specialty Vietnamese Snack Store & Retail Counter',
        masterPrompt: `Subject: A young Vietnamese woman's hand presents the package of "${prodName}" (${category}) directly in front of a specialty Vietnamese snack shop counter (Tạp Hoá Cóc style). In the background: floor-to-ceiling wooden display shelves neatly lined with transparent snack containers with bright red lids and standing kraft pouches, sampling wicker trays, and soft natural daylight. Foreground package takes 55-70% of frame, background: snack display shelves.`,
        videoPrompt: `Reviewer hand presents the package of "${prodName}" in front of the specialty snack shop counter, showcasing its label against display shelves packed with red-lid snack containers and standing pouches. Full-bleed 9:16 vertical canvas.`
      };
    case 'home_kitchen':
      return {
        settingKey: 'home_kitchen',
        settingName: 'Vietnamese Home Cooking Kitchen',
        masterPrompt: `Subject: A young Vietnamese woman's hand presents the package of "${prodName}" (${category}) on a cozy home kitchen counter next to a large stainless steel cooking pot on the stove. In the background: stainless ladle, clean tile backsplash, and warm natural kitchen lighting. Foreground package takes 55-70% of frame, background: cozy domestic kitchen counter.`,
        videoPrompt: `Reviewer hand presents the package of "${prodName}" on the domestic kitchen counter beside the cooking pot and ladle, catching warm natural kitchen light. Full-bleed 9:16 vertical canvas.`
      };
    case 'tea_table':
    default:
      return {
        settingKey: 'tea_table',
        settingName: 'Cozy Vietnamese Home Tea Table',
        masterPrompt: `Subject: Packaging of "${prodName}" (${category}) placed on the warm honey-oak wooden table. A young Vietnamese woman's well-groomed female hand gently introduces the package toward the camera. In the soft blurred background: an elegant slender white ceramic vase with fresh blooming white flowers, a small pot with lush green lucky bamboo (cây phát tài), and a traditional ceramic teapot set with golden tea under natural side-window sunlight. Foreground package takes 55-70% of frame, background: cozy domestic tea corner.`,
        videoPrompt: `Reviewer hand gently guides the packaging of "${prodName}" forward on the warm honey-oak wooden table toward the camera, catching natural side-window sunlight with the floral tea set and lucky bamboo in the soft background. Full-bleed 9:16 vertical canvas.`
      };
  }
}

/**
 * Xây dựng kế hoạch đạo cụ động (Prop Plan - Section 4)
 * Tích hợp bộ đạo cụ nhận diện đặc trưng từ kênh Tạp Hoá Cóc: bình hoa hồng trắng, cây phát tài, ấm chén trà, mẹt tre, đĩa chấm viền lượn sóng
 */
function buildDynamicPropPlan(foodCategory = '', form = '', profile = {}) {
  const cat = String(foodCategory || '').toLowerCase();
  const f = String(form || profile?.form || '').toLowerCase();
  const props = [];

  if (f === 'noodle') {
    props.push(
      'đôi đũa gỗ tự nhiên đặt trên đồ gác đũa',
      'bát tô sứ sâu lòng đựng mì nóng hổi bốc khói nhẹ',
      'ấm trà gốm trắng, chậu cây phát tài xanh tươi và bình hoa hồng trắng phía sau'
    );
  } else if (f === 'cooked_dish') {
    props.push(
      'chén cơm trắng dẻo thơm hạt bóng bẩy',
      'thìa sứ hoặc đũa gỗ tự nhiên',
      'ấm trà nóng và bình hoa hồng trắng trên bàn gỗ sồi mật ong'
    );
  } else if (f === 'nuts_seeds' || profile?.unitScale === 'tiny') {
    props.push(
      'đĩa sứ trắng viền lượn sóng hoặc mẹt tre nhỏ lót lá chuối',
      'tách trà vàng ươm mộc mạc và chậu cây phát tài mini phía sau',
      'túi zip bao bì sản phẩm chính hãng'
    );
  } else if (f === 'rice_topping' || f === 'paste' || f === 'granular_food') {
    props.push(
      'bát cơm trắng nóng hổi dẻo thơm',
      'thìa gỗ nhỏ múc đồ ăn',
      'bình hoa hồng trắng, tách trà ấm và hũ sản phẩm nguyên bản'
    );
  } else if (f === 'filled_pastry' || f === 'bar_block' || cat.includes('cake') || cat.includes('pastry')) {
    props.push(
      'đĩa sứ tráng men mộc hoặc đĩa viền lượn sóng bày bánh',
      'ấm trà gốm sứ nóng hổi nghi ngút khói thơm trên khay gỗ',
      'bình hoa tươi hồng trắng dịu dàng và khăn ăn vải thô gấp gọn'
    );
  } else if (f === 'liquid' || cat.includes('drink')) {
    props.push(
      'ly thủy tinh có đá mát lạnh kèm ống hút',
      'lót ly gỗ sồi mật ong',
      'bình hoa tươi và chai/hộp sản phẩm nguyên bản đặt kế bên'
    );
  } else if (f === 'dried_strip' || f === 'crispy_sheet' || cat.includes('dried') || cat.includes('snack')) {
    props.push(
      'mẹt tre tròn thủ công lót lá chuối tươi bày đồ ăn đầy đặn',
      'chén sứ nhỏ viền lượn sóng đựng tương ớt đỏ au sánh mịn',
      'bình hoa hồng trắng thanh mảnh và ly trà mát thanh nhiệt phía sau'
    );
  } else {
    props.push(
      'mẹt tre tròn hoặc đĩa gốm mộc bày món ăn',
      'bộ ấm chén trà gốm sứ và bình hoa tươi trang nhã',
      'bao bì sản phẩm chính hãng'
    );
  }

  return {
    selectedProps: props,
    propDensity: 'medium',
    foregroundProp: props[0] || 'mẹt tre tròn lót lá chuối',
    backgroundProp: props[1] || 'bình hoa hồng trắng và bộ ấm trà',
    packageProp: props[2] || 'bao bì sản phẩm chính hãng'
  };
}

/**
 * Lập kế hoạch 4 cảnh động theo đặc tính thực phẩm (Section 13)
 */
function buildDynamicFourScenePlan(analysis = {}, profile = {}, affordance = {}, propPlan = {}, world = {}) {
  const prodName = analysis.productName || 'món ăn review';
  const heroAction = affordance?.heroAction || analysis.heroInteraction?.action || 'inspect';
  const sensoryTarget = affordance?.sensoryEvidence || analysis.heroInteraction?.sensoryTarget || 'kết cấu hấp dẫn';
  const unitScale = profile?.unitScale || 'medium';
  const form = profile?.form || 'snack';
  const effectivePropPlan = propPlan?.foregroundProp ? propPlan : buildDynamicPropPlan(analysis.foodCategory, form, profile);

  let s1Action = `Tay người review cầm gói/hộp ${prodName} đưa nhẹ về phía camera trên bàn gỗ tự nhiên, ánh mắt tò mò.`;
  let s2Action = '';
  let s3Action = '';
  let s3Runway = '';
  let s4Action = '';

  if (form === 'noodle') {
    s2Action = `Bát/đĩa ${prodName} đã nấu chín vàng óng bày biện đẹp mắt trên bàn gỗ, camera cận cảnh thấy rõ từng sợi mì dai mướt quyện đều nước xốt/nước dùng đậm đà, bên cạnh là đôi đũa gỗ tự nhiên đặt ngay ngắn trên đồ gác đũa.`;
    s3Action = `Dùng đôi đũa gỗ kẹp và gắp một vắt mì ${prodName} óng ả nâng nhẹ lên cao từ bát, sợi mì dai mướt bốc khói nhẹ quyện xốt đậm đà; tay người review cầm chắc thân đũa ở phía trên, tuyệt đối không dùng tay bốc mì.`;
    s3Runway = `ACTION RUNWAY (GẮP MÌ BẰNG ĐŨA GỖ): Đôi đũa gỗ tự nhiên đã kẹp nhẹ vào vắt mì trong bát/đĩa, đang ở vị trí chuẩn bị nhấc bổng sợi mì lên cao để khoe độ dai mượt và nước xốt; tay người review cầm chắc thân đũa ở phía trên, tuyệt đối không chạm ngón tay vào thức ăn.`;
    s4Action = `Bát mì hoàn chỉnh thơm ngon mời gọi với vắt mì gắp nhẹ trên đũa hoặc thìa đặt cạnh, khói nhẹ bay lên, kết thúc review hấp dẫn thèm thuồng.`;
  } else if (form === 'cooked_dish') {
    s2Action = `Đĩa/bát ${prodName} nóng hổi bốc khói nhẹ bày trên bàn ăn ấm cúng, thấy rõ thớ thịt mềm thơm đậm đà.`;
    s3Action = `Dùng thìa sứ múc một phần ${prodName} đầy đặn nâng lên hướng về phía bát cơm, không dùng tay trần.`;
    s3Runway = `ACTION RUNWAY (MÚC THÌA): Chiếc thìa sứ đặt dưới phần thức ăn, chuẩn bị nâng lên cao; tay cầm cán thìa.`;
    s4Action = `Món ăn thơm phức hoàn thiện bày cạnh chén cơm nóng, thôi thúc người xem thưởng thức.`;
  } else if (unitScale === 'tiny' || form === 'nuts_seeds') {
    s2Action = `Trút một nắm ${prodName} ra ${effectivePropPlan.foregroundProp}, camera cận cảnh thấy rõ từng hạt tròn đều và lớp vỏ áo giòn rụm.`;
    s3Action = `Hai đầu ngón tay nhón 1 hạt ${prodName} giơ sát camera, xoay nhẹ dưới ánh sáng tự nhiên để khoe lớp vỏ và kích cỡ thực tế.`;
    s3Runway = `ACTION RUNWAY (NHÓN & XOAY HẠT): Một hạt đã được nhón sẵn giữa ngón cái và ngón trỏ, giữ vững ngay trước camera sẵn sàng cho chuyển động xoay tròn quan sát; không bẻ nát hạt.`;
    s4Action = `Cả nắm hạt nằm gọn trong lòng bàn tay đưa gần camera mời gọi thưởng thức, hậu cảnh mờ nhẹ tách trà ấm cúng.`;
  } else if (form === 'rice_topping' || form === 'paste' || form === 'granular_food') {
    s2Action = `Mở nắp hũ ${prodName} đặt ngay ngắn, camera nhìn nghiêng thấy rõ độ tơi xốp, ẩm mọng và ánh vàng óng ánh của thớ thịt.`;
    s3Action = `Dùng thìa gỗ múc một phần ${prodName} đầy đặn nâng lên cao từ miệng hũ, thể hiện độ đậm đà tơi xốp.`;
    s3Runway = `ACTION RUNWAY (MÚC & NÂNG THÌA): Chiếc thìa gỗ đã nằm sẵn dưới lớp thực phẩm bên trong hũ, chuẩn bị thực hiện động tác nâng thìa thơm phức lên hướng về bát cơm nóng.`;
    s4Action = `Rưới phần sốt/thịt thơm phức lên bát cơm trắng nóng hổi bốc khói mộc mạc, tạo cảm giác thôi thúc muốn ăn thử liền.`;
  } else if (form === 'filled_pastry' || profile?.hasInteriorReveal) {
    s2Action = `Đặt chiếc bánh ${prodName} lên đĩa sứ mộc, xoay nhẹ để thấy rõ độ hoàn thiện, màu sắc nướng vàng và độ dày của bánh.`;
    s3Action = `Hai bàn tay bẻ đôi chiếc bánh làm lộ rõ lớp nhân dẻo mềm óng ả và vỏ bánh nhiều lớp.`;
    s3Runway = `ACTION RUNWAY (BẺ ĐÔI TÁCH NHÂN): Hai bàn tay đặt chắc chắn ở hai bên thân bánh, tạo lực kéo ban đầu ngay khoảnh khắc vỏ bánh vừa nứt nhẹ hé lộ nhân bên trong.`;
    s4Action = `Hai nửa chiếc bánh đẫm nhân giơ song song cận cảnh camera, kết thúc review thỏa mãn và ngon mắt.`;
  } else {
    s2Action = `Bày phần ${prodName} ra đĩa gốm mộc, xoay nhẹ 30 độ để thấy rõ lát cắt, độ dày và lớp sốt/gia vị bên ngoài.`;
    s3Action = `Thực hiện thao tác ${heroAction} trên ${prodName} làm phơi bày ${sensoryTarget}.`;
    s3Runway = `ACTION RUNWAY (${heroAction.toUpperCase()}): Tay/dụng cụ đặt ở vị trí bắt đầu của thao tác ${heroAction}, sẵn sàng cho 6 giây chuyển động liên tục.`;
    s4Action = `Cầm phần món ăn đưa lại gần camera mời mọc, không gian ấm cúng tự nhiên.`;
  }

  // Gather reference image IDs from propPlan metadata for scene mapping (spec §8)
  const imgMeta = effectivePropPlan._imageMetadata || [];
  const allRefIds     = imgMeta.map(m => m.id);
  const packagingIds  = imgMeta.filter(m => m.role === 'packaging').map(m => m.id);
  const textureIds    = imgMeta.filter(m => ['texture', 'product_opened'].includes(m.role)).map(m => m.id);
  const usageIds      = imgMeta.filter(m => ['usage', 'prepared'].includes(m.role)).map(m => m.id);

  return {
    heroAction,
    sensoryEvidence: sensoryTarget,
    scene1: {
      index: 1, role: 'discovery', phase: 'Discovery',
      duration: 6, durationSeconds: 6,
      action: s1Action,
      goal: 'Gây tò mò, mở màn tự nhiên',
      referenceImageIds: packagingIds.length > 0 ? packagingIds : allRefIds.slice(0, 1),
      continuityLocks: ['table_color', 'light_direction', 'color_temperature', 'prop_family'],
      negativeConstraints: ['no_tiktok_ui', 'no_fake_logos', 'no_delivery_proof_unless_evidenced', 'no_other_brand_packaging'],
      qaChecks: ['product_correctly_identified', 'packaging_matches_reference', 'correct_aspect_ratio_9_16']
    },
    scene2: {
      index: 2, role: 'show', phase: 'Show',
      duration: 6, durationSeconds: 6,
      action: s2Action,
      goal: 'Quan sát bề mặt ngoài, lớp áo và kích thước thực tế',
      referenceImageIds: textureIds.length > 0 ? textureIds : allRefIds.slice(0, 2),
      continuityLocks: ['table_color', 'light_direction', 'prop_family', 'product_quantity'],
      negativeConstraints: ['no_invented_interior_if_no_evidence', 'no_wrong_unit_count', 'no_packaging_mutation'],
      qaChecks: ['new_information_shown', 'product_shape_color_consistent', 'quantity_plausible']
    },
    scene3: {
      index: 3, role: 'hero_interaction', phase: 'Experience',
      duration: 6, durationSeconds: 6,
      action: s3Action, actionRunway: s3Runway,
      goal: 'Hero Interaction làm nổi bật giá trị cảm quan',
      referenceImageIds: [...(usageIds.length > 0 ? usageIds : []), ...(textureIds.length > 0 ? textureIds : allRefIds.slice(0, 1))],
      continuityLocks: ['table_color', 'light_direction', 'product_identity'],
      negativeConstraints: ['no_forbidden_action', 'no_extra_hands', 'no_product_form_mutation', 'no_anatomically_implausible_grip', 'no_floating_food', 'no_unverified_interior_reveal'],
      qaChecks: ['hero_interaction_present', 'action_physically_plausible', 'sensory_evidence_revealed', 'no_forbidden_action_executed']
    },
    scene4: {
      index: 4, role: 'verdict', phase: 'Verdict',
      duration: 6, durationSeconds: 6,
      action: s4Action,
      goal: 'Bày biện thành phẩm mời gọi, kết thúc thỏa mãn',
      referenceImageIds: allRefIds.slice(0, 2),
      continuityLocks: ['table_color', 'light_direction', 'prop_family'],
      negativeConstraints: ['no_ungrounded_health_claims', 'no_fake_best_seller_claims', 'no_price_promise', 'no_tiktok_ui'],
      qaChecks: ['closing_natural', 'cta_soft', 'no_verbal_overclaim', 'video_24s_total_within_tolerance']
    }
  };
}


/**
 * Kiểm tra tính hợp lệ của hành động thực phẩm (Section 23)
 */
function validateFoodAction(action, profile = {}) {
  const errors = [];
  const warnings = [];
  const act = String(action || '').toLowerCase().replace(/_/g, ' ');
  const forbidden = deriveForbiddenFoodActions(profile);

  for (const f of forbidden) {
    if (act.includes(f.toLowerCase())) {
      errors.push(`INVALID_FOOD_ACTION: Hành động "${action}" nằm trong danh sách cấm đối với dạng sản phẩm "${profile.form || 'unknown'}".`);
    }
  }

  // Cấm bốc tay trần đối với mì, bún, phở, món nấu chín nóng
  if (profile.form === 'noodle' || profile.form === 'cooked_dish') {
    const invalidBareHandActs = ['pick', 'rotate', 'break', 'break open', 'tear', 'squeeze', 'crush', 'hand grab', 'bare hand', 'finger'];
    if (invalidBareHandActs.some(bad => act === bad || act.includes(bad)) && !act.includes('chopstick') && !act.includes('fork') && !act.includes('spoon')) {
      errors.push(`INVALID_FOOD_ACTION: Món "${profile.form}" bắt buộc phải dùng dụng cụ (đũa gỗ: lift_with_chopsticks, nĩa: twirl_with_fork, hoặc thìa). Tuyệt đối cấm dùng tay trần bốc/nhón/bẻ (got action: "${action}").`);
    }
  }

  if (profile.unitScale === 'tiny' && (act.includes('break') || act.includes('tear') || act.includes('squeeze') || act.includes('crush'))) {
    errors.push(`PRODUCT_SCALE_ACTION_MISMATCH: Sản phẩm cỡ "tiny" (${profile.form}) không thể thực hiện hành động "${action}".`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Kiểm tra đồng bộ giữa hình ảnh và lời thoại (Show -> Say Synchronization - Section 17)
 */
function validateShowSaySync(script = [], dynamicPlan = {}, profile = {}, refs = {}) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(script) || script.length === 0) return { valid: true, errors, warnings };

  const sc3 = script[2] || {};
  const sc3Voice = (sc3.voiceOver || '').toLowerCase();
  const heroAction = (dynamicPlan?.scene3?.action || dynamicPlan?.heroAction || '').toLowerCase();
  const unitScale = (profile?.unitScale || '').toLowerCase();
  const allVoice = script.map(s => (s.voiceOver || s.voiceScript || '')).join(' ').toLowerCase();

  // ── HARD FAILS (spec §10) ────────────────────────────────────────────────────

  // 1. Interior/filling claim without reference evidence
  const mentionsInterior = /\b(nhân|ruột bên trong|lớp nhân|nhân mềm|nhân đầy|cắt ra|bẻ ra thấy|lộ nhân)\b/i.test(allVoice);
  const hasInteriorEvidence = refs.hasInteriorEvidence || (refs.product_opened && refs.product_opened.length > 0) || (profile.hasFilling && profile.hasInteriorReveal);
  if (mentionsInterior && !hasInteriorEvidence) {
    errors.push('UNSUPPORTED_INTERIOR_REVEAL: Thoại nhắc đến nhân/ruột bên trong nhưng không có ảnh reference product_opened xác minh. Không được bịa nội thất sản phẩm.');
  }

  // 2. Break/tear mismatch — voice says break but visual action is not break
  const mentionsBreak = /\b(bẻ ra|bẻ đôi|bẻ thử|bẻ cái|tách ra|tách đôi)\b/i.test(sc3Voice);
  if (mentionsBreak && heroAction && !heroAction.includes('bẻ') && !['break', 'break_open', 'tear', 'crack', 'pull'].some(a => heroAction.includes(a))) {
    errors.push(`SHOW_SAY_MISMATCH: Cảnh 3 thoại nói về hành động bẻ/tách nhưng hành động thị giác được chọn là "${heroAction}".`);
  }

  // 3. Tiny food forced break
  if (unitScale === 'tiny' && mentionsBreak) {
    errors.push('FORCED_BREAK: Sản phẩm có kích thước nhỏ (tiny) không được bẻ đôi trong thoại hoặc hành động.');
  }

  // 4. Eating/tasting claims without verified experience (spec §10 hard fail)
  const mentionsEating = /\b(tui ăn rồi|tui thử rồi|ăn thử thấy|nếm rồi|đã ăn|tui đặt|mới giao|shipper vừa)\b/i.test(allVoice);
  if (mentionsEating) {
    errors.push('UNVERIFIED_EXPERIENCE_CLAIM: Thoại tuyên bố đã ăn/đặt/nhận giao hàng mà không có bằng chứng xác minh. Loại bỏ hoặc viết lại trung tính.');
  }

  // 5. Dipping voice but no dip action
  const mentionsDip = /\b(chấm thử|chấm vào|nhúng vào)\b/i.test(sc3Voice);
  if (mentionsDip && !['dip', 'sauce'].some(a => heroAction.includes(a))) {
    errors.push(`SHOW_SAY_MISMATCH: Cảnh 3 thoại nói "chấm" nhưng hành động thị giác là "${heroAction}" không bao gồm chấm.`);
  }

  // ── SOFT WARNINGS (spec §10) ─────────────────────────────────────────────────

  // Squeeze mismatch
  const mentionsSqueeze = /\b(bóp|ép|nắn)\b/i.test(sc3Voice);
  if (mentionsSqueeze && !['squeeze', 'press'].some(a => heroAction.includes(a))) {
    warnings.push(`SHOW_SAY_MISMATCH: Thoại nhắc đến bóp/ép nhưng hành động thị giác là "${heroAction}".`);
  }

  // All 4 scenes same visual framing (spec §10 soft warning)
  const phases = script.map(s => (s.visualGoal || s.foodAction || '').substring(0, 30));
  const uniquePhases = new Set(phases);
  if (uniquePhases.size <= 1 && script.length === 4) {
    warnings.push('SHOW_SAY_MISMATCH: 4 cảnh có cùng mô tả thị giác (visualGoal). Mỗi cảnh cần bổ sung thông tin mới.');
  }

  // Over-qualification without visual proof
  const adjectives = (allVoice.match(/\b(giòn rụm|dẻo mềm|béo ngậy|đậm đà|thơm nức|mịn màng|mướt mát)\b/gi) || []);
  if (adjectives.length > 6) {
    warnings.push(`WARN_UNSUPPORTED_SENSORY: Quá nhiều tính từ cảm quan (${adjectives.length} lần: ${[...new Set(adjectives)].join(', ')}). Đảm bảo mỗi từ đi kèm visual proof.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Kiểm tra tính nhất quán của thế giới kênh review (Section 4 / v2-spec §4)
 * Adaptive theo category — không ép "wood" cho mọi loại sản phẩm.
 */
function validateBackgroundWorld(world = {}, category = '') {
  const errors = [];
  const warnings = [];
  if (!world || typeof world !== 'object') {
    errors.push('BACKGROUND_TOO_GENERIC: Thiếu cấu hình Food Review World.');
    return { valid: false, errors, warnings };
  }

  // Hard forbidden looks (v2-spec §4 forbiddenLook)
  const surface = (world.surface || '').toLowerCase();
  const environment = (world.environment || '').toLowerCase();
  const forbiddenLooks = ['empty studio', 'seamless background', 'commercial catalogue', 'cgi kitchen', 'luxury restaurant', 'overdecorated influencer'];
  const foundForbidden = forbiddenLooks.find(f => surface.includes(f) || environment.includes(f));
  if (foundForbidden) {
    errors.push(`BACKGROUND_TOO_GENERIC: Forbidden look detected: "${foundForbidden}". Sử dụng môi trường sống động thực tế (bàn gỗ ấm cúng, ánh sáng tự nhiên, props phù hợp).`);
  }

  // Adaptive surface check — wood is default for dried/snack; drinks/fresh may differ
  const drinkCategories = ['drink', 'beverage', 'liquid', 'nuoc'];
  const isDrink = drinkCategories.some(d => category.toLowerCase().includes(d));
  if (!surface && !isDrink) {
    warnings.push('BACKGROUND_WORLD_DRIFT: Không có cấu hình surface. Khuyến nghị bàn gỗ tự nhiên có vân cho đồ ăn khô/bánh.');
  } else if (surface && !surface.includes('wood') && !isDrink && !surface.includes('ceramic') && !surface.includes('tile') && !surface.includes('tray')) {
    warnings.push(`BACKGROUND_WORLD_DRIFT: Surface "${world.surface}" không phổ biến cho category này. Xem xét lại để đảm bảo food-review authenticity.`);
  }

  return { valid: errors.length === 0, errors, warnings };
}


// ── 2.2 SCRIPT VALIDATION GATE & LINTER ───────────────────────────────────────

/**
 * Bộ thẩm định kịch bản Food Review (Script Validation Gate & Linter)
 * Tuân thủ Section 49 & 50 & 51 và các Hard Gates mới.
 */
function validateFoodScript(parsedData) {
  const errors = [];
  const warnings = [];

  if (!parsedData || typeof parsedData !== 'object') {
    return { valid: false, errors: ['Parsed analysis data is not an object'], warnings };
  }

  const analysis = parsedData.analysis || {};
  const script = Array.isArray(parsedData.script)
    ? parsedData.script
    : (Array.isArray(parsedData.scenes) ? parsedData.scenes : []);

  // 1. Kiểm tra số cảnh: bắt buộc đúng 4 cảnh
  if (script.length !== 4) {
    errors.push(`Kịch bản phải có đúng 4 cảnh, hiện tại có ${script.length} cảnh.`);
  }

  // 2. Kiểm tra thời lượng: mỗi cảnh 6s, tổng 24s
  let totalDuration = 0;
  script.forEach((sc, idx) => {
    const dur = Number(sc.durationSeconds || sc.duration || 6);
    totalDuration += dur;
    if (dur !== 6) {
      warnings.push(`Cảnh ${idx + 1} có thời lượng ${dur}s (khuyến nghị chuẩn 6s).`);
    }
  });
  if (totalDuration !== 24) {
    warnings.push(`Tổng thời lượng kịch bản là ${totalDuration}s (chuẩn mục tiêu là 24s).`);
  }

  // 3. Bắt buộc có Hero Interaction (Section 7)
  const hero = analysis.heroInteraction;
  if (!hero || !hero.action || !hero.sensoryTarget) {
    errors.push('Bắt buộc phải có trường "heroInteraction" với action và sensoryTarget rõ ràng.');
  } else {
    // Kiểm tra Cảnh 3 phải mô tả đúng thao tác Hero Interaction
    const sc3 = script[2];
    if (sc3) {
      const sc3Text = `${sc3.foodAction || ''} ${sc3.voiceOver || ''} ${sc3.visualGoal || ''}`.toLowerCase();
      const heroAct = String(hero.action || '').toLowerCase().replace(/_/g, ' ');
      if (!sc3Text.includes(heroAct) && !sc3.foodAction) {
        warnings.push(`Cảnh 3 (Experience) nên thể hiện rõ hành động Hero Interaction "${hero.action}".`);
      }
    }
  }

  // 4. Linter ngôn ngữ (Section 50)
  const allVoice = script.map(s => s.voiceOver || s.voiceScript || '').join(' ');
  const words = allVoice.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  if (wordCount < 68 || wordCount > 95) {
    warnings.push(`WARN_WORD_COUNT_BUDGET: Tổng số từ kịch bản là ${wordCount} từ (ngân sách khuyến nghị 72-82 từ cho chuẩn 24s ở tốc độ nói tự nhiên ~3.3 từ/giây).`);
  }

  // Linter: Nhồi nhét hư từ địa phương
  const neCount = (allVoice.match(/\bnè\b/gi) || []).length;
  const nhaCount = (allVoice.match(/\bnha\b/gi) || []).length;
  const nghenCount = (allVoice.match(/\bnghen\b/gi) || []).length;
  const aCount = (allVoice.match(/\bá\b/gi) || []).length;
  if (neCount + nhaCount + nghenCount + aCount > 7) {
    warnings.push(`WARN_PARTICLE_OVERUSE: Hư từ địa phương xuất hiện ${neCount + nhaCount + nghenCount + aCount} lần (quá dày đặc).`);
  }

  // Linter: Gọi người xem dồn dập (tối đa 0-2 lần)
  const addressMatches = allVoice.match(/\b(cả nhà|mọi người|mấy bạn)\b/gi) || [];
  if (addressMatches.length > 2) {
    warnings.push(`WARN_AUDIENCE_ADDRESS_OVERUSE: Gọi người xem (${addressMatches.join(', ')}) ${addressMatches.length} lần (khuyến nghị tối đa 2 lần).`);
  }

  // Linter: Từ ngữ quảng cáo quá đà (Section 51)
  const bannedSalesWords = ['siêu phẩm', 'xịn xò', 'đỉnh của chóp', 'chốt đơn', 'hốt liền', 'mua ngay', 'không mua là tiếc'];
  const foundSales = bannedSalesWords.filter(w => allVoice.toLowerCase().includes(w));
  if (foundSales.length > 0) {
    warnings.push(`WARN_SALESY_LANGUAGE: Phát hiện từ quảng cáo cấm: ${foundSales.join(', ')}.`);
  }

  // Linter: Xưng hô không chuẩn (chỉ xưng tui hoặc tỉnh lược)
  if (/\b(em|mình|chị|cháu|bác)\b/i.test(allVoice) && !/\btui\b/i.test(allVoice)) {
    warnings.push('WARN_PRONOUN_INSTABILITY: Kênh Food Review ưu tiên xưng "tui" hoặc tỉnh lược chủ ngữ, tránh đổi sang em/mình/chị.');
  }

  // 5. Kiểm tra Affordance & Show-Say Sync (Dynamic Affordance Engine)
  const profile = analysis.foodPhysicalProfile || analyzeFoodPhysicalProfile(analysis);
  const refs = analysis.referenceRoles || parsedData.referenceRoles || parsedData.refs || analysis.refs || {};
  if (hero && hero.action) {
    const actCheck = validateFoodAction(hero.action, profile);
    if (!actCheck.valid) {
      errors.push(...actCheck.errors);
    }
    warnings.push(...actCheck.warnings);
  }

  const syncCheck = validateShowSaySync(script, analysis.dynamicFourScenePlan || { heroAction: hero?.action }, profile, refs);
  if (!syncCheck.valid) {
    errors.push(...syncCheck.errors);
  }
  warnings.push(...syncCheck.warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    wordCount,
  };
}

// ── 3. PRODUCT ANALYSIS (STEP 1) ──────────────────────────────────────────────

function buildTemplateFoodAnalysisPrompt(options = {}) {
  const productContext = options.productContext || {};
  const productTitle = productContext.productTitle || productContext.title || '';
  const productDescription = productContext.productDescription || productContext.description || '';

  return `### SYSTEM ROLE:
You are a Vietnamese short-form food-review strategist, sensory copywriter, visual director, and AI video prompt planner.
Your job is to analyze the supplied food/beverage product images and metadata, then produce a high-converting, experiential 24-second review consisting of exactly four 6-second scenes.

### CHANNEL GOAL & PHILOSOPHY:
This is a dedicated Vietnamese food & beverage review channel (snack, cake, dried food, regional specialty, drink, sauce, convenience food...).
The channel feels like a real young Vietnamese woman who just bought the food, holds it in front of her phone camera, opens it, inspects it, and casually tells viewers her genuine sensory reaction.
CORE PRINCIPLE:
SEE IT -> TOUCH IT -> REVEAL IT -> TASTE / EXPERIENCE IT -> REACT TO IT.
"Camera thấy gì, tay đang làm gì, thì giọng review phải phản ứng đúng cái đó."

### HARD REQUIREMENTS:
1. FORMAT: Exactly 4 scenes × 6 seconds = 24 seconds total.
   - Scene 1 (00:00 - 00:06): DISCOVERY / HOOK (Curiosity, why it caught attention, store/packaging).
   - Scene 2 (00:06 - 00:12): SHOW / FIRST OBSERVATION (Surface, thickness, portion size, quantity, texture).
   - Scene 3 (00:12 - 00:18): HERO INTERACTION / SENSORY PROOF (The single physical action that most strongly reveals texture, filling, softness, stretch, crunch, or sauce viscosity).
   - Scene 4 (00:18 - 00:24): TASTE / VERDICT / SOFT CTA (Eating experience, balanced verdict, who may like it, soft friendly sign-off).
2. MANDATORY HERO INTERACTION: You MUST define the single physical action performed by hands in Scene 3 (e.g. break_open, pull, tear, stretch, dip, pour, swirl, bite, snap, pick, rotate, scoop). NO HERO INTERACTION = INVALID ANALYSIS.
3. ACTION RUNWAY FOR STORYBOARD: The visual plan for Scene 3 must depict the BEGINNING of the action (e.g. hands gripping both sides of cake right before tearing, or spoon positioned under topping before lifting, or one unit delicately pinched ready to rotate), NOT the finished state, so the 6s video has motion runway.
4. REVIEWER PERSONA: "FOOD_REVIEWER_PERSONA_V1"
   - Young adult Vietnamese female, friendly, curious, natural vocal smile.
   - Casual Southern Vietnamese with a subtle Mekong Delta conversational flavor.
   - Stable pronoun: Default self-reference is "tui" (or natural subject omission). Never switch to "em/mình/chị".
   - Audience address: Use "cả nhà", "mọi người", "mấy bạn", "ai mê..." sparingly (0 to 2 times MAX in the entire video).
   - Conversational particles: "nè", "nha", "nghen", "á", "chứ" appear naturally and sparingly. NEVER stuff particles into every clause.
5. SENSORY VOCABULARY & BALANCED VERDICT:
   - Use sensory vocabulary (giòn, giòn rụm, mềm xốp, dẻo dai, béo thơm, ngọt thanh, đậm đà, áo đều...).
   - Balanced review language: "khá vừa miệng", "ngọt vừa chứ không gắt", "béo nhẹ", "ăn chơi thì ổn".
   - NO generic hype ads: ABSOLUTELY FORBIDDEN: "siêu phẩm", "xịn xò", "đỉnh của chóp", "chấn động", "chốt đơn", "hốt liền", "mua ngay".
6. WORD BUDGET (TARGET 24.0s AT NATURAL ~3.2-3.4 WORDS/SEC):
   - Scene 1: ~18-20 words (5.5 - 6s)
   - Scene 2: ~18-20 words (5.5 - 6s)
   - Scene 3: ~18-21 words (5.5 - 6s)
   - Scene 4: ~18-20 words (5.5 - 6s)
   - Total spoken script: Exactly 72 to 82 Vietnamese words.
7. GROUNDING & SAFETY: Never fabricate unverified origin or personal history ("tui ăn từ nhỏ", "quê tui...").

### CRITICAL AFFORDANCE & SHOW->SAY SYNC RULES (SPEC v3):
- Tuyệt đối KHÔNG ép mọi món ăn đều phải bẻ đôi hoặc bóp nát!
- Nếu là mì, bún, phở, miến, hủ tiếu, mì tươi, mì gói, pasta, ramen: Hero action BẮT BUỘC là gắp bằng đũa (lift_with_chopsticks) hoặc cuộn nĩa (twirl_with_fork). TUYỆT ĐỐI CẤM dùng tay bốc mì, nhón mì, hoặc bẻ nát! Bàn tay chỉ cầm đũa ở phía trên.
- Nếu là đồ ăn hạt nhỏ (đậu phộng, hạt điều, kẹo viên): Hero action BẮT BUỘC là nhón (pick), xoay (rotate), trút (pour), hoặc nắm hạt (show_handful). CẤM bẻ đôi hạt nhỏ!
- Nếu là món mặn/sốt/mắm tép: Hero action BẮT BUỘC là múc thìa (scoop), phết (spread), rưới lên cơm (mix_with_rice). CẤM bẻ hoặc biến thành miếng bánh!
- Nếu là bánh có nhân (bánh pía): Hero action là bẻ đôi (break_open) để thấy nhân.
- SHOW -> SAY SYNC: Lời thoại review phải mô tả đúng những gì mắt thấy ở Cảnh 3. Nếu không bẻ bánh thì thoại TUYỆT ĐỐI KHÔNG nói "bẻ ra...".

- Bối cảnh nguồn gốc Cảnh 1 (sourcingSetting): Chọn 1 trong 5 bối cảnh chân thực nhất cho sản phẩm:
  * bakery_workshop: Lò nướng bánh / xưởng sản xuất thực tế (bánh pía, bánh nướng, bánh ngọt).
  * market_stall: Sạp đồ khô / sạp mắm chợ truyền thống có rổ sọt thúng nan, lối đi chợ tấp nập (khô cá, mắm cá, ba khía).
  * specialty_shop: Tiệm bánh kẹo đặc sản / đồ khô với kệ hũ nắp đỏ, túi zip, quầy mở ra vỉa hè có xe máy đậu (khoai lang sấy, mực cán, me dốt).
  * street_shipper: Giao hàng shipper áo đỏ J&T trên vỉa hè đường phố Việt Nam tấp nập xe máy và người đi lại (combo, chè, set nguyên liệu).
  * tea_table: Bàn gỗ sồi ấm cúng trong nhà với bình hoa hồng trắng và ấm trà (lifestyle nội thất).

### PRODUCT METADATA PROVIDED:
Product Title: "${productTitle}"
Product Details: "${productDescription}"

### REQUIRED JSON OUTPUT STRUCTURE (Return VALID JSON only, no markdown wrappers):
{
  "analysis": {
    "productName": "Tên món ăn ngắn gọn chính xác",
    "foodCategory": "snack|cake|noodle|dried_food|specialty|drink|sauce|dessert|ready_to_eat|other",
    "sourcingSetting": "street_shipper|market_stall|specialty_shop|bakery_workshop|tea_table",
    "variant": "Vị / phân loại cụ thể nếu có",
    "packageType": "Túi zip / hộp giấy / hũ thuỷ tinh / khay...",
    "visibleProperties": ["Màu sắc", "Độ dày", "Lớp phủ bên ngoài", "Nhân bánh..."],
    "metadataClaims": ["Các thông tin từ tiêu đề/mô tả"],
    "unverifiedClaims": ["Những điểm vị giác chưa kiểm chứng được"],
    "verifiedClaims": [
      {
        "text": "Mô tả ngắn về điều được xác minh",
        "source": "user|packaging|visible_image|verified_metadata",
        "evidenceIds": ["ref_1", "ref_2"]
      }
    ],
    "unknowns": ["Những thông tin không thể xác minh từ input hiện tại (vị, mùi, nguồn gốc, thành phần không thấy)"],
    "forbiddenClaims": ["Các phát biểu tuyệt đối không được dùng: sức khoẻ, an toàn, giá, giao hàng, chứng nhận nếu không có bằng chứng"],
    "primarySensoryAngle": "Độ mềm dẻo / độ giòn / vị đậm đà / độ béo ngậy...",
    "secondarySensoryAngle": "Lượng nhân đầy đặn / độ thơm...",
    "reviewAngle": {
      "primary": "texture|filling|crispness|sauce|richness|freshness",
      "secondary": "portion|sweetness_balance|aroma",
      "avoid": ["health_claim", "unverified_origin", "unverified_taste_claim"]
    },
    "targetViewer": "Người thích ăn vặt / người thích đồ ngọt / gia đình...",
    "heroInteraction": {
      "action": "lift_with_chopsticks|twirl_with_fork|scoop|break_open|tear|pull|dip|pour|stretch|snap|swirl|bite|pick|rotate",
      "performedBy": "reviewer_hand",
      "visualTarget": "Mô tả chi tiết kết cấu được phơi bày khi tương tác",
      "sensoryTarget": "Cảm giác giác quan chính muốn chứng minh",
      "shotType": "close_up|macro|medium_close",
      "scene": 3
    }
  },

  "voicePersona": {
    "personaId": "SOUTHERN_VIETNAMESE_SUBTLE_MEKONG_V1",
    "dialectDirection": "southern_vietnamese_subtle_mekong",

    "selfReference": "tui",
    "audienceAddress": ["cả nhà", "mọi người", "mấy bạn"],
    "energy": 7,
    "excitement": 6.5,
    "salesPressure": 3,
    "vocalSmile": 7.5
  },
  "script": [
    {
      "id": 1,
      "phase": "Discovery",
      "durationSeconds": 6,
      "visualGoal": "Giới thiệu món ăn, tạo tò mò, góc quay cận cảnh bao bì và sản phẩm",
      "foodAction": "Tay người review cầm gói đồ ăn đưa nhẹ về phía camera",
      "cameraAction": "Camera điện thoại góc cận cảnh tự nhiên, ánh sáng ấm",
      "speechFunctions": ["HOOK", "OBSERVE"],
      "voiceOver": "Câu thoại khoảng 18-21 từ khơi gợi tò mò, xưng tui tự nhiên"
    },
    {
      "id": 2,
      "phase": "Show",
      "durationSeconds": 6,
      "visualGoal": "Cận cảnh mở bao bì, bày ra đĩa, quan sát bề mặt bên ngoài và lớp áo",
      "foodAction": "Bày hoặc trút một phần đồ ăn lên đĩa/tay, camera thấy độ dày hoặc số lượng",
      "cameraAction": "Camera cận cảnh tập trung vào bề mặt thực phẩm",
      "speechFunctions": ["POINT_OUT", "OBSERVE"],
      "voiceOver": "Câu thoại khoảng 18-21 từ miêu tả đúng những gì mắt đang thấy"
    },
    {
      "id": 3,
      "phase": "Experience",
      "durationSeconds": 6,
      "visualGoal": "HERO INTERACTION: Thao tác thực tế phù hợp (nhón xoay hạt / múc thìa / bẻ bánh có nhân)",
      "foodAction": "Bàn tay thực hiện thao tác Hero Interaction tương ứng",
      "cameraAction": "Macro cận cảnh thức ăn, nét căng vào kết cấu",
      "speechFunctions": ["ACTION", "REVEAL", "SENSORY"],
      "voiceOver": "Câu thoại khoảng 18-21 từ phản ứng trực tiếp với hành động ở Cảnh 3 (không nói bẻ nếu không bẻ)"
    },
    {
      "id": 4,
      "phase": "Verdict",
      "durationSeconds": 6,
      "visualGoal": "Thưởng thức thử / giơ phần thức ăn lại gần camera, kết luận trải nghiệm",
      "foodAction": "Cầm phần đồ ăn giơ tự nhiên gần camera mời mọc",
      "cameraAction": "Góc trung cận ấm áp, giữ yên tĩnh để người xem ngắm thành phẩm",
      "speechFunctions": ["REACTION", "QUALIFY", "VERDICT", "CTA"],
      "voiceOver": "Câu thoại khoảng 18-21 từ đánh giá vừa vặn, kết thúc nhẹ nhàng mời tham khảo"
    }
  ]
}`;
}

async function analyzeProductTemplateFood(geminiClient, filePayloads, options = {}) {
  const prompt = buildTemplateFoodAnalysisPrompt(options);

  const uploadedFiles = [];
  if (geminiClient && Array.isArray(filePayloads)) {
    for (let i = 0; i < Math.min(filePayloads.length, 5); i++) {
      const file = filePayloads[i];
      const buffer = Buffer.isBuffer(file.buffer)
        ? file.buffer
        : (file.base64 ? Buffer.from(file.base64, 'base64') : (file.path && fs.existsSync(file.path) ? fs.readFileSync(file.path) : null));
      if (!buffer) continue;

      const mimeType = file.mimeType || 'image/png';
      const filename = file.name || `food_${i + 1}.png`;
      try {
        const url = await geminiClient.uploadFile(buffer, filename, mimeType);
        if (url) uploadedFiles.push({ url, filename, mimeType });
      } catch (upErr) {
        console.warn(`[TemplateFood] Failed to upload product image ${filename}: ${upErr.message}`);
      }
    }
  }

  console.log(`[TemplateFood] Step 1: Analyzing food product with Gemini Vision (${uploadedFiles.length} uploaded reference images)...`);

  let responseText = '';
  if (geminiClient) {
    try {
      const res = await geminiClient.generateContent({
        prompt,
        fileData: uploadedFiles,
        temporary: true,
        expectImages: false,
      });
      responseText = res?.text || '';
    } catch (genErr) {
      console.warn(`[TemplateFood] Gemini generateContent failed: ${genErr.message}`);
    }
  }

  let parsed = parseJsonObjectFood(responseText);

  if ((!parsed || !parsed.script || parsed.script.length === 0) && geminiClient) {
    console.warn('[TemplateFood] Initial analysis parse failed or empty script. Trying direct text prompt fallback...');
    const retryPrompt = `${prompt}\n\nIMPORTANT: Return ONLY raw JSON object. Do not wrap in markdown. Ensure script has exactly 4 scenes.`;
    try {
      const retryRes = await geminiClient.generateContent({
        prompt: retryPrompt,
        fileData: uploadedFiles,
        temporary: true,
        expectImages: false,
      });
      parsed = parseJsonObjectFood(retryRes?.text || '');
    } catch (_) {}
  }

  const ctx = options.productContext || {};
  const fallbackTitle = (ctx.productTitle || 'Món Ăn Đặc Sản Thơm Ngon').trim();

  const buildFallback = () => {
    let inferredCategory = 'snack';
    const lowerTitle = fallbackTitle.toLowerCase();
    if (
      lowerTitle.includes('mì') || lowerTitle.includes('mi ') || lowerTitle.includes('bún') ||
      lowerTitle.includes('phở') || lowerTitle.includes('miến') || lowerTitle.includes('hủ tiếu') ||
      lowerTitle.includes('bánh canh') || lowerTitle.includes('noodle') || lowerTitle.includes('ramen') ||
      lowerTitle.includes('spaghetti') || lowerTitle.includes('pasta')
    ) {
      inferredCategory = 'noodle';
    } else if (lowerTitle.includes('bánh') || lowerTitle.includes('cake') || lowerTitle.includes('pastry') || lowerTitle.includes('pía')) {
      inferredCategory = 'cake';
    } else if (lowerTitle.includes('trà') || lowerTitle.includes('cà phê') || lowerTitle.includes('sữa') || lowerTitle.includes('nước') || lowerTitle.includes('drink')) {
      inferredCategory = 'drink';
    } else if (lowerTitle.includes('mắm') || lowerTitle.includes('thịt chưng') || lowerTitle.includes('ruốc') || lowerTitle.includes('kho quẹt')) {
      inferredCategory = 'ready_to_eat';
    }

    const dummyAnalysis = { productName: fallbackTitle, foodCategory: inferredCategory };
    const pProfile = analyzeFoodPhysicalProfile(dummyAnalysis);
    const pAffordance = deriveFoodAffordances(pProfile);
    const pProps = buildDynamicPropPlan(inferredCategory, pProfile.form, pProfile);
    const pWorld = buildFoodReviewWorld(inferredCategory);
    const pPlan = buildDynamicFourScenePlan(dummyAnalysis, pProfile, pAffordance, pProps, pWorld);

    let sc3Voice = 'Bẻ thử ra một cái là lớp nhân tràn trề, cắn vô nó mềm mịn đậm đà, đã cái nư ghê luôn.';
    if (pProfile.form === 'noodle') {
      sc3Voice = 'Gắp một đũa mì tươi lên là khói bốc nghi ngút, sợi mì dai mướt thấm đẫm nước xốt thơm lừng luôn.';
    } else if (pProfile.form === 'cooked_dish') {
      sc3Voice = 'Múc một thìa nóng hổi thơm phức, thớ thịt mềm tan đậm đà, ăn với cơm là chuẩn bài luôn.';
    } else if (pProfile.unitScale === 'tiny') {
      sc3Voice = 'Nhón thử một hạt cắn vô là giòn rụm rôm rốp, béo ngậy ngọt thanh, ăn một hạt là muốn ăn hoài luôn á.';
    } else if (pProfile.form === 'rice_topping') {
      sc3Voice = 'Múc một thìa rưới lên cơm nóng là thơm nức mũi, đậm đà thấm tháp từng hạt cơm, hao cơm dữ thần luôn.';
    }

    return {
      analysis: {
        productName: fallbackTitle,
        foodCategory: inferredCategory,
        originStory: (pProfile.form === 'noodle' ? 'Món mì ngon đậm vị, ăn bữa chính hay bữa phụ đều tiện lợi ấm bụng' : 'Món ngon đậm vị truyền thống, ăn vặt hay làm quà đều hết ý'),
        tasteProfile: {
          primary: 'Đậm đà, thơm béo hài hoà',
          texture: 'Bên ngoài giòn xốp/mềm mịn, bên trong ẩm mọng đậm vị',
          mouthfeel: 'Cắn một miếng là ngập tràn hương vị, ăn hoài không ngán'
        },
        heroInteraction: {
          action: pAffordance.heroAction,
          visualTarget: pAffordance.sensoryEvidence,
          sensoryTarget: pAffordance.sensoryEvidence
        },
        eatingOccasion: 'Ăn vặt xế chiều hoặc nhâm nhi cùng trà',
        buyerAppeal: 'Giao hàng nhanh, đóng gói kỹ càng, ăn là ghiền',
        voicePersona: {
          gender: 'nu',
          voiceName: 'Zephyr',
          tone: 'ngọt ngào, tự nhiên, gần gũi như người bạn sành ăn miền Nam'
        }
      },
      script: [
        {
          id: 1,
          phase: 'Discovery',
          durationSeconds: 6,
          voiceOver: `Bữa nay tui mới lùng được món ${fallbackTitle} này ngon xỉu lên xỉu xuống luôn nè.`,
          foodAction: pPlan.scene1.action,
          sensoryFocus: 'Màu sắc bao bì bắt mắt, cảm giác háo hức muốn thử liền'
        },
        {
          id: 2,
          phase: 'Show',
          durationSeconds: 6,
          voiceOver: `Mở ra cái là mùi thơm nức mũi bay khắp phòng, nhìn cái màu sắc thôi là thấy ưng bụng rồi đó.`,
          foodAction: pPlan.scene2.action,
          sensoryFocus: 'Bề mặt óng ánh, chi tiết hoàn thiện hấp dẫn'
        },
        {
          id: 3,
          phase: 'Experience',
          durationSeconds: 6,
          voiceOver: sc3Voice,
          foodAction: pPlan.scene3.action,
          sensoryFocus: `Hero Interaction: ${pAffordance.sensoryEvidence}`
        },
        {
          id: 4,
          phase: 'Verdict',
          durationSeconds: 6,
          voiceOver: `Ai mê đồ ngon thì bấm liền góc trái giỏ hàng rinh về ăn thử nha, đảm bảo ghiền liền!`,
          foodAction: pPlan.scene4.action,
          sensoryFocus: 'Tổng thể ngon mắt, thôi thúc người xem bấm mua ngay'
        }
      ]
    };
  };

  if (!parsed || !parsed.script || parsed.script.length === 0) {
    console.warn(`[TemplateFood] Gemini analysis parsing failed completely. Using intelligent food fallback.`);
    parsed = buildFallback();
  }

  // ── ENRICH WITH FOOD PHYSICAL ENGINE & AFFORDANCES ─────────────────────────
  const refs = classifyReferenceRoles(filePayloads, parsed.analysis);
  const physicalProfile = analyzeFoodPhysicalProfile(parsed.analysis, refs);
  const affordance = deriveFoodAffordances(physicalProfile, refs);
  const forbidden = deriveForbiddenFoodActions(physicalProfile);
  const world = buildFoodReviewWorld(parsed.analysis?.foodCategory);
  const propPlan = buildDynamicPropPlan(parsed.analysis?.foodCategory, physicalProfile.form, physicalProfile);
  const dynamicPlan = buildDynamicFourScenePlan(parsed.analysis, physicalProfile, affordance, propPlan, world);
  const stateMachine = buildProductStateMachine(physicalProfile, affordance.heroAction, dynamicPlan);

  parsed.analysis.referenceRoles = refs;
  parsed.analysis.foodPhysicalProfile = physicalProfile;
  parsed.analysis.affordance = affordance;
  parsed.analysis.forbiddenActions = forbidden;
  parsed.analysis.foodReviewWorld = world;
  parsed.analysis.propPlan = propPlan;
  parsed.analysis.dynamicFourScenePlan = dynamicPlan;
  parsed.analysis.productStates = stateMachine;

  if (!parsed.analysis.heroInteraction || !parsed.analysis.heroInteraction.action) {
    parsed.analysis.heroInteraction = chooseHeroInteraction(physicalProfile, affordance, refs);
  }

  const validation = validateFoodScript(parsed);
  if (!validation.valid) {
    console.warn(`[TemplateFood] Script validation warnings/errors:`, validation.errors);
  }
  if (validation.warnings && validation.warnings.length > 0) {
    console.log(`[TemplateFood] Script linter warnings:`, validation.warnings);
  }

  parsed.validation = validation;
  return parsed;
}

// ── 4. MASTER STORYBOARD GENERATION WITH ACTION RUNWAY ─────────────────────────

/**
 * Xây dựng prompt sinh Master Storyboard 4 panels cho Kênh Food Review
 * Đảm bảo Smartphone Realism + Warm Lifestyle + Action Runway Rule (Section 42).
 */
/**
 * Xây dựng prompt sinh Master Storyboard 4 panels cho Kênh Food Review
 * Đảm bảo Food Review World Bible (Section 4) + Dynamic 4-Scene + Action-specific Runway (Section 15)
 */
function buildTemplateFoodMasterPrompt(analysis = {}, options = {}) {
  const fullAnalysis = analysis.analysis || analysis || {};
  const prodName = fullAnalysis.productName || options.productTitle || 'Vietnamese food product';
  const category = fullAnalysis.foodCategory || 'snack';

  const env = getFoodEnvironmentBible(fullAnalysis, options);
  const profile = fullAnalysis.foodPhysicalProfile || analyzeFoodPhysicalProfile(fullAnalysis);
  const affordance = fullAnalysis.affordance || deriveFoodAffordances(profile);
  const propPlan = fullAnalysis.propPlan || buildDynamicPropPlan(category, profile.form, profile);
  const dynamicPlan = fullAnalysis.dynamicFourScenePlan || buildDynamicFourScenePlan(fullAnalysis, profile, affordance, propPlan, env);
  const hero = fullAnalysis.heroInteraction || { action: affordance.heroAction, visualTarget: affordance.sensoryEvidence };

  // Action-specific runway description (Section 15 & Dining Etiquette)
  let actionRunwayPrompt = '';
  const heroAct = String(hero.action || affordance.heroAction || 'inspect').toLowerCase();
  if (heroAct.includes('chopstick') || heroAct.includes('fork') || profile.form === 'noodle') {
    actionRunwayPrompt = `ACTION RUNWAY (LIFT WITH WOODEN CHOPSTICKS): A pair of smooth natural wooden chopsticks is held properly by the reviewer's hand at the upper grip, firmly lifting a generous, glistening bundle upward from the dish. STRICTLY FORBIDDEN: Bare fingers or hands touching the noodles directly. The reviewer's hand holds ONLY the upper part of the chopsticks; NO fingers touch the food.`;
  } else if (heroAct === 'scoop' || heroAct.includes('scoop') || heroAct.includes('spoon') || profile.form === 'cooked_dish' || profile.form === 'soup') {
    actionRunwayPrompt = `ACTION RUNWAY (SCOOP WITH SPOON): A wooden or ceramic spoon is gripped by its handle lifting a generous portion of "${prodName}" upward from the dish, showcasing tender glistening texture and delicate steam. Hand holds ONLY the spoon handle.`;
  } else if (heroAct === 'pour') {
    actionRunwayPrompt = `ACTION RUNWAY (POUR): Package or container is slightly tilted with "${prodName}" poised at the rim, smoothly pouring onto the serving plate.`;
  } else if (heroAct === 'break' || heroAct === 'break_open' || heroAct === 'tear' || heroAct === 'pull') {
    actionRunwayPrompt = `ACTION RUNWAY (BREAK OPEN): Hands placed on opposite sides of "${prodName}", starting moment of breaking open, preparing to reveal ${hero.visualTarget || affordance.sensoryEvidence}. Do NOT show the food completely finished or broken apart yet; show the dynamic starting moment ready for 6 seconds of motion.`;
  } else if ((heroAct === 'pick' || heroAct === 'rotate' || heroAct === 'show_handful') && (profile.unitScale === 'tiny' || profile.form === 'nuts_seeds' || profile.form === 'finger_snack')) {
    actionRunwayPrompt = `ACTION RUNWAY (TINY FOOD PICK/ROTATE): One individual unit of "${prodName}" is naturally pinched between fingertips with clear clearance to rotate 360 degrees, or a generous handful cupped in palm; do NOT break, squeeze, or crush.`;
  } else if (heroAct === 'dip') {
    actionRunwayPrompt = `ACTION RUNWAY (DIP): A piece of "${prodName}" held directly above sauce/condiment saucer, wrist orientation supporting a steady downward dipping motion.`;
  } else {
    actionRunwayPrompt = `ACTION RUNWAY: Hands or utensils placed in dynamic starting position right at the onset of ${hero.action ? hero.action.replace(/_/g, ' ') : 'inspect'}, ready for 6 seconds of smooth physical motion.`;
  }

  // Sensory texture descriptor from profile
  const sensoryEvidence = affordance.sensoryEvidence || profile.textureDescription || 'distinct appetizing texture';

  const diningEtiquette = (profile.form === 'noodle' || profile.form === 'cooked_dish' || profile.form === 'soup')
    ? `CRITICAL DINING ETIQUETTE & UTENSIL COMPLIANCE: The food is a hot cooked dish / noodle meal (${profile.form}). It MUST be handled and eaten exclusively with proper dining utensils (wooden chopsticks / ceramic spoon). STRICTLY FORBIDDEN: touching noodles, meat, or sauce with bare fingers, pinching food directly by hand, or bare-hand eating. Hand holds ONLY the chopsticks/spoon.`
    : `DINING COMPLIANCE: Realistic, natural food handling respecting authentic Vietnamese food consumption culture.`;

  const worldSetting = `FOOD REVIEW WORLD (LIFESTYLE TEA & SNACK SETTING): Authentic lived-in Vietnamese home tea & snack table setting with honey-oak wood grain, vase of fresh white roses or lucky bamboo in water glass, traditional ceramic teapot and cups, and appetizing snack plating.`;

  return [
    'LAYOUT — MANDATORY: The output image contains exactly 4 panels as 4 equal-width vertical columns arranged side-by-side left to right. Column 1 | Column 2 | Column 3 | Column 4. Each column occupies exactly 1/4 (25%) of the total image width and the full image height from top edge to bottom edge. There are NO borders, NO dividers, NO gaps, NO margins, NO decorative frames, NO film strip holes, NO black bands, NO vignettes between or around columns. Each column is a seamless photographic scene extending from top to bottom edge. DO NOT use any other layout — NOT a 1-large + multiple-small arrangement, NOT a 2×2 grid, NOT floating framed smartphone screens with padding.',
    `PRODUCT LOCK: Authentic reference item "${prodName}" (${category}). Exact shape, packaging, texture, and appetizing natural colors.`,
    worldSetting,
    `ENVIRONMENT TYPE: ${env.title}.`,
    `ENVIRONMENT DETAILS: ${env.promptFragment}`,
    `CONTINUITY LOCK: ${env.continuity}`,
    diningEtiquette,
    'Camera & Style: realistic smartphone vertical TikTok food review capture, natural warm lighting, crisp photographic realism, mouthwatering food focus, natural depth of field.',
    '',
    'STRICT VISUAL RULES: ABSOLUTELY ZERO TEXT, zero text overlays, zero subtitles, zero panel labels, zero titles, zero headers (do NOT write "PANEL 1", "PANEL 2", "DISCOVERY", "SHOW", etc. on the image), zero fake UI, zero cart icons, zero stickers, zero watermarks, zero borders, zero margins, zero frames around columns.',
    '',
    '4 COLUMNS — SAME ENVIRONMENT, SAME PRODUCT, STRICT CONTINUITY:',
    `PANEL 1 (DISCOVERY - Column 1): A young Vietnamese reviewer's well-groomed hand presents the original sealed packaging of "${prodName}" forward toward the camera in the chosen environment (${env.title}). Clear view of product packaging taking 55-70% of frame, background shows the authentic environment.`,
    `PANEL 2 (SHOW - Column 2): The food "${prodName}" is unboxed and generously arranged on ${propPlan.foregroundProp || 'a ceramic plate or bamboo tray'} on the table/counter in the exact same environment. Food takes 60-70% of frame, highlighting fresh appetizing color, portion thickness, and surface texture (${sensoryEvidence}).`,
    `PANEL 3 (HERO INTERACTION WITH ACTION RUNWAY - Column 3): Extreme close-up of ${prodName} undergoing the dynamic starting moment of interaction. MANDATORY ACTION RUNWAY: ${actionRunwayPrompt} Food and interaction take 70-80% of frame, with extreme texture detail revealing ${sensoryEvidence}. The exact same environment remains visible in the soft background bokeh. Do NOT show the food completely finished or broken apart yet.`,
    `PANEL 4 (VERDICT - Column 4): The reviewer holds up the finished, delicious piece or portion of "${prodName}" near the camera in a mouth-watering final verdict presentation in the exact same environment, inviting the viewer to taste. Beside it sits a small dipping saucer or warm teacup. Food occupies 65-80% of frame.`,
    '',
    'STRICT NEGATIVE PROMPT: text, typography, subtitles, captions, panel numbers, panel labels, headers, watermark, UI, shopping cart icon, buttons, stickers, borders, white borders, black borders, frames around panels, split screen inside a panel, distorted hands, extra fingers, blurry morphing, mismatched backgrounds between panels, changing room or table.'
  ].join('\n');
}

function buildTemplateFoodMultiStoryboardPrompt(analysis, candidateIndex = 1, options = {}) {
  const basePrompt = buildTemplateFoodMasterPrompt(analysis, options);
  const variations = [
    'Warm neutral daylight, natural honey oak wooden table, subtle tea cup in background.',
    'Slightly brighter morning lighting, rustic walnut tabletop, clean ceramic dish.',
    'Warm cozy indoor afternoon light, bamboo tray accent, crisp focus on food sheen.',
    'Natural window side light, warm lifestyle ambiance, rich texture contrast.',
  ];
  const variation = variations[(candidateIndex - 1) % variations.length];
  return `${basePrompt}\n\nAtmosphere variation #${candidateIndex}: ${variation}`;
}

// ── 5. MULTI-CANDIDATE VISUAL QA & EVALUATION (100 PTS) ────────────────────────

/**
 * Detects whether a food storyboard image has horizontal dividing lines or borders,
 * which indicates an invalid layout (such as a collage, comic grid, or floating bordered cards)
 * instead of the mandatory 4 equal vertical columns spanning the full height.
 */
function detectHorizontalDividersFood(imageInput) {
  if (!imageInput) return { hasDividers: false, dividerCount: 0 };
  const tmpId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const tmpIn = path.join(os.tmpdir(), `detect-food-layout-${tmpId}.png`);
  try {
    if (Buffer.isBuffer(imageInput)) {
      fs.writeFileSync(tmpIn, imageInput);
    } else if (typeof imageInput === 'string' && fs.existsSync(imageInput)) {
      return _runFoodDividerAnalysis(imageInput);
    } else if (typeof imageInput === 'string') {
      const b64 = imageInput.includes('base64,') ? imageInput.split('base64,')[1] : imageInput;
      fs.writeFileSync(tmpIn, Buffer.from(b64, 'base64'));
    } else {
      return { hasDividers: false, dividerCount: 0 };
    }
    return _runFoodDividerAnalysis(tmpIn);
  } catch (err) {
    console.warn(`[TemplateFood] Layout divider detection error: ${err.message}`);
    return { hasDividers: false, dividerCount: 0 };
  } finally {
    try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch (_) {}
  }
}

function _runFoodDividerAnalysis(filePath) {
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
    let brightCount = 0;
    let darkCount = 0;
    const xStart = Math.floor(width * 0.15);
    const xEnd = Math.floor(width * 0.85);
    const span = xEnd - xStart;
    for (let x = xStart; x < xEnd; x++) {
      const val = raw[y * width + x];
      if (val > 235) brightCount++;
      if (val < 20) darkCount++;
    }
    if (brightCount / span > 0.35 || darkCount / span > 0.35) {
      detectedRows++;
    }
  }
  return { hasDividers: detectedRows >= 3, dividerCount: detectedRows };
}

function buildTemplateFoodVerificationPrompt(analysis) {
  const fullAnalysis = analysis.analysis || analysis || {};
  const prodName = fullAnalysis.productName || 'Vietnamese food product';
  const profile = fullAnalysis.foodPhysicalProfile || analyzeFoodPhysicalProfile(fullAnalysis);
  const affordance = fullAnalysis.affordance || deriveFoodAffordances(profile);
  const heroAction = fullAnalysis.heroInteraction?.action || affordance.heroAction || 'inspect';
  const forbidden = fullAnalysis.forbiddenActions || deriveForbiddenFoodActions(profile);
  const env = getFoodEnvironmentBible(fullAnalysis);

  return `### SYSTEM ROLE:
You are an expert AI Food Video QA Director and Visual Inspector.
Evaluate the candidate storyboard images against the 100-point Food Review Quality Standard.

### CRITICAL MANDATORY LAYOUT RULE (PASS/FAIL):
- The ONLY acceptable layout is EXACTLY 4 equal-width vertical columns side-by-side from left to right (Column 1, 2, 3, 4). Each column must span the full canvas height from top to bottom (100% height).
- ANY candidate with a collage, comic grid, 2x2 grid, 1 large image + smaller stacked images, floating framed cards with borders, or horizontal dividing lines splitting columns into sub-panels is a HARD REJECT (is4VerticalColumns: false, score: 0). NEVER select such a candidate!
- CONTINUITY & ENVIRONMENT LOCK: All 4 columns MUST share the exact same background environment (${env.title}) with zero world-drifting or jarring room changes.

### EVALUATION CRITERIA (100 Points Total):
1. Mandatory Layout (Pass/Fail): Exactly 4 equal vertical columns, zero borders, zero text labels.
2. Product Fidelity (Max 20): Food matches physical profile (${profile.form}, ${profile.unitScale}), authentic textures, no deformed package, no product form mutations.
3. Physical Action Correctness (Max 20): Panel 3 correctly executes the Hero Action ("${heroAction}") with Action Runway (starting moment, not finished state). Action is physically valid for ${profile.form}.
4. Reference-Style Environment (Max 15): Consistent ${env.title} across ALL 4 columns. Same tabletop/counter surface, lighting direction, and background elements. Not sterile studio or CGI.
5. Sensory Evidence (Max 10): ${affordance.sensoryEvidence} visually readable and appetizing.
6. Hand/Tool Anatomy (Max 8): 5 natural fingers per hand, correct grip/pinch, no merged joints or extra thumbs.
7. Appetite Appeal (Max 7): Mouth-watering presentation, delicious natural colors.
8. Action Runway / Start State (Max 15): Panel 3 shows early phase of action, leaving ample motion runway for 6s video.

### HARD REJECT RULES (Instantly score 0 and fail candidate if any apply):
- INVALID_LAYOUT: Any collage, 2x2 grid, floating framed cards, or dividing borders.
- TEXT_OVERLAYS: Any printed text ("PANEL 1", "PANEL 2", subtitles, or labels) on the image.
- BACKGROUND_TOO_GENERIC: Sterile CGI, plain white backdrop, or unnatural artificial studio look.
- BACKGROUND_WORLD_DRIFT: Inconsistent room/table between panels (e.g. street in panel 1, dining table in panel 2).
- FORCED_BREAK: Bending or breaking food that cannot be broken by hand.
- FORCED_SQUEEZE: Squeezing or crushing items that should not be squished.
- SHOW_SAY_MISMATCH: Visual actions conflicting with narrative review focus.
- BARE_HAND_ON_UTENSIL_FOOD: Human fingers or bare hands touching noodles, soup, or sauced hot food directly.
- INVALID_FOOD_ACTION: Performing an invalid action for ${profile.form}.
- PRODUCT_SCALE_ACTION_MISMATCH: Trying to break, tear or squeeze tiny food (${profile.unitScale}).
Forbidden Actions to strictly check: ${forbidden.join(', ')}.

### OUTPUT JSON FORMAT:
{
  "candidates": [
    {
      "index": 1,
      "is4VerticalColumns": true,
      "totalScore": 88,
      "breakdown": {
        "productFidelity": 18,
        "physicalAction": 18,
        "environment": 13,
        "sensoryEvidence": 9,
        "handAnatomy": 7,
        "appetiteAppeal": 6,
        "continuity": 4,
        "actionRunway": 13
      },
      "passedHardReject": true,
      "hardRejectErrors": [],
      "notes": "Good 4 equal vertical columns, consistent environment and action runway on panel 3"
    }
  ],
  "bestOverallIndex": 1,
  "panelPicks": {
    "panel1": 1,
    "panel2": 1,
    "panel3": 1,
    "panel4": 1
  }
}`;
}

async function verifyMultiStoryboardWithGeminiVision(geminiClient, candidateBuffers, savedInputs, analysis) {
  // 1. Programmatic layout pre-check on every candidate
  const layoutChecks = (candidateBuffers || []).map((buf, i) => {
    const check = detectHorizontalDividersFood(buf);
    return {
      index: i + 1,
      hasDividers: check.hasDividers,
      dividerCount: check.dividerCount,
    };
  });

  layoutChecks.forEach(lc => {
    if (lc.hasDividers) {
      console.warn(`[TemplateFood] ⚠️ Candidate #${lc.index} flagged by layout pre-check: horizontal dividers detected (${lc.dividerCount} rows) -> DISQUALIFIED`);
    } else {
      console.log(`[TemplateFood] ✅ Candidate #${lc.index} passed layout pre-check (clean 4 vertical columns)`);
    }
  });

  const prompt = buildTemplateFoodVerificationPrompt(analysis || {});
  const uploadedFiles = [];
  if (geminiClient && Array.isArray(candidateBuffers)) {
    for (let i = 0; i < candidateBuffers.length; i++) {
      const buf = candidateBuffers[i];
      if (!buf) continue;
      const filename = `candidate-${i + 1}.png`;
      try {
        const url = await geminiClient.uploadFile(buf, filename, 'image/png');
        if (url) uploadedFiles.push({ url, filename, mimeType: 'image/png' });
      } catch (upErr) {
        console.warn(`[TemplateFood] Failed to upload candidate ${filename}: ${upErr.message}`);
      }
    }
  }

  console.log(`[TemplateFood] Step 3: Verifying ${candidateBuffers.length} storyboard candidates via Gemini Vision QA...`);
  try {
    if (geminiClient && uploadedFiles.length > 0) {
      const res = await geminiClient.generateContent({
        prompt,
        fileData: uploadedFiles,
        temporary: true,
        expectImages: false,
      });
      const parsed = parseJsonObjectFood(res?.text || '');
      if (parsed && Array.isArray(parsed.candidates) && parsed.candidates.length > 0) {
        // Merge with programmatic layout check: if dividers detected, override to failed
        parsed.candidates.forEach(c => {
          const idx = c.index || c.candidateIndex || 1;
          const progCheck = layoutChecks[idx - 1];
          if (progCheck && progCheck.hasDividers) {
            c.is4VerticalColumns = false;
            c.totalScore = 0;
            c.passedHardReject = false;
            if (!Array.isArray(c.hardRejectErrors)) c.hardRejectErrors = [];
            c.hardRejectErrors.push('INVALID_LAYOUT_DIVIDERS_DETECTED');
          }
        });

        // Filter valid candidates if any
        const validCandidates = parsed.candidates.filter(c => c.passedHardReject !== false && c.totalScore > 0);
        if (validCandidates.length > 0) {
          validCandidates.sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
          parsed.bestOverallIndex = validCandidates[0].index || validCandidates[0].candidateIndex || 1;
        }
        return parsed;
      }
    }
  } catch (err) {
    console.warn(`[TemplateFood] Vision QA evaluation failed (${err.message}).`);
  }

  // Fallback: pick first candidate that passed programmatic layout check
  const firstCleanIdx = layoutChecks.findIndex(lc => !lc.hasDividers);
  const fallbackBestIdx = firstCleanIdx !== -1 ? firstCleanIdx + 1 : 1;

  console.warn(`[TemplateFood] QA_UNAVAILABLE: Vision QA evaluation was not completed. Marking QA as unavailable.`);
  return {
    qaStatus: 'QA_UNAVAILABLE',
    qaAvailable: false,
    candidates: candidateBuffers.map((_, i) => ({
      index: i + 1,
      totalScore: layoutChecks[i]?.hasDividers ? 0 : 80,
      passedHardReject: !layoutChecks[i]?.hasDividers,
      qaStatus: 'QA_UNAVAILABLE',
      notes: layoutChecks[i]?.hasDividers ? 'Disqualified by layout pre-check' : 'Passed programmatic layout pre-check',
    })),
    bestOverallIndex: fallbackBestIdx,
    panelPicks: { panel1: fallbackBestIdx, panel2: fallbackBestIdx, panel3: fallbackBestIdx, panel4: fallbackBestIdx },
  };
}

function selectBestCandidateForPanel(evalResult, panelIndex) {
  if (!evalResult) return 1;
  const pickKey = `panel${panelIndex}`;
  if (evalResult.panelPicks && evalResult.panelPicks[pickKey]) {
    return Number(evalResult.panelPicks[pickKey]) || 1;
  }
  return Number(evalResult.bestOverallIndex) || 1;
}

// ── 6. SLICING & COMPOSING STORYBOARDS (FFMPEG) ────────────────────────────────

/**
 * Cắt Master Storyboard 16:9 thành 4 vertical panels bằng nhau (mỗi panel rộng iw / 4)
 * Giữ nguyên 100% tỷ lệ gốc (Zero-Distortion), làm tròn số chẵn cho encoder (chuẩn tproduct)
 */
function sliceMasterStoryboardFood(storyboardBuffer) {
  const tmpId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `food-in-${tmpId}.png`);
  const outPaths = [1, 2, 3, 4].map(i => path.join(tmpDir, `food-panel-${i}-${tmpId}.png`));

  const buf = Buffer.isBuffer(storyboardBuffer)
    ? storyboardBuffer
    : (typeof storyboardBuffer === 'string' && fs.existsSync(storyboardBuffer)
      ? fs.readFileSync(storyboardBuffer)
      : Buffer.from(storyboardBuffer, 'base64'));

  try {
    fs.writeFileSync(inputPath, buf);
    // Tách 4 vertical panels từ Master Storyboard 16:9:
    // Giữ nguyên 100% tỷ lệ gốc (Zero-Distortion), mỗi panel rộng iw / 4 (làm tròn số chẵn cho encoder)
    for (let i = 0; i < 4; i++) {
      const cropFilter = `crop=trunc(iw/4/2)*2:trunc(ih/2)*2:trunc(iw/4/2)*2*${i}:0`;
      execSync(`"${ffmpegPath}" -y -i "${inputPath}" -vf "${cropFilter}" -frames:v 1 "${outPaths[i]}"`, {
        timeout: 15000,
        stdio: 'pipe',
      });
    }
    const buffers = outPaths.map(p => fs.readFileSync(p));
    console.log(`[TemplateFood] ✅ Sliced Master Storyboard into 4 equal vertical panels: ${buffers.map((b, i) => `Panel ${i + 1} (${(b.length / 1024).toFixed(0)} KB)`).join(', ')}`);
    return buffers;
  } finally {
    [inputPath, ...outPaths].forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    });
  }
}

/**
 * Ghép 4 panel thành Master Storyboard 16:9 chuẩn (1920x1080)
 */
function composeMasterStoryboardFood(panels, outputPath) {
  const tmpId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const tmpDir = os.tmpdir();
  const tmpFiles = [];

  try {
    const inputArgs = [];
    for (let i = 0; i < 4; i++) {
      const p = panels[i];
      const pPath = path.join(tmpDir, `food-comp-${i + 1}-${tmpId}.png`);
      tmpFiles.push(pPath);
      const buf = Buffer.isBuffer(p)
        ? p
        : (p && Buffer.isBuffer(p.buffer)
          ? p.buffer
          : (p && p.imagePath && fs.existsSync(p.imagePath)
            ? fs.readFileSync(p.imagePath)
            : null));
      if (!buf) throw new Error(`Missing panel data for panel ${i + 1}`);
      fs.writeFileSync(pPath, buf);
      inputArgs.push('-i', pPath);
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const filterComplex = '[0:v]scale=-1:1080[p1];[1:v]scale=-1:1080[p2];[2:v]scale=-1:1080[p3];[3:v]scale=-1:1080[p4];[p1][p2][p3][p4]hstack=inputs=4[out]';
    execSync(`"${ffmpegPath}" -y ${inputArgs.map(a => `"${a}"`).join(' ')} -filter_complex "${filterComplex}" -map "[out]" -frames:v 1 "${outputPath}"`, {
      timeout: 30000,
      stdio: 'pipe',
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error('FFmpeg failed to compose Food Master Storyboard');
    }
    console.log(`[TemplateFood] ✅ Composed 4 panels into 16:9 Food Master Storyboard (1920x1080): ${outputPath}`);

    const jpgPath = outputPath.replace(/\.png$/i, '.jpg');
    try {
      execSync(`"${ffmpegPath}" -y -i "${outputPath}" -q:v 2 -update 1 "${jpgPath}"`, { timeout: 15000, stdio: 'pipe' });
    } catch (_) {}
  } finally {
    tmpFiles.forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    });
  }
}

// ── 7. VEO 3 VIDEO PROMPTS & MOTION ARC (SECTION 21 & FULL-BLEED 9:16 CANVAS) ──

/**
 * Xây dựng prompt sinh video 6s cho từng Panel theo chuẩn Veo 3 / Google Flow
 * Đảm bảo:
 * - Format: Video Prompt v3 (Section 21) trong tiếng Anh chuẩn motion-first
 * - Full-bleed 9:16 vertical canvas: chỉ thị mở rộng nền ra 2 mép, triệt tiêu viền đen (zero crop)
 * - State machine transition: initial -> scene1End -> scene2End -> scene3End -> scene4End
 * - Khoá sản phẩm 100%, không chữ, không UI, video im lặng
 */
function buildTemplateFoodVideoPrompts(analysis = {}, options = {}) {
  const fullAnalysis = analysis.analysis || analysis || {};
  const prodName = fullAnalysis.productName || options.productTitle || 'Vietnamese food product';
  const category = fullAnalysis.foodCategory || 'snack';
  const profile = fullAnalysis.foodPhysicalProfile || analyzeFoodPhysicalProfile(fullAnalysis);
  const affordance = fullAnalysis.affordance || deriveFoodAffordances(profile);
  const forbidden = fullAnalysis.forbiddenActions || deriveForbiddenFoodActions(profile);
  const states = fullAnalysis.productStates || buildProductStateMachine(profile, affordance.heroAction);
  const env = getFoodEnvironmentBible(fullAnalysis, options);
  const propPlan = fullAnalysis.propPlan || buildDynamicPropPlan(category, profile.form, profile);
  const hero = fullAnalysis.heroInteraction || { action: affordance.heroAction, visualTarget: affordance.sensoryEvidence };

  const forbiddenText = forbidden.length > 0 ? forbidden.join(', ') : 'forced break, forced squeeze, mutation';
  const sourcing = buildSourcingScenePrompt(env.key, prodName, category);

  const envBackgroundPrompt = `Keep the exact same authentic setting from the Start Frame (${env.title}: ${env.surface}, ${env.promptFragment}). The scene background naturally extends seamlessly to the extreme left and right borders of the 9:16 frame. Full-bleed composition with zero empty space.`;

  // SCENE 1: DISCOVERY & SOURCING HOOK
  const p1 = [
    `Animate this Start Frame into a realistic 6-second smartphone food-review video filling the full 9:16 vertical smartphone frame edge-to-edge.`,
    ``,
    `PRIMARY ACTION:`,
    sourcing.videoPrompt,
    ``,
    `PRODUCT STATE TRANSITION:`,
    `${states.initial || 'unopened original package at sourcing location'} -> ${states.scene1End || 'package tilted toward camera with visible branding'}`,
    ``,
    `HAND MOTION:`,
    `Young Vietnamese woman's well-groomed female hand holds or receives the package, smoothly guiding it forward with steady, natural handheld movement.`,
    ``,
    `TOOL MOTION:`,
    `None. Natural hand only.`,
    ``,
    `CAMERA:`,
    `Subtle handheld forward push-in, keeping crisp focus on product packaging with natural background depth of field.`,
    ``,
    `SENSORY EVIDENCE TO REVEAL:`,
    `Clean, appealing packaging, vibrant color, pristine sealed state, inviting discovery mood.`,
    ``,
    `BACKGROUND & CANVAS:`,
    envBackgroundPrompt,
    ``,
    `FORBIDDEN:`,
    `${forbiddenText}. STRICTLY NO black bars, NO pillarboxing, NO letterboxing, NO side borders, NO padding lines. Do not invent a new food form. Do not mutate packaging. Keep motion natural and physically plausible. Silent video.`
  ].join('\n\n');

  // SCENE 2: SHOW
  let s2Action = '';
  let s2Hand = '';
  let s2Evidence = affordance.sensoryEvidence || profile.textureDescription || 'outer surface finish and portion thickness';
  if (profile.form === 'noodle') {
    s2Action = `Camera pans over a freshly prepared, steaming hot bowl of "${prodName}" in a deep ceramic bowl, displaying the rich glossy sauce, tender beef cubes/toppings, and fresh aromatic herbs, with a pair of smooth wooden chopsticks resting neatly on the rim or rest.`;
    s2Hand = `Hand gently turns the bowl slightly on the wooden table to present the most appetizing angle, fingers touching only the outer base of the ceramic bowl without touching food.`;
  } else if (profile.form === 'cooked_dish') {
    s2Action = `Camera reveals a freshly prepared, hot serving dish of "${prodName}" with rich glossy texture, fragrant steam, and a clean serving spoon resting nearby.`;
    s2Hand = `Hand presents the dish gently on the table, touching only the outer dish rim.`;
  } else if (profile.unitScale === 'tiny' || profile.form === 'nuts_seeds') {
    s2Action = `Hand smoothly tilts package or bowl to display a generous cluster of "${prodName}" on ${propPlan.foregroundProp}, showing uniform size, glossy roasted coating, and crispy texture.`;
    s2Hand = `Hand gently presents the dish forward, fingers pointing subtly toward the cluster of pieces.`;
  } else if (profile.form === 'rice_topping' || profile.form === 'paste') {
    s2Action = `Hand unscrews or lifts lid off jar of "${prodName}", placing lid neatly aside to reveal the rich, moist shredded fibers inside.`;
    s2Hand = `Hand unscrews lid smoothly, rotating wrist naturally.`;
  } else {
    s2Action = `Hand holds or presents a portion of "${prodName}" on ${propPlan.foregroundProp}, gently rotating it 30 degrees to display crust thickness, color, and mouth-watering freshness.`;
    s2Hand = `Fingertips hold the food or plate stably, rotating smoothly to reveal outer contours.`;
  }

  const p2 = [
    `Animate this Start Frame into a realistic 6-second smartphone food-review video filling the full 9:16 vertical smartphone frame edge-to-edge.`,
    ``,
    `PRIMARY ACTION:`,
    s2Action,
    ``,
    `PRODUCT STATE TRANSITION:`,
    `${states.scene1End || 'package on table'} -> ${states.scene2End || 'opened product with outer surface showcased'}`,
    ``,
    `HAND MOTION:`,
    s2Hand,
    ``,
    `TOOL MOTION:`,
    `None or simple plate adjustment.`,
    ``,
    `CAMERA:`,
    `Macro close-up, gently panning down to emphasize mouth-watering surface texture and portion thickness.`,
    ``,
    `SENSORY EVIDENCE TO REVEAL:`,
    s2Evidence,
    ``,
    `BACKGROUND & CANVAS:`,
    envBackgroundPrompt,
    ``,
    `FORBIDDEN:`,
    `${forbiddenText}. STRICTLY NO black bars, NO pillarboxing, NO letterboxing, NO side borders, NO padding lines. Do not deform the food. Do not perform forbidden actions. Silent video.`
  ].join('\n\n');

  // SCENE 3: HERO INTERACTION
  let s3Action = '';
  let s3Hand = '';
  let s3Tool = 'None.';
  const heroAct = String(hero.action || affordance.heroAction || 'inspect').toLowerCase();
  if (profile.form === 'noodle') {
    s3Action = `A pair of natural wooden chopsticks smoothly lifts a luscious, glistening bundle of "${prodName}" noodles upward from the steaming ceramic bowl toward the camera, showcasing the tender noodle elasticity and rich clinging sauce as steam rises gracefully.`;
    s3Hand = `Female hand holds the chopsticks properly at the upper grip, controlling the lift smoothly. Under NO circumstances do bare fingers touch the noodles, sauce, or toppings. Only chopsticks touch the food.`;
    s3Tool = `Pair of wooden chopsticks lifting the noodle bundle smoothly.`;
  } else if (heroAct.includes('chopstick') || heroAct.includes('fork')) {
    s3Action = `A pair of natural wooden chopsticks smoothly picks up an appetizing, glistening piece of "${prodName}" from the serving dish/bamboo tray and lifts it upward toward the camera, showcasing its succulent texture, rich seasoning, and authentic mouth-watering details.`;
    s3Hand = `Female hand holds the chopsticks properly at the upper grip, controlling the lift smoothly. Under NO circumstances do bare fingers touch the food or sauce directly. Only chopsticks touch the food.`;
    s3Tool = `Pair of wooden chopsticks picking and lifting food steadily.`;
  } else if (profile.form === 'cooked_dish' || heroAct === 'scoop' || heroAct.includes('scoop') || heroAct.includes('spoon')) {
    s3Action = `A wooden spoon smoothly scoops a generous serving of "${prodName}" from the bowl/dish, lifting it upward toward the camera so viewers clearly observe the tender texture and savory sauce sheen.`;
    s3Hand = `Hand holds spoon handle firmly, wrist tilting upward smoothly. Under NO circumstances do bare fingers touch the hot food or sauce directly.`;
    s3Tool = `Wooden spoon lifting food steadily.`;
  } else if (heroAct === 'pick' || heroAct === 'rotate' || heroAct === 'show_handful' || profile.unitScale === 'tiny') {
    s3Action = `Index finger and thumb delicately pinch one single unit of "${prodName}" in front of the lens and smoothly rotate it 360 degrees under natural daylight, showing its complete spherical coating and authentic size.`;
    s3Hand = `Index and thumb perform smooth rotational motion without squeezing, crushing, or breaking the food.`;
  } else if (heroAct === 'break' || heroAct === 'break_open' || heroAct === 'tear' || heroAct === 'pull') {
    s3Action = `Both hands gently pull apart "${prodName}" along its natural seam, cleanly splitting it in two to reveal the luscious, steamy, soft interior filling (${hero.visualTarget || affordance.sensoryEvidence}).`;
    s3Hand = `Two hands apply outward rotational pull, fingers flexing naturally as the pastry yields.`;
  } else if (heroAct === 'pour') {
    s3Action = `Hand tilts the container, pouring "${prodName}" smoothly in a steady stream into the waiting vessel below.`;
    s3Hand = `Hand tilts container gradually with controlled wrist angle.`;
  } else if (heroAct === 'dip') {
    s3Action = `Hand lowers "${prodName}" steadily into the dipping sauce, gently swirling once to coat the tip appetizingly.`;
    s3Hand = `Hand lowers food with controlled downward motion, subtle swirl at bottom.`;
  } else {
    s3Action = `Reviewer executes ${hero.action ? hero.action.replace(/_/g, ' ') : 'inspect'} on "${prodName}", clearly unveiling ${affordance.sensoryEvidence}.`;
    s3Hand = `Fingers manipulate food naturally with realistic human anatomy and gentle pressure.`;
  }

  const s3Forbidden = (profile.form === 'noodle' || profile.form === 'cooked_dish')
    ? `${forbiddenText}, bare hand touching food, eating noodles with bare hands, grabbing noodles with fingers. STRICTLY NO black bars, NO pillarboxing, NO letterboxing, NO side borders, NO padding lines. Do not force break or crush. Silent video.`
    : `${forbiddenText}. STRICTLY NO black bars, NO pillarboxing, NO letterboxing, NO side borders, NO padding lines. Do not force break or crush. Do not mutate product into pastry or dough. Silent video.`;

  const p3 = [
    `Animate this Start Frame into a realistic 6-second smartphone food-review video filling the full 9:16 vertical smartphone frame edge-to-edge.`,
    ``,
    `PRIMARY ACTION:`,
    s3Action,
    ``,
    `PRODUCT STATE TRANSITION:`,
    `${states.scene2End || 'starting position ready for hero action'} -> ${states.scene3End || 'hero action completed revealing core texture'}`,
    ``,
    `HAND MOTION:`,
    s3Hand,
    ``,
    `TOOL MOTION:`,
    s3Tool,
    ``,
    `CAMERA:`,
    `Extreme macro close-up, sharp lock on the point of interaction, background beautifully blurred.`,
    ``,
    `SENSORY EVIDENCE TO REVEAL:`,
    affordance.sensoryEvidence || 'core texture reveal',
    ``,
    `BACKGROUND & CANVAS:`,
    envBackgroundPrompt,
    ``,
    `FORBIDDEN:`,
    s3Forbidden
  ].join('\n\n');

  // SCENE 4: VERDICT
  let s4Action = '';
  let s4Hand = '';
  if (profile.form === 'noodle') {
    s4Action = `Reviewer presents the complete, mouth-watering bowl of "${prodName}" with chopsticks resting across the ceramic rim, delicate steam rising under warm natural light, delivering an irresistible final dining invitation.`;
    s4Hand = `Hands hold the sides of the ceramic bowl safely and present it toward the camera with inviting warmth.`;
  } else if (profile.form === 'cooked_dish') {
    s4Action = `Reviewer presents the delicious hot dish of "${prodName}" ready to enjoy with spoon rested neatly, enticing viewers to try immediately.`;
    s4Hand = `Hands hold the dish base gently and present it toward the camera.`;
  } else if (profile.unitScale === 'tiny' || profile.form === 'nuts_seeds') {
    s4Action = `Reviewer presents a generous handful of "${prodName}" resting in an open palm toward the camera, inviting the viewer to snack, with the warm cup of tea in the soft background.`;
    s4Hand = `Palm open, relaxed natural fingers offering the food warmly.`;
  } else if (profile.form === 'rice_topping' || profile.form === 'paste') {
    s4Action = `Reviewer rests the spoon filled with savory "${prodName}" atop a steaming bowl of fragrant white rice, presenting the irresistible pairing directly to the camera.`;
    s4Hand = `Hand rests spoon atop rice bowl, holding bowl gently at base.`;
  } else {
    s4Action = `Reviewer holds the satisfying completed serving of "${prodName}" close to the lens, daylight highlighting its tempting textures, with subtle welcoming motion.`;
    s4Hand = `Hand gently presents food toward viewer, steady and inviting.`;
  }

  const p4 = [
    `Animate this Start Frame into a realistic 6-second smartphone food-review video filling the full 9:16 vertical smartphone frame edge-to-edge.`,
    ``,
    `PRIMARY ACTION:`,
    s4Action,
    ``,
    `PRODUCT STATE TRANSITION:`,
    `${states.scene3End || 'product showcased in core state'} -> ${states.final || 'mouth-watering final verdict shot ready to enjoy'}`,
    ``,
    `HAND MOTION:`,
    s4Hand,
    ``,
    `TOOL MOTION:`,
    `None.`,
    ``,
    `CAMERA:`,
    `Gentle handheld pull-out settling into a warm, inviting final composition.`,
    ``,
    `SENSORY EVIDENCE TO REVEAL:`,
    `Mouth-watering completed presentation, fresh and appetizing, irresistible craving.`,
    ``,
    `BACKGROUND & CANVAS:`,
    envBackgroundPrompt,
    ``,
    `FORBIDDEN:`,
    `${forbiddenText}. STRICTLY NO black bars, NO pillarboxing, NO letterboxing, NO side borders, NO padding lines. Do not deform the food. Silent video.`
  ].join('\n\n');

  const result = [p1, p2, p3, p4];
  result.panel1 = p1;
  result.panel2 = p2;
  result.panel3 = p3;
  result.panel4 = p4;
  result.allPrompts = [p1, p2, p3, p4];
  return result;
}

function buildTemplateFood6sPanelPrompts(analysis, options = {}) {
  const allPrompts = buildTemplateFoodVideoPrompts(analysis, options);
  if (options.panelIndex && options.panelIndex >= 1 && options.panelIndex <= 4) {
    let p = allPrompts[options.panelIndex - 1];
    if (options.customInstruction) {
      p += `\n\nCUSTOM INSTRUCTION: ${options.customInstruction}. Preserve 9:16 full-bleed canvas with NO black bars or borders.`;
    }
    return p;
  }
  return allPrompts;
}

function buildTemplateFoodRemakePrompt(analysis, targetPanelIndex, customInstruction = '') {
  const basePrompts = buildTemplateFoodVideoPrompts(analysis);
  const target = Math.max(1, Math.min(4, Number(targetPanelIndex) || 1));
  let prompt = basePrompts[target - 1];
  if (customInstruction) {
    prompt += `\n\nCUSTOM INSTRUCTION: ${customInstruction}. Maintain Smartphone Realism, strict food fidelity, and full-bleed 9:16 framing without black bars.`;
  }
  return prompt;
}

function buildTemplateFoodRemakeAllPrompt(analysis, customInstruction = '') {
  let prompt = buildTemplateFoodMasterPrompt(analysis);
  if (customInstruction) {
    prompt += `\nUSER CUSTOM ADJUSTMENT: ${customInstruction}. Maintain 100% food fidelity and Action Runway in panel 3.`;
  }
  return prompt;
}

function buildTemplateFoodRemakeVideoJobs(runDir, requestedIndices = [1], customInstruction = '', analysis = null) {
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
    const prompt = buildTemplateFood6sPanelPrompts(analysis || {}, { panelIndex: idx, customInstruction });

    jobs.push({
      index: idx,
      panelIndex: idx,
      prompt,
      imagePath: pPath,
      buffer: pBuf,
      videoModelKey: 'abra_r2v_8s',
    });
  }

  return jobs;
}

// ── 8. TELEGRAM INLINE KEYBOARDS ──────────────────────────────────────────────

function buildFoodInlineKeyboard(runId) {
  return {
    inline_keyboard: [
      [
        { text: '🔄 Remake Cảnh 1', callback_data: `tfood_remake:1:${runId}` },
        { text: '🔄 Remake Cảnh 2', callback_data: `tfood_remake:2:${runId}` },
      ],
      [
        { text: '🔄 Remake Cảnh 3', callback_data: `tfood_remake:3:${runId}` },
        { text: '🔄 Remake Cảnh 4', callback_data: `tfood_remake:4:${runId}` },
      ],
      [
        { text: '🎲 Remake Toàn Bộ', callback_data: `tfood_remake_all:${runId}` },
        { text: '✅ OK Sinh Video 24s', callback_data: `tfood_ok:${runId}` },
      ]
    ]
  };
}

function buildFoodVideoInlineKeyboard(runId) {
  return {
    inline_keyboard: [
      [
        { text: '🔄 Tạo lại Video Cảnh 1', callback_data: `tfood_remake_video:1:${runId}` },
        { text: '🔄 Tạo lại Video Cảnh 2', callback_data: `tfood_remake_video:2:${runId}` },
      ],
      [
        { text: '🔄 Tạo lại Video Cảnh 3', callback_data: `tfood_remake_video:3:${runId}` },
        { text: '🔄 Tạo lại Video Cảnh 4', callback_data: `tfood_remake_video:4:${runId}` },
      ],
      [
        { text: '📦 Tải các Video Panel', callback_data: `tfood_download_panels:${runId}` },
      ],
      [
        { text: '🚀 Đăng lên TikTok Shop', callback_data: `tfood_upload:${runId}` },
      ]
    ]
  };
}

// ── 9. VIDEO MERGE & AUDIO MUX (24 SECONDS TARGET) ────────────────────────────

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

function merge4PanelsWithVoice(panelVideoPaths, voiceAudioPath, outputMergedPath) {
  ensureDir(path.dirname(outputMergedPath));

  const hasVoice = voiceAudioPath && fs.existsSync(voiceAudioPath);
  const voiceDuration = hasVoice ? getMediaDuration(voiceAudioPath) : 0;

  // Tính tổng thời lượng video của 4 panels
  let totalVideoDuration = 0;
  for (let i = 0; i < 4; i++) {
    const d = getMediaDuration(panelVideoPaths[i]) || 6.0;
    totalVideoDuration += d;
  }
  if (totalVideoDuration <= 0) totalVideoDuration = 24.0;

  // QUY TẮC BẮT BUỘC: Ưu tiên thời lượng của audio khi merge vào video!
  // Nếu audio thực tế dài 26s (hoặc bất kỳ độ dài nào), video phải co/giãn khớp chính xác với audio
  const finalDuration = (voiceDuration > 0) ? voiceDuration : totalVideoDuration;

  const filterParts = [];
  for (let i = 0; i < 4; i++) {
    filterParts.push(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=disable,setsar=1[v${i}]`);
  }
  filterParts.push(`[v0][v1][v2][v3]concat=n=4:v=1:a=0[vconcat]`);

  // Nếu finalDuration khác totalVideoDuration, co giãn mượt tốc độ phát video để khớp hoàn toàn với voice
  if (voiceDuration > 0 && Math.abs(voiceDuration - totalVideoDuration) > 0.05) {
    const speedRatio = voiceDuration / totalVideoDuration;
    filterParts.push(`[vconcat]setpts=${speedRatio.toFixed(6)}*PTS[vout]`);
  } else {
    filterParts.push(`[vconcat]null[vout]`);
  }

  const inputArgs = [];
  for (let i = 0; i < 4; i++) {
    inputArgs.push('-i', path.resolve(panelVideoPaths[i]));
  }

  let args = ['-y', ...inputArgs];
  if (hasVoice) {
    args.push('-i', path.resolve(voiceAudioPath));
    args.push(
      '-filter_complex', filterParts.join(';'),
      '-map', '[vout]',
      '-map', '4:a',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '22',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-t', finalDuration.toFixed(2),
      outputMergedPath
    );
  } else {
    args.push(
      '-filter_complex', filterParts.join(';'),
      '-map', '[vout]',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '22',
      '-an',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-t', finalDuration.toFixed(2),
      outputMergedPath
    );
  }

  execSync(`"${ffmpegPath}" ${args.map(a => `"${a}"`).join(' ')}`, { stdio: 'pipe', timeout: 180000 });
  if (!fs.existsSync(outputMergedPath)) {
    throw new Error('FFmpeg merge4PanelsWithVoice completed but output file not created');
  }
  return outputMergedPath;
}

// ── 9B. MARKDOWN LOGGING (PROMPT.MD & PROMPTS.MD) ─────────────────────────────

function writeMarkdownLog(runDir, content) {
  try {
    fs.writeFileSync(path.join(runDir, 'prompts.md'), content, 'utf8');
    fs.writeFileSync(path.join(runDir, 'prompt.md'), content, 'utf8');
  } catch (e) {
    console.warn(`[TemplateFood] Failed to write prompts.md / prompt.md:`, e.message);
  }
}

function appendMarkdownLog(runDir, content) {
  try {
    fs.appendFileSync(path.join(runDir, 'prompts.md'), content, 'utf8');
    fs.appendFileSync(path.join(runDir, 'prompt.md'), content, 'utf8');
  } catch (e) {
    console.warn(`[TemplateFood] Failed to append to prompts.md / prompt.md:`, e.message);
  }
}

function formatFoodScriptBreakdown(analysisData) {
  const analysis = analysisData?.analysis || {};
  const scriptList = analysisData?.script || [];
  const hero = analysis.heroInteraction || {};

  const scriptTable = [
    '| Panel | Giai đoạn (Phase) | Thời lượng | Lời thoại Voice-Over | Số từ (Target: 18-22 từ/panel) | Hành động món ăn (Food Action) | Góc máy (Camera) |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
    ...[0, 1, 2, 3].map(i => {
      const p = scriptList[i] || {};
      const vo = p.voiceOver || 'N/A';
      const count = vo !== 'N/A' ? vo.split(/\s+/).filter(Boolean).length : 0;
      return `| Panel ${i + 1} | ${p.phase || `Cảnh ${i + 1}`} | ${p.durationSeconds || 6}s | ${vo.replace(/\|/g, '-')} | **${count} từ** | ${(p.foodAction || 'N/A').replace(/\|/g, '-')} | ${(p.cameraAction || 'N/A').replace(/\|/g, '-')} |`;
    })
  ].join('\n');

  const totalWords = scriptList.reduce((sum, s) => sum + (s.voiceOver ? s.voiceOver.split(/\s+/).filter(Boolean).length : 0), 0);

  return [
    '### 4-Panel Food Review Script Breakdown',
    scriptTable,
    '',
    `- **Tổng số từ Voice Review**: **${totalWords} từ** (Chuẩn 24.0s / 4 cảnh x 6s)`,
    `- **Hero Interaction (Cảnh 3)**: Hành động: \`${hero.action || 'N/A'}\` | Người thực hiện: \`${hero.performedBy || 'reviewer_hand'}\``,
    `  * Visual Target: ${hero.visualTarget || 'N/A'}`,
    `  * Sensory Target: ${hero.sensoryTarget || 'N/A'}`,
    `  * Shot Type: \`${hero.shotType || 'macro'}\``,
    `- **Review Angle**: Chính: \`${analysis.reviewAngle?.primary || 'taste'}\` | Phụ: \`${analysis.reviewAngle?.secondary || 'texture'}\``,
    `- **Đặc tính cảm quan**: ${analysis.primarySensoryAngle || 'N/A'}`,
    `- **Khách hàng mục tiêu**: ${analysis.targetViewer || 'N/A'}`,
  ].join('\n');
}

function buildInitialFoodMarkdown(sessionData) {
  const { runId, analysisData, masterPrompt, qaResult, candidateBuffers, bestCandidateIndex, chatId, inputs } = sessionData;
  const analysis = analysisData?.analysis || {};
  const voicePersona = analysisData?.voicePersona || {};

  return [
    `# Food Review Template Full Flow Execution Log — ${runId}`,
    `- Run ID: \`${runId}\``,
    `- Timestamp: ${new Date().toISOString()}`,
    `- Template: \`/tfood\` (Food Review Template Pro 24s / 4x 6s)`,
    `- Product: **${analysis.productName || 'Đồ ăn review'}**`,
    `- Food Category: \`${analysis.foodCategory || 'ready_to_eat'}\``,
    `- Variant: ${analysis.variant || 'N/A'}`,
    `- Packaging: ${analysis.packageType || 'N/A'}`,
    `- Voice Persona: Dialect: \`${voicePersona.dialectDirection || 'southern_vietnamese_subtle_mekong'}\`, Self-ref: \`${voicePersona.selfReference || 'tui'}\`, Energy: \`${voicePersona.energy || 7}/10\``,
    '',
    '---',
    '## Step 1: Gemini Food Analysis & Voice Script Generation',
    '- **API Engine**: Gemini API Client (generateContent & Vision)',
    '- **Framework**: 4-phase Food Review (Discovery 6s, Show 6s, Experience/Hero 6s, Verdict 6s)',
    '- **Target Duration**: Exactly 24.0s (4x 6s clips)',
    '',
    '### Gemini Analysis Prompt',
    '```text',
    analysisData?.analysisPrompt || 'N/A',
    '```',
    '',
    '### Gemini Raw Response',
    '```json',
    analysisData?.rawResponse || (analysisData ? JSON.stringify(analysisData, null, 2) : 'N/A'),
    '```',
    '',
    formatFoodScriptBreakdown(analysisData),
    '',
    '---',
    '## Step 2: Google Flow 4x Parallel Food Master Storyboard Generation & QA',
    '- **Model**: `nano-banana-pro` (Aspect Ratio: `16:9`, 1920x1080)',
    `- **Generated Candidates**: ${candidateBuffers?.length || 4} parallel storyboards`,
    `- **Selected Best Candidate**: Candidate #${bestCandidateIndex || 1}`,
    `- **Action Runway in Panel 3**: Enforced (Hero interaction ready to execute in first 0.5s of video)`,
    ...(Array.isArray(inputs) && inputs.length > 0 ? [
      '- **Input References**:',
      ...inputs.map((si, i) => `  * Input ${i + 1}: \`${si.name || `product_${i + 1}.png`}\``)
    ] : []),
    '',
    '### Master Storyboard Prompt Used',
    '```text',
    masterPrompt || 'N/A',
    '```',
    '',
    '### QA Verification Results',
    '```json',
    JSON.stringify(qaResult || {}, null, 2),
    '```',
    '',
    `- **Final Master Storyboard**: \`master-storyboard.png\` (1920x1080)`,
    '',
    '---',
    '## Step 3: Natural 4:9 Panel Slicing & Telegram Interaction',
    '- **Slicing Method**: Natural 480x1080 (4:9 aspect ratio each panel, zero distortion, zero logo crop)',
    ...[1, 2, 3, 4].map(idx => `- **Panel ${idx}**: \`panels/panel-${idx}.png\` (480x1080)`),
    `- **Telegram Notification**: Photo sent to chat \`${chatId || 'N/A'}\``,
    '- **Interactive Options**: `[Remake Cảnh 1-4]` `[Remake Toàn Bộ]` `[OK Sinh Video 24s]`',
    '- **Current Status**: Waiting for user review / OK',
    ''
  ].join('\n');
}

// ── 10. MAIN STORYBOARD GENERATION FLOW ───────────────────────────────────────

async function generateStoryboard(baseDir, filePayloads, options = {}) {
  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const template = 'template_food';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const shortRunId = Math.random().toString(36).substring(2, 8);
  const runId = (options.runId && options.runId.length <= 12) ? options.runId : shortRunId;
  const originalJobId = options.runId || options.jobId || runId;
  const chatId = options.chatId || null;
  const isAuto = Boolean(options.isAuto);

  console.log(`[TemplateFood] 🍱 Starting Food Review Storyboard Pipeline (Run: ${runId}, JobId: ${originalJobId})...`);

  const runsRoot = path.join(effectiveBaseDir, 'storyboard-review-runs');
  const runDir = path.join(runsRoot, `${timestamp}-${template}-flow-${runId}`);
  const panelsDir = path.join(runDir, 'panels');
  const candidatesDir = path.join(runDir, 'candidates');
  const audioDir = path.join(runDir, 'audio');
  const videosDir = path.join(runDir, 'videos');

  ensureDir(runDir);
  ensureDir(panelsDir);
  ensureDir(candidatesDir);
  ensureDir(audioDir);
  ensureDir(videosDir);

  const geminiClient = new GeminiApiClient({
    browserMode: true,
    userDataDir: path.join(effectiveBaseDir, 'gemini-playwright-user-data')
  });

  let analysisData = null;
  let analysis = {};
  let script = [];
  let candidateBuffers = [];

  try {
    try { await geminiClient.init(); } catch (_) {}

    // 1. Phân tích món ăn (Step 1)
    analysisData = await analyzeProductTemplateFood(geminiClient, filePayloads, options);
    analysis = analysisData.analysis || {};
    script = analysisData.script || [];

    // 2. Kích hoạt song song tiến trình sinh Voice Review 24s qua Gemini TTS
    const fullVoicePath = path.join(audioDir, 'voice_full.m4a');
    const voicePromise = generateTemplateFoodVoiceReview(analysisData, fullVoicePath, {
      voice: options.voice || 'Zephyr',
      targetDuration: 24.0,
    });

    // 3. Sinh Master Storyboard (4 ứng viên k=4)
    console.log(`[TemplateFood] Step 2: Generating 4 parallel candidate storyboards with Action Runway...`);
    const masterPrompt = buildTemplateFoodMasterPrompt(analysis, options);

    const validPayloads = (Array.isArray(filePayloads) ? filePayloads : [])
      .filter(f => f && (f.buffer || f.path))
      .slice(0, 4)
      .map((f, idx) => ({
        name: f.name || `product_${idx + 1}.png`,
        buffer: Buffer.isBuffer(f.buffer) ? f.buffer : (f.path && fs.existsSync(f.path) ? fs.readFileSync(f.path) : null),
        mimeType: f.mimeType || 'image/png'
      }))
      .filter(f => f.buffer);

    let flowPage = null;
    try {
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
    } finally {
      if (flowPage) await closeFlowPage(flowPage).catch(() => {});
    }

    if (candidateBuffers.length === 0) {
      throw new Error('Failed to generate any candidate storyboards for Food Review.');
    }

    // Lưu candidates ra đĩa
    candidateBuffers.forEach((buf, idx) => {
      fs.writeFileSync(path.join(candidatesDir, `candidate-${idx + 1}.png`), buf);
    });

    // 4. Visual QA & Đánh giá 100 điểm
    const qaResult = await verifyMultiStoryboardWithGeminiVision(geminiClient, candidateBuffers, filePayloads, analysis);
    const bestCandIdx = qaResult.bestOverallIndex || 1;
    const bestCandidateBuf = candidateBuffers[bestCandIdx - 1] || candidateBuffers[0];

    // 5. Cắt và gán 4 panel
    let panelBuffers = [];
    try {
      panelBuffers = sliceMasterStoryboardFood(bestCandidateBuf);
    } catch (err) {
      console.warn(`[TemplateFood] Slicing best candidate failed: ${err.message}. Retrying candidate 1...`);
      panelBuffers = sliceMasterStoryboardFood(candidateBuffers[0]);
    }

    // Lưu 4 panel ra đĩa
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(path.join(panelsDir, `panel-${i}.png`), panelBuffers[i - 1]);
    }

    // Ghép lại thành master storyboard chuẩn
    const masterPath = path.join(runDir, 'master-storyboard.png');
    composeMasterStoryboardFood(panelBuffers, masterPath);

    // Tạo và ghi log prompt.md & prompts.md
    const initialMd = buildInitialFoodMarkdown({
      runId,
      analysisData,
      masterPrompt,
      qaResult,
      candidateBuffers,
      bestCandidateIndex: bestCandIdx,
      chatId,
      inputs: validPayloads,
    });
    writeMarkdownLog(runDir, initialMd);

    // Lưu session
    const extractedProductId = options.productContext?.productId || options.productId || (originalJobId && originalJobId.startsWith('tg_') ? originalJobId.split('_')[2] : '') || '';
    const extractedProductTitle = options.productContext?.productTitle || options.productTitle || analysis?.productName || 'Sản phẩm review';
    const session = {
      runId,
      jobId: originalJobId,
      baseDir: effectiveBaseDir,
      chatId,
      template: 'template_food',
      productId: extractedProductId,
      productTitle: extractedProductTitle,
      productUrl: options.productContext?.productUrl || options.productUrl || '',
      shortlink: options.productContext?.shortlink || options.shortlink || '',
      cartAnchorText: options.productContext?.cartAnchorText || analysis?.cartAnchorText || '',
      promptsMdPath: path.join(runDir, 'prompt.md'),
      analysis: analysisData,
      runDir,
      panelsDir,
      candidatesDir,
      audioDir,
      videosDir,
      candidateCount: candidateBuffers.length,
      bestCandidateIndex: bestCandIdx,
      qaResult,
      fullVoicePath,
      voicePromise,
      isAuto,
      createdAt: new Date().toISOString(),
    };
    saveFoodSession(runId, session);

    // Nếu có chatId và không phải auto mode: Gửi Telegram để tương tác duyệt
    if (chatId && !isAuto) {
      const candidateScoresText = Array.isArray(qaResult?.candidates)
        ? qaResult.candidates.map(c => `#${c.candidateIndex || c.index}: <b>${c.totalScore || c.score || 88}đ</b>`).join(' | ')
        : '';
      const bestScore = qaResult?.candidates?.[0]?.totalScore || 88;
      const captionLines = [
        `🎨 <b>[Template Food] Master Storyboard đã tạo xong!</b>\n`,
        `🍜 <b>Món ăn:</b> ${analysis.productName || 'Đồ ăn review'}`,
        ...(candidateScoresText ? [`📊 <b>Điểm 4 Storyboard:</b> ${candidateScoresText}`] : []),
        `🏆 <b>Đã chọn:</b> Storyboard #${bestCandIdx} (Điểm kiểm định: <b>${bestScore}/100</b>)\n`,
        `🖼️ Storyboard gồm 4 cảnh (1: Hook, 2: Sensory Runway, 3: Sensory Proof, 4: Taste CTA).`,
        `👉 <i>Bấm nút bên dưới nếu bạn muốn làm lại (Remake) cảnh cụ thể, làm lại tất cả, hoặc bấm OK để chốt:</i>`
      ];

      const keyboard = buildFoodInlineKeyboard(runId);
      await sendPhotoToTelegram(chatId, masterPath, captionLines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    }

    return {
      success: true,
      runId,
      template: 'template_food',
      analysis: analysisData,
      masterStoryboardPath: masterPath,
      panels: [1, 2, 3, 4].map(idx => ({
        index: idx,
        panelIndex: idx,
        imagePath: path.join(panelsDir, `panel-${idx}.png`),
        buffer: panelBuffers[idx - 1],
      })),
      isInteractiveStoryboard: true,
    };
  } finally {
    try { await geminiClient.close(); } catch (_) {}
  }
}

// ── 11. REMAKE & FINALIZE HANDLERS (TELEGRAM INTERACTIONS) ────────────────────

async function executeFoodRemakePanel(chatId, baseDir, runId, targetPanelIndex, opts = {}) {
  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const session = getFoodSession(runId, effectiveBaseDir);
  if (!session) throw new Error(`Food review session not found for run ${runId}`);

  const pIdx = Math.max(1, Math.min(4, Number(targetPanelIndex) || 1));
  console.log(`[TemplateFood] Remaking panel ${pIdx} for run ${runId}...`);

  const flowPage = await createFlowPage(effectiveBaseDir);
  let newPanelBuf = null;
  try {
    const rPrompt = buildTemplateFoodRemakePrompt(session.analysis?.analysis, pIdx, opts.customInstruction);
    const prepared = await prepareGeneration(flowPage, rPrompt, [], {
      imageModel: 'nano-banana-pro',
      aspectRatio: '9:16',
      outputCount: 1,
    }, effectiveBaseDir);
    const genRes = await executeGeneration(prepared);
    if (genRes && genRes.buffer) newPanelBuf = genRes.buffer;
    else if (genRes && Array.isArray(genRes.allResults) && genRes.allResults[0]?.buffer) newPanelBuf = genRes.allResults[0].buffer;
  } finally {
    await closeFlowPage(flowPage).catch(() => {});
  }

  if (!newPanelBuf) {
    throw new Error(`Failed to remake panel ${pIdx}`);
  }

  // Cập nhật panel file
  const panelPath = path.join(session.panelsDir, `panel-${pIdx}.png`);
  fs.writeFileSync(panelPath, newPanelBuf);

  // Đọc lại 4 panel và ghép lại master
  const currentPanels = [1, 2, 3, 4].map(i => {
    const f = path.join(session.panelsDir, `panel-${i}.png`);
    return fs.existsSync(f) ? fs.readFileSync(f) : newPanelBuf;
  });
  const masterPath = path.join(session.runDir, 'master-storyboard.png');
  composeMasterStoryboardFood(currentPanels, masterPath);

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

  saveFoodSession(runId, session);

  if (chatId) {
    const keyboard = buildFoodInlineKeyboard(runId);
    await sendPhotoToTelegram(chatId, masterPath, `✅ <b>Đã cập nhật lại Cảnh ${pIdx}!</b>\n\nBạn có thể Remake tiếp cảnh khác hoặc bấm "OK Sinh Video 24s":`, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }

  return { panelIndex: pIdx, panelPath };
}

async function executeFoodRemakeAll(chatId, baseDir, runId, opts = {}) {
  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const session = getFoodSession(runId, effectiveBaseDir);
  if (!session) throw new Error(`Food review session not found for run ${runId}`);

  console.log(`[TemplateFood] Remaking ALL panels for run ${runId}...`);
  const flowPage = await createFlowPage(effectiveBaseDir);
  let newMasterBuf = null;

  try {
    const rPrompt = buildTemplateFoodRemakeAllPrompt(session.analysis?.analysis, opts.customInstruction);
    const prepared = await prepareGeneration(flowPage, rPrompt, [], {
      imageModel: 'nano-banana-pro',
      aspectRatio: '16:9',
      outputCount: 1,
    }, effectiveBaseDir);
    const genRes = await executeGeneration(prepared);
    if (genRes && genRes.buffer) newMasterBuf = genRes.buffer;
    else if (genRes && Array.isArray(genRes.allResults) && genRes.allResults[0]?.buffer) newMasterBuf = genRes.allResults[0].buffer;
  } finally {
    await closeFlowPage(flowPage).catch(() => {});
  }

  if (!newMasterBuf) {
    throw new Error('Failed to regenerate master storyboard');
  }

  const newPanels = sliceMasterStoryboardFood(newMasterBuf);
  for (let i = 1; i <= 4; i++) {
    fs.writeFileSync(path.join(session.panelsDir, `panel-${i}.png`), newPanels[i - 1]);
  }
  const masterPath = path.join(session.runDir, 'master-storyboard.png');
  composeMasterStoryboardFood(newPanels, masterPath);

  // Ghi log remake all vào prompt.md
  const remakeAllLog = [
    '',
    '---',
    `### Remake All 4 Panels Log — ${new Date().toISOString()}`,
    `- **Custom Instruction**: ${opts.customInstruction || 'None'}`,
    '```text',
    rPrompt,
    '```',
    `- **New Master Storyboard**: \`master-storyboard.png\``,
    ''
  ].join('\n');
  appendMarkdownLog(session.runDir, remakeAllLog);

  saveFoodSession(runId, session);

  if (chatId) {
    const keyboard = buildFoodInlineKeyboard(runId);
    await sendPhotoToTelegram(chatId, masterPath, `🎲 <b>Đã Remake toàn bộ 4 cảnh mới!</b>\n\nKiểm tra lại và bấm "OK Sinh Video 24s" để render:`, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }

  return { masterPath };
}

function generateCameraMotionPanelClip(imagePath, outputPath, opts = {}) {
  ensureDir(path.dirname(outputPath));
  const pIdx = opts.panelIndex || 1;
  const duration = opts.duration || 6.0;
  const totalFrames = Math.round(duration * 24);

  // High-quality cinematic camera motion tailored for each scene:
  // Scene 1: Slow push-in zoom into packaging (1.00 -> 1.08)
  // Scene 2: Gentle tilt-down drift
  // Scene 3: Macro zoom-in on hero food texture / interaction (1.00 -> 1.12)
  // Scene 4: Slow pull-back / subtle pan for verdict (1.08 -> 1.00)
  let zoompanFilter = `zoompan=z='min(zoom+0.0006,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1080x1920:fps=24`;
  if (pIdx === 2) {
    zoompanFilter = `zoompan=z='1.05':x='iw/2-(iw/zoom/2)':y='(ih/2-(ih/zoom/2))*(1+0.0005*on)':d=${totalFrames}:s=1080x1920:fps=24`;
  } else if (pIdx === 3) {
    zoompanFilter = `zoompan=z='min(zoom+0.0008,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1080x1920:fps=24`;
  } else if (pIdx === 4) {
    zoompanFilter = `zoompan=z='max(1.08-0.0005*on,1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1080x1920:fps=24`;
  }

  const filterComplex = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${zoompanFilter}`;

  try {
    execSync(
      `"${ffmpegPath}" -y -loop 1 -i "${imagePath}" -vf "${filterComplex}" -t ${duration.toFixed(1)} -c:v libx264 -pix_fmt yuv420p -r 24 "${outputPath}"`,
      { stdio: 'pipe', timeout: 35000 }
    );
  } catch (err) {
    console.warn(`[TemplateFood] Camera motion failed for panel ${pIdx} (${err.message}). Using standard static loop.`);
    execSync(
      `"${ffmpegPath}" -y -loop 1 -i "${imagePath}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1" -t ${duration.toFixed(1)} -c:v libx264 -pix_fmt yuv420p -r 24 "${outputPath}"`,
      { stdio: 'pipe', timeout: 25000 }
    );
  }
}

async function finalizeFoodStoryboardAndGenerateVideos(chatId, baseDir, runId, opts = {}) {
  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const session = getFoodSession(runId, effectiveBaseDir);
  if (!session) throw new Error(`Food review session not found for run ${runId}`);

  console.log(`[TemplateFood] 🎬 Finalizing Storyboard and generating 4 panel videos (Model: veo_3_1_i2v_lite_low_priority)...`);
  const tracker = opts.stepTracker || null;

  if (tracker) {
    await tracker.setStep(4, 'running', 'Đang chuẩn bị prompt và start frame cho 4 cảnh (Veo 3)...');
  }

  const panelJobs = [1, 2, 3, 4].map(idx => {
    const pPath = path.join(session.panelsDir, `panel-${idx}.png`);
    const pBuf = fs.existsSync(pPath) ? fs.readFileSync(pPath) : null;
    const prompt = buildTemplateFood6sPanelPrompts(session.analysis?.analysis, { panelIndex: idx });
    return {
      index: idx,
      panelIndex: idx,
      prompt,
      imagePath: pPath,
      buffer: pBuf,
      videoModelKey: 'abra_r2v_8s',
    };
  });

  if (tracker) {
    await tracker.setStep(4, 'running', 'Đang gọi AI sinh 4 video (Start Frame mode, abra_r2v_8s)...');
  }

  let generatedVideos = [];
  try {
    generatedVideos = await generateVideosFromPanelsDirect(effectiveBaseDir, panelJobs, {
      aspectRatio: '9:16',
      videoModelKey: 'veo_3_1_i2v_lite_low_priority',
      includeVideoBase64: true,
      cropPercent: 0,
      preserveBorder: true,
      runId: `food-${runId}`,
      projectUrl: 'https://flow.google.com/project/c3d78077-c6ff-4afe-b55a-4949b316de27',
    });
  } catch (genErr) {
    console.warn(`[TemplateFood] ⚠️ Remote Veo 3 generation failed (${genErr.message}). Applying camera motion fallback.`);
  }

  // Lưu các file video panel (dùng Veo nếu có, hoặc camera-motion clip từ Start Frame)
  const savedVideoPaths = [];
  for (let i = 1; i <= 4; i++) {
    const v = (generatedVideos || []).find(gv => gv?.panelIndex === i) || generatedVideos?.[i - 1];
    const targetPath = path.join(session.videosDir, `panel-${i}.mp4`);
    if (v && v.videoPath && fs.existsSync(v.videoPath) && fs.statSync(v.videoPath).size > 0) {
      try { fs.copyFileSync(v.videoPath, targetPath); } catch (_) {}
    } else if (v && v.video?.base64) {
      fs.writeFileSync(targetPath, Buffer.from(v.video.base64, 'base64'));
    }

    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
      const pPath = path.join(session.panelsDir, `panel-${i}.png`);
      generateCameraMotionPanelClip(pPath, targetPath, {
        panelIndex: i,
        duration: 6.0,
      });
    }
    savedVideoPaths.push(targetPath);
  }

  if (tracker) {
    await tracker.setStep(5, 'running', 'Đang xử lý hậu kỳ: hoàn tất voice review 24s và ghép 4 cảnh video...');
  }

  // Đợi voice review hoàn thành (nếu chạy song song từ trước)
  let voiceResult = null;
  try {
    voiceResult = await session.voicePromise;
  } catch (vErr) {
    console.warn(`[TemplateFood] Voice promise error: ${vErr.message}. Generating fresh voice track...`);
    voiceResult = await generateTemplateFoodVoiceReview(session.analysis, session.fullVoicePath, {
      voice: 'Zephyr',
      targetDuration: 24.0,
    });
  }

  // Ghép 4 video 6s thành video hoàn chỉnh và mux voice review (ưu tiên độ dài của audio)
  const mergedVideoPath = path.join(session.videosDir, 'final_video.mp4');
  merge4PanelsWithVoice(savedVideoPaths, session.fullVoicePath, mergedVideoPath);

  const finalDur = getMediaDuration(mergedVideoPath) || 24.0;
  const durationFormatted = finalDur.toFixed(1);
  const prodName = session.analysis?.analysis?.productName || 'Đồ ăn review';
  const defaultTags = ['#reviewdoan', '#foodreview', '#anngon', '#tiktokshop', '#trending'];
  const hashtags = normalizeHashtags(session.analysis?.analysis?.hashtags, defaultTags).slice(0, 5);

  // Đảm bảo copy vào thư mục final/ để đồng bộ hệ thống lưu trữ và upload
  const finalDir = path.join(session.runDir, 'final');
  ensureDir(finalDir);
  const finalVideoPath = path.join(finalDir, 'final-video.mp4');
  try { fs.copyFileSync(mergedVideoPath, finalVideoPath); } catch (_) {}

  session.mergedVideoPath = mergedVideoPath;
  session.finalVideoPath = mergedVideoPath;
  session.savedVideoPaths = savedVideoPaths;
  session.voiceResult = voiceResult;
  saveFoodSession(runId, session);

  // Đăng ký completed job vào generationJobService để lệnh /upload và nút upload hoạt động ngay lập tức
  if (typeof registerExternalCompletedJob === 'function') {
    const jobPayload = {
      jobId: `tfood-${runId}`,
      chatId: String(chatId),
      template: 'template_food',
      hasVoice: true,
      jobDir: session.runDir,
      baseDir: effectiveBaseDir,
      status: 'completed',
      finalVideoPath: mergedVideoPath,
      productId: session.productId || session.analysis?.productId || (session.jobId && session.jobId.startsWith('tg_') ? session.jobId.split('_')[2] : '') || '',
      productTitle: session.productTitle || prodName,
      productUrl: session.productUrl || '',
      shortlink: session.shortlink || '',
      cartAnchorText: session.cartAnchorText || session.analysis?.analysis?.cartAnchorText || '',
      panels: [1, 2, 3, 4].map(idx => ({ index: idx, status: 'completed' })),
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
        panels: [1, 2, 3, 4].map(idx => ({ index: idx, imagePath: path.join(session.panelsDir, `panel-${idx}.png`) })),
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
      registerExternalCompletedJob(chatId, { ...jobPayload, jobId: `tfood-${session.jobId}` });
      registerExternalCompletedJob(chatId, { ...jobPayload, jobId: session.jobId });
    }
  }

  if (opts.lastRunByChat) {
    opts.lastRunByChat.set(String(chatId), {
      runDir: session.runDir,
      panelsDir: session.panelsDir,
      videosDir: session.videosDir,
      template: 'template_food',
      analysis: session.analysis,
      baseDir: effectiveBaseDir,
    });
  }

  // Ghi log video generation vào prompt.md
  const finalizeLog = [
    '',
    '---',
    `## Step 4: Food Video Generation & Merge (${durationFormatted}s) — ${new Date().toISOString()}`,
    `- **Video Model**: \`veo_3_1_i2v_lite_low_priority\` (Start Frame mode, 9:16 aspect ratio)`,
    `- **Clips Generated**: 4 clips of 6 seconds each`,
    `- **Audio Track**: \`audio/voice_full.m4a\` (${durationFormatted}s, audio length prioritized)`,
    '',
    '### Video Generation Prompts (Veo 3 6s Motion Arc):',
    ...panelJobs.map(job => [
      `#### Panel ${job.panelIndex} (${session.analysis?.script?.[job.panelIndex - 1]?.phase || `Scene ${job.panelIndex}`}):`,
      '```text',
      job.prompt,
      '```',
    ].join('\n')),
    '',
    `- **Final Merged Video**: \`${mergedVideoPath}\` (${durationFormatted}s, video + voice merged)`,
    `- **Telegram Delivery**: Sent to chat \`${chatId || 'N/A'}\``,
    ''
  ].join('\n');
  appendMarkdownLog(session.runDir, finalizeLog);

  if (tracker) {
    await tracker.completeAll();
  }

  // Gửi video về Telegram theo đúng cấu trúc tpro
  if (chatId) {
    if (opts.statusMsgId) {
      await deleteTelegramMessage(chatId, opts.statusMsgId).catch(() => {});
    }

    // 1. Gửi video hoàn chỉnh (caption ngắn gọn, không gắn keyboard trực tiếp để tránh trùng lặp)
    const videoCaption = [
      `🎬 <b>[Template Food] Video Review Hoàn Chỉnh (${durationFormatted} giây)</b>\n`,
      `✨ <i>Đã ghép đủ 4 Cảnh (6s/cảnh) lồng ghép giọng đọc review tiếng Việt tự nhiên 100%.</i>`
    ].join('\n');

    await sendMergedVideoToTelegram(chatId, mergedVideoPath, videoCaption, {
      parse_mode: 'HTML',
    });

    // 2. Xóa message tiến trình cũ
    if (tracker && tracker.messageId) {
      await deleteTelegramMessage(chatId, tracker.messageId).catch(() => {});
      tracker.messageId = null;
    }
    if (session.stepTrackerMessageId) {
      await deleteTelegramMessage(chatId, session.stepTrackerMessageId).catch(() => {});
      session.stepTrackerMessageId = null;
    }

    // 3. Gửi tiêu đề + hashtag để người dùng tiện sao chép
    await sendTelegramMessage(chatId, `${prodName}\n\n${hashtags.join(' ')}`);

    // 4. Gửi status message hoàn tất kèm keyboard thao tác
    const keyboard = buildFoodVideoInlineKeyboard(runId);
    const finalStatusLines = [
      `🎉 <b>TẠO VIDEO REVIEW HOÀN TẤT (${durationFormatted} GIÂY)!</b>\n`,
      `🍜 <b>Món ăn:</b> <b>${prodName}</b>\n`,
      `1. ✅ Tải thông tin & hình ảnh món ăn`,
      `2. ✅ Phân tích món ăn & lên kịch bản review`,
      `3. ✅ Tạo Master Storyboard & chia 4 panel (16:9)`,
      `4. ✅ Sinh 4 video chuyển động AI Veo (6s/cảnh)`,
      `5. ✅ Xử lý hậu kỳ & lồng tiếng review (Zephyr)\n`,
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
      saveFoodSession(runId, session);
    }
  }

  return {
    success: true,
    mergedVideoPath,
    savedVideoPaths,
    voicePath: session.fullVoicePath,
  };
}

async function executeFoodRemakeSingleVideo(chatId, baseDir, runId, targetPanelIndex, opts = {}) {
  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const session = getFoodSession(runId, effectiveBaseDir);
  if (!session) throw new Error(`Food review session not found for run ${runId}`);

  const pIdx = Math.max(1, Math.min(4, Number(targetPanelIndex) || 1));
  console.log(`[TemplateFood] Remaking single video scene ${pIdx} for run ${runId}...`);

  const pPath = path.join(session.panelsDir, `panel-${pIdx}.png`);
  const pBuf = fs.existsSync(pPath) ? fs.readFileSync(pPath) : null;
  const prompt = buildTemplateFood6sPanelPrompts(session.analysis?.analysis, {
    panelIndex: pIdx,
    customInstruction: opts.customInstruction,
  });

  const singleJob = [{
    index: pIdx,
    panelIndex: pIdx,
    prompt,
    imagePath: pPath,
    buffer: pBuf,
    videoModelKey: 'veo_3_1_i2v_lite_low_priority',
  }];

  let newVideos = [];
  try {
    newVideos = await generateVideosFromPanelsDirect(effectiveBaseDir, singleJob, {
      aspectRatio: '9:16',
      videoModelKey: 'veo_3_1_i2v_lite_low_priority',
      includeVideoBase64: true,
      multiImageMode: undefined,
      cropPercent: 0,
      preserveBorder: true,
      runId: `food-${runId}-remake-${pIdx}`,
    });
  } catch (remakeErr) {
    console.warn(`[TemplateFood] ⚠️ Remake scene ${pIdx} Veo 3 error: ${remakeErr.message}. Falling back to camera motion.`);
  }

  const targetPath = path.join(session.videosDir, `panel-${pIdx}.mp4`);
  if (newVideos?.[0]?.videoPath && fs.existsSync(newVideos[0].videoPath) && fs.statSync(newVideos[0].videoPath).size > 0) {
    fs.copyFileSync(newVideos[0].videoPath, targetPath);
  } else if (newVideos?.[0]?.video?.base64) {
    fs.writeFileSync(targetPath, Buffer.from(newVideos[0].video.base64, 'base64'));
  } else {
    generateCameraMotionPanelClip(pPath, targetPath, {
      panelIndex: pIdx,
      duration: 6.0,
    });
  }

  // Ghép lại video hoàn chỉnh (ưu tiên độ dài audio)
  const panelVideos = [1, 2, 3, 4].map(i => path.join(session.videosDir, `panel-${i}.mp4`));
  const mergedVideoPath = path.join(session.videosDir, 'final_video.mp4');
  merge4PanelsWithVoice(panelVideos, session.fullVoicePath, mergedVideoPath);

  const finalDur = getMediaDuration(mergedVideoPath) || 24.0;
  const durationFormatted = finalDur.toFixed(1);
  const prodName = session.analysis?.analysis?.productName || 'Đồ ăn review';

  const finalDir = path.join(session.runDir, 'final');
  ensureDir(finalDir);
  try { fs.copyFileSync(mergedVideoPath, path.join(finalDir, 'final-video.mp4')); } catch (_) {}

  session.mergedVideoPath = mergedVideoPath;
  session.finalVideoPath = mergedVideoPath;

  // Cập nhật job trong generationJobService
  if (typeof getJob === 'function') {
    const existingJob = getJob(`tfood-${runId}`) || (session.jobId ? getJob(session.jobId) : null);
    if (existingJob) {
      existingJob.finalVideoPath = mergedVideoPath;
      if (existingJob.result) existingJob.result.finalVideoPath = mergedVideoPath;
      existingJob.updatedAt = new Date().toISOString();
    }
  }

  saveFoodSession(runId, session);

  if (chatId) {
    // 1. Gửi video hoàn chỉnh cập nhật
    const videoCaption = [
      `✨ <b>[Template Food] Đã cập nhật xong Video Cảnh ${pIdx}!</b>\n`,
      `🎬 <i>Video ${durationFormatted} giây hoàn chỉnh đã được ghép lại với Cảnh ${pIdx} mới và giữ nguyên giọng đọc review.</i>`
    ].join('\n');

    await sendMergedVideoToTelegram(chatId, mergedVideoPath, videoCaption, {
      parse_mode: 'HTML',
    });

    // Xóa status message tiến trình cũ (nếu có)
    if (opts.stepTracker && opts.stepTracker.messageId) {
      await deleteTelegramMessage(chatId, opts.stepTracker.messageId).catch(() => {});
      opts.stepTracker.messageId = null;
    }
    if (session.stepTrackerMessageId) {
      await deleteTelegramMessage(chatId, session.stepTrackerMessageId).catch(() => {});
      session.stepTrackerMessageId = null;
    }
    if (opts.statusMsgId) {
      await deleteTelegramMessage(chatId, opts.statusMsgId).catch(() => {});
    }

    // 2. Gửi status message mới kèm options remake video hoặc upload TikTok
    const keyboard = buildFoodVideoInlineKeyboard(runId);
    const updatedStatusText = [
      `🎉 <b>ĐÃ CẬP NHẬT XONG VIDEO CẢNH ${pIdx}!</b>\n`,
      `🍜 <b>Món ăn:</b> <b>${prodName}</b>\n`,
      `1. ✅ Tải thông tin & hình ảnh món ăn`,
      `2. ✅ Phân tích món ăn & lên kịch bản review`,
      `3. ✅ Tạo Master Storyboard & chia 4 panel (16:9)`,
      `4. ✅ Tạo lại Video Cảnh ${pIdx}`,
      `5. ✅ Ghép lại video ${durationFormatted}s và giữ nguyên giọng đọc review\n`,
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
      saveFoodSession(runId, session);
    }
  }

  return { panelIndex: pIdx, mergedVideoPath };
}

module.exports = {
  generateStoryboard,
  executeFoodRemakePanel,
  executeFoodRemakeAll,
  finalizeFoodStoryboardAndGenerateVideos,
  executeFoodRemakeSingleVideo,
  buildTemplateFoodRemakeVideoJobs,
  getFoodSession,
  saveFoodSession,
  buildTemplateFoodAnalysisPrompt,
  parseJsonObjectFood,
  validateFoodScript,
  analyzeProductTemplateFood,
  buildTemplateFoodMasterPrompt,
  buildTemplateFoodMultiStoryboardPrompt,
  buildTemplateFoodVerificationPrompt,
  verifyMultiStoryboardWithGeminiVision,
  selectBestCandidateForPanel,
  sliceMasterStoryboardFood,
  composeMasterStoryboardFood,
  buildTemplateFoodVideoPrompts,
  buildTemplateFood6sPanelPrompts,
  buildTemplateFoodRemakePrompt,
  buildTemplateFoodRemakeAllPrompt,
  buildFoodInlineKeyboard,
  buildFoodVideoInlineKeyboard,
  merge4PanelsWithVoice,
  writeMarkdownLog,
  appendMarkdownLog,
  formatFoodScriptBreakdown,
  FOOD_FORM_TAXONOMY,
  classifyReferenceRoles,
  analyzeFoodPhysicalProfile,
  deriveFoodAffordances,
  deriveForbiddenFoodActions,
  chooseHeroInteraction,
  buildProductStateMachine,
  buildFoodReviewWorld,
  detectSourcingSetting,
  buildSourcingScenePrompt,
  buildDynamicPropPlan,
  buildDynamicFourScenePlan,
  validateFoodAction,
  validateBackgroundWorld,
  validateShowSaySync,
  getFoodEnvironmentBible,
  detectHorizontalDividersFood,
};
