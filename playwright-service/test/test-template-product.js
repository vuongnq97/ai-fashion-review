'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const { normalizeTemplateName, buildTemplateOptions } = require('../services/template-options');
const { getStoryboardProvider } = require('../services/storyboard-provider');
const {
  DEFAULT_GLOBAL_VOICE_BIBLE,
  DEFAULT_GLOBAL_VISUAL_BIBLE,
  buildTemplateProductAnalysisPrompt,
  validateTemplateProductScript,
  buildTemplateProductMasterPrompt,
  buildTemplateProduct8sVideoPrompt,
  buildTemplateProduct8sVideoPrompts,
  sliceMasterStoryboardProduct,
  composeMasterStoryboardProduct,
  concat5NativeAudioClips,
  buildProductInlineKeyboard,
  buildProductVideoInlineKeyboard,
  finalizeProductStoryboardAndGenerateVideos,
  executeProductRemakeSingleVideo,
  buildTemplateProductRemakeVideoJobs,
  stripUnverifiedClaims,
  buildSafeLibraryHookOpening,
  createProductInputCollage,
  createProductInputCollages,
  buildTemplateProductRemakeAllPrompt,
} = require('../services/template-product-storyboard');
const { registerExternalCompletedJob, getLatestCompletedJobForChat, generationJobService } = require('../services/generation-job');

console.log('═══════════════════════════════════════════════════════════════════');
console.log('🧪 TEST SUITE: LIVE-COMMERCE PRESENTER TEMPLATE PRO (/tproduct, 5x8s / 40s)');
console.log('═══════════════════════════════════════════════════════════════════\n');

// ── Test 1: Template Options & Provider Resolution ────────────────────────────
console.log('--- Test 1: Template Options & Provider Resolution for tproduct ---');
assert.strictEqual(normalizeTemplateName('tproduct'), 'template_product');
assert.strictEqual(normalizeTemplateName('template_product'), 'template_product');
assert.strictEqual(normalizeTemplateName('templateproduct'), 'template_product');
assert.strictEqual(normalizeTemplateName('tpro40nv'), 'template_product');

const opts = buildTemplateOptions('tproduct');
assert.strictEqual(opts.template, 'template_product');
assert.strictEqual(opts.panelCount, 5);
assert.strictEqual(opts.clipDuration, 8.0);
assert.strictEqual(opts.totalTargetDuration, 40.0);
assert.strictEqual(opts.videoModelKey, 'veo_3_1_i2v_s_lite_8s_low_priority');
assert.strictEqual(opts.nativeVoice, true);
assert.strictEqual(opts.interactiveStoryboard, true);
console.log('✅ Template options verified for tproduct (5 panels, 8s clips, total 40s, veo_3_1_i2v_s_lite_8s_low_priority, nativeVoice: true)');

const provider = getStoryboardProvider(path.resolve(__dirname, '..'), { template: 'tproduct' });
assert.strictEqual(provider.name, 'template_product');
console.log('✅ Storyboard provider successfully resolved to:', provider.name);

// ── Test 2: Canonical Model Asset Verification ────────────────────────────────
console.log('\n--- Test 2: Canonical Presenter Model Asset Verification ---');
const baseDir = path.resolve(__dirname, '..');
const canonicalAssetPath = path.join(baseDir, 'assets/tproduct/presenter.png');
const docsModelPath = path.resolve(__dirname, '../../docs/tproduct/modal.png');

assert.ok(fs.existsSync(canonicalAssetPath), `Canonical model asset must exist at ${canonicalAssetPath}`);
if (fs.existsSync(docsModelPath)) {
  const assetStat = fs.statSync(canonicalAssetPath);
  const docsStat = fs.statSync(docsModelPath);
  assert.strictEqual(assetStat.size, docsStat.size, 'Canonical asset should match docs/tproduct/modal.png');
  console.log(`✅ Presenter asset verified: ${canonicalAssetPath} (${(assetStat.size / 1024 / 1024).toFixed(2)} MB) matches docs/tproduct/modal.png`);
} else {
  console.log(`✅ Presenter asset exists at: ${canonicalAssetPath}`);
}

