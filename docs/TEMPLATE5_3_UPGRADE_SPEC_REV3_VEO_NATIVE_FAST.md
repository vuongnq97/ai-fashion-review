# TEMPLATE5_3_UPGRADE_SPEC — REVISION 2

## INSTANCE-FIRST + EVIDENCE-FIRST UNIVERSAL PRODUCT REVIEW PIPELINE

> Revision này cập nhật `TEMPLATE5_3_UPGRADE_SPEC.md`.
> XCUP/F37 chỉ là regression cases. Tuyệt đối không hardcode logic theo loại sản phẩm.
> Template phải dùng được cho mọi sản phẩm ecommerce.

# FINAL MODE DECISION

```text
VIDEO_MODE = VEO_NATIVE_FAST
```

This decision is FINAL for this specification.

Agent migration rule:
- remove/deprecate `LEGACY_QUALITY_LOCKED` execution paths;
- remove 4 × 4s Veo generation and concat from production;
- do not keep it as automatic fallback;
- storyboard may still contain four independently generated STILL first-frame panels for planning/QA;
- final VIDEO is generated once as one native 16-second Veo run.

# 0. UPDATE SUMMARY

Giữ nguyên các quyết định đúng của spec trước:
- Product Fact Lock
- Visual Evidence Matrix
- reference-aware planning
- global continuity IDs
- VEO_NATIVE_FAST = FINAL AND ONLY video generation mode
- one native 16-second Veo generation from the approved storyboard/first-frame plan
- master narration planned as one continuous 16-second performance
- validation + local retry

Bổ sung kiến trúc bắt buộc:

```text
RAW INPUTS
↓
INPUT REFERENCE INVENTORY
↓
PRODUCT / VARIANT CLUSTERING
↓
CANONICAL PRODUCT INSTANCE RESOLUTION
↓
PRODUCT IDENTITY MANIFEST
↓
REFERENCE ROLE MAP
↓
PRODUCT FACT LOCK
↓
VISUAL EVIDENCE MATRIX
↓
SCENE PLAN
↓
4 INDIVIDUAL FIRST-FRAME GENERATIONS
↓
IDENTITY + ANIMATION QA
↓
STORYBOARD PREVIEW
↓
VEO_NATIVE_FAST — ONE NATIVE 16s VIDEO
↓
MASTER NARRATION / NATIVE AUDIO PLAN
```

Lý do: nhiều input có thể chứa nhiều SKU, colorway, capacity, print, accessory, poster hoặc state khác nhau. Nếu đưa tất cả ảnh cho generator với quyền ngang nhau, model có thể semantic-fusion thành một sản phẩm mới dù prompt ghi `match exactly`.

---

# 1. UNIVERSAL / MULTI-CATEGORY REQUIREMENT

Core architecture chỉ dùng generic concepts:

```text
product instance
product family
variant
configuration
component
overall geometry
surface appearance
visible feature
product state
mechanical state
usage state
action state
identity evidence
state evidence
context evidence
```

Không hardcode core logic theo `bottle`, `lid`, `lamp`, `button`, `USB-C`, `strap`, `backpack`, v.v.

Category-specific component names chỉ được sinh động từ evidence của run hiện tại.

---

# 2. [NEW] INPUT REFERENCE INVENTORY + VARIANT CLUSTERING
## Insert BEFORE old Product Fact Lock

Phân loại mỗi input:

```json
{
  "referenceId": "REF_001",
  "referenceType": "clean_product | detail | lifestyle | poster | multi_variant | packaging | mechanism | context | unknown",
  "observedProductCandidates": [],
  "identityReliability": "HIGH | MEDIUM | LOW",
  "notes": []
}
```

Sau đó cluster:

```json
{
  "variantClusters": [{
    "clusterId": "VARIANT_001",
    "referenceIds": [],
    "sharedIdentityTraits": [],
    "conflictingTraits": []
  }]
}
```

Hard rule: `multi_variant` image không tự động được làm canonical identity anchor.

---

# 3. [NEW] CANONICAL PRODUCT INSTANCE RESOLUTION
## Insert AFTER clustering, BEFORE fact/evidence extraction

