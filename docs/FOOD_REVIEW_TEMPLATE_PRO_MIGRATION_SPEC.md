# FOOD REVIEW CHANNEL --- 4×6s / 24s MIGRATION SPEC

## Implementation specification for AI Coding Agent

> **Goal:** Update the current short-form commerce/video pipeline into a
> dedicated Vietnamese food & beverage review channel inspired by the
> three supplied reference videos.
>
> **Target output:** 4 scenes × 6 seconds = **24 seconds total**.
>
> This document is the single implementation brief. The agent should
> update the complete pipeline: product analysis → script → storyboard →
> visual QA → 4×6s video generation → Gemini TTS → 24s assembly.
>
> **Important evidence boundary:** The supplied videos support the
> visual/rhythm analysis in this document. A reliable verbatim
> Vietnamese transcript was not available during analysis, so exact
> regional word frequencies and exact quoted wording from the references
> must **not** be invented. The "Miền Tây" language profile below is
> therefore an implementation target to be calibrated later against a
> verified transcript.

------------------------------------------------------------------------

# 1. CHANNEL GOAL

Build a recurring short-form channel reviewing:

-   snacks,
-   cakes and sweets,
-   dried foods,
-   regional specialties,
-   packaged foods,
-   ready-to-eat foods,
-   drinks,
-   sauces/dips,
-   convenience foods,
-   other visually reviewable food & beverage products.

The channel should feel like:

> A real Vietnamese woman has just found/bought a food item, holds it in
> front of the camera, opens it, breaks/pulls/dips/pours/tastes it, and
> casually tells viewers what she notices.

It must **not** feel like:

> A generic TikTok affiliate advertisement reading product features.

Core principle:

``` text
SEE IT
→ TOUCH IT
→ REVEAL IT
→ TASTE / EXPERIENCE IT
→ REACT TO IT
```

The reviewer's voice and the visible food action must feel synchronized.

------------------------------------------------------------------------

# 2. REFERENCE-VIDEO DNA

The three supplied reference videos share a strong visual system even
when the products change.

Observed recurring principles:

1.  Product fills a large part of the frame.
2.  Close and medium-close framing dominate.
3.  Hands perform meaningful actions rather than merely holding the
    product.
4.  Texture and interior structure are repeatedly revealed.
5.  Quantity/abundance shots make the food look plentiful.
6.  Product is moved from packaging → presentation → interaction →
    consumption context.
7.  Warm, believable lifestyle backgrounds support the product without
    overpowering it.
8.  Real-world/source/packaging shots increase authenticity.
9.  Shots generally have enough duration for the viewer to perceive
    texture.
10. Speech is dense and flowing with few long pauses.
11. The review should feel experiential rather than feature-list driven.

The implementation should copy these **mechanics**, not reproduce
specific copyrighted wording or exact creative expression.

------------------------------------------------------------------------

# 3. NEW VIDEO FORMAT --- HARD REQUIREMENT

Replace previous timing with:

``` text
4 scenes
× 6 seconds
= 24 seconds total
```

Canonical timeline:

``` text
00:00–00:06  Scene 1 — DISCOVERY / HOOK
00:06–00:12  Scene 2 — SHOW / FIRST OBSERVATION
00:12–00:18  Scene 3 — HERO INTERACTION / SENSORY PROOF
00:18–00:24  Scene 4 — TASTE / VERDICT / SOFT CTA
```

Every scene must be independently generatable as a 6-second Start Frame
video and later concatenated without visual or narrative discontinuity.

------------------------------------------------------------------------

# 4. DO NOT USE THE OLD GENERIC COMMERCE FRAMEWORK

Do not blindly reuse:

``` text
HOOK
SOLUTION
PROOF
CLOSING
```

That framework makes sense for household problem-solving products but is
too commercial for food review.

Replace it with:

``` text
DISCOVERY
SHOW
EXPERIENCE
VERDICT
```

Detailed interpretation:

``` text
SCENE 1 — DISCOVERY / HOOK
Why did this food catch the reviewer's attention?

SCENE 2 — SHOW / FIRST OBSERVATION
What does the package, quantity, size, surface or appearance actually look like?

SCENE 3 — HERO INTERACTION / SENSORY PROOF
What physical action best reveals the food?

SCENE 4 — TASTE / VERDICT / SOFT CTA
What is the eating experience, who may like it, and is it worth trying?
```

------------------------------------------------------------------------

# 5. SCENE 1 --- DISCOVERY / HOOK

Duration:

``` text
6 seconds
```

Purpose:

-   establish food/product immediately,
-   create curiosity,
-   feel like a real discovery rather than a scripted ad,
-   optionally show packaging/source/quantity.

Possible visual structures:

``` text
seller/store/source context
→ product bag toward camera

package close-up
→ open package

large tray/pile
→ hand selects one piece

interesting product appearance
→ reviewer immediately picks it up
```

Hook language should be contextual.

Preferred patterns:

``` text
"Lần đầu tui thấy loại này nên mua thử coi sao."

"Nhìn cái bịch này là tui tò mò liền nè."

"Món này nhìn đơn giản vậy chứ coi bên trong nè."

"Ai mê kiểu ... thì coi món này thử nè."

"Đi ngang thấy người ta bán món này nhiều quá nên tui mua thử."
```

These are **style examples**, not quotations from the supplied videos.

Avoid default hooks such as:

``` text
"Trời ơi mọi người ơi..."
"TikTok đang rần rần..."
"Siêu phẩm..."
"Chấn động..."
"Phải mua ngay..."
```

unless genuinely appropriate.

------------------------------------------------------------------------

# 6. SCENE 2 --- SHOW / FIRST OBSERVATION

Duration:

``` text
6 seconds
```

Purpose:

-   let viewer inspect the food,
-   establish size/quantity/shape/color/surface,
-   move from package to edible product,
-   provide visually verifiable observations.

Typical actions:

``` text
open bag
pour onto plate
pick up one piece
rotate food toward camera
show whole tray
show thickness
show portion size
show filling edge
show seasoning surface
```

Speech should describe what is actually visible.

Example logic:

``` text
VISUAL:
Reviewer lifts one piece.

VOICE:
"Miếng này cầm lên khá dày nha, bên ngoài nhìn ráo chứ không bị khô queo."
```

Do not use generic feature language if the camera can describe something
more concrete.

------------------------------------------------------------------------

# 7. SCENE 3 --- HERO INTERACTION

This is the most important scene.

Duration:

``` text
6 seconds
```

Every product analysis must identify one **Hero Interaction**.

Definition:

> The single physical action that most strongly reveals texture,
> filling, consistency, juiciness, crispness, softness, stretch, sauce
> behavior, or another desirable sensory property.

Examples:

``` text
break
tear
pull
stretch
cut
squeeze gently
dip
pour
stir
lift with chopsticks
bite
crack
peel
open
spread
shake
```

