'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { normalizeAudit, normalizeInput } = require('./contracts');
const { normalizeWorkingImages } = require('./asset-normalizer');
const { normalizeRunConfig } = require('./config');
const { buildProductTruthProfile } = require('./product-truth');
const { routeCategoryAndSceneTypes } = require('./category-router');
const { validateAndRewriteVisualScenes } = require('./visual-feasibility');
const { buildContinuityPack } = require('./continuity-pack');
const { assertApprovedPanels, evaluateClipQa, evaluateMasterQa, evaluatePanelQa } = require('./qa');
const { composeEvidenceBoard, composeStoryboardDeterministically, splitMasterStoryboard } = require('./storyboard-compositor');
const { RunManifest } = require('./run-manifest');
const { createDefaultProviderAdapter } = require('./provider-adapter');
const prompts = require('./prompts');
const { applyStoryboardCopy, postProcessFinalVideo } = require('./post-process');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeRunId(value) {
  return String(value || `v2-${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .slice(0, 160);
}

function inspectImageDimensions(buffer) {
  const tempPath = path.join(require('os').tmpdir(), `storyboard-v2-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  try {
    fs.writeFileSync(tempPath, buffer);
    try {
      execFileSync(ffmpegPath, ['-i', tempPath], { stdio: 'pipe', timeout: 10000 });
    } catch (error) {
      const output = `${error.stderr || ''}${error.stdout || ''}`;
      const match = output.match(/Video:.*?\s(\d{2,5})x(\d{2,5})(?:[\s,])/s);
      if (match) return { width: Number(match[1]), height: Number(match[2]) };
    }
    return null;
  } finally {
    try { fs.unlinkSync(tempPath); } catch (_) {}
  }
}

function deterministicImageQa(buffer, config) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1000) return { valid: false, hardRejectReasons: ['invalid_image_file'] };
  const dimensions = inspectImageDimensions(buffer);
  if (!dimensions) return { valid: false, hardRejectReasons: ['unreadable_image_dimensions'] };
  const ratio = dimensions.width / dimensions.height;
  const target = config.panelWidth / config.panelHeight;
  const validRatio = Math.abs(ratio - target) <= 0.03;
  return { valid: validRatio, dimensions, hardRejectReasons: validRatio ? [] : ['wrong_aspect_ratio'] };
}

function deterministicMasterQa(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1000) return { valid: false, hardRejectReasons: ['invalid_image_file'] };
  const dimensions = inspectImageDimensions(buffer);
  if (!dimensions) return { valid: false, hardRejectReasons: ['unreadable_image_dimensions'] };
  const ratio = dimensions.width / dimensions.height;
  const validRatio = dimensions.width > dimensions.height && Math.abs(ratio - (16 / 9)) <= 0.2;
  return { valid: validRatio, dimensions, hardRejectReasons: validRatio ? [] : ['wrong_master_aspect_ratio'] };
}

function videoHasAudio(videoPath) {
  try {
    execFileSync(ffmpegPath, ['-i', videoPath], { stdio: 'pipe', timeout: 10000 });
  } catch (error) {
    return /Audio:\s/iu.test(`${error.stderr || ''}${error.stdout || ''}`);
  }
  return false;
}

function toReferencePayloads(input) {
  return input.images.map(image => ({ name: image.name, mimeType: image.mimeType, buffer: image.buffer, path: image.uri, imageId: image.imageId }));
}

function buildLegacyAnalysis(truth, storyPlan, routing) {
  return {
    productName: truth.canonicalProductName,
    category: truth.category,
    targetAudience: storyPlan.targetAudience || '',
    highlights: truth.attributes.filter(item => item.allowedInVoiceover).slice(0, 3).map(item => `${item.name}: ${item.value ?? ''} ${item.unit || ''}`.trim()),
    hashtags: ['#review', '#sanpham', '#tiktokshop', '#xuhuong', '#trending'],
    voicePersona: { gender: 'auto', voiceDescription: 'configured post-production voice', tone: 'natural product review' },
    sceneContext: { location: routing.environmentType, lighting: 'consistent natural light', mood: 'authentic' },
    script: storyPlan.scenes.map(scene => ({ id: scene.sceneNumber, phase: scene.phase, goal: scene.marketingIntent, voiceOver: scene.voiceoverClaim, visualDescription: scene.visualDescription || scene.visualClaim, techVFX: scene.primaryAction, cameraAction: 'one restrained camera movement' })),
    productTruth: truth,
    storyPlan,
  };
}

