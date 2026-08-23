const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createFlowPage, closeFlowPage } = require('./browser');
const { prepareGeneration, executeGeneration } = require('./image');
const { generateVideosFromPanelsDirect } = require('./gemini-webapi-storyboard');
const { GeminiApiClient } = require('./gemini-client/gemini-api');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safeBaseName(filePath, fallback = 'image') {
  const base = path.basename(filePath || fallback).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base || fallback;
}

function getRandomMicroDetails(template = 'template3') {
  if (template === 'template4') {
    const boxVariations = [
      'neatly stacked chic pastel pink, dusty rose, and minimalist white shoe boxes under the gold display shelving',
      'blush pink and cream white designer shoe boxes arranged with boutique elegance',
      'a mix of soft coral pink, blush, and off-white shoeboxes with subtle ribbons and labels',
      'clean arrangement of pastel pink shoeboxes on lower shelves with boutique lighting',
    ];

    const floorShoeVariations = [
      'clean light grey tiled boutique floor with gold frame shelving and dusty rose velvet try-on bench',
      'spotless boutique floor tiles with elegant sample try-on footwear displayed on gold stands',
      'tidy boutique floor with try-on samples neatly organized on lower gold display ledges',
      'chic pastel boutique setting with shoes neatly displayed on gold stands and pink bench',
    ];

    const shopperVariations = [
      'a female customer in a casual summer dress browsing shoe shelves near the glass storefront',
      'a shopper browsing the upper boutique display racks in the soft-focus background',
      'a peaceful boutique atmosphere with natural daylight filtering through the front window',
      'a quiet moment in the pastel boutique looking toward the bright storefront entrance',
    ];

    const boxes = boxVariations[Math.floor(Math.random() * boxVariations.length)];
    const floorShoes = floorShoeVariations[Math.floor(Math.random() * floorShoeVariations.length)];
    const shopper = shopperVariations[Math.floor(Math.random() * shopperVariations.length)];

    return { boxes, floorShoes, shopper };
  }

  const boxVariations = [
    'randomized stacking of orange, cobalt blue, classic red, and matte black shoe boxes on the display shelves',
    'neatly organized kraft brown, minimalist white, and vibrant red shoe boxes arranged with realistic variety',
    'a mix of heritage green, deep navy, bright orange, and black brand shoeboxes stacked with slight natural offsets',
    'clean arrangement of monochrome black-and-white and neutral craft shoeboxes on the shelving units'
  ];

  const floorShoeVariations = [
    'clean tiled aisle floor with 1-2 try-on sample sneakers resting naturally near the base of the center rack',
    'clean, unobstructed floor tiles with a single display shoe resting neatly on a lower display ledge',
    'a pair of lifestyle casual shoes set aside on the floor near the display column',
    'spotless and tidy boutique floor tiles with footwear neatly confined to display stands and shelves'
  ];

  const shopperVariations = [
    'a customer in a casual dark hoodie and shorts browsing shoe boxes near the rear glass window',
    'a shopper in a light casual shirt browsing sneakers in the distant background aisle',
    'a person browsing the upper shelf displays in the soft-focus background',
    'a quiet moment in the boutique with clear depth of field looking toward the bright storefront entrance'
  ];

  const boxes = boxVariations[Math.floor(Math.random() * boxVariations.length)];
  const floorShoes = floorShoeVariations[Math.floor(Math.random() * floorShoeVariations.length)];
  const shopper = shopperVariations[Math.floor(Math.random() * shopperVariations.length)];

  return { boxes, floorShoes, shopper };
}