Examples by product:

``` text
soft dried sweet potato → pull / tear
filled cake → break open
crispy snack → snap / bite
dried fish → dip / tear
sauce → pour / coat
drink → pour over ice / swirl
mochi → stretch
cream-filled item → split to reveal filling
noodles → lift
cheese item → pull
```

Mandatory Step-1 field:

``` json
"heroInteraction": {
  "action": "break_open",
  "performedBy": "reviewer_hand",
  "visualTarget": "reveal dense filling and soft inner texture",
  "sensoryTarget": "softness + filling amount",
  "shotType": "close_up",
  "scene": 3
}
```

Hard rule:

``` text
NO HERO INTERACTION
=
ANALYSIS NOT COMPLETE
```

------------------------------------------------------------------------

# 8. SCENE 4 --- TASTE / VERDICT / SOFT CTA

Duration:

``` text
6 seconds
```

Purpose:

-   complete sensory experience,
-   give a balanced reaction,
-   optionally show eating/dipping/drinking,
-   tell viewer who may like it,
-   close softly.

Preferred verdict language:

``` text
"Ai thích kiểu dẻo mềm như vầy chắc sẽ mê."

"Vị khá vừa miệng, ăn chơi thì ổn á."

"Tui thích nhất là phần nhân, nhiều mà không bị ngấy."

"Mấy bạn thích đồ giòn giòn đậm vị thì món này đáng thử."

"Ăn vặt hoặc đem ra nhâm nhi thì hợp."
```

Avoid hard-selling endings by default:

``` text
"Mua ngay!"
"Chốt đơn liền!"
"Nhanh tay kẻo hết!"
"Bấm giỏ hàng ngay!"
```

Commerce CTA may still exist, but it should sound like a natural
continuation of the review.

Examples:

``` text
"Ai thích kiểu này thì coi thử nha."

"Tui để món này ở giỏ, ai mê thì tham khảo nghen."

"Thích đồ ăn vặt kiểu này thì thử cũng được á."
```

------------------------------------------------------------------------

# 9. CORE CONTENT PHILOSOPHY

The system must generate:

``` text
EXPERIENCE LANGUAGE
```

not:

``` text
PRODUCT DESCRIPTION LANGUAGE
```

Bad:

``` text
"Sản phẩm có kết cấu mềm dẻo và hương vị thơm ngon."
```

Better:

``` text
"Bẻ ra mới thấy bên trong nó mềm dẻo nè, nhìn cái ruột là muốn ăn liền."
```

Bad:

``` text
"Bánh có lượng nhân đầy đặn."
```

Better:

``` text
"Bẻ đôi ra coi nè, cái nhân bên trong khá đầy chứ không có lèo tèo."
```

Bad:

``` text
"Sản phẩm có vị béo thơm."
```

Better:

``` text
"Ăn vô có cái vị béo béo thơm thơm, mà không tới mức ngấy."
```

Core transformation:

``` text
DESCRIBE A FEATURE
        ↓
REACT TO AN EXPERIENCE
```

------------------------------------------------------------------------

# 10. SHOW → SAY SYNCHRONIZATION

Audio must describe or react to what is happening visually at
approximately the same time.

Examples:

``` text
VISUAL: cake is broken open
VOICE: "Bẻ ra coi cái nhân bên trong nè..."

VISUAL: dried food is pulled apart
VOICE: "Cái độ dẻo nè, kéo ra là thấy rõ luôn."

VISUAL: fish is dipped into sauce
VOICE: "Chấm thêm miếng này vô là nhìn bắt vị hẳn."

VISUAL: drink is poured over ice
VOICE: "Rót ra mới thấy màu nó đậm cỡ này nè."
```

Do not create:

``` text
voice discusses taste
while
video only shows unopened package
```

unless deliberately used as anticipation.

------------------------------------------------------------------------

# 11. SCRIPT MUST FOLLOW THE PHYSICAL ACTION

The script generator must receive the visual action plan before
finalizing voice-over.

Recommended order:

``` text
PRODUCT ANALYSIS
↓
VISUAL PROPERTY ANALYSIS
↓
HERO INTERACTION SELECTION
↓
4-SCENE ACTION PLAN
↓
VOICE-OVER WRITING
↓
TTS
```

Do not write a complete voice-over first and force visuals to fit
afterward.

------------------------------------------------------------------------

# 12. SENSORY VOCABULARY ENGINE

Create an internal vocabulary bank.

## Crisp / crunchy

``` text
giòn
giòn rụm
giòn tan
giòn nhẹ
cắn nghe rôm rốp
```

## Soft

``` text
mềm
mềm xốp
mềm ẩm
mềm bên trong
không bị khô
```

## Chewy / elastic

``` text
dẻo
dẻo mềm
dai nhẹ
nhai vui miệng
kéo ra thấy độ dẻo
không bị dai nhách
```

## Rich / fatty

``` text
béo
béo béo
béo thơm
béo vừa
không bị ngấy
```

## Sweet

``` text
ngọt vừa
ngọt nhẹ
ngọt thanh
không ngọt gắt
```

## Savory

``` text
đậm vị
đậm đà
mặn vừa
bắt vị
```

## Aroma

``` text
thơm
mùi khá rõ
mở ra nghe mùi liền
thơm kiểu...
```

## Filling

``` text
nhân nhiều
nhân khá đầy
nhân dày
bẻ ra thấy nhân rõ
```

## Sauce / liquid

``` text
sệt
bám
mịn
rót ra...
áo đều
```

## Quantity

``` text
đầy bịch
khá nhiều
nguyên khay
một bịch được khá nhiều miếng
```

## Size

``` text
miếng khá to
nhỏ nhỏ vừa ăn
cầm vừa tay
dày
mỏng
```

Rules:

-   Use sensory vocabulary only when supported.
-   Do not stack excessive adjectives.
-   One visual beat should normally emphasize one dominant sensory idea.

------------------------------------------------------------------------

# 13. EXPECTATION → CONTRAST → REWARD

Encourage natural contrast structures.

Examples:

``` text
"Nhìn ngoài tưởng khô nha, mà bẻ ra bên trong mềm dữ lắm."

"Tưởng ngọt lắm á, ăn vô thì vị vừa hơn tui nghĩ."

"Miếng nhìn nhỏ vậy chứ bẻ ra nhân khá nhiều."

"Nhìn dày vậy mà ăn không bị nặng miệng."
```

Pattern:

``` text
EXPECTATION
↓
CONTRAST
↓
POSITIVE OR BALANCED DISCOVERY
```

This creates a mini narrative inside a review sentence.

Do not manufacture contrast if unsupported.

------------------------------------------------------------------------

# 14. BALANCED REVIEW LANGUAGE

The reviewer should not praise every attribute at maximum intensity.

Use qualification:

