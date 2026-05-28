const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { adoptBrowserPage, ensureBearerToken, PROJECT_URL } = require('./browser');
const { prepareVideoGeneration, executeVideoGeneration } = require('./video');
const { EXTENSION_ID, getExtensionArgs } = require('../utils/extension-loader');
const { startTrustedSubmitWatchdog } = require('../utils/flow-submit-watchdog');
const { startTrustedAssetWatchdog } = require('../utils/flow-asset-watchdog');

const { getConfig, applyConfigToUI } = require('../utils/config-manager');
const config = getConfig(path.resolve(__dirname, '..'));
const AISTUDIO_URL = config.systemSettings.aiStudioUrl || 'https://aistudio.google.com/apps/67340c71-44d0-4210-a324-33525f7e1ecb?fullscreenApplet=true';

let globalContext = null;
let globalPage = null;

function splitCopiedPrompts(rawText) {
  const text = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  if (!text) return [];

  const panelHeaderRegex = /(?:^|\n)\s*PANEL\s+(\d+)\s+PROMPT\s*\n+/gi;
  const headers = [];
  let match;
  while ((match = panelHeaderRegex.exec(text)) !== null) {
    headers.push({
      panelIndex: parseInt(match[1], 10),
      contentStart: panelHeaderRegex.lastIndex,
      headerStart: match.index
    });
  }

  if (headers.length > 0) {
    return headers.map((header, index) => {
      const end = index + 1 < headers.length ? headers[index + 1].headerStart : text.length;
      return {
        panelIndex: header.panelIndex,
        prompt: text.slice(header.contentStart, end).trim()
      };
    }).filter(item => item.prompt.length > 0);
  }

  return text
    .split(/\n\s*\n+/)
    .map((prompt, index) => ({
      panelIndex: index + 1,
      prompt: prompt
        .replace(/^\s*PANEL\s+\d+\s+PROMPT\s*/i, '')
        .trim()
    }))
    .filter(item => item.prompt.length > 0);
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

  const uniquePaths = [...new Set(paths)].filter(Boolean);
  let deleted = 0;
  for (const filePath of uniquePaths) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    } catch (error) {
      console.log(`[AIStudio] ⚠️ Could not cleanup ${filePath}: ${error.message}`);
    }
  }

  if (deleted > 0) {
    console.log(`[AIStudio] 🧹 Cleaned up ${deleted}/${uniquePaths.length} generated file(s).`);
  }
}

async function closePageQuietly(page, label) {
  try {
    if (page && !page.isClosed()) {
      await page.close();
      console.log(`[AIStudio] Closed ${label} tab.`);
    }
  } catch (error) {
    console.log(`[AIStudio] ⚠️ Could not close ${label} tab: ${error.message}`);
  }
}

// ── Browser management ───────────────────────────────────────
async function getAIStudioPage(baseDir) {
  const { getSharedContext } = require('./browser');
  const context = await getSharedContext(baseDir);

  if (globalPage && !globalPage.isClosed()) {
    if (!globalPage.url().includes('aistudio.google.com/apps')) {
      await globalPage.goto(AISTUDIO_URL);
      await globalPage.waitForTimeout(6000);
    }
    return globalPage;
  }

  console.log('[AIStudio] Creating new page in shared context...');
  globalPage = await context.newPage();
  await globalPage.goto(AISTUDIO_URL);
  console.log('[AIStudio] Waiting for page load...');
  await globalPage.waitForTimeout(8000);

  if (globalPage.url().includes('accounts.google.com')) {
    throw new Error('Not authenticated for AI Studio. Please login manually first.');
  }

  return globalPage;
}

// ── Get the app iframe ───────────────────────────────────────
async function getAppFrame(page) {
  const frames = page.frames();
  const appFrame = frames.find(f => f.url().includes('run.app'));
  if (!appFrame) {
    for (const frame of frames) {
      try {
        const hasUpload = await frame.$('#upload');
        if (hasUpload) return frame;
      } catch (e) {}
    }
    throw new Error('Could not find AI Studio app iframe.');
  }
  return appFrame;
}

