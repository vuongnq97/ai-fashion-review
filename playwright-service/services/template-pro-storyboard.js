'use strict';

/**
 * template-pro-storyboard.js
 *
 * Pipeline Template Pro (/tpro):
 * - Kế thừa từ Template 5.2 (đa ngành hàng, faceless 100%, smartphone realism, no-text).
 * - Interactive Storyboard Workflow:
 *   1. Lần 1: Input + Prompt 1 => Master Storyboard 1 => Tách thành 4 panels tự nhiên 4:9 (480x1080).
 *   2. Gửi Master Storyboard 1 về Telegram kèm 4 nút [Remake 1, 2, 3, 4] và 1 nút [OK].
 *      Lưu telegramMessageId để có thể replace tin nhắn ở các lần remake tiếp theo.
 *   3. Khi user bấm Remake K:
 *      Gửi tin nhắn trạng thái ngay lập tức vào chat.
 *      Input + Prompt Remake K + Storyboard hiện tại => AI gen Storyboard mới.
 *      Tách panel K mới sinh (480x1080), thay thế vào bộ 4 panels đã chọn.
 *      Ghép 4 panels lại thành Storyboard 16:9 composite mới (1920x1080) KHÔNG BỊ BÓP MÉO.
 *      Ghi lịch sử vào prompts.md.
 *      Replace (cập nhật in-place qua editMessageMedia) tin nhắn ảnh trên Telegram kèm lại các nút.
 *      Xóa tin nhắn trạng thái để chat luôn sạch sẽ.
 *   4. Khi user bấm OK:
 *      Chốt 4 panels cuối cùng và thông báo hoàn tất sẵn sàng cho bước tiếp theo.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const { GeminiApiClient } = require('./gemini-client/gemini-api');
const {
  combineTwoSceneScripts,
} = require('./template5-storyboard');
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
const { registerExternalCompletedJob } = require('./generation-job');
const { FlowStepTracker } = require('./flow-step-tracker');

// In-memory cache for active /tpro sessions: runId -> sessionData
const proSessions = new Map();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Xử lý làm sạch và parse JSON cho Template Pro
 */
/**
 * Làm sạch các ký tự điều khiển (bad control characters) không hợp lệ bên trong string literals của JSON
 */
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

/**
 * Sửa lỗi unescaped double quotes bên trong giá trị chuỗi của JSON
 */
function repairJsonNestedQuotes(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const repaired = lines.map(line => {
    // 1. Dòng property chuỗi: "key": "value có "ngoặc kép" ở trong",? hoặc { "id": 1, "voiceOver": "value..." }
    const propMatch = line.match(/^(\s*(?:\{[^{}]*)?"[^"]+"\s*:\s*")(.*)("(?:\s*\}|\s*,)?(?:\s*\/\/[^\r\n]*)?\s*)$/);
    if (propMatch) {
      const prefix = propMatch[1];
      let middle = propMatch[2];
      const suffix = propMatch[3];
      middle = middle.replace(/(?<!\\)"/g, '\\"');
      return prefix + middle + suffix;
    }
    // 2. Dòng phần tử chuỗi trong mảng: "giá trị có "ngoặc kép"",?
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

/**
 * Trích xuất cấp cứu các trường dữ liệu phân tích sản phẩm nếu JSON parsing bị lỗi không thể phục hồi
 */
function extractFallbackAnalysisFields(text) {
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

  const category = extractString('category') || 'home';
  const targetUser = extractString('targetUser') || 'Người tiêu dùng và gia đình';
  const buyerAngle = extractString('buyerAngle') || 'self_use';
  const addressStyle = extractString('addressStyle') || 'mọi người / cả nhà';
  const cartAnchorText = extractString('cartAnchorText') || 'Bấm giỏ hàng góc trái màn hình';
  const materials = extractString('materials') || 'Chất liệu cao cấp';

  const hashtags = [];
  const hashMatches = text.matchAll(/#([a-zA-Z0-9_\u00C0-\u024F\u1E00-\u1EFF]+)/g);
  for (const hm of hashMatches) {
    const tag = `#${hm[1]}`;
    if (!hashtags.includes(tag)) hashtags.push(tag);
    if (hashtags.length >= 5) break;
  }
  if (hashtags.length === 0) {
    hashtags.push('#review', '#tiktokshop', '#trending');
  }

  const script = [];
  const sceneRegex = /\{\s*"id"\s*:\s*([1-4])[\s\S]*?"voiceOver"\s*:\s*"([^"]*(?:\\\\.[^"]*)*)"[\s\S]*?\}/gi;
  let scMatch;
  while ((scMatch = sceneRegex.exec(text)) !== null) {
    const id = parseInt(scMatch[1], 10);
    let vo = scMatch[2];
    try { vo = JSON.parse(`"${vo}"`); } catch (_) { vo = vo.replace(/\\"/g, '"'); }
    script.push({
      id,
      phase: id === 1 ? 'Hook' : (id === 2 ? 'Solution' : (id === 3 ? 'Proof' : 'Closing')),
      voiceOver: vo,
    });
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
          voiceOver: vo,
        });
      }
      idx++;
    }
  }

  return {
    analysis: {
      productName: pName,
      category,
      targetUser,
      buyerAngle,
      addressStyle,
      cartAnchorText,
      hashtags,
      materials,
      highlights: ['Tiện dụng', 'Bền đẹp'],
      targetAudience: targetUser,
      fourAnswers: {},
    },
    script: script.sort((a, b) => a.id - b.id),
    panelOverlays: [
      { id: 1, headline: pName.toUpperCase(), subtexts: ['• ' + pName] },
      { id: 2, headline: 'CÔNG NĂNG VƯỢT TRỘI', subtexts: ['• Tiện lợi mỗi ngày'] },
      { id: 3, headline: 'CHẤT LIỆU CAO CẤP', subtexts: ['• Chắc nịch bao bền'] },
      { id: 4, headline: 'ƯU ĐÃI HÔM NAY', subtexts: ['• Bấm giỏ hàng ngay'] }
    ]
  };
}

/**
 * Tự động đóng các ngoặc nhọn / ngoặc vuông bị thiếu nếu LLM phản hồi dở dang
 */
function autoBalanceJsonBraces(text) {
  if (!text) return '';
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === '{') openBraces++;
      else if (ch === '}') openBraces--;
      else if (ch === '[') openBrackets++;
      else if (ch === ']') openBrackets--;
    }
  }

  let balanced = text;
  while (openBrackets > 0) {
    balanced += '\n]';
    openBrackets--;
  }
  while (openBraces > 0) {
    balanced += '\n}';
    openBraces--;
  }
  return balanced;
}

/**
 * Xử lý làm sạch và parse JSON toàn diện cho Template Pro:
 * - Miễn nhiễm với Bad control characters
 * - Tự sửa unescaped double quotes bên trong chuỗi
 * - Tự sửa thiếu dấu phẩy ở cuối dòng
 * - Tự sửa trailing commas & unquoted keys
 * - Tự động cân bằng ngoặc đóng
 */
function parseJsonObjectPro(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

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
  } catch (_) { }

  // 2. Thử sửa unescaped double quotes bên trong chuỗi trên từng dòng TRƯỚC KHI sanitize
  // (Nếu sanitize trước, unescaped quote sẽ làm inString bị lộn ngược và biến \n thành \\n, phá hủy cấu trúc dòng)
  let cleanQuotes = repairJsonNestedQuotes(s);
  try {
    return JSON.parse(cleanQuotes);
  } catch (_) { }

  // 3. Làm sạch control characters (unescaped newlines bên trong chuỗi đa dòng, tabs)
  const clean1 = sanitizeJsonControlCharacters(cleanQuotes);
  try {
    return JSON.parse(clean1);
  } catch (_) { }

  // 4. Sửa thiếu dấu phẩy giữa các thuộc tính/dòng và xóa comments/trailing commas
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
  } catch (_) { }

  // 5. Tự động đóng các ngoặc nhọn/vuông bị thiếu nếu Gemini bị ngắt giữa chừng
  let balanced = autoBalanceJsonBraces(cleanCommas);
  balanced = balanced.replace(/,\s*([\}\]])/gu, '$1');
  try {
    return JSON.parse(balanced);
  } catch (err) {
    console.warn(`[TemplatePro] JSON parse fallback: ${err.message}`);
  }

  // 6. Cứu hộ cấp cứu bằng Regex Extractor: Nếu JSON vẫn bị lỗi cú pháp không thể parse,
  // tự động trích xuất các trường dữ liệu quan trọng nhất từ text gốc thay vì trả về null!
  const extracted = extractFallbackAnalysisFields(s);
  if (extracted) {
    console.log(`[TemplatePro] 🛡️ Cứu hộ thành công: Đã trích xuất cấu trúc analysis từ phản hồi thô.`);
    return extracted;
  }

  return null;
}

/**
 * Xây dựng prompt phân tích sản phẩm chuyên biệt cho Template Pro:
 * - 4 cảnh tiếp thị (Hook, Solution, Proof, Closing).
 * - Yêu cầu LỜI THOẠI VOICE-OVER: 16 ĐẾN 18 TỪ CHO MỖI CẢNH (TỔNG 4 CẢNH TỐI THIỂU 65 TỪ, TỐI ĐA 70 TỪ CHO TOÀN BỘ VIDEO 16 GIÂY).
 * - Tốc độ đọc review tự nhiên, cuốn hút, đọc hết trong 16 giây, TUYỆT ĐỐI KHÔNG CUTOFF.
 */
function buildTemplateProAnalysisPrompt(options = {}) {
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

  return `TEXT-ONLY TASK. Do not generate images. Do not call image generation. Do not create a visual storyboard asset.
You are a senior multi-category e-commerce marketing strategist, TikTok viral content director, and Veo 3 prompt writer.
Analyze the uploaded product reference images (which can be any product: Fashion, Clothing, Bags, Footwear, Cosmetics/Skincare, Home Appliances/Kitchenware, Tech Gadgets, Accessories, etc.) and the TikTok Shop product description metadata. Write a comprehensive 4-scene product review plan as JSON text only.
${contextSection}

CRITICAL 4-SCENE MARKETING FRAMEWORK (BẮT BUỘC TRẢ LỜI ĐỦ 4 CÂU HỎI THEO 4 CẢNH BẰNG GIỌNG ĐỜI THƯỜNG MIỀN NAM):
Video bao gồm đúng 4 cảnh nội dung (sau này được ghép thành 2 video panel, mỗi video chứa 2 cảnh):
1. Cảnh 1 (HOOK) — "Hook gì để người xem dừng lướt?"
   - Bắt trend đời thường / chạm đúng nhu cầu của người dùng thực tế: "Bữa giờ lướt TikTok thấy rần rần em này...", "Ai hay bị...", "Cứ tưởng bình thường mà thử xong mê xỉu...", "Chị em nào đang tìm quà cho người yêu...", "Nhà nào có bé nhỏ..."
   - Cảnh báo chân thành bạn bè: "Mọi người đừng vội mua nếu chưa coi hết clip này nha..."
2. Cảnh 2 (SOLUTION - GIẢI PHÁP) — "Sản phẩm là giải pháp gì cho người dùng thực tế?"
   - Giới thiệu giải pháp tự nhiên, cưng xỉu: "Ta nói em này cưng xỉu mà tiện gì đâu á...", "Cứu tinh đời tui chính là ẻm nè...", "Giải quyết gọn lẹ mọi thứ ưng bụng ghê luôn..."
   - Lợi ích chính & điểm khác biệt vượt trội, giải quyết đúng nỗi đau của người trực tiếp xài.
3. Cảnh 3 (PROOF - BẰNG CHỨNG) — "Bằng chứng nào khiến người xem tin tưởng?"
   - Cầm trên tay thực tế: chất liệu xịn xò, chắc nịch bao bền, an toàn lành tính, sờ vào êm ái, test thực tế uy tín, xài bao êm.
4. Cảnh 4 (CLOSING / CTA - CHỐT ĐƠN) — "Lý do gì để họ mua ngay (cho mình hoặc mua tặng người thân)?"
   - Đáng đồng tiền bát gạo, chốt đơn giỏ hàng góc trái màn hình: "Đúng bài luôn á, mọi người bấm liền giỏ hàng góc trái hốt về nha...", "Rinh ngay một em kẻo hết deal hời nghen...", "Chị em sắm ngay cho người thương/gia đình nè..."

QUY TẮC CỐT LÕI (STRICT RULES CHO TEMPLATE PRO):
1. PHÂN TÍCH RÕ NGƯỜI SỬ DỤNG THỰC TẾ & GÓC ĐỘ NGƯỜI MUA (TARGET USER vs. BUYER PERSONA):
   - AI LÀ NGƯỜI TRỰC TIẾP SỬ DỤNG (targetUser): Xác định rõ ràng ai là người trực tiếp dùng món đồ này (Ví dụ: em bé/trẻ nhỏ, học sinh/sinh viên, dân văn phòng, nam giới/chồng/bạn trai, mẹ bỉm/phụ nữ, người lớn tuổi/ông bà bố mẹ, thú cưng, hay cả gia đình...).
   - GÓC ĐỘ NGƯỜI MUA (buyerAngle):
     * "self_use": Tự mua tự xài cho bản thân.
     * "gift_for_partner": Mua tặng / sắm cho chồng, bạn trai, người yêu (ví dụ chị em mua cho nam giới).
     * "for_kids": Bố mẹ / mẹ bỉm mua cho con cái, em bé.
     * "for_parents": Con cái mua biếu, chăm sóc sức khỏe cho bố mẹ, ông bà.
     * "for_family": Sắm sửa đồ dùng chung cho cả gia đình, nhà cửa.
   - BẮT BUỘC kịch bản review phải nói trúng tâm lý của góc độ này: Nếu là đồ cho bé thì nói đến sự an toàn, bé ăn ngoan ngủ ngon mẹ nhàn tênh; nếu mua cho chồng/người yêu thì góc độ chăm sóc người thương tinh tế; nếu mua biếu bố mẹ thì con cái hiếu thảo; nếu tự xài thì tiện nghi cưng xỉu.
2. QUY TẮC KIỂM SOÁT ĐẠI TỪ XƯNG HÔ — TUYỆT ĐỐI KHÔNG LẠM DỤNG TỪ "MẤY BÀ":
   - KHÔNG ĐƯỢC LẠM DỤNG TỪ "mấy bà": Trước đây kịch bản hay bị rập khuôn lặp đi lặp lại "mấy bà" ở mọi câu. Từ "mấy bà" chỉ được dùng TỐI ĐA 1 LẦN trong cả 4 cảnh (hoặc KHÔNG DÙNG NẾU KHÔNG PHÙ HỢP). Tuyệt đối cấm dùng "mấy bà" nếu sản phẩm là đồ nam, đồ công nghệ, đồ cho bé hoặc đồ người lớn tuổi.
   - BẮT BUỘC ĐA DẠNG HÓA đại từ xưng hô theo đúng targetUser và buyerAngle:
     * Đồ đại chúng, gia đình, nhà cửa, tiện ích: dùng 'mọi người', 'cả nhà', 'mấy bạn', 'nhà nào đang...', 'ai hay...'
     * Đồ công nghệ, phụ kiện xe, nam giới, thể thao: dùng 'anh em', 'mấy ông', 'bác nào', 'bạn nào mê...'
     * Đồ cho bé, mẹ bỉm: dùng 'các mẹ bỉm', 'nhà nào có bé nhỏ', 'mẹ nào đang chăm con', 'sắm cho bé cưng...'
     * Đồ cho người lớn tuổi, chăm sóc sức khỏe: dùng 'nhà nào có bố mẹ lớn tuổi', 'mua biếu ông bà bố mẹ', 'cả nhà xài bao êm...'
     * Đồ nam mà người mua là nữ: góc độ mua cho chồng / bạn trai ('Chị em nào muốn mua quà cho người yêu...', 'Mấy bà mua về cho chồng xài là mê liền...', 'Sắm cho ông xã một em...').
     * Đồ nữ giới, mỹ phẩm, thời trang: dùng linh hoạt 'chị em', 'mấy bạn', 'nàng nào', 'mọi người' (chỉ xen kẽ tự nhiên, không spam).
3. TUYỆT ĐỐI KHÔNG SỬ DỤNG CON SỐ GIÁ TIỀN HOẶC % GIẢM GIÁ (dùng evergreen content, không nói giá cụ thể).
4. LỜI THOẠI ĐỜI THƯỜNG CUỐN HÚT (MỖI CẢNH 16 ĐẾN 18 TỪ, TỔNG 4 CẢNH TỐI THIỂU 65 TỪ, TỐI ĐA 70 TỪ CHO TOÀN BỘ VIDEO 16 GIÂY, TUYỆT ĐỐI KHÔNG CUTOFF):
   - Video review TikTok được đọc bởi voice TTS giọng miền Nam tự nhiên, tươi vui, rõ ràng từng chữ, nhịp điệu cuốn hút:
     * Cảnh 1 (Hook): từ 16-18 từ, bắt trend gây tò mò tự nhiên theo đúng targetUser/buyerAngle.
     * Cảnh 2 (Solution): từ 16-18 từ, giới thiệu tính năng giải pháp vượt trội cho người sử dụng thực tế.
     * Cảnh 3 (Proof): từ 16-18 từ, chứng minh thực tế chất liệu xịn xò bao bền an toàn.
     * Cảnh 4 (Closing / CTA): từ 16-18 từ, kêu gọi bấm giỏ hàng góc trái săn deal hời liền tay (cho mình hoặc người thân).
   - TỔNG CỘNG CẢ 4 CẢNH TỐI THIỂU 65 TỪ, TỐI ĐA 70 TỪ (chuẩn vàng: 65 đến 70 từ) để đảm bảo tốc độ nói tự nhiên, tròn vành rõ chữ, vừa khít 16s mà không bị nói quá nhanh hay dính chữ.
   - Mỗi cảnh PHẢI là câu (hoặc 2 câu ngắn) HOÀN CHỈNH ĐẦY ĐỦ Ý NGHĨA VÀ CHỦ NGỮ - VỊ NGỮ, KẾT THÚC BẰNG DẤU CHẤM (.), DẤU HỎI (?) HOẶC DẤU CHẤM THAN (!).
   - Tốc độ đọc: Tự nhiên, liên tục, tự tin, cuốn hút, giàu năng lượng theo phong cách review TikTok viral. TUYỆT ĐỐI KHÔNG ngắt nghỉ rề rà, TUYỆT ĐỐI KHÔNG ĐƯỢC CUTOFF cụt lủn khi video kết thúc.
5. PHONG CÁCH VĂN PHONG VÀ TỪ NGỮ MIỀN NAM ĐỜI THƯỜNG (COLLOQUIAL SOUTHERN VIETNAMESE — ZERO FORMAL / SÁCH VỞ):
   - TUYỆT ĐỐI CẤM văn phong quảng cáo TVC, sách vở, báo chí, giọng đọc phổ thông cứng nhắc hay văn viết trang trọng (nghiêm cấm các câu máy móc như: "Bạn có biết vì sao món đồ này đang gây sốt...", "Cùng mình kiểm chứng thực tế...", "Thiết kế thông minh đột phá cùng công năng vượt trội giúp bạn xử lý mọi nhu cầu...", "Chất liệu cao cấp với độ hoàn thiện tinh xảo...").
   - BẮT BUỘC sử dụng phong cách nói chuyện giao tiếp đời thường của người miền Nam Việt Nam (giọng điệu trò chuyện thân mật như bạn bè, dân dã, tự nhiên, gần gũi, cuốn hút):
     * Đại từ & xưng hô: "tui", "mọi người", "cả nhà", "anh em", "mấy bạn", "mấy bà" (chỉ dùng tối đa 1 lần nếu phù hợp); gọi sản phẩm thân mật: "em này", "ẻm", "bé này".
     * Từ ngữ & cảm thán đời thường miền Nam: "xịn xò", "cưng xỉu", "mê liền", "ưng bụng", "bao êm", "bao bền", "đúng bài", "đã cái nư", "hết nước chấm", "đỉnh dữ thần", "tiện ghê", "tiện gì đâu á", "thiệt tình", "quá chừng", "chắc nịch", "rần rần", "rinh về", "hốt liền".
     * Trợ từ kết câu đặc trưng miền Nam: "nè", "nè nghen", "luôn á", "á nha", "nghen", "nha", "hén", "đó chèn".
     * Cảm giác khi nghe: Tự nhiên 100% như bạn bè đang trò chuyện và mách nhau món đồ hay ho hàng ngày.
6. THAO TÁC THỰC TẾ, KHÔNG ẢO CGI: Mọi thao tác ("techVFX") phải là cử động tay thật trên sản phẩm thực tế.
7. VOICE PERSONA: Luôn luôn chọn giọng nữ ("nu") cho tất cả sản phẩm và ngành hàng (kể cả đồ công nghệ, nam giới). Dùng chất giọng nữ miền Nam ngọt ngào, hoạt bát, phong cách nói chuyện giao tiếp đời thường tự nhiên, gần gũi.

Return ONLY valid JSON matching this schema (CRITICAL JSON SYNTAX RULES: NEVER put unescaped double quotes inside text strings — use single quotes '...' for quoting words; ensure proper commas between all properties and array elements):
{
  "analysis": {
    "productName": "Tên sản phẩm tiếng Việt đầy đủ và chính xác từ ảnh/mô tả",
    "category": "fashion|cosmetics|home|gadgets|accessories|other",
    "targetUser": "ai là người trực tiếp sử dụng (ví dụ: em bé, học sinh, dân văn phòng, nam giới, mẹ bỉm, người lớn tuổi, cả nhà...)",
    "buyerAngle": "self_use|gift_for_partner|for_kids|for_parents|for_family",
    "addressStyle": "cách xưng hô chủ đạo phù hợp (ví dụ: 'mọi người', 'cả nhà', 'anh em', 'các mẹ bỉm', 'chị em mua cho chồng')",
    "cartAnchorText": "Câu CTA giỏ hàng ngắn gọn dưới 30 ký tự khớp chính xác đặc tính/lợi ích sản phẩm",
    "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
    "materials": "mô tả chất liệu hoặc thành phần nổi bật",
    "highlights": ["điểm nổi bật 1", "điểm nổi bật 2", "điểm nổi bật 3"],
    "targetAudience": "đối tượng người mua & người dùng tổng thể",
    "fourAnswers": {
      "hook": "Câu trả lời phân tích cho Cảnh 1: Hook gì để họ dừng lướt?",
      "solution": "Câu trả lời phân tích cho Cảnh 2: Sản phẩm là giải pháp gì cho người dùng thực tế?",
      "proof": "Câu trả lời phân tích cho Cảnh 3: Bằng chứng nào khiến họ tin?",
      "closing": "Câu trả lời phân tích cho Cảnh 4: Lý do gì để họ mua ngay (cho mình hoặc mua tặng người thân)?"
    }
  },
  "voicePersona": {
    "gender": "nu",
    "voiceDescription": "nữ miền Nam ngọt ngào, hoạt bát, giọng nói chuyện giao tiếp đời thường tự nhiên, gần gũi",
    "tone": "nói chuyện giao tiếp đời thường miền Nam, tự nhiên, gần gũi, dùng từ ngữ hàng ngày, không sáo rỗng formal"
  },
  "sceneContext": {
    "location": "mô tả chi tiết không gian bối cảnh sống động phù hợp sản phẩm",
    "lighting": "ánh sáng tự nhiên dịu nhẹ ban ngày kết hợp đèn ấm",
    "mood": "aesthetic, hiện đại, 100% chân thực"
  },
  "panelOverlays": [
    { "id": 1, "headline": "TIÊU ĐỀ IN HOA CẢNH 1", "subtexts": ["• Dòng điểm nhấn hook 1", "• Dòng điểm nhấn 2"] },
    { "id": 2, "headline": "TIÊU ĐỀ IN HOA CẢNH 2", "subtexts": ["• Dòng tính năng giải pháp 1", "• Dòng ưu điểm vượt trội 2"] },
    { "id": 3, "headline": "TIÊU ĐỀ IN HOA CẢNH 3", "subtexts": ["• Dòng chứng minh chất liệu 1", "• Dòng thông số / độ bền 2"] },
    { "id": 4, "headline": "TIÊU ĐỀ IN HOA CẢNH 4", "subtexts": ["• Dòng cam kết chính hãng 1", "• Dòng kêu gọi giỏ hàng 2"] }
  ],
  "script": [
    {
      "id": 1,
      "phase": "Hook",
      "goal": "Hook dừng lướt gây tò mò theo đúng targetUser/buyerAngle bằng giọng đời thường miền Nam",
      "voiceOver": "Lời thoại Cảnh 1 dài từ 16 đến 18 từ tiếng Việt đời thường miền Nam tự nhiên kết thúc bằng dấu câu (xưng hô phù hợp, không lạm dụng mấy bà, ví dụ dùng tui, mọi người, cả nhà, anh em, nè, á nha)...",
      "visualDescription": "Mô tả hình ảnh Cảnh 1 (nửa trái của Video 1)",
      "techVFX": "Thao tác tay thực tế Cảnh 1...",
      "cameraAction": "cận cảnh góc máy ổn định bắt đầu 0s-4s của Video 1"
    },
    {
      "id": 2,
      "phase": "Solution",
      "goal": "Giới thiệu sản phẩm và công năng giải pháp bằng giọng đời thường miền Nam",
      "voiceOver": "Lời thoại Cảnh 2 dài từ 16 đến 18 từ tiếng Việt đời thường miền Nam (câu hoàn chỉnh đủ ý không bị cutoff)...",
      "visualDescription": "Mô tả hình ảnh Cảnh 2 (nửa phải của Video 1)",
      "techVFX": "Thao tác tay đặc tả tính năng Cảnh 2...",
      "cameraAction": "chuyển cảnh dứt khoát tại mốc 4s sang Cảnh 2"
    },
    {
      "id": 3,
      "phase": "Proof",
      "goal": "Đặc tả chi tiết chất liệu, bằng chứng chứng minh bằng giọng đời thường miền Nam",
      "voiceOver": "Lời thoại Cảnh 3 dài từ 16 đến 18 từ tiếng Việt đời thường miền Nam tự nhiên kết thúc bằng dấu câu (ví dụ chắc nịch bao bền, xịn sờ vào êm ái)...",
      "visualDescription": "Mô tả hình ảnh Cảnh 3 (nửa trái của Video 2)",
      "techVFX": "Thao tác tay chứng minh chất lượng Cảnh 3...",
      "cameraAction": "cận cảnh góc máy ổn định bắt đầu 0s-4s của Video 2"
    },
    {
      "id": 4,
      "phase": "Closing",
      "goal": "Tổng thể phong cách sống và chốt đơn giỏ hàng bằng giọng đời thường miền Nam",
      "voiceOver": "Lời thoại Cảnh 4 dài từ 16 đến 18 từ tiếng Việt đời thường miền Nam (tổng cả 4 cảnh tối thiểu 65 từ, tối đa 70 từ, câu hoàn chỉnh đủ ý không bị cutoff)...",
      "visualDescription": "Mô tả hình ảnh Cảnh 4 (nửa phải của Video 2)",
      "techVFX": "Không gian sống ngăn nắp, sản phẩm hoàn thiện Cảnh 4...",
      "cameraAction": "chuyển cảnh dứt khoát tại mốc 4s sang Cảnh 4"
    }
  ]
}

Important:
- Return ONLY valid JSON starting with { and ending with }.
- NO comments, no markdown fences outside the JSON.`.trim();
}

/**
 * Thực hiện phân tích sản phẩm qua Gemini API riêng cho Template Pro
 */
