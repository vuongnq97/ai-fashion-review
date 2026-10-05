# MOTHER & BABY CHANNEL — TEMPLATE PRO MIGRATION SPEC
## Full Implementation Guide for AI Coding Agent

> Purpose: migrate the current `/tpro` generic faceless household-product workflow into a recurring-character **Mother & Baby commerce channel**.
>
> This file is the single source of truth for the implementation. The AI coding agent should use it to update the existing project end-to-end, not only patch individual prompts.

---

# 1. HIGH-LEVEL GOAL

The current workflow is built around:

- generic multi-category products,
- product-first visuals,
- faceless human presence,
- hands/body-only interaction,
- a generic modern home environment,
- product fidelity as the highest visual priority.

The new workflow must become:

- a dedicated **Mother & Baby commerce channel**,
- visible recurring mother character,
- visible recurring baby character,
- mother and baby identity loaded from **Asset Source**,
- products loaded separately from product reference assets,
- the same mother and baby must remain recognizable across every video,
- scenes may contain:
  - mother only,
  - baby only,
  - mother + baby,
- the system must NOT force both characters into every scene,
- products may include anything relevant to mothers, babies, toddlers, postpartum life, feeding, sleep, hygiene, travel, clothing, toys, nursery, baby care, mom care, etc.,
- content should feel like moments from the real life of one mother and her baby, not generic product advertising.

The channel is **NO LONGER FACELESS**.

---

# 2. CORE CREATIVE PRINCIPLE

The mother and baby are the recurring characters of the channel.

The product is introduced into their daily life.

Do NOT treat the mother or baby as generic product-holding props.

Preferred content logic:

```text
REAL MOM-LIFE SITUATION
        ↓
PROBLEM / NEED
        ↓
PRODUCT ENTERS NATURALLY
        ↓
USE / INTERACTION
        ↓
PROOF / RESULT
        ↓
LIFESTYLE CLOSING
```

The viewer should feel:

> "Một người mẹ thật đang chia sẻ món đồ mình dùng cho bản thân hoặc cho con."

NOT:

> "Một quảng cáo sản phẩm có thêm hình phụ nữ và em bé."

---

# 3. EXISTING WORKFLOW TO PRESERVE

Keep the strong parts of the existing Template Pro flow:

```text
Step 1 — Product analysis + 4-scene script generation
Step 2 — 4x parallel storyboard generation
Step 3 — storyboard QA + best candidate selection
Step 4 — natural slicing into 4 panels
Step 5 — user review / remake scene / remake all
Step 6 — TTS generation
Step 7 — 4 x 4-second Start Frame video generation
Step 8 — splice into 16-second final video
Step 9 — mux TTS + video
Step 10 — delivery / upload actions
```

Do NOT rewrite the whole infrastructure unless necessary.

This migration primarily changes:

- asset input architecture,
- prompt architecture,
- analysis JSON schema,
- character strategy,
- storyboard rules,
- QA scoring,
- video generation prompts,
- validation/error handling,
- channel world consistency.

---

# 4. NEW ASSET SOURCE ARCHITECTURE

The system must explicitly separate CHARACTER references from PRODUCT references.

## 4.1 Required Asset Groups

```text
ASSET SOURCE

A. CHANNEL CHARACTER ASSETS
   mother_reference
   baby_reference

B. PRODUCT ASSETS
   product_reference_01
   product_reference_02
   ...
   product_reference_N

C. PRODUCT METADATA
   product_name
   product_description
   category
   variants
   material
   usage_notes
   selling_points
```

Do not send all images into one undifferentiated reference array.

Every image reference must have an explicit semantic role.

---

# 5. REFERENCE ROLE MAPPING

Before any image-generation prompt, construct a reference map.

Example:

```text
REFERENCE ROLE MAPPING

[MOTHER_REFERENCE]
Asset ID: <motherAssetId>
Purpose:
This image defines the permanent mother character identity for this channel.

[BABY_REFERENCE]
Asset ID: <babyAssetId>
Purpose:
This image defines the permanent baby character identity for this channel.

[PRODUCT_REFERENCE_01]
Asset ID: <productAssetId1>
Purpose:
This image defines the exact product being reviewed.

[PRODUCT_REFERENCE_02]
Asset ID: <productAssetId2>
Purpose:
Additional product angle / color / detail reference.
```

The model must never be expected to infer which image is mother, baby, or product.

---

# 6. INPUT VALIDATION

Before Step 1 starts, validate assets.

Required:

```text
mother_reference exists
baby_reference exists
>= 1 product_reference exists
product_name exists
product_description exists or product image analysis is possible
```

If a character asset is missing:

- do not silently replace with a generic person,
- do not generate a random mother,
- do not generate a random baby,
- surface a clear pipeline error.

Suggested internal error codes:

```text
ERR_MISSING_MOTHER_REFERENCE
ERR_MISSING_BABY_REFERENCE
ERR_MISSING_PRODUCT_REFERENCE
ERR_INVALID_PRODUCT_METADATA
```

---

# 7. DELETE ALL FACELESS LOGIC

Search the codebase and remove or replace every rule containing concepts such as:

```text
faceless
strictly faceless
NO visible human faces
hands only
wrists only
body silhouette only
chest down
hide face
face must not appear
anonymous model
generic Asian model
```

The current channel is explicitly face-visible.

Do NOT simply add a new rule below an old `Strictly faceless` rule.

The old rule must be removed from the final constructed prompt.

---

# 8. NEW VISUAL PRIORITY ORDER

Old priority:

```text
P1 Product Fidelity
P2 Scene Accuracy
P3 Commercial Composition
P4 Visual Consistency
```

Replace with:

```text
P1 Character Identity Fidelity
P2 Product Fidelity
P3 Human/Product Interaction Accuracy
P4 Commercial Composition
P5 Cross-Panel Visual Continuity
```

Reason:

- products change every video,
- mother + baby are the permanent visual identity of the channel.

---

# 9. PRIORITY 1 — CHARACTER IDENTITY FIDELITY

Use a prompt block similar to this:

```text
PRIORITY 1 — CHARACTER IDENTITY FIDELITY

THIS CHANNEL IS NOT FACELESS.

The uploaded MOTHER_REFERENCE and BABY_REFERENCE define the two recurring on-camera characters.

MOTHER IDENTITY LOCK:
- The MOTHER_REFERENCE is the ONLY identity source for the mother.
- Preserve the same recognizable woman.
- Preserve facial structure.
- Preserve eye shape.
- Preserve nose shape.
- Preserve lips.
- Preserve skin tone.
- Preserve approximate age.
- Preserve hair identity unless the scene logically requires a minor natural hairstyle variation.
- Preserve overall body proportions.
- Her face MAY and SHOULD be visible whenever appropriate.
- Do NOT replace her with a generic Asian woman.
- Do NOT beautify her into a different person.
- Do NOT change ethnicity.
- Do NOT significantly change apparent age.
- Do NOT create a second mother.

BABY IDENTITY LOCK:
- The BABY_REFERENCE is the ONLY identity source for the baby.
- Preserve the same recognizable baby.
- Preserve facial proportions.
- Preserve eye shape.
- Preserve nose and mouth proportions.
- Preserve skin tone.
- Preserve hair.
- Preserve approximate age and developmental stage.
- Preserve approximate body proportions.
- Do NOT replace the baby with another child.
- Do NOT age the baby up.
- Do NOT age the baby down.
- Do NOT create twins unless explicitly requested.
- Do NOT create an additional baby.

IDENTITY CONTINUITY:
Across all generated storyboard panels, the mother and baby must remain the exact same two recurring characters defined by the references.
```