``` text
khá...
vừa...
hơi...
không tới mức...
chứ không...
theo tui...
tui thấy...
```

Examples:

``` text
"Ngọt vừa thôi chứ không bị gắt."

"Béo nhưng không tới mức ngấy."

"Miếng hơi nhỏ nhưng phần nhân khá ổn."

"Mùi khá rõ, ai thích vị này chắc sẽ hợp."

"Tui thấy ăn chơi thì ổn."
```

This lowers perceived sales pressure and increases reviewer credibility.

------------------------------------------------------------------------

# 15. REVIEWER PERSONA

Internal persona:

``` text
FOOD_REVIEWER_PERSONA_V1
```

Profile:

``` text
Vietnamese female
young adult
Southern / Mekong Delta conversational flavor
food-curious
friendly
observational
casually enthusiastic
slightly playful
not a professional critic
not a TV presenter
not an aggressive affiliate seller
```

Emotional loop:

``` text
curiosity
→ discovery
→ sensory reaction
→ satisfaction / balanced verdict
```

The reviewer sounds as if the food is physically in front of her.

------------------------------------------------------------------------

# 16. MIỀN TÂY LANGUAGE PROFILE --- IMPLEMENTATION TARGET

The user specifically wants a **Miền Tây** review flavor.

Important:

> Do not reduce "Miền Tây" to randomly inserting `nè`, `nghen`, or
> `tui`.

The naturalness must come from the whole speech system:

-   self-reference,
-   audience address,
-   sentence construction,
-   particles,
-   rhythm,
-   vocabulary,
-   contractions/omissions,
-   emotional phrasing.

A verified transcript of the reference videos is still required before
claiming an exact match to their dialect usage.

------------------------------------------------------------------------

# 17. SELF-REFERENCE / XƯNG HÔ

Preferred default self-reference:

``` text
tui
```

Also allow subject omission when natural.

Examples:

``` text
"Tui mua thử một bịch coi sao."

"Bẻ ra mới thấy bên trong nè."

"Ăn thử thì tui thấy vị vừa á."

"Nhìn vậy chứ cầm lên khá chắc tay."
```

Do not mechanically start every sentence with `tui`.

Avoid mixing personas randomly:

``` text
tui
→ mình
→ em
→ chị
```

within the same video unless there is a clear conversational reason.

Channel persona should have stable pronoun behavior.

------------------------------------------------------------------------

# 18. AUDIENCE ADDRESS / GỌI NGƯỜI XEM

Candidate address terms for the channel:

``` text
cả nhà
mọi người
mấy bạn
ai mà...
ai thích...
```

Potentially more regional forms can be added only after transcript
calibration.

Do not over-address viewers.

Bad:

``` text
"Cả nhà ơi... cả nhà coi nè... cả nhà thấy không... cả nhà mua thử..."
```

Natural:

``` text
"Cả nhà coi cái phần nhân nè."

then continue without another address for several clauses.
```

Address frequency should be intentionally limited.

Recommended initial rule:

``` text
0–2 direct audience addresses per 24s video.
```

------------------------------------------------------------------------

# 19. DISCOURSE PARTICLES

Candidate Southern/Mekong conversational particles:

``` text
nè
nha
nghen
á
ha
hen
đó
luôn
chứ
vậy
```

Do not use all of them in one script.

Do not turn them into a dialect costume.

They must perform conversational functions.

Examples:

### `nè`

Direct attention:

``` text
"Bẻ ra coi cái nhân nè."
```

### `nha`

Soft assertion/recommendation:

``` text
"Miếng này khá dày nha."
```

### `nghen`

Warm/soft closing or invitation:

``` text
"Ai thích kiểu này thì tham khảo nghen."
```

### `á`

Casual emphasis/context:

``` text
"Ăn vô á, cái vị béo lên khá rõ."
```

### `chứ`

Contrast:

``` text
"Dẻo chứ không bị dai nhách."
```

------------------------------------------------------------------------

# 20. REGIONAL NATURALNESS RULE

Do not instruct the LLM:

``` text
"Use as many Mekong Delta words as possible."
```

Use:

``` text
"Write natural Southern Vietnamese with a subtle Mekong Delta conversational flavor. Regional particles should emerge naturally and sparingly. Never force dialect words into every sentence."
```

The goal is:

``` text
natural speaker
```

not:

``` text
dialect impersonation
```

------------------------------------------------------------------------

# 21. SENTENCE STRUCTURE

Avoid polished written Vietnamese.

Prefer short speech chunks.

Example:

``` text
"Cái này nhìn ngoài tưởng khô nha,
mà bẻ ra coi nè,
bên trong mềm dữ lắm."
```

Conceptually:

``` text
observation /
action /
reaction
```

Other patterns:

``` text
"Cầm lên là thấy..."
"Bẻ ra mới thấy..."
"Ăn vô thì..."
"Chấm vô cái là..."
"Ở trong có..."
"Nhìn cái phần này nè..."
"Tui thích nhất cái..."
"Ai thích kiểu... thì..."
```

These should be patterns, not mandatory phrases.

------------------------------------------------------------------------

# 22. CLAUSE LENGTH

Target:

``` text
5–10 Vietnamese words per thought group
```

Multiple thought groups can flow within one sentence.

Avoid long formal clauses.

Bad:

``` text
"Sản phẩm này được thiết kế với phần nhân tương đối dày và có hương vị rất phù hợp với những người yêu thích..."
```

Better:

``` text
"Nhân bên trong khá dày nha, ăn vô béo nhẹ, ai mê kiểu này chắc hợp."
```

------------------------------------------------------------------------

# 23. SPEECH DENSITY

Observed reference audio is highly continuous.

Measured mixed-track active-audio ratios were approximately:

``` text
Video 1: ~96%
Video 2: ~95%
Video 3: ~91%
```

Interpretation:

-   few long silent gaps,
-   continuous review flow,
-   micro-pauses instead of dramatic pauses.

This does **not** mean shouting or rushing.

Target delivery:

``` text
FAST CONVERSATIONAL
```

not:

``` text
EXTREMELY FAST AD READ
```

------------------------------------------------------------------------

# 24. TARGET SPEAKING RATE

Initial creative target:

``` text
3.8–4.3 Vietnamese words / second
≈ 228–258 words / minute
```

For 24 seconds, do **not** blindly multiply this into a maximum script
count because natural pauses, punctuation and word tokenization vary.

Recommended practical initial script target:

``` text
~85–100 spoken Vietnamese words total
```

Then measure generated audio duration.

Preferred production loop:

``` text
generate script
↓
TTS
↓
measure duration
↓
if >24.0s → concise rewrite
if <22.5s → add useful sensory content or slightly relax pace
↓
regenerate TTS
```

Do not time-stretch audio aggressively unless necessary.

------------------------------------------------------------------------

# 25. SCENE VOICE BUDGET

Initial target:

