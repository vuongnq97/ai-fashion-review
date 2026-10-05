# TFOOD — CODING AGENT IMPLEMENTATION SPEC

> Mục đích: giao tài liệu này cho coding agent đang có quyền đọc/sửa repository để nâng cấp pipeline tạo video review đồ ăn, thức uống theo phong cách tham chiếu người dùng cung cấp. **Đây là đặc tả triển khai, không phải tuyên bố rằng source code đã được kiểm tra hoặc sửa.** Agent phải khám phá repository trước khi chỉnh sửa, giữ tương thích các tính năng đang hoạt động, chạy kiểm thử và báo cáo thay đổi thực tế.

## 0. Mệnh lệnh dành cho agent

1. Đọc toàn bộ tài liệu, khảo sát repository, xác định entrypoint, sơ đồ pipeline, schema và các file liên quan. Không đoán tên file/hàm, không tự tạo một pipeline song song khi có thể mở rộng pipeline hiện tại.
2. Đọc README, package scripts, test suite, cấu hình và những template đang được sử dụng. Ghi lại baseline: các lệnh build/test, đường đi input → output và những điểm tích hợp AI.
3. Lập kế hoạch sửa theo từng module và **thực thi thay đổi trong code**, không chỉ viết đề xuất. Nếu thiếu quyền truy cập hoặc thiếu file, báo rõ điểm chặn và chỉ sửa những phần có thể xác minh.
4. Không xóa tính năng cũ, không thay đổi public API/schema một cách âm thầm. Nếu cần migration, thêm adapter/default và cập nhật call sites + tests.
5. Không đưa API key, token, ảnh/video tham chiếu có bản quyền hoặc dữ liệu nhạy cảm vào source/log. Không tự gọi API tốn tiền hoặc tạo hàng loạt media khi chưa có yêu cầu/thiết lập phù hợp; ưu tiên dry-run/mock tests.
6. Kết thúc bằng danh sách file đã sửa, lý do, kết quả test, giới hạn chưa xử lý và ví dụ đầu ra thật từ dry-run. Không tuyên bố đạt chất lượng thị giác nếu chưa kiểm tra media thực tế.

## 1. Phạm vi và mục tiêu

- Channel: review/giới thiệu **đồ ăn và thức uống**, nhiều ngành hàng trong nhóm food & beverage; không áp dụng persona mẹ và bé hoặc template household nếu không có cấu hình chọn riêng.
- Đầu vào: ảnh sản phẩm và mô tả/metadata do người dùng cung cấp; có thể có nhiều ảnh, nhiều góc, bao bì, ảnh thành phẩm và ảnh chi tiết. Chỉ sử dụng thông tin đã xác minh từ input để phát biểu về sản phẩm.
- Đầu ra chuẩn: **4 cảnh × 6 giây = 24 giây**, video dọc 9:16, voiceover review nữ miền Nam trẻ trung, gần gũi, nhịp nhanh tự nhiên; có storyboard, prompt hình ảnh/video, thoại, TTS và QA nếu pipeline hiện có hỗ trợ.
- Triết lý: **PRODUCT EXPERIENCE > STORYTELLING**. Món ăn là nhân vật chính; ưu tiên số lượng/độ đầy đặn, texture, thao tác tay có ý nghĩa, cận cảnh, sử dụng/nếm thử khi được chứng minh bằng tư liệu.
- Chất tham chiếu từ các ảnh chụp màn hình: sản phẩm chiếm khung hình lớn, bao bì thật, cảnh cửa hàng/giao hàng khi có bằng chứng, bày đĩa/khay phong phú, tay bẻ/xé/kéo/chấm/rót, nền đời sống ấm áp. Không sao chép logo, tên shop, nhân vật, nhãn hiệu hoặc bối cảnh cụ thể của kênh tham chiếu vào sản phẩm không liên quan.
- Các ảnh chụp màn hình **không đủ để suy ra lời thoại nguyên văn, giọng vùng miền chính xác hoặc hiệu quả chuyển đổi**. Các chỉ tiêu ngôn ngữ bên dưới là mục tiêu sáng tạo cần hiệu chỉnh qua transcript được phép sử dụng, không phải thống kê từ ảnh.

