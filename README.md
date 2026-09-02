# AI Fashion Review

Hệ thống tự động nhận ảnh sản phẩm thời trang từ Telegram, tạo storyboard bằng Google AI Studio, tạo video bằng Veo 3 (Google Flow) qua **direct API** (không thao tác DOM), resize video 9:16, rồi gửi video hoàn chỉnh lại Telegram — tất cả chạy trong một server Node.js duy nhất.

## Kiến Trúc

```text
Telegram user gửi ảnh
  → Telegram Bot (long-polling, tích hợp trong server)
  → Google AI Studio tạo storyboard + panel images + prompts
  → Pre-launch Google Flow tab → lấy Bearer + reCAPTCHA token
  → Direct API upload ảnh lên Flow (/v1/flow/uploadImage)
  → Direct API tạo video Veo 3 (batchAsyncGenerateVideoStartImage)
  → FFmpeg resize/crop video 9:16
  → Telegram bot gửi video đã resize về cho user
```

**Không phụ thuộc n8n** cho luồng chính. Server tự xử lý toàn bộ pipeline.

## Yêu Cầu

- macOS hoặc Linux (cần Chrome/Chromium chạy được UI)
- Node.js 20+
- npm
- FFmpeg (cần cho resize/crop video)
- Tài khoản Google đã vào được Google AI Studio và Google Flow
- Telegram bot token từ BotFather

## Cấu Trúc Dự Án

```text
playwright-service/
  server.js                         Express + Telegram bot entry point, port 3000
  routes/index.js                   REST API endpoints
  login.js                          Đăng nhập Google lần đầu
  config.json                       Cấu hình (storyboard provider, panel count...)

  services/
    telegram-bot.js                 Telegram long-polling listener
    telegram-send.js                Gửi tin nhắn/video về Telegram
    storyboard-fullflow.js          Orchestrator luồng review sản phẩm
    storyboard-provider.js          Chọn provider: aistudio-playwright | gemini-webapi
    aistudio.js                     Giao tiếp với Google AI Studio (storyboard)
    gemini-webapi-storyboard.js     Storyboard qua Gemini WebAPI (Node.js/Python bridge)
    dailyvlog-flow.js               State machine + flow controller cho Daily Vlog
    dailyvlog-storyboard.js         Pipeline + prompts cho Daily Vlog
    browser.js                      Quản lý browser context, Bearer + reCAPTCHA token
    image.js                        Upload ảnh qua direct API (uploadImageDirect)
    video.js                        Tạo video Veo 3 qua direct API
    video-resize.js                 Resize/crop video bằng FFmpeg
    drive-folder.js                 Load ảnh từ Google Drive/local folder
    tiktok.js                       TikTok OAuth + upload (tùy chọn)

  services/gemini-client/
    gemini-api.js                   Gemini Web API client (Playwright-based)
    gemini-storyboard.js            Node.js storyboard generation (thay Python bridge)

  utils/
    config-manager.js               Đọc/ghi config.json
    flow-asset-watchdog.js          Theo dõi asset upload status
    flow-submit-watchdog.js         Theo dõi video generation status

  assets/nhi/                       Ảnh tham chiếu nhân vật Nhi (cho Daily Vlog)
  uploads/                          File tạm (panel images, video downloads)
  chrome-data/                      Chrome profile/session đăng nhập Google
```

## Cài Đặt Cho Máy Mới (1-Click Setup)

### Cách 1: Chạy file Setup tự động (Khuyên dùng)

Sau khi clone repo về máy:

- **Trên macOS & Linux**:
  ```bash
  git clone https://github.com/vuongnq97/ai-fashion-review.git
  cd ai-fashion-review
  ./setup.sh
  ```
- **Trên Windows**:
  - Clone repo hoặc tải ZIP giải nén.
  - **Click đúp (Double-click) vào file `setup.bat`** (hoặc mở Command Prompt gõ `setup.bat`).

*(Script sẽ tự động kiểm tra Node.js — nếu máy chưa có sẽ tự tải & cài Node.js v20 LTS, chạy `npm install`, tải Playwright Chromium, tạo các thư mục dữ liệu, tạo file `.env` và mở trình duyệt để bạn đăng nhập Google lần đầu).*

---

### Khởi động Server sau khi Setup:
- **macOS & Linux**: `./start.sh` (hoặc `cd playwright-service && node server.js`)
- **Windows**: Click đúp vào file `start.bat` (hoặc `cd playwright-service && node server.js`)

---

### Cách 2: Cài Đặt Thủ Công

#### 1. Cài Dependencies & Playwright Browser:
```bash
cd playwright-service
npm install
npx playwright install chromium
```

