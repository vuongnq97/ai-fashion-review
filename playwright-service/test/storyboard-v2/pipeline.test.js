'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const ffmpegPath = require('ffmpeg-static');
const {
  assertApprovedPanels,
  applyPostProductionCopy,
  applyStoryboardCopy,
  buildContinuityPack,
  buildProductTruthProfile,
  clampVoiceover,
  composeStoryboardDeterministically,
  composeEvidenceBoard,
  evaluatePanelQa,
  enforceAttributePolicy,
  generateCoherentMasterWithQa,
  generateStoryboardV2,
  normalizeAudit,
  normalizeRunConfig,
  isV2Enabled,
  normalizeWorkingImages,
  routeCategoryAndSceneTypes,
  selectCanonicalImages,
  validateAndRewriteVisualScenes,
  videoHasAudio,
} = require('../../services/storyboard-v2');
const { clipPrompt, panelPrompt } = require('../../services/storyboard-v2/prompts');
const { parseJson } = require('../../services/storyboard-v2/provider-adapter');
const { buildTemplateOptions } = require('../../services/template-options');

function inputWithImages(count = 2) {
  return {
    productName: 'Fixture product', description: '',
    images: Array.from({ length: count }, (_, index) => ({ imageId: `img_0${index + 1}`, name: `img-${index + 1}.png`, mimeType: 'image/png', source: 'seller', buffer: Buffer.from('x'), original: {} })),
  };
}

function baseAudit(input) {
  return normalizeAudit({ assetAudit: { images: input.images.map((image, index) => ({ imageId: image.imageId, roles: [index ? 'variant_comparison' : 'hero_view'], containsMultipleVariants: index > 0, scores: { productShape: index ? 100 : 80, operation: 20, material: 20, sceneStyle: 20 }, ocrEvidence: [] })) } }, input);
}

function baseTruth() {
  return {
    canonicalProductName: 'Fixture product', category: 'home', canonicalReferenceIds: ['img_01'],
    visualIdentity: { shapeSummary: 'compact product', fixedComponents: [], forbiddenVisualChanges: [], logosAllowedToRemain: [] },
    unsupportedOrRiskyClaims: [], attributes: [], status: 'approved',
  };
}

function planWith(scenePatch = {}) {
  return { storyPlan: { scenes: [0, 1, 2, 3].map(index => ({
    sceneNumber: index + 1, phase: ['hook', 'solution', 'proof', 'closing'][index],
    visualClaim: 'Visible finish', primaryAction: 'Hold product steadily', productState: 'assembled',
    handsRequired: 1, handsAvailable: 2, evidenceIds: ['img_01'], voiceoverClaim: 'Sản phẩm tiện lợi.',
    ...(index === 2 ? scenePatch : {}),
  })) } };
}

function makeImageBuffer(width = 1080, height = 1920, color = 'blue') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-test-image-'));
  const file = path.join(dir, 'image.png');
  try {
    execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}`, '-frames:v', '1', file], { stdio: 'pipe' });
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('provider JSON parser repairs missing commas and trailing commas', () => {
  const parsed = parseJson(`\`\`\`json
  {
    "images": [
      {"imageId":"img_01"}
      {"imageId":"img_02"},
    ],
    "roles": [
      "hero_view"
      "detail_view"
    ],
  }
  \`\`\``);
  assert.equal(parsed.images.length, 2);
  assert.deepEqual(parsed.roles, ['hero_view', 'detail_view']);
});

test('comparison image is not selected as canonical when a clean product image exists', () => {
  const input = inputWithImages();
  const audit = baseAudit(input);
  assert.deepEqual(selectCanonicalImages(audit, 1), ['img_01']);
});

