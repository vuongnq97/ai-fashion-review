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
const path = require('path');
const { generateVideosFromPanelsDirect } = require('./gemini-webapi-storyboard');
const { GeminiApiClient } = require('./gemini-client/gemini-api');

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
  const stores = ['bachhoaxanh', 'winmart'];
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

/**
 * Xây dựng Analysis Prompt cho sản phẩm siêu thị
 */
function buildTemplate6AnalysisPrompt() {
  return `TEXT-ONLY TASK. Do not generate images. Do not call image generation.
You are a supermarket retail product analyst and Veo 3 director.
Analyze the uploaded product image(s) and determine how this product is merchandised in a Vietnamese modern supermarket (such as Bach Hoa Xanh or WinMart).

Return ONLY valid JSON with this schema:
{
  "productName": "Tên sản phẩm tiếng Việt đầy đủ và chính xác",
  "category": "beverages|snacks|dairy|condiments|instant_food|personal_care|household|baby|cosmetics|other",
  "packagingType": "bottle|box|can|pouch|jar|packet|spray|tub|carton",
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

  return `Generate a single cohesive 2-panel storyboard photograph layout (side-by-side 2 vertical 9:16 panels, overall approx 18:16 ratio), depicting a 100% photorealistic first-person POV shopping experience in a Vietnamese modern supermarket (${storeName}).

STRICT STYLE & REALISM:
- Shot on iPhone 15 Pro 4K camera, natural handheld eye/chest level POV.
- 100% live-action realism: natural supermarket lighting, soft ambient daylight, authentic specular reflections on the tiled floor.
- Slim female reviewer hand and forearm with natural skin texture, visible pores, and knuckle creases.
- Reviewer outfit: ${elements.sleeve}, ${elements.accessory}.
- The product featured in both panels is the exact input product: ${prodName} (${analysis.packagingType || 'bao bì chuẩn'}), maintaining 100% brand label, colors, and shape consistency.
- Background setting: ${shelfStyle}. The shelves are stocked with ${aisleDesc} and ${neighbor}.

PANEL 1 (Left Panel - Vertical 9:16 ratio):
- Camera & View: First-person POV standing in the supermarket aisle at chest level looking forward.
- Action & Subject: The female hand (${elements.accessory}, ${elements.sleeve}) holds the ${prodName} upright in the foreground at mid-chest height, observing it closely.
- Floor & Background: Clean beige tiled floor extending down the aisle between the retail shelves.
- CRITICAL RESTRICTION FOR PANEL 1: STRICTLY NO SHOPPING BASKET in Panel 1 (clean floor, no basket, no clutter).

PANEL 2 (Right Panel - Vertical 9:16 ratio):
- Camera & View: The exact same first-person POV looking downward at an angle from chest height towards the floor.
- Basket on Floor: ${basketDesc}. The basket rests stationary on the floor in front of the reviewer's standing position.
- Action & Subject: The same female hand holding the ${prodName} is lowered down over the shopping basket, ready to place it inside amongst the groceries.
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
 * Xây dựng 2 Veo 3 Video Prompts (8 giây mỗi cảnh) bám sát 100% template6_1.md và template6_2.md
 */
function getTemplate6VideoPrompts(analysisData = {}, options = {}) {
  const prodName = analysisData.productName || 'sản phẩm';
  const customInstruction = options.customInstruction || '';

  const realismCues = 'Phong cách 100% live-action photorealistic, giống footage iPhone 15 Pro thật. Da tay tự nhiên, không làm mịn da, không hiệu ứng làm đẹp. Kệ hàng siêu thị ở background giữ nguyên, không thay đổi bố cục. Ánh sáng tự nhiên từ cửa sổ và đèn trần, bóng đổ mềm, sàn gạch thật. Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền, không chữ, không subtitle, không graphic, không CGI, không 3D.';

  // Cảnh 1 (8s - template6_1.md)
  const scene1 = `Tạo video review ${prodName} góc nhìn thứ nhất (POV) dài đúng 8 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. ` +
    `Cảnh quay POV chân thực từ góc nhìn người mua hàng, camera đặt cố định ở vị trí ngang ngực, mô phỏng camera iPhone 15 Pro. ` +
    `Ngay từ frame đầu tiên, sản phẩm ${prodName} đã được cầm sẵn trên tay nữ. Không có hành động lấy sản phẩm từ kệ. Không đưa tay về phía kệ. Tuyệt đối không xuất hiện giỏ mua hàng. ` +
    `Chỉ nhìn thấy bàn tay và cẳng tay nữ, không nhìn thấy khuôn mặt hay phần thân trên. ` +
    `Bàn tay nữ giữ sản phẩm ở phía trước camera, khoảng ngang ngực. Người mua từ từ xoay nhẹ cổ tay sang trái và sang phải, đồng thời hơi nghiêng sản phẩm về các hướng khác nhau, giống như đang quan sát kỹ bao bì, kiểm tra sản phẩm trước khi quyết định mua. ` +
    `Chuyển động rất tự nhiên và chậm: 0s-2s giữ sản phẩm ổn định, 2s-4s xoay cổ tay nhẹ sang trái, 4s-6s xoay sang phải và hơi nghiêng sản phẩm, 6s-8s giữ lại ở vị trí dễ nhìn. ` +
    `Camera hoàn toàn đứng yên, không pan, không tilt, không zoom, không tiến gần sản phẩm, không lùi ra xa. ` +
    (customInstruction ? `YÊU CẦU ƯU TIÊN: ${customInstruction}. ` : '') +
    `${realismCues}`;

  // Cảnh 2 (8s - template6_2.md)
  const scene2 = `Tạo video review ${prodName} góc nhìn thứ nhất (POV) dài đúng 8 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. ` +
    `Video POV chân thực, camera cố định ở vị trí ngang ngực, cùng góc quay và cùng người nữ như Cảnh 1. ` +
    `Ngay từ đầu cảnh, bàn tay nữ đang cầm sẵn chính sản phẩm ${prodName} vừa được quan sát ở Cảnh 1. ` +
    `Chiếc giỏ mua hàng đã nằm cố định trên mặt đất ở phía dưới khung hình. ` +
    `Bàn tay nữ từ từ đưa sản phẩm xuống phía dưới, hướng vào bên trong giỏ. ` +
    `Khi sản phẩm đến gần đáy giỏ, bàn tay nhẹ nhàng đặt sản phẩm xuống giữa những món hàng có sẵn trong giỏ. Sản phẩm phải tiếp xúc thật với các sản phẩm bên trong giỏ và nằm yên theo trọng lực. ` +
    `Sau khi đặt sản phẩm xuống, các ngón tay từ từ buông ra. Bàn tay rút nhẹ lên trên và ra khỏi khu vực giỏ. ` +
    `Trình tự hành động rõ ràng và mượt mà: 0s-2s cầm sản phẩm và bắt đầu hạ tay xuống, 2s-4s đưa sản phẩm vào trong giỏ và đặt xuống đáy giỏ, 4s-6s buông tay nhẹ nhàng, 6s-8s rút tay ra khỏi giỏ. ` +
    `Giỏ luôn nằm cố định dưới đất trong toàn bộ cảnh. Tuyệt đối không được nâng giỏ lên, không được cầm quai, không được kéo giỏ, không được để giỏ bay hoặc tự di chuyển. ` +
    `Camera không di chuyển, không zoom, không pan, không tilt. Chỉ có bàn tay và sản phẩm chuyển động. ` +
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
async function analyzeProductTemplate6(geminiClient, filePayloads) {
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
      console.log(`[Template 6] ✅ Product analyzed: "${pName}" (${cat})`);

      return {
        analysis: {
          productName: pName,
          category: cat,
          packagingType: parsed.packagingType || 'chai/hộp',
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

  return {
    analysis: {
      productName: 'Sản phẩm siêu thị',
      category: 'general',
      packagingType: 'chai/hộp chuẩn',
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
    const { analysis: analyzedData, uploadedFiles } = await analyzeProductTemplate6(geminiClient, filePayloads);
    analysis = analyzedData;

    // ── Bước 2: Tạo Master Storyboard 2 Panel ─────────────────────────────────
    console.log(`[Template 6] 🎨 Step 2: Generating Master Storyboard (2 Panels, Store: ${elements.store}) via Gemini API...`);
    masterPrompt = buildTemplate6StoryboardPrompt(analysis, elements);

    // Sử dụng template reference tương ứng
    const refAssetPath = path.join(baseDir, 'assets', elements.store === 'winmart' ? 'template6_2.png' : 'template6_1.png');
    const combinedFiles = [...uploadedFiles];
    if (fs.existsSync(refAssetPath)) {
      try {
        const refBuf = fs.readFileSync(refAssetPath);
        const refName = elements.store === 'winmart' ? 'template6_2_ref.png' : 'template6_1_ref.png';
        const refUrl = await geminiClient.uploadFile(refBuf, refName, 'image/png');
        combinedFiles.push({ url: refUrl, filename: refName, mimeType: 'image/png' });
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

    // Upload storyboard image for panel reference
    const sbUploadUrl = await geminiClient.uploadFile(storyboardBuf, 'master_storyboard.png', 'image/png');
    const panelCombinedFiles = [
      { url: sbUploadUrl, filename: 'master_storyboard.png', mimeType: 'image/png' },
      ...uploadedFiles
    ];

    // ── Bước 3: Sinh 2 Panel 9:16 riêng biệt ─────────────────────────────────
    const videoPrompts = getTemplate6VideoPrompts(analysis, options);
    for (let i = 1; i <= 2; i++) {
      console.log(`[Template 6] Step 3: Generating Panel ${i}/2 (9:16) via Gemini API...`);
      const panelPrompt = buildTemplate6PanelPrompt(i, analysis, elements);

      let panelBuf = null;
      let lastPanelErr = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const panelRes = await geminiClient.generateContent({
            prompt: panelPrompt,
            fileData: panelCombinedFiles,
            temporary: true,
            expectImages: true,
          });

          if (!panelRes.images || panelRes.images.length === 0) {
            throw new Error(`Gemini API did not return image for Panel ${i}`);
          }

          panelBuf = await geminiClient.downloadImage(panelRes.images[0].url);
          console.log(`[Template 6] ✅ Panel ${i}/2 generated successfully!`);
          break;
        } catch (err) {
          lastPanelErr = err;
          console.warn(`[Template 6] Panel ${i}/2 Attempt ${attempt}/3 failed: ${err.message}. Retrying in 4s...`);
          if (attempt === 3) throw err;
          await new Promise(r => setTimeout(r, 4000));
        }
      }

      if (!panelBuf) {
        throw new Error(`Failed to generate Panel ${i}: ${lastPanelErr?.message || 'Unknown error'}`);
      }

      panels.push({
        index: i,
        imagePath: null, // will be populated in archive
        imageBase64: panelBuf.toString('base64'),
        mimeType: 'image/png',
        prompt: videoPrompts[i - 1],
      });
    }
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
  };
}

module.exports = {
  buildTemplate6AnalysisPrompt,
  buildTemplate6StoryboardPrompt,
  buildTemplate6PanelPrompt,
  getTemplate6VideoPrompts,
  generateStoryboard,
};
