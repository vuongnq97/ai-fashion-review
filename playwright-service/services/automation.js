const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { getAIStudioPage, getAppFrame, dismissOverlays } = require('./aistudio');
const { getBrowserPage } = require('./browser');

async function runStoryboardAutomation(chatId, filePayloads, baseDir) {
  console.log(`[Automate] Starting AI Studio automation for chatId: ${chatId}`);

  // Create temporary directory to save images for upload
  const tempDir = path.join(baseDir, 'uploads', 'temp-automate', String(chatId));
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const filePaths = [];
  let page = null;
  try {
    // 1. Write the image buffers to temporary files
    for (let i = 0; i < filePayloads.length; i++) {
      const file = filePayloads[i];
      const ext = file.mimeType.includes('png') ? '.png' : '.jpg';
      const filePath = path.join(tempDir, `image_${i}${ext}`);
      fs.writeFileSync(filePath, file.buffer);
      filePaths.push(filePath);
    }

    console.log(`[Automate] Saved ${filePaths.length} temporary files for upload.`);

    // 2. Pre-launch the Google Flow page in background to capture tokens
    console.log('[Automate] Pre-launching Google Flow page in background...');
    await getBrowserPage(baseDir);

    // 3. Get/launch the Google AI Studio page using the persistent context
    console.log('[Automate] Fetching Google AI Studio page...');
    page = await getAIStudioPage(baseDir);

    // Set viewport size for consistent UI layout
    await page.setViewportSize({ width: 1280, height: 800 });

    // Intercept outbound /api/generate-video requests to inject chatId and panel info.
    // This intercepts requests made by the React app inside the iframe too!
    let videoRequestCount = 0;
    await page.route('**/api/generate-video', async (route) => {
      videoRequestCount++;
      const currentPanelIndex = videoRequestCount;
      const request = route.request();
      const postData = request.postDataJSON() || {};
      
      // Inject chatId and panel metadata
      postData.chatId = chatId;
      postData.panelIndex = currentPanelIndex;
      postData.panelName = `Panel ${currentPanelIndex}`;
      
      console.log(`[Playwright Interceptor] Intercepted video request for panel ${currentPanelIndex}. Injecting chatId: ${chatId}`);
      
      await route.continue({
        postData: JSON.stringify(postData)
      });
    });

    // 3. Dismiss any initial auth or warning overlays
    await dismissOverlays(page);

    // 4. Wait for and locate the React Web UI iframe inside the AI Studio page
    console.log('[Automate] Locating storyboard-ai app iframe...');
    let frame = null;
    const searchStartTime = Date.now();
    while (Date.now() - searchStartTime < 30000) {
      try {
        frame = await getAppFrame(page);
        if (frame) {
          const fileInput = await frame.$('input[type="file"]');
          if (fileInput) break;
        }
      } catch (_) {}
      await page.waitForTimeout(1000);
    }

    if (!frame) {
      throw new Error('Could not find AI Studio app iframe or file input inside the iframe after 30s');
    }

    console.log('[Automate] Found iframe. Uploading product images...');

    // 5. Upload files into the iframe's file input
    const fileInput = await frame.$('input[type="file"]');
    await fileInput.setInputFiles(filePaths);
    await page.waitForTimeout(3000); // Give the app frontend time to process and load thumbnails

    // 6. Click "Tạo storyboard & prompt" inside the iframe
    console.log('[Automate] Clicking "Tạo storyboard & prompt" inside iframe...');
    const createBtn = await frame.$('#create-button');
    if (!createBtn) throw new Error('#create-button not found inside app iframe');
    await createBtn.click();

    // 7. Wait for panels to generate (by waiting for the "Tạo Video" buttons to appear inside the iframe)
    console.log('[Automate] Waiting for panels to generate inside iframe...');
    const videoBtnSelector = 'button:has-text("Tạo Video")';
    
    // We poll inside the frame until the buttons appear
    let panelCount = 0;
    const genStartTime = Date.now();
    while (Date.now() - genStartTime < 300000) { // 5 minutes max
      try {
        const count = await frame.locator(videoBtnSelector).count();
        if (count > 0) {
          panelCount = count;
          break;
        }
      } catch (_) {}
      await page.waitForTimeout(2000);
    }

    if (panelCount === 0) {
      throw new Error('Panel generation timed out or failed inside the AI Studio iframe.');
    }

    console.log(`[Automate] Storyboard generated! Found ${panelCount} panel(s). Clicking "Tạo Video" for all...`);

    // 8. Click all "Tạo Video" buttons in sequence dynamically
    for (let i = 0; i < panelCount; i++) {
      console.log(`[Automate] Clicking "Tạo Video" for panel ${i + 1}...`);
      try {
        // Query the first available active 'Tạo Video' button
        const btn = frame.locator(videoBtnSelector).first();
        await btn.waitFor({ state: 'visible', timeout: 15000 });
        await btn.click({ force: true });
        console.log(`[Automate] ✅ Clicked "Tạo Video" for panel ${i + 1}`);
      } catch (clickErr) {
        console.error(`[Automate] ⚠️ Failed to click button for panel ${i + 1}:`, clickErr.message);
      }
      await page.waitForTimeout(2000); // Short pause to let UI trigger request and update state
    }

    // 9. Wait for all video generations to complete (by checking that the loading states are gone inside the iframe)
    console.log('[Automate] Waiting for all video generations to complete inside iframe...');
    const loaderStartTime = Date.now();
    let loadersFinished = false;
    while (Date.now() - loaderStartTime < 600000) { // 10 minutes max
      const hasLoaders = await frame.evaluate(() => {
        const loaders = Array.from(document.querySelectorAll('*')).filter(el => 
          el.textContent && el.textContent.includes('Đang tạo Video...')
        );
        return loaders.length > 0;
      });

      if (!hasLoaders) {
        loadersFinished = true;
        break;
      }
      await page.waitForTimeout(5000); // check every 5 seconds
    }

    if (!loadersFinished) {
      throw new Error('Video generation timed out inside the AI Studio iframe.');
    }

    console.log('[Automate] ✅ All videos generated successfully! Closing page...');
    await page.waitForTimeout(3000);

  } catch (error) {
    console.error('[Automate] ❌ Error in automation flow:', error.message);
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      try {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          chat_id: chatId,
          text: `⚠️ Lỗi tự động tạo storyboard/video: ${error.message}`
        });
      } catch (_) {}
    }
  } finally {
    // Clean up page
    if (page) {
      try {
        await page.close();
      } catch (_) {}
      const aistudio = require('./aistudio');
      // Reset the globalPage pointer in aistudio.js if it was closed
      // This is clean since aistudio exports globalPage, or we can just let it reset on next getAIStudioPage call.
    }

    // Cleanup temporary files
    console.log('[Automate] Cleaning up temporary files...');
    filePaths.forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
    });
    try { if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir); } catch (e) {}
  }
}

module.exports = { runStoryboardAutomation };
