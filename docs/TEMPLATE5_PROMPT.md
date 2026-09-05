# ✨ Template 5: Review Đa Ngành Hàng 4 Cảnh (2 Video 8 Giây)

## 1. Tổng quan & Thiết lập
- **Mục đích**: Review chuyên nghiệp, sinh động cho **bất kỳ sản phẩm nào** (Thời trang, Quần áo, Túi xách, Giày dép, Mỹ phẩm / Skincare, Đồ gia dụng / Nhà bếp, Thiết bị công nghệ, Phụ kiện...).
- **Không dùng ảnh ref tĩnh**: Hệ thống tự động phân tích sản phẩm và sáng tạo bối cảnh sống động (phòng khách, bàn trang điểm, góc bếp, bàn làm việc, boutique, quán cafe) tối ưu nhất cho sản phẩm đó.
- **Thời lượng video**: **2 video x 8 giây** (mỗi video ghép 2 cảnh: 0s-4s cảnh 1/3, 4s-8s cảnh 2/4). Dùng model `abra_i2v_8s` sinh video từ 2 panel ảnh full viền.
- **3 Biến thể linh hoạt**:
  * `/template5`: **Có chữ** tiếng Việt hiển thị trên panel và video chuyển cảnh theo thời gian (4s đầu dùng chữ Cảnh 1/3, 4s sau dùng chữ Cảnh 2/4), **không voice** (ghép nhạc trend).
  * `/template5_1`: **Không chữ** (No Text), **không voice** (ghép nhạc trend).
  * `/template5_2`: **Không chữ** (No Text), **có giọng lồng tiếng review AI** tiếng Việt faceless (tối đa 42 từ).

---

## 2. Luồng Xử Lý 4 Cảnh (Choreography & Cấu Trúc)

### 📸 Video 1 (8s, sinh từ Panel 1 = Cảnh 1 [Hook] + Cảnh 2 [Giải pháp]):
- **0s-4s (Cảnh 1 - Hook)**: Khung bên trái. Cận cảnh sản phẩm và thao tác thực tế. Nếu dùng `/template5` thì hiển thị chữ Cảnh 1.
- **4s-8s (Cảnh 2 - Giải pháp)**: Khung bên phải. Chuyển cảnh dứt khoát (clean cut) tại mốc 4s sang đặc tả công năng chi tiết. Nếu dùng `/template5` thì chuyển sang hiển thị chữ Cảnh 2.

### 📸 Video 2 (8s, sinh từ Panel 2 = Cảnh 3 [Bằng chứng] + Cảnh 4 [Chốt đơn]):
- **0s-4s (Cảnh 3 - Bằng chứng)**: Khung bên trái. Cận cảnh chất liệu, độ bền và hoàn thiện. Nếu dùng `/template5` thì hiển thị chữ Cảnh 3.
- **4s-8s (Cảnh 4 - Chốt đơn / CTA)**: Khung bên phải. Chuyển cảnh dứt khoát tại mốc 4s tôn vinh sản phẩm trong không gian sống. Nếu dùng `/template5` thì chuyển sang hiển thị chữ Cảnh 4.

---

## 3. Hướng Dẫn Sử Dụng Qua Telegram Bot

1. **Khởi động**:
   - Gõ `/template5` (có chữ, không voice)
   - Hoặc gõ `/template5_1` (không chữ, không voice)
   - Hoặc gõ `/template5_2` (không chữ, có voice review 42 từ)
2. **Gửi link TikTok Shop**:
   - Gửi shortlink (vd: `https://vt.tiktok.com/...`).
   - Hệ thống tự động phân tích $\rightarrow$ Tạo Master Storyboard 16:9 $\rightarrow$ Tách 2 panel full viền $\rightarrow$ Tạo 2 video 8s bằng Abra i2v $\rightarrow$ Auto-crop 12% loại bỏ viền trắng & xóa logo $\rightarrow$ Gửi video về Telegram.
3. **Tạo lại video chưa ưng ý**:
   - Gõ `/remake_1` (hoặc `/remake 1` kèm yêu cầu tùy chỉnh nếu muốn)
   - Gõ `/remake_2` (hoặc `/remake 2` kèm yêu cầu tùy chỉnh nếu muốn)
4. **Đăng lên TikTok**:
   - Gõ `/upload` để ghép hoàn chỉnh và đăng lên TikTok.

---

## 4. Cấu Trúc Script & Quy Tắc Viền Trắng Cho Template 5.1 & 5.2