// ── Test 3: Analysis Prompt Construction & Constraints ───────────────────────
console.log('\n--- Test 3: Analysis Prompt Construction & Persona Constraints ---');
const analysisPrompt = buildTemplateProductAnalysisPrompt({
  productTitle: 'Son Thỏi Lì Siêu Mịn Môi Velvet Matte',
  productDescription: 'Chất son nhung mịn lì như bơ, giữ màu suốt 12 tiếng, không gây khô môi, bảng màu thời thượng',
  salesMode: 'BENEFIT_LED',
});

assert.ok(analysisPrompt.includes('5 CLIPS × 8 SECONDS') || analysisPrompt.includes('5 CLIPS × 8 GIÂY'), 'Prompt must specify 5 clips x 8s');
assert.ok(analysisPrompt.includes('180 to 200 words') || analysisPrompt.includes('185 to 200 words') || analysisPrompt.includes('185 ĐẾN 200 TỪ'), 'Prompt must specify word budget');
assert.ok(analysisPrompt.includes('NATIVE AUDIO') || analysisPrompt.includes('NATIVE VEO DIALOGUE'), 'Prompt must mandate Native Veo dialogue');
assert.ok(analysisPrompt.includes('BENEFIT_LED'), 'Prompt must reflect selected sales mode');
assert.ok(analysisPrompt.includes('VOICE BIBLE') || analysisPrompt.includes('voiceBible'), 'Prompt must embed Voice Bible');
console.log('✅ Analysis prompt enforces 5x8s timing, 180-200 word budget, Native Voice, and Voice Bible');

// ── Test 4: Script Validation Gate & Speech Continuity ───────────────────────
console.log('\n--- Test 4: Script Validation Gate & Speech Continuity ---');
const sampleValidAnalysis = {
  productName: 'Son Thỏi Velvet Matte',
  salesMode: 'BENEFIT_LED',
  voiceBible: DEFAULT_GLOBAL_VOICE_BIBLE,
  visualBible: DEFAULT_GLOBAL_VISUAL_BIBLE,
  clips: [
    {
      clipIndex: 1,
      name: 'HOOK + PRODUCT INTRO',
      duration: 8,
      voiceOver: 'Chị em nào đang tìm cây son vừa lì vừa mềm môi không khô nẻ thì dừng lại xem ngay cây son này nha. Cầm chắc tay cực kỳ mà màu lên môi chuẩn nét lắm nè.',
      visualPrompt: 'Young Vietnamese female presenter holds velvet lipstick up to camera in bright studio setting, smiling with friendly expression.',
      beats: [
        { beat: 'A', timing: '0-4s', action: 'Direct eye contact hook' },
        { beat: 'B', timing: '4-8s', action: 'Lift lipstick toward camera' },
      ],
    },
    {
      clipIndex: 2,
      name: 'DEAL / VALUE BUILD',
      duration: 8,
      voiceOver: 'Hôm nay trên live giá sale độc quyền giảm tới nửa giá luôn các tình yêu ơi. Vừa được freeship lại còn được tặng kèm tẩy trang môi mini xinh xỉu.',
      visualPrompt: 'Presenter gestures enthusiastically toward the product offer display on desk.',
      beats: [
        { beat: 'A', timing: '0-4s', action: 'Deal framing' },
        { beat: 'B', timing: '4-8s', action: 'Show bonus mini gift' },
      ],
    },
    {
      clipIndex: 3,
      name: 'OFFER BRIDGE + CTA',
      duration: 8,
      voiceOver: 'Số lượng deal sốc trong giỏ hàng góc trái có hạn thôi nên nàng nào ưng màu nào thì nhấn tay rinh ngay kẻo hết mã giảm giá của live nha.',
      visualPrompt: 'Presenter points toward bottom-left basket icon with warm inviting gesture.',
      beats: [
        { beat: 'A', timing: '0-4s', action: 'Urgency bridge' },
        { beat: 'B', timing: '4-8s', action: 'Pointing to cart' },
      ],
    },
    {
      clipIndex: 4,
      name: 'PRODUCT PROOF / DEMO',
      duration: 8,
      voiceOver: 'Chất son mịn như bơ thoa lên môi nhẹ tênh không hề lộ vân môi chút nào. Thử bặm ra khăn giấy mà không dính một tẹo nào luôn nhé cả nhà.',
      visualPrompt: 'Close-up texture swatch test on back of hand, smooth velvety application.',
      beats: [
        { beat: 'A', timing: '0-4s', action: 'Texture demonstration' },
        { beat: 'B', timing: '4-8s', action: 'Transfer-proof check' },
      ],
    },
    {
      clipIndex: 5,
      name: 'BENEFIT + CLOSE',
      duration: 8,
      voiceOver: 'Màu tôn da đỉnh chóp đi tiệc hay đi làm đều xinh lung linh luôn. Tranh thủ chốt đơn liền tay kẻo lỡ deal hời nhất ngày hôm nay nha mọi người.',
      visualPrompt: 'Presenter shows final confident look with lipstick, friendly sign-off smile.',
      beats: [
        { beat: 'A', timing: '0-4s', action: 'Benefit recap' },
        { beat: 'B', timing: '4-8s', action: 'Final sign-off' },
      ],
    },
  ],
};

