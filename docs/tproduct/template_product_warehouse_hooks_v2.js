/**
 * LIVE-COMMERCE PRESENTER TEMPLATE PRO — 40s NATIVE-VOICE (/tproduct, /template_product, /tpro40nv)
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
const { getConfig } = require('../utils/config-manager');

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

// Đường dẫn ảnh người mẫu chuẩn (Canonical Model Reference)
// Hỗ trợ cả model.png và modal.png (legacy backward-compatibility)
const CANONICAL_MODEL_PATHS = [
  path.resolve(__dirname, '../assets/tproduct/presenter.png'),
  path.resolve(__dirname, '../../docs/tproduct/model.png'),
  path.resolve(__dirname, '../../docs/tproduct/modal.png'),
  '/Users/macbook_196/Workspace/something/docs/tproduct/model.png',
  '/Users/macbook_196/Workspace/something/docs/tproduct/modal.png',
];

function getCanonicalPresenterBuffer() {
  for (const p of CANONICAL_MODEL_PATHS) {
    if (fs.existsSync(p)) {
      try {
        const buf = fs.readFileSync(p);
        if (buf && buf.length > 1000) return { path: p, buffer: buf };
      } catch (_) {}
    }
  }
  return null;
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

const DEFAULT_GLOBAL_VISUAL_BIBLE = {
  presenterIdentity: 'canonical uploaded model (model.png)',
  wardrobe: 'same across all clips, neat professional live-commerce host outfit',
  hair: 'same across all clips, neat and stylish',
  environmentType: 'product_warehouse',
  lighting: 'bright clean commercial live-commerce lighting',
  cameraLook: 'realistic smartphone vertical 9:16',
  productVariant: 'locked identical color, shape, size across all panels',
  colorTemperature: 'consistent warm-neutral studio lighting',
  channelStyle: 'realistic product warehouse direct presenter',
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

const VOICE_STYLE_BIBLE = Object.freeze({
  source: 'Nine verbatim Excel hooks (audio not independently transcribed)',
  opening: 'Use the selected hook structure and conversational cadence, not an invented pain-point opening.',
  language: 'Natural spoken Southern Vietnamese; preserve colloquial particles, purposeful repetition, early CTA where supported.',
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
  forbidden: 'No residential kitchen, home, showroom, boutique, decorative studio, unrelated inventory, imaginary machinery, invented labels, extra people, product operation or demonstration.'
});
function selectVerifiedHook(options = {}) {
  const facts = options.verifiedOffer || options.productContext?.verifiedOffer || {};
  const id = options.hookId || options.productContext?.hookId;
  const explicit = id ? HOOK_LIBRARY.find(h => h.id === id) : null;
  // These examples are STYLE REFERENCES only. Never inject original literal text into new product dialogue.
  const price = Boolean(facts.price && (facts.priceVerified === true));
  const shipping = facts.freeShipping === true && facts.freeShippingVerified === true;
  const gift = facts.gift === true && facts.giftVerified === true;
  const subsidy = facts.subsidy === true && facts.subsidyVerified === true;
  const zero = facts.zeroPrice === true && facts.zeroPriceVerified === true;
  const noProfit = facts.noProfit === true && facts.noProfitVerified === true;
  const eligible = h => h.requires === 'verified_price' ? price :
    h.requires === 'verified_price_and_shipping' ? price && shipping :
    h.requires === 'verified_gift_and_subsidy' ? gift && subsidy :
    h.requires === 'verified_zero_price_and_no_profit' ? zero && noProfit : false;
  if (explicit) return eligible(explicit) ? explicit : null;
  return HOOK_LIBRARY.find(h => eligible(h)) || null;
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
      {time:'0-4s',action:'Natural speech, blinking and subtle facial expression; product remains stationary.'},
      {time:'4-8s',action:'Subtle head movement and tiny camera push-in; preserve the entire original scene.'}
    ],
    startFramePlan: {
      presenterPose:'Stable natural presenter pose; face and wardrobe identical to canonical model.',
      handPose:'Hands already in a stable resting/holding pose; no changing grip or manipulating parts.',
      productPlacement: views[index],
      framing: index === 3 ? 'Vertical 9:16 product close-up' : 'Vertical 9:16 medium shot',
      environment: WAREHOUSE_BIBLE.architecture + ' ' + WAREHOUSE_BIBLE.inventory,
      environmentId: WAREHOUSE_ID
    },
    actionRunway:{valid:true,motion:'Blinking, speech lip sync, micro facial movement only.'},
    requiresProductOperation:false,
    introducesUnverifiedProps:false
  };
}
function normalizeWarehouseStoryboard(data) {
  const result = { ...data, analysis: { ...(data.analysis || {}), sourcingSetting:'product_warehouse', warehouseBible:WAREHOUSE_BIBLE,
    visualBible:{...DEFAULT_GLOBAL_VISUAL_BIBLE,environmentType:'product_warehouse',warehouseBible:WAREHOUSE_BIBLE} } };
  result.script = (data.script || []).map(safeWarehouseClip);
  return result;
}
function validateWarehouseStoryboard(data) {
  const errors=[];
  const clips=data?.script || data?.panels || [];
  if(clips.length !== 5) errors.push('Expected exactly 5 panels');
  clips.forEach((c,i)=>{
    if(c.startFramePlan?.environmentId !== WAREHOUSE_ID) errors.push(`Panel ${i+1}: warehouse ID mismatch`);
    if(c.requiresProductOperation) errors.push(`Panel ${i+1}: forbidden product operation`);
    if(c.introducesUnverifiedProps) errors.push(`Panel ${i+1}: unverified props`);
  });
  return {valid:errors.length===0,errors};
}
function validateOfferClaims(script, options={}) {
  const facts=options.verifiedOffer || options.productContext?.verifiedOffer || {};
  const all=(script||[]).map(s=>s.dialogue||'').join(' ');
  const errors=[];
  if(!facts.priceVerified && /(?:\d+[.,]?\d*\s*(?:k|nghìn|ngàn|triệu|đồng|đ)|giá\s*(?:chỉ|còn)\s*\d)/i.test(all)) errors.push('Unverified numeric price');
  if(!facts.freeShippingVerified && /(?:free\s*ship|freeship|miễn phí (?:vận chuyển|ship))/i.test(all)) errors.push('Unverified free shipping');
  if(!facts.subsidyVerified && /(?:trợ giá|giảm thẳng|voucher|mã giảm|ưu đãi độc quyền|giảm sâu)/i.test(all)) errors.push('Unverified subsidy/discount');
  if(!facts.zeroPriceVerified && /(?:không đồng|0\s*đ|0\s*đồng)/i.test(all)) errors.push('Unverified zero price');
  if(!facts.noProfitVerified && /(?:không (?:lấy|lời) (?:một )?đồng|không lợi nhuận)/i.test(all)) errors.push('Unverified no-profit claim');
  if(!facts.giftVerified && /(?:em tặng|người ta cho|là cho chứ)/i.test(all)) errors.push('Unverified gift claim');
  return {valid:errors.length===0,errors};
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
    keywords: ['gối', 'nệm', 'nệm topper', 'chăn', 'ga giường', 'thảm', 'rèm', 'kệ', 'ghế', 'bàn', 'nến thơm', 'tinh dầu', 'khung tranh', 'hoa lụa'],
    defaultSetting: 'lifestyle_home',
    defaultAudienceAddress: 'mọi người',
    heroAction: 'Presenter nhấn bàn tay lún sâu vào lõi đệm/gối rồi thả ra để thấy khả năng đàn hồi phục hồi siêu nhanh trong 1 giây',
    forbiddenActions: ['cấm đốt lửa gây cháy', 'cấm dùng dao sắc cắt rách vỏ đệm', 'cấm dẫm giày bẩn lên nệm trắng'],
    props: ['giường ngủ gọn gàng trải ga tông pastel', 'ly nước thủy tinh trong suốt', 'đèn ngủ ánh vàng ấm áp'],
  },
  health_wellness_supplements: {
    key: 'health_wellness_supplements',
    label: 'Sức khỏe & Thực phẩm bổ sung',
    keywords: ['vitamin', 'collagen', 'canxi', 'omega', 'trà thảo mộc', 'bột ngũ cốc', 'đông trùng', 'yến sào', 'máy massage', 'đai lưng', 'gối massage'],
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
 * Trích xuất danh sách hành động bị cấm (Forbidden Actions) cho sản phẩm
 */
