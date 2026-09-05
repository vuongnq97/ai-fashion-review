# AI Fashion Review & Automation System

Hệ thống tự động hóa toàn diện từ link sản phẩm TikTok Shop / ảnh sản phẩm đến video review hoàn chỉnh:
- **Telegram Bot**: Nhận link TikTok Shop (`https://vt.tiktok.com/...`) hoặc album ảnh sản phẩm.
- **Gemini Web API**: Phân tích sản phẩm, viết kịch bản review tiếng Việt và sinh Master Storyboard + panel images.
- **Google Flow (Veo 3)**: Tạo video trực tiếp qua Direct API (không thao tác DOM, tốc độ cao, hỗ trợ sinh đồng thời).
- **FFmpeg Engine**: Xử lý crop/resize 9:16 chuẩn TikTok, watermark removal, lồng tiếng Voice-over AI.
- **TikTok Web Upload**: Tự động đăng video lên TikTok Shop theo đúng kênh được gán hoặc theo lịch auto-scheduler.

---

## 🚀 Cài Đặt Cho Máy Mới (Setup Local)

### Yêu Cầu Hệ Thống
* **Hệ điều hành**: Windows 10/11, macOS hoặc Linux.
* **Node.js**: Phiên bản **v20 LTS** (hoặc tối thiểu v18+). Tải tại: [nodejs.org](https://nodejs.org/)
* **Tài khoản Google**: Đã truy cập được [Google Labs Flow](https://labs.google/fx/tools/flow) & [Google Gemini](https://gemini.google.com).
* **Telegram Bot Token**: Tạo bot qua [@BotFather](https://t.me/botfather) để lấy token riêng cho máy.

---

### Cách 1: Setup Tự Động 1-Click (Khuyên dùng)

#### 👉 Trên Windows:
1. Clone repo về máy hoặc tải file ZIP rồi giải nén.
2. **Double-click (click đúp) vào file `setup.bat`** ở thư mục gốc của dự án.
3. Script sẽ tự động:
   * Kiểm tra Node.js (hướng dẫn tải nếu máy chưa có).
   * Khởi tạo các thư mục dữ liệu (`chrome-data`, `gemini-cookies`, `uploads`, `storyboard-review-runs`).
   * Cài đặt toàn bộ dependencies thư viện qua `yarn` / `npm`.
   * Cài đặt trình duyệt Playwright Chromium.
   * Tạo file `.env` và nhắc bạn nhập `TELEGRAM_BOT_TOKEN`.
   * Mở trình duyệt Chrome để bạn đăng nhập Google Flow & Gemini lần đầu (tự động xuất và lưu cookies session).

#### 👉 Trên macOS / Linux:
1. Mở Terminal tại thư mục dự án và chạy:
   ```bash
   chmod +x setup.sh start.sh
   ./setup.sh
   ```

---

### Cách 2: Setup Thủ Công Qua Terminal

Nếu bạn muốn tự chạy từng bước qua dòng lệnh:

```bash
# 1. Di chuyển vào thư mục service
cd playwright-service

# 2. Cài đặt thư viện dependencies
npm install

# 3. Cài đặt trình duyệt Chromium cho Playwright
npx playwright install chromium

# 4. Tạo file cấu hình môi trường .env
cp .env.example .env
```

Mở file `playwright-service/.env` và cập nhật tối thiểu:
```env
PORT=3000
TELEGRAM_BOT_TOKEN=dien_token_bot_telegram_cua_ban_o_day
```

Tiếp theo, đăng nhập Google lần đầu để lưu cookie & session:
```bash
node login.js
```
*Trình duyệt sẽ tự mở Google Flow và Gemini. Hãy đăng nhập tài khoản Google của bạn, sau đó quay lại Terminal nhấn phím **ENTER** để hoàn tất.*

---

## ▶️ Khởi Động Server

Sau khi đã setup xong, bạn có thể khởi động server bất cứ lúc nào:

* **Trên Windows**: **Double-click vào file `start.bat`** ở thư mục gốc (tương đương chạy `node server.js`).
* **Trên macOS / Linux**: Chạy `./start.sh` hoặc:
  ```bash
  cd playwright-service
  node server.js
  ```

Khi server khởi động thành công, bạn sẽ thấy log:
```text
🚀 Playwright Automation Server listening on port 3000
[Telegram Bot] Telegram polling active. Listening for TikTok links & /upload...
[Telegram Bot] ✅ Đã đăng ký 24 commands vào menu bot.
```

---

## 🎬 Danh Sách Lệnh Template Telegram (`/t...`)

Bot hỗ trợ đầy đủ các lệnh ngắn gọn tiền tố `/t` (vẫn hỗ trợ gõ dạng dài `/template...`):

| Lệnh Ngắn | Lệnh Đầy Đủ | Mô Tả & Đặc Điểm | Phù Hợp Cho |
|---|---|---|---|
| `/t3` | `/template3` | **Review shop 3 cảnh** (Top-down 8s + Góc hông 4s + Thử giày 8s, không voice) | Giày nam / sneakers (Men Shop) |
| `/t4` | `/template4` | **Review giày/dép pastel 4 cảnh** (Cận cảnh 8s + POV váy 6s + Nệm 4s + Đứng thử 8s, không voice) | Giày nữ / pastel (Lady Shop) |
| `/t5` | `/template5` | **Review đa ngành 2 video 8s (Có chữ)**: Phân tích Gemini, gắn title/subtitle tiếng Việt theo mốc thời gian | Đa ngành, lifestyle |
| `/t5_1` | `/template5_1` (hoặc `/t51`) | **Review đa ngành 2 video 8s (Sạch chữ 100%)**: Không text, góc quay chân thực | Đa ngành, tiện ích |
| `/t5_2` | `/template5_2` (hoặc `/t52`) | **Review đa ngành 2 video 8s (Sạch chữ + Voice AI)**: Có giọng đọc review tiếng Việt chuẩn nam/nữ | Gia dụng, đời sống (Nhi Shop) |
| `/t5_3` | `/template5_3` (hoặc `/t53`) | **Spam video đa ngành 4 video 4s (Sạch chữ + Voice AI)**: Dùng model Veo 4s siêu nhanh, kịch bản 4 cảnh ngắn gọn | Spam video affiliate, gia dụng |
| `/t6` | `/template6` | **Review siêu thị POV 2 cảnh 8s**: Cảnh 1 cầm xem đồ ngang ngực + Cảnh 2 đặt vào giỏ hàng WinMart/Bách Hóa Xanh | Đồ FMCG, thực phẩm, tạp hóa |
| `/t1` | `/template1` | **Review faceless 2 cảnh** (không voice-over) | Thời trang, đồ cơ bản |
| `/t2` | `/template2` | **Review 8 cảnh x 4s** (không voice-over) | Chi tiết sản phẩm nhiều góc |

---

## ⚡ Các Lệnh Điều Khiển & Tiện Ích Khác

| Lệnh | Chức Năng |
|---|---|
| `/register <Tên Shop>` | Đăng ký nhóm vào hệ thống và liên kết tài khoản TikTok Shop qua QR code |
| `/upload` | Ghép các cảnh video thành video dọc 9:16 và đăng lên kênh TikTok liên kết của chat |
| `/remake <cảnh> [prompt]` | Tạo lại cảnh video chưa ưng ý (VD: `/remake 1` hoặc `/remake 4 quay góc cận hơn`) |
| `/status` | Xem trạng thái hàng đợi đang xử lý video |
| `/chatid` | Xem Chat ID Telegram và tài khoản TikTok Shop đang gán cho nhóm này |
| `/start` hoặc `/help` | Mở lại danh sách toàn bộ lệnh và hướng dẫn |

---

## 📱 Đăng Ký Group Mới & Liên Kết TikTok Bằng Mã QR (`/register`)

Hệ thống cho phép thêm nhóm Telegram mới và liên kết tài khoản TikTok hoàn toàn tự động ngay trong khung chat Telegram mà **không cần copy-paste cookie thủ công**:

1. **Thêm bot vào nhóm Telegram mới**.
2. **Gõ lệnh đăng ký**:
   ```text
   /register Shop Giày GenZ
   ```
   * Bot tự động ghi nhận nhóm vào `config.json` với trạng thái `pending_link`.
   * Bot gửi thông báo phản hồi kèm nút bấm **`[📸 Quét mã QR liên kết TikTok]`**.

3. **Quét mã QR đăng nhập TikTok (Nhanh & Tự động hoàn toàn)**:
   * Bấm nút **`[📸 Quét mã QR liên kết TikTok]`**.
   * Bot mở phiên đăng nhập bảo mật và gửi ảnh mã QR trực tiếp vào nhóm Telegram (mã có hiệu lực trong 90 giây).
   * Mở app **TikTok trên điện thoại** $\rightarrow$ Vào trang cá nhân $\rightarrow$ Chọn biểu tượng Quét mã QR $\rightarrow$ Quét ảnh và bấm **Xác nhận đăng nhập**.
   * Server tự động bắt session cookies, lấy thông tin nick/ID TikTok, lưu vào `tiktok-accounts.json`, cập nhật `config.json` và thông báo hoàn tất ngay trong nhóm.

---

## 🤖 Lệnh Tự Động Chạy Theo Lịch (Auto Scheduler)

Hệ thống tích hợp sẵn scheduler tự động cào link sản phẩm trong kho và đăng video theo các khung giờ cài sẵn trong `config.json`:

* **Shop Giày Nam (Template 3)**:
  * `/auto_t3` — Bật chế độ tự động chạy theo lịch
  * `/auto_t3_run` — Chạy thử ngay lập tức 1 video
  * `/auto_t3_off` — Tắt tự động chạy
* **Shop Giày Nữ (Template 4)**:
  * `/auto_t4` — Bật tự động
  * `/auto_t4_run` — Chạy thử ngay 1 video
  * `/auto_t4_off` — Tắt tự động
* **Shop Gia Dụng (Template 5)**:
  * `/auto_t5` — Bật tự động
  * `/auto_t5_run` — Chạy thử ngay 1 video
  * `/auto_t5_off` — Tắt tự động

---

## 🏪 Cấu Hình Shop & Kênh TikTok

Cấu hình liên kết giữa nhóm Telegram và tài khoản TikTok nằm tại `playwright-service/config.json`:

```json
{
  "channels": {
    "-5593429194": {
      "label": "Shop Giày Nam",
      "tiktokCredentialId": "cJDNuW2i1tFFXivi",
      "tiktokCredentialName": "Men Shop"
    },
    "-5593403910": {
      "label": "Shop Giày Nữ",
      "tiktokCredentialId": "WIFMkBwL39jBHjxo",
      "tiktokCredentialName": "Lady Shop"
    },
    "-5348767040": {
      "label": "Gia dụng",
      "tiktokCredentialId": "Q9JStYDsDEzn5Tg3",
      "tiktokCredentialName": "Nhi Shop"
    }
  }
}
```

* **Thông tin đăng nhập TikTok**: Lưu tại `playwright-service/tiktok-accounts.json` (chứa session cookies để đăng video mà không cần đăng nhập lại mỗi lần).

---

## 🔄 Tích Hợp n8n Orchestration (Tự Động Upload & Gắn Giỏ Hàng TikTok Shop)

Hệ thống hỗ trợ kết hợp với **n8n** để tự động hoá việc lấy link Affiliate, gắn link giỏ hàng vàng (Product Anchor) và đăng video lên TikTok Shop.

### 1. Kiến Trúc Phối Hợp Giữa Node.js Server & n8n:
* **Node.js Playwright Service (Cổng 3000)**:
  * Tiếp nhận link/ảnh từ Telegram qua bot.
  * Điều phối Gemini Web API viết kịch bản & storyboard.
  * Gọi Direct API Google Flow (Veo 3) tạo video và dùng FFmpeg merge video hoàn chỉnh.
  * Gửi video preview về nhóm Telegram.
  * Cung cấp REST API nội bộ (`/api/jobs/...`) để n8n truy xuất dữ liệu video và trạng thái.
* **n8n Engine (Cổng 5678)**:
  * Khi có lệnh `/upload` (hoặc sau khi tạo xong video), server tự động bắn webhook sang n8n qua URL: `http://localhost:5678/webhook/tiktok-task`.
  * n8n nhận task, tự động lấy link affiliate sản phẩm từ Showcase của shop tương ứng (`Get Link Affiliate`).
  * n8n tải file video hoàn chỉnh từ `http://host.docker.internal:3000/api/jobs/:jobId/final-video`.
  * Upload video lên TikTok Shop kèm giỏ hàng sản phẩm và gửi thông báo kết quả về Telegram.

---

### 2. Cài Đặt & Khởi Động n8n Bằng Docker:

Chạy container n8n bằng lệnh Docker sau (lưu ý cờ `--add-host=host.docker.internal:host-gateway` để n8n có thể gọi ngược lại server Node.js chạy trên máy host):

```bash
docker run -d \
  --name n8n \
  -p 5678:5678 \
  -v n8n_data:/home/node/.n8n \
  --add-host=host.docker.internal:host-gateway \
  n8nio/n8n:latest
```

---

### 3. Import Workflow Vào n8n:

1. Mở trình duyệt truy cập n8n UI: **`http://localhost:5678`**
2. Tạo tài khoản owner nếu là lần đầu khởi chạy.
3. Vào menu **Workflows** → Chọn **Import from File...**
4. Chọn file workflow trong thư mục dự án:
   * **`workflows/TIKTOK UPLOAD ONLY.json`** (Khuyên dùng): Workflow upload chuyên biệt và tinh gọn (23 nodes), nhận webhook từ bot để gắn giỏ hàng affiliate và đăng TikTok.
   * **`workflows/TELEGRAM GEN VIDEO + AUTO UPLOAD TIKTOK.json`**: Workflow toàn trình (dành cho chế độ n8n trigger trực tiếp).
5. Nhấn **Save** và gạt công tắc **Active** (bật workflow) để webhook URL `/webhook/tiktok-task` bắt đầu lắng nghe.

---

### 4. Đồng Bộ Tài Khoản TikTok Từ n8n Sang Server (`sync-tiktok-accounts.js`):

Nếu bạn đã đăng nhập hoặc cấu hình credential tài khoản TikTok bên trong n8n, bạn có thể đồng bộ nhanh chóng sang server bằng 1 lệnh duy nhất:

```bash
cd playwright-service
node sync-tiktok-accounts.js
```
*Script sẽ tự động kết nối vào Docker container n8n, giải mã token từ `database.sqlite` của n8n và cập nhật trực tiếp vào file `tiktok-accounts.json` của server.*

---

### 5. Cấu Hình File `.env` Cho n8n:

Trong file `playwright-service/.env`:
```env
# Địa chỉ n8n webhook
N8N_WEBHOOK_BASE_URL=http://localhost:5678

# Chế độ điều phối
# false: Server Node.js làm bot Telegram chính, tự forward sang n8n khi upload (Mặc định khuyên dùng)
# true: Chỉ bật khi muốn n8n trực tiếp làm Telegram Trigger
N8N_ORCHESTRATION=false
```

---

### 6. Cơ Chế Fallback (Không bắt buộc phải có n8n):
Nếu bạn **không bật n8n**, hệ thống vẫn hoạt động bình thường! Khi người dùng gõ `/upload`, server sẽ tự động fallback sang module tích hợp sẵn `services/tiktok-web-upload.js` để đăng video trực tiếp lên TikTok bằng cookies trong `tiktok-accounts.json`.

---

## 📁 Cấu Trúc Dự Án

```text
ai-fashion-review/
├── setup.bat                     # File cài đặt tự động 1-click cho Windows
├── start.bat                     # File khởi động server 1-click cho Windows (node server.js)
├── setup.sh                      # Script cài đặt tự động cho macOS/Linux
├── start.sh                      # Script khởi động server cho macOS/Linux
├── README.md                     # Tài liệu hướng dẫn sử dụng
│
└── playwright-service/
    ├── server.js                 # Điểm khởi chạy Express Server & Telegram Bot Polling
    ├── config.json               # Cấu hình kênh, lịch auto scheduler, settings
    ├── tiktok-accounts.json      # Cookie và tài khoản TikTok Shop
    ├── login.js                  # Tool đăng nhập Google Labs & Gemini để lấy session
    ├── setup.js                  # Engine cài đặt môi trường cho setup.bat/setup.sh
    │
    ├── services/
    │   ├── telegram-bot.js       # Xử lý lệnh Telegram và hàng đợi bot
    │   ├── video.js              # Gọi Direct API sinh video Google Flow (Veo 3)
    │   ├── video-resize.js       # FFmpeg crop, resize 9:16 và lồng tiếng
    │   ├── template-options.js   # Phân loại và chuẩn hóa options cho template /t...
    │   ├── auto-template-scheduler.js # Bộ lập lịch tự động đăng video theo giờ
    │   ├── tiktok-web-upload.js  # Upload video lên TikTok Shop tự động
    │   └── gemini-client/        # Client giao tiếp với Google Gemini Web API
    │
    ├── chrome-data/              # Profile trình duyệt Chromium lưu session Google
    ├── gemini-cookies/           # Cookie trích xuất tự động cho Gemini
    ├── storyboard-review-runs/   # Thư mục chứa video và storyboard của các job
    └── uploads/                  # File tạm xử lý video
```

---

## ❓ Xử Lý Sự Cố Thường Gặp (Troubleshooting)

### 1. Google báo hết hạn session hoặc lỗi 401 Unauthorized:
Chạy lại lệnh đăng nhập Google để cập nhật cookie mới nhất:
```bash
cd playwright-service
node login.js
```
*(Đăng nhập xong quay lại Terminal nhấn Enter, sau đó khởi động lại server).*

### 2. Cổng 3000 bị chiếm (Port 3000 in use):
* **Trên macOS / Linux**:
  ```bash
  lsof -ti :3000 | xargs kill -9
  ```
* **Trên Windows**:
  ```cmd
  netstat -ano | findstr :3000
  taskkill /PID <PID_tim_duoc> /F
  ```

### 3. Telegram Bot không phản hồi:
* Kiểm tra `TELEGRAM_BOT_TOKEN` trong file `playwright-service/.env`.
* Đảm bảo không có tiến trình server nào khác đang chạy song song cùng 1 bot token (gây xung đột Polling Conflict 409).
* Kiểm tra log trên cửa sổ console server để xem chi tiết thông báo lỗi.
