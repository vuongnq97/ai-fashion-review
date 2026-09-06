'use strict';
const { execSync } = require('child_process');

/**
 * template5-storyboard.js
 *
 * Template 5: Review Đa Ngành Hàng 4 Cảnh 6 Giây (Không Dùng Ảnh Ref Tĩnh)
 *
 * Luồng hoạt động:
 * 1. Phân tích ảnh sản phẩm (bất kỳ ngành hàng: thời trang, mỹ phẩm, gia dụng, công nghệ, phụ kiện)
 *    qua Gemini API theo kiến trúc prompt chuẩn của template mặc định.
 * 2. Gọi Gemini API tạo Master Storyboard 4 cảnh (16:9 chứa 4 khung dọc 9:16) có ch tiếng Việt.
 * 3. Gọi Gemini API tách/tạo 4 panel 9:16 riêng biệt có typography tiếng Việt thẩm mỹ, đúng chính tả.
 * 4. Gọi Google Flow Veo 3 tạo 4 video 9:16 thời lượng đúng 6 giây bằng 100% prompt tiếng Việt,
 *    gi nguyên ch từ panel, hoàn toàn không có tiếng review / voice-over.
 * 5. Lưu tr archive và trả về kết quả cho Telegram bot.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateVideosFromPanelsDirect } = require('./gemini-webapi-storyboard');
const { GeminiApiClient } = require('./gemini-client/gemini-api');
const { sendPhotoToTelegram, sendOrUpdateLivePanel } = require('./telegram-send');
const { buildCartCtaPromptGuide, getCartAnchorText } = require('./cart-cta');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function stripCodeFence(text) {
  let cleaned = (text || '').trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  return cleaned.trim();
}

/**
 * Xử lý làm sạch sâu và tự động sửa chuỗi JSON thô từ LLM (Gemini):
 * 1. Loại bỏ markdown code fence và văn bản thừa ngoài JSON
 * 2. Loại bỏ comments (// hoặc block comments)
 * 3. Tự động bọc ngoặc kép cho keys chưa có ngoặc kép (productName: -> "productName":)
 * 4. Tự động escape dấu ngoặc kép lồng bên trong chuỗi ("sản phẩm "xịn" này" -> "sản phẩm \"xịn\" này")
 * 5. Tự động bù dấu phẩy thiếu giữa các phần tử array và object properties
 * 6. Loại bỏ trailing commas (dấu phẩy thừa trước } hoặc ]) và leading commas
 * 7. Tự động chuyển ký tự điều khiển (newlines, carriage returns, tabs) bên trong chuỗi
 * 8. Tự động đóng ngoặc } hoặc ] nếu JSON bị ngắt giữa chừng
 */
function cleanRawJson(text) {
  if (!text) return '';
  let s = String(text).trim();

  // 1. Bỏ code fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // 2. Tìm phạm vi JSON ngoài cùng ({ ... } hoặc [ ... ])
  const startObj = s.indexOf('{');
  const startArr = s.indexOf('[');
  let start = -1;
  if (startObj >= 0 && startArr >= 0) start = Math.min(startObj, startArr);
  else if (startObj >= 0) start = startObj;
  else if (startArr >= 0) start = startArr;

  const endObj = s.lastIndexOf('}');
  const endArr = s.lastIndexOf(']');
  let end = Math.max(endObj, endArr);

  if (start >= 0 && end > start) {
    s = s.slice(start, end + 1);
  } else if (start >= 0) {
    s = s.slice(start);
  }

  // 3. Xoá comments
  s = s.replace(/\/\/[^\r\n]*/g, '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');

  // 4. Duyệt dòng để chuẩn hoá keys và dấu ngoặc kép lồng nhau
  const rawLines = s.split(/\r?\n/);
  const lines = [];

  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i];
    let trimmed = line.trim();
    if (!trimmed) continue;

    // Bọc ngoặc kép cho unquoted key ở đầu dòng: key: => "key":
    line = line.replace(/^(\s*)([a-zA-Z0-9_]+)\s*:/, '$1"$2":');
    // Bọc ngoặc kép cho unquoted key sau { hoặc , : { key: => { "key":
    line = line.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');

    // Escape ngoặc kép lồng bên trong property value: "key": "abc "xyz" def"[,]
    const propMatch = line.match(/^(\s*"[a-zA-Z0-9_]+"\s*:\s*")(.*)("(?:\s*,)?\s*)$/);
    if (propMatch) {
      const prefix = propMatch[1];
      const middle = propMatch[2].replace(/(?<!\\)"/g, '\\"');
      const suffix = propMatch[3];
      line = prefix + middle + suffix;
    } else {
      // Escape ngoặc kép lồng bên trong array item: "abc "xyz" def"[,]
      const arrMatch = line.match(/^(\s*")(.*)("(?:\s*,)?\s*)$/);
      if (arrMatch) {
        const prefix = arrMatch[1];
        const middle = arrMatch[2].replace(/(?<!\\)"/g, '\\"');
        const suffix = arrMatch[3];
        line = prefix + middle + suffix;
      }
    }
    lines.push(line);
  }

  // 5. Bù dấu phẩy bị thiếu giữa các dòng liên tiếp
  const cleanedLines = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trim();
    const nextTrimmed = (lines[i + 1] || '').trim();

    const endsWithValue = /(?:"|\d+|true|false|null|\}|\])$/.test(trimmed);
    const nextStartsItem = /^("[a-zA-Z0-9_]+"\s*:|\{|\[|"(?:[^"\\]|\\.)*")/.test(nextTrimmed);
    const nextIsClose = /^(\}|\])/.test(nextTrimmed);

    if (endsWithValue && nextStartsItem && !nextIsClose && !trimmed.endsWith(',')) {
      line = line + ',';
    }
    cleanedLines.push(line);
  }

  s = cleanedLines.join('\n');

  // 6. Xoá trailing commas trước } hoặc ]
  s = s.replace(/,\s*([\}\]])/g, '$1');

  // 7. Xoá leading commas sau { hoặc [
  s = s.replace(/([\{\[])\s*,/g, '$1');

  // 8. Chuyển đổi ký tự điều khiển trong chuỗi thành escape sequence an toàn
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
      } else if (ch === '\\') {
        out += ch;
        esc = true;
      } else if (ch === '"') {
        out += ch;
        inStr = false;
      } else if (ch === '\n') {
        out += '\\n';
      } else if (ch === '\r') {
        out += '\\r';
      } else if (ch === '\t') {
        out += '\\t';
      } else if (ch.charCodeAt(0) < 32) {
        // bỏ qua control char
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') {
        inStr = true;
        out += ch;
      } else {
        out += ch;
      }
    }
  }

  // 9. Tự động đóng chuỗi và ngoặc nếu JSON bị cắt cụt (truncated)
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else {
      if (c === '"') inString = true;
      else if (c === '{') openBraces++;
      else if (c === '}') openBraces = Math.max(0, openBraces - 1);
      else if (c === '[') openBrackets++;
      else if (c === ']') openBrackets = Math.max(0, openBrackets - 1);
    }
  }

  if (inString) out += '"';
  out = out.replace(/,\s*$/, '');
  while (openBrackets > 0) { out += ']'; openBrackets--; }
  while (openBraces > 0) { out += '}'; openBraces--; }

  return out;
}

/**
 * Fallback trích xuất dữ liệu bằng regex khi JSON bị lỗi cú pháp nghiêm trọng
 */
function extractFieldsByRegex(text) {
  if (!text) return null;
  const getStr = (pattern) => {
    const m = text.match(pattern);
    return m ? m[1].replace(/\\"/g, '"').trim() : '';
  };

  const productName = getStr(/"productName"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/)
    || getStr(/productName\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/)
    || getStr(/"productName"\s*:\s*'([^']*)'/)
    || 'Sản Phẩm Cao Cấp';

  const category = getStr(/"category"\s*:\s*"([^"]+)"/) || 'general';

  const hashtags = [];
  const tagMatches = text.match(/#[a-zA-Z0-9_\u00C0-\u1EF9]+/g) || [];
  tagMatches.forEach(t => { if (!hashtags.includes(t)) hashtags.push(t); });
  if (!hashtags.length) hashtags.push('#review', '#trending', '#sanphamchinhhang');

  const materials = getStr(/"materials"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/) || 'Chất liệu cao cấp, hoàn thiện tỉ mỉ';

  const fourAnswers = {
    hook: getStr(/"hook"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/),
    solution: getStr(/"solution"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/),
    proof: getStr(/"proof"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/),
    closing: getStr(/"closing"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/)
  };

  const headlines = [];
  const hlMatches = text.matchAll(/"headline"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g);
  for (const m of hlMatches) {
    if (m[1]) headlines.push(m[1].trim());
  }

  const voiceOvers = [];
  const voMatches = text.matchAll(/"voiceOver"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g);
  for (const m of voMatches) {
    if (m[1]) voiceOvers.push(m[1].trim());
  }

  const defaultHeadlines = ['THIẾT KẾ TINH TẾ', 'CHẤT LIỆU CAO CẤP', 'TRẢI NGHIỆM ÊM ÁI', 'TIỆN NGHI MỖI NGÀY'];
  const panelOverlays = [1, 2, 3, 4].map(id => ({
    id,
    headline: headlines[id - 1] || defaultHeadlines[id - 1],
    subtexts: ['• Tính năng nổi bật', '• Tiện dụng mỗi ngày']
  }));

  const script = [
    { id: 1, phase: 'Hook', goal: 'Hook dừng lướt', voiceOver: voiceOvers[0] || 'Khám phá ngay sản phẩm đang cực kỳ hot hiện nay.' },
    { id: 2, phase: 'Solution', goal: 'Giới thiệu giải pháp', voiceOver: voiceOvers[1] || 'Thiết kế thông minh mang lại trải nghiệm tuyệt vời mỗi ngày.' },
    { id: 3, phase: 'Proof', goal: 'Bằng chứng chất lượng', voiceOver: voiceOvers[2] || 'Chất liệu hoàn thiện tỉ mỉ, độ bền vượt trội theo thời gian.' },
    { id: 4, phase: 'Closing', goal: 'Chốt đơn giỏ hàng', voiceOver: voiceOvers[3] || 'Bấm ngay vào giỏ hàng góc trái màn hình để sở hữu ngay nhé.' }
  ];

  return {
    analysis: {
      productName,
      category,
      hashtags,
      materials,
      highlights: ['Thiết kế sang trọng', 'Tiện dụng mỗi ngày'],
      targetAudience: 'Người dùng yêu thích sự tiện ích và chất lượng',
      fourAnswers
    },
    voicePersona: {
      gender: 'nu',
      voiceDescription: 'nữ miền Nam ngọt ngào, tự nhiên, gần gũi',
      tone: 'thân thiện, duyên dáng, cuốn hút, review chân thực'
    },
    sceneContext: {
      location: 'Không gian sống hiện đại sáng sủa, nội thất tối giản tinh tế',
      lighting: 'Ánh sáng tự nhiên dịu nhẹ ban ngày kết hợp đèn ấm',
      mood: 'Chân thực, hiện đại, cao cấp'
    },
    panelOverlays,
    script
  };
}

/**
 * Parser đa tầng:
 * Tầng 1: JSON.parse chuẩn
 * Tầng 2: cleanRawJson làm sạch sâu rồi JSON.parse
 * Tầng 3: Regex fallback trích xuất cấu trúc dữ liệu thực
 */
function parseJsonObject(text) {
  const cleaned = stripCodeFence(text);
  // Tầng 1
  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  // Tầng 2
  try {
    const sanitized = cleanRawJson(cleaned);
    return JSON.parse(sanitized);
  } catch (_) {}

  // Tầng 3: Thử slice substring { ... }
  try {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const sliced = cleanRawJson(cleaned.slice(start, end + 1));
      return JSON.parse(sliced);
    }
  } catch (_) {}

  // Tầng 4: Trích xuất bằng Regex thông minh để không bao giờ bị mất dữ liệu
  const extracted = extractFieldsByRegex(text);
  if (extracted && (extracted.analysis?.productName || extracted.panelOverlays?.length)) {
    console.log(`[Template5] ℹ️ Trích xuất metadata từ JSON thô bằng Regex fallback thành công: "${extracted.analysis?.productName}"`);
    return extracted;
  }

  throw new Error(`Could not parse or recover JSON from response (${(text || '').slice(0, 150)}...)`);
}

/**
 * Xây dựng Analysis Prompt đa ngành hàng theo cấu trúc chuẩn của default template
 */