// ── Handle "Continue to the app" dialog ──────────────────────
async function dismissOverlays(page) {
  try {
    const continueBtn = await page.$('button:has-text("Continue to the app")');
    if (continueBtn) {
      console.log('[AIStudio] "Continue to the app" dialog → clicking...');
      await continueBtn.click();
      await page.waitForTimeout(1500);
      console.log('[AIStudio] ✅ Continued');
    }
  } catch (e) {
    console.log(`[AIStudio] ⚠️ Overlay handling: ${e.message}`);
  }
}

// ── Upload product images ────────────────────────────────────
async function uploadProductImages(frame, filePayloads, baseDir) {
  console.log(`[AIStudio] Uploading ${filePayloads.length} product image(s)...`);

  const fileInput = await frame.$('#upload input[type="file"]');
  if (!fileInput) throw new Error('Could not find file input inside #upload');

  const tempDir = path.join(baseDir, 'uploads', 'aistudio-temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const tempPaths = [];
  for (const file of filePayloads) {
    const ext = file.mimeType.includes('png') ? '.png' : '.jpg';
    const tempPath = path.join(tempDir, `${Date.now()}-${Math.random().toString(36).substring(7)}${ext}`);
    fs.writeFileSync(tempPath, file.buffer);
    tempPaths.push(tempPath);
  }

  try {
    await fileInput.setInputFiles(tempPaths);
    console.log(`[AIStudio] ✅ Set ${tempPaths.length} file(s)`);
    await frame.waitForTimeout(3000);
  } finally {
    for (const p of tempPaths) { try { fs.unlinkSync(p); } catch (_) {} }
    try { fs.rmdirSync(tempDir); } catch (_) {}
  }
}

// ── Click create and wait for generation ─────────────────────
async function clickCreateAndWait(page, frame) {
  console.log('[AIStudio] Clicking "Tạo storyboard & prompt"...');

  const createBtn = await frame.$('#create-button');
  if (!createBtn) throw new Error('#create-button not found');

  const isDisabled = await createBtn.evaluate(el => el.disabled);
  if (isDisabled) throw new Error('#create-button is disabled. Upload images first.');

  // Setup download handler BEFORE clicking
  const downloadDir = path.join(__dirname, '..', 'uploads', 'aistudio-panels');
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

  const downloadedFiles = [];
  const seenNames = new Set();

  const downloadHandler = async (download) => {
    const name = download.suggestedFilename();
    // Deduplicate (app triggers each download twice)
    if (seenNames.has(name)) {
      try { await download.delete(); } catch (_) {}
      return;
    }
    seenNames.add(name);
    const savePath = path.join(downloadDir, name);
    await download.saveAs(savePath);
    downloadedFiles.push({ name, path: savePath });
    console.log(`[AIStudio] 📥 Downloaded: ${name}`);
  };

  page.on('download', downloadHandler);

  await createBtn.click();
  console.log('[AIStudio] ✅ Clicked. Waiting for generation...');

  try {
    const launchOverlay = frame.locator('.interaction-modal', { hasText: /launch!/i }).first();
    await launchOverlay.waitFor({ state: 'visible', timeout: 5000 });
    await launchOverlay.hover();
    console.log('[AIStudio] Hovered Launch interaction modal.');
  } catch (error) {
    console.log(`[AIStudio] ⚠️ Launch interaction modal hover skipped: ${error.message}`);
  }

  // Poll: wait until "Sao chép tất cả" button appears (= generation done)
  // This is more reliable than polling #loading since #loading SVG always exists
  const maxWait = 600000; // 10 min max
  const startTime = Date.now();
  let genDone = false;

  while (Date.now() - startTime < maxWait) {
    try {
      const copyBtn = await frame.$('button:has-text("Sao chép tất cả")');
      if (copyBtn) {
        const isVisible = await copyBtn.evaluate(el => el.offsetWidth > 0 && el.offsetHeight > 0);
        if (isVisible) {
          genDone = true;
          break;
        }
      }
    } catch (_) {}

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (elapsed % 10 === 0 && elapsed > 0) {
      console.log(`[AIStudio] ⏳ Waiting for generation... (${elapsed}s)`);
    }
    await frame.waitForTimeout(2000);
  }

  if (!genDone) {
    page.removeListener('download', downloadHandler);
    throw new Error('Generation timed out after 10 minutes');
  }

  console.log(`[AIStudio] ✅ Generation complete! (${Math.round((Date.now() - startTime) / 1000)}s)`);

  // Wait for auto-downloads to finish
  await page.waitForTimeout(5000);
  page.removeListener('download', downloadHandler);

  return { downloadedFiles, downloadDir };
}

// ── Click "copy all prompts" and parse clipboard text ────────
async function clickCopyAllPrompts(page, frame) {
  console.log('[AIStudio] Clicking "SAO CHÉP TẤT CẢ PROMPT"...');

  const copyButton = frame.locator('button').filter({ hasText: /sao chép tất cả(?: prompt)?/i }).first();
  await copyButton.waitFor({ state: 'visible', timeout: 30000 });

  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  } catch (e) {
    console.log(`[AIStudio] ⚠️ Clipboard permission grant skipped: ${e.message}`);
  }

  await copyButton.click();
  await page.waitForTimeout(800);

  let clipboardText = '';
  const readAttempts = [
    () => page.evaluate(() => navigator.clipboard.readText()),
    () => frame.evaluate(() => navigator.clipboard.readText())
  ];

  for (const attempt of readAttempts) {
    try {
      clipboardText = await attempt();
      if (clipboardText && clipboardText.trim()) break;
    } catch (e) {
      console.log(`[AIStudio] ⚠️ Clipboard read attempt failed: ${e.message}`);
    }
  }

  const prompts = splitCopiedPrompts(clipboardText);
  console.log(`[AIStudio] ✅ Clipboard prompts parsed: ${prompts.length}`);
  prompts.forEach(p => {
    console.log(`  Prompt ${p.panelIndex}: "${p.prompt.substring(0, 80)}..."`);
  });

  return { clipboardText, prompts };
}

