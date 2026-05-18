# AI Fashion Review

Workflow tự động nhận ảnh sản phẩm từ Telegram, tạo storyboard bằng Google AI Studio, tạo video bằng Google Flow thông qua Chrome extension, resize video bằng FFmpeg rồi gửi video hoàn chỉnh lại Telegram qua n8n.

## Luồng Chính

```text
Telegram photo
  -> n8n ReviewAI workflow
  -> Playwright service /api/generate-storyboard
  -> Google AI Studio tạo storyboard + panel images + prompts
  -> Extension trên Google Flow tạo video từ từng panel
  -> Playwright service tải video về, trả base64 cho n8n
  -> n8n gọi /api/resize-video
  -> n8n gửi video đã resize về Telegram
```

## Yêu Cầu

- macOS hoặc Linux có Chrome/Chromium chạy được UI.
- Node.js 20+.
- npm.
- Docker nếu chạy n8n bằng container.
- Tài khoản Google đã vào được Google AI Studio và Google Flow.
- Telegram bot token từ BotFather.
- TikTok developer credentials chỉ cần nếu dùng các API TikTok trong project.

## Cấu Trúc Quan Trọng

```text
playwright-service/
  server.js                         Express API server, port 3000
  routes/index.js                   API routes generate, storyboard, resize, TikTok
  login.js                          Mở browser để đăng nhập Google và load extension
  services/aistudio.js              Luồng AI Studio -> Extension -> Flow
  services/browser.js               Browser/session cho Google Flow API cũ
  services/video-resize.js          Resize/crop video bằng ffmpeg
  extension/                        Chrome extension dùng để automate Google Flow
  uploads/                          File tạm, panel/video tải về
  chrome-data/                      Chrome profile/session đăng nhập Google

workflows/solid-saddle-de3ecbf97f11/
  ReviewAI.workflow.ts              Workflow n8n chính

tiktok-site/
  callback.html                     OAuth callback page cho TikTok nếu dùng
```

## 1. Clone Project

```bash
git clone https://github.com/vuongnq97/ai-fashion-review.git
cd ai-fashion-review
```

Nếu bạn đang dùng folder hiện tại:

```bash
git remote -v
```

Remote đúng phải là:

```text
origin  https://github.com/vuongnq97/ai-fashion-review.git
```

## 2. Cài Playwright Service

```bash
cd playwright-service
npm install
npx playwright install chromium
cp .env.example .env
```

Sửa `playwright-service/.env` nếu dùng TikTok:

```env
TIKTOK_CLIENT_KEY=your_tiktok_client_key
TIKTOK_CLIENT_SECRET=your_tiktok_client_secret
TIKTOK_REDIRECT_URI=https://your-domain.github.io/ai-fashion/callback.html
PORT=3000
```

Lưu ý: server hiện đang listen cố định ở port `3000` trong `server.js`, nên n8n workflow đang gọi `http://host.docker.internal:3000`.

## 3. Đăng Nhập Google Cho Playwright

Chạy:

```bash
cd playwright-service
node login.js
```

Script sẽ mở Chrome profile tại `playwright-service/chrome-data`, load extension và mở Google Labs.

Trong browser vừa mở:

1. Đăng nhập Google.
2. Mở được Google Labs / Flow bình thường.
3. Kiểm tra extension mở được trang Automation -> Frame to Video.
4. Đóng browser hoặc nhấn `Ctrl+C` ở terminal khi xong.

Session đăng nhập được lưu trong `playwright-service/chrome-data`.

## 4. Chạy Playwright Service

```bash
cd playwright-service
node server.js
```

Server chạy tại:

```text
http://localhost:3000
```

Các endpoint chính:

```text
POST /api/generate-storyboard  Tạo storyboard + video bằng AI Studio/Flow
POST /api/resize-video         Crop/resize video base64
POST /api/generate             Tạo image bằng Google Flow API cũ
POST /api/generate-video       Tạo video bằng Google Flow API cũ
GET  /api/export-cookies       Export cookies Google Labs nếu đang có browser context
```

## 5. Chạy n8n

Cách nhanh bằng Docker:

```bash
docker run -d \
  --name n8n-ai-fashion \
  -p 5678:5678 \
  -v n8n_ai_fashion_data:/home/node/.n8n \
  --add-host=host.docker.internal:host-gateway \
  -e N8N_DEFAULT_BINARY_DATA_MODE=filesystem \
  n8nio/n8n:2.17.7
```

Mở:

```text
http://localhost:5678
```

Tạo owner account nếu n8n hỏi lần đầu.

## 6. Tạo Telegram Credential Trong n8n

Trong n8n UI:

1. Vào `Credentials`.
2. Tạo credential loại `Telegram API`.
3. Dán bot token từ BotFather.
4. Đặt tên dễ nhận biết, ví dụ `Telegram Bot B`.

Sau khi import/push workflow, nếu node Telegram báo credential missing thì mở từng Telegram node và chọn credential vừa tạo.

## 7. Push Workflow ReviewAI Lên n8n

Từ root repo:

```bash
cd /path/to/ai-fashion-review
```

Nếu workspace n8n-as-code chưa có auth API key, tạo API key trong n8n UI:

```text
n8n UI -> Settings -> n8n API -> Create API Key
```

