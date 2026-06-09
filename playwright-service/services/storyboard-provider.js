const path = require('path');

const aistudio = require('./aistudio');
const geminiWebapi = require('./gemini-webapi-storyboard');
const { getConfig } = require('../utils/config-manager');

function getStoryboardProvider(baseDir = path.resolve(__dirname, '..')) {
  const config = getConfig(baseDir);
  const provider = String(
    process.env.STORYBOARD_PROVIDER ||
    config.systemSettings?.storyboardProvider ||
    'aistudio-playwright'
  ).trim().toLowerCase();

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
