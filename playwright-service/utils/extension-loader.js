const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config-manager');

const config = getConfig(path.resolve(__dirname, '..'));
const EXTENSION_ID = config.systemSettings.chromeExtensionId || 'jmobnhoghinjlmjogafjadohcmdebbej';

function getExtensionPath(baseDir = path.resolve(__dirname, '..')) {
  return path.join(baseDir, 'extension');
}

function getExtensionArgs(baseDir = path.resolve(__dirname, '..')) {
  if (String(process.env.DISABLE_EXTENSION || '').toLowerCase() === 'true') {
    return [];
  }

  const extensionPath = getExtensionPath(baseDir);
  const manifestPath = path.join(extensionPath, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    console.log(`[Extension] Not loaded. Missing manifest: ${manifestPath}`);
    return [];
  }

  console.log(`[Extension] Loading unpacked extension: ${extensionPath}`);
  return [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ];
}

module.exports = {
  EXTENSION_ID,
  getExtensionPath,
  getExtensionArgs,
};