#### 2. Cấu Hình Environment:
```bash
cp .env.example .env
```
Mở `playwright-service/.env` và điền:
- `TELEGRAM_BOT_TOKEN=...` (Token riêng lấy từ `@BotFather` cho máy này).
- `PORT=3000`

#### 3. Đăng Nhập Google Lần Đầu:
```bash
cd playwright-service
node login.js
```
- Trình duyệt sẽ mở ra trang Google Labs / Flow.
- Đăng nhập tài khoản Google của bạn rồi đóng trình duyệt để lưu session vào `chrome-data/`.

#### 4. Khởi Động Server:
```bash
cd playwright-service
node server.js
```

---

## Các Template Hỗ Trợ Trên Telegram Bot

| Lệnh Telegram | Chức Năng & Đặc Điểm |
|---|---|
| `/template6` | **Review Siêu Thị POV 2 cảnh 8s (Bách Hóa Xanh / WinMart, Không Chữ, Không Tiếng)** — Tự động xếp gian hàng siêu thị ngẫu nhiên, đổi outfit người review, Cảnh 1 cầm xem ngang ngực, Cảnh 2 đặt vào giỏ hàng dưới sàn. |
| `/template5` | **Review Đa Ngành Hàng 4 cảnh 6s** (Thời trang, Mỹ phẩm, Gia dụng... tự động phân tích qua Gemini API, có thẻ chữ tiếng Việt nhỏ gọn trong safe-zone, không tiếng review). |
| `/template5_1` | **Review Đa Ngành Hàng 4 cảnh 6s (KHÔNG CHỮ / No Text $100\%$)** — Storyboard, 4 Panel và 4 Video đều sạch hoàn toàn không chữ, tập trung góc quay thực tế. |
| `/template5_2` | **Review Đa Ngành Hàng 4 cảnh 6s (KHÔNG CHỮ + GIỌNG NÓI VOICE-OVER)** — Storyboard & Panel sạch không chữ, video có giọng đọc review tiếng Việt chuẩn nam/nữ theo sản phẩm, faceless $100\%$. |
| `/template1` | Review giày dép/thời trang faceless 2 cảnh (không voice-over). |
| `/template2` | Review giày dép 8 cảnh x 4s (không voice-over). |
| `/template3` | Review shop giày dép 4 cảnh (Top-down 8s, POV 6s, góc hông 4s, đứng thử 8s). |
| `/template4` | Review giày/dép nữ shop pastel 4 cảnh (Cận cảnh 8s, POV váy 6s, góc nệm 4s, đứng dáng 8s). |
| `/remake <cảnh> [yêu cầu]` | **Tạo lại video cảnh chưa ưng ý** (VD: `/remake 2` hoặc `/remake 2 xoay nhẹ góc 45 độ` để ưu tiên custom prompt). |
| `/dailyvlog` | Tạo vlog lifestyle cho nhân vật Nhi. |
| `/status` | Xem trạng thái hàng đợi xử lý video. |

---

## Sử Dụng

### Luồng Chính: Review Sản Phẩm (Telegram → Video)

1. Mở Telegram, chat với bot của bạn.
2. Gõ lệnh chọn template mong muốn (ví dụ: `/template5`, `/template5_1` hoặc `/template5_2`).
3. Gửi album ảnh sản phẩm (từ 1 đến 11+ ảnh).
4. Bot tự động gom ảnh, tạo Master Storyboard qua Gemini API, tách 4 Panel 9:16, sinh 4 Video 6s trên Veo 3 và gửi video về Telegram.
5. Nếu cần làm lại cảnh nào, gõ `/remake <số_cảnh> [yêu cầu]`.

### Luồng Daily Vlog: Lifestyle cho Nhi (Telegram → Video)

1. Gửi `/dailyvlog` vào Telegram bot.
2. Gửi ảnh sản phẩm (1 hoặc nhiều ảnh).
3. Pipeline 4 bước tự động:
   - **Step 1**: Phân tích sản phẩm theo lifestyle (text-only JSON)
   - **Step 2**: Tạo storyboard N panel cho Nhi (image generation)
   - **Step 3**: Vẽ từng panel riêng (image generation)
   - **Step 4**: Tạo N video Veo 3 (tái sử dụng video pipeline)
4. Gửi video về Telegram kèm gợi ý caption và hashtags.

Cấu hình Daily Vlog riêng trong `config.json`:

```json
{
  "dailyVlogSettings": {
    "panelCount": 5,
    "sceneRatio": "9:16",
    "nhiReferencePath": "assets/nhi"
  }
}
```

Đặt ảnh tham chiếu nhân vật Nhi vào `playwright-service/assets/nhi/` để kết quả nhân vật nhất quán hơn.

### REST API Endpoints