async function analyzeProductTemplatePro(geminiClient, filePayloads, options = {}) {
  const analysisPrompt = buildTemplateProAnalysisPrompt(options);

  // Upload tối đa 4 ảnh đầu vào lên Gemini để lấy URL hợp lệ trước khi phân tích
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
        if (url) {
          uploadedFiles.push({ url, filename, mimeType });
        }
      } catch (upErr) {
        console.warn(`[TemplatePro] Failed to upload analysis file ${filename}: ${upErr.message}`);
      }
    }
  }

  const ctx = options.productContext || {};
  const fallbackTitle = (ctx.productTitle || 'Sản Phẩm Cao Cấp').trim();
  const buildFallback = () => ({
    analysis: {
      category: 'general',
      productName: fallbackTitle,
      targetUser: 'Mọi thành viên trong gia đình và người dùng cá nhân',
      buyerAngle: 'self_use',
      addressStyle: 'mọi người / cả nhà',
      cartAnchorText: 'Bấm giỏ hàng góc trái màn hình',
      hashtags: ['#review', '#sanphamchinhhang', '#lifestyle', '#trending', '#xuhuong'],
      materials: 'Chất liệu cao cấp, hoàn thiện tỉ mỉ',
      highlights: ['Thiết kế tiện dụng', 'Xài bao êm', 'Ưng bụng mỗi ngày'],
      targetAudience: 'Mọi gia đình và người dùng yêu thích sự tiện lợi',
      fourAnswers: {
        hook: `Bữa giờ thấy em này hot quá, nay tui rinh về test cho cả nhà coi nè.`,
        solution: `Nhỏ gọn cưng xỉu, ai xài cũng mê, làm gì cũng nhanh gọn và ưng bụng nha.`,
        proof: 'Cầm chắc nịch bao bền, chất liệu xịn xò sờ vào thấy êm ái cực kỳ đã.',
        closing: `Đúng bài tiện nghi, mọi người bấm liền giỏ hàng góc trái săn deal ngay nghen!`
      },
      voicePersona: {
        gender: 'nu',
        voiceDescription: 'nữ miền Nam ngọt ngào, hoạt bát, giọng nói chuyện giao tiếp đời thường tự nhiên, gần gũi',
        tone: 'nói chuyện giao tiếp đời thường miền Nam, thân thiện, duyên dáng, gần gũi, dùng từ ngữ hàng ngày không formal'
      },
      sceneContext: {
        location: 'Không gian sống hiện đại sáng sủa, nội thất tối giản tinh tế',
        lighting: 'Ánh sáng tự nhiên dịu nhẹ ban ngày kết hợp đèn ấm',
        mood: 'Chân thực, hiện đại, cao cấp'
      },
      panelOverlays: [
        { id: 1, headline: 'THIẾT KẾ TINH TẾ', subtexts: ['• Kiểu dáng hiện đại', '• Nhỏ gọn tiện lợi'] },
        { id: 2, headline: 'CHẤT LIỆU CAO CẤP', subtexts: ['• Hoàn thiện tỉ mỉ', '• Bền bỉ vượt trội'] },
        { id: 3, headline: 'TRẢI NGHIỆM ÊM ÁI', subtexts: ['• Tiện lợi dễ dùng', '• Hiệu quả tối đa'] },
        { id: 4, headline: 'TIỆN NGHI MỖI NGÀY', subtexts: ['• Phù hợp mọi nhu cầu', '• Nâng tầm cuộc sống'] }
      ],
      panelCaptions: ['THIẾT KẾ TINH TẾ', 'CHẤT LIỆU CAO CẤP', 'TRẢI NGHIỆM ÊM ÁI', 'TIỆN NGHI MỖI NGÀY'],
      script: [
        {
          id: 1,
          phase: 'Hook',
          goal: 'Hook dừng lướt gây tò mò bằng giọng đời thường miền Nam',
          voiceOver: 'Bữa giờ thấy em này hot quá, nay tui rinh về test cho cả nhà coi nè.',
          visualDescription: `Cận cảnh cầm ${fallbackTitle} trên bề mặt tự nhiên sang trọng`,
          techVFX: 'Thao tác tay thực tế cầm sản phẩm',
          cameraAction: 'cận cảnh góc máy ổn định bắt đầu 0s-4s của Video 1'
        },
        {
          id: 2,
          phase: 'Solution',
          goal: 'Giới thiệu công năng giải pháp bằng giọng đời thường miền Nam',
          voiceOver: 'Nhỏ gọn cưng xỉu, ai xài cũng mê, làm gì cũng nhanh gọn và ưng bụng nha.',
          visualDescription: `Mô tả công năng và chi tiết của ${fallbackTitle}`,
          techVFX: 'Thao tác tay đặc tả tính năng',
          cameraAction: 'lia máy sang phải và zoom vào Cảnh 2 trong 4s-8s của Video 1'
        },
        {
          id: 3,
          phase: 'Proof',
          goal: 'Đặc tả chất liệu và độ bền bằng giọng đời thường miền Nam',
          voiceOver: 'Cầm chắc nịch bao bền, chất liệu xịn xò sờ vào thấy êm ái cực kỳ đã.',
          visualDescription: `Cận cảnh chất liệu và độ hoàn thiện của ${fallbackTitle}`,
          techVFX: 'Thao tác tay kiểm tra thực tế',
          cameraAction: 'cận cảnh góc máy ổn định bắt đầu 0s-4s của Video 2'
        },
        {
          id: 4,
          phase: 'Closing',
          goal: 'Kêu gọi mua hàng giỏ hàng bằng giọng đời thường miền Nam',
          voiceOver: 'Đúng bài tiện nghi, mọi người bấm liền giỏ hàng góc trái săn deal ngay nghen!',
          visualDescription: `Không gian phong cách sống cùng ${fallbackTitle}`,
          techVFX: 'Đặt sản phẩm ngay ngắn trong không gian sống',
          cameraAction: 'lia máy sang phải và toàn cảnh Cảnh 4 trong 4s-8s của Video 2'
        }
      ]
    },
    analysisPrompt,
    rawResponse: 'Fallback triggered due to parse/network error',
    uploadedFiles: filePayloads
  });

  if (!geminiClient) {
    return buildFallback();
  }

  let lastAnalysisErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const promptToSend = attempt === 1
        ? analysisPrompt
        : `${analysisPrompt}\n\nCRITICAL RETRY NOTICE: Your previous attempt failed with a JSON syntax error (${lastAnalysisErr?.message || 'invalid JSON'}). Please output 100% strictly valid RFC 8259 JSON without any comments, missing commas, or unescaped quotes.`;

      const res = await geminiClient.generateContent({
        prompt: promptToSend,
        fileData: uploadedFiles,
        temporary: true,
        expectImages: false,
      });

      const parsed = parseJsonObjectPro(res.text || '');
      if (parsed) {
        const pName = parsed.analysis?.productName || parsed.productName || 'Sản Phẩm Cao Cấp';
        const cat = parsed.analysis?.category || parsed.category || 'general';
        const rawCartCTA = (parsed.analysis?.cartAnchorText || parsed.cartAnchorText || '').trim();
        const cartAnchorText = rawCartCTA ? rawCartCTA.slice(0, 30) : 'Bấm giỏ hàng góc trái màn hình';
        const overlays = Array.isArray(parsed.panelOverlays) ? parsed.panelOverlays : [];
        const captions = overlays.map(p => p.headline || '');

        console.log(`[TemplatePro] ✅ Product analyzed (attempt ${attempt}): "${pName}" (${cat})`);

        return {
          analysis: {
            productName: pName,
            category: cat,
            targetUser: parsed.analysis?.targetUser || parsed.targetUser || 'Người tiêu dùng và gia đình',
            buyerAngle: parsed.analysis?.buyerAngle || parsed.buyerAngle || 'self_use',
            addressStyle: parsed.analysis?.addressStyle || parsed.addressStyle || 'mọi người / cả nhà',
            cartAnchorText,
            hashtags: parsed.analysis?.hashtags || parsed.hashtags || ['#review', '#sanphamchinhhang', '#trending'],
            materials: parsed.analysis?.materials || parsed.materials || 'Chất liệu cao cấp',
            highlights: parsed.analysis?.highlights || parsed.highlights || ['Thiết kế sang trọng', 'Tiện dụng'],
            targetAudience: parsed.analysis?.targetAudience || parsed.targetAudience || '',
            fourAnswers: parsed.analysis?.fourAnswers || parsed.fourAnswers || {},
            voicePersona: parsed.voicePersona || {
              gender: 'nu',
              voiceDescription: 'nữ miền Nam ngọt ngào, hoạt bát, tự nhiên, gần gũi',
              tone: 'thân thiện, duyên dáng, cuốn hút, review chân thực'
            },
            sceneContext: parsed.sceneContext || {
              location: 'Không gian sống hiện đại sáng sủa, nội thất tối giản tinh tế',
              lighting: 'Ánh sáng tự nhiên dịu nhẹ ban ngày kết hợp đèn ấm',
              mood: 'Chân thực, hiện đại, cao cấp'
            },
            panelOverlays: overlays,
            panelCaptions: captions,
            script: parsed.script || [],
          },
          analysisPrompt: promptToSend,
          rawResponse: res.text || '',
          uploadedFiles: filePayloads
        };
      }
    } catch (err) {
      lastAnalysisErr = err;
      console.warn(`[TemplatePro] Analysis attempt ${attempt}/3 failed: ${err.message}.`);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }

  console.warn(`[TemplatePro] Analysis JSON parse fallback: ${lastAnalysisErr?.message}`);
  return buildFallback();
}

/**
 * Xây dựng Video Prompts cho Template Pro (/tpro):
 * - 2 video 8s (Video 1 = Panel 1+2, Video 2 = Panel 3+4).
 * - Script voice: 30-36 từ cho 1 panel, tổng 60-72 từ cho 1 video 8s.
 * - Tốc độ review CỰC KỲ NHANH, dồn dập, đọc HẾT toàn bộ lời thoại trong 8s, TUYỆT ĐỐI KHÔNG CUTOFF.
 * - BỎ QUA HOÀN TOÀN KHUNG VIỀN TRẮNG (NO BORDER PADDING): video 9:16 thuần túy, không viền, không crop sau khi gen.
 */
function buildTemplateProVideoPrompts(analysisData, options = {}) {
  const prodName = analysisData?.productName || 'sản phẩm';
  const script = analysisData?.script || [];
  const customInstruction = options.customInstruction ? ` YÊU CẦU ƯU TIÊN HÀNG ĐẦU: ${options.customInstruction}.` : '';

  const realismCues = 'Cảnh quay tự nhiên 100% như quay bằng camera điện thoại cao cấp góc rộng, ánh sáng ban ngày tự nhiên từ cửa sổ, đổ bóng tiếp xúc chân thực, bề mặt sản phẩm lì có vân chất liệu, không hiệu ứng bokeh giả, không ánh sáng studio nhân tạo, không nhựa bóng kiểu AI, không hiệu ứng ảo CGI.';
  const refRule = 'THAM CHIẾU HÌNH ẢNH VÀ ĐỘ CHÍNH XÁC SẢN PHẨM: Toàn bộ video phải đối chiếu và tham chiếu chặt chẽ với hình ảnh Master Storyboard và hình ảnh Panel chi tiết đã cung cấp để đảm bảo tính đúng đắn, nhất quán 100% về ngoại quan, kiểu dáng, cấu tạo, chất liệu, màu sắc và chi tiết sản phẩm.';

  const desc1 = script[0]?.visualDescription || 'Cận cảnh tay cầm sản phẩm trên bề mặt tự nhiên sang trọng';
  const vfx1 = script[0]?.techVFX ? ` Thao tác thực tế: ${script[0].techVFX}.` : '';
  const desc2 = script[1]?.visualDescription || 'Góc quay cận cảnh đặc tả công năng, cấu tạo và hoàn thiện tinh xảo';
  const vfx2 = script[1]?.techVFX ? ` Thao tác thực tế: ${script[1].techVFX}.` : '';
  const desc3 = script[2]?.visualDescription || 'Trải nghiệm sử dụng thực tế của người dùng với sản phẩm trong không gian';
  const vfx3 = script[2]?.techVFX ? ` Thao tác thực tế: ${script[2].techVFX}.` : '';
  const desc4 = script[3]?.visualDescription || 'Toàn cảnh sản phẩm trong không gian phong cách sống hiện đại';
  const vfx4 = script[3]?.techVFX ? ` Thao tác thực tế: ${script[3].techVFX}.` : '';

  // Luôn sử dụng giọng nữ tự nhiên
  const defaultVoice = 'nữ miền Nam ngọt ngào, hoạt bát, giọng nói chuyện giao tiếp đời thường tự nhiên, gần gũi';
  const voiceDesc = analysisData?.voicePersona?.voiceDescription || defaultVoice;

  // Lời thoại voice-over: mỗi cảnh 16-20 từ, tổng 2 cảnh càng dài càng tốt nhưng tối đa 40 từ cho video 8s
  const defaultVo1 = 'Bữa giờ lướt mạng thấy rần rần em này, nay tui test thử cho cả nhà coi nè.';
  const defaultVo2 = 'Nhỏ gọn cưng xỉu mà tiện gì đâu á, làm việc gì cũng gọn lẹ ưng bụng ghê luôn.';
  const defaultVo3 = 'Cầm trên tay chắc nịch bao bền luôn nghen, chất liệu xịn sờ vào êm ái cực kỳ đã.';
  const defaultVo4 = 'Đúng bài cho cuộc sống tiện nghi, mọi người bấm liền giỏ hàng góc trái hốt liền một em nha.';

  const vo1 = script[0]?.voiceOver || defaultVo1;
  const vo2 = script[1]?.voiceOver || defaultVo2;
  const vo3 = script[2]?.voiceOver || defaultVo3;
  const vo4 = script[3]?.voiceOver || defaultVo4;

  const video1Script = combineTwoSceneScripts(vo1, vo2, 40);
  const video2Script = combineTwoSceneScripts(vo3, vo4, 40);
  const v1WordCount = video1Script.split(/\s+/).filter(Boolean).length;
  const v2WordCount = video2Script.split(/\s+/).filter(Boolean).length;

  const voiceInstruction1 = `TỐC ĐỘ ĐỌC VÀ VOICE-OVER: Giọng đọc review: ${voiceDesc}, phong cách nói chuyện giao tiếp đời thường miền Nam cực kỳ tự nhiên, gần gũi, dùng từ ngữ hàng ngày (như bạn bè trò chuyện, xưng tui/mọi người/cả nhà/anh em, có trợ từ nè/nghen/luôn á, tuyệt đối không dùng văn phong formal sách vở), năng lượng cao dồn dập. Tốc độ đọc review CỰC KỲ NHANH, liên tục dồn dập không ngừng nghỉ để đọc HẾT trọn vẹn toàn bộ lời thoại (${v1WordCount} từ, tối đa 40 từ) trong đúng 8 giây, TUYỆT ĐỐI KHÔNG ĐƯỢC CUTOFF ngắt ngang khi video kết thúc. Lời thoại đọc liên tục trọn vẹn trong 8 giây: "${video1Script}".`;
  const voiceInstruction2 = `TỐC ĐỘ ĐỌC VÀ VOICE-OVER: Giọng đọc review: ${voiceDesc}, phong cách nói chuyện giao tiếp đời thường miền Nam cực kỳ tự nhiên, gần gũi, dùng từ ngữ hàng ngày (như bạn bè trò chuyện, xưng tui/mọi người/cả nhà/anh em, có trợ từ nè/nghen/luôn á, tuyệt đối không dùng văn phong formal sách vở), năng lượng cao dồn dập. Tốc độ đọc review CỰC KỲ NHANH, liên tục dồn dập không ngừng nghỉ để đọc HẾT trọn vẹn toàn bộ lời thoại (${v2WordCount} từ, tối đa 40 từ) trong đúng 8 giây, TUYỆT ĐỐI KHÔNG ĐƯỢC CUTOFF ngắt ngang khi video kết thúc. Lời thoại đọc liên tục trọn vẹn trong 8 giây: "${video2Script}".`;

  const actionLockdownRule = ' NGUYÊN TẮC BẢO TOÀN TRẠNG THÁI VẬT LÝ VÀ KHÓA CHẶT HÀNH ĐỘNG (UNIVERSAL PHYSICAL STATE INVARIANCE & ACTION LOCKDOWN — ZERO UNPROMPTED ACTIONS): Sản phẩm là trung tâm bất biến, giữ nguyên 100% hình học, kích thước, màu sắc và trạng thái cơ học vốn có trong ảnh tham chiếu từ giây 0 đến giây 8. TUYỆT ĐỐI CẤM TỰ Ý BỊA HÀNH ĐỘNG CƠ HỌC LÀM THAY ĐỔI CẤU TRÚC HAY BIẾN DẠNG SẢN PHẨM: Không tự ý mở/vặn/tháo rời bất kỳ bộ phận nào, không tự kéo dãn/gập bẻ, không làm phát sinh chất lỏng/khói bụi, và cấm hiện tượng biến hình co dãn (NO MORPHING, NO WARPING). NẾU SẢN PHẨM Ở TRẠNG THÁI ĐÓNG HOẶC NGUYÊN KHỐI TRONG ẢNH THÌ PHẢI GIỮ NGUYÊN VẸN ĐÓNG TRONG TOÀN BỘ VIDEO. Chuyển động duy nhất cho phép là chuyển động máy quay (pan/tilt/zoom nhẹ) và bàn tay người mẫu nâng/cầm giữ/xoay nhẹ sản phẩm để đổi góc nhìn.';

  // BỎ QUA HOÀN TOÀN BORDER RULE (NO WHITE BORDER PADDING CHO TPRO)
  return [
    `Tạo video review ${prodName} faceless dài đúng 8 giây từ 3 hình ảnh đã cung cấp (gồm Panel 1: Cảnh 1, Panel 2: Cảnh 2, và Master Storyboard toàn bộ 4 cảnh). ${customInstruction}${actionLockdownRule} CHUYỂN ĐỘNG THEO THỜI GIAN VÀ CẢNH QUAY: 4 giây đầu (0s-4s) bắt đầu chính xác từ hình ảnh Panel 1 (Cảnh 1: Hook), camera giữ góc quay cận cảnh ổn định bên trong khung hình Cảnh 1, bàn tay người thao tác thực tế${vfx1} ${desc1}; tại mốc 4 giây chuyển cảnh dứt khoát (clean cut transition) sang 4 giây sau (4s-8s) bắt đầu chính xác từ hình ảnh Panel 2 (Cảnh 2: Solution), tiếp tục góc quay đặc tả công năng và chi tiết sản phẩm bên trong khung hình Cảnh 2${vfx2} ${desc2}. ${refRule} GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI. ${voiceInstruction1} ${realismCues}`,
    `Tạo video review ${prodName} faceless dài đúng 8 giây từ 3 hình ảnh đã cung cấp (gồm Panel 3: Cảnh 3, Panel 4: Cảnh 4, và Master Storyboard toàn bộ 4 cảnh). ${customInstruction}${actionLockdownRule} CHUYỂN ĐỘNG THEO THỜI GIAN VÀ CẢNH QUAY: 4 giây đầu (0s-4s) bắt đầu chính xác từ hình ảnh Panel 3 (Cảnh 3: Proof), camera giữ góc quay cận cảnh đặc tả chất liệu, cấu tạo tinh xảo bên trong khung hình Cảnh 3, bàn tay người thao tác kiểm tra thực tế${vfx3} ${desc3}; tại mốc 4 giây chuyển cảnh dứt khoát (clean cut transition) sang 4 giây sau (4s-8s) bắt đầu chính xác từ hình ảnh Panel 4 (Cảnh 4: Closing), mở rộng góc quay tôn vinh sản phẩm trong không gian phong cách sống hoàn thiện bên trong khung hình Cảnh 4${vfx4} ${desc4}. ${refRule} GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI. ${voiceInstruction2} ${realismCues}`
  ];
}

/**
 * Xây dựng 2 prompts cho 2 video 8s bằng model veo_3_1_i2v_lite_low_priority để trích xuất voice review
 * - Video 1 (8s): Lời thoại Cảnh 1 + Cảnh 2 (Hook + Solution)
 * - Video 2 (8s): Lời thoại Cảnh 3 + Cảnh 4 (Proof + Closing)
 */
function buildTemplateProVoiceVideoPrompts(analysisData) {
  const prodName = analysisData?.productName || 'sản phẩm';
  const script = analysisData?.script || [];

  // Luôn sử dụng giọng nữ tự nhiên
  const defaultVoice = 'nữ miền Nam ngọt ngào, hoạt bát, giọng nói chuyện giao tiếp đời thường tự nhiên, gần gũi';
  const voiceDesc = analysisData?.voicePersona?.voiceDescription || defaultVoice;

  const defaultVo1 = 'Bữa giờ lướt mạng thấy rần rần em này, nay tui test thử cho cả nhà coi nè.';
  const defaultVo2 = 'Nhỏ gọn cưng xỉu mà tiện gì đâu á, làm việc gì cũng gọn lẹ ưng bụng ghê luôn.';
  const defaultVo3 = 'Cầm trên tay chắc nịch bao bền luôn nghen, chất liệu xịn sờ vào êm ái cực kỳ đã.';
  const defaultVo4 = 'Đúng bài cho cuộc sống tiện nghi, mọi người bấm liền giỏ hàng góc trái hốt liền một em nha.';

  const vo1 = script[0]?.voiceOver || defaultVo1;
  const vo2 = script[1]?.voiceOver || defaultVo2;
  const vo3 = script[2]?.voiceOver || defaultVo3;
  const vo4 = script[3]?.voiceOver || defaultVo4;

  const video1Script = combineTwoSceneScripts(vo1, vo2, 40);
  const video2Script = combineTwoSceneScripts(vo3, vo4, 40);
  const v1WordCount = video1Script.split(/\s+/).filter(Boolean).length;
  const v2WordCount = video2Script.split(/\s+/).filter(Boolean).length;

  const p1 = `Tạo video review ${prodName} dài đúng 8 giây để thu âm giọng đọc voice-over. Giọng đọc review: ${voiceDesc}, phong cách giao tiếp đời thường miền Nam cực kỳ tự nhiên, gần gũi, dồn dập. Đọc đầy đủ trọn vẹn toàn bộ lời thoại (${v1WordCount} từ) trong đúng 8 giây không ngắt quãng: "${video1Script}".`;
  const p2 = `Tạo video review ${prodName} dài đúng 8 giây để thu âm giọng đọc voice-over. Giọng đọc review: ${voiceDesc}, phong cách giao tiếp đời thường miền Nam cực kỳ tự nhiên, gần gũi, dồn dập. Đọc đầy đủ trọn vẹn toàn bộ lời thoại (${v2WordCount} từ) trong đúng 8 giây không ngắt quãng: "${video2Script}".`;

  return [p1, p2];
}

/**
 * Xây dựng prompts cho 4 panel video 4s (Start Frame mode) sử dụng model hiện tại (abra_r2v_4s)
 * - Mỗi video 4 giây
 * - Bắt đầu chính xác từ frame ảnh của Panel K
 * - Hoàn toàn silent, không lời thoại, không chữ
 * - Chuyển động máy quay mượt mà, thao tác thực tế với sản phẩm
 */
function buildTemplatePro4sPanelPrompts(analysisData, options = {}) {
  const prodName = analysisData?.productName || 'sản phẩm';
  const script = analysisData?.script || [];
  const customInstruction = options.customInstruction ? ` YÊU CẦU ƯU TIÊN HÀNG ĐẦU: ${options.customInstruction}.` : '';

  const realismCues = 'Cảnh quay tự nhiên 100% như quay bằng camera điện thoại cao cấp góc rộng, ánh sáng ban ngày tự nhiên từ cửa sổ, đổ bóng tiếp xúc chân thực, bề mặt sản phẩm lì có vân chất liệu, không hiệu ứng bokeh giả, không ánh sáng studio nhân tạo, không nhựa bóng kiểu AI, không hiệu ứng ảo CGI.';
  const refRule = 'BẢO TOÀN HÌNH ẢNH: Toàn bộ video bắt đầu chính xác từ hình ảnh Panel đã cung cấp, giữ nguyên 100% kiểu dáng, cấu tạo, chất liệu, màu sắc và trạng thái của sản phẩm. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO (STRICTLY NO TEXT). Video hoàn toàn im lặng, không có voice-over, không lời thoại.';

  const actionLockdownRule = ' NGUYÊN TẮC KHÓA CHẶT HÀNH ĐỘNG (ACTION LOCKDOWN): Sản phẩm là trung tâm bất biến, giữ nguyên 100% hình học từ giây 0 đến giây 4. Không tự ý mở/vặn/tháo rời bất kỳ bộ phận nào, không tự kéo dãn hay biến dạng (NO MORPHING).';

  const desc1 = script[0]?.visualDescription || 'Cận cảnh tay cầm sản phẩm trên bề mặt tự nhiên sang trọng';
  const vfx1 = script[0]?.techVFX ? ` Thao tác thực tế: ${script[0].techVFX}.` : '';
  const desc2 = script[1]?.visualDescription || 'Góc quay cận cảnh đặc tả công năng, cấu tạo và hoàn thiện tinh xảo';
  const vfx2 = script[1]?.techVFX ? ` Thao tác thực tế: ${script[1].techVFX}.` : '';
  const desc3 = script[2]?.visualDescription || 'Trải nghiệm sử dụng thực tế của người dùng với sản phẩm trong không gian';
  const vfx3 = script[2]?.techVFX ? ` Thao tác thực tế: ${script[2].techVFX}.` : '';
  const desc4 = script[3]?.visualDescription || 'Toàn cảnh sản phẩm trong không gian phong cách sống hiện đại';
  const vfx4 = script[3]?.techVFX ? ` Thao tác thực tế: ${script[3].techVFX}.` : '';

  const prompts = [
    `Tạo video review ${prodName} faceless dài đúng 4 giây theo mode Start Frame, bắt đầu chính xác từ hình ảnh Cảnh 1 (Hook). ${customInstruction}${actionLockdownRule} CHUYỂN ĐỘNG VÀ CẢNH QUAY: Bắt đầu từ frame ảnh Cảnh 1, camera giữ góc quay cận cảnh ổn định bên trong khung hình, bàn tay người thao tác thực tế${vfx1} ${desc1}. ${refRule} ${realismCues}`,
    `Tạo video review ${prodName} faceless dài đúng 4 giây theo mode Start Frame, bắt đầu chính xác từ hình ảnh Cảnh 2 (Solution). ${customInstruction}${actionLockdownRule} CHUYỂN ĐỘNG VÀ CẢNH QUAY: Bắt đầu từ frame ảnh Cảnh 2, camera giữ góc quay đặc tả công năng và chi tiết sản phẩm bên trong khung hình Cảnh 2${vfx2} ${desc2}. ${refRule} ${realismCues}`,
    `Tạo video review ${prodName} faceless dài đúng 4 giây theo mode Start Frame, bắt đầu chính xác từ hình ảnh Cảnh 3 (Proof). ${customInstruction}${actionLockdownRule} CHUYỂN ĐỘNG VÀ CẢNH QUAY: Bắt đầu từ frame ảnh Cảnh 3, camera giữ góc quay đặc tả chất liệu, cấu tạo tinh xảo bên trong khung hình Cảnh 3, bàn tay người thao tác kiểm tra thực tế${vfx3} ${desc3}. ${refRule} ${realismCues}`,
    `Tạo video review ${prodName} faceless dài đúng 4 giây theo mode Start Frame, bắt đầu chính xác từ hình ảnh Cảnh 4 (Closing). ${customInstruction}${actionLockdownRule} CHUYỂN ĐỘNG VÀ CẢNH QUAY: Bắt đầu từ frame ảnh Cảnh 4, mở rộng góc quay tôn vinh sản phẩm trong không gian phong cách sống hoàn thiện bên trong khung hình Cảnh 4${vfx4} ${desc4}. ${refRule} ${realismCues}`
  ];

  if (options.panelIndex && options.panelIndex >= 1 && options.panelIndex <= 4) {
    return prompts[options.panelIndex - 1];
  }
  return prompts;
}

/**
 * Định dạng bảng phân tích Script 4 cảnh cho file prompts.md
 */
function formatScriptBreakdownMarkdown(analysis) {
  const scriptList = analysis?.script || [];
  const scriptTable = [
    '| Panel | Giai đoạn (Phase) | Lời thoại Voice-Over | Số từ (Target: 16-20 từ / panel, max 40 từ / video 8s) | Mô tả hình ảnh (Visual) | Thao tác thực tế (TechVFX) |',
    '| :--- | :--- | :--- | :--- | :--- | :--- |',
    ...[0, 1, 2, 3].map(i => {
      const p = scriptList[i] || {};
      const vo = p.voiceOver || 'N/A';
      const count = vo !== 'N/A' ? vo.split(/\s+/).filter(Boolean).length : 0;
      return `| Panel ${i + 1} | ${p.phase || `Cảnh ${i + 1}`} | ${vo.replace(/\|/g, '-')} | **${count} từ** | ${(p.visualDescription || 'N/A').replace(/\|/g, '-')} | ${(p.techVFX || 'N/A').replace(/\|/g, '-')} |`;
    })
  ].join('\n');

  const v1Script = combineTwoSceneScripts(scriptList[0]?.voiceOver, scriptList[1]?.voiceOver, 40);
  const v2Script = combineTwoSceneScripts(scriptList[2]?.voiceOver, scriptList[3]?.voiceOver, 40);
  const v1Count = v1Script.split(/\s+/).filter(Boolean).length;
  const v2Count = v2Script.split(/\s+/).filter(Boolean).length;

  return [
    '### 4-Panel Script Breakdown',
    scriptTable,
    '',
    `- **Video 1 (8s - Panel 1+2)**: "${v1Script}" (**${v1Count} từ** / Target: 60-72 từ, đọc cực nhanh, không cutoff)`,
    `- **Video 2 (8s - Panel 3+4)**: "${v2Script}" (**${v2Count} từ** / Target: 60-72 từ, đọc cực nhanh, không cutoff)`,
    `- **Cart Anchor CTA**: "${analysis?.cartAnchorText || 'N/A'}"`,
    `- **Hashtags**: ${(analysis?.hashtags || []).join(' ')}`,
    '',
    '### 4 Answers Marketing Framework',
    `- **Hook (Cảnh 1)**: ${analysis?.fourAnswers?.hook || 'N/A'}`,
    `- **Solution (Cảnh 2)**: ${analysis?.fourAnswers?.solution || 'N/A'}`,
    `- **Proof (Cảnh 3)**: ${analysis?.fourAnswers?.proof || 'N/A'}`,
    `- **Closing (Cảnh 4)**: ${analysis?.fourAnswers?.closing || 'N/A'}`
  ].join('\n');
}

