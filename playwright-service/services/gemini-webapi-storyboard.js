const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const { createFlowPage, closeFlowPage } = require('./browser');
const { prepareVideoGeneration, executeVideoGeneration } = require('./video');
const { getConfig } = require('../utils/config-manager');
const geminiStoryboard = require('./gemini-client/gemini-storyboard');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function removeDirQuietly(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

function safeFileStem(value, fallback) {
  const stem = path.parse(String(value || fallback)).name || fallback;
  return stem.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function getMimeExt(mimeType) {
  const value = String(mimeType || '').toLowerCase();
  if (value.includes('webp')) return '.webp';
  if (value.includes('gif')) return '.gif';
  return /jpe?g/i.test(value) ? '.jpg' : '.png';
}

function getTemplateName(options = {}) {
  return String(options.template || options.storyboardTemplate || options.promptTemplate || '').trim().toLowerCase();
}

function buildTemplate3ReferenceAssets(baseDir) {
  const standPath = path.join(baseDir, 'assets', 'giadegiay.webp');
  const shopPath = path.join(baseDir, 'assets', 'shopgiay.png');
  const scene1ShoeboxPath = path.join(baseDir, 'assets', 'template3-scene1-shoebox-reference.png');
  const scene1StandPath = path.join(baseDir, 'assets', 'template3-scene1-stand-reference.png');
  const scene3Path = path.join(baseDir, 'assets', 'canhr3.jpeg');
  const assets = [];

  if (!fs.existsSync(standPath)) {
    console.warn(`[GeminiWebAPI] Template3 display stand reference not found: ${standPath}`);
  } else {
    assets.push({
      name: 'giadegiay-display-stand-reference.webp',
      role: 'template3_display_stand_prop',
      mimeType: 'image/webp',
      base64: fs.readFileSync(standPath).toString('base64'),
    });
  }

  if (!fs.existsSync(shopPath)) {
    console.warn(`[GeminiWebAPI] Template3 shoe shop background reference not found: ${shopPath}`);
  } else {
    assets.push({
      name: 'shopgiay-background-reference.png',
      role: 'template3_shoe_shop_background_reference',
      mimeType: 'image/png',
      base64: fs.readFileSync(shopPath).toString('base64'),
    });
  }

  // Scene 1 reference images (conditional: shoebox or stand)
  if (fs.existsSync(scene1ShoeboxPath)) {
    assets.push({
      name: 'template3-scene1-shoebox-reference.png',
      role: 'template3_scene1_shoebox_reference',
      mimeType: 'image/png',
      base64: fs.readFileSync(scene1ShoeboxPath).toString('base64'),
    });
  } else {
    console.warn(`[GeminiWebAPI] Template3 scene1 shoebox reference not found: ${scene1ShoeboxPath}`);
  }

  if (fs.existsSync(scene1StandPath)) {
    assets.push({
      name: 'template3-scene1-stand-reference.png',
      role: 'template3_scene1_stand_reference',
      mimeType: 'image/png',
      base64: fs.readFileSync(scene1StandPath).toString('base64'),
    });
  } else {
    console.warn(`[GeminiWebAPI] Template3 scene1 stand reference not found: ${scene1StandPath}`);
  }

  // Scene 2 reference: side-angle bar stool
  if (fs.existsSync(scene3Path)) {
    assets.push({
      name: 'canh3-reference.jpeg',
      role: 'template3_scene2_side_angle_reference',
      mimeType: 'image/jpeg',
      base64: fs.readFileSync(scene3Path).toString('base64'),
    });
  } else {
    console.warn(`[GeminiWebAPI] Template3 scene3 reference not found: ${scene3Path}`);
  }

  return assets;
}

/**
 * Run the Node.js Gemini storyboard bridge (replaces Python subprocess).
 * @param {string} baseDir
 * @param {object} request - Same JSON format as Python bridge input
 * @param {number} [timeoutMs]
 * @returns {Promise<object>} - Same JSON format as Python bridge output
 */
async function runBridge(baseDir, request, timeoutMs = 30 * 60 * 1000) {
  const impl = String(process.env.GEMINI_WEBAPI_IMPL || 'python').trim().toLowerCase();
  if (impl === 'python' || impl === 'py' || impl === 'hanaokayuzu') {
    return runPythonBridge(baseDir, request, timeoutMs);
  }
  if (impl !== 'node' && impl !== 'js') {
    throw new Error(`Unknown GEMINI_WEBAPI_IMPL: ${impl}`);
  }

  const tmpRoot = path.join(baseDir, 'uploads', 'gemini-webapi-runs');
  ensureDir(tmpRoot);
  const workDir = fs.mkdtempSync(path.join(tmpRoot, 'run-'));

  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Gemini storyboard timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
  );

  try {
    const result = await Promise.race([
      geminiStoryboard.run(request, workDir),
      timer,
    ]);
    return result;
  } finally {
    removeDirQuietly(workDir);
  }
}

function getPythonCommand(baseDir) {
  const localVenvPython = path.join(baseDir, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(localVenvPython)) return localVenvPython;

  const configured = String(process.env.GEMINI_WEBAPI_PYTHON || '').trim();
  if (configured && fs.existsSync(configured)) return configured;

  const commonWindowsPython = path.join(
    process.env.LOCALAPPDATA || '',
    'Programs',
    'Python',
    'Python312',
    'python.exe'
  );
  if (commonWindowsPython && fs.existsSync(commonWindowsPython)) return commonWindowsPython;

  return process.platform === 'win32' ? 'python' : 'python3';
}

async function runPythonBridge(baseDir, request, timeoutMs = 30 * 60 * 1000) {
  const tmpRoot = path.join(baseDir, 'uploads', 'gemini-webapi-runs');
  ensureDir(tmpRoot);
  const workDir = fs.mkdtempSync(path.join(tmpRoot, 'py-run-'));
  const inputPath = path.join(workDir, 'request.json');
  const outputPath = path.join(workDir, 'response.json');
  const scriptPath = path.join(baseDir, 'gemini-webapi-bridge', 'gemini_storyboard.py');
  const pythonCmd = getPythonCommand(baseDir);

  fs.writeFileSync(inputPath, JSON.stringify(request), 'utf8');

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(pythonCmd, [
      scriptPath,
      '--input', inputPath,
      '--output', outputPath,
      '--work-dir', workDir,
    ], {
      cwd: baseDir,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      },
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Gemini Python bridge timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeDirQuietly(workDir);
      reject(new Error(`Failed to start Python bridge (${pythonCmd}): ${error.message}`));
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (code !== 0) {
          throw new Error(`Python bridge exited with code ${code}\n${stderr || stdout}`.trim());
        }
        if (!fs.existsSync(outputPath)) {
          throw new Error(`Python bridge did not write output file\n${stderr || stdout}`.trim());
        }
        const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        removeDirQuietly(workDir);
      }
    });
  });
}

