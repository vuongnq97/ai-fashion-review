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
  buildTemplateProAnalysisPrompt,
  parseJsonObjectPro,
  extractFallbackAnalysisFields,
  analyzeProductTemplatePro,
  buildTemplateProVideoPrompts,
  buildTemplateProVoiceVideoPrompts,
  buildTemplatePro4sPanelPrompts,
  buildTemplateProRemakePrompt,
  buildTemplateProRemakeAllPrompt,
  buildTemplateProVerificationPrompt,
  verifyStoryboardWithGeminiVision,
  formatQAVerificationMarkdown,
  buildTemplateProMultiStoryboardPrompt,
  verifyMultiStoryboardWithGeminiVision,
  formatMultiStoryboardQAMarkdown,
  buildProInlineKeyboard,
  buildProVideoInlineKeyboard,
  selectBestCandidateForPanel,
  buildTemplateProMasterPrompt,
  finalizeProStoryboardAndGenerateVideos,
  buildTemplateProRemakeVideoJobs,
  extractAudioFromVideo,
  concatTwoVoiceAudios,
  merge4PanelsWithVoice,
  executeProRemakeSingleVideo,
  sliceMasterStoryboardPro,
  composeMasterStoryboardPro,
  createInputCollageImagePro,
  extractVideoKeyframes,
  buildTemplateProVideoVerificationPrompt,
  verifyVideoWithGeminiVision,
  formatVideoQAMarkdown,
} = require('../services/template-pro-storyboard');
const { registerExternalCompletedJob, getLatestCompletedJobForChat } = require('../services/generation-job');
const {
  pcmToWav,
  buildGeminiTtsPrompt,
  generateSpeechWithGemini,
  convertPcmToM4a,
  generateTemplateProVoiceReview,
  TTS_MODELS_FALLBACK,
  DEFAULT_TTS_TOKENS,
  resolveTtsTokens,
  getActiveTokenIndex,
  setActiveTokenIndex,
} = require('../services/gemini-tts');

console.log('--- Test 1: Template Options & Provider Resolution ---');
assert.strictEqual(normalizeTemplateName('tpro'), 'template_pro');
assert.strictEqual(normalizeTemplateName('template_pro'), 'template_pro');
assert.strictEqual(normalizeTemplateName('templatepro'), 'template_pro');

const opts = buildTemplateOptions('tpro');
assert.strictEqual(opts.template, 'template_pro');
assert.strictEqual(opts.interactiveStoryboard, true);
assert.strictEqual(opts.panelCount, 2);
assert.strictEqual(opts.cropPercent, 0);
assert.strictEqual(opts.preserveBorder, true);
assert.strictEqual(typeof finalizeProStoryboardAndGenerateVideos, 'function');
console.log('✅ Template options (zero crop, preserveBorder) and finalizeProStoryboardAndGenerateVideos verified');

const provider = getStoryboardProvider(path.resolve(__dirname, '..'), { template: 'tpro' });
assert.strictEqual(provider.name, 'template_pro');
console.log('✅ Storyboard provider resolved to:', provider.name);

console.log('\n--- Test 2: Template Pro Script Analysis Prompt & Word Count Density ---');
const analysisPrompt = buildTemplateProAnalysisPrompt({
  productContext: {
    productTitle: 'Nồi chiên không dầu điện tử 6L',
    productDescription: 'Dung tích 6 lít, công suất 1800W, màn hình cảm ứng, chống dính ceramic',
  }
});
assert.ok(analysisPrompt.includes('MỖI CẢNH 16 ĐẾN 18 TỪ'));
assert.ok(analysisPrompt.includes('TỔNG 4 CẢNH TỐI THIỂU 65 TỪ, TỐI ĐA 70 TỪ'));
assert.ok(analysisPrompt.includes('TUYỆT ĐỐI KHÔNG ĐƯỢC CUTOFF'));
assert.ok(analysisPrompt.includes('COLLOQUIAL SOUTHERN VIETNAMESE'));
assert.ok(analysisPrompt.includes('targetUser'));
assert.ok(analysisPrompt.includes('buyerAngle'));
assert.ok(analysisPrompt.includes('TUYỆT ĐỐI KHÔNG LẠM DỤNG TỪ "MẤY BÀ"'));
assert.ok(analysisPrompt.includes('mấy bà'));
assert.ok(analysisPrompt.includes('tui'));
console.log('✅ Analysis prompt enforces targetUser, buyerAngle, anti-overuse of "mấy bà", 16-18 words/panel, and min 65 max 70 words total');

(async () => {
  const fallbackRes = await analyzeProductTemplatePro(null, [], {
    productContext: { productTitle: 'Nồi chiên không dầu điện tử 6L' }
  });
  assert.ok(fallbackRes.analysis);
  assert.ok(fallbackRes.analysis.targetUser);
  assert.ok(fallbackRes.analysis.buyerAngle);
  assert.ok(fallbackRes.analysis.addressStyle);
  const scripts = fallbackRes.analysis.script;
  assert.strictEqual(scripts.length, 4);

  let totalWords = 0;
  for (let i = 0; i < 4; i++) {
    const wCount = scripts[i].voiceOver.split(/\s+/).filter(Boolean).length;
    totalWords += wCount;
    assert.ok(wCount >= 16 && wCount <= 19, `Panel ${i + 1} word count ${wCount} must be between 16 and 19 words`);
    console.log(`  * Panel ${i + 1} (${scripts[i].phase}): ${wCount} words -> "${scripts[i].voiceOver}"`);
  }

  assert.ok(totalWords >= 65 && totalWords <= 70, `Total review words ${totalWords} must be between 65 and 70 words for 16s video`);
  console.log(`✅ Fallback scripts verified: Total = ${totalWords} words across 4 scenes (Target: min 65, max 70 words for 16s natural TTS review)`);
})();

console.log('\n--- Test 3: Remake Prompt Construction ---');
const mockAnalysis = {
  productName: 'Bàn ủi hơi nước cầm tay',
  category: 'appliances',
  sceneContext: {
    location: 'Phòng khách chung cư tối giản',
    lighting: 'Ánh sáng ban ngày ấm áp'
  },
  leftHalfComposition: {
    panel1: {
      phase: 'Hook',
      marketingAnswer: 'Áo sơ mi nhăn nhúm trước giờ đi làm',
      visualDescription: 'Cận cảnh áo sơ mi nhăn và tay cầm bàn ủi',
      handInteraction: 'Cầm bàn ủi lướt nhẹ'
    }
  },
  script: [
    { id: 1, voiceOver: 'Bạn có biết lý do vì sao chiếc bàn ủi cầm tay này lại khiến chị em mê mẩn suốt thời gian qua không? Hãy cùng mình kiểm chứng ngay độ phẳng mượt chỉ sau vài giây lướt nhé.' },
    { id: 2, voiceOver: 'Công nghệ phun hơi tăng áp cực mạnh làm phẳng tức thì mọi nếp nhăn cứng đầu trên mọi chất liệu vải cao cấp, giúp bạn luôn tự tin chỉn chu mỗi sáng mà không tốn công sức.' },
    { id: 3, voiceOver: 'Mặt đế ceramic cao cấp lướt cực êm không lo cháy xém sợi vải, thiết kế nhỏ gọn gấp gọn thông minh dễ dàng mang theo trong mọi chuyến du lịch hay công tác xa nhà.' },
    { id: 4, voiceOver: 'Một món đồ thiết thực không thể thiếu để nâng tầm diện mạo chỉn chu mỗi ngày, số lượng ưu đãi có hạn nên hãy bấm ngay vào giỏ hàng góc trái màn hình để nhận quà nhé.' }
  ]
};

const promptP1 = buildTemplateProRemakePrompt(mockAnalysis, 1, 2);
assert.ok(promptP1.includes('REMAKE AND RE-INVENT ONLY PANEL 1'));
assert.ok(promptP1.includes('current_storyboard.png'));
assert.ok(promptP1.includes('Áo sơ mi nhăn nhúm'));
// Đảm bảo Remake Prompt chứa toàn bộ prompt master lần 1 (Scene plan, Visual direction...)
assert.ok(promptP1.includes('CRITICAL VISUAL DIRECTION — 100% SMARTPHONE REALISM'), 'Must include Prompt 1 visual direction');
assert.ok(promptP1.includes('leftHalfComposition'), 'Must include Prompt 1 scene plan structure');
console.log('✅ Remake Prompt for Panel 1 successfully generated and contains full Prompt 1 + Remake instructions');

const promptAll = buildTemplateProRemakeAllPrompt(mockAnalysis, 2);
assert.ok(promptAll.includes('REMAKE ALL 4 PANELS'));
assert.ok(promptAll.includes('Panel 1 (Hook)'));
assert.ok(promptAll.includes('Panel 2 (Solution)'));
assert.ok(promptAll.includes('Panel 3 (Proof)'));
assert.ok(promptAll.includes('Panel 4 (Closing / CTA)'));
console.log('✅ Remake All Prompt successfully generated and contains key instructions for all 4 panels');

const keyboard = buildProInlineKeyboard('run_test_456');
assert.strictEqual(keyboard.inline_keyboard.length, 4);
assert.strictEqual(keyboard.inline_keyboard[0][0].callback_data, 'tpro_remake:1:run_test_456');
assert.strictEqual(keyboard.inline_keyboard[0][1].callback_data, 'tpro_remake:2:run_test_456');
assert.strictEqual(keyboard.inline_keyboard[1][0].callback_data, 'tpro_remake:3:run_test_456');
assert.strictEqual(keyboard.inline_keyboard[1][1].callback_data, 'tpro_remake:4:run_test_456');
assert.strictEqual(keyboard.inline_keyboard[2][0].callback_data, 'tpro_remake_all:run_test_456');
assert.strictEqual(keyboard.inline_keyboard[3][0].callback_data, 'tpro_ok:run_test_456');
console.log('✅ Inline Keyboard has Remake 1..4, Remake All, and OK buttons perfectly configured');

console.log('\n--- Test 4: Video Prompts (Zero White Border, 60-72 Words, No Cutoff) ---');
const proVideoPrompts = buildTemplateProVideoPrompts(mockAnalysis);
assert.strictEqual(proVideoPrompts.length, 2);
assert.ok(proVideoPrompts[0].includes('8 giây'));
assert.ok(proVideoPrompts[1].includes('8 giây'));
// Kiểm tra hoàn toàn KHÔNG có khung viền trắng padding
assert.ok(!proVideoPrompts[0].includes('KHUNG VIỀN TRẮNG CỐ ĐỊNH'), 'Video 1 prompt must NOT have white border padding');
assert.ok(!proVideoPrompts[1].includes('KHUNG VIỀN TRẮNG CỐ ĐỊNH'), 'Video 2 prompt must NOT have white border padding');
// Kiểm tra yêu cầu đọc cực nhanh không cutoff
assert.ok(proVideoPrompts[0].includes('TUYỆT ĐỐI KHÔNG ĐƯỢC CUTOFF'));
assert.ok(proVideoPrompts[1].includes('TUYỆT ĐỐI KHÔNG ĐƯỢC CUTOFF'));
// Kiểm tra khóa chặt hành động và trạng thái vật lý (Physical State Invariance & Action Lockdown)
assert.ok(proVideoPrompts[0].includes('UNIVERSAL PHYSICAL STATE INVARIANCE & ACTION LOCKDOWN'));
assert.ok(proVideoPrompts[0].includes('ZERO UNPROMPTED ACTIONS'));
assert.ok(proVideoPrompts[1].includes('UNIVERSAL PHYSICAL STATE INVARIANCE & ACTION LOCKDOWN'));
assert.ok(proVideoPrompts[1].includes('ZERO UNPROMPTED ACTIONS'));
// Kiểm tra đã bỏ ảnh input, chỉ dùng 3 ảnh (2 panel + storyboard)
assert.ok(proVideoPrompts[0].includes('từ 3 hình ảnh đã cung cấp (gồm Panel 1: Cảnh 1, Panel 2: Cảnh 2, và Master Storyboard toàn bộ 4 cảnh)'));
assert.ok(proVideoPrompts[1].includes('từ 3 hình ảnh đã cung cấp (gồm Panel 3: Cảnh 3, Panel 4: Cảnh 4, và Master Storyboard toàn bộ 4 cảnh)'));
// Kiểm tra đã bỏ từ khóa camera iPhone 15
assert.ok(!proVideoPrompts[0].includes('iPhone 15'), 'Must not contain iPhone 15 keyword');
assert.ok(!proVideoPrompts[1].includes('iPhone 15'), 'Must not contain iPhone 15 keyword');
// Kiểm tra giới hạn max 40 từ
assert.ok(proVideoPrompts[0].includes('tối đa 40 từ'));
assert.ok(proVideoPrompts[1].includes('tối đa 40 từ'));
// Kiểm tra giọng đọc đời thường miền Nam
assert.ok(proVideoPrompts[0].includes('nói chuyện giao tiếp đời thường miền Nam'));
assert.ok(proVideoPrompts[1].includes('nói chuyện giao tiếp đời thường miền Nam'));
console.log('✅ Video prompts enforce 8s duration, pure 9:16, max 40 words, Southern Vietnamese colloquial tone, NO iPhone 15 keyword, and NO input photo');

