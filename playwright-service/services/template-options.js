'use strict';

// Template mục tiêu khi dùng lệnh /testing (có thể override qua biến môi trường TESTING_TEMPLATE)
const TESTING_TARGET_TEMPLATE = process.env.TESTING_TEMPLATE || 'template_pro';

function normalizeTemplateName(name) {
  if (!name) return '';
  const s = String(name).trim().toLowerCase();
  // Alias lệnh /testing: linh hoạt trỏ tới template cần test
  if (s === 'testing' || s === 'template_testing' || s === 'ttest') {
    return normalizeTemplateName(TESTING_TARGET_TEMPLATE);
  }
  if (s === 't1' || s === 'template1') return 'template1';
  if (s === 't2' || s === 'template2') return 'template2';
  if (s === 't3' || s === 'template3') return 'template3';
  if (s === 't4' || s === 'template4') return 'template4';
  if (s === 't5' || s === 'template5') return 'template5';
  if (s === 't5_1' || s === 't5.1' || s === 't51' || s === 'template5_1' || s === 'template5.1' || s === 'template51') return 'template5_1';
  if (s === 't5_2' || s === 't5.2' || s === 't52' || s === 'template5_2' || s === 'template5.2' || s === 'template52') return 'template5_2';
  if (s === 't5_3' || s === 't5.3' || s === 't53' || s === 'template5_3' || s === 'template5.3' || s === 'template53') return 'template5_3';
  if (s === 't6' || s === 'template6' || s === 'template_6') return 'template6';
  // Template 10 — QUALITY_LOCKED Atomic Shot (EVIDENCE-FIRST + MASTER NARRATION)
  if (s === 't10' || s === 'template10' || s === 'template_10') return 'template10';
  // Template Pro — Interactive Storyboard Remake Workflow
  if (s === 'tpro' || s === 'template_pro' || s === 'templatepro') return 'template_pro';
  // Template Mom — Mother & Baby Commerce Interactive Storyboard
  if (s === 'tmom' || s === 'template_mom' || s === 'templatemom') return 'template_mom';
  // Template Food — Food & Beverage Review 24s Interactive Storyboard (4x 6s)
  if (s === 'tfood' || s === 'template_food' || s === 'templatefood') return 'template_food';
  // Template Product — Live-Commerce Presenter Template Pro 40s Native-Voice (5x 8s)
  if (s === 'tproduct' || s === 'template_product' || s === 'templateproduct' || s === 'tpro40nv') return 'template_product';
  return s;
}

function resolveUseProxyForTemplate(template, defaultVal = true) {
  const envKey = `TEMPLATE_${template.toUpperCase()}_USE_PROXY`;
  if (process.env[envKey] !== undefined) {
    return process.env[envKey] === 'true' || process.env[envKey] === '1';
  }
  return defaultVal;
}

