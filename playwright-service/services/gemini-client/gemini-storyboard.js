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
const { buildCartCtaPromptGuide, getCartAnchorText } = require('../cart-cta');

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
  const rawCTA = source.cartAnchorText || source.cartCTA;
  const cartAnchorText = (rawCTA && typeof rawCTA === 'string' && rawCTA.trim())
    ? rawCTA.trim().slice(0, 30)
    : getCartAnchorText({ title: productName }, { category: category || 'fashion', productName });
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

  return { productName, hashtags, cartAnchorText };
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
  if (isTemplate3(options)) return 3;
  return parseInt(options.panelCount || 4, 10);
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
- All 3 panels MUST share the same shoe shop background style as shown in the provided reference images (template3-scene1-*-reference, canh3-reference).
- The shop background includes: warm-toned wooden shelves, orange/blue Nike/New Balance shoe boxes, beige/cream tiled floor, warm ceiling lights, storefront window light, wooden counters/display tables.
- The shop reference is a background/context reference only. It is NOT the product, NOT a product box, and NOT a foreground prop.
- All 3 storyboard panels should feel like they were shot in the same shop: coherent shelves, shoe displays, floor/counter surfaces, retail density, and mixed shop lighting.
- The shop background must remain secondary and clean; do not let shelves, boxes, signs, people, or props cover or compete with the footwear product.
- Do not copy any watermark, logo, signage text, UI, price tag, or readable store text from the shop reference into the generated image.
- Only the product (shoe/sandal) changes based on uploaded images; the background, pose, camera angle, and setting remain consistent with the references.
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
Hành động cảnh 1 (8 giây — cầm tay trên quầy gỗ, nghiêng cổ tay nhẹ nhàng, tuyệt đối không lật giày):
Bàn tay luôn giữ chắc cố định ở dưới đế giày trong suốt video, chiếc giày gắn liền theo bàn tay, không tự xoay tròn hay lật đảo độc lập, chỉ nghiêng cổ tay nhẹ nhàng để khoe các góc cạnh của giày:
0s-2s: Bàn tay giữ đế, nghiêng nhẹ cổ tay về phía trước để camera thấy rõ góc trên và chi tiết mũi giày.
2s-4s: Nghiêng nhẹ cổ tay sang trái góc 30 độ khoe toàn bộ thân giày bên ngoài và độ cao đế.
4s-6s: Nghiêng nhẹ cổ tay sang phải góc 30 độ khoe thân giày bên trong.
6s-8s: Nghiêng nhẹ cổ tay về phía sau khoe gót giày và cạnh đế dưới, rồi giữ yên góc nghiêng tự nhiên kết thúc chắc chắn.
Nhịp chuyển động: Chắc chắn, mượt mà, có chủ đích, không đổi hướng bất ngờ, không biến dạng sản phẩm.
`.trim();

const TEMPLATE3_PANEL3_SCENE_REFERENCE = `
CRITICAL — Template3 side-angle scene MUST replicate the uploaded reference image "canh3-reference.jpeg" EXACTLY:
- Camera: Side-angle view from the LEFT side, roughly at waist/hip height of the seated person. Camera is about 1-1.5 meters away, facing the person's side profile.
- Person: Sitting on a TALL wooden bar stool (the stool is clearly visible — dark wood, high seat, NO backrest). The person's body from mid-torso down is visible: grey t-shirt, blue jeans, white socks, product shoes.
- Leg position: One leg hangs down naturally from the tall stool, foot flat on the floor or near the floor. The other leg may be on the stool footrest or also hanging. The stool is HIGH enough that the person's thigh is above the knee level.
- Face: CROPPED OUT above the frame — only body from approximately chest/shoulders down is visible.
- Background: Shoe store interior clearly visible BEHIND the person — shelves with shoe boxes (Nike, Adidas branded boxes in red/blue/black), storefront window with daylight, overhead track lighting, grey tiled floor.
- FORBIDDEN: Do NOT use a front-facing camera angle. Do NOT show a full face. Do NOT use a low-angle from the floor. Do NOT sit on a regular chair or bench (must be a TALL bar stool). Do NOT hide the stool.
- Only replace the shoes with the uploaded product. Everything else (stool, pose, angle, background, outfit proportions) must match the reference exactly.
`.trim();

const TEMPLATE3_PANEL3_CHOREOGRAPHY = `
Hành động cảnh 3 (4 giây — góc bên hông, ngồi ghế bar cao, động tác chân nhanh nhẹn, mượt mà và dứt khoát):
0s-2s: Bàn chân đang mang giày chạm nhẹ sàn gạch, người mẫu nhịp chân nhẹ nhàng 2 lần mượt mà để khoe độ đàn hồi êm ái của đế và form giày khi vận động.
2s-4s: Xoay nhẹ cổ chân sang một bên góc 30 độ mượt mà và dứt khoát để khoe toàn bộ cạnh bên, phom dáng và gót giày dưới ánh đèn shop, rồi giữ ổn định tự nhiên.
Chuyển động liền mạch, nhanh nhẹn, tự nhiên như khách đang thử giày thật, không giật cục, không thô cứng. Tuyệt đối không walking, không đứng dậy, không di chuyển khỏi ghế.
`.trim();

const TEMPLATE3_PANEL4_SCENE_REFERENCE = `
CRITICAL — Template3 standing try-on scene MUST replicate the standing try-on pose in the shop aisle:
- Camera: Standing eye/chest level, looking at model from chest/waist down to feet (faceless, no face visible).
- Model is standing in the middle of the shop aisle, body and feet slightly turned toward the camera/viewer to showcase the footwear silhouette, fit, and outfit.
- Shoes on feet, clean socks, natural fabric folds on trousers.
- Shoe store shelves, display columns, shoe boxes, storefront window visible behind.
- FORBIDDEN: full face, walking, low-angle, watermark, text.
`.trim();

const TEMPLATE3_PANEL4_CHOREOGRAPHY = `
Hành động cảnh 4 (8 giây — đứng thử giày trong lối đi shop, hai chân đặt phẳng trên sàn, tuyệt đối cấm nhón chân, cấm nhảy):
Hai bàn chân luôn đặt phẳng hoàn toàn trên mặt sàn gạch trong suốt video, tuyệt đối không nhón mũi chân, không nhấc gót, không nhảy:
0s-2.5s: Đứng thẳng tại chỗ với hai bàn chân đặt phẳng trên sàn gạch, xoay nhẹ thân người sang trái góc 20 độ khoe dáng giày bên ngoài và phom quần.
2.5s-5.5s: Xoay nhẹ thân người sang phải góc 20 độ, hai bàn chân vẫn đặt phẳng trên sàn gạch, khoe mặt giày bên trong.
5.5s-8s: Chân phải trượt nhẹ sang bên nửa bước giữ bàn chân phẳng bám sát sàn gạch, đứng thẳng vững chãi tạo dáng tự tin trước gương shop khoe trực diện tổng thể form dáng giày và outfit.
Tuyệt đối cấm nhảy, không nhón gót, không jumping, không hopping, không walking rời khung hình, không lộ mặt người.
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
- ${buildCartCtaPromptGuide()}