// ── Extract prompts from iframe ──────────────────────────────
async function extractPrompts(frame) {
  console.log('[AIStudio] Extracting prompts...');

  const prompts = await frame.evaluate(() => {
    const results = [];

    // Strategy 1: Find prompt blocks by header pattern "Panel X Prompt"
    // The body text has: "PANEL 1 PROMPT\n\n<text>\n\nPANEL 2 PROMPT\n\n<text>"
    const body = document.body.innerText;

    // Find the "Prompt Veo 3 tương ứng" section start or "SAO CHÉP TẤT CẢ\n" (button line)
    // Then find each "PANEL X PROMPT" block after it
    const promptSectionStart = body.indexOf('Prompt Veo 3 tương ứng');
    if (promptSectionStart === -1) return results;

    const promptSection = body.substring(promptSectionStart);

    // Split by PANEL headers: "PANEL 1 PROMPT", "PANEL 2 PROMPT", etc.
    const regex = /PANEL\s+(\d+)\s+PROMPT\s*/gi;
    const headers = [];
    let match;

    while ((match = regex.exec(promptSection)) !== null) {
      headers.push({ index: parseInt(match[1]), pos: match.index + match[0].length });
    }

    // Extract text between headers
    for (let i = 0; i < headers.length; i++) {
      const start = headers[i].pos;
      const end = i + 1 < headers.length ? headers[i + 1].pos - headers[i + 1].pos + headers[i + 1].pos : undefined;

      // Find the end of this prompt (next PANEL header or end markers)
      let endPos;
      if (i + 1 < headers.length) {
        // Find "PANEL X" start position (before the match)
        const nextHeaderStart = promptSection.indexOf(`PANEL ${headers[i + 1].index}`, start);
        endPos = nextHeaderStart !== -1 ? nextHeaderStart : promptSection.length;
      } else {
        // Last panel — end at known markers
        const endMarkers = ['* Hướng dẫn:', 'Kịch bản', '* Note:', '* Lưu ý:'];
        endPos = promptSection.length;
        for (const marker of endMarkers) {
          const idx = promptSection.indexOf(marker, start);
          if (idx !== -1 && idx < endPos) endPos = idx;
        }
      }

      const promptText = promptSection.substring(start, endPos).trim();
      if (promptText.length > 10) {
        results.push({ panelIndex: headers[i].index, prompt: promptText });
      }
    }

    return results;
  });

  console.log(`[AIStudio] ✅ Extracted ${prompts.length} panel prompt(s)`);
  prompts.forEach(p => {
    console.log(`  Panel ${p.panelIndex}: "${p.prompt.substring(0, 80)}..."`);
  });

  return prompts;
}

