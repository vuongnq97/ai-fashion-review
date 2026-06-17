# Template Prompt Tạo Storyboard

Tài liệu này tóm tắt template prompt tạo storyboard đang dùng trong project AI Fashion Review.

Nguồn code hiện tại:

- `playwright-service/gemini-webapi-bridge/gemini_storyboard.py`
  - `build_analysis_prompt(...)`: phân tích ảnh sản phẩm, viết kịch bản, tạo prompt Veo 3.
  - `build_storyboard_prompt(...)`: tạo ảnh storyboard tổng.
  - `build_panel_prompt(...)`: tạo từng start frame/panel riêng.
- `remix_-fashion-storyboard-creator-(vietnamese)/src/services/geminiService.ts`
  - `analyzeProduct(...)`: bản app UI dùng Gemini API.
  - `generateStoryboardImage(...)`: tạo storyboard dạng lưới.
  - `generateScenePanel(...)`: tách/nâng cấp từng panel.

## Luồng Prompt

Project không chỉ có một prompt duy nhất. Storyboard được tạo theo 3 bước:

1. Phân tích sản phẩm và sinh kịch bản review.
2. Tạo ảnh storyboard tổng từ dữ liệu kịch bản.
3. Tạo từng ảnh panel/start frame riêng để đưa sang Veo 3.

## 1. Prompt Phân Tích Và Viết Kịch Bản

Template:

```text
You are a senior fashion product analyst, storyboard director, and Veo 3 prompt writer.
Analyze the uploaded product images and create a short Vietnamese review storyboard.

Requirements:
- Category: {category}
- Panel count: exactly {panel_count}
- Scene ratio for each panel: {scene_ratio}
- {model_line}
- {pace_line}
- Product identity must remain consistent across all panels.
- Do not ask follow-up questions.
- Return ONLY valid JSON. No markdown, no commentary.

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
  "frameData": "Combined detailed visual plan for all panels.",
  "cropTemplate": "How to crop/extract each panel cleanly.",
  "veo3Prompts": [
    "One single-line Vietnamese Veo 3 prompt for panel 1"
  ]
}

Important:
- Infer "analysis.productName" from visible product information, product type, design, and labels/text in the images.
- Extract existing hashtags from the images if visible. If fewer than 5 are visible, add relevant Vietnamese/TikTok-friendly fashion hashtags until there are exactly 5.
- "analysis.hashtags" must contain exactly 5 unique hashtags, each starting with "#".
- "script" and "veo3Prompts" must contain exactly {panel_count} items.
- Each veo3 prompt must be one line, with no newline characters.
- Each veo3 prompt must include VISUAL, Tone & Mood, Action timing 0s-4s and 5s-8s, and Script nhan vat.
```

Biến cần điền:

- `{category}`: danh mục sản phẩm, ví dụ `Giày / Sneakers`.
- `{panel_count}`: số panel, mặc định thường là `3`.
- `{scene_ratio}`: tỷ lệ từng panel, thường là `9:16`.
- `{model_line}`:
  - Nếu dùng người mẫu Việt Nam: `Use a young Vietnamese model when a human model is needed.`
  - Nếu không: `Use a professional fashion model when a human model is needed.`
- `{pace_line}`:
  - Phong cách cuốn hút: `Voice-over must be short, punchy, curiosity-driven, 24-30 Vietnamese words per panel.`
  - Phong cách tự nhiên: `Voice-over must feel natural, clear, 18-24 Vietnamese words per panel.`

## 2. Prompt Tạo Ảnh Storyboard Tổng

Template:

```text
Generate one clean fashion storyboard image from the uploaded product reference images.

Storyboard requirements:
- Exactly {panel_count} panels.
- Each panel is optimized for {scene_ratio}.
- Show one coherent Vietnamese fashion product review sequence.
- Preserve product design, color, material, and identity from the references.
- Use cinematic commercial lighting, realistic fashion photography, clean composition.
- {text_rule}

Storyboard data:
{analysis_json}

Generate an image. Do not return only text.
```

Biến cần điền:

- `{panel_count}`: số panel.
- `{scene_ratio}`: tỷ lệ từng panel.
- `{text_rule}`:
  - Mặc định: `No text, labels, captions, UI, logos, or watermarks inside the image.`
  - Nếu cho phép chữ: `Avoid unnecessary text.`
- `{analysis_json}`: JSON trả về từ bước phân tích/kịch bản.

## 3. Prompt Tạo Từng Panel / Start Frame

Template:

```text
Generate a single clean start-frame image for video.

Panel: {panel_index} of {panel_count}
Aspect ratio: {scene_ratio}
Instruction:
- {source_instruction}
- Keep the product identity exactly consistent with the reference.
- Do not include text, labels, captions, UI, or watermarks.
- Make it a polished vertical fashion commercial frame suitable for Veo 3 start image.

Panel script:
{script_item_json}

Veo 3 prompt for this panel:
{veo_prompt}

Generate exactly one image. Do not return only text.
```

Biến cần điền:

- `{panel_index}`: số thứ tự panel, bắt đầu từ `1`.
- `{panel_count}`: tổng số panel.
- `{scene_ratio}`: tỷ lệ frame, ví dụ `9:16`.
- `{source_instruction}`:
  - Nếu có storyboard tổng: `Use the uploaded storyboard image as the main visual reference and extract/recreate only this panel.`
  - Nếu không có storyboard tổng: `Use the uploaded product images as visual references and create this panel directly.`
- `{script_item_json}`: object script của panel đang xử lý.
- `{veo_prompt}`: prompt Veo 3 một dòng của panel đó.

## Ví Dụ Cụ Thể

Input giả định:

- Ảnh upload: 2 ảnh giày sneaker trắng, đế chunky, phối lưới và da tổng hợp.
- `category`: `Giày / Sneakers`
- `panel_count`: `3`
- `scene_ratio`: `9:16`
- `model_line`: `Use a young Vietnamese model when a human model is needed.`
- `pace_line`: `Voice-over must be short, punchy, curiosity-driven, 24-30 Vietnamese words per panel.`
- `text_rule`: `No text, labels, captions, UI, logos, or watermarks inside the image.`

Prompt phân tích/kịch bản sau khi điền biến:

```text
You are a senior fashion product analyst, storyboard director, and Veo 3 prompt writer.
Analyze the uploaded product images and create a short Vietnamese review storyboard.

Requirements:
- Category: Giày / Sneakers
- Panel count: exactly 3
- Scene ratio for each panel: 9:16
- Use a young Vietnamese model when a human model is needed.
- Voice-over must be short, punchy, curiosity-driven, 24-30 Vietnamese words per panel.
- Product identity must remain consistent across all panels.
- Do not ask follow-up questions.
- Return ONLY valid JSON. No markdown, no commentary.

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
  "frameData": "Combined detailed visual plan for all panels.",
  "cropTemplate": "How to crop/extract each panel cleanly.",
  "veo3Prompts": [
    "One single-line Vietnamese Veo 3 prompt for panel 1"
  ]
}

Important:
- Infer "analysis.productName" from visible product information, product type, design, and labels/text in the images.
- Extract existing hashtags from the images if visible. If fewer than 5 are visible, add relevant Vietnamese/TikTok-friendly fashion hashtags until there are exactly 5.
- "analysis.hashtags" must contain exactly 5 unique hashtags, each starting with "#".
- "script" and "veo3Prompts" must contain exactly 3 items.
- Each veo3 prompt must be one line, with no newline characters.
- Each veo3 prompt must include VISUAL, Tone & Mood, Action timing 0s-4s and 5s-8s, and Script nhan vat.
```

Ví dụ JSON kết quả mong muốn:

```json
{
  "analysis": {
    "productName": "Giày sneaker trắng đế chunky",
    "hashtags": ["#giaysneaker", "#sneakertrang", "#thoitrangnamnu", "#reviewgiay", "#tiktokshop"],
    "type": "Giày sneaker thời trang",
    "materials": "Phối lưới thoáng khí, da tổng hợp và đế cao su chunky; chất liệu chính xác chưa thấy nhãn xác nhận.",
    "highlights": ["Form trắng dễ phối đồ", "Đế chunky tạo cảm giác cao hơn", "Thân giày phối lưới tạo vẻ năng động"],
    "styling": "Casual, streetwear, đi học, đi chơi cuối tuần",
    "uncertainties": "Không thấy rõ thương hiệu, trọng lượng, công nghệ đệm và chất liệu chính xác trên nhãn.",
    "gender": "unisex"
  },
  "script": [
    {
      "id": 1,
      "duration": "00:00-00:08",
      "voiceOver": "Một đôi sneaker trắng mà phối gần như bộ nào cũng hợp, nhất là khi bạn muốn cao ráo hơn ngay lập tức.",
      "goal": "Hook",
      "visualDescription": "Cận cảnh đôi sneaker trắng trên bục studio tối giản, ánh sáng mềm, làm nổi bật phần đế chunky và thân giày phối lưới.",
      "cameraAction": "Máy quay dolly-in chậm từ mũi giày lên thân giày, kết thúc ở góc nghiêng ba phần tư."
    },
    {
      "id": 2,
      "duration": "00:00-00:08",
      "voiceOver": "Phần thân phối lưới nhìn nhẹ và thoáng, còn đế dày giúp bước chân chắc hơn khi di chuyển cả ngày.",
      "goal": "Value",
      "visualDescription": "Người mẫu Việt Nam trẻ mặc outfit casual sáng màu, bước đi trên vỉa hè hiện đại, giày xuất hiện rõ trong từng bước.",
      "cameraAction": "Tracking shot thấp ngang cổ chân, bám theo chuyển động bước đi tự nhiên."
    },
    {
      "id": 3,
      "duration": "00:00-00:08",
      "voiceOver": "Muốn một đôi dễ mang, dễ phối, lên hình sạch và trẻ trung, mẫu này rất đáng để thử.",
      "goal": "CTA",
      "visualDescription": "Người mẫu đứng tạo dáng lookbook trong studio, outfit streetwear tối giản, đôi sneaker là điểm nhấn chính.",
      "cameraAction": "Camera tilt từ giày lên toàn thân, sau đó giữ khung hình hero shot."
    }
  ],
  "frameData": "Panel 1: Cận cảnh sneaker trắng trên bục studio tối giản, ánh sáng mềm, tập trung đế chunky và chất liệu thân giày. Panel 2: Người mẫu Việt Nam bước đi trên vỉa hè hiện đại, camera thấp bám theo giày. Panel 3: Lookbook studio, người mẫu tạo dáng với outfit streetwear, đôi sneaker là điểm nhấn chính.",
  "cropTemplate": "Tách panel X từ storyboard đã upload, giữ nguyên sản phẩm, người mẫu, ánh sáng, bố cục và phong cách hình ảnh của panel đó, chuyển thành một ảnh 9:16 sạch để làm start frame video. Không thêm chữ, không thêm UI, không tự diễn giải lại cảnh, không thay đổi nhận diện sản phẩm.",
  "veo3Prompts": [
    "Tạo video review với giọng nhân vật nữ miền Nam, Việt Nam, giọng nhẹ nhàng, dễ thương. VISUAL: Cận cảnh đôi sneaker trắng đế chunky trên bục studio tối giản, ánh sáng mềm, footage quảng cáo sản phẩm cao cấp, giữ đúng thiết kế giày 100%. Tone & Mood: sạch, trẻ trung, cuốn hút. Hành động: 0s - 4s: máy quay dolly-in từ mũi giày lên thân giày, không xuất hiện chữ trên video. 5s - 8s: xoay nhẹ góc ba phần tư để thấy đế chunky và chất liệu lưới, không xuất hiện chữ trên video. Script nhan vat: “Một đôi sneaker trắng mà phối gần như bộ nào cũng hợp, nhất là khi bạn muốn cao ráo hơn ngay lập tức.”",
    "Tạo video review với giọng nhân vật nữ miền Nam, Việt Nam, giọng nhẹ nhàng, dễ thương. VISUAL: Người mẫu Việt Nam trẻ mang sneaker trắng bước đi trên vỉa hè hiện đại, camera thấp tập trung vào giày, giữ đúng form và màu sản phẩm 100%. Tone & Mood: năng động, tự nhiên, dễ ứng dụng. Hành động: 0s - 4s: tracking shot ngang cổ chân theo từng bước đi, không xuất hiện chữ trên video. 5s - 8s: chuyển sang góc nghiêng cho thấy độ cao đế và dáng giày khi di chuyển, không xuất hiện chữ trên video. Script nhan vat: “Phần thân phối lưới nhìn nhẹ và thoáng, còn đế dày giúp bước chân chắc hơn khi di chuyển cả ngày.”",
    "Tạo video review với giọng nhân vật nữ miền Nam, Việt Nam, giọng nhẹ nhàng, dễ thương. VISUAL: Người mẫu tạo dáng lookbook trong studio với outfit streetwear tối giản, sneaker trắng là điểm nhấn chính, giữ đúng sản phẩm và nhân vật 100%. Tone & Mood: tự tin, thời trang, thuyết phục. Hành động: 0s - 4s: camera tilt từ đôi giày lên outfit toàn thân, không xuất hiện chữ trên video. 5s - 8s: giữ hero shot với ánh sáng mềm và dáng đứng tự nhiên, không xuất hiện chữ trên video. Script nhan vat: “Muốn một đôi dễ mang, dễ phối, lên hình sạch và trẻ trung, mẫu này rất đáng để thử.”"
  ]
}
```