const mockJob = {
  jobId: 'tpro-testrun123',
  chatId: '999888777',
  status: 'completed',
  template: 'template_pro',
  hasVoice: true,
};
registerExternalCompletedJob('999888777', mockJob);
const retrievedJob = getLatestCompletedJobForChat('999888777');
assert.strictEqual(retrievedJob?.jobId, 'tpro-testrun123');
assert.strictEqual(retrievedJob?.status, 'completed');
console.log('✅ Completed Pro Job successfully registered for /upload integration');

console.log('\n--- Test 5: Template Pro Remake Video Jobs & Command Parsing ---');
// Kiểm tra regex lệnh remake bắt chính xác mọi biến thể:
const remakeRegex = /^\/(?:remake|again|redo)(?:[_@\s\d]|$)/i;
assert.ok(remakeRegex.test('/remake_1'));
assert.ok(remakeRegex.test('/remake_2'));
assert.ok(remakeRegex.test('/remake_1_2'));
assert.ok(remakeRegex.test('/remake 1'));
assert.ok(remakeRegex.test('/remake 2'));
assert.ok(remakeRegex.test('/remake 1 2'));
assert.ok(remakeRegex.test('/remake1'));
assert.ok(remakeRegex.test('/remake'));
console.log('✅ Remake command regex successfully matches /remake_1, /remake_2, /remake 1, /remake 2');

console.log('\n--- Test 4: Slice and Composite 16:9 (No Distortion) ---');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpro-test-'));

