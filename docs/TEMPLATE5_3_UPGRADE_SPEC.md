# TEMPLATE5_3_UPGRADE_SPEC.md

## Mục tiêu

Tài liệu này là **upgrade specification** để AI coding agent cập nhật các file Markdown template hiện tại của pipeline Template 5.

Mục tiêu không phải chỉ “viết prompt hay hơn”, mà là sửa kiến trúc để giải quyết đồng thời:

1. **Sai / drift hình ảnh khi gen video**
2. **Hành động sản phẩm bị hallucinate hoặc sai cơ chế**
3. **Panel 2 / Panel 4 không thật sự trở thành start frame tại mốc 4s**
4. **Voice giữa các video không đồng nhất**
5. **Voice nói chậm, thiếu chữ khi script dài**
6. **Thông tin sản phẩm có thể leak từ run/product khác**
7. **Storyboard tự nghĩ hành động mà input không có bằng chứng hình ảnh**
8. **Prompt Veo quá dài, lặp và có nhiều instruction cạnh tranh nhau**

---

# 1. Kết luận sau khi phân tích nhiều run thực tế

## 1.1. Vấn đề không nằm ở một câu prompt đơn lẻ

Pipeline hiện tại đang dùng một generation 8 giây để làm đồng thời:

- 0–4s: bắt đầu từ Panel A
- 4–8s: “bắt đầu lại” từ Panel B
- tham chiếu Master Storyboard
- tham chiếu input sản phẩm
- giữ chính xác product identity
- tự tạo action vật lý
- giữ environment
- tạo voice
- đọc đủ thoại
- đọc nhanh
- giữ voice giống generation tiếp theo

Đây là quá nhiều nhiệm vụ trong cùng một generation.

**Không nên tiếp tục sửa bằng cách chỉ thêm nhiều câu lệnh vào prompt hiện tại.**

Cần thay đổi pipeline.

---

# 2. Bằng chứng từ các output đã kiểm tra

## 2.1. Case XCUP

### Scene có first-frame trực tiếp
Panel 1 là chiếc bình inox cũ trên bàn/vở.

Output giữ tương đối tốt:
- composition
- bàn tay
- vật thể
- bối cảnh

### Scene thứ hai nằm giữa generation
Panel 2 là XCUP trên bàn picnic ngoài trời.

Output lại có tendency:
- tái dựng background khác
- thay đổi composition
- không bắt đầu chính xác từ Panel 2 tại 4.0s

Kết luận:

> Text “bắt đầu chính xác từ Panel 2 tại 4 giây” không đủ để biến Panel 2 thành một hard start-frame constraint ở giữa cùng một generation.

---

## 2.2. Case XCUP — action phức tạp

Panel 3 yêu cầu:
- mở nắp
- nhìn thấy ruột inox
- thấy chi tiết 316
- có thao tác dốc ngược

Output hiểu được semantic action, nhưng các chi tiết nhỏ / cấu tạo có thể bị tái dựng.

Kết luận:

> Khi action làm lộ ra một trạng thái mới của sản phẩm, trạng thái đó phải có visual evidence rõ ràng. Nếu không, model buộc phải hallucinate phần cấu tạo bị che khuất.

---

## 2.3. Case đèn đội đầu F37

Input có nhiều bằng chứng tốt:
- dây đeo
- khớp xoay 90°
- USB-C
- nút nguồn
- mặt đèn
- kích thước
- các state sản phẩm

Storyboard 4 panel khá nhất quán về product identity.

Nhưng video output vẫn cho thấy:

### Video 1
- 0s bám Panel 1 tương đối tốt
- qua thời gian model tự biến đổi góc nhìn / cấu trúc
- đến 4s không có một hard reset chính xác vào Panel 2
- Scene 2 giống “tiếp tục generation” hơn là “Panel 2 bắt đầu chính xác”