function buildAnalysisSummary(truth, audit, feasibility) {
  const excludedClaims = (truth.attributes || [])
    .filter(attribute => !attribute.allowedInVisual || !attribute.allowedInVoiceover)
    .slice(0, 8)
    .map(attribute => ({ name: attribute.name, value: attribute.value, status: attribute.status }));
  return {
    canonicalProductName: truth.canonicalProductName,
    canonicalVariant: truth.canonicalVariant || '',
    canonicalReferenceIds: truth.canonicalReferenceIds || audit.recommendedCanonicalImages || [],
    receivedImageCount: (audit.images || []).length,
    conflicts: [...(audit.crossImageConflicts || []), ...(truth.openConflicts || [])].slice(0, 8),
    excludedReferenceIds: audit.excludedGenerationReferences || [],
    excludedClaims,
    sceneChanges: (feasibility.scenes || []).filter(scene => scene.rewritten || scene.status === 'rewritten').map(scene => ({ sceneNumber: scene.sceneNumber, reasons: scene.reasons || scene.issues || [] })),
  };
}

function selectMasterReferences(input, truth, audit, evidenceBoardPath, config) {
  const orderedIds = [
    ...(truth.canonicalReferenceIds || []),
    ...(audit.recommendedDetailImages || []),
    ...(audit.recommendedCanonicalImages || []),
  ];
  const seen = new Set();
  const direct = orderedIds
    .map(id => input.images.find(image => image.imageId === id))
    .filter(image => image && !seen.has(image.imageId) && seen.add(image.imageId))
    .slice(0, Math.max(1, config.maxImageReferencesPerCall - 1))
    .map(image => ({ name: image.name, mimeType: image.mimeType, buffer: image.buffer, path: image.uri, imageId: image.imageId }));
  if (evidenceBoardPath && fs.existsSync(evidenceBoardPath)) {
    direct.push({ name: 'all-input-evidence-board.png', mimeType: 'image/png', buffer: fs.readFileSync(evidenceBoardPath), path: evidenceBoardPath, imageId: 'all_input_evidence_board', role: 'context_only' });
  }
  return direct.slice(0, config.maxImageReferencesPerCall);
}

