const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const state = require('../utils/state');
const { getBrowserPage } = require('../services/browser');
const { automateGeneration, prepareGeneration, executeGeneration } = require('../services/image');
const { automateVideoGeneration, prepareVideoGeneration, executeVideoGeneration } = require('../services/video');
const tiktok = require('../services/tiktok');
const aistudio = require('../services/aistudio');
const { processVideoBase64 } = require('../services/video-resize');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });
const baseDir = path.resolve(__dirname, '..');

// ── Request Queue for serializing Playwright operations ──
// Only one generation can run at a time since they share a single browser page
let generateQueue = Promise.resolve();
function enqueue(fn) {
  const task = generateQueue.then(fn, fn); // run fn regardless of previous result
  generateQueue = task.then(() => {}, () => {}); // swallow errors in chain
  return task;
}

router.post('/generate', upload.array('images', 5), async (req, res) => {
  const files = req.files;
  const body = req.body || {};

  // Enqueue so setup phase is processed one at a time
  const enqueueResult = enqueue(async () => {
    let imagePathsToClean = [];
    try {
      console.log(JSON.stringify(body).substring(0, 500));
      console.log(`[API] Raw body fileNames:`, body.fileNames);
      const { prompt, base64Images, mode, imageModel, aspectRatio, outputCount, imageSelection, fileNames } = body;

      if (!prompt) {
        res.status(400).json({ error: 'Prompt is required' });
        return;
      }

      let filePayloads = [];

      // Handle physical file uploads
      if (files && files.length > 0) {
        files.forEach((f, idx) => {
          const fPath = path.join(baseDir, f.path);
          imagePathsToClean.push(fPath);
          const name = (fileNames && fileNames[idx]) ? fileNames[idx] : (f.originalname || 'upload.png');
          filePayloads.push({ name, mimeType: f.mimetype, buffer: fs.readFileSync(fPath) });
        });
      }

      // Handle base64 string uploads
      if (base64Images) {
        const b64Array = Array.isArray(base64Images) ? base64Images : [base64Images];
        b64Array.forEach((b64, idx) => {
          const name = (fileNames && fileNames[idx]) ? fileNames[idx] : `b64_${idx}.png`;
          filePayloads.push({ name, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
        });
      }

      const config = {
        mode: mode || 'ingredients-to-image',
        imageModel: imageModel || 'nano-banana-2',
        aspectRatio: aspectRatio || '9:16',
        outputCount: parseInt(outputCount) || 1,
        imageSelection: imageSelection
      };

      console.log(`[API] Received: prompt="${prompt.substring(0, 60)}...", files=${filePayloads.length}, config=${JSON.stringify(config)}`);
      console.log(`[API] imageSelection from body:`, JSON.stringify(imageSelection));
      console.log(`[Queue] Processing request (queue active)...`);

      const page = await getBrowserPage(baseDir);

      // PHASE 1 (inside lock): Setup — upload, resolve UUIDs, get tokens
      const prepared = await prepareGeneration(page, prompt, filePayloads, config, baseDir);
      return prepared; // return prepared data out of enqueue
    } catch (error) {
      console.error('API Error:', error);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: error.message });
      }
    } finally {
      imagePathsToClean.forEach(p => {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { }
      });
    }
  });

  // PHASE 2 (outside lock): API call + fetch result — runs in parallel
  try {
    const prepared = await enqueueResult;
    if (!prepared || res.headersSent) return; // phase 1 failed
    const result = await executeGeneration(prepared);
    res.json({ success: true, image: result });
  } catch (error) {
    console.error('[Gen Phase 2] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

router.post('/generate-video', upload.array('images', 5), async (req, res) => {
  const files = req.files;
  const body = req.body || {};

  // Phase 1 (queued): browser setup + start API call
  const enqueueResult = enqueue(async () => {
    let imagePathsToClean = [];
    try {
      const { prompt, extendPrompt, base64Images, imageSelection, fileNames, aspectRatio, videoModelKey, chatId, panelIndex, panelName } = body;

      if (!prompt) {
        res.status(400).json({ error: 'Prompt is required' });
        return;
      }

      let filePayloads = [];

      if (files && files.length > 0) {
        files.forEach((f, idx) => {
          const fPath = path.join(baseDir, f.path);
          imagePathsToClean.push(fPath);
          const name = (fileNames && fileNames[idx]) ? fileNames[idx] : (f.originalname || 'upload.png');
          filePayloads.push({ name, mimeType: f.mimetype, buffer: fs.readFileSync(fPath) });
        });
      }

      if (base64Images) {
        const b64Array = Array.isArray(base64Images) ? base64Images : [base64Images];
        b64Array.forEach((b64, idx) => {
          const name = (fileNames && fileNames[idx]) ? fileNames[idx] : `b64_${idx}.png`;
          filePayloads.push({ name, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
        });
      }

      console.log(`[VideoGen] Received: prompt="${prompt.substring(0, 60)}...", files=${filePayloads.length}`);

      const page = await getBrowserPage(baseDir);
      const config = { imageSelection, aspectRatio: aspectRatio || '9:16', videoModelKey: videoModelKey || null };
      
      // PHASE 1: Setup + start API (inside lock)
      const prepared = await prepareVideoGeneration(page, prompt, extendPrompt, filePayloads, config, baseDir);
      return prepared;
    } catch (error) {
      console.error('API Error:', error);
      if (!res.headersSent) res.status(500).json({ success: false, error: error.message });
    } finally {
      imagePathsToClean.forEach(p => {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { }
      });
    }
  });

  // Phase 2 (outside lock): poll + fetch — runs in parallel with other videos
  try {
    const prepared = await enqueueResult;
    if (!prepared || res.headersSent) return;
    const resultBase64 = await executeVideoGeneration(prepared);
    if (resultBase64) {
      const { chatId, panelIndex, panelName } = body;
      const targetChatId = chatId || process.env.DEFAULT_TELEGRAM_CHAT_ID;
      if (targetChatId) {
        console.log(`[VideoGen] Sending video directly to Telegram for chatId: ${targetChatId}, panel: ${panelName || panelIndex}`);
        sendVideoToTelegramDirect(targetChatId, resultBase64, panelIndex, panelName).catch(err => {
          console.error('[VideoGen] Direct Telegram send failed:', err.message);
        });
      }
      res.json({ success: true, video: { base64: resultBase64, mimeType: 'video/mp4' } });
    } else {
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Could not extract generated video' });
    }
  } catch (error) {
    console.error('[VideoGen Phase 2] Error:', error);
    if (!res.headersSent) res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// Video Utilities Routes
// ═══════════════════════════════════════════════════════════════

router.post('/resize-video', async (req, res) => {
  const body = req.body || {};
  try {
    const { videoBase64, cropPercent, cropPx, aspectRatio, width, height } = body;
    
    if (!videoBase64) {
      return res.status(400).json({ success: false, error: 'videoBase64 is required' });
    }

    const options = {};
    if (cropPercent !== undefined) options.cropPercent = cropPercent;
    if (cropPx !== undefined) options.cropPx = cropPx;
    if (aspectRatio !== undefined) options.aspectRatio = aspectRatio;
    if (width !== undefined) options.width = width;
    if (height !== undefined) options.height = height;

    console.log(`[API] Resizing video, options:`, options);
    
    const resultBase64 = await processVideoBase64(videoBase64, options);
    
    res.json({ success: true, videoBase64: resultBase64 });
  } catch (error) {
    console.error('[ResizeVideo] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// AI Studio Storyboard Routes (with server-side request batching)
// ═══════════════════════════════════════════════════════════════

// Batch accumulator: groups requests by batchKey (chatId) within a time window
const storyboardBatches = new Map();
const BATCH_WAIT_MS = 5000; // Wait 5 seconds for more images before processing

router.post('/generate-storyboard', upload.array('images', 10), async (req, res) => {
  const files = req.files;
  const body = req.body || {};
  let imagePathsToClean = [];

  try {
    const { base64Images, fileNames, aspectRatio, videoModelKey, generateVideos, includeVideoBase64, batchKey } = body;
    let filePayloads = [];

    // Handle physical file uploads
    if (files && files.length > 0) {
      files.forEach((f, idx) => {
        const fPath = path.join(baseDir, f.path);
        imagePathsToClean.push(fPath);
        const name = (fileNames && fileNames[idx]) ? fileNames[idx] : (f.originalname || 'upload.png');
        filePayloads.push({ name, mimeType: f.mimetype, buffer: fs.readFileSync(fPath) });
      });
    }

    // Handle base64 string uploads
    if (base64Images) {
      const b64Array = Array.isArray(base64Images) ? base64Images : [base64Images];
      b64Array.forEach((b64, idx) => {
        const name = (fileNames && fileNames[idx]) ? fileNames[idx] : `image_${idx}.png`;
        filePayloads.push({ name, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
      });
    }

    if (filePayloads.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one image is required' });
    }

    const options = {
      generateVideos: generateVideos === undefined ? true : String(generateVideos) !== 'false',
      includeVideoBase64: String(includeVideoBase64) === 'true',
      aspectRatio: aspectRatio || '9:16',
      videoModelKey: videoModelKey || null
    };

    // If no batchKey, process immediately (single image, no batching)
    if (!batchKey) {
      console.log(`[API] Storyboard: ${filePayloads.length} image(s) received (no batch)`);
      const results = await aistudio.generateStoryboard(baseDir, filePayloads, options);
      return res.json({ success: true, results, isPrimary: true });
    }

    // ── Batching logic ───────────────────────────────────────
    console.log(`[API] Storyboard batch "${batchKey}": +${filePayloads.length} image(s)`);

    if (!storyboardBatches.has(batchKey)) {
      storyboardBatches.set(batchKey, {
        images: [],
        waiters: [],
        timer: null,
        options,
        primaryIdx: 0, // first request is primary
      });
    }

    const batch = storyboardBatches.get(batchKey);
    const myIdx = batch.waiters.length;
    batch.images.push(...filePayloads);

    // Create a promise that this request will wait on
    const resultPromise = new Promise((resolve, reject) => {
      batch.waiters.push({ resolve, reject });
    });

    // Reset the batch timer (extend window on each new image)
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(async () => {
      const { images, waiters, options: batchOpts } = batch;
      storyboardBatches.delete(batchKey);

      console.log(`[API] Storyboard batch "${batchKey}": processing ${images.length} image(s) for ${waiters.length} waiter(s)`);

      try {
        const results = await aistudio.generateStoryboard(baseDir, images, batchOpts);
        waiters.forEach((w, idx) => w.resolve({ results, isPrimary: idx === 0 }));
      } catch (err) {
        waiters.forEach(w => w.reject(err));
      }
    }, BATCH_WAIT_MS);

    // Wait for batch to complete
    const { results, isPrimary } = await resultPromise;
    res.json({ success: true, results, isPrimary });

  } catch (error) {
    console.error('[Storyboard] Error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  } finally {
    imagePathsToClean.forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// Playwright Web UI Automation Route
// ═══════════════════════════════════════════════════════════════

const automationBatches = new Map();
const AUTOMATION_BATCH_WAIT_MS = 5000;

router.post('/automate-storyboard', upload.array('images', 10), async (req, res) => {
  const files = req.files;
  const body = req.body || {};
  let imagePathsToClean = [];

  try {
    const { base64Images, fileNames, chatId } = body;
    const targetChatId = chatId || process.env.DEFAULT_TELEGRAM_CHAT_ID || '8724472821';
    let filePayloads = [];

    // Handle physical file uploads
    if (files && files.length > 0) {
      files.forEach((f, idx) => {
        const fPath = path.join(baseDir, f.path);
        imagePathsToClean.push(fPath);
        const name = (fileNames && fileNames[idx]) ? fileNames[idx] : (f.originalname || 'upload.png');
        filePayloads.push({ name, mimeType: f.mimetype, buffer: fs.readFileSync(fPath) });
      });
    }

    // Handle base64 string uploads
    if (base64Images) {
      const b64Array = Array.isArray(base64Images) ? base64Images : [base64Images];
      b64Array.forEach((b64, idx) => {
        const name = (fileNames && fileNames[idx]) ? fileNames[idx] : `image_${idx}.png`;
        filePayloads.push({ name, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
      });
    }

    if (filePayloads.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one image is required' });
    }

    // ── Batching logic ───────────────────────────────────────
    console.log(`[API] Automate batch "${targetChatId}": +${filePayloads.length} image(s)`);

    if (!automationBatches.has(targetChatId)) {
      automationBatches.set(targetChatId, {
        images: [],
        timer: null
      });
    }

    const batch = automationBatches.get(targetChatId);
    batch.images.push(...filePayloads);

    // Reset the batch timer (extend window on each new image)
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(async () => {
      const { images } = batch;
      automationBatches.delete(targetChatId);

      console.log(`[API] Automate batch "${targetChatId}": trigger Playwright automation with ${images.length} image(s)...`);
      
      // Asynchronously trigger Playwright automation in the background
      const { runStoryboardAutomation } = require('../services/automation');
      runStoryboardAutomation(targetChatId, images, baseDir).catch(err => {
        console.error(`[API] Background automation error for ${targetChatId}:`, err.message);
      });
    }, AUTOMATION_BATCH_WAIT_MS);

    // Return immediately to n8n to avoid timeouts
    res.json({ success: true, message: 'Automation triggered' });

  } catch (error) {
    console.error('[Automate API] Error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  } finally {
    imagePathsToClean.forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// TikTok API Routes
// ═══════════════════════════════════════════════════════════════

// GET /api/tiktok/auth — Get OAuth authorization URL (JSON)
router.get('/tiktok/auth', (req, res) => {
    const state = req.query.state || `state_${Date.now()}`;
    const authUrl = tiktok.getAuthUrl(state);
    console.log(`[TikTok] Auth URL generated for state: ${state}`);
    res.json({ success: true, authUrl, state });
});

// GET /api/tiktok/login — Redirect directly to TikTok (For Telegram buttons)
router.get('/tiktok/login', (req, res) => {
    const state = req.query.state || `state_${Date.now()}`;
    const authUrl = tiktok.getAuthUrl(state);
    res.redirect(authUrl);
});

// POST /api/tiktok/callback — Exchange auth code for tokens
router.post('/tiktok/callback', async (req, res) => {
    try {
        const { code, state } = req.body;
        if (!code) {
            return res.status(400).json({ success: false, error: 'Authorization code is required' });
        }
        const tokenData = await tiktok.exchangeCodeForToken(code, state);
        res.json({ success: true, ...tokenData });
    } catch (error) {
        console.error('[TikTok] Callback error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/tiktok/upload — Upload video to TikTok
router.post('/tiktok/upload', async (req, res) => {
    try {
        // Can accept either open_id OR telegram_id (state)
        const { open_id, telegram_id, base64Video, title, privacyLevel } = req.body;
        const lookupId = open_id || telegram_id;

        if (!lookupId || !base64Video) {
            return res.status(400).json({ success: false, error: 'open_id (or telegram_id) and base64Video are required' });
        }

        const accessToken = await tiktok.getValidToken(lookupId);
        const result = await tiktok.uploadVideoBase64(accessToken, base64Video, {
            title: title || 'AI Fashion Video ✨ #fashion #ai #tryon',
            privacyLevel: privacyLevel || 'SELF_ONLY',
        });

        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[TikTok] Upload error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/tiktok/user — Get authenticated user info
router.get('/tiktok/user', async (req, res) => {
    try {
        const { open_id } = req.query;
        if (!open_id) {
            return res.status(400).json({ success: false, error: 'open_id is required' });
        }
        const accessToken = await tiktok.getValidToken(open_id);
        const userInfo = await tiktok.getUserInfo(accessToken);
        res.json({ success: true, user: userInfo });
    } catch (error) {
        console.error('[TikTok] User info error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/tiktok/tokens — Debug: list stored tokens
router.get('/tiktok/tokens', (req, res) => {
    const store = tiktok.getTokenStore();
    const sanitized = Object.entries(store).map(([id, t]) => ({
        open_id: id,
        expires_at: new Date(t.expires_at).toISOString(),
        is_valid: Date.now() < t.expires_at,
    }));
    res.json({ success: true, tokens: sanitized });
});
// ═══════════════════════════════════════════════════════════════
// Utility Routes
// ═══════════════════════════════════════════════════════════════

// GET /api/export-cookies — Export current browser session cookies to file
router.get('/export-cookies', async (req, res) => {
    try {
        const context = require('../utils/state').getContext?.() || require('../services/browser').getContext();
        if (!context) {
            return res.status(400).json({ success: false, error: 'No browser context running. Start a generation first.' });
        }

        const allCookies = await context.cookies(['https://labs.google']);
        const relevantCookies = allCookies.map(c => {
            const cookie = {
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                expires: c.expires,
                httpOnly: c.httpOnly,
                secure: c.secure,
            };
            if (c.sameSite && c.sameSite !== 'None') {
                cookie.sameSite = c.sameSite;
            }
            return cookie;
        });

        const cookiesPath = path.join(baseDir, 'labs.google.cookies.json');

        // Backup old cookies
        if (fs.existsSync(cookiesPath)) {
            const backupPath = cookiesPath.replace('.json', `.backup-${Date.now()}.json`);
            fs.copyFileSync(cookiesPath, backupPath);
            console.log(`[Cookies] Backed up old cookies to ${path.basename(backupPath)}`);
        }

        fs.writeFileSync(cookiesPath, JSON.stringify(relevantCookies, null, 2));

        const sessionCookie = relevantCookies.find(c => c.name === '__Secure-next-auth.session-token');
        const expiresAt = sessionCookie ? new Date(sessionCookie.expires * 1000).toISOString() : null;

        console.log(`[Cookies] ✅ Exported ${relevantCookies.length} cookies`);
        res.json({
            success: true,
            cookieCount: relevantCookies.length,
            sessionExpires: expiresAt,
            emails: relevantCookies.filter(c => c.name.toLowerCase().includes('email')).map(c => ({ name: c.name, value: decodeURIComponent(c.value) }))
        });
    } catch (error) {
        console.error('[Cookies] Export error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

async function sendVideoToTelegramDirect(chatId, videoBase64, panelIndex, panelName) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.log('[Telegram] ⚠️ TELEGRAM_BOT_TOKEN is not configured in .env');
    return false;
  }

  const pName = panelName || `Panel ${panelIndex || 1}`;

  try {
    // Step 1: Crop & Resize video locally using our service
    console.log(`[Telegram] Resizing ${pName} before sending...`);
    const resizedBase64 = await processVideoBase64(videoBase64, {
      cropPercent: 0.04,
      aspectRatio: '9:16'
    });

    // Step 2: Send status message
    console.log(`[Telegram] Sending status update to chat ${chatId}...`);
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🎬 ${pName} đã resize xong!\n📤 Đang gửi video về Telegram...`
      })
    });

    // Step 3: Send video file
    console.log(`[Telegram] Uploading video to chat ${chatId}...`);
    const videoBuffer = Buffer.from(resizedBase64, 'base64');
    const blob = new Blob([videoBuffer], { type: 'video/mp4' });
    
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('video', blob, `${pName.toLowerCase().replace(/\s+/g, '_')}_resized.mp4`);
    formData.append('caption', `✅ ${pName} đã sẵn sàng!`);

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendVideo`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Telegram API returned HTTP ${response.status}: ${errText}`);
    }

    console.log(`[Telegram] ✅ Successfully sent ${pName} to Telegram.`);
    return true;
  } catch (error) {
    console.error(`[Telegram] ❌ Failed to send ${pName} to Telegram:`, error.message);
    // Attempt to notify user of failure
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `⚠️ Lỗi gửi ${pName} về Telegram: ${error.message}`
        })
      });
    } catch (_) {}
    return false;
  }
}

module.exports = router;