function buildProductContextSection(options = {}) {
  const ctx = options.productContext || {};
  const lines = [];
  if (ctx.productTitle) lines.push(`Product title: ${String(ctx.productTitle).replace(/["\\]/g, "'").trim()}`);
  if (ctx.productId) lines.push(`Product ID: ${ctx.productId}`);
  if (ctx.productUrl) lines.push(`Product URL: ${ctx.productUrl}`);
  if (ctx.productDescription) {
    const cleanDesc = String(ctx.productDescription)
      .slice(0, 1500)
      .replace(/["\\]/g, "'")
      .replace(/[\r\t]/g, ' ')
      .trim();
    lines.push(`Product description from TikTok Shop:\n${cleanDesc}`);
  }
  return lines.length ? `\nTikTok Shop source metadata:\n${lines.join('\n')}\n` : '';
}

function buildTemplate5AnalysisPrompt(options = {}) {
  return `TEXT-ONLY TASK. Do not generate images. Do not call image generation. Do not create a visual storyboard asset.
You are a senior multi-category e-commerce marketing strategist, TikTok viral content director, and Veo 3 prompt writer.
Analyze the uploaded product reference images (which can be any product: Fashion, Clothing, Bags, Footwear, Cosmetics/Skincare, Home Appliances/Kitchenware, Tech Gadgets, Accessories, etc.) and the TikTok Shop product description metadata. Write a comprehensive 4-scene product review plan as JSON text only.
${buildProductContextSection(options)}

CRITICAL 4-SCENE MARKETING FRAMEWORK (BẮT BUỘC TRẢ LỜI ĐỦ 4 CÂU HỎI THEO 4 CẢNH):
Video bao gồm đúng 4 cảnh nội dung (sau này được ghép thành 2 video panel, mỗi video chứa 2 cảnh). Bạn PHẢI trả lời sâu sắc 4 câu hỏi cốt lõi dựa trên đặc tính thực tế của sản phẩm:
1. Cảnh 1 (HOOK) — "Hook gì để người xem dừng lướt?"
   - Chọn một hướng triển khai hook hiệu quả nhất:
     * Nêu nỗi đau thực tế: "Bạn cũng đang gặp tình trạng này?", "Khó chịu nhất là khi..."
     * Gây tò mò: "Ít ai biết mẹo này…", "Cứ ngỡ chỉ là món đồ bình thường..."
     * Thấy ngay kết quả: "Trước và sau chỉ khác nhau vài giây...", "Khác biệt thấy rõ khi..."
     * Cảnh báo chân thành: "Đừng mua [tên sản phẩm] trước khi xem điều này..."
     * So sánh giá trị: "Cùng phân khúc nhưng khác biệt nằm ở đây..."
     * Thử thách: "Liệu món đồ này có làm được thật không?"
2. Cảnh 2 (SOLUTION - GIẢI PHÁP) — "Sản phẩm là giải pháp gì?"
   - Giới thiệu giải pháp rõ ràng & thuyết phục:
     * Giới thiệu trực tiếp: "Đây chính là [tên sản phẩm]."
     * Lợi ích chính: Giúp giải quyết vấn đề nhanh hơn, tiện hơn.
     * Điểm khác biệt: Nêu bật tính năng vượt trội so với loại thông thường trên thị trường.
     * Đối tượng & tính tiện lợi: Phù hợp ai, cách dùng dễ dàng, nhỏ gọn mang theo mọi lúc.
3. Cảnh 3 (PROOF - BẰNG CHỨNG) — "Bằng chứng nào khiến người xem tin tưởng?"
   - Đưa ra bằng chứng vững chắc từ ảnh và mô tả sản phẩm:
     * Demo thực tế sản phẩm đang hoạt động, thao tác tay mượt mà.
     * Cận cảnh chất liệu cao cấp, thành phần, chi tiết cấu tạo, độ hoàn thiện tinh xảo.
     * So sánh trước - sau hoặc thông số kỹ thuật thực tế (độ bền, dung tích, công suất, chất liệu...).
4. Cảnh 4 (CLOSING / CTA - CHỐT ĐƠN) — "Lý do gì để họ mua ngay?"
   - Đòn bẩy hành động dứt khoát:
     * Quà tặng kèm / hỗ trợ vận chuyển hoặc ưu đãi đặt sớm.
     * Cam kết đổi trả / bảo hành chính hãng uy tín.
     * Nhắc lại lợi ích lớn nhất: "Nâng tầm cuộc sống và tiết kiệm thời gian mỗi ngày."
     * Kêu gọi hành động CTA rõ ràng: "Bấm ngay vào giỏ hàng góc trái màn hình để đặt ngay."

QUY TẮC CỐT LÕI (STRICT RULES):
1. TUYỆT ĐỐI KHÔNG SỬ DỤNG CON SỐ GIÁ TIỀN HOẶC % GIẢM GIÁ:
   - Nghiêm cấm các từ ngữ chứa con số cụ thể như "chỉ 99k", "199.000đ", "giảm 50%". Video được sử dụng lâu dài (evergreen), mọi con số cụ thể sẽ bị sai lệch theo thời gian.
   - Dựa vào phần input sản phẩm làm trọng tâm từ hình ảnh và mô tả (Product Description).
2. LỜI THOẠI DỒN DẬP NGẮN GỌN (TỔNG TỐI ĐA 42 TỪ CHO MỖI VIDEO 8 GIÂY GỒM 2 CẢNH, ĐỦ Ý TRỌN VẸN CÂU):
   - Mỗi video 8 giây gồm 2 cảnh, tổng lời thoại voice-over của cả 2 cảnh CỘNG LẠI TỐI ĐA 42 TỪ (mỗi cảnh trong "script" có "voiceOver" dài từ 15 đến 19 từ).
   - Mỗi cảnh PHẢI là một câu (hoặc 2 câu ngắn) HOÀN CHỈNH ĐẦY ĐỦ Ý NGHĨA VÀ CHỦ NGỮ - VỊ NGỮ, KẾT THÚC BẰNG DẤU CHẤM (.), DẤU HỎI (?) HOẶC DẤU CHẤM THAN (!).
   - Tổng Cảnh 1 + Cảnh 2 TUYỆT ĐỐI KHÔNG QUÁ 42 TỪ; tổng Cảnh 3 + Cảnh 4 TUYỆT ĐỐI KHÔNG QUÁ 42 TỪ.
   - Tuyệt đối KHÔNG viết câu dài lê thê dẫn tới bị cắt ngang cụt lủn dở dang, đảm bảo câu nói trọn vẹn và đọc vừa vặn trong 8 giây.
   - Tốc độ đọc: Nhanh, liên tục, dồn dập, tự tin, cuốn hút, giàu năng lượng theo phong cách review TikTok viral.
3. THAO TÁC THỰC TẾ, KHÔNG ẢO CGI:
   - Tuyệt đối không đồ họa hoạt hình, mũi tên phát sáng, kính lúp ảo 3D. Mọi thao tác ("techVFX") phải là cử động tay thật trên sản phẩm thực tế.
4. VOICE PERSONA:
   - "nu" cho đồ nữ, mỹ phẩm, gia dụng, thời trang mềm mại (giọng nữ ngọt ngào, gần gũi, tự nhiên).
   - "nam" cho đồ nam, công nghệ, thiết bị cơ khí, thể thao (giọng nam trầm ấm, tự tin, đáng tin cậy).

5. ${buildCartCtaPromptGuide()}

Return ONLY valid JSON matching this schema:
{
  "analysis": {
    "productName": "Tên sản phẩm tiếng Việt đầy đủ và chính xác từ ảnh/mô tả",
    "category": "fashion|cosmetics|home|gadgets|accessories|other",
    "cartAnchorText": "Câu CTA giỏ hàng ngắn gọn dưới 30 ký tự khớp chính xác đặc tính/lợi ích sản phẩm (ví dụ: Mang siêu êm mua ở đây, Đồ tiện ích mua ở đây, Da căng bóng mua ở đây...)",
    "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
    "materials": "mô tả chất liệu hoặc thành phần nổi bật",
    "highlights": ["điểm nổi bật 1", "điểm nổi bật 2", "điểm nổi bật 3"],
    "targetAudience": "đối tượng người dùng",
    "fourAnswers": {
      "hook": "Câu trả lời phân tích cho Cảnh 1: Hook gì để họ dừng lướt?",
      "solution": "Câu trả lời phân tích cho Cảnh 2: Sản phẩm là giải pháp gì?",
      "proof": "Câu trả lời phân tích cho Cảnh 3: Bằng chứng nào khiến họ tin?",
      "closing": "Câu trả lời phân tích cho Cảnh 4: Lý do gì để họ mua ngay?"
    }
  },
  "voicePersona": {
    "gender": "nu|nam",
    "voiceDescription": "nữ miền Nam ngọt ngào tự nhiên | nam miền Nam trầm ấm tự tin",
    "tone": "thân thiện, duyên dáng, cuốn hút, review chân thực"
  },
  "sceneContext": {
    "location": "mô tả chi tiết không gian bối cảnh sống động phù hợp sản phẩm",
    "lighting": "ánh sáng tự nhiên dịu nhẹ ban ngày kết hợp đèn ấm",
    "mood": "aesthetic, hiện đại, 100% chân thực"
  },
  "panelOverlays": [
    {
      "id": 1,
      "headline": "TIÊU ĐỀ IN HOA CẢNH 1",
      "subtexts": [
        "• Dòng điểm nhấn hook 1",
        "• Dòng điểm nhấn 2"
      ]
    },
    {
      "id": 2,
      "headline": "TIÊU ĐỀ IN HOA CẢNH 2",
      "subtexts": [
        "• Dòng tính năng giải pháp 1",
        "• Dòng ưu điểm vượt trội 2"
      ]
    },
    {
      "id": 3,
      "headline": "TIÊU ĐỀ IN HOA CẢNH 3",
      "subtexts": [
        "• Dòng chứng minh chất liệu 1",
        "• Dòng thông số / độ bền 2"
      ]
    },
    {
      "id": 4,
      "headline": "TIÊU ĐỀ IN HOA CẢNH 4",
      "subtexts": [
        "• Dòng cam kết chính hãng 1",
        "• Dòng kêu gọi giỏ hàng 2"
      ]
    }
  ],
  "script": [
    {
      "id": 1,
      "phase": "Hook",
      "goal": "Hook dừng lướt nêu nỗi đau hoặc gây tò mò",
      "voiceOver": "Lời thoại Cảnh 1 dài 15-19 từ tiếng Việt trọn vẹn câu đủ ý nghĩa có dấu câu kết thúc...",
      "visualDescription": "Mô tả hình ảnh Cảnh 1 (sẽ nằm ở nửa trái của Video 1)",
      "techVFX": "Thao tác tay thực tế Cảnh 1...",
      "cameraAction": "cận cảnh góc máy ổn định bắt đầu 0s-4s của Video 1"
    },
    {
      "id": 2,
      "phase": "Solution",
      "goal": "Giới thiệu sản phẩm và công năng giải pháp",
      "voiceOver": "Lời thoại Cảnh 2 dài 15-19 từ (tổng Cảnh 1 + 2 tối đa 42 từ, câu hoàn chỉnh đủ ý có dấu kết thúc)...",
      "visualDescription": "Mô tả hình ảnh Cảnh 2 (sẽ nằm ở nửa phải của Video 1)",
      "techVFX": "Thao tác tay đặc tả tính năng Cảnh 2...",
      "cameraAction": "chuyển cảnh dứt khoát tại mốc 4s sang Cảnh 2"
    },
    {
      "id": 3,
      "phase": "Proof",
      "goal": "Đặc tả chi tiết chất liệu, bằng chứng chứng minh",
      "voiceOver": "Lời thoại Cảnh 3 dài 15-19 từ tiếng Việt trọn vẹn câu đủ ý nghĩa có dấu câu kết thúc...",
      "visualDescription": "Mô tả hình ảnh Cảnh 3 (sẽ nằm ở nửa trái của Video 2)",
      "techVFX": "Thao tác tay chứng minh chất lượng Cảnh 3...",
      "cameraAction": "cận cảnh góc máy ổn định bắt đầu 0s-4s của Video 2"
    },
    {
      "id": 4,
      "phase": "Closing",
      "goal": "Tổng thể phong cách sống và chốt đơn giỏ hàng",
      "voiceOver": "Lời thoại Cảnh 4 dài 15-19 từ (tổng Cảnh 3 + 4 tối đa 42 từ, câu hoàn chỉnh đủ ý có dấu kết thúc)...",
      "visualDescription": "Mô tả hình ảnh Cảnh 4 (sẽ nằm ở nửa phải của Video 2)",
      "techVFX": "Không gian sống ngăn nắp, sản phẩm hoàn thiện Cảnh 4...",
      "cameraAction": "chuyển cảnh dứt khoát tại mốc 4s sang Cảnh 4"
    }
  ]
}

Important:
- If you are unable to inspect the images, still return the JSON schema with best-effort assumptions.
- Do not ask follow-up questions. Return ONLY the JSON object starting with { and ending with }.
- CRITICAL JSON SPEC (RFC 8259):
  1. NO comments: absolutely DO NOT write // or /* */ anywhere.
  2. Every single property key MUST be in double quotes (e.g. "productName").
  3. Inside string values, NEVER use double quotes ("). If you need quotes inside text, use single quotes ('...') or escape as \\".
  4. MUST include commas between every array element and every object property. Do NOT leave trailing commas before } or ].
  5. NEVER include raw unescaped newlines inside string literal values; keep each string value on a single line.`.trim();
}

/**
 * Chuẩn hóa danh sách Panel Overlays (Headlines + Subtexts)
 */
function normalizePanelOverlays(parsed) {
  if (Array.isArray(parsed.panelOverlays) && parsed.panelOverlays.length === 4) {
    return parsed.panelOverlays.map((item, idx) => ({
      id: idx + 1,
      headline: (item.headline || `PANEL ${idx + 1}`).trim(),
      subtexts: Array.isArray(item.subtexts)
        ? item.subtexts.map(s => s.trim()).filter(Boolean)
        : (item.subtext ? [item.subtext.trim()] : [])
    }));
  }

  // Fallback từ panelCaptions nếu model cũ trả về captions
  const captions = parsed.panelCaptions || [
    'THIẾT KẾ TINH TẾ',
    'CHẤT LIỆU CAO CẤP',
    'TRẢI NGHIỆM ÊM ÁI',
    'TIỆN NGHI MỖI NGÀY'
  ];
  const highlights = parsed.analysis?.highlights || parsed.highlights || [
    'Tính năng thông minh vượt trội',
    'Chất liệu bền đẹp cao cấp',
    'Tiện dụng mỗi ngày'
  ];

  return [
    {
      id: 1,
      headline: captions[0] || 'THIẾT KẾ TINH TẾ',
      subtexts: [highlights[0] ? `• ${highlights[0]}` : '• Thiết kế tối ưu']
    },
    {
      id: 2,
      headline: captions[1] || 'CHẤT LIỆU CAO CẤP',
      subtexts: [
        parsed.analysis?.materials ? `• ${parsed.analysis.materials.slice(0, 35)}` : '• Hoàn thiện tỉ mỉ',
        highlights[1] ? `• ${highlights[1]}` : '• Bền bỉ vượt trội'
      ]
    },
    {
      id: 3,
      headline: captions[2] || 'TRẢI NGHIỆM ÊM ÁI',
      subtexts: [highlights[2] ? `• ${highlights[2]}` : '• Tiện lợi & dễ sử dụng']
    },
    {
      id: 4,
      headline: captions[3] || 'TIỆN NGHI MỖI NGÀY',
      subtexts: ['• Phù hợp mọi gia đình', '• Nâng tầm chất lượng sống']
    }
  ];
}

/**
 * Phân tích sản phẩm qua Gemini API
 */
async function analyzeProductTemplate5(geminiClient, filePayloads, options = {}) {
  console.log(`[Template5] Step 1a: Uploading ${filePayloads.length} product image(s)...`);

  const uploadedFiles = [];
  for (let i = 0; i < filePayloads.length; i++) {
    const file = filePayloads[i];
    const buffer = Buffer.isBuffer(file.buffer)
      ? file.buffer
      : (file.base64 ? Buffer.from(file.base64, 'base64') : (file.path ? fs.readFileSync(file.path) : null));
    if (!buffer) continue;

    const mimeType = file.mimeType || 'image/png';
    const filename = file.name || `product_${i + 1}.png`;
    const url = await geminiClient.uploadFile(buffer, filename, mimeType);
    uploadedFiles.push({ url, filename, mimeType });
  }

  console.log(`[Template5] Step 1b: Analyzing product metadata via Gemini API...`);
  const analysisPrompt = buildTemplate5AnalysisPrompt(options);
  // Gửi tối đa 4 ảnh đại diện cho bước phân tích văn bản để tránh làm nặng request và gây socket timeout (read ETIMEDOUT)
  const analysisFiles = uploadedFiles.slice(0, 4);

  let lastAnalysisErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const promptToSend = attempt === 1
        ? analysisPrompt
        : `${analysisPrompt}\n\nCRITICAL RETRY NOTICE: Your previous attempt failed with a JSON syntax error (${lastAnalysisErr?.message || 'invalid JSON'}). Please output 100% strictly valid RFC 8259 JSON without any comments, missing commas, or unescaped quotes.`;

      const res = await geminiClient.generateContent({
        prompt: promptToSend,
        fileData: analysisFiles,
        temporary: true,
        expectImages: false,
      });

      const parsed = parseJsonObject(res.text || '');
      if (parsed) {
        const pName = parsed.analysis?.productName || parsed.productName || 'Sản Phẩm Cao Cấp';
        const cat = parsed.analysis?.category || parsed.category || 'general';
        const rawCartCTA = (parsed.analysis?.cartAnchorText || parsed.cartAnchorText || parsed.analysis?.cartCTA || '').trim();
        const cartAnchorText = rawCartCTA
          ? rawCartCTA.slice(0, 30)
          : getCartAnchorText(options.productContext || { title: pName }, parsed.analysis || parsed);
        const panelOverlays = normalizePanelOverlays(parsed);
        const captions = panelOverlays.map(p => p.headline);

        console.log(`[Template5] ✅ Product analyzed (attempt ${attempt}): "${pName}" (${cat})`);
        console.log(`[Template5] CTA giỏ hàng: "${cartAnchorText}"`);
        console.log(`[Template5] Panel Overlays:`, JSON.stringify(panelOverlays, null, 2));

        return {
          analysis: {
            productName: pName,
            category: cat,
            cartAnchorText,
            hashtags: parsed.analysis?.hashtags || parsed.hashtags || ['#review', '#sanphamchinhhang', '#trending'],
            materials: parsed.analysis?.materials || parsed.materials || 'Chất liệu cao cấp',
            highlights: parsed.analysis?.highlights || parsed.highlights || ['Thiết kế sang trọng', 'Tiện dụng'],
            targetAudience: parsed.analysis?.targetAudience || parsed.targetAudience || '',
            fourAnswers: parsed.analysis?.fourAnswers || parsed.fourAnswers || {},
            voicePersona: parsed.voicePersona || {
              gender: 'nu',
              voiceDescription: 'nữ miền Nam ngọt ngào, tự nhiên, gần gũi',
              tone: 'thân thiện, duyên dáng, cuốn hút, review chân thực'
            },
            sceneContext: parsed.sceneContext || {
              location: 'Không gian sống hiện đại sáng sủa, nội thất tối giản tinh tế',
              lighting: 'Ánh sáng tự nhiên dịu nhẹ ban ngày kết hợp đèn ấm',
              mood: 'Chân thực, hiện đại, cao cấp'
            },
            panelOverlays,
            panelCaptions: captions,
            script: parsed.script || [],
            veo3Prompts: parsed.veo3Prompts || [],
          },
          uploadedFiles
        };
      }
    } catch (err) {
      lastAnalysisErr = err;
      console.warn(`[Template5] Analysis attempt ${attempt}/3 failed: ${err.message}.`);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }

  console.warn(`[Template5] Analysis JSON parse fallback after 3 attempts: ${lastAnalysisErr?.message}`);

  // Fallback defaults using actual product context if provided
  const ctx = options.productContext || {};
  const fallbackTitle = (ctx.productTitle || 'Sản Phẩm Cao Cấp').trim();
  const fallbackCTA = getCartAnchorText(ctx, { productName: fallbackTitle });
  const defaultOverlays = [
    { id: 1, headline: 'THIẾT KẾ TINH TẾ', subtexts: ['• Kiểu dáng hiện đại', '• Nhỏ gọn tiện lợi'] },
    { id: 2, headline: 'CHẤT LIỆU CAO CẤP', subtexts: ['• Hoàn thiện tỉ mỉ', '• Bền bỉ vượt trội'] },
    { id: 3, headline: 'TRẢI NGHIỆM ÊM ÁI', subtexts: ['• Tiện lợi dễ dùng', '• Hiệu quả tối đa'] },
    { id: 4, headline: 'TIỆN NGHI MỖI NGÀY', subtexts: ['• Phù hợp mọi nhu cầu', '• Nâng tầm cuộc sống'] }
  ];

  return {
    analysis: {
      category: 'general',
      productName: fallbackTitle,
      cartAnchorText: fallbackCTA,
      hashtags: ['#review', '#sanphamchinhhang', '#lifestyle', '#trending', '#xuhuong'],
      materials: 'Chất liệu cao cấp, hoàn thiện tỉ mỉ',
      highlights: ['Thiết kế sang trọng', 'Công năng vượt trội', 'Tiện dụng hàng ngày'],
      targetAudience: 'Mọi gia đình và người dùng yêu thích sự tiện lợi',
      fourAnswers: {
        hook: `Bạn đang tìm một món đồ vừa sang vừa tiện lợi để nâng tầm không gian sống mỗi ngày? Đừng bỏ qua ${fallbackTitle}.`,
        solution: `${fallbackTitle} với thiết kế tinh tế, chất liệu cao cấp giải quyết hoàn hảo mọi nhu cầu.`,
        proof: 'Chi tiết gia công tỉ mỉ, độ bền vượt trội được chứng minh qua thực tế sử dụng.',
        closing: `${fallbackTitle} đáng đầu tư lâu dài, đặt ngay tại giỏ hàng hôm nay.`
      },
      voicePersona: {
        gender: 'nu',
        voiceDescription: 'nữ miền Nam ngọt ngào, tự nhiên, gần gũi',
        tone: 'thân thiện, duyên dáng, cuốn hút, review chân thực'
      },
      sceneContext: {
        location: 'Không gian sống hiện đại sáng sủa, nội thất tối giản tinh tế',
        lighting: 'Ánh sáng tự nhiên dịu nhẹ ban ngày kết hợp đèn ấm',
        mood: 'Chân thực, hiện đại, cao cấp'
      },
      panelOverlays: defaultOverlays,
      panelCaptions: defaultOverlays.map(p => p.headline),
      script: [
        {
          id: 1,
          phase: 'Hook',
          goal: 'Hook dừng lướt gây tò mò',
          voiceOver: clampScriptWords(`Bạn đang tìm một món đồ vừa sang vừa tiện lợi để nâng tầm cuộc sống mỗi ngày? Đừng bỏ qua siêu phẩm này!`, 20),
          visualDescription: `Cận cảnh cầm ${fallbackTitle} trên bề mặt tự nhiên sang trọng`,
          techVFX: 'Thao tác tay thực tế cầm sản phẩm',
          cameraAction: 'cận cảnh góc máy ổn định bắt đầu 0s-4s của Video 1'
        },
        {
          id: 2,
          phase: 'Solution',
          goal: 'Giới thiệu công năng giải pháp',
          voiceOver: clampScriptWords(`Thiết kế thông minh với công năng vượt trội, hoàn thiện tỉ mỉ từng chi tiết, giải quyết nhanh gọn mọi bất tiện.`, 20),
          visualDescription: `Mô tả công năng và chi tiết của ${fallbackTitle}`,
          techVFX: 'Thao tác tay đặc tả tính năng',
          cameraAction: 'lia máy sang phải và zoom vào Cảnh 2 trong 4s-8s của Video 1'
        },
        {
          id: 3,
          phase: 'Proof',
          goal: 'Đặc tả chất liệu và độ bền',
          voiceOver: clampScriptWords(`Cận cảnh từng đường nét gia công sắc sảo cùng chất liệu cao cấp bền bỉ, an tâm sử dụng mỗi ngày.`, 20),
          visualDescription: `Cận cảnh chất liệu và độ hoàn thiện của ${fallbackTitle}`,
          techVFX: 'Thao tác tay kiểm tra thực tế',
          cameraAction: 'cận cảnh góc máy ổn định bắt đầu 0s-4s của Video 2'
        },
        {
          id: 4,
          phase: 'Closing',
          goal: 'Kêu gọi mua hàng giỏ hàng',
          voiceOver: clampScriptWords(`Sự lựa chọn hoàn hảo cho mọi gia đình hiện đại, bấm ngay giỏ hàng góc trái màn hình để sở hữu liền nha!`, 20),
          visualDescription: `Không gian phong cách sống cùng ${fallbackTitle}`,
          techVFX: 'Đặt sản phẩm ngay ngắn trong không gian sống',
          cameraAction: 'lia máy sang phải và toàn cảnh Cảnh 4 trong 4s-8s của Video 2'
        }
      ],
      veo3Prompts: []
    },
    uploadedFiles
  };
}

/**
 * Xây dựng prompt Master Storyboard (4 panel horizontal split 16:9)
 * - Nửa trái: Cảnh 1 (Hook) + Cảnh 2 (Giải pháp) -> Tách thành Hình 1 -> Video 1
 * - Nửa phải: Cảnh 3 (Bằng chứng) + Cảnh 4 (Chốt đơn) -> Tách thành Hình 2 -> Video 2
 */
function buildTemplate5MasterPrompt(analysisData, options = {}) {
  const isNoText = !!(
    options.noText ||
    options.template === 'template5_1' || options.template === 'template5.1' || options.template === 'template51' ||
    options.template === 'template5_2' || options.template === 'template5.2' || options.template === 'template52'
  );
  const a = analysisData || {};
  const overlays = a.panelOverlays || normalizePanelOverlays(a);
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
        headline: isNoText ? undefined : overlays[0]?.headline,
        subtexts: isNoText ? undefined : overlays[0]?.subtexts,
      },
      panel2: {
        id: 2,
        phase: "Solution",
        marketingQuestion: "Sản phẩm là giải pháp gì?",
        marketingAnswer: fourAnswers.solution || script[1]?.goal || "Giới thiệu sản phẩm và công năng giải pháp vượt trội",
        visualDescription: script[1]?.visualDescription || "Đặc tả tính năng và chi tiết cấu tạo hoàn thiện",
        handInteraction: script[1]?.techVFX || "Thao tác tay sử dụng công năng sản phẩm",
        headline: isNoText ? undefined : overlays[1]?.headline,
        subtexts: isNoText ? undefined : overlays[1]?.subtexts,
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
        headline: isNoText ? undefined : overlays[2]?.headline,
        subtexts: isNoText ? undefined : overlays[2]?.subtexts,
      },
      panel4: {
        id: 4,
        phase: "Closing / CTA",
        marketingQuestion: "Lý do gì để họ mua ngay?",
        marketingAnswer: fourAnswers.closing || script[3]?.goal || "Lý do mua ngay và nâng tầm phong cách sống",
        visualDescription: script[3]?.visualDescription || "Toàn cảnh sản phẩm hòa nhập không gian sống hiện đại",
        handInteraction: script[3]?.techVFX || "Sản phẩm hoàn thiện trong không gian sống",
        headline: isNoText ? undefined : overlays[3]?.headline,
        subtexts: isNoText ? undefined : overlays[3]?.subtexts,
      }
    }
  };

  if (isNoText) {
    return `Generate one product review storyboard image (still photo collage, NOT a video) from the uploaded product reference images for ${prodName}.

CRITICAL VISUAL DIRECTION — 100% SMARTPHONE REALISM (CHUẨN CAMERA THỰC TẾ, KHÔNG ẢO CGI):
- Aesthetics: Authentic smartphone camera snapshot (iPhone 15 Pro 24mm/26mm lens, f/1.8 auto mode), natural window light, subtle realistic contact shadows, genuine material textures (matte finish, fabric grain, metallic brush or leather texture). Must look 100% real and authentic like a real human photoshoot.
- Hands & Model: Fair Asian skin tone, natural skin pores, knuckle creases, neat manicured nails, anatomically correct hands with 5 fingers, realistic physical grip. Strictly faceless (no visible faces, only hands/limbs/outfit).
- NO CARTOON GRAPHICS: Absolutely NO glowing neon arrows, NO cartoon magnifying glasses, NO floating 3D icons, NO fake fairy sparkles.

Storyboard requirements:
- Exactly 4 panels arranged side by side in one single still image (horizontal 16:9 collage composed of 4 vertical 9:16 frames).
  * Left Half: Panel 1 (Hook) + Panel 2 (Solution)
  * Right Half: Panel 3 (Proof) + Panel 4 (Closing)
- Setting: All 4 panels share the exact same location (${loc}) and natural lighting (${lighting}).
- STRICT NO-TEXT RULE (TUYỆT ĐỐI KHÔNG CHỮ / NO TEXT / NO LABELS):
  * Every panel must be 100% pure clean photography without any typography, without any text badges, without any words, without any subtitles, without any labels, and without any watermarks.
  * Pure visual focus on authentic product textures, details, and realistic everyday interaction.
- Output must be a still photograph collage. Do NOT generate or describe a video.

Scene plan:
${JSON.stringify(sceneData, null, 2)}

Generate one still storyboard image now.`.trim();
  }

  const sequenceInstructions = overlays.map(p => {
    const subtextLines = (p.subtexts || []).join(' | ');
    return `  Panel ${p.id}: Render a single small rounded caption badge (placed 18% below top edge) containing: "${p.headline}" and "${subtextLines}".`;
  }).join('\n');

  return `Generate one product review storyboard image (still photo collage, NOT a video) from the uploaded product reference images for ${prodName}.

CRITICAL VISUAL DIRECTION — 100% SMARTPHONE REALISM (CHUẨN CAMERA THỰC TẾ, KHÔNG ẢO CGI):
- Aesthetics: Authentic smartphone camera snapshot (iPhone 15 Pro 24mm/26mm lens, f/1.8 auto mode), natural window light, subtle realistic contact shadows, genuine material textures (matte finish, fabric grain, metallic brush or leather texture). Must look 100% real and authentic like a real human photoshoot.
- Hands & Model: Fair Asian skin tone, natural skin pores, knuckle creases, neat manicured nails, anatomically correct hands with 5 fingers, realistic physical grip. Strictly faceless (no visible faces, only hands/limbs/outfit).
- NO CARTOON GRAPHICS: Absolutely NO glowing neon arrows, NO cartoon magnifying glasses, NO floating 3D icons, NO fake fairy sparkles.

Storyboard requirements:
- Exactly 4 panels arranged side by side in one single still image (horizontal 16:9 collage composed of 4 vertical 9:16 frames).
  * Left Half: Panel 1 (Hook) + Panel 2 (Solution)
  * Right Half: Panel 3 (Proof) + Panel 4 (Closing)
- Setting: All 4 panels share the exact same location (${loc}) and natural lighting (${lighting}).
- Sequence & Single Caption Badges:
${sequenceInstructions}
- Typography Rules & Safe Margin (QUAN TRỌNG: Cỡ chữ nhỏ gọn, an toàn 100% viền, không vẽ chữ rác):
  * EXACTLY ONE SINGLE COMPACT BADGE PER PANEL: Render only ONE small, elegant, semi-transparent rounded pill card in the upper safe area.
  * POSITION: Leave at least 18% empty margin from top edge (DO NOT touch top border y=0). Leave at least 15% margin from left and right borders.
  * Clean minimalist modern sans-serif font with 100% ACCURATE VIETNAMESE DIACRITICS (đúng chính tả tiếng Việt có dấu).
  * STRICT NEGATIVE RULE: Absolutely NO other text, words, floating letters, gibberish English/Vietnamese anywhere in the scene, background, walls, or ceilings. The single caption card is the ONLY text in each panel.
- Output must be a still photograph collage. Do NOT generate or describe a video.

Scene plan:
${JSON.stringify(sceneData, null, 2)}

Generate one still storyboard image now.`.trim();
}

