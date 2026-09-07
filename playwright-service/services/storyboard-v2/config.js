'use strict';

// template5_2 (/t52) is intentionally pinned to V1.
const V2_TEMPLATES = new Set(['template5', 'template5_1']);

function normalizeTemplate(value) {
  const raw = String(value || 'template5').trim().toLowerCase();
  if (['t5', 'template5'].includes(raw)) return 'template5';
  if (['t5_1', 't5.1', 't51', 'template5_1', 'template5.1', 'template51'].includes(raw)) return 'template5_1';
  if (['t5_2', 't5.2', 't52', 'template5_2', 'template5.2', 'template52'].includes(raw)) return 'template5_2';
  if (['t5_3', 't5.3', 't53', 'template5_3', 'template5.3', 'template53'].includes(raw)) return 'template5_3';
  return raw;
}

function enumValue(value, allowed, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function finiteNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function resolvePipelineVersion(options = {}) {
  return enumValue(
    options.pipelineVersion || process.env.STORYBOARD_PIPELINE_VERSION,
    ['v1', 'v2'],
    'v1'
  );
}

function isV2Enabled(options = {}) {
  return V2_TEMPLATES.has(normalizeTemplate(options.template)) && resolvePipelineVersion(options) === 'v2';
}

function normalizeRunConfig(options = {}) {
  const template = normalizeTemplate(options.template);
  const qualityMode = enumValue(
    options.qualityMode || process.env.STORYBOARD_QUALITY_MODE,
    ['fast', 'balanced', 'high_fidelity'],
    'balanced'
  );
  const humanMode = enumValue(options.humanMode, ['none', 'hands_only', 'faceless_model', 'full_model', 'auto'], 'auto');
  const hasVoice = template === 'template5_2' || options.hasVoice === true;
  const voiceStrategy = hasVoice
    ? enumValue(
        options.voiceStrategy || process.env.STORYBOARD_VOICE_STRATEGY || (typeof options.synthesizeVoiceover === 'function' ? 'external_tts' : 'provider'),
        ['provider', 'external_tts'],
        'provider'
      )
    : 'none';
  const textMode = template === 'template5'
    ? 'with_post_copy'
    : 'no_generated_text';

  return Object.freeze({
    pipelineVersion: resolvePipelineVersion(options),
    template,
    language: options.language || 'vi-VN',
    targetPlatform: options.targetPlatform || 'tiktok',
    qualityMode,
    textMode,
    humanMode,
    hasVoice,
    voiceStrategy,
    panelCount: 4,
    panelWidth: 1080,
    panelHeight: 1920,
    panelAspectRatio: '9:16',
    sceneDurationSeconds: finiteNumber(options.sceneDurationSeconds, 4, 1, 15),
    finalVideoDurationSeconds: finiteNumber(options.finalVideoDurationSeconds, 16, 4, 60),
    maxImageReferencesPerCall: Math.round(finiteNumber(options.maxImageReferencesPerCall, 4, 1, 4)),
    maxPanelRetries: Math.round(finiteNumber(options.maxPanelRetries ?? process.env.STORYBOARD_MAX_PANEL_RETRIES, 2, 0, 5)),
    maxClipRetries: Math.round(finiteNumber(options.maxClipRetries ?? process.env.STORYBOARD_MAX_CLIP_RETRIES, 2, 0, 5)),
    voiceWordsPerSecondTarget: finiteNumber(options.voiceWordsPerSecondTarget, 2.5, 1.5, 3.5),
    generateVideos: options.generateVideos !== false,
    includeVideoBase64: options.includeVideoBase64 === true,
  });
}

module.exports = {
  V2_TEMPLATES,
  isV2Enabled,
  normalizeRunConfig,
  normalizeTemplate,
  resolvePipelineVersion,
};