async function cleanPanelWatermark(baseDir, panelPath) {
  if (!fs.existsSync(panelPath)) return null;

  // 1. Try cleaning with Gemini API first if configured
  try {
    const secure1Psid = process.env.GEMINI_SECURE_1PSID;
    const secure1Psidts = process.env.GEMINI_SECURE_1PSIDTS;
    const cookieFilePath = path.join(baseDir, 'gemini.cookies.json');

    if (secure1Psid) {
      console.log(`[GoogleFlowStoryboard] Inpainting & removing watermark on ${path.basename(panelPath)} via Gemini API...`);
      const client = new GeminiApiClient({
        secure1Psid,
        secure1Psidts,
        cookieFilePath: fs.existsSync(cookieFilePath) ? cookieFilePath : undefined
      });

      await client.init();
      const imgBuf = fs.readFileSync(panelPath);
      const uploadedUrl = await client.uploadFile(imgBuf, path.basename(panelPath), 'image/png');

      const cleanPrompt = `Edit this image to remove the subtle logo/watermark in the bottom right corner.
Preserve 100% of the subject, the model's body, trousers, shoes, socks, the store background, wooden shelves, and the floor tiles completely unchanged.
Only inpaint and restore the natural floor tile texture in the bottom right corner so there is NO watermark, NO logo, NO symbol, and NO text.
Return the exact same image cleaned.`;

      const result = await client.generateContent({
        prompt: cleanPrompt,
        fileData: [{ url: uploadedUrl, filename: path.basename(panelPath), mimeType: 'image/png' }],
        temporary: true,
        expectImages: true,
      });

      if (result.images && result.images.length > 0) {
        const cleanImgBuf = await client.downloadImage(result.images[0].url);
        fs.writeFileSync(panelPath, cleanImgBuf);
        console.log(`[GoogleFlowStoryboard] ✅ Cleaned watermark via Gemini API and replaced ${path.basename(panelPath)}!`);
        try { await client.close(); } catch (_) {}
        return cleanImgBuf.toString('base64');
      }
      try { await client.close(); } catch (_) {}
    }
  } catch (geminiErr) {
    console.warn(`[GoogleFlowStoryboard] Gemini API watermark cleaning fallback: ${geminiErr.message}`);
  }

  // 2. Fallback to high-precision FFmpeg delogo inpainting filter
  try {
    console.log(`[GoogleFlowStoryboard] Cleaning bottom-right watermark on ${path.basename(panelPath)} via FFmpeg inpaint filter...`);
    const tmpCleanPath = path.join(path.dirname(panelPath), `clean-${Date.now()}-${path.basename(panelPath)}`);
    const cmd = `ffmpeg -y -i "${panelPath}" -vf "delogo=x=645:y=1245:w=100:h=100" "${tmpCleanPath}"`;
    execSync(cmd, { stdio: 'pipe' });

    if (fs.existsSync(tmpCleanPath)) {
      const cleanBuf = fs.readFileSync(tmpCleanPath);
      fs.writeFileSync(panelPath, cleanBuf);
      fs.unlinkSync(tmpCleanPath);
      console.log(`[GoogleFlowStoryboard] ✅ Watermark cleaned and replaced on ${path.basename(panelPath)}!`);
      return cleanBuf.toString('base64');
    }
  } catch (ffmpegErr) {
    console.warn(`[GoogleFlowStoryboard] FFmpeg delogo filter skipped: ${ffmpegErr.message}`);
  }

  return null;
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

function normalizeFootwearHashtags(parsed, isTemplate4) {
  const provided = Array.isArray(parsed.hashtags) ? parsed.hashtags : (Array.isArray(parsed.analysis?.hashtags) ? parsed.analysis.hashtags : []);
  const pName = parsed.productName || parsed.analysis?.productName || '';
  const brand = parsed.brand || parsed.analysis?.brand || '';
  const category = parsed.category || (isTemplate4 ? 'guocnu' : 'sneaker');

  const defaultPool = isTemplate4
    ? ['#GuocNu', '#GiayCaoGot', '#SandalNu', '#ReviewGiayNu', '#TikTokShopVN', '#OOTDFashion', '#TrendingVN']
    : ['#GiaySneaker', '#GiayTheThao', '#ReviewGiay', '#SneakerVN', '#TikTokShopVN', '#StreetwearVN', '#TrendingVN'];

  const fallbacks = [
    brand,
    pName,
    category,
    ...defaultPool,
  ];

  const tags = [];
  for (const item of [...provided, ...fallbacks]) {
    const norm = normalizeHashtag(item) || slugToHashtag(item);
    if (norm && norm.length > 2 && !tags.some(t => t.toLowerCase() === norm.toLowerCase())) {
      tags.push(norm);
    }
    if (tags.length === 5) break;
  }

  while (tags.length < 5) {
    tags.push(defaultPool[tags.length] || `#sanpham${tags.length + 1}`);
  }

  return tags;
}

async function analyzeProductFootwear(geminiClient, filePayloads, isTemplate4) {
  try {
    const uploadedFiles = [];
    for (let i = 0; i < Math.min(filePayloads.length, 3); i++) {
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

    if (uploadedFiles.length === 0) throw new Error('No files to analyze');

    const prompt = `TEXT-ONLY TASK. Do not generate images.
You are a footwear fashion expert, e-commerce OCR analyst, and TikTok content strategist.
Analyze the uploaded footwear product image(s) or e-commerce screenshots with extreme precision.

CRITICAL INSTRUCTIONS:
1. OCR / Text Extraction: Read ALL text, product titles, search keywords, shop names, and captions visible in the images/screenshots (e.g. from Shopee, TikTok Shop, Lazada, product boxes, or catalog listings).
2. Extract exact product name in Vietnamese (e.g. "Giày Sneaker Thể Thao Nam Nữ Cổ Thấp Trắng Đen", "Guốc Nữ Quai Trong Gót Vuông 5cm Đính Đá").
3. Extract Brand name if visible (e.g. Nike, MLB, Adidas, Vascara, Juno, hoặc thương hiệu trên ảnh).
4. Extract or generate EXACTLY 5 high-converting, trending hashtags starting with "#". Prioritize any hashtags/keywords visible in the screenshots, brand name, specific shoe model, and relevant TikTok trending tags.

Return ONLY valid JSON with this schema:
{
  "productName": "Tên sản phẩm tiếng Việt đầy đủ và chính xác từ ảnh/tiêu đề e-commerce",
  "brand": "Tên thương hiệu nếu có",
  "category": "sneaker|heels|sandals|boots|loafers|mules|slippers|other",
  "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
  "colorway": "Màu sắc chính của sản phẩm",
  "keyFeatures": "Đặc điểm nổi bật (quai, đế, chất liệu, phụ kiện đính kèm)"
}`;

    const res = await geminiClient.generateContent({
      prompt,
      fileData: uploadedFiles,
      temporary: true,
      expectImages: false,
    });

    let cleaned = (res.text || '').trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    }
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      const pName = parsed.productName || (isTemplate4 ? 'Guốc / Giày Nữ Thời Trang' : 'Giày Thể Thao Sneaker');
      const hashtags = normalizeFootwearHashtags(parsed, isTemplate4);
      console.log(`[GoogleFlowStoryboard] ✅ Footwear analyzed: "${pName}"`);
      console.log(`[GoogleFlowStoryboard] Hashtags: ${hashtags.join(' ')}`);
      return {
        productName: pName,
        brand: parsed.brand || '',
        category: parsed.category || 'footwear',
        hashtags,
        colorway: parsed.colorway || '',
        keyFeatures: parsed.keyFeatures || '',
      };
    }
  } catch (err) {
    console.warn(`[GoogleFlowStoryboard] ⚠️ Footwear analysis fallback: ${err.message}`);
  }

  const fallbackHashtags = normalizeFootwearHashtags({}, isTemplate4);
  return {
    productName: isTemplate4 ? 'Guốc Nữ / Giày Sandal Cao Gót Thời Trang' : 'Giày Thể Thao Sneaker Thời Trang',
    brand: '',
    category: 'footwear',
    hashtags: fallbackHashtags,
  };
}

