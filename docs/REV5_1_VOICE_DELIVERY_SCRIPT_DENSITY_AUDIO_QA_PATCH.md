# REV5.1 — Voice Delivery, Script Density & Audio QA Patch

## Purpose

This document is a corrective patch for the current REV5 product-video pipeline.

The goal is to make Vietnamese narration sound fast, dense, natural, expressive, and conversational in the desired social-commerce / TikTok review style, while keeping timing measurable and QA-driven.

This patch must NOT redesign the existing video architecture.

## Architecture Guardrail — DO NOT CHANGE

Keep the current pipeline:

1. One multimodal product-analysis pass.
2. One master 4-panel storyboard generation.
3. Blocking storyboard QA with bounded retries/fallback handling.
4. Slice the accepted storyboard into Panel 1–4.
5. `VEO_NATIVE_FAST` Video 1 = 8s, Panel 1 → Panel 2.
6. `VEO_NATIVE_FAST` Video 2 = 8s, Panel 3 → Panel 4.
7. Video QA.
8. Final concat = 16s.

Do NOT change this into 4×4s video generation.
Do NOT change this into one 16s Veo generation.

---

## 1. Remove Fixed 3 Words/Second Assumption

The current assumption:

```text
~3 words/sec
```

is NOT a reliable representation of fast Vietnamese TikTok/social-commerce speech.

Do not calculate Vietnamese narration duration using only:

```text
estimatedDuration = wordCount / 3
```

Vietnamese speech timing must consider:

- syllable count
- phrase structure
- punctuation
- numbers
- English/foreign words
- product/model names
- natural micro-pauses
- pronunciation complexity

Word count may still be recorded as diagnostic metadata, but must NOT be the primary timing metric.

---

## 2. Introduce Voice Delivery Profile

Replace the simplistic voice configuration with a richer `VOICE_DELIVERY_PROFILE`.

Default target profile:

```text
Language: vi-VN
Dialect Family: Southern Vietnamese
Register: highly colloquial / natural everyday spoken Vietnamese
Context: social-commerce / TikTok product review

Speaker Style:
- young adult
- bright
- friendly
- lively
- approachable
- casual
- enthusiastic
```

Do NOT sound like:

- formal commercial announcer
- news presenter
- corporate voice-over
- robotic TTS
- exaggerated salesperson
- shouting

The dialect field describes desired speech characteristics only. It must not be treated as a claim about a speaker's real-world origin.

---

## 3. Fast Speech Must Be Phrase-Driven

"Fast" must NOT mean mechanically pronouncing every word faster.

Target delivery:

- fast conversational speech
- high speech density
- continuous phrase chaining
- very short micro-pauses
- minimal dead air
- natural breath placement
- dynamic emphasis
- natural Vietnamese phrase rhythm

Desired rhythm:

```text
FAST PHRASE
→ tiny natural micro-pause
→ emphasized phrase
→ immediately continue
→ pitch movement
→ next phrase
```

Avoid:

```text
word → pause → word → pause
```

Also avoid:

```text
sentence → large pause → next sentence
```

The voice should feel like a real person enthusiastically talking directly to the viewer, not an AI reading individual words quickly.

---

## 4. Prosody / Intonation Profile

Voice must remain expressive even at high speed.

```text
Prosody: animated and conversational
Base Pitch: medium
Pitch Movement: dynamic
Energy: high but natural
Emphasis: selective
Sentence Endings: lively and conversational
```

Prefer emphasis on:

- important product benefits
- surprising/useful features
- verified specifications
- emotional/reaction words
- CTA when appropriate

Do NOT:

- apply equal stress to every word
- keep pitch flat
- artificially stretch emphasized words
- shout to simulate high energy

---

## 5. Pause Behavior

Use extremely limited dead air.

Target:

```text
Initial Silence: <= 0.25s preferred
Maximum Acceptable Initial Silence: 0.30s
Normal Micro-Pause: approximately 0.05–0.18s when linguistically appropriate
Long Internal Pauses: avoid
```

A visual scene transition must NOT automatically create an audio pause.

The ~4-second visual cut between the two scenes is VISUAL ONLY.