---

# 10. CHARACTER PRESENCE MUST BE SCENE-DEPENDENT

Do NOT require both mother and baby in every scene.

The analysis model must decide which character appears based on product usage and storytelling.

Allowed values:

```text
mother
baby
mother_and_baby
```

Per-scene allowed arrays:

```json
["mother"]
["baby"]
["mother", "baby"]
```

Examples:

## Breast pump

```text
Hook       → mother
Solution   → mother
Proof      → mother
Closing    → mother + baby
```

## Baby bib

```text
Hook       → mother + baby
Solution   → baby
Proof      → mother + baby
Closing    → mother + baby
```

## Diaper bag

```text
Hook       → mother
Solution   → mother
Proof      → mother
Closing    → mother + baby
```

## Baby toy

```text
Hook       → baby
Solution   → mother + baby
Proof      → baby
Closing    → mother + baby
```

## Postpartum product for mother

```text
Hook       → mother
Solution   → mother
Proof      → mother
Closing    → mother
```

---

# 11. PRODUCT DOMAIN

This Template Pro variant is focused on mother & baby related products.

Examples include but are not limited to:

```text
feeding
bottles
bottle warmers
sterilizers
breast pumps
milk storage
baby food tools
weaning products
baby bibs
baby bowls
baby spoons
high-chair accessories

diapers
wipes
diaper bags
changing mats
baby skincare
baby bath
baby towels
bath toys

baby clothes
baby shoes
socks
hats
swaddles
sleep sacks

crib accessories
nursery products
night lights
baby monitors
white-noise machines

strollers
car-seat accessories
travel organizers
baby carriers

toys
sensory toys
books
teethers
learning products

postpartum products
mom skincare
nursing bras
maternity wear
breastfeeding accessories

storage and organization products
when directly relevant to mother/baby life
```

The channel must stay contextually mother-and-baby oriented even when a product is technically a generic household item.

Example:

A storage basket should be framed as:

```text
organizing diapers / baby clothes / feeding items
```

not generic home organization.

---

# 12. STEP 1 — NEW ANALYSIS ROLE

Replace the old generic strategist identity with:

```text
TEXT-ONLY TASK.
Do not generate images.
Do not call image generation.
Do not create a visual storyboard asset.

You are a senior Mother & Baby TikTok commerce strategist,
short-form content director,
family lifestyle visual planner,
and Veo / image-generation prompt writer.

You create product content from the point of view of one recurring young mother and her recurring baby.

The mother and baby are permanent channel characters defined by external reference assets.

Analyze:
1. the uploaded product reference images,
2. the TikTok Shop product metadata,
3. the intended user,
4. who should appear in each scene,
5. how the product naturally fits the mother's or baby's real daily life.

Return a complete 4-scene product-review plan as JSON only.
```

---

# 13. STEP 1 — MARKETING FRAMEWORK

Keep the four phases:

```text
1. HOOK
2. SOLUTION
3. PROOF
4. CLOSING
```

But change the creative interpretation.

---

# 14. SCENE 1 — HOOK

Goal:

```text
Hook gì khiến mẹ bỉm dừng lướt?
```

Preferred sources of hooks:

- real parenting frustration,
- baby routine,
- feeding mess,
- diaper changing,
- sleep routine,
- carrying too much outside,
- cleaning baby items,
- baby refusing something,
- mom struggling with convenience,
- mom discovering a useful product.

Preferred language examples:

```text
"Mẹ nào cho bé ăn dặm chắc hiểu cảnh này nè..."

"Từ ngày có bé tui mới biết món này tiện dữ thần."

"Nhà nào có bé hay quăng đồ xuống đất coi cái này nè."

"Trước mỗi lần đưa con ra ngoài tui ngán nhất cái khúc này."

"Không biết các mẹ sao chứ hồi trước tui cứ vật lộn với cái này hoài."

"Bé nhà tui cứ tới giờ này là y như rằng..."
```

Avoid overused generic hooks such as:

```text
"Bữa giờ TikTok rần rần..."
```

They may still be used occasionally but must NOT be the default.

---

# 15. SCENE 2 — SOLUTION

The product should enter naturally.

Example logic:

```text
Mom problem → product solves it
Baby need → product supports it
Routine friction → product simplifies it
```

The product should feel discovered through real use.

Do not write TVC-style claims.

---

# 16. SCENE 3 — PROOF

Proof should be visually demonstrable.

Possible proof types:

```text
material close-up
fit on baby
actual feeding use
spill resistance
ease of cleaning
softness
size
foldability
storage
grip
comfort
real baby interaction
real mom usage
before/after routine improvement
physical construction
practical setup
```

Avoid unsupported medical or developmental claims.

Do not invent specifications not visible in product references or metadata.

---

# 17. SCENE 4 — CLOSING

Closing should show the product integrated into mother/baby lifestyle.

Examples:

```text
mom and baby using the item comfortably
baby happily engaged with product
mom packing product into diaper bag
clean nursery scene with the product in use
feeding routine completed naturally
mom holding baby while product remains visible in context
```

CTA remains voice-only.

Do NOT create:

```text
shopping cart icons
fake UI
pointer arrows
finger pointing to screen corner
cart badges
price labels
discount badges
```

---

# 18. BUYER ANGLE

Replace the generic buyer-angle system with mother/baby-focused values:

```text
for_baby
for_mother
for_mother_and_baby
for_parenting_routine
gift_for_new_mom
gift_for_baby
```

Optional compatibility mapping:

```text
self_use             -> for_mother
for_kids             -> for_baby
for_family           -> for_mother_and_baby
gift_for_partner     -> remove from this template
for_parents          -> remove from this template
```

---

# 19. TARGET USER CLASSIFICATION

Allowed examples:

```text
baby
toddler
mother
postpartum_mother
breastfeeding_mother
mother_and_baby
parents_with_baby
```

If the product primarily serves the mother but indirectly helps the baby:

```text
targetUser = mother
buyerAngle = for_mother
```

If the product is worn/used directly by the baby:

```text
targetUser = baby
buyerAngle = for_baby
```

---

# 20. CHARACTER STRATEGY SCHEMA

Add this object:

```json
"characterStrategy": {
  "primaryCharacter": "mother|baby|mother_and_baby",
  "motherRole": "user|reviewer|caregiver|demonstrator|supporting|none",
  "babyRole": "user|recipient|demonstration_context|supporting|none",
  "relationshipDynamic": "short natural description",
  "sceneCastingReason": "why these characters are used for this product"
}
```