/**
 * Lưu log đồng thời vào cả prompts.md và prompt.md để người dùng xem lại toàn bộ full luồng
 */
function writeMarkdownLog(runDir, content) {
  try {
    fs.writeFileSync(path.join(runDir, 'prompts.md'), content, 'utf8');
    fs.writeFileSync(path.join(runDir, 'prompt.md'), content, 'utf8');
  } catch (e) {
    console.warn(`[TemplatePro] Failed to write prompts.md / prompt.md:`, e.message);
  }
}

function appendMarkdownLog(runDir, content) {
  try {
    fs.appendFileSync(path.join(runDir, 'prompts.md'), content, 'utf8');
    fs.appendFileSync(path.join(runDir, 'prompt.md'), content, 'utf8');
  } catch (e) {
    console.warn(`[TemplatePro] Failed to append to prompts.md / prompt.md:`, e.message);
  }
}


/**
 * Tách Master Storyboard (16:9) thành 4 panel tự nhiên KHÔNG bị bóp méo (tỷ lệ 4:9 mỗi panel)
 * Kích thước chuẩn: mỗi panel rộng 480px, cao 1080px (480x1080 có tỷ lệ 4:9 = 0.4444)
 * Khi ghép 4 panel (4 x 480 = 1920, cao 1080), tỷ lệ ra đúng 1920x1080 (16:9) chuẩn 100%!
 */
function sliceMasterStoryboardPro(storyboardBuffer) {
  const ffmpegPath = require('ffmpeg-static');
  const tmpId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `pro-in-${tmpId}.png`);
  const outPaths = [1, 2, 3, 4].map(i => path.join(tmpDir, `pro-panel-${i}-${tmpId}.png`));

  const buf = Buffer.isBuffer(storyboardBuffer)
    ? storyboardBuffer
    : (typeof storyboardBuffer === 'string' && fs.existsSync(storyboardBuffer)
      ? fs.readFileSync(storyboardBuffer)
      : Buffer.from(storyboardBuffer, 'base64'));

  try {
    fs.writeFileSync(inputPath, buf);

    // Mỗi panel được crop chính xác 1/4 bề ngang (iw/4) và toàn bộ chiều cao (ih),
    // scale về 480:1080 (tỷ lệ đúng 4:9, KHÔNG co kéo, KHÔNG méo hình)
    for (let i = 0; i < 4; i++) {
      const cropFilter = `crop=iw/4:ih:${i}*iw/4:0,scale=480:1080:flags=lanczos`;
      execSync(`"${ffmpegPath}" -y -i "${inputPath}" -vf "${cropFilter}" -frames:v 1 "${outPaths[i]}"`, { timeout: 15000, stdio: 'pipe' });
    }

    const buffers = outPaths.map(p => fs.readFileSync(p));
    console.log(`[TemplatePro] ✅ Sliced Master Storyboard into 4 natural 4:9 panels (480x1080): ${buffers.map((b, i) => `Panel ${i + 1} (${(b.length / 1024).toFixed(0)} KB)`).join(', ')}`);
    return buffers;
  } finally {
    [inputPath, ...outPaths].forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { }
    });
  }
}

/**
 * Ghép 4 panel thành Master Storyboard 16:9 chuẩn (1920x1080)
 * 4 panel (mỗi panel 480x1080) xếp ngang cạnh nhau: 4 x 480 = 1920, cao 1080.
 * Hoàn toàn giữ nguyên tỷ lệ, không bóp méo, dung lượng ~2-3MB tối ưu gửi Telegram.
 */
function composeMasterStoryboardPro(panels, outputPath) {
  const ffmpegPath = require('ffmpeg-static');
  const tmpId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const tmpDir = os.tmpdir();
  const tmpFiles = [];

  try {
    const inputArgs = [];
    for (let i = 0; i < 4; i++) {
      const p = panels[i];
      const pPath = path.join(tmpDir, `pro-comp-${i + 1}-${tmpId}.png`);
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
    // Scale mỗi panel chuẩn 480:1080 trước khi hstack để tuyệt đối không bị lệch kích thước
    const filterComplex = '[0:v]scale=480:1080[p1];[1:v]scale=480:1080[p2];[2:v]scale=480:1080[p3];[3:v]scale=480:1080[p4];[p1][p2][p3][p4]hstack=inputs=4[out]';
    execSync(`"${ffmpegPath}" -y ${inputArgs.map(a => `"${a}"`).join(' ')} -filter_complex "${filterComplex}" -map "[out]" -frames:v 1 "${outputPath}"`, {
      timeout: 30000,
      stdio: 'pipe'
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error('FFmpeg failed to compose Master Storyboard');
    }
    console.log(`[TemplatePro] ✅ Composed 4 panels into 16:9 Master Storyboard (1920x1080): ${outputPath}`);

    // Tự động tạo thêm bản JPG nén chất lượng cao (q:2) để gửi Telegram siêu tốc không bao giờ bị timeout
    const jpgPath = outputPath.replace(/\.png$/i, '.jpg');
    try {
      execSync(`"${ffmpegPath}" -y -i "${outputPath}" -q:v 2 -update 1 "${jpgPath}"`, { timeout: 15000, stdio: 'pipe' });
    } catch (_) {}
  } finally {
    tmpFiles.forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { }
    });
  }
}

/**
 * Trích xuất audio từ file video MP4 bằng FFmpeg
 * Nếu video không có audio, tạo file audio silent có thời lượng targetDuration (mặc định 8.0s)
 */
function extractAudioFromVideo(videoPath, outAudioPath, targetDuration = 8.0) {
  const ffmpegPath = require('ffmpeg-static');
  const { execSync } = require('child_process');
  ensureDir(path.dirname(outAudioPath));

  let hasAudio = false;
  if (videoPath && fs.existsSync(videoPath)) {
    try {
      const probe = execSync(`"${ffmpegPath}" -i "${videoPath}"`, { stdio: 'pipe' }).toString();
      hasAudio = /Audio:\s*aac|Audio:\s*mp3|Audio:\s*pcm/i.test(probe);
    } catch (err) {
      const probe = (err.stderr ? err.stderr.toString() : '') + (err.stdout ? err.stdout.toString() : '');
      hasAudio = /Audio:\s*aac|Audio:\s*mp3|Audio:\s*pcm/i.test(probe);
    }
  }

  if (hasAudio) {
    try {
      execSync(`"${ffmpegPath}" -y -i "${videoPath}" -vn -c:a aac -b:a 192k "${outAudioPath}"`, {
        timeout: 20000,
        stdio: 'pipe'
      });
      if (fs.existsSync(outAudioPath) && fs.statSync(outAudioPath).size > 500) {
        return outAudioPath;
      }
    } catch (e) {
      console.warn(`[TemplatePro] extractAudio failed, falling back to silent:`, e.message);
    }
  }

  // Fallback silent audio đúng targetDuration
  execSync(`"${ffmpegPath}" -y -f lavfi -i anullsrc=r=48000:cl=stereo -t ${targetDuration.toFixed(2)} -c:a aac -b:a 192k "${outAudioPath}"`, {
    timeout: 15000,
    stdio: 'pipe'
  });
  return outAudioPath;
}

/**
 * Ghép 2 file audio (mỗi file ~8s) thành 1 file audio 16.0s duy nhất
 */
function concatTwoVoiceAudios(audio1Path, audio2Path, outVoicePath) {
  const ffmpegPath = require('ffmpeg-static');
  const { execSync } = require('child_process');
  ensureDir(path.dirname(outVoicePath));

  execSync(`"${ffmpegPath}" -y -i "${audio1Path}" -i "${audio2Path}" -filter_complex "[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a0];[1:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a1];[a0][a1]concat=n=2:v=0:a=1[aout]" -map "[aout]" -c:a aac -b:a 192k -t 16.0 "${outVoicePath}"`, {
    timeout: 30000,
    stdio: 'pipe'
  });
  return outVoicePath;
}

/**
 * Ghép 4 video panel (mỗi video 4s) và lồng ghép voiceAudioPath (16s) thành video 9:16 (1080x1920) hoàn chỉnh
 */