## 2. Quy trình khám phá repository (bắt buộc trước khi code)

Tìm và ghi nhận:

- Điểm nhận input: ảnh, mô tả, product category, user settings, reference images.
- Product analysis / claim extraction / vision model calls.
- Storyboard planner, scene schema, shot selection, image prompt builder.
- Video prompt builder, reference-image attachment, image-to-video/video generation, retry/fallback.
- Script writer, TTS client, voice config, audio duration probing, audio/video mux.
- QA validators, logging, UI/API/export, persisted run schema.
- Cơ chế cấu hình template/channel và các template khác cần bảo toàn.

Tạo một bảng mapping `requirement → actual file/function → change → test`. Nếu module chưa tồn tại, chỉ tạo module mới khi có điểm tích hợp rõ ràng. Kiểm tra các giới hạn thực tế của provider; không giả định model có khả năng gắn nhiều ảnh reference, duy trì identity, hoặc tạo chính xác 6 giây nếu API không hỗ trợ.

## 3. Cấu hình chuẩn có thể ghi đè

Đề xuất cấu hình logic (chuyển sang convention đang có trong repo, không ép dùng JSON nguyên xi):

```json
{
  "templateId": "FOOD_REVIEW_TEMPLATE_PRO",
  "format": { "aspectRatio": "9:16", "sceneCount": 4, "sceneSeconds": 6, "totalSeconds": 24 },
  "visual": {
    "productFirst": true,
    "requireHeroInteraction": true,
    "preferMeaningfulHandAction": true,
    "allowVerifiedRealWorldProvenance": true,
    "avoidReferenceBrandCopying": true
  },
  "voice": {
    "language": "vi-VN",
    "persona": "SOUTHERN_VIETNAMESE_SUBTLE_MEKONG_V1",
    "selfReference": "tui",
    "style": "fast conversational, warm, bright, natural",
    "model": "configurable",
    "voiceName": "configurable"
  },
  "qa": { "failOnUnsupportedClaims": true, "failOnProductMismatch": true, "failOnMissingHeroInteraction": true }
}
```

**Không hardcode tên model TTS/voice nếu repository đã có provider config.** Nếu chọn Gemini, xác nhận model/voice hiện được tài khoản hỗ trợ tại thời điểm tích hợp, cấu hình qua env/UI và có fallback phù hợp. Không suy diễn rằng API có trường `speed`/`pitch` dạng số; chỉ truyền tham số thực sự được provider hỗ trợ.

## 4. Pipeline mục tiêu

```text
INPUT: product images + user description + verified metadata
  ↓
Product evidence extraction + image role classification
  ↓
Product-specific review angle + sensory/claim safety plan
  ↓
4-scene storyboard planner + visual continuity plan
  ↓
Scene image prompts + explicit reference mapping
  ↓
Storyboard image generation + visual QA + selective retry
  ↓
6-second video prompts + reference mapping + action runway
  ↓
Video generation + scene QA + selective retry
  ↓
Voice script + Show↔Say alignment + TTS generation
  ↓
Duration check + concise rewrite / audio adjustment if supported
  ↓
4-scene assembly + audio mux + final QA + export
```

Nếu pipeline hiện tại sắp xếp TTS trước image/video, có thể giữ thứ tự miễn có **alignment contract** và vòng phản hồi để thoại khớp hình. Các bước bất khả thi do provider phải được biểu diễn bằng trạng thái lỗi/fallback minh bạch, không lặng lẽ bỏ qua.

## 5. Product evidence & image-role mapping

### 5.1 Chuẩn hóa dữ liệu đầu vào

Tạo/điều chỉnh cấu trúc nội bộ tương đương:

```ts
interface FoodProductEvidence {
  productId: string;
  displayName: string;
  category: 'bakery' | 'dried_fruit' | 'snack' | 'seafood' | 'drink' | 'dessert' | 'other';
  referenceImages: Array<{
    id: string;
    source: string;
    role: 'packaging' | 'product_whole' | 'product_opened' | 'texture' | 'prepared' | 'usage' | 'environment' | 'unknown';
    confidence?: number;
    verifiedObservations: string[];
  }>;
  verifiedClaims: Array<{ text: string; source: 'user' | 'packaging' | 'visible_image' | 'verified_metadata'; evidenceIds: string[] }>;
  unknowns: string[];
  forbiddenClaims: string[];
}
```

Dùng schema validation thực tế trong repo. Không xem mô tả model tự suy đoán là chứng cứ độc lập. Ảnh có thể chứng minh hình dạng/màu/bao bì nhìn thấy; **không** tự chứng minh mùi vị, nguồn gốc, thành phần, an toàn thực phẩm, giá, giao hàng, chứng nhận, hoặc trải nghiệm cá nhân.

### 5.2 Quy tắc hình ảnh

- Gắn vai trò cho từng ảnh; giữ ID gốc xuyên suốt analysis → storyboard → image → video → QA.
- Chọn reference theo cảnh và mục tiêu: bao bì dùng ảnh bao bì, ruột bánh dùng ảnh ruột bánh; không dùng ảnh bao bì để tự bịa cấu trúc bên trong.
- Trích xuất thuộc tính cần khóa: shape, dimensions tương đối, màu, số lượng/đơn vị, vị trí nhãn, cấu trúc bao bì, thành phần nhìn thấy. Không biến sản phẩm thành món khác.
- Nếu không có ảnh texture/ruột hoặc không có thông tin xác minh, chọn tương tác an toàn như cầm/xoay/mở túi/đổ ra đĩa thay vì bịa cảnh bẻ ra lộ nhân.
- Cảnh giao hàng, nhân viên, nhà máy, cửa hàng, chứng nhận, nhãn J&T hoặc shop tham chiếu **chỉ được tạo khi thuộc dữ liệu đầu vào và được người dùng cho phép**; không giả mạo bằng chứng nguồn gốc/giao hàng.

## 6. Scene architecture: 4 × 6 giây

| Scene | Time | Role | Primary visual | Voice function | Mandatory outcome |
|---|---|---|---|---|---|
| 1 | 00–06 | DISCOVERY / HOOK | Product reveal, packaging or compelling hero product | Name/curiosity/context | Nhận diện đúng sản phẩm ngay đầu video |
| 2 | 06–12 | SHOW / FIRST OBSERVATION | Unpack, pile, pour, plate, close-up | Mô tả điều quan sát được | Chứng minh hình dáng/số lượng/đặc điểm có thật |
| 3 | 12–18 | HERO INTERACTION / SENSORY PROOF | Tear, break, pull, dip, lift, pour, stir, etc. | Phản ứng theo hành động đang diễn ra | Có thao tác rõ, nhìn được kết quả; không bịa texture |
| 4 | 18–24 | EXPERIENCE / VERDICT / SOFT CTA | Final texture/usage/hero beauty shot | Nhận xét có điều kiện + CTA nhẹ | Kết thúc gọn, không hứa hẹn vô căn cứ |

Không rập khuôn góc máy: chọn visual grammar theo loại sản phẩm. **Scene 3 là trọng tâm**, nhưng nếu sản phẩm không cho phép bẻ/xé/chấm, dùng tương tác phù hợp khác. Đảm bảo 4 cảnh bổ sung thông tin, không lặp cùng một shot hoặc chỉ zoom ảnh tĩnh.

### 6.1 Hero Interaction planner

Ánh xạ ví dụ (chỉ chọn khi phù hợp với sản phẩm và evidence):