function buildTemplate3Prompt(customOutfit = null) {
  const details = getRandomMicroDetails('template3');

  const outfitInstruction = customOutfit
    ? `Change the wearer's clothing in Panel 2, Panel 3, and Panel 4 to: ${customOutfit}.`
    : `Analyze the uploaded footwear product style, category, and colorway, then adapt the wearer's pants/trousers in Panel 2, Panel 3, and Panel 4 to a stylish, matching outfit (e.g. relaxed light beige/khaki chinos, linen trousers, charcoal tailored pants, or casual denim) that best complements this specific footwear.`;

  return `A realistic 4-panel horizontal split storyboard image (9:16 vertical ratio for each panel arranged side-by-side in a single wide collage) for a footwear review inside the EXACT footwear shop setting from the reference storyboard image.

- Environment Continuity & Natural Micro-Variations:
  + PRESERVE the exact shop architecture, square cream and charcoal floor tiles, wooden counter in Panel 1, tall wooden bar stool in Panel 3, black track lighting, and shop aisles from the reference storyboard image.
  + INTRODUCE NATURAL VARIATIONS in background micro-details:
    * Shoe Boxes on shelves: ${details.boxes}.
    * Display & Floor footwear: ${details.floorShoes}.
    * Background atmosphere: ${details.shopper}.

- Footwear Replacement (Source of Truth):
  + In all 4 panels, REPLACE the footwear with the EXACT product design, colorway, upper materials (leather/canvas/suede/mesh), sole thickness, laces/straps, and logo details from the uploaded product reference images.

- Outfit & Footwear Styling:
  + ${outfitInstruction}
  + Footwear logic: If closed-toe shoes/sneakers/loafers, wear clean neutral or off-white socks with natural folds. If sandals/slides/slippers/open-toe, feature natural bare feet with realistic skin texture.

- 4-Panel Composition (Locked to reference layout):
  + Panel 1 (Leftmost): Top-down overhead angle over the shop wooden counter. A realistic human hand supports and tilts one shoe from underneath the sole at a 20-degree angle; the matching second shoe rests neatly below on the display stand. Both shoes completely within frame.
  + Panel 2 (Second from left): First-person chest POV looking down at relaxed extended legs wearing the footwear on the shop tiled floor.
  + Panel 3 (Third from left): Side profile view of the wearer sitting on the tall wooden bar stool in the same shop, showing the trousers, legs, and matching footwear.
  + Panel 4 (Rightmost): Standing try-on pose in the exact same shop aisle. The model is standing faceless (camera framed from chest/waist down to feet), body and feet slightly turned toward the camera/viewer to showcase the footwear silhouette and fit from a standing perspective.

- Atmosphere & Realism: Authentic smartphone photography in a real footwear boutique, warm shop lighting, real skin textures with visible pores, genuine fabric and leather folds, no CGI, no AI plastic shine, no studio rim light.
- Strictly faceless, no visible faces, no text, no captions, no watermarks, no UI elements.`;
}

function buildTemplate4Prompt(customOutfit = null) {
  const details = getRandomMicroDetails('template4');

  const outfitInstruction = customOutfit
    ? `Change the wearer's clothing in Panel 2, Panel 3, and Panel 4 to: ${customOutfit}.`
    : `Chic pastel pink ribbed short-sleeve top + cream/white pleated tennis/A-line skirt + small beige crossbody shoulder bag with gold chain. Delicate female hands and slender bare legs, clean manicured nails with soft nude/pink polish, delicate gold bracelet on wrist.`;

  return `A realistic 4-panel horizontal split storyboard image (9:16 vertical ratio for each panel arranged side-by-side in a single wide collage) for a women's footwear review inside the EXACT pastel pink boutique shoe shop setting from the reference storyboard image.

- Environment Continuity & Natural Micro-Variations:
  + PRESERVE the exact chic boutique shop architecture, large light grey/beige square floor tiles, gold metal frame shelving racks, pastel pink shoe boxes, dusty rose/blush velvet cushioned try-on bench with gold frame in Panel 1 & Panel 3, and bright storefront natural daylight.
  + INTRODUCE NATURAL VARIATIONS in background micro-details:
    * Shoe Boxes on shelves: ${details.boxes}.
    * Display & Shelves footwear: ${details.floorShoes}.
    * Background atmosphere: ${details.shopper}.

- Footwear Replacement (Source of Truth):
  + In all 4 panels, REPLACE the footwear with the EXACT women's product design, colorway, upper materials (leather/satin/suede/mesh/straps/buckles), heel style/height, sole, and fine details from the uploaded product reference images.

- Outfit & Styling:
  + ${outfitInstruction}
  + Footwear logic: If open-toe/sandals/heels/mules/slides, feature natural bare feet with realistic smooth skin texture. If closed-toe sneakers/loafers, clean off-white ankle socks or barefoot as appropriate.

- 4-Panel Composition (Locked to reference layout):
  + Panel 1 (Leftmost): Close-up shot over the dusty rose velvet try-on bench. A delicate female hand with manicured nails holds and tilts one women's shoe/sandal/heel from the upper/side at a 20-degree angle; the matching second shoe rests neatly below on the silver/metallic display stand on the velvet bench.
  + Panel 2 (Second from left): First-person POV looking straight down from the female model's lap/waist. The bottom hem of the cream pleated skirt is visible at the top edge. Slender bare legs extended forward wearing the women's footwear on the light grey boutique floor tiles.
  + Panel 3 (Third from left): Side-profile view of the female model sitting gracefully on the dusty rose velvet cushioned bench with gold frame. Shows the pink ribbed top, white pleated skirt, beige crossbody bag, and legs extended/crossed displaying the side silhouette, heel height, strap design, and fit of the footwear.
  + Panel 4 (Rightmost): Full-body standing try-on pose in the pastel pink boutique aisle next to the gold display racks. The model stands gracefully (faceless, framed from chest down to feet), body slightly angled, wearing the pink top, pleated skirt, crossbody bag, showcasing the complete outfit with the footwear.

- Atmosphere & Realism: Authentic smartphone photography in a real women's footwear boutique, bright soft shop lighting, natural skin textures with visible pores, genuine fabric and leather folds, no CGI, no AI plastic shine.
- Strictly faceless, no visible faces, no text, no captions, no watermarks, no UI elements.`;
}