### Video 2
- 0s bám semantic của Panel 3
- chi tiết khớp, USB-C, vị trí tay có thể thay đổi
- 4–8s chuyển sang bàn / sản phẩm nhưng Panel 4 vẫn không phải hard start frame

Kết luận tương tự XCUP:

> Một image reference ở giữa prompt không tương đương với một start frame thực tế tại timestamp giữa clip.

---

# 3. Quyết định kiến trúc mới

## 3.1. Không còn coi “2 video x 8s, mỗi video chứa 2 hard start frames” là mode chất lượng cao

Thay bằng hai mode.

---

# 4. MODE A — QUALITY_LOCKED (DEFAULT RECOMMENDED)

Đây là mode mặc định cho production faceless product review.

```text
FINAL VIDEO 16s

Panel 1 → Veo Shot 1 = 4s
Panel 2 → Veo Shot 2 = 4s
Panel 3 → Veo Shot 3 = 4s
Panel 4 → Veo Shot 4 = 4s

4 shots
   ↓
concat
   ↓
master voice / narration
   ↓
final mix
```

## Lợi ích

- Mỗi Panel thật sự là start frame của một generation riêng
- Không cần model “reset” ở giữa 8 giây
- Action mỗi shot đơn giản hơn
- Product fidelity cao hơn
- Reference image có vai trò rõ ràng
- Dễ retry riêng shot lỗi
- Dễ validate
- Dễ map voice theo timeline
- Không cần Veo duy trì cùng voice qua nhiều generation nếu dùng master narration ngoài

---

# 5. MODE B — VEO_NATIVE_FAST (FALLBACK / EXPERIMENTAL)

Giữ pipeline:

```text
Video 1 = 8s = Scene 1 → Scene 2
Video 2 = 8s = Scene 3 → Scene 4
```

Mode này chỉ dùng khi:
- muốn native Veo voice
- muốn native sound/performance
- chấp nhận visual scene 2 / 4 chỉ là soft reference
- chấp nhận voice consistency là best-effort

Không được mô tả mode này là “exact frame accurate”.

---

# 6. Thay đổi lớn #1 — PRODUCT FACT LOCK

Trước khi storyboard, phải có Product Fact Extraction.

Output dạng:

```json
{
  "productName": "...",
  "verifiedFacts": [],
  "visualFacts": [],
  "unsupportedClaims": [],
  "sourceEvidence": []
}
```

## Rule

Mọi:
- marketingAnswer
- visualDescription
- handInteraction
- dialogue
- CTA fact

phải chỉ dùng `verifiedFacts`.

Không được:
- reuse text từ run trước
- dùng fact của sản phẩm khác
- tự tạo material / feature / duration / certification
- suy đoán cơ chế bên trong

Nếu không đủ dữ liệu:
- viết generic nhưng đúng
- không invent

---

# 7. Thay đổi lớn #2 — VISUAL EVIDENCE MATRIX

Sau Product Fact Lock, tạo một inventory riêng cho hình ảnh.

Ví dụ:

```json
{
  "states": {
    "fullProductFront": {
      "available": true,
      "referenceIds": ["input_crop_01"]
    },
    "powerButton": {
      "available": true,
      "referenceIds": ["input_crop_02"]
    },
    "usbCPort": {
      "available": true,
      "referenceIds": ["input_crop_03"]
    },
    "hinge90Degree": {
      "available": true,
      "referenceIds": ["input_crop_04"]
    },
    "headStrap": {
      "available": true,
      "referenceIds": ["input_crop_05"]
    }
  }
}
```

## Action feasibility rule

Storyboard chỉ được yêu cầu một action nếu:

```text
ACTION_STATE_VISIBLE_IN_REFERENCE = true
```

Ví dụ:

```text
open lid
→ cần ảnh open state / interior
```

```text
rotate 90 degrees
→ cần ảnh hoặc evidence thể hiện khớp xoay
```

```text
press button
→ cần thấy button
```

```text
plug USB-C
→ cần thấy port
```

Nếu không có evidence:

```text
DO NOT GENERATE COMPLEX ACTION
```

