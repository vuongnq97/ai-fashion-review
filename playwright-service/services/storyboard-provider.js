const path = require('path');

const aistudio = require('./aistudio');
const geminiWebapi = require('./gemini-webapi-storyboard');
const googleFlow = require('./google-flow-storyboard');
const template5 = require('./template5-storyboard');
const template6 = require('./template6-storyboard');
const template10 = require('./template10-storyboard');
const { getConfig } = require('../utils/config-manager');
const { normalizeTemplateName } = require('./template-options');

function getStoryboardProvider(baseDir = path.resolve(__dirname, '..'), options = {}) {
  const config = getConfig(baseDir);
  const rawTemplate = String(options.template || options.storyboardTemplate || '').trim();
  const template = normalizeTemplateName(rawTemplate);

  // Template 10 — QUALITY_LOCKED Atomic Shot (EVIDENCE-FIRST + MASTER NARRATION)
  // Completely isolated pipeline — does NOT touch any template5 / template6 code paths.
  if (template === 'template10' || template === 'template_10') {
    return {
      name: 'template10',
      generateStoryboard: (baseDir, filePayloads, opts = {}) =>
        template10.generateStoryboard(baseDir, filePayloads, { ...opts, template: 'template10' }),
    };
  }

  if (template === 'template6' || template === 'template_6') {
    return {
      name: 'template6',
      generateStoryboard: (baseDir, filePayloads, opts = {}) =>
        template6.generateStoryboard(baseDir, filePayloads, { ...opts, template: 'template6' }),
    };
  }

  if (template === 'template_pro' || template === 'templatepro' || template === 'tpro') {
    return {
      name: 'template_pro',
      generateStoryboard: (baseDir, filePayloads, opts = {}) => {
        const templatePro = require('./template-pro-storyboard');
        return templatePro.generateStoryboard(baseDir, filePayloads, { ...opts, template: 'template_pro' });
      },
    };
  }

  if (template === 'template5' || template === 'template5_1' || template === 'template5.1' || template === 'template51' ||
      template === 'template5_2' || template === 'template5.2' || template === 'template52' ||
      template === 'template5_3' || template === 'template5.3' || template === 'template53') {
    return {
      name: template,
      generateStoryboard: (baseDir, filePayloads, opts = {}) =>
        template5.generateStoryboard(baseDir, filePayloads, { ...opts, template }),
    };
  }

  const provider = String(
    process.env.STORYBOARD_PROVIDER ||
    (template === 'template3' || template === 'template4' ? 'google-flow' : null) ||
    config.systemSettings?.storyboardProvider ||
    'aistudio-playwright'
  ).trim().toLowerCase();

  if (provider === 'google-flow' || provider === 'googleflow' || provider === 'flow') {
    return {
      name: 'google-flow',
      generateStoryboard: googleFlow.generateStoryboard,
    };
  }

  if (provider === 'gemini-webapi' || provider === 'gemini_webapi') {
    return {
      name: 'gemini-webapi',
      generateStoryboard: geminiWebapi.generateStoryboard,
    };
  }

  if (provider === 'aistudio-playwright' || provider === 'aistudio' || provider === 'playwright') {
    return {
      name: 'aistudio-playwright',
      generateStoryboard: aistudio.generateStoryboard,
    };
  }

  throw new Error(`Unknown storyboard provider: ${provider}`);
}

module.exports = {
  getStoryboardProvider,
};
