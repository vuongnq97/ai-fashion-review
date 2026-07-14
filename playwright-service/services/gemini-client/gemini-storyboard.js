'use strict';

/**
 * gemini-storyboard.js
 *
 * Node.js equivalent of the Python gemini-webapi-bridge/gemini_storyboard.py.
 * Accepts the same JSON input/output format so the calling code in
 * gemini-webapi-storyboard.js can be swapped with minimal changes.
 *
 * Flow:
 *   1. Upload product images
 *   2. generateContent(analysisPrompt) → parse JSON → analysis + veo3Prompts
 *   3. generateContent(storyboardPrompt, files) → download storyboard image
 *   4. For each panel: generateContent(panelPrompt, storyboard files) → download panel image
 *   5. Return result JSON matching Python bridge output format
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GeminiApiClient } = require('./gemini-api');

const PANEL_MAX_RETRIES = parseInt(process.env.GEMINI_WEBAPI_PANEL_MAX_RETRIES || '3', 10);
const PANEL_RETRY_DELAY_MS = parseFloat(process.env.GEMINI_WEBAPI_PANEL_RETRY_DELAY || '5') * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[GeminiJS] ${msg}\n`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class JsonParseResponseError extends Error {
  constructor(text, cause) {
    const cleaned = stripCodeFence(text);
    super(
      'Could not parse JSON from response. ' +
      `First 200 chars: ${cleaned.slice(0, 200)} ` +
      `Last 200 chars: ${cleaned.slice(-200)}`
    );
    this.name = 'JsonParseResponseError';
    this.responseText = cleaned;
    this.cause = cause;
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
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch (sliceError) {
        throw new JsonParseResponseError(cleaned, sliceError);
      }
    }
    throw new JsonParseResponseError(cleaned, error);
  }
}

function normalizePrompt(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeTemplate1VideoPrompt(value) {
  let prompt = normalizePrompt(value);
  prompt = prompt
    .replace(/Script\s+nh[aâ]n\s+v[aậ]t\s*:[^.。]*(?:[.。]|$)/giu, 'Không có voice-over, không lời thoại, không phụ đề. ')
    .replace(/gi[oọ]ng\s+nh[aâ]n\s+v[aậ]t[^.。]*(?:[.。]|$)/giu, '');
  if (!prompt.includes('Không có voice-over')) {
    prompt = `${prompt} Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark.`;
  }
  return normalizePrompt(prompt);
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

function normalizeProductMetadata(analysis, category) {
  const source = (analysis && typeof analysis === 'object') ? analysis : {};
  const productName = normalizePrompt(source.productName || source.product_name || source.name || category || 'San pham thoi trang');
  const providedTags = Array.isArray(source.hashtags) ? source.hashtags : [];
  const fallbackTags = [
    productName,
    category || 'Fashion product',
    source.type,
    'thoi trang',
    'review san pham',
    'fashion review',
  ];

  const hashtags = [];
  for (const value of [...providedTags, ...fallbackTags]) {
    const normalized = normalizeHashtag(value) || slugToHashtag(value);
    if (normalized && !hashtags.some(tag => tag.toLowerCase() === normalized.toLowerCase())) {
      hashtags.push(normalized);
    }
    if (hashtags.length === 5) break;
  }

  while (hashtags.length < 5) {
    hashtags.push(`#sanpham${hashtags.length + 1}`);
  }

  return { productName, hashtags };
}

function getMimeExt(mimeType) {
  const value = String(mimeType || '').toLowerCase();
  if (value.includes('webp')) return '.webp';
  if (value.includes('gif')) return '.gif';
  return /jpe?g/i.test(value) ? '.jpg' : '.png';
}

function getTemplateName(options = {}) {
  return String(options.template || options.storyboardTemplate || options.promptTemplate || '').trim().toLowerCase();
}

function isTemplate1(options = {}) {
  return getTemplateName(options) === 'template1';
}

function isTemplate2(options = {}) {
  return getTemplateName(options) === 'template2';
}

function isTemplate3(options = {}) {
  return getTemplateName(options) === 'template3';
}

function resolvePanelCount(options = {}) {
  if (isTemplate1(options)) return 2;
  if (isTemplate2(options)) return 8;
  if (isTemplate3(options)) return 2;
  return parseInt(options.panelCount || 3, 10);
}

// ─── Smartphone Realism Directives (template1 only) ─────────────────────────

const SMARTPHONE_REALISM_STYLE = `
Photography style: authentic customer review photo casually taken at home with a normal smartphone camera.
This is NOT a studio photo, NOT a commercial advertisement, NOT a 3D render, NOT an AI-generated artwork.
`.trim();

const SMARTPHONE_CAMERA_TRAITS = `
Smartphone camera characteristics:
- Main 1x lens, approximately 24–28 mm equivalent focal length.
- Auto mode, no Portrait Mode bokeh.
- Slight white-balance drift, minor brightness inconsistency, and occasional soft-focus edges.
- Faint sensor noise in shadow areas, light sharpening artifacts, subtle barrel distortion at edges.
- No fake bokeh, no artificial background blur.
- The two panels may have slightly different exposure as if the phone metered each shot independently.
`.trim();

const SMARTPHONE_LIGHTING = `
Lighting rules:
- Natural window light: brighter near the window, gradually darker toward the room interior.
- Allow slight overexposure near the window and slightly dark shadow areas.
- Realistic shadow contact under sandals, feet, and hands.
- No warm golden glow, no pastel color grading, no studio rim lights.
`.trim();

const SMARTPHONE_MATERIAL_REALISM = `
Product material realism:
- Describe the product as EVA foam or soft molded rubber.
- Surface must be slightly matte with fine texture grain, mold seam lines, faint fingerprint marks, or very light scuffs.
- FORBIDDEN: glossy porcelain surface, smooth 3D-render finish, shiny artificial plastic.
`.trim();

const SMARTPHONE_BODY_REALISM = `
Human body realism:
- Hands must show visible pores, knuckle creases, light veins, and natural skin tone variation.
- Feet must show ankle bone structure, natural toe positioning; two feet should NOT stand in perfect parallel symmetry.
- Socks (if present) must have slight wrinkles, compression marks under straps, and off-white/ivory tone instead of pure white.
- Denim/fabric garments must show weave texture, stitching, natural creases, and slight wear.
- FORBIDDEN: plastic/wax skin, doll-like hands, unnaturally long legs, fashion-model proportions.
`.trim();

const SMARTPHONE_IMPERFECTION = `
Anti-perfection rules:
- Frame composition slightly off-center, not perfectly aligned.
- Living room background has everyday details and imperfect surfaces.
- Wood floor shows joint gaps, uneven grain, minor marks.
- Curtains are not perfectly symmetrical.
`.trim();

const SMARTPHONE_NEGATIVE_PROMPT = `
Negative prompt (must avoid): CGI look, over-processed HDR, waxy skin, fake bokeh, studio lighting setup, pastel Instagram filter, cinematic color grading, perfect bilateral symmetry, 3D render aesthetic.
`.trim();

const TEMPLATE1_PANEL2_CHOREOGRAPHY = `
Hành động: Các chuyển động phải dứt khoát, rõ biên độ, liên tục theo nhịp nhanh, có chủ đích; không chậm rãi, không lắc nhẹ mơ hồ, không chuyển động mềm kiểu slow motion.
0s-2s: Giữ nguyên bố cục POV top-down. Cả hai bàn chân đồng thời xoay mũi chân nhanh ra ngoài, lập tức thu vào trong, sau đó bật trở lại tư thế song song. Mỗi động tác phải có điểm kết thúc rõ ràng, thể hiện sự hào hứng khi khoe đôi mới. Vị trí đứng cơ bản không thay đổi.
2s-4s: Hai chân luân phiên nhấc gót nhanh và rõ biên độ, mũi chân vẫn chạm sàn; chân trái thực hiện trước, tiếp nối ngay bằng chân phải. Sau đó cả hai chân đồng thời nhón gót một nhịp ngắn rồi hạ xuống dứt khoát để khoe form sản phẩm, độ dày đế và charm/chi tiết bắt sáng.
4s-6s: Cả hai bàn chân nghiêng nhanh ra ngoài rồi bật trở lại, tiếp tục xoay chéo hai mũi chân sang hai hướng khác nhau để khoe mặt bên, quai/dây, charm, đế và silhouette. Chuyển động sắc nét, liên tục, có điểm dừng ngắn giữa từng pose, không rung chân ngẫu nhiên.
6s-8s: Một chân xoay chéo khoảng 20-30 độ, chân còn lại giữ thẳng; cả hai chân nhón nhẹ một nhịp cuối rồi hạ xuống ngay, sau đó snap vào một pose kết thúc tự tin và giữ yên khoảng 1 giây. Camera thực hiện một cú push-in ngắn, nhanh nhưng mượt từ trên xuống để nhấn vào dáng giày/dép, charm/chi tiết và outfit.
Toàn bộ chuỗi động tác phải nhanh, gọn, tự tin và liên tục, giống hành động khoe một đôi giày/dép mới. Giữ sản phẩm luôn rõ nét, đúng tỉ lệ và không biến dạng. Tuyệt đối không walking, không stepping forward, không đổi vị trí trong không gian, không nhảy, không đá chân mạnh, không low-angle, không tracking shot, không đổi bối cảnh, không đổi ánh sáng, không slow motion.
`.trim();

const TEMPLATE3_REALISM_FULL = `
Photography style: authentic faceless footwear shop review captured with a normal smartphone camera, not a studio advertisement, not a 3D render, not AI-looking product art.

Smartphone camera characteristics:
- Main 1x lens, approximately 24-28 mm equivalent focal length, vertical 9:16 frame.
- Auto mode, tiny hand shake, slight white-balance drift from mixed shop lighting, minor edge softness, faint sensor noise in shadows.
- No fake bokeh, no artificial background blur, no cinematic color grading, no over-processed HDR.

Footwear shop setting:
- Real shoe/sandal shop interior with shelves, shoe boxes, display stands, tiled or laminate floor, counter/table edge, and everyday retail details.
- Background must support the product and remain secondary; do not turn it into a studio, luxury showroom render, outdoor scene, bedroom, living room, or home setting.
- Lighting can be mixed shop ceiling light plus natural storefront/window light; shadows and reflections must remain physically plausible.

Material and product realism:
- Preserve the exact product material visible in the references, such as canvas, jacquard fabric, leather, suede, rubber, EVA, molded foam, stitching, embroidery, logos, charms, buckles, laces, straps, outsole texture, and printed text.
- Surface should have natural texture, weave, grain, seams, small scuffs, dust specks, fingerprints, and real contact shadows where appropriate.
- FORBIDDEN: glossy porcelain, waxy plastic, melted rubber, soft deformed product, duplicated mismatched pair, invented logos, missing straps, changed sole, changed proportions.

Human realism:
- Hands must show visible pores, knuckle creases, light veins, natural skin tone variation, correct anatomy, and no extra fingers.
- Feet/legs in Panel 2 must look natural, not doll-like; toes/ankles are not perfectly symmetrical.

Negative prompt: CGI look, plastic toy finish, waxy skin, fake bokeh, studio lighting setup, pastel Instagram filter, perfect bilateral symmetry, watermark, TikTok UI, captions, added text, floating product, warped sole, mismatched pair.
`.trim();

const TEMPLATE3_DISPLAY_STAND_RULES = `
Template3 display support rules:
- First check whether the uploaded product reference images clearly include a shoe box or branded box that belongs with the product.
- If a matching shoe box is visible in the product references, Panel 1 may place the stationary shoe on that box or on top of the same product box style.
- If no shoe box is visible in the product references, use the uploaded reference asset named "giadegiay-display-stand-reference.webp" only as a shoe display stand prop for the stationary shoe.
- The display stand reference is NOT the product. Never copy its shape, color, material, or details onto the footwear.
- The hand-held shoe must always be the uploaded product from Telegram; the stationary shoe must be the matching pair with identical product design, size, color, material, sole, strap/lace, logo/text, charm, pattern, stitching, and proportions.
`.trim();

const TEMPLATE3_SHOP_BACKGROUND_RULES = `
Template3 shoe shop background reference rules:
- Use the uploaded reference asset named "shopgiay-background-reference.png" as the primary visual reference for the footwear shop environment, shelf style, retail mood, floor/display logic, and lighting consistency for this channel.
- The shop reference is a background/context reference only. It is NOT the product, NOT a product box, and NOT a foreground prop.
- Both storyboard panels should feel like they were shot in the same shop from this reference: coherent shelves, shoe displays, floor/counter surfaces, retail density, and mixed shop lighting.
- The shop background must remain secondary and clean; do not let shelves, boxes, signs, people, or props cover or compete with the footwear product.
- Do not copy any watermark, logo, signage text, UI, price tag, or readable store text from the shop reference into the generated image.
`.trim();

const TEMPLATE3_PANEL1_HANDHELD_COMPOSITION = `
Template3 Panel 1 hand-held composition rules:
- One shoe/sandal is held in the foreground and must occupy the largest visual area in the frame, approximately 55-70% of the panel height.
- The matching other shoe/sandal stays in the background or below the held product, smaller but still fully visible with the complete form, toe/front, heel/back, side silhouette, and sole edge readable.
- The hand pose must match a real product review grip: the hand holds the product firmly at the outsole/sole edge and side body, with fingers supporting under or along the sole and the thumb stabilizing the side/upper edge.
- The hand must NOT pinch only the toe, hold only the heel, cover the laces/straps/logo/front design, flatten the product, or hide the top surface.
- The held product is tilted about 15-30 degrees, so the camera sees both the top/upper surface and one side/sole edge in the same frame.
- The top/upper, laces/straps, toe/front, side body, and a portion of the sole edge must be visible at once.
- Camera stays top-down product-review style. Do not switch to horizontal side view, low-angle, orbit, complex rotation, or face/body shot.
- Only the hand and wrist/forearm may appear when needed; no face, no full body.
- Any prop base such as a shoe box, table, chair surface, shelf surface, or display stand must remain clean, secondary, and not compete with the product.
`.trim();

const TEMPLATE3_PANEL2_SOCK_RULES = `
Template3 Panel 2 footwear/sock rules:
- If the product is a closed-toe shoe such as sneaker, trainer, loafer, oxford, derby, boot, or other enclosed footwear, the wearer MUST wear appropriate clean socks for a realistic shop try-on. Choose low-cut, no-show, ankle, or crew socks based on the shoe style and outfit.
- Socks should look natural with fabric texture, slight wrinkles, and realistic compression at the ankle or shoe opening. Avoid pure plastic-white socks unless the outfit truly calls for it.
- If the product is open footwear such as sandal, slide, slipper, flip-flop, open-toe mule, or casual dép, the wearer should normally be barefoot with natural feet and toes. Do not add socks unless the product reference or styling clearly supports socks.
- The socks or bare feet must support the product and must not hide important straps, upper details, logo/text, or silhouette.
`.trim();

const TEMPLATE3_PANEL1_CHOREOGRAPHY = `
Hành động:
0.0s-0.7s: Bàn tay đưa nhanh một chiếc giày/dép từ mép khung hình vào trung tâm, nâng lên phía trên chiếc còn lại đang đặt cố định. Mặt trước hoặc mặt trên hướng rõ vào camera và được giữ ngắn trong một nhịp.
0.7s-1.7s: Xoay cổ tay dứt khoát từ mặt trên sang góc ba phần tư rồi sang mặt bên để khoe thân sản phẩm, quai/dây, độ dày đế và silhouette.
1.7s-3.1s: Lật sản phẩm để toàn bộ mặt đế hướng thẳng vào camera. Đưa mặt đế gần máy hơn một chút và giữ ổn định khoảng 0.6-0.8 giây để nhìn rõ rãnh đế, logo/chữ và kết cấu.
3.1s-4.2s: Xoay nhanh từ mặt đế qua phần gót rồi sang mặt bên đối diện, giới thiệu độ cao gót, mép đế và đường cong sản phẩm bằng một chuyển động liên tục có kiểm soát.
4.2s-5.8s: Đưa sản phẩm nhanh về gần ống kính, đồng thời xoay về góc ba phần tư mặt trước. Kết thúc bằng một cận cảnh rõ nét phần thiết kế nổi bật như quai/dây, charm, họa tiết, logo hoặc phần mũi.
5.8s-7.0s: Kéo sản phẩm lùi ra xa, xoay về mặt trên và đưa về bên cạnh chiếc còn lại. Cả hai chiếc xuất hiện đầy đủ, đúng kích thước và không chồng méo lên nhau.
7.0s-8.0s: Nghiêng chiếc đang cầm khoảng 20-30 độ để vừa thấy mặt trên vừa thấy cạnh đế. Giữ pose kết thúc chắc chắn trong 1 giây.
Nhịp chuyển động: Nhanh, dứt khoát, có chủ đích. Mỗi lần xoay phải kết thúc rõ ràng trước khi chuyển sang góc tiếp theo. Không xoay chậm đều, không rung lắc ngẫu nhiên, không làm sản phẩm mềm, méo hoặc biến hình.
`.trim();

// ─── Template2: 8-scene footwear review structure ────────────────────────────

const TEMPLATE2_SCENES = [
  {
    id: 1,
    goal: 'Side pose hero shot',
    visualDescription: 'Model standing and posing, bending one leg to show the product from the side angle — full lower body visible, fashionable outfit, natural pose',
    cameraAction: 'Medium shot from slightly low angle, model shifts weight to showcase silhouette',
    productFocus: 'Side profile, overall shape, heel height, strap/lace design',
    choreography: '0s-2s: Model stands with one leg slightly bent, rotating ankle to show side view. 2s-4s: Model shifts weight and adjusts pose, lifting bent leg slightly higher then settling into a confident stance.',
  },
  {
    id: 2,
    goal: 'Handheld pair showcase',
    visualDescription: 'Two hands holding the pair of footwear close to camera, tilting gently to show design details — well-lit, product fills most of the frame',
    cameraAction: 'Close-up front angle, hands rotate product slowly to show design',
    productFocus: 'Upper design, texture, color, brand details, stitching, material',
    choreography: '0s-2s: Hands hold product steady close to camera, slight tilt to one side. 2s-4s: Hands rotate product smoothly to the other side, showcasing different angles and catching light on texture details.',
  },
  {
    id: 3,
    goal: 'Front toe tap and spin',
    visualDescription: 'Front view of lower body, both feet doing rhythmic toe taps and rotating toe tips continuously — energetic, playful movement showing product in motion',
    cameraAction: 'Low angle front view, feet tapping and spinning on the spot',
    productFocus: 'Toe box, upper, overall form during movement, flexibility',
    choreography: '0s-2s: Feet alternate quick toe taps on the floor, showing product bounce and flex. 2s-4s: Both feet rotate toe tips outward then inward in sync, then settle back to neutral position.',
  },
  {
    id: 4,
    goal: 'Seated leg swing',
    visualDescription: 'Model sitting on a chair or stool, legs swinging and ankles rotating — relaxed, casual feel, showing product from a different perspective',
    cameraAction: 'Medium shot at sitting level, feet swing naturally and rotate',
    productFocus: 'On-foot comfort, ankle fit, product shape from seated angle, sole glimpse',
    choreography: '0s-2s: Seated model swings legs forward gently and rotates one ankle in a circle. 2s-4s: Both feet swing in opposite directions, then ankles rotate together to show product from multiple angles.',
  },
  {
    id: 5,
    goal: 'Hands-on detail adjust',
    visualDescription: 'Model bending down, hands adjusting the collar, strap, lace, buckle, or heel area of the product — close interaction showing craftsmanship',
    cameraAction: 'Close-up from above, hands interact with product details',
    productFocus: 'Collar/tongue, lace/strap mechanism, buckle, heel detail, inner lining quality',
    choreography: '0s-2s: Hand reaches down and adjusts the strap or lace, fingers tracing along the edge. 2s-4s: Fingers press and smooth the collar or heel area, then gently tug to show secure fit.',
  },
  {
    id: 6,
    goal: 'Standing cross-leg pose swap',
    visualDescription: 'Standing at a slight angle, model crossing legs, lifting heels, and switching between poses continuously — dynamic, fashion-forward movement',
    cameraAction: 'Side angle medium shot, model switches between cross-leg poses',
    productFocus: 'Side and back view, heel height, silhouette from different angles, outfit pairing',
    choreography: '0s-2s: Model crosses one leg in front, lifts heel of back foot to show sole. 2s-4s: Quick pose switch — uncross and cross the other leg, lift opposite heel, settle into final pose.',
  },
  {
    id: 7,
    goal: 'Single piece rotation',
    visualDescription: 'Two hands holding one piece of footwear, rotating it from side view to sole view — smooth controlled rotation showing all surfaces',
    cameraAction: 'Close-up, hands smoothly rotate product 180 degrees from side to sole',
    productFocus: 'Side construction, sole thickness, tread pattern, material layers, brand marking on sole',
    choreography: '0s-2s: Hands hold one shoe at side angle, slowly begin rotating toward the sole. 2s-4s: Complete rotation to show full sole view, pause briefly to display tread pattern and sole details.',
  },
  {
    id: 8,
    goal: 'Sole close-up texture',
    visualDescription: 'Extreme close-up of the sole, fingers stroking and pressing into the anti-slip grooves and texture — tactile, detail-oriented final shot',
    cameraAction: 'Macro close-up, fingers press and trace the sole grooves',
    productFocus: 'Sole tread pattern, rubber quality, anti-slip grooves, sole branding, flexibility',
    choreography: '0s-2s: Fingers press into the sole grooves to show depth and flexibility. 2s-4s: Fingers trace along the tread pattern, pressing to demonstrate grip quality, final hold on a detail.',
  },
];

const SMARTPHONE_REALISM_FULL = [
  SMARTPHONE_REALISM_STYLE,
  SMARTPHONE_CAMERA_TRAITS,
  SMARTPHONE_LIGHTING,
  SMARTPHONE_MATERIAL_REALISM,
  SMARTPHONE_BODY_REALISM,
  SMARTPHONE_IMPERFECTION,
  SMARTPHONE_NEGATIVE_PROMPT,
].join('\n\n');

// ─── Prompt builders (mirrors gemini_storyboard.py) ──────────────────────────

function buildAnalysisPrompt(options = {}) {
  const panelCount = resolvePanelCount(options);
  const sceneRatio = options.sceneRatio || options.aspectRatio || '9:16';
  const category = options.category || 'Fashion product';
  const vietnameseModel = options.useVietnameseModel !== false;
  const styleFast = options.styleCuonHut !== false;

  if (isTemplate2(options)) {
    return `TEXT-ONLY TASK. Do not generate images. Do not call image generation. Do not create a visual storyboard asset.
You are a senior footwear product analyst, storyboard director, and Veo 3 prompt writer.
Analyze the uploaded footwear product reference images and create a reusable review storyboard as JSON text only.

IMPORTANT — VISUAL REALISM DIRECTION:
${SMARTPHONE_REALISM_FULL}

Requirements:
- Template: template2 footwear review.
- Category: ${category}
- Panel count: exactly 8.
- Scene ratio for each panel: ${sceneRatio}.
- Use a young Vietnamese model when a human model is needed. Model's face can be visible in the scenes (not strictly faceless).
- Use the uploaded product analysis/reference images as the source of truth for product type, color, material, sole, straps/laces, logo/text, silhouette, and styling.
- Randomly choose ONE coherent real-world HOME setting (e.g. living room, bedroom, balcony, front porch) and ONE time of day for the whole storyboard. The setting must feel like a real home, not a showroom or studio.
- Randomly choose ONE outfit styling direction for the model. The outfit must fit the product, gender/styling inference, selected location, time of day, weather/season cues, and color palette.
- Both panels must share the exact same setting, time of day, weather/season cues, surface, background logic, color palette, and lighting plan.
- Lighting must follow smartphone realism rules: natural window light with gradient falloff, no studio lighting.
- The storyboard must feature a young Vietnamese model showing the footwear using exactly 8 specific scenes in sequence.
- No voice-over, no dialogue, no subtitles, no captions, no UI, no price, no rating, no watermark.
- Product identity must remain consistent across all 8 panels.
- Each veo3 prompt must be one line, with no newline characters.
- Each veo3 prompt must include VISUAL, Tone & Mood.
- Each veo3 prompt must explicitly say: "Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark."
- Each veo3 prompt must include smartphone realism cues: "ảnh chụp bằng điện thoại, ánh sáng cửa sổ tự nhiên, bề mặt sản phẩm lì có vân khuôn, không bokeh giả, không ánh sáng studio."
- Each veo3 prompt MUST describe the exact 4-second action choreography specified for that panel.

JSON schema:
{
  "analysis": {
    "productName": "Vietnamese product name inferred from the images",
    "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
    "type": "footwear type such as sneaker, sandal, mule, loafer, boot",
    "materials": "describe visible material: EVA foam, soft molded rubber, matte finish, mold seam lines, texture grain — not glossy or porcelain",
    "highlights": ["string"],
    "styling": "who/where this footwear fits",
    "uncertainties": "visible limits or details that cannot be confirmed",
    "gender": "male|female|unisex"
  },
  "sceneContext": {
    "location": "one random shared HOME location for all panels (living room, bedroom, balcony, etc.)",
    "timeOfDay": "random shared time of day",
    "lighting": "natural window light description: gradient falloff, slight overexposure near window, no studio lights",
    "mood": "casual, authentic, everyday review",
    "cameraCharacteristics": "smartphone 1x lens ~24-28mm, Auto mode, slight white-balance drift, faint noise in shadows, no fake bokeh",
    "continuityRules": "how all panels keep the same setting, lighting, and smartphone camera feel"
  },
  "outfitPlan": {
    "styleDirection": "random outfit style that fits the product and setting",
    "visibleGarments": "visible garments/clothing worn by the model; describe fabric texture, weave, stitching, natural creases",
    "colorPalette": "outfit colors that complement the footwear",
    "fitReason": "why this outfit fits the product, setting, and target wearer"
  },
  "script": [
    {
      "id": 1,
      "duration": "00:00-00:04",
      "goal": "Side pose hero shot",
      "visualDescription": "Model standing and posing, bending one leg to show the product from the side angle — full lower body visible, outfit matching the outfitPlan, natural pose, in the shared HOME setting",
      "cameraAction": "Medium shot from slightly low angle, model shifts weight to showcase silhouette",
      "productFocus": "Side profile, overall shape, heel height, strap/lace design"
    },
    {
      "id": 2,
      "duration": "00:04-00:08",
      "goal": "Handheld pair showcase",
      "visualDescription": "Two hands holding the pair of footwear close to camera, tilting gently to show design details — well-lit, product fills most of the frame",
      "cameraAction": "Close-up front angle, hands rotate product slowly to show design",
      "productFocus": "Upper design, texture, color, brand details, stitching, material"
    },
    {
      "id": 3,
      "duration": "00:08-00:12",
      "goal": "Front toe tap and spin",
      "visualDescription": "Front view of lower body, both feet doing rhythmic toe taps and rotating toe tips continuously — energetic, playful movement showing product in motion",
      "cameraAction": "Low angle front view, feet tapping and spinning on the spot",
      "productFocus": "Toe box, upper, overall form during movement, flexibility"
    },
    {
      "id": 4,
      "duration": "00:12-00:16",
      "goal": "Seated leg swing",
      "visualDescription": "Model sitting on a chair or stool, legs swinging and ankles rotating — relaxed, casual feel, showing product from a different perspective",
      "cameraAction": "Medium shot at sitting level, feet swing naturally and rotate",
      "productFocus": "On-foot comfort, ankle fit, product shape from seated angle, sole glimpse"
    },
    {
      "id": 5,
      "duration": "00:16-00:20",
      "goal": "Hands-on detail adjust",
      "visualDescription": "Model bending down, hands adjusting the collar, strap, lace, buckle, or heel area of the product — close interaction showing craftsmanship",
      "cameraAction": "Close-up from above, hands interact with product details",
      "productFocus": "Collar/tongue, lace/strap mechanism, buckle, heel detail, inner lining quality"
    },
    {
      "id": 6,
      "duration": "00:20-00:24",
      "goal": "Standing cross-leg pose swap",
      "visualDescription": "Standing at a slight angle, model crossing legs, lifting heels, and switching between poses continuously — dynamic, fashion-forward movement",
      "cameraAction": "Side angle medium shot, model switches between cross-leg poses",
      "productFocus": "Side and back view, heel height, silhouette from different angles, outfit pairing"
    },
    {
      "id": 7,
      "duration": "00:24-00:28",
      "goal": "Single piece rotation",
      "visualDescription": "Two hands holding one piece of footwear, rotating it from side view to sole view — smooth controlled rotation showing all surfaces",
      "cameraAction": "Close-up, hands smoothly rotate product 180 degrees from side to sole",
      "productFocus": "Side construction, sole thickness, tread pattern, material layers, brand marking on sole"
    },
    {
      "id": 8,
      "duration": "00:28-00:32",
      "goal": "Sole close-up texture",
      "visualDescription": "Extreme close-up of the sole, fingers stroking and pressing into the anti-slip grooves and texture — tactile, detail-oriented final shot",
      "cameraAction": "Macro close-up, fingers press and trace the sole grooves",
      "productFocus": "Sole tread pattern, rubber quality, anti-slip grooves, sole branding, flexibility"
    }
  ],
  "frameData": "Combined detailed visual plan for exactly 8 panels.",
  "cropTemplate": "How to extract each panel cleanly from the 4x2 storyboard grid.",
  "veo3Prompts": [
    "One single-line Vietnamese Veo 3 prompt for panel 1 — must include smartphone realism cues and action choreography: '0s-2s: Model stands with one leg slightly bent, rotating ankle to show side view. 2s-4s: Model shifts weight and adjusts pose, lifting bent leg slightly higher then settling into a confident stance.'",
    "One single-line Vietnamese Veo 3 prompt for panel 2 — must include smartphone realism cues and action choreography: '0s-2s: Hands hold product steady close to camera, slight tilt to one side. 2s-4s: Hands rotate product smoothly to the other side, showcasing different angles and catching light on texture details.'",
    "One single-line Vietnamese Veo 3 prompt for panel 3 — must include smartphone realism cues and action choreography: '0s-2s: Feet alternate quick toe taps on the floor, showing product bounce and flex. 2s-4s: Both feet rotate toe tips outward then inward in sync, then settle back to neutral position.'",
    "One single-line Vietnamese Veo 3 prompt for panel 4 — must include smartphone realism cues and action choreography: '0s-2s: Seated model swings legs forward gently and rotates one ankle in a circle. 2s-4s: Both feet swing in opposite directions, then ankles rotate together to show product from multiple angles.'",
    "One single-line Vietnamese Veo 3 prompt for panel 5 — must include smartphone realism cues and action choreography: '0s-2s: Hand reaches down and adjusts the strap or lace, fingers tracing along the edge. 2s-4s: Fingers press and smooth the collar or heel area, then gently tug to show secure fit.'",
    "One single-line Vietnamese Veo 3 prompt for panel 6 — must include smartphone realism cues and action choreography: '0s-2s: Model crosses one leg in front, lifts heel of back foot to show sole. 2s-4s: Quick pose switch — uncross and cross the other leg, lift opposite heel, settle into final pose.'",
    "One single-line Vietnamese Veo 3 prompt for panel 7 — must include smartphone realism cues and action choreography: '0s-2s: Hands hold one shoe at side angle, slowly begin rotating toward the sole. 2s-4s: Complete rotation to show full sole view, pause briefly to display tread pattern and sole details.'",
    "One single-line Vietnamese Veo 3 prompt for panel 8 — must include smartphone realism cues and action choreography: '0s-2s: Fingers press into the sole grooves to show depth and flexibility. 2s-4s: Fingers trace along the tread pattern, pressing to demonstrate grip quality, final hold on a detail.'"
  ]
}

Below are the 8 mandatory scene definitions that you MUST use for the "script" array and "veo3Prompts" (adjust based on target product from reference images):
${JSON.stringify(TEMPLATE2_SCENES, null, 2)}

Do not ask follow-up questions. Return ONLY valid JSON.
`.trim();
  }

  if (isTemplate3(options)) {
    return `TEXT-ONLY TASK. Do not generate images. Do not call image generation. Do not create a visual storyboard asset.
You are a senior footwear product analyst, faceless shop-review storyboard director, and Veo 3 prompt writer.
Analyze ONLY the uploaded footwear product reference images as the product source of truth, then create a reusable template3 storyboard as JSON text only.

IMPORTANT — VISUAL REALISM DIRECTION:
${TEMPLATE3_REALISM_FULL}

IMPORTANT — DISPLAY SUPPORT RULE:
${TEMPLATE3_DISPLAY_STAND_RULES}

IMPORTANT — SHOE SHOP BACKGROUND REFERENCE:
${TEMPLATE3_SHOP_BACKGROUND_RULES}

IMPORTANT — PANEL 1 HANDHELD COMPOSITION:
${TEMPLATE3_PANEL1_HANDHELD_COMPOSITION}

IMPORTANT — PANEL 2 SOCK / BAREFOOT LOGIC:
${TEMPLATE3_PANEL2_SOCK_RULES}

Requirements:
- Template: template3 faceless footwear shop top-down review.
- Category: ${category}
- Panel count: exactly 2.
- Scene ratio for each panel: ${sceneRatio}.
- Use the uploaded product reference images as the source of truth for product type, color, material, sole, straps/laces, logo/text, silhouette, charm, pattern, stitching, and styling.
- Use "shopgiay-background-reference.png" as the shared footwear shop background/style reference for both panels, while keeping the uploaded footwear product as the only product identity source.
- Scene context must be a real footwear shop / shoe store interior. Do not choose a home, bedroom, living room, cafe, beach, street, or studio.
- Randomly choose ONE coherent footwear shop area for the whole storyboard, such as a display counter, shoe-box shelf corner, fitting bench area, or retail floor near product shelves.
- Randomly choose ONE realistic shop time/lighting plan, such as daytime storefront light mixed with ceiling lights, evening shop light, or mall/store lighting.
- Both panels must share the exact same shop setting, time of day, surface/floor logic, background shelves, color palette, mood, and lighting plan.
- Randomly choose ONE outfit styling direction for the faceless wearer in Panel 2. The outfit must fit the footwear, shop setting, inferred gender/styling, and retail try-on context.
- Do not hardcode one default outfit such as cream/beige wide pants. Use that only if it truly fits the product.
- Faceless only: no visible faces, no talking host, no presenter, no full body. You may show hands, forearms, feet, lower legs, or cropped outfit/body parts only.
- Panel 1 composition is mandatory: top-down smartphone camera from above, almost fixed; one shoe/sandal is held by a realistic hand/forearm for product rotation, and the matching other shoe/sandal stays stationary below/on the product base.
- Panel 1 must feel like the provided layout reference: one footwear piece close to camera in the hand, one matching piece below, product base visible, shop background context around the surface.
- Panel 1 hand pose is mandatory: the hand grips the product firmly at the sole edge and side body, fingers supporting the outsole/side, thumb stabilizing the upper/side edge; the held product is tilted 15-30 degrees so the top/upper, toe/front, straps/laces, side body, and part of the sole edge are all visible.
- Panel 1 foreground/background scale is mandatory: the held product in hand is larger and dominant in the foreground; the matching other product is smaller in the background/below but fully visible and not blocked.
- Panel 1 product base rule: if product reference images clearly show a matching shoe box, use that box; otherwise use the display stand reference asset named "giadegiay-display-stand-reference.webp" for the stationary shoe.
- Panel 2 composition is mandatory: same as template1 Panel 2, top-down POV / first-person camera from above looking at the wearer trying the footwear on feet in the same footwear shop, sitting still or standing still in one place.
- Panel 2 sock logic is mandatory: if the analyzed product type is sneaker/shoe/loafer/boot/closed-toe footwear, the wearer must wear appropriate socks; if it is sandal/slide/slipper/open-toe dép, the wearer should normally be barefoot.
- Panel 2 must not show walking, stepping forward, low-angle shot, tracking shot, or body movement through space.
- No voice-over, no dialogue, no subtitles, no captions, no UI, no price, no rating, no watermark.
- Do not add text. Preserve only real existing product logo/text from the product reference if visible.
- Product identity must remain consistent across both panels.
- When writing visualDescription for each panel, embed the smartphone/shop realism details: normal phone camera, mixed shop lighting, real material texture, hand/skin pores, floor/shelf imperfections, not plastic/AI-looking.
- Return ONLY valid JSON. No markdown, no commentary.

JSON schema:
{
  "analysis": {
    "productName": "Vietnamese product name inferred from the images",
    "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
    "type": "footwear type such as sneaker, sandal, mule, loafer, boot, slipper",
    "materials": "describe visible material from references: fabric/leather/suede/rubber/EVA, texture, stitching, outsole, logo/text; avoid generic glossy plastic",
    "highlights": ["string"],
    "styling": "who/where this footwear fits",
    "uncertainties": "visible limits or details that cannot be confirmed",
    "gender": "male|female|unisex",
    "hasVisibleShoeBox": true,
    "shoeBoxEvidence": "what visible product box/packaging was detected, or 'not visible'"
  },
  "sceneContext": {
    "location": "one random shared FOOTWEAR SHOP location for both panels",
    "timeOfDay": "random shared shop time/lighting condition",
    "lighting": "mixed shop/store lighting plan with realistic shadows and no studio look",
    "mood": "authentic, fast, commercial shop review",
    "cameraCharacteristics": "smartphone 1x lens 24-28mm, Auto mode, top-down/POV, slight hand shake, no fake bokeh",
    "continuityRules": "how both panels keep the same shop setting, lighting, shelf/floor logic, and product identity"
  },
  "productSupportPlan": {
    "panel1StationaryBase": "use visible matching shoe box from reference OR use giadegiay-display-stand-reference.webp if no box is visible",
    "reason": "why this support choice was selected from product references",
    "propSafety": "display stand is a prop only; product remains exactly the Telegram uploaded footwear"
  },
  "outfitPlan": {
    "styleDirection": "random outfit style that fits the product and shoe-shop try-on context",
    "visibleGarments": "only visible cropped garments/body parts, no face; describe fabric texture, weave, stitching, natural creases",
    "colorPalette": "outfit colors that complement the footwear without copying one fixed default",
    "fitReason": "why this outfit fits the product, shop setting, and target wearer"
  },
  "script": [
    {
      "id": 1,
      "duration": "00:00-00:08",
      "goal": "Top-down hand rotation hero review",
      "visualDescription": "top-down smartphone shop-review layout: one shoe/sandal held large in the foreground by a realistic hand gripping the sole edge and side body, tilted 15-30 degrees so the top/upper, toe/front, straps/laces, side body, and part of the sole edge are visible; the matching stationary shoe stays smaller below/background on the product base but fully visible; footwear shop shelves/floor visible around the surface, product material looks real",
      "cameraAction": "almost fixed top-down smartphone camera; movement comes from the hand: lift, wrist rotation, sole flip, close push-in, return to pair",
      "productFocus": "upper/top, side silhouette, sole tread, heel/edge, straps/laces, logo/text, charm/pattern/stitching, material texture"
    },
    {
      "id": 2,
      "duration": "00:08-00:16",
      "goal": "Stationary POV on-foot proof in shop",
      "visualDescription": "top-down first-person POV in the same footwear shop, wearer trying the product on feet while sitting or standing still in one place; if the product is a closed shoe/sneaker/loafer/boot the wearer has appropriate socks, if open sandal/slide/slipper/dép then barefoot; cropped outfit visible, floor/shelves consistent",
      "cameraAction": "stationary top-down POV with only tiny handheld drift and a short push-in; no walking, no tracking",
      "productFocus": "on-foot shape, fit, strap/lace/detail visibility, outsole thickness, outfit pairing, realistic try-on value"
    }
  ],
  "frameData": "Combined detailed visual plan for exactly 2 panels, including the shared shop sceneContext, productSupportPlan, and realism direction.",
  "cropTemplate": "How to extract each panel cleanly while preserving the shop setting, top-down/POV composition, product support, lighting, and product identity.",
  "veo3Prompts": [
    "One single-line Vietnamese Veo 3 prompt for panel 1 without voice-over, exactly 8 seconds, top-down shop hand rotation, using the mandatory choreography.",
    "One single-line Vietnamese Veo 3 prompt for panel 2 without voice-over, exactly 8 seconds, template1-style POV on-foot proof in the same shop."
  ]
}

Important:
- Do not include a voiceOver field anywhere in the JSON.
- "script" and "veo3Prompts" must contain exactly 2 items.
- Each veo3 prompt must be one line, with no newline characters.
- Each veo3 prompt must include VISUAL, Tone & Mood.
- Each veo3 prompt must explicitly say: "Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark."
- Each veo3 prompt must include realism cues: "quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da tay/chân thật, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI."
- Panel 1 veo3 prompt MUST use this exact action choreography and must not replace it with generic product rotation:
${TEMPLATE3_PANEL1_CHOREOGRAPHY}
- Panel 1 storyboard and panel image prompts MUST follow this hand-held composition exactly:
${TEMPLATE3_PANEL1_HANDHELD_COMPOSITION}
- Panel 1 must explicitly say: if no shoe box appears in the product reference, the stationary shoe is placed on the giadegiay display stand reference, while the moving hand-held product remains exactly the Telegram uploaded product.
- Panel 2 storyboard and video prompts MUST follow this footwear/sock rule:
${TEMPLATE3_PANEL2_SOCK_RULES}
- Panel 2 veo3 prompt MUST use the same stationary POV choreography style as template1 Panel 2:
${TEMPLATE1_PANEL2_CHOREOGRAPHY}
- Panel 2 must be top-down POV from above in a footwear shop, with the wearer standing still or sitting still in one place. Do not write walking, stepping forward, low-angle, or tracking movement.
- Do not ask follow-up questions. Return ONLY valid JSON.`.trim();
  }

  if (isTemplate1(options)) {
    return `TEXT-ONLY TASK. Do not generate images. Do not call image generation. Do not create a visual storyboard asset.
You are a senior footwear product analyst, faceless storyboard director, and Veo 3 prompt writer.
Analyze the uploaded footwear product reference images and create a reusable faceless review storyboard as JSON text only.

IMPORTANT — VISUAL REALISM DIRECTION:
${SMARTPHONE_REALISM_FULL}

Requirements:
- Template: template1 faceless footwear review.
- Category: ${category}
- Panel count: exactly 2.
- Scene ratio for each panel: ${sceneRatio}.
- Use the uploaded product analysis/reference images as the source of truth for product type, color, material, sole, straps/laces, logo/text, silhouette, and styling.
- Randomly choose ONE coherent real-world HOME setting (e.g. living room, bedroom, balcony, front porch) and ONE time of day for the whole storyboard. The setting must feel like a real home, not a showroom or studio.
- Randomly choose ONE outfit styling direction for the faceless wearer in Panel 2. The outfit must fit the product, gender/styling inference, selected location, time of day, weather/season cues, and color palette.
- Do not hardcode a default outfit such as cream/beige wide pants. Use a different suitable outfit when the product and context call for it.
- Both panels must share the exact same setting, time of day, weather/season cues, surface, background logic, color palette, and lighting plan.
- Lighting must follow smartphone realism rules above: natural window light with gradient falloff, no studio lighting.
- Faceless only: no visible faces, no talking host, no presenter. You may show hands, feet, lower legs, or cropped body parts only when useful.
- Panel 1 composition is mandatory: a beautiful feminine hand holds ONE sandal close to camera in the foreground, with the other sandal visible behind in the same setting. The hand must look realistic with visible pores, knuckle creases, natural skin tone, neat glossy nude/pink manicure, correct anatomy, no extra fingers.
- Panel 2 composition is mandatory: top-down POV / first-person camera from above, looking at the wearer's feet and sandals while the wearer is sitting still or standing still in one place. No walking, no stepping forward, no low-angle shot, no tracking shot, no body movement through space.
- Panel 2 can include only small stationary foot gestures such as toe wiggle, slight ankle tilt, heel lift, or settling pose. The feet must remain in the same spot.
- No voice-over, no dialogue, no subtitles, no captions, no UI, no price, no rating, no watermark.
- Product identity must remain consistent across both panels.
- When writing visualDescription for each panel, embed the smartphone realism details: mention phone camera traits, natural window lighting, matte product surface with texture grain/mold lines, skin pores on hands, imperfect framing.
- Do not ask follow-up questions.
- Return ONLY valid JSON. No markdown, no commentary.
- If you are unable to inspect the images, still return the JSON schema with best-effort assumptions. Never mention image quota, limits, usage, or settings.

JSON schema:
{
  "analysis": {
    "productName": "Vietnamese product name inferred from the images",
    "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
    "type": "footwear type such as sneaker, sandal, mule, loafer, boot",
    "materials": "describe visible material with realism: EVA foam, soft molded rubber, matte finish, mold seam lines, texture grain — not glossy or porcelain",
    "highlights": ["string"],
    "styling": "who/where this footwear fits",
    "uncertainties": "visible limits or details that cannot be confirmed",
    "gender": "male|female|unisex"
  },
  "sceneContext": {
    "location": "one random shared HOME location for both panels (living room, bedroom, balcony, etc.)",
    "timeOfDay": "random shared time of day",
    "lighting": "natural window light description following smartphone realism rules: gradient falloff, slight overexposure near window, no studio lights",
    "mood": "casual, authentic, everyday review",
    "cameraCharacteristics": "smartphone 1x lens ~24-28mm, Auto mode, slight white-balance drift, faint noise in shadows, no fake bokeh",
    "continuityRules": "how both panels keep the same setting, lighting, and smartphone camera feel"
  },
  "outfitPlan": {
    "styleDirection": "random outfit style that fits the product and setting",
    "visibleGarments": "only the visible cropped garments/body parts, no face; describe fabric texture, weave, stitching, natural creases",
    "colorPalette": "outfit colors that complement the footwear without copying one fixed default",
    "fitReason": "why this outfit fits the product, setting, and target wearer"
  },
  "script": [
    {
      "id": 1,
      "duration": "00:00-00:08",
      "goal": "Handheld hero detail",
      "visualDescription": "beautiful feminine hand holding one sandal close to camera, second sandal behind, same shared setting — shot looks like a casual smartphone photo with natural window light, matte product surface with mold lines, hand has visible pores and knuckle creases, frame slightly off-center",
      "cameraAction": "close-up front angle, subtle handheld product showcase, smartphone auto-focus with slight depth",
      "productFocus": "insole, upper, charms/details, strap, sole, product shape — matte EVA/rubber texture, not glossy"
    },
    {
      "id": 2,
      "duration": "00:08-00:16",
      "goal": "Stationary POV on-foot proof",
      "visualDescription": "top-down first-person POV, wearer sitting still or standing still in one place, sandals on feet, same shared setting — authentic phone camera look, feet not in perfect parallel, sock slightly wrinkled, wood floor has visible grain and joint gaps",
      "cameraAction": "stationary top-down POV with only tiny handheld drift, no walking/tracking, smartphone auto-exposure",
      "productFocus": "on-foot shape, charms/details, outfit pairing, comfort impression — realistic material texture"
    }
  ],
  "frameData": "Combined detailed visual plan for exactly 2 panels, including the shared sceneContext and smartphone realism direction.",
  "cropTemplate": "How to extract each panel cleanly while preserving the shared setting, lighting, smartphone camera feel, and product identity.",
  "veo3Prompts": [
    "One single-line Vietnamese Veo 3 prompt for panel 1 without voice-over — must include smartphone realism cues",
    "One single-line Vietnamese Veo 3 prompt for panel 2 without voice-over — must include smartphone realism cues"
  ]
}

Important:
- Do not include a voiceOver field anywhere in the JSON.
- "script" and "veo3Prompts" must contain exactly 2 items.
- Each veo3 prompt must be one line, with no newline characters.
- Each veo3 prompt must include VISUAL, Tone & Mood.
- Each veo3 prompt must explicitly say: "Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark."
- Each veo3 prompt must include smartphone realism cues: "ảnh chụp bằng điện thoại, ánh sáng cửa sổ tự nhiên, bề mặt sản phẩm lì có vân khuôn, không bokeh giả, không ánh sáng studio."
- Panel 1 veo3 prompt must introduce the footwear with a beautiful female hand holding one sandal close to camera; the other sandal stays behind for depth. Include action timing 0s-4s and 5s-8s.
- Panel 2 veo3 prompt MUST use the following EXACT choreography (do not simplify, do not replace with generic movements):
${TEMPLATE1_PANEL2_CHOREOGRAPHY}
- Panel 2 must be top-down POV from above, with the wearer standing still in one place. Do not write walking, stepping forward, low-angle, or tracking movement.`.trim();
  }

  const modelLine = vietnameseModel
    ? 'Use a young Vietnamese model when a human model is needed.'
    : 'Use a professional fashion model when a human model is needed.';
  const paceLine = styleFast
    ? 'Voice-over must be short, punchy, curiosity-driven, 24-30 Vietnamese words per panel.'
    : 'Voice-over must feel natural, clear, 18-24 Vietnamese words per panel.';

  return `TEXT-ONLY TASK. Do not generate images. Do not call image generation. Do not create a visual storyboard asset.
You are a senior fashion product analyst, text storyboard planner, and Veo 3 prompt writer.
Analyze the uploaded product reference images and write a Vietnamese review plan as JSON text only.

Requirements:
- Category: ${category}
- Panel count: exactly ${panelCount}
- Scene ratio for each panel: ${sceneRatio}
- ${modelLine}
- ${paceLine}
- Product identity must remain consistent across all panels.
- Do not ask follow-up questions.
- Return ONLY valid JSON. No markdown, no commentary.
- If you are unable to inspect the images, still return the JSON schema with best-effort assumptions. Never mention image quota, limits, usage, or settings.
- This step is only for text analysis and prompt writing. The actual image generation will happen in a later separate request.

JSON schema:
{
  "analysis": {
    "productName": "Vietnamese product name inferred from the images",
    "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
    "type": "string",
    "materials": "string",
    "highlights": ["string"],
    "styling": "string",
    "uncertainties": "string",
    "gender": "male|female|unisex"
  },
  "script": [
    {
      "id": 1,
      "duration": "00:00-00:08",
      "voiceOver": "Vietnamese voice-over",
      "goal": "Hook|Value|Twist|CTA",
      "visualDescription": "detailed visual",
      "cameraAction": "detailed camera movement"
    }
  ],
  "frameData": "Combined text-only visual plan for all panels.",
  "cropTemplate": "Text-only notes for panel composition/cropping.",
  "veo3Prompts": [
    "One single-line Vietnamese Veo 3 prompt for panel 1"
  ]
}

Important:
- Infer "analysis.productName" from visible product information, product type, design, and labels/text in the images.
- Extract existing hashtags from the images if visible. If fewer than 5 are visible, add relevant Vietnamese/TikTok-friendly fashion hashtags until there are exactly 5.
- "analysis.hashtags" must contain exactly 5 unique hashtags, each starting with "#".
- "script" and "veo3Prompts" must contain exactly ${panelCount} items.
- Each veo3 prompt must be one line, with no newline characters.
- Each veo3 prompt must include VISUAL, Tone & Mood, Action timing 0s-4s and 5s-8s, and vietnamese voice Script.`.trim();
}

function buildStoryboardPrompt(analysis, options = {}) {
  const panelCount = resolvePanelCount(options);
  const sceneRatio = options.sceneRatio || options.aspectRatio || '9:16';
  const noText = options.noTextInImage !== false;
  const textRule = noText
    ? 'No text, labels, captions, UI, logos, or watermarks inside the image.'
    : 'Avoid unnecessary text.';

  if (isTemplate2(options)) {
    const sceneData = {
      analysis: analysis.analysis || {},
      sceneContext: analysis.sceneContext || {},
      outfitPlan: analysis.outfitPlan || {},
      frameData: analysis.frameData || '',
      cropTemplate: analysis.cropTemplate || '',
      panels: (analysis.script || []).map((s, i) => ({
        id: s.id || (i + 1),
        goal: s.goal || '',
        visualDescription: s.visualDescription || '',
        cameraAction: s.cameraAction || '',
        productFocus: s.productFocus || '',
      })),
    };

    return `Generate one footwear review storyboard image from the uploaded product reference images.

CRITICAL VISUAL DIRECTION — SMARTPHONE REALISM:
${SMARTPHONE_REALISM_FULL}

Storyboard requirements:
- Exactly 8 panels arranged in a 4x2 grid (4 columns and 2 rows) within a single still image.
- Each panel frame is optimized for ${sceneRatio} aspect ratio.
- All 8 panels must share the same home setting, wearer, outfit, lighting, and smartphone camera characteristics from the Scene plan.
- The panels must show the following sequence of shots:
  1. Panel 1: Model standing and posing, bending one leg to show the product from the side.
  2. Panel 2: Two hands holding the pair of footwear close to camera, tilting to show design.
  3. Panel 3: Front view of lower body, feet tapping and spinning toes.
  4. Panel 4: Model sitting on a chair, legs swinging and ankles rotating.
  5. Panel 5: Model bending down, hands adjusting the collar, strap, lace, or heel.
  6. Panel 6: Standing cross-leg pose, lifting heel and switching pose.
  7. Panel 7: Two hands holding one piece, rotating it from side to sole.
  8. Panel 8: Close-up of sole, fingers pressing/stroking anti-slip grooves.
- Preserve product design, color, material, and identity from the reference photos exactly.
- The photo must look like a set of casual photos taken with a normal smartphone camera: natural window light, matte surfaces, realistic skin, correct anatomy.
- ${textRule}
- Output must be a still 4x2 photo collage. Do NOT generate or describe a video.

Scene plan:
${JSON.stringify(sceneData, null, 2)}

Generate one still storyboard image now.`.trim();
  }

  if (isTemplate3(options)) {
    const sceneData = {
      analysis: analysis.analysis || {},
      sceneContext: analysis.sceneContext || {},
      productSupportPlan: analysis.productSupportPlan || {},
      outfitPlan: analysis.outfitPlan || {},
      frameData: analysis.frameData || '',
      cropTemplate: analysis.cropTemplate || '',
      panels: (analysis.script || []).map((s, i) => ({
        id: s.id || (i + 1),
        goal: s.goal || '',
        visualDescription: s.visualDescription || '',
        cameraAction: s.cameraAction || '',
        productFocus: s.productFocus || '',
      })),
    };

    return `Generate one faceless footwear shop review storyboard image from the uploaded product reference images.

CRITICAL VISUAL DIRECTION — TEMPLATE3 SHOP SMARTPHONE REALISM:
${TEMPLATE3_REALISM_FULL}

DISPLAY SUPPORT RULES:
${TEMPLATE3_DISPLAY_STAND_RULES}

SHOP BACKGROUND REFERENCE RULES:
${TEMPLATE3_SHOP_BACKGROUND_RULES}

PANEL 1 HANDHELD COMPOSITION RULES:
${TEMPLATE3_PANEL1_HANDHELD_COMPOSITION}

PANEL 2 SOCK / BAREFOOT RULES:
${TEMPLATE3_PANEL2_SOCK_RULES}

Storyboard requirements:
- Exactly 2 panels arranged side by side in one single still image.
- Each panel frame is optimized for ${sceneRatio} aspect ratio.
- Use uploaded reference asset "shopgiay-background-reference.png" as the shared shop environment reference for both panels, including shelves/display mood/floor/counter/lighting. Keep it secondary behind the product.
- Both panels must share the same real footwear shop setting, time of day, surface/floor logic, shelves/display background, mood, and lighting plan from Scene plan.
- Panel 1 is mandatory: top-down smartphone shot from above, almost fixed camera, one shoe/sandal held by a realistic hand in the foreground, larger than everything else, the matching other shoe/sandal stationary below/background on the product base.
- Panel 1 must match the reference layout idea: held product in foreground occupying about 55-70% of panel height, matching stationary pair below/background still fully visible, product support visible, shop context around the table/counter/floor.
- Panel 1 hand pose must look correct: fingers support under/along the outsole and side body, thumb stabilizes the side/upper edge, product tilted 15-30 degrees, top/upper, toe/front, straps/laces, side body, and a portion of the sole edge visible at once.
- Panel 1 must not show a pinch-only grip, heel-only grip, covered laces/straps/logo, hidden top surface, horizontal side-view camera, low-angle camera, or orbit-style composition.
- If the uploaded product references show a matching shoe box, use that box. If not, use uploaded reference asset "giadegiay-display-stand-reference.webp" only as the shoe display stand for the stationary shoe.
- Panel 2 is mandatory: template1-style top-down POV on-foot proof in the exact same shop. The wearer is sitting still or standing still in one place, no walking and no tracking.
- Panel 2 sock/barefoot logic is mandatory: if the product is a closed shoe/sneaker/loafer/boot, show appropriate socks; if the product is open sandal/slide/slipper/dép, keep the wearer barefoot unless styling clearly supports socks.
- Preserve product design, color, material, silhouette, logo/text, sole, straps/laces, charm, pattern, stitching, and identity from the product reference photos.
- The stationary shoe and hand-held shoe must be the same pair, identical in size, color, design, and material.
- No visible faces. Only hands, forearms, feet, lower legs, or cropped outfit/body parts are allowed when useful.
- Do not create a home, bedroom, living room, cafe, beach, street, studio, low-angle shot, or movement-through-space scene.
- ${textRule} Preserve only real product logo/text that exists on the reference product.
- Output must be a still photo collage. Do NOT generate or describe a video.

Scene plan:
${JSON.stringify(sceneData, null, 2)}

Generate one still storyboard image now.`.trim();
  }

  if (isTemplate1(options)) {
    const sceneData = {
      analysis: analysis.analysis || {},
      sceneContext: analysis.sceneContext || {},
      outfitPlan: analysis.outfitPlan || {},
      frameData: analysis.frameData || '',
      cropTemplate: analysis.cropTemplate || '',
      panels: (analysis.script || []).map((s, i) => ({
        id: s.id || (i + 1),
        goal: s.goal || '',
        visualDescription: s.visualDescription || '',
        cameraAction: s.cameraAction || '',
        productFocus: s.productFocus || '',
      })),
    };

    return `Generate one faceless footwear review storyboard image from the uploaded product reference images.

CRITICAL VISUAL DIRECTION — SMARTPHONE REALISM:
${SMARTPHONE_REALISM_FULL}

Storyboard requirements:
- Exactly 2 panels arranged side by side in one single still image.
- Each panel frame is optimized for ${sceneRatio} aspect ratio.
- Both panels must share the same home setting, time of day, surface, background, mood, and natural window lighting from Scene plan.
- Panel 1 is a mandatory handheld hero/detail shot: beautiful feminine hand holding one sandal close to camera, other sandal behind, same shared setting. Hand must show pores, knuckle creases, natural skin. Product surface must be matte with texture grain and mold seam lines.
- Panel 2 is a mandatory top-down POV on-foot shot using the randomized outfitPlan in the exact same setting. The wearer is sitting still or standing still in one place. Feet not in perfect parallel. Socks slightly wrinkled, off-white/ivory.
- Preserve product design, color, material, silhouette, logo/text, sole, straps/laces, and identity from the reference photos.
- The photo must look like it was taken with a normal smartphone camera at home: natural window light with gradient falloff, slight sensor noise in shadows, slightly off-center framing, matte product surfaces, no studio lighting.
- No visible faces. Only hands, feet, lower legs, or cropped body parts are allowed when needed.
- Do not create a walking scene, low-angle shot, tracking shot, beach-walking transition, or movement through space.
- Wood floor or home surface must show natural grain, joint gaps, minor imperfections.
- ${textRule}
- Output must be a still photo collage. Do NOT generate or describe a video.

Scene plan:
${JSON.stringify(sceneData, null, 2)}

Generate one still storyboard image now.`.trim();
  }

  // Only include visual/camera scene data — do NOT include veo3Prompts or any
  // video-related keys that could trigger Gemini's video generation mode instead
  // of image generation.
  const sceneData = {
    frameData: analysis.frameData || '',
    cropTemplate: analysis.cropTemplate || '',
    panels: (analysis.script || []).map((s, i) => ({
      id: s.id || (i + 1),
      visualDescription: s.visualDescription || '',
      cameraAction: s.cameraAction || '',
    })),
  };

  return `Generate one clean fashion storyboard image (still photo collage, NOT a video) from the uploaded product reference images.

Storyboard requirements:
- Exactly ${panelCount} panels arranged side by side in one single image.
- Each panel frame is optimized for ${sceneRatio} aspect ratio.
- Show one coherent Vietnamese fashion product review photo sequence.
- Preserve product design, color, material, and identity from the reference photos.
- Use cinematic commercial lighting, realistic fashion photography, clean composition.
- ${textRule}
- Output must be a still photograph/illustration. Do NOT generate or describe a video.

Scene plan:
${JSON.stringify(sceneData, null, 2)}

Generate one still storyboard image now.`.trim();
}

function buildPanelPrompt(storyboardAvailable, panelIndex, panelCount, scriptItem, veoPrompt, options = {}) {
  const sceneRatio = options.sceneRatio || options.aspectRatio || '9:16';
  const source = storyboardAvailable
    ? 'Use the uploaded storyboard image as the main visual reference and extract/recreate only this panel.'
    : 'Use the uploaded product images as visual references and create this panel directly.';

  if (isTemplate2(options)) {
    return `Generate a single footwear photograph featuring a young Vietnamese model that looks like an authentic smartphone camera shot (still image, NOT a video).

CRITICAL VISUAL DIRECTION — SMARTPHONE REALISM:
${SMARTPHONE_REALISM_FULL}

Panel: ${panelIndex} of ${panelCount}
Aspect ratio: ${sceneRatio}
Instructions:
- ${source}
- Keep the product identity exactly consistent with the reference photo(s).
- Keep the shared home setting, lighting, model, and mood consistent with the storyboard scene.
- The photo must look like it was casually taken with a normal smartphone camera, not a professional camera or AI render.
- Product surface: matte with fine texture grain. NEVER glossy porcelain or smooth render finish.
- Human skin: visible pores, knuckle creases, natural skin tone variation. NEVER plastic/waxy skin.
- Framing: slightly off-center. Background has everyday home details.
- Lighting: natural window light with gradient falloff, realistic shadow contact under product and body.
- For Panel 1: model standing and posing, co một chân khoe mặt bên sản phẩm.
- For Panel 2: hai tay cầm đôi sản phẩm cận camera, nghiêng nhẹ.
- For Panel 3: góc chính diện phần thân dưới, toe tap và xoay mũi.
- For Panel 4: model ngồi ghế, hai chân đung đưa, xoay cổ chân.
- For Panel 5: cúi người dùng tay chỉnh cổ giày/quai/dây/gót.
- For Panel 6: đứng nghiêng, bắt chéo chân, nhấc gót, đổi pose.
- For Panel 7: hai tay cầm một chiếc xoay từ mặt bên sang mặt đế.
- For Panel 8: cận cảnh mặt đế, tay vuốt nhấn vào các rãnh.
- Make it a vertical start frame suitable for image-to-video, maintaining the smartphone camera aesthetic.

Panel data:
${JSON.stringify(scriptItem)}

Motion reference prompt:
${veoPrompt}

Generate exactly one still image now.`.trim();
  }

  if (isTemplate3(options)) {
    const panelSpecificRules = panelIndex === 1
      ? `- Panel 1 mandatory composition: top-down smartphone camera from above, almost fixed; one shoe/sandal is held by a realistic hand close to the camera in the foreground and is clearly larger than the matching other shoe/sandal.
- The held product should occupy about 55-70% of the panel height. The matching other shoe/sandal stays below or in the background, smaller but still fully visible with complete form.
- Hand grip must be realistic and stable: fingers support the outsole/sole edge and side body, thumb stabilizes the side/upper edge. Do not pinch only the toe, hold only the heel, cover the laces/straps/logo/front design, or hide the top surface.
- The held product must be tilted about 15-30 degrees, showing the top/upper, toe/front, straps/laces, side body, and part of the sole edge in the same image.
- If a matching shoe box appears in the product reference/storyboard, keep it as the base. If no shoe box is visible, use "giadegiay-display-stand-reference.webp" only as the shoe display stand prop for the stationary shoe.
- Show the start frame for the hand-rotation hero review: the held product is entering/raised above the stationary pair, with top/upper facing camera clearly.
- Do not show a face, full body, horizontal side-view camera, low-angle camera, orbit composition, TikTok UI, caption, watermark, or added logo/text.`
      : `- Panel 2 mandatory composition: top-down POV / first-person camera from above, wearer trying the footwear on feet in the exact same footwear shop.
- The wearer is sitting still or standing still in one place. Do not show walking, stepping forward, low-angle tracking, or movement through space.
- Footwear/sock logic is mandatory: if product is a closed shoe/sneaker/loafer/boot, show appropriate clean socks; if product is open sandal/slide/slipper/dép, show natural bare feet unless styling clearly supports socks.
- Use the randomized outfit direction from the storyboard/shot concept; do not force cream/beige wide pants unless outfitPlan selected it.
- Show realistic shop floor, fitting bench/shelf context, and natural foot/ankle asymmetry.`;

    return `Generate a single faceless footwear shop-review photograph that looks like an authentic smartphone camera shot (still image, NOT a video).

CRITICAL VISUAL DIRECTION — TEMPLATE3 SHOP SMARTPHONE REALISM:
${TEMPLATE3_REALISM_FULL}

DISPLAY SUPPORT RULES:
${TEMPLATE3_DISPLAY_STAND_RULES}

SHOP BACKGROUND REFERENCE RULES:
${TEMPLATE3_SHOP_BACKGROUND_RULES}

PANEL 1 HANDHELD COMPOSITION RULES:
${TEMPLATE3_PANEL1_HANDHELD_COMPOSITION}

PANEL 2 SOCK / BAREFOOT RULES:
${TEMPLATE3_PANEL2_SOCK_RULES}

Panel: ${panelIndex} of ${panelCount}
Aspect ratio: ${sceneRatio}
Instructions:
- ${source}
- Keep the product identity exactly consistent with the product reference photo(s), including color, material, silhouette, sole, straps/laces, logo/text, charm, pattern, stitching, and proportions.
- Use "shopgiay-background-reference.png" as the shop environment reference for shelves/display/floor/counter/lighting, but keep it secondary and do not copy any text/watermark/signage.
- Keep the shared footwear shop setting, time of day, mixed shop lighting, floor/shelf logic, and mood consistent with the storyboard scene.
- The photo must look like it was casually taken with a normal smartphone camera, not a professional studio photo or AI render.
- Product material must show real texture/grain/weave/seams/scuffs/fingerprints where appropriate. Never make it glossy porcelain, waxy plastic, melted, or deformed.
- Human skin must show visible pores, knuckle creases, light veins, natural skin tone variation, and correct anatomy. No extra fingers.
- Framing can be slightly off-center; shop shelves/floor/counter details should feel real but not distract from the product.
${panelSpecificRules}
- Make it a vertical start frame suitable for image-to-video, maintaining the same shop smartphone aesthetic.

Panel data:
${JSON.stringify(scriptItem)}

Motion reference prompt:
${veoPrompt}

Generate exactly one still image now.`.trim();
  }

  if (isTemplate1(options)) {
    return `Generate a single faceless footwear photograph that looks like an authentic smartphone camera shot (still image, NOT a video).

CRITICAL VISUAL DIRECTION — SMARTPHONE REALISM:
${SMARTPHONE_REALISM_FULL}

Panel: ${panelIndex} of ${panelCount}
Aspect ratio: ${sceneRatio}
Instructions:
- ${source}
- Keep the product identity exactly consistent with the reference photo(s).
- Keep the shared home setting, time of day, natural window lighting, surface, and mood consistent with the storyboard scene.
- The photo must look like it was casually taken with a normal smartphone camera, not a professional camera or AI render.
- Product surface: matte EVA/rubber with fine texture grain, mold seam lines, faint fingerprint marks. NEVER glossy porcelain or smooth render finish.
- Human skin: visible pores, knuckle creases, light veins, natural skin tone variation. NEVER plastic/waxy skin or doll-like hands.
- Socks (if visible): slight wrinkles, compression under straps, off-white/ivory not pure white.
- Fabric/clothing: visible weave texture, stitching, natural creases, slight wear signs.
- Framing: slightly off-center, not perfectly aligned. Background has everyday home details.
- Lighting: natural window light with gradient falloff, slight overexposure near window, realistic shadow contact under product and body parts. No studio lights, no warm golden glow.
- Faint sensor noise in shadow areas, light sharpening artifacts near edges.
- Do not show any visible face, talking person, presenter, or full-face reflection.
- Do not include text, labels, captions, UI, prices, ratings, logos added by the model, or watermarks.
- If the panel includes clothing, use the randomized outfit direction from the storyboard/shot concept; do not force cream/beige wide pants unless that was explicitly selected by outfitPlan.
- For Panel 1: show a beautiful feminine hand holding one sandal close to camera, with correct hand anatomy, visible pores and knuckle creases, and neat glossy nude/pink nails; keep the second sandal behind in the same scene.
- For Panel 2: use top-down POV from above only; the wearer must be sitting still or standing still in one place; feet not in perfect parallel. Do not show walking, stepping forward, low-angle tracking, or a moving body.
- Make it a vertical start frame suitable for image-to-video, maintaining the smartphone camera aesthetic.

Panel data:
${JSON.stringify(scriptItem)}

Motion reference prompt:
${veoPrompt}

Generate exactly one still image now.`.trim();
  }

  // Keep the panel prompt focused on still image generation.
  // Do NOT mention Veo 3 / video by name to avoid triggering video mode.
  return `Generate a single polished fashion photograph (still image, NOT a video).

Panel: ${panelIndex} of ${panelCount}
Aspect ratio: ${sceneRatio}
Instructions:
- ${source}
- Keep the product identity exactly consistent with the reference photo(s).
- Do not include text, labels, captions, UI, or watermarks.
- Cinematic commercial lighting, vertical frame, clean background.

Scene description:
- Visual: ${scriptItem.visualDescription || ''}
- Camera: ${scriptItem.cameraAction || ''}

Shot concept:
${veoPrompt}

Generate exactly one still image now.`.trim();
}

// ─── Normalize analysis (mirrors Python normalize_analysis) ───────────────────

function normalizeAnalysis(data, panelCount, options = {}) {
  const useTemplate1 = isTemplate1(options);
  const useTemplate2 = isTemplate2(options);
  const useTemplate3 = isTemplate3(options);
  const script = Array.isArray(data.script) ? data.script : [];
  const prompts = Array.isArray(data.veo3Prompts) ? data.veo3Prompts : [];
  const rawAnalysis = (typeof data.analysis === 'object' && data.analysis) ? data.analysis : {};
  const productMetadata = normalizeProductMetadata(rawAnalysis, rawAnalysis.type || 'Fashion product');

  const normalizedScript = [];
  for (let idx = 0; idx < panelCount; idx++) {
    const item = (idx < script.length && typeof script[idx] === 'object') ? script[idx] : {};
    const stepDuration = useTemplate2 ? 4 : 8;
    const normalizedItem = {
      id: parseInt(item.id || idx + 1, 10),
      duration: String(item.duration || `00:${String(idx * stepDuration).padStart(2, '0')}-00:${String((idx + 1) * stepDuration).padStart(2, '0')}`),
      goal: String(item.goal || ''),
      visualDescription: String(item.visualDescription || ''),
      cameraAction: String(item.cameraAction || ''),
    };
    if (useTemplate1 || useTemplate2 || useTemplate3) {
      normalizedItem.productFocus = String(item.productFocus || '');
    } else {
      normalizedItem.voiceOver = String(item.voiceOver || '');
    }
    normalizedScript.push(normalizedItem);
  }

  const normalizedPrompts = [];
  for (let idx = 0; idx < panelCount; idx++) {
    if (idx < prompts.length) {
      let prompt = (useTemplate1 || useTemplate2 || useTemplate3)
        ? normalizeTemplate1VideoPrompt(prompts[idx])
        : normalizePrompt(prompts[idx]);
      if (useTemplate1) {
        if (idx === 0) {
          prompt = normalizePrompt(
            `${prompt} Quy tắc bắt buộc Panel 1: tay nữ đẹp cầm một chiếc dép sát camera, móng nude/hồng bóng nhẹ, đúng giải phẫu, chiếc dép còn lại ở phía sau cùng bối cảnh.`
          );
        } else if (idx === 1) {
          // Replace Gemini's generic Panel 2 choreography with the exact choreography from 2.video.md
          // Strip Gemini's action timing ("Hành động 0s-4s:..." / "Hanh dong...") and inject ours
          prompt = prompt
            .replace(/H[aà]nh\s+[đd][oộ]ng\s+\d+s[^.]*\./giu, '')
            .replace(/Action\s+\d+s[^.]*\./gi, '');
          prompt = normalizePrompt(
            `${prompt} Quy tắc bắt buộc Panel 2: POV top-down từ trên xuống, người mẫu đứng im một chỗ. ${TEMPLATE1_PANEL2_CHOREOGRAPHY} Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark, không lộ mặt người.`
          );
        }
      } else if (useTemplate3) {
        if (idx === 0) {
          prompt = normalizePrompt(
            `${prompt} Quy tắc bắt buộc Panel 1 / Template3: Cảnh shop giày dép, camera smartphone top-down cố định từ trên xuống, một chiếc giày/dép được tay cầm để giới thiệu, chiếc còn lại đặt cố định trên hộp giày nếu ảnh tham chiếu có hộp; nếu không có hộp thì đặt trên giá đỡ theo reference giadegiay-display-stand-reference.webp. Sản phẩm di chuyển luôn là sản phẩm đã upload từ Telegram; giá đỡ chỉ là prop. ${TEMPLATE3_PANEL1_HANDHELD_COMPOSITION} ${TEMPLATE3_PANEL1_CHOREOGRAPHY} Quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da tay thật, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI. Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark, không lộ mặt người.`
          );
        } else if (idx === 1) {
          prompt = prompt
            .replace(/H[aà]nh\s+[đd][oộ]ng\s+\d+s[^.]*\./giu, '')
            .replace(/Action\s+\d+s[^.]*\./gi, '');
          prompt = normalizePrompt(
            `${prompt} Quy tắc bắt buộc Panel 2 / Template3: POV top-down từ trên xuống trong cùng shop giày dép, người mẫu đứng im hoặc ngồi im một chỗ, không walking, không stepping forward, không low-angle, không tracking shot. ${TEMPLATE3_PANEL2_SOCK_RULES} ${TEMPLATE1_PANEL2_CHOREOGRAPHY} Quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da chân thật, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI. Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark, không lộ mặt người.`
          );
        }
      } else if (useTemplate2) {
        const sceneDef = TEMPLATE2_SCENES[idx];
        prompt = normalizePrompt(
          `${prompt} Quy tắc bắt buộc Panel ${idx + 1}: ${sceneDef.goal}. ${sceneDef.choreography} Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark.`
        );
      }
        normalizedPrompts.push(prompt);
      } else {
        const item = normalizedScript[idx];
        if (useTemplate1) {
        const fallbackChoreography = idx === 1
          ? TEMPLATE1_PANEL2_CHOREOGRAPHY
          : `Hành động: 0s-4s ${item.cameraAction}; 5s-8s giữ đúng bố cục cảnh, chỉ chuyển động nhỏ tại chỗ để nhấn chi tiết sản phẩm.`;
        normalizedPrompts.push(normalizePrompt(
          `Tạo video review giày dép faceless 8 giây. VISUAL: ${item.visualDescription}. ` +
          `Tone & Mood: chân thực, thời trang, sạch, thương mại. ` +
          `${fallbackChoreography} ` +
          `Nếu là cảnh POV thì nhân vật phải đứng im hoặc ngồi im một chỗ, không đi lại, không tracking shot. ` +
            `Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark.`
          ));
      } else if (useTemplate3) {
        if (idx === 0) {
          normalizedPrompts.push(normalizePrompt(
            `Tạo video review giày dép faceless dài đúng 8 giây. VISUAL: Camera smartphone top-down nhìn từ trên xuống trong shop giày dép chân thực; ${item.visualDescription}; một chiếc được tay cầm giới thiệu, chiếc còn lại đặt cố định trên hộp giày nếu ảnh tham chiếu có hộp, nếu không có hộp thì đặt trên giá đỡ theo reference giadegiay-display-stand-reference.webp; giữ chính xác 100% màu sắc, form dáng, chất liệu, đế, quai/dây, logo/chữ có sẵn, charm, họa tiết, đường may và tỉ lệ sản phẩm theo ảnh tham chiếu. Yêu cầu bố cục tay cầm: ${TEMPLATE3_PANEL1_HANDHELD_COMPOSITION} Tone & Mood: nhanh, chân thực, thương mại, quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da tay thật, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI. ${TEMPLATE3_PANEL1_CHOREOGRAPHY} Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark, không lộ mặt người.`
          ));
        } else {
          normalizedPrompts.push(normalizePrompt(
            `Tạo video review giày dép faceless 8 giây. VISUAL: Cảnh POV top-down / first-person nhìn từ trên xuống đôi chân đang mang sản phẩm trong đúng cùng shop giày dép, ${item.visualDescription}; người mẫu đang ngồi yên hoặc đứng yên một chỗ, tuyệt đối không đi lại; giữ đúng màu sắc, form dáng, chất liệu, đế, quai/dây, logo/chữ có sẵn, charm/chi tiết trang trí và tỉ lệ sản phẩm 100% theo ảnh tham chiếu. Quy tắc tất/chân trần: ${TEMPLATE3_PANEL2_SOCK_RULES} Tone & Mood: tự nhiên, shop try-on, thời trang, quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da chân thật, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI. ${TEMPLATE1_PANEL2_CHOREOGRAPHY} Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark, không lộ mặt người.`
          ));
        }
      } else if (useTemplate2) {
        const sceneDef = TEMPLATE2_SCENES[idx];
        normalizedPrompts.push(normalizePrompt(
          `Tạo video review giày dép 4 giây. VISUAL: ${item.visualDescription}. ` +
          `Tone & Mood: chân thực, thời trang, sạch, thương mại. ` +
          `Quy tắc bắt buộc Panel ${idx + 1}: ${sceneDef.goal}. ${sceneDef.choreography} ` +
          `Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark.`
        ));
      } else {
        normalizedPrompts.push(normalizePrompt(
          `Create an 8-second Vietnamese fashion review video. VISUAL: ${item.visualDescription}. ` +
          `Tone & Mood: premium, clear, engaging. Action: 0s-4s ${item.cameraAction}; ` +
          `5s-8s show product detail and model reaction. Script nhan vat: "${item.voiceOver}"`
        ));
      }
    }
  }

  return {
    ...data,
    script: normalizedScript,
    veo3Prompts: normalizedPrompts,
    analysis: {
      ...rawAnalysis,
      ...productMetadata,
    },
    sceneContext: (useTemplate1 || useTemplate2 || useTemplate3) ? (typeof data.sceneContext === 'object' && data.sceneContext ? data.sceneContext : {}) : data.sceneContext,
    productSupportPlan: useTemplate3 ? (typeof data.productSupportPlan === 'object' && data.productSupportPlan ? data.productSupportPlan : {}) : data.productSupportPlan,
    outfitPlan: (useTemplate1 || useTemplate2 || useTemplate3) ? (typeof data.outfitPlan === 'object' && data.outfitPlan ? data.outfitPlan : {}) : data.outfitPlan,
    frameData: data.frameData || '',
    cropTemplate: data.cropTemplate || '',
  };
}

// ─── Main run function ────────────────────────────────────────────────────────

/**
 * Run the full storyboard generation pipeline.
 * @param {object} request   - Same format as Python bridge input JSON
 * @param {string} workDir   - Working directory for temporary files
 * @returns {Promise<object>} - Same format as Python bridge output JSON
 */