JSON schema:
{
  "analysis": {
    "productName": "Vietnamese product name inferred from the images",
    "cartAnchorText": "Câu CTA giỏ hàng ngắn gọn dưới 30 ký tự khớp chính xác sản phẩm (ví dụ: Mang siêu êm mua ở đây, Giày êm chân mua ở đây...)",
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

IMPORTANT — PANEL 2/3 SOCK / BAREFOOT LOGIC:
${TEMPLATE3_PANEL2_SOCK_RULES}

IMPORTANT — PANEL 2 SCENE REFERENCE (side angle bar stool):
${TEMPLATE3_PANEL3_SCENE_REFERENCE}

IMPORTANT — PANEL 3 SCENE REFERENCE (standing try-on in aisle):
${TEMPLATE3_PANEL4_SCENE_REFERENCE}

Requirements:
- Template: template3 faceless footwear shop review.
- Category: ${category}
- Panel count: exactly 3.
- Scene ratio for each panel: ${sceneRatio}.
- Use the uploaded product reference images as the source of truth for product type, color, material, sole, straps/laces, logo/text, silhouette, charm, pattern, stitching, and styling.
- All 3 panels MUST share the same shoe shop background style as the reference images. Only the product (shoe/sandal) changes based on uploaded images.
- Scene context must be a real footwear shop / shoe store interior matching the reference images. Do not choose a home, bedroom, living room, cafe, beach, street, or studio.
- All 3 panels must share the exact same shop setting, surface/floor logic, background shelves, color palette, mood, and lighting plan.
- Randomly choose ONE outfit styling direction for the faceless wearer in Panel 2 and Panel 3. The outfit must fit the footwear, shop setting, inferred gender/styling, and retail try-on context.
- Faceless only: no visible faces, no talking host, no presenter. You may show hands, forearms, feet, lower legs, torso, or cropped outfit/body parts only.
- Panel 1 (8 seconds) composition: top-down smartphone camera from above, one shoe/sandal held by a realistic hand, the matching other stationary below/on the product base. Use "template3-scene1-shoebox-reference.png" if shoe box visible, or "template3-scene1-stand-reference.png" if not.
- Panel 1 hand pose is mandatory: the hand grips the product firmly at the sole edge and side body, tilted 15-30 degrees.
- Panel 1 product base rule: if product reference images clearly show a matching shoe box, use that box; otherwise use the display stand reference.
- Panel 2 (4 seconds) composition: side-angle camera view; person sitting on a tall bar stool in the same shop; camera from the side captures leg, shoe, stool, and part of body; faceless. Match reference "canh3-reference.jpeg" exactly for composition, pose, and camera angle. Only replace the product.
- Panel 2 sock logic is mandatory: if closed-toe footwear, wear appropriate socks; if open sandal/slide/slipper, barefoot.
- Panel 3 (8 seconds) composition: standing try-on pose in shop aisle; model standing with body and feet turned toward camera to show footwear fit and outfit; faceless from chest/waist down. Match shop aisle context.
- Panel 3 sock logic same as Panel 2.
- No voice-over, no dialogue, no subtitles, no captions, no UI, no price, no rating, no watermark.
- Product identity must remain consistent across all 3 panels.
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
    "location": "footwear shop matching the reference images",
    "timeOfDay": "shop time/lighting condition matching references",
    "lighting": "mixed shop/store lighting plan with realistic shadows and no studio look",
    "mood": "authentic, fast, commercial shop review",
    "cameraCharacteristics": "smartphone 1x lens 24-28mm, Auto mode, various angles per panel, slight hand shake, no fake bokeh",
    "continuityRules": "how all 3 panels keep the same shop setting, lighting, shelf/floor logic, and product identity"
  },
  "productSupportPlan": {
    "panel1StationaryBase": "use visible matching shoe box from reference OR use giadegiay-display-stand-reference.webp if no box is visible",
    "panel1ReferenceImage": "template3-scene1-shoebox-reference.png OR template3-scene1-stand-reference.png",
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
      "visualDescription": "top-down smartphone shop-review layout matching scene1 reference: one shoe/sandal held large in the foreground by a realistic hand gripping the sole edge and side body, tilted 15-30 degrees; the matching stationary shoe stays smaller below/background on the product base; footwear shop shelves/floor visible around the surface",
      "cameraAction": "almost fixed top-down smartphone camera; movement comes from the hand: lift, wrist rotation, sole flip, close push-in, return to pair",
      "productFocus": "upper/top, side silhouette, sole tread, heel/edge, straps/laces, logo/text, charm/pattern/stitching, material texture"
    },
    {
      "id": 2,
      "duration": "00:08-00:12",
      "goal": "Side-angle bar stool try-on showcase",
      "visualDescription": "side-angle view matching canh3-reference.jpeg: person sitting on tall bar stool in same shop, camera from the side captures waist-down (t-shirt, thigh, full leg, shoe on foot), leg hangs naturally, foot touching or near floor, same shop background visible behind, faceless",
      "cameraAction": "side-angle medium shot at sitting height; slight natural camera sway; no low-angle, no orbit, no tracking, no walking",
      "productFocus": "side profile on foot, leg silhouette, shoe form during natural movement, outfit pairing, bar stool lifestyle context"
    },
    {
      "id": 3,
      "duration": "00:12-00:20",
      "goal": "Standing try-on showcase in shop aisle",
      "visualDescription": "standing try-on pose in shop aisle, camera from waist down, model standing with body and feet turned toward viewer showcasing shoe silhouette and outfit, faceless",
      "cameraAction": "straight medium shot from standing eye/chest level pointing down slightly, slight handheld natural drift",
      "productFocus": "standing profile on foot, overall footwear silhouette and proportions, outfit matching"
    }
  ],
  "frameData": "Combined detailed visual plan for exactly 3 panels, including the shared shop sceneContext, productSupportPlan, and realism direction.",
  "cropTemplate": "How to extract each panel cleanly while preserving the shop setting, composition, product support, lighting, and product identity.",
  "veo3Prompts": [
    "One single-line Vietnamese Veo 3 prompt for panel 1 without voice-over, exactly 8 seconds, top-down shop hand rotation, using the mandatory choreography.",
    "One single-line Vietnamese Veo 3 prompt for panel 2 without voice-over, exactly 4 seconds, side-angle bar stool try-on in the same shop, matching canh3-reference.jpeg composition.",
    "One single-line Vietnamese Veo 3 prompt for panel 3 without voice-over, exactly 8 seconds, standing try-on in shop aisle, faceless."
  ]
}

