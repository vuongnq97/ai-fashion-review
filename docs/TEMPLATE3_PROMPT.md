# Template3 - Shop Top-Down Faceless Footwear Review

Luồng `/template3` dùng cho review giày dép faceless 2 cảnh trong bối cảnh shop giày dép.

Mục tiêu:

- Tạo review giày dép dạng faceless.
- Chỉ có đúng 2 cảnh, mỗi cảnh 8 giây.
- Cảnh 1 là top-down smartphone giống bố cục video mẫu: một chiếc được cầm xoay trên tay, chiếc còn lại đặt cố định bên dưới.
- Cảnh 2 tương tự template 1: POV top-down thử lên chân, đứng/ngồi yên một chỗ.
- Ở cảnh 1, chiếc cầm trên tay phải là foreground lớn nhất, tay giữ chắc ở phần đế và thân bên, sản phẩm nghiêng 15-30 độ để thấy cả mặt trên và cạnh bên.
- Ở cảnh 2, nếu sản phẩm là giày/sneaker/loafer/boot/giày kín mũi thì người mẫu phải mang tất phù hợp; nếu là sandal/dép/slide/slipper/open-toe thì không cần tất, ưu tiên chân trần tự nhiên.
- Cả 2 cảnh cùng một bối cảnh shop giày dép thật, không phải nhà, studio, cafe, đường phố hay ngoài trời.
- Không có voice-over, không lời thoại, không phụ đề, không chữ thêm, không watermark, không lộ mặt.
- Nếu ảnh sản phẩm không có hộp giày/dép, chiếc còn lại ở cảnh 1 đặt trên giá đỡ: `playwright-service/assets/giadegiay.webp`.
- Khi tạo storyboard/panel cho template 3, luôn kèm ảnh shop giày dép: `playwright-service/assets/shopgiay.png` để đồng bộ background cho kênh.
- Ảnh `shopgiay.png` chỉ là reference bối cảnh shop: dùng cho mood, kệ giày, sàn/kệ/quầy và ánh sáng; không xem là sản phẩm, không copy chữ/logo/watermark/signage vào ảnh tạo ra.
- Sản phẩm luôn lấy theo ảnh đã upload từ Telegram; giá đỡ chỉ là prop, không được biến thành sản phẩm.
- Dùng realism keyword giống template 1 nhưng chuyển sang shop: quay bằng điện thoại, ánh sáng shop chân thực, chất liệu có texture tự nhiên, da tay/chân thật, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI.

## Step 1 - Phân Tích Và Sinh Storyboard JSON

```text
TEXT-ONLY TASK. Do not generate images. Do not call image generation. Do not create a visual storyboard asset.
You are a senior footwear product analyst, faceless shop-review storyboard director, and Veo 3 prompt writer.
Analyze ONLY the uploaded footwear product reference images as the product source of truth, then create a reusable template3 storyboard as JSON text only.

Requirements:
- Template: template3 faceless footwear shop top-down review.
- Category: {category}
- Panel count: exactly 2.
- Scene ratio for each panel: {scene_ratio}.
- Scene context must be a real footwear shop / shoe store interior.
- Use "shopgiay-background-reference.png" as the shared footwear shop background/style reference for both panels, while keeping the uploaded footwear as the only product identity source.
- Panel 1: top-down smartphone camera from above; one shoe/sandal is held by a hand and rotated; the matching other shoe/sandal stays stationary below/on the product base.
- Panel 1 hand composition: the held product is large in the foreground, about 55-70% of panel height; the hand grips firmly at the sole edge and side body; fingers support the outsole/side, thumb stabilizes the side/upper; product tilted 15-30 degrees to reveal top/upper, toe/front, straps/laces, side body, and part of sole edge.
- If product references show a matching shoe box, use that box. If not, use "giadegiay-display-stand-reference.webp" as a display stand prop only.
- Panel 2: template1-style top-down POV on-foot proof in the same shop, wearer sitting or standing still in one place.
- Panel 2 sock logic: closed shoes/sneakers/loafers/boots require appropriate socks; open sandals/slides/slippers/dép should normally be barefoot.
- Preserve exact product color, material, silhouette, sole, straps/laces, logo/text, charm, pattern, stitching, and proportions.
- No voice-over, no dialogue, no subtitles, no captions, no UI, no price, no rating, no watermark.
- Return ONLY valid JSON.
```