``` text
Scene 1: ~20–24 words
Scene 2: ~21–25 words
Scene 3: ~22–26 words
Scene 4: ~20–25 words
```

Total target:

``` text
~85–100 words
```

Scene 3 can be slightly denser because it contains the strongest visual
proof.

Programmatically validate, but prioritize final TTS duration over raw
word count.

------------------------------------------------------------------------

# 26. PROSODY TARGET

Desired voice:

``` text
female
young adult
bright upper-mid register
friendly
warm
lively
natural vocal smile
moderately excited
low sales pressure
```

Creative scales:

``` text
Energy:          7/10
Excitement:      6.5/10
Warmth:          8/10
Friendliness:    9/10
Sales pressure:  3/10
Vocal smile:     7.5/10
Formality:       1–2/10
```

Do not interpret these as Gemini API numeric parameters; they are
prompt-design targets.

------------------------------------------------------------------------

# 27. PITCH / VOCAL REGISTER

Mixed-track pitch analysis suggested median regions around:

``` text
~250–280 Hz
```

This is not a clean isolated-voice measurement and must not be treated
as an exact target frequency.

Use it only to inform the qualitative direction:

``` text
bright young female voice
not deep narrator
not childish
not squeaky
```

------------------------------------------------------------------------

# 28. GEMINI TTS BASELINE

Recommended starting setup:

``` text
Model:
gemini-3.1-flash-tts-preview

Primary voice candidate:
Zephyr

A/B candidate:
Leda

Language:
Vietnamese
```

The implementation should keep model and voice configurable rather than
hard-coded.

Example:

``` json
{
  "tts": {
    "provider": "gemini",
    "model": "gemini-3.1-flash-tts-preview",
    "voice": "Zephyr",
    "language": "vi",
    "targetDurationSeconds": 24
  }
}
```

------------------------------------------------------------------------

# 29. GEMINI TTS DIRECTOR PROMPT

Use a structured prompt similar to:

``` text
### AUDIO PROFILE

You are a young Vietnamese female food reviewer.

Your voice is bright, warm, friendly and naturally expressive.

Your conversational style is Southern Vietnamese with a subtle Mekong Delta flavor.

You sound like a real person showing a snack, local specialty, dessert, food or drink she has just bought and is genuinely trying.

You are NOT a commercial announcer.
You are NOT a professional food critic.
You are NOT an aggressive affiliate salesperson.

Use a natural vocal smile.

### SCENE

You are filming a short vertical food-review video on your phone.

The food is physically in front of you.

While speaking, you may be:
opening it,
holding it toward the camera,
breaking it,
pulling it,
showing the filling,
dipping it,
pouring it,
or tasting it.

Your reaction should sound synchronized with the physical action.

### LANGUAGE CHARACTER

Speak natural Vietnamese.

Use casual Southern Vietnamese sentence construction with a subtle Mekong Delta conversational flavor.

Keep the pronoun system stable.

Default self-reference is "tui" when self-reference is needed.

Use audience addresses such as "cả nhà", "mọi người", "mấy bạn", or "ai..." sparingly and naturally.

Conversational particles such as "nè", "nha", "nghen", "á", "chứ", "ha/hen" may appear naturally when appropriate.

Never stuff regional particles into every sentence.

Never exaggerate the dialect.

### DIRECTOR'S NOTES

Energy: 7/10.
Excitement: 6.5/10.
Warmth: 8/10.
Friendliness: 9/10.
Sales pressure: 3/10.
Vocal smile: noticeable but natural.

Pacing:
Fast conversational.
Target approximately 3.8–4.3 Vietnamese words per second.

Keep the delivery flowing.
Use short thought groups.
Use very short micro-pauses.
Avoid long pauses.

Prosody:
Frequent small pitch changes.
Emphasize sensory words naturally.
React slightly more when the visual reveals texture, filling or an unexpected detail.

Articulation:
Clear but conversational.
Never over-enunciate like a presenter.

Do NOT:
shout,
sound like a TV commercial,
sound like a newsreader,
sound like an audiobook,
sound excessively cute,
use fake laughter,
overstretch vowels,
insert theatrical pauses,
sound desperate to sell.

Most importantly:
sound like you are genuinely looking at, touching and tasting the food while talking to viewers.

### TRANSCRIPT

{{VOICE_OVER}}
```

------------------------------------------------------------------------

# 30. TTS MUST NOT FIX BAD WRITING

TTS quality cannot rescue an advertisement-style script.

Before TTS, validate that script language contains enough of:

``` text
observation
physical action
sensory description
reaction
qualification
verdict
```

and not too much:

``` text
feature listing
generic praise
sales claims
CTA
```

------------------------------------------------------------------------

# 31. SCRIPT FUNCTION TAGS

Internally classify every speech chunk as:

``` text
HOOK
OBSERVE
POINT_OUT
ACTION
REVEAL
COMPARE
SENSORY
REACTION
QUALIFY
VERDICT
CTA
```

Example:

``` json
[
  {
    "text": "Cái này nhìn ngoài tưởng khô nha",
    "function": "COMPARE"
  },
  {
    "text": "bẻ ra coi nè",
    "function": "ACTION"
  },
  {
    "text": "bên trong mềm dữ lắm",
    "function": "SENSORY"
  }
]
```

This helps prevent feature-list scripts.

------------------------------------------------------------------------

# 32. SCRIPT BALANCE

A 24-second script should normally contain:

``` text
1 hook/context
2–4 observations
2–4 physical-action references
2–4 sensory statements
1–2 qualifications
1 verdict
0–1 CTA
```

Do not require exact counts if the product demands another structure.

------------------------------------------------------------------------

# 33. CLAIM SAFETY / GROUNDING

Never invent sensory or factual claims.

Separate data into:

``` text
VISUALLY VERIFIED
PRODUCT METADATA
SUBJECTIVE REVIEW CLAIM
UNVERIFIED
```

Example:

``` json
{
  "evidence": {
    "visuallyVerified": [
      "product is thick",
      "visible filling",
      "large quantity in package"
    ],
    "metadataClaims": [
      "durian flavor"
    ],
    "unverified": [
      "very fragrant",
      "not too sweet"
    ]
  }
}
```

Do not script `unverified` as fact.

For generated tasting reactions, only use sensory descriptions supported
by product information or explicitly approved assumptions.

------------------------------------------------------------------------

# 34. PRODUCT ANALYSIS OUTPUT

Recommended Step-1 schema:

``` json
{
  "analysis": {
    "productName": "...",
    "foodCategory": "snack|cake|dried_food|specialty|drink|sauce|dessert|ready_to_eat|other",
    "variant": "...",
    "packageType": "...",
    "visibleProperties": [
      "..."
    ],
    "metadataClaims": [
      "..."
    ],
    "unverifiedClaims": [
      "..."
    ],
    "primarySensoryAngle": "...",
    "secondarySensoryAngle": "...",
    "reviewAngle": "...",
    "targetViewer": "...",
    "heroInteraction": {
      "action": "...",
      "performedBy": "reviewer_hand",
      "visualTarget": "...",
      "sensoryTarget": "...",
      "shotType": "close_up|macro|medium_close",
      "scene": 3
    }
  },
  "voicePersona": {
    "personaId": "FOOD_REVIEWER_PERSONA_V1",
    "dialectDirection": "southern_vietnamese_subtle_mekong",
    "selfReference": "tui",
    "audienceAddress": ["cả nhà", "mọi người", "mấy bạn", "ai..."],
    "energy": 7,
    "excitement": 6.5,
    "salesPressure": 3,
    "vocalSmile": 7.5
  },
  "script": [
    {
      "id": 1,
      "phase": "Discovery",
      "durationSeconds": 6,
      "visualGoal": "...",
      "voiceOver": "...",
      "speechFunctions": ["HOOK", "OBSERVE"],
      "foodAction": "...",
      "cameraAction": "..."
    },
    {
      "id": 2,
      "phase": "Show",
      "durationSeconds": 6,
      "visualGoal": "...",
      "voiceOver": "...",
      "speechFunctions": ["POINT_OUT", "OBSERVE"],
      "foodAction": "...",
      "cameraAction": "..."
    },
    {
      "id": 3,
      "phase": "Experience",
      "durationSeconds": 6,
      "visualGoal": "...",
      "voiceOver": "...",
      "speechFunctions": ["ACTION", "REVEAL", "SENSORY"],
      "foodAction": "...",
      "cameraAction": "..."
    },
    {
      "id": 4,
      "phase": "Verdict",
      "durationSeconds": 6,
      "visualGoal": "...",
      "voiceOver": "...",
      "speechFunctions": ["REACTION", "QUALIFY", "VERDICT", "CTA"],
      "foodAction": "...",
      "cameraAction": "..."
    }
  ]
}
```

------------------------------------------------------------------------

# 35. VISUAL WORLD

The references favor believable, warm food presentation rather than
sterile e-commerce studio visuals.

Recommended channel world:

``` text
warm Vietnamese food-review lifestyle
natural table surfaces
wood tones
subtle plants / flowers / tea ware when relevant
warm-neutral daylight
realistic phone-camera appearance
background visually pleasant but secondary
food remains dominant
```

Do not force one identical set for every product.

Allow:

``` text
home table
food stall
shop/source
kitchen
cafe-like table
outdoor purchase context
```

while maintaining consistent shooting language.

------------------------------------------------------------------------

# 36. PRODUCT FRAME OCCUPANCY

Food should normally occupy a large share of the useful frame.

Recommended by scene:

``` text
Scene 1:
product/context ~40–70%

Scene 2:
product ~60–80%

Scene 3:
product/detail ~70–90%

Scene 4:
food/action ~50–80%
```

These are composition targets, not strict pixel validation.

------------------------------------------------------------------------

# 37. HAND INTERACTION RULE

Every visible hand should have a reason.

Good:

``` text
hold
open
tear
break
pull
dip
pour
lift
rotate
squeeze
cut
taste
```

Weak:

``` text
static hand holding product for 6 seconds
```

Principle:

> Every hand needs an action.

------------------------------------------------------------------------

# 38. ABUNDANCE SHOTS

When appropriate, show quantity:

``` text
full bag
full tray
pile
plate with multiple pieces
multiple packages
```

Purpose:

-   visual richness,
-   perceived value,
-   appetite appeal,
-   stronger food presence.

Do not fabricate quantity that contradicts the actual package/product.

------------------------------------------------------------------------

# 39. TEXT OVERLAY

Reference style favors minimal product-identification text.

Recommended:

``` text
PRODUCT NAME
```

Optional:

``` text
short variant/flavor
```

Avoid clutter:

``` text
5 benefits
discount percentages
large price badges
multiple arrows
fake UI
excessive emoji
```

Storyboard generation itself should preferably remain text-free if text
rendering is unreliable; overlay can be applied in post.

------------------------------------------------------------------------

# 40. CAMERA LANGUAGE

Preferred:

``` text
smartphone realism
close-up
medium close-up
macro-like detail where appropriate
natural handheld micro-movement
stable enough to inspect food
realistic perspective
```

Avoid:

``` text
cinematic crane shots
extreme orbiting
overly glossy CGI
impossible macro transitions
excessive depth-of-field blur
```

Food texture must remain readable.

------------------------------------------------------------------------

# 41. STORYBOARD STRUCTURE

Generate exactly 4 panels corresponding to:

``` text
Panel 1 — Discovery
Panel 2 — Show
Panel 3 — Experience
Panel 4 — Verdict
```

Each panel is the Start Frame for one 6-second clip.

Storyboard should already imply the action that follows.

Example:

``` text
Panel 3 Start Frame:
two hands positioned to break cake
```

rather than:

``` text
cake already completely broken with no motion opportunity
```

The Start Frame must leave **action runway** for the 6-second video.

------------------------------------------------------------------------

# 42. ACTION RUNWAY

This is mandatory.

Each Start Frame should represent:

``` text
the beginning or early stage of the intended action
```

not the final state.

Examples:

``` text
tear scene:
hands grip both sides before tearing

dip scene:
food held just above sauce

pour scene:
container tilted slightly before liquid flows

bite scene:
food approaching mouth, not already consumed

break scene:
fingers positioned at break point
```

This improves 6-second motion generation.

------------------------------------------------------------------------

# 43. 6-SECOND VIDEO PROMPT STRUCTURE

Every scene prompt should contain:

``` text
START FRAME LOCK
PRODUCT LOCK
ACTION
CAMERA
PHYSICS
ENDING STATE
NO-TEXT / NO-MORPH RULES
```

Example:

``` text
Create a realistic 6-second vertical smartphone food-review video from the approved Start Frame.

START FRAME:
Begin exactly from the provided frame.

PRODUCT LOCK:
Preserve the exact food shape, color, quantity, packaging and visible texture.
Do not transform the food into another item.

ACTION:
The reviewer slowly pulls the food apart with both hands.
The inner texture becomes visible progressively.
The action should complete around second 4–5, leaving the final second to clearly show the revealed texture.

CAMERA:
Very subtle handheld smartphone movement.
Keep focus on the food.
No sudden zoom.

PHYSICS:
Natural hand motion.
Correct fingers.
Realistic food deformation.
No floating pieces.
No duplicated food.

ENDING:
Finish on a clear close-up of the revealed interior.

NO TEXT.
NO UI.
NO CGI.
NO PRODUCT MORPHING.
SILENT VIDEO.
```

------------------------------------------------------------------------

# 44. SCENE MOTION ARC

For each 6-second clip:

``` text
0.0–1.0s  establish Start Frame
1.0–4.5s  primary action
4.5–6.0s  reveal/result/hold
```

Do not fill all six seconds with random motion.

Each scene should have:

``` text
ONE PRIMARY ACTION
```

plus subtle secondary motion.

------------------------------------------------------------------------

# 45. VISUAL QA SCORE

Recommended:

``` text
Product/Food Fidelity           25
Hero Interaction Accuracy       20
Texture/Sensory Readability     15
Hand Anatomy                    10
Scene Accuracy                  10
Appetite Appeal                 10
Camera/Composition               5
Cross-Scene Continuity           5
-----------------------------------
TOTAL                           100
```

------------------------------------------------------------------------

# 46. HARD REJECT CONDITIONS

Reject if:

``` text
wrong product
wrong food color/shape
package mutation
food transforms during interaction
filling invented incorrectly
extra fingers
merged hands
floating food
impossible tearing
impossible liquid physics
unappetizing severe deformation
scene does not match script
Hero Interaction is missing
text/UI hallucination when forbidden
```

------------------------------------------------------------------------

# 47. AUDIO ↔ VIDEO ALIGNMENT DATA

Store timing intent per scene.

Example:

``` json
{
  "sceneId": 3,
  "duration": 6,
  "syncPoints": [
    {
      "timeRange": "1.0-2.5",
      "visual": "hands begin pulling cake apart",
      "voiceIntent": "ACTION"
    },
    {
      "timeRange": "2.5-4.5",
      "visual": "filling becomes visible",
      "voiceIntent": "REVEAL"
    },
    {
      "timeRange": "4.5-6.0",
      "visual": "hold revealed filling near camera",
      "voiceIntent": "SENSORY"
    }
  ]
}
```

Exact word-level lip sync is unnecessary because this channel is
product/hand-centric.

Semantic synchronization is essential.

------------------------------------------------------------------------

# 48. TTS DURATION VALIDATION

Mandatory:

``` text
target final audio ≈ 24 seconds
```

Recommended acceptable range before mux:

``` text
23.2–24.0 seconds
```

or whatever tolerance current assembly requires.

Do not cut off final words.

If audio is too long:

1.  rewrite concisely,
2.  remove redundant address/particles,
3.  remove duplicated adjective,
4.  regenerate.

Do not first solve it by forcing an unnaturally fast voice.

If audio is too short:

1.  add useful observation/sensory detail,
2.  add natural micro-reaction,
3.  regenerate.

------------------------------------------------------------------------

# 49. SCRIPT VALIDATION

Before storyboard:

``` text
JSON parse
↓
schema validation
↓
4 scenes exactly
↓
each scene duration = 6
↓
Hero Interaction exists
↓
claim grounding
↓
speech style validation
↓
estimated word budget
↓
PASS
```

Before final assembly:

``` text
TTS generated
↓
audio duration measured
↓
24s target validation
↓
PASS
```

No valid script = no storyboard.

No valid TTS duration = no final mux.

------------------------------------------------------------------------

# 50. LANGUAGE LINTING

Add a script linter.

Flag:

``` text
too many direct audience addresses
too many "nè"
too many "nha"
too many "nghen"
too many superlatives
too many sales words
formal written-language phrases
repeated sentence openings
repeated adjective pairs
unsupported taste claims
```

Suggested warnings:

``` text
WARN_PARTICLE_OVERUSE
WARN_AUDIENCE_ADDRESS_OVERUSE
WARN_SALESY_LANGUAGE
WARN_FORMAL_COPY
WARN_REPETITIVE_OPENING
WARN_UNSUPPORTED_SENSORY_CLAIM
```

------------------------------------------------------------------------

# 51. WORDS / PHRASES TO DE-PRIORITIZE

Unless context genuinely supports them:

``` text
siêu phẩm
xịn xò
đỉnh của chóp
cực phẩm
hết nước chấm
chấn động
hot trend
TikTok rần rần
must-have
chốt đơn
hốt liền
mua ngay
không mua là tiếc
```

Occasional use is possible, but they must not define the persona.

------------------------------------------------------------------------

# 52. LANGUAGE THAT SHOULD DOMINATE

Prefer:

``` text
observation:
"nhìn..."
"cầm lên..."
"ở ngoài..."
"bên trong..."

action:
"bẻ ra..."
"kéo ra..."
"chấm vô..."
"rót ra..."
"cắn thử..."
"mở ra..."

reaction:
"tui thấy..."
"khá..."
"cũng..."
"đúng kiểu..."
"ăn vô..."
"nhai vô..."

qualification:
"vừa thôi"
"không tới mức..."
"chứ không..."
"hơi..."
"khá..."

attention:
"coi nè"
"cái này nè"
"nhìn phần này..."
```

Again: use naturally, not mechanically.

------------------------------------------------------------------------

# 53. REVIEW CREDIBILITY

The script should occasionally contain mild constraints.

Good:

``` text
"Tui thấy ngọt vừa thôi."

"Phần này hơi dày nhưng ăn vẫn ổn."

"Ai không thích mùi này chắc sẽ thấy hơi rõ."

"Không tới mức giòn rụm, mà nó giòn nhẹ."
```

This is more believable than:

``` text
"Hoàn hảo 10/10."
```

for every product.

------------------------------------------------------------------------

# 54. DO NOT FAKE PERSONAL HISTORY

The LLM must not invent:

``` text
"tui ăn món này từ nhỏ"
"quê tui ai cũng ăn"
"tui mua chỗ này nhiều lần"
"mẹ tui hay làm"
```

unless such context is actually supplied.

A regional speaking style does not authorize fabricated personal
history.

------------------------------------------------------------------------

# 55. PRODUCT-SPECIFIC REVIEW ANGLE

Step 1 must identify:

``` json
"reviewAngle": {
  "primary": "texture",
  "secondary": "filling",
  "avoid": ["health_claim", "unverified_origin"]
}
```

Possible primary angles:

``` text
texture
filling
crispness
chewiness
portion
quantity
aroma
sauce
visual novelty
preparation
convenience
refreshment
richness
sweetness balance
savory intensity
```

------------------------------------------------------------------------

# 56. 4-SCENE EXAMPLE --- FILLED CAKE

``` text
Scene 1 — Discovery
Show package + tray.
Voice introduces why it caught attention.

Scene 2 — Show
Pick one up, rotate it, show size and exterior.

Scene 3 — Experience
Break cake open slowly.
Reveal filling.
This is Hero Interaction.

Scene 4 — Verdict
Taste a bite / hold broken cake near camera.
Give texture/flavor verdict and soft recommendation.
```

------------------------------------------------------------------------

# 57. 4-SCENE EXAMPLE --- DRIED FISH

``` text
Scene 1
Package/source + quantity.

Scene 2
Plate/pile + lift one piece.

Scene 3
Tear or dip into sauce.
Close-up texture.

Scene 4
Taste + balanced savory verdict + who may like it.
```