/**
 * Xây dựng prompt cho từng Panel 9:16 riêng biệt (Gemini API)
 */
function buildTemplate5PanelPrompt(panelIndex, analysisData, options = {}) {
  const isNoText = !!(
    options.noText ||
    options.template === 'template5_1' || options.template === 'template5.1' || options.template === 'template51' ||
    options.template === 'template5_2' || options.template === 'template5.2' || options.template === 'template52' ||
    options.template === 'template5_3' || options.template === 'template5.3' || options.template === 'template53'
  );
  const a = analysisData || {};
  const overlays = a.panelOverlays || normalizePanelOverlays(a);
  const current = overlays[panelIndex - 1] || { id: panelIndex, headline: `PANEL ${panelIndex}`, subtexts: [] };
  const loc = a.sceneContext?.location || 'a bright modern setting';
  const prodName = a.productName || 'the product';
  const subtextStr = (current.subtexts || []).join(' | ');

  if (isNoText) {
    return `Generate a single vertical 9:16 smartphone photograph for Panel ${panelIndex} of 4 for the ${prodName} review.

VISUAL INSTRUCTIONS:
- Panel Index: ${panelIndex} of 4.
- Aspect Ratio: 9:16 vertical.
- STORYBOARD REFERENCE: Use the uploaded storyboard image (master_storyboard.png) as the PRIMARY visual reference. Extract and recreate ONLY panel ${panelIndex} (counting from left) of the 4-panel storyboard collage. The generated panel MUST match the exact same camera angle, composition, pose, product placement, and background setting as shown in panel ${panelIndex} of the storyboard.
- Setting: ${loc}.
- Product Identity: Match the EXACT design, colors, textures, and details from the product reference images.

- STRICT NO-TEXT RULE (TUYỆT ĐỐI KHÔNG CHỮ / NO TEXT / NO WATERMARKS):
  * Pure clean smartphone photography with NO typography overlays, NO caption cards, NO words, NO letters, NO numbers, NO badges, NO stickers, NO watermarks, NO price tags anywhere in the image.
  * The image must focus 100% cleanly on the authentic physical product, material texture, and natural human interaction.

- 100% PHOTOREALISM (THỰC TẾ 100%, KHÔNG ẢO CGI):
  * Authentic smartphone camera snapshot (iPhone 15 Pro style 24mm lens), real natural room daylight, genuine soft contact shadows and textures.
  * Fair Asian skin tone, natural skin pores, knuckle creases, clean neat nails, correct 5-finger anatomy, natural physical grip.
  * Faceless only: No visible human faces.
  * STRICTLY NO cartoon graphics, NO glowing neon arrows, NO floating magnifying glasses, NO fake fairy sparkles, NO 3D CGI props.
- Output must be a still photo. Do NOT generate a video.

Generate exactly one still image now.`.trim();
  }

  return `Generate a single vertical 9:16 smartphone photograph for Panel ${panelIndex} of 4 for the ${prodName} review.

VISUAL INSTRUCTIONS:
- Panel Index: ${panelIndex} of 4.
- Aspect Ratio: 9:16 vertical.
- STORYBOARD REFERENCE: Use the uploaded storyboard image (master_storyboard.png) as the PRIMARY visual reference. Extract and recreate ONLY panel ${panelIndex} (counting from left) of the 4-panel storyboard collage. The generated panel MUST match the exact same camera angle, composition, pose, product placement, and background setting as shown in panel ${panelIndex} of the storyboard.
- Setting: ${loc}.
- Product Identity: Match the EXACT design, colors, textures, and details from the product reference images.

- SINGLE CAPTION BADGE & SAFE ZONE (QUAN TRỌNG: Cỡ ch nhỏ gọn tinh tế, 100% không ct viền, không vẽ ch rác):
  * EXACTLY ONE SINGLE COMPACT CARD: Render only ONE small, elegant, semi-transparent white/glassmorphism rounded pill card (kích thước nhỏ gọn, chiếm tối đa 10-12% chiều cao ảnh) floating in the upper safe area.
  * PRECISE POSITION & MARGINS:
    - Top margin: Must have at least 18% empty margin from the top edge of the frame (DO NOT touch or overlap the top border).
    - Side margins: Must have at least 15% empty margin from left and right borders.
    - Card must be horizontally centered and fully contained inside the safe area.
  * INSIDE THE SINGLE CARD ONLY:
    - Line 1 (Headline): "${current.headline}" (small bold uppercase, modern clean sans-serif font).
    - Line 2 (Highlights): "${subtextStr}" (compact, small bullet points).
    - 100% ACCURATE VIETNAMESE SPELLING (đúng chính tả tiếng Việt có dấu).
  * CRITICAL NEGATIVE RULES FOR TEXT & GRAPHICS:
    - Absolutely NO other floating text, NO secondary words, NO background letters, NO gibberish English/Vietnamese anywhere in the scene, on walls, on ceilings, or in the air.
    - The ONLY text allowed in the entire image is inside the single caption card.
    - STRICTLY NO cartoon graphics, NO glowing neon arrows, NO floating magnifying glasses, NO fake fairy sparkles, NO 3D CGI props, NO speech bubble pointers.

- 100% PHOTOREALISM (THỰC TẾ 100%, KHÔNG ẢO CGI):
  * Authentic smartphone camera snapshot (iPhone 15 Pro style 24mm lens), real natural room daylight, genuine soft contact shadows and textures.
  * Fair Asian skin tone, natural skin pores, knuckle creases, clean neat nails, correct 5-finger anatomy, natural physical grip.
  * Faceless only: No visible human faces, no watermarks, no price tags.
  * IMPORTANT: The storyboard reference image may contain a small star/sparkle logo watermark in the bottom-right corner. This is an AI generation artifact — you MUST completely remove/ignore it. The generated panel must have a perfectly clean corner with only the natural scene continuing seamlessly. Do NOT reproduce any logo, star icon, or watermark from the reference.
- Output must be a still photo. Do NOT generate a video.

Generate exactly one still image now.`.trim();
}