async function generateAnalysisJson(client, options, fileData) {
  const maxAttempts = parseInt(process.env.GEMINI_WEBAPI_ANALYSIS_MAX_RETRIES || '3', 10);
  const basePrompt = buildAnalysisPrompt(options);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const retryLine = attempt === 1
      ? ''
      : '\n\nYour previous response was not valid parseable JSON. Return the complete JSON object only, with all strings properly escaped and all braces/arrays closed.';

    const analysisResult = await client.generateContent({
      prompt: basePrompt + retryLine,
      fileData,
      temporary: true,
    });

    try {
      return parseJsonObject(analysisResult.text || '');
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      const delay = PANEL_RETRY_DELAY_MS * attempt;
      log(`Analysis JSON parse failed (attempt ${attempt}/${maxAttempts}); retrying in ${Math.round(delay / 1000)}s...`);
      await sleep(delay);
    }
  }

  throw lastError;
}

async function run(request, workDir) {
  const secure1Psid = (process.env.GEMINI_SECURE_1PSID || '').trim();
  const secure1Psidts = (process.env.GEMINI_SECURE_1PSIDTS || '').trim();
  const cookieFilePath = process.env.GEMINI_COOKIE_PATH
    ? path.resolve(process.env.GEMINI_COOKIE_PATH)
    : null;

  if (!secure1Psid) {
    throw new Error('GEMINI_SECURE_1PSID environment variable is required');
  }

  const options = request.options || {};
  const panelCount = resolvePanelCount(options);
  options.panelCount = panelCount;

  const outputDir = path.join(workDir, 'outputs');
  const inputDir = path.join(workDir, 'inputs');
  const referenceDir = path.join(workDir, 'references');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(referenceDir, { recursive: true });

  // Save input images to disk and collect metadata
  const inputFiles = [];
  for (let idx = 0; idx < (request.images || []).length; idx++) {
    const image = request.images[idx];
    const mimeType = image.mimeType || 'image/png';
    const safeName = (image.name || `image-${idx + 1}`).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || `image-${idx + 1}`;
    const ext = getMimeExt(mimeType);
    const filename = `${String(idx + 1).padStart(2, '0')}-${path.parse(safeName).name}${ext}`;
    const filePath = path.join(inputDir, filename);
    fs.writeFileSync(filePath, Buffer.from(image.base64 || '', 'base64'));
    inputFiles.push({ filePath, filename, mimeType, buffer: fs.readFileSync(filePath) });
  }

  if (inputFiles.length === 0) {
    throw new Error('At least one input image is required');
  }

  const referenceFiles = [];
  for (let idx = 0; idx < (request.referenceAssets || []).length; idx++) {
    const asset = request.referenceAssets[idx];
    const mimeType = asset.mimeType || 'image/png';
    const safeName = (asset.name || asset.role || `reference-${idx + 1}`).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || `reference-${idx + 1}`;
    const ext = getMimeExt(mimeType);
    const filename = `${String(idx + 1).padStart(2, '0')}-${path.parse(safeName).name}${ext}`;
    const filePath = path.join(referenceDir, filename);
    fs.writeFileSync(filePath, Buffer.from(asset.base64 || '', 'base64'));
    referenceFiles.push({ filePath, filename, mimeType, buffer: fs.readFileSync(filePath), role: asset.role || '' });
  }

  const client = new GeminiApiClient({ secure1Psid, secure1Psidts, cookieFilePath });

  try {
    log('Initializing Gemini client...');
    await client.init();

    // ── 1. Upload all input images ──────────────────────────────────────────
    log(`Uploading ${inputFiles.length} image(s)...`);
    const uploadedUrls = [];
    for (const file of inputFiles) {
      const url = await client.uploadFile(file.buffer, file.filename, file.mimeType);
      uploadedUrls.push(url);
      log(`  Uploaded: ${file.filename} → ${url.slice(0, 60)}...`);
    }

    const fileData = uploadedUrls.map((url, i) => ({
      url,
      filename: inputFiles[i].filename,
      mimeType: inputFiles[i].mimeType,
    }));

    // ── 2. Analysis ─────────────────────────────────────────────────────────
    log('Generating analysis and Veo prompts...');
    const analysisPrompt = buildAnalysisPrompt(options);
    const analysisRaw = await generateAnalysisJson(client, options, fileData);
    const analysis = normalizeAnalysis(analysisRaw, panelCount, options);
    log(`Analysis done. Panels: ${analysis.script.length}, Prompts: ${analysis.veo3Prompts.length}`);

    const referenceFileData = [];
    if (referenceFiles.length > 0) {
      log(`Uploading ${referenceFiles.length} reference asset(s) after analysis...`);
      for (const file of referenceFiles) {
        const url = await client.uploadFile(file.buffer, file.filename, file.mimeType);
        referenceFileData.push({
          url,
          filename: file.filename,
          mimeType: file.mimeType,
        });
        log(`  Uploaded reference: ${file.filename} → ${url.slice(0, 60)}...`);
      }
    }

    // ── 3. Storyboard image ─────────────────────────────────────────────────
    log('Generating full storyboard image...');
    const storyboardPrompt = buildStoryboardPrompt(analysis, options);
    const storyboardResult = await client.generateContent({
      prompt: storyboardPrompt,
      fileData: [...fileData, ...referenceFileData],
      temporary: true,
      expectImages: true,
    });

    if (storyboardResult.images.length === 0) {
      throw new Error('Gemini did not return a storyboard image; stopping before panel generation.');
    }

    const imgBuf = await client.downloadImage(storyboardResult.images[0].url);
    const storyboardPath = path.join(outputDir, 'storyboard.png');
    fs.writeFileSync(storyboardPath, imgBuf);
    const storyboardB64 = imgBuf.toString('base64');
    log(`Storyboard saved: ${storyboardPath}`);

    // ── 4. Panel images (PARALLEL) ────────────────────────────────────────────
    // Dùng chung 1 client cho tất cả panels — APIRequestContext xử lý concurrent
    // requests tốt. Mỗi request đã có reqid và uuidVal riêng nên không conflict.
    const panelConcurrency = Math.min(
      panelCount,
      Math.max(1, parseInt(process.env.GEMINI_WEBAPI_PANEL_CONCURRENCY || String(panelCount), 10))
    );
    log(`Generating ${panelCount} panel image(s) in parallel (concurrency=${panelConcurrency})...`);

    // Upload storyboard 1 lần, dùng chung cho tất cả panels.
    const sbBuf = fs.readFileSync(storyboardPath);
    const sbUrl = await client.uploadFile(sbBuf, 'storyboard.png', 'image/png');
    const panelFileData = [
      { url: sbUrl, filename: 'storyboard.png', mimeType: 'image/png' },
      ...referenceFileData,
    ];
    const panelImagePrompts = Array.from({ length: panelCount }, () => null);

    /**
     * Generate one panel image using the shared client.
     * @param {number} idx  0-based panel index
     */
    async function generatePanelParallel(idx) {
      const panelIndex = idx + 1;
      const prompt = analysis.veo3Prompts[idx];
      let lastError;

      for (let attempt = 1; attempt <= PANEL_MAX_RETRIES; attempt++) {
        const startedAt = Date.now();
        log(`[Panel ${panelIndex}] Requesting image (attempt ${attempt}/${PANEL_MAX_RETRIES})...`);

        try {
          const panelPrompt = buildPanelPrompt(
            !!storyboardPath,
            panelIndex,
            panelCount,
            analysis.script[idx],
            prompt,
            options
          );
          panelImagePrompts[idx] = panelPrompt;
          const result = await client.generateContent({
            prompt: panelPrompt,
            fileData: panelFileData,
            temporary: true,
            expectImages: true,
          });
          log(`[Panel ${panelIndex}] Image response received after ${Math.round((Date.now() - startedAt) / 1000)}s; downloading...`);

          const imgBuf = await client.downloadImage(result.images[0].url);
          const panelPath = path.join(outputDir, `panel-${panelIndex}.png`);
          fs.writeFileSync(panelPath, imgBuf);
          log(`[Panel ${panelIndex}] Done after ${Math.round((Date.now() - startedAt) / 1000)}s`);

          return {
            index: panelIndex,
            prompt,
            imageBase64: imgBuf.toString('base64'),
            mimeType: 'image/png',
            sourcePath: panelPath,
          };
        } catch (error) {
          lastError = error;
          if (attempt >= PANEL_MAX_RETRIES) break;
          const delay = PANEL_RETRY_DELAY_MS * attempt;
          log(`[Panel ${panelIndex}] Attempt ${attempt} failed after ${Math.round((Date.now() - startedAt) / 1000)}s: ${error.message}. Retrying in ${Math.round(delay / 1000)}s...`);
          await sleep(delay);
        }
      }

      throw lastError;
    }

    // ── Concurrency pool ──────────────────────────────────────────────────────
    const allIndices = Array.from({ length: panelCount }, (_, i) => i);
    const panelResults = [];

    for (let start = 0; start < panelCount; start += panelConcurrency) {
      const batch = allIndices.slice(start, start + panelConcurrency);
      log(`Starting panel batch [${batch.map(i => i + 1).join(', ')}]...`);

      const settled = await Promise.allSettled(batch.map(idx => generatePanelParallel(idx)));

      for (let bi = 0; bi < settled.length; bi++) {
        const panelIndex = batch[bi] + 1;
        if (settled[bi].status === 'fulfilled') {
          panelResults.push(settled[bi].value);
        } else {
          log(`[Panel ${panelIndex}] ❌ Failed: ${settled[bi].reason?.message}`);
          panelResults.push({
            index: panelIndex,
            prompt: analysis.veo3Prompts[batch[bi]],
            error: settled[bi].reason?.message,
          });
        }
      }
    }

    const panels = panelResults.filter(p => !p.error);
    panels.sort((a, b) => a.index - b.index);

    return {
      analysis: analysis.analysis || {},
      script: analysis.script,
      sceneContext: analysis.sceneContext || null,
      productSupportPlan: analysis.productSupportPlan || null,
      outfitPlan: analysis.outfitPlan || null,
      frameData: analysis.frameData || '',
      cropTemplate: analysis.cropTemplate || '',
      veo3Prompts: analysis.veo3Prompts,
      storyboard: {
        imageBase64: storyboardB64,
        mimeType: storyboardB64 ? 'image/png' : null,
        sourcePath: storyboardPath,
      },
      debugPrompts: {
        analysisPrompt,
        storyboardPrompt,
        panelImagePrompts,
        veo3Prompts: analysis.veo3Prompts,
      },
      panels,
    };

  } finally {
    try { await client.close(); } catch (_) { }
  }
}

module.exports = { run };