Một review run chỉ có ONE canonical product instance, trừ khi user yêu cầu comparison.

```json
{
  "canonicalProductInstance": {
    "productIdentityId": "PRODUCT_001",
    "clusterId": "VARIANT_001",
    "selectionStatus": "RESOLVED | AMBIGUOUS | BLOCKED",
    "canonicalReferenceId": "REF_XXX",
    "supportingIdentityReferenceIds": [],
    "excludedConflictingReferenceIds": [],
    "selectionReason": [],
    "confidence": 0.0
  }
}
```

Canonical priority:
1. clean isolated intended variant;
2. high-resolution lifestyle image showing full intended variant;
3. single-variant poster;
4. multiple mutually consistent same-variant references.

Avoid primary identity anchors:
- multi-SKU posters;
- heavily occluded/distant products;
- detail-only images;
- generated storyboard outputs;
- hallucinated intermediate images.

Canonical identity MUST originate from original input evidence.

Pixel-preserving crop từ original input được phép.
Redraw/regenerate/inpaint rồi dùng làm ground truth: FORBIDDEN.

---

# 4. [NEW] PRODUCT IDENTITY MANIFEST
## Main product-drift fix

```json
{
  "productIdentityManifest": {
    "productIdentityId": "PRODUCT_001",
    "overallGeometry": {
      "silhouette": "",
      "proportions": "",
      "majorSections": [],
      "baseOrSupportGeometry": ""
    },
    "appearance": {
      "primaryColors": [],
      "secondaryColors": [],
      "surfaceFinish": [],
      "visiblePatterns": [],
      "graphicsOrPrints": [],
      "physicalBrandMarks": []
    },
    "componentLayout": [{
      "componentId": "COMP_001",
      "name": "",
      "position": "",
      "shape": "",
      "color": "",
      "relationshipToMainBody": ""
    }],
    "configuration": {
      "attachedComponents": [],
      "detachableComponents": [],
      "visibleAccessories": [],
      "orientationConstraints": []
    },
    "identityCriticalTraits": [],
    "forbiddenMutations": [],
    "unknownTraits": []
  }
}
```

`identityCriticalTraits` phải được derive động từ target product.

`forbiddenMutations` cũng derive động, ví dụ generic:
- do not change silhouette;
- do not change colorway;
- do not replace visible pattern;
- do not move critical components;
- do not add/remove attachments;
- do not merge another variant;
- do not simplify geometry.

Không chỉ dựa vào câu `do not redesign`.

---

# 5. [NEW] REFERENCE ROLE MAP
## Replaces assumption that all inputs are equivalent references

```json
{
  "referenceRoleMap": [{
    "referenceId": "REF_001",
    "roles": [
      "CANONICAL_IDENTITY",
      "IDENTITY_SUPPORT",
      "DETAIL_EVIDENCE",
      "MECHANISM_EVIDENCE",
      "STATE_EVIDENCE",
      "USAGE_EVIDENCE",
      "ENVIRONMENT_INSPIRATION",
      "ACCESSORY_EVIDENCE",
      "PACKAGING_EVIDENCE",
      "EXCLUDED_CONFLICT"
    ],
    "allowedForIdentity": true,
    "allowedForSceneState": false,
    "allowedForEnvironment": false
  }]
}
```

Conflict priority:

```text
CANONICAL_IDENTITY
>
IDENTITY_SUPPORT same variant
>
SCENE-SPECIFIC STATE / MECHANISM
>
USAGE
>
CONTEXT / ENVIRONMENT
```

State/detail reference chỉ được điều khiển phần state/detail mà nó chứng minh. Không được overwrite unrelated canonical traits.

---

# 6. [MODIFIED] PRODUCT FACT LOCK

Thêm canonical-instance scope:

```json
{
  "productFactLock": {
    "productIdentityId": "PRODUCT_001",
    "verifiedFacts": [],
    "variantSpecificFacts": [],
    "familyLevelFacts": [],
    "visualFacts": [],
    "unsupportedClaims": [],
    "conflictingClaims": [],
    "sourceEvidence": []
  }
}
```

Family-level hoặc other-variant fact không tự động trở thành fact của canonical instance.

---

# 7. [MODIFIED] VISUAL EVIDENCE MATRIX