/**
 * Tách Master Storyboard (16:9 gồm 4 cảnh ngang) thành 2 hình ảnh 2 cảnh:
 * - Hình 1 (Nửa trái, Cảnh 1 & 2): crop=iw/2:ih:0:0 + 8% viền trắng
 * - Hình 2 (Nửa phải, Cảnh 3 & 4): crop=iw/2:ih:iw/2:0 + 8% viền trắng
/**
 * Giới hạn chuỗi lời thoại tối đa maxWords từ (mặc định 42 từ cho video 8s)
 * Đảm bảo câu cú luôn trọn vẹn đủ ý nghĩa, kết thúc bằng dấu câu hoàn chỉnh (. ! ?),
 * tuyệt đối KHÔNG cắt ngang giữa chừng gây cụt lủn dở dang.
 */
function clampScriptWords(text, maxWords = 42) {
  if (!text) return '';
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  if (words.length <= maxWords) {
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  }

  // Chuẩn hóa dấu câu kết thúc nếu thiếu
  const normalized = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;

  // 1. Tách chuỗi thành các câu hoàn chỉnh dựa trên dấu kết thúc (. ! ?)
  const sentenceRegex = /[^.!?]+[.!?]+/g;
  const sentences = normalized.match(sentenceRegex);

  if (sentences && sentences.length > 0) {
    let accumulated = '';
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i].trim();
      const candidate = accumulated ? `${accumulated} ${s}` : s;
      const count = candidate.split(/\s+/).length;

      if (count <= maxWords) {
        accumulated = candidate;
      } else {
        // Thử xem s có các vế câu ngăn cách bởi dấu phẩy/chấm phẩy (,) mà có thể thêm vào không
        const subParts = s.split(/[,;]\s*/);
        if (subParts.length > 1) {
          let subAcc = accumulated;
          for (let j = 0; j < subParts.length; j++) {
            const sub = subParts[j].trim().replace(/[.!?]+$/, '');
            if (!sub) continue;
            const testCandidate = subAcc ? `${subAcc}, ${sub}.` : `${sub}.`;
            if (testCandidate.split(/\s+/).length <= maxWords) {
              subAcc = subAcc ? `${subAcc}, ${sub}` : sub;
            } else {
              break;
            }
          }
          if (subAcc && subAcc !== accumulated) {
            // Giữ dấu hỏi nếu câu gốc là câu hỏi, ngược lại kết thúc bằng dấu chấm
            const termPunct = /\?$/.test(s) ? '?' : '.';
            accumulated = subAcc.replace(/[,;:\s]+$/, '') + termPunct;
          }
        }
        break;
      }
    }

    if (accumulated && accumulated.split(/\s+/).length > 0) {
      return accumulated.replace(/[,;:\s]+$/, '') + (/[.!?]$/.test(accumulated) ? '' : '.');
    }
  }

  // 2. Nếu chuỗi là một câu đơn dài không có dấu chấm, tách theo dấu phẩy / chấm phẩy
  const clauses = normalized.split(/[,;]\s*/);
  if (clauses.length > 1) {
    let accumulated = '';
    for (const cl of clauses) {
      const cTrim = cl.trim().replace(/[.!?]+$/, '');
      if (!cTrim) continue;
      const candidate = accumulated ? `${accumulated}, ${cTrim}` : cTrim;
      const testWithDot = `${candidate}.`;
      if (testWithDot.split(/\s+/).length <= maxWords) {
        accumulated = candidate;
      } else {
        break;
      }
    }
    if (accumulated) {
      return accumulated.replace(/[,;:\s]+$/, '') + '.';
    }
  }

  // 3. Fallback: tìm dấu phẩy gần nhất trong 8 từ cuối của slice
  const slice = words.slice(0, maxWords);
  for (let i = slice.length - 1; i >= Math.max(0, slice.length - 8); i--) {
    if (/[,;]/.test(slice[i])) {
      return slice.slice(0, i + 1).join(' ').replace(/[,;:\s]+$/, '') + '.';
    }
  }
  return slice.join(' ').replace(/[,;:\s]+$/, '') + '.';
}

