const assert = require('assert');
const path = require('path');
const fs = require('fs');

const { getChannelProfile } = require('../utils/config-manager');
const {
  getCanonicalPresenterBuffer,
  buildDynamicVoiceBible,
  buildProductIntelligencePromptA,
  buildScriptAndStoryboardPromptB,
  buildProductVideoInlineKeyboard,
} = require('../services/template-product-storyboard');
const { buildFoodVideoInlineKeyboard } = require('../services/template-food-storyboard');
const { buildProVideoInlineKeyboard } = require('../services/template-pro-storyboard');

const baseDir = path.resolve(__dirname, '..');

console.log('═══════════════════════════════════════════════════════════════════════════');
console.log('🧪 TEST: CHANNEL GENDER & PANEL DOWNLOAD FUNCTIONALITY');
console.log('═══════════════════════════════════════════════════════════════════════════');

// Test 1: Channel profile lookup for Shop Giày Nam
console.log('\n--- Test 1: Channel Profile for Shop Giày Nam (-5593429194) ---');
const maleProfile = getChannelProfile(baseDir, '-5593429194');
assert.strictEqual(maleProfile.gender, 'male', 'Shop Giày Nam must have male gender');
assert.strictEqual(maleProfile.audience, 'anh em', 'Shop Giày Nam must address audience as "anh em"');
console.log('✅ Shop Giày Nam profile verified:', maleProfile);

// Test 2: Channel profile fallback/neutral/female
console.log('\n--- Test 2: Channel Profile for Giày Nữ (-5593403910) & Gia dụng (-5348767040) ---');
const femaleProfile = getChannelProfile(baseDir, '-5593403910');
assert.strictEqual(femaleProfile.gender, 'female', 'Shop Giày Nữ must have female gender');
assert.strictEqual(femaleProfile.audience, 'chị em', 'Shop Giày Nữ must address audience as "chị em"');
console.log('✅ Shop Giày Nữ profile verified:', femaleProfile);

const neutralProfile = getChannelProfile(baseDir, '-5348767040');
assert.strictEqual(neutralProfile.gender, 'neutral', 'Gia dụng must have neutral gender');
console.log('✅ Gia dụng profile verified:', neutralProfile);

// Test 3: Presenter asset selection by Gender
console.log('\n--- Test 3: Canonical Presenter Asset Selection by Gender ---');
const malePresenter = getCanonicalPresenterBuffer({ baseDir, channelProfile: maleProfile });
assert.ok(malePresenter && Buffer.isBuffer(malePresenter.buffer), 'Male presenter buffer must exist');
assert.ok(malePresenter.buffer.length > 50000, `Male presenter buffer size must be valid (${malePresenter.buffer.length} bytes)`);
assert.strictEqual(malePresenter.filename, 'presenter_male.png', 'Should select presenter_male.png');
console.log(`✅ Selected male presenter model: ${malePresenter.filename} (${malePresenter.buffer.length} bytes)`);

const femalePresenter = getCanonicalPresenterBuffer({ baseDir, channelProfile: femaleProfile });
assert.ok(femalePresenter && Buffer.isBuffer(femalePresenter.buffer), 'Female presenter buffer must exist');
console.log(`✅ Selected female presenter model: ${femalePresenter.filename} (${femalePresenter.buffer.length} bytes)`);

// Test 4: Voice bible and prompt address constraints
console.log('\n--- Test 4: Voice Bible & Prompt Address Constraints for Male Channel ---');
const maleBible = buildDynamicVoiceBible(maleProfile);
assert.strictEqual(maleBible.gender, 'male', 'Voice bible gender must be male');
assert.strictEqual(maleBible.audienceAddress, 'anh em', 'Voice bible audienceAddress must be "anh em"');
assert.ok(maleBible.speaker.includes('male presenter'), 'Voice bible speaker must indicate male presenter');
console.log('✅ Male voice bible strictly configured for male presenter and "anh em"');

const promptA = buildProductIntelligencePromptA({ product_name: 'Giày Tây Oxford Nam' }, maleProfile);
assert.ok(promptA.includes('anh em'), 'Prompt A must instruct to address "anh em"');
assert.ok(promptA.includes('NEVER USE "chị em"'), 'Prompt A must explicitly forbid "chị em"');
console.log('✅ Prompt A for male channel includes strict gender rules');

const promptB = buildScriptAndStoryboardPromptB({ product_name: 'Giày Tây Oxford Nam' }, { channelProfile: maleProfile });
assert.ok(promptB.includes('anh em'), 'Prompt B must instruct to address "anh em"');
assert.ok(promptB.includes('canonical male reviewer model'), 'Prompt B must specify male reviewer model');
console.log('✅ Prompt B for male channel specifies male reviewer and audience');

// Test 5: Panel Download button present in all 3 templates
console.log('\n--- Test 5: Panel Download Keyboard Buttons across Templates ---');
const runId = 'test-run-panels-123';

const tproKb = buildProVideoInlineKeyboard(runId);
const tproButtons = tproKb.inline_keyboard.flat();
const tproDl = tproButtons.find(b => b.callback_data === `tpro_download_panels:${runId}`);
assert.ok(tproDl, 'Template Pro video keyboard must include panel download button');
assert.strictEqual(tproDl.text, '📦 Tải các Video Panel');
console.log('✅ Template Pro keyboard contains "📦 Tải các Video Panel"');

const tfoodKb = buildFoodVideoInlineKeyboard(runId);
const tfoodButtons = tfoodKb.inline_keyboard.flat();
const tfoodDl = tfoodButtons.find(b => b.callback_data === `tfood_download_panels:${runId}`);
assert.ok(tfoodDl, 'Template Food video keyboard must include panel download button');
assert.strictEqual(tfoodDl.text, '📦 Tải các Video Panel');
console.log('✅ Template Food keyboard contains "📦 Tải các Video Panel"');

const tprodKb = buildProductVideoInlineKeyboard(runId);
const tprodButtons = tprodKb.inline_keyboard.flat();
const tprodDl = tprodButtons.find(b => b.callback_data === `tprod_download_panels:${runId}`);
assert.ok(tprodDl, 'Template Product video keyboard must include panel download button');
assert.strictEqual(tprodDl.text, '📦 Tải các Video Panel');
console.log('✅ Template Product keyboard contains "📦 Tải các Video Panel"');

console.log('\n═══════════════════════════════════════════════════════════════════════════');
console.log('🎉 ALL CHANNEL GENDER & PANEL DOWNLOAD VERIFICATION TESTS PASSED 100%!');
console.log('═══════════════════════════════════════════════════════════════════════════');
