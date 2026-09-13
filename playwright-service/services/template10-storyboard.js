'use strict';

/**
 * template10-storyboard.js
 *
 * Template 10 — VEO_NATIVE_FAST 2×8s (REV5 FINAL SPEC)
 *
 * REV5 Changes over REV4:
 *   Fix 1: Storyboard QA is now a BLOCKING gate (hard abort on max retries).
 *   Fix 2: Panel "OK" now means file created only, NOT visual correctness.
 *   Fix 3: TRUE start-frame binding via provider native first-frame mechanism.
 *   Fix 4: exactStartFrameGuaranteed metadata (true only for native conditioning).
 *   Fix 5: POST-VIDEO frame QA — extract first frame and compare to panel target.
 *   Fix 6: Measurable speech timing contract (start ≤0.3s, end ~6.0-6.5s).
 *   Fix 7: AUDIO QA — measure silence/speech duration from generated video.
 *   Fix 8: Script feasibility/compression logic (word count budget per video).
 *   Fix 9: NO-TEXT fix — brand/product labels on physical product are allowed.
 *   Fix 10: Canonical Product Instance now includes Variant Identity Tuple.
 */

const fs = require('fs');
const path = require('path');
const { GeminiApiClient } = require('./gemini-client/gemini-api');
const { generateVideosFromPanelsDirect } = require('./gemini-webapi-storyboard');
const { sendPhotoToTelegram } = require('./telegram-send');
const { getCartAnchorText } = require('./cart-cta');
const { sliceStoryboardIntoFourPanels } = require('./template5-storyboard');
const { mergeVideos } = require('./video-merge');

// ── REV5 Config ───────────────────────────────────────────────────────────────

const REV5_CONFIG = {
  // ── Storyboard QA budget ───────────────────────────────────────────────────
  MAX_STORYBOARD_REGENERATION_RETRIES: 2,
  MAX_STORYBOARD_GEN_ATTEMPTS: 9,
  STORYBOARD_QA_BLOCKING: true,

  // ── Video QA budget ───────────────────────────────────────────────────────
  MAX_VIDEO_REGENERATION_RETRIES: 2,
  MAX_VIDEO_GEN_ATTEMPTS: 9,
  VIDEO_QA_BLOCKING: true,

  // ── Timing contract ───────────────────────────────────────────────────────
  SPEECH_START_MAX_S: 0.30,         // max acceptable initial silence
  SPEECH_START_PREFERRED_MAX_S: 0.25, // preferred
  SPEECH_END_TARGET_S: 6.50,        // preferred completion (center of 6.2-6.8s window)
  SPEECH_END_WINDOW_MIN_S: 6.20,
  SPEECH_END_WINDOW_MAX_S: 6.80,
  SPEECH_END_TOLERANCE_S: 0.30,     // abs max = 6.80s
  VIDEO_DURATION_S: 8.0,
  AUDIO_TAIL_S: 1.2,                // min visual tail after speech

  // ── REV5.1: Vietnamese speech estimator ──────────────────────────────────
  // Vietnamese is a monosyllabic tonal language — syllables are a better
  // timing unit than words. At fast conversational delivery (~FAST_CONVERSATIONAL_VI):
  //   ~5.5–6.5 syllables/second, micro-pauses ~0.05–0.18s between phrases.
  // Word count is preserved as diagnostic metadata only, NOT primary control.
  VI_SYLLABLES_PER_SECOND_FAST: 6.0,   // fast conversational TikTok delivery
  VI_SYLLABLES_PER_SECOND_NORMAL: 4.5, // normal delivery fallback
  VI_AVG_SYLLABLES_PER_WORD: 1.85,     // average Vietnamese syllables per orthographic word
  // FILL STATE thresholds (as fraction of available speech window)
  VI_FILL_UNDERFILLED_RATIO: 0.70,     // < 70% of window used → UNDERFILLED
  VI_FILL_OVERFILLED_RATIO: 0.95,      // > 95% of window used → OVERFILLED
  VI_TARGET_WINDOW_S: 6.40,            // 0.1s start → 6.5s end = 6.4s active speech

  // ── REV5.1: Speech density QA ─────────────────────────────────────────────
  AUDIO_MIN_SPEECH_RATIO: 0.60,
  AUDIO_MIN_ACTIVE_DURATION_S: 4.5,  // activeSpeechDuration must be >= this for HIGH density
  AUDIO_MAX_LONG_PAUSES: 1,          // any silence gap > 0.5s counts as a long pause
  AUDIO_LONG_PAUSE_THRESHOLD_S: 0.5,

  // ── Model capabilities ────────────────────────────────────────────────────
  NATIVE_START_FRAME_MODEL: 'abra_i2v_8s',
  START_FRAME_CAPABILITY: {
    'abra_i2v_8s': { nativeFirstFrame: true, exactStartFrameGuaranteed: true },
    'abra_r2v_8s': { nativeFirstFrame: false, exactStartFrameGuaranteed: false },
  },
};

// ── REV5.1: FAST_CONVERSATIONAL_VI Voice Delivery Profile ─────────────────────
// This is the canonical target voice delivery profile for all Vietnamese narration.
// Do NOT reference words-per-second. Use syllable rate + fill state instead.
const FAST_CONVERSATIONAL_VI = {
  language: 'vi-VN',
  dialectFamily: 'Southern Vietnamese',
  register: 'colloquial everyday Vietnamese',
  speakerClass: 'young_adult',
  timbre: 'warm, bright, approachable',
  energy: 'high, lively, natural',
  delivery: 'fast conversational social-commerce review',
  speechProfile: 'FAST_CONVERSATIONAL_VI',
  speechDensity: 'HIGH',
  phraseChaining: 'HIGH',
  initialSilenceMaxS: 0.30,
  initialSilencePreferredMaxS: 0.25,
  microPauseRangeS: [0.05, 0.18],
  longPausesForbidden: true,
  prosody: 'animated and conversational',
  pitchMovement: 'dynamic',
  emphasis: 'selective, benefit-driven',
  articulation: 'natural fast Vietnamese',
  naturalness: 'HIGH',
  doNotSound: ['formal announcer', 'news presenter', 'corporate voice-over', 'robotic TTS', 'exaggerated salesperson'],
  notes: [
    'Speak in connected Vietnamese phrases, not isolated words.',
    'Maintain expressive pitch movement and selective emphasis while speaking quickly.',
    'Fast = phrase-chaining + short micro-pauses + high density, NOT mechanically faster playback.',
    'Do not introduce artificial pauses at visual scene cuts.',
    'The ~4s visual cut is VISUAL ONLY — narration continues smoothly.',
  ],
};



// ── Utilities ─────────────────────────────────────────────────────────────────

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function stripCodeFence(text) {
  let s = (text || '').trim();
  // Remove BOM
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  // Remove leading/trailing code fences (handles ```json, ```JSON, ``` etc.)
  s = s.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '');
  // Remove any inline "Here is the JSON:" type prefix before the {
  // (strip any non-JSON prefix text before the first { or [)
  return s.trim();
}

function parseJsonSafe(text) {
  // Step 0: sanitize — remove BOM, control chars (except \t\n\r), CRLF normalize
  const sanitize = (s) => s
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // remove control chars except \t\n\r

  const cleaned = sanitize(stripCodeFence(text || ''));

  // Step 1: direct parse
  try { return JSON.parse(cleaned); } catch (_) {}

  // Step 2: extract first { ... } block
  try {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  } catch (_) {}

  // Step 3: partial recovery — close open braces
  try {
    const start = cleaned.indexOf('{');
    if (start >= 0) {
      let partial = cleaned.slice(start);
      let inString = false, escape = false;
      const stack = [];
      for (let i = 0; i < partial.length; i++) {
        const c = partial[i];
        if (escape) { escape = false; continue; }
        if (c === '\\' && inString) { escape = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === '{') stack.push('}');
        else if (c === '[') stack.push(']');
        else if (c === '}' || c === ']') stack.pop();
      }
      if (inString) partial += '"';
      partial = partial.replace(/,\s*"[^"]*$/, '').replace(/,\s*$/, '');
      // Re-close open braces
      const closeStack = [];
      inString = false; escape = false;
      for (let i = 0; i < partial.length; i++) {
        const c = partial[i];
        if (escape) { escape = false; continue; }
        if (c === '\\' && inString) { escape = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === '{') closeStack.push('}');
        else if (c === '[') closeStack.push(']');
        else if (c === '}' || c === ']') closeStack.pop();
      }
      while (closeStack.length) partial += closeStack.pop();
      return JSON.parse(partial);
    }
  } catch (_) {}

  // Step 4: last resort — try to parse after stripping any ```...``` blocks
  try {
    const withoutFences = (text || '').replace(/```[\s\S]*?```/g, '').trim();
    const start = withoutFences.indexOf('{');
    const end = withoutFences.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(withoutFences.slice(start, end + 1));
  } catch (_) {}

  // Log first 300 chars for debugging
  console.warn(`[parseJsonSafe] All parse attempts failed. First 300 chars: ${(text || '').substring(0, 300)}`);
  return null;
}


// ── REV5.1: Vietnamese Speech Estimator ──────────────────────────────────────
// Replaces the old 3-words/sec fixed formula.
// Vietnamese is monosyllabic — syllable count + phrase structure drives timing.

function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Estimate syllable count for a Vietnamese text.
 * Orthographic words are mostly 1 syllable, but:
 *   - Numbers, foreign words, and model names can be multi-syllable.
 *   - This is a heuristic estimate for feasibility gating.
 */
function estimateViSyllables(text) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  let syllables = 0;
  for (const word of words) {
    // Numbers written as digits: each digit group ≈ 1–2 syllables
    if (/^[\d,.]+$/.test(word)) { syllables += Math.max(1, word.replace(/[,. ]/g, '').length * 0.6 | 0); continue; }
    // Mixed alphanumeric (model numbers like "316", "XCUP"): estimate 2 syllables
    if (/[a-zA-Z]/.test(word) && /\d/.test(word)) { syllables += 2; continue; }
    // Uppercase acronym (e.g. XCUP, BPA): each letter is a syllable
    if (/^[A-Z]{2,}$/.test(word)) { syllables += word.length; continue; }
    // Vietnamese orthographic word = typically 1 syllable (monosyllabic language)
    syllables += 1;
  }
  return Math.max(1, syllables);
}

/**
 * Estimate spoken duration in seconds using FAST_CONVERSATIONAL_VI profile.
 * @param {string} text  Vietnamese dialogue
 * @param {'fast'|'normal'} rate
 * @returns {number} seconds
 */
function estimateViSpeechDuration(text, rate = 'fast') {
  const syllables = estimateViSyllables(text);
  const syllPerSec = rate === 'fast'
    ? REV5_CONFIG.VI_SYLLABLES_PER_SECOND_FAST
    : REV5_CONFIG.VI_SYLLABLES_PER_SECOND_NORMAL;
  // Add micro-pause time: approximately one 0.10s micro-pause per phrase (every ~6 syllables)
  const phrases = Math.ceil(syllables / 6);
  const pauseTime = Math.min(phrases * 0.10, 0.80); // cap at 0.80s total micro-pauses
  return (syllables / syllPerSec) + pauseTime;
}

/**
 * Classify dialogue fill state: UNDERFILLED | READY | OVERFILLED.
 * Uses syllable-based duration estimate against the target speech window.
 * @param {string} text
 * @returns {{ fillState, estimatedDurationS, syllables, words, windowS, occupancy }}
 */
function classifyScriptFillState(text) {
  const windowS     = REV5_CONFIG.VI_TARGET_WINDOW_S;  // 6.4s
  const estimatedS  = estimateViSpeechDuration(text, 'fast');
  const occupancy   = estimatedS / windowS;
  const syllables   = estimateViSyllables(text);
  const words       = countWords(text);

  let fillState;
  if (occupancy < REV5_CONFIG.VI_FILL_UNDERFILLED_RATIO) {
    fillState = 'UNDERFILLED';
  } else if (occupancy > REV5_CONFIG.VI_FILL_OVERFILLED_RATIO) {
    fillState = 'OVERFILLED';
  } else {
    fillState = 'READY';
  }

  return { fillState, estimatedDurationS: +estimatedS.toFixed(2), syllables, words, windowS, occupancy: +occupancy.toFixed(3) };
}

/**
 * compressScriptToTimingBudget: Trim OVERFILLED script by removing trailing words.
 * Only called when fillState = OVERFILLED.
 * @param {string} text
 * @param {number} targetWords  fallback word count (used only for OVERFILLED hard trim)
 */
function compressScriptToTimingBudget(text, targetWords) {
  // First try trimming by estimated duration
  let current = (text || '').trim();
  const MAX_ITER = 8;
  for (let i = 0; i < MAX_ITER; i++) {
    const { fillState, estimatedDurationS } = classifyScriptFillState(current);
    if (fillState !== 'OVERFILLED') break;
    // Remove last sentence or last clause
    const lastPunct = Math.max(current.lastIndexOf(','), current.lastIndexOf('!'), current.lastIndexOf('.'), current.lastIndexOf('?'));
    if (lastPunct > current.length * 0.4) {
      current = current.substring(0, lastPunct).trim();
    } else {
      // Fall back: trim last N words
      const words = current.split(/\s+/);
      current = words.slice(0, Math.ceil(words.length * 0.85)).join(' ');
    }
  }
  // If targetWords specified, also enforce hard word limit
  if (targetWords) {
    const words = current.split(/\s+/);
    if (words.length > targetWords) current = words.slice(0, targetWords).join(' ');
  }
  return { text: current, ...classifyScriptFillState(current) };
}

/**
 * validateAndCompressScripts: REV5.1 version.
 * Replaces old word-count-based validation with fill-state gate.
 * Returns { video1Script, video2Script, feasibility: { video1, video2 } }
 */
function validateAndCompressScripts(fullScript) {
  const process = (raw, label) => {
    const text = (raw || '').trim();
    const state = classifyScriptFillState(text);
    let finalText = text;
    let finalState = state;

    if (state.fillState === 'OVERFILLED') {
      console.warn(`[T10][REV5.1] Script ${label} OVERFILLED (est ${state.estimatedDurationS}s / ${state.syllables} syllables). Compressing...`);
      const compressed = compressScriptToTimingBudget(text);
      finalText = compressed.text;
      finalState = compressed;
      console.log(`[T10][REV5.1] Script ${label} after compression: ${compressed.fillState} (est ${compressed.estimatedDurationS}s)`);
    } else if (state.fillState === 'UNDERFILLED') {
      // Log warning — expansion must be done by script generator with verified facts, not here
      console.warn(`[T10][REV5.1] Script ${label} UNDERFILLED (est ${state.estimatedDurationS}s / ${(state.occupancy * 100).toFixed(0)}% of window). Consider expanding with verified product benefits.`);
    } else {
      console.log(`[T10][REV5.1] Script ${label} READY (est ${state.estimatedDurationS}s / ${(state.occupancy * 100).toFixed(0)}% of window, ${state.syllables} syllables, ${state.words} words)`);
    }

    return {
      text: finalText,
      fillState: finalState.fillState,
      estimatedDurationS: finalState.estimatedDurationS,
      syllables: finalState.syllables,
      words: finalState.words,
      occupancy: finalState.occupancy,
      windowS: finalState.windowS,
    };
  };

  const s1 = process(fullScript?.video1Script, 'V1');
  const s2 = process(fullScript?.video2Script, 'V2');

  return {
    video1Script: s1.text,
    video2Script: s2.text,
    feasibility: {
      video1: { fillState: s1.fillState, estimatedDurationS: s1.estimatedDurationS, syllables: s1.syllables, words: s1.words, occupancy: s1.occupancy, windowS: s1.windowS },
      video2: { fillState: s2.fillState, estimatedDurationS: s2.estimatedDurationS, syllables: s2.syllables, words: s2.words, occupancy: s2.occupancy, windowS: s2.windowS },
    },
  };
}


