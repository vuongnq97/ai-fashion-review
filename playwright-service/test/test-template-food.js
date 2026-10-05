'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const { normalizeTemplateName, buildTemplateOptions } = require('../services/template-options');
const { getStoryboardProvider } = require('../services/storyboard-provider');
const {
  parseJsonObjectFood,
  validateFoodScript,
  buildTemplateFoodAnalysisPrompt,
  buildTemplateFoodMasterPrompt,
  buildTemplateFoodMultiStoryboardPrompt,
  buildTemplateFoodVerificationPrompt,
  selectBestCandidateForPanel,
  sliceMasterStoryboardFood,
  composeMasterStoryboardFood,
  buildTemplateFoodVideoPrompts,
  buildTemplateFood6sPanelPrompts,
  buildTemplateFoodRemakePrompt,
  buildTemplateFoodRemakeAllPrompt,
  buildTemplateFoodRemakeVideoJobs,
  buildFoodInlineKeyboard,
  buildFoodVideoInlineKeyboard,
  merge4PanelsWithVoice,
  saveFoodSession,
  getFoodSession,
  FOOD_FORM_TAXONOMY,
  classifyReferenceRoles,
  analyzeFoodPhysicalProfile,
  deriveFoodAffordances,
  deriveForbiddenFoodActions,
  chooseHeroInteraction,
  buildProductStateMachine,
  buildFoodReviewWorld,
  buildDynamicPropPlan,
  buildDynamicFourScenePlan,
  validateFoodAction,
  validateBackgroundWorld,
  validateShowSaySync,
} = require('../services/template-food-storyboard');
const {
  buildFoodReviewTtsPrompt,
} = require('../services/gemini-tts');