Prompt tạo storyboard tổng từ JSON ví dụ:

```text
Generate one clean fashion storyboard image from the uploaded product reference images.

Storyboard requirements:
- Exactly 3 panels.
- Each panel is optimized for 9:16.
- Show one coherent Vietnamese fashion product review sequence.
- Preserve product design, color, material, and identity from the references.
- Use cinematic commercial lighting, realistic fashion photography, clean composition.
- No text, labels, captions, UI, logos, or watermarks inside the image.

Storyboard data:
{JSON kết quả ở trên}

Generate an image. Do not return only text.
```

Prompt tạo riêng panel 1:

```text
Generate a single clean start-frame image for video.

Panel: 1 of 3
Aspect ratio: 9:16
Instruction:
- Use the uploaded storyboard image as the main visual reference and extract/recreate only this panel.
- Keep the product identity exactly consistent with the reference.
- Do not include text, labels, captions, UI, or watermarks.
- Make it a polished vertical fashion commercial frame suitable for Veo 3 start image.

Panel script:
{
  "id": 1,
  "duration": "00:00-00:08",
  "voiceOver": "Một đôi sneaker trắng mà phối gần như bộ nào cũng hợp, nhất là khi bạn muốn cao ráo hơn ngay lập tức.",
  "goal": "Hook",
  "visualDescription": "Cận cảnh đôi sneaker trắng trên bục studio tối giản, ánh sáng mềm, làm nổi bật phần đế chunky và thân giày phối lưới.",
  "cameraAction": "Máy quay dolly-in chậm từ mũi giày lên thân giày, kết thúc ở góc nghiêng ba phần tư."
}

Veo 3 prompt for this panel:
Tạo video review với giọng nhân vật nữ miền Nam, Việt Nam, giọng nhẹ nhàng, dễ thương. VISUAL: Cận cảnh đôi sneaker trắng đế chunky trên bục studio tối giản, ánh sáng mềm, footage quảng cáo sản phẩm cao cấp, giữ đúng thiết kế giày 100%. Tone & Mood: sạch, trẻ trung, cuốn hút. Hành động: 0s - 4s: máy quay dolly-in từ mũi giày lên thân giày, không xuất hiện chữ trên video. 5s - 8s: xoay nhẹ góc ba phần tư để thấy đế chunky và chất liệu lưới, không xuất hiện chữ trên video. Script nhan vat: “Một đôi sneaker trắng mà phối gần như bộ nào cũng hợp, nhất là khi bạn muốn cao ráo hơn ngay lập tức.”

Generate exactly one image. Do not return only text.
```