------------------------------------------------------------------------

# 58. 4-SCENE EXAMPLE --- DRINK

``` text
Scene 1
Bottle/cup/package reveal.

Scene 2
Open and show color/consistency.

Scene 3
Pour over ice / stir / foam or texture reveal.

Scene 4
Taste + sweetness/aroma/refreshment verdict.
```

------------------------------------------------------------------------

# 59. 4-SCENE EXAMPLE --- SOFT DRIED FRUIT

``` text
Scene 1
Full package / abundance.

Scene 2
Pick up one piece and show thickness/surface.

Scene 3
Pull/tear to reveal chewiness and fibers.

Scene 4
Taste + sweetness/texture verdict.
```

------------------------------------------------------------------------

# 60. CHANNEL CONSISTENCY

The channel identity should come from three layers.

## Layer 1 --- Voice

Same reviewer persona:

``` text
FOOD_REVIEWER_PERSONA_V1
```

## Layer 2 --- Visual language

Recurring:

``` text
close product
hands
real action
warm lifestyle
texture proof
smartphone realism
```

## Layer 3 --- Review grammar

Recurring:

``` text
DISCOVERY
→ SHOW
→ EXPERIENCE
→ VERDICT
```

Products can change radically while the channel still feels consistent.

------------------------------------------------------------------------

# 61. WHAT NOT TO MAKE CONSISTENT

Do not make every video identical.

Vary:

``` text
hook structure
background
plate
food action
camera distance
sensory focus
audience address
particle use
CTA
```

Consistency should come from the **system**, not copied sentences.

------------------------------------------------------------------------

# 62. STEP-1 AI ROLE

Recommended system/task prompt:

``` text
You are a Vietnamese short-form food-review strategist, sensory copywriter, visual director and AI-video prompt planner.

Your job is to analyze the supplied food/product references and metadata and create a 24-second review consisting of exactly four 6-second scenes.

The channel is experiential, not advertisement-first.

The reviewer should sound like a young Vietnamese woman speaking naturally in Southern Vietnamese with a subtle Mekong Delta conversational flavor.

Do not write formal product descriptions.

Plan what the camera and hands physically do before writing the voice-over.

Every product must have one Hero Interaction that visually proves or reveals its strongest sensory property.

The final four-scene structure is:

1. Discovery
2. Show
3. Experience
4. Verdict

Return valid JSON only.
```

------------------------------------------------------------------------

# 63. SCRIPT-WRITER HARD RULES

``` text
1. Write for speech, not reading.
2. Stable self-reference.
3. Do not force audience address.
4. Do not overuse regional particles.
5. Describe visible actions at the moment they happen.
6. Prefer sensory language over feature language.
7. Use balanced qualification.
8. No unsupported taste/health/origin claims.
9. No generic hype opening by default.
10. Soft CTA only.
11. Total audio must fit 24 seconds.
12. Scene 3 must reference the Hero Interaction.
```

------------------------------------------------------------------------

# 64. TRANSCRIPT CALIBRATION TASK --- REQUIRED FUTURE IMPROVEMENT

To reproduce the supplied reference channel's **exact** Miền Tây
language behavior, add a calibration phase once reliable transcripts are
available.

For each reference video, extract:

``` text
timestamp
verbatim sentence
self-reference
audience address
discourse particles
regional vocabulary
sentence pattern
speech function
sensory word
CTA form
```

Then calculate:

``` text
frequency of "tui"
frequency of subject omission
frequency of "cả nhà"
frequency of "mọi người"
frequency of "nè"
frequency of "nha"
frequency of "nghen"
frequency of "á"
frequency of "ha/hen"
average thought-group length
average direct-address count/video
opening patterns
closing patterns
```

Only after this calibration should the system claim:

``` text
REFERENCE_MATCHED_MEKONG_LANGUAGE_PROFILE
```

Until then use:

``` text
SOUTHERN_VIETNAMESE_SUBTLE_MEKONG_V1
```

This distinction prevents invented dialect analysis.

------------------------------------------------------------------------

# 65. LOGGING

Add to each run:

``` text
Product
Food Category
Variant
Primary Sensory Angle
Secondary Sensory Angle
Hero Interaction
Scene 1 action
Scene 2 action
Scene 3 action
Scene 4 action
Script total words
TTS model
TTS voice
TTS duration
Audience address count
Regional particle counts
Unsupported-claim warnings
Storyboard QA
Video QA
Final duration
```

------------------------------------------------------------------------

# 66. RECOMMENDED INTERNAL CONFIG

``` json
{
  "channelType": "food_review",
  "video": {
    "sceneCount": 4,
    "sceneDurationSeconds": 6,
    "totalDurationSeconds": 24
  },
  "storyFramework": [
    "discovery",
    "show",
    "experience",
    "verdict"
  ],
  "reviewer": {
    "personaId": "FOOD_REVIEWER_PERSONA_V1",
    "language": "vi",
    "dialect": "southern_vietnamese_subtle_mekong",
    "selfReference": "tui",
    "salesPressure": 3,
    "energy": 7,
    "vocalSmile": 7.5
  },
  "tts": {
    "provider": "gemini",
    "model": "gemini-3.1-flash-tts-preview",
    "voice": "Zephyr",
    "targetDurationSeconds": 24
  }
}
```

------------------------------------------------------------------------

# 67. MIGRATION CHECKLIST

The AI coding agent must update at minimum:

-   [ ] Channel type/config.
-   [ ] Video timing from previous format to 4×6s.
-   [ ] Total assembly duration to 24s.
-   [ ] Step-1 product analysis prompt.
-   [ ] New Discovery/Show/Experience/Verdict framework.
-   [ ] Hero Interaction field.
-   [ ] Food evidence/claim classification.
-   [ ] Sensory vocabulary logic.
-   [ ] Southern/Mekong reviewer persona.
-   [ ] Pronoun/xưng-hô rules.
-   [ ] Regional particle rules.
-   [ ] Script language linter.
-   [ ] Scene voice budgets.
-   [ ] TTS director prompt.
-   [ ] Gemini TTS config.
-   [ ] TTS duration measurement/retry.
-   [ ] Storyboard 4-panel semantics.
-   [ ] Action-runway rule.
-   [ ] 6-second video prompts.
-   [ ] Hero Interaction QA.
-   [ ] Food/product fidelity QA.
-   [ ] 4×6s concatenation.
-   [ ] 24s audio mux.
-   [ ] Logging.
-   [ ] Regression/acceptance tests.

------------------------------------------------------------------------

# 68. ACCEPTANCE TEST --- FILLED CAKE

Input:

``` text
mini filled cake
```

Expected:

``` text
Scene 1 = package/discovery
Scene 2 = whole cake inspection
Scene 3 = break open filling
Scene 4 = taste/verdict
```