function buildFilePayloadFromPanel(panel) {
  if (!panel.imagePath) return null;
  if (!fs.existsSync(panel.imagePath)) return null;

  const ext = path.extname(panel.imagePath).toLowerCase();
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  return {
    name: path.basename(panel.imagePath),
    mimeType,
    buffer: fs.readFileSync(panel.imagePath)
  };
}

async function openFlowPageFromAIStudioContext() {
  if (!globalContext) throw new Error('[AIStudio] Browser context is not available for Google Flow');

  console.log('[AIStudio→Flow] Opening Google Flow in a new tab...');
  const flowPage = await globalContext.newPage();
  await flowPage.goto(PROJECT_URL);
  await flowPage.waitForTimeout(6000);
  await adoptBrowserPage(globalContext, flowPage);

  if (flowPage.url().includes('accounts.google.com')) {
    throw new Error('Not authenticated for Google Flow. Please login manually first.');
  }

  console.log('[AIStudio→Flow] ✅ Flow tab ready');
  return flowPage;
}

async function waitForExtensionQueue(extensionPage, expectedCount, timeoutMs = 45 * 60 * 1000) {
  console.log(`[AIStudio→Extension] Waiting for queue completion (${expectedCount} item(s))...`);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const state = await extensionPage.evaluate(() => {
      const group = document.querySelector('.queue-body .queue-group');
      if (!group) return { hasGroup: false, done: false, text: '' };

      const items = Array.from(group.querySelectorAll('.queue-item'));
      const completed = items.filter(item => item.classList.contains('completed')).length;
      const stopped = items.filter(item => item.classList.contains('stopped')).length;
      const statuses = items.map(item => (item.querySelector('.status-text')?.textContent || '').trim());
      const badge = (group.querySelector('.badge-running')?.textContent || '').trim();

      return {
        hasGroup: true,
        done: items.length > 0 && completed >= items.length,
        failed: stopped > 0 || statuses.some(status => /lỗi|fail|không|timeout/i.test(status)),
        total: items.length,
        completed,
        stopped,
        badge,
        statuses,
        text: group.innerText
      };
    });

    if (state.hasGroup) {
      console.log(`[AIStudio→Extension] Queue ${state.completed || 0}/${state.total || 0}: ${(state.statuses || []).join(' | ')}`);
      if (state.done) return state;
      if (state.failed) {
        throw new Error(`[AIStudio→Extension] Queue failed: ${state.text}`);
      }
    }

    await extensionPage.waitForTimeout(5000);
  }

  throw new Error('[AIStudio→Extension] Queue timed out');
}

