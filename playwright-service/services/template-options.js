'use strict';

function normalizeTemplateName(name) {
  if (!name) return '';
  const s = String(name).trim().toLowerCase();
  if (s === 't1' || s === 'template1') return 'template1';
  if (s === 't2' || s === 'template2') return 'template2';
  if (s === 't3' || s === 'template3') return 'template3';
  if (s === 't4' || s === 'template4') return 'template4';
  if (s === 't5' || s === 'template5') return 'template5';
  if (s === 't5_1' || s === 't5.1' || s === 't51' || s === 'template5_1' || s === 'template5.1' || s === 'template51') return 'template5_1';
  if (s === 't5_2' || s === 't5.2' || s === 't52' || s === 'template5_2' || s === 'template5.2' || s === 'template52') return 'template5_2';
  if (s === 't5_3' || s === 't5.3' || s === 't53' || s === 'template5_3' || s === 'template5.3' || s === 'template53') return 'template5_3';
  if (s === 't6' || s === 'template6' || s === 'template_6') return 'template6';
  return s;
}

/**
 * Returns canonical template options (panelCount, videoModelKey, noText, hasVoice, etc.)
 * for a given template name. Shared between telegram-bot.js and generation-job.js.
 */
function buildTemplateOptions(rawTemplate) {
  const template = normalizeTemplateName(rawTemplate);
  if (template === 'template1') {
    return {
      template: 'template1',
      panelCount: 2,
    };
  }
  if (template === 'template2') {
    return {
      template: 'template2',
      panelCount: 8,
      videoModelKey: '4s',
    };
  }
  if (template === 'template3') {
    return {
      template: 'template3',
      panelCount: 2,
      videoModelKey: 'abra_i2v_8s',
    };
  }
  if (template === 'template4') {
    return {
      template: 'template4',
      panelCount: 2,
      videoModelKey: 'abra_i2v_8s',
    };
  }
  if (template === 'template5') {
    return {
      template: 'template5',
      panelCount: 2,
      videoModelKey: 'abra_i2v_8s',
    };
  }
  if (template === 'template5_1' || template === 'template5.1' || template === 'template51') {
    return {
      template: 'template5_1',
      panelCount: 2,
      noText: true,
      videoModelKey: 'abra_i2v_8s',
    };
  }
  if (template === 'template5_2' || template === 'template5.2' || template === 'template52') {
    return {
      template: 'template5_2',
      panelCount: 2,
      noText: true,
      hasVoice: true,
      videoModelKey: 'abra_i2v_8s',
    };
  }
  if (template === 'template5_3' || template === 'template5.3' || template === 'template53') {
    return {
      template: 'template5_3',
      panelCount: 4,
      noText: true,
      hasVoice: true,
      videoModelKey: '4s',
    };
  }
  if (template === 'template6' || template === 'template_6') {
    return {
      template: 'template6',
      panelCount: 2,
      noText: true,
    };
  }
  return {};
}

module.exports = {
  buildTemplateOptions,
  normalizeTemplateName,
};