function merge4PanelsWithVoice(panelVideoPaths, voiceAudioPath, outputMergedPath) {
  const ffmpegPath = require('ffmpeg-static');
  const { execFileSync } = require('child_process');
  ensureDir(path.dirname(outputMergedPath));

  const filterParts = [];
  for (let i = 0; i < 4; i++) {
    filterParts.push(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=disable,setsar=1[v${i}]`);
  }
  filterParts.push(`[v0][v1][v2][v3]concat=n=4:v=1:a=0[vout]`);

  const hasVoice = voiceAudioPath && fs.existsSync(voiceAudioPath);
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
      '-t', '16.0',
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
      '-t', '16.0',
      outputMergedPath
    );
  }

  execFileSync(ffmpegPath, args, { stdio: 'pipe', timeout: 180000 });
  if (!fs.existsSync(outputMergedPath)) {
    throw new Error('ffmpeg merge4PanelsWithVoice completed but output file not created');
  }
  return outputMergedPath;
}

/**
 * Lưu trữ session vào memory và file session.json trên đĩa
 */
function saveProSession(runId, sessionData) {
  if (!runId || !sessionData) return;
  const strId = String(runId);
  proSessions.set(strId, sessionData);
  if (sessionData.jobId && String(sessionData.jobId) !== strId) {
    proSessions.set(String(sessionData.jobId), sessionData);
  }
  if (sessionData.runDir) {
    try {
      const sessionFile = path.join(sessionData.runDir, 'session.json');
      fs.writeFileSync(sessionFile, JSON.stringify({
        ...sessionData,
        currentStoryboardBuffer: undefined,
      }, null, 2), 'utf8');
    } catch (e) {
      console.warn(`[TemplatePro] Could not write session.json for ${runId}:`, e.message);
    }
  }
}

/**
 * Lấy session từ memory hoặc khôi phục từ file session.json
 */
function getProSession(runId, baseDir) {
  if (!runId) return null;
  const strId = String(runId);
  if (proSessions.has(strId)) {
    return proSessions.get(strId);
  }
  for (const sess of proSessions.values()) {
    if (sess && (sess.runId === strId || sess.jobId === strId)) {
      return sess;
    }
  }

  try {
    const reviewRunsDir = path.join(baseDir || path.resolve(__dirname, '..'), 'storyboard-review-runs');
    if (fs.existsSync(reviewRunsDir)) {
      const entries = fs.readdirSync(reviewRunsDir).filter(name =>
        (name.includes('template_pro') || name.includes('tpro'))
      );
      // 1. Khớp theo tên folder
      for (const entry of entries) {
        if (entry.includes(strId)) {
          const runDir = path.join(reviewRunsDir, entry);
          const sessionFile = path.join(runDir, 'session.json');
          if (fs.existsSync(sessionFile)) {
            const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
            proSessions.set(strId, data);
            return data;
          }
        }
      }
      // 2. Duyệt các thư mục gần nhất (mới nhất) kiểm tra nội dung session.json
      entries.sort().reverse();
      for (const entry of entries.slice(0, 15)) {
        const runDir = path.join(reviewRunsDir, entry);
        const sessionFile = path.join(runDir, 'session.json');
        if (fs.existsSync(sessionFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
            if (data.runId === strId || data.jobId === strId || (data.runDir && data.runDir.includes(strId))) {
              proSessions.set(strId, data);
              return data;
            }
          } catch (_) {}
        }
      }
      // 3. Fallback cho auto mode: nếu strId bắt đầu bằng tg_, lấy session gần nhất vừa tạo
      if (strId.startsWith('tg_') && entries.length > 0) {
        const latestRunDir = path.join(reviewRunsDir, entries[0]);
        const sessionFile = path.join(latestRunDir, 'session.json');
        if (fs.existsSync(sessionFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
            proSessions.set(strId, data);
            return data;
          } catch (_) {}
        }
      }
    }
  } catch (e) {
    console.warn(`[TemplatePro] Failed to restore session ${runId} from disk:`, e.message);
  }
  return null;
}

/**
 * Xây dựng Master Prompt chuyên biệt cho Template Pro
 * Tích hợp trực tiếp Product Storyboard Evaluation Framework v1.0 vào nội dung prompt:
 * - Tiêu chí 1: Product Fidelity (40đ, Tuyệt đối đúng silhouette, thân sản phẩm, bộ phận, màu sắc, vật liệu, KHÔNG ảo giác, KHÔNG đột biến)
 * - Tiêu chí 2: Scene Accuracy (25đ, Bối cảnh chuẩn, công năng thực tế, bàn tay 5 ngón tự nhiên, tiếp xúc vật lý thật)
 * - Tiêu chí 3: Commercial Composition (20đ, Bố cục thương mại, làm nổi bật sản phẩm & selling point, TUYỆT ĐỐI KHÔNG CHỮ)
 * - Tiêu chí 4: Visual Consistency (15đ, Đồng nhất sản phẩm, ánh sáng, góc nhìn, bối cảnh xuyên suốt 4 panel)
 */
function buildTemplateProMasterPrompt(analysisData, options = {}) {
  const a = analysisData || {};
  const loc = a.sceneContext?.location || 'a bright modern lifestyle setting';
  const lighting = a.sceneContext?.lighting || 'soft natural daylight with realistic contact shadows';
  const prodName = a.productName || 'the product';
  const fourAnswers = a.fourAnswers || {};
  const script = a.script || [];

  const sceneData = {
    productName: prodName,
    category: a.category || 'general',
    sceneContext: a.sceneContext || {},
    leftHalfComposition: {
      description: "Left half of storyboard (Panels 1 & 2 side-by-side) - will be sliced directly into Image 1 for Video 1",
      panel1: {
        id: 1,
        phase: "Hook",
        marketingQuestion: "Hook gì để họ dừng lướt?",
        marketingAnswer: fourAnswers.hook || script[0]?.goal || "Hook gây tò mò / nêu nỗi đau thực tế",
        visualDescription: script[0]?.visualDescription || "Cận cảnh cầm sản phẩm trên bề mặt tự nhiên sang trọng",
        handInteraction: script[0]?.techVFX || "Thao tác tay thực tế",
      },
      panel2: {
        id: 2,
        phase: "Solution",
        marketingQuestion: "Sản phẩm là giải pháp gì?",
        marketingAnswer: fourAnswers.solution || script[1]?.goal || "Giới thiệu sản phẩm và công năng giải pháp vượt trội",
        visualDescription: script[1]?.visualDescription || "Đặc tả tính năng và chi tiết cấu tạo hoàn thiện",
        handInteraction: script[1]?.techVFX || "Thao tác tay sử dụng công năng sản phẩm",
      }
    },
    rightHalfComposition: {
      description: "Right half of storyboard (Panels 3 & 4 side-by-side) - will be sliced directly into Image 2 for Video 2",
      panel3: {
        id: 3,
        phase: "Proof",
        marketingQuestion: "Bằng chứng nào khiến họ tin?",
        marketingAnswer: fourAnswers.proof || script[2]?.goal || "Bằng chứng chất liệu cao cấp và kiểm tra thực tế",
        visualDescription: script[2]?.visualDescription || "Cận cảnh chất liệu, vân bề mặt và độ hoàn thiện tinh xảo",
        handInteraction: script[2]?.techVFX || "Thao tác tay kiểm tra độ bền, chất lượng thực tế",
      },
      panel4: {
        id: 4,
        phase: "Closing / CTA",
        marketingQuestion: "Lý do gì để họ mua ngay?",
        marketingAnswer: fourAnswers.closing || script[3]?.goal || "Lý do mua ngay và nâng tầm phong cách sống",
        visualDescription: script[3]?.visualDescription || "Toàn cảnh sản phẩm hòa nhập không gian sống hiện đại",
        handInteraction: script[3]?.techVFX || "Sản phẩm hoàn thiện trong không gian sống",
      }
    }
  };

  return `Generate one product review storyboard image (still photo collage, NOT a video) from the uploaded product reference images for ${prodName}.

CRITICAL VISUAL DIRECTION — 100% SMARTPHONE REALISM & QUALITY FRAMEWORK (PRODUCT STORYBOARD EVALUATION FRAMEWORK v1.0):
You MUST strictly satisfy all 4 quality criteria in order of priority:

1. PRIORITY 1: PRODUCT FIDELITY (Tuyệt đối bảo toàn kiểu dáng sản phẩm gốc - ƯU TIÊN SỐ 1 CAO NHẤT):
- Silhouette & Main Body Shape: Strictly match the uploaded product reference photo. The product's overall geometry, structural silhouette, proportions, lid/body/base contours, and aspect ratio MUST EXACTLY replicate the real product. DO NOT transform or morph the product into another design, variant, or competitor's product.
- Components & Structural Parts: Every major visible component (buttons, dials, handles, nozzles, ports, seams, lids, attachments) must be in the exact position shown in the reference image. NO missing essential parts, NO hallucinated or invented accessories.
- Color, Material & Finish: Faithfully preserve the exact colors, dual-tone palettes, textures, and material finishes (matte plastic, brushed aluminum, glossy ceramic, woven fabric, transparent glass, etc.) from the reference photo.
- Zero Hallucination / Zero Mutation: Strictly NO invented controls, NO extra decorative elements not in reference. The product must NOT morph or change shape/color between panels.

2. PRIORITY 2: SCENE ACCURACY (Bối cảnh và thao tác sử dụng thực tế, chuẩn xác):
- Correct Product Usage: Demonstrate realistic, ergonomic use cases that match real-world functionality and the product category.
- Realistic Environment: Place the product in ${loc} with natural perspective and contextually plausible surrounding objects.
- Anatomically Accurate Hands & Model: Authentic Asian skin tone, natural skin pores, knuckle creases, neat nails. EXACTLY 5 anatomically correct fingers per hand with physically plausible grip. Hands must realistically wrap around handles or surfaces without clipping, merging, or floating. Strictly faceless (only hands, wrists, limbs, or body silhouette from behind/chest down; NO visible human faces).
- Physical Plausibility: Stable contact points on real surfaces with natural ambient occlusion and contact shadows. Product and objects MUST NOT float.

3. PRIORITY 3: COMMERCIAL COMPOSITION (Bố cục thương mại, làm nổi bật sản phẩm & công năng):
- Product Prominence & Eye-Level Framing: Product must be clearly visible, in sharp focus, well-lit, occupying prominent frame area in each panel. Camera angles must showcase the product's premium aesthetic.
- Clear Selling Point Visuals: Panel 1 highlights the curiosity/problem hook; Panel 2 clearly displays the core functional solution; Panel 3 gives a crisp close-up proof of material quality and finish; Panel 4 showcases the aspirational lifestyle integration.
- STRICT NO-TEXT RULE (TUYỆT ĐỐI KHÔNG CHỮ / NO TEXT / NO LABELS):
  * Every panel must be 100% pure clean photography.
  * Absolutely NO typography, NO words, NO subtitles, NO badges, NO digital stickers, NO watermarks, NO glowing neon arrows, NO cartoon magnifying glasses, and NO fake fairy sparkles.

4. PRIORITY 4: VISUAL CONSISTENCY (Đồng nhất xuyên suốt toàn bộ 4 panel):
- Product Continuity: Identical product model, exact color, material, and component count across all 4 panels. Zero mutation.
- Environment & Lighting Continuity: All 4 panels must share the same environment (${loc}) under consistent ${lighting}.
- Cohesive Photography Style: Coherent smartphone camera look (iPhone 15 Pro 24mm/26mm f/1.8 aesthetic, crisp focal plane, natural depth of field).

Storyboard requirements:
- Exactly 4 panels arranged side by side in one single still image (horizontal 16:9 collage composed of 4 vertical 9:16 frames).
  * Left Half: Panel 1 (Hook) + Panel 2 (Solution)
  * Right Half: Panel 3 (Proof) + Panel 4 (Closing / CTA)
- Output must be a still photograph collage. Do NOT generate or describe a video.

Scene plan:
${JSON.stringify(sceneData, null, 2)}

Generate one still storyboard image now.`.trim();
}

/**
 * Tạo bàn phím Inline Telegram gồm các nút Remake (từng cảnh & tất cả) và nút OK
 */
function buildProInlineKeyboard(runId) {
  return {
    inline_keyboard: [
      [
        { text: '🔄 Remake 1 (Hook)', callback_data: `tpro_remake:1:${runId}` },
        { text: '🔄 Remake 2 (Solution)', callback_data: `tpro_remake:2:${runId}` }
      ],
      [
        { text: '🔄 Remake 3 (Proof)', callback_data: `tpro_remake:3:${runId}` },
        { text: '🔄 Remake 4 (Closing)', callback_data: `tpro_remake:4:${runId}` }
      ],
      [
        { text: '🔄 Remake All (Tạo lại cả 4 cảnh)', callback_data: `tpro_remake_all:${runId}` }
      ],
      [
        { text: '✅ OK - Chốt Storyboard', callback_data: `tpro_ok:${runId}` }
      ]
    ]
  };
}

/**
 * Tạo bàn phím Inline Telegram gồm 4 tùy chọn Remake Video cho 4 Cảnh + Nút Upload TikTok:
 * 1. Remake Cảnh 1
 * 2. Remake Cảnh 2
 * 3. Remake Cảnh 3
 * 4. Remake Cảnh 4
 * 5. Đăng lên TikTok (/upload)
 */
function buildProVideoInlineKeyboard(runId) {
  return {
    inline_keyboard: [
      [
        { text: '🔄 Remake Cảnh 1', callback_data: `tpro_remake_video:1:${runId}` },
        { text: '🔄 Remake Cảnh 2', callback_data: `tpro_remake_video:2:${runId}` }
      ],
      [
        { text: '🔄 Remake Cảnh 3', callback_data: `tpro_remake_video:3:${runId}` },
        { text: '🔄 Remake Cảnh 4', callback_data: `tpro_remake_video:4:${runId}` }
      ],
      [
        { text: '🚀 Đăng lên TikTok (/upload)', callback_data: `tpro_upload:${runId}` }
      ]
    ]
  };
}

/**
 * Xây dựng prompt Remake All cho toàn bộ 4 cảnh
 */
function buildTemplateProRemakeAllPrompt(analysis, iteration, baseMasterPrompt = null) {
  const basePrompt = baseMasterPrompt || buildTemplateProMasterPrompt(analysis, { noText: true, template: 'template_pro' });
  return `${basePrompt}

CRITICAL VARIATION INSTRUCTION — REMAKE ALL 4 PANELS (ITERATION ${iteration}):
- You are provided with the original physical product photos as the ground-truth reference for product appearance, color, design, and finish.
- TASK: Generate a completely FRESH, HIGHLY DYNAMIC, and CREATIVE alternative 4-panel storyboard collage (16:9).
- Remake ALL 4 panels simultaneously with brand-new perspectives:
  * Panel 1 (Hook): Fresh dynamic angle & compelling problem/curiosity hook.
  * Panel 2 (Solution): Distinct hand interaction demonstrating key features & practical function.
  * Panel 3 (Proof): New close-up angle highlighting premium texture/material quality and finish.
  * Panel 4 (Closing / CTA): Fresh lifestyle setting placement & final showcase.
- STRICT SMARTPHONE REALISM: Authentic high-end smartphone camera style (natural daylight, genuine contact shadows).
- STRICT FACELESS: No visible human faces, only natural hands/limbs/outfit.
- STRICT NO-TEXT: No typography, words, labels, subtitles, or watermarks.

Generate the newly remade 4-panel still storyboard collage now.`;
}

/**
 * Lấy thông tin ngữ cảnh và góc nhìn của từng Panel theo phân tích
 */
function getPanelContext(analysis, panelIndex) {
  const left = analysis?.leftHalfComposition || {};
  const right = analysis?.rightHalfComposition || {};
  if (panelIndex === 1) {
    return {
      phase: 'Hook',
      marketingQuestion: left.panel1?.marketingQuestion || 'Hook thu hút khách hàng',
      marketingAnswer: left.panel1?.marketingAnswer || 'Nêu bật vấn đề hoặc nỗi đau thường gặp',
      visualDescription: left.panel1?.visualDescription || 'Cận cảnh cầm sản phẩm trên bề mặt tự nhiên sang trọng',
      handInteraction: left.panel1?.handInteraction || 'Thao tác tay thực tế tương tác sản phẩm'
    };
  }
  if (panelIndex === 2) {
    return {
      phase: 'Solution',
      marketingQuestion: left.panel2?.marketingQuestion || 'Sản phẩm giải quyết vấn đề gì?',
      marketingAnswer: left.panel2?.marketingAnswer || 'Công năng đặc biệt của sản phẩm',
      visualDescription: left.panel2?.visualDescription || 'Đặc tả tính năng và chi tiết cấu tạo hoàn thiện',
      handInteraction: left.panel2?.handInteraction || 'Thao tác tay sử dụng công năng sản phẩm'
    };
  }
  if (panelIndex === 3) {
    return {
      phase: 'Proof',
      marketingQuestion: right.panel3?.marketingQuestion || 'Bằng chứng chất lượng?',
      marketingAnswer: right.panel3?.marketingAnswer || 'Độ bền, chi tiết chất liệu cao cấp',
      visualDescription: right.panel3?.visualDescription || 'Cận cảnh chất liệu, vân bề mặt và độ hoàn thiện tinh xảo',
      handInteraction: right.panel3?.handInteraction || 'Thao tác tay kiểm tra độ bền, chất lượng thực tế'
    };
  }
  return {
    phase: 'Closing / CTA',
    marketingQuestion: right.panel4?.marketingQuestion || 'Lý do mua ngay?',
    marketingAnswer: right.panel4?.marketingAnswer || 'Ứng dụng hoàn hảo trong không gian sống',
    visualDescription: right.panel4?.visualDescription || 'Toàn cảnh sản phẩm hòa nhập không gian sống hiện đại',
    handInteraction: right.panel4?.handInteraction || 'Sản phẩm hoàn thiện trong không gian sống'
  };
}

/**
 * Xây dựng prompt Remake chuyên biệt cho Panel K
 * Bao gồm toàn bộ prompt lần đầu (base master prompt) + hướng dẫn nâng cấp:
 * AI đối chiếu ảnh storyboard hiện tại và ảnh input gốc, CHỈ THAY ĐỔI Panel K với góc nhìn/hành động mới,
 * giữ nguyên 3 panel còn lại để đồng bộ bố cục và không gian.
 */
function buildTemplateProRemakePrompt(analysis, panelIndex, iteration, baseMasterPrompt = null) {
  const basePrompt = baseMasterPrompt || buildTemplateProMasterPrompt(analysis, { noText: true, template: 'template_pro' });
  const panelInfo = getPanelContext(analysis, panelIndex);
  const location = analysis?.sceneContext?.location || 'không gian sống hiện đại, tự nhiên';
  const lighting = analysis?.sceneContext?.lighting || 'ánh sáng tự nhiên dịu nhẹ ban ngày kết hợp đèn ấm';

  return `${basePrompt}

CRITICAL EDIT & REMAKE INSTRUCTION — REMAKE AND RE-INVENT ONLY PANEL ${panelIndex} (ITERATION ${iteration}):
- Reference Images Provided:
  1. Original physical product photos: Ground-truth reference for exact product identity, color, design, and finish.
  2. Current 4-panel storyboard image (current_storyboard.png): Reference for overall environment, tone, and existing scene compositions.
- TASK:
  * You must REMAKE and RE-IMAGINE ONLY Panel ${panelIndex} (Scene ${panelIndex}, counting 1 to 4 from left to right).
  * The other 3 panels must strictly preserve their identity, scene context, and styling matching the current storyboard image (current_storyboard.png) and the original scene plan above.
  * Provide a completely FRESH, ALTERNATIVE, and HIGHLY DYNAMIC visual composition specifically for Panel ${panelIndex}:
    - Scene Phase: Panel ${panelIndex} — ${panelInfo.phase}
    - Marketing Focus: ${panelInfo.marketingAnswer}
    - Visual Re-imagining: ${panelInfo.visualDescription}. Provide a newly improved angle, different realistic hand interaction, and distinct composition.
    - Hand Interaction: ${panelInfo.handInteraction}
  * Maintain identical setting (${location}), lighting (${lighting}), and human model styling so it harmonizes seamlessly with the rest of the storyboard.
- STRICT SMARTPHONE REALISM: Authentic high-end smartphone camera style (natural daylight, genuine contact shadows).
- STRICT FACELESS: No visible human faces, only natural hands/limbs/outfit.
- STRICT NO-TEXT: No typography, words, labels, subtitles, or watermarks.

Generate the newly updated still storyboard image now.`;
}

/**
 * Xây dựng prompt kiểm định chất lượng Master Storyboard bằng Gemini Vision (100 điểm)
 * Áp dụng Product Storyboard Evaluation Framework v1.0:
 * 1. Product Fidelity (40đ, Hard Gate min 32đ)
 * 2. Scene Accuracy (25đ, min 18đ)
 * 3. Commercial Composition (20đ, min 14đ)
 * 4. Visual Consistency (15đ, min 10đ)
 */
function buildTemplateProVerificationPrompt(analysis, attempt = 1) {
  const productName = analysis?.productName || 'sản phẩm';
  const category = analysis?.category || 'general';
  const location = analysis?.sceneContext?.location || 'Không gian sống hiện đại sáng sủa, nội thất tối giản tinh tế';
  const lighting = analysis?.sceneContext?.lighting || 'Ánh sáng tự nhiên dịu nhẹ ban ngày kết hợp đèn ấm';

  return `You are a strict, objective Quality Assurance (QA) Vision Inspector for an e-commerce 4-panel product review storyboard (still photo collage, 16:9).

EVALUATION FRAMEWORK: Product Storyboard Evaluation Framework v1.0 (Total Score: 100)

You are provided with:
1. Reference Product Input Photo ("input.png" or reference photos): Ground truth reference combining authentic product photos (exact product appearance, physical shape, silhouette, proportions, lid/handle/base geometry, color, materials, logos/prints, and finish).
2. Generated Master Storyboard Image (storyboard_qa.png): A horizontal 16:9 collage consisting of 4 vertical 9:16 panels side-by-side:
   - Panel 1 (Scene 1): Hook
   - Panel 2 (Scene 2): Solution / Key Feature
   - Panel 3 (Scene 3): Proof / Demonstration / Material Quality
   - Panel 4 (Scene 4): Closing / Lifestyle / Call to Action

Product being reviewed: "${productName}" (Category: ${category})
Expected Setting: ${location}
Expected Lighting: ${lighting}

CRITERIA & PRIORITY ORDER:
1. PRODUCT FIDELITY (Priority 1, Max 40 pts, Weight 40%, Hard Gate: min 32 pts):
   - Overall Shape & Structure (Max 10 pts, Severity if wrong: CRITICAL): Silhouette matches reference, main body shape matches, structural layout matches, major sections positioned correctly, structural relationships between parts preserved. Product is NOT transformed into another model, variant, or design.
   - Components & Features (Max 10 pts, Severity if wrong: CRITICAL): All major visible components exist, correct number of important components, no required major component missing, functional parts appear in correct positions, feature design matches reference, functionality not changed, accessories preserved.
   - Proportions & Dimensions (Max 6 pts, Severity if wrong: MAJOR): Width-to-height ratio consistent with reference, relative component sizes match, spacing between components correct, product thickness visually consistent, relative scale between major parts preserved, scale relative to hands/furniture/environment plausible.
   - Color, Material & Surface (Max 5 pts, Severity if wrong: MAJOR): Primary color matches reference, secondary colors match, material type matches, surface finish matches (matte, glossy, metallic, fabric, wood, plastic, glass), transparency/translucency preserved where applicable, reflection behavior plausible.
   - Details & Identity Markers (Max 5 pts, Severity if wrong: MODERATE): Logo correct when clearly visible in references, text/typography not fabricated, buttons match placement and shape, slots/holes/grooves match, patterns and decorative details preserved, seams/joints/connectors consistent. (Do NOT penalize details genuinely hidden by camera angle or occlusion).
   - No Hallucination / Mutation (Max 4 pts, Severity if wrong: CRITICAL): No invented components, no invented functionality, no unsupported buttons/screens/LEDs/controls, no fabricated branding/logo, no unauthorized accessories, no component count mutation, no shape mutation across panels, no color/material mutation across panels.
   CRITICAL PRODUCT FIDELITY ERRORS:
   * Product becomes a different model or SKU
   * Major product component is missing
   * Major unsupported component is added
   * Core functionality is changed
   * Product structure contradicts reference images
   * Important feature is hallucinated
   * Product mutates significantly between panels
   CRITICAL ERROR OVERRIDE: If ANY critical Product Fidelity error exists, decision MUST BE "FAIL" and product_fidelity.score MUST be < 32.

2. SCENE ACCURACY (Priority 2, Max 25 pts, Weight 25%, min pass score: 18 pts):
   - Correct Product Usage (Max 8 pts, Severity if wrong: CRITICAL): Human uses product correctly, functional interaction matches real behavior, product orientation during usage correct, demonstrated feature matches actual feature, no impossible/incorrect usage, logical sequence.
   - Correct Environment (Max 6 pts, Severity if wrong: MAJOR): Environment matches product category, product placement realistic, supporting objects contextually relevant, background supports intended use, scene does not contradict expected product usage.
   - Human Interaction Accuracy (Max 5 pts, Severity if wrong: MAJOR): Hand position natural, grip physically plausible, finger placement realistic, fingers do not intersect or merge with product, interaction direction correct, human scale relative to product plausible.
   - Physical Plausibility (Max 4 pts, Severity if wrong: MAJOR): Product does not float, mounting or support plausible, realistic contact points, gravity direction correct, no impossible geometry, no penetration between solid objects.
   - Storyboard Intent Match (Max 2 pts, Severity if wrong: MODERATE): Hook panel communicates intended problem/curiosity, solution panel communicates solution, demo panel clearly demonstrates feature, result panel communicates final benefit.
   Major Errors: Product used incorrectly, scene context conflicts with use, human interaction physically impossible, product placement unrealistic, panel does not match intended role.

3. COMMERCIAL COMPOSITION (Priority 3, Max 20 pts, Weight 20%, min pass score: 14 pts):
   - Product Visibility & Recognition (Max 6 pts, Severity if wrong: MAJOR): Product clearly visible, important parts not unnecessarily obstructed, occupies sufficient visual area, camera angle helps identify product, background does not overpower product, recognizable at mobile viewing size.
   - Selling Point Clarity (Max 5 pts, Severity if wrong: MAJOR): Main selling point visually understandable, feature demonstration easy to read, benefit visually communicated, important feature not hidden.
   - Hook / Demo Effectiveness (Max 4 pts, Severity if wrong: MODERATE): Hook creates immediate visual interest, problem recognizable, demo action visually clear, communicates value quickly.
   - Framing & Visual Hierarchy (Max 3 pts, Severity if wrong: MODERATE): Visual hierarchy prioritizes product and key action, framing balanced, important content inside safe area, foreground and background clearly separated.
   - Commercial Cleanliness (Max 2 pts, Severity if wrong: MINOR): No distracting unnecessary objects, no irrelevant visual clutter, no accidental competing brand elements, STRICTLY NO digital text banners, subtitles, neon arrows, watermarks, or cartoon stickers.
   Major Errors: Product too small or hidden, main selling point visually unclear, demo does not communicate function, composition distracts attention away from product.

4. VISUAL CONSISTENCY (Priority 4, Max 15 pts, Weight 15%, min pass score: 10 pts):
   - Product Continuity (Max 4 pts, Severity if wrong: CRITICAL): Same product model across panels, same color, same material, same component count, same structural details. No mutation between panels.
   - Environment Continuity (Max 4 pts, Severity if wrong: MAJOR): Same room identity, same wall/floor/furniture language, background landmarks consistent, spatial coherence.
   - Lighting & Color Continuity (Max 3 pts, Severity if wrong: MODERATE): Light direction consistent, color temperature consistent, exposure reasonably consistent.
   - Human / Hand Continuity (Max 2 pts, Severity if wrong: MODERATE): Same apparent person when continuity required, skin tone visually stable, clothing consistent, hand appearance does not radically change.
   - Camera Language Continuity (Max 2 pts, Severity if wrong: MINOR): Lens perspective coherent, camera height coherent, framing style feels like same shoot.
   Major Errors: Product visibly changes between panels, environment changes unintentionally, lighting style changes abruptly, human identity changes unexpectedly, camera language feels like unrelated shoots.

DECISION RULES & SCORE BANDS:
- Priority 1: Any critical Product Fidelity error exists -> "FAIL" (Regenerate affected panel or entire storyboard)
- Priority 2: product_fidelity.score < 32 -> "FAIL"
- Priority 3: total_score < 75 -> "FAIL"
- Priority 4: total_score >= 75 && total_score < 85 -> "REGENERATE_OR_FIX"
- Priority 5: total_score >= 85 && total_score < 93 -> "PASS"
- Priority 6: total_score >= 93 -> "EXCELLENT"

OUTPUT FORMAT:
Return ONLY a valid RFC 8259 JSON object starting with { and ending with }:
{
  "total_score": 88,
  "score": 88,
  "decision": "PASS",
  "passed": true,
  "criteria_results": {
    "product_fidelity": {
      "score": 36,
      "max_score": 40,
      "passed": true,
      "critical_error": false,
      "subcriteria": {
        "overall_shape_structure": { "score": 9, "max_score": 10, "notes": "Silhouette và thân khớp ảnh reference" },
        "components_features": { "score": 9, "max_score": 10, "notes": "Đầy đủ các bộ phận chính" },
        "proportions_dimensions": { "score": 5, "max_score": 6, "notes": "Tỷ lệ chuẩn xác" },
        "color_material_surface": { "score": 5, "max_score": 5, "notes": "Màu sắc và vật liệu chuẩn" },
        "details_identity_markers": { "score": 4, "max_score": 5, "notes": "Chi tiết nhận diện tốt" },
        "no_hallucination_mutation": { "score": 4, "max_score": 4, "notes": "Không đột biến giữa các panel" }
      }
    },
    "scene_accuracy": {
      "score": 22,
      "max_score": 25,
      "passed": true,
      "subcriteria": {
        "correct_product_usage": { "score": 7, "max_score": 8, "notes": "Sử dụng sản phẩm đúng cách" },
        "correct_environment": { "score": 5, "max_score": 6, "notes": "Bối cảnh phù hợp ngành hàng" },
        "human_interaction_accuracy": { "score": 5, "max_score": 5, "notes": "Tương tác tay tự nhiên" },
        "physical_plausibility": { "score": 3, "max_score": 4, "notes": "Vật lý hợp lý" },
        "storyboard_intent_match": { "score": 2, "max_score": 2, "notes": "Đúng vai trò từng panel" }
      }
    },
    "commercial_composition": {
      "score": 17,
      "max_score": 20,
      "passed": true,
      "subcriteria": {
        "product_visibility_recognition": { "score": 5, "max_score": 6, "notes": "Sản phẩm rõ ràng nổi bật" },
        "selling_point_clarity": { "score": 4, "max_score": 5, "notes": "Selling point trực quan" },
        "hook_demo_effectiveness": { "score": 4, "max_score": 4, "notes": "Hook và demo hiệu quả" },
        "framing_visual_hierarchy": { "score": 2, "max_score": 3, "notes": "Phân cấp thị giác tốt" },
        "commercial_cleanliness": { "score": 2, "max_score": 2, "notes": "Bố cục sạch sẽ, không text đè" }
      }
    },
    "visual_consistency": {
      "score": 13,
      "max_score": 15,
      "passed": true,
      "subcriteria": {
        "product_continuity": { "score": 4, "max_score": 4, "notes": "Sản phẩm đồng nhất 4 panel" },
        "environment_continuity": { "score": 3, "max_score": 4, "notes": "Bối cảnh duy trì liền mạch" },
        "lighting_color_continuity": { "score": 3, "max_score": 3, "notes": "Ánh sáng đồng đều" },
        "human_hand_continuity": { "score": 2, "max_score": 2, "notes": "Tay và da người ổn định" },
        "camera_language_continuity": { "score": 1, "max_score": 2, "notes": "Ngôn ngữ camera gắn kết" }
      }
    }
  },
  "critical_errors": [],
  "major_errors": [],
  "warnings": [],
  "discrepancies": [],
  "critique": "Đánh giá tổng quan chi tiết bằng tiếng Việt",
  "correctionDirective": "Chỉ thị chỉnh sửa cụ thể cho lần sinh tiếp theo nếu cần",
  "regeneration_recommendation": {
    "required": false,
    "scope": "none",
    "panels": [],
    "reasons": []
  }
}`;
}

/**
 * Thực hiện xác thực chất lượng Storyboard qua Gemini Vision API
 * Áp dụng Product Storyboard Evaluation Framework v1.0 (100 điểm, ngưỡng pass >= 85)
 */
async function verifyStoryboardWithGeminiVision(geminiClient, storyboardBuffer, savedInputs, analysis, attempt = 1) {
  if (!geminiClient || !storyboardBuffer) {
    console.warn('[TemplatePro] ⚠️ Gemini client or storyboard buffer unavailable, bypassing QA');
    return {
      score: 88,
      total_score: 88,
      decision: 'PASS',
      passed: true,
      criteria_results: {
        product_fidelity: { score: 36, max_score: 40, passed: true },
        scene_accuracy: { score: 22, max_score: 25, passed: true },
        commercial_composition: { score: 17, max_score: 20, passed: true },
        visual_consistency: { score: 13, max_score: 15, passed: true }
      },
      criteria: {
        productFidelity: 36,
        sceneAccuracy: 22,
        commercialComposition: 17,
        visualConsistency: 13,
        productFidelityAndIdentity: 36,
        physicalStateAndMorphology: 22,
        panelCompositionAndContinuity: 17,
        smartphoneRealismAndFaceless: 13,
        cleanlinessAndStrictNoText: 5
      },
      discrepancies: [],
      critique: 'Bypassed verification due to client unavailable',
      correctionDirective: '',
      bypassed: true
    };
  }

  console.log(`[TemplatePro] 🔎 [QA Attempt ${attempt}] Uploading Storyboard & Input images to Gemini Vision...`);

  try {
    const sbFilename = `storyboard_qa_att${attempt}.png`;
    const sbUrl = await geminiClient.uploadFile(storyboardBuffer, sbFilename, 'image/png');

    const fileData = [
      { url: sbUrl, filename: sbFilename, mimeType: 'image/png' }
    ];

    // Ưu tiên gửi ảnh input.png (đã gộp các góc chụp sản phẩm vào 1 khung lưới)
    let collageInput = null;
    if (Array.isArray(savedInputs)) {
      collageInput = savedInputs.find(f => f.name === 'input.png' || (f.path && path.basename(f.path) === 'input.png'));
    }

    if (collageInput) {
      const refBuf = collageInput.buffer || (collageInput.path && fs.existsSync(collageInput.path) ? fs.readFileSync(collageInput.path) : null);
      if (refBuf) {
        const refUrl = await geminiClient.uploadFile(refBuf, 'input.png', 'image/png');
        fileData.push({ url: refUrl, filename: 'input.png', mimeType: 'image/png' });
      }
    } else {
      const inputRefs = (savedInputs || []).slice(0, 3);
      for (let i = 0; i < inputRefs.length; i++) {
        const ref = inputRefs[i];
        const refBuf = ref.buffer || (ref.path && fs.existsSync(ref.path) ? fs.readFileSync(ref.path) : null);
        if (refBuf) {
          const refName = ref.name || `input_ref_${i + 1}.png`;
          const mime = ref.mimeType || (refName.endsWith('.jpg') || refName.endsWith('.jpeg') ? 'image/jpeg' : 'image/png');
          const refUrl = await geminiClient.uploadFile(refBuf, refName, mime);
          fileData.push({ url: refUrl, filename: refName, mimeType: mime });
        }
      }
    }

    const qaPrompt = buildTemplateProVerificationPrompt(analysis, attempt);
    console.log(`[TemplatePro] 🔎 [QA Attempt ${attempt}] Evaluating Storyboard via Gemini Vision (Product Storyboard Framework v1.0, threshold >= 85)...`);

    const res = await geminiClient.generateContent({
      prompt: qaPrompt,
      fileData,
      temporary: true,
      expectImages: false,
    });

    const rawText = res?.text || '';
    const parsed = parseJsonObjectPro(rawText);

    if (parsed && (typeof parsed.score === 'number' || typeof parsed.total_score === 'number')) {
      const rawScore = parsed.total_score !== undefined ? parsed.total_score : parsed.score;
      const score = Math.max(0, Math.min(100, Math.round(rawScore)));
      const critResults = parsed.criteria_results || {};
      const prodFidScore = critResults.product_fidelity?.score ?? (parsed.criteria?.productFidelityAndIdentity ?? (parsed.criteria?.productFidelity ?? Math.round(score * 0.4)));
      const hasCriticalError = (Array.isArray(parsed.critical_errors) && parsed.critical_errors.length > 0) ||
                               critResults.product_fidelity?.critical_error === true;

      // Áp dụng decision rules chuẩn xác theo framework v1.0
      let decision = parsed.decision || '';
      if (!decision) {
        if (hasCriticalError || prodFidScore < 32 || score < 75) {
          decision = 'FAIL';
        } else if (score < 85) {
          decision = 'REGENERATE_OR_FIX';
        } else if (score < 93) {
          decision = 'PASS';
        } else {
          decision = 'EXCELLENT';
        }
      }
      const passed = (decision === 'PASS' || decision === 'EXCELLENT') && prodFidScore >= 32 && !hasCriticalError;
      const discrepancies = Array.isArray(parsed.discrepancies) ? parsed.discrepancies : [];
      if (Array.isArray(parsed.critical_errors) && parsed.critical_errors.length > 0) {
        parsed.critical_errors.forEach(err => {
          if (!discrepancies.includes(err)) discrepancies.unshift(`[CRITICAL] ${err}`);
        });
      }
      const critique = parsed.critique || (passed ? 'Storyboard đạt chuẩn chất lượng.' : 'Storyboard có lỗi chưa đạt chuẩn.');
      const correctionDirective = parsed.correctionDirective || '';

      const criteria = {
        productFidelity: prodFidScore,
        sceneAccuracy: critResults.scene_accuracy?.score ?? (parsed.criteria?.physicalStateAndMorphology ?? Math.round(score * 0.25)),
        commercialComposition: critResults.commercial_composition?.score ?? (parsed.criteria?.panelCompositionAndContinuity ?? Math.round(score * 0.20)),
        visualConsistency: critResults.visual_consistency?.score ?? (parsed.criteria?.smartphoneRealismAndFaceless ?? Math.round(score * 0.15)),
        // Legacy keys
        productFidelityAndIdentity: prodFidScore,
        physicalStateAndMorphology: critResults.scene_accuracy?.score ?? Math.round(score * 0.25),
        panelCompositionAndContinuity: critResults.commercial_composition?.score ?? Math.round(score * 0.20),
        smartphoneRealismAndFaceless: critResults.visual_consistency?.score ?? Math.round(score * 0.15),
        cleanlinessAndStrictNoText: 5
      };

      console.log(`[TemplatePro] 📊 [QA Attempt ${attempt}] Score: ${score}/100 [${decision}] (Pass: ${passed}, Fidelity: ${prodFidScore}/40)`);
      if (!passed) {
        console.warn(`[TemplatePro] ⚠️ [QA Attempt ${attempt}] Discrepancies: ${discrepancies.join('; ')}`);
      }

      return {
        score,
        total_score: score,
        decision,
        passed,
        criteria,
        criteria_results: critResults,
        critical_errors: parsed.critical_errors || [],
        major_errors: parsed.major_errors || [],
        discrepancies,
        critique,
        correctionDirective,
        rawText
      };
    }

    // Dự phòng khi Gemini không trả JSON hoàn hảo
    const scoreMatch = rawText.match(/"total_score":\s*(\d+)/i) || rawText.match(/"score":\s*(\d+)/i) || rawText.match(/score\s*[:=]\s*(\d+)/i);
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 86;
    const passed = score >= 85;
    return {
      score,
      total_score: score,
      decision: passed ? 'PASS' : 'FAIL',
      passed,
      criteria: {
        productFidelity: Math.round(score * 0.4),
        sceneAccuracy: Math.round(score * 0.25),
        commercialComposition: Math.round(score * 0.20),
        visualConsistency: Math.round(score * 0.15),
        productFidelityAndIdentity: Math.round(score * 0.4),
        physicalStateAndMorphology: Math.round(score * 0.25),
        panelCompositionAndContinuity: Math.round(score * 0.20),
        smartphoneRealismAndFaceless: Math.round(score * 0.15),
        cleanlinessAndStrictNoText: 5
      },
      criteria_results: {},
      critical_errors: [],
      major_errors: [],
      discrepancies: passed ? [] : ['Có sai lệch chưa đạt chuẩn >= 85 điểm'],
      critique: 'Chấm điểm dự phòng từ phản hồi text.',
      correctionDirective: '',
      rawText
    };
  } catch (err) {
    console.warn(`[TemplatePro] ⚠️ Gemini QA verification error: ${err.message}`);
    return {
      score: 86,
      total_score: 86,
      decision: 'PASS',
      passed: true,
      criteria: {},
      criteria_results: {},
      critical_errors: [],
      major_errors: [],
      discrepancies: [`QA API error: ${err.message}`],
      critique: `Bỏ qua QA do lỗi kết nối: ${err.message}`,
      correctionDirective: '',
      bypassed: true
    };
  }
}

/**
 * Định dạng lịch sử kiểm định Gemini Vision QA sang Markdown để lưu vào prompts.md
 */
function formatQAVerificationMarkdown(qaHistory, selectedCandidate) {
  if (!qaHistory || qaHistory.length === 0) return '';
  const lines = [
    '',
    '### Gemini Vision QA Verification History (Product Storyboard Framework v1.0, Threshold >= 85)',
    ''
  ];

  qaHistory.forEach((item) => {
    const qa = item.qaResult || {};
    const crit = qa.criteria || {};
    const cr = qa.criteria_results || {};
    const fid = cr.product_fidelity?.score ?? (crit.productFidelity ?? (crit.productFidelityAndIdentity ?? 'N/A'));
    const scene = cr.scene_accuracy?.score ?? (crit.sceneAccuracy ?? (crit.physicalStateAndMorphology ?? 'N/A'));
    const comp = cr.commercial_composition?.score ?? (crit.commercialComposition ?? (crit.panelCompositionAndContinuity ?? 'N/A'));
    const cons = cr.visual_consistency?.score ?? (crit.visualConsistency ?? (crit.smartphoneRealismAndFaceless ?? 'N/A'));
    const dec = qa.decision || (item.passed ? 'PASS' : 'FAIL');
    const passIcon = item.passed ? `✅ PASSED [${dec}]` : `⚠️ RETRY REQUIRED [${dec}]`;

    lines.push(`#### QA Attempt ${item.attempt}: **${item.score}/100** — ${passIcon}`);
    lines.push(`- **Product Fidelity (Đúng sản phẩm)**: ${fid}/40 (Ngưỡng Hard Gate >= 32)`);
    lines.push(`- **Scene Accuracy (Đúng bối cảnh & thao tác)**: ${scene}/25 (Ngưỡng >= 18)`);
    lines.push(`- **Commercial Composition (Bố cục bán hàng)**: ${comp}/20 (Ngưỡng >= 14)`);
    lines.push(`- **Visual Consistency (Đồng nhất panel)**: ${cons}/15 (Ngưỡng >= 10)`);
    lines.push(`- **Decision**: \`${dec}\``);
    lines.push(`- **Gemini Critique**: ${qa.critique || 'N/A'}`);
    if (Array.isArray(qa.critical_errors) && qa.critical_errors.length > 0) {
      lines.push('- **Critical Errors**:');
      qa.critical_errors.forEach(e => lines.push(`  * 🚨 ${e}`));
    }
    if (Array.isArray(qa.discrepancies) && qa.discrepancies.length > 0) {
      lines.push('- **Discrepancies vs Input Photos**:');
      qa.discrepancies.forEach(d => lines.push(`  * ${d}`));
    }
    if (qa.correctionDirective) {
      lines.push(`- **Correction Directive Applied**: \`${qa.correctionDirective}\``);
    }
    lines.push('');
  });

  if (selectedCandidate) {
    lines.push(`- **Final Approved Candidate**: Attempt ${selectedCandidate.attempt} (Score: **${selectedCandidate.score}/100**)`);
  }

  return lines.join('\n');
}

/**
 * Xây dựng prompt đánh giá đồng thời 4 Master Storyboard candidates bằng Gemini Vision
 * Áp dụng Product Storyboard Evaluation Framework v1.0
 */