Narration should continue naturally through the cut when the phrase/sentence continues.

---

## 6. Change Script Generation from Word Target to Speech-Density Target

Do NOT generate dialogue using a fixed low word target such as:

```text
19 words for ~6.3 seconds
```

Instead:

Generate the longest NATURAL and USEFUL Vietnamese dialogue that fits the target active speech window at fast conversational delivery.

For each 8-second video:

```text
Preferred Speech Start: 0.10–0.25s
Maximum Initial Silence: 0.30s
Preferred Speech Completion: 6.2–6.8s
Remaining Visual/Audio Tail: approximately 1.2–1.8s
Speech Density: HIGH
```

Initial script generation may typically fall around:

```text
~25–32 Vietnamese words
```

but this is NOT a hard limit.

The actual amount must be determined dynamically by speech feasibility.

Do not pad dialogue with unsupported claims merely to increase density.

---

## 7. Add Script Fill State

The Script Feasibility Gate must detect THREE states:

```text
UNDERFILLED
READY
OVERFILLED
```

### UNDERFILLED

Dialogue is too short to create the desired high-density delivery within the available narration window.

Example:

```text
19 words
+
large available speech window
=
UNDERFILLED
```

Action:

Expand using ONLY verified information from `ProductFactLock` and other approved product evidence.

Possible useful additions:

- verified benefit
- verified feature
- use case
- natural reaction
- transition
- CTA

Never invent product claims just to make the script longer.

### READY

Dialogue naturally fills the target speech window using the desired fast conversational delivery.

Proceed to video generation.

### OVERFILLED

Dialogue would require unnatural rushing, dropped words, poor intelligibility, or incomplete delivery.

Action:

Compress/rewrite while preserving the most important verified information.

---

## 8. Speech Feasibility Loop

Before sending dialogue to Veo:

```text
Generate dialogue
↓
Analyze syllables + phrases + pronunciation complexity
↓
Estimate spoken duration using FAST_CONVERSATIONAL_VI profile
↓

UNDERFILLED
→ expand useful verified content
→ re-estimate

OVERFILLED
→ compress wording
→ re-estimate

READY
→ send to Veo
```

Do NOT solve `OVERFILLED` dialogue by simply instructing Veo to "speak much faster."

Do NOT accept `UNDERFILLED` dialogue merely because it technically finishes before the maximum speech-end time.

---

## 9. Update Veo Voice Performance Lock

Use a richer voice instruction:

```text
[VOICE PERFORMANCE LOCK]

Language: vi-VN
Dialect Family: Southern Vietnamese
Register: colloquial everyday Vietnamese
Speaker Class: young_adult
Timbre: warm, bright, approachable
Energy: high, lively, natural

Delivery: fast conversational social-commerce review
Speech Profile: FAST_CONVERSATIONAL_VI
Speech Density: HIGH
Phrase Chaining: HIGH

Initial Silence: <= 0.25s preferred
Maximum Initial Silence: 0.30s
Micro-Pauses: very short and natural
Long Pauses: forbidden unless linguistically necessary

Prosody: animated and conversational
Pitch Movement: dynamic
Emphasis: selective, benefit-driven
Articulation: natural fast Vietnamese
Naturalness: HIGH

Speak in connected Vietnamese phrases rather than isolated words.

Maintain expressive pitch movement and selective emphasis while
speaking quickly.

Do not sound like a formal advertisement, announcer, or robotic TTS.

Do not introduce artificial pauses at visual scene cuts.
```

---

## 10. Update the 8-Second Timing Contract

Remove:

```text
Native Vietnamese Dialogue (19 words, ~6.3s estimated)
Pacing: ~3 words/sec
```

Replace timing strategy with:

```text
[FULL 8s DIALOGUE TIMING CONTRACT]

Target Speech Start: 0.10–0.25s
Maximum Acceptable Initial Silence: 0.30s
Preferred Speech Completion: 6.2–6.8s

Speech Profile: FAST_CONVERSATIONAL_VI
Speech Density Target: HIGH

Delivery must feel:
- dense
- continuous
- energetic
- natural
- expressive

Do NOT force an exact words-per-second target.
```

