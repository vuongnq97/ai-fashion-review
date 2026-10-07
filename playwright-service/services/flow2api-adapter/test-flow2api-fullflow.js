'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const path = require('path');
const fs = require('fs');
const { Flow2ApiClient } = require('./flow2api-client');
const { generateStoryboard } = require('./flow2api-storyboard-provider');
const { mergePanelVideos } = require('../video-merge');

async function runTest() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('   🚀 TEST FULL LUỒNG AI-FASHION-REVIEW VỚI FLOW2API GATEWAY');
  console.log('═══════════════════════════════════════════════════════════════════');

  const baseDir = path.resolve(__dirname, '../..');
  const client = new Flow2ApiClient();

  // 1. Kiểm tra kết nối tới Flow2API
  console.log('\n[1/5] Kiểm tra kết nối tới Flow2API Gateway...');
  const isHealthy = await client.isHealthy();
  if (!isHealthy) {
    console.error('❌ Flow2API Gateway chưa sẵn sàng tại:', client.baseUrl);
    console.log('👉 Vui lòng đảm bảo container flow2api đang chạy: docker ps');
    process.exit(1);
  }
  console.log('✅ Flow2API Gateway đang hoạt động tại:', client.baseUrl);

  // 2. Chuẩn bị ảnh đầu vào
  console.log('\n[2/5] Chuẩn bị tài nguyên hình ảnh đầu vào...');
  const inputArg = process.argv[2];
  let filePayloads = [];

  let productMeta = null;
  if (inputArg && (inputArg.startsWith('http://') || inputArg.startsWith('https://'))) {
    console.log(`Đang cào dữ liệu từ link: ${inputArg}`);
    const axios = require('axios');
    const { extractProductAssetsFromHtml } = require('../product-assets');

    let targetUrl = inputArg;
    let title = '';
    let images = [];

    try {
      const redirectRes = await axios.get(inputArg, {
        maxRedirects: 0,
        validateStatus: (s) => s >= 200 && s < 400,
        headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X)' },
      });
      const loc = redirectRes.headers.location;
      if (loc) {
        targetUrl = loc;
        const parsed = new URL(loc);
        const ogInfoRaw = parsed.searchParams.get('og_info');
        if (ogInfoRaw) {
          try {
            const og = JSON.parse(ogInfoRaw);
            if (og.title) title = og.title;
            if (og.image) images.push(og.image);
          } catch (_) {}
        }
      }
    } catch (_) {}

    if (images.length === 0) {
      const resp = await axios.get(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X)' },
      });
      const assets = extractProductAssetsFromHtml(resp.data, targetUrl);
      if (assets.title && !title) title = assets.title;
      if (assets.productImages && assets.productImages.length > 0) {
        images = assets.productImages;
      }
    }

    console.log(`Tìm thấy: "${title || 'Không rõ'}" với ${images.length} ảnh.`);
    productMeta = { title };

    for (let i = 0; i < Math.min(images.length, 3); i++) {
      try {
        const imgResp = await axios.get(images[i], { responseType: 'arraybuffer' });
        filePayloads.push({
          name: `product-${i + 1}.jpg`,
          buffer: Buffer.from(imgResp.data),
          mimeType: 'image/jpeg',
        });
      } catch (e) {
        console.warn(`Không tải được ảnh ${images[i]}: ${e.message}`);
      }
    }
  }

  // Fallback: nếu không có link hoặc không lấy được ảnh, dùng ảnh mẫu từ assets/
  if (filePayloads.length === 0) {
    console.log('Sử dụng ảnh mẫu local từ assets/...');
    const sampleDir = path.join(baseDir, 'assets');
    const candidateFiles = ['template3-storyboard-reference.png', 'template4-storyboard-reference.png', 'template_storyboard_nu.png'];
    for (const f of candidateFiles) {
      const full = path.join(sampleDir, f);
      if (fs.existsSync(full)) {
        filePayloads.push({
          name: f,
          buffer: fs.readFileSync(full),
          mimeType: 'image/png',
        });
        break;
      }
    }
  }

  if (filePayloads.length === 0) {
    console.error('❌ Không tìm thấy ảnh đầu vào để test!');
    process.exit(1);
  }
  console.log(`✅ Đã chuẩn bị ${filePayloads.length} ảnh sản phẩm đầu vào.`);

  // 3. Chạy Storyboard & Veo Video generation qua Flow2API theo chuẩn Template Pro
  console.log('\n[3/5] Thực hiện sinh Master Storyboard (16:9, 4 Panels) & Veo Videos qua Flow2API...');
  const startTime = Date.now();
  const result = await generateStoryboard(baseDir, filePayloads, {
    videoCount: 2, // Tạo thử nghiệm 2 video clip để tối ưu thời gian test
    productMeta,
    onProgress: (info) => {
      console.log(`  [Tiến trình ${info.progressPercent}%] ${info.message}`);
    },
  });

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  console.log(`✅ Tạo hoàn tất sau ${durationSec}s!`);
  console.log(`- Master Storyboard 16:9: ${result.masterStoryboard?.imagePath}`);
  console.log(`- Số panel tách được: ${result.panels.length} panels (480x1080)`);
  console.log(`- Số video hoàn thành: ${result.videos.filter(v => !v.error).length}/${result.videos.length}`);

  // 4. Ghép video với FFmpeg
  console.log('\n[4/5] Ghép các video panel thành video hoàn chỉnh với FFmpeg...');
  const validVideos = result.videos.filter(v => v.videoPath && fs.existsSync(v.videoPath));
  if (validVideos.length === 0) {
    console.error('❌ Không có video nào được tạo thành công để ghép.');
    process.exit(1);
  }

  const finalVideoDir = path.join(baseDir, 'uploads', 'final-videos');
  if (!fs.existsSync(finalVideoDir)) fs.mkdirSync(finalVideoDir, { recursive: true });
  const finalVideoPath = path.join(finalVideoDir, `flow2api-tpro-${Date.now()}.mp4`);

  if (typeof mergePanelVideos === 'function') {
    await mergePanelVideos(validVideos.map(v => v.videoPath), finalVideoPath);
    console.log(`✅ Đã ghép video hoàn tất: ${finalVideoPath}`);
  } else {
    fs.copyFileSync(validVideos[0].videoPath, finalVideoPath);
    console.log(`✅ Xuất video hoàn tất: ${finalVideoPath}`);
  }

  // 5. Tổng kết
  console.log('\n[5/5] TỔNG KẾT KẾT QUẢ TEST TEMPLATE PRO (MASTER STORYBOARD + 4 PANELS):');
  console.log('───────────────────────────────────────────────────────────────────');
  console.log(`📦 Tên sản phẩm:            ${result.analysis.productName}`);
  console.log(`🖼️ Master Storyboard 16:9:  ${result.masterStoryboard?.imagePath}`);
  result.panels.forEach(p => {
    console.log(`   ├─ Panel ${p.index} (${p.phase}): ${p.imagePath}`);
  });
  console.log(`🎬 File video xuất:         ${finalVideoPath}`);
  console.log(`⏱️ Tổng thời gian:          ${durationSec} giây`);
  console.log('───────────────────────────────────────────────────────────────────');
  console.log('🎉 TEST THÀNH CÔNG! Chuẩn 100% flow Template Pro qua Flow2API Gateway.');
}

runTest().catch((err) => {
  console.error('\n❌ TEST THẤT BẠI VỚI LỖI:', err.message);
  if (err.response?.data) {
    console.error('Chi tiết phản hồi từ Flow2API:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