function buildSinglePanelPrompt(panelIndex, outfit, details, template = 'template3') {
  if (template === 'template4') {
    const outfitText = outfit || 'chic pastel pink ribbed short-sleeve top and cream/white pleated skirt with a small beige crossbody bag';

    const commonHeader = `Generate a single faceless women's footwear boutique-review photograph that looks like an authentic smartphone camera shot (still image, NOT a video).
CRITICAL INSTRUCTIONS:
- Aspect ratio: 9:16 vertical frame.
- Use the uploaded storyboard image (storyboard-master.png) as the main visual reference and extract/recreate ONLY this panel ${panelIndex} of 4.
- Keep the women's product identity exactly consistent with the product reference photo(s).
- Keep the shared chic pastel pink boutique shop setting, light grey floor tiles, gold metal shelving racks, pastel pink shoe boxes, and dusty rose velvet try-on bench consistent with the storyboard scene.
- The photo must look like it was casually taken with a normal smartphone camera, not a professional studio photo or AI render.
- Product material must show real texture/grain/weave/seams/straps/heel. Never make it glossy porcelain or waxy plastic.
- Human skin must show delicate feminine hands and slender legs with visible pores, natural skin tone variation.
- Strictly faceless: no visible faces, no text, no captions, no UI, no watermarks.`;

    if (panelIndex === 1) {
      return `${commonHeader}
CRITICAL — Panel 1 MUST match scene 1 of the women's boutique storyboard:
- Camera: Eye-level / slight top-down close-up over the dusty rose velvet try-on bench.
- One women's shoe/sandal/heel held gracefully by a delicate female hand in the FOREGROUND, occupying 55-70% of panel height, tilted 15-30 degrees.
- The OTHER shoe rests neatly below on the metallic display stand on the velvet bench.
- Background: chic pastel pink boutique shelves with ${details.boxes}, light grey tiled floor, soft boutique lights.
- FORBIDDEN: full body, face, watermark, added text.`;
    }

    if (panelIndex === 2) {
      return `${commonHeader}
CRITICAL — Panel 2 MUST match scene 2 of the women's boutique storyboard:
- Camera: POV from female model's lap looking STRAIGHT DOWN at own legs. Camera at waist/lap level, pointing down 60-70 degrees.
- Top edge shows the hem of the cream/white pleated skirt.
- Slender bare legs EXTENDED STRAIGHT FORWARD, relaxed on the light grey boutique floor tiles.
- Feet wearing the women's footwear at BOTTOM CENTER.
- 1-1.5 meters of floor tiles visible between camera and feet.
- Boutique gold shelves with pastel pink brand boxes visible in the DISTANCE.
- FORBIDDEN: bent knees at 90°, crossed legs, side angle, low camera, hands in frame, walking, standing up.`;
    }

    if (panelIndex === 3) {
      return `${commonHeader}
CRITICAL — Panel 3 MUST match scene 3 of the women's boutique storyboard:
- Camera: SIDE-ANGLE view of the female model seated gracefully on the dusty rose velvet cushioned bench with gold metal frame.
- Shows model from mid-torso down: pastel pink ribbed top, ${outfitText}, matching women's footwear.
- Legs extended or crossed displaying the side silhouette, heel height, strap design, and fit.
- Face CROPPED OUT above frame.
- Background: gold frame shelves with pastel pink shoeboxes, boutique entrance with soft daylight.
- FORBIDDEN: front-facing angle, full face, regular wooden chair, low-angle from floor, walking.`;
    }

    if (panelIndex === 4) {
      return `${commonHeader}
CRITICAL — Panel 4 MUST match scene 4 (the rightmost standing scene) of the women's boutique storyboard:
- Subject: A single continuous, cohesive standing try-on shot of the female model in the pastel boutique aisle wearing the footwear and ${outfitText}.
- Camera & Framing: Standing eye/chest level, vertical 9:16 frame showing the full lower body from chest/waist down to feet in one clean, uninterrupted shot (faceless, head cropped above frame or hidden behind phone).
- Stance & Pose: The female model stands gracefully next to the gold display racks, body and feet slightly angled to showcase the footwear silhouette, heel height, and pleated skirt.
- Background: Pastel pink boutique aisle with shoe display shelves and pink boxes.
- STRICTLY FORBIDDEN: split body, floating torso, full face, walking, watermark, text.`;
    }

    return '';
  }

  const outfitText = outfit || 'stylish matching light beige/khaki chinos with clean off-white socks';

  const commonHeader = `Generate a single faceless footwear shop-review photograph that looks like an authentic smartphone camera shot (still image, NOT a video).
CRITICAL INSTRUCTIONS:
- Aspect ratio: 9:16 vertical frame.
- Use the uploaded storyboard image (storyboard-master.png) as the main visual reference and extract/recreate ONLY this panel ${panelIndex} of 4.
- Keep the product identity exactly consistent with the product reference photo(s).
- Keep the shared footwear shop setting, square floor tiles, warm shop lighting, and shelving consistent with the storyboard scene.
- The photo must look like it was casually taken with a normal smartphone camera, not a professional studio photo or AI render.
- Product material must show real texture/grain/weave/seams/scuffs. Never make it glossy porcelain or waxy plastic.
- Human skin must show visible pores, knuckle creases, light veins, natural skin tone variation.
- Strictly faceless: no visible faces, no text, no captions, no UI, no watermarks.`;

  if (panelIndex === 1) {
    return `${commonHeader}
CRITICAL — Panel 1 MUST match scene 1 of the storyboard:
- Camera: TOP-DOWN from ABOVE, looking straight down at the store wooden counter. NOT a side view, NOT a horizontal shot.
- One shoe/footwear product held by a realistic hand in the FOREGROUND, occupying 55-70% of panel height, tilted 15-30 degrees.
- The OTHER shoe rests neatly below on the display stand.
- Background: warm boutique shelves with ${details.boxes}, beige tiled floor, warm ceiling lights.
- FORBIDDEN: side-view camera, face, full body, watermark, added text.`;
  }

  if (panelIndex === 2) {
    return `${commonHeader}
CRITICAL — Panel 2 MUST match scene 2 of the storyboard:
- Camera: POV from wearer's CHEST looking STRAIGHT DOWN at own legs. Camera at chest level, pointing down 60-70 degrees.
- Legs EXTENDED STRAIGHT FORWARD, relaxed, NOT bent at 90 degrees, NOT crossed.
- Frame: Two thighs at LEFT/RIGHT top edges (V shape). Floor tiles in middle. Feet with footwear at BOTTOM CENTER.
- 1-1.5 meters of floor tiles visible between camera and feet.
- Outfit: ${outfitText}. Clean socks if closed-toe shoes; barefoot if sandals.
- Shoe store shelves with brand boxes visible in the DISTANCE.
- FORBIDDEN: bent knees at 90°, crossed legs, side angle, low camera, hands in frame, walking, standing up.`;
  }

  if (panelIndex === 3) {
    return `${commonHeader}
CRITICAL — Panel 3 MUST match scene 3 of the storyboard:
- Camera: SIDE-ANGLE from the side, at waist/hip height, 1-1.5m away.
- Person sitting on a TALL wooden bar stool (dark wood, high seat, NO backrest, stool clearly visible).
- Visible body from mid-torso down: relaxed top, ${outfitText}, matching footwear.
- Leg hangs NATURALLY from the tall stool, foot flat on or near floor.
- Face CROPPED OUT above frame.
- Shoe store shelves, shoe boxes, storefront window, track lighting visible behind.
- FORBIDDEN: front-facing angle, full face, regular chair/bench, hidden stool, low-angle from floor, walking.`;
  }

  if (panelIndex === 4) {
    return `${commonHeader}
CRITICAL — Panel 4 MUST match scene 4 (the rightmost standing scene) of the storyboard:
- Subject: A single continuous, cohesive standing try-on shot of the model in the shop aisle wearing the footwear and ${outfitText}.
- Camera & Framing: Standing eye/chest level, vertical 9:16 frame showing the full lower body from chest/waist down to feet in one clean, uninterrupted shot (faceless, no face visible above chest).
- Stance & Pose: The model stands naturally in the center aisle, body and both feet turned slightly toward the camera/viewer to showcase the footwear silhouette, fit, and trousers. Both shoes rest firmly on the shop floor tiles.
- Background: The boutique shop aisle with shoe shelves and display stands visible in the background behind the model.
- STRICTLY FORBIDDEN: split body, floating torso, boxes/shelves cutting through the model's body, full face, walking, watermark, text.`;
  }

  return '';
}