Must contain a Hero Interaction.

Must not read like a generic ad.

------------------------------------------------------------------------

# 69. ACCEPTANCE TEST --- DRIED FOOD

Input:

``` text
soft dried sweet potato
```

Expected Hero Interaction:

``` text
pull / tear
```

The visual should reveal chewiness/fibers.

Do not invent sweetness level if unsupported.

------------------------------------------------------------------------

# 70. ACCEPTANCE TEST --- SAUCE

Input:

``` text
dipping sauce
```

Expected Hero Interaction:

``` text
pour / dip / coat
```

Scene 3 must visually show viscosity/coating if product references
support it.

------------------------------------------------------------------------

# 71. ACCEPTANCE TEST --- AUDIO

Generated TTS must:

``` text
fit approximately 24s
sound conversational
avoid long silence
avoid announcer delivery
avoid shouting
use stable pronoun behavior
not overuse "nè/nha/nghen"
```

If it sounds like a TVC, fail the run.

------------------------------------------------------------------------

# 72. ACCEPTANCE TEST --- LANGUAGE

Reject or regenerate scripts like:

``` text
"Sản phẩm này sở hữu hương vị thơm ngon tuyệt hảo cùng chất lượng cao cấp..."
```

Accept patterns like:

``` text
"Bẻ ra coi nè, phần bên trong khá dày nha, nhìn mềm hơn tui tưởng."
```

provided the claims are supported.

------------------------------------------------------------------------

# 73. ACCEPTANCE TEST --- SALES PRESSURE

A video should remain valid with zero hard CTA.

Default CTA should be soft.

Fail if the generator repeatedly outputs:

``` text
mua ngay
chốt đơn
hốt liền
nhanh tay
```

across normal review videos.

------------------------------------------------------------------------

# 74. ACCEPTANCE TEST --- DIALECT OVERUSE

Fail or warn if a 24-second script contains unnatural particle stuffing
such as:

``` text
nè nha nghen á ha
```

repeated across every clause.

Regional flavor must remain conversational.

------------------------------------------------------------------------

# 75. ACCEPTANCE TEST --- SHOW/SAY ALIGNMENT

If Scene 3 voice says:

``` text
"Bẻ ra..."
```

but Scene 3 visual has no breaking action:

``` text
FAIL
```

If voice describes filling but camera never reveals filling:

``` text
FAIL
```

Semantic audio/video synchronization is mandatory.

------------------------------------------------------------------------

# 76. FINAL PIPELINE

``` text
PRODUCT REFERENCES + METADATA
              ↓
      FOOD ANALYSIS
              ↓
    EVIDENCE CLASSIFICATION
              ↓
    PRIMARY SENSORY ANGLE
              ↓
      HERO INTERACTION
              ↓
       4-SCENE ACTION PLAN
              ↓
       VOICE-OVER WRITING
              ↓
       LANGUAGE VALIDATION
              ↓
         CLAIM VALIDATION
              ↓
       STORYBOARD GENERATION
              ↓
       4 PARALLEL CANDIDATES
              ↓
            QA
              ↓
        USER APPROVAL
              ↓
       4 × 6s VIDEO GEN
              ↓
          VIDEO QA
              ↓
       GEMINI TTS 24s
              ↓
    AUDIO DURATION VALIDATION
              ↓
       24s VIDEO ASSEMBLY
              ↓
            MUX
              ↓
          DELIVERY
```

------------------------------------------------------------------------

# 77. DEFINITION OF DONE

The migration is complete only when:

-   [ ] Final video has exactly four planned scenes.
-   [ ] Each generated scene targets 6 seconds.
-   [ ] Final timeline targets 24 seconds.
-   [ ] Framework is Discovery → Show → Experience → Verdict.
-   [ ] Every product has a Hero Interaction.
-   [ ] Visual actions are planned before voice-over.
-   [ ] Audio semantically follows visible actions.
-   [ ] Food occupies strong frame area.
-   [ ] Hand actions are meaningful.
-   [ ] Texture/interior/sauce/consistency proof is prioritized.
-   [ ] Script sounds spoken rather than written.
-   [ ] Reviewer persona is stable.
-   [ ] Default self-reference behavior is stable.
-   [ ] Audience address is not overused.
-   [ ] Southern/Mekong particles are natural and sparse.
-   [ ] Unsupported sensory claims are blocked.
-   [ ] Review contains balanced language.
-   [ ] Hard-selling language is not the default.
-   [ ] Gemini TTS is prompt-steered for fast conversational delivery.
-   [ ] TTS duration is validated before mux.
-   [ ] Storyboard has action runway.
-   [ ] 6-second video prompts preserve product fidelity.
-   [ ] Hero Interaction is visually readable.
-   [ ] QA rejects product/hand/physics failures.
-   [ ] Existing delivery/remake infrastructure continues to work where
    applicable.

------------------------------------------------------------------------

# 78. MOST IMPORTANT PRINCIPLE

The finished channel should not feel like:

``` text
AI writes an ad
→ AI voice reads it
→ AI video shows the food
```

It should feel like:

``` text
A reviewer notices something
→ camera shows it
→ her hands interact with it
→ the food reveals a sensory property
→ her voice reacts at that exact moment
→ she gives a natural verdict
```

In one sentence:

> **Camera thấy gì, tay đang làm gì, thì giọng review phải phản ứng đúng
> cái đó.**

That synchronization is the central creative system of this channel.

------------------------------------------------------------------------

# 79. AGENT INSTRUCTION

Treat this as a new channel template, not a small modification of the
household or Mother & Baby template.

Recommended internal template name:

``` text
FOOD_REVIEW_TEMPLATE_PRO
```

Do not carry unrelated assumptions from other channels into this one.

Especially remove/reject:

``` text
household problem/solution framing
mother/baby character logic
faceless household-specific rules
generic 16-second timing
4×4s generation
aggressive affiliate CTA defaults
generic Gen-Z hype voice
```

The required production architecture is:

``` text
FOOD REVIEW
4 × 6s
24s
SOUTHERN VIETNAMESE / SUBTLE MEKONG REVIEW PERSONA
HERO INTERACTION
SENSORY PROOF
SOFT VERDICT
GEMINI TTS
```

------------------------------------------------------------------------

# 80. FUTURE CALIBRATION NOTE

The next highest-value improvement is to obtain a reliable verbatim
transcript of the three reference videos.

Once available, update this specification with an evidence-based:

``` text
FOOD_REVIEWER_PERSONA_V2
```

containing exact:

-   pronoun distribution,
-   audience-address distribution,
-   regional particle frequency,
-   regional vocabulary,
-   sentence templates,
-   opening/closing habits,
-   thought-group length,
-   CTA wording,
-   speech-rate by segment.

Do not fabricate these statistics before transcript evidence exists.