function isProxyEnabledForTemplate(rawTemplate) {
  const opts = buildTemplateOptions(rawTemplate);
  return opts.useProxy !== false;
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
      useProxy: resolveUseProxyForTemplate('template1', true),
    };
  }
  if (template === 'template2') {
    return {
      template: 'template2',
      panelCount: 8,
      videoModelKey: '4s',
      useProxy: resolveUseProxyForTemplate('template2', true),
    };
  }
  if (template === 'template3') {
    return {
      template: 'template3',
      panelCount: 2,
      videoModelKey: 'abra_i2v_8s',
      useProxy: resolveUseProxyForTemplate('template3', true),
    };
  }
  if (template === 'template4') {
    return {
      template: 'template4',
      panelCount: 2,
      videoModelKey: 'abra_i2v_8s',
      useProxy: resolveUseProxyForTemplate('template4', true),
    };
  }
  if (template === 'template5') {
    return {
      template: 'template5',
      panelCount: 2,
      videoModelKey: 'abra_i2v_8s',
      useProxy: resolveUseProxyForTemplate('template5', true),
    };
  }
  if (template === 'template5_1' || template === 'template5.1' || template === 'template51') {
    return {
      template: 'template5_1',
      panelCount: 2,
      noText: true,
      videoModelKey: 'abra_i2v_8s',
      useProxy: resolveUseProxyForTemplate('template5_1', true),
    };
  }
  if (template === 'template5_2' || template === 'template5.2' || template === 'template52') {
    return {
      template: 'template5_2',
      panelCount: 2,
      noText: true,
      hasVoice: true,
      videoModelKey: 'abra_i2v_8s',
      useProxy: resolveUseProxyForTemplate('template5_2', true),
    };
  }
  if (template === 'template5_3' || template === 'template5.3' || template === 'template53') {
    return {
      template: 'template5_3',
      panelCount: 4,
      noText: true,
      hasVoice: true,
      videoModelKey: '4s',
      useProxy: resolveUseProxyForTemplate('template5_3', true),
    };
  }
  if (template === 'template6' || template === 'template_6') {
    return {
      template: 'template6',
      panelCount: 2,
      noText: true,
      useProxy: resolveUseProxyForTemplate('template6', true),
    };
  }
  // Template 10 — REV4 FINAL: VEO_NATIVE_FAST (2 videos × 8s, evidence-first, native Veo voice)
  if (template === 'template10' || template === 'template_10') {
    return {
      template: 'template10',
      panelCount: 2,               // 2 videos x 8s (covering 4 panels)
      noText: true,
      hasVoice: true,              // Veo native voice in each 8s video
      videoModelKey: 'abra_i2v_8s', // Same model as template5_2
      cropPercent: 0.12,           // Same white border crop as template5_2
      qualityMode: 'VEO_NATIVE_FAST_2x8s',
      voiceMode: 'VEO_NATIVE_FAST',
      useProxy: resolveUseProxyForTemplate('template10', true),
    };
  }

  // Template Pro & Testing — Interactive Storyboard Remake Workflow (Direct, không cần proxy cho video gen)
  if (template === 'template_pro' || template === 'templatepro' || template === 'tpro' || template === 'testing' || template === 'template_testing' || template === 'ttest') {
    return {
      template: 'template_pro',
      panelCount: 2,
      noText: true,
      hasVoice: true,
      videoModelKey: 'abra_i2v_8s',
      interactiveStoryboard: true,
      cropPercent: 0,
      preserveBorder: true,
      useProxy: resolveUseProxyForTemplate('template_pro', false),
    };
  }

  // Template Mom — Mother & Baby Commerce Interactive Storyboard
  if (template === 'template_mom' || template === 'templatemom' || template === 'tmom') {
    return {
      template: 'template_mom',
      panelCount: 2,
      noText: true,
      hasVoice: true,
      videoModelKey: 'abra_r2v_4s',
      interactiveStoryboard: true,
      cropPercent: 0,
      preserveBorder: true,
      useProxy: resolveUseProxyForTemplate('template_mom', true),
    };
  }

  // Template Food — Food & Beverage Review 24s Interactive Storyboard (4 panels)
  if (template === 'template_food' || template === 'templatefood' || template === 'tfood') {
    return {
      template: 'template_food',
      panelCount: 4,
      noText: true,
      hasVoice: true,
      videoModelKey: 'veo_3_1_i2v_lite_low_priority',
      interactiveStoryboard: true,
      cropPercent: 0,
      preserveBorder: true,
      useProxy: resolveUseProxyForTemplate('template_food', true),
    };
  }

  // Template Product — Live-Commerce Presenter Template Pro 40s Native-Voice (Direct, không cần proxy cho video gen)
  if (template === 'template_product' || template === 'templateproduct' || template === 'tproduct' || template === 'tpro40nv') {
    return {
      template: 'template_product',
      panelCount: 5,
      noText: true,
      hasVoice: false, // NO separate TTS stage
      nativeVoice: true, // Native dialogue/voice directly in Veo
      clipCount: 5,
      clipDuration: 8.0,
      totalTargetDuration: 40.0,
      videoModelKey: 'veo_3_1_i2v_s_lite_8s_low_priority',
      interactiveStoryboard: true,
      cropPercent: 0,
      preserveBorder: true,
      useProxy: resolveUseProxyForTemplate('template_product', false),
    };
  }

  return {
    useProxy: true,
  };
}

module.exports = {
  buildTemplateOptions,
  normalizeTemplateName,
  isProxyEnabledForTemplate,
};