Thay bằng:
- pick up
- hold
- rotate slightly
- place on surface
- point to visible detail

---

# 8. Thay đổi lớn #3 — REFERENCE EXTRACTION

Không đưa nguyên marketing sheet phức tạp vào mọi Veo request nếu có thể tránh.

Input có:
- text
- infographic
- nhiều state
- nhiều variant
- nhiều callout

Cần preprocessing:

```text
RAW INPUT
   ↓
REFERENCE EXTRACTOR
   ↓
clean crops
```

Ví dụ:

```text
product_identity.png
product_front.png
product_button.png
product_port.png
product_hinge.png
product_strap.png
```

Không AI-redraw các crop này.

Chỉ crop / extract trực tiếp từ source.

---

# 9. Thay đổi lớn #4 — REFERENCE ROLES

Mỗi image đưa cho video generator phải có role cụ thể.

Không dùng chung chung:

```text
“tham chiếu chặt chẽ cả 4 hình”
```

Thay bằng:

```json
{
  "firstFrame": "panel_2",
  "productIdentityRef": "product_identity",
  "actionStateRef": "product_button",
  "optionalEnvironmentRef": null
}
```

## Priority

```text
1. FIRST FRAME
2. PRODUCT IDENTITY REFERENCE
3. ACTION STATE REFERENCE
4. SCENE TEXT
5. GENERAL STYLE
```

Nếu text conflict với visual evidence:
- visual evidence thắng

---

# 10. Thay đổi lớn #5 — MASTER STORYBOARD KHÔNG PHẢI VIDEO REF MẶC ĐỊNH

Master Storyboard dùng để:

```text
plan
→ generate 4 panels
→ split panels
```

Sau khi đã có individual panels:

**không gửi Master Storyboard vào mỗi shot Veo theo mặc định.**

Lý do:
- tạo thêm competing visual states
- model phải tự suy luận panel nào quan trọng
- tăng khả năng drift

Chỉ dùng Master Storyboard nếu provider/API có một use-case rõ ràng và test chứng minh tốt hơn.

Default:

```text
SHOT N INPUTS:
- Panel N
- Product identity reference
- Relevant action-state reference
```

---

# 11. Thay đổi lớn #6 — ONE PANEL = ONE ATOMIC SHOT

Trong `QUALITY_LOCKED`:

```text
Panel 1 = Shot 1
Panel 2 = Shot 2
Panel 3 = Shot 3
Panel 4 = Shot 4
```

Mỗi shot:
- một start frame
- một action chính
- một camera intent
- tối đa 1–2 relevant references

Không yêu cầu 3–4 thao tác phức tạp trong 4 giây.

---

# 12. ACTION COMPLEXITY BUDGET

Mỗi shot có complexity score.

## SAFE

```text
hold product
lift product
place product
point to visible feature
press one visible button
slight rotation
put product into bag
wear product
```

## MEDIUM

```text
open lid
close lid
adjust hinge
attach simple strap
plug a visible cable
```

Chỉ dùng nếu có state reference.

## HIGH RISK

```text
disassemble
reassemble
transform
show hidden mechanism
open multiple compartments
demonstrate internal moving parts
prove leak-proof by inversion
complex installation
```

High risk:
- require explicit reference sequence
- otherwise reject and replace action

---

# 13. STORYBOARD GENERATION PHẢI “REFERENCE-AWARE”

Câu hỏi cũ:

```text
Bằng chứng nào khiến họ tin?
```

Câu hỏi mới:

```text
Bằng chứng nào khiến họ tin VÀ có thể biểu diễn chính xác từ visual evidence hiện có?
```

Flow:

```text
Marketing goal
     ↓
Candidate visual proof
     ↓
Visual evidence exists?
    / \
  YES  NO
   |    |
 use   replace
```

---

# 14. STORYBOARD CONTINUITY LOCK

Tất cả Panel phải share:

```json
{
  "environmentId": "ENV_001",
  "handModelId": "HAND_001",
  "lightingId": "LIGHT_001",
  "productIdentityId": "PRODUCT_001",
  "cameraStyleId": "CAMERA_PHONE_001"
}
```

Không cho scene planner rewrite các global identity fields.

Scene chỉ override:
- framing
- hand action
- product state
- composition

---

# 15. VIDEO PROMPT BUILDER MỚI

Không còn tạo một paragraph khổng lồ.

Prompt được assemble từ immutable blocks:

```text
PRODUCT LOCK
+
REFERENCE ROLE BLOCK
+
FIRST FRAME BLOCK
+
ACTION BLOCK
+
CAMERA BLOCK
+
CONTINUITY BLOCK
+
NEGATIVE BLOCK
+
AUDIO BLOCK
```

---

# 16. VÍ DỤ PROMPT SHOT CHO F37

```text
PRODUCT IDENTITY LOCK:
This is the exact same black-and-purple F37 headlamp shown in the supplied product reference.
Do not redesign its body, lens, hinge, strap, USB-C port or button layout.

FIRST FRAME:
Use the supplied Panel 2 image as the exact visual starting frame for this shot.

REFERENCE ROLES:
- Panel 2 = first-frame composition and hand placement.
- Product identity crop = exact product shape, colors and surface design.
- Power-button crop = exact button geometry and location.

ACTION:
The index finger performs one natural press on the visible power button.
The product remains in the same hand and same orientation.
Do not rotate or transform the lamp.

CAMERA:
Close smartphone product shot.
Mostly locked camera.
Only subtle natural handheld micro-motion.

CONTINUITY:
Preserve the same room, light direction, hand appearance and product geometry.

DO NOT:
- invent extra buttons
- change the hinge
- change the strap
- change the purple ring
- change the reflector
- add text
- add logos
- add graphics
- show a face

AUDIO:
No spoken dialogue in QUALITY_LOCKED mode.
Only subtle handling ambience if available.
```

---

# 17. VOICE STRATEGY

Có hai voice modes.

---

## 17.1. VOICE MODE A — MASTER_NARRATION

Recommended cho faceless product review.

```text
FULL SCRIPT 16s
   ↓
ONE TTS REQUEST
   ↓
master_voice.wav
   ↓
duration validation
   ↓
optional light time-compression
   ↓
mix over final visual
```

### Mục đích

Giải quyết:
- speaker identity drift
- cadence reset
- tone đổi giữa generation
- thiếu chữ cuối
- speaking speed khó kiểm soát

### Quan trọng

Master narration KHÔNG dùng để lip-sync người nhìn thấy mặt.

Nó phù hợp vì Template 5 hiện tại là:

```text
FACELESS + VOICE-OVER
```

---

# 18. VOICE MODE B — VEO_NATIVE

Dùng khi muốn:
- native dialogue
- visible presenter
- native talking performance
- hoặc muốn thử kiểu TikTok presenter

Voice profile phải được tạo một lần rồi copy nguyên văn.

```json
{
  "voiceId": "VEO_PROFILE_001",
  "language": "vi-VN",
  "gender": "female",
  "accent": "southern_vietnamese",
  "timbre": "bright_sweet_youthful",
  "pitch": "medium_high",
  "delivery": "rapid_fire_tiktok_commerce",
  "energy": "high",
  "pauses": "minimal"
}
```

Nhưng cần ghi rõ trong template:

> Native Veo voice consistency across independent generations is best-effort, not deterministic voice identity locking.

---

# 19. KHÔNG DÙNG `MAX 42 WORDS / 8s`

Rule này phải xóa khỏi template.

Thay bằng speech duration budget.

Ví dụ Native 8s:

```json
{
  "videoDuration": 8.0,
  "speechStartTarget": 0.15,
  "speechEndTarget": 7.0,
  "safetyMargin": 1.0
}
```

Dialogue phải được viết theo:
- spoken Vietnamese
- short clauses
- minimal formal copy
- rapid delivery friendly