/**
 * Kết hợp và cân đối lời thoại của 2 cảnh trong 1 video 8s:
 * - Đảm bảo tổng số từ cả 2 cảnh CỘNG LẠI TỐI ĐA 42 TỪ.
 * - Cả 2 cảnh đều có câu trọn vẹn đầy đủ ý nghĩa (chủ ngữ - vị ngữ), không bị cắt ngang giữa chừng.
 * - Phù hợp với mốc thời gian: Cảnh trước (0s-4s) và Cảnh sau (4s-8s).
 */
function combineTwoSceneScripts(voFirst, voSecond, maxTotalWords = 42) {
  const v1 = (voFirst || '').trim();
  const v2 = (voSecond || '').trim();
  if (!v1 && !v2) return '';
  if (!v1) return clampScriptWords(v2, maxTotalWords);
  if (!v2) return clampScriptWords(v1, maxTotalWords);

  const cleanV1 = /[.!?]$/.test(v1) ? v1 : `${v1}.`;
  const cleanV2 = /[.!?]$/.test(v2) ? v2 : `${v2}.`;
  const totalWords = `${cleanV1} ${cleanV2}`.split(/\s+/).length;
  if (totalWords <= maxTotalWords) {
    return `${cleanV1} ${cleanV2}`;
  }

  // Cân đối để cả 2 cảnh đều có câu trọn vẹn, không cảnh nào bị nuốt chửng
  const halfMax = Math.floor(maxTotalWords / 2); // 21 words
  const w1Count = cleanV1.split(/\s+/).length;
  const w2Count = cleanV2.split(/\s+/).length;

  let clampedV1, clampedV2;
  if (w1Count <= halfMax) {
    clampedV1 = clampScriptWords(cleanV1, w1Count);
    const remaining = maxTotalWords - clampedV1.split(/\s+/).length;
    clampedV2 = clampScriptWords(cleanV2, remaining);
  } else if (w2Count <= halfMax) {
    clampedV2 = clampScriptWords(cleanV2, w2Count);
    const remaining = maxTotalWords - clampedV2.split(/\s+/).length;
    clampedV1 = clampScriptWords(cleanV1, remaining);
  } else {
    clampedV1 = clampScriptWords(cleanV1, halfMax);
    const remaining = maxTotalWords - clampedV1.split(/\s+/).length;
    clampedV2 = clampScriptWords(cleanV2, remaining);
  }

  return `${clampedV1} ${clampedV2}`.trim();
}

/**
 * Tách Master Storyboard (16:9 gồm 4 cảnh ngang) thành 2 hình ảnh 2 cảnh:
 * - Hình 1: Cảnh 1 (0..25%) và Cảnh 2 (25%..50%)
 * - Hình 2: Cảnh 3 (50%..75%) và Cảnh 4 (75%..100%)
 * Mỗi cảnh được cắt riêng và thêm đầy đủ 4 viền trắng (trên, dưới, trái, phải).
 * Sau đó ghép ngang (hstack) và thêm viền ngoài để đảm bảo giữa 2 cảnh và quanh mỗi cảnh
 * đều có viền trắng rõ rệt, không bị dính sát vào nhau.
 *
 * @param {Buffer} storyboardBuffer - Buffer ảnh Master Storyboard
 * @param {object} [options]
 * @returns {[Buffer, Buffer]} [panel1Buffer, panel2Buffer]
 */
function sliceStoryboardIntoTwoImages(storyboardBuffer, options = {}) {
  const ffmpegPath = require('ffmpeg-static');
  const tmpId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `sb-input-${tmpId}.png`);
  const out1Path = path.join(tmpDir, `sb-panel1-${tmpId}.png`);
  const out2Path = path.join(tmpDir, `sb-panel2-${tmpId}.png`);

  try {
    fs.writeFileSync(inputPath, storyboardBuffer);

    // Panel 1: Cảnh 1 + Cảnh 2 (nửa trái storyboard 0..iw/2) full viền không viền trắng
    const fc1 = '[0:v]crop=iw/2:ih:0:0[out]';
    execSync(`"${ffmpegPath}" -y -i "${inputPath}" -filter_complex "${fc1}" -map "[out]" -q:v 2 -update 1 "${out1Path}"`, { timeout: 15000, stdio: 'pipe' });

    // Panel 2: Cảnh 3 + Cảnh 4 (nửa phải storyboard iw/2..iw) full viền không viền trắng
    const fc2 = '[0:v]crop=iw/2:ih:iw/2:0[out]';
    execSync(`"${ffmpegPath}" -y -i "${inputPath}" -filter_complex "${fc2}" -map "[out]" -q:v 2 -update 1 "${out2Path}"`, { timeout: 15000, stdio: 'pipe' });

    const buf1 = fs.readFileSync(out1Path);
    const buf2 = fs.readFileSync(out2Path);

    console.log(`[Template5] ✅ Sliced Master Storyboard into 2 panel images full viền (no white borders): Panel 1 (${(buf1.length / 1024).toFixed(0)} KB), Panel 2 (${(buf2.length / 1024).toFixed(0)} KB)`);
    return [buf1, buf2];
  } finally {
    [inputPath, out1Path, out2Path].forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    });
  }
}

/**
 * Tách Master Storyboard (16:9 gồm 4 cảnh ngang) thành 4 panel 9:16 riêng biệt cho Template 5_3:
 * - Panel 1: Cảnh 1 (Hook, 0..25%)
 * - Panel 2: Cảnh 2 (Solution, 25%..50%)
 * - Panel 3: Cảnh 3 (Proof, 50%..75%)
 * - Panel 4: Cảnh 4 (Closing, 75%..100%)
 * Toàn bộ 4 panel đều full viền 9:16 (1080x1920), không chèn viền trắng.
 *
 * @param {Buffer} storyboardBuffer - Buffer ảnh Master Storyboard
 * @returns {[Buffer, Buffer, Buffer, Buffer]} [panel1, panel2, panel3, panel4]
 */
function sliceStoryboardIntoFourPanels(storyboardBuffer) {
  const ffmpegPath = require('ffmpeg-static');
  const tmpId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `sb-in-4p-${tmpId}.png`);
  const outPaths = [1, 2, 3, 4].map(i => path.join(tmpDir, `sb-panel${i}-4p-${tmpId}.png`));

  try {
    fs.writeFileSync(inputPath, storyboardBuffer);

    const filterCrops = [
      '[0:v]crop=iw/4:ih:0:0,scale=1080:1920:flags=lanczos[out1]',
      '[0:v]crop=iw/4:ih:iw/4:0,scale=1080:1920:flags=lanczos[out2]',
      '[0:v]crop=iw/4:ih:iw/2:0,scale=1080:1920:flags=lanczos[out3]',
      '[0:v]crop=iw/4:ih:3*iw/4:0,scale=1080:1920:flags=lanczos[out4]',
    ];

    for (let i = 0; i < 4; i++) {
      execSync(`"${ffmpegPath}" -y -i "${inputPath}" -filter_complex "${filterCrops[i]}" -map "[out${i + 1}]" -q:v 2 -update 1 "${outPaths[i]}"`, { timeout: 15000, stdio: 'pipe' });
    }

    const buffers = outPaths.map(p => fs.readFileSync(p));
    console.log(`[Template5_3] ✅ Sliced Master Storyboard into 4 panel images full viền (no white borders): ${buffers.map((b, i) => `Panel ${i + 1} (${(b.length / 1024).toFixed(0)} KB)`).join(', ')}`);
    return buffers;
  } finally {
    [inputPath, ...outPaths].forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    });
  }
}