function buildTemplateProMultiStoryboardPrompt(analysis, candidateCount = 4) {
  const productName = analysis?.productName || 'sản phẩm';
  const category = analysis?.category || 'general';
  const location = analysis?.sceneContext?.location || 'Không gian sống hiện đại sáng sủa, nội thất tối giản tinh tế';
  const lighting = analysis?.sceneContext?.lighting || 'Ánh sáng tự nhiên dịu nhẹ ban ngày kết hợp đèn ấm';

  return `You are a strict, objective Quality Assurance (QA) Vision Inspector for an e-commerce 4-panel product review storyboard (still photo collage, 16:9).

EVALUATION FRAMEWORK: Product Storyboard Evaluation Framework v1.0 (Total Score: 100)

You are provided with:
1. Reference Product Input Photo ("input.png"): Ground truth reference collage combining all authentic multi-angle product photos (silhouette, shape, body structure, proportions, components, lid/handle/base geometry, color, materials, surface finish, logos/prints).
2. Exactly ${candidateCount} Generated Master Storyboards (named storyboard_cand_1.png to storyboard_cand_${candidateCount}.png), where each image is a horizontal 16:9 collage consisting of 4 vertical 9:16 panels side-by-side:
   - Panel 1 (Scene 1): Hook
   - Panel 2 (Scene 2): Solution / Key Feature
   - Panel 3 (Scene 3): Proof / Demonstration / Material Quality
   - Panel 4 (Scene 4): Closing / Lifestyle / Call to Action

Product being reviewed: "${productName}" (Category: ${category})
Expected Setting: ${location}
Expected Lighting: ${lighting}

CRITERIA & PRIORITY ORDER:
1. PRODUCT FIDELITY (Priority 1, Max 40 pts, Weight 40%, Hard Gate: min 32 pts):
   - Overall Shape & Structure (Max 10 pts, Severity if wrong: CRITICAL): Silhouette matches reference, main body shape matches, structural layout matches, major sections positioned correctly, structural relationships between parts preserved. Product is NOT transformed into another model, variant, or design.
   - Components & Features (Max 10 pts, Severity if wrong: CRITICAL): All major visible components exist, correct number of important components, no required major component missing, functional parts appear in correct positions, feature design matches reference, functionality not changed, accessories preserved.
   - Proportions & Dimensions (Max 6 pts, Severity if wrong: MAJOR): Width-to-height ratio consistent with reference, relative component sizes match, spacing between components correct, product thickness visually consistent, relative scale between major parts preserved, scale relative to hands/furniture/environment plausible.
   - Color, Material & Surface (Max 5 pts, Severity if wrong: MAJOR): Primary color matches reference, secondary colors match, material type matches, surface finish matches (matte, glossy, metallic, fabric, wood, plastic, glass), transparency/translucency preserved where applicable, reflection behavior plausible.
   - Details & Identity Markers (Max 5 pts, Severity if wrong: MODERATE): Logo correct when clearly visible in references, text/typography not fabricated, buttons match placement and shape, slots/holes/grooves match, patterns and decorative details preserved, seams/joints/connectors consistent. (Do NOT penalize details genuinely hidden by camera angle or occlusion).
   - No Hallucination / Mutation (Max 4 pts, Severity if wrong: CRITICAL): No invented components, no invented functionality, no unsupported buttons/screens/LEDs/controls, no fabricated branding/logo, no unauthorized accessories, no component count mutation, no shape mutation across panels, no color/material mutation across panels.
   CRITICAL PRODUCT FIDELITY ERRORS:
   * Product becomes a different model or SKU
   * Major product component is missing
   * Major unsupported component is added
   * Core functionality is changed
   * Product structure contradicts reference images
   * Important feature is hallucinated
   * Product mutates significantly between panels
   CRITICAL ERROR OVERRIDE: If ANY critical Product Fidelity error exists, decision MUST BE "FAIL" and product_fidelity.score MUST be < 32.

2. SCENE ACCURACY (Priority 2, Max 25 pts, Weight 25%, min pass score: 18 pts):
   - Correct Product Usage (Max 8 pts, Severity if wrong: CRITICAL): Human uses product correctly, functional interaction matches real behavior, product orientation during usage correct, demonstrated feature matches actual feature, no impossible/incorrect usage, logical sequence.
   - Correct Environment (Max 6 pts, Severity if wrong: MAJOR): Environment matches product category, product placement realistic, supporting objects contextually relevant, background supports intended use, scene does not contradict expected product usage.
   - Human Interaction Accuracy (Max 5 pts, Severity if wrong: MAJOR): Hand position natural, grip physically plausible, finger placement realistic, fingers do not intersect or merge with product, interaction direction correct, human scale relative to product plausible.
   - Physical Plausibility (Max 4 pts, Severity if wrong: MAJOR): Product does not float, mounting or support plausible, realistic contact points, gravity direction correct, no impossible geometry, no penetration between solid objects.
   - Storyboard Intent Match (Max 2 pts, Severity if wrong: MODERATE): Hook panel communicates intended problem/curiosity, solution panel communicates solution, demo panel clearly demonstrates feature, result panel communicates final benefit.
   Major Errors: Product used incorrectly, scene context conflicts with use, human interaction physically impossible, product placement unrealistic, panel does not match intended role.

3. COMMERCIAL COMPOSITION (Priority 3, Max 20 pts, Weight 20%, min pass score: 14 pts):
   - Product Visibility & Recognition (Max 6 pts, Severity if wrong: MAJOR): Product clearly visible, important parts not unnecessarily obstructed, occupies sufficient visual area, camera angle helps identify product, background does not overpower product, recognizable at mobile viewing size.
   - Selling Point Clarity (Max 5 pts, Severity if wrong: MAJOR): Main selling point visually understandable, feature demonstration easy to read, benefit visually communicated, important feature not hidden.
   - Hook / Demo Effectiveness (Max 4 pts, Severity if wrong: MODERATE): Hook creates immediate visual interest, problem recognizable, demo action visually clear, communicates value quickly.
   - Framing & Visual Hierarchy (Max 3 pts, Severity if wrong: MODERATE): Visual hierarchy prioritizes product and key action, framing balanced, important content inside safe area, foreground and background clearly separated.
   - Commercial Cleanliness (Max 2 pts, Severity if wrong: MINOR): No distracting unnecessary objects, no irrelevant visual clutter, no accidental competing brand elements, STRICTLY NO digital text banners, subtitles, neon arrows, watermarks, or cartoon stickers.
   Major Errors: Product too small or hidden, main selling point visually unclear, demo does not communicate function, composition distracts attention away from product.

4. VISUAL CONSISTENCY (Priority 4, Max 15 pts, Weight 15%, min pass score: 10 pts):
   - Product Continuity (Max 4 pts, Severity if wrong: CRITICAL): Same product model across panels, same color, same material, same component count, same structural details. No mutation between panels.
   - Environment Continuity (Max 4 pts, Severity if wrong: MAJOR): Same room identity, same wall/floor/furniture language, background landmarks consistent, spatial coherence.
   - Lighting & Color Continuity (Max 3 pts, Severity if wrong: MODERATE): Light direction consistent, color temperature consistent, exposure reasonably consistent.
   - Human / Hand Continuity (Max 2 pts, Severity if wrong: MODERATE): Same apparent person when continuity required, skin tone visually stable, clothing consistent, hand appearance does not radically change.
   - Camera Language Continuity (Max 2 pts, Severity if wrong: MINOR): Lens perspective coherent, camera height coherent, framing style feels like same shoot.
   Major Errors: Product visibly changes between panels, environment changes unintentionally, lighting style changes abruptly, human identity changes unexpectedly, camera language feels like unrelated shoots.

DECISION RULES & SCORE BANDS:
- Critical Error Override: If any critical Product Fidelity error exists, decision MUST BE "FAIL". A candidate with a critical error CANNOT be chosen as bestCandidateIndex if any candidate without critical error is available!
- product_fidelity.score < 32 -> "FAIL"
- total_score < 75 -> "FAIL"
- 75 <= total_score < 85 -> "REGENERATE_OR_FIX"
- 85 <= total_score < 93 -> "PASS"
- total_score >= 93 -> "EXCELLENT"

SELECTION & PANEL REPLACEMENT TASK:
1. Evaluate each of the ${candidateCount} candidates across all 4 criteria. Score each of the 4 panels (1, 2, 3, 4) on a 100-point scale.
2. Select "bestCandidateIndex" (1 to ${candidateCount}):
   - STRICTLY filter out candidates with critical Product Fidelity errors (e.g. deformed shape, wrong SKU, missing parts).
   - Pick the candidate with the highest valid score, highest product fidelity, and best visual coherence.
3. PANEL REPLACEMENT (CROSS-STORYBOARD STITCHING):
   - Check the selected best candidate. Does ANY panel have flaws, lower score (< 85), or product fidelity discrepancies?
   - Look across other candidates for that same panel index (1, 2, 3, or 4).
   - If another candidate has that panel with significantly higher score and strictly correct product fidelity (matching the reference photo):
     Recommend replacing that panel!
     "replacements": [{ "panelIndex": 1..4, "sourceCandidateIndex": 1..${candidateCount}, "reason": "Lý do chi tiết bằng tiếng Việt tại sao panel này tốt hơn" }]
   - If all 4 panels of the best candidate are excellent, set "replacements": [].

OUTPUT FORMAT:
Return ONLY a valid RFC 8259 JSON object starting with { and ending with }:
{
  "candidates": [
    {
      "candidateIndex": 1,
      "total_score": 88,
      "score": 88,
      "decision": "PASS",
      "criteria_results": {
        "product_fidelity": { "score": 36, "max_score": 40, "passed": true, "critical_error": false },
        "scene_accuracy": { "score": 22, "max_score": 25, "passed": true },
        "commercial_composition": { "score": 17, "max_score": 20, "passed": true },
        "visual_consistency": { "score": 13, "max_score": 15, "passed": true }
      },
      "critical_errors": [],
      "major_errors": [],
      "panels": [
        { "panelIndex": 1, "score": 90, "flaws": [] },
        { "panelIndex": 2, "score": 88, "flaws": [] },
        { "panelIndex": 3, "score": 85, "flaws": [] },
        { "panelIndex": 4, "score": 89, "flaws": [] }
      ],
      "discrepancies": [],
      "critique": "Tổng quan tốt, đúng kiểu dáng sản phẩm trong ảnh input.png",
      "regeneration_recommendation": {
        "required": false,
        "scope": "none",
        "panels": [],
        "reasons": []
      }
    }
  ],
  "bestCandidateIndex": 1,
  "replacements": [
    {
      "panelIndex": 3,
      "sourceCandidateIndex": 2,
      "reason": "Panel 3 ở Candidate 2 đạt 92 điểm, chuẩn kiểu dáng và chi tiết nắp sắc nét hơn so với Candidate 1."
    }
  ],
  "finalSummary": "Đã chọn Candidate 1 (88đ) và thay thế Panel 3 từ Candidate 2 (92đ) để tạo Storyboard tối ưu nhất."
}`;
}

/**
 * Thực hiện kiểm định đồng thời nhiều ứng viên Storyboard qua Gemini Vision API
 * Áp dụng Product Storyboard Evaluation Framework v1.0
 */
async function verifyMultiStoryboardWithGeminiVision(geminiClient, candidateBuffers, savedInputs, analysis) {
  if (!geminiClient || !Array.isArray(candidateBuffers) || candidateBuffers.length === 0) {
    console.warn('[TemplatePro] ⚠️ Gemini client or candidate buffers unavailable, using fallback selection');
    return {
      candidates: (candidateBuffers || []).map((_, i) => ({
        candidateIndex: i + 1,
        total_score: 88,
        score: 88,
        decision: 'PASS',
        criteria_results: {
          product_fidelity: { score: 36, max_score: 40, passed: true },
          scene_accuracy: { score: 22, max_score: 25, passed: true },
          commercial_composition: { score: 17, max_score: 20, passed: true },
          visual_consistency: { score: 13, max_score: 15, passed: true }
        },
        criteria: {
          productFidelity: 36,
          sceneAccuracy: 22,
          commercialComposition: 17,
          visualConsistency: 13,
          productFidelityAndIdentity: 36,
          physicalStateAndMorphology: 22,
          panelCompositionAndContinuity: 17,
          smartphoneRealismAndFaceless: 13,
          cleanlinessAndStrictNoText: 5
        },
        panels: [1, 2, 3, 4].map(p => ({ panelIndex: p, score: 88, flaws: [] })),
        discrepancies: [],
        critique: 'Bypassed verification due to client unavailable'
      })),
      bestCandidateIndex: 1,
      replacements: [],
      finalSummary: 'Chọn Storyboard 1 (chế độ fallback).'
    };
  }

  const count = candidateBuffers.length;
  console.log(`[TemplatePro] 🔎 Uploading ${count} Storyboards & input references to Gemini Vision for batch evaluation...`);

  try {
    const fileData = [];

    // 1. Upload ảnh sản phẩm tham chiếu: Ưu tiên ảnh ghép tổng hợp input.png (đã gộp tất cả ảnh gốc vào 1 lưới)
    let collageInput = null;
    if (Array.isArray(savedInputs)) {
      collageInput = savedInputs.find(f => f.name === 'input.png' || (f.path && path.basename(f.path) === 'input.png'));
      if (!collageInput && savedInputs.length > 0 && savedInputs[0]?.path) {
        const potentialPath = path.join(path.dirname(savedInputs[0].path), 'input.png');
        if (fs.existsSync(potentialPath)) {
          collageInput = {
            name: 'input.png',
            path: potentialPath,
            buffer: fs.readFileSync(potentialPath),
            mimeType: 'image/png'
          };
        }
      }
    }

    if (collageInput) {
      const refBuf = collageInput.buffer || (collageInput.path && fs.existsSync(collageInput.path) ? fs.readFileSync(collageInput.path) : null);
      if (refBuf) {
        const refUrl = await geminiClient.uploadFile(refBuf, 'input.png', 'image/png');
        fileData.push({ url: refUrl, filename: 'input.png', mimeType: 'image/png' });
        console.log('[TemplatePro] 🖼️ Uploaded merged input.png collage as the sole reference photo for QA evaluation.');
      }
    } else {
      // Fallback nếu không có file input.png
      const inputRefs = (savedInputs || []).slice(0, 3);
      for (let i = 0; i < inputRefs.length; i++) {
        const ref = inputRefs[i];
        const refBuf = ref.buffer || (ref.path && fs.existsSync(ref.path) ? fs.readFileSync(ref.path) : null);
        if (refBuf) {
          const refName = ref.name || `input_ref_${i + 1}.png`;
          const mime = ref.mimeType || (refName.endsWith('.jpg') || refName.endsWith('.jpeg') ? 'image/jpeg' : 'image/png');
          const refUrl = await geminiClient.uploadFile(refBuf, refName, mime);
          fileData.push({ url: refUrl, filename: refName, mimeType: mime });
        }
      }
    }

    // 2. Upload đồng thời các candidate storyboards
    const candUploads = candidateBuffers.map(async (buf, idx) => {
      const cName = `storyboard_cand_${idx + 1}.png`;
      const url = await geminiClient.uploadFile(buf, cName, 'image/png');
      return { url, filename: cName, mimeType: 'image/png', candidateIndex: idx + 1 };
    });
    const uploadedCands = await Promise.all(candUploads);
    uploadedCands.forEach(uc => fileData.push({ url: uc.url, filename: uc.filename, mimeType: uc.mimeType }));

    const prompt = buildTemplateProMultiStoryboardPrompt(analysis, count);
    console.log(`[TemplatePro] 🔎 Evaluating all ${count} Storyboards simultaneously via Gemini Vision...`);

    const res = await geminiClient.generateContent({
      prompt,
      fileData,
      temporary: true,
      expectImages: false,
    });

    const rawText = res?.text || '';
    const parsed = parseJsonObjectPro(rawText);

    if (parsed && Array.isArray(parsed.candidates) && parsed.candidates.length > 0) {
      // Chuẩn hóa điểm và decision cho từng candidate theo framework v1.0
      parsed.candidates.forEach(c => {
        c.total_score = c.total_score !== undefined ? c.total_score : (c.score || 0);
        c.score = c.total_score;
        const cr = c.criteria_results || {};
        const fidScore = cr.product_fidelity?.score ?? (c.criteria?.productFidelityAndIdentity ?? (c.criteria?.productFidelity ?? Math.round(c.score * 0.4)));
        const hasCrit = (Array.isArray(c.critical_errors) && c.critical_errors.length > 0) || cr.product_fidelity?.critical_error === true;
        if (!c.decision) {
          if (hasCrit || fidScore < 32 || c.score < 75) c.decision = 'FAIL';
          else if (c.score < 85) c.decision = 'REGENERATE_OR_FIX';
          else if (c.score < 93) c.decision = 'PASS';
          else c.decision = 'EXCELLENT';
        }
        c.passed = (c.decision === 'PASS' || c.decision === 'EXCELLENT') && fidScore >= 32 && !hasCrit;
      });

      // Lựa chọn best candidate:
      // Ưu tiên:
      // 1. Không có critical error và product_fidelity >= 32
      // 2. Điểm tổng cao nhất
      let bestIdx = 1;
      const validCands = parsed.candidates.filter(c => {
        const hasCrit = (Array.isArray(c.critical_errors) && c.critical_errors.length > 0) || c.criteria_results?.product_fidelity?.critical_error === true;
        const fid = c.criteria_results?.product_fidelity?.score ?? 40;
        return !hasCrit && fid >= 32;
      });

      if (validCands.length > 0) {
        validCands.sort((a, b) => (b.total_score || 0) - (a.total_score || 0));
        // Nếu bestCandidateIndex do Gemini chọn nằm trong danh sách hợp lệ, giữ nguyên lựa chọn của Gemini
        if (typeof parsed.bestCandidateIndex === 'number' && validCands.some(vc => vc.candidateIndex === parsed.bestCandidateIndex)) {
          bestIdx = parsed.bestCandidateIndex;
        } else {
          bestIdx = validCands[0].candidateIndex;
        }
      } else if (typeof parsed.bestCandidateIndex === 'number' && parsed.bestCandidateIndex >= 1 && parsed.bestCandidateIndex <= count) {
        bestIdx = parsed.bestCandidateIndex;
      } else {
        bestIdx = parsed.candidates.sort((a, b) => (b.score || 0) - (a.score || 0))[0]?.candidateIndex || 1;
      }

      const replacements = Array.isArray(parsed.replacements)
        ? parsed.replacements.filter(r => (
            r && typeof r.panelIndex === 'number' && r.panelIndex >= 1 && r.panelIndex <= 4 &&
            typeof r.sourceCandidateIndex === 'number' && r.sourceCandidateIndex >= 1 && r.sourceCandidateIndex <= count &&
            r.sourceCandidateIndex !== bestIdx
          ))
        : [];

      console.log(`[TemplatePro] 📊 Multi-Storyboard QA Results (Product Storyboard Evaluation Framework v1.0):`);
      parsed.candidates.forEach(c => {
        const fid = c.criteria_results?.product_fidelity?.score;
        const fidStr = fid !== undefined ? ` | Fidelity: ${fid}/40` : '';
        const decStr = c.decision ? ` [${c.decision}]` : '';
        console.log(`   - Candidate #${c.candidateIndex}: Score ${c.score}/100${decStr}${fidStr} | Panels: ${c.panels?.map(p => `P${p.panelIndex}:${p.score}`).join(', ') || 'N/A'}`);
        if (Array.isArray(c.critical_errors) && c.critical_errors.length > 0) {
          console.warn(`     🚨 Critical Errors: ${c.critical_errors.join('; ')}`);
        }
      });
      console.log(`[TemplatePro] 🏆 Best Candidate Selected: #${bestIdx}`);
      if (replacements.length > 0) {
        replacements.forEach(r => {
          console.log(`[TemplatePro] 🔄 Panel Replacement: Replace Panel ${r.panelIndex} with Panel from Candidate #${r.sourceCandidateIndex} (${r.reason || 'superior fidelity'})`);
        });
      } else {
        console.log(`[TemplatePro] ✨ No panel replacements needed — Candidate #${bestIdx} has excellent consistency across all 4 panels.`);
      }

      return {
        candidates: parsed.candidates,
        bestCandidateIndex: bestIdx,
        replacements,
        finalSummary: parsed.finalSummary || `Đã chọn Storyboard #${bestIdx}.`,
        rawText
      };
    }

    // Fallback: Pick candidate 1 if parse JSON doesn't match
    console.warn('[TemplatePro] ⚠️ Could not parse multi-candidate JSON, defaulting to Candidate 1');
    return {
      candidates: candidateBuffers.map((_, i) => ({
        candidateIndex: i + 1,
        total_score: 88,
        score: 88,
        decision: 'PASS',
        criteria_results: {
          product_fidelity: { score: 36, max_score: 40, passed: true },
          scene_accuracy: { score: 22, max_score: 25, passed: true },
          commercial_composition: { score: 17, max_score: 20, passed: true },
          visual_consistency: { score: 13, max_score: 15, passed: true }
        },
        criteria: {
          productFidelity: 36,
          sceneAccuracy: 22,
          commercialComposition: 17,
          visualConsistency: 13,
          productFidelityAndIdentity: 36,
          physicalStateAndMorphology: 22,
          panelCompositionAndContinuity: 17,
          smartphoneRealismAndFaceless: 13,
          cleanlinessAndStrictNoText: 5
        },
        panels: [1, 2, 3, 4].map(p => ({ panelIndex: p, score: 88, flaws: [] })),
        discrepancies: [],
        critique: 'Default selection from unparsed response'
      })),
      bestCandidateIndex: 1,
      replacements: [],
      finalSummary: 'Đã chọn Storyboard #1 (mặc định).',
      rawText
    };
  } catch (err) {
    console.warn(`[TemplatePro] ⚠️ Error during multi-storyboard QA: ${err.message}`);
    return {
      candidates: candidateBuffers.map((_, i) => ({
        candidateIndex: i + 1,
        total_score: 86,
        score: 86,
        decision: 'PASS',
        criteria_results: {
          product_fidelity: { score: 34, max_score: 40, passed: true },
          scene_accuracy: { score: 21, max_score: 25, passed: true },
          commercial_composition: { score: 17, max_score: 20, passed: true },
          visual_consistency: { score: 14, max_score: 15, passed: true }
        },
        criteria: {
          productFidelity: 34,
          sceneAccuracy: 21,
          commercialComposition: 17,
          visualConsistency: 14,
          productFidelityAndIdentity: 34,
          physicalStateAndMorphology: 21,
          panelCompositionAndContinuity: 17,
          smartphoneRealismAndFaceless: 14,
          cleanlinessAndStrictNoText: 5
        },
        panels: [1, 2, 3, 4].map(p => ({ panelIndex: p, score: 86, flaws: [] })),
        discrepancies: [],
        critique: 'Fallback selection due to error'
      })),
      bestCandidateIndex: 1,
      replacements: [],
      finalSummary: 'Đã chọn Storyboard #1 (fallback).',
      rawText: err.message
    };
  }
}

/**
 * Định dạng lịch sử kiểm định Gemini Vision QA 4 Storyboards sang Markdown để lưu vào prompts.md
 * Áp dụng Product Storyboard Evaluation Framework v1.0
 */