const validation = validateTemplateProductScript(sampleValidAnalysis);
assert.strictEqual(validation.valid, true, `Validation failed: ${validation.errors.join(', ')}`);
console.log(`✅ Valid live-commerce script passed validation gate (${validation.totalWords} words total)`);

// Test invalid script: only 4 clips
const invalidClips = { ...sampleValidAnalysis, clips: sampleValidAnalysis.clips.slice(0, 4) };
const invalidRes = validateTemplateProductScript(invalidClips);
assert.strictEqual(invalidRes.valid, false);
assert.ok(invalidRes.errors.some(e => e.includes('chính xác 5 clip') || e.includes('5 clip') || e.includes('exactly 5 clips')));
console.log('✅ Correctly rejected script with != 5 clips');

// Test invalid speech boundary: ending with incomplete clause / comma
const badPunctuationClips = JSON.parse(JSON.stringify(sampleValidAnalysis));
badPunctuationClips.clips[0].voiceOver = 'Chị em nào đang tìm cây son vừa lì vừa mềm môi không khô nẻ thì dừng lại xem ngay,';
const badPuncRes = validateTemplateProductScript(badPunctuationClips);
assert.strictEqual(badPuncRes.valid, false);
assert.ok(badPuncRes.errors.some(e => e.includes('complete sentence boundary')));
console.log('✅ Correctly rejected clip lacking complete sentence punctuation boundary');

// ── Test 5: Master Storyboard Prompt & Action Runway ──────────────────────────
console.log('\n--- Test 5: Master Storyboard Prompt & Action Runway ---');
const masterPrompt = buildTemplateProductMasterPrompt(sampleValidAnalysis, {
  productContext: { productTitle: 'Son Thỏi Velvet Matte' },
});

assert.ok(masterPrompt.includes('5-panel') || masterPrompt.includes('5 panels'), 'Master prompt must specify 5 panels');
assert.ok(masterPrompt.includes('MODEL REFERENCE') || masterPrompt.includes('CRITICAL IDENTITY REQUIREMENT'), 'Master prompt must lock presenter identity');
assert.ok(masterPrompt.includes('Action Runway'), 'Master prompt must mandate Action Runway');
assert.ok(masterPrompt.includes('Panel 1') || masterPrompt.includes('PANEL 1'), 'Panel 1 description must exist');
assert.ok(masterPrompt.includes('Panel 5') || masterPrompt.includes('PANEL 5'), 'Panel 5 description must exist');
assert.ok(masterPrompt.includes('ABSOLUTELY ZERO TEXT'), 'Master prompt must enforce zero text');
assert.ok(masterPrompt.includes('shopping cart icon'), 'Master prompt must strictly negate shopping cart icons in negative prompt');
assert.ok(!masterPrompt.includes('indicating the shopping cart button'), 'Master prompt must not instruct drawing a cart button');
console.log('✅ Master Storyboard prompt strictly enforces 5 panels, locked model identity, Action Runway, zero-text, and zero-cart constraints');

