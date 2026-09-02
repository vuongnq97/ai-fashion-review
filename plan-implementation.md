# Kế hoạch implementation: Telegram → Gen Video → TikTok Affiliate

## 1. Mục tiêu

Tạo một workflow n8n JSON mới, bắt đầu từ Telegram và kết thúc bằng việc upload video lên TikTok kèm sản phẩm affiliate.

Toàn bộ logic tạo nội dung hiện tại vẫn chạy trong `playwright-service`:

- phân tích sản phẩm;
- tạo storyboard;
- tạo panel images;
- tạo video bằng Google Flow/Veo;
- resize/crop video bằng FFmpeg.

n8n không thực thi lại các thuật toán trên. n8n chịu trách nhiệm:

- nhận yêu cầu từ Telegram;
- mở shortlink TikTok Shop để lấy `product_id`, title, tối đa 8 ảnh và Product description;
- điều phối generation job;
- hiển thị checkpoint để biết pipeline đang chạy tới bước nào;
- xác minh sản phẩm có thể gắn giỏ hàng bằng node affiliate hiện tại;
- nhận lệnh `/remake` hoặc `/upload` sau khi các video panel đã được gửi lại Telegram;
- upload video hoàn chỉnh lên TikTok kèm product anchor;
- lưu trạng thái và gửi kết quả về Telegram.

Workflow cũ `workflows/AUTO UPLOAD VIDEO +AFFILITATE LIINK TIKTOK.json` được giữ nguyên để đối chiếu. Kết quả implementation là một file JSON mới.

## 2. Kiến trúc tổng thể

```text
Telegram Trigger (n8n)
  → Parse shortlink
  → Download TikTok Shop PDP HTML
  → Extract product_id/title/Product description/images
  → Start Generation Job (playwright-service)
  → Checkpoint 01: Product Assets Extracted
  → Checkpoint 02: Product Analyzed
  → Checkpoint 03: Storyboard Generated
  → Checkpoint 04: Panel Images Generated
  → Checkpoint 05: Videos Generated
  → Checkpoint 06: Waiting For User Command
  → Send Panel Videos To Telegram
  → Wait/Handle /remake or /upload
  → If /remake: regenerate selected panel video, then wait again
  → If /upload: merge latest panel videos into final 9:16 video
  → Get Link Affiliate
  → Verify Product Can Attach Cart
  → Upload final video lên TikTok kèm product anchor
  → Ghi audit/idempotency
  → Thông báo kết quả qua Telegram
```

## 3. Nguyên tắc thiết kế

### 3.1 Generation vẫn thuộc Node/Playwright

Không chuyển Playwright, Gemini, Google AI Studio, Google Flow/Veo hoặc FFmpeg thành Code node trong n8n. Các service hiện có tiếp tục là source of truth của pipeline generation.

### 3.2 Mỗi step có checkpoint riêng trong n8n

Mỗi giai đoạn generation có một cụm node được đặt tên rõ ràng:

```text
HTTP: Check <Step>
  → IF: Step Reached?
      ├─ Yes → sang checkpoint tiếp theo
      └─ No  → Wait → poll lại
```

Khi xem một execution:

- node màu xanh: bước đã hoàn thành;
- node đang chạy hoặc đang wait: bước hiện tại;
- node lỗi: vị trí pipeline thất bại.

Điều kiện checkpoint phải dùng `stepOrder >= expectedStepOrder`, không chỉ so sánh bằng nhau. Cách này tránh workflow bị kẹt nếu server hoàn thành nhiều bước giữa hai lần poll.

### 3.3 Telegram ingress và n8n gateway

Workflow hiện tại dùng n8n `Webhook` làm trigger, trong khi Telegram bot không cấu hình webhook trực tiếp. Vì vậy `playwright-service` vẫn cần long-poll Telegram để làm gateway nhận message rồi forward sang n8n webhook.

Khi chạy chế độ này:

```env
N8N_ORCHESTRATION=true
TELEGRAM_POLLING_DISABLED=false
```

