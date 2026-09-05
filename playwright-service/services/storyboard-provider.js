const path = require('path');

const aistudio = require('./aistudio');
const geminiWebapi = require('./gemini-webapi-storyboard');
const googleFlow = require('./google-flow-storyboard');
const template5 = require('./template5-storyboard');
const template6 = require('./template6-storyboard');
const { getConfig } = require('../utils/config-manager');
const { normalizeTemplateName } = require('./template-options');

function getStoryboardProvider(baseDir = path.resolve(__dirname, '..'), options = {}) {
  const config = getConfig(baseDir);
  const rawTemplate = String(options.template || options.storyboardTemplate || '').trim();
  const template = normalizeTemplateName(rawTemplate);

  if (template === 'template6' || template === 'template_6') {
    return {
      name: 'template6',
      generateStoryboard: (baseDir, filePayloads, opts = {}) =>
        template6.generateStoryboard(baseDir, filePayloads, { ...opts, template: 'template6' }),
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