Không tối ưu theo số từ đơn thuần.

---

# 20. MASTER NARRATION TIMING MAP

Audio và visual là hai timeline riêng.

```text
0────4────8────12────16
| P1 | P2 | P3 | P4 |

VOICE:
━━━━━━━━━━━━━━━━━━━━━━
```

Script planner tạo semantic map:

```json
{
  "segments": [
    {
      "time": "0-4",
      "phase": "hook",
      "visual": "problem",
      "speechMeaning": "problem"
    },
    {
      "time": "4-8",
      "phase": "solution",
      "visual": "product use",
      "speechMeaning": "solution"
    },
    {
      "time": "8-12",
      "phase": "proof",
      "visual": "verified feature",
      "speechMeaning": "proof"
    },
    {
      "time": "12-16",
      "phase": "closing",
      "visual": "lifestyle",
      "speechMeaning": "CTA"
    }
  ]
}
```

Voice không cần pause đúng mốc 4/8/12s.

Natural speech có thể bridge qua cut.

---

# 21. SCRIPT DURATION VALIDATOR

Nếu dùng Master Narration:

```text
Generate script
   ↓
TTS
   ↓
measure duration
```

Target:

```text
14.2s – 15.3s
```

cho final 16s.

Nếu > 15.3s:

```text
1. Rewrite shorter
2. TTS again
3. If still slightly long, time-compress lightly
```

Không:
- cắt cuối audio
- drop words
- ép một script 20–25s xuống 15s

---

# 22. PRODUCT CLAIM VS VISUAL DEMONSTRATION

Template phải phân biệt:

```text
TEXT FACT
```

và:

```text
VISUALLY DEMONSTRABLE FACT
```

Ví dụ:
- “pin 1200mAh” có thể là verified text fact
- nhưng không thể “nhìn thấy 1200mAh” trong video nếu không có visual state phù hợp

Voice có thể nói fact nếu verified.

Visual không được tự hallucinate proof.

---

# 23. CTA RULE

Không hardcode:

```text
bấm giỏ hàng góc trái
```

trong mọi product.

CTA phải là separate field:

```json
{
  "ctaMode": "platform_generic",
  "ctaText": "Xem thử trong giỏ hàng nha"
}
```

Nếu platform position không guaranteed:
- không nói “góc trái”
- không yêu cầu tay chạm vào vị trí UI giả

---

# 24. FACELESS RULE

Nếu mode là faceless:

Không viết scene như:

```text
nữ sinh mỉm cười
```

vì nó conflict với:
- no face

Thay bằng:

```text
torso-only lifestyle shot
hands place product into backpack
face remains fully out of frame
```

Validation phải reject mọi scene chứa:
- smile
- facial expression
- eye contact
- looks at camera

khi `faceless=true`.

---

# 25. IMAGE GENERATION IMPROVEMENT

Storyboard image generator không nên chỉ tạo “đẹp”.

Nó phải tạo frame **video-friendly**.

Panel cần:

- product fully readable
- hand position physically plausible
- action start state rõ
- không pose tay gây khó animate
- không che joint/button/port cần dùng
- không tạo product state impossible
- đủ room cho action tiếp theo

Thêm field:

```json
{
  "animationReadiness": {
    "actionStartStateVisible": true,
    "requiredControlVisible": true,
    "handPoseFeasible": true,
    "hiddenGeometryRequired": false
  }
}
```

---

# 26. PRE-STORYBOARD VALIDATION

```json
{
  "productFactsReady": true,
  "visualEvidenceReady": true,
  "productIdentityReferenceReady": true,
  "actionStatesMapped": true
}
```

Nếu false:
- không generate storyboard

---

# 27. PRE-VIDEO VALIDATION

Mỗi shot phải pass:

```json
{
  "firstFrameAssigned": true,
  "productIdentityRefAssigned": true,
  "actionRefAssignedIfNeeded": true,
  "actionSupportedByEvidence": true,
  "singlePrimaryAction": true,
  "productFactsCurrentRunOnly": true,
  "facelessCompatible": true,
  "noUnsupportedVisibleDetail": true
}
```