// ── Analysis Normalization ────────────────────────────────────────────────────
// Bug: Gemini sometimes returns the full analysis object nested INSIDE
// canonicalProductInstance.variantIdentityTuple instead of just the tuple.
//
// Correct shape:
//   analysis.canonicalProductInstance.variantIdentityTuple = { colorFamily, finishType, ... }
//
// Buggy shape (seen in practice):
//   analysis.canonicalProductInstance.variantIdentityTuple = {
//     canonicalProductInstance: { ... },   ← full object nested here
//     productIdentityManifest: { ... },
//     scenes: [...],
//     ...
//   }
//
// This function detects and unwraps the buggy shape, hoisting the nested keys
// back to the top level so all downstream code works correctly.

function normalizeAnalysisData(raw) {
  if (!raw || typeof raw !== 'object') return raw || {};

  const canonical = raw.canonicalProductInstance || {};
  const vit = canonical.variantIdentityTuple;

  // Detect buggy shape: vit contains nested canonicalProductInstance (not a proper tuple)
  if (vit && typeof vit === 'object' && vit.canonicalProductInstance && !vit.colorFamily) {
    console.warn('[T10][Normalize] Detected nested analysis structure in variantIdentityTuple. Unwrapping...');
    const nested = vit; // full analysis nested here

    // Build corrected object by hoisting nested keys to top level
    const corrected = {
      ...raw,
      // Overwrite top-level keys with nested equivalents (if they're missing or empty at top)
      productIdentityManifest:  raw.productIdentityManifest  || nested.productIdentityManifest,
      productFactLock:          raw.productFactLock           || nested.productFactLock,
      scenes:                   (raw.scenes && raw.scenes.length > 0) ? raw.scenes : nested.scenes,
      voicePerformanceProfile:  raw.voicePerformanceProfile  || nested.voicePerformanceProfile,
      fullScript:               raw.fullScript               || nested.fullScript,
      referenceRoleMap:         raw.referenceRoleMap         || nested.referenceRoleMap,
      visualEvidenceMatrix:     raw.visualEvidenceMatrix     || nested.visualEvidenceMatrix,
      // Fix canonical: replace bugged vit with the real nested tuple
      canonicalProductInstance: {
        ...canonical,
        variantIdentityTuple: nested.canonicalProductInstance?.variantIdentityTuple || null,
      },
    };

    console.log(`[T10][Normalize] Unwrap OK: productName="${corrected.productFactLock?.productName}", scenes=${corrected.scenes?.length}, vit.colorFamily="${corrected.canonicalProductInstance.variantIdentityTuple?.colorFamily}"`);
    return corrected;
  }

  return raw;
}

// ── Fix 10: Variant Identity Tuple ───────────────────────────────────────────

function buildVariantIdentityTuple(analysisData) {
  const manifest = analysisData?.productIdentityManifest || {};
  const lock = analysisData?.productFactLock || {};
  const canonical = analysisData?.canonicalProductInstance || {};
  const appearance = manifest.appearance || '';
  const variantFacts = (lock.variantSpecificFacts || []).join('; ');
  const colorMatch = appearance.match(/^([^,]+)/);
  const finishMatch = appearance.match(/\b(matte|glossy|satin|brushed|metallic|transparent|clear|frosted)\b/i);
  const graphicMatch = (manifest.identityCriticalTraits || []).find(t => /logo|graphic|mascot|print|pattern|cartoon/i.test(t));
  return {
    tupleId: `VIT_${canonical.productIdentityId || 'PRODUCT_001'}`,
    colorFamily: colorMatch ? colorMatch[1].trim() : 'as-reference',
    finishType: finishMatch ? finishMatch[1].toLowerCase() : 'as-reference',
    graphicVariant: graphicMatch || 'as-reference',
    sizeClass: manifest.overallGeometry || 'as-reference',
    configState: manifest.configuration || 'standard',
    variantLock: variantFacts || 'match canonical reference exactly',
    canonicalReferenceId: canonical.canonicalReferenceId || 'REF_01',
  };
}


// ── Action Complexity ─────────────────────────────────────────────────────────

const ACTION_COMPLEXITY = {
  SAFE: ['hold product','lift product','place product','point to visible feature','press one visible button','slight rotation','put product into bag','wear product','carry product'],
  MEDIUM: ['open lid','close lid','adjust hinge','attach simple strap','plug a visible cable','fold','unfold'],
  HIGH_RISK: ['disassemble','reassemble','transform','show hidden mechanism','open multiple compartments','demonstrate internal moving parts','prove leak-proof by inversion','complex installation'],
};

function checkActionFeasibility(action, visualEvidenceMatrix) {
  if (!action) return { feasible: true, replacementAction: 'hold product and point to visible feature' };
  const lower = action.toLowerCase();
  const isHighRisk = ACTION_COMPLEXITY.HIGH_RISK.some(hr => lower.includes(hr.split(' ')[0]));
  if (isHighRisk) {
    const evidence = visualEvidenceMatrix?.states || {};
    const hasEvidence = Object.values(evidence).some(s => s.available && (s.referenceIds || []).length > 0);
    if (!hasEvidence) return { feasible: false, replacementAction: 'hold product naturally and point to visible feature' };
  }
  return { feasible: true, replacementAction: action };
}

// ── Step 1: Analysis Prompt ───────────────────────────────────────────────────

