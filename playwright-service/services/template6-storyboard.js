'use strict';

/**
 * template6-storyboard.js
 *
 * Template 6: Review Siêu Thị / Cửa Hàng Tiện Lợi (Bách Hóa Xanh / WinMart POV 2 Cảnh 8 Giây, Không Chữ, Không Tiếng)
 *
 * Luồng hoạt động:
 * 1. Phân tích ảnh sản phẩm (bất kỳ sản phẩm nào trong siêu thị: đồ uống, bánh kẹo, gia vị, hóa mỹ phẩm, gia dụng, đồ cho bé...)
 * 2. Chọn ngẫu nhiên phong cách siêu thị:
 *    - Bách Hóa Xanh (kệ hàng xanh lá, giỏ xanh lá quai vàng trên sàn) - Tham chiếu template6_1.png
 *    - WinMart (kệ hàng đỏ, biển hiệu WinMart "Tiết kiệm mỗi ngày" / "Tươi ngon thượng hạng", giỏ đỏ WinMart trên sàn) - Tham chiếu template6_2.png
 * 3. Tạo Master Storyboard 2 cảnh (chứa 2 khung dọc 9:16 đặt song song):
 *    - Panel 1 (9:16): Cầm sản phẩm ngang ngực quan sát bao bì, sàn gạch sạch sẽ, TUYỆT ĐỐI KHÔNG CÓ GIỎ HÀNG.
 *    - Panel 2 (9:16): Góc nhìn từ trên xuống (top-down), cầm sản phẩm đưa xuống giỏ hàng cố định trên sàn.
 * 4. Sinh 2 panel 9:16 riêng biệt có độ phân giải cao và chân thực chuẩn iPhone 15 Pro.
 * 5. Gọi Google Flow Veo 3 tạo 2 video 9:16 thời lượng đúng 8 GIÂY (8s):
 *    - Cảnh 1 (8s, theo template6_1.md): Cầm sản phẩm ngang ngực -> xoay cổ tay nhẹ -> nghiêng xem bao bì -> giữ lại vị trí. Camera cố định, không giỏ hàng, không chữ, không tiếng.
 *    - Cảnh 2 (8s, theo template6_2.md): Cầm sản phẩm -> hạ tay xuống -> đưa vào giỏ hàng dưới sàn -> đặt xuống giữa hàng hóa -> buông tay -> rút tay ra. Giỏ cố định dưới đất, camera cố định, không chữ, không tiếng.
 * 6. Lưu trữ archive và trả kết quả cho Telegram bot.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

const { generateVideosFromPanelsDirect } = require('./gemini-webapi-storyboard');
const { GeminiApiClient } = require('./gemini-client/gemini-api');

/**
 * Tách chính xác 2 panel 9:16 từ Master Storyboard (nửa trái = Panel 1, nửa phải = Panel 2)
 * Đảm bảo 100% đồng nhất về sản phẩm, góc máy, bàn tay và ánh sáng giữa Storyboard và Panel
 */