// ── Test 6: Veo 8s Video Prompts with Native Dialogue ─────────────────────────
console.log('\n--- Test 6: Veo 8s Video Prompts & Native Audio Dialogue ---');
const videoPrompts = buildTemplateProduct8sVideoPrompts(sampleValidAnalysis);
assert.strictEqual(videoPrompts.length, 5, 'Must produce exactly 5 video prompts');

for (let i = 0; i < 5; i++) {
  const p = videoPrompts[i];
  assert.strictEqual(p.sceneNumber, i + 1);
  assert.strictEqual(p.targetDuration, 8.0);
  assert.ok(p.prompt.includes('AUDIO & DIALOGUE') || p.prompt.includes('AUDIO / DIALOGUE'), `Clip ${i + 1} prompt must have Native Audio section`);
  assert.ok(p.prompt.includes(sampleValidAnalysis.clips[i].voiceOver), `Clip ${i + 1} must include exact dialogue`);
  assert.ok(!p.prompt.toLowerCase().includes('silent scene'), `Clip ${i + 1} prompt MUST NOT contain "silent scene"`);
  assert.ok(!p.prompt.toLowerCase().includes('no dialogue'), `Clip ${i + 1} prompt MUST NOT contain "no dialogue"`);
}
console.log('✅ Generated 5 Veo 8s video prompts with Native Audio Dialogue and zero "silent scene" clauses');

// ── Test 7: Telegram Keyboards & Callback Patterns ────────────────────────────
console.log('\n--- Test 7: Telegram Keyboards & Callback Patterns ---');
const testRunId = 'run-12345';
const storyboardKeyboard = buildProductInlineKeyboard(testRunId);
assert.ok(storyboardKeyboard.inline_keyboard.length >= 3);
// Check panel remake buttons
const row1 = storyboardKeyboard.inline_keyboard[0];
assert.strictEqual(row1[0].callback_data, `tprod_remake:1:${testRunId}`);
assert.strictEqual(row1[1].callback_data, `tprod_remake:2:${testRunId}`);
assert.strictEqual(row1[2].callback_data, `tprod_remake:3:${testRunId}`);
const row2 = storyboardKeyboard.inline_keyboard[1];
assert.strictEqual(row2[0].callback_data, `tprod_remake:4:${testRunId}`);
assert.strictEqual(row2[1].callback_data, `tprod_remake:5:${testRunId}`);
assert.strictEqual(row2[2].callback_data, `tprod_remake_all:${testRunId}`);
const row3 = storyboardKeyboard.inline_keyboard[2];
assert.strictEqual(row3[0].callback_data, `tprod_ok:${testRunId}`);
console.log('✅ Storyboard inline keyboard contains all 5 panel remake buttons, remake all, and OK to generate');

const videoKeyboard = buildProductVideoInlineKeyboard(testRunId);
assert.ok(videoKeyboard.inline_keyboard.length >= 5);
const vRow1 = videoKeyboard.inline_keyboard[0];
assert.strictEqual(vRow1[0].callback_data, `tprod_remake_video:1:${testRunId}`);
assert.strictEqual(vRow1[1].callback_data, `tprod_remake_video:2:${testRunId}`);
const vRow2 = videoKeyboard.inline_keyboard[1];
assert.strictEqual(vRow2[0].callback_data, `tprod_remake_video:3:${testRunId}`);
assert.strictEqual(vRow2[1].callback_data, `tprod_remake_video:4:${testRunId}`);
const vRow3 = videoKeyboard.inline_keyboard[2];
assert.strictEqual(vRow3[0].callback_data, `tprod_remake_video:5:${testRunId}`);
const vRow4 = videoKeyboard.inline_keyboard[3];
assert.strictEqual(vRow4[0].callback_data, `tprod_download_panels:${testRunId}`);
const vRow5 = videoKeyboard.inline_keyboard[4];
assert.strictEqual(vRow5[0].callback_data, `tprod_upload:${testRunId}`);
console.log('✅ Video inline keyboard contains all 5 video scene remake buttons, download panels, and TikTok upload callback');