function buildRequest(filePayloads, options, baseDir) {
  const config = getConfig(baseDir);
  const ui = config.uiSettings || {};
  const template = getTemplateName(options);
  const mergedOptions = {
    category: ui.category || 'Fashion product',
    useVietnameseModel: ui.useVietnameseModel !== false,
    noTextInImage: ui.noTextInImage !== false,
    styleCuonHut: ui.styleCuonHut !== false,
    panelCount: Number(ui.panelCount) || 3,
    sceneRatio: options.aspectRatio || ui.sceneRatio || '9:16',
    ...options,
  };
  if (template === 'template1') {
    mergedOptions.template = 'template1';
    mergedOptions.panelCount = 2;
    mergedOptions.noVoiceOver = true;
    mergedOptions.category = mergedOptions.category || 'Giày dép / Footwear';
  } else if (template === 'template2') {
    mergedOptions.template = 'template2';
    mergedOptions.panelCount = 8;
    mergedOptions.noVoiceOver = true;
    mergedOptions.videoModelKey = '4s';
    mergedOptions.category = mergedOptions.category || 'Giày dép / Footwear';
  } else if (template === 'template3') {
    mergedOptions.template = 'template3';
    mergedOptions.panelCount = 3;
    mergedOptions.noVoiceOver = true;
    mergedOptions.category = mergedOptions.category || 'Giày dép / Footwear';
  }

  return {
    options: mergedOptions,
    images: filePayloads.map((file, index) => ({
      name: file.name || `image-${index + 1}${getMimeExt(file.mimeType)}`,
      mimeType: file.mimeType || 'image/png',
      base64: Buffer.from(file.buffer).toString('base64'),
    })),
    referenceAssets: template === 'template3'
      ? buildTemplate3ReferenceAssets(baseDir)
      : [],
  };
}