`N8N_ORCHESTRATION=true` nghĩa là bot local chỉ đóng vai trò gateway/control-command handler cho job n8n. `/upload` là command điều khiển job, không phải folder Drive.

Chỉ đặt:

```env
TELEGRAM_POLLING_DISABLED=true
```

khi n8n đã nhận Telegram update trực tiếp bằng Telegram Trigger hoặc Telegram webhook riêng. Nếu tắt polling mà n8n vẫn chỉ có Webhook `tiktok-task`, Telegram message sẽ không tự vào workflow.

## 4. Contract tin nhắn Telegram

Người dùng không gửi album ảnh nữa. Tin nhắn khởi tạo job chỉ cần một shortlink TikTok Shop:

```text
https://vt.tiktok.com/ZS9BmkKeUr2B2-NiRSN/
```

n8n mở shortlink, theo redirect đến PDP:

```text
https://shop.tiktok.com/vn/pdp/1736025111455303479?xxxxx
```

`product_id` được lấy từ path `/pdp/<product_id>`. Title, ảnh và Product description được lấy từ HTML PDP, ưu tiên JSON nhúng `product_model` nếu có.

n8n chỉ gửi URL ảnh sang `playwright-service`, không download ảnh và không gửi base64 ảnh qua workflow execution. Bước download ảnh chạy trong code Node của service vì không cần browser/Playwright.

Một generation job cần các trường:

```json
{
  "chatId": "123456789",
  "sourceMessageId": "telegram-message-id",
  "shortlink": "https://vt.tiktok.com/ZS9BmkKeUr2B2-NiRSN/",
  "productUrl": "https://shop.tiktok.com/vn/pdp/1736025111455303479?xxxxx",
  "template": "template5_1",
  "productId": "1736025111455303479",
  "productTitle": "Tên sản phẩm",
  "productDescription": "Product description text",
  "productImages": [
    { "url": "https://...", "width": 790, "height": 1040 }
  ]
}
```

Quy ước command đề xuất để chọn template khi cần:

```text
/template5_1 https://vt.tiktok.com/...
```

Nếu không có command template, dùng template mặc định trong cấu hình. Caption và hashtag không lấy từ Google Sheet nữa; chúng là output của flow phân tích/gen video.

Sau khi job generation hoàn tất, bot chỉ gửi các video panel riêng lẻ về Telegram để người dùng kiểm tra/sửa từng cảnh. Final video chưa được merge ở bước này. Command upload:

```text
/upload
```

`/upload` dùng job hoàn tất gần nhất của chat hiện tại, hoặc nhận `jobId` nếu cần hỗ trợ nhiều job song song:

```text
/upload tg_123456789_1736025111455303479
```

n8n cần từ chối sớm và báo Telegram nếu:

- tin nhắn không có shortlink hợp lệ;
- không resolve được PDP URL;
- không lấy được `product_id`;
- không lấy được ảnh/Product description đủ tối thiểu để gen video;
- command/template không hợp lệ;
- khi upload, sản phẩm không attach được giỏ hàng/affiliate anchor.

`/upload` là control command của job TikTok hiện tại, không còn là command folder Drive. Vì vậy nó phải được route vào command loop/job signal (`POST /api/jobs/command`) hoặc execution đang đợi `/wait-command`; tuyệt đối không fallback sang luồng tìm folder Drive tên `upload`.

Khi chạy bằng n8n orchestration qua n8n Webhook `tiktok-task`, Telegram polling nội bộ trong `playwright-service` vẫn bật như gateway:

```env
N8N_ORCHESTRATION=true
TELEGRAM_POLLING_DISABLED=false
```

Nếu sau này đổi sang n8n Telegram Trigger thật, lúc đó mới tắt gateway bằng `TELEGRAM_POLLING_DISABLED=true` để tránh hai listener Telegram cùng nhận message.

## 5. Job API cho playwright-service

### 5.1 Khởi tạo job từ dữ liệu sản phẩm

```http
POST /api/jobs/enqueue
```

Request:

```json
{
  "chatId": "123456789",
  "sourceMessageId": "telegram-message-id",
  "shortlink": "https://vt.tiktok.com/ZS9BmkKeUr2B2-NiRSN/",
  "productUrl": "https://shop.tiktok.com/vn/pdp/1736025111455303479?xxxxx",
  "template": "template5_1",
  "productId": "1736025111455303479",
  "productTitle": "Tên sản phẩm",
  "productDescription": "Product description text",
  "productImages": [
    { "url": "https://...", "width": 790, "height": 1040 }
  ]
}
```

Response:

```json
{
  "jobId": "tg_123456789_1736025111455303479",
  "isOwner": true,
  "status": "queued"
}
```

Với cùng `chatId + productId`, chỉ một job active được tạo tại một thời điểm để tránh generate/upload trùng.

### 5.2 Download Product description images trong service

`playwright-service` nhận `productImages` dạng URL, sau đó download tối đa 8 ảnh về local bằng Node HTTP/fetch. Bước này không dùng Playwright.

Folder đề xuất:

```text
/tmp/ai-fashion-review/jobs/<jobId>/source-images/01.jpg
/tmp/ai-fashion-review/jobs/<jobId>/source-images/02.jpg
...
```

Helper đề xuất:

```text
playwright-service/services/product-assets.js
```

API nội bộ:

```javascript
await downloadProductImages(productImages, jobDir, {
  limit: 8,
  timeoutMs: 15000,
  maxBytesPerImage: 10 * 1024 * 1024
});
```

Yêu cầu xử lý:

- chỉ nhận URL `https://`;
- giới hạn tối đa 8 ảnh;
- timeout từng ảnh;
- kiểm tra `content-type` phải là `image/*`;
- giới hạn dung lượng từng ảnh;
- đặt tên file ổn định theo thứ tự `01`, `02`, ...;
- nếu một ảnh lỗi thì bỏ qua ảnh đó, nhưng job phải fail nếu số ảnh còn lại dưới ngưỡng tối thiểu;
- source images được cleanup cùng job sau khi upload hoặc hết TTL.

Gemini nhận input gồm:

- ảnh local đã download;
- `productTitle`;
- `productDescription`;
- metadata cơ bản như `productId` và `productUrl`.

### 5.3 Đọc trạng thái job

```http
GET /api/jobs/:jobId
```

Response chuẩn:

```json
{
  "jobId": "tg_123456789_1736025111455303479",
  "status": "running",
  "currentStep": "generating_videos",
  "stepOrder": 5,
  "progressPercent": 68,
  "message": "Đang tạo video panel 3/4",
  "panels": [
    { "index": 1, "status": "completed" },
    { "index": 2, "status": "completed" },
    { "index": 3, "status": "running" },
    { "index": 4, "status": "pending" }
  ],
  "error": null
}
```

### 5.4 Lấy kết quả job

```http
GET /api/jobs/:jobId/result
```

Response không chứa toàn bộ video base64 để tránh payload JSON quá lớn:

```json
{
  "jobId": "tg_123456789_1736025111455303479",
  "analysis": {},
  "caption": "...",
  "hashtags": ["#review", "#tiktokshop"],
  "product": {
    "productId": "1736025111455303479",
    "title": "Tên sản phẩm"
  },
  "finalVideo": {
    "status": "completed",
    "downloadPath": "/api/jobs/tg_123456789_1736025111455303479/final-video"
  }
}
```

Video được tải dạng binary qua:

```http
GET /api/jobs/:jobId/final-video
```

### 5.5 Cleanup job

Chỉ cleanup file video khi:

- final video đã upload thành công; hoặc
- job hết thời gian lưu trữ cấu hình; hoặc
- người dùng chủ động hủy job.

Không cleanup ngay sau generation như flow gửi Telegram hiện tại, vì n8n còn cần tải video để upload TikTok.

## 6. Progress instrumentation trong pipeline hiện tại

Thêm callback `onProgress()` vào orchestration layer, không viết lại business logic:

