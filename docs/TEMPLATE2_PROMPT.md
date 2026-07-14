# Template2 - Review 8 cảnh (Mỗi cảnh 4 giây video)

Luồng `/template2` hỗ trợ tạo 8 cảnh review đa dạng góc chụp và động tác, thích hợp cho việc giới thiệu chi tiết mọi loại giày dép. 

## Cấu trúc 8 cảnh

| Cảnh  | Nội dung storyboard                                                  | Thời lượng dự kiến |
| ----- | -------------------------------------------------------------------- | -----------------: |
| **1** | Người mẫu đứng tạo dáng, co một chân để khoe mặt bên sản phẩm        |             0–4,0s |
| **2** | Hai tay cầm sản phẩm gần camera, nghiêng nhẹ khoe thiết kế           |           4,0–8,0s |
| **3** | Góc chính diện phần thân dưới, hai chân toe tap và xoay mũi liên tục |          8,0–12,0s |
| **4** | Người mẫu ngồi ghế, hai chân đung đưa và xoay cổ chân                |         12,0–16,0s |
| **5** | Cúi người dùng tay chỉnh cổ giày/quai/dây/gót                        |         16,0–20,0s |
| **6** | Góc đứng nghiêng, bắt chéo chân, nhấc gót và đổi pose liên tục       |         20,0–24,0s |
| **7** | Hai tay cầm một chiếc và xoay từ mặt bên sang mặt đế                 |         24,0–28,0s |
| **8** | Cận cảnh mặt đế, tay vuốt và nhấn vào các rãnh chống trượt           |         28,0–32,0s |

## Hướng dẫn sử dụng

Gửi lệnh `/template2` đến Telegram Bot, sau đó gửi album ảnh sản phẩm. Bot sẽ:
1. Tạo Storyboard tổng 8 panel (xếp dạng **4x2 grid**).
2. Tách 8 panel ảnh riêng biệt.
3. Tạo 8 video 4s tương ứng bằng video model `veo_3_1_i2v_s_lite_4s_low_priority`.

## Video Model Key

Để sinh video đúng 4s, API sẽ gọi key: `veo_3_1_i2v_s_lite_4s_low_priority`.
Trong veo3Prompt sinh ra cho mỗi panel, hành động phải được chia thành 2 phase (0s-2s và 2s-4s) thay vì 8s.
