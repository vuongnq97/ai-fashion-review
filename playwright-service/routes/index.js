const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const state = require('../utils/state');
const { getBrowserPage } = require('../services/browser');
const { automateGeneration } = require('../services/image');
const { automateVideoGeneration } = require('../services/video');
const tiktok = require('../services/tiktok');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });
const baseDir = path.resolve(__dirname, '..');

router.post('/generate', upload.array('images', 5), async (req, res) => {
  if (state.getIsProcessing()) {
    return res.status(429).json({ success: false, error: 'Server is busy processing another request.' });
  }
  state.setIsProcessing(true);
  let imagePathsToClean = [];
  try {
    const body = req.body || {};
    console.log(JSON.stringify(req.body).substring(0, 500));
    console.log(`[API] Raw body fileNames:`, body.fileNames);
    const { prompt, base64Images, mode, imageModel, aspectRatio, outputCount, imageSelection, fileNames } = body;
    const files = req.files;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    let filePayloads = [];

    // Handle physical file uploads
    if (files && files.length > 0) {
      files.forEach((f, idx) => {
        const fPath = path.join(baseDir, f.path);
        imagePathsToClean.push(fPath);
        const name = (fileNames && fileNames[idx]) ? fileNames[idx] : (f.originalname || 'upload.png');
        filePayloads.push({
          name: name,
          mimeType: f.mimetype,
          buffer: fs.readFileSync(fPath)
        });
      });
    }

    // Handle base64 string uploads
    if (base64Images) {
      const b64Array = Array.isArray(base64Images) ? base64Images : [base64Images];
      b64Array.forEach((b64, idx) => {
        const name = (fileNames && fileNames[idx]) ? fileNames[idx] : `b64_${idx}.png`;
        filePayloads.push({
          name: name,
          mimeType: 'image/png',
          buffer: Buffer.from(b64, 'base64')
        });
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
    console.log(`[API] body keys:`, Object.keys(body));

    const page = await getBrowserPage(baseDir);
    const result = await automateGeneration(page, prompt, filePayloads, config, baseDir);

    res.json({
      success: true,
      image: result
    });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    state.setIsProcessing(false);
    imagePathsToClean.forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { }
    });
  }
});

router.post('/generate-video', upload.array('images', 5), async (req, res) => {
  if (state.getIsProcessing()) {
    return res.status(429).json({ success: false, error: 'Server is busy processing another request.' });
  }
  state.setIsProcessing(true);
  let imagePathsToClean = [];
  try {
    const body = req.body || {};
    const { prompt, extendPrompt, base64Images, outputCount, imageSelection, fileNames, aspectRatio, videoModelKey } = body;
    const files = req.files;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    let filePayloads = [];

    if (files && files.length > 0) {
      files.forEach((f, idx) => {
        const fPath = path.join(baseDir, f.path);
        imagePathsToClean.push(fPath);
        const name = (fileNames && fileNames[idx]) ? fileNames[idx] : (f.originalname || 'upload.png');
        filePayloads.push({
          name: name,
          mimeType: f.mimetype,
          buffer: fs.readFileSync(fPath)
        });
      });
    }

    if (base64Images) {
      const b64Array = Array.isArray(base64Images) ? base64Images : [base64Images];
      b64Array.forEach((b64, idx) => {
        const name = (fileNames && fileNames[idx]) ? fileNames[idx] : `b64_${idx}.png`;
        filePayloads.push({
          name: name,
          mimeType: 'image/png',
          buffer: Buffer.from(b64, 'base64')
        });
      });
    }

    console.log(`[VideoGen] Received request: prompt="${prompt.substring(0, 60)}...", files=${filePayloads.length}, imageSelection=${JSON.stringify(imageSelection)}`);

    const page = await getBrowserPage(baseDir);
    const config = { imageSelection, aspectRatio: aspectRatio || '9:16', videoModelKey: videoModelKey || null };
    
    const resultBase64 = await automateVideoGeneration(page, prompt, extendPrompt, filePayloads, config, baseDir);

    if (resultBase64) {
      res.json({ success: true, video: { base64: resultBase64, mimeType: 'video/mp4' } });
    } else {
      res.status(500).json({ success: false, error: 'Could not extract generated video' });
    }

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    state.setIsProcessing(false);
    imagePathsToClean.forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { }
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

module.exports = router;