```javascript
await onProgress({
  currentStep: 'storyboard_generated',
  stepOrder: 3,
  progressPercent: 35,
  message: 'Đã tạo storyboard'
});
```

Danh sách step chuẩn:

| Order | Step | Ý nghĩa |
|---:|---|---|
| 0 | `queued` | Đã nhận shortlink và tạo job |
| 1 | `product_assets_extracted` | Đã có title, Product description và tối đa 8 ảnh |
| 2 | `product_analyzed` | Đã phân tích sản phẩm |
| 3 | `storyboard_generated` | Đã tạo storyboard/prompts |
| 4 | `panels_generated` | Đã tạo panel images |
| 5 | `generating_videos` | Đang tạo video; có tiến độ panel N/M |
| 6 | `videos_generated` | Đã tạo video panel; user có thể `/remake` hoặc `/upload` |
| 7 | `completed` | Generation job hoàn tất và đang chờ command |
| -1 | `failed` | Job thất bại; kèm step và error |

Nếu một provider hiện gom nhiều thao tác trong một hàm, chỉ thêm callback tại ranh giới thật sự đã hoàn thành. Không báo hoàn tất giả trước khi artifact được ghi thành công.

## 7. Xác minh sản phẩm để gắn giỏ hàng

### 7.1 `Get Link Affiliate` vẫn cần, nhưng đổi vai trò

Node `Get Link Affiliate` có type:

```text
n8n-nodes-social-tiktok.tiktokAll
```

với `resource: product`. Output hiện tại là danh sách sản phẩm affiliate/showcase rút gọn trong `products`. Workflow cũ đang dùng node này để truyền `anchors` cho upload node:

- `product_id`;
- `title`.

Shortlink/PDP đã đủ dữ liệu cho generation, nhưng chưa đủ để đảm bảo upload node gắn được giỏ hàng. Vì vậy `Get Link Affiliate` vẫn nên giữ ở phase upload để kiểm tra:

- sản phẩm có nằm trong danh sách mà credential hiện tại được phép gắn affiliate/cart hay không;
- title/display name dùng cho anchor có khớp với sản phẩm TikTok trả về hay không;
- dừng sớm trước upload nếu sản phẩm không đủ điều kiện attach.

### 7.2 Chọn đúng sản phẩm trước upload

Thêm Code/Set node để tìm sản phẩm:

```javascript
const product = products.find(
  (item) => String(item.product_id) === String(productId)
);
```

Nếu không tìm thấy, dừng trước upload và báo Telegram rằng `product_id` không nằm trong danh sách affiliate/cart anchor mà credential hiện tại attach được.

## 8. Node map của workflow n8n mới

### Nhóm A — Telegram intake

1. `Telegram Trigger`
2. `Parse Shortlink And Template`
3. `Resolve TikTok Shortlink`
4. `Extract product_id From PDP URL`
5. `Download PDP HTML`
6. `Extract Product Assets URLs`
7. `Limit Product Image URLs To 8`
8. `Enqueue Generation Job`

### Nhóm B — Generation checkpoints

9. `01 — Product Assets Extracted`
10. `Wait — Product Assets Extracted`
11. `02 — Product Analyzed`
12. `Wait — Product Analyzed`
13. `03 — Storyboard Generated`
14. `Wait — Storyboard Generated`
15. `04 — Panels Generated`
16. `Wait — Panels Generated`
17. `05 — Videos Generated`
18. `Wait — Videos Generated`
19. `06 — Videos Generated`
20. `Wait — Videos Generated`
21. `07 — Waiting For User Command`
22. `Get Generation Result`

Mỗi checkpoint có nhánh `Job Failed?` trước khi retry.

### Nhóm C — Telegram preview và command loop

23. `Get Generation Result`
24. `Telegram — Generation Completed`
25. `Wait For User Command`
26. `Route User Command`
27. `Execute Remake Panels`
28. `Prepare Final Video For Upload`

### Nhóm D — Verify cart attachment