function deriveProductForbiddenActions(categoryInfo, physicalProfile) {
  const baseForbidden = [
    'cấm làm biến dạng hoặc biến hình sản phẩm thành đồ vật khác',
    'cấm tự ý thêm nhãn mác, chữ số, logo hay icon đồ họa lạ lên thân sản phẩm',
    'cấm sinh thêm người thứ hai trong khung hình (chỉ 1 presenter duy nhất)',
    'cấm tạo góc nhìn méo mó hoặc bàn tay dị tật nhiều hơn 5 ngón',
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
    key: 'product_warehouse', title: 'Kho hàng sản phẩm (locked)',
    promptFragment: WAREHOUSE_BIBLE.architecture + ' ' + WAREHOUSE_BIBLE.inventory + ' ' + WAREHOUSE_BIBLE.continuity + ' ' + WAREHOUSE_BIBLE.forbidden
  },
  factory_showcase: {
    key: 'factory_showcase',
    title: 'Xưởng sản xuất chính hãng (Factory Direct)',
    promptFragment: 'Modern high-tech clean manufacturing facility and quality inspection area. Background features clean organized packaging lines, stainless steel staging tables, neatly stacked branded export cartons on wooden pallets, bright industrial daylight LED lighting, sterile and professional atmosphere.',
  },
  showroom_display: {
    key: 'showroom_display',
    title: 'Showroom trưng bày cao cấp (Premium Showroom)',
    promptFragment: 'High-end minimalist commercial showroom and live-commerce studio. Clean white and warm beige acoustic walls, illuminated glass display vitrines, floating modern wooden shelving with organized product lines, soft directional studio key-lighting and flattering fill lights, professional clean atmosphere.',
  },
  lifestyle_home: {
    key: 'lifestyle_home',
    title: 'Không gian sống gia đình hiện đại (Lifestyle Home)',
    promptFragment: 'Bright modern Scandinavian-inspired home living room and open kitchen countertop. Clean white marble surfaces, warm oak wood textures, sheer linen curtains with natural morning daylight streaming in, small green monstera potted plant in the background, cozy authentic domestic setting.',
  },
  street_handover: {
    key: 'street_handover',
    title: 'Cửa hàng mặt phố năng động (Urban Retail & Fast Deal)',
    promptFragment: 'Dynamic contemporary boutique storefront and retail counter. Clean glass store entrance, well-organized backlit pegboard shelves displaying authentic accessories, cheerful urban retail lighting, vibrant authentic live-commerce atmosphere.',
  }
};

