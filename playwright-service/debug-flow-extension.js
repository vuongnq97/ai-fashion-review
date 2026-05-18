const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { EXTENSION_ID, getExtensionArgs } = require('./utils/extension-loader');
const { adoptBrowserPage, PROJECT_URL } = require('./services/browser');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function splitPrompts(rawText) {
  return String(rawText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    .split(/\n\s*\n+/)
    .map(text => text.trim())
    .filter(Boolean);
}

function findDefaultImages(baseDir) {
  const dirs = [
    path.join(baseDir, 'uploads', 'aistudio-panels'),
    path.join(baseDir, 'test-output'),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir)
      .filter(name => /^panel-\d+\.(png|jpe?g|webp)$/i.test(name))
      .sort((a, b) => {
        const ai = Number((a.match(/panel-(\d+)/i) || [])[1] || 0);
        const bi = Number((b.match(/panel-(\d+)/i) || [])[1] || 0);
        return ai - bi;
      })
      .map(name => path.join(dir, name));
    if (files.length > 0) return files;
  }

  return [];
}

function resolveImages(baseDir, args) {
  const rawImages = args.images
    ? String(args.images).split(',').map(item => item.trim()).filter(Boolean)
    : findDefaultImages(baseDir);

  return rawImages.map(filePath => path.resolve(baseDir, filePath)).filter(filePath => {
    const ok = fs.existsSync(filePath);
    if (!ok) console.log(`[DebugFlowExt] ⚠️ Image not found: ${filePath}`);
    return ok;
  });
}

function loadPrompts(baseDir, args, imageCount) {
  if (args.prompts) return String(args.prompts);

  if (args['prompts-file']) {
    const promptPath = path.resolve(baseDir, args['prompts-file']);
    if (!fs.existsSync(promptPath)) throw new Error(`Prompt file not found: ${promptPath}`);
    return fs.readFileSync(promptPath, 'utf8');
  }

  return Array.from({ length: imageCount }, (_, index) =>
    `Create an 8-second cinematic product video from panel ${index + 1}. Keep the product accurate, realistic, premium, and suitable for TikTok shop advertising.`
  ).join('\n\n');
}

async function waitForExtensionQueue(extensionPage, expectedCount, timeoutMs = 45 * 60 * 1000) {
  console.log(`[DebugFlowExt] Waiting for extension queue (${expectedCount} item(s))...`);
  const start = Date.now();
  let lastText = '';

  while (Date.now() - start < timeoutMs) {
    const state = await extensionPage.evaluate(() => {
      const group = document.querySelector('.queue-body .queue-group');
      if (!group) return { hasGroup: false, done: false, text: '' };

      const items = Array.from(group.querySelectorAll('.queue-item'));
      const completed = items.filter(item => item.classList.contains('completed')).length;
      const stopped = items.filter(item => item.classList.contains('stopped')).length;
      const statuses = items.map(item => (item.querySelector('.status-text')?.textContent || '').trim());
      return {
        hasGroup: true,
        done: items.length > 0 && completed >= items.length,
        failed: stopped > 0 || statuses.some(status => /lỗi|fail|không|timeout/i.test(status)),
        total: items.length,
        completed,
        statuses,
        text: group.innerText
      };
    });

    if (state.hasGroup) {
      const text = `${state.completed || 0}/${state.total || 0}: ${(state.statuses || []).join(' | ')}`;
      if (text !== lastText) {
        console.log(`[DebugFlowExt] Queue ${text}`);
        lastText = text;
      }
      if (state.done) return state;
      if (state.failed) throw new Error(`[DebugFlowExt] Queue failed: ${state.text}`);
    }

    await extensionPage.waitForTimeout(5000);
  }

  throw new Error('[DebugFlowExt] Queue timed out');
}