/**
 * Lấy danh sách 4 Prompt Veo 4s tiếng Việt cho Template 5_3 (Spam Video 4 cảnh x 4s, No Text + Voice)
 * - Mỗi cảnh tạo 1 video riêng dài đúng 4s từ panel 9:16 tương ứng (Cảnh 1, Cảnh 2, Cảnh 3, Cảnh 4).
 * - KHÔNG CHÈN VIỀN TRẮNG (logo model Veo ở xa trung tâm hơn, crop video tương tự template 6).
 * - Script và voice tương tự Template 5_2: mỗi cảnh đọc nhanh, dồn dập (15-21 từ), câu cú trọn vẹn đủ ý.
 *
 * @param {object} analysisData
 * @param {object} [options]
 * @returns {string[]} [prompt1, prompt2, prompt3, prompt4]
 */
function getTemplate5_3VideoPrompts(analysisData, options = {}) {
  const prodName = analysisData?.productName || 'sản phẩm';
  const script = analysisData?.script || [];
  const isMale = analysisData?.voicePersona?.gender === 'nam' ||
    (analysisData?.voicePersona && /nam|men/i.test(analysisData.voicePersona.voiceDescription || '')) ||
    analysisData?.category === 'gadgets' ||
    (analysisData?.targetAudience && /nam|men|đàn ông/i.test(analysisData.targetAudience));
  const defaultVoice = isMale
    ? 'nam miền Nam trầm ấm, tự tin, cuốn hút'
    : 'nữ miền Nam ngọt ngào, tự nhiên, gần gũi';
  const voiceDesc = analysisData?.voicePersona?.voiceDescription || defaultVoice;

  const realismCues = 'Cảnh quay tự nhiên 100% như quay bằng camera điện thoại iPhone 15 Pro, ánh sáng ban ngày tự nhiên từ cửa sổ, đổ bóng tiếp xúc chân thực, bề mặt sản phẩm lì có vân chất liệu, không hiệu ứng bokeh giả, không ánh sáng studio nhân tạo, không nhựa bóng kiểu AI, không hiệu ứng ảo CGI.';

  const desc1 = script[0]?.visualDescription || 'Cận cảnh tay cầm sản phẩm trên bề mặt tự nhiên sang trọng';
  const vfx1 = script[0]?.techVFX ? ` Thao tác thực tế: ${script[0].techVFX}.` : '';
  const desc2 = script[1]?.visualDescription || 'Góc quay cận cảnh đặc tả công năng, cấu tạo và hoàn thiện tinh xảo';
  const vfx2 = script[1]?.techVFX ? ` Thao tác thực tế: ${script[1].techVFX}.` : '';
  const desc3 = script[2]?.visualDescription || 'Trải nghiệm sử dụng thực tế của người dùng với sản phẩm trong không gian';
  const vfx3 = script[2]?.techVFX ? ` Thao tác thực tế: ${script[2].techVFX}.` : '';
  const desc4 = script[3]?.visualDescription || 'Toàn cảnh sản phẩm trong không gian phong cách sống hiện đại';
  const vfx4 = script[3]?.techVFX ? ` Thao tác thực tế: ${script[3].techVFX}.` : '';

  const vo1 = clampScriptWords(script[0]?.voiceOver || 'Đầu giường vừa tối vừa rối tung dây sạc khiến bạn khó chịu mỗi ngày? Đừng bỏ qua siêu phẩm này!', 21);
  const vo2 = clampScriptWords(script[1]?.voiceOver || 'Đèn bàn thông minh tích hợp sẵn ổ cắm và sạc nhanh, giải quyết nhanh gọn mọi bất tiện.', 21);
  const vo3 = clampScriptWords(script[2]?.voiceOver || 'Cận cảnh thao tác chạm đổi ba màu sáng êm dịu, chất liệu cao cấp bền bỉ an toàn.', 21);
  const vo4 = clampScriptWords(script[3]?.voiceOver || 'Sự lựa chọn hoàn hảo nâng tầm không gian sống, bấm ngay giỏ hàng góc trái nhận ưu đãi nha!', 21);

  return [
    `Tạo video review ${prodName} faceless dài đúng 4 giây từ hình ảnh Cảnh 1 đã cung cấp. CHUYỂN ĐỘNG THEO THỜI GIAN VÀ CẢNH QUAY: camera giữ góc quay cận cảnh ổn định bên trong khung hình Cảnh 1, bàn tay người thao tác thực tế${vfx1} ${desc1}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI. Giọng đọc review: ${voiceDesc}, phong cách TikTok review cuốn hút, tốc độ đọc NHANH liên tục dồn dập không ngừng nghỉ để truyền tải trọn vẹn thông tin. Lời thoại nhân vật đọc liên tục trong 4 giây: "${vo1}". ${realismCues}`,
    `Tạo video review ${prodName} faceless dài đúng 4 giây từ hình ảnh Cảnh 2 đã cung cấp. CHUYỂN ĐỘNG THEO THỜI GIAN VÀ CẢNH QUAY: camera giữ góc quay đặc tả công năng và chi tiết sản phẩm bên trong khung hình Cảnh 2, bàn tay người thao tác thực tế${vfx2} ${desc2}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI. Giọng đọc review: ${voiceDesc}, phong cách TikTok review cuốn hút, tốc độ đọc NHANH liên tục dồn dập không ngừng nghỉ để truyền tải trọn vẹn thông tin. Lời thoại nhân vật đọc liên tục trong 4 giây: "${vo2}". ${realismCues}`,
    `Tạo video review ${prodName} faceless dài đúng 4 giây từ hình ảnh Cảnh 3 đã cung cấp. CHUYỂN ĐỘNG THEO THỜI GIAN VÀ CẢNH QUAY: camera giữ góc quay cận cảnh đặc tả chất liệu, cấu tạo tinh xảo bên trong khung hình Cảnh 3, bàn tay người thao tác kiểm tra thực tế${vfx3} ${desc3}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI. Giọng đọc review: ${voiceDesc}, phong cách TikTok review cuốn hút, tốc độ đọc NHANH liên tục dồn dập không ngừng nghỉ để truyền tải trọn vẹn thông tin. Lời thoại nhân vật đọc liên tục trong 4 giây: "${vo3}". ${realismCues}`,
    `Tạo video review ${prodName} faceless dài đúng 4 giây từ hình ảnh Cảnh 4 đã cung cấp. CHUYỂN ĐỘNG THEO THỜI GIAN VÀ CẢNH QUAY: mở rộng góc quay tôn vinh sản phẩm trong không gian phong cách sống hoàn thiện bên trong khung hình Cảnh 4${vfx4} ${desc4}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI. Giọng đọc review: ${voiceDesc}, phong cách TikTok review cuốn hút, tốc độ đọc NHANH liên tục dồn dập không ngừng nghỉ để truyền tải trọn vẹn thông tin. Lời thoại nhân vật đọc liên tục trong 4 giây: "${vo4}". ${realismCues}`
  ];
}

/**
 * Lấy danh sách 2 Prompt Veo 3 chuẩn 8s tiếng Việt cho Template 5 / Template 5.1 / Template 5.2
 * - Video 1 (8s, sinh từ Hình 1 chứa Cảnh 1 & 2):
 *     * 0s-4s: Bắt đầu chính xác Cảnh 1 (khung bên trái)
 *     * tại mốc 4s: Chuyển cảnh dứt khoát (clean cut transition) sang Cảnh 2 (khung bên phải)
 *     * Voice-over: Đọc liên tục Cảnh 1 + Cảnh 2 (TỐI ĐA 42 TỪ, TRỌN VẸN CÂU), tốc độ nhanh dồn dập
 * - Video 2 (8s, sinh từ Hình 2 chứa Cảnh 3 & 4):
 *     * 0s-4s: Bắt đầu chính xác Cảnh 3 (khung bên trái)
 *     * tại mốc 4s: Chuyển cảnh dứt khoát (clean cut transition) sang Cảnh 4 (khung bên phải)
 *     * Voice-over: Đọc liên tục Cảnh 3 + Cảnh 4 (TỐI ĐA 42 TỪ, TRỌN VẸN CÂU), tốc độ nhanh dồn dập
 * QUY TẮC VIỀN TRẮNG: Panel ảnh full viền không viền trắng. Video có khung viền màu trắng tĩnh cố định
 * dày đúng 12% ở cả 4 cạnh. Nội dung video chỉ hiển thị chính xác bên trong khung viền trắng, không có vạch chia cắt bên trong.
 */