| Method | Endpoint                       | Mô tả                                      |
|--------|--------------------------------|---------------------------------------------|
| POST   | `/api/generate`                | Tạo image bằng Google Flow API              |
| POST   | `/api/generate-video`          | Tạo video bằng Google Flow API              |
| POST   | `/api/generate-storyboard`     | Tạo storyboard + video qua AI Studio       |
| POST   | `/api/automate-storyboard`     | Trigger automation pipeline (fire & forget) |
| POST   | `/api/resize-video`            | Crop/resize video base64                    |
| GET    | `/api/export-cookies`          | Export cookies của browser context hiện tại |
| GET    | `/api/tiktok/auth`             | TikTok OAuth URL                            |
| POST   | `/api/tiktok/callback`         | Exchange TikTok auth code                   |
| POST   | `/api/tiktok/upload`           | Upload video lên TikTok                     |

## Cách Hoạt Động Của Direct API

Thay vì thao tác DOM (click file input, chọn file, đợi UI update), server sử dụng:

1. **Token capture**: Mở Google Flow page trong Playwright, intercept network requests để lấy `Bearer` token và enterprise reCAPTCHA token.
2. **Direct upload**: `POST` file ảnh trực tiếp đến `/v1/flow/uploadImage` với Bearer auth.
3. **Direct video generation**: Gọi `batchAsyncGenerateVideoStartImage` API với uploaded asset UUID, prompt, và video model config.
4. **Polling**: Theo dõi operation status cho đến khi video sẵn sàng, sau đó tải về base64.

Flow tab chỉ cần mở để **refresh token**, không cần tương tác UI.

## Debug & Test

### Test Direct API (không cần Telegram)

```bash
node playwright-service/debug-flow-direct-video-api.js
```

### Test Chrome Extension + Flow UI

```bash
node playwright-service/debug-flow-extension.js --keep-open
```

### Test Resize Video

```bash
node playwright-service/test-video-crop.js --input playwright-service/test.mp4 --percent 0.04 --aspect 9:16
```

### Debug AI Studio

```bash
node playwright-service/debug-aistudio.js
```

### Gemini WebAPI Storyboard Provider

`playwright-service/config.json` can switch storyboard generation away from AI Studio UI automation:

```json
{
  "systemSettings": {
    "storyboardProvider": "gemini-webapi"
  }
}
```

Install the Python bridge dependency:

```bash
python -m pip install -r playwright-service/gemini-webapi-bridge/requirements.txt
```

Set these values in `playwright-service/.env`:

```env
GEMINI_SECURE_1PSID=your___Secure-1PSID_cookie
GEMINI_SECURE_1PSIDTS=your___Secure-1PSIDTS_cookie
GEMINI_COOKIE_PATH=./gemini-cookies
GEMINI_WEBAPI_PYTHON=C:/Users/LAPTOP_036/AppData/Local/Programs/Python/Python312/python.exe
GEMINI_WEBAPI_PANEL_CONCURRENCY=3
```

With this provider, `/api/generate-storyboard`, `/api/automate-storyboard`, and the Telegram bot full flow use `gemini_webapi` for analysis, storyboard prompts, and panel images. The existing Flow/Veo direct API step is still used for video generation.

To export Gemini cookies from the same Playwright profile used by the service, run:

```bash
cd playwright-service
node export-gemini-cookies.js
```

Use this script instead of opening system Chrome manually. It launches the persistent `chrome-data` profile directly.

## Expose Server Qua Internet (Ngrok)

Để Telegram webhook hoặc external clients gọi được server:

```bash
ngrok http 3000
```

## Các Thiết Lập Đang Hardcode

| File                          | Nội dung hardcode                              |
|-------------------------------|------------------------------------------------|
| `services/aistudio.js`       | AI Studio app URL                              |
| `services/browser.js`        | Google Flow project URL/ID                     |
| `utils/extension-loader.js`  | Chrome extension path                          |

Nếu đổi Google project hoặc AI Studio app thì cần sửa các file trên.

## Dữ Liệu Tạm Và Bảo Mật

**Không commit** các file/thư mục này (đã có trong `.gitignore`):

```text
playwright-service/.env
playwright-service/chrome-data/
playwright-service/uploads/
playwright-service/labs.google.cookies.json
playwright-service/tokens.json
gemini-cookies/
```

Các file này chứa session Google, Telegram token, dữ liệu video tạm hoặc cookie nhạy cảm.

## Lỗi Thường Gặp

### Port 3000 bị chiếm

```bash
lsof -ti :3000 | xargs kill -9
```

### Google yêu cầu đăng nhập lại

```bash
cd playwright-service && node login.js
```

Đăng nhập Google xong rồi restart server.

### Bearer token hết hạn

Server tự động refresh token khi mở Flow tab. Nếu vẫn lỗi 401, thử:
1. Restart server.
2. Nếu vẫn không được, chạy lại `node login.js` để refresh session.

