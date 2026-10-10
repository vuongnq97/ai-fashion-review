'use strict';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const path = require('path');
const fs = require('fs');
const { scrapeWalmartProduct, downloadImages } = require('./services/walmart-scraper');
const { analyzeAndSelectAngles } = require('./services/image-analyzer');
const { generatePanel9x16 } = require('./services/panel-generator');
const { generateOmni360Video } = require('./services/omni-video');

async function runPipeline(targetInput) {
  const startTime = Date.now();
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧱 LEGO 360° SHORT VIDEO PIPELINE (10S PORTRAIT 9:16)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`🔗 Input: ${targetInput}\n`);

  try {
    let product;
    let downloadDir;
    let outputDir;

    const isUrl = /^https?:\/\//i.test(targetInput);

    if (isUrl) {
      console.log('▶️ [BƯỚC 0] Cào dữ liệu sản phẩm & tải ảnh gốc từ Walmart...');
      product = await scrapeWalmartProduct(targetInput);
      console.log(`   - Tên sản phẩm: ${product.name}`);
      console.log(`   - Giá: ${product.price?.priceDisplay || product.price?.priceString || 'N/A'}`);
      console.log(`   - Tổng ảnh phát hiện: ${product.images.length} ảnh`);

      downloadDir = path.join(__dirname, 'downloads', product.itemId);
      console.log(`   - Đang tải toàn bộ ảnh vào: ${downloadDir}...`);
      const downloadedImages = await downloadImages(product.images, downloadDir);
      console.log(`   ✅ Đã tải xong ${downloadedImages.length} ảnh.\n`);

      outputDir = path.join(__dirname, 'outputs', product.itemId);
    } else {
      console.log('▶️ [BƯỚC 0] Sử dụng thư mục ảnh có sẵn trên máy...');
      downloadDir = path.resolve(targetInput);
      if (!fs.existsSync(downloadDir)) {
        throw new Error(`Thư mục không tồn tại: ${downloadDir}`);
      }

      const folderName = path.basename(downloadDir);
      outputDir = path.join(__dirname, 'outputs', folderName);

      product = {
        itemId: folderName,
        name: 'LEGO Disney Moana 2 Heihei (43272)',
        brand: 'LEGO',
        dimensionsText: 'DIMENSIONS – This 566-piece buildable LEGO Disney set stands over 10.5 in. (27 cm) tall when fully assembled'
      };
      console.log(`   - Thư mục nguồn: ${downloadDir}`);
      console.log(`   - Tên sản phẩm: ${product.name}`);
      console.log(`   - Thông số kích thước: ${product.dimensionsText}\n`);
    }

    // ─────────────────────────────────────────────────────────────
    // BƯỚC 1: GEMINI VISION PHÂN TÍCH & CHỌN BỘ ẢNH ĐA GÓC
    // ─────────────────────────────────────────────────────────────
    let analysis;
    const cachedAnalysisPath = path.join(outputDir, 'analysis_result.json');
    if (fs.existsSync(cachedAnalysisPath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cachedAnalysisPath, 'utf8'));
        if (cached.analysis && cached.analysis.selectedAngles && cached.analysis.dimensions) {
          console.log('▶️ [BƯỚC 1] ⚡ Tái sử dụng kết quả phân tích đã có từ analysis_result.json...');
          analysis = cached.analysis;
        }
      } catch (_) {}
    }

    if (!analysis) {
      console.log('▶️ [BƯỚC 1] Gemini Vision phân tích & chắt lọc bộ ảnh đa góc (Multi-Angle)...');
      analysis = await analyzeAndSelectAngles(downloadDir, product);
    }

    if (analysis.dimensions) {
      console.log(`\n   📏 KÍCH THƯỚC SẢN PHẨM: ${analysis.dimensions.formatted || analysis.dimensions.rawText}`);
      if (analysis.dimensions.height_cm) console.log(`      - Chiều cao: ${analysis.dimensions.height_cm} cm${analysis.dimensions.height_inch ? ` (${analysis.dimensions.height_inch} in)` : ''}`);
      if (analysis.dimensions.length_cm) console.log(`      - Chiều dài: ${analysis.dimensions.length_cm} cm${analysis.dimensions.length_inch ? ` (${analysis.dimensions.length_inch} in)` : ''}`);
      if (analysis.dimensions.width_cm) console.log(`      - Chiều rộng: ${analysis.dimensions.width_cm} cm${analysis.dimensions.width_inch ? ` (${analysis.dimensions.width_inch} in)` : ''}`);
    }

    console.log('\n   🎯 BỘ ẢNH ĐA GÓC ĐƯỢC CHỌN:');
    if (analysis.selectedAngles?.heroAngle) {
      console.log(`   1. [Hero View / Góc chính 3/4]: ${analysis.selectedAngles.heroAngle.filename}`);
      console.log(`      ↳ ${analysis.selectedAngles.heroAngle.reason}`);
    }
    if (analysis.selectedAngles?.altAngle) {
      console.log(`   2. [Alt View / Góc bên hoặc sau]: ${analysis.selectedAngles.altAngle.filename}`);
      console.log(`      ↳ ${analysis.selectedAngles.altAngle.reason}`);
    }
    if (analysis.selectedAngles?.featureAngle) {
      console.log(`   3. [Feature View / Góc chi tiết khớp]: ${analysis.selectedAngles.featureAngle.filename}`);
      console.log(`      ↳ ${analysis.selectedAngles.featureAngle.reason}`);
    }

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    // Lưu kết quả phân tích
    fs.writeFileSync(
      path.join(outputDir, 'analysis_result.json'),
      JSON.stringify({ product, analysis }, null, 2),
      'utf8'
    );

    // ─────────────────────────────────────────────────────────────
    // BƯỚC 2: TẠO MASTER PANEL 9:16 BẰNG NANO BANANA PRO
    // ─────────────────────────────────────────────────────────────
    let panelImagePath = path.join(outputDir, 'master_panel_9_16.png');
    if (fs.existsSync(panelImagePath) && fs.statSync(panelImagePath).size > 20000) {
      console.log(`\n▶️ [BƯỚC 2] ⚡ Tái sử dụng Master Panel 9:16 đã có: ${panelImagePath}`);
    } else {
      console.log('\n▶️ [BƯỚC 2] Tạo ảnh Master Panel 9:16 bằng Nano Banana Pro...');
      const panelResult = await generatePanel9x16({
        analysis,
        productName: product.name,
        outputDir
      });
      panelImagePath = panelResult.imagePath;
    }

    // ─────────────────────────────────────────────────────────────
    // BƯỚC 3: TẠO VIDEO 10S XOAY 360° BẰNG OMNI VIDEO MODEL
    // ─────────────────────────────────────────────────────────────
    let videoFilePath = path.join(outputDir, 'video_360_10s.mp4');
    if (fs.existsSync(videoFilePath) && fs.statSync(videoFilePath).size > 50000) {
      console.log(`\n▶️ [BƯỚC 3] ⚡ Tái sử dụng Video 360° đã có: ${videoFilePath}`);
    } else {
      console.log('\n▶️ [BƯỚC 3] Tạo Video 10s xoay 360° bằng model Omni Video...');
      const videoResult = await generateOmni360Video({
        panelImagePath,
        productName: product.name,
        outputDir
      });
      videoFilePath = videoResult.videoPath;
    }

    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`🎉 HOÀN TẤT PIPELINE CHO SẢN PHẨM: ${product.name}`);
    console.log(`⏱️ Thời gian thực thi: ${elapsedSec}s`);
    console.log(`📁 Thư mục kết quả: ${outputDir}`);
    console.log('═══════════════════════════════════════════════════════════════\n');

  } catch (err) {
    console.error('\n❌ PIPELINE FAILED:', err.message);
  }
}

// Chạy trực tiếp từ dòng lệnh
const url = process.argv[2] || 'https://www.walmart.com/ip/LEGO-Disney-Princess-43272/7277168939?classType=REGULAR&athbdg=L1800&from=/search';
runPipeline(url);