---

# 21. NEW SCENE CASTING SCHEMA

Every scene MUST include:

```json
"characters": ["mother"]
```

or:

```json
"characters": ["baby"]
```

or:

```json
"characters": ["mother", "baby"]
```

Never leave the cast implicit.

---

# 22. REPLACE `techVFX`

The field name `techVFX` is misleading.

Replace with:

```text
humanInteraction
```

Recommended structure:

```json
"humanInteraction": {
  "characters": ["mother", "baby"],
  "motherAction": "what the mother physically does",
  "babyAction": "what the baby physically does",
  "productInteraction": "how the product is actually used",
  "facialExpression": "natural emotion",
  "gazeDirection": "where mother/baby are looking",
  "physicalContact": "how mother, baby and product make contact"
}
```

If only mother is present:

```json
"humanInteraction": {
  "characters": ["mother"],
  "motherAction": "...",
  "babyAction": "none",
  "productInteraction": "...",
  "facialExpression": "...",
  "gazeDirection": "...",
  "physicalContact": "..."
}
```

---

# 23. STEP 1 JSON SCHEMA

Use this updated schema.

```json
{
  "analysis": {
    "productName": "Exact Vietnamese product name",
    "category": "mother_baby",
    "subCategory": "feeding|sleep|hygiene|travel|clothing|toy|nursery|postpartum|breastfeeding|storage|other",
    "targetUser": "baby|toddler|mother|postpartum_mother|breastfeeding_mother|mother_and_baby|parents_with_baby",
    "buyerAngle": "for_baby|for_mother|for_mother_and_baby|for_parenting_routine|gift_for_new_mom|gift_for_baby",
    "addressStyle": "các mẹ|mẹ nào|nhà nào có bé|mẹ bỉm|mọi người",
    "cartAnchorText": "CTA anchor under 30 characters",
    "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
    "materials": "verified product materials only",
    "highlights": [
      "highlight 1",
      "highlight 2",
      "highlight 3"
    ],
    "targetAudience": "target audience summary",
    "characterStrategy": {
      "primaryCharacter": "mother|baby|mother_and_baby",
      "motherRole": "user|reviewer|caregiver|demonstrator|supporting|none",
      "babyRole": "user|recipient|demonstration_context|supporting|none",
      "relationshipDynamic": "natural mother-baby dynamic",
      "sceneCastingReason": "casting rationale"
    },
    "fourAnswers": {
      "hook": "What real mom-life hook stops scrolling?",
      "solution": "How does product solve the actual need?",
      "proof": "What visible evidence makes the product believable?",
      "closing": "Why would a mother want it now?"
    }
  },

  "voicePersona": {
    "gender": "nu",
    "voiceDescription": "nữ miền Nam trẻ, tự nhiên, gần gũi, đúng chất mẹ bỉm chia sẻ thật",
    "tone": "ấm áp, hoạt bát vừa phải, đời thường, thân thiện, không TVC"
  },

  "sceneContext": {
    "worldId": "mother_baby_home",
    "location": "selected recurring family environment",
    "lighting": "soft natural daylight with subtle warm practical lighting",
    "mood": "warm, real, intimate, believable family lifestyle"
  },

  "script": [
    {
      "id": 1,
      "phase": "Hook",
      "goal": "mom-life hook",
      "characters": ["mother", "baby"],
      "voiceOver": "16-18 Vietnamese words",
      "visualDescription": "exact visual scene",
      "humanInteraction": {
        "characters": ["mother", "baby"],
        "motherAction": "...",
        "babyAction": "...",
        "productInteraction": "...",
        "facialExpression": "...",
        "gazeDirection": "...",
        "physicalContact": "..."
      },
      "cameraAction": "..."
    },
    {
      "id": 2,
      "phase": "Solution",
      "goal": "...",
      "characters": ["mother"],
      "voiceOver": "16-18 Vietnamese words",
      "visualDescription": "...",
      "humanInteraction": {
        "characters": ["mother"],
        "motherAction": "...",
        "babyAction": "none",
        "productInteraction": "...",
        "facialExpression": "...",
        "gazeDirection": "...",
        "physicalContact": "..."
      },
      "cameraAction": "..."
    },
    {
      "id": 3,
      "phase": "Proof",
      "goal": "...",
      "characters": ["baby"],
      "voiceOver": "16-18 Vietnamese words",
      "visualDescription": "...",
      "humanInteraction": {
        "characters": ["baby"],
        "motherAction": "none",
        "babyAction": "...",
        "productInteraction": "...",
        "facialExpression": "...",
        "gazeDirection": "...",
        "physicalContact": "..."
      },
      "cameraAction": "..."
    },
    {
      "id": 4,
      "phase": "Closing",
      "goal": "...",
      "characters": ["mother", "baby"],
      "voiceOver": "16-18 Vietnamese words",
      "visualDescription": "...",
      "humanInteraction": {
        "characters": ["mother", "baby"],
        "motherAction": "...",
        "babyAction": "...",
        "productInteraction": "...",
        "facialExpression": "...",
        "gazeDirection": "...",
        "physicalContact": "..."
      },
      "cameraAction": "..."
    }
  ]
}
```

---

# 24. SCRIPT LENGTH RULES

Keep:

```text
4 scenes
16-18 words per scene
65-70 words total
16 seconds final video
```

However, implement word-count validation programmatically.

Do NOT rely only on the LLM.

Validation:

```text
scene 1: 16 <= words <= 18
scene 2: 16 <= words <= 18
scene 3: 16 <= words <= 18
scene 4: 16 <= words <= 18
total: 65 <= words <= 70
```

If invalid:

```text
repair or regenerate before storyboard generation
```

---

# 25. LANGUAGE STYLE

Main audience: Vietnamese mothers.

Preferred address terms:

```text
các mẹ
mẹ nào
mẹ bỉm
nhà nào có bé
mọi người
cả nhà
```

Avoid:

```text
anh em
mấy ông
bác nào
chị em mua cho chồng
```

Remove from this template.

The word:

```text
"mấy bà"
```

should preferably not be used.

If retained for stylistic variation:

```text
max 1 occurrence per full script
```

but default should be 0.

---

# 26. VOICE PERSONA

Use a female Southern Vietnamese voice.

New persona:

```text
Young Southern Vietnamese mother.
Warm, friendly, lively but not aggressively salesy.
Sounds like a real mother sharing something useful with other mothers.
Natural conversational rhythm.
Clear pronunciation.
Fast enough for short-form content, but not unnaturally rushed.
```

Avoid excessive Gen-Z sales hype.

Avoid making every product sound:

```text
"cưng xỉu"
"xịn xò"
"hết nước chấm"
"đỉnh dữ thần"
```

These phrases may appear occasionally, but the voice should sound authentic and varied.

---

# 27. HEALTH / BABY SAFETY CLAIM RULE

Because the channel involves babies:

Do NOT invent claims such as:

```text
guaranteed safe
medical-grade
prevents disease
improves development
prevents allergies
improves sleep
doctor recommended
BPA-free
non-toxic
sterile
antibacterial
hypoallergenic
```

unless supported by source metadata / packaging / verified product information.

Prefer:

```text
"theo mô tả sản phẩm..."
"thiết kế..."
"chất liệu được ghi là..."
```

internally when needed.

Visual prompts must not imply unsafe usage.

---

# 28. BABY SAFETY VISUAL RULES

Hard rules:

```text
No baby near dangerous heat sources.
No unsupported baby on high surfaces.
No unsafe sleeping position.
No loose objects covering baby face.
No choking-hazard interaction unless product is intended and age-appropriate.
No baby handling sharp objects.
No baby directly touching unsafe appliances.
No physically impossible posture.
No forced adult-like gestures.
```

For uncertain situations, let the mother demonstrate the product instead.

---

# 29. CHANNEL WORLD

Replace the generic modern-home world with a recurring Mother & Baby world.

Use:

```text
MOTHER & BABY CHANNEL WORLD

A warm, believable Vietnamese young-family home.

Recurring environments:
- bright living room
- cozy nursery
- mother's bedroom
- baby changing area
- feeding / dining corner
- clean family bathroom
- compact modern kitchen
- stroller / outdoor family outing when relevant

Visual style:
- authentic Vietnamese family lifestyle
- warm and lived-in
- clean but not showroom-perfect
- subtle baby belongings in background
- soft natural daylight
- slight warm practical lighting
- realistic smartphone photography
- no artificial luxury showroom look
```

---

# 30. WORLD CONSISTENCY

The environment should feel like the same family home across the channel.

Do NOT require exact pixel-identical rooms across every product.

Instead preserve recurring design language:

```text
similar wall tone
similar wood tone
similar soft textile palette
similar daylight direction
similar nursery aesthetic
similar furniture style
similar warm family atmosphere
```

This allows creative flexibility while retaining channel identity.

---

# 31. MASTER STORYBOARD PROMPT — NEW BASE

Use this as the foundation.

```text
Generate one Mother & Baby product review storyboard image as a still photo collage.

THIS CHANNEL IS NOT FACELESS.

Use the provided references according to their explicit roles:

[MOTHER_REFERENCE]
Defines the exact recurring mother identity.

[BABY_REFERENCE]
Defines the exact recurring baby identity.

[PRODUCT_REFERENCES]
Define the exact product.

The final storyboard must preserve BOTH character identity fidelity and product fidelity.

CRITICAL VISUAL PRIORITIES:

1. CHARACTER IDENTITY FIDELITY
2. PRODUCT FIDELITY
3. HUMAN / PRODUCT INTERACTION ACCURACY
4. COMMERCIAL COMPOSITION
5. CROSS-PANEL CONTINUITY

PRIORITY 1 — CHARACTER IDENTITY FIDELITY

Mother:
- use the exact identity from MOTHER_REFERENCE
- face is allowed and expected
- preserve facial structure, eyes, nose, lips, skin tone, hair identity and approximate age
- never replace with a different woman
- never create duplicate mothers

Baby:
- use exact identity from BABY_REFERENCE
- preserve face, skin tone, hair, age and developmental stage
- never replace with a different child
- never create duplicate babies
- never significantly age up/down

Only include the characters specified by each scene's `characters` field.

If characters = ["mother"], DO NOT add the baby.

If characters = ["baby"], DO NOT add the mother unless physically required for safety and explicitly specified.

If characters = ["mother", "baby"], show the same reference mother and same reference baby together.

PRIORITY 2 — PRODUCT FIDELITY

Strictly preserve:
- silhouette
- body shape
- component count
- proportions
- color
- material
- texture
- logo if naturally visible in source
- functional structure

No product mutation.
No invented accessories.
No competitor redesign.
No unexplained color change.

PRIORITY 3 — REALISTIC INTERACTION

Follow each scene's humanInteraction exactly.

Ensure:
- anatomically correct adult hands
- anatomically correct baby limbs
- realistic contact
- correct grip
- correct wear/use
- no clipping
- no floating objects
- no merged fingers
- no duplicate limbs
- no unsafe baby positioning

PRIORITY 4 — COMMERCIAL COMPOSITION

Keep product clearly readable and visually important,
but do not make the shot look like a sterile studio advertisement.

The scene should feel like a real mother/baby lifestyle moment captured on a high-end smartphone.

STRICT NO-TEXT RULE:
- no captions
- no badges
- no fake typography
- no stickers
- no UI
- no watermark
- no fake promotional graphics

STRICT NO CART UI:
- no cart icon
- no price badge
- no arrows
- no finger pointing at screen corners

PRIORITY 5 — CONTINUITY

Across all four panels:
- same mother identity whenever mother appears
- same baby identity whenever baby appears
- same exact product
- same channel-world visual language
- compatible lighting
- compatible color temperature
- compatible family-home aesthetic

STORYBOARD FORMAT:

Exactly 4 panels side-by-side in one horizontal 16:9 image.

Each panel is designed to later be sliced into a natural vertical panel.

Panel 1 = Hook
Panel 2 = Solution
Panel 3 = Proof
Panel 4 = Closing

Output:
still photograph collage only.
Do NOT generate a video.
```

Append the generated Step 1 scene plan after this block.

---

# 32. STORYBOARD COMPOSITION CHANGE

Old generic visual patterns like:

```text
close-up hand holding product
product on premium surface
product-only lifestyle scene
```

must no longer be default.

The storyboard should follow the scene cast.

Examples:

## Mother scene

```text
medium shot or medium-close lifestyle framing
face visible
product clearly readable
natural body posture
```

## Baby scene

```text
safe baby-centered framing
age-appropriate posture
product usage visible
baby face visible
```

## Mother + baby scene

```text
natural relationship moment
mother looks at baby when appropriate
baby reacts naturally
product integrated into the action
```

---

# 33. CAMERA RULES

Use realistic smartphone cinematography.

Preferred:

```text
24mm / 26mm smartphone main camera aesthetic
natural perspective
medium shot
medium close-up
close-up only for proof/details
subtle handheld realism
stable enough for commerce
natural depth of field
```

Do NOT use extreme artificial bokeh.

Do NOT make every panel a macro product shot.

Faces should remain sharp enough for identity recognition.

---

# 34. ANATOMY RULES

For mother:

```text
2 arms unless occluded naturally
5 fingers per visible hand
natural joints
natural posture
realistic grip
```

For baby:

```text
correct number of limbs
age-appropriate proportions
age-appropriate pose
small natural hand shape
no adult-like fingers
no warped feet
no fused limbs
no impossible neck rotation
```

---

# 35. STORYBOARD QA — NEW SCORING

Replace the old product-heavy score with:

```text
Mother Identity Fidelity       20
Baby Identity Fidelity         20
Product Fidelity               20
Human / Baby Anatomy           10
Product Interaction Accuracy   10
Scene / Story Accuracy          8
Cross-Panel Continuity          7
Commercial Composition          5
----------------------------------
TOTAL                         100
```

