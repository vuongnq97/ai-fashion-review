# TEMPLATE 5.1 — Clean Review Đa Ngành Hàng (KHÔNG CHỮ / NO TEXT)

## 1. Tổng quan
- **Lệnh kích hoạt**: `/template5_1` (hoặc `/template5.1`, `/template51`).
- **Đặc trưng**: Tương tự Template 5 về quy trình tự động phân tích mọi ngành hàng (Thời trang, Mỹ phẩm, Gia dụng, Thiết bị gia đình...), nhưng **toàn bộ Master Storyboard, 4 Panel 9:16 và 4 Video 6s sinh ra đều 100% sạch, KHÔNG CHỨA BẤT KỲ CHỮ / TEXT NÀO**.
- **Độ dài**: 4 cảnh x 6 giây = 24 giây tổng thể.
- **Phong cách**: Faceless, camera smartphone thực tế (iPhone 15 Pro 24mm), ánh sáng tự nhiên, hành động tương tác vật lý chân thực, không tiếng review/voice-over.

---

## 2. Quy trình xử lý
1. **Phân tích sản phẩm (Gemini API)**: Tự động trích xuất tên sản phẩm, danh mục, bối cảnh nội thất/không gian sống và thao tác sử dụng thực tế.
2. **Master Storyboard 16:9 (Gemini API)**: Sinh ảnh collage 4 cảnh hoàn toàn không có chữ, nhãn, subtitle, badge hay watermark.
3. **4 Panel 9:16 (Gemini API)**: Tách 4 khung hình dọc độ nét cao, 100% pure photography.
4. **4 Video 6s (Google Flow Veo 3)**: Animate chuyển động camera và thao tác thực tế mượt mà, nghiêm cấm sinh chữ/phụ đề.
5. **Tạo lại linh hoạt với `/again`**: Hỗ trợ `/again <số_cảnh> [yêu cầu]` giữ nguyên phong cách no-text.