function buildPanel2VideoPrompt(footChoice = null) {
  // Randomly choose 'phai' (right) or 'trai' (left) if not specified
  const foot = footChoice || (Math.random() < 0.5 ? 'phai' : 'trai');
  const isRight = foot === 'phai';

  const movingFootUpper = isRight ? 'BÀN CHÂN PHẢI' : 'BÀN CHÂN TRÁI';
  const movingFootLower = isRight ? 'bàn chân phải' : 'bàn chân trái';
  const movingSide = isRight ? 'sang bên phải' : 'sang bên trái';
  const movingDir = isRight ? 'sang phải' : 'sang trái';
  const stationaryFootUpper = isRight ? 'CHÂN TRÁI' : 'CHÂN PHẢI';
  const stationaryFootLower = isRight ? 'chân trái' : 'chân phải';
  const shoeSide = isRight ? 'đế giày phải' : 'đế giày trái';

  return `Tạo video review giày dép faceless dài đúng 6 giây, sử dụng chính xác hình ảnh gốc đã cung cấp.

POV từ ngực nhìn thẳng xuống hai chân của người đang ngồi trong shop giày dép.

GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC:
Giữ nguyên người, quần áo, hai chân, đôi giày, sàn gạch, kệ giày, hộp giày, ánh sáng và không gian cửa hàng.

CAMERA:
Camera cố định hoàn toàn.
Không di chuyển camera.
Không pan.
Không tilt.
Không zoom.
Không rung.
Không thay đổi góc nhìn.
Không cắt cảnh.

CHUYỂN ĐỘNG DUY NHẤT TRONG VIDEO:
Chỉ có một chuyển động rất nhỏ của ${movingFootUpper}.

${stationaryFootUpper}:
Giữ nguyên hoàn toàn vị trí ban đầu trong toàn bộ 6 giây.
Không chuyển động.

${isRight ? 'CHÂN PHẢI' : 'CHÂN TRÁI'}:
Không nhấc bàn chân.
Không nâng chân.
Không duỗi chân.
Không co chân.
Không bước chân.

${movingFootUpper} LUÔN NẰM PHẲNG TRÊN MẶT SÀN.

Hãy hình dung toàn bộ ${shoeSide} được đặt cố định trên mặt sàn bằng một lực rất nhẹ và chỉ có thể TRƯỢT NGANG trên bề mặt gạch.

0–2 GIÂY:

Giữ nguyên tư thế ban đầu.

Hai bàn chân nằm yên trên sàn.

Không có chuyển động lớn.

2–4 GIÂY:

Rê nguyên cả ${movingFootLower} ${movingSide} khoảng 3–5 centimet.

Đây là chuyển động TRƯỢT NGANG trên mặt sàn.

Toàn bộ đế giày di chuyển cùng nhau.

Mũi giày, phần giữa đế và gót giày cùng di chuyển ${movingDir}.

Đế giày luôn tiếp xúc với mặt sàn.

Không xoay bàn chân.

Không nhấc bất kỳ phần nào của giày.

Chỉ trượt nguyên bàn chân ${movingDir}.

4–6 GIÂY:

Rê nguyên cả ${movingFootLower} trở lại vị trí ban đầu.

Một lần nữa, đây chỉ là chuyển động TRƯỢT NGANG trên mặt sàn.

Toàn bộ đế giày di chuyển cùng nhau.

Mũi giày và gót giày cùng di chuyển.

Đế giày luôn tiếp xúc trực tiếp với mặt sàn.

KẾT QUẢ MONG MUỐN:

Chuyển động giống như một người đang dùng bàn chân để nhẹ nhàng kéo một vật nặng trên sàn gạch.

Bàn chân không được nâng lên để di chuyển.

Bàn chân không được bước.

Bàn chân không được xoay.

Bàn chân chỉ TRƯỢT trên mặt sàn.

VẬT LÝ BẮT BUỘC:

Trong mọi khung hình từ 0 đến 6 giây, đế giày phải nằm trên cùng một mặt phẳng với sàn gạch.

Không tạo khoảng hở giữa đế giày và sàn.

Không tạo chuyển động thẳng đứng.

Không tạo chuyển động bật lên.

Không tạo chuyển động nhấc chân.

Không tạo chuyển động đá chân.

Không tạo chuyển động bước chân.

Không tạo chuyển động xoay cổ chân.

Không tạo chuyển động xoay quanh gót.

Không thay đổi hình dạng đôi giày.

Không làm biến dạng chân.

Không làm biến dạng quần áo.

Không thay đổi vị trí ${stationaryFootLower}.

VIDEO:
Phong cách quay điện thoại chân thực.
Chuyển động rất chậm, nhỏ và tự nhiên.
Không cinematic.
Không slow motion.
Không hiệu ứng.
Không âm thanh.
Không lời nói.

Thời lượng chính xác: 6 giây.

ƯU TIÊN SỐ 1:
${movingFootUpper} KHÔNG ĐƯỢC RỜI MẶT SÀN.

ƯU TIÊN SỐ 2:
CHUYỂN ĐỘNG DUY NHẤT LÀ TRƯỢT NGANG TOÀN BỘ BÀN CHÂN TRÊN MẶT SÀN.

ƯU TIÊN SỐ 3:
GIỮ NGUYÊN HÌNH DÁNG VÀ VỊ TRÍ CỦA NGƯỜI VÀ ĐÔI GIÀY.`;
}

