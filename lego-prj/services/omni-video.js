'use strict';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');
const { chromium } = require('playwright');
const { startProxyBridge } = require('./proxy-bridge');

/**
 * Xây dựng prompt chuyển động xoay 360 độ trong 10 giây cho model Omni Video
 * 
 * @param {string} productName - Tên mô hình LEGO
 * @returns {string} Motion prompt chuyên sâu
 */
function buildOmni360MotionPrompt(productName) {
  return `A seamless continuous 360-degree clockwise turntable rotation of the LEGO ${productName} model.
The motorized round display base rotates steadily at a smooth, constant speed, performing exactly one full 360-degree rotation across the duration.
The camera remains perfectly stable on a studio tripod, maintaining razor-sharp focus on the rotating LEGO model.
Studio highlights and soft reflections glide realistically across the glossy plastic studs, surfaces, and edges of the LEGO bricks as each side turns to face the light.
All moving elements, articulation points, and structural parts maintain rock-solid geometry with zero morphing or distortion.
The warm ambient background showroom shelves filled with other blurred collectible LEGO sets stay consistently out-of-focus with soft, creamy bokeh.
Cinematic commercial product video, smooth 60fps feel, hyper-consistent structure. Silent video, no audio.`;
}

/**
 * Sinh video 10s xoay 360 độ từ Panel 9:16 bằng model Omni Video trên Google Flow Ultra
 * 
 * @param {object} params
 * @param {string} params.panelImagePath - Đường dẫn file ảnh 9:16 Master Panel
 * @param {string} params.productName - Tên sản phẩm
 * @param {string} params.outputDir - Thư mục lưu video đầu ra
 * @returns {Promise<{videoPath: string, prompt: string}>}
 */
