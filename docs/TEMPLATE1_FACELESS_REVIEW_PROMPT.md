# Template1 Faceless Footwear Review

Template này dùng cho luồng `/template1` trong Telegram bot.

Mục tiêu:

- Tạo review giày dép dạng faceless.
- Chỉ có đúng 2 cảnh.
- Không có voice-over, không lời thoại, không phụ đề.
- Hai cảnh dùng chung một bối cảnh random.
- Thời gian trong ngày random: có thể sáng, chiều, tối, trong nhà hoặc ngoài trời.
- Ánh sáng phải hợp lý với bối cảnh và thời gian đã chọn.
- Dùng được cho nhiều loại giày dép: sneaker, sandal, dép, mule, loafer, boot, v.v.
- Nhận diện sản phẩm phải bám vào bước phân tích sản phẩm trước đó.

## Step 1 - Phân Tích Và Sinh Storyboard JSON

```text
TEXT-ONLY TASK. Do not generate images. Do not call image generation. Do not create a visual storyboard asset.
You are a senior footwear product analyst, faceless commercial storyboard director, and Veo 3 prompt writer.
Analyze the uploaded footwear product reference images and create a reusable faceless review storyboard as JSON text only.

Requirements:
- Template: template1 faceless footwear review.
- Category: {category}
- Panel count: exactly 2.
- Scene ratio for each panel: {scene_ratio}.
- Use the uploaded product analysis/reference images as the source of truth for product type, color, material, sole, straps/laces, logo/text, silhouette, and styling.
- Randomly choose ONE coherent real-world setting and ONE time of day for the whole storyboard.
- Randomly choose ONE outfit styling direction for Panel 2. The outfit must fit the footwear, setting, time of day, weather/season cues, and target wearer.
- Do not hardcode one default outfit such as cream/beige wide pants.
- Both panels must share the exact same setting, time of day, weather/season cues, surface, background logic, color palette, and lighting plan.
- Panel 1 must show a beautiful feminine hand holding one sandal close to camera, with the other sandal visible behind.
- Panel 2 must be top-down POV from above while the wearer is sitting still or standing still in one place; no walking, no low-angle, no tracking shot.
- Lighting must be physically consistent with the chosen setting and time of day.
- Faceless only: no visible faces, no talking host, no presenter.
- No voice-over, no dialogue, no subtitles, no captions, no UI, no price, no rating, no watermark.
- Product identity must remain consistent across both panels.
- Return ONLY valid JSON.

JSON schema:
{
  "analysis": {
    "productName": "Vietnamese product name inferred from the images",
    "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
    "type": "footwear type",
    "materials": "visible material and construction details",
    "highlights": ["string"],
    "styling": "who/where this footwear fits",
    "uncertainties": "visible limits or details that cannot be confirmed",
    "gender": "male|female|unisex"
  },
  "sceneContext": {
    "location": "one random shared location for both panels",
    "timeOfDay": "random shared time of day",
    "lighting": "lighting that matches the location and time",
    "mood": "commercial mood",
    "continuityRules": "how both panels keep the same setting and lighting"
  },
  "outfitPlan": {
    "styleDirection": "random outfit style that fits the product and setting",
    "visibleGarments": "only the visible cropped garments/body parts, no face",
    "colorPalette": "outfit colors that complement the footwear without copying one fixed default",
    "fitReason": "why this outfit fits the product, setting, and target wearer"
  },
  "script": [
    {
      "id": 1,
      "duration": "00:00-00:08",
      "goal": "Handheld hero detail",
      "visualDescription": "beautiful feminine hand holding one sandal close to camera, second sandal behind, same shared setting",
      "cameraAction": "close-up front angle, subtle handheld product showcase",
      "productFocus": "insole, upper, charms/details, strap, sole, product shape"
    },
    {
      "id": 2,
      "duration": "00:08-00:16",
      "goal": "Stationary POV on-foot proof",
      "visualDescription": "top-down first-person POV, wearer sitting still or standing still in one place, sandals on feet, same shared setting",
      "cameraAction": "stationary top-down POV with only tiny handheld drift, no walking/tracking",
      "productFocus": "on-foot shape, charms/details, outfit pairing, comfort impression"
    }
  ],
  "frameData": "Combined detailed visual plan for exactly 2 panels, including the shared sceneContext.",
  "cropTemplate": "How to extract each panel cleanly while preserving the shared setting, lighting, and product identity.",
  "veo3Prompts": [
    "One single-line Vietnamese Veo 3 prompt for panel 1 without voice-over",
    "One single-line Vietnamese Veo 3 prompt for panel 2 without voice-over"
  ]
}

Important:
- Do not include a voiceOver field anywhere in the JSON.
- "script" and "veo3Prompts" must contain exactly 2 items.
- Each veo3 prompt must be one line.
- Each veo3 prompt must explicitly say: "Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark."
```

## Step 2 - Tạo Storyboard Tổng

```text
Generate one clean faceless footwear review storyboard image from the uploaded product reference images.

Storyboard requirements:
- Exactly 2 panels arranged side by side in one single still image.
- Each panel frame is optimized for {scene_ratio} aspect ratio.
- Both panels must share the same random setting, time of day, surface, background, mood, and lighting plan from Scene plan.
- Panel 1 is a mandatory handheld hero/detail shot: beautiful feminine hand holding one sandal close to camera, other sandal behind, same shared setting.
- Panel 2 is a mandatory top-down POV on-foot shot using the randomized outfitPlan in the exact same setting. The wearer is sitting still or standing still in one place.
- Preserve product design, color, material, silhouette, logo/text, sole, straps/laces, and identity from the reference photos.
- No visible faces.
- Do not create walking, low-angle, tracking, or movement-through-space scenes.
- No text, labels, captions, UI, logos, or watermarks inside the image.

Scene plan:
{template1_json}

Generate one still storyboard image now.
```

## Step 3 - Tạo Panel Riêng

Xem:

- `docs/1.md`
- `docs/2.md`

## Step 4 - Tạo Video

Xem:

- `docs/1.video.md`
- `docs/2.video.md`