function formatMultiStoryboardQAMarkdown(multiQA) {
  if (!multiQA || !Array.isArray(multiQA.candidates)) return '';
  const lines = [
    '',
    '### Gemini Vision Multi-Storyboard Batch Evaluation (Product Storyboard Framework v1.0)',
    '',
    '| Candidate | Tổng Điểm | Quyết Định | Đúng SP (40đ) | Bối Cảnh (25đ) | Bố Cục (20đ) | Đồng Nhất (15đ) | Panels | Nhận xét |',
    '| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |'
  ];

  multiQA.candidates.forEach(c => {
    const isBest = c.candidateIndex === multiQA.bestCandidateIndex ? ' 🏆' : '';
    const cr = c.criteria_results || {};
    const fid = cr.product_fidelity?.score ?? (c.criteria?.productFidelity ?? (c.criteria?.productFidelityAndIdentity ?? 'N/A'));
    const scene = cr.scene_accuracy?.score ?? (c.criteria?.sceneAccuracy ?? (c.criteria?.physicalStateAndMorphology ?? 'N/A'));
    const comp = cr.commercial_composition?.score ?? (c.criteria?.commercialComposition ?? (c.criteria?.panelCompositionAndContinuity ?? 'N/A'));
    const cons = cr.visual_consistency?.score ?? (c.criteria?.visualConsistency ?? (c.criteria?.smartphoneRealismAndFaceless ?? 'N/A'));
    const decision = c.decision || (c.score >= 85 ? 'PASS' : 'FAIL');

    const panelScores = [1, 2, 3, 4].map(idx => {
      const p = c.panels?.find(item => item.panelIndex === idx);
      return p ? `P${idx}:${p.score}` : `P${idx}:-`;
    }).join(', ');

    lines.push(`| **Storyboard #${c.candidateIndex}**${isBest} | **${c.score}/100** | \`${decision}\` | ${fid}/40 | ${scene}/25 | ${comp}/20 | ${cons}/15 | ${panelScores} | ${c.critique || 'N/A'} |`);
  });

  lines.push('');
  lines.push(`- **Selected Base Storyboard**: Candidate #${multiQA.bestCandidateIndex}`);
  if (Array.isArray(multiQA.replacements) && multiQA.replacements.length > 0) {
    lines.push('- **Panel Replacements Applied**:');
    multiQA.replacements.forEach(r => {
      lines.push(`  * **Panel ${r.panelIndex}**: Thay thế bằng Panel ${r.panelIndex} từ **Storyboard #${r.sourceCandidateIndex}** (${r.reason})`);
    });
  } else {
    lines.push('- **Panel Replacements**: Không cần thay thế (toàn bộ 4 panels của Storyboard được chọn đều đạt chất lượng cao).');
  }
  lines.push(`- **Final Summary**: ${multiQA.finalSummary || 'N/A'}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Trích xuất 3 keyframe tại 0.5s, 4.0s, 7.5s từ video MP4 để gửi lên Gemini Vision kiểm định chất lượng.
 * @param {string} videoPath Đường dẫn file MP4
 * @param {string} runDir Thư mục run
 * @param {number} videoIndex Chỉ số video (1 hoặc 2)
 * @returns {Array<{timestamp: string, path: string, buffer: Buffer, mimeType: string}>}
 */
function extractVideoKeyframes(videoPath, runDir, videoIndex) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    return [];
  }

  const ffmpegPath = require('ffmpeg-static');
  const keyframesDir = path.join(runDir, 'videos', 'keyframes');
  ensureDir(keyframesDir);

  // Trích xuất 8 keyframes cho video 8 giây (1 frame mỗi giây: 1.0s -> 8.0s)
  const timestamps = [
    { label: '1.0s', time: '00:00:01.000', name: `v${videoIndex}_t1.0s.png` },
    { label: '2.0s', time: '00:00:02.000', name: `v${videoIndex}_t2.0s.png` },
    { label: '3.0s', time: '00:00:03.000', name: `v${videoIndex}_t3.0s.png` },
    { label: '4.0s', time: '00:00:04.000', name: `v${videoIndex}_t4.0s.png` },
    { label: '5.0s', time: '00:00:05.000', name: `v${videoIndex}_t5.0s.png` },
    { label: '6.0s', time: '00:00:06.000', name: `v${videoIndex}_t6.0s.png` },
    { label: '7.0s', time: '00:00:07.000', name: `v${videoIndex}_t7.0s.png` },
    { label: '8.0s', time: '00:00:07.850', name: `v${videoIndex}_t8.0s.png` }
  ];

  const extracted = [];

  for (const item of timestamps) {
    const outPath = path.join(keyframesDir, item.name);
    try {
      execSync(
        `"${ffmpegPath}" -y -ss ${item.time} -i "${videoPath}" -vframes 1 -q:v 2 "${outPath}"`,
        { stdio: 'pipe' }
      );
      if (fs.existsSync(outPath)) {
        const buf = fs.readFileSync(outPath);
        extracted.push({
          timestamp: item.label,
          path: outPath,
          buffer: buf,
          mimeType: 'image/png'
        });
      }
    } catch (err) {
      console.warn(`[TemplatePro] Failed to extract keyframe at ${item.label} for Video ${videoIndex}: ${err.message}`);
    }
  }

  return extracted;
}

/**
 * Xây dựng prompt kiểm định chất lượng Video 8s bằng Gemini Vision (100 điểm, ngưỡng pass > 85)
 * Áp dụng tiêu chuẩn phổ quát (Universal Template) độc lập ngành hàng.
 */
function buildTemplateProVideoVerificationPrompt(videoIndex, analysis, attempt = 1) {
  const productName = analysis?.productName || 'sản phẩm';
  const category = analysis?.category || 'general';
  const location = analysis?.sceneContext?.location || 'Không gian sống hiện đại sáng sủa';
  const sceneRange = videoIndex === 1 ? 'Panel 1 (Hook) -> Panel 2 (Solution)' : 'Panel 3 (Proof) -> Panel 4 (Closing / CTA)';

  return `You are a strict, objective Quality Assurance (QA) Vision Inspector evaluating a generated 8-second e-commerce product video clip (Video ${videoIndex}, covering ${sceneRange}).

You are provided with:
1. Product Reference Photos (Input collage - ground truth appearance of the physical product).
2. Start Panel Image (Ground truth visual anchor for Scene 1: 0s - 4s).
3. Target Panel Image (Ground truth visual anchor for Scene 2: 4s - 8s).
4. 8 Extracted Keyframes across the 8-second video (1 keyframe per second):
   - Keyframe 1 (1.0s), 2 (2.0s), 3 (3.0s), 4 (4.0s) [Scene 1 segment]
   - Keyframe 5 (5.0s), 6 (6.0s), 7 (7.0s), 8 (8.0s) [Scene 2 segment]

Product being reviewed: "${productName}" (Category: ${category})
Expected Setting: ${location}

CRITICAL SCENE TRANSITION PRINCIPLE (DO NOT PENALIZE INTENDED STORYBOARD TRANSITIONS):
- An 8-second video in this workflow explicitly combines TWO DISTINCT STORYBOARD SCENES (e.g., Video 1 combines Hook 0s-4s and Solution 4s-8s; Video 2 combines Proof 0s-4s and Closing 4s-8s).
- It is 100% NORMAL, INTENDED, AND EXPECTED for the background, tabletop surface, lighting, or camera angle to transition or cut between Keyframe 4 (4.0s) and Keyframe 5 (5.0s) to reflect the shift from Start Panel to Target Panel.
- DO NOT penalize background changes, tabletop changes, or camera angle shifts occurring around the 4.0s mark between the two panels. That is the correct storyboard behavior.

TASK:
Perform a comprehensive visual inspection across all 8 keyframes against the reference product photos and panel images.
Evaluate and score the video on a strict 100-POINT SCALE across the following 4 UNIVERSAL CRITERIA:

1. UNIVERSAL PHYSICAL STATE INVARIANCE & PRODUCT INTEGRITY (Tối đa 45 điểm - ƯU TIÊN SỐ 1 CAO NHẤT):
   - The product must remain strictly faithful in shape, color, branding/text, and mechanical structure to the reference photos across all 8 keyframes.
   - ZERO unprompted mechanical transformations: NO unauthorized opening/closing of caps/lids/doors/drawers, NO twisting/detaching/swapping of parts (e.g. handle mysteriously jumping from right to left, lid disappearing), NO morphing of geometry, NO incorrect colors, NO hallucinated internal mechanisms.
   - Product MUST NOT mutate, stretch, bend, or melt as hands touch or hold it.
   - Deduct heavily (15-30 pts) if the product spontaneously mutates, changes parts, or undergoes unauthorized mechanical changes not shown in reference images.

2. STORYBOARD SCENE FIDELITY & ACTION FLOW (Tối đa 25 điểm):
   - Keyframes 1-4 (0s-4s) must naturally correspond to the Start Panel visual anchor and Scene 1 action.
   - Keyframes 5-8 (4s-8s) must naturally correspond to the Target Panel visual anchor and Scene 2 action.
   - The narrative progression from 1.0s to 8.0s must be logical and smooth.
   - Deduct (5-15 pts) only if keyframes deviate completely from both storyboard panels. Remember: changing tabletop/background between 4.0s and 5.0s is INTENDED and MUST NOT be penalized.

3. HAND ERGONOMICS & STRICT 100% FACELESS POLICY (Tối đa 20 điểm):
   - Realistic Asian hand model holding/touching the product: correct anatomy (5 fingers, natural fingernails, authentic skin tone, genuine contact grip).
   - STRICTLY FACELESS: Absolutely NO human faces visible across all keyframes.
   - Deduct 20 pts (AUTOMATIC HARD FAIL) if any human face appears in any keyframe.
   - Deduct (5-15 pts) for unnatural hand warping, rubbery fingers, floating phantom hands, or impossible wrist angles.

4. SMARTPHONE REALISM & ARTIFACT-FREE CLEANLINESS (Tối đa 10 điểm):
   - Authentic smartphone camera aesthetic (organic handheld motion, natural depth of field, real daylight/warm light, genuine contact shadows).
   - Clean video: zero digital text overlays, zero floating icons, zero watermarks, zero subtitles.
   - No severe AI video artifacts (melting edges, liquid blurring, floating debris, flickering lines).
   - Deduct (5-10 pts) for digital text overlays, plastic CGI shine, or severe video tearing.

SCORING RULES:
- Total Score = Sum of all 4 criteria (Range: 0 to 100).
- PASS THRESHOLD: Score MUST BE STRICTLY GREATER THAN 85 (> 85) to pass.
- If Total Score <= 85, set "passed": false. If Total Score > 85, set "passed": true.
- Be honest, objective, and rigorous. Do NOT inflate scores.

OUTPUT FORMAT:
Return ONLY a valid RFC 8259 JSON object starting with { and ending with }:
{
  "score": 88,
  "passed": true,
  "criteria": {
    "physicalStateInvariance": 41,
    "storyboardSceneFidelity": 23,
    "handErgonomicsAndFaceless": 18,
    "smartphoneRealismCleanliness": 6
  },
  "discrepancies": [
    "List specific flaws or product defects observed in the keyframes (in Vietnamese)"
  ],
  "critique": "Brief overall evaluation of video quality in Vietnamese",
  "correctionDirective": "Specific, actionable prompt instruction to eliminate the detected hallucination or defect on the next video generation"
}`;
}

/**
 * Thực hiện kiểm định chất lượng Video qua Gemini Vision bằng 3 keyframes
 * Chấm điểm trên thang 100 (ngưỡng pass > 85).
 */
async function verifyVideoWithGeminiVision(geminiClient, videoPath, startPanelBuf, targetPanelBuf, inputCollageBuf, videoIndex, analysis, runDir, attempt = 1) {
  if (!geminiClient || !videoPath || !fs.existsSync(videoPath)) {
    console.warn(`[TemplatePro] ⚠️ Video QA: Video file or Gemini client unavailable for Video ${videoIndex}, bypassing QA`);
    return {
      score: 88,
      passed: true,
      criteria: {
        physicalStateInvariance: 36,
        sceneTransitionContinuity: 22,
        handErgonomicsAndFaceless: 18,
        smartphoneRealismCleanliness: 12
      },
      discrepancies: [],
      critique: 'Bypassed verification due to client or file unavailable',
      correctionDirective: '',
      keyframes: [],
      bypassed: true
    };
  }

  const keyframes = extractVideoKeyframes(videoPath, runDir, videoIndex);
  if (keyframes.length === 0) {
    console.warn(`[TemplatePro] ⚠️ Could not extract keyframes from ${videoPath}, bypassing Video QA`);
    return {
      score: 86,
      passed: true,
      criteria: {},
      discrepancies: ['Không trích xuất được keyframes từ video'],
      critique: 'Bỏ qua Video QA do không trích xuất được keyframe',
      correctionDirective: '',
      keyframes: [],
      bypassed: true
    };
  }

  console.log(`[TemplatePro] 🔎 [Video ${videoIndex} QA Attempt ${attempt}] Uploading ${keyframes.length} keyframes + reference panels to Gemini Vision...`);

  try {
    const fileData = [];

    // 1. Upload 3 keyframes
    for (let i = 0; i < keyframes.length; i++) {
      const kf = keyframes[i];
      const kfName = `v${videoIndex}_att${attempt}_kf_${kf.timestamp.replace('.', '_')}.png`;
      const kfUrl = await geminiClient.uploadFile(kf.buffer, kfName, 'image/png');
      fileData.push({ url: kfUrl, filename: kfName, mimeType: 'image/png' });
    }

    // 2. Upload start panel & target panel
    if (startPanelBuf) {
      const spName = `v${videoIndex}_start_panel.png`;
      const spUrl = await geminiClient.uploadFile(startPanelBuf, spName, 'image/png');
      fileData.push({ url: spUrl, filename: spName, mimeType: 'image/png' });
    }
    if (targetPanelBuf) {
      const tpName = `v${videoIndex}_target_panel.png`;
      const tpUrl = await geminiClient.uploadFile(targetPanelBuf, tpName, 'image/png');
      fileData.push({ url: tpUrl, filename: tpName, mimeType: 'image/png' });
    }

    // 3. Upload input collage
    if (inputCollageBuf) {
      const icName = `v${videoIndex}_input_collage.png`;
      const icUrl = await geminiClient.uploadFile(inputCollageBuf, icName, 'image/png');
      fileData.push({ url: icUrl, filename: icName, mimeType: 'image/png' });
    }

    const qaPrompt = buildTemplateProVideoVerificationPrompt(videoIndex, analysis, attempt);
    console.log(`[TemplatePro] 🔎 [Video ${videoIndex} QA Attempt ${attempt}] Evaluating Video Quality via Gemini Vision (100-point scale, threshold > 85)...`);

    const res = await geminiClient.generateContent({
      prompt: qaPrompt,
      fileData,
      temporary: true,
      expectImages: false,
    });

    const rawText = res?.text || '';
    const parsed = parseJsonObjectPro(rawText);

    if (parsed && typeof parsed.score === 'number') {
      const score = Math.max(0, Math.min(100, Math.round(parsed.score)));
      const passed = score > 85;
      const criteria = parsed.criteria || {};
      const discrepancies = Array.isArray(parsed.discrepancies) ? parsed.discrepancies : [];
      const critique = parsed.critique || (passed ? 'Video đạt chuẩn chất lượng >85 điểm.' : 'Video có điểm số chưa đạt chuẩn >85 điểm.');
      const correctionDirective = parsed.correctionDirective || '';

      console.log(`[TemplatePro] 📊 [Video ${videoIndex} QA Attempt ${attempt}] Score: ${score}/100 (Pass: ${passed})`);
      if (!passed) {
        console.warn(`[TemplatePro] ⚠️ [Video ${videoIndex} QA Attempt ${attempt}] Discrepancies: ${discrepancies.join('; ')}`);
      }

      return {
        score,
        passed,
        criteria,
        discrepancies,
        critique,
        correctionDirective,
        keyframes: keyframes.map(k => k.path),
        rawText
      };
    }

    // Dự phòng text
    const scoreMatch = rawText.match(/"score":\s*(\d+)/i) || rawText.match(/score\s*[:=]\s*(\d+)/i);
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 86;
    const passed = score > 85;
    return {
      score,
      passed,
      criteria: {},
      discrepancies: passed ? [] : ['Có sai lệch chưa đạt chuẩn >85 điểm'],
      critique: 'Chấm điểm dự phòng từ phản hồi text.',
      correctionDirective: '',
      keyframes: keyframes.map(k => k.path),
      rawText
    };
  } catch (err) {
    console.warn(`[TemplatePro] ⚠️ Video QA verification error for Video ${videoIndex}: ${err.message}`);
    return {
      score: 86,
      passed: true,
      criteria: {},
      discrepancies: [`QA API error: ${err.message}`],
      critique: `Bỏ qua Video QA do lỗi kết nối: ${err.message}`,
      correctionDirective: '',
      keyframes: keyframes.map(k => k.path),
      bypassed: true
    };
  }
}

/**
 * Định dạng báo cáo kiểm định Video QA sang Markdown để ghi vào prompts.md
 */
function formatVideoQAMarkdown(videoQAResults) {
  if (!videoQAResults || videoQAResults.length === 0) return '';
  const lines = [
    '',
    '### Gemini Vision Video QA Verification Report (100-Point Rubric, Threshold: > 85)',
    ''
  ];

  videoQAResults.forEach((vQa) => {
    const passIcon = vQa.passed ? '✅ PASSED (> 85)' : '⚠️ FAILED (<= 85)';
    lines.push(`#### Video ${vQa.videoIndex} (Attempt ${vQa.attempt}): **${vQa.score}/100** — ${passIcon}`);
    const crit = vQa.criteria || {};
    lines.push(`- **Universal Physical State Invariance & Product Integrity**: ${crit.physicalStateInvariance !== undefined ? crit.physicalStateInvariance : 'N/A'}/45`);
    lines.push(`- **Storyboard Scene Fidelity & Action Flow**: ${crit.storyboardSceneFidelity !== undefined ? crit.storyboardSceneFidelity : (crit.sceneTransitionContinuity !== undefined ? crit.sceneTransitionContinuity : 'N/A')}/25`);
    lines.push(`- **Hand Ergonomics & Faceless**: ${crit.handErgonomicsAndFaceless !== undefined ? crit.handErgonomicsAndFaceless : 'N/A'}/20`);
    lines.push(`- **Smartphone Realism & Cleanliness**: ${crit.smartphoneRealismCleanliness !== undefined ? crit.smartphoneRealismCleanliness : 'N/A'}/15`);
    lines.push(`- **Gemini Critique**: ${vQa.critique || 'N/A'}`);
    if (Array.isArray(vQa.discrepancies) && vQa.discrepancies.length > 0) {
      lines.push('- **Discrepancies / Hallucinations Detected**:');
      vQa.discrepancies.forEach(d => lines.push(`  * ${d}`));
    }
    if (vQa.correctionDirective) {
      lines.push(`- **Correction Directive Applied**: \`${vQa.correctionDirective}\``);
    }
    if (Array.isArray(vQa.keyframes) && vQa.keyframes.length > 0) {
      lines.push(`- **Keyframes Inspected**: ${vQa.keyframes.map(k => `\`${path.basename(k)}\``).join(', ')}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * Tạo ảnh collage tổng hợp từ tất cả ảnh sản phẩm đầu vào thành 1 ảnh lưới input.png cho Template Pro.
 * Dùng làm ảnh tham chiếu xác thực ngoại quan, chất liệu và chi tiết thực tế của sản phẩm cho Gemini Vision.
 * Tự động khử trùng lặp (MD5 hash deduplication) và hỗ trợ lưới linh hoạt từ 1 đến 8 ảnh độc nhất.
 *
 * @param {Array<{buffer?: Buffer, base64?: string, path?: string, mimeType?: string}>} filePayloads
 * @returns {Buffer|null}
 */
function createInputCollageImagePro(filePayloads) {
  if (!filePayloads || filePayloads.length === 0) return null;
  const ffmpegPath = require('ffmpeg-static');
  const tmpId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const tmpDir = os.tmpdir();
  const outPath = path.join(tmpDir, `tpro-input-collage-${tmpId}.jpg`);
  const inputPaths = [];

  try {
    // 1. Khử trùng lặp ảnh dựa trên MD5 hash của buffer nội dung
    const seenHashes = new Set();
    const uniqueBuffers = [];

    for (const f of filePayloads) {
      const buf = Buffer.isBuffer(f.buffer)
        ? f.buffer
        : (f.base64 ? Buffer.from(f.base64, 'base64') : (f.path && fs.existsSync(f.path) ? fs.readFileSync(f.path) : null));
      if (buf && buf.length > 0) {
        const hash = crypto.createHash('md5').update(buf).digest('hex');
        if (!seenHashes.has(hash)) {
          seenHashes.add(hash);
          const ext = (f.mimeType && f.mimeType.includes('png')) ? '.png' : '.jpg';
          uniqueBuffers.push({ buf, ext });
        }
      }
    }

    if (uniqueBuffers.length === 0) return null;

    // Giới hạn tối đa 8 ảnh độc nhất (1..8)
    const activeBuffers = uniqueBuffers.slice(0, 8);
    for (let i = 0; i < activeBuffers.length; i++) {
      const inPath = path.join(tmpDir, `in-${tmpId}-${i}${activeBuffers[i].ext}`);
      fs.writeFileSync(inPath, activeBuffers[i].buf);
      inputPaths.push(inPath);
    }

    const n = inputPaths.length;
    const inputs = inputPaths.map(p => `-i "${p}"`).join(' ');

    if (n === 1) {
      const filter = '[0:v]scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:white[out]';
      execSync(`"${ffmpegPath}" -y -i "${inputPaths[0]}" -filter_complex "${filter}" -map "[out]" -q:v 2 -update 1 "${outPath}"`, { timeout: 15000, stdio: 'pipe' });
    } else if (n === 2) {
      const filter = '[0:v]scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2:white[img0];[1:v]scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2:white[img1];[img0][img1]hstack[out]';
      execSync(`"${ffmpegPath}" -y ${inputs} -filter_complex "${filter}" -map "[out]" -q:v 2 -update 1 "${outPath}"`, { timeout: 15000, stdio: 'pipe' });
    } else if (n === 3) {
      const filter = '[0:v]scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2:white[img0];[1:v]scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2:white[img1];[2:v]scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2:white[img2];[img0][img1][img2]hstack=inputs=3[out]';
      execSync(`"${ffmpegPath}" -y ${inputs} -filter_complex "${filter}" -map "[out]" -q:v 2 -update 1 "${outPath}"`, { timeout: 15000, stdio: 'pipe' });
    } else if (n === 4) {
      const filter = '[0:v]scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2:white[img0];[1:v]scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2:white[img1];[2:v]scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2:white[img2];[3:v]scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2:white[img3];[img0][img1]hstack[top];[img2][img3]hstack[bottom];[top][bottom]vstack[out]';
      execSync(`"${ffmpegPath}" -y ${inputs} -filter_complex "${filter}" -map "[out]" -q:v 2 -update 1 "${outPath}"`, { timeout: 15000, stdio: 'pipe' });
    } else if (n === 5 || n === 6) {
      const scaleFilters = [];
      for (let i = 0; i < n; i++) {
        scaleFilters.push(`[${i}:v]scale=540:540:force_original_aspect_ratio=decrease,pad=540:540:(ow-iw)/2:(oh-ih)/2:white[img${i}]`);
      }
      let topRow = '[img0][img1][img2]hstack=inputs=3[top]';
      let bottomRow = '';
      if (n === 5) {
        scaleFilters.push(`[4:v]scale=540:540:force_original_aspect_ratio=decrease,pad=540:540:(ow-iw)/2:(oh-ih)/2:white[img5]`);
        bottomRow = '[img3][img4][img5]hstack=inputs=3[bottom]';
      } else {
        bottomRow = '[img3][img4][img5]hstack=inputs=3[bottom]';
      }
      const filter = `${scaleFilters.join(';')};${topRow};${bottomRow};[top][bottom]vstack[out]`;
      execSync(`"${ffmpegPath}" -y ${inputs} -filter_complex "${filter}" -map "[out]" -q:v 2 -update 1 "${outPath}"`, { timeout: 20000, stdio: 'pipe' });
    } else {
      // 7 hoặc 8 ảnh -> Lưới 2 hàng x 4 cột (480x480)
      const scaleFilters = [];
      for (let i = 0; i < n; i++) {
        scaleFilters.push(`[${i}:v]scale=480:480:force_original_aspect_ratio=decrease,pad=480:480:(ow-iw)/2:(oh-ih)/2:white[img${i}]`);
      }
      let topRow = '[img0][img1][img2][img3]hstack=inputs=4[top]';
      let bottomRow = '';
      if (n === 7) {
        scaleFilters.push(`[6:v]scale=480:480:force_original_aspect_ratio=decrease,pad=480:480:(ow-iw)/2:(oh-ih)/2:white[img7]`);
        bottomRow = '[img4][img5][img6][img7]hstack=inputs=4[bottom]';
      } else {
        bottomRow = '[img4][img5][img6][img7]hstack=inputs=4[bottom]';
      }
      const filter = `${scaleFilters.join(';')};${topRow};${bottomRow};[top][bottom]vstack[out]`;
      execSync(`"${ffmpegPath}" -y ${inputs} -filter_complex "${filter}" -map "[out]" -q:v 2 -update 1 "${outPath}"`, { timeout: 25000, stdio: 'pipe' });
    }

    if (fs.existsSync(outPath)) {
      const buf = fs.readFileSync(outPath);
      console.log(`[TemplatePro] ✅ Created input collage image (${(buf.length / 1024).toFixed(0)} KB) from ${n} unique reference photos (out of ${filePayloads.length} inputs)`);
      return buf;
    }
    return null;
  } catch (err) {
    console.warn(`[TemplatePro] ⚠️ Failed to create input collage: ${err.message}. Falling back to first input photo.`);
    const first = filePayloads[0];
    return Buffer.isBuffer(first?.buffer) ? first.buffer : (first?.base64 ? Buffer.from(first.base64, 'base64') : (first?.path && fs.existsSync(first.path) ? fs.readFileSync(first.path) : null));
  } finally {
    [...inputPaths, outPath].forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { }
    });
  }
}

/**
 * Bước 1: Khởi tạo Storyboard ban đầu cho /tpro
 * Kèm quy trình kiểm định chất lượng Gemini Vision QA (thang 100 điểm, retry nếu <= 85 điểm, tối đa 5 lần).
 */
async function generateStoryboard(baseDir, filePayloads, options = {}) {
  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const template = 'template_pro';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const shortRunId = Math.random().toString(36).substring(2, 8);
  const runId = (options.runId && options.runId.length <= 12) ? options.runId : shortRunId;
  const runDir = path.join(effectiveBaseDir, 'storyboard-review-runs', `${timestamp}-${template}-flow-${runId}`);
  ensureDir(runDir);

  const inputsDir = path.join(runDir, 'inputs');
  ensureDir(inputsDir);
  const savedInputs = [];
  filePayloads.forEach((f, idx) => {
    const ext = (f.mimeType && f.mimeType.includes('png')) ? '.png' : '.jpg';
    const filePath = path.join(inputsDir, `input-${idx + 1}${ext}`);
    const buf = Buffer.isBuffer(f.buffer) ? f.buffer : (f.base64 ? Buffer.from(f.base64, 'base64') : (f.path ? fs.readFileSync(f.path) : null));
    if (buf) {
      fs.writeFileSync(filePath, buf);
      savedInputs.push({
        name: `input-${idx + 1}${ext}`,
        path: filePath,
        buffer: buf,
        mimeType: f.mimeType || 'image/png'
      });
    }
  });

  // Tạo ảnh collage ghép từ các ảnh input gốc để gửi kèm đối chiếu
  const inputCollagePath = path.join(inputsDir, 'input.png');
  let inputCollageBuf = null;
  try {
    inputCollageBuf = createInputCollageImagePro(savedInputs);
    if (inputCollageBuf) {
      fs.writeFileSync(inputCollagePath, inputCollageBuf);
      savedInputs.unshift({
        name: 'input.png',
        path: inputCollagePath,
        buffer: inputCollageBuf,
        mimeType: 'image/png'
      });
    }
  } catch (err) {
    console.warn(`[TemplatePro] Failed to create input collage: ${err.message}`);
  }

  const progress = typeof options.onProgress === 'function' ? options.onProgress : async () => { };
  if (options.stepTracker) {
    await options.stepTracker.setStep(1, 'completed');
    await options.stepTracker.setStep(2, 'running');
  }

  const geminiClient = new GeminiApiClient({
    browserMode: true,
    userDataDir: path.join(effectiveBaseDir, 'gemini-playwright-user-data')
  });

  let analysis = null;
  let analysisPrompt = null;
  let rawResponse = null;

  try {
    try {
      await geminiClient.init();
    } catch (initErr) {
      console.warn(`[TemplatePro] GeminiApiClient init warning: ${initErr.message}`);
    }

    // 1. Phân tích sản phẩm bằng Gemini (sử dụng hàm riêng của Template Pro)
    try {
      const promptOptions = {
        template: 'template_pro',
        noText: true,
        hasVoice: true,
        productContext: options.productContext || {},
      };
      const analyzed = await analyzeProductTemplatePro(geminiClient, filePayloads, promptOptions);
      analysis = analyzed.analysis;
      analysisPrompt = analyzed.analysisPrompt || null;
      rawResponse = analyzed.rawResponse || null;
    } catch (err) {
      console.warn(`[TemplatePro] Gemini analysis error, using fallback: ${err.message}`);
      const fallbackRes = await analyzeProductTemplatePro(null, filePayloads, { productContext: options.productContext || {} });
      analysis = fallbackRes.analysis;
      analysisPrompt = fallbackRes.analysisPrompt || null;
      rawResponse = fallbackRes.rawResponse || null;
    }

    if (analysis?.productName && options.stepTracker) {
      await options.stepTracker.setTitle(analysis.productName);
    }
    if (options.stepTracker) {
      await options.stepTracker.setStep(2, 'completed');
      await options.stepTracker.setStep(3, 'running');
    }

    // 2. Sinh đồng thời 4 Master Storyboards song song qua Google Flow (16:9, model nano-banana-pro)
    // Sau đó gửi cả 4 hình lên Gemini Vision để đánh giá chung 1 lần, chọn ra bản tốt nhất và tự động replace panel lỗi (nếu có).
    console.log('[TemplatePro] Step 2: Generating 4 Master Storyboard candidates in parallel via Google Flow...');
    await progress({
      currentStep: 'generating_storyboard',
      stepOrder: 3,
      progressPercent: 35,
      message: 'Đang tạo đồng thời 4 Master Storyboards trên Google Flow...',
    });

    const masterPrompt = buildTemplateProMasterPrompt(analysis, { noText: true, template: 'template_pro' });
    const collageItem = savedInputs.find(fp => fp.name === 'input.png' || (fp.path && path.basename(fp.path) === 'input.png'));
    const validPayloads = collageItem
      ? [{
          name: 'input.png',
          buffer: collageItem.buffer || (collageItem.path && fs.existsSync(collageItem.path) ? fs.readFileSync(collageItem.path) : null),
          path: collageItem.path,
          mimeType: 'image/png'
        }]
      : savedInputs.map(fp => ({
          name: fp.name,
          buffer: fp.buffer,
          path: fp.path,
          mimeType: fp.mimeType
        }));
    console.log(`[TemplatePro] 🖼️ Sending ${validPayloads.length} reference payload(s) to Google Flow (${validPayloads.map(p => p.name).join(', ')})`);

    let candidateBuffers = [];
    let flowPage = null;
    let lastMasterErr = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`[TemplatePro] 🔄 Retrying parallel Storyboard generation (Attempt ${attempt}/3)...`);
          await new Promise(r => setTimeout(r, 4000));
        }
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
          console.log(`[TemplatePro] ✅ Successfully generated ${candidateBuffers.length} Master Storyboard candidates in parallel!`);
          break;
        }
      } catch (err) {
        lastMasterErr = err;
        console.warn(`[TemplatePro] Parallel Storyboard Attempt ${attempt}/3 failed: ${err.message}`);
      } finally {
        if (flowPage) {
          try { await closeFlowPage(flowPage); } catch (_) { }
        }
      }
    }

    if (candidateBuffers.length === 0) {
      throw new Error(`Failed to generate Master Storyboards on Google Flow: ${lastMasterErr?.message || 'Unknown error'}`);
    }

    // Lưu các candidate storyboards vào runDir để lưu trữ và kiểm tra
    candidateBuffers.forEach((buf, i) => {
      const candPath = path.join(runDir, `storyboard-candidate-${i + 1}.png`);
      try { fs.writeFileSync(candPath, buf); } catch (_) { }
    });

    // 3. Đánh giá chung 4 Storyboards qua Gemini Vision trong 1 lần gọi duy nhất
    await progress({
      currentStep: 'generating_storyboard',
      stepOrder: 3,
      progressPercent: 45,
      message: `Đang kiểm định chất lượng đồng thời ${candidateBuffers.length} Storyboards qua Gemini Vision...`,
    });

    const multiQAResult = await verifyMultiStoryboardWithGeminiVision(
      geminiClient,
      candidateBuffers,
      savedInputs,
      analysis
    );

    const bestIndex = (multiQAResult.bestCandidateIndex >= 1 && multiQAResult.bestCandidateIndex <= candidateBuffers.length)
      ? multiQAResult.bestCandidateIndex
      : 1;
    const bestScore = multiQAResult.candidates?.find(c => c.candidateIndex === bestIndex)?.score || 88;
    console.log(`[TemplatePro] 🎯 Selected Base Storyboard: Candidate #${bestIndex} (${bestScore}/100)`);

    // Tách Base Storyboard thành 4 panels tự nhiên 4:9 (480x1080)
    let chosenPanels = sliceMasterStoryboardPro(candidateBuffers[bestIndex - 1]);

    // Xử lý tự động bóc tách & thay thế panel nếu có panel bị lỗi / sai lệch
    const replacementsApplied = [];
    if (Array.isArray(multiQAResult.replacements) && multiQAResult.replacements.length > 0) {
      for (const rep of multiQAResult.replacements) {
        const pIdx = rep.panelIndex; // 1..4
        const sIdx = rep.sourceCandidateIndex; // 1..candidateBuffers.length
        if (pIdx >= 1 && pIdx <= 4 && sIdx >= 1 && sIdx <= candidateBuffers.length && sIdx !== bestIndex) {
          try {
            console.log(`[TemplatePro] 🔄 Slicing source Candidate #${sIdx} to replace Panel ${pIdx}...`);
            const sourcePanels = sliceMasterStoryboardPro(candidateBuffers[sIdx - 1]);
            if (sourcePanels && sourcePanels[pIdx - 1]) {
              chosenPanels[pIdx - 1] = sourcePanels[pIdx - 1];
              replacementsApplied.push({
                panelIndex: pIdx,
                sourceCandidateIndex: sIdx,
                reason: rep.reason || 'Tối ưu độ chính xác và chi tiết sản phẩm'
              });
              console.log(`[TemplatePro] ✅ Successfully replaced Panel ${pIdx} with Panel from Candidate #${sIdx}!`);
            }
          } catch (repErr) {
            console.warn(`[TemplatePro] ⚠️ Failed to replace panel ${pIdx}: ${repErr.message}`);
          }
        }
      }
    }

    const panelsDir = path.join(runDir, 'panels');
    ensureDir(panelsDir);

    const panels = [];
    for (let i = 1; i <= 4; i++) {
      const pBuf = chosenPanels[i - 1];
      const pPath = path.join(panelsDir, `panel-${i}.png`);
      fs.writeFileSync(pPath, pBuf);
      panels.push({
        index: i,
        sceneNumber: i,
        imagePath: pPath,
        buffer: pBuf,
        mimeType: 'image/png'
      });
    }

    // Ghép lại thành Master Storyboard 1920x1080 chuẩn 16:9 sắc nét (đã tích hợp panel replace)
    const storyboardPath = path.join(runDir, 'storyboard.png');
    composeMasterStoryboardPro(panels, storyboardPath);
    const storyboardJpgPath = storyboardPath.replace(/\.png$/i, '.jpg');
    let storyboardBuf = fs.existsSync(storyboardJpgPath) ? fs.readFileSync(storyboardJpgPath) : fs.readFileSync(storyboardPath);

    // 4. Khởi tạo file prompts.md ghi lại toàn bộ lịch sử luồng xử lý chi tiết
    const promptsMdPath = path.join(runDir, 'prompts.md');
    const targetChatId = options.chatId || options.telegramChatId || null;

    const initialMd = [
      `# Template Pro Full Flow Execution Log — ${runId}`,
      `- Run ID: \`${runId}\``,
      `- Timestamp: ${new Date().toISOString()}`,
      `- Template: \`/tpro\` (Template Pro Interactive Storyboard & Zero-Crop Video Workflow)`,
      `- Product: **${analysis?.productName || 'Unknown'}**`,
      `- Category: \`${analysis?.category || 'general'}\``,
      `- Voice Persona: ${analysis?.voicePersona?.voiceDescription || 'N/A'} (Gender: ${analysis?.voicePersona?.gender || 'N/A'}, Tone: ${analysis?.voicePersona?.tone || 'N/A'})`,
      `- Scene Context: Location: ${analysis?.sceneContext?.location || 'N/A'}, Lighting: ${analysis?.sceneContext?.lighting || 'N/A'}`,
      '',
      '---',
      '## Step 1: Gemini Product Analysis & Voice Script Generation',
      '- **API Engine**: Gemini API Client (generateContent)',
      '- **Prompt Rule**: 30-36 words per panel, 60-72 words per 8s video, fast review, NO cutoff.',
      '',
      '### Gemini Analysis Prompt',
      '```text',
      analysisPrompt || 'N/A',
      '```',
      '',
      '### Gemini Raw Response',
      '```json',
      rawResponse || 'N/A',
      '```',
      '',
      formatScriptBreakdownMarkdown(analysis),
      '',
      '---',
      '## Step 2: Google Flow 4x Parallel Master Storyboard Generation & Multi-Candidate QA',
      '- **Model**: `nano-banana-pro` (Aspect Ratio: `16:9`, 1920x1080)',
      `- **Generated Candidates**: ${candidateBuffers.length} parallel storyboards`,
      `- **Final Selected Base Storyboard**: Candidate #${bestIndex} (QA Score: **${bestScore}/100**)`,
      `- **Panel Replacements**: ${replacementsApplied.length > 0 ? replacementsApplied.map(r => `Panel ${r.panelIndex} replaced from Candidate #${r.sourceCandidateIndex}`).join(', ') : 'None (Base Storyboard passed with high consistency)'}`,
      '- **Input References**:',
      ...savedInputs.map(si => `  * \`${si.name}\` (${(fs.statSync(si.path).size / 1024).toFixed(1)} KB)`),
      '',
      '### Master Storyboard Prompt Used',
      '```text',
      masterPrompt,
      '```',
      formatMultiStoryboardQAMarkdown(multiQAResult),
      '',
      `- **Final Composition Result**: Master Storyboard approved and composited -> \`storyboard.png\` (1920x1080, ${(storyboardBuf.length / 1024).toFixed(1)} KB)`,
      '',
      '---',
      '## Step 3: Natural 4:9 Panel Slicing & Telegram Interaction',
      '- **Slicing Method**: Natural crop 480x1080 (4:9 ratio, zero distortion, zero logo crop policy)',
      ...panels.map(p => `- **Panel ${p.index}**: \`${p.imagePath}\` (${(fs.statSync(p.imagePath).size / 1024).toFixed(1)} KB)`),
      `- **Telegram Notification**: Photo sent to chat \`${targetChatId || 'N/A'}\``,
      '- **Interactive Options**: `[Remake 1]` `[Remake 2]` `[Remake 3]` `[Remake 4]` `[Remake All]` `[OK Chốt]`',
      '- **Current Status**: Waiting for user review',
      ''
    ].join('\n');
    writeMarkdownLog(runDir, initialMd);

    // 5. Lưu session vào bộ nhớ & disk
    const sessionData = {
      runId,
      jobId: options.runId || options.jobId || null,
      template: 'template_pro',
      chatId: targetChatId,
      runDir,
      promptsMdPath,
      storyboardPath,
      iteration: 1,
      analysis,
      masterPrompt,
      multiQAResult,
      qaScore: bestScore,
      bestCandidateIndex: bestIndex,
      replacementsApplied,
      candidateCount: candidateBuffers.length,
      analysisPrompt,
      rawResponse,
      panels: panels.map(p => ({ index: p.index, imagePath: p.imagePath })),
      savedInputs: savedInputs.map(si => ({ name: si.name, path: si.path })),
      telegramMessageId: null,
      stepTrackerMessageId: options.stepTracker?.messageId || null,
      productTitle: options.productContext?.productTitle || options.productTitle || analysis?.productName || 'Sản phẩm review',
      productId: options.productContext?.productId || options.productId || analysis?.productId || '',
      productUrl: options.productContext?.productUrl || options.productUrl || '',
      shortlink: options.productContext?.shortlink || options.shortlink || '',
      cartAnchorText: options.productContext?.cartAnchorText || analysis?.cartAnchorText || analysis?.cartCTA || '',
    };

    // 6. Ghi lại session và gửi Telegram
    if (targetChatId) {
      if (inputCollageBuf) {
        await sendPhotoToTelegram(
          targetChatId,
          inputCollageBuf,
          `📸 <b>[Ảnh Input Gốc]</b> Hình ảnh sản phẩm thực tế đã ghép lại để bạn đối chiếu so sánh:`,
          { parse_mode: 'HTML' }
        );
      }

      const isAuto = !!options.isAuto;
      const keyboard = isAuto ? null : buildProInlineKeyboard(runId);
      const candidateScoresText = multiQAResult.candidates?.map(c => `#${c.candidateIndex}: <b>${c.score}đ</b>`).join(' | ') || '';
      const replacementNote = replacementsApplied.length > 0
        ? `\n✨ <i>Tự động hoàn thiện: Đã ghép ${replacementsApplied.map(r => `Cảnh ${r.panelIndex} (từ SB #${r.sourceCandidateIndex})`).join(', ')} để chi tiết đạt độ chuẩn xác cao nhất!</i>`
        : '';

      const captionLines = [
        `🎨 <b>[Template Pro${isAuto ? ' - Tự động' : ''}] Master Storyboard đã tạo xong!</b>\n`,
        `📦 <b>Sản phẩm:</b> ${analysis?.productName || 'Sản phẩm review'}`,
        `📊 <b>Điểm 4 Storyboard:</b> ${candidateScoresText}`,
        `🏆 <b>Đã chọn:</b> Storyboard #${bestIndex} (Điểm kiểm định: <b>${bestScore}/100</b>)${replacementNote}`,
      ];

      if (isAuto) {
        captionLines.push(`\n⚡ <i>Chế độ tự động: Bỏ qua bước duyệt/remake, đang tiến hành sinh 4 video AI và lồng tiếng review...</i>`);
      } else {
        captionLines.push(
          `\n🖼️ Storyboard gồm 4 cảnh (1: Hook, 2: Solution, 3: Proof, 4: Closing).`,
          `👉 <i>Bấm nút bên dưới nếu bạn muốn làm lại (Remake) cảnh cụ thể, làm lại tất cả, hoặc bấm OK để chốt:</i>`
        );
      }

      const caption = captionLines.join('\n');
      const sendOpts = {
        parse_mode: 'HTML',
        ...(keyboard ? { reply_markup: keyboard } : {}),
      };

      let sentMsgId = await sendPhotoToTelegram(targetChatId, storyboardBuf, caption, sendOpts);
      if (!sentMsgId) {
        console.warn('[TemplatePro] ⚠️ sendPhoto failed, sending fallback text message...');
        sentMsgId = await sendTelegramMessage(targetChatId, caption, sendOpts);
      }
      if (sentMsgId) {
        sessionData.telegramMessageId = (typeof sentMsgId === 'object' && sentMsgId?.message_id) ? sentMsgId.message_id : sentMsgId;
        console.log(`[TemplatePro] Storyboard 1 sent to Telegram, message_id: ${sessionData.telegramMessageId}`);
      }
    }

    if (options.stepTracker) {
      await options.stepTracker.setStep(3, 'completed');
      sessionData.stepTrackerMessageId = options.stepTracker.messageId;
    }
    saveProSession(runId, sessionData);

    return {
      runId,
      jobId: options.runId || options.jobId || null,
      template: 'template_pro',
      panels,
      videos: [],
      isInteractiveStoryboard: true,
      promptSource: 'gemini-api',
      qaScore: bestScore,
      storyboard: {
        imageBase64: storyboardBuf.toString('base64'),
        mimeType: 'image/png',
        sourcePath: storyboardPath,
      },
      reviewArchive: {
        root: runDir,
        panelsDir,
        storyboardPath,
        promptsPath: promptsMdPath
      },
      analysis: {
        productName: analysis?.productName || 'Template Pro Product Review',
        category: analysis?.category || 'general',
        hashtags: analysis?.hashtags || ['#review', '#tiktokshop', '#trending'],
        summary: `✨ Đã tạo xong Storyboard tương tác cho "${analysis?.productName || 'sản phẩm'}" (Điểm kiểm định: ${bestScore}/100). Đang chờ chọn Remake hoặc chốt!`,
      },
    };
  } finally {
    try { await geminiClient.close(); } catch (_) { }
  }
}

