'use strict';

const fs = require('fs');
const path = require('path');
const { GeminiApiClient } = require('./gemini-client/gemini-api');
const reviewManager = require('./storyboard-review-manager');

/**
 * Regenerate a specific panel image for a pending storyboard review
 * @param {string} baseDir
 * @param {object} pendingReview
 * @param {number} panelIndex
 * @param {string} [customInstruction]
 * @returns {Promise<object>} updated panel object
 */
async function regenerateStoryboardPanel(baseDir, pendingReview, panelIndex, customInstruction = '') {
  const template = pendingReview.template || 'template5';
  const analysis = pendingReview.analysis || {};
  const filePayloads = pendingReview.filePayloads || [];
  const effectiveBaseDir = baseDir || path.resolve(__dirname, '..');

  if (pendingReview.pipelineVersion === 'v2' || pendingReview.result?.pipelineVersion === 'v2') {
    const result = pendingReview.result;
    const scene = result?.storyPlan?.scenes?.find(item => Number(item.sceneNumber) === Number(panelIndex));
    if (!scene) throw new Error(`V2 scene ${panelIndex} not found`);
    const { normalizeInput } = require('./storyboard-v2/contracts');
    const { normalizeRunConfig } = require('./storyboard-v2/config');
    const { createDefaultProviderAdapter } = require('./storyboard-v2/provider-adapter');
    const { generateCoherentMasterWithQa } = require('./storyboard-v2/orchestrator');
    const { composeEvidenceBoard, composeStoryboardDeterministically } = require('./storyboard-v2/storyboard-compositor');
    const input = normalizeInput(filePayloads, { productName: result.productTruth?.canonicalProductName });
    const config = normalizeRunConfig({ ...(result.runManifest?.config || {}), template, pipelineVersion: 'v2', generateVideos: false });
    const adapter = createDefaultProviderAdapter(effectiveBaseDir, {});
    const panelsDir = result.reviewArchive?.panelsDir || path.join(result.reviewArchive.root, 'panels');
    const runDir = result.reviewArchive.root;
    let evidenceBoardPath = result.reviewArchive?.evidenceBoardPath || path.join(runDir, 'all-input-evidence-board.png');
    if (!fs.existsSync(evidenceBoardPath)) composeEvidenceBoard(input.images, evidenceBoardPath);
    const manifestPath = result.reviewArchive?.dataPath || path.join(result.reviewArchive.root, 'run-manifest.json');
    const manifest = {
      data: result.runManifest,
      save() { fs.writeFileSync(manifestPath, `${JSON.stringify(this.data, (key, value) => Buffer.isBuffer(value) ? `[Buffer ${value.length} bytes]` : value, 2)}\n`, 'utf8'); },
    };
    try {
      const correction = `The user requested a correction focused on Scene ${panelIndex}: ${customInstruction || 'improve this scene while preserving its planned intent'}. Regenerate ALL FOUR CELLS together and keep every unchanged scene visually consistent.`;
      const regenerated = await generateCoherentMasterWithQa({
        adapter, storyPlan: result.storyPlan, continuity: result.continuityPack, input,
        truth: result.productTruth, audit: result.assetAudit, config, panelDir: panelsDir,
        runDir, manifest, evidenceBoardPath, customInstruction: correction,
      });
      if (regenerated.status !== 'approved') throw new Error('Ảnh master mới chưa đạt QA; hệ thống không thay riêng một panel để tránh lệch sản phẩm');
      result.panels = regenerated.panels;
      const storyboardPath = result.reviewArchive?.storyboardPath || path.join(runDir, 'storyboard-clean.png');
      const storyboard = composeStoryboardDeterministically(result.panels, storyboardPath, config);
      result.storyboard = {
        imageBase64: fs.readFileSync(storyboardPath).toString('base64'), mimeType: 'image/png', sourcePath: storyboardPath,
        cleanPath: storyboardPath, width: storyboard.width, height: storyboard.height, aspectRatio: storyboard.aspectRatio,
      };
      result.reviewArchive.storyboardPath = storyboardPath;
      result.reviewArchive.generatedMasterPath = regenerated.masterPath;
      pendingReview.panels = result.panels;
      pendingReview.runManifest = manifest.data;
      for (const panel of result.panels) reviewManager.updatePanel(pendingReview.chatId, panel.sceneNumber, panel);
      const updated = result.panels.find(panel => Number(panel.sceneNumber) === Number(panelIndex));
      return { ...updated, allPanels: result.panels, masterRegenerated: true, generatedMasterPath: regenerated.masterPath };
    } finally {
      await adapter.close();
    }
  }

  const cookieFilePath = process.env.GEMINI_COOKIE_PATH
    ? path.resolve(effectiveBaseDir, process.env.GEMINI_COOKIE_PATH)
    : path.join(effectiveBaseDir, 'gemini-cookies');

  const geminiClient = new GeminiApiClient({
    cookieFilePath: fs.existsSync(cookieFilePath) ? cookieFilePath : undefined,
  });

  await geminiClient.init();

  try {
    // Upload files if needed
    const uploadedFiles = [];
    const payloads = filePayloads.slice(0, 4);
    for (let i = 0; i < payloads.length; i++) {
      const f = payloads[i];
      const buf = f.buffer || (f.path && fs.existsSync(f.path) ? fs.readFileSync(f.path) : null);
      if (buf) {
        const ext = f.mimeType?.includes('jpeg') ? '.jpg' : '.png';
        const filename = f.name || `product_${i + 1}${ext}`;
        const mimeType = f.mimeType || 'image/png';
        try {
          const url = await geminiClient.uploadFile(buf, filename, mimeType);
          if (url) uploadedFiles.push({ url, filename, mimeType });
        } catch (upErr) {
          console.warn(`[StoryboardRemake] Could not upload product image ${i + 1}: ${upErr.message}`);
        }
      }
    }

    const prodName = analysis.productName || analysis.product_name || 'the product';
    const loc = analysis.sceneContext?.location || 'a bright modern lifestyle setting';
    const lighting = analysis.sceneContext?.lighting || 'soft natural daylight with realistic contact shadows';
    const script = Array.isArray(analysis.script) ? analysis.script : [];

    let prompt = '';
    const tmpl = String(template || '').toLowerCase();
    const isTemplate5_3 = (tmpl === 'template5_3' || tmpl === 'template5.3' || tmpl === 'template53');
    const isTemplate6 = tmpl === 'template6' || tmpl === 't6';
    const isTemplate5 = tmpl.includes('template5') || tmpl.includes('t5');

    if (isTemplate6) {
      const sceneNum = Number(panelIndex) === 2 ? 2 : 1;
      const sceneDesc = sceneNum === 1
        ? 'First-person POV walking up to modern supermarket shelf / cart, eyes catching the neatly arranged product'
        : 'First-person POV hand holding and inspecting the product up close with clear labels and natural indoor supermarket lighting';
      prompt = `Generate one product review storyboard panel image (still photo vertical 9:16 aspect ratio, NOT a video) for ${prodName}.
Setting: Modern supermarket / retail store interior (${loc}), clean bright supermarket fluorescent and shelf accent lighting (${lighting}).
Scene description: ${sceneDesc}.
${customInstruction ? `Specific user modification request: ${customInstruction}` : ''}
CRITICAL REQUIREMENTS:
- Authentic smartphone camera snapshot (iPhone 15 Pro, f/1.8), authentic supermarket setting.
- Strictly faceless (only hands or cart POV visible).
- NO text, NO watermarks, NO cartoons. Clean photographic realism.`.trim();
    } else if (isTemplate5_3 || isTemplate5) {
      const sIdx = Math.max(0, Math.min(Number(panelIndex) - 1, script.length - 1));
      const s = script[sIdx] || {};
      const phaseNames = ['Hook', 'Solution', 'Proof', 'Closing / CTA'];
      const phaseName = s.phase || phaseNames[sIdx] || `Scene ${panelIndex}`;
      prompt = `Generate one product review storyboard panel image (still photo vertical 9:16 aspect ratio, NOT a video) for ${prodName}.
Setting: ${loc}, ${lighting}.
Panel ${panelIndex} Scene details (${phaseName}):
- Phase: ${phaseName}
- Goal: ${s.goal || 'Showcase product features and authentic lifestyle usage'}
- Visual description: ${s.visualDescription || 'Realistic hands interacting with product up close'}
- Hand interaction: ${s.techVFX || 'Natural physical hand grip and demonstration'}
${customInstruction ? `Specific user modification request: ${customInstruction}` : ''}
CRITICAL REQUIREMENTS:
- 100% Smartphone camera realism (iPhone 15 Pro, f/1.8), natural window lighting.
- Strictly faceless (clean manicured Asian hands, no visible faces).
- NO words, NO subtitles, NO cartoon graphics. Pure clean photography.`.trim();
    } else {
      // General fallback for other templates (Template 3, 4, etc.)
      const targetP = pendingReview.panels?.find(p => Number(p.index || p.panelIndex) === Number(panelIndex)) || {};
      const baseDesc = targetP.prompt || targetP.description || `Showcasing ${prodName} scene ${panelIndex}`;
      prompt = `Generate one product review storyboard panel image (still photo vertical 9:16 aspect ratio, NOT a video) for ${prodName}.
Setting: ${loc}, ${lighting}.
Scene description: ${baseDesc}.
${customInstruction ? `Specific user modification request: ${customInstruction}` : ''}
CRITICAL REQUIREMENTS:
- 100% Smartphone camera realism (iPhone 15 Pro, f/1.8), authentic lifestyle setting.
- Strictly faceless (clean hands interacting with product if visible, no visible face).
- NO text, NO watermarks, NO cartoons. Pure clean photography.`.trim();
    }

    let newBuf = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await geminiClient.generateContent({
          prompt,
          fileData: uploadedFiles,
          temporary: true,
          expectImages: true,
        });
        if (res.images && res.images.length > 0) {
          newBuf = await geminiClient.downloadImage(res.images[0].url);
          break;
        }
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (!newBuf) throw new Error('Gemini API did not return an image for panel remake');

    // Save buffer to panel image file
    const panelsDir = pendingReview.reviewArchive?.panelsDir
      || (pendingReview.reviewArchive?.root ? path.join(pendingReview.reviewArchive.root, 'panels') : null)
      || path.join(effectiveBaseDir, 'uploads');
    if (!fs.existsSync(panelsDir)) fs.mkdirSync(panelsDir, { recursive: true });

    const panelPath = path.join(panelsDir, `panel-${panelIndex}.png`);
    fs.writeFileSync(panelPath, newBuf);

    // Update in reviewManager
    const updated = reviewManager.updatePanel(pendingReview.chatId, panelIndex, {
      buffer: newBuf,
      imageBase64: newBuf.toString('base64'),
      imagePath: panelPath,
    });

    return {
      ...(updated || {}),
      buffer: newBuf,
      imagePath: panelPath,
    };
  } finally {
    try { await geminiClient.close(); } catch (_) {}
  }
}

module.exports = {
  regenerateStoryboardPanel,
};
