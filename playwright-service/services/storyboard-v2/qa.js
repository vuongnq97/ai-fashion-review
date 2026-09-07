'use strict';

const PANEL_WEIGHTS = Object.freeze({
  productIdentity: 30,
  physicalFeasibility: 20,
  sceneIntent: 15,
  continuity: 15,
  humanAnatomy: 10,
  realism: 5,
  noTextCompliance: 5,
});

const HARD_REJECT_CODES = new Set([
  'wrong_sku',
  'wrong_mechanism',
  'floating_object',
  'product_morph',
  'unsafe_mechanical_state',
  'panel_count_error',
  'cross_panel_product_mismatch',
]);

const MASTER_WEIGHTS = Object.freeze({
  productIdentity: 30,
  crossPanelContinuity: 25,
  physicalFeasibility: 15,
  sceneCoverage: 15,
  layoutCompliance: 10,
  noTextCompliance: 5,
});

function normalizeMetric(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  // Vision providers commonly return a 0-10 scale even when asked for 0-100.
  const normalized = number > 0 && number <= 10 ? number * 10 : number;
  return Math.max(0, Math.min(100, normalized));
}

function weightedScore(scores = {}, weights = PANEL_WEIGHTS) {
  let total = 0;
  for (const [key, weight] of Object.entries(weights)) {
    total += normalizeMetric(scores[key]) * weight / 100;
  }
  return Math.round(total);
}

function evaluateMasterQa(rawQa = {}, deterministic = {}) {
  const raw = rawQa.masterQa || rawQa.qa || rawQa;
  const defects = normalizeDefects(raw.defects);
  const hardRejectReasons = [
    ...(Array.isArray(raw.hardRejectReasons) ? raw.hardRejectReasons : []),
    ...defects.filter(defect => HARD_REJECT_CODES.has(defect.code)).map(defect => defect.code),
    ...(Array.isArray(deterministic.hardRejectReasons) ? deterministic.hardRejectReasons : []),
  ].map(String);
  const scores = Object.fromEntries(Object.keys(MASTER_WEIGHTS).map(key => [key, normalizeMetric((raw.scores || raw)[key])]));
  const score = weightedScore(scores, MASTER_WEIGHTS);
  return {
    score,
    decision: hardRejectReasons.length ? 'reject' : (deterministic.valid === false || score < 75 ? 'regenerate' : score < 85 ? 'targeted_retry' : 'approve'),
    hardRejectReasons: [...new Set(hardRejectReasons)],
    defects,
    correctionPrompt: String(raw.correctionPrompt || '').trim(),
    scores,
  };
}

function normalizeDefects(defects) {
  return (Array.isArray(defects) ? defects : []).map(defect => {
    if (typeof defect === 'string') return { code: 'observable_defect', severity: 'major', description: defect };
    return {
      code: String(defect.code || 'observable_defect').toLowerCase(),
      severity: String(defect.severity || 'major').toLowerCase(),
      description: String(defect.description || defect.message || ''),
    };
  });
}

function evaluatePanelQa(rawQa = {}, deterministic = {}) {
  const raw = rawQa.panelQa || rawQa.qa || rawQa;
  const defects = normalizeDefects(raw.defects);
  const hardRejectReasons = [
    ...(Array.isArray(raw.hardRejectReasons) ? raw.hardRejectReasons : []),
    ...defects.filter(defect => HARD_REJECT_CODES.has(defect.code)).map(defect => defect.code),
    ...(Array.isArray(deterministic.hardRejectReasons) ? deterministic.hardRejectReasons : []),
  ].map(String);
  const score = weightedScore(raw.scores || raw);
  let decision = 'regenerate';
  if (hardRejectReasons.length > 0) decision = 'reject';
  else if (deterministic.valid === false) decision = 'regenerate';
  else if (score >= 85) decision = 'approve';
  else if (score >= 75) decision = 'targeted_retry';
  return {
    score,
    decision,
    hardRejectReasons: [...new Set(hardRejectReasons)],
    defects,
    correctionPrompt: String(raw.correctionPrompt || '').trim(),
    scores: Object.fromEntries(Object.keys(PANEL_WEIGHTS).map(key => [key, normalizeMetric((raw.scores || raw)[key])])),
  };
}

function assertApprovedPanels(panels, expectedCount = 4) {
  if (!Array.isArray(panels) || panels.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} panels before video generation`);
  }
  const rejected = panels.filter(panel => panel.status !== 'approved');
  if (rejected.length) {
    throw new Error(`Video generation blocked: panels not approved (${rejected.map(panel => panel.sceneNumber || panel.index).join(', ')})`);
  }
  return panels;
}

function evaluateClipQa(rawQa = {}, deterministic = {}) {
  const raw = rawQa.clipQa || rawQa.qa || rawQa;
  const defects = normalizeDefects(raw.defects);
  const hardRejectReasons = [
    ...(Array.isArray(raw.hardRejectReasons) ? raw.hardRejectReasons : []),
    ...defects.filter(defect => HARD_REJECT_CODES.has(defect.code)).map(defect => defect.code),
    ...(Array.isArray(deterministic.hardRejectReasons) ? deterministic.hardRejectReasons : []),
  ];
  const score = normalizeMetric(raw.score ?? 0);
  return {
    score,
    decision: hardRejectReasons.length ? 'reject' : (deterministic.valid === false || score < 75 ? 'regenerate' : score < 85 ? 'targeted_retry' : 'approve'),
    hardRejectReasons: [...new Set(hardRejectReasons.map(String))],
    defects,
    correctionPrompt: String(raw.correctionPrompt || '').trim(),
  };
}

module.exports = {
  HARD_REJECT_CODES,
  MASTER_WEIGHTS,
  PANEL_WEIGHTS,
  assertApprovedPanels,
  evaluateClipQa,
  evaluateMasterQa,
  evaluatePanelQa,
  weightedScore,
};