29. `Get Link Affiliate`
30. `Find Product By product_id`
31. `Product Can Attach Cart?`

### Nhóm E — Upload

32. `Check Upload Idempotency`
33. `Download Final Generated Video`
34. `TikTok Upload With Product`
35. `Save Publish Result`
36. `Cleanup Generation Job`

### Nhóm F — Notification/error

37. `Telegram — Job Accepted`
38. `Telegram — Generation Progress`
39. `Telegram — Upload Completed`
40. `Telegram — Job Failed`

## 9. Upload TikTok và affiliate anchor

Tái sử dụng credential và hai community node từ workflow cũ:

- `Get Link Affiliate`;
- `TikTok Upload With Product`.

Anchor dùng sản phẩm đã validate:

```javascript
{
  "type": "product",
  "productId": product.product_id,
  "displayName": product.title
}
```

Final video chỉ được merge sau khi người dùng gửi `/upload`, để mọi lệnh `/remake` trước đó đều được tính vào bản upload. Visibility khi test phải là chế độ riêng tư/`SELF_ONLY` tương ứng với node đang dùng.

## 10. Idempotency và audit

Khóa chống đăng trùng:

```text
<jobId>:final
```

Trạng thái upload final video:

```text
generated → downloading → uploading → published
                                 └→ failed
```

Lưu tối thiểu:

- `job_id`;
- `chat_id`;
- `product_id`;
- `shortlink`;
- `product_url`;
- `caption`;
- `hashtags`;
- `status`;
- `publish_id`;
- `error`;
- timestamps.

Không upload lại nếu `/upload` được gửi nhiều lần cho cùng một job đã published. Retry upload không được chạy lại generation.

## 11. Xử lý lỗi và timeout

- Poll interval ban đầu: 10–15 giây.
- Generation timeout: cấu hình theo số panel, không dùng timeout HTTP đồng bộ dài.
- TikTok upload retry: tối đa 2 lần với lỗi tạm thời.
- Không retry tự động khi shortlink không resolve được, `product_id` không attach được giỏ hàng, hoặc credential thiếu quyền.
- Lưu `failedStep`, error code và message trong job.
- Telegram chỉ nhận thông báo ngắn; chi tiết kỹ thuật nằm trong execution data/log server đã loại bỏ secrets.

## 12. File dự kiến thay đổi

### File hiện có

- `playwright-service/server.js`
- `playwright-service/routes/index.js`
- `playwright-service/services/storyboard-fullflow.js`
- các storyboard provider cần phát progress event
- `playwright-service/.env.example`
- `README.md`

### File mới

- `playwright-service/services/generation-job.js`
- `workflows/TELEGRAM GEN VIDEO + AUTO UPLOAD TIKTOK.json`

Tên service có thể điều chỉnh theo convention hiện tại, nhưng không gộp job store vào `routes/index.js`.

## 13. Trình tự implementation

1. Thêm job state model và unit-test state transitions.
2. Thêm bước extract product assets từ shortlink/PDP HTML.
3. Thêm helper Node thuần để download tối đa 8 ảnh Product description về local, không dùng Playwright.
4. Gửi ảnh local + title + Product description vào Gemini analysis.
5. Instrument progress callback vào generation pipeline hiện tại.
6. Thêm Job API và binary download endpoint cho final video.
7. Thêm chế độ `N8N_ORCHESTRATION` để tránh Telegram polling trùng.
8. Xác minh output thật của `Get Link Affiliate` trên instance, không đoán schema ngoài `product_id`/`title`.
9. Tạo workflow mới từ Telegram intake đến generation checkpoints.
10. Ghép nhánh preview video về Telegram và command `/upload`.
11. Ghép nhánh affiliate/cart verification bằng `Get Link Affiliate`.
12. Ghép upload final video, idempotency và audit.
13. Validate/import workflow bằng n8n-as-code.
14. Test end-to-end với TikTok ở chế độ riêng tư.
15. Chỉ activate production sau khi toàn bộ acceptance criteria đạt.