- Bánh có nhân: bẻ/cắt để lộ ruột, chỉ khi có ảnh hoặc mô tả đáng tin về ruột.
- Khoai sấy dẻo: cầm, uốn/kéo nhẹ để thấy độ dẻo khi đã có evidence.
- Cá khô/đồ chấm: gắp/chấm/nâng miếng; không khẳng định vị nếu chưa thử.
- Kẹo đậu phộng: bẻ/cầm để lộ hạt, nếu hình thái thực tế cho phép.
- Đồ uống: mở, rót, khuấy, nâng ly; giữ đúng độ sánh/màu từ reference.
- Set chè: mở nguyên liệu → chế biến/hoàn thiện chỉ khi có tư liệu, thời gian và thao tác hợp lý; không tạo cảnh nấu hoàn tất trong 6s như bằng chứng thực tế nếu không phù hợp.

Hero Interaction phải gồm `startState`, `handAction`, `visibleResult`, `referenceIds`, `claimIds`, `fallbackAction`. Tránh biến dạng sản phẩm, tay thừa/ngón lỗi, vật thể xuyên nhau, đổi số lượng/nhãn vô lý.

## 7. Visual direction / channel world

- Video dọc 9:16, smartphone-realism; không dùng CGI quá bóng, ánh sáng studio phi thực tế, background AI lộn xộn.
- Product-first: khung hero nên chiếm phần lớn vùng nhìn (mục tiêu sáng tạo khoảng 50–80%, điều chỉnh theo kích thước/đặc thù). Không dùng threshold này làm hard fail cho mọi cảnh.
- Context được chọn theo chức năng: cửa hàng/bao bì cho discovery, bàn gỗ/khay/đĩa cho abundance, góc cận sạch cho texture, ly/chén/đũa cho usage.
- Warm lifestyle background là **một lựa chọn**, không áp dụng vô điều kiện cho đồ uống lạnh, thực phẩm tươi, sản phẩm nhà máy hoặc sản phẩm có concept khác.
- Tay phải có hành động có ý nghĩa; không ép tay xuất hiện trong cảnh mà tay gây che khuất sản phẩm.
- Background và props hỗ trợ sản phẩm, không thay thế sản phẩm. Tránh tự tạo nhãn hiệu/bao bì khác.
- Không bake giao diện TikTok, thanh tìm kiếm, lượt tim, comment, watermark, logo kênh tham chiếu vào ảnh/video. Overlay tên sản phẩm nếu cần nên render trong hậu kỳ bằng dữ liệu chính xác, không phụ thuộc model vẽ chữ.

## 8. Storyboard & video prompt contracts

Mỗi scene phải có dữ liệu tương đương:

```ts
interface FoodScenePlan {
  index: 1 | 2 | 3 | 4;
  durationSeconds: 6;
  role: 'discovery' | 'show' | 'hero_interaction' | 'verdict';
  visualGoal: string;
  productState: string;
  environment: string;
  framing: string;
  cameraMovement: string;
  action: { start: string; middle: string; end: string; visibleResult: string };
  referenceImageIds: string[];
  continuityLocks: string[];
  narration: string;
  narrationEvidenceIds: string[];
  negativeConstraints: string[];
  qaChecks: string[];
}
```

Prompt builder phải:

1. Ghi rõ ảnh reference nào được dùng và **vai trò** của từng ảnh. Nếu provider không hỗ trợ tham chiếu trực tiếp, dùng phương thức khả dụng (ảnh đầu vào/first frame/image-to-video) và ghi rõ hạn chế.
2. Nêu cụ thể sản phẩm, hình dạng, màu, bao bì, background, camera, ánh sáng, tay, động tác, trạng thái đầu/cuối và kết quả thấy được.
3. Xây **action runway 6 giây**: 0–1s thiết lập, 1–4.5s hành động chính, 4.5–6s giữ kết quả/đóng shot; tùy scene điều chỉnh, tránh nhồi nhiều hành động không khả thi.
4. Ghi negative constraints: no wrong product, no extra hands/fingers, no packaging mutation, no fake logos, no floating food, no unreadable invented text, no unverified interior/ingredients.
5. Giữ continuity có chọn lọc: sản phẩm/bao bì/props nhất quán khi cùng không gian; cho phép chuyển không gian có chủ đích (cửa hàng → bàn review), không ép tất cả scene cùng background.
6. Sinh storyboard trước khi tạo video nếu pipeline hiện có bước này; kiểm tra storyboard và chỉ retry scene lỗi, không regenerate toàn bộ vô cớ.