## Step 2 - Tạo Storyboard Tổng

```text
Generate one faceless footwear shop review storyboard image from the uploaded product reference images.

Storyboard requirements:
- Exactly 2 panels arranged side by side in one single still image.
- Each panel frame is optimized for {scene_ratio} aspect ratio.
- Both panels share the same real footwear shop setting, lighting, shelves/display background, surface/floor logic, and mood.
- Use uploaded reference asset "shopgiay-background-reference.png" as the shared shop environment reference for both panels, including shelf style, retail density, floor/counter/display surfaces, and mixed shop lighting. Keep it secondary behind the product.
- Panel 1 is mandatory: top-down smartphone shot, one shoe/sandal held by realistic hand close to camera, matching other shoe/sandal stationary below/on the product base.
- Panel 1 mandatory grip/pose: held shoe/sandal is largest in foreground; hand holds the outsole/sole edge and side body, not only toe or heel; fingers support under/along the sole, thumb stabilizes side/upper; top/upper, toe/front, straps/laces, side body, and part of sole edge are visible together; held product tilted 15-30 degrees.
- If no matching shoe box is visible in product references, use uploaded reference asset "giadegiay-display-stand-reference.webp" only as the stationary shoe display stand.
- Panel 2 is mandatory: top-down POV on-foot proof in the exact same shop, wearer sitting or standing still, no walking/tracking.
- Panel 2 mandatory sock/barefoot logic: if the product is a closed shoe/sneaker/loafer/boot, show clean suitable socks; if open sandal/slide/slipper/dép, show natural bare feet unless styling clearly supports socks.
- Preserve product identity exactly.
- No visible faces, no added text, no UI, no watermark.
- Real smartphone shop-review look: mixed shop lighting, natural texture, slight handheld imperfection, not plastic/AI-looking.

Scene plan:
{template3_json}

Generate one still storyboard image now.
```

## Cảnh 1 - Video Prompt

