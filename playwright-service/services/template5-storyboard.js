'use strict';

/**
 * template5-storyboard.js
 *
 * Template 5: Review Đa Ngành Hàng 4 Cảnh 6 Giây (Không Dùng Ảnh Ref Tĩnh)
 *
 * Luồng hoạt động:
 * 1. Phân tích ảnh sản phẩm (bất kỳ ngành hàng: thời trang, mỹ phẩm, gia dụng, công nghệ, phụ kiện)
 *    qua Gemini API theo kiến trúc prompt chuẩn của template mặc định.
 * 2. Gọi Gemini API tạo Master Storyboard 4 cảnh (16:9 chứa 4 khung dọc 9:16) có chữ tiếng Việt.
 * 3. Gọi Gemini API tách/tạo 4 panel 9:16 riêng biệt có typography tiếng Việt thẩm mỹ, đúng chính tả.
 * 4. Gọi Google Flow Veo 3 tạo 4 video 9:16 thời lượng đúng 6 giây bằng 100% prompt tiếng Việt,
 *    giữ nguyên chữ từ panel, hoàn toàn không có tiếng review / voice-over.
 * 5. Lưu trữ archive và trả về kết quả cho Telegram bot.
 */

const fs = require('fs');
const path = require('path');
const { generateVideosFromPanelsDirect } = require('./gemini-webapi-storyboard');
const { GeminiApiClient } = require('./gemini-client/gemini-api');
const { sendPhotoToTelegram, sendOrUpdateLivePanel } = require('./telegram-send');

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
 * Xây dựng Analysis Prompt đa ngành hàng theo cấu trúc chuẩn của default template
 */
function buildProductContextSection(options = {}) {
  const ctx = options.productContext || {};
  const lines = [];
  if (ctx.productTitle) lines.push(`Product title: ${ctx.productTitle}`);
  if (ctx.productId) lines.push(`Product ID: ${ctx.productId}`);
  if (ctx.productUrl) lines.push(`Product URL: ${ctx.productUrl}`);
  if (ctx.productDescription) lines.push(`Product description from TikTok Shop:\n${ctx.productDescription}`);
  return lines.length ? `\nTikTok Shop source metadata:\n${lines.join('\n')}\n` : '';
}