---

## 11. Add Audio Delivery QA

Video QA must evaluate more than:

```text
Did narration finish before 6.5s?
```

Measure at minimum:

- `actualSpeechStart`
- `actualSpeechEnd`
- `activeSpeechDuration`
- `initialSilenceDuration`
- `internalPauseDistribution`
- `longPauseCount`
- `scriptCompleteness`
- `speechDensity`
- `pacingClassification`
- `deliveryNaturalness`
- `energyConsistency`

Example:

```json
{
  "actualSpeechStart": 0.16,
  "actualSpeechEnd": 6.51,
  "activeSpeechDuration": 6.12,
  "initialSilenceDuration": 0.16,
  "longPauseCount": 0,
  "scriptCompleteness": 1.0,
  "speechDensity": "HIGH",
  "pacingClassification": "FAST",
  "deliveryNaturalness": "HIGH",
  "energyConsistency": "HIGH",
  "pass": true
}
```

---

## 12. QA Must Detect Under-Dense Voice

A clip must NOT pass merely because:

```text
speechStart <= 0.30s
AND
speechEnd <= 6.80s
```

Example:

```text
12 words spoken from 0.2s → 4.0s
```

must NOT automatically PASS.

QA must determine whether the generated voice actually has the desired high-density, fast conversational delivery.

Introduce failure reason:

```text
VOICE_DELIVERY_UNDER_DENSE
```

Other useful failure reasons may include:

```text
VOICE_LATE_START
VOICE_TOO_SLOW
VOICE_LONG_PAUSES
VOICE_ROBOTIC
VOICE_INCOMPLETE_DIALOGUE
VOICE_OVERFILLED
VOICE_ENERGY_MISMATCH
```

---

## 13. Retry Must Be Failure-Aware

Retry behavior must depend on the actual QA failure.

```text
LATE_START
→ strengthen immediate narration requirement

UNDER_DENSE
→ increase useful verified script density and/or delivery density

TOO_SLOW
→ strengthen fast conversational phrase chaining

OVERFILLED
→ shorten/restructure script

LONG_PAUSES
→ reduce unnecessary punctuation and strengthen continuous delivery

ROBOTIC
→ increase conversational phrase rhythm, dynamic prosody,
  selective emphasis, and natural articulation

INCOMPLETE_DIALOGUE
→ shorten/restructure script before retry

ENERGY_MISMATCH
→ correct energy/prosody without unnecessarily changing product visuals
```

Do NOT regenerate with exactly the same script and exactly the same instructions when QA has already identified the cause.

Do not retry indefinitely.

Preserve the existing bounded retry + best-usable/fallback strategy from REV5.

---

## 14. Reference Voice Style Support

Add optional:

```text
VOICE_REFERENCE_PROFILE
```

When a reference video/audio is provided, analyze its DELIVERY STYLE, not the identity of the speaker.

Extract characteristics such as:

- language
- dialect/accent characteristics
- speech rate
- syllable rate where measurable
- active speech occupancy
- phrase length
- pause distribution
- rhythm
- pitch movement
- emphasis pattern
- energy
- articulation
- colloquiality
- sentence-ending behavior
- naturalness characteristics

Use those characteristics to construct the target delivery profile.

The objective is:

```text
MATCH DELIVERY CHARACTERISTICS
```

not:

```text
CLONE A SPECIFIC PERSON'S VOICE IDENTITY
```

---

## 15. Current Target Reference Style

For the current desired delivery style, use approximately:

```text
Language:
Vietnamese

Dialect Characteristics:
Southern Vietnamese

Register:
very colloquial / everyday spoken language

Delivery:
fast conversational
high-density
continuous
energetic

Rhythm:
phrase-driven
strong phrase chaining

Pauses:
very short micro-pauses
minimal dead air

Prosody:
animated
dynamic
expressive

Energy:
bright
lively
friendly

Naturalness:
should feel like a person enthusiastically reviewing a product
directly to the viewer, NOT reading an advertisement script
```

This is a delivery-style target, not a speaker-identity target.

---