test('asset audit maps provider filenames and fractional scores back to internal image IDs', () => {
  const input = inputWithImages(2);
  input.images[0].name = '01.jpg';
  input.images[1].name = '06.jpg';
  const audit = normalizeAudit({ assetAudit: {
    images: [
      { imageId: '01.jpg', roles: ['variant_comparison'], containsMultipleVariants: true, scores: { productShape: 0.4 } },
      { imageId: '06.jpg', roles: ['hero_view'], scores: { productShape: 0.95 } },
    ],
    recommendedCanonicalImages: ['06.jpg'],
  } }, input);
  assert.equal(audit.images[1].imageId, 'img_02');
  assert.deepEqual(audit.images[1].roles, ['hero_view']);
  assert.equal(audit.images[1].scores.productShape, 95);
  assert.deepEqual(audit.recommendedCanonicalImages, ['img_02']);
});

test('600W and 1000W evidence becomes a conflict and is blocked from claim channels', () => {
  const input = inputWithImages();
  const audit = baseAudit(input);
  audit.images[0].ocrEvidence = ['Công suất 600W'];
  audit.images[1].ocrEvidence = ['Công suất 1000W'];
  const truth = buildProductTruthProfile({ productTruth: { category: 'home', status: 'approved', attributes: [] } }, audit, input);
  const power = truth.attributes.find(attribute => attribute.name === 'power');
  assert.equal(power.status, 'conflict');
  assert.equal(power.allowedInVisual, false);
  assert.equal(power.allowedInVoiceover, false);
});

test('resolved canonical variant continues while conflicted claims remain excluded', () => {
  const input = inputWithImages(1);
  const audit = baseAudit(input);
  audit.possibleVariants = ['X9', 'X9 Pro', 'X9 Plus'];
  const truth = buildProductTruthProfile({ productTruth: {
    canonicalProductName: 'Fixture product', canonicalVariant: 'X9', category: 'home', variantConfidence: 1, status: 'needs_review',
    attributes: [{ name: 'power', value: 600, unit: 'W', evidenceStatus: 'disputed', confidence: 1, sources: ['title', 'description'] }],
    openConflicts: [{ attribute: 'power' }],
  } }, audit, input);
  assert.equal(truth.variantConfidence, 100);
  assert.equal(truth.status, 'approved');
  assert.equal(truth.reviewDisposition, 'continued_with_unverified_claims_excluded');
  assert.equal(truth.attributes[0].status, 'conflict');
  assert.equal(truth.attributes[0].allowedInVoiceover, false);
});

test('scene requiring three hand roles is rewritten to one feasible action', () => {
  const config = normalizeRunConfig({ pipelineVersion: 'v2' });
  const routing = { humanMode: 'hands_only' };
  const result = validateAndRewriteVisualScenes(planWith({ primaryAction: 'Lift product and detach container and point at filter', handsRequired: 3, handsAvailable: 2 }), baseTruth(), routing, config);
  assert.notEqual(result.feasibility.scenes[2].status, 'fail');
  assert.ok(result.storyPlan.scenes[2].handsRequired <= 2);
  assert.equal(result.storyPlan.scenes[2].primaryAction, 'Lift product');
});

test('faceless mode removes facial expression requirements', () => {
  const config = normalizeRunConfig({ pipelineVersion: 'v2' });
  const result = validateAndRewriteVisualScenes(planWith({ visualClaim: 'Người mẫu mỉm cười hài lòng', primaryAction: 'Mỉm cười và cầm sản phẩm' }), baseTruth(), { humanMode: 'faceless_model' }, config);
  assert.doesNotMatch(`${result.storyPlan.scenes[2].visualClaim} ${result.storyPlan.scenes[2].primaryAction}`, /mỉm cười/i);
});

test('no-text prompt preserves a physical product mark but bans added text', () => {
  const continuity = buildContinuityPack({ ...baseTruth(), visualIdentity: { ...baseTruth().visualIdentity, logosAllowedToRemain: ['physical wordmark'] } }, { humanMode: 'none', environmentType: 'desk' }, { images: [] });
  const prompt = panelPrompt(planWith().storyPlan.scenes[0], continuity);
  assert.match(prompt, /preserve only an original product mark physically present/i);
  assert.match(prompt, /no added headline/i);
});