If a character is not used anywhere in a storyboard due to product context, redistribute their score proportionally.

Example: mother-only postpartum product:

```text
Mother Identity Fidelity       35
Product Fidelity               25
Human Anatomy                  10
Product Interaction            10
Scene Accuracy                  8
Continuity                      7
Composition                     5
```

---

# 36. HARD REJECT CONDITIONS

Reject a storyboard immediately if any of the following occurs:

```text
wrong mother identity
wrong baby identity
mother face severely mutated
baby face severely mutated
baby age changed significantly
different baby appears between panels
different mother appears between panels
extra mother
extra baby
duplicate baby
duplicate mother
product model changed
product color changed without reference
missing critical product component
hallucinated critical product component
malformed baby limbs
malformed adult hands
unsafe baby positioning
product used in obviously incorrect way
major scene does not match generated plan
```

Hard reject must override numerical score.

---

# 37. QA OUTPUT SCHEMA

Suggested:

```json
{
  "candidateId": 1,
  "hardReject": false,
  "hardRejectReasons": [],
  "scores": {
    "motherIdentity": 18,
    "babyIdentity": 19,
    "productFidelity": 18,
    "anatomy": 9,
    "interaction": 9,
    "sceneAccuracy": 8,
    "continuity": 7,
    "composition": 5
  },
  "total": 93,
  "panelScores": {
    "1": 92,
    "2": 94,
    "3": 91,
    "4": 95
  },
  "notes": "..."
}
```

---

# 38. PANEL REPLACEMENT

Keep the existing ability to replace individual panels.

However, when replacing one panel, always pass:

```text
mother reference
baby reference
product references
selected master storyboard
scene-specific cast
scene-specific interaction
channel world
```

The replacement panel must match identities from the selected storyboard.

---

# 39. SLICING

Keep current zero-distortion natural slicing.

Do NOT change aspect logic unless implementation requires it.

Requirements:

```text
no stretching
no facial crop
no baby head crop
no product-critical-area crop
```

If the current 4:9 slice is preserved, composition prompts must reserve safe margins.

---

# 40. STEP 1 VALIDATION GATE — MANDATORY

The current system must NOT continue when the analysis JSON is broken.

New required flow:

```text
Gemini analysis response
        ↓
extract JSON
        ↓
JSON.parse
        ↓
schema validation
        ↓
semantic validation
        ↓
word-count validation
        ↓
scene-cast validation
        ↓
PASS?
   ├─ NO → repair/regenerate
   └─ YES → storyboard generation
```

Never create storyboard from `N/A` scenes.

Never proceed with 0-word voiceOver.

---

# 41. VALIDATION REQUIREMENTS

Required fields:

```text
analysis.productName
analysis.category
analysis.targetUser
analysis.buyerAngle
analysis.characterStrategy
analysis.fourAnswers.hook
analysis.fourAnswers.solution
analysis.fourAnswers.proof
analysis.fourAnswers.closing

script.length === 4

for each script item:
id
phase
goal
characters
voiceOver
visualDescription
humanInteraction
cameraAction
```

---

# 42. CAST VALIDATION

Allowed cast values only:

```json
["mother"]
["baby"]
["mother", "baby"]
```

Reject:

```json
[]
["woman"]
["child"]
["mother", "child"]
["parents"]
["family"]
```

Use explicit canonical character names.

---

# 43. RETRY STRATEGY

Recommended maximum:

```text
attempt 1 = original generation
attempt 2 = repair malformed JSON
attempt 3 = regenerate full output with validation errors included
```

If still invalid:

```text
stop pipeline
return structured error
```

Do not silently invent fallback scenes.

---

# 44. TTS SCRIPT CONSTRUCTION

TTS should use the validated four voiceOver lines in order:

```text
scene1.voiceOver
scene2.voiceOver
scene3.voiceOver
scene4.voiceOver
```

Do not regenerate a separate unrelated TTS script after storyboard approval.

The spoken content must remain consistent with approved storyboard logic.

---

# 45. TTS STYLE

Suggested prompt:

```text
Giọng nữ miền Nam trẻ, ấm áp, tự nhiên, giống một mẹ bỉm đang chia sẻ món đồ thật sự dùng trong cuộc sống hằng ngày.

Nhịp nói nhanh vừa đủ cho TikTok nhưng không dồn dập kiểu quảng cáo.
Phát âm rõ.
Có cảm xúc tự nhiên.
Không kéo dài nguyên âm.
Không đọc như TVC.
Không quá phấn khích.
Không gằn giọng bán hàng.

Đọc trọn kịch bản trong khoảng 15-16 giây.
Không cutoff.
```

---

# 46. VIDEO GENERATION — GENERAL CHANGE

Delete all instances of:

```text
faceless
face hidden
hands only
no visible face
```

from 4-second video prompts.

The Start Frame remains authoritative for:

```text
character identity
product identity
wardrobe
scene setup
lighting
camera position
```

---

# 47. VIDEO CHARACTER CONTINUITY LOCK

Append this block to every 4-second scene prompt:

```text
CHARACTER CONTINUITY LOCK

This channel is NOT faceless.

If the mother is visible in the Start Frame:
- she is the canonical recurring mother
- preserve her exact facial identity from frame 0 through frame 4
- preserve facial geometry
- preserve skin tone
- preserve hair identity
- preserve approximate age
- no face swap
- no identity drift
- no second woman
- no duplicate mother

If the baby is visible in the Start Frame:
- the baby is the canonical recurring baby
- preserve exact facial identity
- preserve approximate age
- preserve facial proportions
- preserve skin tone
- preserve hair
- no age morphing
- no child replacement
- no second baby
- no duplicate baby

No identity morphing during motion.

All facial movement must be subtle, natural and consistent with the Start Frame.
```

---

# 48. VIDEO ACTION LOCKDOWN — UPDATED

Keep product anti-morphing, but do NOT freeze all actions unnaturally.

Use:

```text
ACTION LOCKDOWN

The scene must begin exactly from the approved Start Frame.

Preserve:
- exact character identities
- exact product geometry
- wardrobe
- room layout
- lighting
- starting pose

Allowed movement:
- subtle mother hand movement
- natural gaze changes
- gentle smile
- natural baby head movement
- small baby hand movement
- realistic product interaction defined by the scene
- gentle camera drift if requested

Forbidden:
- character transformation
- product transformation
- sudden wardrobe change
- new person entering
- duplicate character
- unexplained object appearance
- extreme camera movement
- fantasy VFX
```

---

# 49. VIDEO PROMPT TEMPLATE — MOTHER ONLY