function writePanels(baseDir, bridgeResult) {
  const downloadDir = path.join(baseDir, 'uploads', 'aistudio-panels');
  ensureDir(downloadDir);

  const panels = (bridgeResult.panels || []).map((panel, index) => {
    const panelIndex = Number(panel.index || index + 1);
    const base64 = panel.imageBase64 || panel.image || null;
    const mimeType = panel.mimeType || 'image/png';
    let imagePath = null;

    if (base64) {
      const fileName = `${safeFileStem(`panel-${panelIndex}`, `panel-${panelIndex}`)}-${Date.now()}${getMimeExt(mimeType)}`;
      imagePath = path.join(downloadDir, fileName);
      fs.writeFileSync(imagePath, Buffer.from(base64, 'base64'));
    }

    return {
      index: panelIndex,
      prompt: panel.prompt || (bridgeResult.veo3Prompts || [])[index] || null,
      image: base64,
      imagePath,
    };
  });

  return { panels, downloadDir };
}

function buildCopiedPromptText(panels) {
  return panels
    .filter(panel => panel.prompt)
    .map(panel => `PANEL ${panel.index} PROMPT\n${panel.prompt}`)
    .join('\n\n');
}

function makeArchiveRunId(options = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const template = getTemplateName(options) || 'default';
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${template}-${suffix}`;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function saveBase64File(filePath, base64) {
  if (!base64) return false;
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return true;
}

function buildReviewPromptMarkdown(bridgeResult) {
  const debugPrompts = bridgeResult.debugPrompts || {};
  const panelImagePrompts = Array.isArray(debugPrompts.panelImagePrompts)
    ? debugPrompts.panelImagePrompts
    : [];
  const veo3Prompts = Array.isArray(debugPrompts.veo3Prompts)
    ? debugPrompts.veo3Prompts
    : (Array.isArray(bridgeResult.veo3Prompts) ? bridgeResult.veo3Prompts : []);

  const sections = [
    '# Storyboard Review Prompts',
    '',
    '## Analysis Prompt',
    '',
    '```text',
    debugPrompts.analysisPrompt || '',
    '```',
    '',
    '## Storyboard Image Prompt',
    '',
    '```text',
    debugPrompts.storyboardPrompt || '',
    '```',
  ];

  panelImagePrompts.forEach((prompt, index) => {
    sections.push(
      '',
      `## Panel ${index + 1} Image Prompt`,
      '',
      '```text',
      prompt || '',
      '```'
    );
  });

  veo3Prompts.forEach((prompt, index) => {
    sections.push(
      '',
      `## Panel ${index + 1} Veo Prompt`,
      '',
      '```text',
      prompt || '',
      '```'
    );
  });

  return `${sections.join('\n')}\n`;
}

