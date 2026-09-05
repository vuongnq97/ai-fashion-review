# TEMPLATE 5.3 — Spam Video Đa Ngành Hàng (4 Video 4s, Model Veo, Không Viền Trắng)

## 1. Tổng quan
- **Lệnh kích hoạt**: `/template5_3` (hoặc `/template5.3`, `/template53`).
- **Mục đích**: Spam video review nhanh đa ngành hàng, tạo 1 video hoàn chỉnh gồm 4 video panel ghép lại (mỗi video dài đúng 4 giây, tổng 16 giây).
- **Model Video**: Sử dụng model Veo 4s low-priority (`veo_3_1_i2v_s_lite_4s_low_priority`, key: `'4s'`) tương tự Template 1/2/6.
- **Đặc điểm viền và crop**:
  1. **KHÔNG CHÈN VIỀN TRẮNG** trên ảnh panel và video prompt: Vì model Veo có watermark/logo nằm ở xa góc ngoài hơn Abra nên không cần khung viền đệm trắng 12%.
  2. **Crop video**: Tương tự như Template 6 (giữ tỉ lệ 9:16 tự nhiên, không crop 12%).
  3. **Storyboard & 4 Panel 9:16**: Master storyboard 16:9 được cắt thẳng thành 4 panel 9:16 (1080x1920) full viền (borderless).
  4. **Faceless 100% & Không Text**: Không xuất hiện mặt người, không chữ overlay, không cartoon graphics.
  5. **Giọng nói Voice-over**: Tương tự Template 5_2, giọng đọc nhanh, dồn dập, liên tục trong 4 giây (15-21 từ mỗi cảnh, câu cú trọn vẹn đủ ý).

---

## 2. Cấu trúc 4 Phân cảnh (4s mỗi cảnh)
- **Cảnh 1 (Hook - 4s)**: Đặt vấn đề hoặc mở đầu ấn tượng, nêu tên sản phẩm (15-21 từ).
- **Cảnh 2 (Solution / Features - 4s)**: Đặc tả công năng, cấu tạo và hoàn thiện tinh xảo (15-21 từ).
- **Cảnh 3 (Proof / Experience - 4s)**: Trải nghiệm thực tế, thao tác kiểm chứng chất lượng (15-21 từ).
- **Cảnh 4 (Closing / CTA - 4s)**: Toàn cảnh sản phẩm trong không gian hoàn thiện, kêu gọi giỏ hàng (15-21 từ).

---

## 3. Ghép video & Upload
- Sau khi 4 video hoàn thành, lệnh `/upload` sẽ tự động ghép 4 video theo thứ tự Cảnh 1 -> 2 -> 3 -> 4 thành video 16 giây.
- Vì là template có giọng đọc (`isVoiceTemplate = true`), hệ thống giữ nguyên âm thanh voice-over của video, không tắt tiếng để chèn nhạc trend.
