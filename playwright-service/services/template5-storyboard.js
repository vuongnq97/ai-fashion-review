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
function buildTemplate5AnalysisPrompt() {
  return `TEXT-ONLY TASK. Do not generate images. Do not call image generation. Do not create a visual storyboard asset.
You are a senior multi-category product marketing analyst, lifestyle content director, and Veo 3 prompt writer.
Analyze the uploaded product reference images (which can be any product: Fashion, Clothing, Bags, Footwear, Cosmetics/Skincare, Home Appliances/Kitchenware, Tech Gadgets, Accessories, etc.) and write a comprehensive product review plan as JSON text only.

Requirements:
- Panel count: exactly 4.
- Scene ratio for each panel: 9:16 vertical.
- Identify the product name in Vietnamese, category, materials/ingredients, key selling points, and target audience.
- Design an aesthetic, authentic lifestyle setting (e.g., modern sunlit living room, luxury marble vanity, contemporary kitchen countertop, aesthetic desk setup, minimalist cafe, or chic boutique) that best showcases this product naturally.
- For each of the 4 panels, extract RICH & FLEXIBLE VIETNAMESE TEXT OVERLAYS consisting of:
  1. "headline": Short, punchy uppercase title (1-4 words).
  2. "subtexts": Array of 1-3 concise bullet points / key features / specs / performance highlights / direct benefits (3-7 words each).
  CRITICAL: Every headline and subtext MUST HAVE 100% ACCURATE VIETNAMESE SPELLING AND DIACRITICS (chuẩn 100% chính tả tiếng Việt có dấu).

- TECHNOLOGY VISUAL EFFECTS & INFOGRAPHIC CUES (HIỆU ỨNG CÔNG NGHỆ ĐẶC SẮC):
  * Carefully inspect the uploaded product images for any technology demonstration cues, functional diagrams, or visual effects (e.g. water droplet splash / repel, microfiber absorption waves, 360° rotation spin, air-cushion elasticity bounce, cooling/hydrating mist, steam, sparkling clean shine reflection, suction vortex, shock-absorption layers, etc.).
  * In the "script" array, provide a vivid, detailed "techVFX" string for each panel so that both the panel imagery and the Veo 3 video animation feature dynamic, high-converting visual effects in motion.

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
  "sceneContext": {
    "location": "detailed description of setting and surface",
    "lighting": "natural daylight / warm interior lighting",
    "mood": "aesthetic, modern, authentic review"
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
      "visualDescription": "clean hero shot of product held naturally or displayed on surface",
      "techVFX": "Hiệu ứng ánh sáng tinh tế quét qua viền thân sản phẩm tôn bật chất lượng hoàn thiện cao cấp",
      "cameraAction": "close-up front angle with natural lighting"
    },
    {
      "id": 2,
      "duration": "00:06-00:12",
      "goal": "Key feature / material detail",
      "visualDescription": "macro close-up focusing on key functional detail, texture, or finish",
      "techVFX": "Hiệu ứng đặc tả công nghệ vật liệu (VD: sợi dệt microfiber hút nước tức thì, đệm lót EVA đàn hồi nhún êm, hạt dưỡng chất căng mọng)",
      "cameraAction": "extreme close-up macro"
    },
    {
      "id": 3,
      "duration": "00:12-00:18",
      "goal": "In-action user experience",
      "visualDescription": "hands-on authentic human interaction using the product smoothly",
      "techVFX": "Hiệu ứng chuyển động công năng thực tế (VD: tia nước vắt xoáy khô ráo, khớp xoay 360 độ linh hoạt, độ bám sàn chống trượt)",
      "cameraAction": "medium close-up in-action"
    },
    {
      "id": 4,
      "duration": "00:18-00:24",
      "goal": "Overall benefit & lifestyle",
      "visualDescription": "overall scene showing product integrated into daily lifestyle",
      "techVFX": "Hiệu ứng kết quả hoàn hảo (VD: bề mặt sáng bóng sạch bong phản chiếu ánh sáng trong trẻo, diện mạo tự tin)",
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
async function analyzeProductTemplate5(geminiClient, filePayloads) {
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
  const analysisPrompt = buildTemplate5AnalysisPrompt();

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
function buildTemplate5MasterPrompt(analysisData) {
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
      headline: p.headline,
      keySellingPoints: p.subtexts,
    }))
  };

  const sequenceInstructions = overlays.map(p => {
    const subtextLines = (p.subtexts || []).join(' | ');
    return `  Panel ${p.id}: Render neat, compact typography overlay in the upper safe zone with bold uppercase headline "${p.headline}" and key details: "${subtextLines}".`;
  }).join('\n');

  return `Generate one product review storyboard image (still photo collage, NOT a video) from the uploaded product reference images for ${prodName}.

CRITICAL VISUAL DIRECTION — SMARTPHONE REALISM:
- Aesthetics: Authentic smartphone camera snapshot (main lens ~26mm), natural window light, subtle realistic depth of field, real materials (matte, fabric grain, metallic brush or leather texture). No 3D render, no plastic CGI.
- Strictly faceless: No visible human faces, no presenter face. Only hands, body limbs or cropped outfit in frame.

Storyboard requirements:
- Exactly 4 panels arranged side by side in one single still image (horizontal 16:9 collage composed of 4 vertical 9:16 frames).
- Setting: All 4 panels share the exact same location (${loc}) and lighting (${lighting}).
- Sequence & Compact Typography Overlays:
${sequenceInstructions}
- Typography Rules & Safe Margin (QUAN TRỌNG: Kích thước chữ nhỏ gọn, an toàn viền):
  * Font Size: Compact, medium-small, elegant typography (kích thước chữ nhỏ gọn vừa phải, tinh tế, không in quá to).
  * Safe Margin / Padding: Leave generous inner padding of at least 15% from left, right, and top borders of each panel. Text must NEVER stretch edge-to-edge or touch the borders, ensuring text is never cropped when resized or converted to video.
  * Clean minimalist modern sans-serif font with 100% ACCURATE VIETNAMESE DIACRITICS (đúng chính tả tiếng Việt có dấu). Text should be placed neatly with high contrast and sleek aesthetic layout.
- Technology / Functional Visual Cues: If the product reference images include technology demonstration cues (e.g. water droplet repel, microfiber suction absorption, clean shine reflection, shock absorption flex, 360° spin capability), naturally incorporate subtle, aesthetic, realistic visual cues into the photography.
- Output must be a still photograph collage. Do NOT generate or describe a video.

Scene plan:
${JSON.stringify(sceneData, null, 2)}

Generate one still storyboard image now.`.trim();
}

/**
 * Xây dựng prompt cho từng Panel 9:16 riêng biệt (Gemini API)
 */
function buildTemplate5PanelPrompt(panelIndex, analysisData) {
  const a = analysisData || {};
  const overlays = a.panelOverlays || normalizePanelOverlays(a);
  const current = overlays[panelIndex - 1] || { id: panelIndex, headline: `PANEL ${panelIndex}`, subtexts: [] };
  const loc = a.sceneContext?.location || 'a bright modern setting';
  const prodName = a.productName || 'the product';
  const subtextStr = (current.subtexts || []).join(' | ');

  return `Generate a single vertical 9:16 smartphone photograph for Panel ${panelIndex} of 4 for the ${prodName} review.

VISUAL INSTRUCTIONS:
- Panel Index: ${panelIndex} of 4.
- Aspect Ratio: 9:16 vertical.
- Setting: ${loc}.
- Product Identity: Match the EXACT design, colors, textures, and details from the product reference images.
- Compact Typography Overlay & Safe Zone (QUAN TRỌNG: Kích thước chữ nhỏ gọn, không cắt mép):
  * Font Size & Scale: Compact, elegant, medium-small typography overlay positioned at the upper center. Headline is bold uppercase in moderate scale (do NOT make text oversized or giant). Subtexts are neat small bullet points.
  * Safe Margins: Generous padding (at least 15% margin from top, left, and right borders). Text must be well-contained inside the safe zone, never touching or extending close to the image edges to avoid any cutoff during video resizing/cropping.
  * Headline (Uppercase): "${current.headline}"
  * Key Details / Highlights: "${subtextStr}"
  * Ensure 100% ACCURATE VIETNAMESE SPELLING AND DIACRITICS (đúng 100% chính tả tiếng Việt có dấu, tuyệt đối không sai dấu).
- Technology / Functional Cues: If input product images show technology/functional demonstrations (e.g. water repel, microfiber absorption, elastic cushion bounce, clean shine, 360° rotation), reflect these subtle, realistic visual elements cleanly in the scene.
- Realism: Smartphone camera snapshot, natural lighting, realistic material finishes, authentic skin pores if hands/limbs are shown.
- Faceless only: No visible human faces, no watermarks, no price tags.
- Output must be a still photo. Do NOT generate a video.

Generate exactly one still image now.`.trim();
}

/**
 * Lấy danh sách 4 Prompt Veo 3 chuẩn 6s tiếng Việt cho Template 5
 * TUYỆT ĐỐI KHÔNG truyền chuỗi text trong ngoặc kép cho Veo vì Veo sẽ tự vẽ thêm chữ lỗi font.
 * Veo chỉ animate hình ảnh gốc và giữ nguyên chữ đã có sẵn trên panel ảnh.
 */
function getTemplate5VideoPrompts(analysisData) {
  const prodName = analysisData?.productName || 'sản phẩm';
  const script = analysisData?.script || [];

  const desc1 = script[0]?.visualDescription || 'Cận cảnh tay cầm sản phẩm trên bề mặt tự nhiên sang trọng';
  const vfx1 = script[0]?.techVFX ? ` HIỆU ỨNG CÔNG NGHỆ: ${script[0].techVFX}.` : '';

  const desc2 = script[1]?.visualDescription || 'Góc quay cận cảnh đặc tả chất liệu, cấu tạo và hoàn thiện tinh xảo';
  const vfx2 = script[1]?.techVFX ? ` HIỆU ỨNG CÔNG NGHỆ: ${script[1].techVFX}.` : '';

  const desc3 = script[2]?.visualDescription || 'Trải nghiệm sử dụng thực tế của người dùng với sản phẩm trong không gian';
  const vfx3 = script[2]?.techVFX ? ` HIỆU ỨNG CÔNG NGHỆ: ${script[2].techVFX}.` : '';

  const desc4 = script[3]?.visualDescription || 'Toàn cảnh sản phẩm trong không gian phong cách sống hiện đại';
  const vfx4 = script[3]?.techVFX ? ` HIỆU ỨNG CÔNG NGHỆ: ${script[3].techVFX}.` : '';

  return [
    `Tạo video review ${prodName} faceless dài đúng 6 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT ĐỒ HỌA TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO HAY OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS). VISUAL:${vfx1} ${desc1}. Chuyển động camera và tay mượt mà: 0s-2s giữ yên góc quay, 2s-4s nghiêng nhẹ cổ tay khoe chi tiết và kiểu dáng sản phẩm, 4s-6s trở về vị trí tự nhiên ban đầu. Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`,
    `Tạo video review ${prodName} faceless dài đúng 6 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT ĐỒ HỌA TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO HAY OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS). VISUAL:${vfx2} ${desc2}. Chuyển động: 0s-2s giữ khung hình ổn định, 2s-4s ngón tay tương tác chạm nhẹ vào chi tiết công năng, 4s-6s giữ yên góc quay tôn vinh sản phẩm. Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`,
    `Tạo video review ${prodName} faceless dài đúng 6 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT ĐỒ HỌA TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO HAY OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS). VISUAL:${vfx3} ${desc3}. Chuyển động: 0s-2s bắt đầu thao tác sử dụng, 2s-4s tương tác mượt mà thể hiện hiệu quả công năng vượt trội, 4s-6s giữ nguyên trạng thái hài lòng tại chỗ. Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`,
    `Tạo video review ${prodName} faceless dài đúng 6 giây, sử dụng chính xác hình ảnh gốc đã cung cấp. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT ĐỒ HỌA TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO HAY OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS). VISUAL:${vfx4} ${desc4}. Chuyển động: 0s-2s khung hình tổng thể sang trọng, 2s-4s chuyển động nhẹ nhàng khoe trọn vẻ đẹp và tính tiện dụng của sản phẩm, 4s-6s kết thúc tự tin vững chãi. Video hoàn toàn im lặng, không có voice-over, không lời thoại, không tiếng review, không nhạc nền.`
  ];
}

/**
 * Lưu trữ metadata và kết quả vào thư mục storyboard-review-runs
 */
function archiveStoryboardReview(baseDir, filePayloads, prompt, storyboardBase64, panels, analysis) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = Math.random().toString(36).substring(2, 8);
  const runDir = path.join(baseDir, 'storyboard-review-runs', `${timestamp}-template5-flow-${runId}`);
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

  const videoPrompts = getTemplate5VideoPrompts(analysis);
  const overlays = analysis?.panelOverlays || normalizePanelOverlays(analysis || {});
  const overlaysSummary = overlays.map(p => `Panel ${p.id}: [${p.headline}] ${p.subtexts.join(' / ')}`).join('\n');

  const promptsMd = [
    `# Template 5 Storyboard Run: ${timestamp}`,
    `Run ID: ${runId}`,
    `Product Name: ${analysis?.productName || 'N/A'}`,
    `Category: ${analysis?.category || 'N/A'}`,
    `Text Overlays:\n${overlaysSummary}`,
    '',
    '## Master Storyboard Prompt (Gemini API)',
    '```text',
    prompt,
    '```',
    '',
    '## Panel 1 (6s - Hero Showcase)',
    '```text',
    videoPrompts[0],
    '```',
    '',
    '## Panel 2 (6s - Key Feature / Material Detail)',
    '```text',
    videoPrompts[1],
    '```',
    '',
    '## Panel 3 (6s - In-Action / Usage Experience)',
    '```text',
    videoPrompts[2],
    '```',
    '',
    '## Panel 4 (6s - Lifestyle Context & Aesthetic Result)',
    '```text',
    videoPrompts[3],
    '```',
  ].join('\n');

  fs.writeFileSync(path.join(runDir, 'prompts.md'), promptsMd);

  return {
    root: runDir,
    panelsDir,
    videosDir: path.join(runDir, 'videos'),
    storyboardPath,
  };
}