test('four 9:16 panels compose to a 4320x1920 9:4 master', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-compose-test-'));
  try {
    const panels = ['red', 'green', 'blue', 'yellow'].map((color, index) => ({ index: index + 1, buffer: makeImageBuffer(1080, 1920, color) }));
    const result = composeStoryboardDeterministically(panels, path.join(dir, 'storyboard.png'));
    assert.equal(result.width, 4320);
    assert.equal(result.height, 1920);
    assert.equal(result.aspectRatio, '9:4');
    assert.ok(fs.statSync(result.outputPath).size > 1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('numeric warranty, weight and power are removed from no-text visual claims', () => {
  const config = normalizeRunConfig({ pipelineVersion: 'v2' });
  const result = validateAndRewriteVisualScenes(planWith({ visualClaim: 'Công suất 1000W, nặng 1.8kg, bảo hành 12 tháng', primaryAction: 'Show product' }), baseTruth(), { humanMode: 'hands_only' }, config);
  assert.doesNotMatch(result.storyPlan.scenes[2].visualClaim, /1000W|1\.8kg|12 tháng/i);
  assert.match(`${result.storyPlan.scenes[2].voiceoverClaim} ${result.storyPlan.scenes[2].postProductionCopy}`, /1000W|1\.8kg|12 tháng/i);
});

test('conflicted attribute is blocked from visual, voice and post-production channels', () => {
  const config = normalizeRunConfig({ pipelineVersion: 'v2' });
  const truth = {
    ...baseTruth(),
    attributes: [{ name: 'power', value: 1000, unit: 'W', status: 'conflict', allowedInVisual: false, allowedInVoiceover: false, allowedInPostProductionCopy: false }],
  };
  const result = validateAndRewriteVisualScenes(planWith({ visualClaim: 'Công suất 1000W', voiceoverClaim: 'Công suất 1000W mạnh mẽ', postProductionCopy: '1000W' }), truth, { humanMode: 'hands_only' }, config);
  assert.equal(result.feasibility.overallStatus, 'needs_review');
  assert.equal(result.feasibility.scenes[2].checks.safetyAndClaims, false);
});

test('duplicate OCR evidence does not block a value allowed by a stronger description source', () => {
  const config = normalizeRunConfig({ pipelineVersion: 'v2' });
  const truth = {
    ...baseTruth(),
    attributes: [
      { name: 'product_weight', value: '1.8kg', status: 'description_only', allowedInVisual: false, allowedInVoiceover: true, allowedInPostProductionCopy: true },
      { name: 'weight', value: 1.8, unit: 'kg', status: 'poster_only', allowedInVisual: false, allowedInVoiceover: false, allowedInPostProductionCopy: false },
      { name: 'model', value: 'X9', status: 'description_only', allowedInVisual: false, allowedInVoiceover: true, allowedInPostProductionCopy: true },
    ],
  };
  const rawPlan = planWith();
  rawPlan.storyPlan.scenes[1] = {
    ...rawPlan.storyPlan.scenes[1],
    visualClaim: 'Máy X9 nhỏ gọn trên mặt bàn',
    voiceoverClaim: 'Máy nhẹ chỉ một phẩy tám ký.',
    postProductionCopy: 'Trọng lượng 1.8kg',
  };
  const result = validateAndRewriteVisualScenes(rawPlan, truth, { humanMode: 'hands_only' }, config);
  assert.notEqual(result.feasibility.overallStatus, 'needs_review');
  assert.equal(result.feasibility.scenes[1].checks.safetyAndClaims, true);
});

test('sensitive description-only claim is not allowed in voice-over', () => {
  const attribute = enforceAttributePolicy({ name: 'hiệu quả điều trị', value: 'mụn', status: 'description_only', confidence: 80, evidence: [] });
  assert.equal(attribute.allowedInVisual, false);
  assert.equal(attribute.allowedInVoiceover, false);
  assert.equal(attribute.allowedInPostProductionCopy, false);
});

test('QA scores returned on a 0-10 scale are normalized to 0-100', () => {
  const qa = evaluatePanelQa({ panelQa: { scores: { productIdentity: 9, physicalFeasibility: 9, sceneIntent: 9, continuity: 9, humanAnatomy: 9, realism: 9, noTextCompliance: 9 } } }, { valid: true });
  assert.equal(qa.score, 90);
  assert.equal(qa.decision, 'approve');
});

test('evidence board includes every received input image', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-evidence-test-'));
  try {
    const images = Array.from({ length: 8 }, (_, index) => ({ buffer: makeImageBuffer(240, 320, index % 2 ? 'blue' : 'red') }));
    const result = composeEvidenceBoard(images, path.join(dir, 'evidence.png'), { evidenceCellWidth: 120, evidenceCellHeight: 160 });
    assert.equal(result.imageCount, 8);
    assert.ok(fs.statSync(result.outputPath).size > 1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('video generation gate rejects any unapproved source panel', () => {
  assert.throws(() => assertApprovedPanels([1, 2, 3, 4].map(index => ({ index, status: index === 3 ? 'needs_review' : 'approved' }))), /not approved/);
});

test('voice-over respects configured words per second', () => {
  const result = clampVoiceover('một hai ba bốn năm sáu bảy tám chín mười mười một mười hai', 4, 2.5);
  assert.equal(result.maxWords, 10);
  assert.equal(result.wordCount, 10);
  assert.equal(result.truncated, true);
});

test('template5_2 defaults to provider voice and embeds the bounded script in each clip prompt', () => {
  const config = normalizeRunConfig({ pipelineVersion: 'v2', template: 'template5_2' });
  const scene = planWith().storyPlan.scenes[0];
  const prompt = clipPrompt(scene, {}, 4, config);
  assert.equal(config.voiceStrategy, 'provider');
  assert.match(prompt, /OFF-SCREEN VOICE-OVER/);
  assert.match(prompt, new RegExp(scene.voiceoverClaim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('shared V2 implementation contains no fixture-specific product name', () => {
  const root = path.resolve(__dirname, '../../services/storyboard-v2');
  const source = fs.readdirSync(root).filter(name => name.endsWith('.js')).map(name => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
  assert.doesNotMatch(source, new RegExp(['JETZT', 'X9'].join(' '), 'i'));
});

test('handbag and serum route to category-appropriate scene policies', () => {
  const config = normalizeRunConfig({ pipelineVersion: 'v2' });
  const audit = { images: [] };
  const bag = routeCategoryAndSceneTypes({ ...baseTruth(), category: 'handbag' }, audit, config);
  const serum = routeCategoryAndSceneTypes({ ...baseTruth(), category: 'serum' }, audit, config);
  assert.equal(bag.category, 'bags');
  assert.ok(bag.proofTypes.includes('compartment'));
  assert.equal(serum.category, 'cosmetics');
  assert.ok(serum.proofTypes.includes('texture'));
});

test('template5_2 is pinned to V1 even when V2 is requested globally', () => {
  const voice = buildTemplateOptions('template5_2', { pipelineVersion: 'v2' });
  const legacy53 = buildTemplateOptions('template5_3', { pipelineVersion: 'v2' });
  assert.equal(voice.pipelineVersion, 'v1');
  assert.equal(voice.panelCount, 2);
  assert.equal(voice.hasVoice, true);
  assert.equal(isV2Enabled({ template: 'template5_2', pipelineVersion: 'v2' }), false);
  assert.equal(isV2Enabled({ template: 'template5_1', pipelineVersion: 'v2' }), true);
  assert.notEqual(legacy53.pipelineVersion, 'v2');
  assert.equal(legacy53.panelCount, 4);
});

test('input normalization keeps originals and removes exact duplicate images', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-normalize-test-'));
  try {
    const image = makeImageBuffer(1080, 1920, 'purple');
    const input = inputWithImages(2);
    input.images[0].buffer = image;
    input.images[1].buffer = image;
    const normalized = normalizeWorkingImages(input, dir);
    assert.equal(normalized.input.images.length, 1);
    assert.equal(normalized.report.rejected[0].reason, 'exact_duplicate');
    assert.ok(fs.existsSync(normalized.input.images[0].originalPath));
    assert.ok(fs.existsSync(normalized.input.images[0].workingPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('post-production copy is rendered deterministically on storyboard and video', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-copy-test-'));
  try {
    const panelBuffer = makeImageBuffer();
    const panels = [1, 2, 3, 4].map(index => ({ index, buffer: panelBuffer }));
    const cleanStoryboard = path.join(dir, 'clean.png');
    composeStoryboardDeterministically(panels, cleanStoryboard);
    const storyboardCopy = applyStoryboardCopy(cleanStoryboard, path.join(dir, 'with-copy.png'), ['Móc câu', 'Giải pháp', 'Bằng chứng', 'Xem ngay']);
    assert.equal(storyboardCopy.copyApplied, true);
    assert.ok(fs.statSync(storyboardCopy.outputPath).size > 1000);

    const cleanVideo = path.join(dir, 'clean.mp4');
    execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=540x960:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', cleanVideo], { stdio: 'pipe' });
    const videoCopy = applyPostProductionCopy(cleanVideo, path.join(dir, 'with-copy.mp4'), 'Mua ngay hôm nay');
    assert.equal(videoCopy.copyApplied, true);
    assert.ok(fs.statSync(videoCopy.outputPath).size > 1000);
    assert.equal(videoHasAudio(videoCopy.outputPath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('V2 orchestrator generates one coherent master, validates its slices and composes the storyboard', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-orchestrator-test-'));
  try {
    const image = makeImageBuffer(1920, 1080);
    let imageCalls = 0;
    const adapter = {
      capabilities: { maxImageReferences: 4, supportsImageEdit: false, supportsInpainting: false },
      async analyzeStructured({ prompt }) {
        if (prompt.includes('Audit each provided')) {
          return { assetAudit: { images: [{ imageId: 'img_01', roles: ['hero_view'], contentType: 'photo', visibleProducts: ['fixture'], visibleGeometry: ['rectangular'], visibleInteractions: [], ocrEvidence: [], containsMultipleVariants: false, scores: { productShape: 95, operation: 50, material: 70, sceneStyle: 60 }, warnings: [] }], recommendedCanonicalImages: ['img_01'] } };
        }
        if (prompt.includes('Product Truth Profile')) {
          return { productTruth: { canonicalProductName: 'Fixture product', category: 'home', variantConfidence: 95, status: 'approved', visualIdentity: { dominantColors: ['blue'], shapeSummary: 'rectangular', fixedComponents: ['body'], movingOrDetachableComponents: [], logosAllowedToRemain: [], forbiddenVisualChanges: ['no redesign'] }, attributes: [], supportedUseCases: ['display'], unsupportedOrRiskyClaims: [], openConflicts: [] } };
        }
        if (prompt.includes('Create exactly four scenes')) return planWith();
        return { environment: { type: 'home', layout: 'fixed room' }, character: {}, camera: {}, negativeRules: [] };
      },
      async generateImage() { imageCalls++; return { buffer: image, mimeType: 'image/png' }; },
      async inspectImage() {
        return {
          masterQa: { scores: { productIdentity: 95, crossPanelContinuity: 95, physicalFeasibility: 95, sceneCoverage: 95, layoutCompliance: 95, noTextCompliance: 95 }, defects: [], hardRejectReasons: [] },
          panelQa: { scores: { productIdentity: 95, physicalFeasibility: 95, sceneIntent: 95, continuity: 95, humanAnatomy: 95, realism: 95, noTextCompliance: 95 }, defects: [], hardRejectReasons: [] },
        };
      },
    };
    const result = await generateStoryboardV2(dir, [{ imageId: 'img_01', name: 'fixture.png', mimeType: 'image/png', buffer: image }], {
      providerAdapter: adapter,
      template: 'template5_1',
      pipelineVersion: 'v2',
      qualityMode: 'balanced',
      generateVideos: false,
      runDir: path.join(dir, 'run'),
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.panels.length, 4);
    assert.ok(result.panels.every(panel => panel.status === 'approved'));
    assert.equal(imageCalls, 1);
    assert.equal(result.storyboard.width, 4320);
    assert.ok(fs.existsSync(result.reviewArchive.dataPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed slice causes the entire four-cell master to be regenerated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-master-retry-test-'));
  try {
    const image = makeImageBuffer(1920, 1080);
    const input = inputWithImages(1);
    input.images[0].buffer = image;
    const audit = baseAudit(input);
    audit.recommendedCanonicalImages = ['img_01'];
    const evidenceBoardPath = path.join(dir, 'evidence.png');
    composeEvidenceBoard(input.images, evidenceBoardPath);
    let generated = 0;
    let sceneTwoChecks = 0;
    const highPanelScores = { productIdentity: 95, physicalFeasibility: 95, sceneIntent: 95, continuity: 95, humanAnatomy: 95, realism: 95, noTextCompliance: 95 };
    const adapter = {
      capabilities: { supportsImageEdit: false },
      async generateImage() { generated++; return { buffer: image, mimeType: 'image/png' }; },
      async inspectImage({ prompt }) {
        if (prompt.includes('MASTER storyboard')) return { masterQa: { scores: { productIdentity: 95, crossPanelContinuity: 95, physicalFeasibility: 95, sceneCoverage: 95, layoutCompliance: 95, noTextCompliance: 95 } } };
        if (prompt.includes('"sceneNumber":2')) {
          sceneTwoChecks++;
          const score = sceneTwoChecks === 1 ? 70 : 95;
          return { panelQa: { scores: Object.fromEntries(Object.keys(highPanelScores).map(key => [key, score])), correctionPrompt: 'Correct Scene 2 but preserve all other cells' } };
        }
        return { panelQa: { scores: highPanelScores } };
      },
    };
    const manifest = { data: { panels: [] }, save() {} };
    const result = await generateCoherentMasterWithQa({
      adapter, storyPlan: planWith().storyPlan,
      continuity: buildContinuityPack(baseTruth(), { humanMode: 'hands_only', environmentType: 'home' }, audit),
      input, truth: baseTruth(), audit, config: normalizeRunConfig({ pipelineVersion: 'v2', maxPanelRetries: 2 }),
      panelDir: path.join(dir, 'panels'), runDir: dir, manifest, evidenceBoardPath,
    });
    assert.equal(result.status, 'approved');
    assert.equal(generated, 2);
    assert.equal(result.history.length, 2);
    assert.ok(result.panels.every(panel => panel.masterAttempt === 2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fast mode uses one contact-sheet call when all draft panels pass QA', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-fast-test-'));
  try {
    const image = makeImageBuffer(1920, 1080);
    let imageCalls = 0;
    const adapter = {
      capabilities: { maxImageReferences: 4, supportsImageEdit: false },
      async analyzeStructured({ prompt }) {
        if (prompt.includes('Audit each provided')) return { assetAudit: { images: [{ imageId: 'img_01', roles: ['hero_view'], scores: { productShape: 95 } }], recommendedCanonicalImages: ['img_01'] } };
        if (prompt.includes('Product Truth Profile')) return { productTruth: { canonicalProductName: 'Fixture', category: 'other', variantConfidence: 90, status: 'approved', visualIdentity: {}, attributes: [], unsupportedOrRiskyClaims: [] } };
        if (prompt.includes('Create exactly four scenes')) return planWith();
        return {};
      },
      async generateImage() { imageCalls++; return { buffer: image, mimeType: 'image/png' }; },
      async inspectImage() { return {
        masterQa: { scores: { productIdentity: 95, crossPanelContinuity: 95, physicalFeasibility: 95, sceneCoverage: 95, layoutCompliance: 95, noTextCompliance: 95 } },
        panelQa: { scores: { productIdentity: 95, physicalFeasibility: 95, sceneIntent: 95, continuity: 95, humanAnatomy: 95, realism: 95, noTextCompliance: 95 } },
      }; },
    };
    const result = await generateStoryboardV2(dir, [{ imageId: 'img_01', name: 'fixture.png', mimeType: 'image/png', buffer: image }], { providerAdapter: adapter, template: 'template5_1', qualityMode: 'fast', generateVideos: false, runDir: path.join(dir, 'run') });
    assert.equal(result.status, 'completed');
    assert.equal(imageCalls, 1);
    assert.equal(result.panels.length, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