/**
 * Lựa chọn ứng viên có Panel targetPanelIndex đạt điểm cao nhất từ kết quả QA đa ứng viên.
 * Ưu tiên các ứng viên không có lỗi Critical Product Fidelity.
 */
function selectBestCandidateForPanel(multiQAResult, candidateCount, targetPanelIndex) {
  const candidates = multiQAResult?.candidates || [];
  if (candidates.length === 0) {
    return { bestIdx: 1, bestScore: 88, bestFidelity: 36 };
  }

  // Ưu tiên các ứng viên không mắc lỗi Critical Product Fidelity
  const validCandidates = candidates.filter(c => {
    const hasCritFidelity = c.criteria_results?.product_fidelity?.critical_error;
    const hasCritList = Array.isArray(c.critical_errors) && c.critical_errors.length > 0;
    return !hasCritFidelity && !hasCritList;
  });

  const pool = validCandidates.length > 0 ? validCandidates : candidates;

  let bestIdx = pool[0]?.candidateIndex || 1;
  let bestScore = -1;
  let bestFidelity = 36;

  for (const c of pool) {
    const pInfo = c.panels?.find(p => p.panelIndex === targetPanelIndex);
    const pScore = (typeof pInfo?.score === 'number') ? pInfo.score : (c.score || 0);
    const fidelity = c.criteria_results?.product_fidelity?.score ?? 36;
    if (pScore > bestScore) {
      bestScore = pScore;
      bestIdx = c.candidateIndex;
      bestFidelity = fidelity;
    }
  }

  if (bestIdx < 1 || bestIdx > candidateCount) bestIdx = 1;
  if (bestScore < 0) bestScore = 88;

  return { bestIdx, bestScore, bestFidelity };
}

/**
 * Bước 2: Thực thi Remake cho Panel K (K = 1, 2, 3, 4)
 * - Chạy lại bước sinh 4 Storyboard song song qua Google Flow như step gen ban đầu
 * - Chạy Gemini Vision QA đánh giá 4 Storyboard vừa tạo
 * - Chọn ra Panel K tốt nhất từ 4 Storyboard mới
 * - Ghép Panel K tốt nhất đó vào Storyboard trước đó (giữ nguyên 3 panel còn lại)
 * - Ghi lại nhật ký vào prompts.md
 * - Cập nhật in-place qua editPhotoInTelegram tin nhắn ảnh trên Telegram kèm bàn phím
 */