async function generateVideosWithExtensionFromPanels(baseDir, panels, rawPrompts, options = {}) {
  const panelPaths = panels
    .filter(panel => panel.imagePath && fs.existsSync(panel.imagePath))
    .sort((a, b) => a.index - b.index)
    .map(panel => panel.imagePath);

  if (panelPaths.length === 0) {
    console.log('[AIStudio→Extension] No panel images to upload.');
    return [];
  }

  const flowPage = await openFlowPageFromAIStudioContext();
  const context = globalContext;
  const promptBlocks = splitCopiedPrompts(rawPrompts).map(item => item.prompt);
  const expectedCount = Math.max(promptBlocks.length, panelPaths.length);
  const expectedVideoCount = Math.min(expectedCount, panelPaths.length);
  const videoDir = path.join(baseDir, 'uploads', 'aistudio-videos');
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

  const downloadedVideos = [];
  const pendingDownloads = new Map();
  const seenDownloadNames = new Map();
  const downloadPages = new WeakSet();
  const makeDownloadPath = (suggestedName) => {
    const parsed = path.parse(suggestedName || `flow-video-${Date.now()}.mp4`);
    const safeBase = (parsed.name || 'flow-video').replace(/[^\w.-]+/g, '-');
    const ext = parsed.ext || '.mp4';
    const count = (seenDownloadNames.get(`${safeBase}${ext}`) || 0) + 1;
    seenDownloadNames.set(`${safeBase}${ext}`, count);
    const fileName = count === 1 ? `${safeBase}${ext}` : `${safeBase}-${count}${ext}`;
    return path.join(videoDir, fileName);
  };

  const downloadHandler = async (download) => {
    const suggestedName = download.suggestedFilename();
    const savePath = makeDownloadPath(suggestedName);
    const downloadKey = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingDownloads.set(downloadKey, { name: suggestedName, savePath, startedAt: Date.now() });
    console.log(`[AIStudio→Extension] ⬇️ Download started (${pendingDownloads.size} pending): ${suggestedName}`);

    try {
      await download.saveAs(savePath);
      const item = {
        panelIndex: downloadedVideos.length + 1,
        name: suggestedName,
        videoPath: savePath,
      };

      if (options.includeVideoBase64) {
        item.video = {
          base64: fs.readFileSync(savePath).toString('base64'),
          mimeType: 'video/mp4'
        };
      }

      downloadedVideos.push(item);
      console.log(`[AIStudio→Extension] 📥 Downloaded video ${downloadedVideos.length}/${expectedVideoCount}: ${suggestedName} → ${savePath}`);
    } catch (error) {
      console.log(`[AIStudio→Extension] ⚠️ Download save failed for ${suggestedName}: ${error.message}`);
    } finally {
      pendingDownloads.delete(downloadKey);
    }
  };

  const attachDownloadListener = (page) => {
    if (!page || page.isClosed()) return;
    if (downloadPages.has(page)) return;
    downloadPages.add(page);
    page.on('download', downloadHandler);
  };

  let extensionPage = null;
  let submitWatchdog = null;
  let assetWatchdog = null;
  let shouldCloseTabs = false;
  context.pages().forEach(attachDownloadListener);
  context.on('page', attachDownloadListener);

  try {
    extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${EXTENSION_ID}/popup.html?skipIntro=1&tab=control-tab&mode=frame-to-video&defaults=1`);
    await extensionPage.waitForLoadState('domcontentloaded');
    await extensionPage.waitForTimeout(1000);

    const fileChooserPromise = extensionPage.waitForEvent('filechooser');
    await extensionPage.locator('#frame-to-video .upload-zone').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(panelPaths);
    console.log(`[AIStudio→Extension] Uploaded ${panelPaths.length} panel image(s) into extension UI`);

    await extensionPage.locator('#frame-to-video textarea').fill(String(rawPrompts || ''));
    await extensionPage.evaluate(() => {
      const select = document.querySelector('#frame-to-video .output-dial-select');
      if (select) {
        select.value = '1';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const num = document.querySelector('#frame-to-video .output-dial-num');
      if (num) num.textContent = '1';
    });

    await flowPage.bringToFront();
    await flowPage.waitForTimeout(500);
    await extensionPage.bringToFront();
    await extensionPage.getByRole('button', { name: '▷ Run', exact: true }).click();

    submitWatchdog = startTrustedSubmitWatchdog(flowPage, promptBlocks, {
      label: 'AIStudioExtensionSubmit',
    });
    assetWatchdog = startTrustedAssetWatchdog(flowPage, extensionPage, panelPaths, {
      label: 'AIStudioExtensionAsset',
    });

    const queueDebugPromise = waitForExtensionQueue(extensionPage, expectedCount)
      .catch(error => {
        console.log(`[AIStudio→Extension] Queue debug ended with warning: ${error.message}`);
        return null;
      });

    await queueDebugPromise;

    const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
    const waitDownloadStart = Date.now();

    while ((downloadedVideos.length < expectedVideoCount || pendingDownloads.size > 0) && Date.now() - waitDownloadStart < DOWNLOAD_TIMEOUT_MS) {
      console.log(`[AIStudio→Extension] Waiting for extension downloads: ${downloadedVideos.length}/${expectedVideoCount}, pending=${pendingDownloads.size} (${Math.round((Date.now() - waitDownloadStart) / 1000)}s elapsed)`);

      // Re-attach listeners to any new pages
      context.pages().forEach(attachDownloadListener);
      
      await extensionPage.waitForTimeout(5000);
    }

    if (submitWatchdog) {
      console.log(`[AIStudio→Extension] Trusted submit clicks performed: ${submitWatchdog.getClickCount()}`);
    }
    if (assetWatchdog) {
      console.log(`[AIStudio→Extension] Trusted asset clicks performed: ${assetWatchdog.getClickCount()}`);
    }

    // Fallback: scan multiple directories for recently created mp4 files
    if (downloadedVideos.length < expectedVideoCount) {
      console.log(`[AIStudio→Extension] ⚠️ Only ${downloadedVideos.length}/${expectedVideoCount} caught by handler. Scanning directories for missed files...`);
      const knownPaths = new Set(downloadedVideos.map(v => v.videoPath));
      
      // Directories to scan: videoDir, ~/Downloads, ~/Downloads/veo-folder-*
      const scanDirs = [videoDir];
      const homeDownloads = path.join(require('os').homedir(), 'Downloads');
      if (fs.existsSync(homeDownloads)) {
        scanDirs.push(homeDownloads);
        // Also scan subfolders like veo-folder-1, etc.
        try {
          const subDirs = fs.readdirSync(homeDownloads)
            .filter(d => d.startsWith('veo-folder'))
            .map(d => path.join(homeDownloads, d))
            .filter(d => fs.statSync(d).isDirectory());
          scanDirs.push(...subDirs);
        } catch (_) {}
      }

      for (const dir of scanDirs) {
        if (downloadedVideos.length >= expectedVideoCount) break;
        try {
          const allFiles = fs.readdirSync(dir)
            .filter(f => f.endsWith('.mp4'))
            .map(f => {
              const fullPath = path.join(dir, f);
              const stat = fs.statSync(fullPath);
              return { name: f, path: fullPath, mtime: stat.mtimeMs };
            })
            // Only files created during this run (within last 20 minutes)
            .filter(f => f.mtime > Date.now() - 1200000 && !knownPaths.has(f.path))
            .sort((a, b) => a.mtime - b.mtime);
          
          for (const file of allFiles) {
            if (downloadedVideos.length >= expectedVideoCount) break;
            const item = {
              panelIndex: downloadedVideos.length + 1,
              name: file.name,
              videoPath: file.path,
            };
            if (options.includeVideoBase64) {
              item.video = {
                base64: fs.readFileSync(file.path).toString('base64'),
                mimeType: 'video/mp4'
              };
            }
            downloadedVideos.push(item);
            knownPaths.add(file.path);
            console.log(`[AIStudio→Extension] 📥 Recovered missed video ${downloadedVideos.length}/${expectedVideoCount} from ${dir}: ${file.name}`);
          }
        } catch (scanError) {
          // Skip directories that can't be read
        }
      }
    }

    console.log(`[AIStudio→Extension] ✅ Final download count: ${downloadedVideos.length}/${expectedVideoCount}`);
    if (downloadedVideos.length < expectedVideoCount) {
      throw new Error(`[AIStudio→Extension] Only downloaded ${downloadedVideos.length}/${expectedVideoCount} videos.`);
    }
    shouldCloseTabs = true;
    return downloadedVideos.slice(0, expectedVideoCount);
  } finally {
    if (submitWatchdog) {
      submitWatchdog.stop();
    }
    if (assetWatchdog) {
      assetWatchdog.stop();
    }

    context.off('page', attachDownloadListener);
    context.pages().forEach(page => {
      try { page.removeListener('download', downloadHandler); } catch (_) {}
    });
    if (shouldCloseTabs) {
      await closePageQuietly(extensionPage, 'extension');
      await closePageQuietly(flowPage, 'Flow');
    } else {
      console.log('[AIStudio→Extension] Keeping Flow/extension tabs open because video downloads did not finish.');
    }
  }
}

async function generateVideosFromPanels(baseDir, panels, options = {}) {
  const videoJobs = panels
    .filter(panel => panel.prompt && panel.imagePath)
    .map(panel => ({ panel, filePayload: buildFilePayloadFromPanel(panel) }))
    .filter(job => job.filePayload);

  if (videoJobs.length === 0) {
    console.log('[AIStudio→Flow] No complete panel+prompt pairs to generate videos.');
    return [];
  }

  const flowPage = await openFlowPageFromAIStudioContext();
  const videoDir = path.join(baseDir, 'uploads', 'aistudio-videos');
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

  const preparedJobs = [];
  for (const job of videoJobs) {
    const { panel, filePayload } = job;
    console.log(`[AIStudio→Flow] Starting video for panel ${panel.index}/${videoJobs.length}...`);
    const prepared = await prepareVideoGeneration(
      flowPage,
      panel.prompt,
      null,
      [filePayload],
      {
        imageSelection: [`name:${filePayload.name}`],
        aspectRatio: options.aspectRatio || '9:16',
        videoModelKey: options.videoModelKey || null
      },
      baseDir
    );
    preparedJobs.push({ panel, prepared });
  }

  console.log(`[AIStudio→Flow] Polling ${preparedJobs.length} video job(s) in parallel...`);
  const settled = await Promise.allSettled(preparedJobs.map(async ({ panel, prepared }) => {
    const base64 = await executeVideoGeneration(prepared);
    const fileName = `panel-${panel.index}-video-${Date.now()}.mp4`;
    const videoPath = path.join(videoDir, fileName);
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
      error: result.reason?.message || String(result.reason)
    };
  });
}

// ── Main flow: generate storyboard ───────────────────────────
async function generateStoryboard(baseDir, filePayloads, options = {}) {
  if (!filePayloads || filePayloads.length === 0) {
    throw new Error('At least one product image is required');
  }

  // Step 1: Get page
  const page = await getAIStudioPage(baseDir);

  // Step 2: Reload for clean state
  await page.goto(AISTUDIO_URL);
  await page.waitForTimeout(8000);

  // Step 3: Dismiss overlay
  await dismissOverlays(page);

  // Step 4: Get iframe
  const frame = await getAppFrame(page);
  console.log('[AIStudio] ✅ Found app iframe');

  // Apply default config.json settings to the UI iframe
  await applyConfigToUI(frame, baseDir);

  // Step 5: Upload images
  await uploadProductImages(frame, filePayloads, baseDir);

  // Step 6: Click create & wait for generation + downloads
  const { downloadedFiles, downloadDir } = await clickCreateAndWait(page, frame);

  // Step 7: Copy all prompts first, then fall back to DOM extraction if needed
  const copied = await clickCopyAllPrompts(page, frame);
  let prompts = copied.prompts;
  if (prompts.length === 0) {
    prompts = await extractPrompts(frame);
  }

  // Step 8: Build result — match panels to prompts
  const panels = [];
  // Sort downloaded files by panel number: panel-1.png, panel-2.png, etc.
  const sortedFiles = downloadedFiles
    .filter(f => f.name.match(/panel-\d+/i))
    .sort((a, b) => {
      const numA = parseInt(a.name.match(/panel-(\d+)/i)?.[1] || '0');
      const numB = parseInt(b.name.match(/panel-(\d+)/i)?.[1] || '0');
      return numA - numB;
    });

  for (let i = 0; i < Math.max(sortedFiles.length, prompts.length); i++) {
    const panel = {
      index: i + 1,
      prompt: prompts[i]?.prompt || null,
      image: null,
      imagePath: null
    };

    if (sortedFiles[i]) {
      panel.imagePath = sortedFiles[i].path;
      try {
        const imgBuf = fs.readFileSync(sortedFiles[i].path);
        panel.image = imgBuf.toString('base64');
      } catch (e) {
        console.log(`[AIStudio] ⚠️ Could not read panel image: ${e.message}`);
      }
    }

    panels.push(panel);
  }

  console.log(`[AIStudio] ✅ Final result: ${panels.length} panel(s)`);

  let videos = [];
  if (options.generateVideos !== false) {
    videos = await generateVideosWithExtensionFromPanels(baseDir, panels, copied.clipboardText, {
      aspectRatio: options.aspectRatio || '9:16',
      videoModelKey: options.videoModelKey || null,
      includeVideoBase64: !!options.includeVideoBase64
    });
    console.log(`[AIStudio→Flow] ✅ Video result: ${videos.filter(v => !v.error).length}/${videos.length} completed`);
  }

  const result = { panels, videos, downloadDir, promptSource: copied.prompts.length > 0 ? 'clipboard' : 'dom' };
  cleanupGeneratedFiles(result, options);
  await closePageQuietly(page, 'AI Studio');
  if (page === globalPage) globalPage = null;
  return result;
}

function getAIStudioContext() {
  return globalContext;
}

module.exports = {
  getAIStudioPage,
  getAppFrame,
  dismissOverlays,
  uploadProductImages,
  clickCreateAndWait,
  clickCopyAllPrompts,
  splitCopiedPrompts,
  extractPrompts,
  generateVideosWithExtensionFromPanels,
  generateVideosFromPanels,
  generateStoryboard,
  getAIStudioContext,
  AISTUDIO_URL
};