async function generateOmni360Video({ panelImagePath, productName, outputDir }) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const prompt = buildOmni360MotionPrompt(productName);
  console.log('\n[OmniVideo] 🎬 Đã tạo Motion Prompt 360° cho Omni Video:');
  console.log(prompt);

  const outputVideoPath = path.join(outputDir, 'video_360_10s.mp4');

  // Đảm bảo Local Proxy Bridge đang chạy cho Google Chrome
  await startProxyBridge(8888);

  console.log('[OmniVideo] 🌐 Đang kết nối tới Google Chrome CDP (port 9222)...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  let page = context.pages().find(p => p.url().includes('flow.google.com'));

  if (!page) {
    page = context.pages()[0];
    await page.goto('https://flow.google.com/project/8ac10c4a-44b5-4d55-b470-10ab24db4c1c', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
  }

  // Nếu đang ở trang chi tiết edit cũ, quay về project chính
  if (page.url().includes('/edit/')) {
    const backBtn = page.locator('button[aria-label*="quay lại" i], button:has-text("arrow_back")').first();
    if (await backBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await backBtn.click({ force: true });
      await page.waitForTimeout(1000);
    } else {
      await page.goto('https://flow.google.com/project/8ac10c4a-44b5-4d55-b470-10ab24db4c1c', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
    }
  }

  console.log('[OmniVideo] ⏳ Chờ giao diện Flow sẵn sàng...');
  await page.waitForSelector('.settings-trigger-button, .ProseMirror', { timeout: 30000 });
  await page.waitForTimeout(1000);

  // 1. Cấu hình chế độ: Video · 9:16 · 10s (hoặc 8s)
  console.log('[OmniVideo] ⚙️ Thiết lập chế độ: Video · 9:16 · Omni Flash...');
  const settingsBtn = page.locator('.settings-trigger-button').first();
  const currentSettingsText = await settingsBtn.innerText().catch(() => '');

  if (!currentSettingsText.includes('Video') || !currentSettingsText.includes('9:16')) {
    await settingsBtn.click({ force: true });
    await page.waitForSelector('.cdk-overlay-pane', { timeout: 10000 });
    await page.waitForTimeout(500);

    const vidRadio = page.locator('.cdk-overlay-pane button', { hasText: /Video/i }).first();
    if (await vidRadio.isVisible()) {
      await vidRadio.click({ force: true });
      await page.waitForTimeout(400);
    }

    const ratio916 = page.locator('.cdk-overlay-pane button', { hasText: /9:16/i }).first();
    if (await ratio916.isVisible()) {
      await ratio916.click({ force: true });
      await page.waitForTimeout(300);
    }

    const durBtn = page.locator('.cdk-overlay-pane button', { hasText: /10 giây|8 giây/i }).first();
    if (await durBtn.isVisible()) {
      console.log(`[OmniVideo] ⏱️ Chọn độ dài: ${await durBtn.innerText()}`);
      await durBtn.click({ force: true });
      await page.waitForTimeout(300);
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  } else {
    console.log(`[OmniVideo] ℹ️ Đã ở chế độ: ${currentSettingsText.replace(/\n/g, ' ')}, sẵn sàng tiếp tục.`);
  }

  // 2. Gắn ảnh Master Panel làm Khung hình Bắt đầu (Start Frame)
  console.log('[OmniVideo] 🖼️ Gắn ảnh Master Panel vào composer...');
  const addBtn = page.locator('button[aria-label="Thêm thành phần vào ô nhập câu lệnh"]').first();
  const startChip = page.locator('button, div, [class*="chip"]').filter({ hasText: /^Bắt đầu$/i }).first();

  if (await addBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await addBtn.click();
    await page.waitForTimeout(600);

    const uploadBtn = page.locator('.cdk-overlay-pane button', { hasText: /Tải nội dung nghe nhìn lên/i }).first();
    if (await uploadBtn.isVisible({ timeout: 2000 }).catch(() => false) && fs.existsSync(panelImagePath)) {
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 10000 }),
        uploadBtn.click()
      ]);
      await fileChooser.setFiles(panelImagePath);
      console.log(`[OmniVideo] 📤 Đã upload Master Panel: ${panelImagePath}`);
      await page.waitForTimeout(3000);
    } else {
      const firstOption = page.locator('.cdk-overlay-pane [role="option"]').first();
      if (await firstOption.isVisible()) {
        await firstOption.click();
        await page.waitForTimeout(800);
      }
    }
  } else if (await startChip.isVisible({ timeout: 2000 }).catch(() => false)) {
    await startChip.click();
    await page.waitForTimeout(800);
    const firstOption = page.locator('.cdk-overlay-pane [role="option"], .cdk-overlay-pane button:has(img)').first();
    if (await firstOption.isVisible()) {
      await firstOption.click();
      await page.waitForTimeout(800);
    }
  }

  // Đảm bảo đóng menu overlay hoặc backdrop còn sót lại
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  // 3. Nhập Motion Prompt
  console.log('[OmniVideo] ✍️ Nhập 360° Motion Prompt vào composer...');
  const editor = page.locator('.ProseMirror').first();
  await editor.click({ force: true });
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(prompt);
  await page.waitForTimeout(600);

  // 4. Kích hoạt Render Video
  console.log('[OmniVideo] 🚀 Bắt đầu quá trình tạo Video 360°...');
  const submitBtn = page.locator('button[aria-label="Bắt đầu tạo"], button:has-text("arrow_forward")').last();
  await submitBtn.click({ force: true });

  console.log('[OmniVideo] ⏳ Đang theo dõi tiến trình render video từ Omni model...');
  let completed = false;

  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(3000);
    const progressInfo = await page.evaluate(() => {
      const text = document.body.innerText;
      const m = text.match(/(\d+)%\s+A seamless continuous 360/);
      const isFin = text.includes('A seamless continuous 360') && !m;
      return {
        percent: m ? `${m[1]}%` : (isFin ? '100% (Hoàn thành)' : 'Đang xử lý...'),
        isFin
      };
    });

    console.log(`   [Render ${i * 3}s] Tiến độ: ${progressInfo.percent}`);

    if (progressInfo.isFin || progressInfo.percent.includes('100')) {
      completed = true;
      break;
    }
  }

  console.log('[OmniVideo] 🎉 Video đã render xong! Đang mở xem chi tiết để tải file gốc...');
  await page.waitForTimeout(2000);

  // 5. Mở chi tiết video và tải video MP4 720p gốc
  const openTile = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button, div, a, img.thumbnail'));
    for (const el of els) {
      if (el.innerText && el.innerText.includes('A seamless continuous 360') && (el.className.includes('container') || el.className.includes('tile') || el.tagName === 'BUTTON')) {
        el.click();
        return true;
      }
    }
    const firstThumb = document.querySelector('img.thumbnail');
    if (firstThumb) {
      firstThumb.click();
      return true;
    }
    return false;
  });

  await page.waitForTimeout(2000);

  // Lắng nghe stream tải video từ network
  let videoBuffer = null;
  const videoBufferPromise = new Promise((resolve) => {
    const handler = async (res) => {
      const url = res.url();
      if (url.includes('flow-content.google/video/') && res.status() === 200) {
        try {
          const buf = await res.body();
          if (buf && buf.length > 50000) {
            page.off('response', handler);
            resolve(buf);
          }
        } catch (_) {}
      }
    };
    page.on('response', handler);
    setTimeout(() => resolve(null), 30000);
  });

  const downloadEventPromise = page.waitForEvent('download', { timeout: 25000 }).catch(() => null);

  console.log('[OmniVideo] 📥 Kích hoạt tải video 720p Kích thước gốc...');
  const downloadBtn = page.locator('button[aria-label="Tải nội dung nghe nhìn xuống"], button:has-text("download")').first();
  if (await downloadBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await downloadBtn.click({ force: true });
    await page.waitForTimeout(600);

    const option720p = page.locator('.mat-mdc-menu-panel button', { hasText: /720p/i }).first();
    if (await option720p.isVisible({ timeout: 3000 }).catch(() => false)) {
      await option720p.click({ force: true });
    }
  }

  const nativeDownload = await downloadEventPromise;
  if (nativeDownload) {
    try {
      await nativeDownload.saveAs(outputVideoPath);
      console.log(`[OmniVideo] 💾 Đã lưu video qua trình tải native của trình duyệt: ${outputVideoPath}`);
    } catch (_) {}
  }

  videoBuffer = await videoBufferPromise;

  // Fallback: Tìm thẻ video trên DOM và fetch qua browser session
  if (!videoBuffer) {
    console.log('[OmniVideo] ℹ️ Đang tìm video URL trực tiếp từ DOM...');
    const videoUrl = await page.evaluate(() => {
      const vid = document.querySelector('video');
      if (vid && vid.src && vid.src.includes('flow-content.google')) return vid.src;
      const src = document.querySelector('video source');
      return src ? src.src : null;
    });

    if (videoUrl) {
      console.log(`[OmniVideo] 📥 Đang tải video từ URL DOM: ${videoUrl.slice(0, 80)}...`);
      try {
        const base64 = await page.evaluate(async (url) => {
          const res = await fetch(url);
          const blob = await res.blob();
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
        }, videoUrl);
        videoBuffer = Buffer.from(base64.split(',')[1], 'base64');
      } catch (e) {
        console.warn('[OmniVideo] Fallback fetch error:', e.message);
      }
    }
  }

  if (videoBuffer && videoBuffer.length > 50000) {
    fs.writeFileSync(outputVideoPath, videoBuffer);
    console.log(`[OmniVideo] ✅ ĐÃ LƯU VIDEO 360° THÀNH CÔNG: ${outputVideoPath} (${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
    return { prompt, videoPath: outputVideoPath, buffer: videoBuffer };
  } else {
    // Nếu buffer không bắt được qua click, kiểm tra xem có video đã tải trong outputs không
    if (fs.existsSync(outputVideoPath) && fs.statSync(outputVideoPath).size > 50000) {
      return { prompt, videoPath: outputVideoPath };
    }
    throw new Error('Không thể tải file video MP4 từ Flow');
  }
}

module.exports = {
  buildOmni360MotionPrompt,
  generateOmni360Video
};
