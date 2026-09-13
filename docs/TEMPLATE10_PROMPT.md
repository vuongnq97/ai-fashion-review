# TEMPLATE 10 — QUALITY_LOCKED Atomic Shot Review (EVIDENCE-FIRST + MASTER NARRATION)

## 1. Tổng quan

- **Lệnh kích hoạt**: `/t10` (hoặc `/template10`, `/template_10`)
- **Kiến trúc**: QUALITY_LOCKED — 4 Atomic Shots × 4s = 16s final
- **Voice**: MASTER_NARRATION — 1 TTS request cho toàn bộ script 16s, mix ngoài Veo
- **Storyboard**: EVIDENCE-FIRST — chỉ gen scene khi có visual evidence từ input

## 2. Khác biệt so với Template 5.2

| Điểm | Template 5.2 | Template 10 |
|---|---|---|
| Shot structure | 2 video × 8s (2 scene/video) | 4 video × 4s (1 scene/video) |
| Panel → Video | Panel 2/4 là soft reference giữa generation | Panel 1/2/3/4 là hard start-frame của generation riêng |
| Voice | Embedded trong Veo (best-effort) | Master Narration 1 TTS request ngoài |
| Storyboard | Creative freedom | Evidence-aware: chỉ dùng action có visual proof |
| Prompt | 1 paragraph lớn | Modular blocks (Product Lock + First Frame + Action + Camera + Continuity + Negative + Audio) |
| Retry | Phải regenerate cả 8s | Retry riêng từng shot 4s |

## 3. Pipeline

```text
Product Inputs
  ↓
Fact Extraction + Visual Evidence Matrix
  ↓
Global Visual Lock (environment/hand/light IDs)
  ↓
Reference-Aware Storyboard 4 panels
  ↓
Split 4 individual panels
  ↓
Shot 1 (4s) — Panel 1 as first frame
Shot 2 (4s) — Panel 2 as first frame
Shot 3 (4s) — Panel 3 as first frame
Shot 4 (4s) — Panel 4 as first frame
  ↓
Concat → 16s visual
  ↓
Master Narration (separate TTS)
  ↓
Final Mix
```

## 4. Analysis JSON Schema

```json
{
  "productFactLock": {
    "productName": "...",
    "verifiedFacts": [],
    "visualFacts": [],
    "unsupportedClaims": [],
    "sourceEvidence": []
  },
  "visualEvidenceMatrix": {
    "states": {}
  },
  "globalVisualLock": {
    "environmentId": "ENV_001",
    "handModelId": "HAND_001",
    "lightingId": "LIGHT_001",
    "productIdentityId": "PRODUCT_001",
    "cameraStyleId": "CAMERA_PHONE_001"
  },
  "voiceMode": "MASTER_NARRATION",
  "voiceProfile": {},
  "fullScript16s": "...",
  "timingMap": [],
  "scenes": []
}
```

## 5. Veo Prompt Block Structure (per shot)

```text
PRODUCT IDENTITY LOCK
+ REFERENCE ROLE BLOCK
+ FIRST FRAME BLOCK
+ ACTION BLOCK
+ CAMERA BLOCK
+ CONTINUITY BLOCK
+ NEGATIVE BLOCK
+ AUDIO BLOCK (no dialogue — MASTER_NARRATION mode)
```

## 6. CTA Rule

- `ctaMode: "platform_generic"` — không hardcode "góc trái"
- Nếu platform position không guaranteed: "Xem trong giỏ hàng nha"

## 7. Action Complexity Budget

### SAFE (luôn cho phép)
- hold, lift, place, point to visible feature, press one visible button, slight rotation

### MEDIUM (chỉ khi có state reference)
- open/close lid, adjust hinge, attach strap, plug visible cable

### HIGH RISK (phải có reference sequence, nếu không thì reject)
- disassemble, show hidden mechanism, complex installation, prove leak-proof by inversion

## 8. Validation Gates

### Pre-Storyboard
- productFactsReady: true
- visualEvidenceReady: true
- actionStatesMapped: true

### Pre-Video (per shot)
- firstFrameAssigned: true
- productIdentityRefAssigned: true
- actionSupportedByEvidence: true
- singlePrimaryAction: true
- facelessCompatible: true

## 9. Voice Script Target

- Full 16s → Target: 14.2s – 15.3s
- Style: spoken Vietnamese, short clauses, rapid delivery friendly
- Không dùng "góc trái" nếu platform không đảm bảo
- Không hardcode giá tiền / % giảm giá (evergreen)