Thêm:

```json
{
  "evidenceId": "EVIDENCE_001",
  "referenceId": "REF_001",
  "productIdentityId": "PRODUCT_001",
  "variantCompatibility": "EXACT | COMPATIBLE_STATE_ONLY | FAMILY_ONLY | CONFLICTING | UNKNOWN",
  "evidenceType": "IDENTITY | DETAIL | STATE | MECHANISM | USAGE | CONTEXT",
  "visibleFacts": [],
  "supportsActions": [],
  "mustNotInfer": []
}
```

`COMPATIBLE_STATE_ONLY` = được dùng chứng minh state/mechanism nhưng không được copy unrelated appearance.

---

# 8. [MODIFIED] REFERENCE CROPS

Crops phải là original pixels và có provenance:

```json
{
  "cropId": "CROP_001",
  "sourceReferenceId": "REF_001",
  "sourceIsOriginalInput": true,
  "cropRole": "CANONICAL_IDENTITY",
  "pixelPreserving": true
}
```

Possible generic roles:
- canonicalIdentityCrop
- criticalComponentCrop
- mechanismCrop
- surfacePatternCrop
- physicalMarkCrop
- stateCrop

Forbidden feedback loop:

```text
generated storyboard → crop → identity ground truth
```

---

# 9. [MODIFIED] STORYBOARD PLANNER

Planner inputs:

```text
Canonical Product Instance
+ Product Identity Manifest
+ Product Fact Lock
+ Visual Evidence Matrix
+ Reference Role Map
```

Per candidate scene:
1. communication job?
2. verified fact/benefit?
3. exact visual evidence?
4. canonical product supports this state?
5. identity authority reference?
6. state/mechanism authority reference?
7. action possible without changing identity?

Nếu không → replace scene/action. Không invent missing product state.

---

# 10. [MAJOR NEW DEFAULT] GENERATE PANELS INDIVIDUALLY

OLD:

```text
all refs → one 4-panel generation → split
```

NEW VEO_NATIVE_FAST:

```text
Canonical Identity
├→ Panel 1 generation
├→ Panel 2 generation
├→ Panel 3 generation
└→ Panel 4 generation
       ↓
validate each
       ↓
compose storyboard preview
```

4-panel collage chỉ là presentation artifact, không còn là authoritative generation primitive.

---

# 11. [NEW] PER-PANEL REFERENCE BUDGET

Mỗi panel chỉ nhận minimum necessary references:

```text
A. canonical product identity
B. scene-specific detail/state/mechanism if needed
C. approved environment/continuity anchor
D. optional hand/person/outfit continuity anchor
```

Không attach toàn bộ raw inputs vào mọi generation call.

---

# 12. [REPLACE DEFAULT COLLAGE PROMPT] UNIVERSAL PANEL PROMPT

```text
Generate ONE vertical 9:16 photorealistic ecommerce product-review first frame.
This call generates only Scene {{sceneNumber}}.

REFERENCE AUTHORITY

Reference A is the CANONICAL PRODUCT IDENTITY for {{productIdentityId}}.
Preserve exactly:
{{identityCriticalTraits}}

Forbidden mutations:
{{forbiddenMutations}}

Reference B, when supplied, controls ONLY:
{{sceneSpecificEvidenceRole}}

Do not copy unrelated appearance from Reference B.
Never blend variants or average conflicting references.

Reference C controls environment continuity when supplied.
Reference D controls human continuity when supplied.

PRODUCT STATE
Required state: {{productState}}
Required visible components/features: {{requiredVisibleComponents}}
Supported by evidence: {{evidenceIds}}

SCENE
Phase: {{phase}}
Communication job: {{communicationJob}}
Primary action start state: {{actionStartState}}
Composition: {{composition}}
Human framing: {{humanFraming}}

ANIMATION READINESS
This image is the exact first frame of an independent video shot.
Use one primary action.
Starting pose must be physically plausible.
Do not obscure components needed for the action.
Leave room for action progression.

REALISM
Authentic smartphone product photography.
Natural perspective/exposure.
Real materials/contact shadows.
Physically plausible support/grip.
Correct hand anatomy when visible.
Faceless unless scene policy explicitly permits otherwise.

TEXT POLICY
No added typography, captions, badges, subtitles, UI or watermark.
Do not invent logos.
Preserve physical marks only when genuinely present on canonical evidence.

ABSOLUTE IDENTITY RULE
If composition conflicts with product fidelity, PRODUCT FIDELITY WINS.
Do not simplify, beautify, normalize, restyle, recolor or redesign the product.
```