function archiveStoryboardReview(baseDir, filePayloads, request, bridgeResult, panels) {
  const archiveRoot = path.join(baseDir, 'storyboard-review-runs');
  ensureDir(archiveRoot);

  const archiveDir = path.join(archiveRoot, makeArchiveRunId(request.options || {}));
  ensureDir(archiveDir);

  const inputDir = path.join(archiveDir, 'inputs');
  const panelDir = path.join(archiveDir, 'panels');
  const referenceDir = path.join(archiveDir, 'references');
  ensureDir(inputDir);
  ensureDir(panelDir);

  for (let index = 0; index < filePayloads.length; index++) {
    const file = filePayloads[index];
    const ext = getMimeExt(file.mimeType);
    const name = safeFileStem(file.name || `input-${index + 1}`, `input-${index + 1}`);
    fs.writeFileSync(path.join(inputDir, `${String(index + 1).padStart(2, '0')}-${name}${ext}`), file.buffer);
  }

  const storyboardBase64 = bridgeResult.storyboard?.imageBase64 || null;
  const storyboardPath = path.join(archiveDir, 'storyboard.png');
  saveBase64File(storyboardPath, storyboardBase64);

  for (const panel of panels || []) {
    if (panel.image) {
      saveBase64File(path.join(panelDir, `panel-${panel.index}.png`), panel.image);
    }
  }

  const referenceAssets = Array.isArray(request.referenceAssets) ? request.referenceAssets : [];
  if (referenceAssets.length > 0) {
    ensureDir(referenceDir);
    for (const asset of referenceAssets) {
      const ext = getMimeExt(asset.mimeType || '');
      const name = safeFileStem(asset.name || asset.role || 'reference', 'reference');
      saveBase64File(path.join(referenceDir, `${name}${path.extname(name) ? '' : ext}`), asset.base64);
    }
  }

  const reviewData = {
    createdAt: new Date().toISOString(),
    options: request.options || {},
    analysis: bridgeResult.analysis || null,
    sceneContext: bridgeResult.sceneContext || null,
    productSupportPlan: bridgeResult.productSupportPlan || null,
    outfitPlan: bridgeResult.outfitPlan || null,
    script: bridgeResult.script || null,
    frameData: bridgeResult.frameData || '',
    cropTemplate: bridgeResult.cropTemplate || '',
    veo3Prompts: bridgeResult.veo3Prompts || [],
    debugPrompts: bridgeResult.debugPrompts || {},
    files: {
      root: archiveDir,
      storyboard: storyboardBase64 ? storyboardPath : null,
      inputs: inputDir,
      panels: panelDir,
      references: referenceAssets.length > 0 ? referenceDir : null,
    },
  };

  writeJson(path.join(archiveDir, 'review-data.json'), reviewData);
  fs.writeFileSync(path.join(archiveDir, 'prompts.md'), buildReviewPromptMarkdown(bridgeResult), 'utf8');

  console.log(`[GeminiWebAPI] Storyboard review archive saved: ${archiveDir}`);
  return {
    root: archiveDir,
    storyboardPath: storyboardBase64 ? storyboardPath : null,
    promptsPath: path.join(archiveDir, 'prompts.md'),
    dataPath: path.join(archiveDir, 'review-data.json'),
    inputsDir: inputDir,
    panelsDir: panelDir,
  };
}


function buildFilePayloadFromPanel(panel) {
  if (!panel.imagePath || !fs.existsSync(panel.imagePath)) return null;
  const ext = path.extname(panel.imagePath).toLowerCase();
  return {
    name: path.basename(panel.imagePath),
    mimeType: ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png',
    buffer: fs.readFileSync(panel.imagePath),
  };
}