### 🎙️ Quy Tắc Lời Thoại (Voice-over Script): Tối Đa 42 Từ Mỗi Video 8s
1. **Thời lượng**: 2 video, mỗi video dài đúng **8 giây** chứa **2 cảnh** (Video 1: Cảnh 1 & Cảnh 2; Video 2: Cảnh 3 & Cảnh 4).
2. **Số lượng từ**:
   - Mỗi cảnh dài từ **15 đến 19 từ** tiếng Việt chuẩn có dấu 100%.
   - **TỔNG LỜI THOẠI CỦA MỖI VIDEO 8S TỐI ĐA 42 TỪ** (Cảnh 1 + Cảnh 2 $\le$ 42 từ; Cảnh 3 + Cảnh 4 $\le$ 42 từ).
   - **Đầy đủ ý câu, không cắt ngang**: Mỗi cảnh hoặc chuỗi thoại phải là câu văn hoàn chỉnh có đầy đủ chủ ngữ - vị ngữ và kết thúc bằng dấu chấm câu (. ! ?), tuyệt đối không viết dở dang hoặc bị cắt cụt giữa chừng.
   - Tốc độ đọc nhanh, dồn dập, tự tin, cuốn hút theo phong cách review TikTok viral.
3. **Quy tắc giá tiền**: Tuyệt đối **KHÔNG** sử dụng con số giá tiền cụ thể ("99k", "199.000đ") hoặc "% giảm giá" để video có giá trị lâu dài (evergreen).

### 🖼️ Quy Tắc Viền Trắng Đầy Đủ & Cố Định (White Borders & Prompt Rules)
1. **Hình Panel 2 cảnh Full Viền (Borderless Panels)**:
   - Master Storyboard 16:9 được tách thành 2 hình Panel (Hình 1 = Cảnh 1 + Cảnh 2; Hình 2 = Cảnh 3 + Cảnh 4).
   - Tách thẳng full viền (borderless), **tuyệt đối không thêm bất kỳ viền trắng nào trong panel ảnh** (không có viền ngoài và không có vạch trắng ở giữa 2 cảnh).
2. **Chỉ dẫn khung viền trắng chi tiết trong Video Prompt gửi Flow / Abra i2v**:
   - Prompt mô tả chi tiết độ dày viền trắng cho từng cạnh:
     * *KHUNG VIỀN TRẮNG CỐ ĐỊNH (SOLID WHITE BORDER PADDING): Toàn bộ video được bao bọc bởi một khung viền màu trắng tĩnh cố định dày chính xác 12% ở mỗi cạnh: cạnh trên dày 12%, cạnh dưới dày 12%, cạnh trái dày 12%, cạnh phải dày 12% (solid white border frame: 12% top, 12% bottom, 12% left, 12% right padding).*
     * *Toàn bộ nội dung chuyển động và hình ảnh video chỉ hiển thị chính xác bên trong khung viền trắng này (video content strictly rendered inside the white frame), tuyệt đối không tràn ra ngoài viền trắng, và bên trong nội dung video hoàn toàn liền mạch không có bất kỳ vạch kẻ hay viền trắng nào chia cắt (seamless continuous content, no internal dividers, no vertical split lines).*
3. **Chuyển cảnh dứt khoát tại mốc 4s (Clean Cut Transition)**:
   - Từ 0s-4s: Cảnh trước diễn ra ổn định bên trong khung hình bên trái.
   - Tại mốc 4 giây: Chuyển cảnh dứt khoát (clean cut transition) sang Cảnh sau ở khung hình bên phải (không lia máy quét ngang).
4. **Xử lý hậu kỳ (Post-Processing Auto-Crop 12%)**:
   - Video sau khi sinh sẽ tự động crop 12% (`cropPercent: 0.12`) và scale về 1080x1920 (9:16).
   - Loại bỏ sạch 12% khung viền trắng ngoài cùng do AI vẽ ra + xóa sạch 100% logo ngôi sao Gemini ở góc dưới bên phải, trả về video 9:16 nguyên bản với nội dung tràn viền hoàn hảo.

---

## 5. Khung 4 Câu Hỏi Marketing Cốt Lõi

| Cảnh | Câu hỏi | Triển khai thực tế |
|---|---|---|
| **1. Hook** | *Hook gì để họ dừng lướt?* | Nêu nỗi đau chai cũ/bất tiện, gây tò mò, cảnh báo hoặc so sánh trực quan. |
| **2. Giải pháp** | *Sản phẩm là giải pháp gì?* | Giới thiệu tên sản phẩm, công năng chính, cơ chế thông minh, tính tiện lợi. |
| **3. Bằng chứng** | *Bằng chứng nào khiến họ tin?* | Demo thực tế dốc ngược không rò rỉ, chất liệu cao cấp, gia công tỉ mỉ, độ bền. |
| **4. Chốt đơn** | *Lý do gì để họ mua ngay?* | Đổi trả uy tín 7 ngày, nâng tầm không gian sống, CTA dứt khoát bấm vào giỏ hàng góc trái. |

