'use strict';

const { assertFourScenes } = require('./contracts');
const { isNonVisualClaim, normalizeComparableValue } = require('./product-truth');

const FACE_EXPRESSION_RE = /\b(smile|smiling|happy face|facial expression|mỉm cười|cười tươi|gương mặt vui|biểu cảm)\b/iu;
const MULTI_ACTION_RE = /(?:\b(?:and|then|while)\b|\b(?:và|rồi|đồng thời|trong khi|vừa).{0,32}\b(?:và|rồi|đồng thời|vừa)\b)/iu;

function clampVoiceover(text, durationSeconds, wordsPerSecond) {
  const words = String(text || '').trim().split(/\s+/u).filter(Boolean);
  const maxWords = Math.max(1, Math.floor(Number(durationSeconds || 4) * Number(wordsPerSecond || 2.5)));
  if (words.length <= maxWords) return { text: words.join(' '), wordCount: words.length, truncated: false, maxWords };
  let selected = words.slice(0, maxWords).join(' ').replace(/[,;:\s]+$/u, '');
  const punctuation = selected.match(/[.!?](?=\s|$)/gu);
  if (!/[.!?]$/u.test(selected)) selected += punctuation?.length ? '' : '.';
  return { text: selected, wordCount: maxWords, truncated: true, maxWords };
}

function stripFacialExpressions(value) {
  const allExpressions = new RegExp(FACE_EXPRESSION_RE.source, 'giu');
  return String(value || '').replace(allExpressions, '').replace(/\s{2,}/g, ' ').replace(/^[,;\s]+|[,;\s]+$/g, '');
}

function simplifyAction(action) {
  const raw = String(action || '').trim();
  if (!raw) return 'Show the product resting securely in a natural setting';
  return raw.split(/\b(?:and|then|while|và|rồi|đồng thời|trong khi|vừa)\b/iu)[0].trim().replace(/[,;]+$/u, '') || raw;
}

function normalizeScene(rawScene, index, routing, config) {
  const durationSeconds = Number(rawScene.durationSeconds || config.sceneDurationSeconds);
  const voice = clampVoiceover(rawScene.voiceoverClaim || rawScene.voiceover, durationSeconds, config.voiceWordsPerSecondTarget);
  const humanMode = routing.humanMode;
  const handsAvailable = Number.isFinite(Number(rawScene.handsAvailable))
    ? Number(rawScene.handsAvailable)
    : (humanMode === 'none' ? 0 : 2);
  return {
    ...rawScene,
    sceneNumber: index + 1,
    phase: ['hook', 'solution', 'proof', 'closing'][index],
    visualClaim: String(rawScene.visualClaim || rawScene.primaryVisualClaim || '').trim(),
    voiceoverClaim: voice.text,
    voiceWordCount: voice.wordCount,
    voiceWasTrimmed: voice.truncated,
    postProductionCopy: String(rawScene.postProductionCopy || '').trim(),
    primaryAction: String(rawScene.primaryAction || '').trim(),
    productState: rawScene.productState || 'assembled',
    humanFraming: rawScene.humanFraming || (humanMode === 'none' ? 'none' : humanMode === 'hands_only' ? 'hands' : 'shoulders_down'),
    handsRequired: Math.max(0, Number(rawScene.handsRequired || 0)),
    handsAvailable: Math.max(0, handsAvailable),
    supportingSurface: String(rawScene.supportingSurface || '').trim(),
    evidenceIds: Array.isArray(rawScene.evidenceIds) ? rawScene.evidenceIds : [],
    durationSeconds,
    fallbackScene: rawScene.fallbackScene || null,
  };
}