async function generateVideosFromPanelsDirect(baseDir, panels, options = {}) {
  const jobs = panels
    .filter(panel => panel.prompt && panel.imagePath)
    .map(panel => ({ panel, filePayload: buildFilePayloadFromPanel(panel) }))
    .filter(job => job.filePayload);

  if (jobs.length === 0) {
    console.log('[GeminiWebAPI->Flow] No complete panel+prompt pairs to generate videos.');
    return [];
  }

  const page = await createFlowPage(baseDir);
  const videoDir = path.join(baseDir, 'uploads', 'aistudio-videos');
  ensureDir(videoDir);

  const MAX_VIDEO_ATTEMPTS = 3;
  const resultsByPanel = new Map();

  async function prepareJobVideo(job, attemptNumber = 1) {
    const { panel, filePayload } = job;
    const resolvedModelKey = panel.videoModelKey
      || options.videoModelKey
      || (panel.prompt?.includes('8 giây') ? 'veo_3_1_i2v_lite_low_priority' : (panel.prompt?.includes('4 giây') ? 'veo_3_1_i2v_s_lite_4s_low_priority' : null));

    if (attemptNumber > 1) {
      console.log(`[GeminiWebAPI->Flow] 🔄 Retrying video generation for panel ${panel.index} (Attempt ${attemptNumber}/${MAX_VIDEO_ATTEMPTS})...`);
    } else {
      console.log(`[GeminiWebAPI->Flow] Preparing video for panel ${panel.index}/${jobs.length} (model: ${resolvedModelKey || 'default'})...`);
    }

    const prepared = await prepareVideoGeneration(
      page,
      panel.prompt,
      null,
      [filePayload],
      {
        imageSelection: [`name:${filePayload.name}`],
        aspectRatio: options.aspectRatio || '9:16',
        videoModelKey: resolvedModelKey,
        preserveBorder: options.preserveBorder !== undefined ? options.preserveBorder : false,
        cropPercent: typeof options.cropPercent === 'number' ? options.cropPercent : undefined,
      },
      baseDir
    );

    return { panel, prepared };
  }

  async function executeAndSaveVideo(panel, prepared) {
    const base64 = await executeVideoGeneration(prepared);
    const videoPath = path.join(videoDir, `panel-${panel.index}-video-${Date.now()}.mp4`);
    fs.writeFileSync(videoPath, Buffer.from(base64, 'base64'));
    const item = {
      panelIndex: panel.index,
      prompt: panel.prompt,
      videoPath,
    };
    if (options.includeVideoBase64) {
      item.video = { base64, mimeType: 'video/mp4' };
    }
    return item;
  }

  try {
    // 1. Chuẩn bị batch đầu tiên tuần tự trên page
    const preparedJobs = [];
    for (const job of jobs) {
      try {
        const item = await prepareJobVideo(job, 1);
        preparedJobs.push({ job, ...item });
      } catch (prepErr) {
        console.warn(`[GeminiWebAPI->Flow] ⚠️ Initial preparation failed for panel ${job.panel.index}: ${prepErr.message}`);
        preparedJobs.push({ job, panel: job.panel, prepared: null, error: prepErr });
      }
    }

    // 2. Poll song song đợt 1
    console.log(`[GeminiWebAPI->Flow] Polling ${preparedJobs.filter(pj => pj.prepared).length} video job(s) in parallel...`);
    const initialSettled = await Promise.allSettled(preparedJobs.map(async ({ panel, prepared, error }) => {
      if (!prepared) throw error || new Error('Preparation failed');
      return await executeAndSaveVideo(panel, prepared);
    }));

    initialSettled.forEach((res, idx) => {
      const { panel } = preparedJobs[idx];
      if (res.status === 'fulfilled') {
        resultsByPanel.set(panel.index, res.value);
        console.log(`[GeminiWebAPI->Flow] ✅ Panel ${panel.index} video completed successfully (attempt 1)!`);
      } else {
        console.warn(`[GeminiWebAPI->Flow] ⚠️ Panel ${panel.index} video attempt 1 failed: ${res.reason?.message || res.reason}`);
      }
    });

    // 3. Cơ chế retry tối đa 3 lần cho các panel bị lỗi
    for (let attempt = 2; attempt <= MAX_VIDEO_ATTEMPTS; attempt++) {
      const failedJobs = jobs.filter(j => !resultsByPanel.has(j.panel.index));
      if (failedJobs.length === 0) break;

      console.log(`[GeminiWebAPI->Flow] 🔄 Bắt đầu retry đợt ${attempt}/${MAX_VIDEO_ATTEMPTS} cho ${failedJobs.length} panel video bị lỗi...`);
      await new Promise(r => setTimeout(r, 4000));

      for (const job of failedJobs) {
        try {
          const { panel, prepared } = await prepareJobVideo(job, attempt);
          const item = await executeAndSaveVideo(panel, prepared);
          resultsByPanel.set(panel.index, item);
          console.log(`[GeminiWebAPI->Flow] ✅ Panel ${panel.index} video thành công ở lần thử thứ ${attempt}!`);
        } catch (retryErr) {
          console.warn(`[GeminiWebAPI->Flow] ❌ Panel ${job.panel.index} lần thử ${attempt}/${MAX_VIDEO_ATTEMPTS} thất bại: ${retryErr.message}`);
        }
      }
    }

    // 4. Trả về kết quả đầy đủ theo thứ tự các panel
    return jobs.map(job => {
      const panelIndex = job.panel.index;
      if (resultsByPanel.has(panelIndex)) {
        return resultsByPanel.get(panelIndex);
      }
      return {
        panelIndex,
        error: `Video generation failed after ${MAX_VIDEO_ATTEMPTS} attempts`,
      };
    });
  } finally {
    await closeFlowPage(page);
  }
}

