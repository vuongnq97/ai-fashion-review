const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const { getBrowserPage } = require('./browser');
const { prepareVideoGeneration, executeVideoGeneration } = require('./video');
const { getConfig } = require('../utils/config-manager');

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
  return /jpe?g/i.test(String(mimeType || '')) ? '.jpg' : '.png';
}

function getPythonCommand() {
  return process.env.GEMINI_WEBAPI_PYTHON || process.env.PYTHON || 'python';
}

function getBridgeEnv(baseDir) {
  const env = { ...process.env };
  if (env.GEMINI_COOKIE_PATH && !path.isAbsolute(env.GEMINI_COOKIE_PATH)) {
    env.GEMINI_COOKIE_PATH = path.resolve(baseDir, env.GEMINI_COOKIE_PATH);
  }
  return env;
}

function runBridge(baseDir, request, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const bridgeDir = path.join(baseDir, 'gemini-webapi-bridge');
    const scriptPath = path.join(bridgeDir, 'gemini_storyboard.py');
    if (!fs.existsSync(scriptPath)) {
      reject(new Error(`Gemini WebAPI bridge script not found: ${scriptPath}`));
      return;
    }

    const tmpRoot = path.join(baseDir, 'uploads', 'gemini-webapi-runs');
    ensureDir(tmpRoot);
    const workDir = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
    const requestPath = path.join(workDir, 'request.json');
    const outputPath = path.join(workDir, 'result.json');
    fs.writeFileSync(requestPath, JSON.stringify(request), 'utf8');

    const args = [scriptPath, '--input', requestPath, '--output', outputPath, '--work-dir', workDir];
    const child = spawn(getPythonCommand(), args, {
      cwd: baseDir,
      env: getBridgeEnv(baseDir),
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      child.kill('SIGTERM');
      reject(new Error(`Gemini WebAPI bridge timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      const text = chunk.toString().trim();
      if (text) console.log(`[GeminiWebAPI stdout] ${text}`);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      const text = chunk.toString().trim();
      if (text) console.log(`[GeminiWebAPI] ${text}`);
    });
    child.on('error', error => {
      finished = true;
      clearTimeout(timer);
      removeDirQuietly(workDir);
      reject(error);
    });
    child.on('close', code => {
      finished = true;
      clearTimeout(timer);
      try {
        if (code !== 0) {
          throw new Error(`Gemini WebAPI bridge exited with code ${code}: ${(stderr || stdout).slice(-2000)}`);
        }
        if (!fs.existsSync(outputPath)) {
          throw new Error(`Gemini WebAPI bridge did not write output file. ${(stderr || stdout).slice(-2000)}`);
        }
        const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        removeDirQuietly(workDir);
        resolve(result);
      } catch (error) {
        removeDirQuietly(workDir);
        reject(error);
      }
    });
  });
}

function buildRequest(filePayloads, options, baseDir) {
  const config = getConfig(baseDir);
  const ui = config.uiSettings || {};
  const mergedOptions = {
    category: ui.category || 'Fashion product',
    useVietnameseModel: ui.useVietnameseModel !== false,
    noTextInImage: ui.noTextInImage !== false,
    styleCuonHut: ui.styleCuonHut !== false,
    panelCount: Number(ui.panelCount) || 3,
    sceneRatio: options.aspectRatio || ui.sceneRatio || '9:16',
    ...options,
  };

  return {
    options: mergedOptions,
    images: filePayloads.map((file, index) => ({
      name: file.name || `image-${index + 1}${getMimeExt(file.mimeType)}`,
      mimeType: file.mimeType || 'image/png',
      base64: Buffer.from(file.buffer).toString('base64'),
    })),
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

  const page = await getBrowserPage(baseDir);
  const videoDir = path.join(baseDir, 'uploads', 'aistudio-videos');
  ensureDir(videoDir);

  const preparedJobs = [];
  for (const job of jobs) {
    const { panel, filePayload } = job;
    console.log(`[GeminiWebAPI->Flow] Preparing video for panel ${panel.index}/${jobs.length}...`);
    const prepared = await prepareVideoGeneration(
      page,
      panel.prompt,
      null,
      [filePayload],
      {
        imageSelection: [`name:${filePayload.name}`],
        aspectRatio: options.aspectRatio || '9:16',
        videoModelKey: options.videoModelKey || null,
      },
      baseDir
    );
    preparedJobs.push({ panel, prepared });
  }

  console.log(`[GeminiWebAPI->Flow] Polling ${preparedJobs.length} video job(s) in parallel...`);
  const settled = await Promise.allSettled(preparedJobs.map(async ({ panel, prepared }) => {
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
  }));

  return settled.map((result, index) => {
    const panelIndex = preparedJobs[index].panel.index;
    if (result.status === 'fulfilled') return result.value;
    return {
      panelIndex,
      error: result.reason?.message || String(result.reason),
    };
  });
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

  console.log(`[GeminiWebAPI] Generating storyboard from ${filePayloads.length} image(s)...`);
  const request = buildRequest(filePayloads, options, baseDir);
  const bridgeResult = await runBridge(baseDir, request, Number(process.env.GEMINI_WEBAPI_TIMEOUT_MS) || 30 * 60 * 1000);
  const { panels, downloadDir } = writePanels(baseDir, bridgeResult);

  if (panels.length === 0) {
    throw new Error('Gemini WebAPI bridge returned no panels');
  }

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
    frameData: bridgeResult.frameData || '',
    cropTemplate: bridgeResult.cropTemplate || '',
    copiedPromptText: buildCopiedPromptText(panels),
  };

  cleanupGeneratedFiles(result, options);
  return result;
}

module.exports = {
  generateStoryboard,
  generateVideosFromPanelsDirect,
};