/**
 * Main Storyboard Generator for Template 5
 */
async function generateStoryboard(baseDir, filePayloads, options = {}) {
  console.log(`[Template5] Starting Template 5 review generation for ${filePayloads.length} input image(s)...`);

  const secure1Psid = process.env.GEMINI_SECURE_1PSID;
  const secure1Psidts = process.env.GEMINI_SECURE_1PSIDTS;
  const cookieFilePath = process.env.GEMINI_COOKIE_PATH
    ? path.resolve(baseDir, process.env.GEMINI_COOKIE_PATH)
    : path.join(baseDir, 'gemini.cookies.json');

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
    const { analysis: analyzedData, uploadedFiles } = await analyzeProductTemplate5(geminiClient, filePayloads);
    analysis = analyzedData;

    // 2. Sinh Master Storyboard qua Gemini API (Không dùng ảnh ref tĩnh)
    console.log('[Template5] Step 2: Generating Master 4-Panel Storyboard via Gemini API...');
    masterPrompt = buildTemplate5MasterPrompt(analysis);

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

    // Upload storyboard image for panel generation reference
    const sbUploadUrl = await geminiClient.uploadFile(storyboardBuf, 'master_storyboard.png', 'image/png');
    const combinedFiles = [
      { url: sbUploadUrl, filename: 'master_storyboard.png', mimeType: 'image/png' },
      ...uploadedFiles
    ];

    // 3. Tách / Sinh 4 Panel 9:16 riêng biệt có chữ tiếng Việt qua Gemini API
    const videoPrompts = getTemplate5VideoPrompts(analysis);
    for (let i = 1; i <= 4; i++) {
      console.log(`[Template5] Step 3: Generating Panel ${i}/4 (9:16) with text overlay via Gemini API...`);
      const panelPrompt = buildTemplate5PanelPrompt(i, analysis);

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
    }
  } finally {
    try { await geminiClient.close(); } catch (_) {}
  }

  // 4. Archive kết quả
  const reviewArchive = archiveStoryboardReview(baseDir, filePayloads, masterPrompt, storyboardBase64, panels, analysis);

  // 5. Sinh 4 Video 6s trên Google Flow (Veo 3)
  let videos = [];
  if (options.generateVideos !== false) {
    console.log('[Template5] Step 5: Generating 4 Veo 3 6-second videos on Google Flow...');
    videos = await generateVideosFromPanelsDirect(baseDir, panels, {
      aspectRatio: '9:16',
      videoModelKey: options.videoModelKey || null,
      includeVideoBase64: !!options.includeVideoBase64,
    });
    console.log(`[Template5] Video result: ${videos.filter(v => !v.error).length}/${videos.length} completed`);

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