async function generateCoherentMasterWithQa({ adapter, storyPlan, continuity, input, truth, audit, config, panelDir, runDir, manifest, evidenceBoardPath, customInstruction = '' }) {
  const references = selectMasterReferences(input, truth, audit, evidenceBoardPath, config);
  const history = [];
  let correction = String(customInstruction || '').trim();
  let previousBuffer = null;
  const maxAttempts = config.maxPanelRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = prompts.coherentMasterPrompt(storyPlan, continuity, truth, audit, input, correction);
    let generated;
    if (attempt > 1 && previousBuffer && adapter.capabilities?.supportsImageEdit && typeof adapter.editImage === 'function') {
      generated = await adapter.editImage({ image: previousBuffer, prompt, references, aspectRatio: '16:9' });
    } else {
      generated = await adapter.generateImage({ prompt, references, aspectRatio: '16:9' });
    }
    previousBuffer = generated.buffer;
    const deterministicMaster = deterministicMasterQa(generated.buffer);
    const split = deterministicMaster.valid
      ? splitMasterStoryboard(generated.buffer, panelDir, config, attempt)
      : { sourcePath: path.join(runDir, `master-attempt-${attempt}.png`), panels: [] };
    if (!deterministicMaster.valid) fs.writeFileSync(split.sourcePath, generated.buffer);

    const rawMasterQa = deterministicMaster.valid
      ? await adapter.inspectImage({ image: generated.buffer, prompt: prompts.masterQaPrompt(storyPlan, truth, continuity), references: references.slice(0, 3) })
      : {};
    const masterQa = evaluateMasterQa(rawMasterQa, deterministicMaster);
    const panels = [];
    if (deterministicMaster.valid) {
      for (const draft of split.panels) {
        const scene = storyPlan.scenes.find(item => Number(item.sceneNumber) === draft.sceneNumber);
        const deterministic = deterministicImageQa(draft.buffer, config);
        const rawPanelQa = deterministic.valid
          ? await adapter.inspectImage({ image: draft.buffer, prompt: prompts.panelQaPrompt(scene, truth, continuity), references: references.slice(0, 3) })
          : {};
        const qa = evaluatePanelQa(rawPanelQa, deterministic);
        panels.push({ ...draft, index: draft.sceneNumber, status: qa.decision === 'approve' ? 'approved' : 'needs_review', attempt, prompt, qa });
      }
    }
    const approved = masterQa.decision === 'approve' && panels.length === 4 && panels.every(panel => panel.status === 'approved');
    history.push({ attempt, masterPath: split.sourcePath, masterQa, panels: panels.map(panel => ({ sceneNumber: panel.sceneNumber, imagePath: panel.imagePath, qa: panel.qa, status: panel.status })) });
    manifest.data.masterStoryboard = { status: approved ? 'approved' : 'retrying', attempt, imagePath: split.sourcePath, qa: masterQa, history };
    manifest.data.panels = panels.map(panel => ({ ...panel, buffer: undefined }));
    manifest.save();
    if (approved) {
      const approvedMasterPath = path.join(runDir, 'generated-master.png');
      fs.copyFileSync(split.sourcePath, approvedMasterPath);
      for (const panel of panels) {
        const approvedPath = path.join(panelDir, `panel-${panel.sceneNumber}.png`);
        fs.copyFileSync(panel.imagePath, approvedPath);
        panel.imagePath = approvedPath;
        panel.imageBase64 = panel.buffer.toString('base64');
        panel.masterAttempt = attempt;
      }
      manifest.data.masterStoryboard = { status: 'approved', attempt, imagePath: approvedMasterPath, qa: masterQa, history };
      manifest.data.panels = panels.map(panel => ({ ...panel, buffer: undefined, imageBase64: undefined }));
      manifest.save();
      return { status: 'approved', masterPath: approvedMasterPath, masterQa, panels, history };
    }

    const corrections = [
      masterQa.correctionPrompt,
      ...masterQa.defects.map(defect => defect.description),
      ...panels.filter(panel => panel.status !== 'approved').flatMap(panel => [
        `Scene ${panel.sceneNumber}: ${panel.qa.correctionPrompt}`,
        ...panel.qa.defects.map(defect => `Scene ${panel.sceneNumber}: ${defect.description}`),
      ]),
    ].filter(Boolean);
    correction = corrections.slice(0, 12).join('; ') || 'Keep one identical canonical product and correct all four cells as a single coherent shoot';
  }

  const last = history.at(-1);
  const panels = (last?.panels || []).map(panel => ({ ...panel, index: panel.sceneNumber, status: 'needs_review' }));
  manifest.data.masterStoryboard = { status: 'needs_review', attempt: maxAttempts, imagePath: last?.masterPath || null, qa: last?.masterQa || null, history };
  manifest.data.panels = panels;
  manifest.save();
  return { status: 'needs_review', masterPath: last?.masterPath || null, masterQa: last?.masterQa || null, panels, history };
}

async function generateApprovedClips({ adapter, panels, scenes, continuity, config, clipDir, manifest, baseDir }) {
  assertApprovedPanels(panels, 4);
  const clips = [];
  for (const panel of panels) {
    const scene = scenes.find(item => item.sceneNumber === panel.sceneNumber);
    let correction = '';
    let approved = null;
    const history = [];
    for (let attempt = 1; attempt <= config.maxClipRetries + 1; attempt++) {
      const prompt = `${prompts.clipPrompt(scene, continuity, config.sceneDurationSeconds, config)}${correction ? `\nTARGETED CORRECTION: ${correction}` : ''}`;
      const jobs = [{ index: scene.sceneNumber, panelIndex: scene.sceneNumber, imagePath: panel.imagePath, prompt, videoModelKey: '4s' }];
      const [result] = await adapter.generateVideos(jobs, { aspectRatio: '9:16', videoModelKey: '4s', includeVideoBase64: config.includeVideoBase64 });
      if (!result || result.error || !result.videoPath || !fs.existsSync(result.videoPath)) {
        history.push({ attempt, error: result?.error || 'video provider returned no file' });
        correction = 'Use a nearly static camera and only the specified action';
        continue;
      }
      if (config.voiceStrategy === 'provider' && !videoHasAudio(result.videoPath)) {
        history.push({ attempt, videoPath: result.videoPath, error: 'provider clip is missing required voice-over audio' });
        correction = `Include the exact off-screen Vietnamese voice-over: "${scene.voiceoverClaim}"`;
        continue;
      }
      const rawQa = await adapter.inspectVideo({ videoPath: result.videoPath, prompt: prompts.clipQaPrompt(scene), references: [{ name: 'approved-panel.png', mimeType: 'image/png', buffer: panel.buffer }] });
      const qa = evaluateClipQa(rawQa, { valid: true });
      history.push({ attempt, videoPath: result.videoPath, qa });
      if (qa.decision === 'approve') {
        const target = path.join(clipDir, `scene-${scene.sceneNumber}.mp4`);
        fs.copyFileSync(result.videoPath, target);
        approved = { ...result, panelIndex: scene.sceneNumber, sceneNumber: scene.sceneNumber, status: 'approved', videoPath: target, qa, history };
        break;
      }
      correction = qa.correctionPrompt || (attempt >= config.maxClipRetries ? 'Keep the source frame nearly static with only a gentle push-in' : 'Correct the observed motion defect');
    }
    clips.push(approved || { panelIndex: panel.sceneNumber, sceneNumber: panel.sceneNumber, status: 'needs_review', history, error: 'Clip QA failed' });
    manifest.data.clips = clips.map(clip => ({ ...clip, video: undefined }));
    manifest.save();
  }
  if (clips.some(clip => clip.status !== 'approved')) return { clips, finalVideoPath: null };
  const finalDir = path.join(manifest.root, 'final');
  ensureDir(finalDir);
  const finalVideoPath = path.join(finalDir, 'final-video.mp4');
  await postProcessFinalVideo(clips, finalVideoPath, {
    finalVideoDurationSeconds: config.finalVideoDurationSeconds,
    copyByScene: config.textMode === 'with_post_copy' ? scenes.map(scene => scene.postProductionCopy) : [],
    preserveClipAudio: config.voiceStrategy === 'provider',
  });
  return { clips, finalVideoPath };
}