## 9. Voice persona, language & script

### 9.1 Persona target

- Nữ Việt trẻ, miền Nam tự nhiên, hơi hướng miền Tây **nhẹ**; thân thiện, tươi, ấm, có cảm giác đang trò chuyện với bạn.
- Fast conversational; lời liên tục nhưng có nhịp nhấn và ngắt cực ngắn. Không đọc như quảng cáo TV, không hét, không quá diễn, không giọng bản tin.
- Self-reference mặc định `tui`, có thể lược chủ ngữ tự nhiên; tránh đổi ngẫu nhiên `tui/mình/em/chị` trong một video.
- Xưng hô người xem (`cả nhà`, `mọi người`, `mấy bạn`, `ai...`) tùy ngữ cảnh; không nhồi trong từng cảnh. Các hạt `nè`, `nha`, `nghen`, `á`, `ha/hen`, `đó` dùng vừa phải; không coi việc thêm hạt cuối câu là đủ tạo giọng miền Tây.
- Đặt profile `SOUTHERN_VIETNAMESE_SUBTLE_MEKONG_V1` cho đến khi có transcript/ghi âm được phân tích. Không gọi profile này là khớp tuyệt đối kênh tham chiếu.

### 9.2 Script mechanics

- **Describe feature → react to experience**, nhưng không giả vờ đã ăn/nếm nếu không có trải nghiệm được xác minh.
- **Expectation → Contrast → Reward** khi có bằng chứng: “Nhìn ngoài tưởng khô, mà bẻ ra thấy phần ruột mềm…” chỉ khi ruột thật sự được chứng minh.
- Một ý cảm quan chính/beat; từ vựng tùy evidence: giòn rụm, dẻo mềm, béo nhẹ, ngọt vừa, nhân đầy, sốt sệt... Không suy ra vị/mùi từ ảnh.
- Ưu tiên lời nói chỉ đúng hành động đang hiện: “Bẻ ra coi nè…” khi video đang bẻ; không nói “chấm thử” lúc đang quay túi đóng kín.
- Có thể dùng mức độ thận trọng `khá`, `hơi`, `vừa`, `theo tui` khi thực sự có căn cứ; tránh khen 100% và ngôn ngữ quảng cáo trống rỗng.
- CTA mềm ở scene 4: “Ai thích kiểu này thì tham khảo nha”; chỉ nói “ở giỏ hàng” nếu kênh/luồng xuất bản thực sự có giỏ hàng.
- Không tự bịa “tui mới đặt”, “shipper vừa giao”, “ăn rồi thấy”, “nhà tui mê”, “best seller”, “đặc sản chính gốc”, “healthy”, “an toàn cho bé”, chứng nhận, giá/khuyến mại.

### 9.3 Timing

