# TEMPLATE PRO --- STORYBOARD → VEO START-FRAME MIGRATION SPEC v2

## 0. Mục tiêu

Tài liệu này là specification để AI coding agent **update Template Pro
`/tpro`** dựa trên:

1.  Hai execution log được cung cấp (`prompt(1).md` và `prompts(1).md`).
2.  Storyboard 4 panel thực tế của run ô Nason G30.
3.  Lỗi đã quan sát ở pipeline trước: JSON Step 1 có thể hỏng/truncated
    nhưng pipeline vẫn tiếp tục; storyboard QA có thể fallback cùng một
    điểm cho mọi candidate; action được tạo quá generic; prompt Veo
    Start Frame có xu hướng mô tả lại quá nhiều appearance/identity thay
    vì tập trung vào motion.
4.  Case khác đã quan sát: prompt video sản phẩm tã từng sinh action sai
    semantic như **"mở nắp sản phẩm"**, chứng minh cần Product
    Affordance Validation trước khi tạo storyboard/video prompt.

> Đây là **template đa ngành hàng**. Không hard-code logic cho ô, tã, mẹ
> & bé hay bất kỳ sản phẩm cụ thể nào.

------------------------------------------------------------------------

# 1. Kết luận quan trọng từ run hiện tại

## 1.1 Hai file log là cùng một run

Hai file đầu vào hiện chứa cùng execution log `4k5x6j`, cùng sản phẩm
Nason G30 và cùng pipeline. Vì vậy agent không được coi đây là hai
experiment độc lập.

## 1.2 Step 1 hiện có lỗi fatal nhưng pipeline không dừng

Gemini Raw Response trong log bị malformed/truncated:

``` text
"product{
  "analysis": {
```

Sau đó `script` không parse được và hệ thống ghi:

``` text
Panel 1 = N/A / 0 từ
Panel 2 = N/A / 0 từ
Panel 3 = N/A / 0 từ
Panel 4 = N/A / 0 từ
```

Nhưng Step 2 vẫn chạy storyboard.

Đây là lỗi kiến trúc.

### BẮT BUỘC

``` text
STEP 1
  ↓
JSON parse
  ↓
Schema validation
  ↓
Semantic validation
  ↓
Scene validation
  ↓
Action validation
  ↓
PASS?
  ├─ NO → repair/regenerate
  └─ YES → storyboard
```

**Không được phép storyboard generation nếu script/action data đang N/A,
rỗng hoặc invalid.**

------------------------------------------------------------------------

# 2. Vấn đề lớn nhất: pipeline đang trộn 3 loại thông tin

Hiện template đang để các khái niệm như:

``` text
visualDescription
techVFX
handInteraction
cameraAction
```

quá generic.

Agent phải tách thành 3 lớp độc lập:

``` text
A. APPEARANCE / START-FRAME STATE
B. MOTION / ACTION PLAN
C. VEO MOTION PROMPT
```

## A --- Appearance

Dùng để tạo storyboard Start Frame:

-   sản phẩm trông như thế nào,
-   đang ở trạng thái nào,
-   tay/người đang ở đâu,
-   camera composition,
-   background,
-   ánh sáng.

## B --- Motion

Mô tả hành động vật lý sẽ xảy ra **sau Start Frame**.

Ví dụ:

``` text
startState:
umbrella is already fully open

primaryMotion:
gently tilt the open umbrella

endState:
umbrella remains open, canopy clearly visible
```

## C --- Veo Prompt

Chỉ chuyển Motion Plan thành prompt ngắn cho image-to-video.

**Không copy toàn bộ storyboard prompt vào Veo.**

------------------------------------------------------------------------

# 3. Nguyên tắc trung tâm mới

``` text
START FRAME = APPEARANCE SOURCE OF TRUTH
VEO PROMPT = MOTION INSTRUCTION
```

Storyboard chịu trách nhiệm cho:

-   identity,
-   product appearance,
-   wardrobe,
-   room,
-   lighting,
-   product state,
-   composition.

Veo prompt chịu trách nhiệm chủ yếu cho:

-   subject motion,
-   product motion,
-   camera motion,
-   expression change nếu cần,
-   ending state.

Không bắt Veo "reconstruct" lại toàn bộ ảnh bằng text.

------------------------------------------------------------------------

# 4. PRODUCT AFFORDANCE ENGINE --- bắt buộc thêm

Trước khi tạo 4 scene, Gemini phải phân tích **sản phẩm có thể được thao
tác vật lý như thế nào**.

Schema mới:

``` json
{
  "productAffordance": {
    "productType": "umbrella",
    "states": [
      "closed",
      "unfastened",
      "opening",
      "fully_open",
      "closing"
    ],
    "validActions": [
      "hold_handle",
      "rotate_handle",
      "press_open_button",
      "open",
      "tilt_open_canopy",
      "inspect_rib",
      "close",
      "lean_against_stand",
      "pick_up"
    ],
    "invalidActions": [
      "open_lid",
      "pour",
      "twist_cap"
    ],
    "fragileActions": [
      "forcefully_bend_rib"
    ]
  }
}
```

Đối với tã:

``` json
{
  "productType": "baby_diaper",
  "validActions": [
    "pick_up",
    "unfold",
    "press_inner_surface",
    "show_thickness",
    "gently_stretch_waistband",
    "fold"
  ],
  "invalidActions": [
    "open_lid",
    "press_power_button",
    "pour"
  ]
}
```

### Hard validation

Nếu scene action không thuộc `validActions` hoặc không hợp trạng thái
sản phẩm:

``` text
REJECT SCENE PLAN
→ regenerate action
```

Không được để action generic kiểu:

``` text
"thao tác các tính năng chính"
"thao tác tay thực tế"
"cầm và sử dụng sản phẩm"
```

Mọi action phải **cụ thể, nhìn thấy được và animate được**.

------------------------------------------------------------------------

# 5. PRODUCT STATE MACHINE

Agent phải thêm `startState`, `transition`, `endState`.

Ví dụ ô:

``` json
{
  "startState": "fully_open",
  "primaryAction": "tilt_open_canopy",
  "endState": "fully_open"
}
```

Không được tạo contradiction như:

``` text
Start Frame: umbrella already fully open
Video Prompt: opens the umbrella
```

Nếu muốn quay hành động mở ô thì storyboard phải tạo Start Frame ở trạng
thái:

``` text
closed/unfastened
```

hoặc ngay trước thời điểm mở.

------------------------------------------------------------------------

# 6. ACTION RUNWAY --- storyboard phải phục vụ video

Storyboard không chỉ cần đẹp. Nó phải là **frame 0 tốt cho video**.

Mỗi panel cần đánh giá:

``` text
Can this still image naturally continue into the planned motion?
```

Schema:

``` json
{
  "actionRunway": {
    "startPoseSupportsMotion": true,
    "requiredRepositioning": "none",
    "motionComplexity": "low",
    "occlusionRisk": "low",
    "notes": "..."
  }
}
```

Hard reject nếu:

-   action đã hoàn tất trong Start Frame nhưng video lại yêu cầu làm lại
    action,
-   tay ở quá xa vị trí cần thao tác,
-   sản phẩm ở trạng thái không thể tiếp tục action,
-   action yêu cầu teleport/reposition lớn ngay frame đầu,
-   composition không còn chỗ cho motion,
-   action sẽ làm sản phẩm ra khỏi crop.

------------------------------------------------------------------------

# 7. Phân tích storyboard Nason G30 hiện tại

Storyboard hiện tại có 4 trạng thái trực quan tốt về product fidelity
nhưng **không phải panel nào cũng tối ưu cho motion**.

## Panel 1

Quan sát:

``` text
close-up cán gỗ + tay cầm
ô đang đóng
khắc tên nổi bật
```

Motion phù hợp:

``` text
slowly rotate handle
slightly adjust grip
trace/turn handle to reveal engraving
subtle camera push-in
```

Không nên:

``` text
suddenly open umbrella
large body movement
invent another mechanism
```

## Panel 2

Quan sát:

``` text
ô đã mở hoàn toàn
người cầm ô
```

Motion phù hợp:

``` text
gently tilt open umbrella
small wrist adjustment
subtle canopy movement
slow camera push-in
```

Không nên:

``` text
open umbrella
```

vì Start Frame đã ở `fully_open`.

## Panel 3

Quan sát:

``` text
macro mặt dưới ô
tay đang gần/chạm nan
```

Motion phù hợp:

``` text
lightly touch/trace one rib
small finger movement
very subtle camera drift
```

Không nên:

``` text
forcefully bend rib
rebuild/open canopy
large hand movement
```

## Panel 4

Quan sát:

``` text
ô đóng
đặt tựa cạnh giá
tay người ở gần cán
```

Motion phù hợp:

``` text
gently grasp handle
slightly lift/reposition umbrella
small camera push-in
```

Không nên bắt đầu bằng một action lớn nếu Start Frame không có đủ
runway.

------------------------------------------------------------------------