// Verify strict <= 64 bytes constraint even with extra long Telegram jobId
const longTelegramJobId = 'tg_-5424522541_1735805352820967073_1789435521690';
const longSbKb = buildProductInlineKeyboard(longTelegramJobId);
for (const row of longSbKb.inline_keyboard) {
  for (const btn of row) {
    const bytes = Buffer.byteLength(btn.callback_data, 'utf8');
    assert.ok(bytes <= 64, `Storyboard button ${btn.text} callback_data must be <= 64 bytes, got ${bytes}: ${btn.callback_data}`);
  }
}
const longVidKb = buildProductVideoInlineKeyboard(longTelegramJobId);
for (const row of longVidKb.inline_keyboard) {
  for (const btn of row) {
    const bytes = Buffer.byteLength(btn.callback_data, 'utf8');
    assert.ok(bytes <= 64, `Video button ${btn.text} callback_data must be <= 64 bytes, got ${bytes}: ${btn.callback_data}`);
  }
}
console.log('✅ All inline keyboard callbacks guaranteed <= 64 bytes for Telegram compliance');

// ── Test 8: FFmpeg Storyboard Slicing & Composing (5 panels) ─────────────────
console.log('\n--- Test 8: FFmpeg Storyboard Slicing & Composing (1920x1080 & 1376x768) ---');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-product-'));
const mockMasterPath = path.join(tmpDir, 'master.png');
const panelsDir = path.join(tmpDir, 'panels');
fs.mkdirSync(panelsDir, { recursive: true });

// 8.1 Test slicing standard 1920x1080
execSync(
  `"${ffmpegPath}" -y -f lavfi -i "color=c=black:s=1920x1080:d=1" -vframes 1 "${mockMasterPath}"`,
  { stdio: 'pipe' }
);
assert.ok(fs.existsSync(mockMasterPath), 'Master mock image created');

function getImageInfo(p) {
  try { execSync(`"${ffmpegPath}" -i "${p}"`, { encoding: 'utf8', stdio: 'pipe' }); return ''; }
  catch (err) { return (err.stderr || '') + (err.stdout || ''); }
}

const slicedPanels = sliceMasterStoryboardProduct(mockMasterPath, panelsDir);
assert.strictEqual(slicedPanels.length, 5, 'Must produce 5 sliced panels');
for (let i = 0; i < 5; i++) {
  assert.ok(fs.existsSync(slicedPanels[i]), `Panel ${i + 1} must exist at ${slicedPanels[i]}`);
  const dims = getImageInfo(slicedPanels[i]);
  assert.ok(dims.includes('384x1080'), `Panel ${i + 1} must keep native resolution 384x1080 (no stretching)`);
}
console.log('✅ Successfully sliced 1920x1080 master into 5 panels (native 384x1080, zero distortion)');

