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

Trên máy mới, chỉ cần chạy đúng 1 lệnh từ thư mục gốc:

```bash
git clone https://github.com/vuongnq97/ai-fashion-review.git
cd ai-fashion-review
./setup.sh
```

*(Script sẽ tự động: kiểm tra Node.js, chạy `npm install`, tải Playwright Chromium, tạo các thư mục dữ liệu cần thiết, tạo file `.env`, hỗ trợ nhập `TELEGRAM_BOT_TOKEN`, và mở trình duyệt để bạn đăng nhập Google lần đầu).*

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
| `/template5` | **Review Đa Ngành Hàng 4 cảnh 6s** (Thời trang, Mỹ phẩm, Gia dụng... tự động phân tích qua Gemini API, có thẻ chữ tiếng Việt nhỏ gọn trong safe-zone, không tiếng review). |
| `/template5_1` | **Review Đa Ngành Hàng 4 cảnh 6s (KHÔNG CHỮ / No Text $100\%$)** — Storyboard, 4 Panel và 4 Video đều sạch hoàn toàn không chữ, tập trung góc quay thực tế. |
| `/template1` | Review giày dép/thời trang faceless 2 cảnh (không voice-over). |
| `/template2` | Review giày dép 8 cảnh x 4s (không voice-over). |
| `/template3` | Review shop giày dép 4 cảnh (Top-down 8s, POV 6s, góc hông 4s, đứng thử 8s). |
| `/template4` | Review giày/dép nữ shop pastel 4 cảnh (Cận cảnh 8s, POV váy 6s, góc nệm 4s, đứng dáng 8s). |
| `/again <cảnh> [yêu cầu]` | **Tạo lại video cảnh chưa ưng ý** (VD: `/again 2` hoặc `/again 2 xoay nhẹ góc 45 độ` để ưu tiên custom prompt). |
| `/dailyvlog` | Tạo vlog lifestyle cho nhân vật Nhi. |
| `/status` | Xem trạng thái hàng đợi xử lý video. |

---

## Sử Dụng

### Luồng Chính: Review Sản Phẩm (Telegram → Video)

1. Mở Telegram, chat với bot của bạn.
2. Gõ lệnh chọn template mong muốn (ví dụ: `/template5` hoặc `/template5_1`).
3. Gửi album ảnh sản phẩm (từ 1 đến 11+ ảnh).
4. Bot tự động gom ảnh, tạo Master Storyboard qua Gemini API, tách 4 Panel 9:16, sinh 4 Video 6s trên Veo 3 và gửi video về Telegram.
5. Nếu cần làm lại cảnh nào, gõ `/again <số_cảnh> [yêu cầu]`.

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

## Legacy: n8n Workflow (Không còn sử dụng)

> **Lưu ý:** Luồng n8n đã được thay thế hoàn toàn bằng Telegram bot tích hợp trong server Node.js. Phần này chỉ để tham khảo.

Nếu muốn dùng n8n workflow (legacy):

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