function getPanelPrompts(template = 'template3', options = {}) {
  const panel2Prompt = buildPanel2VideoPrompt(options.panel2Foot || null);

  if (template === 'template4') {
    return [
      'Tạo video review giày dép nữ faceless dài đúng 8 giây. VISUAL: Camera điện thoại góc nhìn cận cảnh quầy nệm nhung hồng pastel trong shop giày nữ. Chiếc giày/dép/guốc còn lại đặt cố định trên giá đỡ kim loại bên dưới. Bàn tay nữ với móng tay sơn nhẹ nhàng luôn cầm chắc ở thân/quai giày trong suốt video, chiếc giày gắn liền theo bàn tay, không tự xoay tròn hay lật đảo độc lập, chỉ nghiêng cổ tay nhẹ nhàng để khoe các góc cạnh: 0s-2s: Bàn tay giữ giày, nghiêng nhẹ cổ tay về phía trước để camera thấy rõ chi tiết mũi giày và quai trên. 2s-4s: Nghiêng nhẹ cổ tay sang trái góc 30 độ khoe toàn bộ thân giày bên ngoài, độ cao gót và đường cong đế. 4s-6s: Nghiêng nhẹ cổ tay sang phải góc 30 độ khoe thân giày bên trong và lớp lót êm. 6s-8s: Nghiêng nhẹ cổ tay về phía sau khoe gót giày và cạnh đế dưới, rồi giữ yên góc nghiêng tự nhiên kết thúc duyên dáng. Ánh sáng boutique hồng pastel ấm áp chân thực, da tay mịn tự nhiên, video im lặng không tiếng nói.',
      panel2Prompt,
      'Tạo video review giày dép nữ faceless dài đúng 4 giây. VISUAL: Góc quay ngang từ bên hông người mẫu nữ mặc váy xếp ly ngồi duyên dáng trên ghế nệm nhung hồng chân vàng kim trong shop giày, thấy từ eo xuống chân và sàn gạch. Hành động chân mềm mại: 0s-1.2s: Chân gần camera duỗi nhẹ tự nhiên từ ghế nệm, bàn chân chạm nhẹ sàn gạch, xoay nhẹ cổ chân khoe đường cong gót giày, độ cao gót và quai ôm chân. 1.2s-2.6s: Bàn chân tựa trên sàn gạch nhún nhẹ đệm đế êm ái khi tiếp đất. 2.6s-4s: Nghiêng nhẹ bàn chân sang cạnh ngoài khoe chi tiết quai cài và gót, rồi thả lỏng chân về tư thế ngồi tự nhiên. Ánh sáng boutique ấm áp, không rời ghế, video im lặng không tiếng nói.',
      'Tạo video review giày dép nữ faceless dài đúng 8 giây. VISUAL: Người mẫu nữ mặc áo hồng và chân váy xếp ly trắng đứng thử giày giữa lối đi shop giày pastel, góc máy từ ngực xuống chân (faceless). Hai bàn chân luôn đặt phẳng hoàn toàn trên mặt sàn gạch trong suốt video, tuyệt đối không nhón mũi chân, không nhấc gót, không nhảy: 0s-2.5s: Đứng thẳng tại chỗ với hai bàn chân đặt phẳng trên sàn gạch, xoay nhẹ thân người sang trái góc 20 độ khoe dáng giày bên ngoài và sự kết hợp với chân váy xếp ly. 2.5s-5.5s: Xoay nhẹ thân người sang phải góc 20 độ, hai bàn chân vẫn đặt phẳng trên sàn gạch, khoe mặt giày bên trong. 5.5s-8s: Chân phải trượt nhẹ sang bên nửa bước giữ bàn chân phẳng bám sát sàn gạch, đứng thẳng vững chãi tạo dáng tự tin nữ tính trước gương shop khoe trực diện tổng thể form dáng giày và outfit. Ánh sáng shop chân thực, video im lặng không tiếng nói.',
    ];
  }

  return [
    'Tạo video review giày dép faceless dài đúng 8 giây. VISUAL: Camera điện thoại góc top-down nhìn từ trên xuống quầy gỗ shop giày dép. Chiếc giày còn lại đặt cố định trên giá đỡ bên dưới. Bàn tay luôn giữ chắc cố định ở dưới đế giày trong suốt video, chiếc giày gắn liền theo bàn tay, không tự xoay tròn hay lật đảo độc lập, chỉ nghiêng cổ tay nhẹ nhàng để khoe các góc cạnh của giày: 0s-2s: Bàn tay giữ đế, nghiêng nhẹ cổ tay về phía trước để camera thấy rõ góc trên và chi tiết mũi giày. 2s-4s: Nghiêng nhẹ cổ tay sang trái góc 30 độ khoe toàn bộ thân giày bên ngoài và độ cao đế. 4s-6s: Nghiêng nhẹ cổ tay sang phải góc 30 độ khoe thân giày bên trong. 6s-8s: Nghiêng nhẹ cổ tay về phía sau khoe gót giày và cạnh đế dưới, rồi giữ yên góc nghiêng tự nhiên kết thúc chắc chắn. Ánh sáng shop chân thực, da tay có vân tự nhiên, không bokeh giả, video im lặng không tiếng nói.',
    panel2Prompt,
    'Tạo video review giày dép faceless dài đúng 4 giây. VISUAL: Góc quay ngang từ bên hông người mẫu ngồi trên ghế bar gỗ cao trong shop giày, thấy từ eo xuống chân và sàn gạch. Hành động chân dứt khoát: 0s-1.2s: Chân gần camera duỗi nhẹ tự nhiên từ ghế cao, bàn chân chạm nhẹ sàn gạch, xoay nhẹ cổ chân khoe đường cong thân bên và độ dốc đế. 1.2s-2.6s: Bàn chân tựa trên sàn gạch nhún nhẹ đệm đế êm ái khi tiếp đất. 2.6s-4s: Nghiêng nhẹ bàn chân sang cạnh ngoài khoe chi tiết viền đế và gót, rồi thả lỏng chân về tư thế ngồi tự nhiên. Ánh sáng shop ấm áp chân thực, không rời ghế, video im lặng không tiếng nói.',
    'Tạo video review giày dép faceless dài đúng 8 giây. VISUAL: Người mẫu đứng thử giày giữa lối đi shop giày dép, góc máy từ ngực xuống chân (faceless). Hai bàn chân luôn đặt phẳng hoàn toàn trên mặt sàn gạch trong suốt video, tuyệt đối không nhón mũi chân, không nhấc gót, không nhảy: 0s-2.5s: Đứng thẳng tại chỗ với hai bàn chân đặt phẳng trên sàn gạch, xoay nhẹ thân người sang trái góc 20 độ khoe dáng giày bên ngoài và phom quần. 2.5s-5.5s: Xoay nhẹ thân người sang phải góc 20 độ, hai bàn chân vẫn đặt phẳng trên sàn gạch, khoe mặt giày bên trong. 5.5s-8s: Chân phải trượt nhẹ sang bên nửa bước giữ bàn chân phẳng bám sát sàn gạch, đứng thẳng vững chãi tạo dáng tự tin trước gương shop khoe trực diện tổng thể form dáng giày và outfit. Ánh sáng shop chân thực, video im lặng không tiếng nói.',
  ];
}

