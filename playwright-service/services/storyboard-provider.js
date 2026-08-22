const path = require('path');

const aistudio = require('./aistudio');
const geminiWebapi = require('./gemini-webapi-storyboard');
const googleFlow = require('./google-flow-storyboard');
const { getConfig } = require('../utils/config-manager');

function getStoryboardProvider(baseDir = path.resolve(__dirname, '..'), options = {}) {
  const config = getConfig(baseDir);
  const template = String(options.template || options.storyboardTemplate || '').trim().toLowerCase();

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