Important:
- Do not include a voiceOver field anywhere in the JSON.
- "script" and "veo3Prompts" must contain exactly 3 items.
- Each veo3 prompt must be one line, with no newline characters.
- Each veo3 prompt must include VISUAL, Tone & Mood.
- Each veo3 prompt must explicitly say: "Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark."
- Each veo3 prompt must include realism cues: "quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da tay/chân thật, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI."
- Panel 1 veo3 prompt MUST use this exact action choreography:
${TEMPLATE3_PANEL1_CHOREOGRAPHY}
- Panel 1 MUST follow this hand-held composition:
${TEMPLATE3_PANEL1_HANDHELD_COMPOSITION}
- Panel 1 must use the correct scene1 reference image based on shoe box presence.
- Panel 2 and Panel 3 MUST follow this footwear/sock rule:
${TEMPLATE3_PANEL2_SOCK_RULES}
- Panel 2 veo3 prompt MUST match the composition of canh3-reference.jpeg and use this choreography:
${TEMPLATE3_PANEL3_CHOREOGRAPHY}
- Panel 3 veo3 prompt MUST match the standing try-on composition and use this choreography:
${TEMPLATE3_PANEL4_CHOREOGRAPHY}
- All 3 panels must share the same shop background. Only the product changes.
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
- ${buildCartCtaPromptGuide()}