- Tổng 24s; target ban đầu ~85–100 từ tiếng Việt cho toàn video và khoảng 20–26 từ/scene, **chỉ là heuristic**; cách tách từ tiếng Việt không đồng nhất nên thời lượng TTS thật là nguồn quyết định.
- Mỗi scene có `narrationText`, `targetStartMs`, `targetEndMs`, `visualCue`, `evidenceIds`; ưu tiên thoại scene-specific, tránh cắt giữa câu ở scene boundary.
- Sinh TTS, đo duration thật; nếu dài, viết lại gọn mà vẫn giữ thông tin trước khi tăng tốc; nếu ngắn, thêm nhận xét có chứng cứ hoặc khoảng nghỉ tự nhiên. Không tăng tốc đến mức khó nghe.
- Nếu voiceover là một track liên tục, dùng alignment timestamps để xác định beat; nếu TTS per-scene, thêm quy tắc nối âm, tránh 4 đoạn giọng khác nhau về âm sắc/năng lượng.
- Có thể đặt target ~23.2–24.0s tùy tolerance của mux; không hardcode padding/cắt ở giây 24 gây mất chữ. Tính duration từ output thực tế và test.

### 9.4 Prompt TTS mẫu (adapt to provider)

```text
AUDIO PROFILE: Young Vietnamese female food reviewer; natural Southern Vietnamese
with a subtle Mekong Delta conversational flavor. Warm, bright, friendly, lightly
smiling voice. Fast conversational delivery with clear words, varied emphasis,
short natural micro-pauses, and no shouting.

SCENE: Speaking to a friend while demonstrating the actual food product on camera.

DIRECTOR'S NOTES: Sound like an authentic hands-on food review, not a commercial,
newscast, audiobook or exaggerated influencer. Keep pronouns consistent; use
regional particles sparingly and only where natural. Follow punctuation and
scene-specific action cues. Do not pronounce scene labels or metadata.

TRANSCRIPT:
{{validated_narration_text}}
```

Nếu API có giới hạn prompt/chunk, thích nghi mà không đưa metadata vào lời nói. Voice/model chọn từ cấu hình; không mặc định provider sẽ tạo đúng accent chỉ bằng một prompt.

## 10. Show↔Say alignment

Tạo validator liên kết từng câu/beat với `sceneIndex`, `visualAction`, `visibleEvidence`, `voiceText`, `timeWindow`.

Hard fail nếu:
- Lời nói về chi tiết ruột/nhân mà cảnh và reference không có chứng cứ.
- Nói “đang bẻ/chấm/rót” nhưng prompt/cảnh không có hành động đó.
- Nói đã ăn hoặc đã mua khi không có dữ liệu chứng minh.
- Lời thoại scene không thể nằm trong 6 giây sau khi đo TTS và chưa được sửa.

Soft warning nếu:
- Voice quá nhiều tính từ không đi cùng visual proof.
- Lặp tên sản phẩm, xưng hô, từ đệm, CTA.
- 4 scene có cùng framing/visual function.

## 11. QA gates & retry policy

### 11.1 Input QA

- Có ảnh hợp lệ, mô tả và category đủ để xác định sản phẩm; đánh dấu unknown rõ ràng.
- Reference IDs tồn tại; không truy cập path không hợp lệ.
- Claim có evidence; không suy diễn taste/health/origin.

### 11.2 Storyboard QA

- Đúng 4 cảnh × 6s; roles đủ và theo thứ tự.
- Scene 1 nhận diện sản phẩm; scene 2 cho thông tin mới; scene 3 có hero interaction; scene 4 có closing phù hợp.
- Product locks nhất quán; không tạo bao bì/ruột mới; background/props hợp lý.
- Mỗi scene có reference mapping, action runway, narration alignment.

### 11.3 Visual/video QA

- Product identity, shape, color, packaging, number of units, ingredients visible match reference.
- Hands anatomically plausible, grip/action physically possible, object interaction coherent.
- No fake delivery/factory/shop proof, fake logos, UI screenshots, copied watermarks.
- No unintended scene cuts, frozen frame disguised as interaction, floating/morphing product.
- Output duration/aspect ratio/codecs conform to existing export contract.

### 11.4 Audio/final QA

- TTS Vietnamese pronunciation, consistent persona, no spoken metadata.
- Duration within mux tolerance; no truncated last syllable, no long dead air, no abrupt boundary.
- Voice matches visible action; music (if any) does not drown voice; output is 24s within configured tolerance.
- Overlay text accurate and readable inside safe area; no TikTok UI baked in.