function validateScene(scene, routing, productTruth) {
  const attributes = productTruth.attributes || [];
  const usesBlockedAttribute = attributes.some(attribute => {
    if (attribute.value === null || attribute.value === undefined || attribute.value === '') return false;
    if (/brand|model|sku|product_name|tên_sản_phẩm/iu.test(String(attribute.name || ''))) return false;
    if (!/\d/u.test(String(attribute.value))) return false;
    const value = String(attribute.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const unit = String(attribute.unit || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matcher = new RegExp(`${value}\\s*${unit}`, 'iu');
    const comparable = normalizeComparableValue(attribute.value, attribute.unit);
    const peers = attributes.filter(candidate => normalizeComparableValue(candidate.value, candidate.unit) === comparable);
    const visualAllowed = peers.some(candidate => candidate.allowedInVisual);
    const voiceAllowed = peers.some(candidate => candidate.allowedInVoiceover);
    const copyAllowed = peers.some(candidate => candidate.allowedInPostProductionCopy);
    return (!visualAllowed && matcher.test(scene.visualClaim))
      || (!voiceAllowed && matcher.test(scene.voiceoverClaim))
      || (!copyAllowed && matcher.test(scene.postProductionCopy));
  });
  const allClaims = `${scene.visualClaim} ${scene.voiceoverClaim} ${scene.postProductionCopy}`.toLocaleLowerCase('vi');
  const usesRiskyClaim = productTruth.unsupportedOrRiskyClaims
    .map(claim => String(claim || '').trim().toLocaleLowerCase('vi'))
    .filter(Boolean)
    .some(claim => allClaims.includes(claim));
  const checks = {
    singleClaim: !Array.isArray(scene.visualClaim) && !MULTI_ACTION_RE.test(String(scene.visualClaim)),
    singleAction: !MULTI_ACTION_RE.test(scene.primaryAction),
    handBudget: scene.handsRequired <= scene.handsAvailable,
    objectSupport: !['detached', 'open'].includes(scene.productState) || Boolean(scene.supportingSurface) || scene.handsRequired > 0,
    mechanismGrounding: !['detached', 'open'].includes(scene.productState) || scene.evidenceIds.length > 0,
    productStateConsistency: Boolean(scene.productState),
    humanModeCompliance: !(['faceless_model', 'hands_only', 'none'].includes(routing.humanMode) && FACE_EXPRESSION_RE.test(`${scene.visualClaim} ${scene.primaryAction} ${scene.visualDescription || ''}`)),
    visualizable: Boolean(scene.visualClaim || scene.primaryAction) && !isNonVisualClaim(scene.visualClaim),
    timeFeasibility: !MULTI_ACTION_RE.test(scene.primaryAction),
    safetyAndClaims: !usesRiskyClaim && !usesBlockedAttribute,
  };
  return checks;
}

function rewriteScene(scene, checks, routing) {
  const revised = { ...scene };
  const reasons = [];
  if (!checks.singleAction || !checks.handBudget || !checks.timeFeasibility) {
    revised.primaryAction = simplifyAction(scene.primaryAction);
    revised.handsRequired = Math.min(scene.handsAvailable, Math.max(0, scene.handsAvailable ? 1 : 0));
    reasons.push('simplified_action');
  }
  if (!checks.objectSupport) {
    revised.productState = 'assembled';
    revised.supportingSurface = revised.supportingSurface || 'stable table or floor surface';
    revised.primaryAction = routing.humanMode === 'none' ? 'Product remains securely placed on the surface' : 'One hand steadies the assembled product';
    reasons.push('added_object_support');
  }
  if (!checks.mechanismGrounding) {
    revised.productState = 'assembled';
    revised.primaryAction = 'Show the verified exterior finish in one stable close shot';
    reasons.push('removed_unsupported_mechanism');
  }
  if (!checks.humanModeCompliance) {
    revised.visualClaim = stripFacialExpressions(revised.visualClaim);
    revised.primaryAction = stripFacialExpressions(revised.primaryAction);
    revised.visualDescription = stripFacialExpressions(revised.visualDescription);
    reasons.push('removed_facial_expression');
  }
  if (!checks.visualizable || !checks.singleClaim) {
    if (isNonVisualClaim(revised.visualClaim)) {
      revised.voiceoverClaim = revised.voiceoverClaim || revised.visualClaim;
      revised.postProductionCopy = revised.postProductionCopy || revised.visualClaim;
    }
    revised.visualClaim = 'Show one visible, evidence-backed product detail';
    reasons.push('rerouted_non_visual_claim');
  }
  return { revised, reasons };
}

function validateAndRewriteVisualScenes(rawPlan, productTruth, routing, config) {
  const source = rawPlan?.storyPlan || rawPlan;
  assertFourScenes(source);
  const results = [];
  const scenes = source.scenes.map((rawScene, index) => {
    let scene = normalizeScene(rawScene, index, routing, config);
    let checks = validateScene(scene, routing, productTruth);
    let status = Object.values(checks).every(Boolean) ? 'pass' : 'revised';
    let reasons = [];
    if (status === 'revised') {
      const rewrite = rewriteScene(scene, checks, routing);
      scene = rewrite.revised;
      reasons = rewrite.reasons;
      checks = validateScene(scene, routing, productTruth);
      if (!Object.values(checks).every(Boolean)) status = 'fail';
    }
    results.push({ sceneNumber: index + 1, checks, status, reasons });
    return scene;
  });

  return {
    storyPlan: { ...source, scenes },
    feasibility: {
      overallStatus: results.some(item => item.status === 'fail') ? 'needs_review' : (results.some(item => item.status === 'revised') ? 'revised' : 'pass'),
      scenes: results,
    },
  };
}

module.exports = {
  FACE_EXPRESSION_RE,
  clampVoiceover,
  simplifyAction,
  stripFacialExpressions,
  validateAndRewriteVisualScenes,
  validateScene,
};