// 8.2 Test slicing Google Flow 1376x768 output
const mockFlow169Path = path.join(tmpDir, 'flow-1376x768.png');
const flowPanelsDir = path.join(tmpDir, 'flow-panels');
fs.mkdirSync(flowPanelsDir, { recursive: true });
execSync(
  `"${ffmpegPath}" -y -f lavfi -i "color=c=red:s=1376x768:d=1" -vframes 1 "${mockFlow169Path}"`,
  { stdio: 'pipe' }
);
const flowSliced = sliceMasterStoryboardProduct(mockFlow169Path, flowPanelsDir);
assert.strictEqual(flowSliced.length, 5, 'Must produce 5 sliced panels from 1376x768');
for (let i = 0; i < 5; i++) {
  assert.ok(fs.existsSync(flowSliced[i]), `Flow panel ${i + 1} must exist at ${flowSliced[i]}`);
  const dims = getImageInfo(flowSliced[i]);
  assert.ok(dims.includes('274x768'), `Flow panel ${i + 1} must keep native resolution 274x768 (no stretching)`);
}
console.log('✅ Successfully sliced 1376x768 Google Flow master into 5 panels (native 274x768, zero distortion)');

const recomposedMasterPath = path.join(tmpDir, 'recomposed-master.png');
composeMasterStoryboardProduct(slicedPanels, recomposedMasterPath);
assert.ok(fs.existsSync(recomposedMasterPath), 'Recomposed master must exist');
console.log('✅ Successfully recomposed 5 panels back into 16:9 Master Storyboard (1920x1080)');

// ── Test 9: Video Concat & 40.0s Target with Native Voice (5x 8s) ─────────────
console.log('\n--- Test 9: Video Concat & 40.0s Target with Native Voice ---');
const mockVideosDir = path.join(tmpDir, 'videos');
fs.mkdirSync(mockVideosDir, { recursive: true });

const mockClipPaths = [];
for (let i = 1; i <= 5; i++) {
  const clipPath = path.join(mockVideosDir, `clip-${i}.mp4`);
  // Generate an 8.0s test MP4 with both video and audio tone
  const freq = 400 + i * 100;
  execSync(
    `"${ffmpegPath}" -y -f lavfi -i "color=c=blue:s=1080x1920:d=8" -f lavfi -i "sine=frequency=${freq}:duration=8" -c:v libx264 -t 8 -c:a aac -b:a 128k -pix_fmt yuv420p "${clipPath}"`,
    { stdio: 'pipe' }
  );
  assert.ok(fs.existsSync(clipPath), `Mock clip ${i} created`);
  mockClipPaths.push(clipPath);
}

const finalVideoPath = path.join(tmpDir, 'final_video.mp4');
concat5NativeAudioClips(mockClipPaths, finalVideoPath);
assert.ok(fs.existsSync(finalVideoPath), `Final video must exist at ${finalVideoPath}`);

// Measure final video duration and check audio presence
const durationStr = execSync(
  `"${ffmpegPath}" -i "${finalVideoPath}" 2>&1 | grep "Duration"`,
  { encoding: 'utf8' }
);
const durMatch = durationStr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
assert.ok(durMatch, 'Must obtain final video duration');
const finalSecs = parseFloat(durMatch[1]) * 3600 + parseFloat(durMatch[2]) * 60 + parseFloat(durMatch[3]);
console.log(`✅ Concatenated 5x 8s clips into final video: ${finalSecs.toFixed(2)}s (Target: 40.0s)`);
assert.ok(Math.abs(finalSecs - 40.0) < 1.0, `Duration ${finalSecs}s should be very close to 40.0s`);

// Verify audio stream exists
const audioStreamCheck = execSync(
  `"${ffmpegPath}" -i "${finalVideoPath}" 2>&1 | grep "Audio:"`,
  { encoding: 'utf8' }
);
assert.ok(audioStreamCheck.includes('Audio: aac'), 'Final video must retain native audio stream');
console.log('✅ Native audio stream preserved cleanly in final video without external TTS muxing');

// ── Test 10: Generation Job Registration & TikTok Lookup ──────────────────────
console.log('\n--- Test 10: Generation Job Registration & TikTok Lookup ---');
const dummyJobId = `tproduct-${testRunId}`;
registerExternalCompletedJob('123456789', {
  jobId: dummyJobId,
  chatId: '123456789',
  runDir: tmpDir,
  finalVideoPath: finalVideoPath,
  videoPath: finalVideoPath,
  status: 'completed',
  productTitle: 'Son Thỏi Lì Velvet Matte',
  productUrl: 'https://vt.tiktok.com/ZS9Bt8ANQrrWb-e1KNu/',
  template: 'template_product',
});

