# TEMPLATE5_3_UPGRADE_SPEC — REVISION 4
## FINAL ARCHITECTURE: SINGLE-COLLAGE STORYBOARD + VEO_NATIVE_FAST 2×8s

> This revision supersedes REV3.
>
> Two corrections are mandatory:
>
> 1. **Storyboard MUST NOT default to 4 independent image generations.**
>    Four independent calls can drift in product, environment, hand, lighting and camera continuity.
>    The default storyboard generation returns to **ONE 4-panel collage generation**, then panels are sliced.
>
> 2. **Do NOT assume a 16-second Veo generation.**
>    Final production video mode is **VEO_NATIVE_FAST = 2 independent native 8-second Veo generations**.
>    Video 1 covers Panel 1 → Panel 2. Video 2 covers Panel 3 → Panel 4.
>
> `VEO_NATIVE_FAST` remains the final selected video mode.
>
> Product identity resolution, variant clustering, identity manifest, reference roles, evidence-first planning and QA from REV3 remain required.


# 0. FINAL PIPELINE

```text
RAW PRODUCT INPUTS
        ↓
INPUT REFERENCE INVENTORY
        ↓
PRODUCT / VARIANT CLUSTERING
        ↓
CANONICAL PRODUCT INSTANCE
        ↓
PRODUCT IDENTITY MANIFEST
        ↓
REFERENCE ROLE MAP
        ↓
PRODUCT FACT LOCK
        ↓
VISUAL EVIDENCE MATRIX
        ↓
STORYBOARD SCENE PLAN
        ↓
ONE MASTER 4-PANEL STORYBOARD GENERATION
        ↓
STORYBOARD IDENTITY + CONTINUITY QA
        ↓
SLICE INTO PANEL 1 / 2 / 3 / 4
        ↓
VIDEO 1 INPUT PACKAGE
Panel 1 + Panel 2 + Canonical Product refs + Relevant evidence refs
        ↓
VEO_NATIVE_FAST 8s
        ↓
VIDEO 2 INPUT PACKAGE
Panel 3 + Panel 4 + Canonical Product refs + Relevant evidence refs
        ↓
VEO_NATIVE_FAST 8s
        ↓
FINAL 16s COMPOSITION
```

The final 16s result is therefore:

```text
8s native Veo video #1
+
8s native Veo video #2
```

NOT one 16s Veo generation.

---

# 1. WHY STORYBOARD RETURNS TO ONE COLLAGE CALL

The four storyboard panels must feel like one visual world.

Four unrelated image-generation calls create additional continuity risk:

- different product proportions;
- different print/color rendering;
- different room geometry;
- different hand appearance;
- different lighting;
- different camera response;
- different material interpretation.

Therefore the production default is:

```text
ONE storyboard call
→ exactly 4 panels in one image
→ shared product/environment/hand/light context
→ slice after QA
```

This does NOT remove upstream product-instance resolution.

The storyboard generator must receive a resolved, non-ambiguous identity package rather than all raw references with equal authority.

---

# 2. CANONICAL PRODUCT INSTANCE — REQUIRED BEFORE STORYBOARD

The system must still resolve one target instance before storyboard generation.

```json
{
  "canonicalProductInstance": {
    "productIdentityId": "PRODUCT_001",
    "selectionStatus": "RESOLVED | AMBIGUOUS | BLOCKED",
    "canonicalReferenceId": "REF_XXX",
    "supportingIdentityReferenceIds": [],
    "excludedConflictingReferenceIds": [],
    "confidence": 0.0
  }
}
```

If multiple variants exist:

- select one intended variant;
- exclude conflicting appearance from identity authority;
- do not ask the image model to average the variants.

If target instance is ambiguous:

```text
DO NOT GENERATE STORYBOARD
```

Resolve ambiguity first.

---

# 3. PRODUCT IDENTITY MANIFEST

Create one category-agnostic identity manifest:

```json
{
  "productIdentityManifest": {
    "productIdentityId": "PRODUCT_001",
    "overallGeometry": {},
    "appearance": {},
    "componentLayout": [],
    "configuration": {},
    "identityCriticalTraits": [],
    "forbiddenMutations": [],
    "unknownTraits": []
  }
}
```