```text
Tạo video review sản phẩm dài đúng 4 giây theo mode Start Frame.

Cảnh này có MẸ בלבד.

Bắt đầu chính xác từ approved Start Frame.

IDENTITY:
Người mẹ trong Start Frame là nhân vật mẹ cố định của kênh.
Giữ nguyên nhận diện khuôn mặt từ giây 0 đến giây 4.
Không đổi người.
Không face swap.
Không thay tuổi.
Không tạo thêm phụ nữ.
Không tạo em bé nếu scene cast không có baby.

PRODUCT:
Giữ nguyên tuyệt đối kiểu dáng, màu sắc, vật liệu, cấu tạo và số lượng bộ phận của sản phẩm.

ACTION:
<insert motherAction>
<insert productInteraction>

FACIAL PERFORMANCE:
<insert facialExpression>
<insert gazeDirection>

CAMERA:
<insert cameraAction>

REALISM:
Chuyển động nhỏ, tự nhiên, đúng vật lý.
Phong cách smartphone lifestyle chân thực.

NO TEXT.
NO CART ICON.
NO UI.
NO FAKE OVERLAY.
NO CGI.
Video im lặng.
```

---

# 50. VIDEO PROMPT TEMPLATE — BABY ONLY

```text
Tạo video review sản phẩm dài đúng 4 giây theo mode Start Frame.

Cảnh này có BÉ בלבד.

Bắt đầu chính xác từ approved Start Frame.

IDENTITY:
Em bé trong Start Frame là nhân vật bé cố định của kênh.
Giữ nguyên nhận diện khuôn mặt, độ tuổi, tỉ lệ khuôn mặt, màu da và mái tóc.
Không đổi sang em bé khác.
Không age morphing.
Không tạo thêm em bé.
Không tạo mẹ nếu scene cast không yêu cầu.

BABY SAFETY:
Tư thế phải an toàn, đúng độ tuổi và hợp vật lý.
Không tạo chuyển động người lớn.
Không tạo tư thế nguy hiểm.
Không làm biến dạng tay/chân.

PRODUCT:
Giữ nguyên tuyệt đối sản phẩm.

ACTION:
<insert babyAction>
<insert productInteraction>

FACIAL PERFORMANCE:
<insert facialExpression>
<insert gazeDirection>

CAMERA:
<insert cameraAction>

NO TEXT.
NO CART ICON.
NO UI.
NO CGI.
Video im lặng.
```

---

# 51. VIDEO PROMPT TEMPLATE — MOTHER + BABY

```text
Tạo video review sản phẩm dài đúng 4 giây theo mode Start Frame.

Cảnh này có đúng hai nhân vật:
1. người mẹ cố định của kênh
2. em bé cố định của kênh

Bắt đầu chính xác từ approved Start Frame.

IDENTITY LOCK:
Giữ nguyên chính xác nhận diện của cả mẹ và bé từ giây 0 đến giây 4.

Không thay mặt.
Không đổi người.
Không tạo thêm mẹ.
Không tạo thêm bé.
Không duplicate.
Không age morphing.

RELATIONSHIP:
Chuyển động giữa mẹ và bé phải tự nhiên như quan hệ mẹ-con thật.

MOTHER ACTION:
<insert motherAction>

BABY ACTION:
<insert babyAction>

PRODUCT INTERACTION:
<insert productInteraction>

PHYSICAL CONTACT:
<insert physicalContact>

FACIAL EXPRESSION:
<insert facialExpression>

GAZE:
<insert gazeDirection>

CAMERA:
<insert cameraAction>

BABY SAFETY:
Tất cả tư thế và tương tác phải an toàn, đúng độ tuổi và đúng vật lý.

PRODUCT LOCK:
Giữ nguyên 100% sản phẩm.

NO TEXT.
NO CART ICON.
NO UI.
NO CGI.
Video im lặng.
```

---

# 52. VIDEO HARD-FAIL QA

After each generated 4-second video, if video QA exists or can be added, hard fail on:

```text
mother identity drift
baby identity drift
face morph
baby becomes older/younger
new person appears
extra baby
product morph
product disappears
extra limbs
unsafe baby motion
scene diverges from Start Frame
```

Prefer regenerate the individual scene instead of regenerating all 4 scenes.

---

# 53. REMAKE BEHAVIOR

Existing controls:

```text
Remake 1
Remake 2
Remake 3
Remake 4
Remake All
OK
```

should remain.

When Remake N is pressed:

```text
retain:
- mother asset
- baby asset
- product assets
- product analysis
- approved script
- scene cast
- channel world

regenerate:
- only target scene/panel
```

Do not recast characters.

---

# 54. CONTENT DIVERSITY RULE

Avoid making every video use the exact same pattern:

```text
mother holds product
mother smiles
baby sits next to product
```

The analysis model should vary naturally among:

```text
problem moment
routine moment
setup moment
feeding moment
packing moment
cleaning moment
baby reaction
mother demonstration
material proof
before/after organization
outdoor preparation
nursery routine
bath routine
sleep preparation
```

But always remain product-relevant.

---

# 55. PRODUCT-FIRST VS CHARACTER-FIRST BALANCE

Use:

```text
HOOK:
character / situation first

SOLUTION:
character + product

PROOF:
product or usage detail

CLOSING:
character lifestyle + product
```

This gives better narrative flow.

---

# 56. PANEL-SPECIFIC VISUAL GUIDANCE

## Panel 1 — Hook

Primary objective:

```text
emotion / recognizable parenting situation
```

Product does not have to dominate the frame if that weakens the hook.

## Panel 2 — Solution

Primary objective:

```text
clearly show product solving the problem
```

## Panel 3 — Proof

Primary objective:

```text
clear visual proof
```

Closer framing is allowed.

## Panel 4 — Closing

Primary objective:

```text
warm mother/baby lifestyle integration
```

Do not show fake CTA UI.

---

# 57. OVERLAYS

The storyboard image itself should remain no-text.

If `panelOverlays` are only metadata for later publishing, they can remain in JSON.

If they are being rendered into the storyboard image, stop doing that.

Preferred:

```text
storyboard = pure photography
overlay metadata = separate data layer
```

---

# 58. CART CTA

Voice-only CTA remains allowed.

Examples:

```text
"Mẹ nào đang cần thì bấm giỏ hàng coi thử nha."

"Nhà có bé nhỏ thì món này đáng để tham khảo lắm nè."

"Tui để em này trong giỏ, mẹ nào cần thì coi thử nghen."
```

Do not visually point at the cart.

---

# 59. HASHTAGS

Hashtag generation should now be mother/baby specific when relevant.

Examples:

```text
#mebimsua
#mevabe
#dobaby
#dodungchobe
#andam
#chamsocbe
#nuoicon
#meovatmebim
```

Still include product-specific hashtags.

---

# 60. CATEGORY MODEL

Use top-level category:

```text
mother_baby
```

Suggested subcategories:

```text
feeding
breastfeeding
sleep
hygiene
bath
diapering
travel
stroller
clothing
toy
teething
nursery
postpartum
mom_care
storage
safety
other
```

---

# 61. CONFIG OBJECT

Recommended new persistent channel config:

```json
{
  "channelType": "mother_baby",
  "faceless": false,
  "characters": {
    "motherAssetId": "<asset-id>",
    "babyAssetId": "<asset-id>"
  },
  "world": {
    "id": "mother_baby_home",
    "style": "warm Vietnamese young-family home",
    "lighting": "soft natural daylight + subtle warm practical light"
  },
  "voice": {
    "gender": "nu",
    "localeStyle": "southern_vietnamese",
    "persona": "young_mother"
  }
}
```

---

# 62. RECOMMENDED INTERNAL TYPES

Example TypeScript:

```ts
type CharacterId = 'mother' | 'baby';

type SceneCast =
  | ['mother']
  | ['baby']
  | ['mother', 'baby'];

interface CharacterStrategy {
  primaryCharacter: 'mother' | 'baby' | 'mother_and_baby';
  motherRole:
    | 'user'
    | 'reviewer'
    | 'caregiver'
    | 'demonstrator'
    | 'supporting'
    | 'none';
  babyRole:
    | 'user'
    | 'recipient'
    | 'demonstration_context'
    | 'supporting'
    | 'none';
  relationshipDynamic: string;
  sceneCastingReason: string;
}

interface HumanInteraction {
  characters: SceneCast;
  motherAction: string;
  babyAction: string;
  productInteraction: string;
  facialExpression: string;
  gazeDirection: string;
  physicalContact: string;
}

interface ScenePlan {
  id: 1 | 2 | 3 | 4;
  phase: 'Hook' | 'Solution' | 'Proof' | 'Closing';
  goal: string;
  characters: SceneCast;
  voiceOver: string;
  visualDescription: string;
  humanInteraction: HumanInteraction;
  cameraAction: string;
}
```

---

# 63. ASSET PASSING LOGIC

When generating storyboard candidate:

```ts
generateStoryboard({
  motherReference,
  babyReference,
  productReferences,
  analysis,
  channelWorld
})
```

Do not use:

```ts
generateStoryboard(allImages)
```

without role mapping.

---

# 64. PROMPT ASSEMBLY ORDER

Recommended prompt order:

```text
1. task definition
2. reference role mapping
3. character identity rules
4. product fidelity rules
5. interaction/safety rules
6. channel world
7. storyboard composition rules
8. no-text/no-cart rules
9. scene plan JSON
10. final generation instruction
```

Identity rules should appear before style language.

---

# 65. REFERENCE PRECEDENCE

When references conflict:

```text
Mother appearance → mother reference wins
Baby appearance → baby reference wins
Product appearance → product references win
Scene behavior → Step 1 scene plan wins
Environment → channel world + sceneContext
```

Never allow prompt text to overwrite identity defined by references.

---

# 66. DO NOT COPY PRODUCT CLOTHING/COLORS ONTO CHARACTERS

If product reference contains a model/person:

- do not use that person as mother,
- do not use that child as baby,
- use product reference only for product fidelity.

Character references always define identity.

---

# 67. PRODUCT REFERENCE WITH HUMAN MODEL

If a seller image contains another person:

```text
Ignore the seller's human model identity.
Use only the product visual information.
Replace all human identity with channel mother/baby references according to scene cast.
```

Add this explicitly to the storyboard prompt when relevant.

---

# 68. WARDROBE

The mother may wear simple recurring lifestyle clothing.

Do not require identical outfit in every video.

Within one storyboard/video:

```text
wardrobe continuity required across scenes unless scene logically changes location/time
```

For baby:

```text
same outfit across panels preferred unless product itself is clothing
```

If product is baby clothing:

```text
product clothing reference overrides default baby outfit
```

If product is maternal clothing:

```text
product clothing reference overrides default mother outfit
```

---

# 69. PRODUCT CLOTHING USE CASE

For baby clothing products:

```text
baby must wear the exact product where appropriate
identity must remain baby reference
product color/pattern must match reference
```

For mother clothing:

```text
mother must remain exact mother identity
body and face must not morph to match seller model
```

---

# 70. MULTIPLE PRODUCT VARIANTS

If product references contain multiple colors/variants:

Step 1 must select one variant.

Store:

```json
"selectedVariant": {
  "color": "...",
  "size": "...",
  "referenceIds": ["..."]
}
```

Storyboard and video must use one consistent variant.

Do not mix variants across panels.

---

# 71. LOGGING

Update execution logs to include:

```text
Channel Type
Mother Asset ID
Baby Asset ID
Product Reference IDs
Selected Variant
Character Strategy
Scene Cast per Panel
Storyboard Candidate Identity Scores
Hard Reject Reasons
Video Scene Character Locks
```

Example:

```text
Panel 1 Cast: mother + baby
Panel 2 Cast: mother
Panel 3 Cast: baby
Panel 4 Cast: mother + baby
```

---

# 72. DEBUGGING OUTPUT

When image generation fails identity QA, log:

```text
IDENTITY_FAIL_MOTHER
IDENTITY_FAIL_BABY
```

When anatomy fails:

```text
ANATOMY_FAIL_MOTHER
ANATOMY_FAIL_BABY
```

When product fails:

```text
PRODUCT_FIDELITY_FAIL
```

This will make iterative tuning easier.

---

# 73. MIGRATION CHECKLIST

AI coding agent must search the project for all old faceless assumptions.

Search keywords:

```text
faceless
Strictly faceless
NO visible human faces
handInteraction
hands only
wrists
silhouette from behind
chest down
anonymous model
PRODUCT STORYBOARD EVALUATION FRAMEWORK
Product Fidelity
techVFX
```

Review every occurrence.

---

# 74. REQUIRED CODE CHANGES

At minimum update:

```text
1. channel config
2. asset loading
3. reference mapping
4. Gemini Step 1 analysis prompt
5. Step 1 JSON schema
6. JSON validation
7. word-count validation
8. scene cast validation
9. storyboard master prompt
10. storyboard QA prompt
11. QA score structure
12. hard reject logic
13. panel remake prompt
14. video generation prompt
15. video remake prompt
16. logs
17. tests
```

---

# 75. DO NOT BREAK

Keep:

```text
4-scene flow
4 parallel storyboard candidates
best-candidate selection
per-panel remake
remake all
user approval
natural panel slicing
4 x 4-second video generation
16-second final assembly
TTS mux
Telegram interaction
upload flow
```

unless existing code architecture requires a minimal refactor.

---

# 76. ACCEPTANCE TEST — TEST CASE 1

Product:

```text
baby bib
```

Expected analysis:

```text
targetUser = baby
buyerAngle = for_baby
primaryCharacter = mother_and_baby
```

Possible cast:

```text
P1 mother + baby
P2 baby
P3 mother + baby
P4 mother + baby
```

Expected visuals:

- same mother face,
- same baby face,
- bib exact to reference,
- realistic feeding scene,
- no faceless rule,
- no random seller baby.

---

# 77. ACCEPTANCE TEST — TEST CASE 2

Product:

```text
breast pump
```

Expected:

```text
targetUser = breastfeeding_mother
buyerAngle = for_mother
```

Cast:

```text
P1 mother
P2 mother
P3 mother
P4 mother + baby
```