---

# 13. [MODIFIED] GLOBAL CONTINUITY LOCK

Keep:

```json
{
  "environmentId": "ENV_001",
  "handModelId": "HAND_001",
  "lightingId": "LIGHT_001",
  "productIdentityId": "PRODUCT_001",
  "cameraStyleId": "CAMERA_PHONE_001"
}
```

But `productIdentityId` now resolves to:
`Canonical Product Instance + Identity Manifest + Canonical Identity Reference`.

---

# 14. [NEW] PRODUCT IDENTITY VALIDATION GATE

Every panel must pass before video:

```json
{
  "identityValidation": {
    "silhouetteMatch": true,
    "proportionMatch": true,
    "colorwayMatch": true,
    "patternOrSurfaceMatch": true,
    "criticalComponentMatch": true,
    "componentPlacementMatch": true,
    "configurationMatch": true,
    "foreignVariantTraitsDetected": false,
    "inventedComponentsDetected": false,
    "missingCriticalTraitsDetected": false,
    "pass": true
  }
}
```

Only evaluate applicable traits.

Hard gate:

```text
identityValidation.pass == false
→ DO NOT SEND PANEL TO VIDEO
→ retry only failed panel
```

---

# 15. [MODIFIED] RETRY FAILURE CLASSES

Add:

```text
wrong_variant
semantic_variant_fusion
silhouette_drift
colorway_drift
pattern_drift
component_layout_drift
missing_identity_trait
invented_component
state_reference_overrode_identity
identity_reference_too_weak
```

Retry should reduce conflicting references and strengthen role authority, not merely repeat `match exactly`.

---

# 16. [REPLACED] VEO_NATIVE_FAST VIDEO ARCHITECTURE — FINAL MODE

`LEGACY_QUALITY_LOCKED`, `4 × 4s`, per-shot Veo generation, and concat are REMOVED as production modes.

Final architecture:

```text
Approved Product Identity
+ Approved Scene Plan
+ Approved 4-panel Storyboard Preview
+ Global Continuity Lock
+ Full 16s Narration Plan
↓
ONE VEO_NATIVE_FAST GENERATION
↓
ONE CONTINUOUS 16s VIDEO
↓
FINAL VALIDATION
```

The four storyboard panels are planning/key visual anchors for the four semantic phases of the same native 16-second generation. They are NOT four separately generated video shots.

Target semantic timing remains approximately:

```text
0–4s   Hook
4–8s   Solution
8–12s  Proof
12–16s Closing
```

These boundaries are editorial guidance, not four independent generation jobs.

Veo must preserve:
- the same canonical product instance;
- global environment/lighting/camera/human continuity;
- product identity across all four phases;
- natural transitions between phases;
- one continuous native audiovisual performance.

Do NOT:
- call Veo four times;
- concatenate four generated clips;
- create independent 4-second voice tracks;
- use LEGACY_QUALITY_LOCKED as a fallback;
- silently switch modes when VEO_NATIVE_FAST fails.

If generation fails validation, retry VEO_NATIVE_FAST with corrected prompt/reference packaging.

---

# 17. [MODIFIED] VEO_NATIVE_FAST PROMPT BUILDER

Build ONE prompt for the complete 16-second generation.

Blocks:

```text
PRODUCT INSTANCE LOCK
+ PRODUCT IDENTITY MANIFEST
+ REFERENCE AUTHORITY
+ GLOBAL CONTINUITY
+ 16s SEMANTIC TIMELINE
    + 0–4s HOOK
    + 4–8s SOLUTION
    + 8–12s PROOF
    + 12–16s CLOSING
+ ACTION TRANSITIONS
+ CAMERA BEHAVIOR
+ HUMAN CONTINUITY
+ NEGATIVE CONSTRAINTS
+ MASTER NARRATION
+ AUDIO / SPEECH TIMING
```