This structure applies to any product category.

Do not hardcode bottle/lamp/bag/beauty/tool-specific architecture.

---

# 4. REFERENCE ROLE MAP

Every original image receives a role.

```text
CANONICAL_IDENTITY
IDENTITY_SUPPORT
DETAIL_EVIDENCE
MECHANISM_EVIDENCE
STATE_EVIDENCE
USAGE_EVIDENCE
ENVIRONMENT_INSPIRATION
ACCESSORY_EVIDENCE
PACKAGING_EVIDENCE
EXCLUDED_CONFLICT
```

Priority:

```text
CANONICAL_IDENTITY
>
same-variant IDENTITY_SUPPORT
>
scene-specific STATE / MECHANISM evidence
>
USAGE evidence
>
context inspiration
```

A detail/state reference may control only the demonstrated detail/state.

It must not overwrite unrelated canonical identity.

---

# 5. STORYBOARD REFERENCE PACKAGE

Do NOT attach all raw input references indiscriminately.

Build a curated storyboard package:

```json
{
  "storyboardReferencePackage": {
    "canonicalIdentityRef": "REF_CANONICAL",
    "identitySupportRefs": [],
    "sceneEvidenceRefs": {
      "panel1": [],
      "panel2": [],
      "panel3": [],
      "panel4": []
    },
    "excludedRefs": []
  }
}
```

Recommended reference strategy:

- 1 canonical identity reference;
- 1–2 same-variant identity support references if useful;
- only the detail/state evidence necessary to plan the four scenes;
- no conflicting variants as identity input.

The image generator still produces all 4 panels in ONE call.

---

# 6. MASTER STORYBOARD PROMPT — DEFAULT

The default image-generation task remains:

```text
Generate ONE still 4-panel storyboard collage.
Exactly four vertical panels in one shared visual world.
```

Critical hierarchy:

```text
1. Canonical Product Identity
2. Product Identity Manifest
3. Scene-specific verified state evidence
4. Global continuity
5. Scene composition
6. Aesthetic styling
```

If aesthetics conflict with product fidelity:

```text
PRODUCT FIDELITY WINS
```

All four panels must share:

```json
{
  "productIdentityId": "PRODUCT_001",
  "environmentId": "ENV_001",
  "handModelId": "HAND_001",
  "lightingId": "LIGHT_001",
  "cameraStyleId": "CAMERA_001"
}
```

The four scenes may vary only in:

- framing;
- product state;
- primary hand action;
- composition;
- semantic marketing phase.

---

# 7. STORYBOARD QA BEFORE SLICE

Validate the complete collage before using it.

Checks:

```json
{
  "storyboardValidation": {
    "sameProductAcrossAllPanels": true,
    "sameVariantAcrossAllPanels": true,
    "silhouetteConsistent": true,
    "proportionsConsistent": true,
    "colorwayConsistent": true,
    "patternConsistent": true,
    "criticalComponentsConsistent": true,
    "environmentConsistent": true,
    "handAppearanceConsistent": true,
    "lightingConsistent": true,
    "actionsSupportedByEvidence": true,
    "noForeignVariantTraits": true,
    "pass": true
  }
}
```

If fail:

```text
RETRY THE STORYBOARD GENERATION
```

Do not slice a failed storyboard.

---

# 8. SLICE ONLY AFTER APPROVAL

After storyboard passes QA:

```text
Master Storyboard
├── Panel 1
├── Panel 2
├── Panel 3
└── Panel 4
```

Use pixel-preserving slicing only.

Do not regenerate the panels independently.

This preserves continuity inherited from the single storyboard call.

---

# 9. VEO_NATIVE_FAST — FINAL VIDEO MODE

The production video architecture is fixed:

```text
VIDEO 1 = 8 seconds
Panel 1 → Panel 2

VIDEO 2 = 8 seconds
Panel 3 → Panel 4
```

There is NO 16-second Veo call in this architecture.

There is NO 4×4s Veo production mode.

---

# 10. IMPORTANT LIMITATION OF 2-SCENE / 8s GENERATION

