'use strict';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');
const { chromium } = require('playwright');
const { startProxyBridge } = require('./proxy-bridge');

/**
 * Xây dựng prompt Master Frame từ file template prompt.md và thông số kích thước thực
 * 
 * @param {object} analysis - Dữ liệu phân tích từ Gemini Vision
 * @param {string} productName - Tên sản phẩm LEGO
 * @returns {{promptText: string, width: number, depth: number, height: number}}
 */
function buildMasterPanelPrompt(analysis, productName) {
  const promptTemplatePath = path.resolve(__dirname, '../asset/prompt.md');
  if (!fs.existsSync(promptTemplatePath)) {
    throw new Error(`Không tìm thấy file prompt template: ${promptTemplatePath}`);
  }

  let promptText = fs.readFileSync(promptTemplatePath, 'utf8');

  const dims = analysis?.dimensions || {};
  const height = dims.height_cm || 27;
  const width = dims.width_cm || Math.round(height * 0.6);
  const depth = dims.length_cm || dims.depth_cm || Math.round(height * 0.65);

  promptText = promptText
    .replace(/\[WIDTH\]/g, String(width))
    .replace(/\[DEPTH\]/g, String(depth))
    .replace(/\[HEIGHT\]/g, String(height));

  return { promptText, width, depth, height };
}

function parseBatchExecute(rawText, rpcId = 'ogiZ0b') {
  if (!rawText || typeof rawText !== 'string') return null;
  const cleaned = rawText.replace(/^\)\]\}'\s*/, '').trim();
  const lines = cleaned.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (Array.isArray(item) && item[1] === rpcId && typeof item[2] === 'string') {
            return JSON.parse(item[2]);
          }
        }
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Tạo ảnh Master Panel 9:16 bằng Nano Banana Pro trên Google Flow Ultra
 * Sử dụng asset/template.png làm background (Image 1) và các góc ảnh sản phẩm (Images 2-3)
 * 
 * @param {object} params
 * @param {object} params.analysis - Kết quả từ image-analyzer
 * @param {string} params.productName - Tên sản phẩm LEGO
 * @param {string} params.outputDir - Thư mục lưu kết quả
 * @returns {Promise<{prompt: string, imagePath: string, buffer: Buffer}>}
 */