# 8. Storyboard scene schema mới

Thay:

``` json
{
  "visualDescription": "...",
  "techVFX": "...",
  "cameraAction": "..."
}
```

bằng:

``` json
{
  "id": 1,
  "phase": "Hook",
  "goal": "...",
  "voiceOver": "...",

  "startFrame": {
    "productState": "...",
    "composition": "...",
    "humanPose": "...",
    "handPose": "...",
    "cameraFraming": "...",
    "environment": "...",
    "lighting": "..."
  },

  "motionPlan": {
    "primaryAction": "...",
    "secondaryMotion": "...",
    "productMotion": "...",
    "humanMotion": "...",
    "cameraMotion": "...",
    "endState": "...",
    "motionComplexity": "low|medium|high"
  },

  "actionRunway": {
    "valid": true,
    "reason": "..."
  }
}
```

------------------------------------------------------------------------

# 9. ONE PRIMARY MOTION PER CLIP

Veo clip ngắn không nên chứa chuỗi action phức tạp.

Rule:

``` text
ONE CLIP
=
ONE PRIMARY PHYSICAL ACTION
+
OPTIONAL SUBTLE SECONDARY MOTION
```

Good:

``` text
primary: unfold diaper
secondary: small camera push-in
```

Bad:

``` text
pick up diaper
→ open package
→ unfold
→ stretch
→ press surface
→ smile at camera
→ place down
```

------------------------------------------------------------------------

# 10. MOTION COMPLEXITY SCORE

Trước Veo generation, tính complexity:

``` text
LOW
- one hand/object
- small displacement
- no identity-heavy interaction
- no large occlusion

MEDIUM
- two hands
- product deformation/opening
- one person + object
- moderate camera movement

HIGH
- two people touching
- adult holding baby
- face-to-face interaction
- heavy occlusion
- multiple simultaneous actions
- complex articulated mechanism
```

Rule:

``` text
HIGH complexity
→ simplify motion before sending to Veo
```

Đặc biệt scene có nhiều người:

``` text
prefer animate current pose
rather than create a new pose
```

------------------------------------------------------------------------

# 11. STORYBOARD PROMPT UPDATE

Giữ các ưu tiên tốt hiện có:

``` text
1. Product Fidelity
2. Scene Accuracy
3. Commercial Composition
4. Visual Consistency
```

Nhưng thêm Priority mới:

``` text
VIDEO START-FRAME READINESS
```

Thứ tự đề xuất:

``` text
1. Product Fidelity                30
2. Physical / Functional Accuracy 20
3. Start-Frame Action Readiness    20
4. Commercial Composition          15
5. Visual Consistency              10
6. Anatomy                          5
TOTAL                             100
```

------------------------------------------------------------------------

# 12. Không dùng generic component vocabulary một cách mù quáng

Prompt hiện tại dùng:

``` text
buttons, dials, handles, nozzles, ports, seams, lids, attachments
```

cho mọi sản phẩm.

Đây là mô tả template-level nhưng có nguy cơ gợi model invent component
không liên quan.

Thay bằng:

``` text
Preserve only the components that are visibly present in the supplied product references.
Do not invent controls, lids, ports, attachments, mechanisms, decorations, or accessories.
```

Product analysis phải sinh:

``` json
"visibleComponents": [
  "wooden handle",
  "metal collar",
  "shaft",
  "8 ribs",
  "black canopy"
]
```

Storyboard prompt dùng danh sách thật này.

------------------------------------------------------------------------

# 13. Evidence hierarchy

Không được nâng claim không có trong input thành fact.

Ví dụ log có metadata về `300T Pongee`, `8 nan`, `134cm`, nhưng Gemini
response lại thêm claim `UPF 50+`.

Nếu claim không có trong metadata/reference evidence:

``` text
DO NOT PROMOTE TO VERIFIED FACT
```

Schema:

``` json
{
  "evidence": {
    "verifiedFromMetadata": [],
    "verifiedVisually": [],
    "inferred": [],
    "unsupported": []
  }
}
```

Only `verifiedFromMetadata` + `verifiedVisually` được dùng như fact.

------------------------------------------------------------------------

# 14. Step 1 JSON Reliability Gate

Hiện run cho thấy malformed JSON nhưng pipeline vẫn chạy.

Bắt buộc:

``` text
Attempt 1: generate JSON
↓
parse
↓
invalid?
  YES → repair prompt
↓
parse again
↓
schema validate
↓
semantic validate
```

Suggested max:

``` text
3 attempts
```

Sau 3 lần:

``` text
FAIL RUN
```

Không fallback sang N/A.

------------------------------------------------------------------------

# 15. Semantic validation

Bắt buộc check:

``` text
script.length === 4
scene ids = 1,2,3,4
voiceOver non-empty
visual/startFrame non-empty
motionPlan.primaryAction non-empty
cameraMotion non-empty
productState valid
action belongs to valid product affordances
actionRunway.valid === true
```

Nếu fail:

``` text
do not call storyboard model
```

------------------------------------------------------------------------

# 16. Word-count rules phải có một source of truth

Log hiện có conflict:

``` text
Header:
30–36 words per panel

Prompt:
16–18 words per scene

Breakdown:
16–20 words / panel

Video:
60–72 words per 8s video
```

Đây là contradiction.

Agent phải tạo config duy nhất:

``` json
{
  "voiceTiming": {
    "sceneCount": 4,
    "sceneDurationSeconds": 4,
    "minWordsPerScene": 16,
    "maxWordsPerScene": 18,
    "minTotalWords": 65,
    "maxTotalWords": 70
  }
}
```

Tất cả:

-   prompt,
-   validator,
-   log,
-   UI,
-   TTS

đọc từ cùng config.

Không hard-code word budget ở nhiều nơi.

> Nếu project hiện tại đã chuyển duration khác, dùng config runtime làm
> source of truth; spec này sửa **sự không nhất quán**, không ép
> duration cũ.

------------------------------------------------------------------------

# 17. Storyboard candidate QA không được fake fallback score

Run hiện tại cho cả 4 candidate:

``` text
88/100
88/100
88/100
88/100
```

và ghi:

``` text
Default selection from unparsed response
```

Đây không phải QA thật.

Rule:

``` text
QA parse failed
≠
candidate passed
```

Nếu evaluator response không parse:

``` text
retry evaluator
```

Nếu vẫn fail:

``` text
mark QA_UNAVAILABLE
```

Không tự gán 88.

Không được ghi:

``` text
"passed with high consistency"
```

khi thực tế là fallback.

------------------------------------------------------------------------

# 18. Candidate evaluation output schema

``` json
{
  "candidateId": 1,
  "scores": {
    "productFidelity": 0,
    "physicalAccuracy": 0,
    "actionReadiness": 0,
    "composition": 0,
    "continuity": 0,
    "anatomy": 0
  },
  "panelScores": [
    {
      "panelId": 1,
      "score": 0,
      "issues": [],
      "actionRunwayValid": true
    }
  ],
  "total": 0,
  "decision": "PASS|REMAKE_PANEL|REJECT",
  "reason": "..."
}
```

------------------------------------------------------------------------

# 19. Panel remake logic

Nếu chỉ Panel 3 lỗi:

``` text
DO NOT regenerate all four panels by default.
```

Use:

``` text
selected storyboard
+
product refs
+
scene 3 specification
+
neighbor visual continuity
→ remake panel 3
```

Sau remake:

``` text
re-run QA for panel 3
+
cross-panel continuity
```

------------------------------------------------------------------------

# 20. Crop / slicing awareness

Current output:

``` text
1920 × 1080
4 panels
→ 480 × 1080 each
```

Đây là **4:9**, không phải 9:16.

Agent phải không gọi nhầm đây là vertical 9:16 frame.

Nếu final video generator chấp nhận 480×1080 thì giữ.

Nếu cần 9:16 thật:

``` text
607.5 × 1080 equivalent
```

và storyboard layout phải được thiết kế lại.

Do not stretch 480×1080 to 9:16.

------------------------------------------------------------------------

# 21. Safe composition zone

Vì storyboard sẽ bị cắt thành 4 panel:

``` text
all important product details
hands
faces if applicable
logos if intentionally preserved
```

phải nằm trong safe zone của từng 480px segment.

Không để object vượt panel boundary.

Không để một tay thuộc Panel 2 lọt sang Panel 3.

------------------------------------------------------------------------

# 22. VEO PROMPT BUILDER v2

## Không dùng lại prompt dài kiểu:

``` text
IDENTITY LOCK:
...
PRODUCT LOCK:
...
ACTION & PERFORMANCE:
...
REALISM:
...
STRICT NO...
```

cho mọi scene.

Thay bằng một motion-first builder.

Base:

``` text
Create a realistic {{duration}}-second smartphone video from the provided starting image.

SUBJECT MOTION:
{{humanMotion}}

PRODUCT MOTION:
{{productMotion}}

CAMERA:
{{cameraMotion}}

PERFORMANCE:
{{expressionOrGazeIfRelevant}}

ENDING STATE:
{{endState}}

Keep the motion subtle, continuous, natural, and physically plausible.

Silent scene.
```