For one 8-second generation:

```text
Panel 1
```

can be treated as the true starting visual input.

But:

```text
Panel 2 at ~4s
```

is a scene target/reference, not a guaranteed hard start frame at timestamp 4.000s.

The prompt may request:

```text
0–4s follow Panel 1
clean cut near 4s
4–8s closely match Panel 2
```

but exact mid-clip first-frame identity is best-effort.

This limitation is ACCEPTED because `VEO_NATIVE_FAST` is the selected production mode.

Do not falsely describe Panel 2/4 as guaranteed hard first frames.

---

# 11. VIDEO 1 REFERENCE PACKAGE

Use role-based references:

```json
{
  "video1References": {
    "startFrame": "PANEL_1",
    "secondSceneVisualTarget": "PANEL_2",
    "canonicalIdentityRef": "REF_CANONICAL",
    "relevantEvidenceRefs": []
  }
}
```

Do not automatically include:

- every raw product image;
- conflicting variants;
- unnecessary detail refs;
- marketing posters unrelated to Scene 1/2.

If a Scene 2 action depends on a specific product state, include the corresponding evidence reference.

---

# 12. VIDEO 2 REFERENCE PACKAGE

```json
{
  "video2References": {
    "startFrame": "PANEL_3",
    "secondSceneVisualTarget": "PANEL_4",
    "canonicalIdentityRef": "REF_CANONICAL",
    "relevantEvidenceRefs": []
  }
}
```

Same rules as Video 1.

---

# 13. MASTER STORYBOARD AS VIDEO REFERENCE

The full Master Storyboard should NOT automatically be included in every Veo call.

Default:

```text
Panel A
+ Panel B
+ canonical product identity
+ only relevant scene evidence
```

Use the full Master Storyboard only if actual provider testing proves it improves continuity.

Reason:

The full collage may create competing visual states and unnecessary reference noise.

---

# 14. VEO 8s PROMPT STRUCTURE

Each video prompt must be modular:

```text
PRODUCT INSTANCE LOCK
+
CANONICAL PRODUCT IDENTITY
+
REFERENCE ROLES
+
0–4s SCENE A
+
~4s CLEAN CUT
+
4–8s SCENE B
+
ACTION CONSTRAINTS
+
GLOBAL CONTINUITY
+
VOICE PERFORMANCE LOCK
+
FULL 8s DIALOGUE
+
AUDIO CONTINUITY
+
NEGATIVE RULES
```

Do not use one uncontrolled giant paragraph assembled from duplicated text.

---

# 15. PRODUCT ACTION RULE

Scene actions remain evidence-first.

Before using an action:

```text
Does the input prove the required visible product state?
```

If YES:
- use it;
- send relevant evidence reference.

If NO:
- simplify the action;
- do not hallucinate hidden mechanisms or new geometry.

This rule remains universal across categories.

---

# 16. VOICE — VEO NATIVE, TWO 8s GENERATIONS

Since final mode is `VEO_NATIVE_FAST`, voice is generated natively inside each 8-second Veo video.

Do NOT describe the system as one 16-second native voice generation.

Instead create ONE global Voice Performance Profile and copy the exact same immutable block into both video prompts.

```json
{
  "voicePerformanceProfile": {
    "profileId": "VOICE_001",
    "language": "vi-VN",
    "speakerClass": "",
    "accent": "",
    "timbre": "",
    "pitch": "",
    "delivery": "rapid_fire_tiktok_review",
    "energy": "",
    "pauseBehavior": "minimal",
    "speechStyle": ""
  }
}
```

Important:

The profile increases perceptual similarity across the two generations.

It does NOT guarantee deterministic identical voice identity across independent Veo calls.

This limitation must be documented, not hidden.

---

# 17. VOICE TIMING PER 8s VIDEO

Do not use:

```text
max 42 words
```

as the main control.

Use speech-time budget:

```json
{
  "videoDuration": 8.0,
  "speechStartTarget": "0.1–0.3s",
  "speechCompletionTarget": "6.8–7.4s",
  "safetyMargin": "0.6–1.2s"
}
```

Dialogue rules:

- natural spoken Vietnamese;
- short clauses;
- rapid conversational delivery;
- minimal dramatic pauses;
- no formal corporate copy;
- no unnecessary repetition.

Priority:

```text
1. Complete all dialogue
2. Preserve voice profile
3. Maintain fast pacing
4. Maintain clarity
5. Emotion only if it does not slow speech
```

---

# 18. AUDIO CONTINUITY WITHIN EACH 8s VIDEO

The visual cut around 4s must not force a voice reset.

Prompt:

```text
The visual transition around 4 seconds is visual only.
Narration continues seamlessly across the cut.
Do not restart the speaker.
Do not add a dramatic pause.
Do not change accent, pitch, energy or pace.
Treat the full 8 seconds as one continuous voice performance.
```

This applies independently to Video 1 and Video 2.

---

# 19. CROSS-VIDEO VOICE CONTINUITY

Because Video 1 and Video 2 are separate Veo calls:

```text
Voice A ≈ Voice A'
```

is the realistic goal.

To maximize similarity:

- exact same Voice Performance Profile;
- exact same language/accent wording;
- exact same pace wording;
- same energy;
- same speaker age impression;
- same audio priority rules;
- no paraphrasing of voice instructions between prompts.

The agent must assemble the same immutable voice block byte-for-byte.

---

# 20. UPDATED RUN MD FORMAT

```markdown
# Template Run

## Input Reference Inventory
## Variant Clusters
## Canonical Product Instance
## Product Identity Manifest
## Reference Role Map
## Product Fact Lock
## Visual Evidence Matrix

## Storyboard Reference Package
## Master Storyboard Prompt
## Master Storyboard Validation

## Panel 1
## Panel 2
## Panel 3
## Panel 4

## Global Voice Performance Profile

## Video 1 Reference Package
## Video 1 8s Prompt
## Video 1 Validation

## Video 2 Reference Package
## Video 2 8s Prompt
## Video 2 Validation

## Final 16s Composition Validation
## Retry History
```

---

# 21. AGENT IMPLEMENTATION ORDER

1. Input Reference Inventory
2. Variant Clustering
3. Canonical Product Instance Resolver
4. Product Identity Manifest
5. Reference Role Map
6. Product Fact Lock
7. Visual Evidence Matrix
8. Storyboard Reference Package Builder
9. ONE 4-panel Master Storyboard Prompt Builder
10. Master Storyboard Identity/Continuity QA
11. Pixel-preserving Panel Slice
12. Voice Performance Profile Builder
13. Video 1 Reference Package Builder
14. Video 1 8s VEO_NATIVE_FAST Prompt Builder
15. Video 2 Reference Package Builder
16. Video 2 8s VEO_NATIVE_FAST Prompt Builder
17. Voice/Dialogue Timing Validator
18. Video QA
19. Retry logic
20. Run MD Output
21. Multi-category regression tests

---

# 22. REMOVE FROM REV3 IMPLEMENTATION

The agent must remove/deprecate these REV3 assumptions:

```text
4 independent storyboard panel generation calls
1 × 16s Veo generation
4 × 4s Veo fallback
per-panel image generation as default
```

Do not keep them silently active.

---

# 23. MULTI-CATEGORY REQUIREMENT

This template must remain universal.

Regression tests must cover:

- multi-variant products;
- electronics/mechanical;
- fashion/accessories;
- beauty/cosmetic;
- kitchen/home;
- tools;
- pet products;
- lifestyle/general ecommerce.

No category-specific hardcoding in the core identity/reference architecture.

---

# 24. FINAL ARCHITECTURE SUMMARY

```text
INSTANCE-FIRST
+
ROLE-AWARE REFERENCES
+
EVIDENCE-FIRST
+
ONE MASTER 4-PANEL STORYBOARD CALL
+
STORYBOARD CONTINUITY QA
+
PANEL SLICE
+
VEO_NATIVE_FAST VIDEO 1 = 8s
+
VEO_NATIVE_FAST VIDEO 2 = 8s
+
IMMUTABLE VOICE PERFORMANCE PROFILE
+
FINAL 16s COMPOSITION
```

This is the final architecture for the current Template pipeline.