The video generator must never resolve SKU/variant ambiguity.

Storyboard panels remain evidence-backed visual anchors, but the final Veo call must describe how the video moves naturally through all four phases without behaving like four unrelated clips.

The prompt builder must explicitly carry the same `productIdentityId` through the entire 16 seconds.

---

# 18. [MODIFIED] MASTER VOICE FOR VEO_NATIVE_FAST

Voice is ALWAYS planned globally for the full 16 seconds.

```text
FULL 16s SCRIPT
↓
ONE MASTER NARRATION PLAN
↓
semantic timing map
↓
VEO_NATIVE_FAST receives the complete narration/audio direction
↓
ONE CONTINUOUS 16s PERFORMANCE
```

Never split narration into four independent voice generations.

The semantic timing map aligns speech with the four visual phases while preserving natural fast delivery across scene boundaries.

Example structure:

```text
0.0–4.0s   Hook narration
4.0–8.0s   Solution narration
8.0–12.0s  Proof narration
12.0–16.0s Closing narration
```

Word boundaries do not have to stop exactly at 4/8/12 seconds. Natural speech flow has priority as long as the intended visual claim and spoken claim remain synchronized.

If the implementation uses an external master TTS before/after Veo for a specific integration reason, it must still be ONE continuous master voice track for the whole 16 seconds. Per-scene voice generation is forbidden.

---

# 19. [MODIFIED] TARGET RUN MD FORMAT

```markdown
# Template 5 Run
## Product Request
## Input Reference Inventory
## Variant Clusters
## Canonical Product Instance
## Product Identity Manifest
## Reference Role Map
## Product Fact Lock
## Visual Evidence Matrix
## Reference Crops + Provenance
## Global Visual Lock
## Scene Plan
## Voice Mode
## Voice Profile
## Full 16s Script
## Semantic Timing Map

## Panel 1
### Reference Package
### Prompt
### Identity Validation
### Animation Readiness Validation

## Panel 2
...
## Panel 3
...
## Panel 4
...

## Storyboard Preview
## VEO_NATIVE_FAST Full 16s Prompt
## Master Narration Plan
## Semantic Audio/Visual Timing Map
## Final Validation
## Retry History
```

---

# 20. [REPLACES OLD IMPLEMENTATION ORDER]

AI coding agent update order:

1. Input Reference Inventory
2. Product / Variant Clustering
3. Canonical Product Instance Resolver
4. Product Identity Manifest
5. Reference Role Map
6. Product Fact Extraction scoped to canonical instance
7. Visual Evidence Matrix scoped to canonical instance
8. Pixel-preserving Reference Crops + provenance
9. Reference-aware Scene Planner
10. Individual Panel Prompt Builder
11. Per-panel Reference Package Builder
12. Product Identity Validation Gate
13. Animation Readiness Validation
14. Storyboard Preview Composer
15. VEO_NATIVE_FAST Full 16s Prompt Builder
16. Master Voice + Semantic Timing Plan
17. Native 16s Continuity Validation
18. Final Validation
19. Local Retry Logic
20. Run MD Output
21. Regression Tests

**Do not start by only editing Veo/image prompt wording.**

---

# 21. [REPLACES/EXPANDS OLD FILE TEMPLATE CHANGES]

## A. Product Analysis Template
ADD:
- Input Reference Inventory
- Variant Clustering
- Canonical Product Instance
- Product Identity Manifest
- Reference Role Map

MODIFY:
- Product Fact Lock → canonical-instance scoped
- Visual Evidence Matrix → add variantCompatibility

## B. Storyboard Template
CHANGE:
`one 4-panel generation` → `4 independent first-frame generations → QA → preview collage`.

ADD:
- canonical identity authority
- per-panel reference package
- identityCriticalTraits
- forbiddenMutations
- scene-specific reference role
- identity validation

KEEP:
- semantic Hook/Solution/Proof/Closing where appropriate
- one primary action
- animation readiness
- faceless policy
- environment/hand/light/camera continuity

## C. Video Prompt Template
REPLACE:
- all LEGACY_QUALITY_LOCKED / 4 × 4s / concat logic
- all per-shot Veo prompt generation
- any fallback from VEO_NATIVE_FAST to four-shot generation