async function sliceStoryboardIntoPanels(storyboardBuffer) {
  const tmpDir = os.tmpdir();
  const tmpSbPath = path.join(tmpDir, `sb_master_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`);
  fs.writeFileSync(tmpSbPath, storyboardBuffer);

  const panel1Path = path.join(tmpDir, `panel_1_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`);
  const panel2Path = path.join(tmpDir, `panel_2_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(tmpSbPath)
        .videoFilters(['crop=iw/2:ih:0:0', 'scale=1080:1920:flags=lanczos'])
        .output(panel1Path)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    await new Promise((resolve, reject) => {
      ffmpeg(tmpSbPath)
        .videoFilters(['crop=iw/2:ih:iw/2:0', 'scale=1080:1920:flags=lanczos'])
        .output(panel2Path)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const p1Buf = fs.readFileSync(panel1Path);
    const p2Buf = fs.readFileSync(panel2Path);

    return [p1Buf, p2Buf];
  } finally {
    try { fs.unlinkSync(tmpSbPath); } catch (_) {}
    try { fs.unlinkSync(panel1Path); } catch (_) {}
    try { fs.unlinkSync(panel2Path); } catch (_) {}
  }
}

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

function parseJsonObject(text) {
  const cleaned = stripCodeFence(text);
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw error;
  }
}

/**
 * Ngẫu nhiên hóa siêu thị & outfit người review để tạo sự đa dạng tự nhiên
 */
function getRandomSupermarketElements() {
  const stores = ['bachhoaxanh', 'red_supermarket'];
  const store = stores[Math.floor(Math.random() * stores.length)];

  const sleeves = [
    'dark burgundy / wine-red long-sleeved cuff',
    'minimalist cream beige linen long-sleeved cuff',
    'soft light olive green long-sleeved cuff',
    'classic navy blue cotton long-sleeved cuff',
    'chic soft lavender knit long-sleeved cuff'
  ];
  const accessories = [
    'a delicate thin gold chain bracelet on the wrist',
    'a minimalist slim rose-gold bangle on the wrist',
    'a dainty silver cord bracelet on the wrist',
    'a classic slim leather-strap wristwatch on the wrist'
  ];
  const pantsAndShoes = [
    'casual dark grey denim pants with clean light grey sneakers',
    'relaxed black straight-leg trousers with white lifestyle trainers',
    'comfortable dark navy jeans with neutral grey slip-on sneakers'
  ];

  return {
    store,
    sleeve: sleeves[Math.floor(Math.random() * sleeves.length)],
    accessory: accessories[Math.floor(Math.random() * accessories.length)],
    pantsAndShoes: pantsAndShoes[Math.floor(Math.random() * pantsAndShoes.length)],
  };
}

function normalizeHashtag(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const tag = raw.startsWith('#') ? raw : `#${raw}`;
  return tag
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}_#]/gu, '')
    .replace(/^#+/, '#');
}

function slugToHashtag(value) {
  const raw = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .trim();
  return raw ? `#${raw}` : '';
}

function normalizeTemplate6Hashtags(parsed, elements) {
  const provided = Array.isArray(parsed.hashtags) ? parsed.hashtags : (Array.isArray(parsed.analysis?.hashtags) ? parsed.analysis.hashtags : []);
  const pName = parsed.productName || parsed.analysis?.productName || '';
  const brand = parsed.brand || parsed.analysis?.brand || '';
  const category = parsed.category || parsed.analysis?.category || 'sieuthi';
  const storeTag = elements?.store === 'bachhoaxanh' ? '#BachHoaXanh' : '#SieuThiTienLoi';

  const fallbacks = [
    brand,
    pName,
    'ReviewSieuThi',
    storeTag,
    category,
    'GocNhinReview',
    'TikTokShopVN',
    'Trending',
  ];

  const tags = [];
  for (const item of [...provided, ...fallbacks]) {
    const norm = normalizeHashtag(item) || slugToHashtag(item);
    if (norm && norm.length > 2 && !tags.some(t => t.toLowerCase() === norm.toLowerCase())) {
      tags.push(norm);
    }
    if (tags.length === 5) break;
  }

  const defaultPool = ['#ReviewSieuThi', '#MuaSamThongMinh', storeTag, '#ReviewChanThuc', '#TikTokShopVN'];
  for (const def of defaultPool) {
    if (tags.length >= 5) break;
    if (!tags.some(t => t.toLowerCase() === def.toLowerCase())) {
      tags.push(def);
    }
  }

  while (tags.length < 5) {
    tags.push(`#sanpham${tags.length + 1}`);
  }

  return tags;
}

/**
 * Xây dựng Analysis Prompt cho sản phẩm siêu thị
 */
function buildTemplate6AnalysisPrompt() {
  return `TEXT-ONLY TASK. Do not generate images. Do not call image generation.
You are a senior retail merchandising analyst, Vietnamese typography specialist, and Veo 3 director.
Analyze the uploaded product image(s) with extreme precision. Extract the EXACT Vietnamese text printed on the front label, brand name, and supermarket merchandising context.

Return ONLY valid JSON with this schema:
{
  "productName": "Tên sản phẩm tiếng Việt đầy đủ và chính xác kèm thương hiệu (ví dụ: Nước Rửa Chén Top Gia Hương Bưởi Hồng)",
  "brand": "Tên thương hiệu chính xác (ví dụ: TOP GIA, Sunlight, Lix, Mỹ Hảo)",
  "exactLabelText": {
    "productTitle": "Dòng tiêu đề loại sản phẩm in trên nhãn (ví dụ: NƯỚC RỬA CHÉN)",
    "brandName": "Tên thương hiệu trên nhãn (ví dụ: TOP GIA)",
    "taglineOrVariant": "Dòng slogan hoặc đặc tính nổi bật in trên nhãn (ví dụ: SIÊU SẠCH - SIÊU TIẾT KIỆM)"
  },
  "category": "beverages|snacks|dairy|condiments|instant_food|personal_care|household|baby|cosmetics|other",
  "packagingType": "bottle|box|can|pouch|jar|packet|spray|tub|carton",
  "hashtags": ["#ThuongHieu", "#TenSanPham", "#ReviewSieuThi", "#SieuThiTienLoi", "#TikTokShopVN"],
  "keyVisualDetails": "Color, logo, shape, text on packaging, texture",
  "supermarketAisleDescription": "Mô tả chi tiết kệ hàng siêu thị phù hợp (ví dụ: kệ nước ngọt đóng chai, kệ bánh kẹo bim bim, kệ nước mắm gia vị, kệ dầu gội sữa tắm...)",
  "neighborProducts": "Các sản phẩm tương tự cùng ngành hàng đặt bên cạnh trên kệ"
}`;
}

/**
 * Xây dựng Master Storyboard Prompt 2 Panel cho Template 6
 */
function buildTemplate6StoryboardPrompt(analysis, elements) {
  const prodName = analysis.productName || 'sản phẩm siêu thị';
  const brandName = analysis.exactLabelText?.brandName || analysis.brand || 'TOP GIA';
  const labelTitle = analysis.exactLabelText?.productTitle || 'NƯỚC RỬA CHÉN';
  const labelTagline = analysis.exactLabelText?.taglineOrVariant || 'SIÊU SẠCH - SIÊU TIẾT KIỆM';
  const aisleDesc = analysis.supermarketAisleDescription || 'kệ hàng siêu thị hiện đại ngăn nắp';
  const neighbor = analysis.neighborProducts || 'các sản phẩm cùng loại trên kệ';
  const isRedStore = elements.store === 'red_supermarket' || elements.store === 'winmart';

  const storeName = isRedStore ? 'Siêu thị tiện lợi hiện đại' : 'Bách Hóa Xanh';
  const shelfStyle = isRedStore
    ? 'Modern red-themed convenience supermarket aisle with bold red promotional header signs ("SIÊU THỊ TIỆN LỢI - TƯƠI NGON MỖI NGÀY", "Hàng Mới Giá Tốt"), red shelf price tags with readable numbers ("25.000đ", "39.000đ"), brightly lit modern supermarket environment, glossy beige tile floor'
    : 'Bach Hoa Xanh supermarket aisle with signature green shelf headers ("Bách Hóa XANH - Thịt Cá Tươi Ngon", "Giá Rẻ Mỗi Ngày"), white and yellow price tags, well-organized retail shelving, bright daylight and ceiling lighting, clean beige tiled floor';

  const basketDesc = isRedStore
    ? 'a classic plain red plastic shopping basket (no brand logo) resting flat on the tile floor (containing 1-2 snack boxes and a fresh food tray inside)'
    : 'a signature green plastic shopping basket with bright yellow handles resting flat on the tile floor (containing 1-2 snack packets and a packaged container inside)';

  const refFileName = isRedStore ? 'template6_2_ref.jpg' : 'template6_1_ref.jpg';

  return `Generate a single cohesive 2-panel storyboard photograph layout (side-by-side 2 vertical 9:16 panels, overall approx 18:16 ratio), depicting a 100% photorealistic first-person POV shopping experience in a Vietnamese modern supermarket (${storeName}).

VISUAL REFERENCE INSTRUCTIONS:
- Use the uploaded reference image (${refFileName}) as the MASTER VISUAL REFERENCE for the 2-panel side-by-side layout, camera POV angles, framing, lighting, supermarket theme, and floor perspective.
- REPLACE the product from the reference image with the user's uploaded product: ${prodName} (${analysis.packagingType || 'bao bì chuẩn'}), maintaining 100% brand label, colors, and shape consistency.
- ADAPT the background shelves to naturally merchandise ${aisleDesc} (${neighbor}) while keeping the exact ${storeName} supermarket environment.

MANDATORY VIETNAMESE TYPOGRAPHY & SPELLING RULES:
- The product label MUST display razor-sharp, 100% accurate Vietnamese spelling with proper diacritics and clean modern font typography:
  * Product Title: "${labelTitle}"
  * Brand Name: "${brandName}"
  * Subtext / Tagline: "${labelTagline}"
- All supermarket overhead promotional banners and signs MUST use correct Vietnamese spelling with clear diacritic marks (chuẩn 100% tiếng Việt có dấu, không lỗi font, không thiếu dấu sắc, huyền, hỏi, ngã, nặng, mũ â/ê/ô/ơ/ư):
  * ${isRedStore ? 'Banner text: "SIÊU THỊ TIỆN LỢI", "TƯƠI NGON MỖI NGÀY", "Hàng Mới Giá Tốt"' : 'Banner text: "Bách Hóa XANH", "Thịt Cá Tươi Ngon", "Giá Rẻ Mỗi Ngày"'}
- Shelf price strips and brand labels in background (e.g. Sunlight, Lix, Mỹ Hảo, Net...) must have crisp, realistic letters.
- STRICTLY FORBIDDEN: copyrighted third-party supermarket logos, misspelled words, missing diacritics, unreadable alien fonts, melted/wobbly characters, or distorted pseudo-text.

STRICT STYLE & REALISM:
- Shot on iPhone 15 Pro 4K camera, natural handheld eye/chest level POV.
- 100% live-action realism: natural supermarket lighting, soft ambient daylight, authentic specular reflections on the tiled floor.
- Slim female reviewer hand and forearm with natural skin texture, visible pores, and knuckle creases.
- Reviewer outfit: ${elements.sleeve}, ${elements.accessory}.
- Background setting: ${shelfStyle}.

PANEL 1 (Left Panel - Vertical 9:16 ratio):
- Camera & View: First-person POV standing in the supermarket aisle at chest level looking forward (matching Panel 1 of ${refFileName}).
- Action & Subject: The female hand (${elements.accessory}, ${elements.sleeve}) holds the ${prodName} upright in the foreground at mid-chest height, observing the front label ("${brandName}", "${labelTitle}", "${labelTagline}") clearly.
- Floor & Background: Clean beige tiled floor extending down the aisle between the retail shelves.
- CRITICAL RESTRICTION FOR PANEL 1: STRICTLY NO SHOPPING BASKET in Panel 1 (clean floor, no basket, no clutter).

PANEL 2 (Right Panel - Vertical 9:16 ratio):
- Camera & View: The exact same first-person POV looking downward at an angle from chest height towards the floor (matching Panel 2 of ${refFileName}).
- Basket on Floor: ${basketDesc}. The basket rests stationary on the floor in front of the reviewer's standing position.
- Action & Subject: The same female hand holding the ${prodName} is lowered down over the shopping basket, ready to place it inside amongst the groceries. The bottle label ("${brandName}", "${labelTitle}") remains sharp and legible.
- Bottom Edge: Reviewer's ${elements.pantsAndShoes} are naturally visible at the bottom edge of the frame.

GLOBAL MANDATORY RULES:
- Exactly 2 vertical 9:16 panels side-by-side.
- Zero CGI, zero 3D render, no plastic doll skin, no cartoon graphics, no floating text, no subtitles, no watermark.`;
}

/**
 * Xây dựng prompt tạo panel độc lập (Panel 1 hoặc Panel 2)
 */
function buildTemplate6PanelPrompt(panelIndex, analysis, elements) {
  const prodName = analysis.productName || 'sản phẩm siêu thị';
  const aisleDesc = analysis.supermarketAisleDescription || 'kệ hàng siêu thị hiện đại ngăn nắp';
  const neighbor = analysis.neighborProducts || 'các sản phẩm cùng loại trên kệ';
  const isWinMart = elements.store === 'winmart';

  const storeName = isWinMart ? 'WinMart' : 'Bách Hóa Xanh';
  const shelfStyle = isWinMart
    ? 'WinMart supermarket aisle with bold red promotional header signs ("WinMart Tươi Ngon Thượng Hạng", "Tiết kiệm mỗi ngày"), red shelf price tags, brightly lit modern supermarket environment, glossy beige tile floor'
    : 'Bach Hoa Xanh supermarket aisle with signature green shelf headers, white price strips, well-organized retail shelving, bright daylight and ceiling lighting, clean beige tiled floor';

  const basketDesc = isWinMart
    ? 'a classic red WinMart plastic shopping basket resting flat on the tile floor (containing 1-2 snack boxes and a fresh food tray inside)'
    : 'a signature green plastic shopping basket with bright yellow handles resting flat on the tile floor (containing 1-2 snack packets and a packaged container inside)';

  const commonHeader = `Generate a single faceless supermarket review photograph (9:16 vertical frame) that looks like an authentic iPhone 15 Pro POV live-action smartphone shot (still photo).
- Aspect ratio: 9:16 vertical frame.
- Setting: ${storeName} supermarket (${shelfStyle}), stocked with ${aisleDesc} and ${neighbor}.
- Reviewer: Slim female hand (${elements.sleeve}, ${elements.accessory}), natural skin texture with pores and knuckle creases.
- Product: ${prodName}, exactly matching the input reference product in shape, colors, and label details.
- 100% photorealistic: natural supermarket lighting, soft shadows on tile floor, zero CGI, zero plastic skin, strictly no text overlays, no subtitles, no watermark.`;

  if (panelIndex === 1) {
    return `${commonHeader}
CRITICAL INSTRUCTIONS FOR PANEL 1 (Scene 1):
- Camera: First-person POV at chest level looking forward down the supermarket aisle.
- Action: The female hand holds the ${prodName} upright in the foreground at chest height, inspecting it.
- Floor: Clean beige tiled floor extending down the aisle.
- STRICTLY FORBIDDEN: NO SHOPPING BASKET, no basket on floor, no face, no floating text, no CGI.`;
  }

  return `${commonHeader}
CRITICAL INSTRUCTIONS FOR PANEL 2 (Scene 2):
- Camera: First-person POV looking downwards from chest level towards the floor.
- Basket: ${basketDesc}. The basket sits firmly and securely on the tiled floor in front of the reviewer.
- Action: The female hand holding the ${prodName} is lowered down directly over the shopping basket to place it inside.
- Bottom Edge: ${elements.pantsAndShoes} are visible at the bottom edge.
- STRICTLY FORBIDDEN: basket floating, lifting basket, face, added text, cartoon style.`;
}

/**
 * Xây dựng 2 Veo 3 Video Prompts (8 giây mỗi cảnh) bám sát 100% template6_1.md và template6_2.md (động tác nhanh, dứt khoát 1-2s)
 */
function getTemplate6VideoPrompts(analysisData = {}, options = {}) {
  const prodName = analysisData.productName || 'sản phẩm';
  const customInstruction = options.customInstruction || '';

  const realismCues = 'Phong cách 100% live-action photorealistic, giống footage quay bằng iPhone 15 Pro thật. Da tay nữ tự nhiên, không làm mịn da, không hiệu ứng làm đẹp. Kệ hàng siêu thị ở background giữ nguyên, không thay đổi bố cục và sản phẩm trên kệ. Ánh sáng ban ngày tự nhiên từ cửa sổ và đèn trần, bóng đổ mềm, sàn gạch thật, màu sắc tự nhiên. Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền, không text, không subtitle, không graphic, không CGI, không 3D, không cartoon, không filter làm đẹp. Không biến dạng bàn tay. Không biến dạng sản phẩm. Không thêm người vào foreground.';

  // Cảnh 1 (8s - template6_1.md: phân bổ chi tiết 4 phân đoạn 2 giây)
  const scene1 = `Tạo video review ${prodName} góc nhìn thứ nhất (POV) dài đúng 8 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. ` +
    `Cảnh quay POV chân thực từ góc nhìn người mua hàng, camera iPhone 15 Pro đặt cố định ở vị trí ngang ngực. ` +
    `Ngay từ frame đầu tiên, sản phẩm ${prodName} đã được cầm sẵn trên tay nữ ở khoảng ngang ngực. Không có hành động lấy sản phẩm từ kệ. Tuyệt đối không có giỏ hàng trong Cảnh 1. ` +
    `Chỉ nhìn thấy bàn tay và cẳng tay nữ, không nhìn thấy khuôn mặt hay phần thân trên. ` +
    `Bàn tay giữ sản phẩm trước camera. Người mua xoay cổ tay nhịp nhàng và dứt khoát để quan sát bao bì và chi tiết sản phẩm qua từng khoảng thời gian 2 giây: ` +
    `0s-2s: Cầm sản phẩm ổn định ở ngang ngực, bắt đầu xoay nhẹ cổ tay sang trái để xem mặt bên và nhãn sản phẩm. ` +
    `2s-4s: Xoay cổ tay sang phải nhịp nhàng và dứt khoát để kiểm tra mặt sau và thông tin bao bì. ` +
    `4s-6s: Hơi nghiêng sản phẩm về phía trước và lắc nhẹ cổ tay 1-2 lần để quan sát độ bóng và chất liệu bao bì dưới ánh đèn siêu thị. ` +
    `6s-8s: Đưa sản phẩm trở lại vị trí chính diện ngang ngực, giữ ổn định tự tin. ` +
    `Cổ tay và ngón tay chuyển động tự nhiên, dứt khoát, không giật cục, có quán tính thực tế. ` +
    `Camera hoàn toàn đứng yên trong toàn bộ 8 giây. Không pan, không tilt, không zoom, không tiến gần, không lùi xa. ` +
    (customInstruction ? `YÊU CẦU ƯU TIÊN: ${customInstruction}. ` : '') +
    `${realismCues}`;

  // Cảnh 2 (8s - template6_2.md: lắc lắc sản phẩm trên tay rồi mới đặt nhẹ nhàng dứt khoát vào giỏ)
  const scene2 = `Tạo video review ${prodName} góc nhìn thứ nhất (POV) dài đúng 8 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. ` +
    `Video POV chân thực, camera iPhone 15 Pro đặt cố định ở vị trí ngang ngực, cùng góc quay và cùng bàn tay nữ như Cảnh 1. ` +
    `Ngay từ frame đầu tiên, bàn tay nữ đang cầm sản phẩm. Chiếc giỏ mua hàng đã nằm cố định trên mặt đất ở phía dưới khung hình. ` +
    `Người mua đưa sản phẩm xuống phía trên giỏ hàng, lắc nhẹ sản phẩm qua lại nhiều lần trên tay trước khi đặt nhẹ nhàng và dứt khoát vào giỏ: ` +
    `0s-2s: Bàn tay cầm sản phẩm từ ngang ngực hạ xuống phía trên giỏ hàng, giữ sản phẩm lơ lửng ngay ngắn phía trên các món đồ trong giỏ. ` +
    `2s-4s: Cầm sản phẩm trên tay lắc lắc lắc, lắc qua lắc lại 2-3 lần nhịp nhàng và dứt khoát (như thao tác cân nhắc, kiểm tra lần cuối của người mua hàng). ` +
    `4s-6s: Hạ tay xuống đặt sản phẩm nhẹ nhàng vào giữa các món đồ trong giỏ hàng. Khi sản phẩm chạm đáy giỏ, các ngón tay buông dứt khoát, sản phẩm nằm yên tự nhiên theo trọng lực. ` +
    `6s-8s: Bàn tay nhanh chóng và gọn gàng rút lên trên ra khỏi khung hình. Giỏ hàng và sản phẩm nằm cố định dưới sàn gạch. ` +
    `Giỏ mua hàng luôn nằm cố định trên mặt đất trong toàn bộ 8 giây. Tuyệt đối không nâng giỏ, không cầm quai, không kéo giỏ, không để giỏ bay hoặc tự di chuyển. ` +
    `Camera hoàn toàn đứng yên. Không pan, không tilt, không zoom, không camera tracking. Chỉ có bàn tay và sản phẩm chuyển động. ` +
    (customInstruction ? `YÊU CẦU ƯU TIÊN: ${customInstruction}. ` : '') +
    `${realismCues}`;

  return [scene1, scene2];
}

/**
 * Lưu trữ archive vào storyboard-review-runs
 */
function archiveTemplate6Review(baseDir, filePayloads, prompt, storyboardBase64, panels, analysis, elements, options = {}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = Math.random().toString(36).substring(2, 8);
  const runDir = path.join(baseDir, 'storyboard-review-runs', `${timestamp}-template6-flow-${runId}`);
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
  fs.writeFileSync(storyboardPath, Buffer.from(storyboardBase64, 'base64'));

  const panelsDir = path.join(runDir, 'panels');
  ensureDir(panelsDir);
  panels.forEach(p => {
    const pPath = path.join(panelsDir, `panel-${p.index}.png`);
    fs.writeFileSync(pPath, Buffer.from(p.imageBase64, 'base64'));
    p.imagePath = pPath;
  });

  const videoPrompts = getTemplate6VideoPrompts(analysis, options);

  const mdContent = [
    `# Template 6 Storyboard Run: Supermarket POV (${elements.store === 'winmart' ? 'WinMart' : 'Bách Hóa Xanh'})`,
    `Date: ${new Date().toISOString()}`,
    `Product: ${analysis.productName || 'Unknown'}`,
    `Category: ${analysis.category || 'supermarket'}`,
    `Store Selected: ${elements.store === 'winmart' ? 'WinMart' : 'Bách Hóa Xanh'}`,
    `Reviewer Outfit: ${elements.sleeve}, ${elements.accessory}`,
    '',
    '## Master Storyboard Prompt',
    '```text',
    prompt,
    '```',
    '',
    '## Veo 3 Video Prompts (8s each - Silent & No Text)',
    '### Panel 1 (8s - Inspecting Product at Chest Height, No Basket)',
    videoPrompts[0],
    '',
    '### Panel 2 (8s - Placing Product into Shopping Basket on Floor)',
    videoPrompts[1],
    ''
  ].join('\n');

  fs.writeFileSync(path.join(runDir, 'prompts.md'), mdContent, 'utf8');

  return {
    root: runDir,
    storyboardPath,
    panelsDir,
    inputsDir,
    template: 'template6',
    analysis,
    elements,
  };
}

/**
 * Phân tích sản phẩm qua Gemini API
 */
async function analyzeProductTemplate6(geminiClient, filePayloads, elements) {
  console.log(`[Template 6] Step 1a: Uploading ${filePayloads.length} product image(s)...`);

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

  console.log(`[Template 6] Step 1b: Analyzing product for supermarket merchandising via Gemini API...`);
  const analysisPrompt = buildTemplate6AnalysisPrompt();

  try {
    const res = await geminiClient.generateContent({
      prompt: analysisPrompt,
      fileData: uploadedFiles,
      temporary: true,
      expectImages: false,
    });

    const parsed = parseJsonObject(res.text || '');
    if (parsed) {
      const pName = parsed.productName || 'Sản Phẩm Siêu Thị';
      const cat = parsed.category || 'general';
      const hashtags = normalizeTemplate6Hashtags(parsed, elements);
      console.log(`[Template 6] ✅ Product analyzed: "${pName}" (${cat})`);
      console.log(`[Template 6] Hashtags: ${hashtags.join(' ')}`);

      return {
        analysis: {
          productName: pName,
          brand: parsed.brand || '',
          exactLabelText: parsed.exactLabelText || null,
          category: cat,
          packagingType: parsed.packagingType || 'chai/hộp',
          hashtags,
          keyVisualDetails: parsed.keyVisualDetails || 'Bao bì chuẩn',
          supermarketAisleDescription: parsed.supermarketAisleDescription || 'kệ hàng siêu thị hiện đại',
          neighborProducts: parsed.neighborProducts || 'các sản phẩm cùng loại',
        },
        uploadedFiles,
      };
    }
  } catch (err) {
    console.warn(`[Template 6] ⚠️ Analysis failed: ${err.message}. Using intelligent defaults.`);
  }

  const fallbackHashtags = normalizeTemplate6Hashtags({}, elements);
  return {
    analysis: {
      productName: 'Sản phẩm siêu thị',
      brand: '',
      category: 'general',
      packagingType: 'chai/hộp chuẩn',
      hashtags: fallbackHashtags,
      supermarketAisleDescription: 'kệ hàng siêu thị hiện đại ngăn nắp',
      neighborProducts: 'các mặt hàng tiêu dùng cùng loại',
    },
    uploadedFiles,
  };
}

/**
 * Hàm chính thực thi toàn bộ luồng Template 6
 */
async function generateStoryboard(baseDir, filePayloads, options = {}) {
  if (!filePayloads || filePayloads.length === 0) {
    throw new Error('Template 6 requires at least one product reference image.');
  }

  const secure1Psid = process.env.GEMINI_SECURE_1PSID;
  const secure1Psidts = process.env.GEMINI_SECURE_1PSIDTS;
  const cookieFilePath = process.env.GEMINI_COOKIE_PATH
    ? path.resolve(baseDir, process.env.GEMINI_COOKIE_PATH)
    : path.join(baseDir, 'gemini.cookies.json');

  if (!secure1Psid && !cookieFilePath) {
    throw new Error('GEMINI_SECURE_1PSID or GEMINI_COOKIE_PATH is required for Template 6 storyboard generation');
  }

  const geminiClient = new GeminiApiClient({
    secure1Psid,
    secure1Psidts,
    cookieFilePath: fs.existsSync(cookieFilePath) ? cookieFilePath : undefined,
  });

  await geminiClient.init();

  let analysis = {};
  let elements = getRandomSupermarketElements();
  let storyboardBase64 = null;
  let masterPrompt = '';
  const panels = [];

  try {
    // ── Bước 1: Phân tích sản phẩm qua Gemini API ────────────────────────────
    console.log('[Template 6] 🔍 Step 1: Analyzing product image for supermarket merchandising...');
    const { analysis: analyzedData, uploadedFiles } = await analyzeProductTemplate6(geminiClient, filePayloads, elements);
    analysis = analyzedData;

    // ── Bước 2: Tạo Master Storyboard 2 Panel ─────────────────────────────────
    console.log(`[Template 6] 🎨 Step 2: Generating Master Storyboard (2 Panels, Store: ${elements.store}) via Gemini API...`);
    masterPrompt = buildTemplate6StoryboardPrompt(analysis, elements);

    // Sử dụng template reference tương ứng (ưu tiên JPG tối ưu dung lượng)
    const isRed = elements.store === 'red_supermarket' || elements.store === 'winmart';
    const baseAssetJpg = path.join(baseDir, 'assets', isRed ? 'template6_2.jpg' : 'template6_1.jpg');
    const baseAssetPng = path.join(baseDir, 'assets', isRed ? 'template6_2.png' : 'template6_1.png');
    const refAssetPath = fs.existsSync(baseAssetJpg) ? baseAssetJpg : baseAssetPng;
    const combinedFiles = [...uploadedFiles];
    if (fs.existsSync(refAssetPath)) {
      try {
        const refBuf = fs.readFileSync(refAssetPath);
        const isJpg = refAssetPath.endsWith('.jpg');
        const refMime = isJpg ? 'image/jpeg' : 'image/png';
        const refName = isRed ? (isJpg ? 'template6_2_ref.jpg' : 'template6_2_ref.png') : (isJpg ? 'template6_1_ref.jpg' : 'template6_1_ref.png');
        const refUrl = await geminiClient.uploadFile(refBuf, refName, refMime);
        combinedFiles.push({ url: refUrl, filename: refName, mimeType: refMime });
      } catch (e) {
        console.warn(`[Template 6] Could not upload reference asset: ${e.message}`);
      }
    }

    let storyboardBuf = null;
    let lastMasterErr = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const masterRes = await geminiClient.generateContent({
          prompt: masterPrompt,
          fileData: combinedFiles,
          temporary: true,
          expectImages: true,
        });

        if (!masterRes.images || masterRes.images.length === 0) {
          throw new Error('Gemini API did not return any Master Storyboard image for Template 6');
        }

        storyboardBuf = await geminiClient.downloadImage(masterRes.images[0].url);
        storyboardBase64 = storyboardBuf.toString('base64');
        console.log('[Template 6] ✅ Master Storyboard created successfully!');
        break;
      } catch (err) {
        lastMasterErr = err;
        console.warn(`[Template 6] Master Storyboard Attempt ${attempt}/3 failed: ${err.message}. Retrying in 4s...`);
        if (attempt === 3) throw err;
        await new Promise(r => setTimeout(r, 4000));
      }
    }

    if (!storyboardBuf) {
      throw new Error(`Failed to generate Master Storyboard: ${lastMasterErr?.message || 'Unknown error'}`);
    }

    // ── Bước 3: Tách chính xác 2 Panel 9:16 trực tiếp từ Master Storyboard ──
    console.log('[Template 6] ✂️  Step 3: Slicing 2 exact 9:16 panels directly from Master Storyboard...');
    const videoPrompts = getTemplate6VideoPrompts(analysis, options);
    const [p1Buf, p2Buf] = await sliceStoryboardIntoPanels(storyboardBuf);

    panels.push({
      index: 1,
      panelIndex: 1,
      imagePath: null, // will be populated in archive
      imageBase64: p1Buf.toString('base64'),
      mimeType: 'image/png',
      prompt: videoPrompts[0],
    });

    panels.push({
      index: 2,
      panelIndex: 2,
      imagePath: null, // will be populated in archive
      imageBase64: p2Buf.toString('base64'),
      mimeType: 'image/png',
      prompt: videoPrompts[1],
    });

    console.log('[Template 6] ✅ 2 Panels sliced with 100% pixel-perfect consistency from Master Storyboard!');
  } finally {
    try { await geminiClient.close(); } catch (_) {}
  }

  // ── Bước 4: Lưu trữ archive ────────────────────────────────────────────────
  const archive = archiveTemplate6Review(baseDir, filePayloads, masterPrompt, storyboardBase64, panels, analysis, elements, options);

  // ── Bước 5: Sinh 2 Veo 3 Videos (8 giây mỗi video) ─────────────────────────
  let videos = [];
  if (options.generateVideos !== false) {
    console.log('[Template 6] 🎬 Step 5: Generating 2 Veo 3 videos (8s each, Silent & No Text)...');
    const videoPrompts = getTemplate6VideoPrompts(analysis, options);

    const videoJobPanels = panels.map((p, idx) => ({
      index: p.index,
      panelIndex: p.index,
      imagePath: p.imagePath,
      buffer: Buffer.from(p.imageBase64, 'base64'),
      prompt: videoPrompts[idx] || `Tạo video review siêu thị cảnh ${p.index} 8 giây`,
      videoModelKey: '8s',
    }));

    videos = await generateVideosFromPanelsDirect(baseDir, videoJobPanels, {
      aspectRatio: '9:16',
      videoModelKey: 'veo_3_1_i2v_lite_low_priority',
      includeVideoBase64: !!options.includeVideoBase64,
    });

    console.log(`[Template 6] 🏁 Video generation completed: ${videos.filter(v => !v.error).length}/${videos.length} videos`);

    if (archive && archive.root) {
      const videosDir = path.join(archive.root, 'videos');
      ensureDir(videosDir);
      for (const v of videos) {
        if (v.videoPath && fs.existsSync(v.videoPath)) {
          const target = path.join(videosDir, `panel-${v.panelIndex}.mp4`);
          try { fs.copyFileSync(v.videoPath, target); v.videoPath = target; } catch (_) {}
        }
      }
    }
  }

  return {
    storyboardBase64,
    storyboard: { base64: storyboardBase64, mimeType: 'image/png' },
    panels,
    videos,
    analysis,
    elements,
    archive,
    reviewArchive: archive,
  };
}

module.exports = {
  buildTemplate6AnalysisPrompt,
  buildTemplate6StoryboardPrompt,
  buildTemplate6PanelPrompt,
  getTemplate6VideoPrompts,
  generateStoryboard,
};