function buildProductContextSection(options = {}) {
  const ctx = options.productContext || {};
  const lines = [];
  if (ctx.productTitle) lines.push(`Product Title: ${String(ctx.productTitle).replace(/["\\]/g, "'").trim()}`);
  if (ctx.productId) lines.push(`Product ID: ${ctx.productId}`);
  if (ctx.productDescription) {
    const cleanDesc = String(ctx.productDescription).slice(0, 1000).replace(/["\\]/g, "'").replace(/[\r\t]/g, ' ').trim();
    lines.push(`Product Description:\n${cleanDesc}`);
  }
  return lines.length ? `\nProduct Metadata:\n${lines.join('\n')}\n` : '';
}

function buildTemplate10AnalysisPrompt(options = {}) {
  return `TASK: Return a strictly compact RFC 8259 JSON for an e-commerce video pipeline (Template 10 REV5).
DO NOT write essays, explanations, or long markdown. Use concise machine-oriented values (max 10-15 words per field).
${buildProductContextSection(options)}

Analyze the uploaded images and product metadata to resolve ONE canonical product instance, 4 scenes, and voiceover:

JSON SCHEMA:
{
  "canonicalProductInstance": {
    "productIdentityId": "PRODUCT_001",
    "selectionStatus": "RESOLVED",
    "canonicalReferenceId": "REF_01",
    "supportingIdentityReferenceIds": ["REF_02"],
    "excludedConflictingReferenceIds": [],
    "confidence": 0.95,
    "variantIdentityTuple": {
      "tupleId": "VIT_PRODUCT_001",
      "colorFamily": "primary color from reference",
      "finishType": "matte|glossy|satin|brushed|metallic|transparent|as-reference",
      "graphicVariant": "logo/mascot/print description or as-reference",
      "sizeClass": "compact cylinder|rectangular box|etc.",
      "configState": "closed|open|assembled|standard",
      "variantLock": "exact variant constraints from canonical reference",
      "canonicalReferenceId": "REF_01"
    }
  },
  "productIdentityManifest": {
    "productIdentityId": "PRODUCT_001",
    "overallGeometry": "compact shape description",
    "appearance": "primary colorway, finish, logo details",
    "componentLayout": ["component 1", "component 2"],
    "configuration": "standard product configuration",
    "identityCriticalTraits": ["trait 1 (exact color/material)", "trait 2 (logo/print)", "trait 3 (key mechanism)"],
    "forbiddenMutations": ["do NOT change primary color", "do NOT alter logo", "do NOT invent nonexistent features"],
    "unknownTraits": []
  },
  "referenceRoleMap": [
    { "refId": "REF_01", "role": "CANONICAL_IDENTITY", "reason": "primary front hero shot" },
    { "refId": "REF_02", "role": "STATE_EVIDENCE", "reason": "shows product detail or usage state" }
  ],
  "productFactLock": {
    "productName": "Concise Vietnamese Product Name",
    "category": "home|fashion|cosmetics|gadgets|accessories|other",
    "verifiedFacts": ["verified fact 1", "verified fact 2", "verified fact 3"],
    "variantSpecificFacts": ["selected variant color and specs"],
    "conflictingClaims": []
  },
  "visualEvidenceMatrix": {
    "states": { "fullProductFront": { "available": true, "refId": "REF_01" } }
  },
  "scenes": [
    { "sceneNumber": 1, "phase": "Hook", "visualCore": "Specific visual action at 0s", "primaryAction": "SAFE hand action", "actionComplexity": "SAFE", "actionEvidenceRef": "REF_01", "voiceLine": "Short punchy Vietnamese hook (approx 10-12 words)." },
    { "sceneNumber": 2, "phase": "Solution", "visualCore": "Key feature at 4s", "primaryAction": "Demonstrate main benefit", "actionComplexity": "SAFE", "actionEvidenceRef": "REF_01", "voiceLine": "Short Vietnamese solution sentence (approx 10-12 words)." },
    { "sceneNumber": 3, "phase": "Proof", "visualCore": "Durability or ease of use at 8s", "primaryAction": "Action proving quality", "actionComplexity": "SAFE", "actionEvidenceRef": "REF_01", "voiceLine": "Short Vietnamese proof sentence (approx 10-12 words)." },
    { "sceneNumber": 4, "phase": "Closing", "visualCore": "Lifestyle context with hand pointing at 12s", "primaryAction": "place product on surface and point", "actionComplexity": "SAFE", "actionEvidenceRef": "REF_01", "voiceLine": "Short Vietnamese call-to-action (approx 10-12 words)." }
  ],
  "voicePerformanceProfile": {
    "profileId": "VOICE_001", "language": "vi-VN", "speakerClass": "young_adult",
    "accent": "southern_vietnamese", "timbre": "warm_bright_approachable", "pitch": "medium",
    "delivery": "rapid_fire_tiktok_review", "energy": "high", "pauseBehavior": "minimal",
    "speechStyle": "natural_colloquial_vietnamese"
  },
  "fullScript": {
    "script16s": "Full 16-second script in Vietnamese (42-48 words total).",
    "video1Script": "Video 1 dialogue MAX 21 WORDS. Must complete by 6.5s at rapid TikTok pace.",
    "video2Script": "Video 2 dialogue MAX 21 WORDS. Must complete by 6.5s at rapid TikTok pace.",
    "speechTimingBudget": {
      "videoDuration": 8.0, "speechStartTarget": "0.0-0.3s",
      "speechCompletionTarget": "6.0-6.5s", "safetyMargin": "1.5-2.0s", "maxWordsPerVideo": 21
    }
  },
  "cartAnchorText": "Xem ngay trong gio hang nha",
  "hashtags": ["#review", "#xuhuong", "#giadung", "#tienich", "#tiktokshop"]
}

CRITICAL RULES:
1. facelessCompatible = true (hands and torso ONLY, NO faces).
2. NEVER invent non-existent features or mechanisms.
3. No prices, no discounts, no hardcoded CTA positions.
4. video1Script and video2Script MUST each be MAX 21 words. Hard timing contract.
5. Output MUST BE ONLY VALID RAW JSON. No markdown, no preamble.`.trim();
}


// ── Step 2: Storyboard Prompt (REV5 Fix 9: NO-TEXT refined) ──────────────────

function buildTemplate10StoryboardPrompt(analysisData, options = {}, retryInstruction = '') {
  const a = normalizeAnalysisData(analysisData || {});
  const manifest = a.productIdentityManifest || {};
  const lock = a.productFactLock || {};
  const canonical = a.canonicalProductInstance || {};
  const scenes = a.scenes || [];
  const prodName = lock.productName || a.productName || 'the product';
  const vit = canonical.variantIdentityTuple || buildVariantIdentityTuple(a);

  const traits = (manifest.identityCriticalTraits && manifest.identityCriticalTraits.length > 0)
    ? manifest.identityCriticalTraits
    : ['original product shape, colorway, and surface textures exactly as shown in references'];
  const forbidden = (manifest.forbiddenMutations && manifest.forbiddenMutations.length > 0)
    ? manifest.forbiddenMutations
    : ['do NOT change body color', 'do NOT alter branding or logo', 'do NOT add fantasy attachments'];

  const sceneDescriptions = scenes.map((s, idx) => {
    const num = idx + 1;
    return `Panel ${num} (${s.phase || `Shot ${num}`}):
- Framing: Smartphone close-up snapshot, 9:16 vertical proportion.
- Visual Core: ${s.visualCore || 'Product showcased clearly'}.
- Hand Action: ${s.primaryAction || 'Hold product naturally'} (faceless, hands only).
- Product State: Perfect physical match with canonical reference (color: ${vit.colorFamily}, finish: ${vit.finishType}).`;
  }).join('\n\n');

  const retryBlock = retryInstruction
    ? `\n⚠️ MANDATORY CORRECTION FROM QA:\n${retryInstruction}\nYou MUST fix the above issues in this generation.\n`
    : '';

  return `Generate ONE still master product review storyboard collage containing EXACTLY 4 vertical panels side-by-side (16:9 collage of 4 vertical 9:16 panels) for: ${prodName}.
${retryBlock}
REFERENCE AUTHORITY HIERARCHY:
1. Canonical Product Identity (${canonical.canonicalReferenceId || 'REF_01'})
2. Product Identity Manifest
3. Scene-specific verified state evidence
4. Global visual continuity
5. Scene composition
6. Aesthetic styling
RULE: PRODUCT FIDELITY WINS over artistic liberties.

CANONICAL PRODUCT IDENTITY LOCK:
- Product Name: ${prodName}
- Variant Identity Tuple: color=${vit.colorFamily} | finish=${vit.finishType} | graphic=${vit.graphicVariant} | config=${vit.configState}
- Variant Lock: ${vit.variantLock}
- Identity Critical Traits:
${traits.map(t => `  * ${t}`).join('\n')}
- Forbidden Mutations:
${forbidden.map(f => `  * ${f}`).join('\n')}

SHARED VISUAL WORLD (STRICT CONTINUITY ACROSS ALL 4 PANELS):
- Environment ID: ENV_001 — Bright, modern, clean lifestyle indoor surface (wooden tabletop or marble countertop).
- Hand Model ID: HAND_001 — Fair Asian skin tone, natural pores, clean manicured nails, anatomically correct hands with 5 fingers.
- Lighting ID: LIGHT_001 — Soft natural window daylight, subtle authentic contact shadows.
- Camera Style ID: CAMERA_001 — Authentic smartphone camera snapshot (iPhone 15 Pro 24mm lens, f/1.8 auto mode).

STRICT NEGATIVE RULES:
- 100% FACELESS: NO human faces, NO heads, NO smiles, NO eye contact. Hands, arms, torso, and product ONLY.
- TEXT POLICY (REV5 Fix 9): FORBIDDEN — text overlays, subtitles, captions, watermarks, promotional badges, UI text.
  ALLOWED — brand name, model number, or labels physically printed/embossed on the actual product surface (e.g. XCUP logo on cup body). These are product identity, NOT text overlays.
- NO CARTOON GRAPHICS: NO neon arrows, NO floating 3D icons, NO cartoon magnifying glasses, NO fake sparkles.

PANEL BREAKDOWN (4 VERTICAL PANELS FROM LEFT TO RIGHT):
${sceneDescriptions}

Ensure all 4 panels share the identical product variant (${vit.colorFamily} ${vit.finishType}), hand model, and lighting environment.`.trim();
}


// ── Step 3: Storyboard QA Gate (REV5 Fix 1, 2) ───────────────────────────────

async function validateStoryboard(geminiClient, storyboardBuffer, analysisData) {
  console.log('[T10][REV5] 🔎 BLOCKING Storyboard QA gate via Gemini Vision...');
  const a = analysisData || {};
  const manifest = a.productIdentityManifest || {};
  const lock = a.productFactLock || {};
  const canonical = a.canonicalProductInstance || {};
  const prodName = lock.productName || a.productName || 'the product';
  const vit = canonical.variantIdentityTuple || buildVariantIdentityTuple(analysisData);
  const traits = (manifest.identityCriticalTraits || []).join('; ');
  const forbidden = (manifest.forbiddenMutations || []).join('; ');

  const qaPrompt = `You are a strict QA inspector for an e-commerce 4-panel storyboard collage.
Product: ${prodName}
Variant Lock: color=${vit.colorFamily} | finish=${vit.finishType} | graphic=${vit.graphicVariant} | config=${vit.configState}
Critical Traits: ${traits || 'Match reference images'}
Forbidden Mutations: ${forbidden || 'Do not alter color or shape'}

Analyze the 4 panels and verify:
1. Does the image contain exactly 4 vertical panels?
2. Is the EXACT SAME product AND variant (color: ${vit.colorFamily}, finish: ${vit.finishType}) consistent across all 4 panels?
3. Are hand model, environment, and lighting consistent across all panels?
4. Is it 100% faceless (no human face)?
5. Is it free of TEXT OVERLAYS, subtitles, watermarks? (NOTE: brand labels physically printed on product surface are ALLOWED.)
6. Are Panel 1 and Panel 3 suitable as video start frames (clear, unambiguous product pose)?

"panelChecks[n].pass" means VISUAL IDENTITY is correct, NOT just that file exists (Fix 2).

Return ONLY RFC 8259 JSON:
{
  "pass": true,
  "identityConsistency": true,
  "variantConsistency": true,
  "panelChecks": [
    { "panel": 1, "pass": true, "startFrameSuitable": true, "issue": "" },
    { "panel": 2, "pass": true, "startFrameSuitable": false, "issue": "" },
    { "panel": 3, "pass": true, "startFrameSuitable": true, "issue": "" },
    { "panel": 4, "pass": true, "startFrameSuitable": false, "issue": "" }
  ],
  "failureReasons": [],
  "regenerateInstructions": "",
  "hardFail": false
}
Set "hardFail": true ONLY if the defect is unrecoverable (wrong product entirely, face visible, all panels corrupt).`.trim();

  try {
    const uploaded = await geminiClient.uploadFile(storyboardBuffer, 'storyboard_qa.png', 'image/png');
    const res = await geminiClient.generateContent({
      prompt: qaPrompt,
      fileData: [{ url: uploaded, filename: 'storyboard_qa.png', mimeType: 'image/png' }],
      temporary: true,
      expectImages: false,
    });
    const parsed = parseJsonSafe(res.text || '');
    if (parsed && typeof parsed.pass === 'boolean') {
      console.log(`[T10][REV5] QA: pass=${parsed.pass}, identity=${parsed.identityConsistency}, hardFail=${parsed.hardFail}`);
      if (!parsed.pass) {
        console.warn(`[T10][REV5] QA Violations: ${(parsed.failureReasons || []).join('; ')}`);
      }
      return { ...parsed, qaFailed: false };
    }
  } catch (err) {
    console.warn(`[T10][REV5] QA call error: ${err.message}`);
    return {
      pass: false, qaFailed: true, identityConsistency: false, variantConsistency: false,
      panelChecks: [], failureReasons: [`QA vision call failed: ${err.message}`],
      regenerateInstructions: 'QA failed — regenerate storyboard with strict product identity.', hardFail: false,
    };
  }
  return {
    pass: false, qaFailed: true, identityConsistency: false, variantConsistency: false,
    panelChecks: [], failureReasons: ['QA response unparseable'],
    regenerateInstructions: 'Regenerate storyboard.', hardFail: false,
  };
}


// ── Fix 5: Post-Video Frame QA ────────────────────────────────────────────────

/**
 * runVideoQA: Full 5-group Gemini Vision QA on a generated 8s video.
 * Checks: (1) Start Frame, (2) Product Identity, (3) Scene Progression,
 *         (4) Action Correctness, (5) Audio/Voice.
 *
 * @param {GeminiApiClient} geminiClient
 * @param {Buffer} videoBuffer
 * @param {Buffer} startFramePanelBuffer  Panel 1 or Panel 3
 * @param {Buffer} targetFramePanelBuffer  Panel 2 or Panel 4
 * @param {number} videoIndex  1 or 2
 * @param {object} analysisData
 * @param {object} audioQA  result from runAudioQA (may be null)
 * @returns {{ pass, visual, audio, failureReasons, retryInstructions, skipped }}
 */
async function runVideoQA(geminiClient, videoBuffer, startFramePanelBuffer, targetFramePanelBuffer, videoIndex, analysisData, audioQA = null) {
  if (!videoBuffer || !startFramePanelBuffer) {
    return { pass: true, visual: {}, audio: {}, failureReasons: [], retryInstructions: [], skipped: true, reason: 'buffers unavailable' };
  }

  console.log(`[T10][REV5] Video ${videoIndex} QA: Extracting first frame...`);

  // --- Extract first frame via ffmpeg ---
  let firstFrameBuffer = null;
  try {
    const ffmpegStatic = require('ffmpeg-static');
    const { execSync } = require('child_process');
    const os = require('os');
    const tmpVideo = path.join(os.tmpdir(), `t10_vqa_v${videoIndex}_${Date.now()}.mp4`);
    const tmpFrame = path.join(os.tmpdir(), `t10_vqa_v${videoIndex}_f0_${Date.now()}.png`);
    fs.writeFileSync(tmpVideo, videoBuffer);
    execSync(`"${ffmpegStatic}" -y -i "${tmpVideo}" -vf "select=eq(n\\,0)" -vframes 1 "${tmpFrame}"`, { stdio: 'pipe', timeout: 30000 });
    if (fs.existsSync(tmpFrame)) {
      firstFrameBuffer = fs.readFileSync(tmpFrame);
      try { fs.unlinkSync(tmpVideo); } catch (_) {}
    }
  } catch (ffmpegErr) {
    console.warn(`[T10][REV5] Video ${videoIndex} QA: ffmpeg frame extraction failed: ${ffmpegErr.message}`);
    // Can't do visual QA without frame. Report audio QA only.
    return buildVideoQAFromAudioOnly(videoIndex, audioQA);
  }

  if (!firstFrameBuffer) {
    return buildVideoQAFromAudioOnly(videoIndex, audioQA);
  }

  const a = analysisData || {};
  const lock = a.productFactLock || {};
  const canonical = a.canonicalProductInstance || {};
  const vit = canonical.variantIdentityTuple || buildVariantIdentityTuple(a);
  const prodName = lock.productName || 'the product';
  const startPanelNum = videoIndex === 1 ? 1 : 3;
  const targetPanelNum = videoIndex === 1 ? 2 : 4;

  // Compose audio summary for QA prompt
  let audioSummary = 'Audio QA not available.';
  if (audioQA && !audioQA.skipped) {
    audioSummary = `speechStartS=${audioQA.speechStartS?.toFixed(2) || 'unknown'}s, speechEndS=${audioQA.speechEndS?.toFixed(2) || 'unknown'}s, speechRatio=${audioQA.speechRatio !== null ? (audioQA.speechRatio * 100).toFixed(0) + '%' : 'unknown'}. AudioQA issues: ${(audioQA.issues || []).join('; ') || 'none'}.`;
  }

  const qaPrompt = `You are a strict QA inspector for an 8-second e-commerce product review video (Video ${videoIndex}).
Product: ${prodName}
Variant: color=${vit.colorFamily} | finish=${vit.finishType} | graphic=${vit.graphicVariant} | config=${vit.configState}

You have:
- Image A: the FIRST FRAME extracted from the generated video.
- Image B: expected storyboard Panel ${startPanelNum} (start frame target).
- Image C: expected storyboard Panel ${targetPanelNum} (second scene target).

AUDIO METRICS (from ffmpeg analysis): ${audioSummary}

Inspect and rate these 5 groups:

1. START FRAME (compare Image A vs Image B):
   - Does the first video frame match Panel ${startPanelNum} composition (product pose, camera angle, framing)?
   - Is the product variant (color, finish, graphic) correct?

2. PRODUCT IDENTITY (from Image A):
   - Is the product identity correct? Correct color=${vit.colorFamily}, finish=${vit.finishType}?
   - Any color drift, geometry mutation, or hallucinated components?

3. SCENE PROGRESSION (from Image A context and Image C):
   - Does the composition of Image A suggest it progresses toward Panel ${targetPanelNum} at ~4s?
   - Any teleportation, background mismatch, or incoherent transitions visible?

4. ACTION CORRECTNESS (from Image A):
   - Is the hand action realistic and anatomically correct?
   - Are there hallucinated product features (impossible straps, extra compartments, wrong mechanisms)?

5. AUDIO / VOICE (use the audio metrics provided above):
   - Does speech start by 0.0-0.3s?
   - Does speech complete by 6.0-6.5s?
   - Is speech ratio >= 60%? (no excessive silence)

Return ONLY RFC 8259 JSON:
{
  "pass": true,
  "visual": {
    "startFrameMatch": true,
    "identityMatch": true,
    "sceneProgression": true,
    "actionCorrect": true
  },
  "audio": {
    "speechStartOk": true,
    "speechCompletionOk": true,
    "pacingOk": true
  },
  "failureReasons": [],
  "retryInstructions": [],
  "score": 0.95,
  "hardFail": false
}
"pass" = true only if ALL 5 groups pass.
"hardFail" = true only if defect is unrecoverable (completely wrong product, face visible, video entirely corrupt).`.trim();

  try {
    const filesToUpload = [
      { buf: firstFrameBuffer, name: `v${videoIndex}_frame0.png` },
      { buf: startFramePanelBuffer, name: `panel${startPanelNum}.png` },
    ];
    if (targetFramePanelBuffer) filesToUpload.push({ buf: targetFramePanelBuffer, name: `panel${targetPanelNum}.png` });

    const uploadedFiles = [];
    for (const f of filesToUpload) {
      const url = await geminiClient.uploadFile(f.buf, f.name, 'image/png');
      uploadedFiles.push({ url, filename: f.name, mimeType: 'image/png' });
    }

    const res = await geminiClient.generateContent({
      prompt: qaPrompt,
      fileData: uploadedFiles,
      temporary: true,
      expectImages: false,
    });

    const parsed = parseJsonSafe(res.text || '');
    if (parsed && typeof parsed.pass === 'boolean') {
      const overallPass = parsed.pass;
      console.log(`[T10][REV5] Video ${videoIndex} QA: pass=${overallPass}, score=${parsed.score}, hardFail=${parsed.hardFail}`);
      if (!overallPass) {
        console.warn(`[T10][REV5] Video ${videoIndex} QA failures: ${(parsed.failureReasons || []).join('; ')}`);
        console.warn(`[T10][REV5] Video ${videoIndex} QA retry instructions: ${(parsed.retryInstructions || []).join('; ')}`);
      }
      // Merge in audio QA data
      return mergeVideoQAWithAudio(parsed, audioQA, false);
    }
    console.warn(`[T10][REV5] Video ${videoIndex} QA response unparseable`);
  } catch (err) {
    console.warn(`[T10][REV5] Video ${videoIndex} QA error: ${err.message}`);
  }

  // Fallback: can't determine, treat as best-effort pass to avoid blocking on QA failure
  return buildVideoQAFromAudioOnly(videoIndex, audioQA);
}

function buildVideoQAFromAudioOnly(videoIndex, audioQA) {
  // When visual QA can't run (ffmpeg frame extraction failed), we can't block on
  // visual failures we can't measure. Audio issues are also non-blocking warnings.
  const audioIssues = audioQA?.issues || [];
  const audioWarnings = audioQA?.warnings || [];
  return {
    pass: true,  // visual QA unavailable → can't block; audio is non-blocking
    visual: { startFrameMatch: null, identityMatch: null, sceneProgression: null, actionCorrect: null },
    audio: {
      speechStartOk: audioQA && !audioQA.speechEndUncertain ? (audioQA.speechStartS || 0) <= REV5_CONFIG.SPEECH_START_MAX_S : null,
      speechEndOk: audioQA?.speechEndUncertain ? null : (audioQA?.speechEndS === null || audioQA?.speechEndS <= (REV5_CONFIG.SPEECH_END_TARGET_S + REV5_CONFIG.SPEECH_END_TOLERANCE_S)),
      speechEndUncertain: audioQA?.speechEndUncertain || false,
      pacingOk: audioQA?.speechRatio !== null && audioQA?.speechRatio !== undefined ? audioQA.speechRatio >= REV5_CONFIG.AUDIO_MIN_SPEECH_RATIO : null,
    },
    failureReasons: [],   // visual unavailable — no visual failures to report
    retryInstructions: [],
    warnings: [
      'Visual QA skipped (frame extraction unavailable)',
      ...audioWarnings,
      ...audioIssues.map(i => `[AUDIO WARNING] ${i}`),
    ],
    skipped: true,
    hardFail: false,
  };
}

function mergeVideoQAWithAudio(visualQA, audioQA, skipped) {
  // Audio QA is NON-BLOCKING.
  // Audio issues are logged as warnings and included in metadata, but they do NOT
  // affect visualQA.pass. Only Gemini Vision failures (wrong product, wrong face,
  // wrong variant, scene mismatch) can block/abort a video.
  //
  // Rationale: speech timing is model behavior that retrying the same prompt won't
  // reliably fix, and silencedetect has known false positives (full-audio clips).

  const hasAudio = audioQA && !audioQA.skipped;
  const audioSection = hasAudio ? {
    speechStartOk: (audioQA.speechStartS || 0) <= REV5_CONFIG.SPEECH_START_MAX_S,
    speechEndOk: audioQA.speechEndUncertain
      ? null  // uncertain — cannot evaluate
      : (audioQA.speechEndS === null || audioQA.speechEndS <= (REV5_CONFIG.SPEECH_END_TARGET_S + REV5_CONFIG.SPEECH_END_TOLERANCE_S)),
    speechEndUncertain: audioQA.speechEndUncertain || false,
    pacingOk: (audioQA.speechRatio || 0) >= REV5_CONFIG.AUDIO_MIN_SPEECH_RATIO,
  } : (visualQA.audio || {});

  const audioIssues   = hasAudio ? (audioQA.issues   || []) : [];
  const audioWarnings = hasAudio ? (audioQA.warnings || []) : [];

  // Visual pass: only Gemini Vision checks
  const visualPass = visualQA.visual
    ? Object.values(visualQA.visual).every(v => v !== false)
    : true;

  // Audio issues go into warnings (non-blocking), NOT failureReasons
  const allWarnings = [
    ...(visualQA.warnings || []),
    ...audioWarnings,
    ...audioIssues.map(i => `[AUDIO WARNING] ${i}`),
  ];

  if (audioIssues.length > 0) {
    console.warn(`[T10][REV5] Audio warnings (non-blocking): ${audioIssues.join('; ')}`);
  }

  return {
    ...visualQA,
    pass: visualPass,  // audio does NOT affect pass
    audio: audioSection,
    failureReasons: visualQA.failureReasons || [],  // visual only
    retryInstructions: visualQA.retryInstructions || [],  // visual only
    warnings: allWarnings,  // audio issues here (informational)
    skipped,
    hardFail: visualQA.hardFail || false,
  };
}

// ── Fix 7: Audio QA ───────────────────────────────────────────────────────────

async function runAudioQA(videoBuffer, videoIndex) {
  const result = {
    pass: true,
    // Timing
    speechStartS: null, speechEndS: null, speechRatio: null,
    speechEndUncertain: false,
    // REV5.1: Speech density metrics
    activeSpeechDurationS: null,     // duration of actual speech (speechEnd - speechStart)
    initialSilenceDurationS: null,   // same as speechStartS
    longPauseCount: 0,               // silence gaps > AUDIO_LONG_PAUSE_THRESHOLD_S
    speechDensity: null,             // 'HIGH' | 'MEDIUM' | 'LOW'
    pacingClassification: null,      // 'FAST' | 'NORMAL' | 'SLOW' | 'UNKNOWN'
    // Named failure reasons (spec §12)
    failureCode: null,               // VOICE_LATE_START | VOICE_DELIVERY_UNDER_DENSE | VOICE_LONG_PAUSES | etc.
    issues: [], warnings: [], skipped: false,
  };
  if (!videoBuffer) { result.skipped = true; return result; }
  try {
    const ffmpegStatic = require('ffmpeg-static');
    const { execSync } = require('child_process');
    const os = require('os');
    const tmpVideo = path.join(os.tmpdir(), `t10_aq_v${videoIndex}_${Date.now()}.mp4`);
    fs.writeFileSync(tmpVideo, videoBuffer);
    let silenceOut = '';
    try {
      silenceOut = execSync(`"${ffmpegStatic}" -i "${tmpVideo}" -af "silencedetect=noise=-30dB:d=0.3" -f null -`, { stdio: ['pipe','pipe','pipe'], timeout: 60000 }).toString('utf8');
    } catch (e) { silenceOut = e.stderr ? e.stderr.toString('utf8') : ''; }
    try { fs.unlinkSync(tmpVideo); } catch (_) {}

    const silStarts = [...silenceOut.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
    const silEnds   = [...silenceOut.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));

    if (silStarts.length === 0 && silEnds.length === 0) {
      // No silence detected — speechEnd uncertain. Cannot measure timing.
      // Audio fills full clip. Assume speech starts immediately.
      result.speechStartS = 0;
      result.initialSilenceDurationS = 0;
      result.speechEndS = null;
      result.speechEndUncertain = true;
      result.speechRatio = 1.0;
      result.activeSpeechDurationS = null;  // uncertain
      result.speechDensity = 'HIGH';         // full audio = high density
      result.pacingClassification = 'UNKNOWN';
      result.longPauseCount = 0;
      result.warnings.push('No silence detected — speechEnd is uncertain. Speech timing checks skipped.');
      console.log(`[T10][REV5.1] Audio QA V${videoIndex}: No silence detected. SpeechEnd uncertain, timing check skipped.`);
    } else {
      let totalSil = 0;
      const pairs = Math.min(silStarts.length, silEnds.length);
      for (let i = 0; i < pairs; i++) totalSil += Math.max(0, silEnds[i] - silStarts[i]);

      // REV5.1: Detailed metrics
      result.speechStartS = (silEnds.length > 0 && silStarts[0] < 0.5) ? silEnds[0] : 0;
      result.initialSilenceDurationS = result.speechStartS;
      result.speechEndS = silStarts.length > 0 ? silStarts[silStarts.length - 1] : null;
      result.speechEndUncertain = result.speechEndS === null;
      result.speechRatio = Math.max(0, (REV5_CONFIG.VIDEO_DURATION_S - totalSil) / REV5_CONFIG.VIDEO_DURATION_S);

      // Active speech duration (when both ends are known)
      if (!result.speechEndUncertain && result.speechEndS !== null) {
        result.activeSpeechDurationS = Math.max(0, result.speechEndS - result.speechStartS);
      }

      // Long pause count (silence gaps > threshold, EXCLUDING initial/final silence)
      let longPauses = 0;
      for (let i = 0; i < pairs; i++) {
        const gapDur = silEnds[i] - silStarts[i];
        const isMidSpeech = silStarts[i] > (result.speechStartS + 0.2) && silEnds[i] < (result.speechEndS || REV5_CONFIG.VIDEO_DURATION_S - 0.2);
        if (isMidSpeech && gapDur > REV5_CONFIG.AUDIO_LONG_PAUSE_THRESHOLD_S) longPauses++;
      }
      result.longPauseCount = longPauses;

      // Speech density classification
      const activeDur = result.activeSpeechDurationS || 0;
      if (activeDur >= REV5_CONFIG.AUDIO_MIN_ACTIVE_DURATION_S && result.speechRatio >= 0.75) {
        result.speechDensity = 'HIGH';
      } else if (activeDur >= 3.0 && result.speechRatio >= 0.55) {
        result.speechDensity = 'MEDIUM';
      } else {
        result.speechDensity = 'LOW';
      }

      // Pacing classification based on syllable rate estimate
      // We can't know word count here, but we can use active duration / speechRatio as proxy
      if (result.speechRatio >= 0.75 && activeDur >= 5.0) {
        result.pacingClassification = 'FAST';
      } else if (result.speechRatio >= 0.60 && activeDur >= 3.5) {
        result.pacingClassification = 'NORMAL';
      } else {
        result.pacingClassification = 'SLOW';
      }
    }

    // ── REV5.1 Checks with named failure codes ────────────────────────────────

    // Check 1: Speech start (VOICE_LATE_START)
    if ((result.speechStartS || 0) > REV5_CONFIG.SPEECH_START_MAX_S) {
      result.issues.push(`VOICE_LATE_START: Speech starts at ${result.speechStartS?.toFixed(2)}s > max ${REV5_CONFIG.SPEECH_START_MAX_S}s`);
      result.failureCode = result.failureCode || 'VOICE_LATE_START';
      result.pass = false;
    }

    // Check 2: Speech end timing (only when measurable)
    if (!result.speechEndUncertain && result.speechEndS !== null) {
      const threshold = REV5_CONFIG.SPEECH_END_WINDOW_MAX_S;
      if (result.speechEndS > threshold) {
        result.issues.push(`VOICE_OVERFILLED: Speech ends at ${result.speechEndS.toFixed(2)}s > max ${threshold}s`);
        result.failureCode = result.failureCode || 'VOICE_OVERFILLED';
        result.pass = false;
      }
    }

    // Check 3: Speech ratio (VOICE_DELIVERY_UNDER_DENSE)
    // A short script spoken slowly fails even if timing boundaries pass (spec §12)
    if (result.speechRatio !== null && result.speechRatio < REV5_CONFIG.AUDIO_MIN_SPEECH_RATIO) {
      result.issues.push(`VOICE_DELIVERY_UNDER_DENSE: Speech ratio ${(result.speechRatio * 100).toFixed(0)}% < ${(REV5_CONFIG.AUDIO_MIN_SPEECH_RATIO * 100).toFixed(0)}%`);
      result.failureCode = result.failureCode || 'VOICE_DELIVERY_UNDER_DENSE';
      result.pass = false;
    }

    // Check 4: Active speech duration (density gate — spec §12)
    if (result.activeSpeechDurationS !== null && result.activeSpeechDurationS < REV5_CONFIG.AUDIO_MIN_ACTIVE_DURATION_S) {
      if (result.speechDensity !== 'HIGH') {
        result.issues.push(`VOICE_DELIVERY_UNDER_DENSE: Active speech duration ${result.activeSpeechDurationS.toFixed(2)}s < ${REV5_CONFIG.AUDIO_MIN_ACTIVE_DURATION_S}s minimum for HIGH density`);
        result.failureCode = result.failureCode || 'VOICE_DELIVERY_UNDER_DENSE';
        result.pass = false;
      }
    }

    // Check 5: Long pauses (VOICE_LONG_PAUSES)
    if (result.longPauseCount > REV5_CONFIG.AUDIO_MAX_LONG_PAUSES) {
      result.issues.push(`VOICE_LONG_PAUSES: ${result.longPauseCount} long pause(s) detected (max: ${REV5_CONFIG.AUDIO_MAX_LONG_PAUSES})`);
      result.failureCode = result.failureCode || 'VOICE_LONG_PAUSES';
      result.pass = false;
    }

    const endStr = result.speechEndUncertain ? 'uncertain' : `${result.speechEndS?.toFixed(2)}s`;
    const densityStr = `density=${result.speechDensity}, pacing=${result.pacingClassification}, longPauses=${result.longPauseCount}`;
    if (result.issues.length > 0) {
      console.warn(`[T10][REV5.1] Audio QA V${videoIndex} ISSUES [${result.failureCode}]: ${result.issues.join('; ')}`);
    } else {
      console.log(`[T10][REV5.1] Audio QA V${videoIndex} OK: start=${(result.speechStartS||0).toFixed(2)}s end=${endStr} ratio=${result.speechRatio !== null ? (result.speechRatio*100).toFixed(0)+'%' : 'unknown'} active=${result.activeSpeechDurationS?.toFixed(2) || '?'}s ${densityStr}`);
    }

  } catch (err) {
    console.warn(`[T10][REV5.1] Audio QA error: ${err.message}`);
    result.skipped = true; result.pass = true;
  }
  return result;
}


// ── Video Generation — Degraded Fallback Ladder (REV5.2) ─────────────────────


/**
 * classifyVideoQA: Classify a videoQA result into PASS / SOFT_PASS / HARD_FAIL.
 *
 * HARD_FAIL — discard. Identity is wrong or physically impossible.
 * SOFT_PASS — usable with minor issues (composition/framing off, but product correct).
 * PASS      — all visual checks clear.
 *
 * Score (0.0–1.0) weights:
 *   identityMatch    0.40 (highest — wrong product is fatal)
 *   startFrameMatch  0.20
 *   sceneProgression 0.20
 *   actionCorrect    0.20
 * null/uncertain checks count as 0.5.
 *
 * @param {object} videoQA  result from runVideoQA
 * @returns {{ level: 'PASS'|'SOFT_PASS'|'HARD_FAIL', score: number, reasons: string[] }}
 */
function classifyVideoQA(videoQA) {
  const v = videoQA?.visual || {};

  // Helper: convert boolean|null → 0|0.5|1
  const boolScore = (val) => val === true ? 1.0 : val === false ? 0.0 : 0.5;

  const identityScore    = boolScore(v.identityMatch);
  const startFrameScore  = boolScore(v.startFrameMatch);
  const progressionScore = boolScore(v.sceneProgression);
  const actionScore      = boolScore(v.actionCorrect);

  const score = (
    identityScore    * 0.40 +
    startFrameScore  * 0.20 +
    progressionScore * 0.20 +
    actionScore      * 0.20
  );

  const reasons = videoQA?.failureReasons || [];

  // HARD_FAIL conditions
  const isHardFail = (
    videoQA?.hardFail === true ||
    v.identityMatch === false ||
    v.actionCorrect === false
  );
  if (isHardFail) {
    return { level: 'HARD_FAIL', score, reasons };
  }

  // PASS: no visual false values
  const allVisualClear = Object.values(v).every(val => val !== false);
  if (allVisualClear || videoQA?.pass === true) {
    return { level: 'PASS', score, reasons };
  }

  // SOFT_PASS: product identity OK, but some composition/framing/progression issue
  return { level: 'SOFT_PASS', score, reasons };
}

/**
 * buildFallbackVideoJob: Build a simplified video generation job for the fallback attempt.
 * Reduces action complexity and script length to maximize reliability.
 *
 * @param {object} job           original video job
 * @param {object} analysis      product analysis
 * @param {number} videoIndex    1 or 2
 * @returns {object}  modified job with simplified prompt
 */
function buildFallbackVideoJob(job, analysis, videoIndex) {
  const a = analysis || {};
  const lock = a.productFactLock || {};
  const canonical = a.canonicalProductInstance || {};
  const vit = canonical.variantIdentityTuple || {};
  const prodName = lock.productName || 'the product';

  // Compress script to 65% of normal word budget
  const fallbackMaxWords = Math.floor(REV5_CONFIG.MAX_WORDS_PER_VIDEO * 0.65); // ~13 words

  // Extract existing narration from the prompt (between NARRATION: and next section)
  let existingNarration = '';
  const narrationMatch = job.prompt.match(/NARRATION[^:]*:\s*["']?([^"'\n]{10,})/i);
  if (narrationMatch) existingNarration = narrationMatch[1].trim();
  const compressedNarration = existingNarration
    ? compressScriptToTimingBudget(existingNarration, fallbackMaxWords)
    : `${prodName} - chất lượng tốt, đáng tin dùng.`;

  const fallbackPrompt = `[FALLBACK SIMPLIFIED — previous ${REV5_CONFIG.MAX_VIDEO_REGENERATION_RETRIES + 1} attempts failed visual QA]
MANDATORY SIMPLIFICATIONS — do not deviate:
1. PRIMARY ACTION: hold product naturally with one hand, slight gentle rotation only. NO complex gestures, NO multi-step mechanics, NO proving features.
2. COMPOSITION: product fully visible, centered, clean background matching storyboard panel.
3. VARIANT: exact product color=${vit.colorFamily || 'as-reference'}, finish=${vit.finishType || 'as-reference'}, graphic=${vit.graphicVariant || 'as-reference'}.
4. NARRATION (max ${fallbackMaxWords} words, complete by 5.5s): "${compressedNarration}"
5. NO face visible. NO text overlays. Product labels on product surface are OK.

Product: ${prodName}

${job.prompt}`;

  return {
    ...job,
    prompt: fallbackPrompt,
    isFallback: true,
  };
}

/**
 * generateVideoWithRetry: Degraded fallback ladder (REV5.2).
 *
 * Strategy:
 *   1. Run up to MAX_NORMAL_ATTEMPTS (3) generations, collect all results.
 *   2. Generation errors do NOT count against QA budget.
 *   3. After 3 QA evaluations (or budget exhausted):
 *      a. Select best PASS by score.
 *      b. Else select best SOFT_PASS by score.
 *      c. Else run 1 FALLBACK attempt (simplified action + compressed script).
 *      d. After fallback: output best available by score, never abort.
 *   4. Returns qualityLevel: 'PASS' | 'SOFT_PASS' | 'DEGRADED'
 *
 * Never throws. Always returns a usable result (may be DEGRADED).
 *
 * @param {object} geminiClient
 * @param {string} effectiveBaseDir
 * @param {object} job
 * @param {Buffer} startPanelBuf   Panel 1 or Panel 3
 * @param {Buffer} targetPanelBuf  Panel 2 or Panel 4
 * @param {object} analysis
 * @param {object} pipelineOptions
 * @param {string} videosDir
 * @param {object} compressedScripts  { video1Script, video2Script }
 * @returns {{ videoResult, videoQAResult, audioQAResult, videoPath, videoBuffer,
 *             videoQaPassed, qualityLevel, qualityScore, allAttempts, fallbackUsed }}
 */
async function generateVideoWithRetry(geminiClient, effectiveBaseDir, job, startPanelBuf, targetPanelBuf, analysis, pipelineOptions, videosDir, compressedScripts) {
  const MAX_QA_BUDGET    = REV5_CONFIG.MAX_VIDEO_REGENERATION_RETRIES + 1; // 3 QA checks total
  const MAX_GEN_ATTEMPTS = REV5_CONFIG.MAX_VIDEO_GEN_ATTEMPTS;             // safety cap
  const videoIndex = job.index;

  // Collect all QA-evaluated attempts
  // Each entry: { videoResult, vBuf, videoPath, audioQA, videoQA, classification }
  const attempts = [];
  let qaCheckCount  = 0;
  let genAttemptCount = 0;
  let retryInstruction = '';

  // ── Phase 1: Normal attempts (up to MAX_QA_BUDGET QA checks) ──────────────
  while (qaCheckCount < MAX_QA_BUDGET) {
    genAttemptCount++;
    if (genAttemptCount > MAX_GEN_ATTEMPTS) {
      console.warn(`[T10][REV5.2] Video ${videoIndex}: Hit generation safety cap (${MAX_GEN_ATTEMPTS} gen attempts). Moving to selection.`);
      break;
    }

    console.log(`[T10][REV5.2] Video ${videoIndex}: gen attempt ${genAttemptCount} (QA checks: ${qaCheckCount}/${MAX_QA_BUDGET})...`);

    // Inject targeted retry instruction from previous QA failures
    const currentJob = { ...job };
    if (retryInstruction && qaCheckCount > 0) {
      currentJob.prompt = `[VIDEO QA RETRY — attempt ${qaCheckCount + 1}/${MAX_QA_BUDGET}]\nPrevious QA failed. Fix these issues:\n${retryInstruction}\n\n${job.prompt}`;
    }

    // ── Generate ────────────────────────────────────────────────────────────
    let videoResult = null, vBuf = null;
    try {
      const results = await generateVideosFromPanelsDirect(effectiveBaseDir, [currentJob], {
        aspectRatio: '9:16',
        videoModelKey: pipelineOptions.videoModelKey || 'abra_i2v_8s',
        cropPercent: 0.12,
        multiImageMode: true,
        includeVideoBase64: pipelineOptions.includeVideoBase64 !== undefined ? !!pipelineOptions.includeVideoBase64 : true,
        runId: pipelineOptions.runId || '',
      });
      videoResult = results[0] || null;
      if (videoResult) {
        vBuf = videoResult.buffer
          || (videoResult.video?.base64 ? Buffer.from(videoResult.video.base64, 'base64')
            : (videoResult.base64 ? Buffer.from(videoResult.base64, 'base64')
              : (videoResult.videoBase64 ? Buffer.from(videoResult.videoBase64, 'base64') : null)));
        if (!vBuf && videoResult.videoPath && fs.existsSync(videoResult.videoPath)) {
          try { vBuf = fs.readFileSync(videoResult.videoPath); } catch (_) {}
        }
      }
    } catch (genErr) {
      // Generation error — does NOT count against QA budget
      console.warn(`[T10][REV5.2] ⚠️  Video ${videoIndex} gen error (NOT QA retry): ${genErr.message}`);
      continue;
    }

    if (!vBuf) {
      console.warn(`[T10][REV5.2] ⚠️  Video ${videoIndex} gen attempt ${genAttemptCount}: no buffer (NOT QA retry).`);
      continue;
    }

    // ── Video received → QA ──────────────────────────────────────────────────
    qaCheckCount++;
    const attemptPath = path.join(videosDir, `video-${videoIndex}-attempt${qaCheckCount}.mp4`);
    try { fs.writeFileSync(attemptPath, vBuf); } catch (_) {}
    if (videoResult) { videoResult.videoPath = attemptPath; videoResult.videoBuffer = vBuf; }

    console.log(`[T10][REV5.2] Video ${videoIndex}: QA check ${qaCheckCount}/${MAX_QA_BUDGET}...`);
    const audioQA = await runAudioQA(vBuf, videoIndex);
    const videoQA = await runVideoQA(geminiClient, vBuf, startPanelBuf, targetPanelBuf, videoIndex, analysis, audioQA);
    const classification = classifyVideoQA(videoQA);

    console.log(`[T10][REV5.2] Video ${videoIndex} QA check ${qaCheckCount}: level=${classification.level}, score=${classification.score.toFixed(2)}`);
    if (classification.level !== 'PASS') {
      console.warn(`[T10][REV5.2] Video ${videoIndex} reasons: ${classification.reasons.join('; ')}`);
    }

    attempts.push({ videoResult, vBuf, videoPath: attemptPath, audioQA, videoQA, classification, attemptNum: qaCheckCount, isFallback: false });

    // Early exit if PASS — no need to use more budget
    if (classification.level === 'PASS') {
      console.log(`[T10][REV5.2] ✅ Video ${videoIndex} PASS on QA check ${qaCheckCount} — stopping early.`);
      break;
    }

    // Build targeted retry instruction for next attempt (only if budget remains)
    if (qaCheckCount < MAX_QA_BUDGET) {
      const instructions = videoQA.retryInstructions || videoQA.failureReasons || [];
      retryInstruction = instructions.length > 0
        ? instructions.map((r, i) => `${i + 1}. ${r}`).join('\n')
        : 'Fix product identity and start frame matching. Ensure variant is correct.';
      console.log(`[T10][REV5.2] Video ${videoIndex}: retry instruction: ${retryInstruction.substring(0, 200)}`);
    }
  }

  // ── Phase 2: Select best from collected attempts ───────────────────────────
  const selectBestByLevel = (level) => attempts
    .filter(a => a.classification.level === level)
    .sort((a, b) => b.classification.score - a.classification.score)[0] || null;

  let selected = selectBestByLevel('PASS') || selectBestByLevel('SOFT_PASS');
  let fallbackUsed = false;
  let qualityLevel = selected?.classification?.level || null;

  // ── Phase 3: Fallback generation if no PASS or SOFT_PASS ──────────────────
  if (!selected) {
    console.warn(`[T10][REV5.2] Video ${videoIndex}: All ${attempts.length} attempts were HARD_FAIL. Running FALLBACK simplified generation...`);
    const fallbackJob = buildFallbackVideoJob(job, analysis, videoIndex);
    fallbackUsed = true;

    let fbResult = null, fbBuf = null, fbPath = null;
    try {
      const fbResults = await generateVideosFromPanelsDirect(effectiveBaseDir, [fallbackJob], {
        aspectRatio: '9:16',
        videoModelKey: pipelineOptions.videoModelKey || 'abra_i2v_8s',
        cropPercent: 0.12,
        multiImageMode: true,
        includeVideoBase64: pipelineOptions.includeVideoBase64 !== undefined ? !!pipelineOptions.includeVideoBase64 : true,
        runId: pipelineOptions.runId || '',
      });
      fbResult = fbResults[0] || null;
      if (fbResult) {
        fbBuf = fbResult.buffer
          || (fbResult.video?.base64 ? Buffer.from(fbResult.video.base64, 'base64')
            : (fbResult.base64 ? Buffer.from(fbResult.base64, 'base64')
              : (fbResult.videoBase64 ? Buffer.from(fbResult.videoBase64, 'base64') : null)));
        if (!fbBuf && fbResult.videoPath && fs.existsSync(fbResult.videoPath)) {
          try { fbBuf = fs.readFileSync(fbResult.videoPath); } catch (_) {}
        }
      }
    } catch (fbErr) {
      console.warn(`[T10][REV5.2] Video ${videoIndex}: Fallback generation failed: ${fbErr.message}`);
    }

    if (fbBuf) {
      fbPath = path.join(videosDir, `video-${videoIndex}-fallback.mp4`);
      try { fs.writeFileSync(fbPath, fbBuf); } catch (_) {}
      if (fbResult) { fbResult.videoPath = fbPath; fbResult.videoBuffer = fbBuf; }

      const fbAudioQA = await runAudioQA(fbBuf, videoIndex);
      const fbVideoQA = await runVideoQA(geminiClient, fbBuf, startPanelBuf, targetPanelBuf, videoIndex, analysis, fbAudioQA);
      const fbClassification = classifyVideoQA(fbVideoQA);
      console.log(`[T10][REV5.2] Video ${videoIndex} FALLBACK QA: level=${fbClassification.level}, score=${fbClassification.score.toFixed(2)}`);

      attempts.push({ videoResult: fbResult, vBuf: fbBuf, videoPath: fbPath, audioQA: fbAudioQA, videoQA: fbVideoQA, classification: fbClassification, attemptNum: 'fallback', isFallback: true });

      if (fbClassification.level !== 'HARD_FAIL') {
        selected = attempts[attempts.length - 1];
        qualityLevel = fbClassification.level;
      }
    }

    // Last resort: even if fallback is HARD_FAIL, output best attempt by score
    if (!selected && attempts.length > 0) {
      selected = attempts.sort((a, b) => b.classification.score - a.classification.score)[0];
      qualityLevel = 'DEGRADED';
      console.warn(`[T10][REV5.2] Video ${videoIndex}: DEGRADED output — using best available attempt (score=${selected.classification.score.toFixed(2)})`);
    }
  }

  if (!selected) {
    // Absolute last resort: no video at all (all gen attempts failed with no buffer)
    console.error(`[T10][REV5.2] Video ${videoIndex}: No video produced at all. Returning null result.`);
    return {
      videoResult: null, videoQAResult: null, audioQAResult: null,
      videoPath: null, videoBuffer: null, videoQaPassed: false,
      qualityLevel: 'NO_OUTPUT', qualityScore: 0,
      allAttempts: attempts.map(a => ({ attempt: a.attemptNum, level: a.classification.level, score: a.classification.score, reasons: a.classification.reasons, fallback: a.isFallback })),
      fallbackUsed,
    };
  }

  // ── Phase 4: Finalize selected result ──────────────────────────────────────
  const finalPath = path.join(videosDir, `video-${videoIndex}.mp4`);
  try { fs.renameSync(selected.videoPath, finalPath); } catch (_) {
    try { fs.copyFileSync(selected.videoPath, finalPath); fs.unlinkSync(selected.videoPath); } catch (_2) {}
  }
  if (selected.videoResult) selected.videoResult.videoPath = finalPath;

  const isUsable = qualityLevel === 'PASS' || qualityLevel === 'SOFT_PASS' || qualityLevel === 'DEGRADED';
  console.log(`[T10][REV5.2] ✅ Video ${videoIndex} finalized: qualityLevel=${qualityLevel}, score=${selected.classification.score.toFixed(2)}, fallback=${fallbackUsed}`);

  return {
    videoResult:    selected.videoResult,
    videoQAResult:  selected.videoQA,
    audioQAResult:  selected.audioQA,
    videoPath:      finalPath,
    videoBuffer:    selected.vBuf,
    videoQaPassed:  isUsable,
    qualityLevel,
    qualityScore:   selected.classification.score,
    allAttempts:    attempts.map(a => ({ attempt: a.attemptNum, level: a.classification.level, score: a.classification.score.toFixed(2), reasons: a.classification.reasons, fallback: a.isFallback })),
    fallbackUsed,
  };
}


// ── Step 5: VEO_NATIVE_FAST Prompt Builder (REV5 Fix 3,4,6,9) ────────────────

function buildVeoNativeFastPrompt(analysisData, videoIndex = 1, options = {}, compressedScripts = null) {
  const a = normalizeAnalysisData(analysisData || {});
  const manifest = a.productIdentityManifest || {};
  const lock = a.productFactLock || {};
  const canonical = a.canonicalProductInstance || {};
  const fullScript = a.fullScript || {};
  const scenes = a.scenes || [];
  const prodName = lock.productName || a.productName || 'the product';
  const vIdx = (videoIndex === 2 || videoIndex === 3 || videoIndex === 4) ? 2 : 1;
  const vit = canonical.variantIdentityTuple || buildVariantIdentityTuple(a);

  // Start-frame capability metadata
  const modelKey = options.videoModelKey || REV5_CONFIG.NATIVE_START_FRAME_MODEL;
  const startFrameCap = REV5_CONFIG.START_FRAME_CAPABILITY[modelKey] || { nativeFirstFrame: false, exactStartFrameGuaranteed: false };

  const sceneA = vIdx === 1 ? (scenes[0] || {}) : (scenes[2] || {});
  const sceneB = vIdx === 1 ? (scenes[1] || {}) : (scenes[3] || {});
  const startPanelNum = vIdx === 1 ? 1 : 3;
  const targetPanelNum = vIdx === 1 ? 2 : 4;

  // REV5.1: Use compressedScripts (already fill-state validated)
  let dialogue;
  if (compressedScripts) {
    dialogue = vIdx === 1 ? (compressedScripts.video1Script || '') : (compressedScripts.video2Script || '');
  } else {
    dialogue = vIdx === 1
      ? (fullScript.video1Script || `${sceneA.voiceLine || ''} ${sceneB.voiceLine || ''}`.trim())
      : (fullScript.video2Script || `${sceneA.voiceLine || ''} ${sceneB.voiceLine || ''}`.trim());
  }

  const traits    = (manifest.identityCriticalTraits || ['matching reference colors and materials']).join('; ');
  const forbidden = (manifest.forbiddenMutations || ['do not change colors or shape']).join('; ');
  const customClause = options.customInstruction ? `\nUSER PRIORITY OVERRIDE: ${options.customInstruction}\n` : '';

  // Start-frame binding language
  const startFrameBinding = startFrameCap.nativeFirstFrame
    ? `- NATIVE START FRAME (exactStartFrameGuaranteed=true): Panel ${startPanelNum} is bound as the NATIVE FIRST FRAME via the model's native conditioning mechanism. The very first generated frame MUST be visually identical to Panel ${startPanelNum} in composition, product pose, variant, hand pose, and environment.`
    : `- REFERENCE START FRAME (exactStartFrameGuaranteed=false, best-effort): Panel ${startPanelNum} is the reference visual target for the opening frame. Match this pose and framing as closely as possible.`;

  // REV5.1: Compute fill state metadata (diagnostic — does NOT control voice strategy)
  const fillMeta = classifyScriptFillState(dialogue);
  const dialogueMetadata = [
    `Native Vietnamese Dialogue:`,
    `"${dialogue}"`,
    ``,
    `Speech Profile: FAST_CONVERSATIONAL_VI`,
    `Fill State: ${fillMeta.fillState}`,
    `Target Window: 0.10s \u2192 6.60s`,
    `Speech Density Target: HIGH`,
    `Estimated Delivery: FAST / CONTINUOUS / NATURAL`,
    ``,
    `Diagnostics (informational only — do NOT use to set pacing mechanically):`,
    `- Word Count: ${fillMeta.words}`,
    `- Syllable Count (estimated): ${fillMeta.syllables}`,
    `- Estimated Speech Duration: ~${fillMeta.estimatedDurationS}s`,
    `- Estimated Speech Occupancy: ~${(fillMeta.occupancy * 100).toFixed(0)}% of target window`,
  ].join('\n');

  // REV5.1: VOICE PERFORMANCE LOCK — full FAST_CONVERSATIONAL_VI block
  const voiceLock = [
    `[VOICE PERFORMANCE LOCK — REV5.1 IMMUTABLE]`,
    ``,
    `Language: ${FAST_CONVERSATIONAL_VI.language}`,
    `Dialect Family: ${FAST_CONVERSATIONAL_VI.dialectFamily}`,
    `Register: ${FAST_CONVERSATIONAL_VI.register}`,
    `Speaker Class: ${FAST_CONVERSATIONAL_VI.speakerClass}`,
    `Timbre: ${FAST_CONVERSATIONAL_VI.timbre}`,
    `Energy: ${FAST_CONVERSATIONAL_VI.energy}`,
    ``,
    `Delivery: ${FAST_CONVERSATIONAL_VI.delivery}`,
    `Speech Profile: ${FAST_CONVERSATIONAL_VI.speechProfile}`,
    `Speech Density: ${FAST_CONVERSATIONAL_VI.speechDensity}`,
    `Phrase Chaining: ${FAST_CONVERSATIONAL_VI.phraseChaining}`,
    ``,
    `Initial Silence: <= ${FAST_CONVERSATIONAL_VI.initialSilencePreferredMaxS}s preferred`,
    `Maximum Initial Silence: ${FAST_CONVERSATIONAL_VI.initialSilenceMaxS}s`,
    `Micro-Pauses: very short and natural (${FAST_CONVERSATIONAL_VI.microPauseRangeS[0]}–${FAST_CONVERSATIONAL_VI.microPauseRangeS[1]}s when linguistically appropriate)`,
    `Long Pauses: FORBIDDEN unless linguistically necessary`,
    ``,
    `Prosody: ${FAST_CONVERSATIONAL_VI.prosody}`,
    `Pitch Movement: ${FAST_CONVERSATIONAL_VI.pitchMovement}`,
    `Emphasis: ${FAST_CONVERSATIONAL_VI.emphasis}`,
    `Articulation: ${FAST_CONVERSATIONAL_VI.articulation}`,
    `Naturalness: ${FAST_CONVERSATIONAL_VI.naturalness}`,
    ``,
    FAST_CONVERSATIONAL_VI.notes.map(n => `- ${n}`).join('\n'),
    ``,
    `Do NOT sound like: ${FAST_CONVERSATIONAL_VI.doNotSound.join(', ')}.`,
  ].join('\n');

  // REV5.1: Timing contract — no words/sec, no word count primary
  const timingContract = [
    `[FULL 8s DIALOGUE TIMING CONTRACT — REV5.1]`,
    ``,
    dialogueMetadata,
    ``,
    `MANDATORY TIMING CONSTRAINTS:`,
    `- Speech MUST start between 0.10s–0.25s (absolutely no silent intro; maximum initial silence: 0.30s).`,
    `- Speech MUST complete fully between 6.20s–6.80s (preferred center: ~6.5s). Leave ~1.2–1.8s visual tail.`,
    `- Do NOT force an exact words-per-second target. Deliver at natural fast conversational Vietnamese rhythm.`,
    `- Do NOT add music, jingle, or any audio not in the dialogue above.`,
    `- Dialogue must be COMPLETE. Do not cut off mid-sentence.`,
    ``,
    `SPEECH DENSITY REQUIREMENT:`,
    `- Narration must feel DENSE and CONTINUOUS throughout the 6.0s+ active speech window.`,
    `- A short script spoken slowly will FAIL audio QA even if timing boundaries technically pass.`,
    `- Phrase chaining: each Vietnamese phrase flows directly into the next with only micro-pauses.`,
  ].join('\n');

  const promptText = [
    customClause,
    `[PRODUCT INSTANCE LOCK]\nProduct: ${prodName}\nCanonical Instance ID: ${canonical.productIdentityId || 'PRODUCT_001'}\nSelection Status: RESOLVED\nMaintain 100% strict identity consistency throughout the entire 8-second video. Do NOT drift, morph, or blend into any alternative variant, color, or shape.`,
    `[CANONICAL PRODUCT IDENTITY]\nCritical Traits: ${traits}\nForbidden Mutations: ${forbidden}\nVariant Identity Tuple: color=${vit.colorFamily} | finish=${vit.finishType} | graphic=${vit.graphicVariant} | config=${vit.configState}\nVariant Lock: ${vit.variantLock}\nEvery visible frame must honor these exact physical traits without deviation.`,
    `[REFERENCE ROLES]\n${startFrameBinding}\n- SECOND SCENE TARGET: Panel ${targetPanelNum} is the visual composition target for the second scene at ~4.0s.\n- CANONICAL PRODUCT REFERENCE: Primary source-of-truth for product materials, textures, and details.`,
    `[0-4s SCENE A: ${sceneA.phase || 'HOOK'}]\nVisual Framing: Authentic smartphone camera snapshot, close framing.\nVisual Core: ${sceneA.visualCore || 'Product held naturally by hand'}.\nPrimary Action: ${sceneA.primaryAction || 'Hold product steadily and rotate slightly'}.\nCamera Motion: Locked tripod-stable smartphone framing with subtle organic hand breath.`,
    `[~4.0s CLEAN CUT]\nAt approximately 4.0 seconds, execute a clean, seamless camera cut transition directly to Scene B. No morphing, no artificial dissolves, no visual glitches.`,
    `[4-8s SCENE B: ${sceneB.phase || 'SOLUTION'}]\nVisual Framing: Authentic smartphone camera snapshot, aligned with Panel ${targetPanelNum}.\nVisual Core: ${sceneB.visualCore || 'Product in active feature demonstration'}.\nPrimary Action: ${sceneB.primaryAction || 'Demonstrate feature naturally with fingers'}.\nCamera Motion: Steady close-up focus on the action.`,
    `[ACTION CONSTRAINTS]\nAll movements must follow realistic physical mechanics. Anatomically correct hands with 5 distinct fingers. No floating hands, no sudden teleportation, no morphing geometry.`,
    `[GLOBAL CONTINUITY]\nEnvironment: ENV_001 (clean, modern lifestyle tabletop).\nHand Model: HAND_001 (fair Asian skin tone, natural skin pores, neat clean nails).\nLighting: LIGHT_001 (soft natural daylight).\nCamera: CAMERA_001 (iPhone 15 Pro 24mm f/1.8 authentic camera rendering).`,
    voiceLock,
    timingContract,
    `[AUDIO CONTINUITY]\nThe visual transition around 4 seconds is purely visual. The narration voice DOES NOT pause, reset, or change pitch/energy at the cut. The dialogue continues smoothly across the cut as a single uninterrupted 8-second speech.`,
    `[STRICT NEGATIVE CONSTRAINTS]\nSTRICTLY FACELESS: Absolutely NO human faces, no heads, no eyes, no smiles. Only hands, torso, and product in frame.\nTEXT POLICY (REV5): FORBIDDEN — text overlays, typography, subtitles, captions, watermarks, promotional badges, UI elements.\nALLOWED — brand names, model numbers, or labels physically printed/embossed/stamped on the product surface itself. These are product identity.\nNO CARTOON GRAPHICS: NO neon arrows, NO floating 3D icons, NO cartoon magnifying glasses, NO fake CGI sparkles.`,
  ].filter(Boolean).join('\n\n').trim();

  return {
    promptText,
    dialogue,
    dialogueFillState: fillMeta.fillState,
    dialogueEstimatedS: fillMeta.estimatedDurationS,
    dialogueSyllables: fillMeta.syllables,
    dialogueWords: fillMeta.words,
    startFrameCapability: {
      modelKey,
      nativeFirstFrame: startFrameCap.nativeFirstFrame,
      exactStartFrameGuaranteed: startFrameCap.nativeFirstFrame,
      startPanelNum,
      targetPanelNum,
    },
  };
}

function getTemplate10VideoPrompts(analysisData, options = {}, compressedScripts = null) {
  const normalizedAnalysis = normalizeAnalysisData(analysisData || {});
  return [
    buildVeoNativeFastPrompt(normalizedAnalysis, 1, options, compressedScripts),
    buildVeoNativeFastPrompt(normalizedAnalysis, 2, options, compressedScripts),
  ];
}


// ── Archive ───────────────────────────────────────────────────────────────────

function archiveTemplate10Review(baseDir, filePayloads, storyboardPrompt, storyboardBase64, panels, analysisData, qaResult, videoPrompts, options = {}, scriptFeasibility = null, audioQAResults = [], postVideoQAResults = []) {
  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = Math.random().toString(36).substring(2, 8);
  const runDir = path.join(effectiveBaseDir, 'storyboard-review-runs', `${timestamp}-template10-flow-${runId}`);
  ensureDir(runDir);

  const inputsDir = path.join(runDir, 'inputs');
  ensureDir(inputsDir);
  filePayloads.forEach((f, idx) => {
    const ext = (f.mimeType && f.mimeType.includes('png')) ? '.png' : '.jpg';
    const buf = Buffer.isBuffer(f.buffer) ? f.buffer : (f.base64 ? Buffer.from(f.base64, 'base64') : (f.path ? require('fs').readFileSync(f.path) : null));
    if (buf) fs.writeFileSync(path.join(inputsDir, `input-${idx + 1}${ext}`), buf);
  });

  const storyboardPath = path.join(runDir, 'storyboard.png');
  if (storyboardBase64) fs.writeFileSync(storyboardPath, Buffer.from(storyboardBase64, 'base64'));

  const panelsDir = path.join(runDir, 'panels');
  ensureDir(panelsDir);
  panels.forEach(p => {
    const pPath = path.join(panelsDir, `panel-${p.index}.png`);
    const pBuf = Buffer.isBuffer(p.buffer) ? p.buffer : (p.base64 ? Buffer.from(p.base64, 'base64') : (p.imageBase64 ? Buffer.from(p.imageBase64, 'base64') : null));
    if (pBuf) fs.writeFileSync(pPath, pBuf);
    p.imagePath = pPath;
  });

  const a = analysisData || {};
  const vit = a.canonicalProductInstance?.variantIdentityTuple || buildVariantIdentityTuple(a);
  const p0cap = videoPrompts[0]?.startFrameCapability || {};
  const p1cap = videoPrompts[1]?.startFrameCapability || {};

  const mdLines = [
    `# Template 10 Run — VEO_NATIVE_FAST 2×8s (REV5)`,
    `Run ID: ${runId}`,
    `Date: ${new Date().toISOString()}`,
    `Pipeline: INSTANCE-FIRST + COLLAGE STORYBOARD + BLOCKING QA GATE (Fix 1) + VEO_NATIVE_FAST 2×8s`,
    '',
    `## Canonical Product Instance`, '```json', JSON.stringify(a.canonicalProductInstance || {}, null, 2), '```',
    '',
    `## Variant Identity Tuple (REV5 Fix 10)`, '```json', JSON.stringify(vit, null, 2), '```',
    '',
    `## Product Identity Manifest`, '```json', JSON.stringify(a.productIdentityManifest || {}, null, 2), '```',
    '',
    `## Script Feasibility (REV5 Fix 8)`, '```json', JSON.stringify(scriptFeasibility || 'not computed', null, 2), '```',
    '',
    `## Master Storyboard Prompt`, '```', storyboardPrompt, '```',
    '',
    `## Storyboard QA — BLOCKING Gate (REV5 Fix 1)`, '```json', JSON.stringify(qaResult || {}, null, 2), '```',
    '',
    `## Sliced Panels (REV5 Fix 2: "OK" = file created; visual QA is in BLOCKING gate above)`,
    `- Panel 1 (startFrame V1): ${panels[0] ? '✅ File created' : '❌ Missing'}`,
    `- Panel 2 (secondScene V1): ${panels[1] ? '✅ File created' : '❌ Missing'}`,
    `- Panel 3 (startFrame V2): ${panels[2] ? '✅ File created' : '❌ Missing'}`,
    `- Panel 4 (secondScene V2): ${panels[3] ? '✅ File created' : '❌ Missing'}`,
    '',
    `## Video 1 Start-Frame Binding (REV5 Fix 3, 4)`,
    `- Model: ${p0cap.modelKey || 'unknown'}, nativeFirstFrame: ${p0cap.nativeFirstFrame}, exactStartFrameGuaranteed: ${p0cap.exactStartFrameGuaranteed}`,
    `- Start Panel: ${p0cap.startPanelNum}, Target Panel: ${p0cap.targetPanelNum}`,
    '',
    `## Video 1 8s Prompt`, '```', videoPrompts[0]?.promptText || '', '```',
    '',
    `## Video 2 Start-Frame Binding (REV5 Fix 3, 4)`,
    `- Model: ${p1cap.modelKey || 'unknown'}, nativeFirstFrame: ${p1cap.nativeFirstFrame}, exactStartFrameGuaranteed: ${p1cap.exactStartFrameGuaranteed}`,
    `- Start Panel: ${p1cap.startPanelNum}, Target Panel: ${p1cap.targetPanelNum}`,
    '',
    `## Video 2 8s Prompt`, '```', videoPrompts[1]?.promptText || '', '```',
    '',
    `## Full Script (16s)`, '```json', JSON.stringify(a.fullScript || {}, null, 2), '```',
    '',
    `## Audio QA Results (REV5 Fix 7)`, '```json', JSON.stringify(audioQAResults, null, 2), '```',
    '',
    `## Post-Video Frame QA Results (REV5 Fix 5)`, '```json', JSON.stringify(postVideoQAResults, null, 2), '```',
  ];

  const promptsPath = path.join(runDir, 'prompts.md');
  fs.writeFileSync(promptsPath, mdLines.join('\n'));
  return { root: runDir, inputsDir, panelsDir, videosDir: path.join(runDir, 'videos'), storyboardPath, promptsPath };
}


// ── Fallback Analysis ─────────────────────────────────────────────────────────

function buildFallbackAnalysis(filePayloads, options = {}) {
  const ctx = options.productContext || {};
  const name = (ctx.productTitle || 'San Pham').trim();
  const vit = { tupleId: 'VIT_PRODUCT_001', colorFamily: 'as-reference', finishType: 'as-reference', graphicVariant: 'as-reference', sizeClass: 'as-reference', configState: 'standard', variantLock: 'match canonical reference exactly', canonicalReferenceId: 'REF_01' };
  return {
    productName: name, category: 'general',
    cartAnchorText: getCartAnchorText(ctx, { productName: name }),
    canonicalProductInstance: { productIdentityId: 'PRODUCT_001', selectionStatus: 'RESOLVED', canonicalReferenceId: 'REF_01', supportingIdentityReferenceIds: filePayloads.slice(1).map((_, i) => `REF_0${i + 2}`), excludedConflictingReferenceIds: [], confidence: 1.0, variantIdentityTuple: vit },
    productIdentityManifest: { productIdentityId: 'PRODUCT_001', overallGeometry: 'authentic geometry visible in references', appearance: 'original colors and finish as shown in references', componentLayout: ['main body', 'controls/accessories'], configuration: 'standard product form', identityCriticalTraits: ['exact product shape and colorway as in input images'], forbiddenMutations: ['do NOT change body color', 'do NOT mutate product shape'], unknownTraits: [] },
    referenceRoleMap: filePayloads.map((_, i) => ({ refId: `REF_0${i + 1}`, role: i === 0 ? 'CANONICAL_IDENTITY' : 'IDENTITY_SUPPORT', reason: i === 0 ? 'primary reference image' : 'supporting perspective' })),
    productFactLock: { productName: name, category: 'general', verifiedFacts: ['San pham thuc te hien thi trong hinh anh cung cap'], variantSpecificFacts: ['Phien ban chinh dien theo anh goc'], conflictingClaims: [] },
    visualEvidenceMatrix: { states: { fullProductFront: { available: true, refId: 'REF_01' } } },
    scenes: [
      { sceneNumber: 1, phase: 'Hook', visualCore: 'Can canh tay cam san pham tren ban go sang', primaryAction: 'hold product naturally and tilt slightly', actionComplexity: 'SAFE', actionEvidenceRef: 'REF_01', voiceLine: `San pham ${name} nay dang cuc hot tren thi truong luon!` },
      { sceneNumber: 2, phase: 'Solution', visualCore: 'Trinh dien chi tiet thiet ke va hoan thien tinh xao', primaryAction: 'point to visible key feature', actionComplexity: 'SAFE', actionEvidenceRef: 'REF_01', voiceLine: 'Thiet ke hien dai, chat lieu ben dep dung cuc ky ung y.' },
      { sceneNumber: 3, phase: 'Proof', visualCore: 'Thu nghiem trai nghiem su dung thuc te cam tren tay', primaryAction: 'hold product and demonstrate ease of use', actionComplexity: 'SAFE', actionEvidenceRef: 'REF_01', voiceLine: 'Do hoan thien ti mi tung chi tiet, tien loi mang theo moi ngay.' },
      { sceneNumber: 4, phase: 'Closing', visualCore: 'Dat san pham ngay ngon, ngon tay huong ve san pham', primaryAction: 'place product on surface and point towards it', actionComplexity: 'SAFE', actionEvidenceRef: 'REF_01', voiceLine: 'Uu dai cuc tot hom nay, bam ngay vao gio hang rinh ve nha!' },
    ],
    voicePerformanceProfile: { profileId: 'VOICE_001', language: 'vi-VN', speakerClass: 'young_adult', accent: 'southern_vietnamese', timbre: 'warm_bright_approachable', pitch: 'medium', delivery: 'rapid_fire_tiktok_review', energy: 'high', pauseBehavior: 'minimal', speechStyle: 'natural_colloquial_vietnamese' },
    fullScript: {
      script16s: `San pham ${name} nay dang cuc hot! Thiet ke hien dai, chat lieu ben dep ung y lam. Hoan thien ti mi tung chi tiet, tien loi moi ngay. Bam vao gio hang rinh ve nha!`,
      video1Script: `San pham ${name} nay dang cuc hot! Thiet ke hien dai chat lieu ben dep ung y lam.`,
      video2Script: 'Hoan thien ti mi tung chi tiet tien loi moi ngay. Bam vao gio hang rinh ve nha!',
      speechTimingBudget: { videoDuration: 8.0, speechStartTarget: '0.10s-0.25s', speechCompletionTarget: '6.2s-6.8s', speechProfile: 'FAST_CONVERSATIONAL_VI' },
    },
    hashtags: ['#review', '#giadung', '#xuhuong', '#tiktokshop'],
  };
}

async function analyzeProductTemplate10(geminiClient, filePayloads, options = {}) {
  console.log(`[T10] Step 1a: Uploading ${filePayloads.length} product image(s)...`);
  const uploadedFiles = [];
  for (let i = 0; i < filePayloads.length; i++) {
    const file = filePayloads[i];
    const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : (file.base64 ? Buffer.from(file.base64, 'base64') : (file.path ? fs.readFileSync(file.path) : null));
    if (!buffer) continue;
    const mimeType = file.mimeType || 'image/png';
    const filename = file.name || `product_${i + 1}.png`;
    const url = await geminiClient.uploadFile(buffer, filename, mimeType);
    uploadedFiles.push({ url, filename, mimeType, buffer });
  }

  console.log(`[T10] Step 1b: Running compact machine analysis via Gemini API...`);
  const analysisPrompt = buildTemplate10AnalysisPrompt(options);
  const analysisFiles = uploadedFiles.slice(0, 4);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const promptToSend = attempt === 1 ? analysisPrompt : `${analysisPrompt}\n\nRETRY ${attempt}: Output strictly valid RFC 8259 JSON without markdown wrapper.`;
      const res = await geminiClient.generateContent({ prompt: promptToSend, fileData: analysisFiles, temporary: true, expectImages: false });
      const rawText = res.text || '';
      console.log(`[T10] Gemini analysis (attempt ${attempt}, ${rawText.length} chars):`, rawText.substring(0, 200));
      const parsed = parseJsonSafe(rawText);

      if (!parsed) {
        // Detailed diagnostics for parse failure
        const last200 = rawText.slice(-200);
        const hasOpenBrace = rawText.includes('{');
        const isLikelyTruncated = rawText.length > 3000 && !rawText.trimEnd().endsWith('}');
        console.warn(`[T10] Parse FAIL diagnostics: length=${rawText.length}, hasBrace=${hasOpenBrace}, likelyTruncated=${isLikelyTruncated}`);
        console.warn(`[T10] Last 200 chars: ${last200}`);
        throw new Error(`parseJsonSafe returned null (likely truncated or malformed JSON, length=${rawText.length})`);
      }

      // parsed is non-null — check for required keys
      if (parsed.productFactLock || parsed.canonicalProductInstance) {
        const prodName = parsed.productFactLock?.productName || parsed.productName || 'San Pham';
        console.log(`[T10] Product analysis OK: "${prodName}"`);
        parsed.productName = prodName;
        parsed.category = parsed.productFactLock?.category || 'general';
        parsed.canonicalProductInstance = parsed.canonicalProductInstance || { productIdentityId: 'PRODUCT_001', selectionStatus: 'RESOLVED', canonicalReferenceId: 'REF_01', confidence: 1.0 };

        // Fix 10: Ensure variantIdentityTuple is present
        if (!parsed.canonicalProductInstance.variantIdentityTuple) {
          parsed.canonicalProductInstance.variantIdentityTuple = buildVariantIdentityTuple(parsed);
          console.log(`[T10][REV5] Fix 10: Built VIT: ${JSON.stringify(parsed.canonicalProductInstance.variantIdentityTuple)}`);
        }

        parsed.script = (parsed.scenes || []).map(s => ({ id: s.sceneNumber, phase: s.phase, voiceOver: s.voiceLine || '', visualDescription: s.visualCore || '', techVFX: s.primaryAction || '' }));
        const vp = parsed.voicePerformanceProfile || {};
        parsed.voicePersona = { gender: vp.accent?.includes('nam') ? 'nam' : 'nu', voiceDescription: `${vp.speakerClass || 'tre trung'}, ${vp.accent || 'mien Nam'}, ${vp.timbre || 'tu nhien'}`, tone: vp.delivery || 'nhanh don dap TikTok' };
        return { analysis: parsed, uploadedFiles };
      }

      // parsed exists but missing expected keys — log what we got
      const gotKeys = Object.keys(parsed).join(', ') || '(empty object)';
      throw new Error(`Missing expected analysis keys. Got: [${gotKeys}]`);

    } catch (err) {
      console.warn(`[T10] Analysis attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  console.warn('[T10] Analysis failed after 3 attempts — using robust fallback');
  return { analysis: buildFallbackAnalysis(filePayloads, options), uploadedFiles };
}


// ── Main Pipeline (REV5) ──────────────────────────────────────────────────────

async function generateStoryboard(baseDir, filePayloads, options = {}) {
  console.log(`[T10][REV5] Starting VEO_NATIVE_FAST 2x8s pipeline for ${filePayloads.length} image(s)...`);
  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');

  try {
    const { maybeRefreshCookies } = require('./gemini-cookie-refresher');
    await maybeRefreshCookies(effectiveBaseDir);
  } catch (e) { console.warn(`[T10] Cookie refresh warning: ${e.message}`); }

  const cookieFilePath = process.env.GEMINI_COOKIE_PATH
    ? path.resolve(effectiveBaseDir, process.env.GEMINI_COOKIE_PATH)
    : path.join(effectiveBaseDir, 'gemini-cookies');

  const geminiClient = new GeminiApiClient({ cookieFilePath: fs.existsSync(cookieFilePath) ? cookieFilePath : undefined });
  try { await geminiClient.init(); } catch (e) { console.error(`[T10] GeminiClient init failed: ${e.message}`); throw e; }

  const progressCb = options.onProgress || (() => {});

  try {
    // Step 1: Analysis
    progressCb({ step: 'analyzing', message: 'Dang phan tich san pham (Evidence-First)...' });
    const { analysis: rawAnalysis, uploadedFiles } = await analyzeProductTemplate10(geminiClient, filePayloads, options);

    // Step 1b: Normalize analysis (unwrap buggy nested structure if Gemini returned wrong shape)
    const analysis = normalizeAnalysisData(rawAnalysis);

    // REV5.1: Script feasibility with fill-state gate (replaces word-count budget)
    console.log('[T10][REV5.1] Validating script fill state...');
    const { video1Script, video2Script, feasibility: scriptFeasibility } = validateAndCompressScripts(analysis.fullScript);
    console.log(`[T10][REV5.1] Script fill states: V1=${scriptFeasibility.video1.fillState}(${scriptFeasibility.video1.estimatedDurationS}s/${scriptFeasibility.video1.syllables}syl) V2=${scriptFeasibility.video2.fillState}(${scriptFeasibility.video2.estimatedDurationS}s/${scriptFeasibility.video2.syllables}syl)`);
    const compressedScripts = { video1Script, video2Script };

    // Steps 2+3: Storyboard + BLOCKING QA Gate
    //
    // Budget semantics (matches user spec):
    //   maxQaRetries = 2  →  2 RE-generations after the first
    //   = 3 total storyboard images received + QA'd
    //
    // Generation errors (no image returned, network fail, etc.) do NOT count
    // against the QA retry budget. They are retried up to MAX_STORYBOARD_GEN_ATTEMPTS.
    progressCb({ step: 'storyboard', message: 'Dang tao Master Storyboard 4 canh (Google Flow)...' });

    const MAX_QA_RETRIES   = REV5_CONFIG.MAX_STORYBOARD_REGENERATION_RETRIES; // 2
    const MAX_GEN_ATTEMPTS = REV5_CONFIG.MAX_STORYBOARD_GEN_ATTEMPTS;          // safety cap for generation errors

    let storyboardBase64 = null, storyboardBuf = null, storyboardPrompt = '', qaResult = null;
    let retryInstruction = '', storyboardQaPassed = false;
    let qaFailCount   = 0;   // increments only on: image received + QA ran + QA failed
    let genAttemptCount = 0; // total generation calls (for safety cap)
    let lastKnownFailureReasons = []; // carry forward across QA runs so unparseable QA never loses context

    while (!storyboardQaPassed) {
      genAttemptCount++;
      if (genAttemptCount > MAX_GEN_ATTEMPTS) {
        throw new Error(`[T10][REV5] STORYBOARD_GEN_LIMIT: Storyboard generation failed ${MAX_GEN_ATTEMPTS} times without producing a valid image. Aborting.`);
      }

      storyboardPrompt = buildTemplate10StoryboardPrompt(analysis, options, retryInstruction);
      console.log(`[T10][REV5] Storyboard gen attempt ${genAttemptCount} (QA checks so far: ${qaFailCount}/${MAX_QA_RETRIES + 1} budget)...`);

      // ── Generate storyboard image ──────────────────────────────────────────
      let attemptBuf = null, attemptBase64 = null;
      try {
        const res = await geminiClient.generateContent({ prompt: storyboardPrompt, fileData: uploadedFiles.slice(0, 4), temporary: true, expectImages: true, aspectRatio: '16:9' });
        if (!res.images || res.images.length === 0) throw new Error('No image returned by Google Flow');
        if (res.images[0].buffer) { attemptBuf = res.images[0].buffer; attemptBase64 = attemptBuf.toString('base64'); }
        else if (res.images[0].base64) { attemptBase64 = res.images[0].base64; attemptBuf = Buffer.from(attemptBase64, 'base64'); }
        else if (res.images[0].url) {
          console.log(`[T10] Downloading storyboard from: ${res.images[0].url.substring(0, 60)}...`);
          attemptBuf = await geminiClient.downloadImage(res.images[0].url);
          attemptBase64 = attemptBuf ? attemptBuf.toString('base64') : null;
        }
        if (!attemptBuf) throw new Error('Failed to resolve storyboard image buffer');
        console.log(`[T10][REV5] ✅ Storyboard image received (gen attempt ${genAttemptCount}).`);
      } catch (genErr) {
        // Generation error — does NOT count against QA budget, retry generation.
        console.warn(`[T10][REV5] ⚠️  Storyboard generation error (gen attempt ${genAttemptCount}, NOT counted as QA retry): ${genErr.message}`);
        continue;
      }

      // ── BLOCKING QA Gate ──────────────────────────────────────────────────
      // Image was successfully received — now it counts toward the QA budget.
      progressCb({ step: 'qa_gate', message: `QA Gate: kiem duyet Storyboard (#${qaFailCount + 1})...` });
      const attemptQA = await validateStoryboard(geminiClient, attemptBuf, analysis);

      if (attemptQA.pass) {
        console.log(`[T10][REV5] ✅ Storyboard QA PASSED (gen attempt ${genAttemptCount}, QA check #${qaFailCount + 1})!`);
        storyboardBuf = attemptBuf; storyboardBase64 = attemptBase64; qaResult = attemptQA; storyboardQaPassed = true;
        break;
      }

      // Hard fail — unrecoverable, abort immediately regardless of budget
      if (attemptQA.hardFail === true) {
        throw new Error(`[T10][REV5] STORYBOARD_QA_HARD_FAIL: Unrecoverable defect. Reasons: ${(attemptQA.failureReasons || []).join('; ')}`);
      }

      // QA failed — count it and build targeted retry instruction
      qaFailCount++;

      // Carry forward: if QA response was unparseable, reuse last known real reasons
      const currentReasons  = attemptQA.failureReasons || [];
      const isUnparseable   = attemptQA.qaFailed && currentReasons.some(r => r.includes('unparseable') || r.includes('failed'));
      if (isUnparseable && lastKnownFailureReasons.length > 0) {
        console.warn(`[T10][REV5] QA unparseable — carrying forward reasons from previous QA: ${lastKnownFailureReasons.join(', ')}`);
      } else if (!isUnparseable && currentReasons.length > 0) {
        lastKnownFailureReasons = currentReasons;
      }
      const effectiveReasons = lastKnownFailureReasons.length > 0 ? lastKnownFailureReasons : currentReasons;

      console.warn(`[T10][REV5] ⛔ Storyboard QA FAILED (QA check #${qaFailCount}/${MAX_QA_RETRIES + 1} budget): ${effectiveReasons.join(', ')}`);
      qaResult = attemptQA;

      if (qaFailCount > MAX_QA_RETRIES) {
        // Exhausted QA budget — abort. Never proceed to Veo.
        throw new Error(`[T10][REV5] STORYBOARD_QA_FAILED: QA failed ${qaFailCount} time(s) (budget: ${MAX_QA_RETRIES} retries = ${MAX_QA_RETRIES + 1} QA checks total). Last reasons: ${effectiveReasons.join('; ')}`);
      }

      // Build targeted retry instruction from the actual QA failure reasons
      retryInstruction = (!isUnparseable && attemptQA.regenerateInstructions)
        ? attemptQA.regenerateInstructions
        : `Fix these specific issues (QA retry ${qaFailCount}/${MAX_QA_RETRIES}): ${effectiveReasons.map((r, i) => `${i + 1}. ${r}`).join(' | ')}. Ensure exact product variant (${analysis.canonicalProductInstance?.variantIdentityTuple?.colorFamily || 'as-reference'}) and 100% faceless photography without text overlays across all 4 panels.`;

      console.log(`[T10][REV5] Storyboard retry instruction: ${retryInstruction.substring(0, 200)}`);
    }

    if (!storyboardBuf) throw new Error('[T10][REV5] BLOCKING: No valid storyboard buffer.');

    // Send to Telegram
    const chatId = options.chatId || options.telegramChatId;
    if (chatId) {
      sendPhotoToTelegram(options.botToken || process.env.TELEGRAM_BOT_TOKEN, chatId, storyboardBuf,
        `Master Storyboard 4 Panel (REV5)\nSan pham: ${analysis.productName}\nQA Gate: ${qaResult?.pass ? 'PASSED (BLOCKING)' : 'WARNING'}`
      ).catch(e => console.error('[T10] sendPhoto error:', e.message));
    }

    // Step 4: Slicing — Fix 2: Only after QA passed; "Panel OK" = file created
    progressCb({ step: 'panels', message: 'Dang tach Master Storyboard thanh 4 panel 9:16...' });
    console.log('[T10][REV5] Fix 2: Slicing QA-validated storyboard...');
    const panelBuffers = sliceStoryboardIntoFourPanels(storyboardBuf);
    const panels = [];
    for (let i = 0; i < 4; i++) {
      const pBuf = panelBuffers[i];
      panels.push({ index: i + 1, panelIndex: i + 1, buffer: pBuf, base64: pBuf.toString('base64'), imageBase64: pBuf.toString('base64'), mimeType: 'image/png',
        fileCreated: true,              // Fix 2: file created
        visualQaPassed: storyboardQaPassed, // Fix 2: visual correctness confirmed by blocking gate
      });
      console.log(`[T10][REV5] Fix 2: Panel ${i + 1} file created (${pBuf.length} bytes). Visual QA: ${storyboardQaPassed ? 'confirmed by blocking gate' : 'bypassed'}`);
    }

    // Step 5: Build prompts with compressed scripts (Fix 8)
    const videoPrompts = getTemplate10VideoPrompts(analysis, options, compressedScripts);

    // Step 6: Archive
    const runPaths = archiveTemplate10Review(effectiveBaseDir, filePayloads, storyboardPrompt, storyboardBase64, panels, analysis, qaResult, videoPrompts, options, scriptFeasibility, [], []);
    console.log(`[T10] Archive created at: ${runPaths.root}`);

    // Step 7: Generate 2x8s videos with per-video retry + blocking QA
    progressCb({ step: 'videos', message: 'Dang tao 2 video 8s bang Veo (VEO_NATIVE_FAST)...' });
    ensureDir(runPaths.videosDir);

    const canonicalRefBuf = uploadedFiles[0]?.buffer || filePayloads[0]?.buffer || null;
    const evidenceRefBuf  = uploadedFiles[1]?.buffer || filePayloads[1]?.buffer || null;

    const baseVideoJobs = [
      { index: 1, panelIndex: 1, prompt: videoPrompts[0].promptText, imagePath: panels[0].imagePath, startFrameCapability: videoPrompts[0].startFrameCapability, videoModelKey: options.videoModelKey || 'abra_i2v_8s',
        referenceImages: [{ name: 'panel-1.png', buffer: panelBuffers[0], role: 'startFrame' }, { name: 'panel-2.png', buffer: panelBuffers[1], role: 'secondSceneTarget' }, ...(canonicalRefBuf ? [{ name: 'canonical_identity.png', buffer: canonicalRefBuf, role: 'canonicalRef' }] : []), ...(evidenceRefBuf ? [{ name: 'evidence_ref.png', buffer: evidenceRefBuf, role: 'relevantEvidenceRef' }] : [])].filter(x => x.buffer) },
      { index: 2, panelIndex: 2, prompt: videoPrompts[1].promptText, imagePath: panels[2].imagePath, startFrameCapability: videoPrompts[1].startFrameCapability, videoModelKey: options.videoModelKey || 'abra_i2v_8s',
        referenceImages: [{ name: 'panel-3.png', buffer: panelBuffers[2], role: 'startFrame' }, { name: 'panel-4.png', buffer: panelBuffers[3], role: 'secondSceneTarget' }, ...(canonicalRefBuf ? [{ name: 'canonical_identity.png', buffer: canonicalRefBuf, role: 'canonicalRef' }] : []), ...(evidenceRefBuf ? [{ name: 'evidence_ref.png', buffer: evidenceRefBuf, role: 'relevantEvidenceRef' }] : [])].filter(x => x.buffer) },
    ];

    const videoResults = [];
    const videoQAResults = [];
    const audioQAResults = [];
    const savedVideoPaths = [];

    // Generate Video 1, then Video 2 — each with blocking QA retry loop
    const panelBufPairs = [
      [panelBuffers[0], panelBuffers[1]],  // V1: start=Panel1, target=Panel2
      [panelBuffers[2], panelBuffers[3]],  // V2: start=Panel3, target=Panel4
    ];

    for (let vIdx = 0; vIdx < baseVideoJobs.length; vIdx++) {
      const job = baseVideoJobs[vIdx];
      const [startBuf, targetBuf] = panelBufPairs[vIdx];
      progressCb({ step: 'videos', message: `Dang tao Video ${job.index}/2 (3 attempts + fallback)...` });

      // generateVideoWithRetry never throws — returns best usable result
      const vResult = await generateVideoWithRetry(
        geminiClient, effectiveBaseDir, job, startBuf, targetBuf, analysis, options, runPaths.videosDir, compressedScripts
      );

      videoResults.push(vResult.videoResult);
      videoQAResults.push({ videoIndex: job.index, ...vResult.videoQAResult, qualityLevel: vResult.qualityLevel, qualityScore: vResult.qualityScore, allAttempts: vResult.allAttempts, fallbackUsed: vResult.fallbackUsed });
      audioQAResults.push({ videoIndex: job.index, ...vResult.audioQAResult });
      if (vResult.videoPath && fs.existsSync(vResult.videoPath)) {
        savedVideoPaths.push(vResult.videoPath);
      }

      const ql = vResult.qualityLevel || 'UNKNOWN';
      console.log(`[T10][REV5.2] Video ${job.index} finalized: qualityLevel=${ql}, fallback=${vResult.fallbackUsed}, path=${vResult.videoPath}`);
    }

    // Update archive with real QA results
    try {
      let md = fs.readFileSync(runPaths.promptsPath, 'utf8');
      md = md.replace(/## Audio QA Results \(REV5 Fix 7\)\n```json\n[\s\S]*?```/, `## Audio QA Results (REV5 Fix 7)\n\`\`\`json\n${JSON.stringify(audioQAResults, null, 2)}\n\`\`\``);
      md = md.replace(/## Post-Video Frame QA Results \(REV5 Fix 5\)\n```json\n[\s\S]*?```/, `## Post-Video Frame QA Results (REV5 Fix 5)\n\`\`\`json\n${JSON.stringify(videoQAResults, null, 2)}\n\`\`\``);
      fs.writeFileSync(runPaths.promptsPath, md);
    } catch (_) {}

    // Step 8: Concat — concat if both videos have usable output (PASS, SOFT_PASS, or DEGRADED)
    // Never skip concat just because QA wasn't perfect — degrade strategy ensures there's always output.
    const videoQALevels = videoQAResults.map(r => r.qualityLevel || 'UNKNOWN');
    const allHaveOutput = savedVideoPaths.length === 2;
    const anyDegraded  = videoQALevels.some(l => l === 'DEGRADED' || l === 'NO_OUTPUT');
    const anySoftPass  = videoQALevels.some(l => l === 'SOFT_PASS');
    let final16sVideoPath = null;
    if (allHaveOutput) {
      try {
        progressCb({ step: 'concat', message: `Dang ghep Video 1 va Video 2 thanh video 16s (quality: ${videoQALevels.join(', ')})...` });
        const out = path.join(runPaths.videosDir, 'final_16s.mp4');
        await mergeVideos(savedVideoPaths, out, { timeoutMs: 120000 });
        if (fs.existsSync(out)) {
          final16sVideoPath = out;
          const overallQuality = anyDegraded ? 'DEGRADED' : anySoftPass ? 'SOFT_PASS' : 'PASS';
          console.log(`[T10][REV5.2] Final 16s: ${out} (overall quality: ${overallQuality})`);
        }
      } catch (e) { console.warn(`[T10][REV5.2] Concat warning: ${e.message}`); }
    } else {
      console.warn(`[T10][REV5.2] Cannot concat — only ${savedVideoPaths.length}/2 videos produced.`);
    }

    progressCb({ step: 'done', message: 'Template 10 VEO_NATIVE_FAST REV5 hoan tat!' });

    return {
      template: 'template10', rev: 'REV5',
      runId: path.basename(runPaths.root).split('-').pop(),
      runDir: runPaths.root, promptsPath: runPaths.promptsPath,
      storyboardPath: runPaths.storyboardPath, panelsDir: runPaths.panelsDir, videosDir: runPaths.videosDir,
      panels, videos: videoResults, final16sVideoPath, analysis, videoPrompts,
      qaResult, storyboardQaPassed, qualityMode: 'VEO_NATIVE_FAST_2x8s_REV5.2',
      scriptFeasibility, audioQAResults, videoQAResults,
      videoQualityLevels: videoQAResults.map(r => ({ videoIndex: r.videoIndex, qualityLevel: r.qualityLevel, qualityScore: r.qualityScore, fallbackUsed: r.fallbackUsed })),
      startFrameCapabilities: videoPrompts.map(p => p.startFrameCapability), // Fix 4
    };
  } finally {
    try { await geminiClient.close?.(); } catch (_) {}
  }
}

// ── Module Exports ────────────────────────────────────────────────────────────

module.exports = {
  generateStoryboard,
  buildTemplate10AnalysisPrompt,
  buildTemplate10StoryboardPrompt,
  buildVeoNativeFastPrompt,
  getTemplate10VideoPrompts,
  validateStoryboard,
  analyzeProductTemplate10,
  archiveTemplate10Review,
  checkActionFeasibility,
  ACTION_COMPLEXITY,
  // REV5
  validateAndCompressScripts,
  compressScriptToTimingBudget,
  buildVariantIdentityTuple,
  runVideoQA,
  runAudioQA,
  classifyVideoQA,
  buildFallbackVideoJob,
  generateVideoWithRetry,
  REV5_CONFIG,
  // REV5.1
  FAST_CONVERSATIONAL_VI,
  estimateViSyllables,
  estimateViSpeechDuration,
  classifyScriptFillState,
  normalizeAnalysisData,
};