function archiveStoryboardReview(baseDir, filePayloads, prompt, storyboardBase64, panels, template = 'template3') {
  const archiveRoot = path.join(baseDir, 'storyboard-review-runs');
  ensureDir(archiveRoot);

  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const runId = Math.random().toString(36).substring(2, 8);
  const archiveDir = path.join(archiveRoot, `${timestamp}-${template}-flow-${runId}`);
  const inputsDir = path.join(archiveDir, 'inputs');
  const panelsDir = path.join(archiveDir, 'panels');

  ensureDir(inputsDir);
  ensureDir(panelsDir);

  // Save inputs
  for (let i = 0; i < filePayloads.length; i++) {
    const fp = filePayloads[i];
    const safeName = safeBaseName(fp.name || `input-${i + 1}.png`);
    const inPath = path.join(inputsDir, `${String(i + 1).padStart(2, '0')}-${safeName}`);
    fs.writeFileSync(inPath, fp.buffer);
  }

  // Save storyboard
  const storyboardPath = path.join(archiveDir, 'storyboard.png');
  if (storyboardBase64) {
    fs.writeFileSync(storyboardPath, Buffer.from(storyboardBase64, 'base64'));
  }

  // Save panels
  for (const panel of panels) {
    const pPath = path.join(panelsDir, `panel-${panel.index}.png`);
    if (panel.imageBase64) {
      fs.writeFileSync(pPath, Buffer.from(panel.imageBase64, 'base64'));
      panel.imagePath = pPath;
    }
  }

  // Save prompts.md
  const panelPrompts = getPanelPrompts(template);
  const templateTitle = template === 'template4' ? 'Template 4 (Women Footwear Boutique)' : 'Template 3 (Footwear Shop)';
  const promptsContent = `# ${templateTitle} - Google Flow Storyboard Prompts (4 Panels)

## Storyboard Image-to-Image Prompt
\`\`\`text
${prompt}
\`\`\`

## Veo 3 Video Prompts
### Panel 1 (8s - ${template === 'template4' ? 'Close-Up Hand Held on Velvet Bench' : 'Top-Down Hand Held'})
${panelPrompts[0]}

### Panel 2 (6s - ${template === 'template4' ? 'POV Pleated Skirt Sitting' : 'Chest POV Sitting'})
${panelPrompts[1]}

### Panel 3 (4s - ${template === 'template4' ? 'Side Angle Velvet Bench' : 'Side Bar Stool'})
${panelPrompts[2]}

### Panel 4 (8s - ${template === 'template4' ? 'Standing Try-On in Pastel Aisle' : 'Standing Try-On in Aisle'})
${panelPrompts[3]}
`;
  fs.writeFileSync(path.join(archiveDir, 'prompts.md'), promptsContent, 'utf-8');

  console.log(`[GoogleFlowStoryboard] Storyboard review archive saved: ${archiveDir}`);
  return {
    root: archiveDir,
    storyboardPath,
    panelsDir,
    inputsDir,
    template,
  };
}