------------------------------------------------------------------------

# 23. Veo prompt language

Tách language responsibility:

``` text
Gemini analysis / voice script:
Vietnamese

Storyboard generation:
English preferred

Veo motion prompt:
English preferred

TTS transcript:
Vietnamese
```

Không copy nguyên tiếng Việt dài từ Step 1 sang Veo.

------------------------------------------------------------------------

# 24. Không mô tả lại Start Frame nếu không cần

Avoid:

``` text
The product is black, has a wooden handle, eight ribs, ...
The room is...
The person wears...
```

nếu những thứ đó đã rõ trong Start Frame.

Use:

``` text
The person gently rotates the wooden handle while keeping the umbrella closed.
```

Appearance đã được ảnh cung cấp.

------------------------------------------------------------------------

# 25. Product lock mới --- behavioral, không encyclopedic

Thay:

``` text
Preserve exactly shape, color, material, components, count...
```

bằng:

``` text
The product retains its appearance throughout the motion.
```

Nếu product deform tự nhiên:

``` text
The diaper bends naturally while retaining its original design.
```

Nếu object static:

``` text
The product remains stationary and unchanged.
```

------------------------------------------------------------------------

# 26. Negative constraints

Không spam negative phrase trong main prompt.

Nếu provider/API hỗ trợ negative prompt field, tách:

``` text
text
subtitles
UI
duplicate objects
extra limbs
deformed hands
product morphing
```

Nếu không có negative field, thêm **một dòng ngắn cuối prompt**, không
tạo 10--20 câu `NO...`.

------------------------------------------------------------------------

# 27. Prompt cho Nason G30 từ storyboard hiện tại

## Panel 1

``` text
Create a realistic short smartphone product-review video from the provided starting image.

The hand slowly rotates the closed umbrella handle a few degrees to reveal the engraved wooden surface while maintaining a natural grip.

Use a very subtle camera push-in toward the handle.

The umbrella remains closed and retains its appearance.

Keep the movement small, continuous and physically natural.

Silent scene.
```

## Panel 2

``` text
Create a realistic short smartphone lifestyle video from the provided starting image.

The person gently tilts the already-open umbrella and makes a small natural wrist adjustment.

The canopy remains fully open and stable.

Use minimal handheld camera movement with a subtle push-in.

Keep the motion calm and physically realistic.

Silent scene.
```

## Panel 3

``` text
Create a realistic short smartphone close-up from the provided starting image.

The hand lightly traces one visible umbrella rib with a small controlled finger movement while the open canopy remains stable.

Use only a slight natural camera drift.

Preserve the structure of the umbrella throughout the shot.

Silent scene.
```

## Panel 4

``` text
Create a realistic short smartphone lifestyle video from the provided starting image.

The hand gently grasps the wooden handle and slightly lifts the closed umbrella from its resting position.

Keep the movement small and natural.

Use a slow subtle camera push-in.

The umbrella remains closed and retains its appearance.

Silent scene.
```

------------------------------------------------------------------------

# 28. Dynamic prompt generation, không hard-code 4 prompt trên

4 prompt trên chỉ là acceptance example.

Implementation:

``` text
scene.startFrame
+
scene.motionPlan
+
productAffordance
+
motionComplexity
→ veoPromptBuilder()
```

------------------------------------------------------------------------

# 29. Human / multi-person scenes

Nếu Start Frame có 2 người hoặc adult + child:

``` text
prefer micro-motion
```

Ví dụ:

``` text
small smile
small hand movement
gentle sway
subtle gaze shift
```

Không bắt model tạo lại một body-contact pose phức tạp nếu Start Frame
đã có pose đó.

Rule:

``` text
ANIMATE THE CURRENT POSE
> 
CREATE A NEW POSE
```

đối với multi-person Start Frame.

------------------------------------------------------------------------

# 30. Identity handling

Nếu có recurring character:

Storyboard stage:

``` text
strong identity reference
strong identity QA
```

Veo stage:

``` text
do not redundantly redescribe face
```

Prompt:

``` text
The woman makes a small natural head movement...
```

thay vì một block dài về:

``` text
same face
same nose
same eyes
no face swap
no age morph...
```

Start Frame là anchor identity.

------------------------------------------------------------------------

# 31. Video action validator

Trước API call:

``` ts
validateVideoAction(scene, affordance, startFrameState)
```