async function generateStoryboardV2(baseDir, filePayloads, options = {}) {
  const config = normalizeRunConfig({ ...options, pipelineVersion: 'v2' });
  const rawInput = normalizeInput(filePayloads, options);
  const runId = safeRunId(options.runId);
  const runDir = options.runDir || path.join(baseDir, 'storyboard-review-runs', `${runId}-${config.template}-v2`);
  const panelDir = path.join(runDir, 'panels');
  const clipDir = path.join(runDir, 'clips');
  ensureDir(panelDir);
  ensureDir(clipDir);
  const activeMarker = path.join(runDir, '.active');
  fs.writeFileSync(activeMarker, `${process.pid}\n`, 'utf8');
  const manifest = new RunManifest(runId, runDir, config);
  let adapter = null;
  const progress = typeof options.onProgress === 'function' ? options.onProgress : async () => {};

  try {
    const normalized = normalizeWorkingImages(rawInput, runDir, options);
    const input = normalized.input;
    const references = toReferencePayloads(input);
    const evidenceBoardPath = path.join(runDir, 'all-input-evidence-board.png');
    const evidenceBoard = composeEvidenceBoard(input.images, evidenceBoardPath);
    adapter = options.providerAdapter || createDefaultProviderAdapter(baseDir, {
      ...options,
      diagnosticsDir: path.join(runDir, 'provider-diagnostics'),
    });
    manifest.stage('normalizeInput', 'completed', { productInput: input, assetNormalization: normalized.report, evidenceBoard });
    await progress({ currentStep: 'asset_audit', stepOrder: 2, progressPercent: 10, message: 'Đang phân loại và kiểm tra ảnh sản phẩm...' });
    const rawAudit = await adapter.analyzeStructured({ prompt: prompts.assetAuditPrompt(input), references });
    const audit = normalizeAudit(rawAudit, input);
    manifest.stage('auditProductAssets', 'completed', audit);

    const rawTruth = await adapter.analyzeStructured({ prompt: prompts.productTruthPrompt(input, audit), references });
    const truth = buildProductTruthProfile(rawTruth, audit, input);
    manifest.stage('buildProductTruthProfile', truth.status === 'approved' ? 'completed' : 'needs_review', truth);
    if (truth.status !== 'approved') {
      manifest.finish('needs_review');
      return buildNeedsReviewResult(config, runDir, manifest, { audit, truth });
    }

    const routing = routeCategoryAndSceneTypes(truth, audit, config, rawTruth.sceneRouting || {});
    manifest.stage('routeCategoryAndSceneTypes', 'completed', routing);
    const rawStory = await adapter.analyzeStructured({ prompt: prompts.storyPlanPrompt(truth, routing, config), references });
    manifest.stage('createFourSceneMarketingPlan', 'completed', rawStory.storyPlan || rawStory);
    const { storyPlan, feasibility } = validateAndRewriteVisualScenes(rawStory, truth, routing, config);
    manifest.stage('validateAndRewriteVisualScenes', feasibility.overallStatus === 'needs_review' ? 'needs_review' : 'completed', feasibility);
    if (feasibility.overallStatus === 'needs_review') {
      manifest.finish('needs_review');
      return buildNeedsReviewResult(config, runDir, manifest, { audit, truth, routing, storyPlan, feasibility });
    }

    await progress({
      currentStep: 'analysis_complete',
      stepOrder: 2,
      trackerStep: 2,
      trackerStatus: 'completed',
      progressPercent: 30,
      message: 'Đã chốt SKU, dữ kiện được phép dùng và bốn cảnh trước khi tạo ảnh.',
      analysisSummary: buildAnalysisSummary(truth, audit, feasibility),
    });

    const continuitySuggestion = await adapter.analyzeStructured({ prompt: prompts.continuityPrompt(truth, routing), references });
    const continuity = buildContinuityPack(truth, routing, audit, continuitySuggestion, runId);
    manifest.stage('buildContinuityPack', 'completed', continuity);

    await progress({
      currentStep: 'storyboard_generating',
      stepOrder: 3,
      trackerStep: 3,
      trackerStatus: 'running',
      progressPercent: 35,
      message: 'Phân tích hoàn tất. Đang tạo một ảnh master gồm bốn cảnh và kiểm tra lại...',
    });
    const master = await generateCoherentMasterWithQa({ adapter, storyPlan, continuity, input, truth, audit, config, panelDir, runDir, manifest, evidenceBoardPath });
    const panels = master.panels;
    manifest.stage('generateAndQaCoherentMaster', master.status === 'approved' ? 'completed' : 'needs_review', {
      status: master.status,
      masterPath: master.masterPath,
      masterQa: master.masterQa,
      attempts: master.history.length,
    });
    manifest.stage('qaAndRetryPanels', master.status === 'approved' ? 'completed' : 'needs_review', panels);
    await progress({
      currentStep: 'storyboard_generating', stepOrder: 3, trackerStep: 3, trackerStatus: master.status === 'approved' ? 'completed' : 'running',
      progressPercent: 67,
      message: master.status === 'approved' ? 'Ảnh master và cả bốn cảnh đã đạt QA.' : 'Ảnh master chưa đạt QA; đã dừng để kiểm tra.',
    });
    if (master.status !== 'approved') {
      manifest.finish('needs_review');
      return buildNeedsReviewResult(config, runDir, manifest, { audit, truth, routing, storyPlan, feasibility, continuity, panels, generatedMasterPath: master.masterPath, evidenceBoardPath });
    }

    const storyboardPath = path.join(runDir, 'storyboard-clean.png');
    const storyboard = composeStoryboardDeterministically(panels, storyboardPath, config);
    let storyboardWithCopy = null;
    if (config.textMode === 'with_post_copy') {
      const withCopyPath = path.join(runDir, 'storyboard-with-copy.png');
      storyboardWithCopy = applyStoryboardCopy(
        storyboardPath,
        withCopyPath,
        storyPlan.scenes.map(scene => scene.postProductionCopy)
      );
      if (!storyboardWithCopy.copyApplied) {
        manifest.warning(`Storyboard post-production copy was not applied: ${storyboardWithCopy.reason}`);
      }
    }
    manifest.stage('composeStoryboardDeterministically', 'completed', { ...storyboard, storyboardWithCopy });
    await progress({ currentStep: 'storyboard_generated', stepOrder: 3, trackerStep: 3, trackerStatus: 'completed', progressPercent: 68, message: 'Storyboard 4 panel đã hoàn tất QA.' });
    const analysis = buildLegacyAnalysis(truth, storyPlan, routing);

    let videos = [];
    let finalVideoPath = null;
    let postProcessReady = !config.hasVoice || config.voiceStrategy === 'provider';
    if (config.generateVideos) {
      await progress({ currentStep: 'generating_videos', stepOrder: 4, trackerStep: 4, trackerStatus: 'running', progressPercent: 75, message: 'Đang tạo và QA bốn clip độc lập...' });
      const generated = await generateApprovedClips({ adapter, panels, scenes: storyPlan.scenes, continuity, config, clipDir, manifest, baseDir });
      videos = generated.clips;
      finalVideoPath = generated.finalVideoPath;
      manifest.stage('qaAndRetryClips', videos.every(video => video.status === 'approved') ? 'completed' : 'needs_review', videos);
      await progress({ currentStep: 'post_processing', stepOrder: 5, trackerStep: 5, trackerStatus: 'running', progressPercent: 94, message: 'Bốn clip đã xử lý. Đang hoàn tất hậu kỳ...' });
      let voiceoverPending = false;
      if (config.hasVoice && config.voiceStrategy === 'external_tts' && finalVideoPath && typeof options.synthesizeVoiceover === 'function') {
        const voiceResult = await options.synthesizeVoiceover({
          text: storyPlan.scenes.map(scene => scene.voiceoverClaim).filter(Boolean).join(' '),
          scenes: storyPlan.scenes,
          language: config.language,
          outputDir: path.join(runDir, 'audio'),
        });
        const voicePath = typeof voiceResult === 'string' ? voiceResult : voiceResult?.audioPath;
        if (!voicePath || !fs.existsSync(voicePath)) throw new Error('TTS adapter returned no readable audio file');
        await postProcessFinalVideo(videos, finalVideoPath, { voicePath, finalVideoDurationSeconds: config.finalVideoDurationSeconds });
        postProcessReady = true;
      } else if (config.hasVoice && config.voiceStrategy === 'provider' && finalVideoPath) {
        manifest.stage('postProcessFinalVideo', 'completed', { finalVideoPath, voiceoverPending: false, voiceSource: 'provider_clips' });
      } else if (config.hasVoice) {
        voiceoverPending = true;
        manifest.warning('template5_2 V2 requires synthesizeVoiceover; clean clips were created and voiceover is pending post-production');
      }
      manifest.stage('postProcessFinalVideo', finalVideoPath && !voiceoverPending ? 'completed' : 'needs_review', {
        finalVideoPath,
        voiceoverPending,
        voiceSource: config.hasVoice && config.voiceStrategy === 'provider' ? 'provider_clips' : (config.hasVoice ? 'external_tts' : null),
      });
      if (finalVideoPath && !voiceoverPending) {
        await progress({ currentStep: 'post_processing', stepOrder: 5, trackerStep: 5, trackerStatus: 'completed', progressPercent: 100, message: 'Hậu kỳ video hoàn tất.' });
      }
    }

    const status = !config.generateVideos || (finalVideoPath && postProcessReady) ? 'completed' : 'needs_review';
    manifest.finish(status);
    return {
      pipelineVersion: 'v2', status, panels, videos,
      promptSource: 'storyboard-v2',
      storyboard: {
        imageBase64: fs.readFileSync(storyboardPath).toString('base64'),
        mimeType: 'image/png',
        sourcePath: storyboardPath,
        cleanPath: storyboardPath,
        withCopyPath: storyboardWithCopy?.copyApplied ? storyboardWithCopy.outputPath : null,
        width: storyboard.width,
        height: storyboard.height,
        aspectRatio: storyboard.aspectRatio,
      },
      reviewArchive: { root: runDir, storyboardPath, generatedMasterPath: master.masterPath, evidenceBoardPath, storyboardWithCopyPath: storyboardWithCopy?.copyApplied ? storyboardWithCopy.outputPath : null, panelsDir: panelDir, videosDir: clipDir, dataPath: manifest.path },
      runManifest: manifest.data,
      assetAudit: audit,
      productTruth: truth,
      sceneRouting: routing,
      storyPlan,
      feasibility,
      continuityPack: continuity,
      finalVideoPath,
      analysis,
    };
  } catch (error) {
    manifest.stage('error', 'failed', { message: error.message, stack: error.stack });
    manifest.finish('failed');
    throw error;
  } finally {
    if (!options.providerAdapter && adapter?.close) await adapter.close();
    try { fs.unlinkSync(activeMarker); } catch (_) {}
  }
}

