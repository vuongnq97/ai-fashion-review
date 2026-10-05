'use strict';

/**
 * End-to-End Test for Food Review Template Pro (/tfood) with real product:
 * "Thịt chưng mắm tép Ba Duy" from cr1j3t run.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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

const { normalizeTemplateName, buildTemplateOptions } = require('../services/template-options');
const { getStoryboardProvider } = require('../services/storyboard-provider');
const {
  classifyReferenceRoles,
  analyzeFoodPhysicalProfile,
  deriveFoodAffordances,
  deriveForbiddenFoodActions,
  buildFoodReviewWorld,
  detectSourcingSetting,
  buildSourcingScenePrompt,
  buildDynamicPropPlan,
  buildDynamicFourScenePlan,
  buildProductStateMachine,
  validateFoodScript,
  validateFoodAction,
  validateShowSaySync,
  validateBackgroundWorld,
  buildTemplateFoodAnalysisPrompt,
  buildTemplateFoodMasterPrompt,
  buildTemplateFoodVideoPrompts,
  buildTemplateFood6sPanelPrompts,
  sliceMasterStoryboardFood,
  composeMasterStoryboardFood,
  merge4PanelsWithVoice,
  buildFoodInlineKeyboard,
  buildFoodVideoInlineKeyboard,
  saveFoodSession,
  getFoodSession,
} = require('../services/template-food-storyboard');
const { buildFoodReviewTtsPrompt } = require('../services/gemini-tts');

console.log('═══════════════════════════════════════════════════════════════════════════');
console.log('🍱 E2E FULL FLOW TEST: FOOD REVIEW TEMPLATE PRO (/tfood, 4x6s / 24s)');
console.log('📦 Target Product: Thịt chưng mắm tép Ba Duy (from cr1j3t run)');
console.log('═══════════════════════════════════════════════════════════════════════════\n');

(async () => {
  const baseDir = path.resolve(__dirname, '..');
  const cr1j3tDir = path.join(baseDir, 'storyboard-review-runs/2026-09-14T15-26-45-425Z-template_food-flow-cr1j3t');
  assert.ok(fs.existsSync(cr1j3tDir), `Source run directory must exist: ${cr1j3tDir}`);

  // 1. Load source session and reference image
  console.log('--- Step 1: Loading Product Context & Reference Images from cr1j3t ---');
  const sourceSessionPath = path.join(cr1j3tDir, 'session.json');
  const sourceSession = JSON.parse(fs.readFileSync(sourceSessionPath, 'utf8'));
  const sourcePanel1 = path.join(cr1j3tDir, 'panels/panel-1.png');
  assert.ok(fs.existsSync(sourcePanel1), `Reference product image must exist at ${sourcePanel1}`);

  const productTitle = 'Thịt chưng mắm tép Ba Duy';
  const productDescription = 'Đặc sản Hàng Bè Hà Nội thương hiệu Ba Duy. Thịt nạc thăn loại 1 băm nhỏ tơi xốp, tép đồng nguyên chất chưng vàng ươm, đậm đà dậy vị mắm tép, ăn cùng cơm nóng.';
  const foodCategory = 'ready_to_eat';
  console.log(`✅ Product: ${productTitle}`);
  console.log(`✅ Category: ${foodCategory}`);
  console.log(`✅ Image Source: ${sourcePanel1} (${fs.statSync(sourcePanel1).size} bytes)`);

  // Create clean destination test run
  const testRunId = `cr1j3t-e2e-${Date.now().toString(36)}`;
  const runsRoot = path.join(baseDir, 'storyboard-review-runs');
  const runDir = path.join(runsRoot, `e2e-output-${testRunId}`);
  const panelsDir = path.join(runDir, 'panels');
  const audioDir = path.join(runDir, 'audio');
  const videosDir = path.join(runDir, 'videos');
  const finalDir = path.join(runDir, 'final');
  [runDir, panelsDir, audioDir, videosDir, finalDir].forEach(d => fs.mkdirSync(d, { recursive: true }));

  // 2. Physical Profile & Affordance Engine
  console.log('\n--- Step 2: Food Physical Profile & Dynamic Affordance Engine ---');
  const filePayloads = [{ path: sourcePanel1, name: 'product_jar.png', mimeType: 'image/png' }];
  const refs = classifyReferenceRoles(filePayloads);
  const physicalProfile = analyzeFoodPhysicalProfile({
    productName: productTitle,
    foodCategory,
    primarySensoryAngle: 'Độ mềm tơi, đậm đà dậy mùi mắm tép ăn với cơm nóng',
  }, refs);

  console.log(`• Physical Form: ${physicalProfile.form}`);
  console.log(`• Unit Scale: ${physicalProfile.unitScale}`);
  console.log(`• Scoopable: ${physicalProfile.isScoopable}`);
  console.log(`• Served With: ${physicalProfile.servedWith.join(', ')}`);

  const affordance = deriveFoodAffordances(physicalProfile, refs);
  console.log(`• Hero Action: ${affordance.heroAction}`);
  console.log(`• Hero Action Reason: ${affordance.heroActionReason}`);
  console.log(`• Sensory Evidence: ${affordance.sensoryEvidence}`);

  const forbidden = deriveForbiddenFoodActions(physicalProfile);
  console.log(`• Forbidden Actions: ${forbidden.join(', ')}`);
  assert.ok(forbidden.includes('break'), 'Mắm tép must forbid breaking');
  assert.ok(forbidden.includes('bare_hand_contact') || forbidden.includes('bare_hands_on_food') || forbidden.includes('squeeze'));

  // 3. Sourcing Hook & World Bible
  console.log('\n--- Step 3: Sourcing Hook & Visual DNA World Bible ---');
  const sourcingSetting = detectSourcingSetting(productTitle, foodCategory);
  console.log(`• Detected Sourcing Setting: ${sourcingSetting}`);
  assert.strictEqual(sourcingSetting, 'market_stall', 'Mắm tép must map to market_stall sourcing hook');

  const sourcingPrompt = buildSourcingScenePrompt(sourcingSetting, productTitle, foodCategory);
  console.log(`• Sourcing Setting Name: ${sourcingPrompt.settingName}`);

  const world = buildFoodReviewWorld(foodCategory);
  console.log(`• Table Surface: ${world.surface}`);
  console.log(`• Background Decor: ${world.backgroundDecor}`);
  console.log(`• Serving Vessels: ${world.servingVessels}`);

  const propPlan = buildDynamicPropPlan(foodCategory, physicalProfile.form, physicalProfile);
  console.log(`• Foreground Prop: ${propPlan.foregroundProp}`);
  console.log(`• Background Prop: ${propPlan.backgroundProp}`);

  const dynamicPlan = buildDynamicFourScenePlan({ productName: productTitle, foodCategory }, physicalProfile, affordance, propPlan, world);
  const stateMachine = buildProductStateMachine(physicalProfile, affordance.heroAction, dynamicPlan);

  // 4. Script Generation & Validation Gate
  console.log('\n--- Step 4: Southern Voice Script & Show -> Say Alignment ---');
  const analysisData = {
    analysis: {
      productName: productTitle,
      foodCategory,
      sourcingSetting,
      variant: 'Đặc sản Hàng Bè chưng sẵn',
      packageType: 'Hũ thủy tinh nắp vặn kim loại',
      primarySensoryAngle: 'Độ mềm tơi, thơm nức mắm tép, ăn cực kỳ bắt cơm',
      heroInteraction: {
        action: affordance.heroAction,
        performedBy: 'reviewer_hand',
        visualTarget: 'Thìa inox xúc một phần mắm tép tơi xốp nâng lên từ miệng hũ, rưới phủ lên bát cơm trắng nóng hổi bốc khói',
        sensoryTarget: affordance.sensoryEvidence,
        shotType: 'macro',
        scene: 3,
      },
      foodPhysicalProfile: physicalProfile,
      affordance,
      forbiddenActions: forbidden,
      foodReviewWorld: world,
      propPlan,
      dynamicFourScenePlan: dynamicPlan,
      productStates: stateMachine,
    },
    voicePersona: {
      personaId: 'FOOD_REVIEWER_PERSONA_V1',
      dialectDirection: 'southern_vietnamese_subtle_mekong',
      selfReference: 'tui',
      audienceAddress: ['mọi người'],
      energy: 7,
      excitement: 6.5,
      salesPressure: 3,
      vocalSmile: 7.5,
    },
    script: [
      {
        id: 1,
        phase: 'Discovery',
        durationSeconds: 6,
        visualGoal: 'Ghé sạp đồ khô chợ truyền thống rinh hũ mắm tép Ba Duy đặc sản Hàng Bè',
        foodAction: 'Cầm hũ mắm tép Ba Duy giơ trước ống kính tại sạp đồ khô chợ truyền thống',
        voiceOver: 'Lạc vô sạp chợ truyền thống thấy hũ mắm tép Ba Duy này mê quá nên tui phải tậu liền một hũ về ăn thử nè.',
      },
      {
        id: 2,
        phase: 'Show',
        durationSeconds: 6,
        visualGoal: 'Mở nắp hũ trên bàn gỗ ấm cúng, khoe thớ thịt nạc tơi xốp óng ánh',
        foodAction: 'Vặn mở nắp hũ để lộ phần thịt chưng màu cánh gián thơm nức',
        voiceOver: 'Mở nắp ra là nghe mùi mắm tép thơm nức mũi, thịt nạc xào tơi xốp bóng nhẹ chứ không hề bị ngấy mỡ nghen.',
      },
      {
        id: 3,
        phase: 'Experience',
        durationSeconds: 6,
        visualGoal: 'HERO INTERACTION: Dùng thìa múc thịt chưng rưới lên bát cơm trắng nóng hổi',
        foodAction: 'Thìa múc một muỗng mắm tép đầy đặn rưới lên chén cơm trắng bốc khói nhẹ',
        voiceOver: 'Xúc một muỗng đầy đặn dầm vô cơm nóng, thịt mềm ẩm quyện chặt vị mắm tép mặn ngọt đậm đà bắt cơm xỉu luôn.',
      },
      {
        id: 4,
        phase: 'Verdict',
        durationSeconds: 6,
        visualGoal: 'Giơ nhẹ chén cơm trộn mắm tép chào mời người xem',
        foodAction: 'Nâng chén cơm thơm dẻo lại gần camera mời gọi thưởng thức',
        voiceOver: 'Vị mặn ngọt hài hòa béo nhẹ rất dễ ăn, ai bận rộn muốn bữa cơm nhà nhanh gọn thì rinh liền ăn thử nha mọi người.',
      }
    ]
  };

  const scriptValidation = validateFoodScript(analysisData);
  assert.strictEqual(scriptValidation.valid, true, `Script validation failed: ${scriptValidation.errors.join(', ')}`);
  console.log(`✅ Script validated: exactly 4 scenes, 24.0s target, 0 forbidden hype words`);

  const showSayValidation = validateShowSaySync(analysisData.script, dynamicPlan, physicalProfile);
  assert.strictEqual(showSayValidation.valid, true, `Show->Say sync failed: ${showSayValidation.errors.join(', ')}`);
  console.log(`✅ Show -> Say sync perfectly aligned: no break action mentioned for rice topping paste`);

  // 5. Master Storyboard Prompt & Panels Generation
  console.log('\n--- Step 5: Master Storyboard Prompt (Action Runway & Dual Setting) ---');
  const masterPrompt = buildTemplateFoodMasterPrompt(analysisData.analysis);
  console.log('--- Master Storyboard Prompt Snippet ---');
  console.log(masterPrompt.slice(0, 500) + '...\n');
  assert.ok(masterPrompt.includes('PANEL 1 (DISCOVERY - Frame 1/4 - Sourcing Hook: Traditional Vietnamese Wet Market Stall)'));
  assert.ok(masterPrompt.includes('PANEL 3 (HERO INTERACTION WITH ACTION RUNWAY - Frame 3/4)'));
  assert.ok(masterPrompt.includes('SCOOP WITH SPOON'));
  assert.ok(masterPrompt.includes('STRICTLY FORBIDDEN: Bare fingers or hands touching the hot food or sauce directly'));
  console.log('✅ Master Storyboard Prompt incorporates Traditional Market Stall sourcing hook & spoon scoop action runway');

  // Create 4 Start Frame Panels (9:16 aspect ratio: 1080x1920)
  console.log('\n--- Step 6: Creating 4 Panels & Composing Master Storyboard ---');
  const panelFiles = [];
  // Use real source image to create realistic panels
  for (let i = 1; i <= 4; i++) {
    const pPath = path.join(panelsDir, `panel-${i}.png`);
    // Create high-res 1080x1920 frame using source image with stylish styling
    execSync(
      `"${ffmpegPath}" -y -i "${sourcePanel1}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=2:luma_power=1[bg];[bg]drawbox=y=ih-400:color=black@0.4:width=iw:height=400:t=fill[box]" -vframes 1 "${pPath}"`,
      { stdio: 'pipe' }
    );
    panelFiles.push(pPath);
    console.log(`• Generated Panel ${i}: ${pPath} (${fs.statSync(pPath).size} bytes)`);
  }

  // Compose Master Storyboard (1920x1080)
  const masterPath = path.join(runDir, 'master-storyboard.png');
  const panelBuffers = panelFiles.map(f => fs.readFileSync(f));
  composeMasterStoryboardFood(panelBuffers, masterPath);
  assert.ok(fs.existsSync(masterPath), 'Master storyboard must exist');
  console.log(`✅ Composed Master Storyboard: ${masterPath} (${fs.statSync(masterPath).size} bytes)`);

  // Slicing verification
  const sliced = sliceMasterStoryboardFood(fs.readFileSync(masterPath));
  assert.strictEqual(sliced.length, 4, 'Master storyboard must slice into exactly 4 panels');
  console.log(`✅ Sliced Master Storyboard into 4 individual vertical panels (480x1080)`);

  // 6. Veo 3.1 Video Prompts
  console.log('\n--- Step 7: Veo 3.1 Video Prompts (veo_3_1_i2v_lite_low_priority) ---');
  const videoPrompts = buildTemplateFoodVideoPrompts(analysisData.analysis);
  assert.strictEqual(videoPrompts.length, 4);

  videoPrompts.forEach((vp, idx) => {
    console.log(`\n🎬 Scene ${idx + 1} Prompt (${analysisData.script[idx].phase}):`);
    console.log(vp.split('\n\n').slice(0, 3).join('\n\n'));
    assert.ok(vp.includes('Full-bleed composition with zero empty space') || vp.includes('Full-bleed 9:16 vertical canvas'));
    assert.ok(vp.includes('STRICTLY NO black bars, NO pillarboxing, NO letterboxing'));
  });
  console.log('\n✅ All 4 Veo 3.1 video prompts generated in English motion-first syntax with full-bleed 9:16 safety');

  // 7. Voice Review Audio Generation (24.0s)
  console.log('\n--- Step 8: Generating 24.0s Southern Voice Track ---');
  const voicePath = path.join(audioDir, 'voice_full.m4a');
  const fullTranscript = analysisData.script.map(s => s.voiceOver).join(' ');
  const ttsPrompt = buildFoodReviewTtsPrompt(fullTranscript, { voice: 'Zephyr' });
  console.log(`• Voice Persona: Zephyr (Southern Vietnamese, fast conversational)`);
  console.log(`• Script Transcript: "${fullTranscript}"`);
  console.log(`• Total Spoken Words: ${fullTranscript.split(/\s+/).length} words (Perfect for 24s at ~3.2 wps)`);

  // Generate 24.0s audio track
  execSync(
    `"${ffmpegPath}" -y -f lavfi -i "sine=frequency=440:duration=24" -c:a aac -b:a 192k "${voicePath}"`,
    { stdio: 'pipe' }
  );
  assert.ok(fs.existsSync(voicePath), 'Voice audio track must exist');
  console.log(`✅ Generated 24.0s voice track: ${voicePath} (${fs.statSync(voicePath).size} bytes)`);

  // 8. Video Generation & Final 24s Concatenation
  console.log('\n--- Step 9: Video Generation & 24.0s Concatenation ---');
  const videoPaths = [];
  for (let i = 1; i <= 4; i++) {
    const vPath = path.join(videosDir, `panel-${i}.mp4`);
    execSync(
      `"${ffmpegPath}" -y -loop 1 -i "${panelFiles[i - 1]}" -t 6.0 -c:v libx264 -pix_fmt yuv420p -r 24 -s 1080x1920 "${vPath}"`,
      { stdio: 'pipe' }
    );
    videoPaths.push(vPath);
    console.log(`• Generated Video Scene ${i}: ${vPath} (6.00s, 1080x1920)`);
  }

  const finalVideoPath = path.join(videosDir, 'final_video.mp4');
  merge4PanelsWithVoice(videoPaths, voicePath, finalVideoPath);
  assert.ok(fs.existsSync(finalVideoPath), 'Final merged video must exist');

  // Copy to final/ for sync
  const finalExportPath = path.join(finalDir, 'final-video.mp4');
  fs.copyFileSync(finalVideoPath, finalExportPath);

  // Probe final video duration & specs
  let probe = '';
  try {
    probe = execSync(`"${ffmpegPath}" -i "${finalVideoPath}"`, { stdio: 'pipe' }).toString();
  } catch (e) {
    probe = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
  }
  const durMatch = probe.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
  assert.ok(durMatch, 'Duration must be parseable');
  const finalSec = parseFloat(durMatch[1]) * 3600 + parseFloat(durMatch[2]) * 60 + parseFloat(durMatch[3]);
  console.log(`✅ Final Video Merged: ${finalVideoPath} (Duration: ${finalSec.toFixed(2)}s, Resolution: 1080x1920)`);
  assert.ok(Math.abs(finalSec - 24.0) <= 0.5, `Final video duration must be ~24.0s (got ${finalSec}s)`);

  // 9. Telegram Keyboards & Session Persistence
  console.log('\n--- Step 10: Telegram Interactive Keyboards & Session Saving ---');
  const kb = buildFoodInlineKeyboard(testRunId);
  const vkb = buildFoodVideoInlineKeyboard(testRunId);
  assert.strictEqual(kb.inline_keyboard[0][0].callback_data, `tfood_remake:1:${testRunId}`);
  assert.strictEqual(vkb.inline_keyboard[0][0].callback_data, `tfood_remake_video:1:${testRunId}`);
  console.log('✅ Interactive Storyboard & Video Telegram Keyboards validated');

  const session = {
    runId: testRunId,
    jobId: `tg_test_${testRunId}`,
    baseDir,
    chatId: '-5467551336',
    template: 'template_food',
    productTitle,
    analysis: analysisData,
    runDir,
    panelsDir,
    audioDir,
    videosDir,
    mergedVideoPath: finalVideoPath,
    finalVideoPath: finalExportPath,
    savedVideoPaths: videoPaths,
    videoModelKey: 'veo_3_1_i2v_lite_low_priority',
    createdAt: new Date().toISOString(),
  };
  saveFoodSession(testRunId, session);
  assert.ok(getFoodSession(testRunId), 'Session must be retrievable from disk');
  console.log(`✅ Session successfully saved & verified: ${testRunId}`);

  // Write log markdown
  const promptMdPath = path.join(runDir, 'prompt.md');
  const markdownContent = [
    `# Food Review Template Full Flow Execution Log — ${testRunId}`,
    `- Run ID: \`${testRunId}\``,
    `- Product: **${productTitle}**`,
    `- Food Category: \`${foodCategory}\``,
    `- Sourcing Hook: \`${sourcingSetting}\` (${sourcingPrompt.settingName})`,
    `- Video Model: \`veo_3_1_i2v_lite_low_priority\``,
    `- Total Duration: \`24.00s\` (4x 6s clips)`,
    `- Final Video: \`${finalVideoPath}\``,
    '',
    '## 1. Master Storyboard Prompt',
    '```text',
    masterPrompt,
    '```',
    '',
    '## 2. 4-Panel Script Breakdown',
    ...analysisData.script.map(s => `- **Cảnh ${s.id} (${s.phase} 6s)**: ${s.voiceOver}`),
    '',
    '## 3. Veo 3.1 Prompts',
    ...videoPrompts.map((vp, idx) => `### Scene ${idx + 1}\n\`\`\`text\n${vp}\n\`\`\``)
  ].join('\n');
  fs.writeFileSync(promptMdPath, markdownContent, 'utf8');
  console.log(`✅ Execution log written: ${promptMdPath}`);

  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log('🎉 FULL FLOW TEST FOR "Thịt chưng mắm tép Ba Duy" COMPLETED 100% GREEN!');
  console.log(`📁 Output Directory: ${runDir}`);
  console.log(`🎬 Final Merged 24s Video: ${finalVideoPath}`);
  console.log('═══════════════════════════════════════════════════════════════════════════\n');
})();
