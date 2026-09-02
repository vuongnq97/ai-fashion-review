const fs = require('fs');
const path = require('path');

/**
 * Loads configuration from config.json with fallback values.
 * @param {string} baseDir Base directory containing config.json.
 */
function getConfig(baseDir = path.resolve(__dirname, '..')) {
  const configPath = path.join(baseDir, 'config.json');
  const defaults = {
    uiSettings: {
      category: "Giày / Sneakers",
      useVietnameseModel: true,
      noTextInImage: true,
      styleCuonHut: true,
      panelCount: 3,
      sceneRatio: "9:16",
      useLocalApi: true,
      localApiUrl: "http://localhost:3000/api/generate-video",
      modelImagePath: ""
    },
    systemSettings: {
      storyboardProvider: "aistudio-playwright",
      aiStudioUrl: "https://aistudio.google.com/apps/67340c71-44d0-4210-a324-33525f7e1ecb?fullscreenApplet=true",
      flowProjectUrl: "https://labs.google/fx/vi/tools/flow/project/8ac10c4a-44b5-4d55-b470-10ab24db4c1c",
      flowProjectId: "8ac10c4a-44b5-4d55-b470-10ab24db4c1c",
      recaptchaSiteKey: "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV",
      chromeExtensionId: "jmobnhoghinjlmjogafjadohcmdebbej"
    },
    dailyVlogSettings: {
      panelCount: 5,
      sceneRatio: "9:16",
      nhiReferencePath: "assets/nhi"
    }
  };

  if (!fs.existsSync(configPath)) {
    return defaults;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      uiSettings: { ...defaults.uiSettings, ...parsed.uiSettings },
      systemSettings: { ...defaults.systemSettings, ...parsed.systemSettings },
      dailyVlogSettings: { ...defaults.dailyVlogSettings, ...parsed.dailyVlogSettings },
      autoT3Settings: { ...(parsed.autoT3Settings || {}) },
      autoT4Settings: { ...(parsed.autoT4Settings || {}) },
      autoT5Settings: { ...(parsed.autoT5Settings || {}) },
      channels: parsed.channels || {},
    };
  } catch (err) {
    console.error(`[ConfigManager] Error reading config.json:`, err.message);
    return { ...defaults, channels: {} };
  }
}

/**
 * Resolve TikTok channel config for a given chatId.
 * Lookup order: exact chatId match → "default" → built-in fallback.
 * @param {string} baseDir
 * @param {string|number} chatId
 * @returns {{ channelId: string, label: string, tiktokCredentialId: string, tiktokCredentialName: string }}
 */
function getChannelForChat(baseDir, chatId) {
  const config = getConfig(baseDir);
  const channels = config.channels || {};
  const key = String(chatId || '');

  const channel = channels[key] || channels['default'] || {};
  return {
    channelId: channels[key] ? key : 'default',
    label: channel.label || 'Shop Chính',
    tiktokCredentialId: channel.tiktokCredentialId || 'cJDNuW2i1tFFXivi',
    tiktokCredentialName: channel.tiktokCredentialName || 'TikTok Credential account',
  };
}

/**
 * Automates setting configuration values on the UI using Playwright.
 * @param {import('playwright').Frame} frame Frame representing the storyboard creator UI applet.
 * @param {string} baseDir Base directory containing config.json.
 */