function buildNeedsReviewResult(config, runDir, manifest, data) {
  return { pipelineVersion: 'v2', status: 'needs_review', panels: data.panels || [], videos: [], storyboard: null, reviewArchive: { root: runDir, dataPath: manifest.path, generatedMasterPath: data.generatedMasterPath || null, evidenceBoardPath: data.evidenceBoardPath || null, panelsDir: path.join(runDir, 'panels'), videosDir: path.join(runDir, 'clips') }, runManifest: manifest.data, ...data, analysis: data.truth ? buildLegacyAnalysis(data.truth, data.storyPlan || { scenes: [] }, data.routing || { environmentType: '' }) : {} };
}

async function resumeApprovedVideosV2(baseDir, result, options = {}) {
  if (!result || result.pipelineVersion !== 'v2') throw new Error('A V2 storyboard result is required');
  const config = normalizeRunConfig({ ...(result.runManifest?.config || {}), ...options, template: options.template || result.runManifest?.config?.template, pipelineVersion: 'v2', generateVideos: true });
  const panels = (result.panels || []).map(panel => ({
    ...panel,
    buffer: Buffer.isBuffer(panel.buffer)
      ? panel.buffer
      : (panel.imageBase64 ? Buffer.from(panel.imageBase64, 'base64') : (panel.imagePath && fs.existsSync(panel.imagePath) ? fs.readFileSync(panel.imagePath) : null)),
  }));
  assertApprovedPanels(panels, 4);
  const root = result.reviewArchive?.root;
  if (!root) throw new Error('V2 review archive root is missing');
  const manifestPath = result.reviewArchive?.dataPath || path.join(root, 'run-manifest.json');
  const manifest = {
    root,
    path: manifestPath,
    data: result.runManifest || { runId: path.basename(root), pipelineVersion: 'v2', stages: {}, panels: [], clips: [], warnings: [] },
    save() { fs.writeFileSync(manifestPath, `${JSON.stringify(this.data, (key, value) => Buffer.isBuffer(value) ? `[Buffer ${value.length} bytes]` : value, 2)}\n`, 'utf8'); },
    stage(name, status, data) { this.data.stages = this.data.stages || {}; this.data.stages[name] = { status, updatedAt: new Date().toISOString(), data }; this.save(); },
  };
  const clipDir = result.reviewArchive?.videosDir || path.join(root, 'clips');
  ensureDir(clipDir);
  const adapter = options.providerAdapter || createDefaultProviderAdapter(baseDir, options);
  try {
    const generated = await generateApprovedClips({ adapter, panels, scenes: result.storyPlan.scenes, continuity: result.continuityPack, config, clipDir, manifest, baseDir });
    result.videos = generated.clips;
    result.finalVideoPath = generated.finalVideoPath;
    result.runManifest = manifest.data;
    manifest.stage('qaAndRetryClips', generated.clips.every(clip => clip.status === 'approved') ? 'completed' : 'needs_review', generated.clips);
    if (generated.finalVideoPath && config.hasVoice && config.voiceStrategy === 'external_tts' && typeof options.synthesizeVoiceover === 'function') {
      const voiceResult = await options.synthesizeVoiceover({
        text: result.storyPlan.scenes.map(scene => scene.voiceoverClaim).filter(Boolean).join(' '),
        scenes: result.storyPlan.scenes,
        language: config.language,
        outputDir: path.join(root, 'audio'),
      });
      const voicePath = typeof voiceResult === 'string' ? voiceResult : voiceResult?.audioPath;
      if (!voicePath || !fs.existsSync(voicePath)) throw new Error('TTS adapter returned no readable audio file');
      await postProcessFinalVideo(generated.clips, generated.finalVideoPath, { voicePath, finalVideoDurationSeconds: config.finalVideoDurationSeconds });
      manifest.stage('postProcessFinalVideo', 'completed', { finalVideoPath: generated.finalVideoPath, voiceoverPending: false });
      result.status = 'completed';
    } else if (generated.finalVideoPath && config.hasVoice && config.voiceStrategy === 'provider') {
      manifest.stage('postProcessFinalVideo', 'completed', { finalVideoPath: generated.finalVideoPath, voiceoverPending: false, voiceSource: 'provider_clips' });
      result.status = 'completed';
    } else if (config.hasVoice) {
      manifest.stage('postProcessFinalVideo', 'needs_review', { finalVideoPath: generated.finalVideoPath, voiceoverPending: true });
      result.status = 'needs_review';
    } else {
      manifest.stage('postProcessFinalVideo', generated.finalVideoPath ? 'completed' : 'needs_review', { finalVideoPath: generated.finalVideoPath, voiceoverPending: false });
      result.status = generated.finalVideoPath ? 'completed' : 'needs_review';
    }
    result.runManifest = manifest.data;
    return generated;
  } finally {
    if (!options.providerAdapter && adapter?.close) await adapter.close();
  }
}