function getTemplate5VideoPrompts(analysisData, options = {}) {
  const prodName = analysisData?.productName || 'sản phẩm';
  const script = analysisData?.script || [];
  const template = options.template || (options.noText ? (options.hasVoice ? 'template5_2' : 'template5_1') : 'template5');
  const hasVoice = !!(
    options.hasVoice ||
    template === 'template5_2' || template === 'template5.2' || template === 'template52'
  );
  const isNoText = !!(
    options.noText ||
    template === 'template5_1' || template === 'template5.1' || template === 'template51' ||
    template === 'template5_2' || template === 'template5.2' || template === 'template52'
  );

  const realismCues = 'Cảnh quay tự nhiên 100% như quay bằng camera điện thoại iPhone 15 Pro, ánh sáng ban ngày tự nhiên từ cửa sổ, đổ bóng tiếp xúc chân thực, bề mặt sản phẩm lì có vân chất liệu, không hiệu ứng bokeh giả, không ánh sáng studio nhân tạo, không nhựa bóng kiểu AI, không hiệu ứng ảo CGI.';
  const borderRule = 'KHUNG VIỀN TRẮNG CỐ ĐỊNH (SOLID WHITE BORDER PADDING): Toàn bộ video được bao bọc bởi một khung viền màu trắng tĩnh cố định dày chính xác 12% ở mỗi cạnh: cạnh trên dày 12%, cạnh dưới dày 12%, cạnh trái dày 12%, cạnh phải dày 12% (solid white border frame: 12% top, 12% bottom, 12% left, 12% right padding). Toàn bộ nội dung chuyển động và hình ảnh video chỉ hiển thị chính xác bên trong khung viền trắng này (video content strictly rendered inside the white frame), tuyệt đối không tràn ra ngoài viền trắng, và bên trong nội dung video hoàn toàn liền mạch không có bất kỳ vạch kẻ hay viền trắng nào chia cắt (seamless continuous content, no internal dividers, no vertical split lines).';

  const desc1 = script[0]?.visualDescription || 'Cận cảnh tay cầm sản phẩm trên bề mặt tự nhiên sang trọng';
  const vfx1 = script[0]?.techVFX ? ` Thao tác thực tế: ${script[0].techVFX}.` : '';
  const desc2 = script[1]?.visualDescription || 'Góc quay cận cảnh đặc tả công năng, cấu tạo và hoàn thiện tinh xảo';
  const vfx2 = script[1]?.techVFX ? ` Thao tác thực tế: ${script[1].techVFX}.` : '';
  const desc3 = script[2]?.visualDescription || 'Trải nghiệm sử dụng thực tế của người dùng với sản phẩm trong không gian';
  const vfx3 = script[2]?.techVFX ? ` Thao tác thực tế: ${script[2].techVFX}.` : '';
  const desc4 = script[3]?.visualDescription || 'Toàn cảnh sản phẩm trong không gian phong cách sống hiện đại';
  const vfx4 = script[3]?.techVFX ? ` Thao tác thực tế: ${script[3].techVFX}.` : '';

  if (hasVoice) {
    const isMale = analysisData?.voicePersona?.gender === 'nam' ||
      (analysisData?.voicePersona && /nam|men/i.test(analysisData.voicePersona.voiceDescription || '')) ||
      analysisData?.category === 'gadgets' ||
      (analysisData?.targetAudience && /nam|men|đàn ông/i.test(analysisData.targetAudience));
    const defaultVoice = isMale
      ? 'nam miền Nam trầm ấm, tự tin, cuốn hút'
      : 'nữ miền Nam ngọt ngào, tự nhiên, gần gũi';
    const voiceDesc = analysisData?.voicePersona?.voiceDescription || defaultVoice;

    // Lời thoại voice-over: mỗi cảnh 15-19 từ, tổng 2 cảnh tối đa 42 từ, câu cú trọn vẹn đủ ý, đọc nhanh dồn dập, tuyệt đối không dùng giá tiền / % giảm giá
    const vo1 = script[0]?.voiceOver || 'Đầu giường vừa tối vừa rối tung dây sạc khiến bạn khó chịu mỗi ngày? Đừng bỏ qua siêu phẩm này!';
    const vo2 = script[1]?.voiceOver || 'Đèn bàn thông minh tích hợp sẵn ổ cắm và sạc nhanh, giải quyết nhanh gọn mọi bất tiện.';
    const vo3 = script[2]?.voiceOver || 'Cận cảnh thao tác chạm đổi ba màu sáng êm dịu, chất liệu nhựa ABS cao cấp bền bỉ an toàn.';
    const vo4 = script[3]?.voiceOver || 'Sự lựa chọn hoàn hảo nâng tầm không gian sống, bấm ngay giỏ hàng góc trái để nhận ưu đãi nha!';

    const video1Script = combineTwoSceneScripts(vo1, vo2, 42);
    const video2Script = combineTwoSceneScripts(vo3, vo4, 42);

    return [
      `Tạo video review ${prodName} faceless dài đúng 8 giây từ hình ảnh 2 cảnh đã cung cấp (gồm Cảnh 1 ở nửa bên trái và Cảnh 2 ở nửa bên phải). ${borderRule} CHUYỂN ĐỘNG THEO THỜI GIAN VÀ CẢNH QUAY: 0s-4s bắt đầu chính xác từ Cảnh 1 (nửa bên trái hình ảnh), camera giữ góc quay cận cảnh ổn định bên trong khung hình Cảnh 1, bàn tay người thao tác thực tế${vfx1} ${desc1}; tại mốc 4 giây chuyển cảnh dứt khoát (clean cut transition) sang Cảnh 2 (nửa bên phải hình ảnh), tiếp tục góc quay đặc tả công năng và chi tiết sản phẩm bên trong khung hình Cảnh 2${vfx2} ${desc2}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI. Giọng đọc review: ${voiceDesc}, phong cách TikTok review cuốn hút, tốc độ đọc NHANH liên tục dồn dập không ngừng nghỉ để truyền tải trọn vẹn thông tin. Lời thoại nhân vật đọc liên tục trong 8 giây (tối đa 42 từ): "${video1Script}". ${realismCues}`,
      `Tạo video review ${prodName} faceless dài đúng 8 giây từ hình ảnh 2 cảnh đã cung cấp (gồm Cảnh 3 ở nửa bên trái và Cảnh 4 ở nửa bên phải). ${borderRule} CHUYỂN ĐỘNG THEO THỜI GIAN VÀ CẢNH QUAY: 0s-4s bắt đầu chính xác từ Cảnh 3 (nửa bên trái hình ảnh), camera giữ góc quay cận cảnh đặc tả chất liệu, cấu tạo tinh xảo bên trong khung hình Cảnh 3, bàn tay người thao tác kiểm tra thực tế${vfx3} ${desc3}; tại mốc 4 giây chuyển cảnh dứt khoát (clean cut transition) sang Cảnh 4 (nửa bên phải hình ảnh), mở rộng góc quay tôn vinh sản phẩm trong không gian phong cách sống hoàn thiện bên trong khung hình Cảnh 4${vfx4} ${desc4}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI. Giọng đọc review: ${voiceDesc}, phong cách TikTok review cuốn hút, tốc độ đọc NHANH liên tục dồn dập không ngừng nghỉ để truyền tải trọn vẹn thông tin. Lời thoại nhân vật đọc liên tục trong 8 giây (tối đa 42 từ): "${video2Script}". ${realismCues}`
    ];
  }

  // Template 5: Có chữ (With Text) - 4s đầu dùng chữ Cảnh 1/3, 4s sau dùng chữ Cảnh 2/4
  if (!isNoText) {
    const overlays = analysisData?.panelOverlays || normalizePanelOverlays(analysisData || {});
    const h1 = overlays[0]?.headline || 'TIÊU ĐỀ NỔI BẬT';
    const s1 = (overlays[0]?.subtexts || []).join(' | ');
    const t1 = s1 ? `"${h1}" (${s1})` : `"${h1}"`;

    const h2 = overlays[1]?.headline || 'GIẢI PHÁP VƯỢT TRỘI';
    const s2 = (overlays[1]?.subtexts || []).join(' | ');
    const t2 = s2 ? `"${h2}" (${s2})` : `"${h2}"`;

    const h3 = overlays[2]?.headline || 'CHẤT LƯỢNG CAO CẤP';
    const s3 = (overlays[2]?.subtexts || []).join(' | ');
    const t3 = s3 ? `"${h3}" (${s3})` : `"${h3}"`;

    const h4 = overlays[3]?.headline || 'CHỐT ĐƠN NGAY';
    const s4 = (overlays[3]?.subtexts || []).join(' | ');
    const t4 = s4 ? `"${h4}" (${s4})` : `"${h4}"`;

    return [
      `Tạo video review ${prodName} faceless dài đúng 8 giây từ hình ảnh 2 cảnh đã cung cấp (gồm Cảnh 1 ở nửa bên trái và Cảnh 2 ở nửa bên phải). ${borderRule} CHUYỂN ĐỘNG THEO THỜI GIAN VÀ CẢNH QUAY: 0s-4s bắt đầu chính xác từ Cảnh 1 (nửa bên trái hình ảnh), camera giữ góc quay cận cảnh ổn định bên trong khung hình Cảnh 1, hiển thị chính xác dòng chữ của Cảnh 1: ${t1}, bàn tay người thao tác thực tế${vfx1} ${desc1}; tại mốc 4 giây chuyển cảnh dứt khoát (clean cut transition) sang Cảnh 2 (nửa bên phải hình ảnh), tiếp tục góc quay đặc tả công năng và chi tiết sản phẩm bên trong khung hình Cảnh 2, chuyển sang hiển thị chính xác dòng chữ của Cảnh 2: ${t2}${vfx2} ${desc2}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. HIỂN THỊ CHỮ THEO THỜI GIAN: 4 giây đầu (0s-4s) hiển thị chính xác chữ Cảnh 1, 4 giây sau (4s-8s) chuyển sang hiển thị chính xác chữ Cảnh 2 đúng chính tả tiếng Việt có dấu, tuyệt đối không tự tạo thêm bất kỳ chữ rác, tiêu đề rác hoặc icon hoạt hình nào khác. ${realismCues} Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`,
      `Tạo video review ${prodName} faceless dài đúng 8 giây từ hình ảnh 2 cảnh đã cung cấp (gồm Cảnh 3 ở nửa bên trái và Cảnh 4 ở nửa bên phải). ${borderRule} CHUYỂN ĐỘNG THEO THỜI GIAN VÀ CẢNH QUAY: 0s-4s bắt đầu chính xác từ Cảnh 3 (nửa bên trái hình ảnh), camera giữ góc quay cận cảnh đặc tả chất liệu, cấu tạo tinh xảo bên trong khung hình Cảnh 3, hiển thị chính xác dòng chữ của Cảnh 3: ${t3}, bàn tay người thao tác kiểm tra thực tế${vfx3} ${desc3}; tại mốc 4 giây chuyển cảnh dứt khoát (clean cut transition) sang Cảnh 4 (nửa bên phải hình ảnh), mở rộng góc quay tôn vinh sản phẩm trong không gian phong cách sống hoàn thiện bên trong khung hình Cảnh 4, chuyển sang hiển thị chính xác dòng chữ của Cảnh 4: ${t4}${vfx4} ${desc4}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. HIỂN THỊ CHỮ THEO THỜI GIAN: 4 giây đầu (0s-4s) hiển thị chính xác chữ Cảnh 3, 4 giây sau (4s-8s) chuyển sang hiển thị chính xác chữ Cảnh 4 đúng chính tả tiếng Việt có dấu, tuyệt đối không tự tạo thêm bất kỳ chữ rác, tiêu đề rác hoặc icon hoạt hình nào khác. ${realismCues} Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`
    ];
  }

  // Template 5.1: Không chữ (No Text) - Không voice (Silent)
  return [
    `Tạo video review ${prodName} faceless dài đúng 8 giây từ hình ảnh 2 cảnh đã cung cấp (gồm Cảnh 1 ở nửa bên trái và Cảnh 2 ở nửa bên phải). ${borderRule} CHUYỂN ĐỘNG THEO THỜI GIAN VÀ CẢNH QUAY: 0s-4s bắt đầu chính xác từ Cảnh 1 (nửa bên trái hình ảnh), camera giữ góc quay cận cảnh ổn định bên trong khung hình Cảnh 1, bàn tay người thao tác thực tế${vfx1} ${desc1}; tại mốc 4 giây chuyển cảnh dứt khoát (clean cut transition) sang Cảnh 2 (nửa bên phải hình ảnh), tiếp tục góc quay đặc tả công năng và chi tiết sản phẩm bên trong khung hình Cảnh 2${vfx2} ${desc2}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). ${realismCues} Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`,
    `Tạo video review ${prodName} faceless dài đúng 8 giây từ hình ảnh 2 cảnh đã cung cấp (gồm Cảnh 3 ở nửa bên trái và Cảnh 4 ở nửa bên phải). ${borderRule} CHUYỂN ĐỘNG THEO THỜI GIAN VÀ CẢNH QUAY: 0s-4s bắt đầu chính xác từ Cảnh 3 (nửa bên trái hình ảnh), camera giữ góc quay cận cảnh đặc tả chất liệu, cấu tạo tinh xảo bên trong khung hình Cảnh 3, bàn tay người thao tác kiểm tra thực tế${vfx3} ${desc3}; tại mốc 4 giây chuyển cảnh dứt khoát (clean cut transition) sang Cảnh 4 (nửa bên phải hình ảnh), mở rộng góc quay tôn vinh sản phẩm trong không gian phong cách sống hoàn thiện bên trong khung hình Cảnh 4${vfx4} ${desc4}. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). ${realismCues} Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`
  ];
}

/**
 * Lưu tr metadata và kết quả vào thư mục storyboard-review-runs
 */
function archiveStoryboardReview(baseDir, filePayloads, prompt, storyboardBase64, panels, analysis, options = {}) {
  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const template = options.template || (options.noText ? (options.hasVoice ? 'template5_2' : 'template5_1') : 'template5');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = Math.random().toString(36).substring(2, 8);
  const runDir = path.join(effectiveBaseDir, 'storyboard-review-runs', `${timestamp}-${template}-flow-${runId}`);
  ensureDir(runDir);

  const inputsDir = path.join(runDir, 'inputs');
  ensureDir(inputsDir);
  filePayloads.forEach((f, idx) => {
    const ext = (f.mimeType && f.mimeType.includes('png')) ? '.png' : '.jpg';
    const filePath = path.join(inputsDir, `input-${idx + 1}${ext}`);
    const buf = Buffer.isBuffer(f.buffer) ? f.buffer : (f.base64 ? Buffer.from(f.base64, 'base64') : (f.path ? fs.readFileSync(f.path) : null));
    if (buf) fs.writeFileSync(filePath, buf);
  });

  const storyboardPath = path.join(runDir, 'storyboard.png');
  if (storyboardBase64) {
    fs.writeFileSync(storyboardPath, Buffer.from(storyboardBase64, 'base64'));
  }

  const panelsDir = path.join(runDir, 'panels');
  ensureDir(panelsDir);
  panels.forEach(p => {
    const pPath = path.join(panelsDir, `panel-${p.index}.png`);
    const pBuf = Buffer.isBuffer(p.buffer) ? p.buffer : (p.base64 ? Buffer.from(p.base64, 'base64') : (p.imageBase64 ? Buffer.from(p.imageBase64, 'base64') : null));
    if (pBuf) {
      fs.writeFileSync(pPath, pBuf);
    }
    p.imagePath = pPath;
  });

  const isTemplate5_3 = !!(
    template === 'template5_3' || template === 'template5.3' || template === 'template53'
  );
  const videoPrompts = isTemplate5_3
    ? getTemplate5_3VideoPrompts(analysis, options)
    : getTemplate5VideoPrompts(analysis, options);
  const isNoText = !!(
    options.noText ||
    template === 'template5_1' || template === 'template5.1' || template === 'template51' ||
    template === 'template5_2' || template === 'template5.2' || template === 'template52' ||
    isTemplate5_3
  );
  const overlays = analysis?.panelOverlays || normalizePanelOverlays(analysis || {});
  const overlaysSummary = isNoText
    ? (isTemplate5_3
      ? 'NO TEXT + VOICE-OVER MODE (4x4s Spam Video): All 4 panels generated without text overlays. Videos include Vietnamese review voice-over (4s per panel).'
      : (template.includes('5_2') || template.includes('5.2') || template.includes('52')
        ? 'NO TEXT + VOICE-OVER MODE: All panels and storyboard generated without text overlays. Videos include Vietnamese review voice-over.'
        : 'NO TEXT MODE: All panels and storyboard generated without text overlays.'))
    : overlays.map(p => `### Panel ${p.id}: ${p.headline}\n${(p.subtexts || []).map(s => `- ${s}`).join('\n')}`).join('\n\n');

  const mdContent = [
    `# Template 5 Storyboard Run - ${template.toUpperCase()}`,
    `Run ID: ${runId}`,
    `Date: ${new Date().toISOString()}`,
    `Product: ${analysis?.productName || 'Unknown'}`,
    `Category: ${analysis?.category || 'general'}`,
    `Voice Persona: ${analysis?.voicePersona?.voiceDescription || 'N/A'} (Gender: ${analysis?.voicePersona?.gender || 'N/A'})`,
    '',
    '## Master Storyboard Prompt',
    '```text',
    prompt,
    '```',
    '',
    '## Panel Overlays',
    overlaysSummary,
    '',
    '## Veo 3 Video Prompts',
    videoPrompts.map((vp, idx) => `### Panel ${idx + 1} Video Prompt\n\`\`\`text\n${vp}\n\`\`\``).join('\n\n'),
  ].join('\n');

  fs.writeFileSync(path.join(runDir, 'prompts.md'), mdContent, 'utf8');

  return {
    root: runDir,
    inputsDir,
    panelsDir,
    videosDir: path.join(runDir, 'videos'),
    storyboardPath,
    promptsPath: path.join(runDir, 'prompts.md')
  };
}