**Retry selectively**: regenerate/rewrite only failed scene or narration segment where feasible, with max retries and actionable error log. If failed after limit, return structured failure + artifacts for inspection, not silent success.

## 12. Product-specific adaptation examples

| Category | Discovery | Show | Hero interaction | Closing |
|---|---|---|---|---|
| Bánh pía mini | Bao bì hoặc khay bánh | Đổ/xếp bánh, thấy kích cỡ | Bẻ đôi nếu ruột được reference chứng minh | Cận bánh/nhận xét có căn cứ + CTA |
| Khoai lang sấy dẻo | Gói/miếng khoai | Bày nhiều miếng, cận bề mặt | Uốn/kéo nếu thực tế dẻo | Hero texture + CTA |
| Khô cá | Túi hàng | Khay cá/đĩa | Gắp/chấm khi hợp sản phẩm | Plated beauty shot + CTA |
| Kẹo đậu phộng | Gói/đĩa | Pile và hạt thấy rõ | Bẻ nếu có evidence | Close-up + CTA |
| Đồ uống | Chai/gói/ly | Mở/rót | Rót/khuấy/nâng ly | Thành phẩm + CTA |
| Set chè | Set nguyên liệu | Trưng bày thành phần | Múc/thao tác đã được chứng minh | Thành phẩm hợp evidence + CTA |

Đây là ví dụ định hướng, không phải công thức bắt buộc. Với sản phẩm lạ, planner phải phân tích đặc tính và chọn interaction mới có lý do.

## 13. Implementation work packages

### WP1 — Repo audit & baseline
- Mapping file/hàm, dependency, data contract, provider capability, tests.
- Ghi baseline và lưu một dry-run hiện tại để so sánh nếu có thể.

### WP2 — Config & template routing
- Thêm/điều chỉnh template `FOOD_REVIEW_TEMPLATE_PRO` qua hệ thống template hiện tại.
- Không để cấu hình food ghi đè Mother & Baby/household hoặc các template khác.
- Defaults 4×6/24s, override chỉ khi hệ thống hỗ trợ rõ ràng.

### WP3 — Evidence extraction
- Image-role mapping, claim evidence IDs, unknown/forbidden claims, product locks.
- Validator input và tests thiếu ảnh ruột/thiếu metadata.

### WP4 — Dynamic scene planner
- Discovery/Show/Hero Interaction/Verdict, category-specific strategy, 6s action runway.
- Output schema/adapter tương thích downstream.

### WP5 — Prompt builders & reference attachment
- Image prompt/video prompt dùng cùng scene plan và reference mapping.
- Continuity lock, anti-hallucination, real-world provenance guard.

### WP6 — Script & voice
- Persona config, consistent pronouns, grounded sensory language, alignment.
- TTS integration theo provider đang có; duration loop và fallback.

### WP7 — QA, retries & observability
- Structured validators, hard fail/warning, per-scene retry, logs, status.
- Lưu decision trace: image role, chosen interaction, supporting evidence, QA reason; không log secrets.

### WP8 — Integration & export
- Đảm bảo 4 clips × 6s, mux 24s theo tolerance, export contract/UI/API.
- Regression tests cho các template khác.

## 14. Tests/acceptance criteria bắt buộc

Tạo fixtures synthetic/mock không chứa secret hoặc asset có bản quyền:

1. Bánh có ảnh bao bì + ảnh ruột: scene 3 chọn bẻ và có evidence đúng.
2. Bánh chỉ có ảnh bao bì: không bịa nhân; chọn mở gói/cầm bánh hoặc yêu cầu thêm ảnh nếu cần.
3. Đồ uống: planner không cố bẻ; chọn rót/khuấy hợp lý.
4. Sản phẩm không phù hợp bàn trà ấm: chọn environment thích hợp.
5. Ảnh tham chiếu có logo kênh/shop khác: không copy sang sản phẩm mới.
6. Input không có chứng cứ giao hàng: không tạo shipper/J&T/nhà máy như bằng chứng.
7. Input có claim sức khỏe chưa xác minh: reject hoặc viết lại trung tính.
8. Voice script dùng xưng hô ổn định; không spam `nè/nghen`.
9. Scene 3 không có interaction: hard fail và retry có lý do.
10. Scene script TTS >6s: rewrite/re-time theo chính sách, không cắt chữ.
11. Image/video generation mock fail scene 2: chỉ retry scene 2 nếu architecture hỗ trợ.
12. Scene 1–4 đúng order, 6s/scene và final 24s trong tolerance.
13. Reference image ID sai/missing: lỗi rõ, không dùng nhầm ảnh.
14. Existing template regression: household/mother-baby vẫn chạy như baseline.
15. Dry-run xuất đầy đủ plan, prompts, narration, evidence mapping, QA status và log dễ đọc.

Nếu repo thiếu test framework, thêm test tối thiểu theo conventions hiện có. Không claim end-to-end pass khi chỉ chạy unit tests/mock; tách `unit`, `integration`, `provider smoke`, `visual manual review`.

## 15. Definition of Done

- [ ] Source đã được audit, có mapping requirement → file/hàm.
- [ ] Template food mới/đã nâng cấp chạy qua entrypoint hiện tại.
- [ ] 4 cảnh × 6s với vai trò rõ, scene 3 có interaction hợp lệ.
- [ ] Evidence mapping và guard chống claim/visual bịa đặt.
- [ ] Storyboard/video prompts dùng reference IDs thực tế và continuity có chủ đích.
- [ ] Script/TTS có persona, xưng hô, Show↔Say và duration validation.
- [ ] QA/retry/logging có trạng thái lỗi minh bạch.
- [ ] Build/lint/tests liên quan pass hoặc báo rõ lý do fail.
- [ ] Regression template cũ được kiểm tra.
- [ ] Có ví dụ dry-run và hướng dẫn chạy/cấu hình.
- [ ] Báo cáo rõ phần nào chưa kiểm chứng bằng video/audio thật.

## 16. Format báo cáo cuối cùng của coding agent

```text
1. Repository audit: entrypoint, pipeline map, relevant files
2. Implementation: changed files + exact behavior changed
3. Compatibility/migrations: schema, config, call-site updates
4. Validation: commands run, pass/fail, tests added
5. Example dry-run: 4 scene plan + image/video prompts + script + QA summary
6. Known limitations: provider constraints, unavailable references, manual review needed
7. Follow-up actions: only concrete unresolved blockers
```

## 17. Bối cảnh tham chiếu và mức độ chắc chắn

**Quan sát từ ảnh người dùng gửi:** nhiều video sản phẩm thực phẩm dùng cảnh túi hàng/bao bì, số lượng đầy, khay/đĩa, tay tương tác, cận texture, bối cảnh cửa hàng hoặc bàn ăn, overlay tên món. Đây là cảm hứng về **ngữ pháp hình ảnh**, không phải chỉ dẫn sao chép hình/brand/người của kênh.

**Yêu cầu đã chốt từ người dùng:** kênh review đồ ăn/thức uống, 4 cảnh, mỗi cảnh 6 giây, tổng 24 giây; cần coding agent nâng cấp JS project hiện tại.

**Giả định thiết kế cần kiểm tra trong repo và bằng output:** tên template, schema đề xuất, persona V1, target số từ, timing tolerance, mức chiếm khung hình, lựa chọn provider/model/voice, các khả năng reference và video generation. Agent phải xác minh thay vì xem là sự thật của codebase.

**Ưu tiên tối cao:** sản phẩm đúng và được chứng minh > thao tác hợp lý > thoại khớp hình > chất lượng thẩm mỹ > hiệu ứng quảng cáo.