Check:

``` text
action is concrete
action is allowed
start state supports action
end state is physically reachable
motion complexity acceptable
no contradictory verbs
no unsupported mechanism
no impossible interaction
```

------------------------------------------------------------------------

# 32. Detect generic-action failure

Reject phrases such as:

``` text
use the product
demonstrate main features
interact naturally
operate the product
show product quality
thao tác sản phẩm
thao tác các tính năng chính
```

unless followed by a concrete verb/object.

Require:

``` text
VERB + PHYSICAL TARGET
```

Examples:

``` text
press the opening button
unfold the diaper
rotate the handle
lift the lid
pour water into the cup
pull the zipper
```

------------------------------------------------------------------------

# 33. Storyboard action ↔ Veo action consistency

Bắt buộc:

``` text
Storyboard Start Frame
supports
Motion Plan
supports
Veo Prompt
```

Ví dụ:

``` text
Panel shows open umbrella
Motion Plan = tilt open umbrella
Veo = tilt
PASS
```

``` text
Panel shows open umbrella
Motion Plan = open umbrella
Veo = open
FAIL
```

------------------------------------------------------------------------

# 34. Voice ↔ visual consistency

Voice script không được nói proof khác với hình.

Example:

``` text
voice:
"coi cái khung nan nè"

visual:
macro umbrella ribs

PASS
```

``` text
voice:
"bấm cái là mở liền"

visual:
umbrella already fully open with no button interaction

FAIL
```

Add:

``` json
"syncIntent": {
  "spokenClaim": "...",
  "visibleEvidence": "...",
  "alignment": "PASS"
}
```

------------------------------------------------------------------------

# 35. CTA

Giữ rule tốt hiện tại:

``` text
CTA only in voice
no fake cart interaction in visual
```

Panel 4 visual phải vẫn là product/lifestyle action thật.

Không:

``` text
point at screen corner
tap invisible cart
look at fake UI
```

------------------------------------------------------------------------

# 36. Prompt size strategy

Không đặt mục tiêu bằng số ký tự cứng.

Đặt mục tiêu:

``` text
minimum sufficient instruction
```

Veo prompt nên chứa:

``` text
1 primary motion
1 product behavior
1 camera behavior
optional performance
1 end state
1 concise realism constraint
```

Không chứa toàn bộ marketing analysis.

------------------------------------------------------------------------

# 37. Error taxonomy

Không log mọi lỗi thành:

``` text
PUBLIC_ERROR_MINOR
```

Internal error layer:

``` text
STEP1_JSON_PARSE_ERROR
STEP1_SCHEMA_ERROR
STEP1_SEMANTIC_ERROR
INVALID_PRODUCT_ACTION
START_FRAME_ACTION_MISMATCH
STORYBOARD_QA_PARSE_ERROR
STORYBOARD_QA_FAIL
VIDEO_PROVIDER_SAFETY_REJECT
VIDEO_PROVIDER_PUBLIC_ERROR
VIDEO_TIMEOUT
VIDEO_EMPTY_RESULT
VIDEO_PRODUCT_MUTATION
VIDEO_ANATOMY_FAIL
```

Nếu provider chỉ trả public error chung, vẫn lưu:

``` text
providerRawError
sceneId
prompt
negativePrompt
model
startFramePath/id
duration
retryNumber
```

------------------------------------------------------------------------

# 38. Retry strategy

Không retry cùng prompt y hệt vô hạn.

``` text
Attempt 1:
normal motion prompt

Attempt 2:
simplify primary motion
remove secondary motion
reduce camera movement

Attempt 3:
micro-motion fallback
```

Ví dụ Panel 2:

``` text
A1: gently tilt umbrella + wrist adjustment + push-in
A2: gently tilt umbrella + static camera
A3: tiny wrist adjustment only
```

Sau max retry:

``` text
mark scene failed
do not silently substitute unrelated motion
```

------------------------------------------------------------------------

# 39. PUBLIC_ERROR fallback strategy

Khi provider trả lỗi public/minor không rõ nguyên nhân:

``` text
1. Store raw response.
2. Check prompt/action validation.
3. Remove redundant defensive text.
4. Reduce motion complexity.
5. Retry with concise English motion prompt.
6. If people are involved, simplify body interaction.
7. If still failing, surface provider failure clearly.
```

Không tự kết luận:

``` text
"child safety"
"prompt too long"
"identity lock caused it"
```

nếu provider không trả reason cụ thể.

------------------------------------------------------------------------

# 40. Logging v2

Mỗi scene log:

``` json
{
  "sceneId": 1,
  "startFrame": "...",
  "productState": "...",
  "primaryAction": "...",
  "endState": "...",
  "motionComplexity": "low",
  "actionRunwayValid": true,
  "veoPrompt": "...",
  "negativePrompt": "...",
  "providerModel": "...",
  "duration": 4,
  "attempt": 1,
  "result": "success|failure",
  "providerError": null
}
```

------------------------------------------------------------------------

# 41. Pipeline mới

``` text
INPUT
product images + metadata
        ↓
PRODUCT FACT EXTRACTION
        ↓
EVIDENCE CLASSIFICATION
        ↓
PRODUCT AFFORDANCE ANALYSIS
        ↓
4-SCENE MARKETING PLAN
        ↓
VOICE SCRIPT
        ↓
SCENE START-STATE + MOTION PLAN
        ↓
JSON / SCHEMA / SEMANTIC VALIDATION
        ↓
ACTION VALIDATION
        ↓
STORYBOARD GENERATION × N
        ↓
REAL QA
        ↓
ACTION-RUNWAY QA
        ↓
SELECT / PANEL REMAKE
        ↓
SLICE
        ↓
USER APPROVAL
        ↓
FOR EACH PANEL:
    read approved Start Frame
        ↓
    verify start state
        ↓
    simplify motion if needed
        ↓
    build concise English Veo prompt
        ↓
    Veo generation
        ↓
    video QA
        ↓
    adaptive retry if needed
        ↓
TTS
        ↓
ASSEMBLY
```

------------------------------------------------------------------------

# 42. Step 1 output schema v2

``` json
{
  "analysis": {
    "productName": "...",
    "category": "...",
    "targetUser": "...",
    "buyerAngle": "...",

    "visibleComponents": [],
    "evidence": {
      "verifiedFromMetadata": [],
      "verifiedVisually": [],
      "inferred": [],
      "unsupported": []
    },

    "productAffordance": {
      "productType": "...",
      "states": [],
      "validActions": [],
      "invalidActions": [],
      "fragileActions": []
    }
  },

  "voicePersona": {
    "gender": "nu",
    "voiceDescription": "...",
    "tone": "..."
  },

  "sceneContext": {
    "location": "...",
    "lighting": "...",
    "mood": "..."
  },

  "script": [
    {
      "id": 1,
      "phase": "Hook",
      "goal": "...",
      "voiceOver": "...",

      "startFrame": {
        "productState": "...",
        "composition": "...",
        "humanPose": "...",
        "handPose": "...",
        "cameraFraming": "...",
        "environment": "...",
        "lighting": "..."
      },

      "motionPlan": {
        "primaryAction": "...",
        "secondaryMotion": "...",
        "productMotion": "...",
        "humanMotion": "...",
        "cameraMotion": "...",
        "endState": "...",
        "motionComplexity": "low"
      },

      "actionRunway": {
        "valid": true,
        "reason": "..."
      },

      "syncIntent": {
        "spokenClaim": "...",
        "visibleEvidence": "..."
      }
    }
  ]
}
```

------------------------------------------------------------------------

# 43. Storyboard prompt v2 --- core block

Agent nên refactor prompt thành các block có dữ liệu thật:

``` text
Generate one four-panel product-review storyboard from the supplied product references.

The storyboard will be sliced into four independent Start Frames for image-to-video generation.

PRIORITY 1 — PRODUCT FIDELITY
Preserve the exact product visible in the references.
Preserve only components actually present in the references.
Do not invent controls, lids, ports, mechanisms, accessories, labels or decorative parts.

PRIORITY 2 — PHYSICAL AND FUNCTIONAL ACCURACY
Every interaction must be physically plausible and compatible with the product's validated affordances.

PRIORITY 3 — VIDEO START-FRAME READINESS
Each panel must show the beginning or a stable early state of its planned motion.
Hands and objects must already be positioned so the planned motion can continue naturally from frame zero.
Do not depict the action as already completed if the video prompt needs to perform that action.

PRIORITY 4 — COMMERCIAL COMPOSITION
Keep the product prominent and clearly readable.

PRIORITY 5 — CONTINUITY
Maintain coherent product identity, lighting and photographic style.

PURE PHOTOGRAPHY
No UI, fake cart, subtitles, badges, arrows or decorative graphic overlays.

{{SCENE_PLAN}}
```

------------------------------------------------------------------------

# 44. Acceptance test --- Nason umbrella

Expected scene state/action compatibility:

``` text
P1
state: closed
action: rotate/inspect handle
PASS

P2
state: fully_open
action: gently tilt
PASS

P3
state: fully_open
action: lightly inspect rib
PASS

P4
state: closed/resting
action: grasp and slightly lift
PASS
```

Must reject:

``` text
P2 state fully_open
action open umbrella
```

------------------------------------------------------------------------

# 45. Acceptance test --- diaper

Must reject:

``` text
action = open lid
```

Must accept:

``` text
unfold diaper
press inner surface
gently stretch waistband
show thickness
```

depending on reference evidence and scene.

------------------------------------------------------------------------

# 46. Acceptance test --- generic appliance

If product visibly has a lid:

``` text
open lid
```

can be valid.

If lid is not visible or metadata does not support it:

``` text
do not invent lid
```

This is why affordance must be product-specific.

------------------------------------------------------------------------

# 47. Acceptance test --- malformed Gemini response

Given malformed JSON:

``` text
{
  "analysis": {
    "product{
```

Expected:

``` text
parse fail
→ repair/regenerate
→ NO storyboard call
```

Never:

``` text
N/A scenes
→ storyboard anyway
```

------------------------------------------------------------------------

# 48. Acceptance test --- QA parse failure

If storyboard evaluator output cannot be parsed:

Expected:

``` text
QA_UNAVAILABLE
→ evaluator retry
```

Not:

``` text
88/100 PASS
```

------------------------------------------------------------------------

# 49. Acceptance test --- video prompt quality

Reject:

``` text
Keep identity exactly...
do not face swap...
do not age morph...
preserve all components...
do not duplicate...
do not...
do not...
```

when Start Frame already provides appearance and those clauses are not
necessary.

Accept:

``` text
The hand slowly rotates the closed wooden handle.
Use a subtle camera push-in.
The umbrella remains closed and retains its appearance.
Keep the movement small and natural.
Silent scene.
```

------------------------------------------------------------------------

# 50. Definition of Done

Template update chỉ hoàn thành khi:

-   [ ] Step 1 malformed JSON không thể đi tiếp.
-   [ ] Không còn N/A scene đi vào storyboard.
-   [ ] Word timing có một source of truth.
-   [ ] Product claims có evidence classification.
-   [ ] Có Product Affordance Engine.
-   [ ] Không sinh action generic.
-   [ ] Không sinh action sai loại sản phẩm.
-   [ ] Mỗi scene có startState/action/endState.
-   [ ] Storyboard được thiết kế như Start Frame cho video.
-   [ ] Có Action Runway QA.
-   [ ] Storyboard QA parse fail không được fake PASS.
-   [ ] Candidate scores là kết quả thật.
-   [ ] Crop 480×1080 được gọi đúng là 4:9.
-   [ ] Không stretch panel để giả thành 9:16.
-   [ ] Veo prompt builder dùng motion-first architecture.
-   [ ] Veo prompt không copy nguyên appearance description.
-   [ ] Mỗi clip chỉ có một primary motion.
-   [ ] High-complexity motion được simplify.
-   [ ] Start Frame state và Veo action không contradiction.
-   [ ] Voice claim và visible proof được sync.
-   [ ] Retry thay đổi complexity, không lặp prompt y hệt.
-   [ ] Provider raw error được log đầy đủ.
-   [ ] PUBLIC_ERROR không bị suy đoán nguyên nhân khi không có
    evidence.
-   [ ] Existing Telegram remake/approve flow vẫn hoạt động.
-   [ ] Panel remake không buộc regenerate toàn storyboard.
-   [ ] Product fidelity vẫn là ưu tiên cao nhất.

------------------------------------------------------------------------

# 51. Nguyên tắc cuối cùng cho agent

Không giải quyết lỗi Veo bằng cách tiếp tục thêm:

``` text
STRICT
LOCK
ABSOLUTELY
NO...
NO...
NO...
```

vào prompt.

Hãy giải quyết ở tầng dữ liệu và planning:

``` text
UNDERSTAND PRODUCT
↓
UNDERSTAND VALID PHYSICAL ACTION
↓
DESIGN CORRECT START FRAME
↓
VALIDATE ACTION RUNWAY
↓
SEND ONE SIMPLE MOTION TO VEO
```

Câu cần giữ làm nguyên tắc kiến trúc:

> **Storyboard quyết định video có thể chuyển động như thế nào; Veo
> prompt chỉ nên nói cho chuyển động đó tiếp tục ra sao.**

Và:

> **Start Frame là source of truth cho appearance. Motion Plan là source
> of truth cho animation.**
