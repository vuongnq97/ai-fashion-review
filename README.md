# 🎨 AI Fashion Virtual Try-On — n8n Workflow

Hệ thống tự động tạo video thời trang AI từ ảnh gửi qua Telegram, tích hợp đăng lên TikTok.

## 📋 Tổng quan

```
User gửi ảnh lên Telegram Bot
  → Gemini phân tích outfit
  → Virtual Try-On (NanoBanana AI)
  → Veo 3.1 tạo video 16s
  → Gửi video về Telegram
  → Tự động đăng lên TikTok
```

## 🛠 Yêu cầu

- **Docker** — chạy n8n
- **Node.js** v18+ — chạy Playwright service
- **ngrok** — tunnel HTTPS cho Telegram webhook
- **Google Chrome** — Playwright dùng để tương tác Google Labs

## 🚀 Hướng dẫn cài đặt

### 1. Clone repo

```bash
git clone https://github.com/vuongnq97/n8n-workflow-ai-fashion.git
cd n8n-workflow-ai-fashion
```

### 2. Chạy n8n bằng Docker

```bash
docker run -d \
  --name n8n-vuong \
  -p 5678:5678 \
  -v n8n_data:/home/node/.n8n \
  --add-host=host.docker.internal:host-gateway \
  n8nio/n8n
```

Truy cập: http://localhost:5678

### 3. Cài đặt Playwright Service

```bash
cd playwright-service
npm install
```

### 4. Tạo file `.env`

```bash
cp .env.example .env
```

Sửa file `.env` với thông tin của bạn:

```env
# TikTok API Credentials (Sandbox)
TIKTOK_CLIENT_KEY=your_client_key
TIKTOK_CLIENT_SECRET=your_client_secret

# TikTok OAuth
TIKTOK_REDIRECT_URI=https://your-domain.github.io/ai-fashion/callback.html

# Server
PORT=3000
```

### 5. Cài Google Cookies cho Playwright

Đăng nhập Google trên Chrome, sau đó export cookies:

```bash
node export-cookies.js
```

Hoặc tạo file `labs.google.cookies.json` thủ công từ cookies Google Labs.

### 6. Chạy Playwright Service

```bash
node server.js
```

Server sẽ chạy tại http://localhost:3000

### 7. Chạy ngrok

```bash
ngrok http 5678
```

Copy URL HTTPS (ví dụ: `https://xxxx.ngrok-free.dev`)

### 8. Import Workflow vào n8n

Cài n8n-as-code CLI:

```bash
npx --yes n8nac init
```

Rồi push workflow:

```bash
npx --yes n8nac push workflows/local_5678_ngo_v/personal/Untitled-1777099574829.workflow.ts
```

### 9. Cấu hình Credentials trong n8n

Vào n8n UI → Settings → Credentials, thêm:

| Credential | Cần điền |
|-----------|---------|
| **Telegram API** | Bot Token (lấy từ @BotFather) |
| **Gemini API** | API Key từ Google AI Studio |

### 10. Cập nhật ngrok URL

Trong workflow n8n, tìm node **"Send Login Button"** và cập nhật ngrok URL mới.

Trong file `tiktok-site/callback.html`, cập nhật biến `NGROK_URL`.

### 11. Bật Workflow

Vào n8n UI → bật toggle **Active** cho workflow "Fashion Virtual Try-On".

## 📁 Cấu trúc dự án

```
├── playwright-service/      # Backend Node.js
│   ├── server.js            # Express server
│   ├── routes/index.js      # API routes
│   ├── services/
│   │   ├── browser.js       # Quản lý Playwright browser
│   │   ├── image.js         # Google Labs Image generation
│   │   ├── video.js         # Google Labs Video generation
│   │   ├── video-resize.js  # FFmpeg resize/crop
│   │   └── tiktok.js        # TikTok OAuth & Upload
│   └── login.js             # Google login helper
├── tiktok-site/             # GitHub Pages (OAuth callback)
│   ├── index.html           # Landing page
│   ├── callback.html        # TikTok OAuth callback
│   ├── privacy-policy.html  # Privacy policy
│   └── terms-of-service.html
├── workflows/               # n8n workflows (as code)
│   └── local_5678_ngo_v/personal/
│       └── Untitled-1777099574829.workflow.ts
├── .gitignore
└── README.md
```

## ⚠️ Lưu ý quan trọng

- **TikTok Sandbox**: Video chỉ đăng được cho tài khoản **Private**. Vào TikTok Settings → Privacy → đặt Private.
- **ngrok free**: Mỗi lần restart ngrok sẽ đổi URL → cần cập nhật lại trong workflow và callback.html.
- **Google Labs cookies**: Cookies hết hạn sau một thời gian, cần re-export.

## 📄 License

MIT