---

# 28. POST-VIDEO VALIDATION

Sau Veo output, đánh giá riêng từng shot.

Check:

```text
Product identity
Action correctness
Start-frame similarity
Hand anatomy
Background continuity
Forbidden text
Product geometry
Feature accuracy
```

Nếu một shot fail:
- retry riêng shot đó
- không regenerate toàn bộ 16s

Đây là lợi ích lớn của atomic-shot architecture.

---

# 29. RETRY STRATEGY

Retry không dùng y hệt prompt.

Phải derive failure reason.

Ví dụ:

```json
{
  "failure": "hinge_geometry_drift",
  "retryOverride": [
    "No hinge rotation except supplied joint",
    "Keep exact reference hinge geometry",
    "Reduce action amplitude",
    "Lock camera"
  ]
}
```

---

# 30. FILE TEMPLATE CHANGES REQUIRED

AI coding agent cần tìm toàn bộ file `.md` liên quan đến Template 5 và update theo các nhóm sau.

## A. Storyboard Template

Add:
- Product Fact Lock
- Visual Evidence Matrix
- Reference-aware scene planning
- Action complexity budget
- Animation readiness
- Faceless semantic validation
- Global continuity IDs

Remove / rewrite:
- generic visual actions without evidence
- “creative proof” not grounded in references
- facial expression instructions when faceless

---

## B. Video Prompt Template

Replace current large paragraph with modular blocks.

Add:
- explicit firstFrame role
- productIdentityRef
- actionStateRef
- reference priority
- atomic shot mode
- action evidence rule
- audio mode
- concise negative rules

Remove in QUALITY_LOCKED:
- two-scene 0–4 / 4–8 structure inside one generation
- Master Storyboard as generic reference
- native dialogue requirement
- max 42 words

---

## C. Voice Template

Create a separate template.

Fields:

```json
{
  "voiceMode": "MASTER_NARRATION | VEO_NATIVE",
  "voiceProfile": {},
  "fullScript": "",
  "timingMap": [],
  "durationTarget": {},
  "validation": {}
}
```

---

## D. Product Analysis Template

Add two distinct outputs:

```text
FACT KNOWLEDGE
VISUAL EVIDENCE KNOWLEDGE
```

Do not merge them.

---

## E. Run Output Template

Current run MD should expose:

```text
Product Fact Lock
Visual Evidence Matrix
Reference Crops
Storyboard
Panel Metadata
Shot Specs
Voice Plan
Final Veo Prompts
Validation Results
```

This makes debugging possible.

---

# 31. TARGET RUN FILE FORMAT

New run `.md` should resemble:

```markdown
# Template 5 Run

## Product
...

## Product Fact Lock
...

## Visual Evidence Matrix
...

## Global Visual Lock
...

## Voice Mode
MASTER_NARRATION

## Voice Profile
...

## Full 16s Script
...

## Semantic Timing Map
...

## Storyboard Prompt
...

## Panel 1 Metadata
- phase
- first frame
- action
- refs
- evidence

## Shot 1 Veo Prompt
...

## Panel 2 Metadata
...

## Shot 2 Veo Prompt
...

## Panel 3 Metadata
...

## Shot 3 Veo Prompt
...

## Panel 4 Metadata
...

## Shot 4 Veo Prompt
...

## Validation
...
```

---

# 32. MIGRATION FROM TEMPLATE5_2

## Old

```text
Product
↓
Storyboard 4 panels
↓
slice into 2 images
↓
Veo 8s: Panel 1 → Panel 2 + voice
Veo 8s: Panel 3 → Panel 4 + voice
```

## New default