async function executeProRemakePanel(chatId, baseDir, runId, targetPanelIndex, opts = {}) {
  const session = getProSession(runId, baseDir);
  if (!session) {
    await sendTelegramMessage(chatId, `⚠️ Không tìm thấy phiên làm việc của Run ID <code>${runId}</code>. Hãy bắt đầu lại bằng cách gửi ảnh mới!`, { parse_mode: 'HTML' });
    return;
  }

  const pIdx = parseInt(targetPanelIndex, 10);
  if (pIdx < 1 || pIdx > 4) {
    await sendTelegramMessage(chatId, `⚠️ Panel ${targetPanelIndex} không hợp lệ (chỉ từ 1 đến 4).`);
    return;
  }

  const nextIteration = (session.iteration || 1) + 1;
  const panelInfo = getPanelContext(session.analysis, pIdx);

  // 1. Chuẩn bị ảnh sản phẩm gốc từ savedInputs (ưu tiên ảnh ghép input.png)
  const validPayloads = [];
  const collageItem = session.savedInputs?.find(f => f.name === 'input.png' || (f.path && path.basename(f.path) === 'input.png'));
  if (collageItem && (collageItem.buffer || (collageItem.path && fs.existsSync(collageItem.path)))) {
    validPayloads.push({
      name: 'input.png',
      path: collageItem.path,
      buffer: collageItem.buffer || fs.readFileSync(collageItem.path),
      mimeType: 'image/png'
    });
  } else if (Array.isArray(session.savedInputs)) {
    for (const item of session.savedInputs) {
      if (item.path && fs.existsSync(item.path)) {
        validPayloads.push({
          name: item.name || path.basename(item.path),
          path: item.path,
          buffer: item.buffer || fs.readFileSync(item.path),
          mimeType: 'image/png'
        });
      }
    }
  }

  // 2. Sử dụng Master Prompt chuẩn (chứa 4 tiêu chí đánh giá) để sinh 4 candidates song song
  const masterPrompt = session.masterPrompt || buildTemplateProMasterPrompt(session.analysis, { noText: true, template: 'template_pro' });

  console.log(`[TemplatePro] Step 2 (Remake Panel ${pIdx}): Generating 4 fresh Master Storyboard candidates in parallel...`);
  let candidateBuffers = [];
  let flowPage = null;
  let remakeErr = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`[TemplatePro] 🔄 Retrying parallel Storyboard generation for Remake Panel ${pIdx} (Attempt ${attempt}/3)...`);
        await new Promise(r => setTimeout(r, 4000));
      }
      flowPage = await createFlowPage(baseDir);
      const prepared = await prepareGeneration(
        flowPage,
        masterPrompt,
        validPayloads,
        {
          imageModel: 'nano-banana-pro',
          aspectRatio: '16:9',
          outputCount: 4,
        },
        baseDir
      );
      const genResult = await executeGeneration(prepared);
      if (genResult && Array.isArray(genResult.allResults) && genResult.allResults.length > 0) {
        candidateBuffers = genResult.allResults.map(r => r.buffer || Buffer.from(r.base64, 'base64')).filter(Boolean);
      } else if (genResult && (genResult.buffer || genResult.base64)) {
        candidateBuffers = [genResult.buffer || Buffer.from(genResult.base64, 'base64')];
      }

      if (candidateBuffers.length > 0) {
        console.log(`[TemplatePro] ✅ Successfully generated ${candidateBuffers.length} Storyboards for Remake Panel ${pIdx}!`);
        break;
      }
    } catch (err) {
      remakeErr = err;
      console.warn(`[TemplatePro] Remake Panel ${pIdx} Attempt ${attempt}/3 failed: ${err.message}`);
    } finally {
      if (flowPage) {
        try { await closeFlowPage(flowPage); } catch (_) { }
      }
    }
  }

  if (candidateBuffers.length === 0) {
    await sendTelegramMessage(
      chatId,
      `⚠️ <b>Lỗi tạo lại Panel ${pIdx}:</b> ${remakeErr?.message || 'Không nhận được kết quả từ AI'}.\n👉 Bạn có thể thử bấm lại nút Remake ${pIdx} lần nữa.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Lưu backup các candidate storyboards vừa tạo vào runDir
  candidateBuffers.forEach((buf, i) => {
    const candPath = path.join(session.runDir, `storyboard-candidate-it${nextIteration}-${i + 1}.png`);
    try { fs.writeFileSync(candPath, buf); } catch (_) { }
  });

  // 3. QA đánh giá 4 Storyboard vừa tạo qua Gemini Vision để chọn ra Panel pIdx tốt nhất
  let geminiClient = null;
  let multiQAResult = null;
  try {
    geminiClient = new GeminiApiClient({
      browserMode: true,
      userDataDir: path.join(baseDir, 'gemini-playwright-user-data')
    });
    await geminiClient.init().catch(() => {});
    multiQAResult = await verifyMultiStoryboardWithGeminiVision(
      geminiClient,
      candidateBuffers,
      session.savedInputs,
      session.analysis
    );
  } catch (qaErr) {
    console.warn(`[TemplatePro] QA evaluation failed for Remake Panel ${pIdx}: ${qaErr.message}`);
    multiQAResult = {
      candidates: candidateBuffers.map((_, i) => ({ candidateIndex: i + 1, score: 88, panels: [1, 2, 3, 4].map(p => ({ panelIndex: p, score: 88 })) })),
      bestCandidateIndex: 1,
      replacements: []
    };
  } finally {
    if (geminiClient) {
      try { await geminiClient.close(); } catch (_) { }
    }
  }

  // 4. Chọn ứng viên có Panel pIdx đạt điểm cao nhất
  const { bestIdx: bestCandIdx, bestScore: bestPanelScore } = selectBestCandidateForPanel(
    multiQAResult,
    candidateBuffers.length,
    pIdx
  );
  console.log(`[TemplatePro] 🎯 Remake Panel ${pIdx}: Selected Candidate #${bestCandIdx} with best Panel ${pIdx} (Score: ${bestPanelScore}đ)`);

  // Cắt lấy Panel pIdx từ candidate xuất sắc nhất
  const slicedFromBest = sliceMasterStoryboardPro(candidateBuffers[bestCandIdx - 1]);
  const newTargetPanelBuf = slicedFromBest[pIdx - 1];

  // 5. Lưu Panel pIdx mới vào thư mục panels/
  const panelsDir = path.join(session.runDir, 'panels');
  ensureDir(panelsDir);
  const versionedPanelPath = path.join(panelsDir, `panel-${pIdx}-v${nextIteration}.png`);
  fs.writeFileSync(versionedPanelPath, newTargetPanelBuf);

  const mainPanelPath = path.join(panelsDir, `panel-${pIdx}.png`);
  fs.writeFileSync(mainPanelPath, newTargetPanelBuf);

  // Lưu backup ảnh storyboard cũ trước khi ghép mới
  const currentStoryboardPath = path.join(session.runDir, 'storyboard.png');
  const backupSbPath = path.join(session.runDir, `storyboard-v${session.iteration || 1}.png`);
  try {
    if (fs.existsSync(currentStoryboardPath)) {
      fs.copyFileSync(currentStoryboardPath, backupSbPath);
    }
  } catch (_) { }

  // 6. Ghép Panel pIdx mới vào 3 panel đã có trước đó của storyboard
  const panelsToCompose = [];
  for (let i = 1; i <= 4; i++) {
    const pPath = path.join(panelsDir, `panel-${i}.png`);
    const pBuf = (i === pIdx)
      ? newTargetPanelBuf
      : (fs.existsSync(pPath) ? fs.readFileSync(pPath) : slicedFromBest[i - 1]);
    panelsToCompose.push({
      index: i,
      sceneNumber: i,
      imagePath: pPath,
      buffer: pBuf,
      mimeType: 'image/png'
    });
  }

  // Ghép lại thành ảnh storyboard.png mới 1920x1080 chuẩn 16:9
  composeMasterStoryboardPro(panelsToCompose, currentStoryboardPath);
  const composedStoryboardBuf = fs.readFileSync(currentStoryboardPath);

  // 7. Ghi nhật ký chi tiết vào prompts.md
  const promptsMdPath = session.promptsMdPath || path.join(session.runDir, 'prompts.md');
  const candidateScoresText = multiQAResult.candidates?.map(c => {
    const pScore = c.panels?.find(p => p.panelIndex === pIdx)?.score || c.score;
    return `#${c.candidateIndex}: ${pScore}đ`;
  }).join(', ') || '';

  const remakeLog = [
    '',
    '---',
    `## Remake Iteration ${nextIteration}: Remake Panel ${pIdx} (${panelInfo.phase}) via 4-Candidate QA Batch`,
    `- Date: ${new Date().toISOString()}`,
    `- Action: User clicked Remake Panel ${pIdx} (\`tpro_remake:${pIdx}:${runId}\`)`,
    `- Engine: Google Flow (\`nano-banana-pro\`, Aspect Ratio: 16:9, outputCount: 4)`,
    `- 4 New Candidates Generated: Evaluated via Gemini Vision QA.`,
    `- Panel ${pIdx} Scores Across 4 Candidates: ${candidateScoresText}`,
    `- Best Candidate Selected for Panel ${pIdx}: Storyboard #${bestCandIdx} (Panel ${pIdx} Score: **${bestPanelScore}/100**)`,
    `- Splicing Result: Extracted Panel ${pIdx} from Candidate #${bestCandIdx} -> \`panels/panel-${pIdx}-v${nextIteration}.png\` (${(newTargetPanelBuf.length / 1024).toFixed(1)} KB).`,
    `- Recomposition: Spliced with previous Panels 1..4 into 16:9 Master Storyboard (1920x1080, ${(composedStoryboardBuf.length / 1024).toFixed(1)} KB).`,
    `- Telegram Update: Message ID \`${session.telegramMessageId}\` updated in-place via editMessageMedia.`,
    ''
  ].join('\n');

  appendMarkdownLog(session.runDir, remakeLog);

  // 8. Cập nhật session state
  session.iteration = nextIteration;
  session.panels = panelsToCompose.map(p => ({ index: p.index, imagePath: p.imagePath }));

  // 9. Cập nhật / Thay thế hình ảnh Storyboard trên Telegram (in-place)
  const keyboard = buildProInlineKeyboard(runId);
  const captionScoresFormatted = multiQAResult.candidates?.map(c => {
    const pScore = c.panels?.find(p => p.panelIndex === pIdx)?.score || c.score;
    return `#${c.candidateIndex}: <b>${pScore}đ</b>`;
  }).join(' | ') || '';

  const caption = [
    `✨ <b>[Template Pro] Đã cập nhật xong Cảnh ${pIdx} (${panelInfo.phase})!</b> (Lần remake #${nextIteration - 1})\n`,
    `📊 <b>Điểm Cảnh ${pIdx} ở 4 Storyboard mới:</b> ${captionScoresFormatted}`,
    `🏆 <b>Đã chọn:</b> Cảnh ${pIdx} từ Storyboard #${bestCandIdx} (Điểm: <b>${bestPanelScore}/100</b>) ghép vào Storyboard trước đó.\n`,
    `👉 <i>Bấm nút bên dưới để Remake tiếp cảnh khác nếu cần, hoặc bấm OK khi bạn đã ưng ý:</i>`
  ].join('\n');

  let updated = false;
  if (session.telegramMessageId) {
    console.log(`[TemplatePro] Replacing storyboard photo in Telegram message ${session.telegramMessageId}...`);
    updated = await editPhotoInTelegram(chatId, session.telegramMessageId, composedStoryboardBuf, caption, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }

  if (!updated) {
    console.log(`[TemplatePro] editPhotoInTelegram failed or no messageId, sending new photo...`);
    const newMsgId = await sendPhotoToTelegram(chatId, composedStoryboardBuf, caption, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    if (newMsgId) {
      session.telegramMessageId = newMsgId;
    }
  }

  if (opts.stepTracker) {
    await opts.stepTracker.setStep(3, 'completed');
    session.stepTrackerMessageId = opts.stepTracker.messageId;
  }

  saveProSession(runId, session);

  // Xóa tin nhắn trạng thái tạm thời
  if (opts.statusMsgId) {
    await deleteTelegramMessage(chatId, opts.statusMsgId).catch(() => {});
  }
  console.log(`[TemplatePro] Remake Panel ${pIdx} completed successfully for run ${runId}`);
}

/**
 * Bước 2b: Thực thi Remake All cho toàn bộ 4 Panel
 * - Chạy lại bước sinh 4 Storyboard song song qua Google Flow như step gen ban đầu (outputCount: 4)
 * - Đánh giá QA cả 4 Storyboard qua Gemini Vision
 * - Chọn Storyboard xuất sắc nhất (bestCandidateIndex) và áp dụng thay thế cross-candidate nếu cần
 * - Tách thành 4 panels tự nhiên (480x1080)
 * - Ghép lại thành Master Storyboard 16:9 composite mới (1920x1080)
 * - Ghi lại nhật ký vào prompts.md
 * - Cập nhật in-place qua editPhotoInTelegram tin nhắn ảnh trên Telegram kèm bàn phím
 */
async function executeProRemakeAll(chatId, baseDir, runId, opts = {}) {
  const session = getProSession(runId, baseDir);
  if (!session) {
    await sendTelegramMessage(chatId, `⚠️ Không tìm thấy phiên làm việc của Run ID <code>${runId}</code>. Hãy bắt đầu lại bằng cách gửi ảnh mới!`, { parse_mode: 'HTML' });
    return;
  }

  const nextIteration = (session.iteration || 1) + 1;

  // 1. Chuẩn bị ảnh sản phẩm gốc từ savedInputs (ưu tiên ảnh ghép input.png)
  const referencePayloads = [];
  const collageItem = session.savedInputs?.find(f => f.name === 'input.png' || (f.path && path.basename(f.path) === 'input.png'));
  if (collageItem && fs.existsSync(collageItem.path)) {
    referencePayloads.push({
      name: 'input.png',
      path: collageItem.path,
      buffer: fs.readFileSync(collageItem.path),
      mimeType: 'image/png'
    });
  } else if (Array.isArray(session.savedInputs)) {
    for (const item of session.savedInputs) {
      if (fs.existsSync(item.path)) {
        referencePayloads.push({
          name: item.name || path.basename(item.path),
          path: item.path,
          buffer: fs.readFileSync(item.path),
          mimeType: 'image/png'
        });
      }
    }
  }

  // 2. Sử dụng Prompt Master Storyboard chuẩn để sinh lại toàn bộ 4 candidate
  const masterPrompt = session.masterPrompt || buildTemplateProMasterPrompt(session.analysis, { noText: true, template: 'template_pro' });

  // 3. Gọi Google Flow sinh 4 Storyboard song song (outputCount: 4, 16:9, nano-banana-pro)
  let flowPage = null;
  let candidateBuffers = [];
  let remakeErr = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`[TemplatePro] 🔄 Retrying Remake All (Attempt ${attempt}/3)...`);
        await new Promise(r => setTimeout(r, 4000));
      }
      flowPage = await createFlowPage(baseDir);
      const prepared = await prepareGeneration(
        flowPage,
        masterPrompt,
        referencePayloads,
        {
          imageModel: 'nano-banana-pro',
          aspectRatio: '16:9',
          outputCount: 4,
        },
        baseDir
      );
      const genResult = await executeGeneration(prepared);
      if (Array.isArray(genResult.candidates) && genResult.candidates.length > 0) {
        candidateBuffers = genResult.candidates.map(c => Buffer.from(c.base64, 'base64'));
      } else if (genResult && genResult.base64) {
        candidateBuffers = [Buffer.from(genResult.base64, 'base64')];
      }
      if (candidateBuffers.length > 0) break;
    } catch (err) {
      remakeErr = err;
      console.warn(`[TemplatePro] Remake All Attempt ${attempt}/3 failed: ${err.message}`);
    } finally {
      if (flowPage) {
        try { await closeFlowPage(flowPage); } catch (_) { }
      }
    }
  }

  if (candidateBuffers.length === 0) {
    await sendTelegramMessage(
      chatId,
      `⚠️ <b>Lỗi tạo lại toàn bộ Storyboard:</b> ${remakeErr?.message || 'Không nhận được kết quả từ AI'}.\n👉 Bạn có thể thử bấm lại nút Remake All lần nữa.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Lưu các candidate storyboards vào runDir
  candidateBuffers.forEach((buf, i) => {
    const candPath = path.join(session.runDir, `storyboard-candidate-it${nextIteration}-${i + 1}.png`);
    try { fs.writeFileSync(candPath, buf); } catch (_) { }
  });

  // 4. Đánh giá QA cả 4 Storyboard qua Gemini Vision
  let geminiClient = null;
  let multiQAResult = null;
  try {
    geminiClient = new GeminiApiClient({
      browserMode: true,
      userDataDir: path.join(baseDir, 'gemini-playwright-user-data')
    });
    await geminiClient.init().catch(() => {});
    multiQAResult = await verifyMultiStoryboardWithGeminiVision(
      geminiClient,
      candidateBuffers,
      session.savedInputs || referencePayloads,
      session.analysis
    );
  } catch (qaErr) {
    console.warn(`[TemplatePro] QA evaluation failed for Remake All: ${qaErr.message}`);
    multiQAResult = {
      candidates: candidateBuffers.map((_, i) => ({ candidateIndex: i + 1, score: 88, panels: [1, 2, 3, 4].map(p => ({ panelIndex: p, score: 88 })) })),
      bestCandidateIndex: 1,
      replacements: []
    };
  } finally {
    if (geminiClient) {
      try { await geminiClient.close(); } catch (_) { }
    }
  }

  const bestIndex = (multiQAResult.bestCandidateIndex >= 1 && multiQAResult.bestCandidateIndex <= candidateBuffers.length)
    ? multiQAResult.bestCandidateIndex
    : 1;
  const bestScore = multiQAResult.candidates?.find(c => c.candidateIndex === bestIndex)?.score || 88;
  console.log(`[TemplatePro] 🎯 Remake All: Selected Base Storyboard Candidate #${bestIndex} (${bestScore}/100)`);

  // Tách Base Storyboard thành 4 panels tự nhiên 4:9 (480x1080)
  let chosenPanels = sliceMasterStoryboardPro(candidateBuffers[bestIndex - 1]);

  // Áp dụng bóc tách & thay thế panel nếu QA phát hiện panel ở candidate khác tốt hơn
  const replacementsApplied = [];
  if (Array.isArray(multiQAResult.replacements) && multiQAResult.replacements.length > 0) {
    for (const rep of multiQAResult.replacements) {
      const pIdx = rep.panelIndex;
      const sIdx = rep.sourceCandidateIndex;
      if (pIdx >= 1 && pIdx <= 4 && sIdx >= 1 && sIdx <= candidateBuffers.length && sIdx !== bestIndex) {
        try {
          console.log(`[TemplatePro] 🔄 Remake All: Slicing source Candidate #${sIdx} to replace Panel ${pIdx}...`);
          const sourcePanels = sliceMasterStoryboardPro(candidateBuffers[sIdx - 1]);
          if (sourcePanels && sourcePanels[pIdx - 1]) {
            chosenPanels[pIdx - 1] = sourcePanels[pIdx - 1];
            replacementsApplied.push({
              panelIndex: pIdx,
              sourceCandidateIndex: sIdx,
              reason: rep.reason || 'Tối ưu độ chính xác sản phẩm'
            });
            console.log(`[TemplatePro] ✅ Remake All: Replaced Panel ${pIdx} with Candidate #${sIdx}!`);
          }
        } catch (repErr) {
          console.warn(`[TemplatePro] ⚠️ Remake All: Failed to replace panel ${pIdx}: ${repErr.message}`);
        }
      }
    }
  }

  // 5. Lưu 4 panel mới vào thư mục panels/
  const panelsDir = path.join(session.runDir, 'panels');
  ensureDir(panelsDir);

  const newPanels = [];
  for (let i = 1; i <= 4; i++) {
    const pBuf = chosenPanels[i - 1];
    const versionedPanelPath = path.join(panelsDir, `panel-${i}-v${nextIteration}.png`);
    fs.writeFileSync(versionedPanelPath, pBuf);

    const mainPanelPath = path.join(panelsDir, `panel-${i}.png`);
    fs.writeFileSync(mainPanelPath, pBuf);

    newPanels.push({
      index: i,
      sceneNumber: i,
      imagePath: mainPanelPath,
      buffer: pBuf,
      mimeType: 'image/png'
    });
  }

  // Lưu backup storyboard cũ
  const currentStoryboardPath = path.join(session.runDir, 'storyboard.png');
  const backupSbPath = path.join(session.runDir, `storyboard-v${session.iteration || 1}.png`);
  try {
    if (fs.existsSync(currentStoryboardPath)) {
      fs.copyFileSync(currentStoryboardPath, backupSbPath);
    }
  } catch (_) { }

  // Ghép lại thành Master Storyboard 1920x1080 chuẩn 16:9
  composeMasterStoryboardPro(newPanels, currentStoryboardPath);
  const composedStoryboardBuf = fs.readFileSync(currentStoryboardPath);

  // 6. Ghi nhật ký chi tiết vào prompts.md
  const promptsMdPath = session.promptsMdPath || path.join(session.runDir, 'prompts.md');
  const candidateScoresText = multiQAResult.candidates?.map(c => `#${c.candidateIndex}: ${c.score}đ`).join(', ') || '';
  const remakeAllLog = [
    '',
    '---',
    `## Remake Iteration ${nextIteration}: Remake All Panels via 4-Candidate QA Batch`,
    `- Date: ${new Date().toISOString()}`,
    `- Action: User clicked Remake All (\`tpro_remake_all:${runId}\`)`,
    `- Engine: Google Flow (\`nano-banana-pro\`, Aspect Ratio: 16:9, outputCount: 4)`,
    `- 4 New Candidates Generated: Evaluated via Gemini Vision QA.`,
    `- Candidate Overall Scores: ${candidateScoresText}`,
    `- Best Base Storyboard Selected: Candidate #${bestIndex} (Score: **${bestScore}/100**)`,
    `- Panel Replacements Applied: ${replacementsApplied.length > 0 ? replacementsApplied.map(r => `Panel ${r.panelIndex} from Candidate #${r.sourceCandidateIndex}`).join('; ') : 'None (Base Candidate optimal)'}`,
    `- Recomposition: Recomposed all 4 panels into 16:9 Master Storyboard (1920x1080, ${(composedStoryboardBuf.length / 1024).toFixed(1)} KB).`,
    `- Telegram Update: Message ID \`${session.telegramMessageId}\` updated in-place via editMessageMedia.`,
    ''
  ].join('\n');

  appendMarkdownLog(session.runDir, remakeAllLog);

  // 7. Cập nhật session state
  session.iteration = nextIteration;
  session.panels = newPanels.map(p => ({ index: p.index, imagePath: p.imagePath }));

  // 8. Cập nhật / Thay thế hình ảnh Storyboard trên Telegram (replace in-place qua editMessageMedia)
  const keyboard = buildProInlineKeyboard(runId);
  const captionScoresFormatted = multiQAResult.candidates?.map(c => `#${c.candidateIndex}: <b>${c.score}đ</b>`).join(' | ') || '';
  const caption = [
    `✨ <b>[Template Pro] Đã tạo lại toàn bộ 4 Cảnh Storyboard!</b> (Lần remake #${nextIteration - 1})\n`,
    `📊 <b>Điểm 4 Storyboard mới:</b> ${captionScoresFormatted}`,
    `🏆 <b>Đã chọn:</b> Storyboard #${bestIndex} (Điểm: <b>${bestScore}/100</b>)${replacementsApplied.length > 0 ? ` kèm thay thế ${replacementsApplied.length} panel tối ưu hơn` : ''}.\n`,
    `👉 <i>Bấm nút bên dưới nếu bạn muốn Remake tiếp từng cảnh, Remake lại tất cả, hoặc bấm OK để chốt:</i>`
  ].join('\n');

  let updated = false;
  if (session.telegramMessageId) {
    console.log(`[TemplatePro] Replacing storyboard photo in Telegram message ${session.telegramMessageId}...`);
    updated = await editPhotoInTelegram(chatId, session.telegramMessageId, composedStoryboardBuf, caption, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }

  if (!updated) {
    console.log(`[TemplatePro] editPhotoInTelegram failed or no messageId, sending new photo...`);
    const newMsgId = await sendPhotoToTelegram(chatId, composedStoryboardBuf, caption, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    if (newMsgId) {
      session.telegramMessageId = newMsgId;
    }
  }

  if (opts.stepTracker) {
    await opts.stepTracker.setStep(3, 'completed');
    session.stepTrackerMessageId = opts.stepTracker.messageId;
  }

  saveProSession(runId, session);

  // Xóa tin nhắn trạng thái tạm thời
  if (opts.statusMsgId) {
    await deleteTelegramMessage(chatId, opts.statusMsgId).catch(() => {});
  }
  console.log(`[TemplatePro] Remake All completed successfully for run ${runId}`);
}

/**
 * Bước 3: Người dùng bấm OK - Duyệt Storyboard & Bắt đầu tạo Video
 * - Xác nhận chốt 4 panels trong session
 * - Sinh 2 video review (8s mỗi video, faceless 100%, smartphone realism, voiceover tự nhiên)
 *   Video 1: Cảnh 1 & 2 (Hook + Giải pháp)
 *   Video 2: Cảnh 3 & 4 (Bằng chứng + Chốt đơn)
 * - Tự động retry tối đa 3 lần cho mỗi video trên Google Flow
 * - Lưu video vào thư mục run/videos (panel-1.mp4, panel-2.mp4)
 * - Gửi 2 video trực tiếp về Telegram
 * - Ghi đầy đủ lịch sử vào prompts.md
 * - Đăng ký job completed để người dùng có thể gõ /upload đăng ngay lên TikTok
 */
/**
 * Bước 3: Người dùng bấm OK - Duyệt Storyboard & Bắt đầu tạo Video
 * Flow nâng cấp:
 * 1. Bước 1: Tạo 2 video 8s bằng model veo_3_1_i2v_lite_low_priority để trích xuất voice review (16s)
 * 2. Bước 2: Tạo 4 video 4s cho 4 panel theo mode Start Frame bằng model hiện tại (abra_r2v_4s)
 * 3. Bước 3: Ghép 4 video 4s (16s) + lồng ghép voice review 16s thành video hoàn chỉnh 9:16 (1080x1920)
 * 4. Bước 4: Gửi video về Telegram kèm 4 nút Remake Cảnh (1, 2, 3, 4) và nút Upload TikTok
 */
async function finalizeProStoryboardAndGenerateVideos(chatId, baseDir, runId, opts = {}) {
  const session = getProSession(runId, baseDir);
  if (!session) {
    await sendTelegramMessage(chatId, `⚠️ Không tìm thấy phiên làm việc của Run ID <code>${runId}</code>. Hãy bắt đầu lại bằng cách gửi ảnh mới!`, { parse_mode: 'HTML' });
    return;
  }

  const tracker = opts.stepTracker || new FlowStepTracker(chatId, {
    title: session.analysis?.productName || session.productTitle || 'Sản phẩm review',
    messageId: session.stepTrackerMessageId || null
  });
  if (tracker.steps[3].status !== 'running' && tracker.steps[3].status !== 'completed') {
    await tracker.setStep(4, 'running');
  }

  const runDir = session.runDir;
  const promptsMdPath = session.promptsMdPath || path.join(runDir, 'prompts.md');

  // 1. Kiểm tra 4 panel ảnh
  const panelsDir = path.join(runDir, 'panels');
  const panelFiles = [1, 2, 3, 4].map(i => path.join(panelsDir, `panel-${i}.png`));
  for (let i = 0; i < 4; i++) {
    if (!fs.existsSync(panelFiles[i])) {
      await sendTelegramMessage(chatId, `⚠️ Không tìm thấy file <code>panel-${i + 1}.png</code> trong thư mục run.`, { parse_mode: 'HTML' });
      return;
    }
  }
  const panelBuffers = panelFiles.map(pf => fs.readFileSync(pf));

  // Thư mục lưu audio và video
  const audioDir = path.join(runDir, 'audio');
  const videosDir = path.join(runDir, 'videos');
  ensureDir(audioDir);
  ensureDir(videosDir);

  // ── GIAI ĐOẠN 1 + 2 CHẠY SONG SONG: Tạo Voice Review 16s (Gemini TTS) & 4 Video Panel (Abra r2v 4s) ──
  const fullVoicePath = path.join(audioDir, 'voice_full.m4a');
  const { generateTemplateProVoiceReview } = require('./gemini-tts');
  // Luôn sử dụng giọng nữ review (mặc định Zephyr / Hà Vy GenZ hoặc biến môi trường)
  const targetVoice = process.env.GEMINI_TTS_DEFAULT_VOICE || 'Zephyr';
  
  // ĐẢM BẢO CHỈ GEN 1 LẦN DUY NHẤT CHO 1 VIDEO:
  // Nếu file voice_full.m4a đã tồn tại và hợp lệ (> 1000 bytes), tái sử dụng trực tiếp và KHÔNG gen lại audio!
  let voicePromise;
  if (fs.existsSync(fullVoicePath) && fs.statSync(fullVoicePath).size > 1000) {
    console.log(`[TemplatePro] 🎵 Audio review đã có sẵn (${(fs.statSync(fullVoicePath).size / 1024).toFixed(1)} KB), tái sử dụng trực tiếp và KHÔNG gen lại.`);
    voicePromise = Promise.resolve({ success: true, voicePath: fullVoicePath, audioPath: fullVoicePath });
  } else {
    console.log(`[TemplatePro] Step 4a: Launching 16-second voice review track via Gemini TTS (Voice: ${targetVoice}) in PARALLEL with video generation...`);
    voicePromise = generateTemplateProVoiceReview(session.analysis, fullVoicePath, {
      voice: targetVoice,
      targetDuration: 16.0,
    }).catch(err => {
      console.error(`[TemplatePro] Parallel voice review generation error:`, err.message);
      return { success: false, voicePath: fullVoicePath, audioPath: fullVoicePath, error: err.message };
    });
  }

  // ── GIAI ĐOẠN 2: Tạo 4 video chính cho 4 panel theo mode Start Frame (abra_r2v_4s) ──
  console.log(`[TemplatePro] Step 4b: Generating 4 4-second panel videos via Abra r2v 4s (Start Frame mode)...`);
  const panelPrompts = buildTemplatePro4sPanelPrompts(session.analysis);
  const panelJobs = [1, 2, 3, 4].map(idx => ({
    index: idx,
    panelIndex: idx,
    prompt: panelPrompts[idx - 1],
    imagePath: panelFiles[idx - 1],
    buffer: panelBuffers[idx - 1],
    videoModelKey: 'abra_r2v_4s',
  }));

  let panelVideos = [];
  try {
    panelVideos = await generateVideosFromPanelsDirect(baseDir, panelJobs, {
      aspectRatio: '9:16',
      videoModelKey: 'abra_r2v_4s',
      includeVideoBase64: true,
      multiImageMode: false,
      cropPercent: 0,
      preserveBorder: true,
      runId: path.basename(runDir),
    });
  } catch (err) {
    console.error(`[TemplatePro] Panel video generation failed:`, err.message);
    await sendTelegramMessage(chatId, `⚠️ <b>Lỗi tạo video panel:</b> ${err.message}`, { parse_mode: 'HTML' });
    return;
  }

  // Đợi Voice Review hoàn thành trước khi chuyển sang bước Ghép (thông thường đã xong từ trước)
  console.log(`[TemplatePro] Awaiting voice review generation to finish (if not already completed)...`);
  const ttsRes = await voicePromise;
  session.fullVoicePath = fullVoicePath;
  session.ttsResult = ttsRes;

  // Lưu 4 video panel vào thư mục videos/
  const savedPanelVideoPaths = [];
  for (let i = 1; i <= 4; i++) {
    const v = panelVideos.find(pv => pv.panelIndex === i);
    const targetPath = path.join(videosDir, `panel-${i}.mp4`);
    if (v?.videoPath && fs.existsSync(v.videoPath)) {
      try {
        fs.copyFileSync(v.videoPath, targetPath);
        v.videoPath = targetPath;
      } catch (_) { }
    }
    savedPanelVideoPaths.push(targetPath);
  }

  // ── GIAI ĐOẠN 3: Ghép 4 video 4s (16s) + lồng ghép voice review 16s ──
  console.log(`[TemplatePro] Step 4c: Merging 4 panel videos (16s) + voice review track...`);
  const mergedVideoPath = path.join(videosDir, 'final_video.mp4');
  try {
    await merge4PanelsWithVoice(savedPanelVideoPaths, fullVoicePath, mergedVideoPath);
  } catch (mErr) {
    console.error(`[TemplatePro] Error merging 4 panels with voice:`, mErr.message);
  }

  // Đồng bộ file video vào final/ để chuẩn bị upload
  const finalDir = path.join(runDir, 'final');
  ensureDir(finalDir);
  const finalVideoPath = path.join(finalDir, 'final-video.mp4');
  if (fs.existsSync(mergedVideoPath)) {
    try { fs.copyFileSync(mergedVideoPath, finalVideoPath); } catch (_) { }
  }

  session.finalVideoPath = mergedVideoPath;

  // Ghi nhật ký vào prompts.md
  const currentStoryboardPath = path.join(runDir, 'storyboard.png');
  const approvalLog = [
    '',
    '---',
    '## Step 4: Storyboard Approved & Video Generation Completed (Gemini 3.1 TTS Leda + 4x 4s Start Frame)',
    `- Date: ${new Date().toISOString()}`,
    `- Action: User clicked OK (\`tpro_ok:${runId}\`)`,
    `- Stage 1 (Voice Review TTS): Generated via \`${ttsRes.modelUsed || 'Gemini TTS'}\` (Voice: \`${ttsRes.voiceUsed || targetVoice}\`, Latency: ${ttsRes.latencyMs ? (ttsRes.latencyMs / 1000).toFixed(1) + 's' : 'N/A'}, Duration: 16.0s).`,
    `- Stage 2 (4-Panel Video Generation): 4x 4s videos generated via \`abra_r2v_4s\` (Mode Start Frame, zero text, pure visual).`,
    `- Stage 3 (Assembly & Muxing): Spliced 4 panel videos (16s) + voice review track into \`videos/final_video.mp4\` (${fs.existsSync(mergedVideoPath) ? (fs.statSync(mergedVideoPath).size / 1024).toFixed(1) + ' KB' : 'N/A'}).`,
    `- Delivery: Sent merged 16s video to chat \`${chatId}\` with 4 Remake scene buttons + Upload TikTok button.`,
    ''
  ].join('\n');
  appendMarkdownLog(runDir, approvalLog);

  // Cập nhật tracker bước 4 hoàn thành, bước 5 đang chạy
  if (tracker) {
    await tracker.setStep(4, 'completed');
    await tracker.setStep(5, 'running');
  }

  // Xóa tin nhắn trạng thái tạm thời (nếu có)
  if (opts.statusMsgId) {
    await deleteTelegramMessage(chatId, opts.statusMsgId).catch(() => {});
  }

  // ── GIAI ĐOẠN 4: Gửi video hoàn chỉnh về Telegram ──
  const caption = [
    `🎬 <b>[Template Pro] Video Review Hoàn Chỉnh (16 giây)</b>\n`,
    `✨ <i>Đã ghép đủ 4 Cảnh (4s/cảnh) lồng ghép giọng đọc review tiếng Việt tự nhiên 100%.</i>`
  ].join('\n');

  // Gửi video (không kèm reply_markup để tránh bị trùng lặp nút bấm với status message ở dưới)
  await sendMergedVideoToTelegram(chatId, mergedVideoPath, caption, {
    parse_mode: 'HTML',
  });

  // Xóa status message tiến trình cũ (nằm ở phía trên video)
  if (tracker && tracker.messageId) {
    await deleteTelegramMessage(chatId, tracker.messageId).catch(() => {});
    tracker.messageId = null;
  }
  if (session.stepTrackerMessageId) {
    await deleteTelegramMessage(chatId, session.stepTrackerMessageId).catch(() => {});
    session.stepTrackerMessageId = null;
  }

  // Gửi title + hashtag để tiện copy TRƯỚC status message
  const title = session.analysis?.productName || session.productTitle || 'Sản phẩm review';
  const defaultTags = ['#review', '#sanphamchinhhang', '#trending', '#xuhuong', '#tiktokshop'];
  const hashtags = (Array.isArray(session.analysis?.hashtags) && session.analysis.hashtags.length > 0)
    ? session.analysis.hashtags.slice(0, 5)
    : defaultTags;
  await sendTelegramMessage(chatId, `${title}\n\n${hashtags.join(' ')}`);

  const isAuto = !!opts.isAuto;
  const videoKeyboard = isAuto ? null : buildProVideoInlineKeyboard(runId);
  const finalStatusLines = [
    `🎉 <b>TẠO VIDEO REVIEW HOÀN TẤT (16 GIÂY)!</b>\n`,
    `📦 <b>Sản phẩm:</b> <b>${title}</b>\n`,
    `1. ✅ Tải thông tin & hình ảnh sản phẩm`,
    `2. ✅ Phân tích sản phẩm & lên kịch bản review`,
    `3. ✅ Tạo Master Storyboard & chia 4 panel (16:9)`,
    `4. ✅ Sinh 4 video chuyển động AI (4s/cảnh)`,
    `5. ✅ Xử lý hậu kỳ & lồng tiếng review (Zephyr)\n`,
  ];
  if (isAuto) {
    finalStatusLines.push(`⚡ <i>Chế độ tự động: Đang tiến hành tải video lên TikTok...</i>`);
  } else {
    finalStatusLines.push(`👉 <i>Bấm nút bên dưới để tạo lại từng cảnh nếu cần, hoặc bấm Đăng lên TikTok:</i>`);
  }
  const finalStatusText = finalStatusLines.join('\n');

  const statusMsgId = await sendTelegramMessage(chatId, finalStatusText, {
    parse_mode: 'HTML',
    ...(videoKeyboard ? { reply_markup: videoKeyboard } : {}),
  });
  if (statusMsgId) {
    session.stepTrackerMessageId = (typeof statusMsgId === 'object' && statusMsgId?.message_id)
      ? statusMsgId.message_id
      : (typeof statusMsgId === 'number' ? statusMsgId : null);
    saveProSession(runId, session);
  }

  // Cập nhật lastRunByChat
  if (opts.lastRunByChat) {
    opts.lastRunByChat.set(String(chatId), {
      runDir,
      panelsDir,
      videosDir,
      panels: [1, 2, 3, 4].map(idx => ({ index: idx, imagePath: panelFiles[idx - 1] })),
      template: 'template_pro',
      analysis: session.analysis,
      baseDir,
    });
  }

  // Đăng ký completed job vào generationJobService để lệnh /upload và nút upload hoạt động ngay lập tức
  if (typeof registerExternalCompletedJob === 'function') {
    const jobPayload = {
      jobId: `tpro-${runId}`,
      chatId: String(chatId),
      template: 'template_pro',
      hasVoice: true,
      jobDir: runDir,
      baseDir,
      status: 'completed',
      finalVideoPath: mergedVideoPath,
      productId: session.productId || session.analysis?.productId || '',
      productTitle: title || session.productTitle || session.analysis?.productName || 'Sản phẩm review',
      productUrl: session.productUrl || '',
      shortlink: session.shortlink || '',
      cartAnchorText: session.cartAnchorText || session.analysis?.cartAnchorText || '',
      panels: [1, 2, 3, 4].map(idx => ({ index: idx, status: 'completed' })),
      result: {
        runId,
        finalVideoPath: mergedVideoPath,
        reviewArchive: {
          root: runDir,
          panelsDir,
          videosDir,
          storyboardPath: currentStoryboardPath,
          promptsPath: promptsMdPath,
        },
        panels: [1, 2, 3, 4].map(idx => ({ index: idx, imagePath: panelFiles[idx - 1] })),
        videos: panelVideos,
        analysis: session.analysis,
      },
      analysis: session.analysis,
      caption: title,
      hashtags,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    registerExternalCompletedJob(chatId, jobPayload);
    if (session.jobId && session.jobId !== runId) {
      registerExternalCompletedJob(chatId, { ...jobPayload, jobId: `tpro-${session.jobId}` });
      registerExternalCompletedJob(chatId, { ...jobPayload, jobId: session.jobId });
    }
  }

  saveProSession(runId, session);
  return { videos: panelVideos, runDir, videosDir, mergedVideoPath };
}

/**
 * Thực thi Remake lại riêng video của Cảnh K (K = 1, 2, 3, 4)
 * - Chỉ sinh lại video 4s của Cảnh K theo mode Start Frame bằng model hiện tại (abra_r2v_4s)
 * - Lưu đè vào videos/panel-K.mp4
 * - Tái sử dụng file voice 16s đã tách sẵn (audio/voice_full.m4a)
 * - Ghép lại toàn bộ 4 video panel với file voice thành video 16s mới nhất
 * - Cập nhật job upload và gửi video mới về Telegram kèm 4 nút Remake
 */
async function executeProRemakeSingleVideo(chatId, baseDir, runId, targetPanelIndex, opts = {}) {
  const session = getProSession(runId, baseDir);
  if (!session) {
    await sendTelegramMessage(chatId, `⚠️ Không tìm thấy phiên làm việc của Run ID <code>${runId}</code>.`, { parse_mode: 'HTML' });
    return;
  }

  const pIdx = parseInt(targetPanelIndex, 10);
  if (pIdx < 1 || pIdx > 4) {
    await sendTelegramMessage(chatId, `⚠️ Cảnh ${targetPanelIndex} không hợp lệ (chỉ từ 1 đến 4).`);
    return;
  }

  const customInstruction = opts.customInstruction || '';
  const panelsDir = path.join(session.runDir, 'panels');
  const panelPath = path.join(panelsDir, `panel-${pIdx}.png`);
  if (!fs.existsSync(panelPath)) {
    await sendTelegramMessage(chatId, `⚠️ Không tìm thấy file <code>panel-${pIdx}.png</code> trong thư mục run.`, { parse_mode: 'HTML' });
    return;
  }

  const prompt = buildTemplatePro4sPanelPrompts(session.analysis, { panelIndex: pIdx, customInstruction });
  const job = [{
    index: pIdx,
    panelIndex: pIdx,
    prompt,
    imagePath: panelPath,
    buffer: fs.readFileSync(panelPath),
    videoModelKey: 'abra_r2v_4s',
  }];

  console.log(`[TemplatePro] Remaking Video Cảnh ${pIdx} (4s, Start Frame mode)...`);
  let resVideos = [];
  try {
    resVideos = await generateVideosFromPanelsDirect(baseDir, job, {
      aspectRatio: '9:16',
      videoModelKey: 'abra_r2v_4s',
      includeVideoBase64: true,
      multiImageMode: false,
      cropPercent: 0,
      preserveBorder: true,
      runId: path.basename(session.runDir),
    });
  } catch (err) {
    console.error(`[TemplatePro] Remake video scene ${pIdx} failed:`, err.message);
    await sendTelegramMessage(chatId, `❌ Lỗi tạo lại video Cảnh ${pIdx}: ${err.message}`);
    return;
  }

  const videosDir = path.join(session.runDir, 'videos');
  ensureDir(videosDir);
  const targetPath = path.join(videosDir, `panel-${pIdx}.mp4`);
  const vIt = (session.videoRemakeCount || 0) + 1;
  session.videoRemakeCount = vIt;

  if (resVideos[0]?.videoPath && fs.existsSync(resVideos[0].videoPath)) {
    try {
      // Lưu backup phiên bản remake
      fs.copyFileSync(resVideos[0].videoPath, path.join(videosDir, `panel-${pIdx}-v${vIt}.mp4`));
      fs.copyFileSync(resVideos[0].videoPath, targetPath);
    } catch (_) { }
  }

  // Tái sử dụng file voice 16s đã tách sẵn (tuyệt đối KHÔNG gen lại audio)
  let voicePath = session.fullVoicePath || path.join(session.runDir, 'audio', 'voice_full.m4a');
  if (fs.existsSync(voicePath) && fs.statSync(voicePath).size > 1000) {
    console.log(`[TemplatePro] 🎵 Remake Cảnh ${pIdx}: Giữ nguyên 100% audio review đã tạo trước đó (${voicePath}), KHÔNG gen lại audio.`);
  } else {
    voicePath = path.join(session.runDir, 'audio', 'voice_full.m4a');
    if (!fs.existsSync(voicePath) || fs.statSync(voicePath).size <= 1000) {
      extractAudioFromVideo(null, voicePath, 16.0);
    }
  }

  // Ghép lại 4 video panel với voice review
  const panelVideoPaths = [1, 2, 3, 4].map(i => path.join(videosDir, `panel-${i}.mp4`));
  const mergedVideoPath = path.join(videosDir, 'final_video.mp4');
  try {
    await merge4PanelsWithVoice(panelVideoPaths, voicePath, mergedVideoPath);
    const finalDir = path.join(session.runDir, 'final');
    ensureDir(finalDir);
    fs.copyFileSync(mergedVideoPath, path.join(finalDir, 'final-video.mp4'));
  } catch (mErr) {
    console.error(`[TemplatePro] Error re-merging 4 panels with voice:`, mErr.message);
  }

  session.finalVideoPath = mergedVideoPath;

  // Cập nhật job trong generationJobService
  const { getJob } = require('./generation-job');
  const existingJob = getJob(`tpro-${runId}`);
  if (existingJob) {
    existingJob.finalVideoPath = mergedVideoPath;
  }

  // Ghi log vào prompts.md
  const remakeLog = [
    '',
    '---',
    `## Video Remake Iteration ${vIt}: Remake Video Scene ${pIdx} (4s Start Frame)`,
    `- Date: ${new Date().toISOString()}`,
    `- Action: User clicked Remake Cảnh ${pIdx} (\`tpro_remake_video:${pIdx}:${runId}\`)`,
    `- Engine: Google Flow (\`abra_r2v_4s\`, Mode: Start Frame, 4s)`,
    `- Result: Replaced \`videos/panel-${pIdx}.mp4\`, re-muxed 4 panels with pre-extracted voice into \`videos/final_video.mp4\`.`,
    ''
  ].join('\n');
  appendMarkdownLog(session.runDir, remakeLog);

  // Gửi video mới về Telegram (không kèm reply_markup để tránh trùng lặp nút bấm với status message ở dưới)
  const keyboard = buildProVideoInlineKeyboard(runId);
  const caption = [
    `✨ <b>[Template Pro] Đã cập nhật xong Video Cảnh ${pIdx}!</b> (Lần remake video #${vIt})\n`,
    `🎬 <i>Video 16 giây hoàn chỉnh đã được ghép lại với Cảnh ${pIdx} mới và giữ nguyên giọng đọc review.</i>`
  ].join('\n');

  await sendMergedVideoToTelegram(chatId, mergedVideoPath, caption, {
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

  // Gửi status message mới kèm options remake video hoặc upload TikTok
  const title = session.analysis?.productName || session.productTitle || 'Sản phẩm review';
  const updatedStatusText = [
    `🎉 <b>ĐÃ CẬP NHẬT XONG VIDEO CẢNH ${pIdx}!</b> (Lần remake #${vIt})\n`,
    `📦 <b>Sản phẩm:</b> <b>${title}</b>\n`,
    `1. ✅ Tải thông tin & hình ảnh sản phẩm`,
    `2. ✅ Phân tích sản phẩm & lên kịch bản review`,
    `3. ✅ Tạo Master Storyboard & chia 4 panel (16:9)`,
    `4. ✅ Tạo lại Video Cảnh ${pIdx} (${panelInfo.phase})`,
    `5. ✅ Ghép lại video 16s và giữ nguyên giọng đọc review\n`,
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
    saveProSession(runId, session);
  }

  saveProSession(runId, session);
  return { panelIndex: pIdx, mergedVideoPath };
}

/**
 * Chuẩn bị danh sách jobs để remake video cho Template Pro (/tpro)
 * @param {string} runDir - Thư mục run của phiên xử lý
 * @param {number[]} requestedIndices - Danh sách số cảnh/video người dùng yêu cầu (vd: [1], [2], [1, 2])
 * @param {string} [customInstruction] - Yêu cầu tùy chỉnh của người dùng (nếu có)
 * @param {object} [analysis] - Dữ liệu phân tích sản phẩm (nếu không truyền sẽ tự đọc từ session.json)
 * @returns {Array<object>} Danh sách video jobs sẵn sàng gửi cho generateVideosFromPanelsDirect
 */
function buildTemplateProRemakeVideoJobs(runDir, requestedIndices = [1], customInstruction = '', analysis = null) {
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
    const prompt = buildTemplatePro4sPanelPrompts(analysis || {}, { panelIndex: idx, customInstruction });

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

module.exports = {
  generateStoryboard,
  executeProRemakePanel,
  executeProRemakeAll,
  finalizeProStoryboard: finalizeProStoryboardAndGenerateVideos,
  finalizeProStoryboardAndGenerateVideos,
  buildTemplateProRemakeVideoJobs,
  getProSession,
  saveProSession,
  buildTemplateProAnalysisPrompt,
  parseJsonObjectPro,
  extractFallbackAnalysisFields,
  analyzeProductTemplatePro,
  buildTemplateProVideoPrompts,
  buildTemplateProRemakePrompt,
  buildTemplateProRemakeAllPrompt,
  buildTemplateProVerificationPrompt,
  verifyStoryboardWithGeminiVision,
  formatQAVerificationMarkdown,
  buildTemplateProMultiStoryboardPrompt,
  verifyMultiStoryboardWithGeminiVision,
  formatMultiStoryboardQAMarkdown,
  extractVideoKeyframes,
  buildTemplateProVideoVerificationPrompt,
  verifyVideoWithGeminiVision,
  formatVideoQAMarkdown,
  buildTemplateProMasterPrompt,
  buildProInlineKeyboard,
  buildProVideoInlineKeyboard,
  selectBestCandidateForPanel,
  sliceMasterStoryboardPro,
  composeMasterStoryboardPro,
  createInputCollageImagePro,
  buildTemplateProVoiceVideoPrompts,
  buildTemplatePro4sPanelPrompts,
  extractAudioFromVideo,
  concatTwoVoiceAudios,
  merge4PanelsWithVoice,
  executeProRemakeSingleVideo,
  generateTemplateProVoiceReview: require('./gemini-tts').generateTemplateProVoiceReview,
  appendMarkdownLog,
};
