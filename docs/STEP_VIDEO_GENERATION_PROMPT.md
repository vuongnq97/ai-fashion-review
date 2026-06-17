# Step Video Prompt: Tao Video Tu Panel / Start Frame

File nay tap trung vao step tao video trong pipeline AI Fashion Review.

Nguon code lien quan:

- `playwright-service/routes/index.js`
  - Endpoint: `POST /api/generate-video`
- `playwright-service/services/video.js`
  - Ham chinh: `prepareVideoGeneration(...)`
  - Ham chinh: `startVideoGeneration(...)`
  - API Flow/Veo: `batchAsyncGenerateVideoStartImage`
- `remix_-fashion-storyboard-creator-(vietnamese)/src/App.tsx`
  - UI gui `prompt`, `base64Images`, `aspectRatio`, `videoModelKey`
- `playwright-service/gemini-webapi-bridge/gemini_storyboard.py`
  - Field dau ra tu Step 1: `veo3Prompts`

## Muc Tieu

Step nay nhan:

- 1 anh panel/start frame tu storyboard.
- 1 prompt Veo 3 tuong ung voi panel do.
- Ty le video, thuong la `9:16`.

Sau do service upload anh start frame len Google Flow va tao video image-to-video bang Veo.

## Template Prompt Veo 3

Moi panel nen co 1 prompt rieng, doc lap, dung de paste truc tiep vao Flow/Veo hoac gui qua `/api/generate-video`.

Template:

```text
Tao video review voi giong nhan vat {voice_gender_region}, giong {voice_style}. VISUAL: {visual_description}. Khoa anh san pham va nhan vat khong thay doi, khong bien dang, dung chuan tham chieu 100%. Tone & Mood: {tone_mood}. Hanh dong: 0s - 4s: {action_0_4}, khong xuat hien chu tren video. 5s - 8s: {action_5_8}, khong xuat hien chu tren video. Script nhan vat: "{voice_over}"
```

## Bien Can Dien

```text
{voice_gender_region}
```

Giong doc. Mac dinh trong project dang dung:

```text
nu mien Nam, Viet Nam
```

```text
{voice_style}
```

Phong thai giong doc. Vi du:

```text
nhe nhang, de thuong
tu tin, nang dong
thanh lich, thuyet phuc
```

```text
{visual_description}
```

Mo ta visual cua video, nen lay tu `script[n].visualDescription` va bo sung kieu footage.

Vi du:

```text
Can canh doi sneaker trang de chunky tren buc studio toi gian, anh sang mem, footage quang cao san pham cao cap
```

```text
{tone_mood}
```

Cam xuc va phong cach video.

Vi du:

```text
sach, tre trung, cuon hut
nang dong, tu nhien, de ung dung
tu tin, thoi trang, thuyet phuc
```

```text
{action_0_4}
```

Chuyen dong/camera tu giay 0 den 4.

```text
may quay dolly-in tu mui giay len than giay
```

```text
{action_5_8}
```

Chuyen dong/camera tu giay 5 den 8.

```text
xoay nhe goc ba phan tu de thay de chunky va chat lieu luoi
```

```text
{voice_over}
```

Loi nhan vat doc trong video, lay tu `script[n].voiceOver`.

## Quy Tac Bat Buoc

- Moi prompt tao dung 1 video 8 giay.
- Moi prompt phai tu dung mot minh, khong phu thuoc vao prompt panel khac.
- Moi prompt nen nam tren 1 dong duy nhat de pipeline copy/parse on dinh.
- Luon khoa san pham: mau sac, form dang, chat lieu, logo/chi tiet neu co.
- Neu co nguoi mau, khoa nhan dien nguoi mau va outfit.
- Khong de chu, caption, UI, gia tien, rating, watermark xuat hien trong video.
- Khong yeu cau model tao san pham moi, doi mau, doi logo, doi form.
- Neu video di tu start frame, prompt phai bam sat start frame, khong mo ta canh qua khac.

## Template Payload Goi API

Endpoint:

```text
POST http://localhost:3000/api/generate-video
```

Body JSON:

```json
{
  "prompt": "{veo3_prompt}",
  "base64Images": ["{panel_start_frame_base64}"],
  "aspectRatio": "9:16",
  "videoModelKey": "veo_3_1_i2v_lite_low_priority",
  "panelIndex": 1,
  "panelName": "Panel1"
}
```

Field quan trong:

- `prompt`: prompt Veo 3 mot dong.
- `base64Images`: anh panel/start frame, dang base64 khong can prefix `data:image/...`.
- `aspectRatio`: `9:16`, `16:9`, hoac `1:1`.
- `videoModelKey`: model Veo. Neu de trong, service tu chon theo `aspectRatio`.
- `panelIndex`, `panelName`: tuy chon, dung de log/gui Telegram.

## Vi Du Cu The

Input:

```json
{
  "panelIndex": 1,
  "panelName": "Panel1",
  "aspectRatio": "9:16",
  "visualDescription": "Can canh doi sneaker trang tren buc studio toi gian, anh sang mem, lam noi bat phan de chunky va than giay phoi luoi.",
  "cameraAction": "May quay dolly-in cham tu mui giay len than giay, ket thuc o goc nghieng ba phan tu.",
  "voiceOver": "Mot doi sneaker trang ma phoi gan nhu bo nao cung hop, nhat la khi ban muon cao rao hon ngay lap tuc."
}
```