```text
Product Inputs
↓
Fact Extraction
↓
Visual Evidence Extraction
↓
Reference Crop Extraction
↓
Storyboard 4 panels
↓
Split 4 panels
↓
Shot 1 4s
Shot 2 4s
Shot 3 4s
Shot 4 4s
↓
Concat
↓
Master Narration
↓
Final Mix
```

---

# 33. IMPORTANT — DO NOT OVERFIT TO XCUP OR F37

Các case XCUP và F37 chỉ là test evidence.

Template phải áp dụng được cho:
- home
- beauty
- fashion
- electronics
- kitchen
- accessories
- tools
- lifestyle
- pet products
- general e-commerce products

Không hardcode:
- bottle
- lamp
- lid
- backpack
- button
- USB-C

Dùng generic concepts:

```text
product state
action state
visible feature
mechanical state
usage state
evidence reference
```

---

# 34. AGENT IMPLEMENTATION ORDER

AI agent phải update theo thứ tự sau:

1. Product Fact Extraction
2. Visual Evidence Matrix
3. Reference Crop logic / reference metadata
4. Storyboard planner
5. Panel metadata format
6. QUALITY_LOCKED shot prompt builder
7. VEO_NATIVE fallback builder
8. Voice plan
9. Validation gates
10. Run MD output
11. Retry logic
12. Regression tests

Không bắt đầu bằng việc chỉnh câu chữ Veo prompt.

---

# 35. REGRESSION TESTS

## Test A — XCUP

Expected:

- Panel 1: old bottle / leak problem
- Panel 2: exact XCUP identity
- Panel 3: 316 interior only if evidence available
- Panel 4: backpack usage
- no face
- no product redesign
- no unsupported internal geometry

---

## Test B — F37 headlamp

Expected:

- exact black/purple body
- exact large reflector/front ring
- button state reference
- USB-C state reference
- hinge action only if visible evidence supports it
- strap stays consistent
- no new buttons
- no geometry mutation

---

# 36. ACCEPTANCE CRITERIA

Upgrade chỉ được coi là hoàn thành khi:

### Visual
- mỗi shot bắt đầu từ đúng assigned Panel
- product identity không drift rõ rệt
- action không tạo cơ chế mới
- action phức tạp có reference state
- không dùng Master Storyboard như generic noisy reference
- retry được từng shot

### Voice
- có separate voice strategy
- không còn hardcoded 42 words / 8s
- Master Narration hỗ trợ one-pass script cho faceless
- Native mode có Voice Performance Lock
- script được duration validate

### Data safety
- không leak product facts giữa run
- unsupported claims bị chặn
- visual demonstration phải evidence-aware

### Prompt quality
- prompt modular
- ít lặp
- reference roles rõ
- priority rõ
- không conflict faceless / facial action

---

# 37. FINAL DESIGN PRINCIPLE

Pipeline phải tuân theo nguyên tắc:

> **Không yêu cầu video model tưởng tượng một product state mà hệ thống có thể cung cấp reference cho nó.**

và:

> **Một frame cần chính xác tại một timestamp quan trọng thì frame đó phải là start frame của một atomic generation, không chỉ là một câu mô tả trong prompt.**

và:

> **Voice consistency và visual consistency là hai bài toán riêng. Không ép một Veo generation giải quyết cả hai nếu workflow có thể tách chúng ra.**

---

# 38. KẾT LUẬN CHO AI CODING AGENT

Không “patch” TEMPLATE5_2 bằng cách thêm vài prompt instructions.

Hãy migrate Template 5 sang architecture:

```text
EVIDENCE-FIRST
+
ATOMIC SHOTS
+
EXPLICIT REFERENCE ROLES
+
VOICE MODES
+
VALIDATION GATES
```

Default production path:

```text
QUALITY_LOCKED
= 4 x 4-second visually grounded shots
+ one continuous master narration for faceless video
+ final compositing
```

Fallback:

```text
VEO_NATIVE_FAST
= 2 x 8-second native-audio generations
+ best-effort cross-generation voice consistency
```

Mọi template file, output schema và prompt builder phải phản ánh distinction này rõ ràng.