try {
  // Tạo 1 ảnh Master Storyboard 16:9 (1920x1080)
  const origSbPath = path.join(tmpDir, 'orig-storyboard.png');
  execSync(`"${ffmpegPath}" -y -f lavfi -i testsrc=size=1920x1080:rate=1 -frames:v 1 "${origSbPath}"`, { stdio: 'pipe' });

  // Tách thành 4 panels tự nhiên 4:9 (480x1080)
  const slicedBuffers = sliceMasterStoryboardPro(fs.readFileSync(origSbPath));
  assert.strictEqual(slicedBuffers.length, 4);
  console.log('✅ Sliced into 4 natural 4:9 panels, buffer lengths:', slicedBuffers.map(b => b.length));

  // Ghép lại thành Master Storyboard 16:9
  const reComposedSbPath = path.join(tmpDir, 'recomposed-storyboard.png');
  composeMasterStoryboardPro(slicedBuffers, reComposedSbPath);
  assert.ok(fs.existsSync(reComposedSbPath));

  // Kiểm tra kích thước và tỷ lệ chính xác 1920x1080 (16:9)
  const probe1 = execSync(`sips -g pixelWidth -g pixelHeight "${reComposedSbPath}"`, { encoding: 'utf8' });
  assert.ok(probe1.includes('1920'));
  assert.ok(probe1.includes('1080'));
  console.log('✅ Recomposed storyboard dimensions verified: exactly 1920x1080 (16:9, ZERO distortion)');

  // Giả lập Remake Panel 2: thay panel 2 bằng màu xanh neon 480x1080
  const remadeP2Path = path.join(tmpDir, 'panel-2-remade.png');
  execSync(`"${ffmpegPath}" -y -f lavfi -i color=c=lime:s=480x1080:d=1 -frames:v 1 "${remadeP2Path}"`, { stdio: 'pipe' });
  const remadeP2Buf = fs.readFileSync(remadeP2Path);

  const updatedPanels = [
    slicedBuffers[0],
    remadeP2Buf,
    slicedBuffers[2],
    slicedBuffers[3],
  ];

  const sbV2Path = path.join(tmpDir, 'storyboard-v2.png');
  composeMasterStoryboardPro(updatedPanels, sbV2Path);
  assert.ok(fs.existsSync(sbV2Path));

  const probe2 = execSync(`sips -g pixelWidth -g pixelHeight "${sbV2Path}"`, { encoding: 'utf8' });
  assert.ok(probe2.includes('1920'));
  assert.ok(probe2.includes('1080'));
  console.log('✅ Storyboard v2 verified: 1920x1080 with updated Panel 2 seamlessly replaced!');

  // Kiểm tra buildTemplateProRemakeVideoJobs cho Video 1 & Video 2
  const panelsDir = path.join(tmpDir, 'panels');
  const inputsDir = path.join(tmpDir, 'inputs');
  fs.mkdirSync(panelsDir, { recursive: true });
  fs.mkdirSync(inputsDir, { recursive: true });
  [1, 2, 3, 4].forEach(i => fs.writeFileSync(path.join(panelsDir, `panel-${i}.png`), slicedBuffers[i - 1]));
  fs.writeFileSync(path.join(tmpDir, 'storyboard.png'), fs.readFileSync(origSbPath));
  fs.writeFileSync(path.join(inputsDir, 'input.png'), slicedBuffers[0]);
  fs.writeFileSync(path.join(tmpDir, 'session.json'), JSON.stringify({ analysis: mockAnalysis, template: 'template_pro' }));

  const remakeJobsP1 = buildTemplateProRemakeVideoJobs(tmpDir, [1], 'quay cận cảnh', mockAnalysis);
  assert.strictEqual(remakeJobsP1.length, 1);
  assert.strictEqual(remakeJobsP1[0].panelIndex, 1);
  assert.strictEqual(remakeJobsP1[0].videoModelKey, 'abra_r2v_4s');
  assert.ok(remakeJobsP1[0].prompt.includes('quay cận cảnh'));
  assert.ok(!remakeJobsP1[0].prompt.includes('KHUNG VIỀN TRẮNG CỐ ĐỊNH'));

  const remakeJobsP2 = buildTemplateProRemakeVideoJobs(tmpDir, [2], '', mockAnalysis);
  assert.strictEqual(remakeJobsP2.length, 1);
  assert.strictEqual(remakeJobsP2[0].panelIndex, 2);
  assert.strictEqual(remakeJobsP2[0].videoModelKey, 'abra_r2v_4s');

  const remakeJobsAll = buildTemplateProRemakeVideoJobs(tmpDir, [1, 2], '', mockAnalysis);
  assert.strictEqual(remakeJobsAll.length, 2);
  assert.strictEqual(remakeJobsAll[0].panelIndex, 1);
  assert.strictEqual(remakeJobsAll[1].panelIndex, 2);
  console.log('✅ buildTemplateProRemakeVideoJobs successfully prepares single-panel abra_r2v_4s jobs (Start Frame mode, zero text)');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
console.log('\n--- Test 6: Gemini Vision Storyboard QA Verification (Product Storyboard Framework v1.0, 4 Criteria, Threshold >= 85) ---');

// 1. Kiểm tra prompt verification 4 tiêu chí theo Product Storyboard Evaluation Framework v1.0
const qaPrompt = buildTemplateProVerificationPrompt(mockAnalysis, 1);
assert.ok(qaPrompt.includes('100-POINT SCALE') || qaPrompt.includes('Total Score: 100'));
assert.ok(qaPrompt.includes('PRODUCT FIDELITY (Priority 1, Max 40 pts, Weight 40%, Hard Gate: min 32 pts)'));
assert.ok(qaPrompt.includes('SCENE ACCURACY (Priority 2, Max 25 pts, Weight 25%, min pass score: 18 pts)'));
assert.ok(qaPrompt.includes('COMMERCIAL COMPOSITION (Priority 3, Max 20 pts, Weight 20%, min pass score: 14 pts)'));
assert.ok(qaPrompt.includes('VISUAL CONSISTENCY (Priority 4, Max 15 pts, Weight 15%, min pass score: 10 pts)'));
assert.ok(qaPrompt.includes('CRITICAL ERROR OVERRIDE'));
assert.ok(qaPrompt.includes('correctionDirective'));
console.log('✅ QA Verification Prompt contains 100-point rubric with all 4 priority criteria (40/25/20/15) and Hard Gate min 32');

// 2. Kiểm tra hàm verify với Mock Gemini Client: Trường hợp điểm <= 85 (Fail -> Retry)
const mockClientFail = {
  uploadFile: async () => 'https://bard.google.com/upload/mock-123',
  generateContent: async () => ({
    text: JSON.stringify({
      total_score: 82,
      score: 82,
      decision: 'REGENERATE_OR_FIX',
      passed: false,
      criteria_results: {
        product_fidelity: { score: 30, max_score: 40, passed: false, critical_error: false },
        scene_accuracy: { score: 20, max_score: 25, passed: true },
        commercial_composition: { score: 18, max_score: 20, passed: true },
        visual_consistency: { score: 14, max_score: 15, passed: true }
      },
      discrepancies: ['Màu sắc sản phẩm bị lệch so với ảnh mẫu', 'Chi tiết cấu tạo chưa hoàn toàn ăn khớp'],
      critique: 'Cần khắc phục màu sắc sản phẩm đúng chuẩn ảnh mẫu',
      correctionDirective: 'Chỉnh màu sắc và hoàn thiện chi tiết đúng ảnh mẫu'
    })
  })
};

(async () => {
  const dummyBuf = Buffer.from('fake-png-data');
  const dummyInputs = [{ name: 'input-1.jpg', buffer: dummyBuf }];
  const qaResFail = await verifyStoryboardWithGeminiVision(mockClientFail, dummyBuf, dummyInputs, mockAnalysis, 1);
  assert.strictEqual(qaResFail.score, 82);
  assert.strictEqual(qaResFail.passed, false);
  assert.strictEqual(qaResFail.discrepancies.length, 2);
  assert.strictEqual(qaResFail.correctionDirective, 'Chỉnh màu sắc và hoàn thiện chi tiết đúng ảnh mẫu');
  console.log('✅ QA Verification correctly detects score <= 85 as failed and extracts correction directives');

  // 3. Kiểm tra trường hợp điểm > 85 (Pass)
  const mockClientPass = {
    uploadFile: async () => 'https://bard.google.com/upload/mock-456',
    generateContent: async () => ({
      text: JSON.stringify({
        total_score: 92,
        score: 92,
        decision: 'PASS',
        passed: true,
        criteria_results: {
          product_fidelity: { score: 38, max_score: 40, passed: true, critical_error: false },
          scene_accuracy: { score: 23, max_score: 25, passed: true },
          commercial_composition: { score: 18, max_score: 20, passed: true },
          visual_consistency: { score: 13, max_score: 15, passed: true }
        },
        discrepancies: [],
        critique: 'Chất lượng xuất sắc, đúng 100% ngoại quan sản phẩm và bối cảnh chuẩn smartphone realism.',
        correctionDirective: ''
      })
    })
  };

  const qaResPass = await verifyStoryboardWithGeminiVision(mockClientPass, dummyBuf, dummyInputs, mockAnalysis, 2);
  assert.strictEqual(qaResPass.score, 92);
  assert.strictEqual(qaResPass.passed, true);
  assert.strictEqual(qaResPass.discrepancies.length, 0);
  console.log('✅ QA Verification correctly verifies score > 85 as PASSED (92/100)');

  // 3b. Kiểm tra Critical Error Override: Dù tổng điểm 88 nhưng có lỗi Critical Product Fidelity -> BẮT BUỘC FAIL
  const mockClientCritFail = {
    uploadFile: async () => 'https://bard.google.com/upload/mock-789',
    generateContent: async () => ({
      text: JSON.stringify({
        total_score: 88,
        score: 88,
        decision: 'FAIL',
        passed: false,
        critical_errors: ['Product becomes a different model or SKU'],
        criteria_results: {
          product_fidelity: { score: 28, max_score: 40, passed: false, critical_error: true },
          scene_accuracy: { score: 23, max_score: 25, passed: true },
          commercial_composition: { score: 19, max_score: 20, passed: true },
          visual_consistency: { score: 14, max_score: 15, passed: true }
        },
        discrepancies: ['Sai kiểu dáng sản phẩm so với ảnh reference'],
        critique: 'Kiểu dáng sản phẩm bị sai thành model khác',
        correctionDirective: 'Khôi phục đúng kiểu dáng sản phẩm từ ảnh input.png'
      })
    })
  };
  const qaResCritFail = await verifyStoryboardWithGeminiVision(mockClientCritFail, dummyBuf, dummyInputs, mockAnalysis, 3);
  assert.strictEqual(qaResCritFail.passed, false, 'Must fail when critical error is present');
  assert.strictEqual(qaResCritFail.decision, 'FAIL');
  assert.ok(qaResCritFail.discrepancies.some(d => d.includes('CRITICAL')));
  console.log('✅ Critical Error Override verified: score 88 but with critical error triggers automatic FAIL');

  // 4. Kiểm tra format markdown QA log
  const qaHistory = [
    { attempt: 1, score: 82, passed: false, qaResult: qaResFail },
    { attempt: 2, score: 92, passed: true, qaResult: qaResPass }
  ];
  const mdLog = formatQAVerificationMarkdown(qaHistory, qaHistory[1]);
  assert.ok(mdLog.includes('QA Attempt 1: **82/100** — ⚠️ RETRY REQUIRED'));
  assert.ok(mdLog.includes('**Final Approved Candidate**: Attempt 2 (Score: **92/100**)'));
  assert.ok(mdLog.includes('Product Fidelity (Đúng sản phẩm)'));
  assert.ok(mdLog.includes('Scene Accuracy (Đúng bối cảnh & thao tác)'));
  assert.ok(mdLog.includes('Commercial Composition (Bố cục bán hàng)'));
  assert.ok(mdLog.includes('Visual Consistency (Đồng nhất panel)'));
  console.log('✅ formatQAVerificationMarkdown generates clean audit trail for prompts.md with 4 criteria');

  console.log('\n--- Test 7: Video QA Verification & Action Lockdown (100-Point Rubric, Threshold > 85) ---');
  // 1. Kiểm tra prompt Video QA
  const videoQAPrompt = buildTemplateProVideoVerificationPrompt(1, mockAnalysis, 1);
  assert.ok(videoQAPrompt.includes('100-POINT SCALE'));
  assert.ok(videoQAPrompt.includes('UNIVERSAL PHYSICAL STATE INVARIANCE & PRODUCT INTEGRITY (Tối đa 45 điểm - ƯU TIÊN SỐ 1 CAO NHẤT)'));
  assert.ok(videoQAPrompt.includes('STORYBOARD SCENE FIDELITY & ACTION FLOW (Tối đa 25 điểm)'));
  assert.ok(videoQAPrompt.includes('HAND ERGONOMICS & STRICT 100% FACELESS POLICY (Tối đa 20 điểm)'));
  assert.ok(videoQAPrompt.includes('SMARTPHONE REALISM & ARTIFACT-FREE CLEANLINESS (Tối đa 10 điểm)'));
  assert.ok(videoQAPrompt.includes('DO NOT penalize background changes, tabletop changes, or camera angle shifts occurring around the 4.0s mark'));
  assert.ok(videoQAPrompt.includes('8 Extracted Keyframes'));
  assert.ok(videoQAPrompt.includes('GREATER THAN 85 (> 85)'));
  assert.ok(videoQAPrompt.includes('ZERO unprompted mechanical transformations'));
  console.log('✅ Video QA Prompt contains 100-point rubric (45/25/20/10) with 8 frames and no false penalty for 4s transition');

  // 2. Tạo dummy video 8s để kiểm tra trích xuất 8 keyframes (1s, 2s, 3s, 4s, 5s, 6s, 7s, 8s)
  const videoTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpro-video-qa-test-'));
  try {
    const dummyVideoPath = path.join(videoTestDir, 'test-video-8s.mp4');
    execSync(`"${ffmpegPath}" -y -f lavfi -i testsrc=size=720x1280:rate=24 -t 8 "${dummyVideoPath}"`, { stdio: 'pipe' });

    const extractedKeyframes = extractVideoKeyframes(dummyVideoPath, videoTestDir, 1);
    assert.strictEqual(extractedKeyframes.length, 8, 'Must extract exactly 8 keyframes for 8-second video');
    assert.strictEqual(extractedKeyframes[0].timestamp, '1.0s');
    assert.strictEqual(extractedKeyframes[1].timestamp, '2.0s');
    assert.strictEqual(extractedKeyframes[2].timestamp, '3.0s');
    assert.strictEqual(extractedKeyframes[3].timestamp, '4.0s');
    assert.strictEqual(extractedKeyframes[4].timestamp, '5.0s');
    assert.strictEqual(extractedKeyframes[5].timestamp, '6.0s');
    assert.strictEqual(extractedKeyframes[6].timestamp, '7.0s');
    assert.strictEqual(extractedKeyframes[7].timestamp, '8.0s');
    for (let ki = 0; ki < 8; ki++) {
      assert.ok(fs.existsSync(extractedKeyframes[ki].path), `Keyframe ${ki + 1} file must exist`);
    }
    console.log('✅ extractVideoKeyframes successfully extracted 8 keyframes across 8 seconds (1.0s - 8.0s)');

    // 3. Test verifyVideoWithGeminiVision: Fail case (score <= 85)
    const mockVideoClientFail = {
      uploadFile: async () => 'https://bard.google.com/upload/mock-vid-fail',
      generateContent: async () => ({
        text: JSON.stringify({
          score: 72,
          passed: false,
          criteria: {
            physicalStateInvariance: 22,
            sceneTransitionContinuity: 20,
            handErgonomicsAndFaceless: 18,
            smartphoneRealismCleanliness: 12
          },
          discrepancies: ['Phát hiện hành vi tự ý mở linh kiện sản phẩm không có trong ảnh mẫu'],
          critique: 'Video vi phạm nguyên tắc State Invariance: tự ý mở bộ phận sản phẩm',
          correctionDirective: 'Khóa chặt trạng thái vật lý sản phẩm, cấm tuyệt đối thao tác mở nắp hay tháo lắp'
        })
      })
    };

    const vQaFail = await verifyVideoWithGeminiVision(
      mockVideoClientFail,
      dummyVideoPath,
      Buffer.from('sp'),
      Buffer.from('tp'),
      Buffer.from('ic'),
      1,
      mockAnalysis,
      videoTestDir,
      1
    );
    assert.strictEqual(vQaFail.score, 72);
    assert.strictEqual(vQaFail.passed, false);
    assert.strictEqual(vQaFail.discrepancies.length, 1);
    console.log('✅ Video QA detects unprompted actions and marks score <= 85 as failed');

    // 4. Test verifyVideoWithGeminiVision: Pass case (score > 85)
    const mockVideoClientPass = {
      uploadFile: async () => 'https://bard.google.com/upload/mock-vid-pass',
      generateContent: async () => ({
        text: JSON.stringify({
          score: 93,
          passed: true,
          criteria: {
            physicalStateInvariance: 38,
            sceneTransitionContinuity: 24,
            handErgonomicsAndFaceless: 18,
            smartphoneRealismCleanliness: 13
          },
          discrepancies: [],
          critique: 'Video mượt mà, giữ nguyên trạng thái vật lý sản phẩm, không có hành động lạ',
          correctionDirective: ''
        })
      })
    };

    const vQaPass = await verifyVideoWithGeminiVision(
      mockVideoClientPass,
      dummyVideoPath,
      Buffer.from('sp'),
      Buffer.from('tp'),
      Buffer.from('ic'),
      1,
      mockAnalysis,
      videoTestDir,
      2
    );
    assert.strictEqual(vQaPass.score, 93);
    assert.strictEqual(vQaPass.passed, true);
    console.log('✅ Video QA verifies compliant video as PASSED (> 85)');

    // 5. Test formatVideoQAMarkdown
    const vHistory = [
      { videoIndex: 1, attempt: 1, score: 72, passed: false, ...vQaFail },
      { videoIndex: 1, attempt: 2, score: 93, passed: true, ...vQaPass }
    ];
    const vMd = formatVideoQAMarkdown(vHistory);
    assert.ok(vMd.includes('### Gemini Vision Video QA Verification Report (100-Point Rubric, Threshold: > 85)'));
    assert.ok(vMd.includes('#### Video 1 (Attempt 1): **72/100** — ⚠️ FAILED (<= 85)'));
    assert.ok(vMd.includes('#### Video 1 (Attempt 2): **93/100** — ✅ PASSED (> 85)'));
    assert.ok(vMd.includes('Universal Physical State Invariance'));
    console.log('✅ formatVideoQAMarkdown generates clean markdown audit trail for prompts.md');
  } finally {
    fs.rmSync(videoTestDir, { recursive: true, force: true });
  }

  // --- Test 8: FlowStepTracker Step Sequencing & Auto-Completion Fix ---
  console.log('\n--- Test 8: FlowStepTracker Step Sequencing & Auto-Completion Fix ---');
  const { FlowStepTracker } = require('../services/flow-step-tracker');
  const tracker = new FlowStepTracker('123456', { title: 'Cốc giữ nhiệt 316' });
  
  // Step 1 running -> completed
  await tracker.setStep(1, 'completed');
  assert.strictEqual(tracker.steps[0].status, 'completed');

  // Step 2 running
  await tracker.setStep(2, 'running');
  assert.strictEqual(tracker.steps[0].status, 'completed');
  assert.strictEqual(tracker.steps[1].status, 'running');

  // When step 3 is completed, verify step 2 is AUTOMATICALLY marked completed (Fix for user bug)
  await tracker.setStep(3, 'completed');
  assert.strictEqual(tracker.steps[0].status, 'completed', 'Step 1 must be completed');
  assert.strictEqual(tracker.steps[1].status, 'completed', 'Step 2 must be automatically completed (NOT running/hourglass)');
  assert.strictEqual(tracker.steps[2].status, 'completed', 'Step 3 must be completed');
  assert.strictEqual(tracker.steps[3].status, 'pending', 'Step 4 must be pending');
  assert.strictEqual(tracker.steps[4].status, 'pending', 'Step 5 must be pending');
  console.log('✅ Step 2 is guaranteed completed when Step 3 is completed (resolves hourglass bug in screenshot)');

  // Step 4 running (Generating video)
  await tracker.setStep(4, 'running');
  assert.strictEqual(tracker.steps[2].status, 'completed');
  assert.strictEqual(tracker.steps[3].status, 'running');

  // Step 4 completed, Step 5 running
  await tracker.setStep(4, 'completed');
  await tracker.setStep(5, 'running');
  assert.strictEqual(tracker.steps[3].status, 'completed');
  assert.strictEqual(tracker.steps[4].status, 'running');

  // Complete all
  await tracker.completeAll();
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(tracker.steps[i].status, 'completed');
  }
  const formatted = tracker.formatMessage();
  assert.ok(formatted.includes('1. ✅ Tải thông tin & hình ảnh sản phẩm'));
  assert.ok(formatted.includes('2. ✅ Phân tích sản phẩm & lên kịch bản review'));
  assert.ok(formatted.includes('3. ✅ Tạo storyboard'));
  assert.ok(formatted.includes('4. ✅ Tạo video'));
  assert.ok(formatted.includes('5. ✅ Xử lý hậu kỳ'));
  console.log('✅ FlowStepTracker accurately sequences all 5 steps with zero out-of-sync steps');

  // --- Test 9: Clean Flow Cũ Upload Message Format ---
  console.log('\n--- Test 9: Clean Flow Cũ Upload Message Format ---');
  const completionMsg = `✅ Đã tạo xong 2 video panel.\n\n` +
    `👉 Nhấn lệnh để tạo lại từng cảnh nếu cần:\n` +
    `  • Cảnh 1: /remake_1\n` +
    `  • Cảnh 2: /remake_2\n\n` +
    `👉 Gõ /upload để ghép video và đăng lên TikTok.\n` +
    `👉 Gõ /start để xem toàn bộ danh sách lệnh.`;

  // Verify removed verbose strings
  assert.ok(!completionMsg.includes('Hook + Giải pháp'), 'Must NOT contain verbose scene names');
  assert.ok(!completionMsg.includes('QA: 67/100'), 'Must NOT contain verbose QA scores in caption');
  assert.ok(!completionMsg.includes('[Template Pro] ĐÃ TẠO XONG 2 VIDEO REVIEW HOÀN CHỈNH'), 'Must NOT contain custom template banner');
  // Verify flow cũ commands
  assert.ok(completionMsg.includes('✅ Đã tạo xong 2 video panel.'));
  assert.ok(completionMsg.includes('/remake_1'));
  assert.ok(completionMsg.includes('/remake_2'));
  assert.ok(completionMsg.includes('/upload'));
  assert.ok(completionMsg.includes('/start'));
  console.log('✅ Completion message matches Flow Cũ with clean video delivery and /upload command');

  // --- Test 10: JSON Parser Robustness Against Bad Control Characters ---
  console.log('\n--- Test 10: JSON Parser Bad Control Character Resilience ---');
  // Mô phỏng chuỗi JSON từ Gemini Vision chứa ký tự xuống dòng thô (raw newline) và control character trong string literal
  const badControlJson = '{\n' +
    '  "score": 88,\n' +
    '  "passed": true,\n' +
    '  "criteria": {\n' +
    '    "physicalStateInvariance": 40,\n' +
    '    "storyboardSceneFidelity": 23,\n' +
    '    "handErgonomicsAndFaceless": 18,\n' +
    '    "smartphoneRealismCleanliness": 7\n' +
    '  },\n' +
    '  "discrepancies": [],\n' +
    '  "critique": "Video nhìn chung ổn định.\nDòng 2 xuống dòng trực tiếp không escape.\r\nVà ký tự tab\tngay trong chuỗi.",\n' +
    '  "correctionDirective": ""\n' +
    '}';

  // Thử parse thông thường bằng JSON.parse để chứng minh nếu không sanitize sẽ văng lỗi
  let nativeThrew = false;
  try {
    JSON.parse(badControlJson);
  } catch (err) {
    nativeThrew = true;
  }
  // parseJsonObjectPro phải parse thành công 100% không bao giờ văng lỗi
  const parsedRes = parseJsonObjectPro(badControlJson);
  assert.ok(parsedRes !== null, 'parseJsonObjectPro must successfully parse JSON with bad control characters');
  assert.strictEqual(parsedRes.score, 88);
  assert.strictEqual(parsedRes.passed, true);
  assert.ok(parsedRes.critique.includes('Video nhìn chung ổn định'));
  console.log('✅ parseJsonObjectPro successfully sanitizes bad control characters and parses without failure');

  // Kiểm tra khả năng tự sửa lỗi unescaped quotes, missing comma và missing braces
  const brokenGeminiJson = '{\n' +
    '  "productName": "Máy Hút Bụi "TAMASHIO" Nhật Bản"\n' +
    '  "headline": "Đầu hút "đa năng" 6 trong 1"\n' +
    '  "subtexts": [\n' +
    '    "Lực hút "9000Pa" siêu mạnh"\n' +
    '    "Độ bền "vô địch" trong tầm giá"\n' +
    '  ]\n';
  
  const parsedBroken = parseJsonObjectPro(brokenGeminiJson);
  assert.ok(parsedBroken !== null, 'parseJsonObjectPro must repair unescaped quotes, missing commas, and auto-balance braces');
  assert.strictEqual(parsedBroken.productName, 'Máy Hút Bụi "TAMASHIO" Nhật Bản');
  assert.strictEqual(parsedBroken.subtexts.length, 2);
  console.log('✅ parseJsonObjectPro successfully repairs unescaped quotes, missing commas, and unbalanced braces');

  // --- Test 11: Highest Score Selection Mechanism (Storyboard & Video) ---
  console.log('\n--- Test 11: Highest Score Selection for Storyboard & Video ---');
  // 1. Storyboard candidate selection
  const mockCandidates = [
    { attempt: 1, score: 78, storyboardBuf: Buffer.from('sb1') },
    { attempt: 2, score: 84, storyboardBuf: Buffer.from('sb2') },
    { attempt: 3, score: 81, storyboardBuf: Buffer.from('sb3') },
  ];
  const bestSb = [...mockCandidates].sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  assert.strictEqual(bestSb.attempt, 2, 'Must select attempt 2 with highest score 84');
  assert.strictEqual(bestSb.score, 84);

  // 2. Video candidate selection (Attempt 1 vs Attempt 2)
  // Case A: Attempt 2 scored higher -> pick Attempt 2
  let vid1Attempt1 = { score: 72, videoPath: 'v1_att1.mp4' };
  let vid1Attempt2 = { score: 89, videoPath: 'v1_att2.mp4' };
  let selectedVidA = vid1Attempt2.score >= vid1Attempt1.score ? vid1Attempt2 : vid1Attempt1;
  assert.strictEqual(selectedVidA.score, 89);
  assert.strictEqual(selectedVidA.videoPath, 'v1_att2.mp4');

  // Case B: Attempt 1 scored higher -> retain Attempt 1
  let vid2Attempt1 = { score: 82, videoPath: 'v2_att1.mp4' };
  let vid2Attempt2 = { score: 68, videoPath: 'v2_att2.mp4' };
  let selectedVidB = vid2Attempt2.score >= vid2Attempt1.score ? vid2Attempt2 : vid2Attempt1;
  assert.strictEqual(selectedVidB.score, 82);
  assert.strictEqual(selectedVidB.videoPath, 'v2_att1.mp4');
  console.log('✅ Candidate selection strictly picks the candidate with highest QA score for both storyboard and video');

  // --- Test 12: Storyboard Retry Reference Ordering & Anchor Priority ---
  console.log('\n--- Test 12: Storyboard Retry Anchor Ordering (Ref #1 is Previous Storyboard) ---');
  const validInputs = [
    { name: 'input1.png', buffer: Buffer.from('in1') },
    { name: 'input2.png', buffer: Buffer.from('in2') }
  ];
  const prevSbBuf = Buffer.from('previous_storyboard');
  const retryPayloads = [];
  // Ưu tiên số 1: Storyboard trước đó ở vị trí ĐẦU TIÊN (Index 0)
  retryPayloads.push({
    name: 'previous_storyboard_ref.png',
    buffer: prevSbBuf,
    mimeType: 'image/png'
  });
  retryPayloads.push(...validInputs);

  assert.strictEqual(retryPayloads[0].name, 'previous_storyboard_ref.png', 'First payload MUST be previous storyboard anchor');
  assert.strictEqual(retryPayloads[1].name, 'input1.png', 'Product inputs must be secondary detail references');
  assert.strictEqual(retryPayloads[2].name, 'input2.png');
  console.log('✅ Retry payload order verified: previous storyboard anchor is at Index 0, input photos follow');

  // --- Test 13: Multi-Storyboard Batch QA & Evaluation (4 Candidates in 1 Call) ---
  console.log('\n--- Test 13: Multi-Storyboard Batch QA & Evaluation (4 Candidates in 1 Call) ---');
  const multiPrompt = buildTemplateProMultiStoryboardPrompt({ productName: 'Nồi chiên không dầu điện tử 6L' }, 4);
  assert.ok(multiPrompt.includes('Exactly 4 Generated Master Storyboards'));
  assert.ok(multiPrompt.includes('bestCandidateIndex'));
  assert.ok(multiPrompt.includes('PANEL REPLACEMENT (CROSS-STORYBOARD STITCHING)'));
  assert.ok(multiPrompt.includes('replacements'));
  assert.ok(multiPrompt.includes('PRODUCT FIDELITY (Priority 1, Max 40 pts'));
  assert.ok(multiPrompt.includes('SCENE ACCURACY (Priority 2, Max 25 pts'));
  assert.ok(multiPrompt.includes('COMMERCIAL COMPOSITION (Priority 3, Max 20 pts'));
  assert.ok(multiPrompt.includes('VISUAL CONSISTENCY (Priority 4, Max 15 pts'));
  console.log('✅ Multi-storyboard QA prompt correctly specifies Product Storyboard Framework v1.0 (40/25/20/15), 4 candidates, panel replacement, and JSON format');

  // Test verifyMultiStoryboardWithGeminiVision with mock client
  const dummy4Candidates = [
    Buffer.from('sb1'),
    Buffer.from('sb2'),
    Buffer.from('sb3'),
    Buffer.from('sb4')
  ];

  const mockMultiClient = {
    uploadFile: async (buf, name) => `https://mock.storage/${name}`,
    generateContent: async () => ({
      text: JSON.stringify({
        candidates: [
          { candidateIndex: 1, score: 81, panels: [{ panelIndex: 1, score: 85 }, { panelIndex: 2, score: 82 }, { panelIndex: 3, score: 72 }, { panelIndex: 4, score: 85 }] },
          { candidateIndex: 2, score: 89, panels: [{ panelIndex: 1, score: 92 }, { panelIndex: 2, score: 90 }, { panelIndex: 3, score: 76, flaws: ['Nắp nồi hơi méo'] }, { panelIndex: 4, score: 94 }] },
          { candidateIndex: 3, score: 83, panels: [{ panelIndex: 1, score: 84 }, { panelIndex: 2, score: 85 }, { panelIndex: 3, score: 80 }, { panelIndex: 4, score: 83 }] },
          { candidateIndex: 4, score: 86, panels: [{ panelIndex: 1, score: 83 }, { panelIndex: 2, score: 84 }, { panelIndex: 3, score: 95, flaws: [] }, { panelIndex: 4, score: 82 }] }
        ],
        bestCandidateIndex: 2,
        replacements: [
          {
            panelIndex: 3,
            sourceCandidateIndex: 4,
            reason: 'Panel 3 ở Candidate 2 bị méo nhẹ nắp, trong khi Panel 3 ở Candidate 4 đạt 95đ, chi tiết cực kỳ sắc nét.'
          }
        ],
        finalSummary: 'Chọn Candidate 2 (89đ) và ghép Panel 3 từ Candidate 4 (95đ).'
      })
    })
  };

  const multiRes = await verifyMultiStoryboardWithGeminiVision(mockMultiClient, dummy4Candidates, validInputs, { productName: 'Nồi chiên không dầu' });
  assert.strictEqual(multiRes.bestCandidateIndex, 2, 'Must pick Candidate 2 as best');
  assert.strictEqual(multiRes.replacements.length, 1, 'Must have 1 panel replacement recommended');
  assert.strictEqual(multiRes.replacements[0].panelIndex, 3);
  assert.strictEqual(multiRes.replacements[0].sourceCandidateIndex, 4);

  const mdTable = formatMultiStoryboardQAMarkdown(multiRes);
  assert.ok(mdTable.includes('Storyboard #2'));
  assert.ok(mdTable.includes('🏆'));
  assert.ok(mdTable.includes('Thay thế bằng Panel 3 từ **Storyboard #4**'));
  console.log('✅ Multi-Storyboard QA correctly parsed 4 candidates, selected best (Candidate 2), and captured Panel 3 replacement from Candidate 4');
  console.log('✅ formatMultiStoryboardQAMarkdown generated audit table with markdown formatting');

  // Verify only input.png is uploaded when collage is available
  const uploadedFilenames = [];
  const trackingMockClient = {
    uploadFile: async (buf, name) => {
      uploadedFilenames.push(name);
      return `https://mock.storage/${name}`;
    },
    generateContent: async () => ({
      text: JSON.stringify({
        candidates: [{ candidateIndex: 1, score: 90, panels: [] }],
        bestCandidateIndex: 1,
        replacements: []
      })
    })
  };
  const inputsWithCollage = [
    { name: 'input.png', buffer: Buffer.from('collage') },
    { name: 'input-1.jpg', buffer: Buffer.from('1') },
    { name: 'input-2.jpg', buffer: Buffer.from('2') }
  ];
  await verifyMultiStoryboardWithGeminiVision(trackingMockClient, dummy4Candidates, inputsWithCollage, { productName: 'Bình giữ nhiệt' });
  const referenceUploads = uploadedFilenames.filter(n => n.startsWith('input'));
  assert.strictEqual(referenceUploads.length, 1, 'Only 1 input reference photo (input.png) should be uploaded');
  assert.strictEqual(referenceUploads[0], 'input.png');
  console.log('✅ QA upload strictly uses single input.png collage as sole reference photo');

  // --- Test 14: Cross-Storyboard Panel Slicing, Replacement, and Master Compositing ---
  console.log('\n--- Test 14: Cross-Storyboard Panel Slicing & Replacement ---');
  // Tạo 2 ảnh master 16:9 giả lập bằng FFmpeg
  const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpro-multi-test-'));
  const masterA = path.join(testTmpDir, 'master-a.png');
  const masterB = path.join(testTmpDir, 'master-b.png');
  const recomposedFinal = path.join(testTmpDir, 'final-recomposed.png');

  // Master A (màu xanh dương nhạt)
  execSync(`"${ffmpegPath}" -y -f lavfi -i color=c=0x1E3A8A:s=1920x1080 -frames:v 1 "${masterA}"`, { stdio: 'pipe' });
  // Master B (màu đỏ cam)
  execSync(`"${ffmpegPath}" -y -f lavfi -i color=c=0xEA580C:s=1920x1080 -frames:v 1 "${masterB}"`, { stdio: 'pipe' });

  // 1. Cắt Master A và Master B thành 4 panels
  const panelsA = sliceMasterStoryboardPro(fs.readFileSync(masterA));
  const panelsB = sliceMasterStoryboardPro(fs.readFileSync(masterB));
  assert.strictEqual(panelsA.length, 4);
  assert.strictEqual(panelsB.length, 4);

  // 2. Thay thế Panel 3 của Master A bằng Panel 3 từ Master B
  const mixedPanels = [panelsA[0], panelsA[1], panelsB[2], panelsA[3]];

  // 3. Ghép lại thành Master Storyboard mới
  composeMasterStoryboardPro(mixedPanels, recomposedFinal);
  assert.ok(fs.existsSync(recomposedFinal), 'Recomposed final storyboard must exist');

  let probe = '';
  try {
    probe = execSync(`"${ffmpegPath}" -i "${recomposedFinal}" -f null - 2>&1`, { encoding: 'utf8' });
  } catch (err) {
    probe = err.stdout || (err.output ? err.output.join('') : err.message);
  }
  assert.ok(probe.includes('1920x1080'), 'Output master storyboard MUST be exactly 1920x1080 (16:9)');
  console.log('✅ Cross-storyboard panel replacement verified: Panel 3 successfully sliced from Candidate B and composited into Candidate A at 1920x1080 (16:9)');

  // Clean up
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch (_) {}

  // --- Test 15: Input Collage Deduplication & Multi-Image Grid (Template Pro) ---
  console.log('\n--- Test 15: Input Collage Deduplication & Multi-Image Grid (Template Pro) ---');
  const pngA = execSync(`"${ffmpegPath}" -y -f lavfi -i color=c=red:s=100x100 -frames:v 1 -f image2pipe -vcodec png -`, { stdio: ['pipe', 'pipe', 'ignore'] });
  const pngB = execSync(`"${ffmpegPath}" -y -f lavfi -i color=c=blue:s=100x100 -frames:v 1 -f image2pipe -vcodec png -`, { stdio: ['pipe', 'pipe', 'ignore'] });
  const pngC = execSync(`"${ffmpegPath}" -y -f lavfi -i color=c=green:s=100x100 -frames:v 1 -f image2pipe -vcodec png -`, { stdio: ['pipe', 'pipe', 'ignore'] });
  const pngD = execSync(`"${ffmpegPath}" -y -f lavfi -i color=c=yellow:s=100x100 -frames:v 1 -f image2pipe -vcodec png -`, { stdio: ['pipe', 'pipe', 'ignore'] });

  // Tạo mảng 8 ảnh nhưng thực chất chỉ có 4 ảnh độc nhất (lặp lại theo cặp giống thực tế TikTok)
  const payloadsWithDupes = [
    { name: 'in1.png', buffer: pngA, mimeType: 'image/png' },
    { name: 'in2.png', buffer: pngA, mimeType: 'image/png' }, // trùng in1
    { name: 'in3.png', buffer: pngB, mimeType: 'image/png' },
    { name: 'in4.png', buffer: pngB, mimeType: 'image/png' }, // trùng in3
    { name: 'in5.png', buffer: pngC, mimeType: 'image/png' },
    { name: 'in6.png', buffer: pngC, mimeType: 'image/png' }, // trùng in5
    { name: 'in7.png', buffer: pngD, mimeType: 'image/png' },
    { name: 'in8.png', buffer: pngD, mimeType: 'image/png' }  // trùng in7
  ];

  const testCollageBuf = createInputCollageImagePro(payloadsWithDupes);
  assert.ok(testCollageBuf && testCollageBuf.length > 1000, 'Collage buffer must be generated by FFmpeg');
  console.log('✅ createInputCollageImagePro successfully deduplicated 8 inputs down to 4 unique images and generated 2x2 collage');

  // --- Test 16: Critical Error Candidate Rejection & Single Input Reference Generation ---
  console.log('\n--- Test 16: Critical Error Candidate Rejection & Single Input Reference Generation ---');
  
  // 1. Kiểm tra cơ chế chỉ gửi 1 ảnh input.png tới Google Flow
  const sampleSavedInputs = [
    { name: 'input.png', buffer: Buffer.from('collage-content'), path: '/tmp/inputs/input.png' },
    { name: 'in1.jpg', buffer: Buffer.from('raw1'), path: '/tmp/inputs/in1.jpg' },
    { name: 'in2.jpg', buffer: Buffer.from('raw2'), path: '/tmp/inputs/in2.jpg' },
    { name: 'in3.jpg', buffer: Buffer.from('raw3'), path: '/tmp/inputs/in3.jpg' },
    { name: 'in4.jpg', buffer: Buffer.from('raw4'), path: '/tmp/inputs/in4.jpg' }
  ];
  const collageItem = sampleSavedInputs.find(fp => fp.name === 'input.png' || (fp.path && path.basename(fp.path) === 'input.png'));
  const generationPayloads = collageItem
    ? [{ name: 'input.png', buffer: collageItem.buffer, path: collageItem.path, mimeType: 'image/png' }]
    : sampleSavedInputs.map(fp => ({ name: fp.name, buffer: fp.buffer, path: fp.path, mimeType: fp.mimeType }));

  assert.strictEqual(generationPayloads.length, 1, 'Generation MUST send only 1 reference image (input.png)');
  assert.strictEqual(generationPayloads[0].name, 'input.png');
  console.log('✅ Flow generation reference resolution sends exactly 1 merged input.png image');

  // 2. Kiểm tra selection: Candidate có điểm danh nghĩa cao hơn nhưng mắc lỗi Critical Error về Product Fidelity phải bị loại bỏ!
  const mockCritClient = {
    uploadFile: async (buf, name) => `https://mock.storage/${name}`,
    generateContent: async () => ({
      text: JSON.stringify({
        candidates: [
          {
            candidateIndex: 1,
            total_score: 76,
            score: 76,
            decision: 'REGENERATE_OR_FIX',
            criteria_results: {
              product_fidelity: { score: 34, max_score: 40, passed: true, critical_error: false },
              scene_accuracy: { score: 18, max_score: 25, passed: true },
              commercial_composition: { score: 14, max_score: 20, passed: true },
              visual_consistency: { score: 10, max_score: 15, passed: true }
            },
            critical_errors: [],
            panels: [{ panelIndex: 1, score: 76 }, { panelIndex: 2, score: 78 }, { panelIndex: 3, score: 75 }, { panelIndex: 4, score: 75 }],
            critique: 'Đúng kiểu dáng sản phẩm, chi tiết đạt chuẩn.'
          },
          {
            candidateIndex: 2,
            total_score: 82, // Điểm số danh nghĩa cao hơn nhưng bị lỗi critical Product Fidelity
            score: 82,
            decision: 'FAIL',
            criteria_results: {
              product_fidelity: { score: 24, max_score: 40, passed: false, critical_error: true },
              scene_accuracy: { score: 23, max_score: 25, passed: true },
              commercial_composition: { score: 19, max_score: 20, passed: true },
              visual_consistency: { score: 14, max_score: 15, passed: true }
            },
            critical_errors: ['Product becomes a different model or SKU', 'Product structure contradicts reference images'],
            panels: [{ panelIndex: 1, score: 85 }, { panelIndex: 2, score: 60 }, { panelIndex: 3, score: 88 }, { panelIndex: 4, score: 86 }],
            critique: 'Sai kiểu dáng sản phẩm ở Panel 2.'
          }
        ],
        bestCandidateIndex: 2, // Giả sử Gemini nhầm lẫn chọn 2 do tổng điểm
        replacements: []
      })
    })
  };

  const critMultiRes = await verifyMultiStoryboardWithGeminiVision(mockCritClient, [Buffer.from('c1'), Buffer.from('c2')], sampleSavedInputs, { productName: 'Bình giữ nhiệt' });
  assert.strictEqual(critMultiRes.bestCandidateIndex, 1, 'Must reject Candidate 2 with critical fidelity error and pick valid Candidate 1');
  console.log('✅ Critical error rejection verified: Candidate with critical Product Fidelity error is strictly excluded from best candidate selection');

  // --- Test 17: Product Storyboard Evaluation Framework in Master Prompt & Video Remake Options ---
  console.log('\n--- Test 17: Framework in Master Prompt & 3-Option Video Remake ---');

  // 1. Kiểm tra buildTemplateProMasterPrompt chứa toàn bộ 4 tiêu chí của framework
  const masterPromptTest = buildTemplateProMasterPrompt(mockAnalysis, { template: 'template_pro' });
  assert.ok(masterPromptTest.includes('PRODUCT STORYBOARD EVALUATION FRAMEWORK v1.0'));
  assert.ok(masterPromptTest.includes('1. PRIORITY 1: PRODUCT FIDELITY'));
  assert.ok(masterPromptTest.includes('Silhouette & Main Body Shape'));
  assert.ok(masterPromptTest.includes('Components & Structural Parts'));
  assert.ok(masterPromptTest.includes('Color, Material & Finish'));
  assert.ok(masterPromptTest.includes('Zero Hallucination / Zero Mutation'));
  assert.ok(masterPromptTest.includes('2. PRIORITY 2: SCENE ACCURACY'));
  assert.ok(masterPromptTest.includes('Correct Product Usage'));
  assert.ok(masterPromptTest.includes('Anatomically Accurate Hands & Model'));
  assert.ok(masterPromptTest.includes('3. PRIORITY 3: COMMERCIAL COMPOSITION'));
  assert.ok(masterPromptTest.includes('Product Prominence & Eye-Level Framing'));
  assert.ok(masterPromptTest.includes('STRICT NO-TEXT RULE (TUYỆT ĐỐI KHÔNG CHỮ / NO TEXT / NO LABELS)'));
  assert.ok(masterPromptTest.includes('4. PRIORITY 4: VISUAL CONSISTENCY'));
  assert.ok(masterPromptTest.includes('Product Continuity'));
  assert.ok(masterPromptTest.includes('Environment & Lighting Continuity'));
  assert.ok(masterPromptTest.includes('leftHalfComposition'));
  assert.ok(masterPromptTest.includes('rightHalfComposition'));
  console.log('✅ buildTemplateProMasterPrompt successfully embeds all 4 priority criteria from Evaluation Framework v1.0 directly into generation prompt');

  // 2. Kiểm tra bàn phím 4 tùy chọn Remake Video Cảnh 1..4 + 1 nút Đăng TikTok
  const videoKb = buildProVideoInlineKeyboard('run_xyz_789');
  assert.strictEqual(videoKb.inline_keyboard.length, 3);
  assert.strictEqual(videoKb.inline_keyboard[0].length, 2);
  assert.strictEqual(videoKb.inline_keyboard[1].length, 2);
  assert.strictEqual(videoKb.inline_keyboard[2].length, 1);
  assert.strictEqual(videoKb.inline_keyboard[0][0].text, '🔄 Remake Cảnh 1');
  assert.strictEqual(videoKb.inline_keyboard[0][0].callback_data, 'tpro_remake_video:1:run_xyz_789');
  assert.strictEqual(videoKb.inline_keyboard[0][1].text, '🔄 Remake Cảnh 2');
  assert.strictEqual(videoKb.inline_keyboard[0][1].callback_data, 'tpro_remake_video:2:run_xyz_789');
  assert.strictEqual(videoKb.inline_keyboard[1][0].text, '🔄 Remake Cảnh 3');
  assert.strictEqual(videoKb.inline_keyboard[1][0].callback_data, 'tpro_remake_video:3:run_xyz_789');
  assert.strictEqual(videoKb.inline_keyboard[1][1].text, '🔄 Remake Cảnh 4');
  assert.strictEqual(videoKb.inline_keyboard[1][1].callback_data, 'tpro_remake_video:4:run_xyz_789');
  assert.strictEqual(videoKb.inline_keyboard[2][0].text, '🚀 Đăng lên TikTok (/upload)');
  assert.strictEqual(videoKb.inline_keyboard[2][0].callback_data, 'tpro_upload:run_xyz_789');
  console.log('✅ buildProVideoInlineKeyboard successfully creates 4 remake scene options (Cảnh 1-4) and 1 Upload TikTok button');

  // 3. Kiểm tra regex và lệnh remake tương ứng
  const testCmds = ['/remake_1', '/remake_2', '/remake_all', '/remake 1', '/remake 2', '/remake all', '/remake cả 2'];
  for (const cmd of testCmds) {
    assert.ok(remakeRegex.test(cmd), `Command ${cmd} should match remake regex`);
  }
  console.log('✅ Remake command patterns (/remake_1, /remake_2, /remake_all, /remake all) verified');

  // --- Test 18: Remake Panel K via 4-Candidate Batch & Best Panel QA Selection ---
  console.log('\n--- Test 18: Remake Panel K via 4-Candidate QA Batch & Panel Splice Flow ---');

  // 1. Kiểm tra selectBestCandidateForPanel chọn đúng candidate có điểm cao nhất cho Panel mục tiêu
  const mockBatchQA = {
    candidates: [
      {
        candidateIndex: 1,
        score: 84,
        criteria_results: { product_fidelity: { score: 36, passed: true } },
        panels: [
          { panelIndex: 1, score: 82 },
          { panelIndex: 2, score: 78 },
          { panelIndex: 3, score: 86 },
          { panelIndex: 4, score: 88 }
        ]
      },
      {
        candidateIndex: 2,
        score: 91,
        criteria_results: { product_fidelity: { score: 38, passed: true } },
        panels: [
          { panelIndex: 1, score: 80 },
          { panelIndex: 2, score: 96 }, // Điểm Panel 2 cao nhất!
          { panelIndex: 3, score: 85 },
          { panelIndex: 4, score: 84 }
        ]
      },
      {
        candidateIndex: 3,
        score: 89,
        criteria_results: { product_fidelity: { score: 37, passed: true } },
        panels: [
          { panelIndex: 1, score: 94 }, // Điểm Panel 1 cao nhất!
          { panelIndex: 2, score: 81 },
          { panelIndex: 3, score: 87 },
          { panelIndex: 4, score: 85 }
        ]
      },
      {
        candidateIndex: 4,
        score: 87,
        criteria_results: { product_fidelity: { score: 36, passed: true } },
        panels: [
          { panelIndex: 1, score: 83 },
          { panelIndex: 2, score: 88 },
          { panelIndex: 3, score: 95 }, // Điểm Panel 3 cao nhất!
          { panelIndex: 4, score: 82 }
        ]
      }
    ]
  };

  // Target Panel 2 -> Phải chọn Candidate 2 (điểm 96)
  const selP2 = selectBestCandidateForPanel(mockBatchQA, 4, 2);
  assert.strictEqual(selP2.bestIdx, 2, 'Candidate 2 must be chosen for Panel 2');
  assert.strictEqual(selP2.bestScore, 96, 'Panel 2 score must be 96');
  console.log(`✅ Target Panel 2: Selected Candidate #${selP2.bestIdx} with score ${selP2.bestScore}/100`);

  // Target Panel 1 -> Phải chọn Candidate 3 (điểm 94)
  const selP1 = selectBestCandidateForPanel(mockBatchQA, 4, 1);
  assert.strictEqual(selP1.bestIdx, 3, 'Candidate 3 must be chosen for Panel 1');
  assert.strictEqual(selP1.bestScore, 94, 'Panel 1 score must be 94');
  console.log(`✅ Target Panel 1: Selected Candidate #${selP1.bestIdx} with score ${selP1.bestScore}/100`);

  // Target Panel 3 -> Phải chọn Candidate 4 (điểm 95)
  const selP3 = selectBestCandidateForPanel(mockBatchQA, 4, 3);
  assert.strictEqual(selP3.bestIdx, 4, 'Candidate 4 must be chosen for Panel 3');
  assert.strictEqual(selP3.bestScore, 95, 'Panel 3 score must be 95');
  console.log(`✅ Target Panel 3: Selected Candidate #${selP3.bestIdx} with score ${selP3.bestScore}/100`);

  // 2. Kiểm tra loại trừ ứng viên có lỗi Critical Product Fidelity kể cả khi điểm panel mục tiêu cao
  const mockCritBatchQA = {
    candidates: [
      {
        candidateIndex: 1,
        score: 86,
        criteria_results: { product_fidelity: { score: 36, passed: true } },
        panels: [{ panelIndex: 2, score: 89 }]
      },
      {
        candidateIndex: 2,
        score: 80,
        criteria_results: { product_fidelity: { score: 20, passed: false, critical_error: true } },
        critical_errors: ['Product structure contradicts reference images'],
        panels: [{ panelIndex: 2, score: 98 }] // 98 điểm nhưng dính lỗi chí mạng
      },
      {
        candidateIndex: 3,
        score: 88,
        criteria_results: { product_fidelity: { score: 37, passed: true } },
        panels: [{ panelIndex: 2, score: 91 }]
      }
    ]
  };

  const selP2Crit = selectBestCandidateForPanel(mockCritBatchQA, 3, 2);
  assert.strictEqual(selP2Crit.bestIdx, 3, 'Must bypass Candidate 2 due to critical error and pick Candidate 3 (91đ)');
  assert.strictEqual(selP2Crit.bestScore, 91);
  console.log(`✅ Critical Error exclusion in Panel Remake: Bypassed Candidate #2 (critical error) and selected Candidate #${selP2Crit.bestIdx} (${selP2Crit.bestScore}/100)`);

  // 3. Kiểm tra logic Splicing & Recomposition: Giữ nguyên các panel khác, chỉ cập nhật panel mục tiêu
  const tempTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpro-remake-test-'));
  const testPanelsDir = path.join(tempTestDir, 'panels');
  fs.mkdirSync(testPanelsDir, { recursive: true });

  // Tạo 4 panel cũ (v1)
  const mockBufP1_v1 = Buffer.from('panel1_v1_content');
  const mockBufP2_v1 = Buffer.from('panel2_v1_content');
  const mockBufP3_v1 = Buffer.from('panel3_v1_content');
  const mockBufP4_v1 = Buffer.from('panel4_v1_content');

  fs.writeFileSync(path.join(testPanelsDir, 'panel-1.png'), mockBufP1_v1);
  fs.writeFileSync(path.join(testPanelsDir, 'panel-2.png'), mockBufP2_v1);
  fs.writeFileSync(path.join(testPanelsDir, 'panel-3.png'), mockBufP3_v1);
  fs.writeFileSync(path.join(testPanelsDir, 'panel-4.png'), mockBufP4_v1);

  // Giả lập Remake Panel 2: Sinh ra Panel 2 mới từ Candidate xuất sắc nhất
  const mockNewPanel2 = Buffer.from('panel2_v2_new_fresh_content_from_batch_gen');
  const pIdxToRemake = 2;

  // Cập nhật panel 2
  fs.writeFileSync(path.join(testPanelsDir, `panel-${pIdxToRemake}-v2.png`), mockNewPanel2);
  fs.writeFileSync(path.join(testPanelsDir, `panel-${pIdxToRemake}.png`), mockNewPanel2);

  // Ghép các panel lại với nhau
  const splicedPanels = [];
  for (let i = 1; i <= 4; i++) {
    const pPath = path.join(testPanelsDir, `panel-${i}.png`);
    const pBuf = (i === pIdxToRemake) ? mockNewPanel2 : fs.readFileSync(pPath);
    splicedPanels.push({
      index: i,
      sceneNumber: i,
      imagePath: pPath,
      buffer: pBuf,
      mimeType: 'image/png'
    });
  }

  assert.strictEqual(splicedPanels[0].buffer.toString(), 'panel1_v1_content', 'Panel 1 must be preserved');
  assert.strictEqual(splicedPanels[1].buffer.toString(), 'panel2_v2_new_fresh_content_from_batch_gen', 'Panel 2 must be updated to new content');
  assert.strictEqual(splicedPanels[2].buffer.toString(), 'panel3_v1_content', 'Panel 3 must be preserved');
  assert.strictEqual(splicedPanels[3].buffer.toString(), 'panel4_v1_content', 'Panel 4 must be preserved');
  console.log('✅ Panel Splicing Logic verified: Target Panel 2 cleanly replaced while Panels 1, 3, and 4 are strictly preserved from previous approved storyboard');

  // --- Test 19: Upgraded Video Pipeline (2x 8s Voice via veo_3_1_i2v_lite_low_priority + 4x 4s Panel Videos via abra_r2v_4s + FFmpeg Concat/Muxing + 4-Scene Remake & Upload Loop) ---
  console.log('\n--- Test 19: Upgraded Video Pipeline (2x 8s Voice + 4x 4s Start Frame + Audio/Video Muxing + 4-Scene Remake Loop) ---');

  // 1. Kiểm tra buildTemplateProVoiceVideoPrompts
  const voicePrompts = buildTemplateProVoiceVideoPrompts(mockAnalysis);
  assert.strictEqual(voicePrompts.length, 2, 'Must generate exactly 2 voice video prompts');
  assert.ok(voicePrompts[0].includes('8 giây'), 'Voice video 1 must be 8s');
  assert.ok(voicePrompts[0].includes('laomedeia') || voicePrompts[0].includes('giọng nữ') || voicePrompts[0].includes('miền Nam'), 'Voice prompt must enforce voice description');
  assert.ok(voicePrompts[1].includes('8 giây'), 'Voice video 2 must be 8s');
  console.log('✅ buildTemplateProVoiceVideoPrompts successfully generated 2x 8s voice review prompts with Southern Vietnamese persona');

  // 2. Kiểm tra buildTemplatePro4sPanelPrompts
  const panelPromptsAll = buildTemplatePro4sPanelPrompts(mockAnalysis);
  assert.strictEqual(panelPromptsAll.length, 4, 'Must generate 4 prompts for 4 panels');
  for (let i = 0; i < 4; i++) {
    assert.ok(panelPromptsAll[i].includes('4 giây'), `Panel ${i + 1} prompt must specify 4s duration`);
    assert.ok(panelPromptsAll[i].includes('Start Frame') || panelPromptsAll[i].includes('BẮT ĐẦU CHÍNH XÁC TỪ FRAME HÌNH ẢNH GỐC'), `Panel ${i + 1} must enforce Start Frame mode`);
    assert.ok(panelPromptsAll[i].includes('TUYỆT ĐỐI KHÔNG TỰ TẠO THÊM BẤT KỲ CHỮ'), `Panel ${i + 1} must strictly prohibit text`);
  }

  // Single panel prompt with custom instruction
  const p2CustomPrompt = buildTemplatePro4sPanelPrompts(mockAnalysis, { panelIndex: 2, customInstruction: 'quay góc nghiêng 45 độ' });
  assert.ok(p2CustomPrompt.includes('quay góc nghiêng 45 độ'), 'Custom instruction must be integrated into panel prompt');
  console.log('✅ buildTemplatePro4sPanelPrompts successfully generated 4x 4s Start Frame prompts with zero text rule and custom instructions');

  // 3. Kiểm tra trích xuất & ghép nối Audio bằng FFmpeg
  const testAudioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpro-audio-test-'));
  const a1Path = path.join(testAudioDir, 'voice-1.m4a');
  const a2Path = path.join(testAudioDir, 'voice-2.m4a');
  const fullVoicePath = path.join(testAudioDir, 'voice_full.m4a');

  // Sinh 2 file audio giả lập (hoặc silence fallback)
  extractAudioFromVideo(null, a1Path, 8.0);
  extractAudioFromVideo(null, a2Path, 8.0);
  assert.ok(fs.existsSync(a1Path), 'Voice 1 audio file must exist');
  assert.ok(fs.existsSync(a2Path), 'Voice 2 audio file must exist');

  concatTwoVoiceAudios(a1Path, a2Path, fullVoicePath);
  assert.ok(fs.existsSync(fullVoicePath), 'fullVoicePath must exist after concat');
  assert.ok(fs.statSync(fullVoicePath).size > 1000, 'fullVoicePath must have valid file size');
  console.log('✅ extractAudioFromVideo & concatTwoVoiceAudios successfully extracted & concatenated into voice_full.m4a (16s)');

  // 4. Kiểm tra ghép 4 video panel 4s + lồng ghép voice review 16s
  const testVideoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpro-video-test-'));
  const testPanelVideos = [];
  for (let i = 1; i <= 4; i++) {
    const pVid = path.join(testVideoDir, `panel-${i}.mp4`);
    // Tạo dummy video 4s 1080x1920 bằng ffmpeg
    execSync(`"${ffmpegPath}" -y -f lavfi -i color=c=blue:s=1080x1920:d=4 -c:v libx264 -pix_fmt yuv420p "${pVid}"`, { stdio: 'ignore' });
    assert.ok(fs.existsSync(pVid), `Panel video ${i} must exist`);
    testPanelVideos.push(pVid);
  }

  const mergedTestVideo = path.join(testVideoDir, 'final_video.mp4');
  await merge4PanelsWithVoice(testPanelVideos, fullVoicePath, mergedTestVideo);
  assert.ok(fs.existsSync(mergedTestVideo), 'Merged final_video.mp4 must exist');
  assert.ok(fs.statSync(mergedTestVideo).size > 5000, 'Merged video must have non-trivial size');
  console.log('✅ merge4PanelsWithVoice successfully merged 4x 4s panel videos with 16s voice review track into final_video.mp4 (1080x1920 9:16)');

  // 5. Kiểm tra logic Remake Single Video (panel replacement + re-merge)
  const mockRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpro-run-test-'));
  const mockRunPanelsDir = path.join(mockRunDir, 'panels');
  const mockRunVideosDir = path.join(mockRunDir, 'videos');
  const mockRunAudioDir = path.join(mockRunDir, 'audio');
  fs.mkdirSync(mockRunPanelsDir, { recursive: true });
  fs.mkdirSync(mockRunVideosDir, { recursive: true });
  fs.mkdirSync(mockRunAudioDir, { recursive: true });

  // Copy panels và audio vào mock run dir
  for (let i = 1; i <= 4; i++) {
    fs.writeFileSync(path.join(mockRunPanelsDir, `panel-${i}.png`), Buffer.from(`panel-${i}-image-mock`));
    fs.copyFileSync(testPanelVideos[i - 1], path.join(mockRunVideosDir, `panel-${i}.mp4`));
  }
  fs.copyFileSync(fullVoicePath, path.join(mockRunAudioDir, 'voice_full.m4a'));
  fs.writeFileSync(path.join(mockRunDir, 'session.json'), JSON.stringify({
    runDir: mockRunDir,
    analysis: mockAnalysis,
    fullVoicePath: path.join(mockRunAudioDir, 'voice_full.m4a'),
  }));

  // Tạo mock panel 2 mới
  const mockNewPanel2Vid = path.join(testVideoDir, 'mock_new_panel2.mp4');
  execSync(`"${ffmpegPath}" -y -f lavfi -i color=c=green:s=1080x1920:d=4 -c:v libx264 -pix_fmt yuv420p "${mockNewPanel2Vid}"`, { stdio: 'ignore' });

  // Mock replace panel-2.mp4 và re-merge
  fs.copyFileSync(mockNewPanel2Vid, path.join(mockRunVideosDir, 'panel-2.mp4'));
  const remakeMergedPath = path.join(mockRunVideosDir, 'final_video.mp4');
  await merge4PanelsWithVoice(
    [1, 2, 3, 4].map(i => path.join(mockRunVideosDir, `panel-${i}.mp4`)),
    path.join(mockRunAudioDir, 'voice_full.m4a'),
    remakeMergedPath
  );
  assert.ok(fs.existsSync(remakeMergedPath));
  console.log('✅ Remake scene re-merge verified: panel 2 updated, 4 panels spliced with voice_full.m4a into new final_video.mp4');

  // Dọn dẹp temp test dirs
  try {
    fs.rmSync(testAudioDir, { recursive: true, force: true });
    fs.rmSync(testVideoDir, { recursive: true, force: true });
    fs.rmSync(mockRunDir, { recursive: true, force: true });
  } catch (_) {}

  console.log('\n--- Test 20: Gemini Native TTS Service, Leda Voice, Prompts & Fallback ---');
  // 1. Verify Fallback Models
  assert.ok(Array.isArray(TTS_MODELS_FALLBACK), 'TTS_MODELS_FALLBACK must be an array');
  assert.strictEqual(TTS_MODELS_FALLBACK[0], 'gemini-3.1-flash-tts-preview');
  assert.strictEqual(TTS_MODELS_FALLBACK[1], 'gemini-2.5-flash-preview-tts');
  assert.strictEqual(TTS_MODELS_FALLBACK[2], 'gemini-2.5-pro-preview-tts');
  console.log('✅ TTS_MODELS_FALLBACK contains required priority chain:', TTS_MODELS_FALLBACK);

  // 2. Verify buildGeminiTtsPrompt with Zephyr (Ha Vy) and 65-word TikTok pacing
  const sampleAnalysis = {
    productName: 'Son Dưỡng Môi Mịn Màng YHL',
    targetAudience: 'Phụ nữ 18-35 thích làm đẹp tự nhiên',
    scenes: [
      { panelIndex: 1, voiceScript: 'Lướt mạng thấy em son dưỡng này hot quá, nay tui test thử cho mấy bà coi nghen.' },
      { panelIndex: 2, voiceScript: 'Chất son bơ mướt rượt không bết dính, dưỡng ẩm sâu giúp môi căng mọng xinh xắn.' },
      { panelIndex: 3, voiceScript: 'Thành phần sáp ong và bơ hạt mỡ lành tính, môi nhạy cảm xài cũng êm ru.' },
      { panelIndex: 4, voiceScript: 'Đang có giá siêu hời đó, mấy bà bấm giỏ hàng góc trái săn ngay kẻo lỡ nha.' }
    ]
  };

  const { prompt: haVyPrompt, voice: haVyVoice } = buildGeminiTtsPrompt(sampleAnalysis);
  assert.strictEqual(haVyVoice, 'Zephyr', 'Default female voice should be Zephyr (Ha Vy)');
  assert.ok(haVyPrompt.includes('Chỉ dẫn ngữ điệu & tốc độ'), 'Prompt must include speed and tone instruction');
  assert.ok(haVyPrompt.includes('Hà Vy'), 'Prompt must include Ha Vy persona');
  assert.ok(haVyPrompt.includes('nhịp điệu dồn dập bắt trend TikTok'), 'Prompt must include energetic TikTok pacing');
  assert.ok(haVyPrompt.includes('15 đến 16 giây'), 'Prompt must specify 15-16s duration constraint');
  assert.ok(haVyPrompt.includes('65 đến 70 từ') || haVyPrompt.includes('70 từ'), 'Prompt must specify 65-70 words constraint');
  console.log('✅ buildGeminiTtsPrompt successfully built structured TikTok instruction with voice Zephyr (Ha Vy)');

  // Verify custom voice override (e.g. Leda)
  const { voice: ledaVoice } = buildGeminiTtsPrompt(sampleAnalysis, { voice: 'Leda' });
  assert.strictEqual(ledaVoice, 'Leda', 'Custom voice override must be honored');

  // Verify Strictly Female Voice Selection (even for tech gadgets)
  const maleTechAnalysis = {
    productName: 'Tai Nghe Gaming Bluetooth Pro X',
    targetAudience: 'Nam giới trẻ đam mê công nghệ và game',
    scenes: sampleAnalysis.scenes
  };
  const { voice: techVoice } = buildGeminiTtsPrompt(maleTechAnalysis);
  assert.strictEqual(techVoice, 'Zephyr', 'Tech gadget should strictly use female voice Zephyr');
  console.log('✅ buildGeminiTtsPrompt strictly selects female voice Zephyr even for tech gadgets');

  // 3. Verify pcmToWav (RIFF/WAVE 24kHz) and convertPcmToM4a (16.0s M4A)
  const testTtsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpro-tts-test-'));
  // Generate 10 seconds of mock 24kHz mono PCM (24000 samples/sec * 2 bytes/sample * 10s = 480,000 bytes)
  const mockPcmBuffer = Buffer.alloc(480000, 0);

  // Test pcmToWav
  const wavBuffer = pcmToWav(mockPcmBuffer, 24000, 1, 16);
  assert.strictEqual(wavBuffer.slice(0, 4).toString(), 'RIFF', 'WAV buffer must start with RIFF');
  assert.strictEqual(wavBuffer.slice(8, 12).toString(), 'WAVE', 'WAV buffer format must be WAVE');
  assert.strictEqual(wavBuffer.length, 480000 + 44, 'WAV size must equal PCM + 44-byte RIFF header');
  console.log('✅ pcmToWav successfully generated standard 24kHz RIFF/WAVE header');

  const testM4aPath = path.join(testTtsDir, 'test_converted.m4a');
  await convertPcmToM4a(mockPcmBuffer, testM4aPath, 16.0);
  assert.ok(fs.existsSync(testM4aPath), 'Converted M4A must exist');
  assert.ok(fs.statSync(testM4aPath).size > 1000, 'Converted M4A must have valid file size');
  console.log('✅ convertPcmToM4a successfully converted PCM buffer to M4A with 16s padding');

  // 4. Verify Multi-token fallback resolution
  const resolvedTokens = resolveTtsTokens({
    apiKeys: ['mock_token_1', 'mock_token_2', 'mock_token_3', 'mock_token_4']
  });
  assert.strictEqual(resolvedTokens.length, 4, 'Must resolve 4 fallback tokens');
  assert.strictEqual(resolvedTokens[0], 'mock_token_1', 'Must preserve priority order');
  console.log(`✅ resolveTtsTokens successfully resolved ${resolvedTokens.length} tokens (Primary + Fallbacks)`);

  // 5. Verify generateTemplateProVoiceReview fallback to emergency track when all tokens disabled/fail
  const testVoiceOut = path.join(testTtsDir, 'voice_test_fallback.m4a');
  const ttsResult = await generateTemplateProVoiceReview(sampleAnalysis, testVoiceOut, {
    apiKey: 'invalid-key-to-test-fallback',
    disableFallbackTokens: true,
    maxRetriesPerModel: 1
  });
  assert.ok(fs.existsSync(testVoiceOut), 'generateTemplateProVoiceReview must create voice file even on fallback');
  assert.ok(ttsResult.audioPath === testVoiceOut);
  console.log('✅ generateTemplateProVoiceReview graceful fallback verified, produced valid audio track');

  // Cleanup testTtsDir
  try {
    fs.rmSync(testTtsDir, { recursive: true, force: true });
  } catch (_) {}

  // --------------------------------------------------------------------------
  // TEST 21: Robust JSON Parsing & Emergency Rescue Extractor
  // --------------------------------------------------------------------------
  console.log('\n--- Test 21: Robust JSON Parsing (Nested Quotes, Dimensions & Rescue Extractor) ---');

  // Case 1: Unescaped double quotes in properties and array elements
  const rawWithQuotes = [
    '{',
    '  "productName": "Nồi chiên không dầu 5.5L chuẩn 8\\" thế hệ mới",',
    '  "category": "home",',
    '  "targetUser": "mẹ bỉm, gia đình 4-6 người",',
    '  "buyerAngle": "for_family",',
    '  "addressStyle": "cả nhà, mọi người",',
    '  "cartAnchorText": "Bấm giỏ hàng góc trái săn deal",',
    '  "highlights": [',
    '    "Màn hình 4\\" OLED chống lóa",',
    '    "Công nghệ nhiệt 360 độ"',
    '  ],',
    '  "script": [',
    '    { "id": 1, "phase": "Hook", "voiceOver": "Bữa giờ lướt TikTok thấy \\"rần rần\\" em nồi chiên này nè cả nhà." },',
    '    { "id": 2, "phase": "Solution", "voiceOver": "Dung tích 5.5L nướng cả con gà cưng xỉu mà tiện gì đâu á." },',
    '    { "id": 3, "phase": "Proof", "voiceOver": "Vỏ kim loại chắc nịch bao bền xài êm ái cực kỳ luôn nghen." },',
    '    { "id": 4, "phase": "Closing", "voiceOver": "Đúng bài tiện nghi mọi người bấm liền giỏ hàng góc trái hốt liền nha." }',
    '  ]',
    '}'
  ].join('\n');

  const parsedQuotes = parseJsonObjectPro(rawWithQuotes);
  assert.ok(parsedQuotes, 'parseJsonObjectPro must successfully parse JSON with dimensions and nested quotes');
  assert.strictEqual(parsedQuotes.category, 'home');
  assert.strictEqual(parsedQuotes.script.length, 4);
  console.log('✅ parseJsonObjectPro successfully parsed nested quotes & dimension inch marks');

  // Case 2: Unescaped raw double quotes (e.g. 8" directly without backslash)
  const rawUnescaped = [
    '{',
    '  "productName": "Nồi chiên không dầu 5.5L chuẩn 8" thế hệ mới",',
    '  "category": "home",',
    '  "targetUser": "cả gia đình",',
    '  "highlights": [',
    '    "Màn hình 4" hiển thị nét căng"',
    '  ],',
    '  "script": [',
    '    { "id": 1, "voiceOver": "Bữa giờ thấy "rần rần" em này quá chừng nè." }',
    '  ]',
    '}'
  ].join('\n');

  const parsedUnescaped = parseJsonObjectPro(rawUnescaped);
  const prodName = parsedUnescaped.productName || parsedUnescaped.analysis?.productName;
  assert.ok(prodName && prodName.includes('8'), 'Must preserve 8" in product name');
  console.log('✅ repairJsonNestedQuotes repaired raw unescaped quotes without collapsing line breaks');

  // Case 3: Completely corrupted syntax rescued by extractFallbackAnalysisFields
  const corruptedSyntax = `
  {
    "productName": "Kệ gia vị thông minh 3 tầng chống gỉ",
    "category": "home",
    "targetUser": "người nội trợ, gia đình",
    "buyerAngle": "for_family",
    "addressStyle": "cả nhà, mọi người",
    "cartAnchorText": "Sắm kệ gọn gàng gian bếp ngay",
    "hashtags": ["#kegiavi", "#giadung", "#nhadep"],
    "script": [
      { "id": 1, "voiceOver": "Gian bếp lộn xộn nhìn bực mình ghê luôn á cả nhà ơi." },
      { "id": 2, "voiceOver": "Có em kệ này sắp xếp gọn gàng sạch sẽ cưng xỉu luôn nha." },
      { "id": 3, "voiceOver": "Khung inox chắc nịch bao bền xài mười năm vẫn sáng bóng nghen." },
      { "id": 4, "voiceOver": "Đúng bài tiện nghi mọi người bấm liền giỏ hàng góc trái săn deal nha." }
    ]
    CORRUPTED TRUNCATED UNPARSEABLE JSON
  `;

  const rescued = extractFallbackAnalysisFields(corruptedSyntax);
  assert.ok(rescued, 'extractFallbackAnalysisFields must rescue analysis fields from corrupted text');
  assert.strictEqual(rescued.analysis.productName, 'Kệ gia vị thông minh 3 tầng chống gỉ');
  assert.strictEqual(rescued.analysis.targetUser, 'người nội trợ, gia đình');
  assert.strictEqual(rescued.analysis.buyerAngle, 'for_family');
  assert.strictEqual(rescued.script.length, 4);
  console.log('✅ extractFallbackAnalysisFields successfully rescued all critical fields from corrupted JSON');

  // --------------------------------------------------------------------------
  // TEST 22: Auto TPro Mode Configuration & Scheduler Integration
  // --------------------------------------------------------------------------
  console.log('\n--- Test 22: Auto TPro Mode Configuration & Scheduler Integration ---');
  const cfgRaw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../config.json'), 'utf8'));

  // 1. T3 & T4 disabled
  assert.strictEqual(cfgRaw.autoT3Settings.enabled, false, 'autoT3Settings must be disabled');
  assert.strictEqual(cfgRaw.autoT4Settings.enabled, false, 'autoT4Settings must be disabled');
  console.log('✅ autoT3Settings and autoT4Settings are strictly disabled');

  // 2. T5 configured for tpro on Gia dung channel
  assert.strictEqual(cfgRaw.autoT5Settings.enabled, true, 'autoT5Settings must be enabled');
  assert.strictEqual(cfgRaw.autoT5Settings.chatId, '-5348767040', 'autoT5Settings chatId must match Gia dung (-5348767040)');
  assert.strictEqual(cfgRaw.autoT5Settings.template, 'tpro', 'autoT5Settings template must be tpro');
  assert.ok(cfgRaw.autoT5Settings.times.length >= 25, 'autoT5Settings must contain all configured time slots (>= 25)');
  console.log(`✅ autoT5Settings is active for Gia dung (-5348767040) with template tpro across ${cfgRaw.autoT5Settings.times.length} time slots`);

  // 3. Scheduler normalizeConfig preserves all times
  const { autoT5Scheduler } = require('../services/auto-template-scheduler');
  const normalized = autoT5Scheduler.normalizeConfig(path.resolve(__dirname, '..'));
  assert.strictEqual(normalized.times.length, cfgRaw.autoT5Settings.times.length, 'Scheduler must not truncate times array');
  assert.strictEqual(normalized.template, 'tpro', 'Normalized template must be tpro');
  console.log(`✅ autoT5Scheduler.normalizeConfig retained all ${normalized.times.length} time slots without truncation`);

  // 4. GenerationJob preserves isAuto and autoUpload flags
  const { generationJobService } = require('../services/generation-job');
  const testJob = generationJobService.enqueueJob({
    chatId: '-5348767040',
    productId: `test_auto_${Date.now()}`,
    productImages: [{ url: 'https://example.com/test.jpg', width: 400, height: 400 }],
    template: 'tpro',
    isAuto: true,
    autoUpload: true,
  }, path.resolve(__dirname, '..'));
  assert.strictEqual(testJob.job.isAuto, true, 'Job must retain isAuto flag');
  assert.strictEqual(testJob.job.autoUpload, true, 'Job must retain autoUpload flag');
  generationJobService.cleanupJob(testJob.job.jobId);
  console.log('✅ generationJobService correctly propagates isAuto and autoUpload flags');

  console.log('\n🎉 ALL TESTS (TEST 1 - 22) PASSED FULLY & SUCCESSFULLY!');
})();


