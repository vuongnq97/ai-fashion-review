# 📑 HỆ THỐNG TEMPLATE PROMPT TẠO STORYBOARD & VIDEO TEMPLATE 5
> **Áp dụng cho**: Template 5 (`/template5`), Template 5.1 (`/template5_1`), Template 5.2 (`/template5_2`)  
> **Kèm Toàn Bộ Dữ Liệu & Hình Ảnh Gốc**: Trích xuất từ TikTok Shop link [https://vt.tiktok.com/ZS9SLDcY8khTJ-JrDfz/](https://vt.tiktok.com/ZS9SLDcY8khTJ-JrDfz/)  
> **Thư mục phiên chạy**: `playwright-service/storyboard-review-runs/2026-09-06T07-43-41-084Z-template5_2-flow-l2pclf`

---

## MỤC LỤC
1. [Dữ Liệu Sản Phẩm & Hình Ảnh Gốc Lấy Từ Link TikTok Shop](#1-dữ-liệu-sản-phẩm--hình-ảnh-gốc-lấy-từ-link-tiktok-shop)
2. [Khung 4 Cảnh Marketing Cốt Lõi](#2-khung-4-cảnh-marketing-cốt-lõi)
3. [Prompt Giai Đoạn 1: Phân Tích Sản Phẩm (Marketing Analysis Prompt)](#3-prompt-giai-đoạn-1-phân-tích-sản-phẩm-marketing-analysis-prompt)
   - [Template Prompt Phân Tích](#template-prompt-phân-tích)
   - [Kết Quả JSON Kịch Bản Thực Tế Của Máy Hút Bụi JETZT X9](#kết-quả-json-kịch-bản-thực-tế-của-máy-hút-bụi-jetzt-x9)
4. [Prompt Giai Đoạn 2: Tạo Master Storyboard 16:9 Trên Google Flow](#4-prompt-giai-đoạn-2-tạo-master-storyboard-169-trên-google-flow)
   - [Bản A: Không Chữ (No Text Mode - /template5_1 & /template5_2)](#bản-a-không-chữ-no-text-mode---template5_1--template5_2)
   - [Bản B: Có Chữ Tiếng Việt (With Text Badges - /template5)](#bản-b-có-chữ-tiếng-việt-with-text-badges---template5)
5. [Prompt Giai Đoạn 3: Sinh 2 Video 8 Giây Đa Ảnh Trên Google Flow (Model abra_r2v_8s)](#5-prompt-giai-đoạn-3-sinh-2-video-8-giây-đa-ảnh-trên-google-flow-model-abra_r2v_8s)
   - [Video 1 (8s: Cảnh 1 & Cảnh 2) - Template & Prompt Thực Tế](#video-1-8s-cảnh-1--cảnh-2---template--prompt-thực-tế)
   - [Video 2 (8s: Cảnh 3 & Cảnh 4) - Template & Prompt Thực Tế](#video-2-8s-cảnh-3--cảnh-4---template--prompt-thực-tế)
6. [Tài Nguyên & Đường Dẫn File Của Phiên Chạy Thực Tế](#6-tài-nguyên--đường-dẫn-file-của-phiên-chạy-thực-tế)

---

## 1. Dữ Liệu Sản Phẩm & Hình Ảnh Gốc Lấy Từ Link TikTok Shop

* **Link rút gọn chia sẻ**: [https://vt.tiktok.com/ZS9SLDcY8khTJ-JrDfz/](https://vt.tiktok.com/ZS9SLDcY8khTJ-JrDfz/)
* **TikTok Shop Product ID**: `1730907723739269480`
* **Tiêu đề sản phẩm gốc (Title)**:
  ```text
  [LIVESTREAM] Máy Hút Bụi Cầm Tay Jetzt X9 NEW 19000PA! Hệ Thống Khép Kín HEPA 0.25µm Lọc Sạch 99% Bụi Mịn Lông Thú Cưng, Tránh Ô Nhiễm Thứ Cấp Bảo Vệ Mẹ Bé. Động Cơ 1000W, Nhẹ 1.8kg Kèm Đầu Hút Đa Năng Làm Sạch Sàn Sofa, BH 1 Năm
  ```

### 1.1. Danh Sách 8 Hình Ảnh Sản Phẩm Phân Giải Cao (CDN TikTok Shop)

| STT | Độ phân giải | URL Ảnh CDN TikTok Shop |
|---|---|---|
| **Ảnh 1** | 1122 x 1402 | [https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/4ce5ec46987a4d0bb62ce42f49254e5f~tplv-aphluv4xwc-origin-jpeg.jpeg](https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/4ce5ec46987a4d0bb62ce42f49254e5f~tplv-aphluv4xwc-origin-jpeg.jpeg?dr=15568&t=555f072d&ps=933b5bde&shp=a3510d86&shcp=6ce186a1&idc=my&from=2739998086) |
| **Ảnh 2** | 1122 x 1402 | [https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/d2a289e3c59e41dfa0a5430b10e08e28~tplv-aphluv4xwc-origin-jpeg.jpeg](https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/d2a289e3c59e41dfa0a5430b10e08e28~tplv-aphluv4xwc-origin-jpeg.jpeg?dr=15568&t=555f072d&ps=933b5bde&shp=a3510d86&shcp=6ce186a1&idc=my&from=2739998086) |
| **Ảnh 3** | 1122 x 1402 | [https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/8aaee7c32de9439c9261f0848f8705db~tplv-aphluv4xwc-origin-jpeg.jpeg](https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/8aaee7c32de9439c9261f0848f8705db~tplv-aphluv4xwc-origin-jpeg.jpeg?dr=15568&t=555f072d&ps=933b5bde&shp=a3510d86&shcp=6ce186a1&idc=my&from=2739998086) |
| **Ảnh 4** | 1254 x 1254 | [https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/2c10dc6df9744038b8c0ad55ff5f80e6~tplv-aphluv4xwc-origin-jpeg.jpeg](https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/2c10dc6df9744038b8c0ad55ff5f80e6~tplv-aphluv4xwc-origin-jpeg.jpeg?dr=15568&t=555f072d&ps=933b5bde&shp=a3510d86&shcp=6ce186a1&idc=my&from=2739998086) |
| **Ảnh 5** | 1254 x 1254 | [https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/f35191fdfe904b5b972ba9c71a44c5a5~tplv-aphluv4xwc-origin-jpeg.jpeg](https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/f35191fdfe904b5b972ba9c71a44c5a5~tplv-aphluv4xwc-origin-jpeg.jpeg?dr=15568&t=555f072d&ps=933b5bde&shp=a3510d86&shcp=6ce186a1&idc=my&from=2739998086) |
| **Ảnh 6** | 1254 x 1254 | [https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/901c7ed3b3cd4bc39d8616b558f917c7~tplv-aphluv4xwc-origin-jpeg.jpeg](https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/901c7ed3b3cd4bc39d8616b558f917c7~tplv-aphluv4xwc-origin-jpeg.jpeg?dr=15568&t=555f072d&ps=933b5bde&shp=a3510d86&shcp=6ce186a1&idc=my&from=2739998086) |
| **Ảnh 7** | 1122 x 1402 | [https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/78bffe7cff3a4a07b10e96f08d8c6be1~tplv-aphluv4xwc-origin-jpeg.jpeg](https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/78bffe7cff3a4a07b10e96f08d8c6be1~tplv-aphluv4xwc-origin-jpeg.jpeg?dr=15568&t=555f072d&ps=933b5bde&shp=a3510d86&shcp=6ce186a1&idc=my&from=2739998086) |
| **Ảnh 8** | 1122 x 1402 | [https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/c21d904d280a411dbb7f2790238e08e9~tplv-aphluv4xwc-origin-jpeg.jpeg](https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/c21d904d280a411dbb7f2790238e08e9~tplv-aphluv4xwc-origin-jpeg.jpeg?dr=15568&t=555f072d&ps=933b5bde&shp=a3510d86&shcp=6ce186a1&idc=my&from=2739998086) |

### 1.2. Toàn Bộ Nội Dung Mô Tả Chi Tiết (Product Description)

```text
Máy Hút Bụi Cầm Tay Có Dây JETZT X9 3 Trong 1 - Lực Hút 19.000Pa, Động Cơ BOOST 1000W, Bộ Lọc HEPA Đa Tầng, Hộp Bụi 0.8L, Nhẹ 1.8kg, Dây Điện 4.5m, Hút Bụi Sàn Nhà Khe Góc Lông Thú, Bảo Hành 12 Tháng

JETZT X9 là máy hút bụi cầm tay có dây, phù hợp để làm sạch bụi khô, tóc rụng, vụn nhỏ và lông thú cưng trên sàn nhà, khe góc, gầm bàn ghế và các vị trí khó vệ sinh trong gia đình.

Sản phẩm được trang bị động cơ BOOST 600W, lực hút 19.000Pa, hộp bụi 0.8L và bộ lọc HEPA đa tầng, giúp việc dọn dẹp hằng ngày trở nên nhanh gọn và tiện lợi hơn.

Thiết kế có dây giúp máy duy trì nguồn điện ổn định trong quá trình sử dụng, phù hợp cho nhu cầu vệ sinh sàn nhà, khe góc, chân tường, gầm bàn ghế và các khu vực nhỏ trong nhà.

Bộ lọc HEPA đa tầng - Hạn chế bụi bay ngược
Bộ lọc HEPA đa tầng hỗ trợ giữ lại bụi mịn, tóc và lông thú trong hộp chứa bụi, giúp hạn chế bụi bay ngược trong quá trình vệ sinh.
Hộp bụi trong suốt giúp dễ quan sát lượng bụi bên trong, tiện lợi khi cần đổ rác hoặc vệ sinh sau khi sử dụng.

Thiết kế gọn nhẹ 1.8kg - Dễ thao tác
Thân máy có trọng lượng khoảng 1.8kg, thiết kế cầm tay gọn gàng, giúp thao tác linh hoạt khi vệ sinh sàn nhà, khe góc hoặc các vị trí thấp như gầm bàn, gầm ghế.
Dây điện dài 4.5m giúp mở rộng phạm vi di chuyển trong phòng, hạn chế việc phải đổi ổ cắm quá nhiều lần khi dọn dẹp.

Bảo hành 12 tháng
JETZT X9 được bảo hành 12 tháng theo chính sách của shop. Nếu cần hỗ trợ trong quá trình sử dụng, khách hàng có thể liên hệ shop qua TikTok Shop để được hướng dẫn nhanh chóng.

#mayhutbui #mayhutbuicamtay #mayhutbuicoDay #mayhutbuijetzt #jetztx9 #hutbuisannha #hutbuilongthu #dogiadung #vesinhnhacua
```

---

## 2. Khung 4 Cảnh Marketing Cốt Lõi

Mọi kịch bản review của hệ thống Template 5 đều vận hành theo cấu trúc phễu chuyển đổi 4 cảnh chặt chẽ:

| Cảnh | Câu hỏi Marketing | Mục tiêu triển khai |
|---|---|---|
| **Cảnh 1 (Hook)** | *Hook gì để người xem dừng lướt?* | Đánh trúng nỗi đau thực tế, gây tò mò, cảnh báo chân thành hoặc so sánh trực quan. |
| **Cảnh 2 (Solution)** | *Sản phẩm là giải pháp gì?* | Giới thiệu tên sản phẩm, công năng chính, cơ chế thông minh, tính tiện lợi. |
| **Cảnh 3 (Proof)** | *Bằng chứng nào khiến người xem tin?* | Demo hoạt động thực tế, cận cảnh chất liệu/cấu tạo, kiểm tra độ bền, thông số kỹ thuật. |
| **Cảnh 4 (Closing / CTA)** | *Lý do gì để họ mua ngay?* | Cam kết đổi trả/bảo hành uy tín, nâng tầm không gian sống, CTA giỏ hàng góc trái. |

---

## 3. Prompt Giai Đoạn 1: Phân Tích Sản Phẩm (Marketing Analysis Prompt)

### Template Prompt Phân Tích
Prompt này được gửi kèm ảnh sản phẩm và mô tả TikTok Shop vào Gemini API:

```text
TEXT-ONLY TASK. Do not generate images. Do not call image generation. Do not create a visual storyboard asset.
You are a senior multi-category e-commerce marketing strategist, TikTok viral content director, and Veo 3 prompt writer.
Analyze the uploaded product reference images (which can be any product: Fashion, Clothing, Bags, Footwear, Cosmetics/Skincare, Home Appliances/Kitchenware, Tech Gadgets, Accessories, etc.) and the TikTok Shop product description metadata. Write a comprehensive 4-scene product review plan as JSON text only.

CRITICAL 4-SCENE MARKETING FRAMEWORK (BẮT BUỘC TRẢ LỜI ĐỦ 4 CÂU HỎI THEO 4 CẢNH):
Video bao gồm đúng 4 cảnh nội dung (sau này được ghép thành 2 video panel, mỗi video chứa 2 cảnh). Bạn PHẢI trả lời sâu sắc 4 câu hỏi cốt lõi dựa trên đặc tính thực tế của sản phẩm:
1. Cảnh 1 (HOOK) — "Hook gì để người xem dừng lướt?"
   - Chọn một hướng triển khai hook hiệu quả nhất:
     * Nêu nỗi đau thực tế: "Bạn cũng đang gặp tình trạng này?", "Khó chịu nhất là khi..."
     * Gây tò mò: "Ít ai biết mẹo này…", "Cứ ngỡ chỉ là món đồ bình thường..."
     * Thấy ngay kết quả: "Trước và sau chỉ khác nhau vài giây...", "Khác biệt thấy rõ khi..."
     * Cảnh báo chân thành: "Đừng mua [tên sản phẩm] trước khi xem điều này..."
     * So sánh giá trị: "Cùng phân khúc nhưng khác biệt nằm ở đây..."
     * Thử thách: "Liệu món đồ này có làm được thật không?"
2. Cảnh 2 (SOLUTION - GIẢI PHÁP) — "Sản phẩm là giải pháp gì?"
   - Giới thiệu giải pháp rõ ràng & thuyết phục:
     * Giới thiệu trực tiếp: "Đây chính là [tên sản phẩm]."
     * Lợi ích chính: Giúp giải quyết vấn đề nhanh hơn, tiện hơn.
     * Điểm khác biệt: Nêu bật tính năng vượt trội so với loại thông thường trên thị trường.
     * Đối tượng & tính tiện lợi: Phù hợp ai, cách dùng dễ dàng, nhỏ gọn mang theo mọi lúc.
3. Cảnh 3 (PROOF - BẰNG CHỨNG) — "Bằng chứng nào khiến người xem tin tưởng?"
   - Đưa ra bằng chứng vững chắc từ ảnh và mô tả sản phẩm:
     * Demo thực tế sản phẩm đang hoạt động, thao tác tay mượt mà.
     * Cận cảnh chất liệu cao cấp, thành phần, chi tiết cấu tạo, độ hoàn thiện tinh xảo.
     * So sánh trước - sau hoặc thông số kỹ thuật thực tế (độ bền, dung tích, công suất, chất liệu...).
4. Cảnh 4 (CLOSING / CTA - CHỐT ĐƠN) — "Lý do gì để họ mua ngay?"
   - Đòn bẩy hành động dứt khoát:
     * Quà tặng kèm / hỗ trợ vận chuyển hoặc ưu đãi đặt sớm.
     * Cam kết đổi trả / bảo hành chính hãng uy tín.
     * Nhắc lại lợi ích lớn nhất: "Nâng tầm cuộc sống và tiết kiệm thời gian mỗi ngày."
     * Kêu gọi hành động CTA rõ ràng: "Bấm ngay vào giỏ hàng góc trái màn hình để đặt ngay."

QUY TẮC CỐT LÕI (STRICT RULES):
1. TUYỆT ĐỐI KHÔNG SỬ DỤNG CON SỐ GIÁ TIỀN HOẶC % GIẢM GIÁ (Để video dùng được lâu dài - evergreen).
2. LỜI THOẠI DỒN DẬP NGẮN GỌN (TỔNG TỐI ĐA 42 TỪ CHO MỖI VIDEO 8 GIÂY GỒM 2 CẢNH):
   - Mỗi cảnh dài từ 15 đến 19 từ tiếng Việt trọn vẹn câu đủ ý nghĩa (có dấu chấm câu kết thúc . ! ?).
   - Tổng Cảnh 1 + Cảnh 2 <= 42 từ; tổng Cảnh 3 + Cảnh 4 <= 42 từ.
   - Tốc độ đọc: Nhanh, liên tục, dồn dập, tự tin, cuốn hút theo phong cách review TikTok viral.
3. THAO TÁC THỰC TẾ, KHÔNG ẢO CGI (100% cử động tay người thật, không đồ họa hoạt hình).
4. VOICE PERSONA: "nu" (giọng nữ miền Nam ngọt ngào tự nhiên) hoặc "nam" (giọng nam miền Nam trầm ấm tự tin).

Return ONLY valid JSON matching this schema:
{
  "analysis": {
    "productName": "Tên sản phẩm tiếng Việt đầy đủ và chính xác từ ảnh/mô tả",
    "category": "fashion|cosmetics|home|gadgets|accessories|other",
    "cartAnchorText": "Câu CTA giỏ hàng ngắn gọn dưới 30 ký tự",
    "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
    "materials": "mô tả chất liệu hoặc thành phần nổi bật",
    "highlights": ["điểm nổi bật 1", "điểm nổi bật 2", "điểm nổi bật 3"],
    "targetAudience": "đối tượng người dùng",
    "fourAnswers": {
      "hook": "Câu trả lời phân tích cho Cảnh 1",
      "solution": "Câu trả lời phân tích cho Cảnh 2",
      "proof": "Câu trả lời phân tích cho Cảnh 3",
      "closing": "Câu trả lời phân tích cho Cảnh 4"
    }
  },
  "voicePersona": {
    "gender": "nu|nam",
    "voiceDescription": "nữ miền Nam ngọt ngào tự nhiên | nam miền Nam trầm ấm tự tin",
    "tone": "thân thiện, duyên dáng, cuốn hút, review chân thực"
  },
  "sceneContext": {
    "location": "mô tả chi tiết không gian bối cảnh sống động phù hợp sản phẩm",
    "lighting": "ánh sáng tự nhiên dịu nhẹ ban ngày kết hợp đèn ấm",
    "mood": "aesthetic, hiện đại, 100% chân thực"
  },
  "scenes": [
    {
      "sceneNumber": 1,
      "phase": "Hook",
      "marketingQuestion": "Hook gì để họ dừng lướt?",
      "marketingAnswer": "Nội dung trả lời",
      "visualDescription": "Mô tả hình ảnh",
      "handInteraction": "Cử động tay người thật",
      "voiceover": "Lời thoại cảnh 1 (15-19 từ)."
    },
    {
      "sceneNumber": 2,
      "phase": "Solution",
      "marketingQuestion": "Sản phẩm là giải pháp gì?",
      "marketingAnswer": "Nội dung trả lời",
      "visualDescription": "Mô tả hình ảnh",
      "handInteraction": "Cử động tay người thật",
      "voiceover": "Lời thoại cảnh 2 (15-19 từ)."
    },
    {
      "sceneNumber": 3,
      "phase": "Proof",
      "marketingQuestion": "Bằng chứng nào khiến họ tin?",
      "marketingAnswer": "Nội dung trả lời",
      "visualDescription": "Mô tả hình ảnh",
      "handInteraction": "Cử động tay người thật",
      "voiceover": "Lời thoại cảnh 3 (15-19 từ)."
    },
    {
      "sceneNumber": 4,
      "phase": "Closing",
      "marketingQuestion": "Lý do gì để họ mua ngay?",
      "marketingAnswer": "Nội dung trả lời",
      "visualDescription": "Mô tả hình ảnh",
      "handInteraction": "Cử động tay người thật",
      "voiceover": "Lời thoại cảnh 4 (15-19 từ)."
    }
  ],
  "videoPairs": {
    "video1": {
      "panels": [1, 2],
      "combinedScript": "Lời thoại ghép Cảnh 1 + Cảnh 2 (tối đa 42 từ)",
      "wordCount": 36
    },
    "video2": {
      "panels": [3, 4],
      "combinedScript": "Lời thoại ghép Cảnh 3 + Cảnh 4 (tối đa 42 từ)",
      "wordCount": 36
    }
  }
}
```

### Kết Quả JSON Kịch Bản Thực Tế Của Máy Hút Bụi JETZT X9

```json
{
  "analysis": {
    "productName": "Máy Hút Bụi Cầm Tay Có Dây JETZT X9 3 Trong 1",
    "category": "home",
    "cartAnchorText": "Sắm Jetzt X9 giỏ hàng nhé",
    "hashtags": [
      "#mayhutbui",
      "#jetztx9",
      "#hutbuicamtay",
      "#vesinhnhacua",
      "#dogiadungtiatich"
    ],
    "materials": "Nhựa ABS cao cấp chống va đập, lõi lọc HEPA đa tầng siêu mịn, ống nối kim loại bền bỉ",
    "highlights": [
      "Lực hút mạnh mẽ 19.000Pa cuốn sạch mọi bụi bẩn",
      "Bộ lọc HEPA đa tầng kháng khuẩn khép kín",
      "Trọng lượng siêu nhẹ chỉ 1.8kg thao tác một tay"
    ],
    "targetAudience": "Các gia đình trẻ, người nuôi thú cưng, mẹ bỉm sữa cần dọn dẹp nhà cửa nhanh gọn",
    "fourAnswers": {
      "hook": "Đánh vào nỗi ám ảnh lông thú cưng và tóc rụng vương vãi khắp sàn nhà, quét chổi càng bay tứ tung.",
      "solution": "Máy hút bụi Jetzt X9 sở hữu lực hút 19000Pa cuốn sạch mọi bụi bẩn chỉ trong một lần lướt nhẹ.",
      "proof": "Thực tế máy nặng chỉ 1.8kg thao tác một tay nhẹ nhàng, kết hợp bộ lọc HEPA khóa chặt bụi mịn.",
      "closing": "Cam kết bảo hành chính hãng 12 tháng, giải pháp tối ưu cho không gian sống sạch bong thoáng mát."
    }
  },
  "voicePersona": {
    "gender": "nu",
    "voiceDescription": "nữ miền Nam ngọt ngào tự nhiên",
    "tone": "thân thiện, duyên dáng, cuốn hút, review chân thực"
  },
  "sceneContext": {
    "location": "Phòng khách căn hộ chung cư phong cách Scandinavian ấm cúng, sàn gỗ sáng màu sạch sẽ",
    "lighting": "ánh sáng tự nhiên dịu nhẹ ban ngày kết hợp đèn ấm",
    "mood": "aesthetic, hiện đại, 100% chân thực"
  },
  "scenes": [
    {
      "sceneNumber": 1,
      "phase": "Hook",
      "marketingQuestion": "Hook gì để họ dừng lướt?",
      "marketingAnswer": "Đánh vào nỗi ám ảnh lông thú cưng và tóc rụng vương vãi khắp sàn nhà, quét chổi càng bay tứ tung.",
      "visualDescription": "Cận cảnh sàn gỗ vương vãi lông mèo và bụi mịn, người phụ nữ thở dài cúi xuống quét.",
      "handInteraction": "Bàn tay nhặt cụm tóc vương vãi trên sàn nhà thể hiện sự bất tiện.",
      "voiceover": "Bạn có mệt mỏi khi ngày nào cũng phải quét sàn đầy tóc rụng và lông thú cưng không?"
    },
    {
      "sceneNumber": 2,
      "phase": "Solution",
      "marketingQuestion": "Sản phẩm là giải pháp gì?",
      "marketingAnswer": "Máy hút bụi Jetzt X9 sở hữu lực hút 19000Pa cuốn sạch mọi bụi bẩn chỉ trong một lần lướt nhẹ.",
      "visualDescription": "Người dùng cầm Jetzt X9 đẩy nhẹ một đường dứt khoát cuốn sạch đường bụi trên sàn.",
      "handInteraction": "Bàn tay đẩy máy hút bụi lướt qua dải bụi trên sàn nhà gỗ.",
      "voiceover": "Đã có Jetzt X9 với lực hút 19.000Pa, lướt tới đâu là sàn nhà sạch bóng tới đó."
    },
    {
      "sceneNumber": 3,
      "phase": "Proof",
      "marketingQuestion": "Bằng chứng nào khiến họ tin?",
      "marketingAnswer": "Thực tế máy nặng chỉ 1.8kg thao tác một tay nhẹ nhàng, kết hợp bộ lọc HEPA khóa chặt bụi mịn.",
      "visualDescription": "Cận cảnh bàn tay nâng máy nhẹ nhàng bằng một tay và tháo hộp bụi trong suốt chứa đầy bụi.",
      "handInteraction": "Bàn tay tháo khớp nối hộp bụi và chỉ vào màng lọc HEPA trắng tinh tế.",
      "voiceover": "Thân máy siêu nhẹ 1.8kg kèm bộ lọc HEPA khép kín, giữ sạch bụi mịn mà không bay ngược."
    },
    {
      "sceneNumber": 4,
      "phase": "Closing",
      "marketingQuestion": "Lý do gì để họ mua ngay?",
      "marketingAnswer": "Cam kết bảo hành chính hãng 12 tháng, giải pháp tối ưu cho không gian sống sạch bong thoáng mát.",
      "visualDescription": "Toàn cảnh phòng khách sáng sủa, người phụ nữ mỉm cười đặt máy gọn gàng cạnh góc tường.",
      "handInteraction": "Bàn tay cuộn gọn dây điện 4.5m gài ngay ngắn vào thân máy.",
      "voiceover": "Máy chính hãng bảo hành 12 tháng, rinh ngay ở giỏ hàng góc trái để thảnh thơi dọn nhà nhé!"
    }
  ],
  "videoPairs": {
    "video1": {
      "panels": [1, 2],
      "combinedScript": "Bạn có mệt mỏi khi ngày nào cũng phải quét sàn đầy tóc rụng và lông thú cưng không? Đã có Jetzt X9 với lực hút 19.000Pa, lướt tới đâu là sàn nhà sạch bóng tới đó.",
      "wordCount": 36
    },
    "video2": {
      "panels": [3, 4],
      "combinedScript": "Thân máy siêu nhẹ 1.8kg kèm bộ lọc HEPA khép kín, giữ sạch bụi mịn mà không bay ngược. Máy chính hãng bảo hành 12 tháng, rinh ngay ở giỏ hàng góc trái để thảnh thơi dọn nhà nhé!",
      "wordCount": 36
    }
  }
}
```

---

## 4. Prompt Giai Đoạn 2: Tạo Master Storyboard 16:9 Trên Google Flow

### Bản A: Không Chữ (No Text Mode - `/template5_1` & `/template5_2`)
> Đây là phiên bản được khuyên dùng nhất vì hình ảnh thuần khiết, chân thực như ảnh chụp điện thoại thật, sau đó dùng giọng đọc lồng tiếng (Voice-over) truyền tải thông tin.

#### 1. Template Tổng Quát
```text
Generate one product review storyboard image (still photo collage, NOT a video) from the uploaded product reference images for ${productName}.

CRITICAL VISUAL DIRECTION — 100% SMARTPHONE REALISM (CHUẨN CAMERA THỰC TẾ, KHÔNG ẢO CGI):
- Aesthetics: Authentic smartphone camera snapshot (iPhone 15 Pro 24mm/26mm lens, f/1.8 auto mode), natural window light, subtle realistic contact shadows, genuine material textures (matte finish, fabric grain, metallic brush or leather texture). Must look 100% real and authentic like a real human photoshoot.
- Hands & Model: Fair Asian skin tone, natural skin pores, knuckle creases, neat manicured nails, anatomically correct hands with 5 fingers, realistic physical grip. Strictly faceless (no visible faces, only hands/limbs/outfit).
- NO CARTOON GRAPHICS: Absolutely NO glowing neon arrows, NO cartoon magnifying glasses, NO floating 3D icons, NO fake fairy sparkles.

Storyboard requirements:
- Exactly 4 panels arranged side by side in one single still image (horizontal 16:9 collage composed of 4 vertical 9:16 frames).
  * Left Half: Panel 1 (Hook) + Panel 2 (Solution)
  * Right Half: Panel 3 (Proof) + Panel 4 (Closing)
- Setting: All 4 panels share the exact same location (${location}) and natural lighting (${lighting}).
- STRICT NO-TEXT RULE (TUYỆT ĐỐI KHÔNG CHỮ / NO TEXT / NO LABELS):
  * Every panel must be 100% pure clean photography without any typography, without any text badges, without any words, without any subtitles, without any labels, and without any watermarks.
  * Pure visual focus on authentic product textures, details, and realistic everyday interaction.
- Output must be a still photograph collage. Do NOT generate or describe a video.

Scene plan:
${scenePlanJson}

Generate one still storyboard image now.
```

#### 2. Prompt Thực Tế Của Máy Hút Bụi JETZT X9 (No Text Mode)
```text
Generate one product review storyboard image (still photo collage, NOT a video) from the uploaded product reference images for Máy Hút Bụi Cầm Tay Có Dây JETZT X9 3 Trong 1.

CRITICAL VISUAL DIRECTION — 100% SMARTPHONE REALISM (CHUẨN CAMERA THỰC TẾ, KHÔNG ẢO CGI):
- Aesthetics: Authentic smartphone camera snapshot (iPhone 15 Pro 24mm/26mm lens, f/1.8 auto mode), natural window light, subtle realistic contact shadows, genuine material textures (matte finish, fabric grain, metallic brush or leather texture). Must look 100% real and authentic like a real human photoshoot.
- Hands & Model: Fair Asian skin tone, natural skin pores, knuckle creases, neat manicured nails, anatomically correct hands with 5 fingers, realistic physical grip. Strictly faceless (no visible faces, only hands/limbs/outfit).
- NO CARTOON GRAPHICS: Absolutely NO glowing neon arrows, NO cartoon magnifying glasses, NO floating 3D icons, NO fake fairy sparkles.

Storyboard requirements:
- Exactly 4 panels arranged side by side in one single still image (horizontal 16:9 collage composed of 4 vertical 9:16 frames).
  * Left Half: Panel 1 (Hook) + Panel 2 (Solution)
  * Right Half: Panel 3 (Proof) + Panel 4 (Closing)
- Setting: All 4 panels share the exact same location (Phòng khách căn hộ chung cư phong cách Scandinavian ấm cúng, sàn gỗ sáng màu sạch sẽ) and natural lighting (ánh sáng tự nhiên dịu nhẹ ban ngày kết hợp đèn ấm).
- STRICT NO-TEXT RULE (TUYỆT ĐỐI KHÔNG CHỮ / NO TEXT / NO LABELS):
  * Every panel must be 100% pure clean photography without any typography, without any text badges, without any words, without any subtitles, without any labels, and without any watermarks.
  * Pure visual focus on authentic product textures, details, and realistic everyday interaction.
- Output must be a still photograph collage. Do NOT generate or describe a video.

Scene plan:
{
  "productName": "Máy Hút Bụi Cầm Tay Có Dây JETZT X9 3 Trong 1",
  "category": "home",
  "sceneContext": {
    "location": "Phòng khách căn hộ chung cư phong cách Scandinavian ấm cúng, sàn gỗ sáng màu sạch sẽ",
    "lighting": "ánh sáng tự nhiên dịu nhẹ ban ngày kết hợp đèn ấm",
    "mood": "aesthetic, hiện đại, 100% chân thực"
  },
  "leftHalfComposition": {
    "description": "Left half of storyboard (Panels 1 & 2 side-by-side) - will be sliced directly into Image 1 for Video 1",
    "panel1": {
      "id": 1,
      "phase": "Hook",
      "marketingQuestion": "Hook gì để họ dừng lướt?",
      "marketingAnswer": "Đánh vào nỗi ám ảnh lông thú cưng và tóc rụng vương vãi khắp sàn nhà, quét chổi càng bay tứ tung.",
      "visualDescription": "Cận cảnh sàn gỗ vương vãi lông mèo và bụi mịn, người phụ nữ thở dài cúi xuống quét.",
      "handInteraction": "Bàn tay nhặt cụm tóc vương vãi trên sàn nhà thể hiện sự bất tiện."
    },
    "panel2": {
      "id": 2,
      "phase": "Solution",
      "marketingQuestion": "Sản phẩm là giải pháp gì?",
      "marketingAnswer": "Máy hút bụi Jetzt X9 sở hữu lực hút 19000Pa cuốn sạch mọi bụi bẩn chỉ trong một lần lướt nhẹ.",
      "visualDescription": "Người dùng cầm Jetzt X9 đẩy nhẹ một đường dứt khoát cuốn sạch đường bụi trên sàn.",
      "handInteraction": "Bàn tay đẩy máy hút bụi lướt qua dải bụi trên sàn nhà gỗ."
    }
  },
  "rightHalfComposition": {
    "description": "Right half of storyboard (Panels 3 & 4 side-by-side) - will be sliced directly into Image 2 for Video 2",
    "panel3": {
      "id": 3,
      "phase": "Proof",
      "marketingQuestion": "Bằng chứng nào khiến họ tin?",
      "marketingAnswer": "Thực tế máy nặng chỉ 1.8kg thao tác một tay nhẹ nhàng, kết hợp bộ lọc HEPA khóa chặt bụi mịn.",
      "visualDescription": "Cận cảnh bàn tay nâng máy nhẹ nhàng bằng một tay và tháo hộp bụi trong suốt chứa đầy bụi.",
      "handInteraction": "Bàn tay tháo khớp nối hộp bụi và chỉ vào màng lọc HEPA trắng tinh tế."
    },
    "panel4": {
      "id": 4,
      "phase": "Closing / CTA",
      "marketingQuestion": "Lý do gì để họ mua ngay?",
      "marketingAnswer": "Cam kết bảo hành chính hãng 12 tháng, giải pháp tối ưu cho không gian sống sạch bong thoáng mát.",
      "visualDescription": "Toàn cảnh phòng khách sáng sủa, người phụ nữ mỉm cười đặt máy gọn gàng cạnh góc tường.",
      "handInteraction": "Bàn tay cuộn gọn dây điện 4.5m gài ngay ngắn vào thân máy."
    }
  }
}

Generate one still storyboard image now.
```

---

### Bản B: Có Chữ Tiếng Việt (With Text Badges - `/template5`)
> Phiên bản này sinh kèm 1 thẻ badge phụ đề bo góc nhỏ gọn tinh tế ở vị trí an toàn (18% dưới mép trên của mỗi panel).

#### Template Tổng Quát
```text
Generate one product review storyboard image (still photo collage, NOT a video) from the uploaded product reference images for ${productName}.

CRITICAL VISUAL DIRECTION — 100% SMARTPHONE REALISM (CHUẨN CAMERA THỰC TẾ, KHÔNG ẢO CGI):
- Authentic smartphone camera snapshot (iPhone 15 Pro 24mm lens), natural window daylight, subtle realistic contact shadows, genuine material textures.
- Hands & Model: Fair Asian skin tone, neat manicured nails, anatomically correct hands. Strictly faceless.
- Absolutely NO glowing neon arrows, NO cartoon magnifying glasses, NO floating 3D icons.

Storyboard requirements:
- Exactly 4 panels arranged side by side in one single still image (horizontal 16:9 collage composed of 4 vertical 9:16 frames).
  * Left Half: Panel 1 (Hook) + Panel 2 (Solution)
  * Right Half: Panel 3 (Proof) + Panel 4 (Closing)
- Setting: All 4 panels share the exact same location (${location}) and natural lighting (${lighting}).
- Sequence & Single Caption Badges:
  Panel 1: Render a single small rounded caption badge (placed 18% below top edge) containing: "${headline1}" and "${subtext1}".
  Panel 2: Render a single small rounded caption badge (placed 18% below top edge) containing: "${headline2}" and "${subtext2}".
  Panel 3: Render a single small rounded caption badge (placed 18% below top edge) containing: "${headline3}" and "${subtext3}".
  Panel 4: Render a single small rounded caption badge (placed 18% below top edge) containing: "${headline4}" and "${subtext4}".
- Typography Rules & Safe Margin (Cỡ chữ nhỏ gọn, an toàn viền, không vẽ chữ rác):
  * EXACTLY ONE SINGLE COMPACT BADGE PER PANEL: Render only ONE small, elegant, semi-transparent rounded pill card in the upper safe area.
  * POSITION: Leave at least 18% empty margin from top edge. Leave at least 15% margin from left and right borders.
  * Clean minimalist modern sans-serif font with 100% ACCURATE VIETNAMESE DIACRITICS (đúng chính tả tiếng Việt có dấu).
  * STRICT NEGATIVE RULE: Absolutely NO other text or floating letters anywhere in the background.
- Output must be a still photograph collage. Do NOT generate or describe a video.

Generate one still storyboard image now.
```

---

## 5. Prompt Giai Đoạn 3: Sinh 2 Video 8 Giây Đa Ảnh Trên Google Flow (Model `abra_r2v_8s`)

### Cơ Chế 4 Ảnh Tham Chiếu & Khung Viền 12% Cố Định
Mỗi video được sinh bằng cách đính kèm đồng thời **4 hình ảnh**:
1. **Ảnh 1**: Cắt từ nửa tương ứng của Master Storyboard (hoặc ảnh đơn lẻ panel).
2. **Ảnh 2**: Panel tiếp theo tương ứng.
3. **Ảnh 3**: Toàn bộ Master Storyboard 16:9 (làm mỏ neo đối chiếu không gian tổng thể).
4. **Ảnh 4**: Ảnh Input Collage sản phẩm thực tế (đảm bảo AI giữ đúng màu sắc, thiết kế, đầu hút của JETZT X9).

Đồng thời, video có chỉ thị **`SOLID WHITE BORDER PADDING: 12%`** để giữ viền trắng tĩnh cố định và nội dung video bên trong liền mạch tuyệt đối.

---

### Video 1 (8s: Cảnh 1 & Cảnh 2) - Template & Prompt Thực Tế

#### 1. Template
```text
Tạo video review ${productName} faceless dài đúng 8 giây từ 4 hình ảnh đã cung cấp (gồm Panel 1: Cảnh 1, Panel 2: Cảnh 2, Master Storyboard toàn bộ 4 cảnh, và hình ảnh Input sản phẩm thực tế). KHUNG VIỀN TRẮNG CỐ ĐỊNH (SOLID WHITE BORDER PADDING): Toàn bộ video được bao bọc bởi một khung viền màu trắng tĩnh cố định dày chính xác 12% ở mỗi cạnh: cạnh trên dày 12%, cạnh dưới dày 12%, cạnh trái dày 12%, cạnh phải dày 12% (solid white border frame: 12% top, 12% bottom, 12% left, 12% right padding). Toàn bộ nội dung chuyển động và hình ảnh video chỉ hiển thị chính xác bên trong khung viền trắng này (video content strictly rendered inside the white frame), tuyệt đối không tràn ra ngoài viền trắng, và bên trong nội dung video hoàn toàn liền mạch không có bất kỳ vạch kẻ hay viền trắng nào chia cắt (seamless continuous content, no internal dividers, no vertical split lines). CHUYỂN ĐỘNG THEO THỜI GIAN VÀ CẢNH QUAY: 4 giây đầu (0s-4s) bắt đầu chính xác từ hình ảnh Panel 1 (Cảnh 1: Hook), camera giữ góc quay cận cảnh ổn định bên trong khung hình Cảnh 1, bàn tay người thao tác thực tế ${vfx1} ${desc1}; tại mốc 4 giây chuyển cảnh dứt khoát (clean cut transition) sang 4 giây sau (4s-8s) bắt đầu chính xác từ hình ảnh Panel 2 (Cảnh 2: Solution), tiếp tục góc quay đặc tả công năng và chi tiết sản phẩm bên trong khung hình Cảnh 2 ${vfx2} ${desc2}. THAM CHIẾU HÌNH ẢNH VÀ ĐỘ CHÍNH XÁC SẢN PHẨM: Toàn bộ video phải đối chiếu và tham chiếu chặt chẽ với hình ảnh Master Storyboard và hình ảnh Input sản phẩm thực tế đã cung cấp để đảm bảo tính đúng đắn, nhất quán 100% về ngoại quan, kiểu dáng, cấu tạo, chất liệu, màu sắc và chi tiết sản phẩm. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI. Giọng đọc review: ${voiceDesc}, phong cách TikTok review cuốn hút, tốc độ đọc NHANH liên tục dồn dập không ngừng nghỉ để truyền tải trọn vẹn thông tin. Lời thoại nhân vật đọc liên tục trong 8 giây (tối đa 42 từ): "${video1Script}". Cảnh quay tự nhiên 100% như quay bằng camera điện thoại iPhone 15 Pro, ánh sáng ban ngày tự nhiên từ cửa sổ, đổ bóng tiếp xúc chân thực, bề mặt sản phẩm lì có vân chất liệu, không hiệu ứng bokeh giả, không ánh sáng studio nhân tạo, không nhựa bóng kiểu AI, không hiệu ứng ảo CGI.
```

#### 2. Prompt Thực Tế Của Máy Hút Bụi JETZT X9 (Video 1)
```text
Tạo video review Máy Hút Bụi Cầm Tay Có Dây JETZT X9 3 Trong 1 faceless dài đúng 8 giây từ 4 hình ảnh đã cung cấp (gồm Panel 1: Cảnh 1, Panel 2: Cảnh 2, Master Storyboard toàn bộ 4 cảnh, và hình ảnh Input sản phẩm thực tế). KHUNG VIỀN TRẮNG CỐ ĐỊNH (SOLID WHITE BORDER PADDING): Toàn bộ video được bao bọc bởi một khung viền màu trắng tĩnh cố định dày chính xác 12% ở mỗi cạnh: cạnh trên dày 12%, cạnh dưới dày 12%, cạnh trái dày 12%, cạnh phải dày 12% (solid white border frame: 12% top, 12% bottom, 12% left, 12% right padding). Toàn bộ nội dung chuyển động và hình ảnh video chỉ hiển thị chính xác bên trong khung viền trắng này (video content strictly rendered inside the white frame), tuyệt đối không tràn ra ngoài viền trắng, và bên trong nội dung video hoàn toàn liền mạch không có bất kỳ vạch kẻ hay viền trắng nào chia cắt (seamless continuous content, no internal dividers, no vertical split lines). CHUYỂN ĐỘNG THEO THỜI GIAN VÀ CẢNH QUAY: 4 giây đầu (0s-4s) bắt đầu chính xác từ hình ảnh Panel 1 (Cảnh 1: Hook), camera giữ góc quay cận cảnh ổn định bên trong khung hình Cảnh 1, bàn tay người thao tác thực tế Thao tác thực tế: Bàn tay nhặt cụm tóc vương vãi trên sàn nhà thể hiện sự bất tiện.. Cận cảnh sàn gỗ vương vãi lông mèo và bụi mịn, người phụ nữ thở dài cúi xuống quét.; tại mốc 4 giây chuyển cảnh dứt khoát (clean cut transition) sang 4 giây sau (4s-8s) bắt đầu chính xác từ hình ảnh Panel 2 (Cảnh 2: Solution), tiếp tục góc quay đặc tả công năng và chi tiết sản phẩm bên trong khung hình Cảnh 2 Thao tác thực tế: Bàn tay đẩy máy hút bụi lướt qua dải bụi trên sàn nhà gỗ.. Người dùng cầm Jetzt X9 đẩy nhẹ một đường dứt khoát cuốn sạch đường bụi trên sàn.. THAM CHIẾU HÌNH ẢNH VÀ ĐỘ CHÍNH XÁC SẢN PHẨM: Toàn bộ video phải đối chiếu và tham chiếu chặt chẽ với hình ảnh Master Storyboard và hình ảnh Input sản phẩm thực tế đã cung cấp để đảm bảo tính đúng đắn, nhất quán 100% về ngoại quan, kiểu dáng, cấu tạo, chất liệu, màu sắc và chi tiết sản phẩm. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI. Giọng đọc review: nữ miền Nam ngọt ngào tự nhiên, phong cách TikTok review cuốn hút, tốc độ đọc NHANH liên tục dồn dập không ngừng nghỉ để truyền tải trọn vẹn thông tin. Lời thoại nhân vật đọc liên tục trong 8 giây (tối đa 42 từ): "Bạn có mệt mỏi khi ngày nào cũng phải quét sàn đầy tóc rụng và lông thú cưng không? Đã có Jetzt X9 với lực hút 19.000Pa, lướt tới đâu là sàn nhà sạch bóng tới đó.". Cảnh quay tự nhiên 100% như quay bằng camera điện thoại iPhone 15 Pro, ánh sáng ban ngày tự nhiên từ cửa sổ, đổ bóng tiếp xúc chân thực, bề mặt sản phẩm lì có vân chất liệu, không hiệu ứng bokeh giả, không ánh sáng studio nhân tạo, không nhựa bóng kiểu AI, không hiệu ứng ảo CGI.
```

---

### Video 2 (8s: Cảnh 3 & Cảnh 4) - Template & Prompt Thực Tế

#### 1. Template
```text
Tạo video review ${productName} faceless dài đúng 8 giây từ 4 hình ảnh đã cung cấp (gồm Panel 3: Cảnh 3, Panel 4: Cảnh 4, Master Storyboard toàn bộ 4 cảnh, và hình ảnh Input sản phẩm thực tế). KHUNG VIỀN TRẮNG CỐ ĐỊNH (SOLID WHITE BORDER PADDING): Toàn bộ video được bao bọc bởi một khung viền màu trắng tĩnh cố định dày chính xác 12% ở mỗi cạnh: cạnh trên dày 12%, cạnh dưới dày 12%, cạnh trái dày 12%, cạnh phải dày 12% (solid white border frame: 12% top, 12% bottom, 12% left, 12% right padding). Toàn bộ nội dung chuyển động và hình ảnh video chỉ hiển thị chính xác bên trong khung viền trắng này (video content strictly rendered inside the white frame), tuyệt đối không tràn ra ngoài viền trắng, và bên trong nội dung video hoàn toàn liền mạch không có bất kỳ vạch kẻ hay viền trắng nào chia cắt (seamless continuous content, no internal dividers, no vertical split lines). CHUYỂN ĐỘNG THEO THỜI GIAN VÀ CẢNH QUAY: 4 giây đầu (0s-4s) bắt đầu chính xác từ hình ảnh Panel 3 (Cảnh 3: Proof), camera giữ góc quay cận cảnh đặc tả chất liệu, cấu tạo tinh xảo bên trong khung hình Cảnh 3, bàn tay người thao tác kiểm tra thực tế ${vfx3} ${desc3}; tại mốc 4 giây chuyển cảnh dứt khoát (clean cut transition) sang 4 giây sau (4s-8s) bắt đầu chính xác từ hình ảnh Panel 4 (Cảnh 4: Closing), mở rộng góc quay tôn vinh sản phẩm trong không gian phong cách sống hoàn thiện bên trong khung hình Cảnh 4 ${vfx4} ${desc4}. THAM CHIẾU HÌNH ẢNH VÀ ĐỘ CHÍNH XÁC SẢN PHẨM: Toàn bộ video phải đối chiếu và tham chiếu chặt chẽ với hình ảnh Master Storyboard và hình ảnh Input sản phẩm thực tế đã cung cấp để đảm bảo tính đúng đắn, nhất quán 100% về ngoại quan, kiểu dáng, cấu tạo, chất liệu, màu sắc và chi tiết sản phẩm. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI. Giọng đọc review: ${voiceDesc}, phong cách TikTok review cuốn hút, tốc độ đọc NHANH liên tục dồn dập không ngừng nghỉ để truyền tải trọn vẹn thông tin. Lời thoại nhân vật đọc liên tục trong 8 giây (tối đa 42 từ): "${video2Script}". Cảnh quay tự nhiên 100% như quay bằng camera điện thoại iPhone 15 Pro, ánh sáng ban ngày tự nhiên từ cửa sổ, đổ bóng tiếp xúc chân thực, bề mặt sản phẩm lì có vân chất liệu, không hiệu ứng bokeh giả, không ánh sáng studio nhân tạo, không nhựa bóng kiểu AI, không hiệu ứng ảo CGI.
```

#### 2. Prompt Thực Tế Của Máy Hút Bụi JETZT X9 (Video 2)
```text
Tạo video review Máy Hút Bụi Cầm Tay Có Dây JETZT X9 3 Trong 1 faceless dài đúng 8 giây từ 4 hình ảnh đã cung cấp (gồm Panel 3: Cảnh 3, Panel 4: Cảnh 4, Master Storyboard toàn bộ 4 cảnh, và hình ảnh Input sản phẩm thực tế). KHUNG VIỀN TRẮNG CỐ ĐỊNH (SOLID WHITE BORDER PADDING): Toàn bộ video được bao bọc bởi một khung viền màu trắng tĩnh cố định dày chính xác 12% ở mỗi cạnh: cạnh trên dày 12%, cạnh dưới dày 12%, cạnh trái dày 12%, cạnh phải dày 12% (solid white border frame: 12% top, 12% bottom, 12% left, 12% right padding). Toàn bộ nội dung chuyển động và hình ảnh video chỉ hiển thị chính xác bên trong khung viền trắng này (video content strictly rendered inside the white frame), tuyệt đối không tràn ra ngoài viền trắng, và bên trong nội dung video hoàn toàn liền mạch không có bất kỳ vạch kẻ hay viền trắng nào chia cắt (seamless continuous content, no internal dividers, no vertical split lines). CHUYỂN ĐỘNG THEO THỜI GIAN VÀ CẢNH QUAY: 4 giây đầu (0s-4s) bắt đầu chính xác từ hình ảnh Panel 3 (Cảnh 3: Proof), camera giữ góc quay cận cảnh đặc tả chất liệu, cấu tạo tinh xảo bên trong khung hình Cảnh 3, bàn tay người thao tác kiểm tra thực tế Thao tác thực tế: Bàn tay tháo khớp nối hộp bụi và chỉ vào màng lọc HEPA trắng tinh tế.. Cận cảnh bàn tay nâng máy nhẹ nhàng bằng một tay và tháo hộp bụi trong suốt chứa đầy bụi.; tại mốc 4 giây chuyển cảnh dứt khoát (clean cut transition) sang 4 giây sau (4s-8s) bắt đầu chính xác từ hình ảnh Panel 4 (Cảnh 4: Closing), mở rộng góc quay tôn vinh sản phẩm trong không gian phong cách sống hoàn thiện bên trong khung hình Cảnh 4 Thao tác thực tế: Bàn tay cuộn gọn dây điện 4.5m gài ngay ngắn vào thân máy.. Toàn cảnh phòng khách sáng sủa, người phụ nữ mỉm cười đặt máy gọn gàng cạnh góc tường.. THAM CHIẾU HÌNH ẢNH VÀ ĐỘ CHÍNH XÁC SẢN PHẨM: Toàn bộ video phải đối chiếu và tham chiếu chặt chẽ với hình ảnh Master Storyboard và hình ảnh Input sản phẩm thực tế đã cung cấp để đảm bảo tính đúng đắn, nhất quán 100% về ngoại quan, kiểu dáng, cấu tạo, chất liệu, màu sắc và chi tiết sản phẩm. GIỮ NGUYÊN TOÀN BỘ HÌNH ẢNH GỐC, BỐ CỤC, MÀU SẮC VÀ CÁC CHI TIẾT TRÊN ẢNH. TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ, TIÊU ĐỀ, PHỤ ĐỀ, LOGO, BIỂU TƯỢNG HOẶC OVERLAY NÀO MỚI (STRICTLY NO NEW TEXT, NO CAPTIONS, NO OVERLAYS, NO CARTOON GRAPHICS). TUYỆT ĐỐI FACELESS: CHỈ CÓ GIỌNG NÓI VOICE-OVER, TUYỆT ĐỐI KHÔNG QUAY MẶT NGƯỜI. Giọng đọc review: nữ miền Nam ngọt ngào tự nhiên, phong cách TikTok review cuốn hút, tốc độ đọc NHANH liên tục dồn dập không ngừng nghỉ để truyền tải trọn vẹn thông tin. Lời thoại nhân vật đọc liên tục trong 8 giây (tối đa 42 từ): "Thân máy siêu nhẹ 1.8kg kèm bộ lọc HEPA khép kín, giữ sạch bụi mịn mà không bay ngược. Máy chính hãng bảo hành 12 tháng, rinh ngay ở giỏ hàng góc trái để thảnh thơi dọn nhà nhé!". Cảnh quay tự nhiên 100% như quay bằng camera điện thoại iPhone 15 Pro, ánh sáng ban ngày tự nhiên từ cửa sổ, đổ bóng tiếp xúc chân thực, bề mặt sản phẩm lì có vân chất liệu, không hiệu ứng bokeh giả, không ánh sáng studio nhân tạo, không nhựa bóng kiểu AI, không hiệu ứng ảo CGI.
```

---

## 6. Tài Nguyên & Đường Dẫn File Của Phiên Chạy Thực Tế

Toàn bộ tài nguyên sinh tự động của sản phẩm này được lưu trữ tập trung tại:
`playwright-service/storyboard-review-runs/2026-09-06T07-43-41-084Z-template5_2-flow-l2pclf/`

* **Ảnh tổng hợp tham chiếu đầu vào (Input Collage)**:
  `playwright-service/storyboard-review-runs/2026-09-06T07-43-41-084Z-template5_2-flow-l2pclf/input.png`
* **Ảnh Master Storyboard 16:9 hoàn chỉnh**:
  `playwright-service/storyboard-review-runs/2026-09-06T07-43-41-084Z-template5_2-flow-l2pclf/storyboard.png`
* **4 Panel cắt dọc 9:16 chuẩn**:
  * Panel 1: `.../panels/panel1.png`
  * Panel 2: `.../panels/panel2.png`
  * Panel 3: `.../panels/panel3.png`
  * Panel 4: `.../panels/panel4.png`
* **File nhật ký prompt chạy**:
  `playwright-service/storyboard-review-runs/2026-09-06T07-43-41-084Z-template5_2-flow-l2pclf/prompts.md`