async function waitForDownloads(downloadedVideos, pendingDownloads, expectedCount, extensionPage, timeoutMs = 15 * 60 * 1000) {
  const start = Date.now();
  let lastDownloadCount = 0;
  let lastDownloadChangeTime = Date.now();
  const staleTimeoutMs = 2 * 60 * 1000;

  while ((downloadedVideos.length < expectedCount || pendingDownloads.size > 0) && Date.now() - start < timeoutMs) {
    console.log(`[DebugFlowExt] Waiting for extension downloads: ${downloadedVideos.length}/${expectedCount}, pending=${pendingDownloads.size}`);

    if (downloadedVideos.length > lastDownloadCount) {
      lastDownloadCount = downloadedVideos.length;
      lastDownloadChangeTime = Date.now();
    }

    if (downloadedVideos.length > 0 && pendingDownloads.size === 0 && Date.now() - lastDownloadChangeTime > staleTimeoutMs) {
      console.log(`[DebugFlowExt] No new downloads for ${staleTimeoutMs / 1000}s. Continuing with ${downloadedVideos.length}/${expectedCount}.`);
      break;
    }

    await extensionPage.waitForTimeout(5000);
  }
  return downloadedVideos.slice(0, expectedCount);
}

(async () => {
  const baseDir = __dirname;
  const args = parseArgs(process.argv.slice(2));
  const userDataDir = path.join(baseDir, 'chrome-data');
  const cookieFile = path.join(baseDir, 'labs.google.cookies.json');
  const outputDir = path.join(baseDir, 'debug-output', 'flow-extension');
  fs.mkdirSync(outputDir, { recursive: true });

  const imagePaths = resolveImages(baseDir, args);
  if (imagePaths.length === 0) {
    throw new Error('No panel images found. Use --images "path1,path2,path3" or put panel images in uploads/aistudio-panels.');
  }

  const rawPrompts = loadPrompts(baseDir, args, imagePaths.length);
  const promptCount = splitPrompts(rawPrompts).length;
  const expectedCount = Math.max(promptCount, imagePaths.length);
  const expectedVideoCount = Math.min(expectedCount, imagePaths.length);

  try { fs.unlinkSync(path.join(userDataDir, 'SingletonLock')); } catch (_) {}

  console.log(`[DebugFlowExt] Images (${imagePaths.length}):`);
  imagePaths.forEach((item, index) => console.log(`  ${index + 1}. ${item}`));
  console.log(`[DebugFlowExt] Prompt blocks: ${promptCount || 0}`);
  console.log(`[DebugFlowExt] Output dir: ${outputDir}`);
  console.log('[DebugFlowExt] Mode: extension download only. No Flow API polling.');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    acceptDownloads: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      ...getExtensionArgs(baseDir),
    ],
  });

  if (fs.existsSync(cookieFile)) {
    const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
    await context.addCookies(cookies);
    console.log(`[DebugFlowExt] Loaded ${cookies.length} cookies.`);
  }

  const downloadedVideos = [];
  const pendingDownloads = new Map();
  const seenDownloadNames = new Map();
  const downloadPages = new WeakSet();

  const makeDownloadPath = (suggestedName) => {
    const parsed = path.parse(suggestedName || `flow-video-${Date.now()}.mp4`);
    const safeBase = (parsed.name || 'flow-video').replace(/[^\w.-]+/g, '-');
    const ext = parsed.ext || '.mp4';
    const key = `${safeBase}${ext}`;
    const count = (seenDownloadNames.get(key) || 0) + 1;
    seenDownloadNames.set(key, count);
    const fileName = count === 1 ? `${safeBase}${ext}` : `${safeBase}-${count}${ext}`;
    return path.join(outputDir, fileName);
  };

  const downloadHandler = async (download) => {
    const suggestedName = download.suggestedFilename();
    const savePath = makeDownloadPath(suggestedName);
    const downloadKey = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingDownloads.set(downloadKey, { name: suggestedName, savePath, startedAt: Date.now() });
    console.log(`[DebugFlowExt] ⬇️ Download started (${pendingDownloads.size} pending): ${suggestedName}`);

    try {
      await download.saveAs(savePath);
      downloadedVideos.push({
        index: downloadedVideos.length + 1,
        name: suggestedName,
        videoPath: savePath,
      });
      console.log(`[DebugFlowExt] 📥 Downloaded ${downloadedVideos.length}/${expectedVideoCount}: ${suggestedName} → ${savePath}`);
    } catch (error) {
      console.log(`[DebugFlowExt] ⚠️ Download save failed for ${suggestedName}: ${error.message}`);
    } finally {
      pendingDownloads.delete(downloadKey);
    }
  };

  const attachDownloadListener = (page) => {
    if (!page || page.isClosed() || downloadPages.has(page)) return;
    downloadPages.add(page);
    page.on('download', downloadHandler);
  };

  context.pages().forEach(attachDownloadListener);
  context.on('page', attachDownloadListener);

  const flowPage = await context.newPage();
  attachDownloadListener(flowPage);
  flowPage.on('console', msg => console.log(`[FlowConsole:${msg.type()}] ${msg.text()}`));
  await flowPage.goto(PROJECT_URL);
  await flowPage.waitForTimeout(6000);
  await adoptBrowserPage(context, flowPage);
  if (flowPage.url().includes('accounts.google.com')) {
    throw new Error('Not authenticated for Google Flow. Run login.js first.');
  }

  const extensionPage = await context.newPage();
  extensionPage.on('console', msg => console.log(`[ExtensionConsole:${msg.type()}] ${msg.text()}`));
  await extensionPage.goto(`chrome-extension://${EXTENSION_ID}/popup.html?skipIntro=1&tab=control-tab&mode=frame-to-video&defaults=1`);
  await extensionPage.waitForLoadState('domcontentloaded');
  await extensionPage.waitForTimeout(1000);
  console.log('[DebugFlowExt] Extension opened at Automation → Frame to Video.');

  const fileChooserPromise = extensionPage.waitForEvent('filechooser');
  await extensionPage.locator('#frame-to-video .upload-zone').click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(imagePaths);
  console.log(`[DebugFlowExt] Uploaded ${imagePaths.length} image(s) to extension.`);

  await extensionPage.locator('#frame-to-video textarea').fill(rawPrompts);
  await extensionPage.evaluate(() => {
    const outputSelect = document.querySelector('#frame-to-video .output-dial-select');
    if (outputSelect) {
      outputSelect.value = '1';
      outputSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const outputNum = document.querySelector('#frame-to-video .output-dial-num');
    if (outputNum) outputNum.textContent = '1';
  });
  console.log('[DebugFlowExt] Prompts filled and Outputs per Prompt set to 1.');

  await flowPage.bringToFront();
  await flowPage.waitForTimeout(500);
  await extensionPage.bringToFront();
  await extensionPage.getByRole('button', { name: '▷ Run', exact: true }).click();
  console.log('[DebugFlowExt] Clicked extension Run.');

  await waitForExtensionQueue(extensionPage, expectedCount);
  const results = await waitForDownloads(downloadedVideos, pendingDownloads, expectedVideoCount, extensionPage);

  const reportPath = path.join(outputDir, `debug-report-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    projectUrl: PROJECT_URL,
    imagePaths,
    promptCount,
    expectedVideoCount,
    results,
  }, null, 2));
  console.log(`[DebugFlowExt] Report saved: ${reportPath}`);
  console.log(`[DebugFlowExt] Downloads: ${results.length}/${expectedVideoCount}`);

  if (args['keep-open']) {
    console.log('[DebugFlowExt] keep-open enabled. Press Ctrl+C to close.');
    await new Promise(() => {});
  }

  await context.close();
})().catch(error => {
  console.error('[DebugFlowExt] Fatal:', error);
  process.exit(1);
});