function cleanupGeneratedFiles(result, options = {}) {
  if (options.cleanupFiles === false) return;
  const paths = [];
  for (const panel of result.panels || []) {
    if (panel?.imagePath && panel.image) paths.push(panel.imagePath);
  }
  for (const video of result.videos || []) {
    if (video?.videoPath && (video.video?.base64 || video.videoBase64)) paths.push(video.videoPath);
  }
  for (const filePath of [...new Set(paths)].filter(Boolean)) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (error) {
      console.log(`[GeminiWebAPI] Could not cleanup ${filePath}: ${error.message}`);
    }
  }
}

async function generateStoryboard(baseDir, filePayloads, options = {}) {
  if (!filePayloads || filePayloads.length === 0) {
    throw new Error('At least one product image is required');
  }
  if (!process.env.GEMINI_SECURE_1PSID) {
    throw new Error('GEMINI_SECURE_1PSID is required for storyboardProvider=gemini-webapi');
  }

  console.log(`[GeminiWebAPI] Generating storyboard from ${filePayloads.length} image(s) using ${process.env.GEMINI_WEBAPI_IMPL || 'python'} bridge...`);
  const request = buildRequest(filePayloads, options, baseDir);
  const bridgeResult = await runBridge(baseDir, request, Number(process.env.GEMINI_WEBAPI_TIMEOUT_MS) || 30 * 60 * 1000);
  const { panels, downloadDir } = writePanels(baseDir, bridgeResult);

  if (panels.length === 0) {
    throw new Error('Gemini WebAPI bridge returned no panels');
  }

  const reviewArchive = archiveStoryboardReview(baseDir, filePayloads, request, bridgeResult, panels);

  let videos = [];
  if (options.generateVideos !== false) {
    videos = await generateVideosFromPanelsDirect(baseDir, panels, {
      aspectRatio: options.aspectRatio || request.options.sceneRatio || '9:16',
      videoModelKey: options.videoModelKey || null,
      includeVideoBase64: !!options.includeVideoBase64,
    });
    console.log(`[GeminiWebAPI->Flow] Video result: ${videos.filter(v => !v.error).length}/${videos.length} completed`);
  }

  const result = {
    panels,
    videos,
    downloadDir,
    promptSource: 'gemini-webapi',
    storyboard: bridgeResult.storyboard || null,
    analysis: bridgeResult.analysis || null,
    script: bridgeResult.script || null,
    sceneContext: bridgeResult.sceneContext || null,
    productSupportPlan: bridgeResult.productSupportPlan || null,
    outfitPlan: bridgeResult.outfitPlan || null,
    frameData: bridgeResult.frameData || '',
    cropTemplate: bridgeResult.cropTemplate || '',
    copiedPromptText: buildCopiedPromptText(panels),
    reviewArchive,
  };

  cleanupGeneratedFiles(result, options);
  return result;
}

module.exports = {
  generateStoryboard,
  generateVideosFromPanelsDirect,
};