ADD:
- VEO_NATIVE_FAST as the only production video mode
- one full 16s prompt
- Product Identity Manifest
- explicit reference authority
- canonical identity ref
- scene-state reference scope
- global continuity across the entire 16 seconds
- semantic 0–4 / 4–8 / 8–12 / 12–16 timeline
- transition instructions between phases
- never blend variants

## D. Voice Template
CHANGE:
- master narration is planned for the complete 16s generation
- one continuous narration/performance
- semantic timing map instead of four isolated voice windows
- forbid per-scene voice generation

## E. Run Output Template
ADD all new identity-resolution intermediate outputs and validations.

---

# 22. [UPDATED] MULTI-CATEGORY REGRESSION TESTS

Test at minimum:

### A. Multi-variant container/drinkware
Must not blend colors, prints, proportions or accessories.

### B. Electronic/mechanical product
Exact housing/control/component layout; no invented controls.

### C. Fashion/accessory
Exact shape/material/hardware/pattern/colorway; no cross-variant fusion.

### D. Beauty/cosmetic
Exact packaging geometry; state only when evidenced; no invented effects/claims.

### E. Tool/home/kitchen
Exact structure/attachments/joints; mechanically plausible state.

### F. Ambiguous inputs
If canonical instance cannot be reliably resolved:

```text
selectionStatus = AMBIGUOUS | BLOCKED
```

Never silently average references into a new product.

---

# 23. XCUP REGRESSION NOTE — NOT A UNIVERSAL RULE

The observed XCUP failure is evidence of unresolved reference authority: multiple product-family appearances were semantically fused into a simplified new bottle.

Regression passes only if:
1. intended variant resolved before storyboard;
2. original input becomes canonical authority;
3. detail/state references get limited roles;
4. conflicting variants excluded from identity;
5. panels generated independently;
6. identity QA passes before animation.

Do NOT encode XCUP-specific body/cap/strap rules into generic templates.

---

# 24. CORE INVARIANTS

1. One review target → one canonical identity unless comparison requested.
2. Identity resolved upstream, never by generator.
3. Every reference has explicit role.
4. State evidence cannot rewrite unrelated identity.
5. Original evidence is ground truth; generated outputs are not.
6. Use minimal relevant reference package per panel.
7. Product fidelity outranks aesthetics.
8. Validate first frame before animation.
9. Retry locally.
10. Unknown remains unknown; never invent.

---

# 25. FINAL ARCHITECTURE

```text
USER INPUT
↓
REFERENCE INVENTORY
↓
VARIANT CLUSTERING
↓
CANONICAL INSTANCE RESOLUTION
↓
IDENTITY MANIFEST
↓
REFERENCE ROLE MAP
↓
FACT LOCK + VISUAL EVIDENCE
↓
ORIGINAL-PIXEL REFERENCE CROPS
↓
SCENE PLAN
↓
PANEL 1 | PANEL 2 | PANEL 3 | PANEL 4
↓
IDENTITY + ANIMATION QA PER PANEL
↓
STORYBOARD PREVIEW
↓
VEO_NATIVE_FAST FULL 16s PROMPT
↓
ONE NATIVE 16s VIDEO GENERATION
↓
MASTER NARRATION / AUDIO TIMING
↓
FINAL VIDEO
```

# 26. FINAL IMPLEMENTATION PRINCIPLE

> Do not ask a generative model to infer which variant is canonical when the system can resolve it before generation.

> Do not give contradictory references equal identity authority.

> Do not solve identity-resolution problems by adding stronger adjectives such as `exact`, `strict`, or `do not redesign`.

Production architecture:

```text
INSTANCE-FIRST
+ ROLE-AWARE REFERENCES
+ EVIDENCE-FIRST
+ INDIVIDUAL STORYBOARD FIRST-FRAME GENERATION
+ IDENTITY QA
+ VEO_NATIVE_FAST ONLY
+ ONE NATIVE 16s GENERATION
+ ONE MASTER NARRATION PLAN
```

`VEO_NATIVE_FAST` is not a fallback. It is the final selected production mode.