async function regenerateClipV2(baseDir, result, sceneNumber, customInstruction = '', options = {}) {
  if (!result || result.pipelineVersion !== 'v2') throw new Error('A V2 storyboard result is required');
  const panel = (result.panels || []).find(item => Number(item.sceneNumber || item.index) === Number(sceneNumber));
  if (!panel || panel.status !== 'approved') throw new Error(`Scene ${sceneNumber} does not have an approved source panel`);
  const scene = result.storyPlan?.scenes?.find(item => Number(item.sceneNumber) === Number(sceneNumber));
  if (!scene) throw new Error(`Scene ${sceneNumber} specification is missing`);
  const buffer = Buffer.isBuffer(panel.buffer) ? panel.buffer : (panel.imageBase64 ? Buffer.from(panel.imageBase64, 'base64') : fs.readFileSync(panel.imagePath));
  const config = normalizeRunConfig({ ...(result.runManifest?.config || {}), ...options, pipelineVersion: 'v2', generateVideos: true });
  const adapter = options.providerAdapter || createDefaultProviderAdapter(baseDir, options);
  const clipDir = result.reviewArchive?.videosDir || path.join(result.reviewArchive.root, 'clips');
  ensureDir(clipDir);
  try {
    let correction = customInstruction;
    const history = [];
    for (let attempt = 1; attempt <= config.maxClipRetries + 1; attempt++) {
      const prompt = `${prompts.clipPrompt(scene, result.continuityPack, config.sceneDurationSeconds, config)}${correction ? `\nTARGETED CORRECTION: ${correction}` : ''}`;
      const [video] = await adapter.generateVideos([{ index: sceneNumber, panelIndex: sceneNumber, imagePath: panel.imagePath, prompt, videoModelKey: '4s' }], { aspectRatio: '9:16', videoModelKey: '4s', includeVideoBase64: true });
      if (!video || video.error || !video.videoPath || !fs.existsSync(video.videoPath)) {
        history.push({ attempt, error: video?.error || 'video provider returned no file' });
        correction = 'Use a nearly static camera and preserve the source image exactly';
        continue;
      }
      if (config.voiceStrategy === 'provider' && !videoHasAudio(video.videoPath)) {
        history.push({ attempt, videoPath: video.videoPath, error: 'provider clip is missing required voice-over audio' });
        correction = `Include the exact off-screen Vietnamese voice-over: "${scene.voiceoverClaim}"`;
        continue;
      }
      const rawQa = await adapter.inspectVideo({ videoPath: video.videoPath, prompt: prompts.clipQaPrompt(scene), references: [{ name: 'approved-panel.png', mimeType: 'image/png', buffer }] });
      const qa = evaluateClipQa(rawQa, { valid: true });
      history.push({ attempt, videoPath: video.videoPath, qa });
      if (qa.decision === 'approve') {
        const target = path.join(clipDir, `scene-${sceneNumber}.mp4`);
        fs.copyFileSync(video.videoPath, target);
        const approved = { ...video, panelIndex: Number(sceneNumber), sceneNumber: Number(sceneNumber), status: 'approved', videoPath: target, qa, history };
        result.videos = (result.videos || []).filter(item => Number(item.sceneNumber || item.panelIndex) !== Number(sceneNumber)).concat([approved]).sort((a, b) => Number(a.sceneNumber || a.panelIndex) - Number(b.sceneNumber || b.panelIndex));
        const allApproved = result.videos.length === 4 && result.videos.every(item => item.status === 'approved' && item.videoPath && fs.existsSync(item.videoPath));
        if (allApproved) {
          const finalDir = path.join(result.reviewArchive.root, 'final');
          ensureDir(finalDir);
          const finalVideoPath = path.join(finalDir, 'final-video.mp4');
          await postProcessFinalVideo(result.videos, finalVideoPath, {
            finalVideoDurationSeconds: config.finalVideoDurationSeconds,
            copyByScene: config.textMode === 'with_post_copy' ? result.storyPlan.scenes.map(item => item.postProductionCopy) : [],
            preserveClipAudio: config.voiceStrategy === 'provider',
          });
          result.finalVideoPath = finalVideoPath;
          result.status = config.hasVoice && config.voiceStrategy !== 'provider' ? 'needs_review' : 'completed';
          result.runManifest.stages = result.runManifest.stages || {};
          result.runManifest.stages.postProcessFinalVideo = {
            status: config.hasVoice && config.voiceStrategy !== 'provider' ? 'needs_review' : 'completed',
            updatedAt: new Date().toISOString(),
            data: { finalVideoPath, voiceoverPending: config.hasVoice && config.voiceStrategy !== 'provider', voiceSource: config.voiceStrategy === 'provider' ? 'provider_clips' : null },
          };
          const manifestPath = result.reviewArchive.dataPath;
          if (manifestPath) fs.writeFileSync(manifestPath, `${JSON.stringify(result.runManifest, null, 2)}\n`, 'utf8');
        }
        return approved;
      }
      correction = qa.correctionPrompt || 'Keep the product unchanged and use only a gentle push-in';
    }
    throw new Error(`Scene ${sceneNumber} clip failed V2 QA after retries`);
  } finally {
    if (!options.providerAdapter && adapter?.close) await adapter.close();
  }
}

module.exports = {
  buildLegacyAnalysis,
  deterministicImageQa,
  generateApprovedClips,
  generateCoherentMasterWithQa,
  generateStoryboardV2,
  inspectImageDimensions,
  videoHasAudio,
  resumeApprovedVideosV2,
  regenerateClipV2,
};