function buildTemplate5AnalysisPrompt(options = {}) {
  return `TEXT-ONLY TASK. Do not generate images. Do not call image generation. Do not create a visual storyboard asset.
You are a senior multi-category product marketing analyst, lifestyle content director, and Veo 3 prompt writer.
Analyze the uploaded product reference images (which can be any product: Fashion, Clothing, Bags, Footwear, Cosmetics/Skincare, Home Appliances/Kitchenware, Tech Gadgets, Accessories, etc.) and write a comprehensive product review plan as JSON text only.
${buildProductContextSection(options)}

Requirements:
- Panel count: exactly 4.
- Scene ratio for each panel: 9:16 vertical.
- Identify the product name in Vietnamese, category, materials/ingredients, key selling points, and target audience.
- Prefer the TikTok Shop product title and Product description metadata when they are more specific than image OCR.
- Design an aesthetic, authentic lifestyle setting (e.g., modern sunlit living room, luxury marble vanity, contemporary kitchen countertop, aesthetic desk setup, minimalist cafe, or chic boutique) that best showcases this product naturally.
- For each of the 4 panels, extract RICH & FLEXIBLE VIETNAMESE TEXT OVERLAYS consisting of:
  1. "headline": Short, punchy uppercase title (1-4 words).
  2. "subtexts": Array of 1-3 concise bullet points / key features / specs / performance highlights / direct benefits (3-7 words each).
  CRITICAL: Every headline and subtext MUST HAVE 100% ACCURATE VIETNAMESE SPELLING AND DIACRITICS (chuẩn 100% chính tả tiếng Việt có dấu).

- REALISTIC FUNCTIONAL INTERACTIONS (THAO TÁC THỰC TẾ, KHÔNG ẢO CGI):
  * Observe the product images for authentic functional features (e.g. pulling a tissue smoothly from wall-mounted dispenser, wipe cleaning a table with authentic reflection, tactile finger press on sole, smooth 360 rotation).
  * In the "script" array, provide a "techVFX" string describing REAL, NATURAL physical demonstrations (e.g., "Thao tác tay rút nhẹ tờ khăn giấy từ đáy một cách mượt mà, giấy dai mịn không bị rách", "Bàn tay miết nhẹ bề mặt khoe độ dày dặn và vân dập nổi tự nhiên").
  * STRICTLY FORBID fantasy CGI, glowing neon arrows, cartoon magnifying glasses, floating 3D graphics, or fairy sparkles. Keep everything looking like a real authentic smartphone video.

- VOICE PERSONA & VIETNAMESE SCRIPT (GIỌNG NÓI REVIEW THEO TỪNG SẢN PHẨM):
  * Infer the best voice gender and tone based on product category & target audience:
    - Products for women, skincare, cosmetics, lifestyle, household, kitchenware, soft fashion -> "nu" (giọng nữ miền Nam hoặc miền Bắc ngọt ngào, tự nhiên, duyên dáng, gần gũi như bạn bè chia sẻ).
    - Products for men, tech gadgets, automotive, mechanical tools, heavy gear, masculine fashion -> "nam" (giọng nam miền Nam hoặc miền Bắc trầm ấm, tự tin, cuốn hút, đáng tin cậy).
    - Unisex products -> choose the most engaging tone for the product.
  * For each of the 4 panels in "script", write a natural, conversational "voiceOver" line in Vietnamese:
    - Pacing: exactly 14 to 22 Vietnamese words (matched for 6 seconds pacing).
    - Content:
      * Panel 1: Catchy opening hook + product introduction.
      * Panel 2: Material finish & standout technological / design feature.
      * Panel 3: In-action user experience & practical everyday benefit.
      * Panel 4: Concluding verdict & authentic recommendation.
    - 100% ACCURATE VIETNAMESE DIACRITICS (đúng chính tả tiếng Việt có dấu).

- All 4 panels share the exact same setting, lighting, surface, and smartphone camera realism.
- Faceless only: no visible faces, no talking presenter.

Return ONLY valid JSON matching this schema:
{
  "analysis": {
    "productName": "Vietnamese product name inferred from the images",
    "category": "fashion|cosmetics|home|gadgets|accessories|other",
    "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
    "materials": "materials or ingredients description",
    "highlights": ["highlight 1", "highlight 2", "highlight 3"],
    "targetAudience": "target user description"
  },
  "voicePersona": {
    "gender": "nu|nam",
    "voiceDescription": "nữ miền Nam ngọt ngào tự nhiên | nam miền Nam trầm ấm tự tin",
    "tone": "thân thiện, duyên dáng, cuốn hút, review chân thực"
  },
  "sceneContext": {
    "location": "detailed description of setting and surface",
    "lighting": "natural daylight / warm interior lighting",
    "mood": "aesthetic, modern, 100% authentic realism"
  },
  "panelOverlays": [
    {
      "id": 1,
      "headline": "TIÊU ĐỀ IN HOA PANEL 1",
      "subtexts": [
        "• Dòng tính năng nổi bật 1",
        "• Dòng thông số hoặc chi tiết 2"
      ]
    },
    {
      "id": 2,
      "headline": "TIÊU ĐỀ IN HOA PANEL 2",
      "subtexts": [
        "• Dòng chất liệu / thành phần 1",
        "• Dòng thông số / độ bền 2"
      ]
    },
    {
      "id": 3,
      "headline": "TIÊU ĐỀ IN HOA PANEL 3",
      "subtexts": [
        "• Dòng hiệu quả công năng 1",
        "• Dòng trải nghiệm thực tế 2"
      ]
    },
    {
      "id": 4,
      "headline": "TIÊU ĐỀ IN HOA PANEL 4",
      "subtexts": [
        "• Dòng lợi ích đời sống 1",
        "• Dòng kết quả thực tế 2"
      ]
    }
  ],
  "script": [
    {
      "id": 1,
      "duration": "00:00-00:06",
      "goal": "Hero showcase & exterior",
      "voiceOver": "Một câu lời thoại review tiếng Việt mở đầu ngắn gọn 14-22 từ, đúng 6 giây, chuẩn chính tả có dấu 100%.",
      "visualDescription": "clean hero shot of product held naturally or displayed on surface",
      "techVFX": "Ánh sáng tự nhiên chiếu nhẹ tôn lên kiểu dáng chân thực và bao bì trang nhã",
      "cameraAction": "close-up front angle with natural lighting"
    },
    {
      "id": 2,
      "duration": "00:06-00:12",
      "goal": "Key feature / material detail",
      "voiceOver": "Một câu đặc tả chất liệu và công nghệ nổi bật 14-22 từ, tự nhiên và cuốn hút.",
      "visualDescription": "macro close-up focusing on key functional detail, texture, or finish",
      "techVFX": "Ngón tay miết nhẹ đặc tả chất liệu dày dặn, kết cấu bề mặt thực tế",
      "cameraAction": "extreme close-up macro"
    },
    {
      "id": 3,
      "duration": "00:12-00:18",
      "goal": "In-action user experience",
      "voiceOver": "Một câu chia sẻ trải nghiệm sử dụng thực tế tiện dụng 14-22 từ.",
      "visualDescription": "hands-on authentic human interaction using the product smoothly",
      "techVFX": "Thao tác sử dụng thực tế mượt mà, chân thực không kỹ xảo ảo",
      "cameraAction": "medium close-up in-action"
    },
    {
      "id": 4,
      "duration": "00:18-00:24",
      "goal": "Overall benefit & lifestyle",
      "voiceOver": "Một câu đánh giá kết luận và khuyên dùng nhiệt tình 14-22 từ.",
      "visualDescription": "overall scene showing product integrated into daily lifestyle",
      "techVFX": "Không gian sinh hoạt ngăn nắp, gọn gàng và tiện nghi",
      "cameraAction": "medium lifestyle shot"
    }
  ]
}

Important:
- If you are unable to inspect the images, still return the JSON schema with best-effort assumptions.
- Do not ask follow-up questions. Return ONLY valid JSON.`.trim();
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

  try {
    const res = await geminiClient.generateContent({
      prompt: analysisPrompt,
      fileData: uploadedFiles,
      temporary: true,
      expectImages: false,
    });

    const parsed = parseJsonObject(res.text || '');
    if (parsed) {
      const pName = parsed.analysis?.productName || parsed.productName || 'Sản Phẩm Cao Cấp';
      const cat = parsed.analysis?.category || parsed.category || 'general';
      const panelOverlays = normalizePanelOverlays(parsed);
      const captions = panelOverlays.map(p => p.headline);

      console.log(`[Template5] ✅ Product analyzed: "${pName}" (${cat})`);
      console.log(`[Template5] Panel Overlays:`, JSON.stringify(panelOverlays, null, 2));

      return {
        analysis: {
          productName: pName,
          category: cat,
          hashtags: parsed.analysis?.hashtags || parsed.hashtags || ['#review', '#sanphamchinhhang', '#trending'],
          materials: parsed.analysis?.materials || parsed.materials || 'Chất liệu cao cấp',
          highlights: parsed.analysis?.highlights || parsed.highlights || ['Thiết kế sang trọng', 'Tiện dụng'],
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
    console.warn(`[Template5] Analysis JSON parse fallback: ${err.message}`);
  }

  // Fallback defaults
  const defaultOverlays = [
    { id: 1, headline: 'THIẾT KẾ TINH TẾ', subtexts: ['• Kiểu dáng hiện đại', '• Nhỏ gọn tiện lợi'] },
    { id: 2, headline: 'CHẤT LIỆU CAO CẤP', subtexts: ['• Hoàn thiện tỉ mỉ', '• Bền bỉ vượt trội'] },
    { id: 3, headline: 'TRẢI NGHIỆM ÊM ÁI', subtexts: ['• Tiện lợi dễ dùng', '• Hiệu quả tối đa'] },
    { id: 4, headline: 'TIỆN NGHI MỖI NGÀY', subtexts: ['• Phù hợp mọi nhu cầu', '• Nâng tầm cuộc sống'] }
  ];

  return {
    analysis: {
      category: 'general',
      productName: 'Sản Phẩm Cao Cấp',
      hashtags: ['#review', '#sanphamchinhhang', '#lifestyle', '#trending', '#xuhuong'],
      materials: 'Chất liệu cao cấp, hoàn thiện tỉ mỉ',
      highlights: ['Thiết kế sang trọng', 'Công năng vượt trội', 'Tiện dụng hàng ngày'],
      sceneContext: {
        location: 'Không gian sống hiện đại sáng sủa, nội thất tối giản tinh tế',
        lighting: 'Ánh sáng tự nhiên dịu nhẹ ban ngày kết hợp đèn ấm',
        mood: 'Chân thực, hiện đại, cao cấp'
      },
      panelOverlays: defaultOverlays,
      panelCaptions: defaultOverlays.map(p => p.headline),
      script: [],
      veo3Prompts: []
    },
    uploadedFiles
  };
}

/**
 * Xây dựng prompt Master Storyboard (4 panel horizontal split 16:9)
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

  const sceneData = {
    productName: prodName,
    category: a.category || 'general',
    sceneContext: a.sceneContext || {},
    panels: overlays.map(p => ({
      id: p.id,
      headline: isNoText ? undefined : p.headline,
      keySellingPoints: isNoText ? undefined : p.subtexts,
      goal: (a.script && a.script[p.id - 1]?.goal) || `Scene ${p.id}`,
    }))
  };

  if (isNoText) {
    return `Generate one product review storyboard image (still photo collage, NOT a video) from the uploaded product reference images for ${prodName}.

CRITICAL VISUAL DIRECTION — 100% SMARTPHONE REALISM (CHUẨN CAMERA THỰC TẾ, KHÔNG ẢO CGI):
- Aesthetics: Authentic smartphone camera snapshot (iPhone 15 Pro 24mm/26mm lens, f/1.8 auto mode), natural window light, subtle realistic contact shadows, genuine material textures (matte finish, fabric grain, metallic brush or leather texture). Must look 100% real and authentic like a real human photoshoot.
- Hands & Model: Fair Asian skin tone, natural skin pores, knuckle creases, neat manicured nails, anatomically correct hands with 5 fingers, realistic physical grip. Strictly faceless (no visible faces, only hands/limbs/outfit).
- NO CARTOON GRAPHICS: Absolutely NO glowing neon arrows, NO cartoon magnifying glasses, NO floating 3D icons, NO fake fairy sparkles.

Storyboard requirements:
- Exactly 4 panels arranged side by side in one single still image (horizontal 16:9 collage composed of 4 vertical 9:16 frames).
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
    options.template === 'template5_2' || options.template === 'template5.2' || options.template === 'template52'
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
- Setting: ${loc}.
- Product Identity: Match the EXACT design, colors, textures, and details from the product reference images.

- SINGLE CAPTION BADGE & SAFE ZONE (QUAN TRỌNG: Cỡ chữ nhỏ gọn tinh tế, 100% không cắt viền, không vẽ chữ rác):
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
- Output must be a still photo. Do NOT generate a video.

Generate exactly one still image now.`.trim();
}

/**
 * Lấy danh sách 4 Prompt Veo 3 chuẩn 6s tiếng Việt cho Template 5 / Template 5.1 / Template 5.2
 * TUYỆT ĐỐI KHÔNG truyền chuỗi text trong ngoặc kép cho Veo vì Veo sẽ tự vẽ thêm chữ lỗi font.
 * Veo chỉ animate hình ảnh gốc.
 */
function getTemplate5VideoPrompts(analysisData, options = {}) {
  const prodName = analysisData?.productName || 'sản phẩm';
  const script = analysisData?.script || [];
  const hasVoice = !!(
    options.hasVoice ||
    options.template === 'template5_2' || options.template === 'template5.2' || options.template === 'template52'
  );

  const realismCues = 'Cảnh quay tự nhiên 100% như quay bằng camera điện thoại iPhone 15 Pro, ánh sáng ban ngày tự nhiên từ cửa sổ, đổ bóng tiếp xúc chân thực, bề mặt sản phẩm lì có vân chất liệu, không hiệu ứng bokeh giả, không ánh sáng studio nhân tạo, không nhựa bóng kiểu AI, không hiệu ứng ảo CGI.';

  const desc1 = script[0]?.visualDescription || 'Cận cảnh tay cầm sản phẩm trên bề mặt tự nhiên sang trọng';
  const vfx1 = script[0]?.techVFX ? ` Thao tác thực tế: ${script[0].techVFX}.` : '';

  const desc2 = script[1]?.visualDescription || 'Góc quay cận cảnh đặc tả chất liệu, cấu tạo và hoàn thiện tinh xảo';
  const vfx2 = script[1]?.techVFX ? ` Thao tác thực tế: ${script[1].techVFX}.` : '';

  const desc3 = script[2]?.visualDescription || 'Trải nghiệm sử dụng thực tế của người dùng với sản phẩm trong không gian';
  const vfx3 = script[2]?.techVFX ? ` Thao tác thực tế: ${script[2].techVFX}.` : '';

  const desc4 = script[3]?.visualDescription || 'Toàn cảnh sản phẩm trong không gian phong cách sống hiện đại';
  const vfx4 = script[3]?.techVFX ? ` Thao tác thực tế: ${script[3].techVFX}.` : '';

  if (hasVoice) {
    const isMale = analysisData?.voicePersona?.gender === 'nam' ||
      analysisData?.category === 'gadgets' ||
      (analysisData?.targetAudience && /nam|men|đàn ông/i.test(analysisData.targetAudience));
    const defaultVoice = isMale
      ? 'nam miền Nam trầm ấm, tự tin, cuốn hút'
      : 'nữ miền Nam ngọt ngào, tự nhiên, gần gũi';
    const voiceDesc = analysisData?.voicePersona?.voiceDescription || defaultVoice;

    const vo1 = script[0]?.voiceOver || `Một món đồ không thể thiếu giúp nâng tầm không gian sống và trải nghiệm mỗi ngày.`;
    const vo2 = script[1]?.voiceOver || `Từng chi tiết được hoàn thiện tỉ mỉ với chất liệu cao cấp và độ bền vượt trội.`;
    const vo3 = script[2]?.voiceOver || `Thao tác sử dụng cực kỳ mượt mà và tiện lợi, mang lại cảm giác vô cùng hài lòng.`;
    const vo4 = script[3]?.voiceOver || `Một sự lựa chọn hoàn hảo đáp ứng trọn vẹn cả tính thẩm mỹ lẫn công năng thực tế.`;

    return [
      `Tạo video review ${prodName} faceless dài đúng 6 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI. Giọng đọc review: ${voiceDesc}. Lời thoại nhân vật: "${vo1}". VISUAL:${vfx1} ${desc1}. Chuyển động camera và tay chân thực, mượt mà: 0s-2s giữ yên góc quay, 2s-4s nghiêng nhẹ cổ tay khoe chi tiết và kiểu dáng sản phẩm, 4s-6s trở về vị trí tự nhiên ban đầu. ${realismCues}`,
      `Tạo video review ${prodName} faceless dài đúng 6 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI. Giọng đọc review: ${voiceDesc}. Lời thoại nhân vật: "${vo2}". VISUAL:${vfx2} ${desc2}. Chuyển động: 0s-2s giữ khung hình ổn định, 2s-4s ngón tay tương tác chạm nhẹ vào chi tiết công năng thực tế, 4s-6s giữ yên góc quay tôn vinh sản phẩm. ${realismCues}`,
      `Tạo video review ${prodName} faceless dài đúng 6 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI. Giọng đọc review: ${voiceDesc}. Lời thoại nhân vật: "${vo3}". VISUAL:${vfx3} ${desc3}. Chuyển động: 0s-2s bắt đầu thao tác sử dụng thực tế, 2s-4s tương tác mượt mà thể hiện hiệu quả công năng vượt trội, 4s-6s giữ nguyên trạng thái hài lòng tại chỗ. ${realismCues}`,
      `Tạo video review ${prodName} faceless dài đúng 6 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI. Giọng đọc review: ${voiceDesc}. Lời thoại nhân vật: "${vo4}". VISUAL:${vfx4} ${desc4}. Chuyển động: 0s-2s khung hình tổng thể sang trọng, 2s-4s chuyển động nhẹ nhàng khoe trọn vẻ đẹp và tính tiện dụng của sản phẩm, 4s-6s kết thúc tự tin vững chãi. ${realismCues}`
    ];
  }

  return [
    `Tạo video review ${prodName} faceless dài đúng 6 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). VISUAL:${vfx1} ${desc1}. Chuyển động camera và tay chân thực, mượt mà: 0s-2s giữ yên góc quay, 2s-4s nghiêng nhẹ cổ tay khoe chi tiết và kiểu dáng sản phẩm, 4s-6s trở về vị trí tự nhiên ban đầu. ${realismCues} Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`,
    `Tạo video review ${prodName} faceless dài đúng 6 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). VISUAL:${vfx2} ${desc2}. Chuyển động: 0s-2s giữ khung hình ổn định, 2s-4s ngón tay tương tác chạm nhẹ vào chi tiết công năng thực tế, 4s-6s giữ yên góc quay tôn vinh sản phẩm. ${realismCues} Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`,
    `Tạo video review ${prodName} faceless dài đúng 6 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). VISUAL:${vfx3} ${desc3}. Chuyển động: 0s-2s bắt đầu thao tác sử dụng thực tế, 2s-4s tương tác mượt mà thể hiện hiệu quả công năng vượt trội, 4s-6s giữ nguyên trạng thái hài lòng tại chỗ. ${realismCues} Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`,
    `Tạo video review ${prodName} faceless dài đúng 6 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). VISUAL:${vfx4} ${desc4}. Chuyển động: 0s-2s khung hình tổng thể sang trọng, 2s-4s chuyển động nhẹ nhàng khoe trọn vẻ đẹp và tính tiện dụng của sản phẩm, 4s-6s kết thúc tự tin vững chãi. ${realismCues} Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`
  ];
}

/**
 * Lưu trữ metadata và kết quả vào thư mục storyboard-review-runs
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
    const pBuf = Buffer.isBuffer(p.buffer) ? p.buffer : (p.base64 ? Buffer.from(p.base64, 'base64') : null);
    if (pBuf) fs.writeFileSync(pPath, pBuf);
    p.imagePath = pPath;
  });

  const videoPrompts = getTemplate5VideoPrompts(analysis, options);
  const isNoText = !!(
    options.noText ||
    template === 'template5_1' || template === 'template5.1' || template === 'template51' ||
    template === 'template5_2' || template === 'template5.2' || template === 'template52'
  );
  const overlays = analysis?.panelOverlays || normalizePanelOverlays(analysis || {});
  const overlaysSummary = isNoText
    ? (template.includes('5_2') || template.includes('5.2') || template.includes('52')
      ? 'NO TEXT + VOICE-OVER MODE: All panels and storyboard generated without text overlays. Videos include Vietnamese review voice-over.'
      : 'NO TEXT MODE: All panels and storyboard generated without text overlays.')
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
  const isNoText = !!(
    options.noText ||
    template === 'template5_1' || template === 'template5.1' || template === 'template51' ||
    template === 'template5_2' || template === 'template5.2' || template === 'template52'
  );
  const hasVoice = !!(
    options.hasVoice ||
    template === 'template5_2' || template === 'template5.2' || template === 'template52'
  );
  const promptOptions = { ...options, template, noText: isNoText, hasVoice };

  console.log(`[Template5] Starting ${template.toUpperCase()} (${isNoText ? 'No Text' : 'With Text'}${hasVoice ? ' + Voice' : ''}) review generation for ${filePayloads.length} input image(s)...`);

  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const secure1Psid = process.env.GEMINI_SECURE_1PSID;
  const secure1Psidts = process.env.GEMINI_SECURE_1PSIDTS;
  const cookieFilePath = process.env.GEMINI_COOKIE_PATH
    ? path.resolve(effectiveBaseDir, process.env.GEMINI_COOKIE_PATH)
    : path.join(effectiveBaseDir, 'gemini.cookies.json');

  if (!secure1Psid && !cookieFilePath) {
    throw new Error('GEMINI_SECURE_1PSID or GEMINI_COOKIE_PATH is required for Template 5 storyboard generation');
  }

  const geminiClient = new GeminiApiClient({
    secure1Psid,
    secure1Psidts,
    cookieFilePath: fs.existsSync(cookieFilePath) ? cookieFilePath : undefined,
  });

  await geminiClient.init();

  let analysis = null;
  let storyboardBase64 = null;
  let masterPrompt = '';
  const panels = [];

  try {
    // 1. Phân tích sản phẩm
    const { analysis: analyzedData, uploadedFiles } = await analyzeProductTemplate5(geminiClient, filePayloads, promptOptions);
    analysis = analyzedData;

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
    if (targetChatId && storyboardBuf) {
      sendPhotoToTelegram(targetChatId, storyboardBuf, `🎨 Master Storyboard (${template.toUpperCase()}) đã tạo xong. Đang tiến hành sinh 4 panel...`)
        .catch(err => console.error('[Template5] sendPhoto error:', err.message));
    }

    // Upload storyboard image for panel generation reference
    const sbUploadUrl = await geminiClient.uploadFile(storyboardBuf, 'master_storyboard.png', 'image/png');
    const combinedFiles = [
      { url: sbUploadUrl, filename: 'master_storyboard.png', mimeType: 'image/png' },
      ...uploadedFiles
    ];

    // 3. Tách / Sinh 4 Panel 9:16 riêng biệt (có chữ hoặc không chữ) qua Gemini API
    const videoPrompts = getTemplate5VideoPrompts(analysis, promptOptions);
    let livePanelMsgId = null;
    for (let i = 1; i <= 4; i++) {
      console.log(`[Template5] Step 3: Generating Panel ${i}/4 (9:16) [${isNoText ? 'No Text' : 'With Text'}] via Gemini API...`);
      const panelPrompt = buildTemplate5PanelPrompt(i, analysis, promptOptions);

      let panelBuf = null;
      let lastPanelErr = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const panelRes = await geminiClient.generateContent({
            prompt: panelPrompt,
            fileData: combinedFiles,
            temporary: true,
            expectImages: true,
          });

          if (!panelRes.images || panelRes.images.length === 0) {
            throw new Error(`Gemini API did not return image for Panel ${i}`);
          }

          panelBuf = await geminiClient.downloadImage(panelRes.images[0].url);
          console.log(`[Template5] ✅ Panel ${i}/4 generated successfully!`);
          break;
        } catch (err) {
          lastPanelErr = err;
          console.warn(`[Template5] Panel ${i}/4 Attempt ${attempt}/3 failed: ${err.message}. Retrying in 4s...`);
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

      if (targetChatId && panelBuf) {
        try {
          livePanelMsgId = await sendOrUpdateLivePanel(targetChatId, livePanelMsgId, panelBuf, i, 4);
        } catch (_) {}
      }
    }
  } finally {
    try { await geminiClient.close(); } catch (_) {}
  }

  const progress = typeof options.onProgress === 'function' ? options.onProgress : async () => {};
  await progress({
    currentStep: 'panels_generated',
    stepOrder: 4,
    progressPercent: 60,
    message: 'Đã tạo xong 4 panel ảnh. Đang tiến hành tạo video...',
  });

  // 4. Archive kết quả
  const reviewArchive = archiveStoryboardReview(baseDir, filePayloads, masterPrompt, storyboardBase64, panels, analysis, promptOptions);

  // 5. Sinh 4 Video 6s trên Google Flow (Veo 3)
  let videos = [];
  if (options.generateVideos !== false) {
    console.log('[Template5] Step 5: Generating 4 Veo 3 6-second videos on Google Flow...');
    await progress({
      currentStep: 'generating_videos',
      stepOrder: 5,
      progressPercent: 75,
      message: 'Đang tạo 4 video bằng Veo 3...',
    });
    videos = await generateVideosFromPanelsDirect(baseDir, panels, {
      aspectRatio: '9:16',
      videoModelKey: options.videoModelKey || null,
      includeVideoBase64: !!options.includeVideoBase64,
    });
    console.log(`[Template5] Video result: ${videos.filter(v => !v.error).length}/${videos.length} completed`);
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
      productName: analysis?.productName || 'Template 5 Product Review',
      category: analysis?.category || 'general',
      hashtags: analysis?.hashtags || ['#review', '#trending', '#fashionreview'],
      summary: `✨ Đã hoàn thành review đa ngành hàng 4 cảnh 6s cho "${analysis?.productName || 'sản phẩm'}"!`,
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
};