async function generatePanel9x16({ analysis, productName, outputDir }) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const templateImgPath = path.resolve(__dirname, '../asset/template.png');
  if (!fs.existsSync(templateImgPath)) {
    throw new Error(`Không tìm thấy file template background: ${templateImgPath}`);
  }

  // Lấy các ảnh tham chiếu sản phẩm từ analysis
  const heroPath = analysis?.selectedAngles?.heroAngle?.fullPath;
  const altPath = analysis?.selectedAngles?.altAngle?.fullPath || analysis?.selectedAngles?.featureAngle?.fullPath;

  if (!heroPath || !fs.existsSync(heroPath)) {
    throw new Error(`Ảnh chính (hero angle) không tồn tại: ${heroPath}`);
  }

  const uploadFiles = [templateImgPath, heroPath];
  if (altPath && fs.existsSync(altPath)) {
    uploadFiles.push(altPath);
  }

  const { promptText, width, depth, height } = buildMasterPanelPrompt(analysis, productName);
  console.log('\n[PanelGenerator] 🎨 Đã tạo Master Prompt từ asset/prompt.md:');
  console.log(`   - Kích thước áp dụng: Cao ${height}cm x Rộng ${width}cm x Sâu ${depth}cm`);
  console.log(`   - Image 1 (Template): ${templateImgPath}`);
  console.log(`   - Image 2 (Hero): ${heroPath}`);
  if (uploadFiles[2]) console.log(`   - Image 3 (Alt): ${uploadFiles[2]}`);

  // Đảm bảo Local Proxy Bridge đang chạy cho Google Chrome
  await startProxyBridge(8888);

  const outputImagePath = path.join(outputDir, 'master_panel_9_16.png');

  console.log('[PanelGenerator] 🌐 Đang kết nối tới Google Chrome CDP (port 9222)...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  let page = context.pages().find(p => p.url().includes('flow.google.com')) || context.pages()[0];

  if (!page) {
    page = context.pages()[0];
    await page.goto('https://flow.google.com/project/8ac10c4a-44b5-4d55-b470-10ab24db4c1c', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
  }

  // Đảm bảo không ở trang Detail edit cũ, quay về trang project chính
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

  console.log('[PanelGenerator] ⏳ Đang chờ giao diện Flow sẵn sàng...');
  await page.waitForSelector('.settings-trigger-button, .ProseMirror', { timeout: 30000 });
  await page.waitForTimeout(1000);

  // 1. Cấu hình settings: Hình ảnh, 9:16, x1 (Nano Banana Pro)
  console.log('[PanelGenerator] ⚙️ Thiết lập chế độ: Hình ảnh · 9:16 · Nano Banana Pro...');
  const settingsBtn = page.locator('.settings-trigger-button').first();
  const currentSettingsText = await settingsBtn.innerText().catch(() => '');

  if (!currentSettingsText.includes('Hình ảnh') || !currentSettingsText.includes('9:16')) {
    await settingsBtn.click({ force: true });
    await page.waitForTimeout(600);

    const imgRadio = page.locator('.cdk-overlay-pane button', { hasText: /Hình ảnh/i }).first();
    if (await imgRadio.isVisible()) {
      await imgRadio.click({ force: true });
      await page.waitForTimeout(400);
    }

    const ratio916 = page.locator('.cdk-overlay-pane button', { hasText: /9:16/i }).first();
    if (await ratio916.isVisible()) {
      await ratio916.click({ force: true });
      await page.waitForTimeout(300);
    }

    const x1Btn = page.locator('.cdk-overlay-pane button', { hasText: /^x1$/i }).first();
    if (await x1Btn.isVisible()) {
      await x1Btn.click({ force: true });
      await page.waitForTimeout(300);
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  // 2. Upload các ảnh tham chiếu (Image 1: Template, Images 2-3: Product)
  console.log(`[PanelGenerator] 📤 Đang tải lên ${uploadFiles.length} ảnh tham chiếu vào composer...`);
  const addBtn = page.locator('button[aria-label="Thêm thành phần vào ô nhập câu lệnh"]').first();
  await addBtn.click({ force: true });
  await page.waitForTimeout(600);

  const uploadBtn = page.locator('.cdk-overlay-pane button', { hasText: /Tải nội dung nghe nhìn lên/i }).first();
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    uploadBtn.click()
  ]);

  await fileChooser.setFiles(uploadFiles);
  console.log('[PanelGenerator] ⏳ Đang chờ ảnh upload hoàn tất và gắn chip vào composer...');
  await page.waitForTimeout(4000);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // 3. Nhập Master Prompt
  console.log('[PanelGenerator] ✍️ Nhập Master Prompt vào composer...');
  const editor = page.locator('.ProseMirror').first();
  await editor.click({ force: true });
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(promptText);
  await page.waitForTimeout(600);

  // Ghi nhận các URL ảnh đã có trước khi bấm tạo
  const priorUrls = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('img')).map(i => i.src).filter(s => s.includes('flow-content.google/image'));
  });

  // 4. Kích hoạt tạo ảnh
  console.log('[PanelGenerator] 🚀 Bắt đầu tạo ảnh Nano Banana Pro...');

  const submitBtn = page.locator('button[aria-label="Bắt đầu tạo"], button:has-text("arrow_forward")').last();
  await submitBtn.click({ force: true });

  console.log('[PanelGenerator] ⏳ Đang render Master Panel (Nano Banana Pro)...');

  let imgBuffer = null;
  let fullImageUrl = null;

  // Chờ ảnh mới xuất hiện trên giao diện và tải về bằng URL có Signed query params
  console.log('[PanelGenerator] ⏳ Đang đợi Master Panel hiển thị trên giao diện Flow...');
  for (let attempt = 0; attempt < 35; attempt++) {
    await page.waitForTimeout(2000);
    const result = await page.evaluate(async (priorList) => {
      const imgs = Array.from(document.querySelectorAll('flow-tile img, [data-tile-id] img, img.image, img'))
        .filter(i => i.src && i.src.includes('flow-content.google/image') && i.src.includes('Expires='));
      
      // Tìm ảnh mới (không nằm trong priorList) và có tỷ lệ dọc (naturalHeight > naturalWidth)
      const brandNew = imgs.find(i => {
        const baseSrc = i.src.split('?')[0];
        const isOld = priorList.some(p => p.split('?')[0] === baseSrc);
        return !isOld && i.naturalHeight > i.naturalWidth && i.naturalWidth > 400;
      });

      if (!brandNew) return null;

      try {
        const res = await fetch(brandNew.src);
        if (!res.ok) throw new Error('Fetch status: ' + res.status);
        const blob = await res.blob();
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve({
            dataUrl: reader.result,
            width: brandNew.naturalWidth,
            height: brandNew.naturalHeight,
            src: brandNew.src
          });
          reader.readAsDataURL(blob);
        });
      } catch (err) {
        return { error: err.message, src: brandNew.src };
      }
    }, priorUrls);

    if (result) {
      if (result.dataUrl) {
        imgBuffer = Buffer.from(result.dataUrl.split(',')[1], 'base64');
        fullImageUrl = result.src;
        console.log(`[PanelGenerator] 🎯 Đã nhận và tải thành công Master Panel: ${result.width}x${result.height} (${(imgBuffer.length / 1024).toFixed(1)} KB)`);
        break;
      } else {
        console.warn(`[PanelGenerator] ⚠️ Thử lại tải ảnh DOM: ${result.error}`);
      }
    }
  }

  // Fallback: nếu chưa lấy được qua vòng lặp, lấy ảnh 9:16 mới nhất trên trang
  if (!imgBuffer) {
    console.log('[PanelGenerator] ℹ️ Thử fallback: Lấy ảnh 9:16 mới nhất trên trang...');
    const fallbackResult = await page.evaluate(async () => {
      const imgs = Array.from(document.querySelectorAll('img'))
        .filter(i => i.src && i.src.includes('flow-content.google/image') && i.src.includes('Expires='));
      const target = imgs.find(i => i.naturalHeight > i.naturalWidth && i.naturalWidth > 500);
      if (!target) return null;
      try {
        const res = await fetch(target.src);
        if (!res.ok) return null;
        const blob = await res.blob();
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve({
            dataUrl: reader.result,
            src: target.src,
            width: target.naturalWidth,
            height: target.naturalHeight
          });
          reader.readAsDataURL(blob);
        });
      } catch (_) {
        return null;
      }
    });

    if (fallbackResult && fallbackResult.dataUrl) {
      imgBuffer = Buffer.from(fallbackResult.dataUrl.split(',')[1], 'base64');
      fullImageUrl = fallbackResult.src;
      console.log(`[PanelGenerator] 🎯 Đã tải thành công Master Panel qua fallback: ${fallbackResult.width}x${fallbackResult.height} (${(imgBuffer.length / 1024).toFixed(1)} KB)`);
    }
  }

  if (imgBuffer && imgBuffer.length > 5000) {
    fs.writeFileSync(outputImagePath, imgBuffer);
    console.log(`[PanelGenerator] ✅ ĐÃ LƯU MASTER PANEL 9:16 THÀNH CÔNG: ${outputImagePath} (${(imgBuffer.length / 1024).toFixed(1)} KB)`);
    return { prompt: promptText, imagePath: outputImagePath, buffer: imgBuffer };
  } else {
    throw new Error('Không thể thu thập dữ liệu ảnh từ Nano Banana Pro');
  }
}

module.exports = {
  buildMasterPanelPrompt,
  generatePanel9x16
};