async function applyConfigToUI(frame, baseDir = path.resolve(__dirname, '..')) {
  console.log('[ConfigManager] Applying settings from config.json to Web UI...');
  const config = getConfig(baseDir);
  const ui = config.uiSettings;

  try {
    // 1. Set Product Category Input
    if (ui.category !== undefined) {
      console.log(`[ConfigManager] Setting Category: "${ui.category}"`);
      const categoryContainer = frame.locator('aside, section').filter({ has: frame.locator('label', { hasText: 'Loại sản phẩm' }) }).first();
      const categoryInput = categoryContainer.locator('input[type="text"]');
      if (await categoryInput.isVisible()) {
        await categoryInput.fill(ui.category);
        await frame.waitForTimeout(200);
      }
    }

    // Helper for switches/toggles
    async function setToggle(labelText, targetState) {
      if (targetState === undefined) return;
      const row = frame.locator('div', { has: frame.locator('span', { hasText: labelText }) }).first();
      const button = row.locator('button');
      if (await button.isVisible()) {
        const isCurrentlyActive = await button.evaluate(el => el.classList.contains('bg-indigo-600'));
        if (isCurrentlyActive !== targetState) {
          console.log(`[ConfigManager] Toggling "${labelText}" to: ${targetState}`);
          await button.click();
          await frame.waitForTimeout(300);
        }
      }
    }

    // 2. Set Model Switches
    await setToggle('Tạo người mẫu Việt', ui.useVietnameseModel);
    await setToggle('Không thêm chữ hình', ui.noTextInImage);
    await setToggle('Phong cách cuốn hút', ui.styleCuonHut);

    // 3. Set Aspect Ratio
    if (ui.sceneRatio) {
      console.log(`[ConfigManager] Setting Aspect Ratio: ${ui.sceneRatio}`);
      const ratioContainer = frame.locator('div', { has: frame.locator('span', { hasText: 'Tỉ lệ Scene' }) }).first();
      const ratioButton = ratioContainer.locator(`button:has-text("${ui.sceneRatio}")`).first();
      if (await ratioButton.isVisible()) {
        await ratioButton.click();
        await frame.waitForTimeout(300);
      }
    }

    // 4. Set Panel Count (Slider)
    if (ui.panelCount !== undefined) {
      console.log(`[ConfigManager] Setting Panel Count: ${ui.panelCount}`);
      const panelContainer = frame.locator('div', { has: frame.locator('span', { hasText: 'Số lượng Panel' }) }).first();
      const slider = panelContainer.locator('input[type="range"]');
      if (await slider.isVisible()) {
        await slider.evaluate((el, val) => {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, String(ui.panelCount));
        await frame.waitForTimeout(300);
      }
    }

    // 5. Set Ngrok/Local API Toggle & URL
    await setToggle('Gọi Ngrok / Local API', ui.useLocalApi);
    if (ui.useLocalApi && ui.localApiUrl) {
      console.log(`[ConfigManager] Setting Local API URL: ${ui.localApiUrl}`);
      const urlContainer = frame.locator('div', { has: frame.locator('label', { hasText: 'URL API của bạn' }) }).first();
      const urlInput = urlContainer.locator('input[type="text"]');
      if (await urlInput.isVisible()) {
        await urlInput.fill(ui.localApiUrl);
        await frame.waitForTimeout(200);
      }
    }

    // 6. Set Model Image
    const modelSection = frame.locator('aside section', { has: frame.locator('label', { hasText: 'Upload Review Model' }) }).first();
    if (await modelSection.isVisible()) {
      const deleteBtn = modelSection.locator('button');
      if (await deleteBtn.isVisible()) {
        console.log('[ConfigManager] Clearing existing model image...');
        await deleteBtn.click();
        await frame.waitForTimeout(300);
      }

      if (ui.modelImagePath) {
        const modelPath = path.resolve(baseDir, ui.modelImagePath);
        if (fs.existsSync(modelPath)) {
          console.log(`[ConfigManager] Uploading model image from: ${modelPath}`);
          const fileInput = modelSection.locator('input[type="file"]');
          await fileInput.setInputFiles(modelPath);
          await frame.waitForTimeout(1500);
        } else {
          console.warn(`[ConfigManager] ⚠️ Model image path not found: ${modelPath}`);
        }
      }
    }

    console.log('[ConfigManager] ✅ Successfully applied all config.json settings to Web UI');
  } catch (error) {
    console.error('[ConfigManager] ❌ Failed to apply settings to Web UI:', error.message);
  }
}

module.exports = {
  getConfig,
  getChannelForChat,
  applyConfigToUI
};
