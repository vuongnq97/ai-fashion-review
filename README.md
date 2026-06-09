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
  login.js                          Mở browser để đăng nhập Google lần đầu

  services/
    telegram-bot.js                 Telegram long-polling listener (không cần n8n)
    automation.js                   Orchestrator: AI Studio → Flow → Resize → Telegram
    aistudio.js                     Giao tiếp với Google AI Studio (storyboard)
    browser.js                      Quản lý browser context, Bearer + reCAPTCHA token
    image.js                        Upload ảnh qua direct API (uploadImageDirect)
    video.js                        Tạo video Veo 3 qua direct API
    video-resize.js                 Resize/crop video bằng FFmpeg
    tiktok.js                       TikTok OAuth + upload (tùy chọn)

  utils/
    flow-asset-watchdog.js          Theo dõi asset upload status
    flow-submit-watchdog.js         Theo dõi video generation status

  extension/                        Chrome extension cho batch processing (debug/legacy)
  uploads/                          File tạm (panel images, video downloads)
  chrome-data/                      Chrome profile/session đăng nhập Google
```

## Cài Đặt

### 1. Clone Project

```bash
git clone https://github.com/vuongnq97/ai-fashion-review.git
cd ai-fashion-review
```

### 2. Cài Dependencies

```bash
cd playwright-service
npm install
npx playwright install chromium
```

### 3. Cấu Hình Environment

```bash
cp .env.example .env
```

Sửa `playwright-service/.env`:

```env
# Bắt buộc
TELEGRAM_BOT_TOKEN=your_telegram_bot_token

# Server
PORT=3000

# Tùy chọn: TikTok integration
TIKTOK_CLIENT_KEY=your_tiktok_client_key
TIKTOK_CLIENT_SECRET=your_tiktok_client_secret
TIKTOK_REDIRECT_URI=https://your-domain.github.io/ai-fashion/callback.html
```

### 4. Đăng Nhập Google Lần Đầu

Chạy script để mở browser, đăng nhập Google, và lưu session:

```bash
cd playwright-service
node login.js
```

Trong browser vừa mở:

1. Đăng nhập tài khoản Google.
2. Mở Google AI Studio và Google Flow để xác nhận truy cập bình thường.
3. Đóng browser hoặc `Ctrl+C` khi xong.

Session được lưu trong `playwright-service/chrome-data/`.

### 5. Chạy Server

```bash
cd playwright-service
node server.js
```

Server chạy tại `http://localhost:3000`. Khi khởi động:
- Express API sẵn sàng nhận request.
- Telegram bot tự động bắt đầu long-polling.

## Sử Dụng

### Luồng Chính (Telegram → Video)

1. Gửi 1 hoặc nhiều ảnh sản phẩm vào Telegram bot.
2. Bot tự động nhận ảnh, gom batch (đợi 5 giây nếu có nhiều ảnh liên tiếp).
3. Mở AI Studio, upload ảnh, tạo storyboard với panel images + video prompts.
4. Pre-launch Google Flow tab để lấy Bearer token và enterprise reCAPTCHA token.
5. Upload từng panel image lên Flow qua **direct API** (`/v1/flow/uploadImage`).
6. Gọi API tạo video Veo 3 (`batchAsyncGenerateVideoStartImage`) — không thao tác DOM.
7. Resize/crop video về tỉ lệ 9:16 bằng FFmpeg.
8. Gửi từng video đã resize về Telegram cho user.

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
database.sqlite*
n8nEventLog.log
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

# Kill service port 3000 nếu bị kẹt
lsof -ti :3000 | xargs kill -9

# Expose qua ngrok
ngrok http 3000

# Test direct API
node playwright-service/debug-flow-direct-video-api.js
```

## Legacy: n8n Workflow (Tùy Chọn)

Nếu muốn dùng n8n workflow thay vì Telegram bot tích hợp:

```bash
# Cài n8n
docker run -d --name n8n -p 5678:5678 \
  -v n8n_data:/home/node/.n8n \
  --add-host=host.docker.internal:host-gateway \
  n8nio/n8n:2.17.7

# Push workflow
npx --yes n8nac push workflows/solid-saddle-de3ecbf97f11/ReviewAI.workflow.ts --verify
```

Workflow n8n gọi server qua `http://host.docker.internal:3000`.
