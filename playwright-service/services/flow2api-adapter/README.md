# Flow2API Adapter for AI Fashion Review

Thư mục này chứa module tích hợp độc lập giữa **ai-fashion-review** và **Flow2API Gateway**.

## 📌 Tính Năng
- Thay thế hoàn toàn tầng Playwright tự động hóa web (click DOM Google Flow).
- Giao tiếp qua chuẩn REST API OpenAI (`/v1/chat/completions`) & Google Flow.
- Hỗ trợ sinh ảnh dọc 9:16 (Gemini Flash Image / Imagen 3) và sinh video Veo 8s (`veo-3.1-lite-i2v-8s-portrait`).
- Độc lập 100%, không ảnh hưởng đến luồng code cũ.

---

## 🚀 Cách Chạy Test Độc Lập

### 1. Đảm bảo Flow2API Gateway đang chạy
```bash
docker ps | grep flow2api
```
*(Nếu chưa chạy, khởi động container tại thư mục `flow2api-test`)*

### 2. Chạy test full luồng với ảnh mẫu local
```bash
node playwright-service/services/flow2api-adapter/test-flow2api-fullflow.js
```

### 3. Chạy test với một link TikTok Shop thật
```bash
node playwright-service/services/flow2api-adapter/test-flow2api-fullflow.js "https://vt.tiktok.com/ZSjabcdef/"
```

---

## ⚙️ Cấu Hình Hệ Thống

Để kích hoạt provider này cho toàn bộ hệ thống bot Telegram và web server:

Trong `playwright-service/.env`:
```env
STORYBOARD_PROVIDER=flow2api
FLOW2API_BASE_URL=http://127.0.0.1:38000
FLOW2API_API_KEY=han1234
```