Sau đó cấu hình n8n-as-code:

```bash
npx --yes n8nac env add localhost:5678 --base-url http://localhost:5678 --sync-folder workflows
npx --yes n8nac env auth set localhost:5678 --api-key-stdin
npx --yes n8nac env use localhost:5678
```

Ở bước `--api-key-stdin`, paste API key vào terminal rồi nhấn Enter, sau đó nhấn `Ctrl+D`.

Kiểm tra workflow:

```bash
npx --yes n8nac list
```

Push workflow chính:

```bash
npx --yes n8nac push workflows/solid-saddle-de3ecbf97f11/ReviewAI.workflow.ts --verify
```

Activate workflow:

```bash
npx --yes n8nac workflow activate dNCki6C703CUsRUH
```

Workflow chính tên là `ReviewAI`.

## 8. Test End-To-End

Đảm bảo đang chạy:

```bash
cd playwright-service
node server.js
```

Đảm bảo n8n workflow `ReviewAI` đang active.

Gửi một ảnh sản phẩm vào Telegram bot.

Kỳ vọng:

1. Bot phản hồi đã nhận ảnh.
2. n8n gọi `POST /api/generate-storyboard`.
3. Browser tự mở AI Studio, upload ảnh và click tạo storyboard.
4. Sau khi AI Studio tạo panel, service copy prompt và mở Google Flow + extension.
5. Extension chạy Frame to Video và tải video về.
6. n8n resize video qua `/api/resize-video`.
7. Telegram nhận từng video đã resize.

## 9. Debug Riêng Flow + Extension

Khi chỉ muốn test phần Google Flow + extension, dùng:

```bash
cd /path/to/ai-fashion-review
node playwright-service/debug-flow-extension.js --keep-open
```

Script sẽ dùng panel image trong:

```text
playwright-service/uploads/aistudio-panels
```

Output debug nằm trong:

```text
playwright-service/debug-output/flow-extension
```

## 10. Test Resize Video

Đặt file test tại:

```text
playwright-service/test.mp4
```

Chạy:

```bash
node playwright-service/test-video-crop.js --input playwright-service/test.mp4 --percent 0.04 --aspect 9:16
```

`cropPercent: 0.04` nghĩa là crop 4% mỗi cạnh theo kích thước tương ứng rồi scale về tỉ lệ yêu cầu.

## 11. Các Thiết Lập Đang Hardcode

Một số URL/id đang hardcode trong source:

- AI Studio app URL: `playwright-service/services/aistudio.js`
- Google Flow project URL/id: `playwright-service/services/browser.js`
- Chrome extension id/path: `playwright-service/utils/extension-loader.js`
- n8n gọi service qua `http://host.docker.internal:3000` trong workflow `ReviewAI.workflow.ts`

Nếu đổi Google Flow project hoặc AI Studio app thì cần sửa các file trên.

## 12. Lỗi Thường Gặp

### Extension không load

Kiểm tra có file:

```text
playwright-service/extension/manifest.json
playwright-service/extension/assets/icon16.png
playwright-service/extension/assets/icon32.png
playwright-service/extension/assets/icon48.png
playwright-service/extension/assets/icon128.png
```

Chạy lại:

```bash
node playwright-service/login.js
```

### Google yêu cầu đăng nhập lại

Chạy lại:

```bash
cd playwright-service
node login.js
```

Đăng nhập Google xong rồi chạy lại service.

### n8n gọi API không được

Nếu n8n chạy trong Docker, workflow phải gọi:

```text
http://host.docker.internal:3000
```

Nếu n8n chạy trực tiếp trên máy host, có thể đổi thành:

```text
http://localhost:3000
```

### Telegram không gửi video

Kiểm tra:

- Telegram credential đã được gắn vào các Telegram node.
- Workflow active.
- Node `Prepare Resized Video` có output binary `data`.
- File video sau resize không quá lớn với giới hạn Telegram bot.

### Workflow báo `Invalid or unexpected token`

Lỗi này thường do Code node có string xuống dòng sai cú pháp. Chạy:

```bash
npx --yes n8nac push workflows/solid-saddle-de3ecbf97f11/ReviewAI.workflow.ts --verify
```

Nếu vẫn lỗi runtime, mở execution trong n8n để xem node nào parse fail.

## 13. Dữ Liệu Tạm Và Bảo Mật

Không commit các file/thư mục này:

```text
playwright-service/.env
playwright-service/chrome-data/
playwright-service/uploads/
playwright-service/labs.google.cookies.json
playwright-service/tokens.json
database.sqlite*
n8nEventLog.log
```

Các file này có thể chứa session Google, token TikTok, dữ liệu video hoặc dữ liệu n8n local.

## 14. Lệnh Hay Dùng

```bash
# Chạy service
cd playwright-service && node server.js

# Đăng nhập Google lại
cd playwright-service && node login.js

# Kiểm tra workflow local/remote
npx --yes n8nac list

# Push workflow lên n8n
npx --yes n8nac push workflows/solid-saddle-de3ecbf97f11/ReviewAI.workflow.ts --verify

# Activate workflow
npx --yes n8nac workflow activate dNCki6C703CUsRUH

# Kill service port 3000 nếu bị kẹt
lsof -ti :3000 | xargs kill -9
```