Baby does not need to appear in every scene.

---

# 78. ACCEPTANCE TEST — TEST CASE 3

Product:

```text
baby toy
```

Expected:

```text
P1 baby
P2 mother + baby
P3 baby
P4 mother + baby
```

Baby identity must match reference exactly.

---

# 79. ACCEPTANCE TEST — TEST CASE 4

Product:

```text
diaper bag
```

Expected:

```text
P1 mother
P2 mother
P3 mother
P4 mother + baby
```

Product must remain exact across panels.

---

# 80. ACCEPTANCE TEST — SELLER IMAGE CONTAINS MODEL

Given:

```text
product reference photo includes a random seller model and child
```

Expected:

```text
their faces must NOT be carried into storyboard
mother = channel mother reference
baby = channel baby reference
product = seller product reference
```

---

# 81. ACCEPTANCE TEST — MALFORMED STEP 1 JSON

Given malformed LLM output:

```text
JSON.parse fails
```

Expected:

```text
storyboard generation does not start
repair/regeneration occurs
```

Must never output N/A scenes and continue.

---

# 82. ACCEPTANCE TEST — WRONG BABY IN ONE PANEL

Given:

```text
P1 correct baby
P2 different baby
P3 correct baby
P4 correct baby
```

Expected:

```text
candidate hard rejected
```

Even if product score is high.

---

# 83. ACCEPTANCE TEST — FACELESS REGRESSION

If a generated master prompt contains:

```text
Strictly faceless
NO visible human faces
```

test must fail.

Add regression test to prevent old behavior from returning.

---

# 84. ACCEPTANCE TEST — SCENE DOES NOT REQUIRE BABY

For postpartum mother-only product:

Expected:

```text
baby may be absent from all four scenes
```

Do not force baby into frame only because a baby asset exists.

---

# 85. IMPLEMENTATION PHILOSOPHY

Do NOT implement this as:

```text
old faceless prompt
+
one sentence saying show the mother and baby
```

That will produce contradictory prompts.

Instead:

```text
remove old faceless assumptions
refactor prompt composition around explicit character roles
```

---

# 86. FINAL TARGET ARCHITECTURE

```text
                    ┌──────────────────────────┐
                    │ CHANNEL ASSET SOURCE     │
                    │                          │
                    │ Mother Reference         │
                    │ Baby Reference           │
                    │ Channel World Config     │
                    └────────────┬─────────────┘
                                 │
                                 │
PRODUCT INPUT                    │
─────────────                    │
Product Images ──────────────────┤
Product Metadata ────────────────┤
                                 ▼
                    ┌──────────────────────────┐
                    │ STEP 1 ANALYSIS          │
                    │ Mother/Baby Commerce     │
                    │ Story + Character Cast   │
                    └────────────┬─────────────┘
                                 │
                                 ▼
                      JSON + Schema Validation
                                 │
                         Word Count Validation
                                 │
                         Cast Validation
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │ STORYBOARD GENERATION    │
                    │                          │
                    │ Mother Ref               │
                    │ Baby Ref                 │
                    │ Product Refs             │
                    │ Scene Plan               │
                    │ Channel World            │
                    └────────────┬─────────────┘
                                 │
                                 ▼
                       4 Parallel Candidates
                                 │
                                 ▼
                        Identity/Product QA
                                 │
                        Hard Reject Checks
                                 │
                                 ▼
                       Best Storyboard
                                 │
                                 ▼
                         Natural Slicing
                                 │
                                 ▼
                         User Review
                     ┌───────────┴───────────┐
                     │                       │
                  Remake                  Approve
                     │                       │
                     └───────────┬───────────┘
                                 ▼
                              TTS
                                 │
                                 ▼
                    4 x 4s Start-Frame Video
                                 │
                         Character Lock
                         Product Lock
                         Baby Safety
                                 │
                                 ▼
                         Video Scene QA
                                 │
                                 ▼
                         16s Assembly
                                 │
                                 ▼
                           Audio Mux
                                 │
                                 ▼
                             Delivery
```

---

# 87. DEFINITION OF DONE

Migration is complete only when all of the following are true:

- [ ] No active storyboard/video prompt says faceless.
- [ ] Mother reference is loaded from Asset Source.
- [ ] Baby reference is loaded from Asset Source.
- [ ] Product references are separate from character references.
- [ ] Reference roles are explicitly mapped.
- [ ] Step 1 outputs characterStrategy.
- [ ] Every scene explicitly declares cast.
- [ ] Mother can appear with visible face.
- [ ] Baby can appear with visible face.
- [ ] Mother and baby are not forced into every scene.
- [ ] Same mother identity remains consistent.
- [ ] Same baby identity remains consistent.
- [ ] Product fidelity remains enforced.
- [ ] Baby safety rules are present.
- [ ] `handInteraction` / `techVFX` is replaced or migrated to `humanInteraction`.
- [ ] Storyboard QA scores character identity.
- [ ] Wrong mother/baby triggers hard reject.
- [ ] JSON parse/schema errors block pipeline.
- [ ] Invalid word counts block pipeline.
- [ ] N/A script scenes cannot reach storyboard generation.
- [ ] Panel remake retains character references.
- [ ] Video prompts contain character continuity lock.
- [ ] Video prompts no longer contain faceless rules.
- [ ] TTS uses approved scene voiceOver content.
- [ ] Existing remake / approve / slicing / assembly flow still works.
- [ ] Regression tests cover faceless removal and identity consistency.

---

# 88. IMPORTANT FINAL INSTRUCTION TO AI CODING AGENT

Treat this as a structural migration, not a wording-only prompt edit.

The most important architectural change is:

```text
OLD:
PRODUCT REFERENCES
      ↓
FACELESS STORYBOARD

NEW:
MOTHER IDENTITY
BABY IDENTITY
PRODUCT IDENTITY
      ↓
SCENE CASTING
      ↓
STORYBOARD
      ↓
IDENTITY QA
      ↓
VIDEO IDENTITY LOCK
```

The mother and baby are now permanent brand characters.

The product changes from video to video.

Every implementation choice should preserve that hierarchy.

Do not stop after editing Step 1.

Update the entire path from:
asset source → analysis → storyboard → QA → remake → video generation → final assembly.

---

# 89. CURRENT WORKFLOW DEFECT TO FIX DURING MIGRATION

The existing execution log shows a malformed Gemini JSON response around `fourAnswers`, after which all scene fields became N/A / 0 words, but the workflow still proceeded into storyboard generation.

This is a pipeline defect.

During migration, make validation mandatory so this state can never proceed.

Required invariant:

```text
NO VALID SCRIPT
=
NO STORYBOARD GENERATION
```

---

# 90. FINAL CHANNEL IDENTITY PRINCIPLE

The recurring visual story should always communicate:

```text
"This is the same mother and the same baby,
living their normal daily life,
trying and using different mother-and-baby products."
```

NOT:

```text
"This is a random product ad generated with a random woman and child."
```

That distinction is the core requirement of this migration.