/**
 * Main Storyboard Generator for Template 5, 5.1 (No Text), and 5.2 (No Text + Voice)
 */
async function generateStoryboard(baseDir, filePayloads, options = {}) {
  const template = options.template || (options.noText ? (options.hasVoice ? 'template5_2' : 'template5_1') : 'template5');
  const isTemplate5_3 = !!(
    template === 'template5_3' || template === 'template5.3' || template === 'template53'
  );
  const isNoText = !!(
    options.noText ||
    template === 'template5_1' || template === 'template5.1' || template === 'template51' ||
    template === 'template5_2' || template === 'template5.2' || template === 'template52' ||
    isTemplate5_3
  );
  const hasVoice = !!(
    options.hasVoice ||
    template === 'template5_2' || template === 'template5.2' || template === 'template52' ||
    isTemplate5_3
  );
  const promptOptions = { ...options, template, noText: isNoText, hasVoice };

  console.log(`[Template5] Starting ${template.toUpperCase()} (${isNoText ? 'No Text' : 'With Text'}${hasVoice ? ' + Voice' : ''}) review generation for ${filePayloads.length} input image(s)...`);

  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');

  // Đảm bảo cookies Gemini được kiểm tra và làm mới ngay từ đầu
  try {
    const { maybeRefreshCookies } = require('./gemini-cookie-refresher');
    await maybeRefreshCookies(effectiveBaseDir);
  } catch (refreshErr) {
    console.warn(`[Template5] Tự động refresh cookie đầu luồng: ${refreshErr.message}`);
  }

  const cookieFilePath = process.env.GEMINI_COOKIE_PATH
    ? path.resolve(effectiveBaseDir, process.env.GEMINI_COOKIE_PATH)
    : path.join(effectiveBaseDir, 'gemini-cookies');

  const geminiClient = new GeminiApiClient({
    cookieFilePath: fs.existsSync(cookieFilePath) ? cookieFilePath : undefined,
  });

  try {
    await geminiClient.init();
  } catch (initErr) {
    console.error(`[Template5] ❌ Init GeminiClient thất bại: ${initErr.message}`);
    throw new Error(`[Template5] Không thể kết nối Gemini API: ${initErr.message}. Vui lòng kiểm tra lại cookie hoặc chạy "node login.js".`);
  }

  let analysis = null;
  let storyboardBase64 = null;
  let masterPrompt = '';
  const panels = [];

  try {
    // 1. Phân tích sản phẩm
    if (options.stepTracker) await options.stepTracker.setStep(2, 'running');
    const { analysis: analyzedData, uploadedFiles } = await analyzeProductTemplate5(geminiClient, filePayloads, promptOptions);
    analysis = analyzedData;
    if (options.stepTracker) {
      await options.stepTracker.setTitle(analysis?.productName);
      await options.stepTracker.setStep(2, 'completed');
      await options.stepTracker.setStep(3, 'running');
    }

    // 2. Sinh Master Storyboard qua Gemini API (Không dùng ảnh ref tĩnh)
    console.log(`[Template5] Step 2: Generating Master 4-Panel Storyboard (${isNoText ? 'No Text' : 'With Text'}) via Gemini API...`);
    masterPrompt = buildTemplate5MasterPrompt(analysis, promptOptions);

    let storyboardBuf = null;
    let lastMasterErr = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const masterRes = await geminiClient.generateContent({
          prompt: masterPrompt,
          fileData: uploadedFiles,
          temporary: true,
          expectImages: true,
        });

        if (!masterRes.images || masterRes.images.length === 0) {
          throw new Error('Gemini API did not return any Master Storyboard image for Template 5');
        }

        storyboardBuf = await geminiClient.downloadImage(masterRes.images[0].url);
        storyboardBase64 = storyboardBuf.toString('base64');
        console.log('[Template5] ✅ Master Storyboard created successfully!');
        break;
      } catch (err) {
        lastMasterErr = err;
        console.warn(`[Template5] Master Storyboard Attempt ${attempt}/3 failed: ${err.message}. Retrying in 4s...`);
        await new Promise(r => setTimeout(r, 4000));
      }
    }

    if (!storyboardBuf) {
      throw new Error(`Failed to generate Master Storyboard: ${lastMasterErr?.message || 'Unknown error'}`);
    }

    const targetChatId = options.chatId || options.telegramChatId || null;
    if (targetChatId && storyboardBuf && !options.stepTracker) {
      sendPhotoToTelegram(
        targetChatId,
        storyboardBuf,
        isTemplate5_3
          ? `🎨 Master Storyboard (${template.toUpperCase()}) đã tạo xong. Đang tách thành 4 hình (mỗi hình 1 cảnh 4s)...`
          : `🎨 Master Storyboard (${template.toUpperCase()}) đã tạo xong. Đang tách thành 2 hình (mỗi hình 2 cảnh)...`
      ).catch(err => console.error('[Template5] sendPhoto error:', err.message));
    }

    // 3. Tách Master Storyboard
    let videoPrompts;
    let panelBuffers;
    let expectedPanelCount;

    if (isTemplate5_3) {
      console.log(`[Template5_3] Step 3: Slicing Master Storyboard into 4 individual 9:16 panel images (Scenes 1, 2, 3, 4) full viền (borderless)...`);
      videoPrompts = getTemplate5_3VideoPrompts(analysis, promptOptions);
      panelBuffers = sliceStoryboardIntoFourPanels(storyboardBuf);
      expectedPanelCount = 4;
    } else {
      console.log(`[Template5] Step 3: Slicing Master Storyboard into 2 panel images (Image 1 = Scenes 1+2, Image 2 = Scenes 3+4) full viền (borderless)...`);
      videoPrompts = getTemplate5VideoPrompts(analysis, promptOptions);
      const [panel1Buf, panel2Buf] = sliceStoryboardIntoTwoImages(storyboardBuf);
      panelBuffers = [panel1Buf, panel2Buf];
      expectedPanelCount = 2;
    }

    let livePanelMsgId = null;
    for (let i = 1; i <= expectedPanelCount; i++) {
      const pBuf = panelBuffers[i - 1];
      panels.push({
        index: i,
        imagePath: null, // will be populated in archive
        imageBase64: pBuf.toString('base64'),
        buffer: pBuf,
        mimeType: 'image/png',
        hasWhiteBorder: !isTemplate5_3,
        prompt: videoPrompts[i - 1],
      });

      if (targetChatId && pBuf && !options.stepTracker) {
        try {
          livePanelMsgId = await sendOrUpdateLivePanel(targetChatId, livePanelMsgId, pBuf, i, expectedPanelCount);
        } catch (_) {}
      }
    }

    if (options.stepTracker) {
      await options.stepTracker.setStep(3, 'completed');
      await options.stepTracker.setStep(4, 'running');
    }
  } finally {
    try { await geminiClient.close(); } catch (_) {}
  }

  const progress = typeof options.onProgress === 'function' ? options.onProgress : async () => {};
  await progress({
    currentStep: 'panels_generated',
    stepOrder: 4,
    progressPercent: 60,
    message: isTemplate5_3
      ? 'Đã tách xong 4 hình panel (mỗi hình 1 cảnh 4s). Đang tiến hành tạo video...'
      : 'Đã tách xong 2 hình panel (mỗi hình 2 cảnh). Đang tiến hành tạo video...',
  });

  // 4. Archive kết quả
  const reviewArchive = archiveStoryboardReview(baseDir, filePayloads, masterPrompt, storyboardBase64, panels, analysis, promptOptions);

  // 5. Sinh Video trên Google Flow
  let videos = [];
  if (options.generateVideos !== false) {
    if (isTemplate5_3) {
      console.log('[Template5_3] Step 5: Generating 4 Veo 4-second videos on Google Flow...');
      if (options.stepTracker) await options.stepTracker.setStep(4, 'running');
      await progress({
        currentStep: 'generating_videos',
        stepOrder: 5,
        progressPercent: 75,
        message: 'Đang tạo 4 video bằng Veo 4s...',
      });
      videos = await generateVideosFromPanelsDirect(baseDir, panels, {
        aspectRatio: '9:16',
        videoModelKey: options.videoModelKey || '4s',
        includeVideoBase64: !!options.includeVideoBase64,
        // Template 5_3 does NOT need cropPercent: 0.12 (Veo logo is far from center, crop like Template 6)
      });
    } else {
      console.log('[Template5] Step 5: Generating 2 Abra i2v 8-second videos on Google Flow...');
      if (options.stepTracker) await options.stepTracker.setStep(4, 'running');
      await progress({
        currentStep: 'generating_videos',
        stepOrder: 5,
        progressPercent: 75,
        message: 'Đang tạo 2 video bằng Abra i2v...',
      });
      videos = await generateVideosFromPanelsDirect(baseDir, panels, {
        aspectRatio: '9:16',
        videoModelKey: options.videoModelKey || 'abra_i2v_8s',
        includeVideoBase64: !!options.includeVideoBase64,
        cropPercent: 0.12,
      });
    }
    console.log(`[${isTemplate5_3 ? 'Template5_3' : 'Template5'}] Video result: ${videos.filter(v => !v.error).length}/${videos.length} completed`);
    if (options.stepTracker) {
      await options.stepTracker.setStep(4, 'completed');
      await options.stepTracker.setStep(5, 'completed');
    }
    await progress({
      currentStep: 'videos_generated',
      stepOrder: 6,
      progressPercent: 90,
      message: `Đã tạo xong ${videos.filter(v => !v.error).length}/${videos.length} video panel.`,
    });

    if (reviewArchive && reviewArchive.root) {
      const videosDir = path.join(reviewArchive.root, 'videos');
      ensureDir(videosDir);
      for (const v of videos) {
        if (v.videoPath && fs.existsSync(v.videoPath)) {
          const target = path.join(videosDir, `panel-${v.panelIndex}.mp4`);
          fs.copyFileSync(v.videoPath, target);
          v.videoPath = target;
        }
      }
    }
  }

  return {
    panels,
    videos,
    promptSource: 'gemini-api',
    storyboard: {
      imageBase64: storyboardBase64,
      mimeType: 'image/png',
      sourcePath: reviewArchive?.storyboardPath || null,
    },
    reviewArchive,
    analysis: {
      productName: analysis?.productName || (isTemplate5_3 ? 'Template 5.3 Product Review' : 'Template 5 Product Review'),
      category: analysis?.category || 'general',
      hashtags: analysis?.hashtags || ['#review', '#trending', '#fashionreview'],
      summary: isTemplate5_3
        ? `✨ Đã hoàn thành review đa ngành hàng 4 cảnh (4 video 4s) cho "${analysis?.productName || 'sản phẩm'}"!`
        : `✨ Đã hoàn thành review đa ngành hàng 4 cảnh (2 video 8s) cho "${analysis?.productName || 'sản phẩm'}"!`,
    },
  };
}

module.exports = {
  generateStoryboard,
  analyzeProductTemplate5,
  buildTemplate5AnalysisPrompt,
  buildTemplate5MasterPrompt,
  buildTemplate5PanelPrompt,
  getTemplate5VideoPrompts,
  getTemplate5_3VideoPrompts,
  sliceStoryboardIntoTwoImages,
  sliceStoryboardIntoFourPanels,
  clampScriptWords,
  combineTwoSceneScripts,
  normalizePanelOverlays,
};