```text
Tạo video review giày dép faceless dài đúng 8 giây.

VISUAL: Camera smartphone ở góc top-down nhìn từ trên xuống trong shop giày dép thật, gần như cố định trong toàn bộ video. Một chiếc giày/dép được đặt yên trên bề mặt làm sản phẩm nền; nếu ảnh tham chiếu có hộp giày/dép thì đặt trên hộp đó, nếu không có hộp thì đặt trên giá đỡ theo reference giadegiay-display-stand-reference.webp. Một chiếc còn lại được bàn tay người mẫu cầm lên để giới thiệu. Chỉ thấy bàn tay và cẳng tay khi cần, không lộ mặt, không full body.

Yêu cầu tạo dáng / bố cục: Một chiếc giày/dép được cầm trên tay ở tiền cảnh, chiếm diện tích lớn nhất khung hình khoảng 55-70% chiều cao. Chiếc còn lại đặt ở hậu cảnh hoặc bên dưới, vẫn nhìn rõ toàn bộ form dáng. Tư thế cầm giống ảnh mẫu: bàn tay giữ sản phẩm chắc chắn ở phần đế và thân bên; các ngón đỡ dưới/men theo đế, ngón cái giữ cạnh thân/quai/upper, không che dây/quai/logo/mũi. Sản phẩm cầm trên tay nghiêng khoảng 15-30 độ để vừa thấy mặt trên, quai/dây, mũi giày/dép, thân bên và một phần cạnh đế. Không cầm kẹp mỗi phần mũi, không chỉ cầm gót, không che mặt trên sản phẩm. Nếu có đạo cụ nền như hộp sản phẩm, bàn, mặt ghế, mặt kệ hoặc giá đỡ thì chỉ đóng vai trò nền sạch, không lấn át sản phẩm.

Giữ chính xác 100% màu sắc, form dáng, chất liệu, đế, quai/dây, logo/chữ có sẵn, charm, họa tiết, đường may và tỉ lệ sản phẩm theo ảnh tham chiếu. Hai chiếc phải luôn đồng nhất về thiết kế, kích thước và màu sắc. Không tự thêm, xóa hoặc biến đổi chi tiết sản phẩm.

Camera: Góc top-down cố định, không orbit, không tracking, không camera xoay quanh sản phẩm. Toàn bộ chuyển động giới thiệu được thực hiện bằng bàn tay: nâng, xoay cổ tay, lật mặt đế, đưa sản phẩm gần ống kính và kéo trở lại. Chỉ có rung tay smartphone rất nhẹ và tự nhiên.

Tone & Mood: Nhanh, dứt khoát, chân thực, thương mại, quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da tay thật có lỗ chân lông/nếp khớp, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI.

Hành động:
0.0s-0.7s: Bàn tay đưa nhanh một chiếc giày/dép từ mép khung hình vào trung tâm, nâng lên phía trên chiếc còn lại đang đặt cố định. Mặt trước hoặc mặt trên hướng rõ vào camera và được giữ ngắn trong một nhịp.
0.7s-1.7s: Xoay cổ tay dứt khoát từ mặt trên sang góc ba phần tư rồi sang mặt bên để khoe thân sản phẩm, quai/dây, độ dày đế và silhouette.
1.7s-3.1s: Lật sản phẩm để toàn bộ mặt đế hướng thẳng vào camera. Đưa mặt đế gần máy hơn một chút và giữ ổn định khoảng 0.6-0.8 giây để nhìn rõ rãnh đế, logo/chữ và kết cấu.
3.1s-4.2s: Xoay nhanh từ mặt đế qua phần gót rồi sang mặt bên đối diện, giới thiệu độ cao gót, mép đế và đường cong sản phẩm bằng một chuyển động liên tục có kiểm soát.
4.2s-5.8s: Đưa sản phẩm nhanh về gần ống kính, đồng thời xoay về góc ba phần tư mặt trước. Kết thúc bằng một cận cảnh rõ nét phần thiết kế nổi bật như quai/dây, charm, họa tiết, logo hoặc phần mũi.
5.8s-7.0s: Kéo sản phẩm lùi ra xa, xoay về mặt trên và đưa về bên cạnh chiếc còn lại. Cả hai chiếc xuất hiện đầy đủ, đúng kích thước và không chồng méo lên nhau.
7.0s-8.0s: Nghiêng chiếc đang cầm khoảng 20-30 độ để vừa thấy mặt trên vừa thấy cạnh đế. Giữ pose kết thúc chắc chắn trong 1 giây.

Nhịp chuyển động: Nhanh, dứt khoát, có chủ đích. Mỗi lần xoay phải kết thúc rõ ràng trước khi chuyển sang góc tiếp theo. Không xoay chậm đều, không rung lắc ngẫu nhiên, không làm sản phẩm mềm, méo hoặc biến hình.

Không voice-over, không lời thoại, không nhạc bắt buộc, không phụ đề, không chữ, không watermark, không lộ mặt. Không đổi sản phẩm, không đổi tay, không đổi bối cảnh, không đổi ánh sáng, không xuất hiện thêm vật thể.
```

## Cảnh 2 - Video Prompt

Cảnh 2 dùng lại logic `docs/2.video.md`, nhưng bối cảnh bắt buộc là cùng shop giày dép với cảnh 1.

```text
Tạo video review giày dép faceless 8 giây. VISUAL: Cảnh POV top-down / first-person nhìn từ trên xuống đôi chân đang mang {analysis.productName} trong đúng cùng shop giày dép, thời gian {sceneContext.timeOfDay}, ánh sáng {sceneContext.lighting}; người mẫu đang ngồi yên hoặc đứng yên một chỗ, tuyệt đối không đi lại; outfit được random theo {outfitPlan.styleDirection}, chỉ thấy {outfitPlan.visibleGarments}; giữ đúng màu sắc, form dáng, chất liệu, đế, quai/dây, logo/chữ có sẵn, charm/chi tiết trang trí và tỉ lệ sản phẩm 100% theo ảnh tham chiếu. Tone & Mood: tự nhiên, shop try-on, thời trang, quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da chân thật, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI.
Quy tắc tất/chân trần: Nếu sản phẩm là giày kín mũi như sneaker, giày thể thao, loafer, boot thì người mẫu phải mang tất sạch phù hợp kiểu giày/outfit. Tất có texture vải, hơi nhăn tự nhiên, không che mất chi tiết quan trọng của giày. Nếu sản phẩm là sandal, dép, slide, slipper hoặc open-toe mule thì để chân trần tự nhiên, không tự thêm tất trừ khi styling rõ ràng cần tất.
Hành động: dùng choreography POV đứng/ngồi yên của template 1 cảnh 2.
Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark, không lộ mặt người.
```