let ffmpegPath = 'ffmpeg';
try {
  ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
} catch (_) {
  try {
    ffmpegPath = require('/Users/macbook_196/Workspace/something/playwright-service/node_modules/ffmpeg-static') || 'ffmpeg';
  } catch (__) {
    ffmpegPath = 'ffmpeg';
  }
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('🧪 TEST SUITE: FOOD REVIEW TEMPLATE PRO (/tfood, 4x6s / 24s)');
  console.log('═══════════════════════════════════════════════════════════════════');

  // ── TEST 1: Template Options & Provider Resolution ─────────────────────────
  console.log('\n--- Test 1: Template Options & Provider Resolution for tfood ---');
  assert.strictEqual(normalizeTemplateName('tfood'), 'template_food');
  assert.strictEqual(normalizeTemplateName('template_food'), 'template_food');
  assert.strictEqual(normalizeTemplateName('templatefood'), 'template_food');

  const foodOpts = buildTemplateOptions('tfood');
  assert.strictEqual(foodOpts.template, 'template_food');
  assert.strictEqual(foodOpts.interactiveStoryboard, true);
  assert.strictEqual(foodOpts.panelCount, 4);
  assert.strictEqual(foodOpts.hasVoice, true);
  assert.strictEqual(foodOpts.noText, true);
  assert.strictEqual(foodOpts.cropPercent, 0);
  assert.strictEqual(foodOpts.preserveBorder, true);
  assert.strictEqual(foodOpts.videoModelKey, 'veo_3_1_i2v_lite_low_priority');
  console.log('✅ Template options verified for tfood (panelCount: 4, model: veo_3_1_i2v_lite_low_priority)');

  const provider = getStoryboardProvider(path.resolve(__dirname, '..'), { template: 'tfood' });
  assert.strictEqual(provider.name, 'template_food');
  assert.strictEqual(typeof provider.generateStoryboard, 'function');
  console.log('✅ Storyboard provider successfully resolved to: template_food');

  // ── TEST 2: Analysis Prompt Construction & Persona Constraints ────────────
  console.log('\n--- Test 2: Analysis Prompt Construction & Persona Constraints ---');
  const analysisPrompt = buildTemplateFoodAnalysisPrompt({
    productContext: {
      productTitle: 'Bánh pía mini nhân sầu riêng trứng muối',
      productDescription: 'Bánh mềm xốp, nhân trứng muối béo ngậy, ngọt thanh vừa miệng',
    }
  });

  assert.ok(analysisPrompt.includes('Vietnamese short-form food-review strategist'));
  assert.ok(analysisPrompt.includes('FOOD_REVIEWER_PERSONA_V1'));
  assert.ok(analysisPrompt.includes('4 scenes × 6 seconds = 24 seconds total'));
  assert.ok(analysisPrompt.includes('MANDATORY HERO INTERACTION'));
  assert.ok(analysisPrompt.includes('ACTION RUNWAY FOR STORYBOARD'));
  assert.ok(analysisPrompt.includes('Exactly 72 to 82 Vietnamese words'));
  assert.ok(analysisPrompt.includes('Default self-reference is "tui"'));
  assert.ok(analysisPrompt.includes('ABSOLUTELY FORBIDDEN: "siêu phẩm"'));
  console.log('✅ Analysis prompt enforces 4x6s timing, Hero Interaction, Action Runway, and Southern persona constraints');

  // ── TEST 3: Script Validation Gate & Linter ────────────────────────────────
  console.log('\n--- Test 3: Script Validation Gate & Linter ---');

  // 3.1 Hợp lệ
  const validFoodSample = {
    analysis: {
      productName: 'Bánh pía mini sầu riêng trứng muối',
      foodCategory: 'cake',
      heroInteraction: {
        action: 'break_open',
        performedBy: 'reviewer_hand',
        visualTarget: 'phần nhân sầu riêng vàng ươm và trứng muối tan chảy',
        sensoryTarget: 'độ mềm dẻo và ngập tràn nhân',
        shotType: 'close_up',
        scene: 3,
      }
    },
    script: [
      {
        id: 1,
        phase: 'Discovery',
        durationSeconds: 6,
        foodAction: 'Cầm gói bánh pía mini đưa nhẹ trước ống kính',
        voiceOver: 'Lướt thấy món bánh pía mini này nhìn cưng quá nên tui mua ăn thử coi sao nè cả nhà.',
      },
      {
        id: 2,
        phase: 'Show',
        durationSeconds: 6,
        foodAction: 'Lấy một chiếc bánh vàng ươm ra đĩa, xoay nhẹ để thấy lớp vỏ',
        voiceOver: 'Cầm lên tay thấy cái bánh nhỏ nhỏ vừa miệng, lớp vỏ bên ngoài nhìn mềm chứ không bị khô.',
      },
      {
        id: 3,
        phase: 'Experience',
        durationSeconds: 6,
        foodAction: 'Hai tay từ từ bẻ đôi chiếc bánh pía làm lộ rõ phần nhân trứng muối',
        voiceOver: 'Bẻ ra coi cái nhân bên trong nè, trứng muối với sầu riêng khá đầy đặn nhìn dẻo quánh luôn.',
      },
      {
        id: 4,
        phase: 'Verdict',
        durationSeconds: 6,
        foodAction: 'Cầm nửa chiếc bánh giơ cận cảnh kết thúc video',
        voiceOver: 'Vị béo thơm ngọt vừa phải không bị gắt, ăn vặt nhâm nhi thì bá cháy, ai thích thử nghen.',
      }
    ]
  };

  const valRes = validateFoodScript(validFoodSample);
  assert.strictEqual(valRes.valid, true, 'Valid food sample must pass validation');
  assert.strictEqual(valRes.errors.length, 0);
  console.log(`✅ Valid food script passed validation gate (${valRes.wordCount} words)`);

  // 3.2 Bắt lỗi khi thiếu Hero Interaction
  const invalidNoHero = JSON.parse(JSON.stringify(validFoodSample));
  delete invalidNoHero.analysis.heroInteraction;
  const noHeroRes = validateFoodScript(invalidNoHero);
  assert.strictEqual(noHeroRes.valid, false);
  assert.ok(noHeroRes.errors.some(e => e.includes('heroInteraction')));
  console.log('✅ Correctly rejected script missing Hero Interaction');

  // 3.3 Bắt lỗi khi sai số cảnh
  const invalid3Scenes = JSON.parse(JSON.stringify(validFoodSample));
  invalid3Scenes.script.pop();
  const threeScenesRes = validateFoodScript(invalid3Scenes);
  assert.strictEqual(threeScenesRes.valid, false);
  assert.ok(threeScenesRes.errors.some(e => e.includes('4 cảnh')));
  console.log('✅ Correctly rejected script with != 4 scenes');

  // 3.4 Linter cảnh báo hư từ và từ ngữ quảng cáo
  const spamSalesSample = JSON.parse(JSON.stringify(validFoodSample));
  spamSalesSample.script[3].voiceOver = 'Siêu phẩm cực đỉnh chốt đơn mua ngay kẻo hết nè nha nghen á ha nè nha nghen á.';
  const salesRes = validateFoodScript(spamSalesSample);
  assert.ok(salesRes.warnings.some(w => w.includes('WARN_SALESY_LANGUAGE')));
  assert.ok(salesRes.warnings.some(w => w.includes('WARN_PARTICLE_OVERUSE')));
  console.log('✅ Linter triggered warnings for salesy hype copy and particle stuffing');

  // ── TEST 4: Master Storyboard Prompt & Action Runway ───────────────────────
  console.log('\n--- Test 4: Master Storyboard Prompt & Action Runway ---');
  const masterPrompt = buildTemplateFoodMasterPrompt(validFoodSample.analysis);
  assert.ok(masterPrompt.includes('PANEL 1 (DISCOVERY'));
  assert.ok(masterPrompt.includes('PANEL 2 (SHOW'));
  assert.ok(masterPrompt.includes('PANEL 3 (HERO INTERACTION WITH ACTION RUNWAY'));
  assert.ok(masterPrompt.includes('PANEL 4 (VERDICT'));
  assert.ok(masterPrompt.includes('FOOD REVIEW WORLD (LIFESTYLE TEA & SNACK SETTING): Authentic lived-in Vietnamese home'));
  assert.ok(masterPrompt.includes('white roses'));
  assert.ok(masterPrompt.includes('lucky bamboo'));
  assert.ok(masterPrompt.includes('honey-oak'));
  assert.ok(masterPrompt.includes('MANDATORY ACTION RUNWAY: ACTION RUNWAY (BREAK OPEN): Hands placed on opposite sides'));
  assert.ok(masterPrompt.includes('Do NOT show the food completely finished or broken apart yet'));
  console.log('✅ Master Storyboard prompt strictly enforces 4 panels, Tạp Hoá Cóc tea & snack world, and Action Runway rule');

  // ── TEST 5: Video Prompts for Veo 3 (Video Prompt v3 & Full-Bleed 9:16 Canvas) ──
  console.log('\n--- Test 5: Veo 3 Video Prompts & Full-Bleed 9:16 Canvas ---');
  const videoPrompts = buildTemplateFoodVideoPrompts(validFoodSample.analysis);
  assert.strictEqual(videoPrompts.length, 4);
  assert.ok(videoPrompts[0].includes('Animate this Start Frame into a realistic 6-second smartphone food-review video filling the full 9:16 vertical smartphone frame edge-to-edge'));
  assert.ok(videoPrompts[0].includes('PRIMARY ACTION:'));
  assert.ok(videoPrompts[0].includes('PRODUCT STATE TRANSITION:'));
  assert.ok(videoPrompts[0].includes('HAND MOTION:'));
  assert.ok(videoPrompts[0].includes('BACKGROUND & CANVAS:'));
  assert.ok(videoPrompts[0].includes('STRICTLY NO black bars, NO pillarboxing, NO letterboxing, NO side borders'));
  assert.ok(videoPrompts[2].includes('PRIMARY ACTION:'));
  assert.ok(videoPrompts[2].includes('break') || videoPrompts[2].includes('pull apart'));
  assert.ok(videoPrompts[2].includes('Silent video'));
  console.log('✅ Generated 4 Veo 3 video prompts in English motion-first syntax with full-bleed 9:16 canvas safety');

  // ── TEST 6: Gemini TTS Director Prompt (24s Audio) ─────────────────────────
  console.log('\n--- Test 6: Gemini TTS Director Prompt ---');
  const ttsObj = buildFoodReviewTtsPrompt(validFoodSample.analysis);
  assert.ok(ttsObj.prompt.includes('AUDIO PROFILE'));
  assert.ok(ttsObj.prompt.includes('You are a young Vietnamese female food reviewer'));
  assert.ok(ttsObj.prompt.includes('Southern Vietnamese with a subtle Mekong Delta flavor'));
  assert.ok(ttsObj.prompt.includes('Pacing: Fast conversational. Target approximately 3.8–4.3 Vietnamese words per second'));
  assert.ok(ttsObj.prompt.includes('around 22.5 to 24.0 seconds'));
  assert.ok(ttsObj.prompt.includes('TRANSCRIPT'));
  console.log('✅ Gemini TTS Director Prompt conforms to Section 29 requirements');

  // ── TEST 7: Telegram Inline Keyboards & Callback Patterns ──────────────────
  console.log('\n--- Test 7: Telegram Keyboards & Callback Patterns ---');
  const sbKb = buildFoodInlineKeyboard('run-food-999');
  const cbDatas = sbKb.inline_keyboard.flat().map(b => b.callback_data);
  assert.ok(cbDatas.includes('tfood_remake:1:run-food-999'));
  assert.ok(cbDatas.includes('tfood_remake:2:run-food-999'));
  assert.ok(cbDatas.includes('tfood_remake:3:run-food-999'));
  assert.ok(cbDatas.includes('tfood_remake:4:run-food-999'));
  assert.ok(cbDatas.includes('tfood_remake_all:run-food-999'));
  assert.ok(cbDatas.includes('tfood_ok:run-food-999'));
  console.log('✅ Storyboard inline keyboard contains all required callback routes');

  const vidKb = buildFoodVideoInlineKeyboard('run-food-999');
  const vidCbDatas = vidKb.inline_keyboard.flat().map(b => b.callback_data);
  assert.ok(vidCbDatas.includes('tfood_remake_video:1:run-food-999'));
  assert.ok(vidCbDatas.includes('tfood_upload:run-food-999'));
  console.log('✅ Video inline keyboard contains remake video and upload callback routes');

  // ── TEST 8: FFmpeg Storyboard Slicing & Composing ──────────────────────────
  console.log('\n--- Test 8: FFmpeg Storyboard Slicing & Composing ---');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-food-'));
  try {
    const dummyMasterPath = path.join(tempDir, 'dummy-master.png');
    // Tạo 1 ảnh 16:9 1920x1080 mẫu
    execSync(`"${ffmpegPath}" -y -f lavfi -i testsrc=size=1920x1080:rate=1 -frames:v 1 "${dummyMasterPath}"`, { stdio: 'pipe' });
    const dummyBuf = fs.readFileSync(dummyMasterPath);

    const slices = sliceMasterStoryboardFood(dummyBuf);
    assert.strictEqual(slices.length, 4, 'Must slice into exactly 4 panels');
    slices.forEach((sBuf, i) => {
      assert.ok(Buffer.isBuffer(sBuf) && sBuf.length > 0, `Panel ${i + 1} buffer must be valid`);
    });
    console.log(`✅ Successfully sliced 16:9 master into 4 panels (each ~480x1080)`);

    const composedPath = path.join(tempDir, 'recomposed-master.png');
    composeMasterStoryboardFood(slices, composedPath);
    assert.ok(fs.existsSync(composedPath), 'Composed master storyboard must exist');
    assert.ok(fs.statSync(composedPath).size > 10000, 'Composed file must have valid size');
    console.log('✅ Successfully recomposed 4 panels back into 16:9 Master Storyboard');
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }

  // ── TEST 9: FFmpeg Video Concatenation & 24s Target ────────────────────────
  console.log('\n--- Test 9: Video Merge & 24.0s Target with Voice Track ---');
  const mergeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-food-merge-'));
  try {
    const dummyVideos = [];
    for (let i = 1; i <= 4; i++) {
      const vPath = path.join(mergeTestDir, `dummy-p${i}.mp4`);
      // Tạo video 6 giây giả lập
      execSync(`"${ffmpegPath}" -y -f lavfi -i testsrc=size=1080x1920:rate=30 -t 6.0 -c:v libx264 -pix_fmt yuv420p "${vPath}"`, { stdio: 'pipe' });
      dummyVideos.push(vPath);
    }
    const dummyVoicePath = path.join(mergeTestDir, 'dummy-voice.m4a');
    // Tạo audio 24 giây giả lập
    execSync(`"${ffmpegPath}" -y -f lavfi -i anullsrc=r=48000:cl=stereo -t 24.0 -c:a aac -b:a 192k "${dummyVoicePath}"`, { stdio: 'pipe' });

    const mergedPath = path.join(mergeTestDir, 'final_video.mp4');
    merge4PanelsWithVoice(dummyVideos, dummyVoicePath, mergedPath);

    assert.ok(fs.existsSync(mergedPath), 'Merged video must exist');
    let probe = '';
    try {
      probe = execSync(`"${ffmpegPath}" -i "${mergedPath}"`, { stdio: 'pipe' }).toString();
    } catch (e) {
      probe = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    }
    const durationMatch = probe.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
    assert.ok(durationMatch, 'Duration must be parseable');
    const durSec = parseFloat(durationMatch[1]) * 3600 + parseFloat(durationMatch[2]) * 60 + parseFloat(durationMatch[3]);
    assert.ok(Math.abs(durSec - 24.0) <= 0.5, `Merged video duration must be ~24.0s (got ${durSec}s)`);
    console.log(`✅ Merged 4x 6s clips + 24s voice track into final 24s video: ${durSec.toFixed(2)}s`);

    // Kiểm tra quy tắc ưu tiên độ dài audio: Audio 26.0s -> Video tự động co giãn đạt ~26.0s
    const dummyVoice26Path = path.join(mergeTestDir, 'dummy-voice-26s.m4a');
    execSync(`"${ffmpegPath}" -y -f lavfi -i anullsrc=r=48000:cl=stereo -t 26.0 -c:a aac -b:a 192k "${dummyVoice26Path}"`, { stdio: 'pipe' });
    const merged26Path = path.join(mergeTestDir, 'final_video_26s.mp4');
    merge4PanelsWithVoice(dummyVideos, dummyVoice26Path, merged26Path);
    let probe26 = '';
    try {
      probe26 = execSync(`"${ffmpegPath}" -i "${merged26Path}"`, { stdio: 'pipe' }).toString();
    } catch (e) {
      probe26 = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    }
    const match26 = probe26.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
    assert.ok(match26, '26s merged video duration must be parseable');
    const dur26Sec = parseFloat(match26[1]) * 3600 + parseFloat(match26[2]) * 60 + parseFloat(match26[3]);
    assert.ok(Math.abs(dur26Sec - 26.0) <= 0.5, `Merged video duration must adapt to 26s audio (got ${dur26Sec}s)`);
    console.log(`✅ Audio priority rule verified: Video automatically adapted to 26s audio (${dur26Sec.toFixed(2)}s)`);
  } finally {
    try { fs.rmSync(mergeTestDir, { recursive: true, force: true }); } catch (_) {}
  }

  // ── TEST 10: Dynamic Food Affordance Engine & Tiny Food Override (Section 8 & 9) ──
  console.log('\n--- Test 10: Dynamic Food Affordance Engine & Tiny Food Override ---');
  const peanutAnalysis = {
    productName: 'Đậu Phộng Da Cá Cốt Dừa',
    foodCategory: 'snack',
    visibleProperties: ['hạt tròn nhỏ', 'lớp vỏ áo nước cốt dừa giòn rụm'],
  };
  const peanutProfile = analyzeFoodPhysicalProfile(peanutAnalysis);
  assert.strictEqual(peanutProfile.unitScale, 'tiny');
  assert.strictEqual(peanutProfile.form, 'nuts_seeds');
  assert.strictEqual(peanutProfile.hasInteriorReveal, false);

  const peanutAffordances = deriveFoodAffordances(peanutProfile);
  assert.ok(['pick', 'rotate', 'show_handful', 'pour'].includes(peanutAffordances.heroAction));

  const peanutForbidden = deriveForbiddenFoodActions(peanutProfile);
  assert.ok(peanutForbidden.includes('break'));
  assert.ok(peanutForbidden.includes('squeeze'));

  // validateFoodAction rejects break/squeeze on tiny peanut
  const invalidBreak = validateFoodAction('break', peanutProfile);
  assert.strictEqual(invalidBreak.valid, false);
  assert.ok(invalidBreak.errors.some(e => e.includes('FORCED_BREAK') || e.includes('PRODUCT_SCALE_ACTION_MISMATCH')));

  const validPick = validateFoodAction('pick', peanutProfile);
  assert.strictEqual(validPick.valid, true);
  console.log('✅ Tiny food override verified: Peanuts strictly require pick/rotate/pour and reject break/squeeze');

  // ── TEST 11: Filled Pastry Affordance (Section 7) ──────────────────────────
  console.log('\n--- Test 11: Filled Pastry Affordance ---');
  const piaAnalysis = {
    productName: 'Bánh Pía Sầu Riêng Trứng Muối',
    foodCategory: 'cake',
    visibleProperties: ['bánh nướng tròn', 'lớp vỏ ngàn lớp', 'nhân sầu riêng trứng muối'],
  };
  const piaProfile = analyzeFoodPhysicalProfile(piaAnalysis);
  assert.strictEqual(piaProfile.form, 'filled_pastry');
  assert.strictEqual(piaProfile.hasInteriorReveal, true);

  const piaAffordance = deriveFoodAffordances(piaProfile);
  assert.strictEqual(piaAffordance.heroAction, 'break_open');

  const piaBreakValid = validateFoodAction('break_open', piaProfile);
  assert.strictEqual(piaBreakValid.valid, true);
  console.log('✅ Filled pastry correctly identifies interior reveal and permits break_open');

  // ── TEST 12: Mắm Tép / Rice Topping Jar Flow (Section 10) ──────────────────
  console.log('\n--- Test 12: Mắm Tép / Rice Topping Jar Flow ---');
  const mamTepAnalysis = {
    productName: 'Mắm Tép Chưng Thịt',
    foodCategory: 'ready_to_eat',
    packageType: 'hũ thủy tinh nắp vặn',
    visibleProperties: ['thịt chưng mắm tép đậm đà', 'thớ thịt tơi xốp mọng dầu'],
  };
  const mamTepProfile = analyzeFoodPhysicalProfile(mamTepAnalysis);
  assert.strictEqual(mamTepProfile.form, 'rice_topping');

  const mamTepAffordance = deriveFoodAffordances(mamTepProfile);
  assert.strictEqual(mamTepAffordance.heroAction, 'scoop');

  const mamTepPlan = buildDynamicFourScenePlan(mamTepAnalysis, mamTepProfile, mamTepAffordance);
  assert.ok(mamTepPlan.scene2.action.includes('Mở nắp hũ'));
  assert.ok(mamTepPlan.scene3.action.includes('múc một phần') || mamTepPlan.scene3.action.includes('thìa'));
  assert.ok(mamTepPlan.scene4.action.includes('cơm trắng'));
  console.log('✅ Mắm tép jar-to-rice flow correctly planned: open lid -> scoop -> served over rice');

  // ── TEST 13: Show -> Say Synchronization Validator (Section 17) ───────────
  console.log('\n--- Test 13: Show -> Say Synchronization Validator ---');
  const mismatchScript = [
    { id: 1, foodAction: 'Giới thiệu bao bì đậu phộng', voiceOver: 'Mới mua được hũ đậu phộng ngon xỉu nè.' },
    { id: 2, foodAction: 'Trút đậu phộng ra đĩa', voiceOver: 'Trút ra thấy hạt tròn đều phủ cốt dừa thơm.' },
    { id: 3, foodAction: 'Nhón 1 hạt xoay tròn', voiceOver: 'Bẻ ra coi cái nhân bên trong nè cả nhà ơi.' }, // Mismatched "bẻ ra"
    { id: 4, foodAction: 'Nắm hạt mời ăn', voiceOver: 'Ăn giòn rụm béo ngậy mua thử liền nha.' }
  ];
  const syncCheckBad = validateShowSaySync(mismatchScript, { heroAction: 'pick' }, peanutProfile);
  assert.strictEqual(syncCheckBad.valid, false);
  assert.ok(syncCheckBad.errors.some(e => e.includes('SHOW_SAY_MISMATCH')));

  const matchedScript = [
    { id: 1, foodAction: 'Giới thiệu bao bì đậu phộng', voiceOver: 'Mới mua được hũ đậu phộng ngon xỉu nè.' },
    { id: 2, foodAction: 'Trút đậu phộng ra đĩa', voiceOver: 'Trút ra thấy hạt tròn đều phủ cốt dừa thơm.' },
    { id: 3, foodAction: 'Nhón 1 hạt xoay tròn', voiceOver: 'Nhìn cái hạt tròn xoe phủ cốt dừa giòn rụm nè.' },
    { id: 4, foodAction: 'Nắm hạt mời ăn', voiceOver: 'Ăn giòn rụm béo ngậy mua thử liền nha.' }
  ];
  const syncCheckGood = validateShowSaySync(matchedScript, { heroAction: 'pick' }, peanutProfile);
  assert.strictEqual(syncCheckGood.valid, true);
  console.log('✅ Show -> Say sync validator properly catches mismatch and passes aligned dialogue');

  // ── TEST 14: Food Review World Bible (Section 4) ───────────────────────────
  console.log('\n--- Test 14: Food Review World Bible ---');
  const snackWorld = buildFoodReviewWorld('snack');
  assert.strictEqual(snackWorld.environment, 'cozy Vietnamese home tea & snack tasting corner (lifestyle reviewer set)');
  assert.ok(snackWorld.surface.includes('honey-oak wooden'));
  assert.ok(snackWorld.backgroundDecor.includes('white roses'));
  assert.ok(snackWorld.backgroundDecor.includes('lucky bamboo'));
  assert.ok(snackWorld.lighting.includes('daylight'));
  assert.strictEqual(snackWorld.propDensity, 'medium');
  assert.ok(snackWorld.forbiddenLook.includes('empty studio table'));

  const worldCheck = validateBackgroundWorld(snackWorld);
  assert.strictEqual(worldCheck.valid, true);
  console.log('✅ Food Review World Bible validated for domestic realism');

  // ── TEST 15: QA Hard Gates & 100-Point Rubric (Section 23 & 24) ─────────────
  console.log('\n--- Test 15: QA Hard Gates & 100-Point Rubric ---');
  const qaPrompt = buildTemplateFoodVerificationPrompt(validFoodSample.analysis);
  assert.ok(qaPrompt.includes('100 Points Total'));
  assert.ok(qaPrompt.includes('Product Fidelity (Max 20)'));
  assert.ok(qaPrompt.includes('Physical Action Correctness (Max 20)'));
  assert.ok(qaPrompt.includes('Reference-Style Environment (Max 15)'));
  assert.ok(qaPrompt.includes('Sensory Evidence (Max 10)'));
  assert.ok(qaPrompt.includes('Action Runway / Start State (Max 15)'));
  assert.ok(qaPrompt.includes('BACKGROUND_TOO_GENERIC'));
  assert.ok(qaPrompt.includes('INVALID_FOOD_ACTION'));
  assert.ok(qaPrompt.includes('FORCED_BREAK'));
  assert.ok(qaPrompt.includes('FORCED_SQUEEZE'));
  assert.ok(qaPrompt.includes('SHOW_SAY_MISMATCH'));
  // ── TEST 16: Dining Etiquette & Utensil Affordance for Noodles / Cooked Dishes ──
  console.log('\n--- Test 16: Dining Etiquette & Utensil Affordance for Noodles / Cooked Dishes ---');
  const noodleAnalysis = {
    productName: 'Set 10 gói Mì Tươi Bò Xốt Vang VIFON',
    foodCategory: 'noodle',
    packageType: 'gói mì ăn liền',
    visibleProperties: ['sợi mì tươi dai mướt', 'thịt bò xốt vang đậm đà thơm ngậy'],
  };
  const noodleProfile = analyzeFoodPhysicalProfile(noodleAnalysis);
  assert.strictEqual(noodleProfile.form, 'noodle');
  assert.strictEqual(noodleProfile.cohesion, 'long_strands');
  assert.ok(noodleProfile.servedWith.includes('đôi đũa gỗ'));

  const noodleAffordance = deriveFoodAffordances(noodleProfile);
  assert.strictEqual(noodleAffordance.heroAction, 'lift_with_chopsticks');
  assert.ok(noodleAffordance.sensoryEvidence.includes('sợi mì'));

  // Test action validation: bare hand actions MUST be rejected, lift_with_chopsticks MUST be accepted
  assert.strictEqual(validateFoodAction('lift_with_chopsticks', noodleProfile).valid, true);
  assert.strictEqual(validateFoodAction('pick', noodleProfile).valid, false);
  assert.strictEqual(validateFoodAction('rotate', noodleProfile).valid, false);
  assert.strictEqual(validateFoodAction('break', noodleProfile).valid, false);

  // Test Master Storyboard Prompt for noodles
  const noodleMasterPrompt = buildTemplateFoodMasterPrompt({
    ...noodleAnalysis,
    foodPhysicalProfile: noodleProfile,
    affordance: noodleAffordance,
  });
  assert.ok(noodleMasterPrompt.includes('ACTION RUNWAY (LIFT WITH WOODEN CHOPSTICKS)'));
  assert.ok(noodleMasterPrompt.includes('STRICTLY FORBIDDEN: Bare fingers or hands touching the noodles'));
  assert.ok(noodleMasterPrompt.includes('CRITICAL DINING ETIQUETTE & UTENSIL COMPLIANCE'));

  // Test Video Prompts for noodles
  const noodleVideoPrompts = buildTemplateFoodVideoPrompts({
    ...noodleAnalysis,
    foodPhysicalProfile: noodleProfile,
    affordance: noodleAffordance,
  });
  assert.strictEqual(noodleVideoPrompts.length, 4);
  assert.ok(noodleVideoPrompts[1].includes('steaming hot bowl'));
  assert.ok(noodleVideoPrompts[1].includes('wooden chopsticks'));
  assert.ok(noodleVideoPrompts[2].includes('wooden chopsticks smoothly lifts'));
  assert.ok(noodleVideoPrompts[2].includes('Under NO circumstances do bare fingers touch the noodles'));
  assert.ok(noodleVideoPrompts[2].includes('eating noodles with bare hands'));

  // Test QA Verification Prompt includes BARE_HAND_ON_UTENSIL_FOOD
  const noodleQaPrompt = buildTemplateFoodVerificationPrompt({
    ...noodleAnalysis,
    foodPhysicalProfile: noodleProfile,
    affordance: noodleAffordance,
  });
  assert.ok(noodleQaPrompt.includes('BARE_HAND_ON_UTENSIL_FOOD'));
  console.log('✅ Noodles strictly enforce wooden chopsticks and forbid bare hands across all prompts');

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('🎉 ALL 16 TEST SUITES FOR FOOD REVIEW TEMPLATE PRO PASSED 100%!');
  console.log('═══════════════════════════════════════════════════════════════════\n');
})();