### Telegram bot không nhận ảnh

- Kiểm tra `TELEGRAM_BOT_TOKEN` trong `.env`.
- Đảm bảo không có instance khác đang poll cùng bot token.
- Xem log server để kiểm tra lỗi cụ thể.

### Video quá lớn cho Telegram

Telegram giới hạn file 50MB. Nếu video vượt quá, thử giảm chất lượng resize hoặc crop nhiều hơn.

## Lệnh Hay Dùng

```bash
# Chạy server (bao gồm Telegram bot)
cd playwright-service && node server.js

# Đăng nhập Google lại
cd playwright-service && node login.js

# Export Gemini cookies
cd playwright-service && node export-gemini-cookies.js

# Kill service port 3000 nếu bị kẹt
lsof -ti :3000 | xargs kill -9

# Expose qua ngrok
ngrok http 3000

# Test direct API
node playwright-service/debug-flow-direct-video-api.js
```

## n8n Orchestration (Telegram → Gen Video → TikTok Affiliate)

Hệ thống hỗ trợ chế độ điều phối qua n8n workflow:
- File workflow mới: `workflows/TELEGRAM GEN VIDEO + AUTO UPLOAD TIKTOK.json`
- File workflow tham chiếu cũ: `workflows/AUTO UPLOAD VIDEO +AFFILITATE LIINK TIKTOK.json`

### 1. Cấu hình Server cho n8n Mode:

Trong `playwright-service/.env`:
```env
N8N_ORCHESTRATION=true
DEFAULT_STORYBOARD_TEMPLATE=template5_1
PRODUCT_IMAGE_LIMIT=8
PRODUCT_IMAGE_MIN=1
PRODUCT_IMAGE_DOWNLOAD_TIMEOUT_MS=15000
# Đặt false nếu môi trường gặp lỗi SELF_SIGNED_CERT_IN_CHAIN khi tải ảnh TikTok
PRODUCT_IMAGE_TLS_REJECT_UNAUTHORIZED=true
```

Khi `N8N_ORCHESTRATION=true`, server tắt long-polling Telegram bot nội bộ để n8n độc quyền xử lý Telegram Trigger.

### 2. Luồng hoạt động:

1. **Telegram Trigger**: Người dùng gửi shortlink TikTok Shop (vd: `https://vt.tiktok.com/...` hoặc kèm `/template5_1`).
2. **Asset Extraction**: n8n phân giải shortlink, tải HTML PDP và gọi `/api/product-assets/extract` để trích xuất `product_id`, tiêu đề, mô tả và tối đa 8 ảnh.
3. **Enqueue Job**: n8n gọi `POST /api/jobs/enqueue` để đưa job vào hàng đợi generation.
4. **Checkpoints (01 → 07)**: n8n theo dõi tiến độ từng step theo thời gian thực:
   - `01 — Product Assets Extracted`
   - `02 — Product Analyzed`
   - `03 — Storyboard Generated`
   - `04 — Panels Generated`
   - `05 — Videos Generated`
   - `06 — Final Video Merged`
   - `07 — Generation Completed`
5. **Video Preview**: Server tự động merge các panel video và gửi video hoàn chỉnh về Telegram kèm caption và hướng dẫn `/upload`.
6. **Upload Command (`/upload`)**:
   - Khi người dùng gửi `/upload` (hoặc `/upload <jobId>`), n8n kiểm tra tính duy nhất (idempotency).
   - Gọi `Get Link Affiliate` để xác minh sản phẩm nằm trong danh sách showcase/affiliate của tài khoản TikTok.
   - Tải final video từ `/api/jobs/:jobId/final-video` và upload lên TikTok với product anchor tương ứng.
   - Ghi nhận trạng thái publish và dọn dẹp job tạm.

### 3. Job REST API Endpoints

| Method | Endpoint | Mô tả |
|---|---|---|
| POST | `/api/product-assets/extract` | Trích xuất `productId`, title, mô tả, ảnh từ PDP HTML |
| POST | `/api/jobs/enqueue` | Đưa generation job vào hàng đợi |
| GET | `/api/jobs/:jobId` | Đọc trạng thái và checkpoint hiện tại của job |
| GET | `/api/jobs/latest?chatId=...` | Lấy job hoàn tất gần nhất của một chat |
| GET | `/api/jobs/:jobId/result` | Lấy kết quả phân tích, caption, hashtag và thông tin video |
| GET | `/api/jobs/:jobId/final-video` | Tải file binary MP4 video hoàn chỉnh đã merge |
| POST | `/api/jobs/:jobId/upload-state` | Cập nhật trạng thái upload (`published`, `failed`) |
| DELETE | `/api/jobs/:jobId` | Dọn dẹp thư mục tạm và xóa job khỏi bộ nhớ |