async function generateStoryboard(baseDir, filePayloads, options = {}) {
  if (!filePayloads || filePayloads.length === 0) {
    throw new Error('At least one product image is required');
  }

  const template = String(options.template || options.storyboardTemplate || 'template3').trim().toLowerCase();
  const isTemplate4 = template === 'template4';
  const templateNameDisplay = isTemplate4 ? 'Template 4 (Giày dép nữ)' : 'Template 3';

  console.log(`[GoogleFlowStoryboard] Generating ${templateNameDisplay} storyboard with Google Flow for ${filePayloads.length} input image(s)...`);

  // 1. Prepare reference storyboard template image
  let refName = isTemplate4 ? 'template4-storyboard-reference.png' : 'template3-storyboard-reference.png';
  let refPath = path.join(baseDir, 'assets', refName);
  if (!fs.existsSync(refPath) && isTemplate4) {
    refPath = path.join(baseDir, 'assets', 'template_storyboard_nu.png');
    refName = 'template_storyboard_nu.png';
  }
  if (!fs.existsSync(refPath)) {
    throw new Error(`Storyboard reference image not found: ${refPath}`);
  }

  const refPayload = {
    name: refName,
    buffer: fs.readFileSync(refPath),
    mimeType: 'image/png',
  };

  const details = getRandomMicroDetails(template);

  // Upload reference image + input images to Google Flow
  const allUploadPayloads = [refPayload, ...filePayloads];
  const prompt = isTemplate4 ? buildTemplate4Prompt(options.outfit || null) : buildTemplate3Prompt(options.outfit || null);

  const tmpRoot = path.join(baseDir, 'uploads', 'flow-storyboard-runs');
  ensureDir(tmpRoot);
  const runDir = path.join(tmpRoot, `run-${Date.now()}`);
  ensureDir(runDir);

  const page = await createFlowPage(baseDir);
  let genResult = null;

  try {
    console.log(`[GoogleFlowStoryboard] Step 1: Preparing master Storyboard image generation on Google Flow (${templateNameDisplay})...`);
    const prepared = await prepareGeneration(
      page,
      prompt,
      allUploadPayloads,
      {
        imageModel: 'nano-banana-2',
        aspectRatio: '16:9',
        outputCount: 1,
      },
      baseDir
    );

    console.log('[GoogleFlowStoryboard] Step 2: Executing master Storyboard image generation API...');
    genResult = await executeGeneration(prepared);
  } finally {
    await closeFlowPage(page);
  }

  if (!genResult || !genResult.base64) {
    throw new Error('Google Flow did not return a generated storyboard image');
  }

  const storyboardPath = path.join(runDir, 'storyboard.png');
  fs.writeFileSync(storyboardPath, Buffer.from(genResult.base64, 'base64'));
  console.log(`[GoogleFlowStoryboard] ✅ Master Storyboard image generated via Google Flow: ${storyboardPath}`);

  // 2. Generate 4 native 9:16 vertical panels via Gemini API
  console.log(`[GoogleFlowStoryboard] Step 3: Generating 4 separate 9:16 vertical panels via Gemini API for ${templateNameDisplay}...`);
  const panelsDir = path.join(runDir, 'panels');
  ensureDir(panelsDir);

  const secure1Psid = (process.env.GEMINI_SECURE_1PSID || '').trim();
  const secure1Psidts = (process.env.GEMINI_SECURE_1PSIDTS || '').trim();
  const cookieFilePath = process.env.GEMINI_COOKIE_PATH
    ? path.resolve(process.env.GEMINI_COOKIE_PATH)
    : path.join(baseDir, 'gemini-cookies', 'cookies.json');

  const geminiClient = new GeminiApiClient({ secure1Psid, secure1Psidts, cookieFilePath });
  await geminiClient.init();

  let analysis = {
    productName: isTemplate4 ? 'Guốc Nữ / Giày Sandal Cao Gót Thời Trang' : 'Giày Thể Thao Sneaker Thời Trang',
    hashtags: isTemplate4 ? ['#GuocNu', '#GiayCaoGot', '#SandalNu', '#ReviewGiayNu', '#TikTokShopVN'] : ['#GiaySneaker', '#GiayTheThao', '#ReviewGiay', '#SneakerVN', '#TikTokShopVN'],
  };

  try {
    console.log(`[GoogleFlowStoryboard] 🔍 Step 2.5: Analyzing footwear images & extracting hashtags via Gemini API...`);
    analysis = await analyzeProductFootwear(geminiClient, filePayloads, isTemplate4);
  } catch (aErr) {
    console.warn(`[GoogleFlowStoryboard] ⚠️ Footwear analysis skipped: ${aErr.message}`);
  }

  const panelPrompts = getPanelPrompts(template);
  const panels = [];

  try {
    console.log('[GoogleFlowStoryboard] Uploading Storyboard reference & product images to Gemini API...');
    const sbBuf = fs.readFileSync(storyboardPath);
    const sbUrl = await geminiClient.uploadFile(sbBuf, 'storyboard-master.png', 'image/png');

    const productFileData = [];
    for (let i = 0; i < Math.min(filePayloads.length, 3); i++) {
      const file = filePayloads[i];
      const url = await geminiClient.uploadFile(file.buffer, file.name || `product-${i + 1}.png`, file.mimeType || 'image/png');
      productFileData.push({ url, filename: file.name || `product-${i + 1}.png`, mimeType: file.mimeType || 'image/png' });
    }

    const panelFileData = [
      { url: sbUrl, filename: 'storyboard-master.png', mimeType: 'image/png' },
      ...productFileData,
    ];

    for (let i = 0; i < 4; i++) {
      const panelIndex = i + 1;
      const singlePrompt = buildSinglePanelPrompt(panelIndex, options.outfit || null, details, template);
      console.log(`[GoogleFlowStoryboard] [${panelIndex}/4] Generating Panel ${panelIndex} (9:16) via Gemini API...`);

      let panelBuf = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const startedAt = Date.now();
          const genRes = await geminiClient.generateContent({
            prompt: singlePrompt,
            fileData: panelFileData,
            temporary: true,
            expectImages: true,
          });

          if (!genRes || !genRes.images || genRes.images.length === 0) {
            throw new Error('Gemini API did not return an image');
          }

          panelBuf = await geminiClient.downloadImage(genRes.images[0].url);
          console.log(`[GoogleFlowStoryboard] [${panelIndex}/4] ✅ Image received from Gemini API in ${Math.round((Date.now() - startedAt) / 1000)}s!`);
          break;
        } catch (err) {
          lastErr = err;
          console.warn(`[GoogleFlowStoryboard] [${panelIndex}/4] Attempt ${attempt}/3 failed: ${err.message}. Retrying...`);
          await new Promise(r => setTimeout(r, 4000));
        }
      }

      if (!panelBuf) {
        throw new Error(`Failed to generate Panel ${panelIndex} with Gemini API: ${lastErr?.message || 'Unknown error'}`);
      }

      const panelPath = path.join(panelsDir, `panel-${panelIndex}.png`);
      fs.writeFileSync(panelPath, panelBuf);
      const finalB64 = panelBuf.toString('base64');

      panels.push({
        index: panelIndex,
        prompt: panelPrompts[i],
        imageBase64: finalB64,
        imagePath: panelPath,
        image: { base64: finalB64, mimeType: 'image/png' },
        sourcePath: panelPath,
        mimeType: 'image/png',
      });
      console.log(`[GoogleFlowStoryboard] ✅ Panel ${panelIndex}/4 generated via Gemini API!`);
    }
  } finally {
    try { await geminiClient.close(); } catch (_) {}
  }

  // 3. Save review archive
  const reviewArchive = archiveStoryboardReview(baseDir, filePayloads, prompt, genResult.base64, panels, template);

  // 4. Generate videos if requested
  let videos = [];
  if (options.generateVideos !== false) {
    console.log('[GoogleFlowStoryboard] Step 4: Generating Veo 3 videos from panels on Google Flow...');
    videos = await generateVideosFromPanelsDirect(baseDir, panels, {
      aspectRatio: '9:16',
      videoModelKey: options.videoModelKey || null,
      includeVideoBase64: !!options.includeVideoBase64,
    });
    console.log(`[GoogleFlowStoryboard] Video result: ${videos.filter(v => !v.error).length}/${videos.length} completed`);

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
    promptSource: 'google-flow',
    storyboard: {
      imageBase64: genResult.base64,
      mimeType: 'image/png',
      sourcePath: storyboardPath,
    },
    reviewArchive,
    analysis,
  };
}

module.exports = {
  generateStoryboard,
  buildTemplate3Prompt,
  buildTemplate4Prompt,
  buildSinglePanelPrompt,
  buildPanel2VideoPrompt,
  generateVideosFromPanelsDirect,
  getPanelPrompts,
};