JSON schema:
{
  "analysis": {
    "productName": "Vietnamese product name inferred from the images",
    "cartAnchorText": "Câu CTA giỏ hàng ngắn gọn dưới 30 ký tự khớp chính xác sản phẩm (ví dụ: Mang siêu êm mua ở đây, Mặc tôn dáng ở đây nè...)",
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
- ${buildCartCtaPromptGuide()}

JSON schema:
{
  "analysis": {
    "productName": "Vietnamese product name inferred from the images",
    "cartAnchorText": "Câu CTA giỏ hàng ngắn gọn dưới 30 ký tự khớp chính xác sản phẩm (ví dụ: Mang siêu êm mua ở đây, Mặc tôn dáng ở đây nè, Đồ tiện ích mua ở đây...)",
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
- Each veo3 prompt must include VISUAL, Tone & Mood, Action timing 0s-4s and 5s-8s, and vietnamese voice Script.
- Each veo3 prompt MUST include smartphone realism cues: "quay bằng điện thoại, ánh sáng tự nhiên cửa sổ, bề mặt sản phẩm lì có vân khuôn, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI."`.trim();
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

PANEL 2/3 SOCK / BAREFOOT RULES:
${TEMPLATE3_PANEL2_SOCK_RULES}

PANEL 2 SCENE REFERENCE (side angle bar stool):
${TEMPLATE3_PANEL3_SCENE_REFERENCE}

PANEL 3 SCENE REFERENCE (standing try-on in aisle):
${TEMPLATE3_PANEL4_SCENE_REFERENCE}

Storyboard requirements:
- Exactly 3 panels arranged side by side in one single still image.
- Each panel frame is optimized for ${sceneRatio} aspect ratio.
- All 3 panels MUST share the same shoe shop background matching the reference images.

CRITICAL — Panel 1 MUST match scene1 reference image EXACTLY:
- Camera: TOP-DOWN angle from ABOVE looking straight down at the products on a surface/table. NOT a side view, NOT a horizontal shot.
- One shoe/sandal held by a realistic hand in the FOREGROUND (larger, closer to camera, occupying 55-70% of frame height).
- The matching OTHER shoe/sandal placed STATIONARY on: the shoe box if product reference has a box, OR on the giadegiay display stand if no box. Do NOT place it flat on a bare table/surface without the box or stand.
- The giadegiay display stand is a metal T-shaped shoe holder. Use it exactly as shown in the reference "giadegiay-display-stand-reference.webp" or "template3-scene1-stand-reference.png".
- Hand grip: fingers support outsole/side body, thumb on upper/side edge, product tilted 15-30 degrees.

CRITICAL — Panel 2 MUST match "canh3-reference.jpeg" EXACTLY:
- Camera: SIDE-ANGLE view from the LEFT side, at waist/hip height.
- Person sitting on a TALL wooden bar stool (dark wood, high seat, visible in frame).
- Visible body: grey t-shirt, blue jeans, white socks, product shoes. From mid-torso down.
- Leg hangs NATURALLY from the tall stool, foot on or near the floor.
- Face CROPPED OUT above the frame.
- Shoe store shelves, shoe boxes, storefront window visible behind.
- FORBIDDEN: front-facing angle, full face, regular chair, hidden stool.

CRITICAL — Panel 3 MUST match standing try-on pose in aisle:
- Camera: Eye/chest level looking down slightly at model from waist down to feet (faceless, no face visible).
- Model standing in shop aisle, body and feet turned toward viewer to show footwear fit and outfit.
- Natural standing pose on shop floor tiles, background display columns and shoe boxes visible.
- FORBIDDEN: full face, walking, low-angle from floor.

Additional rules:
- Panel 2 and 3 sock/barefoot logic: closed shoes require socks, open sandals/slides should be barefoot.
- Preserve product design, color, material, silhouette, logo/text, sole, straps/laces, charm, pattern, stitching, and identity from the product reference photos.
- No visible faces. Only hands, forearms, feet, lower legs, torso, or cropped outfit/body parts allowed.
- Only the product changes across panels — background, pose, camera angle remain as in references.
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

CRITICAL VISUAL DIRECTION — SMARTPHONE REALISM:
${SMARTPHONE_REALISM_FULL}

Storyboard requirements:
- Exactly ${panelCount} panels arranged side by side in one single image.
- Each panel frame is optimized for ${sceneRatio} aspect ratio.
- Show one coherent Vietnamese fashion product review photo sequence.
- Preserve product design, color, material, and identity from the reference photos.
- Use natural smartphone camera aesthetics: natural window light with gradient falloff, slight overexposure near window, realistic shadow contact. No studio lighting, no cinematic color grading.
- Product material: matte texture with visible grain, mold seam lines, stitching. NEVER glossy porcelain or smooth 3D-render finish.
- Human skin: visible pores, knuckle creases, natural tone variation. NEVER waxy/plastic skin.
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
    let panelSpecificRules;
    if (panelIndex === 1) {
      panelSpecificRules = `CRITICAL — Panel 1 MUST match scene1 reference image:
- Camera: TOP-DOWN from ABOVE, looking straight down at the products on a surface/counter. NOT a side view, NOT a horizontal shot.
- One shoe/sandal held by a realistic hand in the FOREGROUND, occupying 55-70% of panel height.
- The OTHER shoe/sandal placed STATIONARY on: shoe box (if reference has one) OR on the giadegiay metal T-shaped display stand. Do NOT place it flat on a bare surface.
- Hand grip: fingers on outsole/side body, thumb on upper/side, product tilted 15-30 degrees.
- Background: warm wooden shelves, orange/blue shoe boxes, beige tiled floor, warm ceiling lights — matching scene1 reference.
- FORBIDDEN: side-view camera, horizontal shot, face, full body, orbit composition, watermark, added text, bare table without box or stand.`;
    } else if (panelIndex === 2) {
      panelSpecificRules = `CRITICAL — Panel 2 MUST replicate "canh3-reference.jpeg" EXACTLY:
- Camera: SIDE-ANGLE from the LEFT side, at waist/hip height, 1-1.5m away.
- Person sitting on a TALL wooden bar stool (dark wood, high seat, NO backrest, stool clearly visible).
- Visible body from mid-torso down: grey t-shirt, blue jeans, socks, product shoes.
- Leg hangs NATURALLY from the tall stool, foot flat on or near floor.
- Face CROPPED OUT above frame.
- Shoe store shelves, shoe boxes, storefront window, track lighting visible behind.
- FORBIDDEN: front-facing angle, full face, regular chair/bench, hidden stool, low-angle from floor, walking.`;
    } else if (panelIndex === 3) {
      panelSpecificRules = `CRITICAL — Panel 3 MUST replicate the standing try-on pose in the shop aisle:
- Camera: Standing eye/chest level, looking at model from chest/waist down to feet (faceless, no face visible).
- Model is standing in the middle of the shop aisle, body and feet slightly turned toward the camera/viewer to showcase the footwear silhouette, fit, and outfit.
- Shoes on feet, clean socks, natural fabric folds on trousers.
- Shoe store shelves, display columns, shoe boxes, storefront window visible behind.
- FORBIDDEN: full face, walking, low-angle, watermark, text.`;
    } else {
      panelSpecificRules = `- Unknown panel index ${panelIndex}, use default shop try-on composition.`;
    }

    return `Generate a single faceless footwear shop-review photograph that looks like an authentic smartphone camera shot (still image, NOT a video).

CRITICAL VISUAL DIRECTION — TEMPLATE3 SHOP SMARTPHONE REALISM:
${TEMPLATE3_REALISM_FULL}

DISPLAY SUPPORT RULES:
${TEMPLATE3_DISPLAY_STAND_RULES}

SHOP BACKGROUND REFERENCE RULES:
${TEMPLATE3_SHOP_BACKGROUND_RULES}

PANEL 1 HANDHELD COMPOSITION RULES:
${TEMPLATE3_PANEL1_HANDHELD_COMPOSITION}

PANEL 2/3 SOCK / BAREFOOT RULES:
${TEMPLATE3_PANEL2_SOCK_RULES}

Panel: ${panelIndex} of ${panelCount}
Aspect ratio: ${sceneRatio}
Instructions:
- ${source}
- Keep the product identity exactly consistent with the product reference photo(s).
- Keep the shared footwear shop setting, mixed shop lighting, floor/shelf logic, and mood consistent with the reference images and storyboard scene.
- The photo must look like it was casually taken with a normal smartphone camera, not a professional studio photo or AI render.
- Product material must show real texture/grain/weave/seams/scuffs/fingerprints where appropriate. Never make it glossy porcelain, waxy plastic, melted, or deformed.
- Human skin must show visible pores, knuckle creases, light veins, natural skin tone variation, and correct anatomy.
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
  return `Generate a single polished fashion photograph that looks like an authentic smartphone camera shot (still image, NOT a video).

CRITICAL VISUAL DIRECTION — SMARTPHONE REALISM:
${SMARTPHONE_REALISM_FULL}

Panel: ${panelIndex} of ${panelCount}
Aspect ratio: ${sceneRatio}
Instructions:
- ${source}
- Keep the product identity exactly consistent with the reference photo(s).
- Do not include text, labels, captions, UI, or watermarks.
- Natural smartphone camera aesthetics: natural light with gradient falloff, slight overexposure, realistic shadows. No studio lights, no cinematic color grading.
- Product surface: matte texture with visible grain, seam lines, fingerprint marks. NEVER glossy porcelain or smooth render finish.
- Human skin: visible pores, knuckle creases, natural skin tone variation. NEVER waxy/plastic skin.
- Socks (if visible): slight wrinkles, compression, off-white not pure white.
- Fabric/clothing: visible weave texture, stitching, natural creases.
- Framing: slightly off-center, not perfectly aligned. Background has real-world details.
- Faint sensor noise in shadow areas, light sharpening artifacts near edges.

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
  rawAnalysis.cartAnchorText = productMetadata.cartAnchorText;

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
            `${prompt} Quy tắc bắt buộc Panel 1 / Template3: Cảnh shop giày dép, camera smartphone top-down cố định từ trên xuống, một chiếc giày/dép được tay cầm để giới thiệu, chiếc còn lại đặt cố định trên hộp giày nếu ảnh tham chiếu có hộp; nếu không có hộp thì đặt trên giá đỡ theo reference giadegiay-display-stand-reference.webp. Sản phẩm di chuyển luôn là sản phẩm đã upload từ Telegram; giá đỡ chỉ là prop. Background phải khớp hình reference scene1. ${TEMPLATE3_PANEL1_HANDHELD_COMPOSITION} ${TEMPLATE3_PANEL1_CHOREOGRAPHY} Quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da tay thật, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI. Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark, không lộ mặt người.`
          );
        } else if (idx === 1) {
          prompt = prompt
            .replace(/H[aà]nh\s+[đd][oộ]ng\s+\d+s[^.]*\./giu, '')
            .replace(/Action\s+\d+s[^.]*\./gi, '');
          prompt = normalizePrompt(
            `${prompt} Quy tắc bắt buộc Panel 2 / Template3 (4 giây): Góc camera từ bên hông trong cùng shop giày dép; bố cục PHẢI khớp hình reference canh3-reference.jpeg: ngồi trên ghế bar cao, camera từ bên cạnh, thấy phần thân dưới từ eo xuống (áo, đùi, chân, giày), chân thả lỏng tự nhiên, faceless. Chỉ thay sản phẩm giày/dép, giữ nguyên background shop. ${TEMPLATE3_PANEL2_SOCK_RULES} ${TEMPLATE3_PANEL3_CHOREOGRAPHY} Quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da chân thật, nếp gấp quần tự nhiên, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI. Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark, không lộ mặt người.`
          );
        } else if (idx === 2) {
          prompt = prompt
            .replace(/H[aà]nh\s+[đd][oộ]ng\s+\d+s[^.]*\./giu, '')
            .replace(/Action\s+\d+s[^.]*\./gi, '');
          prompt = normalizePrompt(
            `${prompt} Quy tắc bắt buộc Panel 3 / Template3 (8 giây): Người mẫu đứng tạo dáng thử giày trong lối đi shop, góc máy từ thắt lưng trở xuống thấy toàn bộ chân và giày (faceless). Xoay nhẹ người và bàn chân về hướng camera khoe dáng. ${TEMPLATE3_PANEL2_SOCK_RULES} ${TEMPLATE3_PANEL4_CHOREOGRAPHY} Quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da chân thật, nếp gấp quần tự nhiên, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI. Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark, không lộ mặt người.`
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
            `Tạo video review giày dép faceless dài đúng 8 giây. VISUAL: Camera smartphone top-down nhìn từ trên xuống trong shop giày dép chân thực; ${item.visualDescription}; background phải khớp hình reference scene1; một chiếc được tay cầm giới thiệu, chiếc còn lại đặt cố định trên hộp giày nếu ảnh tham chiếu có hộp, nếu không có hộp thì đặt trên giá đỡ; giữ chính xác 100% màu sắc, form dáng, chất liệu, đế, quai/dây, logo/chữ có sẵn, charm, họa tiết, đường may và tỉ lệ sản phẩm theo ảnh tham chiếu. Yêu cầu bố cục tay cầm: ${TEMPLATE3_PANEL1_HANDHELD_COMPOSITION} Tone & Mood: nhanh, chân thực, thương mại, quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da tay thật, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI. ${TEMPLATE3_PANEL1_CHOREOGRAPHY} Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark, không lộ mặt người.`
          ));
        } else if (idx === 1) {
          normalizedPrompts.push(normalizePrompt(
            `Tạo video review giày dép faceless dài đúng 4 giây. VISUAL: Góc camera từ bên hông/cạnh trong shop giày dép; bố cục PHẢI khớp hình reference canh3-reference.jpeg: ngồi trên ghế bar/stool cao, camera từ bên cạnh, thấy phần thân dưới từ eo xuống (áo, đùi, chân, giày), chân thả lỏng tự nhiên, faceless; ${item.visualDescription}; chỉ thay sản phẩm giày/dép, giữ nguyên background shop; giữ đúng màu sắc, form dáng, chất liệu, đế, quai/dây, logo/chữ có sẵn, charm/chi tiết trang trí và tỉ lệ sản phẩm 100% theo ảnh tham chiếu. Quy tắc tất/chân trần: ${TEMPLATE3_PANEL2_SOCK_RULES} Tone & Mood: tự nhiên, shop try-on, quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da chân thật, nếp gấp quần tự nhiên, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI. ${TEMPLATE3_PANEL3_CHOREOGRAPHY} Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark, không lộ mặt người.`
          ));
        } else if (idx === 2) {
          normalizedPrompts.push(normalizePrompt(
            `Tạo video review giày dép faceless dài đúng 8 giây. VISUAL: Người mẫu đứng tạo dáng thử giày trong lối đi shop; thấy phần thân dưới từ thắt lưng trở xuống (áo, quần, chân, giày), faceless; ${item.visualDescription}; chỉ thay sản phẩm giày/dép, giữ nguyên background shop; giữ đúng màu sắc, form dáng, chất liệu, đế, quai/dây, logo/chữ có sẵn, charm/chi tiết trang trí và tỉ lệ sản phẩm 100% theo ảnh tham chiếu. Quy tắc tất/chân trần: ${TEMPLATE3_PANEL2_SOCK_RULES} Tone & Mood: tự nhiên, shop try-on, quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da chân thật, nếp gấp quần tự nhiên, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI. ${TEMPLATE3_PANEL4_CHOREOGRAPHY} Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark, không lộ mặt người.`
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
          `Tone & Mood: chân thực, thời trang, sạch, thương mại, quay bằng điện thoại, ánh sáng tự nhiên, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI, chất liệu sản phẩm có texture tự nhiên. ` +
          `Action: 0s-4s ${item.cameraAction}; ` +
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
