'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const axios = require('axios');
const https = require('https');
const { startProxyBridge } = require('./services/proxy-bridge');

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

async function testGenerate() {
  await startProxyBridge(8888);

  const templatePath = path.resolve(__dirname, 'asset/template.png');
  const promptTemplatePath = path.resolve(__dirname, 'asset/prompt.md');
  const heroPath = path.resolve(__dirname, 'downloads/7277168939/1_D2A76D21030C4A5D93561872F8D2EE83.jpeg');
  const altPath = path.resolve(__dirname, 'downloads/7277168939/2_20503D73DCC64845B12884616E8C631E.jpeg');

  // Chuẩn bị prompt với kích thước
  let promptText = fs.readFileSync(promptTemplatePath, 'utf8');
  promptText = promptText
    .replace('[WIDTH]', '16')
    .replace('[DEPTH]', '18')
    .replace('[HEIGHT]', '27');

  console.log('📝 Prepared Prompt:\n', promptText.slice(0, 350), '...\n');

  console.log('Connecting to Chrome CDP...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  let page = context.pages().find(p => p.url().includes('flow.google.com')) || context.pages()[0];

  console.log('Current page:', page.url());

  // 1. Cấu hình chế độ Hình ảnh 9:16
  const settingsBtn = page.locator('.settings-trigger-button').first();
  const settingsText = await settingsBtn.innerText().catch(() => '');
  if (!settingsText.includes('Hình ảnh') || !settingsText.includes('9:16')) {
    console.log('Switching to Image 9:16...');
    await settingsBtn.click({ force: true });
    await page.waitForTimeout(600);

    const imgBtn = page.locator('.cdk-overlay-pane button', { hasText: /Hình ảnh/i }).first();
    if (await imgBtn.isVisible()) {
      await imgBtn.click({ force: true });
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

  // 2. Upload template.png và 2 ảnh sản phẩm
  console.log('Uploading reference images: Image 1 (template), Image 2 (hero), Image 3 (alt)...');
  const addBtn = page.locator('button[aria-label="Thêm thành phần vào ô nhập câu lệnh"]').first();
  await addBtn.click();
  await page.waitForTimeout(600);

  const uploadBtn = page.locator('.cdk-overlay-pane button', { hasText: /Tải nội dung nghe nhìn lên/i }).first();
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    uploadBtn.click()
  ]);

  await fileChooser.setFiles([templatePath, heroPath, altPath]);
  console.log('Files selected, waiting 4s for upload to attach...');
  await page.waitForTimeout(4000);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // 3. Nhập prompt
  console.log('Typing prompt...');
  const editor = page.locator('.ProseMirror').first();
  await editor.click({ force: true });
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(promptText);
  await page.waitForTimeout(600);

  // 4. Lắng nghe phản hồi ogiZ0b
  let fullImageUrl = null;
  const responsePromise = new Promise((resolve) => {
    const handler = async (res) => {
      const u = res.url();
      if (u.includes('batchexecute') && (u.includes('ogiZ0b') || u.includes('rpcids='))) {
        try {
          const text = await res.text();
          const parsed = parseBatchExecute(text, 'ogiZ0b');
          if (parsed) {
            function findUrl(node) {
              if (!node || fullImageUrl) return;
              if (typeof node === 'string' && (node.startsWith('https://flow-content.google/image/') || node.startsWith('https://storage.googleapis.com'))) {
                fullImageUrl = node;
                return;
              }
              if (Array.isArray(node)) {
                for (const el of node) findUrl(el);
              } else if (typeof node === 'object') {
                for (const k of Object.keys(node)) findUrl(node[k]);
              }
            }
            findUrl(parsed);
            if (fullImageUrl) {
              page.off('response', handler);
              resolve(fullImageUrl);
            }
          }
        } catch (_) {}
      }
    };
    page.on('response', handler);
    setTimeout(() => resolve(null), 60000);
  });

  console.log('Submitting prompt to Nano Banana Pro...');
  const submitBtn = page.locator('button[aria-label="Bắt đầu tạo"], button:has-text("arrow_forward")').last();
  await submitBtn.click({ force: true });

  console.log('Rendering master panel...');
  fullImageUrl = await responsePromise;

  if (fullImageUrl) {
    console.log('✅ Found full image URL:', fullImageUrl);
    const dlRes = await axios.get(fullImageUrl, {
      responseType: 'arraybuffer',
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 30000
    });
    const savePath = path.resolve(__dirname, 'outputs/7277168939/master_panel_9_16.png');
    fs.writeFileSync(savePath, Buffer.from(dlRes.data));
    console.log(`🎉 SAVED MASTER PANEL (${(dlRes.data.length / 1024).toFixed(1)} KB): ${savePath}`);
  } else {
    console.log('No URL captured via ogiZ0b within 60s, checking page...');
  }
}

testGenerate().catch(console.error);