Prompt Veo 3 hoan chinh:

```text
Tao video review voi giong nhan vat nu mien Nam, Viet Nam, giong nhe nhang, de thuong. VISUAL: Can canh doi sneaker trang de chunky tren buc studio toi gian, anh sang mem, footage quang cao san pham cao cap, giu dung thiet ke giay 100%. Khoa anh san pham va nhan vat khong thay doi, khong bien dang, dung chuan tham chieu 100%. Tone & Mood: sach, tre trung, cuon hut. Hanh dong: 0s - 4s: may quay dolly-in tu mui giay len than giay, khong xuat hien chu tren video. 5s - 8s: xoay nhe goc ba phan tu de thay de chunky va chat lieu luoi, khong xuat hien chu tren video. Script nhan vat: "Mot doi sneaker trang ma phoi gan nhu bo nao cung hop, nhat la khi ban muon cao rao hon ngay lap tuc."
```

Payload API mau:

```json
{
  "prompt": "Tao video review voi giong nhan vat nu mien Nam, Viet Nam, giong nhe nhang, de thuong. VISUAL: Can canh doi sneaker trang de chunky tren buc studio toi gian, anh sang mem, footage quang cao san pham cao cap, giu dung thiet ke giay 100%. Khoa anh san pham va nhan vat khong thay doi, khong bien dang, dung chuan tham chieu 100%. Tone & Mood: sach, tre trung, cuon hut. Hanh dong: 0s - 4s: may quay dolly-in tu mui giay len than giay, khong xuat hien chu tren video. 5s - 8s: xoay nhe goc ba phan tu de thay de chunky va chat lieu luoi, khong xuat hien chu tren video. Script nhan vat: \"Mot doi sneaker trang ma phoi gan nhu bo nao cung hop, nhat la khi ban muon cao rao hon ngay lap tuc.\"",
  "base64Images": ["{panel1_base64}"],
  "aspectRatio": "9:16",
  "videoModelKey": "veo_3_1_i2v_lite_low_priority",
  "panelIndex": 1,
  "panelName": "Panel1"
}
```

## Vi Du Cho 3 Panel

Panel 1:

```text
Tao video review voi giong nhan vat nu mien Nam, Viet Nam, giong nhe nhang, de thuong. VISUAL: Can canh doi sneaker trang de chunky tren buc studio toi gian, anh sang mem, footage quang cao san pham cao cap, giu dung thiet ke giay 100%. Khoa anh san pham va nhan vat khong thay doi, khong bien dang, dung chuan tham chieu 100%. Tone & Mood: sach, tre trung, cuon hut. Hanh dong: 0s - 4s: may quay dolly-in tu mui giay len than giay, khong xuat hien chu tren video. 5s - 8s: xoay nhe goc ba phan tu de thay de chunky va chat lieu luoi, khong xuat hien chu tren video. Script nhan vat: "Mot doi sneaker trang ma phoi gan nhu bo nao cung hop, nhat la khi ban muon cao rao hon ngay lap tuc."
```

Panel 2:

```text
Tao video review voi giong nhan vat nu mien Nam, Viet Nam, giong nhe nhang, de thuong. VISUAL: Nguoi mau Viet Nam tre mang sneaker trang buoc di tren via he hien dai, camera thap tap trung vao giay, giu dung form va mau san pham 100%. Khoa anh san pham va nhan vat khong thay doi, khong bien dang, dung chuan tham chieu 100%. Tone & Mood: nang dong, tu nhien, de ung dung. Hanh dong: 0s - 4s: tracking shot ngang co chan theo tung buoc di, khong xuat hien chu tren video. 5s - 8s: chuyen sang goc nghieng cho thay do cao de va dang giay khi di chuyen, khong xuat hien chu tren video. Script nhan vat: "Phan than phoi luoi nhin nhe va thoang, con de day giup buoc chan chac hon khi di chuyen ca ngay."
```

Panel 3:

```text
Tao video review voi giong nhan vat nu mien Nam, Viet Nam, giong nhe nhang, de thuong. VISUAL: Nguoi mau tao dang lookbook trong studio voi outfit streetwear toi gian, sneaker trang la diem nhan chinh, giu dung san pham va nhan vat 100%. Khoa anh san pham va nhan vat khong thay doi, khong bien dang, dung chuan tham chieu 100%. Tone & Mood: tu tin, thoi trang, thuyet phuc. Hanh dong: 0s - 4s: camera tilt tu doi giay len outfit toan than, khong xuat hien chu tren video. 5s - 8s: giu hero shot voi anh sang mem va dang dung tu nhien, khong xuat hien chu tren video. Script nhan vat: "Muon mot doi de mang, de phoi, len hinh sach va tre trung, mau nay rat dang de thu."
```

## Luu Y Khi Tao Video Hang Loat

- Moi panel nen gui 1 request rieng voi anh start frame tuong ung.
- Khong nen dung chung mot prompt cho nhieu panel.
- Neu video bi lech nhan dien san pham, tang do manh cua cau khoa san pham trong `VISUAL`.
- Neu video xuat hien chu, them ro: `tuyet doi khong co chu viet, so, caption, watermark, UI hay gia tien trong bat ky khung hinh nao`.
- Neu camera chuyen dong qua manh, dung cac dong tu nhe hon: `slow dolly-in`, `subtle pan`, `gentle tilt`, `hold hero shot`.