## 14. Quy trình n8n-as-code khi bắt đầu implement

Trước khi đọc, sửa, validate hoặc push workflow trên instance:

```bash
cd /Users/mac/Desktop/n8n
npx --yes n8nac update-ai
npx --yes n8nac workspace migrate --json
```

Nếu migration không bắt buộc hoặc đã được người dùng chấp thuận và áp dụng:

```bash
npx --yes n8nac workspace status --json
```

Phải sử dụng chính xác `workflowDir` backend trả về. Không tự dựng đường dẫn workflow từ tên environment hoặc sync folder.

Đối với workflow đang tồn tại:

```bash
npx --yes n8nac list
npx --yes n8nac pull <workflowId>
```

Sau khi tạo/sửa:

```bash
npx --yes n8nac validate <full-workflow-path>
npx --yes n8nac push <full-workflow-path> --verify
```

Không force-push nếu có conflict.

## 15. Kế hoạch test

### Server API

- enqueue từ shortlink/product assets;
- download tối đa 8 image URLs về local bằng Node HTTP/fetch;
- reject URL không phải `https://` hoặc response không phải `image/*`;
- bỏ qua ảnh lỗi nhưng fail nếu dưới ngưỡng ảnh tối thiểu;
- gửi đúng ảnh local + title + Product description vào Gemini;
- không tạo trùng job active với cùng `chatId + productId`;
- kiểm tra mọi state transition;
- kiểm tra progress panel N/M;
- tải final video binary sau khi job hoàn tất;
- đảm bảo cleanup không chạy trước upload;
- kiểm tra cleanup sau khi upload hoàn tất.

### n8n

- command hợp lệ và không hợp lệ;
- shortlink hợp lệ và không hợp lệ;
- PDP URL không chứa `product_id`;
- HTML thiếu `product_model.description`;
- giới hạn tối đa 8 URL ảnh Product description trước khi enqueue;
- job generation lỗi ở từng checkpoint;
- `/upload` khi chưa có job hoàn tất;
- sản phẩm không attach được giỏ hàng từ danh sách affiliate/showcase;
- upload một final video;
- gửi `/upload` nhiều lần không đăng trùng;
- execution hiển thị đúng node checkpoint hiện tại.

### TikTok

- test với visibility riêng tư;
- xác nhận video có đúng product anchor;
- xác nhận caption và tên sản phẩm;
- xác nhận `publish_id` được lưu;
- chỉ chuyển production visibility sau khi người dùng kiểm tra kết quả.

## 16. Acceptance criteria

Implementation hoàn tất khi:

- có một workflow JSON mới, không ghi đè workflow cũ;
- Telegram là trigger duy nhất của workflow mới;
- Node/Playwright vẫn thực thi toàn bộ generation logic;
- người dùng chỉ cần gửi shortlink để bắt đầu gen video;
- title, tối đa 8 ảnh và Product description được lấy từ PDP HTML;
- caption và hashtag lấy từ output phân tích/gen video, không lấy từ Google Sheet;
- n8n có checkpoint node riêng cho từng step và thể hiện đúng tiến độ thực;
- video hoàn chỉnh được gửi lại Telegram trước khi upload;
- `/upload` upload đúng final video đã merge;
- `Get Link Affiliate` được dùng để verify sản phẩm có thể gắn giỏ hàng trước upload;
- video được gắn đúng affiliate product/cart anchor;
- không upload trùng khi retry hoặc khi người dùng gửi `/upload` nhiều lần;
- lỗi được gắn với đúng step và gửi thông báo Telegram;
- secrets không xuất hiện trong workflow JSON, execution output hoặc repository;
- test end-to-end ở chế độ riêng tư thành công trước khi activate production.

## 17. Lưu ý bảo mật

- Rotate Telegram bot token đang có hình thức giống token thật trong `.env.example`, sau đó thay bằng placeholder.
- Không lưu TikTok cookie/access token vào workflow JSON.
- Mask credential values và request headers trong log.
- Không commit token store, cookies, browser profiles hoặc generated videos.
