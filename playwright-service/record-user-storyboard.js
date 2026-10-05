const fs = require('fs');
const path = require('path');
const querystring = require('querystring');
const { chromium } = require('playwright');
const { getExtensionArgs } = require('./utils/extension-loader');

const baseDir = __dirname;
const userDataDir = path.join(baseDir, 'chrome-data');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(baseDir, 'storyboard-snaps', `session-${timestamp}`);
fs.mkdirSync(outDir, { recursive: true });

const targetUrl = process.argv[2] || 'https://flow.google.com/project/8ac10c4a-44b5-4d55-b470-10ab24db4c1c';
const cookiesPath = path.join(baseDir, 'labs.google.cookies.json');

// Cleanup singleton locks
try {
  if (fs.existsSync(userDataDir)) {
    for (const f of fs.readdirSync(userDataDir)) {
      if (f.startsWith('Singleton')) {
        try { fs.unlinkSync(path.join(userDataDir, f)); } catch (_) {}
      }
    }
  }
} catch (_) {}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('🎬 GOOGLE FLOW INTERACTIVE STORYBOARD RECORDER & SNAPPER');
console.log('═══════════════════════════════════════════════════════════════════');
console.log(`🎯 URL: ${targetUrl}`);
console.log(`📁 Thư mục lưu snaps: ${outDir}`);
console.log('⏳ Đang mở trình duyệt Google Chrome trên màn hình của bạn...');

(async () => {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    ignoreHTTPSErrors: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
      ...getExtensionArgs(baseDir),
    ]
  });

  if (fs.existsSync(cookiesPath)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
      await context.addCookies(cookies);
      console.log(`✅ Đã nạp ${cookies.length} cookies.`);
    } catch (_) {}
  }

  let snapCount = 0;
  async function takeSnap(page, label = '') {
    snapCount++;
    const snapFile = path.join(outDir, `snap-${String(snapCount).padStart(3, '0')}-${label || 'ui'}.png`);
    try {
      if (page && !page.isClosed()) {
        await page.screenshot({ path: snapFile });
        console.log(`📸 [SNAP #${snapCount}] Đã chụp màn hình: ${path.basename(snapFile)} (${label})`);
      }
    } catch (_) {}
  }

  // Intercept ogiZ0b & other batchexecute RPCs
  context.on('request', async (request) => {
    const url = request.url();
    if (!url.includes('batchexecute')) return;

    const postData = request.postData() || '';
    if (postData.includes('ogiZ0b')) {
      console.log('\n🔥 [DETECTED ogiZ0b Image Generation Request!]');
      try {
        const parsedForm = querystring.parse(postData);
        if (parsedForm['f.req']) {
          const rawReq = JSON.parse(parsedForm['f.req']);
          const innerStr = rawReq[0]?.[0]?.[1];
          if (innerStr) {
            const inner = JSON.parse(innerStr);
            const reqData = {
              timestamp: new Date().toISOString(),
              prompt: inner?.[1]?.[0]?.[0],
              imageInputs: inner?.[1]?.[0]?.[2],
              aspectRatioInt: inner?.[1]?.[0]?.[4],
              fullInner: inner
            };
            fs.writeFileSync(path.join(outDir, `ogiZ0b-request-${Date.now()}.json`), JSON.stringify(reqData, null, 2), 'utf8');
            console.log(`   📝 Prompt: "${(reqData.prompt || '').substring(0, 150)}..."`);
            console.log(`   📐 Aspect Ratio Int: ${reqData.aspectRatioInt}`);
            console.log(`   🖼️ Image Inputs: ${JSON.stringify(reqData.imageInputs)}`);
          }
        }
      } catch (e) {
        console.log(`   ⚠️ Lỗi phân tích ogiZ0b request: ${e.message}`);
      }
    }
  });

  context.on('response', async (response) => {
    const url = response.url();
    if (url.includes('ogiZ0b')) {
      const status = response.status();
      const body = await response.text().catch(() => '');
      console.log(`\n📥 [ogiZ0b Response] Status: ${status} (${body.length} bytes)`);
      fs.writeFileSync(path.join(outDir, `ogiZ0b-response-${Date.now()}.txt`), body, 'utf8');

      // Tìm URLs ảnh trả về
      const matches = [...body.matchAll(/https:(?:\\\/|\/)+flow-content\.google\/image\/[^"\s]+/g)];
      if (matches.length > 0) {
        console.log(`   🎉 Tìm thấy ${matches.length} generated image URLs!`);
        matches.forEach((m, idx) => {
          console.log(`      [${idx + 1}] ${m[0].slice(0, 100)}...`);
        });
      }
    }
  });

  const page = context.pages()[0] || await context.newPage();

  console.log(`🌐 Đang mở: ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('✅ TRÌNH DUYỆT ĐÃ MỞ TRÊN MÀN HÌNH CỦA BẠN!');
  console.log('👉 BẠN HÃY THAO TÁC TRÊN GOOGLE FLOW ĐỂ TẠO 4 STORYBOARD:');
  console.log('   - Chọn mode / settings / aspect ratio.');
  console.log('   - Nhập prompt của bạn.');
  console.log('   - Bấm Generate.');
  console.log('📸 Hệ thống sẽ tự động snap màn hình và bắt toàn bộ request/response.');
  console.log('   Sau khi tạo xong, bạn chỉ cần ĐÓNG CỬA SỔ TRÌNH DUYỆT.');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // Chụp snap ban đầu
  await page.waitForTimeout(2000);
  await takeSnap(page, 'initial-load');

  // Chụp định kỳ mỗi 5s nếu trang thay đổi, hoặc khi có click
  const intervalId = setInterval(async () => {
    if (!page.isClosed()) {
      await takeSnap(page, 'interval');
    }
  }, 6000);

  // Đợi người dùng đóng browser
  await new Promise(resolve => context.on('close', resolve));
  clearInterval(intervalId);

  console.log('\n🏁 Trình duyệt đã đóng.');
  console.log(`📂 Toàn bộ snapshots và network data đã lưu tại: ${outDir}`);

  // Lưu cookies mới nhất
  const cookies = await context.cookies().catch(() => []);
  if (cookies.length > 0) {
    fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2), 'utf8');
  }
})();