const retrievedJob = generationJobService.getJob(dummyJobId);
assert.ok(retrievedJob, `Job ${dummyJobId} must be retrieved from memory or disk`);
assert.strictEqual(retrievedJob.jobId, dummyJobId);
assert.strictEqual(retrievedJob.status, 'completed');
assert.strictEqual(retrievedJob.videoPath, finalVideoPath);
console.log(`✅ Generation job registered and retrieved successfully for TikTok upload: ${dummyJobId}`);

// Verify remake video jobs building
const remakeJobs = buildTemplateProductRemakeVideoJobs(tmpDir, [2], '', sampleValidAnalysis);
assert.strictEqual(remakeJobs.length, 1);
assert.strictEqual(remakeJobs[0].sceneNumber, 2);
assert.strictEqual(remakeJobs[0].targetDuration, 8.0);
console.log('✅ buildTemplateProductRemakeVideoJobs correctly isolates Scene 2 remake');

// ── Test 11: Safe Hook Opening & Strip Unverified Claims Robustness ───────────
console.log('\n--- Test 11: Safe Hook Opening & Strip Unverified Claims Robustness ---');

// Case A: buildSafeLibraryHookOpening for H02 without verified shipping
const hookH02 = { id: 'H02', type: 'price_shipping' };
const hookTextNoShipping = buildSafeLibraryHookOpening(hookH02, 'Xịt tinh dầu ấm VK', {}, 'chị em');
assert.ok(!hookTextNoShipping.includes('miễn phí ship') && !hookTextNoShipping.includes('freeship'), 'H02 without shipping must not claim free shipping');
assert.ok(hookTextNoShipping.includes('Giao hàng đến tận cửa nhà cho mình luôn nè chị em ơi'), 'H02 fallback wording must be clean');

// Case B: stripUnverifiedClaims when unverified claim is at the start of dialogue
const mockScript = [
  {
    clipIndex: 1,
    dialogue: "Miễn phí ship giao hàng đến tận cửa nhà cho mình nữa luôn nè chị em ơi, nguyên một Xịt tinh dầu ấm VK cỏ xạ hương và nghệ như thế này. Em cam kết chất lượng cực kỳ an toàn và lành tính cho làn da."
  }
];
const cleaned = stripUnverifiedClaims(mockScript, { verifiedOffer: {} });
assert.ok(!cleaned[0].dialogue.startsWith(','), 'Dialogue must never start with a comma');
assert.ok(!cleaned[0].dialogue.startsWith(' '), 'Dialogue must not start with whitespace');
assert.strictEqual(cleaned[0].dialogue.charAt(0), cleaned[0].dialogue.charAt(0).toUpperCase(), 'First letter must be capitalized');
assert.ok(cleaned[0].dialogue.startsWith('Nguyên một Xịt tinh dầu ấm VK'), 'Dialogue must cleanly start with capitalized next sentence/clause');
assert.strictEqual(cleaned[0].wordCount, cleaned[0].dialogue.split(/\s+/).filter(Boolean).length, 'wordCount must match cleaned dialogue');

// Case C: buildTemplateProduct8sVideoPrompt defense-in-depth against leading punctuation
const promptWithPunctuation = buildTemplateProduct8sVideoPrompt({}, {
  dialogue: ", nguyên một sản phẩm tuyệt vời như thế này."
});
assert.ok(promptWithPunctuation.includes('She says exactly: "Nguyên một sản phẩm tuyệt vời như thế này."'), 'buildTemplateProduct8sVideoPrompt must sanitize leading punctuation');
console.log('✅ Safe Hook adaptation, stripUnverifiedClaims, and Video Prompt builder correctly prevent leading punctuation and unverified claims');