## 16. Important Design Principle

Fast voice is NOT produced by one variable.

Do NOT define:

```text
FAST = wordsPerSecond
```

Instead model fast natural speech as the interaction of:

```text
FAST NATURAL DELIVERY =
script density
+ syllable load
+ phrase chaining
+ short pauses
+ high speech occupancy
+ dynamic prosody
+ selective emphasis
+ colloquial wording
+ appropriate articulation speed
```

All factors must work together.

A technically fast playback rate with robotic phrasing is NOT considered a successful fast-natural voice.

---

## 17. Replace Dialogue Metadata Format

REMOVE the old dialogue metadata format:

```text
Native Vietnamese Dialogue (19 words, ~6.3s estimated):
"..."
```

Do NOT expose a fixed word-count-based duration estimate as the primary speech timing indicator.

REPLACE it with:

```text
Native Vietnamese Dialogue:
"..."

Speech Profile: FAST_CONVERSATIONAL_VI
Fill State: UNDERFILLED | READY | OVERFILLED
Target Window: 0.10s → 6.60s
Speech Density Target: HIGH
Estimated Delivery: FAST / CONTINUOUS / NATURAL
```

Optional diagnostic metadata may still include:

- word count
- syllable count
- estimated speech duration
- estimated speech occupancy

These values are diagnostic only and must NOT independently control the voice strategy.

Example:

```text
Native Vietnamese Dialogue:
"Bình giữ nhiệt cartoon này xinh xỉu luôn nha, ruột inox 316 an toàn,
giữ nóng giữ lạnh cực lâu, nắp kín tiện mang đi học đi làm mỗi ngày!"

Speech Profile: FAST_CONVERSATIONAL_VI
Fill State: READY
Target Window: 0.10s → 6.60s
Speech Density Target: HIGH
Estimated Delivery: FAST / CONTINUOUS / NATURAL

Diagnostics:
- Word Count: dynamically calculated
- Syllable Count: dynamically calculated
- Estimated Speech Duration: dynamically estimated
- Estimated Speech Occupancy: dynamically estimated
```

---

# Acceptance Criteria

The patch is complete only when all of the following are true:

1. The system no longer uses `~3 words/sec` as the primary Vietnamese timing rule.
2. A short script can be classified as `UNDERFILLED`.
3. An excessively dense script can be classified as `OVERFILLED`.
4. Script generation iterates until it reaches `READY` or the configured fallback policy is triggered.
5. Only verified product facts may be used to expand an underfilled script.
6. Each 8s video targets narration beginning around 0.10–0.25s.
7. Initial silence above 0.30s is treated as a QA issue.
8. Preferred narration completion is approximately 6.2–6.8s.
9. Visual cuts do not automatically create narration pauses.
10. Audio QA measures speech density and pause behavior, not only start/end timestamps.
11. Under-dense delivery can fail QA even if timing boundaries technically pass.
12. Retry instructions are generated from the specific audio failure.
13. Voice prompts describe phrase rhythm, prosody, energy, pause behavior, and naturalness.
14. The old `Native Vietnamese Dialogue (N words, ~Xs estimated)` primary metadata format is removed.
15. New dialogue metadata includes `Speech Profile`, `Fill State`, `Target Window`, `Speech Density Target`, and `Estimated Delivery`.
16. Optional reference audio/video can generate a `VOICE_REFERENCE_PROFILE` based on delivery characteristics.
17. The existing 2×8s VEO_NATIVE_FAST architecture remains unchanged.

# Final Agent Instruction

Implement this patch throughout all relevant schemas, prompt builders, script-generation logic, speech-feasibility logic, video QA logic, retry correction logic, logs, debug output, and generated run documentation.

Do not only update prompt wording.

The implementation must make `UNDERFILLED / READY / OVERFILLED`, `FAST_CONVERSATIONAL_VI`, speech-density QA, and the new dialogue metadata real pipeline behaviors.

Preserve all existing REV5 product-identity, storyboard, start-frame, visual-QA, fallback, and VEO_NATIVE_FAST 2×8s requirements unless this document explicitly modifies voice/audio behavior.