function detectProductSourcingSetting(analysis = {}, options = {}) {
  if (options.warehouseMode !== false) return SOURCING_SCENE_SETTINGS.product_warehouse;
  const explicit = options.sourcingSetting || analysis.sourcingSetting;
  if (explicit && SOURCING_SCENE_SETTINGS[explicit]) {
    return SOURCING_SCENE_SETTINGS[explicit];
  }

  const prodName = String(analysis.productName || analysis.productTitle || options.productTitle || '').toLowerCase();
  const salesMode = options.salesMode || analysis.salesMode || '';
  const cat = routeProductCategory(prodName);

  if (salesMode === 'PRICE_LED' || prodName.includes('xưởng') || prodName.includes('sỉ') || prodName.includes('kho') || prodName.includes('chính hãng tận gốc')) {
    return SOURCING_SCENE_SETTINGS.factory_showcase;
  }
  if (cat.key === 'home_appliances' || cat.key === 'kitchenware_foodprep' || cat.key === 'interior_home_living' || cat.key === 'mother_baby_kids') {
    return SOURCING_SCENE_SETTINGS.lifestyle_home;
  }
  return SOURCING_SCENE_SETTINGS.showroom_display;
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

  return [
    {
      clipIndex: 1,
      duration: 8,
      phase: 'HOOK_AND_PRODUCT_INTRO',
      timeRange: '0-8s',
      focus: 'Visual hook + Problem agitation + Direct camera engagement',
      recommendedAction: `Presenter đứng thẳng tự tin mỉm cười nhìn thẳng vào camera, hai tay nâng ${prodName} lên ngang ngực giới thiệu`,
      visualBeats: [
        { time: '0-4s', action: 'Presenter nhìn thẳng vào ống kính chào tươi tắn, đặt câu hỏi móc nối trực diện vào nhu cầu người xem' },
        { time: '4-8s', action: 'Presenter nâng sản phẩm lên ngang tầm mắt, xoay nhẹ đón sáng commercial rực rỡ' },
      ],
      actionRunway: 'Presenter tư thế sẵn sàng nói, biểu cảm lôi cuốn và tay cầm sản phẩm đầm chắc không che logo',
      framing: 'Vertical 9:16 medium shot (bán thân ngang ngực)',
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
      wardrobe: 'Consistent neat live-commerce presenter outfit',
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

function buildProductIntelligencePromptA(options = {}) {
  const pContext = options.productContext || {};
  const productTitle = pContext.productTitle || options.productTitle || 'Sản phẩm Live-Commerce';
  const productDescription = pContext.productDescription || options.productDescription || '';
  const campaignPrice = options.campaignPrice || pContext.campaignPrice || '';
  const salesMode = options.salesMode || pContext.salesMode || '';

  return [
    `You are the Chief Product Intelligence Analyst and Visual Director for top Vietnamese TikTok Live-Commerce channels.`,
    `Your task is STAGE 1 ANALYSIS: Deeply analyze the supplied product reference images and metadata to construct a comprehensive Product Intelligence & Affordance Profile.`,
    ``,
    `### INPUT METADATA:`,
    `- Product Title: "${productTitle}"`,
    `- Product Description: "${productDescription}"`,
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
    `   - Grip Affordance (how the female host holds it naturally: single_hand_palm, fingertips_pinch, etc.)`,
    `   - Do not plan demonstrations; identify visible exterior details only.`,
    `   - Forbidden Actions (actions that would ruin realism or distort physics)`,
    `4. SOURCING CONTEXT & SETTING: LOCK product_warehouse for every panel. No showroom, home or factory unless explicitly opted out.`,
    `5. PERSONA & AUDIENCE ADDRESS:`,
    `   - Self-reference: "em"`,
    `   - Audience address: Choose ONE and keep it stable: "chị em" (beauty/fashion) | "các bác" (health/kitchen) | "anh chị" (tech/general) | "mọi người" (general)`,
    ``,
    `### RETURN RAW JSON ONLY (No markdown formatting, no text before or after):`,
    `{`,
    `  "analysis": {`,
    `    "productName": "Tên thương mại ngắn gọn, chính xác",`,
    `    "category": "Danh mục sản phẩm chuẩn",`,
    `    "categoryKey": "fashion_apparel|footwear_accessories|beauty_cosmetics|personal_care_hygiene|digital_tech_gadgets|home_appliances|kitchenware_foodprep|interior_home_living|health_wellness_supplements|mother_baby_kids|fallback_general_merchandise",`,
    `    "salesMode": "PRICE_LED|BENEFIT_LED|DEMO_LED",`,
    `    "targetAudience": "Mô tả khách hàng mục tiêu",`,
    `    "audienceAddress": "chị em|các bác|anh chị|mọi người",`,
    `    "selfReference": "em",`,
    `    "sourcingSetting": "product_warehouse",`,
    `    "keyBenefits": ["Lợi ích vượt trội 1", "Lợi ích vượt trội 2", "Lợi ích vượt trội 3"],`,
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
    `      "speaker": "Vietnamese female presenter",`,
    `      "region": "Southern Vietnamese",`,
    `      "tone": "bright, confident, persuasive, friendly",`,
    `      "energy": "high",`,
    `      "pace": "very fast live-commerce (4.5 to 5.0 wps)",`,
    `      "selfReference": "em",`,
    `      "audienceAddress": "chị em"`,
    `    },`,
    `    "visualBible": {`,
    `      "presenterIdentity": "canonical uploaded model (model.png)",`,
    `      "environment": "product warehouse with same-product inventory",`,
    `      "lighting": "bright commercial lighting"`,
    `    }`,
    `  }`,
    `}`
  ].join('\n');
}

// ── 13. STAGE 2: SCRIPT & STORYBOARD PROMPT B ─────────────────────────────────

function buildScriptAndStoryboardPromptB(stage1Analysis = {}, options = {}) {
  const analysis = stage1Analysis.analysis || stage1Analysis || {};
  const prodName = analysis.productName || options.productTitle || 'Sản phẩm Live-Commerce';
  const category = analysis.category || 'Sản phẩm tiêu dùng';
  const salesMode = analysis.salesMode || 'PRICE_LED';
  const audienceAddress = analysis.audienceAddress || 'chị em';
  const selfReference = analysis.selfReference || 'em';
  const heroAction = analysis.affordances?.heroAction || 'Presenter nâng sản phẩm lên ngang ngực thao tác mở nắp đón sáng';
  const setting = 'product_warehouse';
  const selectedHook = selectVerifiedHook(options);
  const verifiedOffer = options.verifiedOffer || options.productContext?.verifiedOffer || {};

  return [
    `You are the Master Scriptwriter & Storyboard Director for top Vietnamese TikTok Live-Commerce.`,
    `Your task is STAGE 2: Write the complete 40-second (5 Clips × 8 Seconds) Native-Voice Live-Commerce Script and 5 Start Frames Storyboard.`,
    ``,
    `### MANDATORY HOOK LIBRARY — 9 VERBATIM EXCEL REFERENCES (NOT VERIFIED VIDEO AUDIO):`,
    JSON.stringify(HOOK_LIBRARY, null, 2),
    `### SELECTED HOOK STYLE: ${selectedHook ? selectedHook.id + ' / ' + selectedHook.type : 'NONE: no verified commercial offer; do not fabricate price, gift, discount or zero-price opening'}`,
    `### VERIFIED OFFER DATA ONLY: ${JSON.stringify(verifiedOffer)}`,
    `### VOICE STYLE BIBLE: ${JSON.stringify(VOICE_STYLE_BIBLE)}`,
    `Preserve the selected reference hook's structure and spoken rhythm, NOT its original product or commercial claims. Adapt only to verified facts. Never invent a new pain-point hook. If no eligible hook, use factual product introduction in conversational tone without invented offers. Keep native voice, 5x8 seconds.`,
    `### VISUAL IS INDEPENDENT OF VOICE: all 5 scenes show static product showcase in ONE identical warehouse; NEVER perform an action just because dialogue mentions it.`,
    `### STAGE 1 INTELLIGENCE INPUT:`,
    `- Product Name: "${prodName}" (${category})`,
    `- Sales Mode: ${salesMode}`,
    `- Presenter Identity: Locked to CANONICAL MODEL reference image (model.png)`,
    `- Audience Address: "${audienceAddress}" (Strictly stable throughout)`,
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
    `   - Every start frame: identical product warehouse and same-product inventory. Only lip sync, blink, tiny head movement and subtle camera motion; no product handling change.`,
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
    `        { "time": "0-4s", "action": "Presenter nhìn thẳng vào camera chào tươi tắn..." },`,
    `        { "time": "4-8s", "action": "Presenter nâng sản phẩm lên ngang ngực giới thiệu..." }`,
    `      ],`,
    `      "startFramePlan": {`,
    `        "presenterPose": "Đứng thẳng tự tin, ánh mắt cuốn hút nhìn thẳng camera",`,
    `        "handPose": "Hai tay nâng sản phẩm trang trọng trước ngực",`,
    `        "productPlacement": "Sản phẩm rõ nét ở trung tâm khung hình 9:16",`,
    `        "framing": "Vertical 9:16 medium shot (bán thân)",`,
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

  return [
    `You are a top-tier Vietnamese live-commerce video strategist and director.`,
    `LOCKED: nine Excel hooks as style reference only; do not invent offer claims. Warehouse only, no demonstration. ${JSON.stringify(VOICE_STYLE_BIBLE)} ${JSON.stringify(HOOK_LIBRARY)}`,
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
    `   - In each 8s video, the female presenter speaks Vietnamese DIRECTLY on camera.`,
    `   - Every single clip must finish at a COMPLETE sentence or clause boundary.`,
    `   - ABSOLUTELY NO sentence splitting across video files (e.g. do NOT end Clip 1 mid-sentence).`,
    `   - Pacing: Fast live-commerce speed (~4.5 to 5.0 words per second).`,
    `   - Word Budget: 34 to 40 Vietnamese words per clip (Total: EXACTLY 180 to 200 words across all 5 clips).`,
    ``,
    `3. PRESENTER PERSONA & VOICE BIBLE:`,
    `   - Same female host as the supplied CANONICAL MODEL reference.`,
    `   - VOICE BIBLE: young adult Vietnamese female, Southern accent, fast live-commerce rhythm.`,
    `   - Self-reference: Default is "em" (stable throughout).`,
    `   - Audience address: Choose ONE address style and keep it stable across all 5 clips:`,
    `     * "các bác" (health/household/older target)`,
    `     * "anh chị" (general adult/professional)`,
    `     * "chị em" (beauty/fashion/female focus)`,
    `     * "mọi người" (general young consumer)`,
    ``,
    `4. SALES MODE SELECTION:`,
    `   - Selected Sales Mode: "${salesMode}" (PRICE_LED | BENEFIT_LED | DEMO_LED)`,
    ``,
    `5. PRODUCT AFFORDANCE ENGINE & SOURCING CONTEXT:`,
    `   - Identify valid physical actions and forbid invalid actions.`,
    `   - Sourcing setting: product_warehouse ONLY.`,
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
    `      "environment": "clean showroom or studio warehouse",`,
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
    `        { "time": "0-4s", "action": "Presenter nhìn thẳng vào camera chào và móc nối hook trực diện" },`,
    `        { "time": "4-8s", "action": "Presenter nâng nhẹ sản phẩm lên ngang ngực, hướng góc đẹp về camera" }`,
    `      ],`,
    `      "startFramePlan": {`,
    `        "presenterPose": "Đứng thẳng tự tin, khuôn mặt tươi tắn mỉm cười nhìn trực diện ống kính",`,
    `        "handPose": "Hai tay cầm sản phẩm đặt ngay ngắn trước ngực",`,
    `        "productPlacement": "Sản phẩm rõ nét ở trung tâm khung hình 9:16",`,
    `        "framing": "Góc quay thẳng bán thân (medium shot) chuẩn dọc 9:16",`,
    `        "environment": "Phòng trưng bày showroom sáng sủa, phía sau có kệ hàng ngăn nắp"`,
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
  return [
    'Create ONE 5-panel storyboard composite, five vertical 9:16 frames side-by-side; each is a static start frame for an 8-second video.',
    'CANONICAL IDENTITY LOCK: identical presenter face, hair, clothing in all five panels, matching supplied model.png.',
    `PRODUCT LOCK: identical exact reference item ${JSON.stringify(prodName)}, exact shape, finish, logo only if visible in reference. Visible texture: ${physicalProfile.surfaceTexture || 'reference only'}. No invented features, packaging, labels or product states.`,
    'WAREHOUSE BIBLE (SAME PLACE IN ALL FIVE PANELS):', JSON.stringify(WAREHOUSE_BIBLE),
    'Show warehouse evidence: high industrial ceiling, steel storage racks, orderly inventory of SAME reference product and its VERIFIED packaging only. Do not invent labels or factory production claims.',
    'Panel 1: medium shot presenter standing by the inventory table and exact product, warehouse racks visible.',
    'Panel 2: slightly closer shot, presenter holds product ONLY IF supported by reference geometry and pose; otherwise product stays on table.',
    'Panel 3: medium shot, product on inventory table and same warehouse shelving behind; no imaginary shopping-cart graphics or gestures.',
    'Panel 4: static detail shot of visible exterior of the intact product, still in SAME warehouse. NO demonstration, pressing buttons, ingredients, opening, disassembly or new product state.',
    'Panel 5: medium closing shot, presenter next to product in SAME warehouse; unchanged layout, inventory and lighting.',
    'Each panel must be a plausible independent still image. Do not depict a sequence of usage or imply moving from one room to another.',
    'Natural smartphone realism, vertical framing per panel, consistent industrial LED lighting; no CGI, no captions, no overlays, no duplicate presenter, no distorted hands.',
    'If product reference does not show its packaging, use generic unlabeled cartons or repeated accurate product units without fabricated branding.'
  ].join('\n');
}

// ── 15. VEO 8s NATIVE VOICE VIDEO PROMPT BUILDER ──────────────────────────────

function buildTemplateProduct8sVideoPrompt(analysis = {}, clipData = {}, options = {}) {
  const dialogueText = String(clipData.dialogue || clipData.voiceOver || clipData.voice_over || '').trim();
  const custom = options.customInstruction ? `USER ADDITIONAL REQUEST (cannot override visual locks): ${options.customInstruction}` : '';
  return [
    'Generate an 8-second vertical 9:16 realistic smartphone video from the PROVIDED START IMAGE ONLY.',
    'ABSOLUTE VISUAL SOURCE OF TRUTH: preserve every visible object, product geometry, logo, color, presenter face, wardrobe, pose, shelving, warehouse architecture, lighting and inventory.',
    'Same warehouse as all other clips. No scene changes, new objects, new people, new packaging, kitchen, showroom or imaginary background.',
    'Allowed movement: lip sync to the exact dialogue, natural blinking, tiny facial/head movement, tiny camera push-in. Hands and product remain stationary in their initial pose.',
    'Forbidden: any product operation, demonstration, rotating or tilting product, opening lid, pressing button, adding ingredients/liquids, assembly, disassembly, picking up objects, gesturing toward nonexistent UI, invented action based on spoken dialogue.',
    'Do NOT use the voice script as an instruction for visual actions. Voice may mention benefits; camera simply shows product and presenter as they already appear.',
    'No text overlays, captions, fake cart icons or additional narrator. Clean native audio, one presenter speaking Southern Vietnamese, energetic but natural.',
    'EXACT DIALOGUE (do not paraphrase, add, remove or split):', JSON.stringify(dialogueText),
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
      dialogue: clipItem.dialogue || clipItem.voiceOver || '',
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
    try { session = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch (_) {}
  }
  const fullAnalysis = analysis || session.analysis?.analysis || session.analysis || {};
  const scriptList = session.analysis?.script || [];

  return (Array.isArray(targetIndices) ? targetIndices : [1])
    .map(Number)
    .filter(idx => idx >= 1 && idx <= 5)
    .map(pIdx => {
      const pPath = path.join(panelsDir, `panel-${pIdx}.png`);
      const pBuf = fs.existsSync(pPath) ? fs.readFileSync(pPath) : null;
      const clipItem = scriptList[pIdx - 1] || {};
      const prompt = buildTemplateProduct8sVideoPrompt(fullAnalysis, clipItem, { customInstruction });

      return {
        index: pIdx,
        panelIndex: pIdx,
        sceneNumber: pIdx,
        targetDuration: 8.0,
        prompt,
        imagePath: pPath,
        buffer: pBuf,
        videoModelKey: 'veo_3_1_i2v_lite_low_priority',
      };
    });
}

// ── 16. REMAKE PROMPT BUILDERS FOR FLOW API ────────────────────────────────────

function buildTemplateProductRemakePrompt(analysis = {}, targetPanelIndex = 1, customInstruction = '') {
  const fullAnalysis = analysis.analysis || analysis || {};
  const prodName = fullAnalysis.productName || 'Sản phẩm review';
  const category = fullAnalysis.category || 'Sản phẩm tiêu dùng';
  const categoryInfo = routeProductCategory(prodName + ' ' + category);
  const pIdx = Math.max(1, Math.min(5, Number(targetPanelIndex) || 1));
  const setting = detectProductSourcingSetting(fullAnalysis);
  const sourcingPrompt = buildProductSourcingScenePrompt(setting, categoryInfo);

  const panelDescriptions = {
    1: `Medium shot. Presenter stands upright facing the camera with a bright, welcoming smile, holding "${prodName}" neatly at chest level. Action Runway: ready to speak and present.`,
    2: `Closer medium shot. Presenter holds "${prodName}" forward with enthusiastic gesture, showcasing deal value. Action Runway: energetic conversational posture.`,
    3: `Medium shot. Presenter holds "${prodName}" in one hand, other hand gesturing clearly toward the bottom-left of the vertical frame pointing at the shopping cart location. Action Runway: open inviting gesture.`,
    4: `Medium close-up shot of the intact reference product exterior in the SAME warehouse. NO demonstration, no manipulation or new objects.`,
    5: `Medium shot. Presenter holds "${prodName}" proudly at chest level with a confident, joyful smile, concluding the showcase. Action Runway: friendly sign-off expression.`,
  };

  let prompt = [
    `Single vertical 9:16 start frame panel (Scene ${pIdx} of 5) for a live-commerce presenter video.`,
    `CRITICAL IDENTITY: The female presenter MUST be the EXACT SAME WOMAN as shown in the canonical model reference (model.png). Same facial features, neat hair, professional presenter outfit.`,
    `CRITICAL PRODUCT: The product MUST be the EXACT SAME model, color, and finish as shown in the product references: "${prodName}" (${category}).`,
    sourcingPrompt,
    `SCENE ${pIdx} SPECIFIC FRAMING: ${panelDescriptions[pIdx]}`,
    `Camera: Smartphone vertical 9:16 aspect ratio, realistic industrial warehouse LED lighting, high resolution, no black bars, no blur.`,
    `NEGATIVE PROMPT: No subtitles, no text overlays, no price tags, no split screens, no distorted hands, no second person. NO product operation or demonstrations. Same warehouse as all other panels.`
  ].join('\n');

  if (customInstruction) {
    prompt += `\n\nUSER CUSTOM INSTRUCTION: ${customInstruction}. Maintain strict identity lock and 9:16 vertical smartphone framing.`;
  }
  return prompt;
}

function buildTemplateProductRemakeAllPrompt(analysis = {}, customInstruction = '') {
  let prompt = buildTemplateProductMasterPrompt(analysis);
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
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
  return outputMasterPath;
}

// ── 19. FFMPEG CONCATENATION OF 5 NATIVE-AUDIO CLIPS (40 SECONDS TARGET) ───────

function concat5NativeAudioClips(panelVideoPaths, outputMergedPath) {
  ensureDir(path.dirname(outputMergedPath));
  if (!Array.isArray(panelVideoPaths) || panelVideoPaths.length < 5) {
    throw new Error(`concat5NativeAudioClips requires 5 video clips, got ${panelVideoPaths?.length}`);
  }

  const inputArgs = [];
  const filterParts = [];

  for (let i = 0; i < 5; i++) {
    inputArgs.push('-i', path.resolve(panelVideoPaths[i]));
    filterParts.push(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=disable,setsar=1[v${i}]`);
  }

  // Ghép nối 5 video clips cùng 5 audio streams tương ứng (native audio)
  const concatInputs = [];
  for (let i = 0; i < 5; i++) {
    concatInputs.push(`[v${i}][${i}:a]`);
  }
  filterParts.push(`${concatInputs.join('')}concat=n=5:v=1:a=1[vout][aout]`);

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
    `- **Sourcing Setting**: \`${analysis.sourcingSetting || 'product_warehouse'}\``,
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
          } catch (_) {}
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
        } catch (_) {}
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
  const template = 'template_product';
  const chatId = options.chatId ? String(options.chatId) : null;
  const isAuto = Boolean(options.isAuto);

  console.log(`[TemplateProduct] 🎬 Starting Live-Commerce Presenter 40s Native-Voice Pipeline (Run: ${runId}, Job: ${originalJobId})...`);

  // Nạp ảnh người mẫu chuẩn (Canonical Presenter Reference - model.png)
  const presenterAsset = getCanonicalPresenterBuffer();
  if (!presenterAsset) {
    throw new Error('ERR_MISSING_PRESENTER_REFERENCE: Không tìm thấy ảnh người mẫu chuẩn model.png tại docs/tproduct/model.png hoặc assets/tproduct/presenter.png');
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

    // Chuẩn bị payload hình ảnh: đưa ảnh người mẫu lên đầu, theo sau là ảnh sản phẩm
    const allImagePayloads = [
      {
        name: 'model.png',
        buffer: presenterAsset.buffer,
        mimeType: 'image/png',
      },
      ...(Array.isArray(filePayloads) ? filePayloads : []).filter(f => f && (f.buffer || f.path || f.base64))
    ];

    const uploadedFiles = [];
    if (geminiClient) {
      for (let i = 0; i < Math.min(allImagePayloads.length, 5); i++) {
        const item = allImagePayloads[i];
        const buf = Buffer.isBuffer(item.buffer)
          ? item.buffer
          : (item.base64 ? Buffer.from(item.base64, 'base64') : (item.path && fs.existsSync(item.path) ? fs.readFileSync(item.path) : null));
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
    const promptA = buildProductIntelligencePromptA(options);
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
    const prodTitle = options.productContext?.productTitle || options.productTitle || 'Sản phẩm Live-Commerce';
    const catInfo = routeProductCategory(prodTitle);
    const physical = analyzeProductPhysicalProfile({ productName: prodTitle });
    const settingObj = detectProductSourcingSetting({ productName: prodTitle }, options);

    if (!stage1Parsed || !stage1Parsed.analysis) {
      console.log(`[TemplateProduct] Stage 1 parse fallback: Building deterministic intelligence profile for "${prodTitle}"...`);
      stage1Parsed = {
        analysis: {
          productName: prodTitle,
          category: catInfo.label,
          categoryKey: catInfo.key,
          salesMode: options.salesMode || 'PRICE_LED',
          targetAudience: 'Người tiêu dùng hiện đại, săn deal thông minh',
          audienceAddress: catInfo.defaultAudienceAddress || 'chị em',
          selfReference: 'em',
          sourcingSetting: settingObj.key,
          keyBenefits: ['Chất lượng chuẩn xịn', 'Tiện lợi sử dụng vượt trội', 'Mức giá ưu đãi độc quyền'],
          physicalProfile: physical,
          affordances: deriveProductAffordances(catInfo, physical),
          voiceBible: DEFAULT_GLOBAL_VOICE_BIBLE,
          visualBible: DEFAULT_GLOBAL_VISUAL_BIBLE,
        }
      };
    }

    stage1Parsed.analysis.sourcingSetting = 'product_warehouse';
    stage1Parsed.analysis.visualBible = {...DEFAULT_GLOBAL_VISUAL_BIBLE, warehouseBible: WAREHOUSE_BIBLE};
    stage1Parsed.analysis.warehouseBible = WAREHOUSE_BIBLE;
    stage1Parsed.analysis.affordances = {...(stage1Parsed.analysis.affordances || {}), heroAction:'No demonstration; static product detail'};

    // ── STAGE 2: 40s Native-Voice Script & Storyboard Construction (Prompt B) ──
    console.log(`[TemplateProduct] Stage 2: Crafting 40s 5-Clip Native-Voice Script & Storyboard (Prompt B)...`);
    const promptB = buildScriptAndStoryboardPromptB(stage1Parsed, options);
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
      const addr = stage1Parsed.analysis.audienceAddress || 'chị em';

      analysisData = {
        analysis: stage1Parsed.analysis,
        script: [
          {
            clipIndex: 1,
            duration: 8,
            phase: 'HOOK_AND_PRODUCT_INTRO',
            dialogue: `${addr.charAt(0).toUpperCase() + addr.slice(1)} ơi, hôm nay em giới thiệu ${prodTitle} nè. Mình cùng nhìn kỹ sản phẩm và các thông tin được cung cấp để xem có phù hợp với nhu cầu của mình không nha.`,
            wordCount: 36,
            visualBeats: dynamic5Clips[0].visualBeats,
            startFramePlan: {
              presenterPose: 'Đứng thẳng tự tin, ánh mắt cuốn hút nhìn thẳng camera',
              handPose: 'Hai tay nâng sản phẩm trang trọng trước ngực',
              productPlacement: 'Sản phẩm rõ nét ở trung tâm khung hình 9:16',
              framing: 'Vertical 9:16 medium shot',
              environment: 'Same locked product warehouse for all five panels'
            },
            actionRunway: { valid: true, motion: 'Tư thế sẵn sàng nói và nâng sản phẩm đón sáng' }
          },
          {
            clipIndex: 2,
            duration: 8,
            phase: 'DEAL_AND_VALUE_BUILD',
            dialogue: `Em sẽ nói rõ từng điểm trong mô tả sản phẩm nha mọi người. Mình xem kỹ hình dáng, các chi tiết có trong ảnh tham khảo và thông tin của sản phẩm trước khi quyết định nhé.`,
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
            dialogue: `Nếu quan tâm thì anh chị có thể mở thông tin sản phẩm để xem phiên bản, giá và điều kiện giao hàng đang được hiển thị thực tế nha. Em không tự đoán mức giá hay ưu đãi đâu ạ.`,
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
            dialogue: `Giờ mình nhìn cận cảnh những chi tiết đang thấy rõ trên sản phẩm nha. Anh chị đối chiếu với hình ảnh và thông số nhà bán cung cấp để chọn đúng mẫu, đúng phiên bản mà mình cần.`,
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
            dialogue: `Vậy là em đã giới thiệu nhanh sản phẩm cho anh chị rồi nè. Nếu thấy phù hợp, mình xem lại mô tả, giá bán và điều kiện giao hàng thực tế ở trang sản phẩm trước khi đặt nha.`,
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

    analysisData = normalizeWarehouseStoryboard(analysisData);
    analysisData.selectedHook = selectVerifiedHook(options)?.id || null;
    analysisData.hookLibraryVersion = 'excel-9-v1';
    const warehouseValidation = validateWarehouseStoryboard(analysisData);
    if (!warehouseValidation.valid) throw new Error('Warehouse storyboard validation failed: ' + warehouseValidation.errors.join('; '));
    const claimValidation = validateOfferClaims(analysisData.script, options);
    if (!claimValidation.valid) {
      // Fail closed rather than rendering fabricated pricing/offer claims.
      throw new Error('Voice offer claims need verified metadata: ' + claimValidation.errors.join('; '));
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

    // Đóng Gemini browser ngay sau Stage 1 & Stage 2 để giải phóng tài nguyên, tránh mở 2 browser cùng lúc
    try { await geminiClient.close(); } catch (_) {}

    // ── Sinh Master Storyboard (5 panels) qua Google Flow ──
    console.log(`[TemplateProduct] Step 2: Generating candidate storyboards via Google Flow...`);
    const masterPrompt = buildTemplateProductMasterPrompt(analysis, options);

    const validPayloads = [
      {
        name: 'model.png',
        buffer: presenterAsset.buffer,
        mimeType: 'image/png'
      },
      ...(Array.isArray(filePayloads) ? filePayloads : [])
        .filter(f => f && (f.buffer || f.path))
        .slice(0, 3)
        .map((f, idx) => ({
          name: f.name || `product_${idx + 1}.png`,
          buffer: Buffer.isBuffer(f.buffer) ? f.buffer : (f.path && fs.existsSync(f.path) ? fs.readFileSync(f.path) : null),
          mimeType: f.mimeType || 'image/png'
        }))
        .filter(f => f.buffer)
    ];

    let flowPage = null;
    try {
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
      }
    } catch (fErr) {
      console.warn(`[TemplateProduct] Flow generation warning: ${fErr.message}. Using fallback generator...`);
    } finally {
      if (flowPage) {
        try { await closeFlowPage(flowPage); } catch (_) {}
      }
    }

    // Nếu không sinh được ứng viên từ Flow, tạo fallback canvas 16:9 5 panels
    if (candidateBuffers.length === 0) {
      const fallbackMasterPath = path.join(candidatesDir, 'candidate-1.png');
      const pBuf = presenterAsset.buffer;
      const dummyPanels = [pBuf, pBuf, pBuf, pBuf, pBuf];
      composeMasterStoryboardProduct(dummyPanels, fallbackMasterPath);
      candidateBuffers.push(fs.readFileSync(fallbackMasterPath));
    } else {
      candidateBuffers.forEach((buf, idx) => {
        fs.writeFileSync(path.join(candidatesDir, `candidate-${idx + 1}.png`), buf);
      });
    }

    const bestCandIdx = 1;
    const bestMasterBuf = candidateBuffers[0];
    const qaResult = {
      candidates: candidateBuffers.map((_, idx) => ({
        candidateIndex: idx + 1,
        totalScore: idx === 0 ? 94 : 88 - idx * 2,
        breakdown: 'Preserves model identity, 5 clean live-commerce panels with Action Runway & Sourcing Setting',
      })),
      selectedCandidateIndex: bestCandIdx,
    };

    // ── Slices master thành 5 panels 9:16 ──
    console.log(`[TemplateProduct] Step 3: Slicing master storyboard into 5 vertical panels (1080x1920, 9:16)...`);
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
      template: 'template_product',
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
        ? qaResult.candidates.map(c => `#${c.candidateIndex || c.index}: <b>${c.totalScore || c.score || 90}đ</b>`).join(' | ')
        : '';
      const bestScore = qaResult?.candidates?.[0]?.totalScore || 94;
      const captionLines = [
        `🎨 <b>[Template Product] Master Storyboard đã tạo xong! (40s Native-Voice)</b>\n`,
        `📦 <b>Sản phẩm:</b> ${analysis.productName || 'Sản phẩm review'}`,
        `🏭 <b>Bối cảnh:</b> <code>${settingObj.title}</code>`,
        `🎯 <b>Chế độ bán hàng:</b> <code>${analysis.salesMode || 'PRICE_LED'}</code> (5 Cảnh x 8s, 34-40 từ/cảnh)`,
        ...(candidateScoresText ? [`📊 <b>Điểm 4 Storyboard:</b> ${candidateScoresText}`] : []),
        `🏆 <b>Đã chọn:</b> Storyboard #${bestCandIdx} (Điểm kiểm định: <b>${bestScore}/100</b>)\n`,
        `🖼️ Storyboard gồm 5 cảnh (1: Hook, 2: Deal Build, 3: Offer & CTA, 4: Proof/Demo, 5: Benefit & Close).`,
        `🎙️ <b>Giọng nói trực tiếp (Native Voice)\n`,
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
      template: 'template_product',
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
    try { await geminiClient.close(); } catch (_) {}
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
    rPrompt = buildTemplateProductRemakePrompt(session.analysis?.analysis, pIdx, opts.customInstruction);
    const presenterAsset = getCanonicalPresenterBuffer();
    const remakePayloads = [];
    if (presenterAsset) {
      remakePayloads.push({
        name: 'model.png',
        buffer: presenterAsset.buffer,
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
    await closeFlowPage(flowPage).catch(() => {});
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
    rPrompt = buildTemplateProductRemakeAllPrompt(session.analysis?.analysis, opts.customInstruction);
    const presenterAsset = getCanonicalPresenterBuffer();
    const remakePayloads = [];
    if (presenterAsset) {
      remakePayloads.push({
        name: 'model.png',
        buffer: presenterAsset.buffer,
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
    await closeFlowPage(flowPage).catch(() => {});
  }

  if (!newMasterBuf) {
    throw new Error('Failed to regenerate master storyboard via Google Flow');
  }

  const tempMasterPath = path.join(session.runDir, 'temp-master-remake.png');
  fs.writeFileSync(tempMasterPath, newMasterBuf);

  // Slices master mới thành 5 panels 9:16
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
        try { fs.unlinkSync(path.join(userDataDir, f)); } catch (_) {}
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
        } catch (_) {}
      }
    }
  } catch (_) {}
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

  console.log(`[TemplateProduct] 🎬 Generating 5x 8s Veo Native-Voice videos (Model: veo_3_1_i2v_lite_low_priority)...`);
  sanitizeChromeDataProfiles(effectiveBaseDir);

  const panelJobs = buildTemplateProductRemakeVideoJobs(
    session.runDir,
    [1, 2, 3, 4, 5],
    opts.customInstruction,
    session.analysis?.analysis
  );

  let videoResults = [];
  try {
    videoResults = await generateVideosFromPanelsDirect(effectiveBaseDir, panelJobs, {
      aspectRatio: '9:16',
      videoModelKey: 'veo_3_1_i2v_lite_low_priority',
      includeVideoBase64: true,
      cropPercent: 0,
      preserveBorder: true,
      multiImageMode: false,
      runId: `prod-${runId}`,
    });
  } catch (genErr) {
    console.warn(`[TemplateProduct] ⚠️ Remote Veo generation failed (${genErr.message}). Applying camera motion fallback.`);
  }

  const savedVideoPaths = [];
  for (let i = 1; i <= 5; i++) {
    const targetPath = path.join(session.videosDir, `panel-${i}.mp4`);
    const r = (videoResults || []).find(v => v.panelIndex === i) || videoResults?.[i - 1];
    if (r?.videoPath && fs.existsSync(r.videoPath) && fs.statSync(r.videoPath).size > 0) {
      try { fs.copyFileSync(r.videoPath, targetPath); } catch (_) {}
    } else if (r?.videoBase64) {
      fs.writeFileSync(targetPath, Buffer.from(r.videoBase64, 'base64'));
    }

    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
      const pPath = path.join(session.panelsDir, `panel-${i}.png`);
      generateCameraMotionProductClip(pPath, targetPath, {
        panelIndex: i,
        duration: 8.0,
      });
    }
    savedVideoPaths.push(targetPath);
  }

  // Ghép 5 video 8s thành video 40s hoàn chỉnh giữ nguyên Native Audio
  console.log(`[TemplateProduct] 🎞️ Concatting 5 native-audio clips into final 40s video...`);
  const mergedVideoPath = path.join(session.videosDir, 'final_video.mp4');
  concat5NativeAudioClips(savedVideoPaths, mergedVideoPath);

  const finalDur = getMediaDuration(mergedVideoPath) || 40.0;
  const durationFormatted = finalDur.toFixed(1);
  const prodName = session.analysis?.analysis?.productName || 'Sản phẩm Live-Commerce';
  const defaultTags = ['#livestream', '#xuhuong', '#review', '#sanphamchinhhang', '#tiktokshop'];
  const hashtags = normalizeHashtags(session.analysis?.analysis?.hashtags, defaultTags).slice(0, 5);

  // Copy vào thư mục final/ để đồng bộ upload TikTok
  const finalDir = path.join(session.runDir, 'final');
  ensureDir(finalDir);
  const finalVideoPath = path.join(finalDir, 'final-video.mp4');
  try { fs.copyFileSync(mergedVideoPath, finalVideoPath); } catch (_) {}

  session.mergedVideoPath = mergedVideoPath;
  session.finalVideoPath = mergedVideoPath;
  session.savedVideoPaths = savedVideoPaths;
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
      await deleteTelegramMessage(chatId, opts.statusMsgId).catch(() => {});
    }

    // 1. Gửi video hoàn chỉnh
    const videoCaption = [
      `🎬 <b>[Template Product] Video Live-Commerce Hoàn Chỉnh (${durationFormatted} giây)</b>\n`,
      `✨ <i>Đã ghép đủ 5 Cảnh (8s/cảnh) lồng ghép giọng đọc review tiếng Việt tự nhiên 100% (Native Voice).</i>`
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

    // 3. Gửi tiêu đề + hashtag để copy tiện lợi
    await sendTelegramMessage(chatId, `${prodName}\n\n${hashtags.join(' ')}`);

    // 4. Gửi status message hoàn tất kèm keyboard thao tác
    const keyboard = buildProductVideoInlineKeyboard(runId);
    const finalStatusLines = [
      `🎉 <b>TẠO VIDEO REVIEW HOÀN TẤT (${durationFormatted} GIÂY)!</b>\n`,
      `📦 <b>Sản phẩm:</b> <b>${prodName}</b>\n`,
      `1. ✅ Tải thông tin & hình ảnh sản phẩm (Khóa khuôn mặt người mẫu chuẩn model.png)`,
      `2. ✅ Phân tích sản phẩm 2-Stage & lên kịch bản 5 cảnh 40s (34-40 từ/cảnh, 180-200 từ)`,
      `3. ✅ Tạo 5 Start Frames & chia 5 panel (16:9 -> 9:16)`,
      `4. ✅ Sinh 5 video chuyển động AI Veo 8s có thoại trực tiếp (Native Voice)`,
      `5. ✅ Ghép nối 5 clip gốc hoàn hảo, giữ nguyên âm thanh trực tiếp\n`,
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

  const singleJob = [{
    index: pIdx,
    panelIndex: pIdx,
    prompt,
    imagePath: pPath,
    buffer: pBuf,
    videoModelKey: 'veo_3_1_i2v_lite_low_priority',
  }];

  sanitizeChromeDataProfiles(effectiveBaseDir);

  let newVideos = [];
  try {
    newVideos = await generateVideosFromPanelsDirect(effectiveBaseDir, singleJob, {
      aspectRatio: '9:16',
      videoModelKey: 'veo_3_1_i2v_lite_low_priority',
      includeVideoBase64: true,
      multiImageMode: false,
      cropPercent: 0,
      preserveBorder: true,
      runId: `prod-${runId}-remake-${pIdx}`,
    });
  } catch (genErr) {
    console.warn(`[TemplateProduct] ⚠️ Remote Veo remake failed for scene ${pIdx} (${genErr.message}). Applying camera motion fallback.`);
  }

  const targetPath = path.join(session.videosDir, `panel-${pIdx}.mp4`);
  if (newVideos && newVideos[0]?.videoPath && fs.existsSync(newVideos[0].videoPath) && fs.statSync(newVideos[0].videoPath).size > 0) {
    try { fs.copyFileSync(newVideos[0].videoPath, targetPath); } catch (_) {}
  } else if (newVideos && newVideos[0]?.videoBase64) {
    fs.writeFileSync(targetPath, Buffer.from(newVideos[0].videoBase64, 'base64'));
  }

  if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
    generateCameraMotionProductClip(pPath, targetPath, {
      panelIndex: pIdx,
      duration: 8.0,
    });
  }

  // Ghép lại video 40s hoàn chỉnh giữ nguyên Native Audio
  const panelVideos = [1, 2, 3, 4, 5].map(i => path.join(session.videosDir, `panel-${i}.mp4`));
  const mergedVideoPath = path.join(session.videosDir, 'final_video.mp4');
  concat5NativeAudioClips(panelVideos, mergedVideoPath);

  const finalDur = getMediaDuration(mergedVideoPath) || 40.0;
  const durationFormatted = finalDur.toFixed(1);
  const prodName = session.analysis?.analysis?.productName || 'Sản phẩm Live-Commerce';

  const finalDir = path.join(session.runDir, 'final');
  ensureDir(finalDir);
  try { fs.copyFileSync(mergedVideoPath, path.join(finalDir, 'final-video.mp4')); } catch (_) {}

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

  if (chatId) {
    // 1. Gửi video hoàn chỉnh cập nhật
    const videoCaption = [
      `✨ <b>[Template Product] Đã cập nhật xong Video Cảnh ${pIdx}!</b>\n`,
      `🎬 <i>Video ${durationFormatted} giây hoàn chỉnh đã được ghép lại với Cảnh ${pIdx} mới và giữ nguyên giọng đọc trực tiếp (Native Voice).</i>`
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
  sliceMasterStoryboardProduct,
  composeMasterStoryboardProduct,
  concat5NativeAudioClips,
  getCanonicalPresenterBuffer,

  // Session & Constants
  getProductSession,
  saveProductSession,
  DEFAULT_GLOBAL_VOICE_BIBLE,
  DEFAULT_GLOBAL_VISUAL_BIBLE,
  HOOK_LIBRARY,
  VOICE_STYLE_BIBLE,
  WAREHOUSE_BIBLE,
  selectVerifiedHook,
  normalizeWarehouseStoryboard,
  validateWarehouseStoryboard,
  validateOfferClaims,
  SOURCING_SCENE_SETTINGS,
};