// Clean up temporary directory
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch (_) {}

// ── Test 12: Multi-Collage Input (input.png & input2.png) for > 8 Product Images ──
console.log('\n--- Test 12: Multi-Collage Input (input.png & input2.png) for > 8 Product Images ---');

// Case A: Create 12 distinct mock images with ffmpeg lavfi
const multiImgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-multi-imgs-'));
const mockPayloads12 = [];
const colors = ['red', 'blue', 'green', 'yellow', 'white', 'gray', 'orange', 'purple', 'cyan', 'magenta', 'brown', 'pink'];
for (let i = 0; i < 12; i++) {
  const p = path.join(multiImgDir, `img_${i + 1}.jpg`);
  execSync(`"${ffmpegPath}" -y -f lavfi -i "color=c=${colors[i]}:s=320x320:d=1" -vframes 1 "${p}"`, { stdio: 'pipe' });
  mockPayloads12.push({
    name: `product_${String(i + 1).padStart(2, '0')}.jpg`,
    path: p,
    mimeType: 'image/jpeg',
  });
}

const collages12 = createProductInputCollages(mockPayloads12);
assert.strictEqual(collages12.uniqueCount, 12, 'Must detect 12 unique images');
assert.ok(Buffer.isBuffer(collages12.input1Buf), 'input1Buf must be a valid Buffer for images 1..8');
assert.ok(collages12.input1Buf.length > 0, 'input1Buf must have non-zero size');
assert.ok(Buffer.isBuffer(collages12.input2Buf), 'input2Buf must be a valid Buffer for images 9..12');
assert.ok(collages12.input2Buf.length > 0, 'input2Buf must have non-zero size');
console.log('✅ createProductInputCollages correctly splits 12 images into input.png (1..8) and input2.png (9..12)');

// Case B: Create 6 mock images (<= 8) -> input2Buf must be null
const collages6 = createProductInputCollages(mockPayloads12.slice(0, 6));
assert.strictEqual(collages6.uniqueCount, 6, 'Must detect 6 unique images');
assert.ok(Buffer.isBuffer(collages6.input1Buf), 'input1Buf must be generated for 6 images');
assert.strictEqual(collages6.input2Buf, null, 'input2Buf must be null when images <= 8');
console.log('✅ createProductInputCollages produces only input.png when product images <= 8');

// Case C: Master Prompt builder with hasInput2: true vs false
const promptWithInput2 = buildTemplateProductMasterPrompt(sampleValidAnalysis, {
  hasInput2: true,
});
assert.ok(promptWithInput2.includes('product reference photos (input.png and input2.png)'), 'Prompt with hasInput2: true must reference both input.png and input2.png');
assert.ok(promptWithInput2.includes('evidenced in input.png or input2.png'), 'Prompt with hasInput2: true must allow evidence from either input');

const promptWithoutInput2 = buildTemplateProductMasterPrompt(sampleValidAnalysis, {
  hasInput2: false,
});
assert.ok(promptWithoutInput2.includes('product reference photo (input.png)'), 'Prompt with hasInput2: false must reference only input.png');
assert.ok(!promptWithoutInput2.includes('input2.png'), 'Prompt with hasInput2: false must not reference input2.png');

// Case D: Remake All Prompt builder with hasInput2 option
const remakeAllWithInput2 = buildTemplateProductRemakeAllPrompt(sampleValidAnalysis, '', { hasInput2: true });
assert.ok(remakeAllWithInput2.includes('product reference photos (input.png and input2.png)'), 'Remake All with hasInput2: true must reference both collages');

try {
  fs.rmSync(multiImgDir, { recursive: true, force: true });
} catch (_) {}
console.log('✅ Multi-Collage input, dual-reference prompt formatting, and Remake All options verified successfully');

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('🎉 ALL 12 TEST SUITES FOR LIVE-COMMERCE PRESENTER TEMPLATE PRO PASSED 100%!');
console.log('═══════════════════════════════════════════════════════════════════\n');
