# Step 1 Prompt: Phan Tich San Pham Va Sinh Kich Ban Review

File nay tap trung rieng vao Step 1 cua pipeline storyboard:

1. Nhan anh san pham thoi trang.
2. Phan tich san pham.
3. Tao kich ban review ngan theo panel.
4. Tao `frameData`, `cropTemplate`, va danh sach prompt Veo 3 mot dong cho tung panel.

Nguon code lien quan:

- `playwright-service/gemini-webapi-bridge/gemini_storyboard.py`
  - Ham chinh: `build_analysis_prompt(options)`
- `remix_-fashion-storyboard-creator-(vietnamese)/src/services/geminiService.ts`
  - Ham chinh: `analyzeProduct(images, options)`

## Muc Tieu

Prompt nay dung de bien anh san pham thanh mot goi du lieu co cau truc, gom:

- Thong tin phan tich san pham.
- Kich ban review theo tung panel, moi panel 8 giay.
- Mo ta hinh anh de sinh storyboard.
- Template tach panel.
- Prompt Veo 3 cho tung video.

## Template Prompt

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

## Bien Can Dien

```text
{category}
```

Danh muc san pham. Vi du:

```text
Giay / Sneakers
Ao thun
Tui xach
Dong ho
Do the thao
```

```text
{panel_count}
```

So panel can tao. Mac dinh nen dung `3`, moi panel dai 8 giay.

```text
{scene_ratio}
```

Ty le moi panel. Thuong dung:

```text
9:16
```

```text
{model_line}
```

Neu can nguoi mau Viet Nam:

```text
Use a young Vietnamese model when a human model is needed.
```

Neu khong bat buoc nguoi mau Viet Nam:

```text
Use a professional fashion model when a human model is needed.
```

```text
{pace_line}
```

Phong cach cuon hut:

```text
Voice-over must be short, punchy, curiosity-driven, 24-30 Vietnamese words per panel.
```

Phong cach tu nhien:

```text
Voice-over must feel natural, clear, 18-24 Vietnamese words per panel.
```

## Prompt Da Dien Bien Mau

Vi du voi san pham giay sneaker:

```text
You are a senior fashion product analyst, storyboard director, and Veo 3 prompt writer.
Analyze the uploaded product images and create a short Vietnamese review storyboard.

Requirements:
- Category: Giay / Sneakers
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

## Vi Du Ket Qua Mong Doi

```json
{
  "analysis": {
    "productName": "Giay sneaker trang de chunky",
    "hashtags": ["#giaysneaker", "#sneakertrang", "#thoitrangnamnu", "#reviewgiay", "#tiktokshop"],
    "type": "Giay sneaker thoi trang",
    "materials": "Than giay phoi luoi va da tong hop, de cao su chunky; chua thay nhan xac nhan chat lieu chinh xac.",
    "highlights": [
      "Mau trang de phoi do",
      "De chunky giup tang chieu cao thi giac",
      "Than giay phoi luoi tao cam giac nang dong"
    ],
    "styling": "Casual, streetwear, di hoc, di choi cuoi tuan",
    "uncertainties": "Khong thay ro thuong hieu, trong luong, cong nghe dem va thong so size tren anh.",
    "gender": "unisex"
  },
  "script": [
    {
      "id": 1,
      "duration": "00:00-00:08",
      "voiceOver": "Mot doi sneaker trang ma phoi gan nhu bo nao cung hop, nhat la khi ban muon cao rao hon ngay lap tuc.",
      "goal": "Hook",
      "visualDescription": "Can canh doi sneaker trang tren buc studio toi gian, anh sang mem, lam noi bat phan de chunky va than giay phoi luoi.",
      "cameraAction": "May quay dolly-in cham tu mui giay len than giay, ket thuc o goc nghieng ba phan tu."
    },
    {
      "id": 2,
      "duration": "00:00-00:08",
      "voiceOver": "Phan than phoi luoi nhin nhe va thoang, con de day giup buoc chan chac hon khi di chuyen ca ngay.",
      "goal": "Value",
      "visualDescription": "Nguoi mau Viet Nam tre mac outfit casual sang mau, buoc di tren via he hien dai, giay xuat hien ro trong tung buoc.",
      "cameraAction": "Tracking shot thap ngang co chan, bam theo chuyen dong buoc di tu nhien."
    },
    {
      "id": 3,
      "duration": "00:00-00:08",
      "voiceOver": "Muon mot doi de mang, de phoi, len hinh sach va tre trung, mau nay rat dang de thu.",
      "goal": "CTA",
      "visualDescription": "Nguoi mau dung tao dang lookbook trong studio, outfit streetwear toi gian, doi sneaker la diem nhan chinh.",
      "cameraAction": "Camera tilt tu giay len toan than, sau do giu khung hinh hero shot."
    }
  ],
  "frameData": "Panel 1: Can canh sneaker trang tren buc studio toi gian, anh sang mem, tap trung de chunky va chat lieu than giay. Panel 2: Nguoi mau Viet Nam buoc di tren via he hien dai, camera thap bam theo giay. Panel 3: Lookbook studio, nguoi mau tao dang voi outfit streetwear, doi sneaker la diem nhan chinh.",
  "cropTemplate": "Tach panel X tu storyboard da upload, giu nguyen san pham, nguoi mau, anh sang, bo cuc va phong cach hinh anh cua panel do, chuyen thanh mot anh 9:16 sach de lam start frame video. Khong them chu, khong them UI, khong tu dien giai lai canh, khong thay doi nhan dien san pham.",
  "veo3Prompts": [
    "Tao video review voi giong nhan vat nu mien Nam, Viet Nam, giong nhe nhang, de thuong. VISUAL: Can canh doi sneaker trang de chunky tren buc studio toi gian, anh sang mem, footage quang cao san pham cao cap, giu dung thiet ke giay 100%. Tone & Mood: sach, tre trung, cuon hut. Hanh dong: 0s - 4s: may quay dolly-in tu mui giay len than giay, khong xuat hien chu tren video. 5s - 8s: xoay nhe goc ba phan tu de thay de chunky va chat lieu luoi, khong xuat hien chu tren video. Script nhan vat: \"Mot doi sneaker trang ma phoi gan nhu bo nao cung hop, nhat la khi ban muon cao rao hon ngay lap tuc.\"",
    "Tao video review voi giong nhan vat nu mien Nam, Viet Nam, giong nhe nhang, de thuong. VISUAL: Nguoi mau Viet Nam tre mang sneaker trang buoc di tren via he hien dai, camera thap tap trung vao giay, giu dung form va mau san pham 100%. Tone & Mood: nang dong, tu nhien, de ung dung. Hanh dong: 0s - 4s: tracking shot ngang co chan theo tung buoc di, khong xuat hien chu tren video. 5s - 8s: chuyen sang goc nghieng cho thay do cao de va dang giay khi di chuyen, khong xuat hien chu tren video. Script nhan vat: \"Phan than phoi luoi nhin nhe va thoang, con de day giup buoc chan chac hon khi di chuyen ca ngay.\"",
    "Tao video review voi giong nhan vat nu mien Nam, Viet Nam, giong nhe nhang, de thuong. VISUAL: Nguoi mau tao dang lookbook trong studio voi outfit streetwear toi gian, sneaker trang la diem nhan chinh, giu dung san pham va nhan vat 100%. Tone & Mood: tu tin, thoi trang, thuyet phuc. Hanh dong: 0s - 4s: camera tilt tu doi giay len outfit toan than, khong xuat hien chu tren video. 5s - 8s: giu hero shot voi anh sang mem va dang dung tu nhien, khong xuat hien chu tren video. Script nhan vat: \"Muon mot doi de mang, de phoi, len hinh sach va tre trung, mau nay rat dang de thu.\""
  ]
}
```

## Ghi Chu Khi Dung

- Nen giu output la JSON thuan de pipeline parse duoc on dinh.
- `script` va `veo3Prompts` phai co dung so luong bang `panel_count`.
- Prompt Veo 3 nen nam tren mot dong duy nhat, vi cac buoc sau co logic tach/copy prompt theo tung panel.
- Neu anh khong thay ro thuong hieu, chat lieu, gia, size hoac cong nghe san pham, phai ghi ro la chua thay ro, khong tu bia.
