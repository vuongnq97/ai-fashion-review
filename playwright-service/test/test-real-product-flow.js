'use strict';

/**
 * Real Live Test for Template Product Storyboard (/tproduct, 40s Native Voice)
 * Product: https://vt.tiktok.com/ZS9AJy341xtFk-mstqx/
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const axios = require('../node_modules/axios');

const { extractProductAssetsFromHtml, downloadProductImages } = require('../services/product-assets');
const {
  generateStoryboard,
  executeProductRemakePanel,
  finalizeProductStoryboardAndGenerateVideos,
  getProductSession,
  getCanonicalPresenterBuffer,
} = require('../services/template-product-storyboard');

(async () => {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('🚀 REAL FLOW TEST: TEMPLATE PRODUCT LIVE-COMMERCE (/tproduct)');
  console.log('🔗 Shortlink: https://vt.tiktok.com/ZS9AJy341xtFk-mstqx/');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const baseDir = path.resolve(__dirname, '..');
  const shortlink = 'https://vt.tiktok.com/ZS9AJy341xtFk-mstqx/';

  // 1. Ingest TikTok link
  console.log('👉 [BƯỚC 1/5] Ingesting TikTok Shop shortlink & extracting metadata...');
  const resp = await axios.get(shortlink, {
    maxRedirects: 5,
    validateStatus: () => true,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  const productUrl = resp.request?.res?.responseUrl || shortlink;
  const assets = extractProductAssetsFromHtml(resp.data, productUrl);

  console.log('   📦 Product ID:', assets.productId);
  console.log('   🏷️ Title:', assets.title);
  console.log('   📝 Description length:', assets.productDescription?.length, 'chars');
  console.log('   🖼️ Product images found:', assets.productImages?.length);

  // 2. Download product images
  console.log('\n👉 [BƯỚC 2/5] Downloading product images to local cache...');
  const tmpImagesDir = path.join(baseDir, 'storyboard-review-runs', `temp-crawl-${Date.now()}`);
  fs.mkdirSync(tmpImagesDir, { recursive: true });

  const dlResult = await downloadProductImages(assets.productImages, tmpImagesDir, {
    tlsRejectUnauthorized: false,
    limit: 4,
  });
  console.log(`   ✅ Downloaded ${dlResult.files?.length || 0} product images.`);

  const filePayloads = (dlResult.files || []).map(f => ({
    name: f.name,
    path: f.path,
    buffer: f.buffer,
    mimeType: f.mimeType || 'image/webp',
  }));

  // Check model reference
  const presenter = getCanonicalPresenterBuffer();
  console.log('   👤 Model reference loaded:', presenter ? `${presenter.path} (${(presenter.buffer.length / 1024 / 1024).toFixed(2)} MB)` : 'MISSING');
  if (!presenter) {
    throw new Error('Model reference missing!');
  }

  // 3. Run generateStoryboard (Stage 1 + Stage 2 + Flow Storyboard + Slicing)
  console.log('\n👉 [BƯỚC 3/5] Executing 2-Stage Gemini Pipeline & Flow Storyboard Generation...');
  const options = {
    template: 'template_product',
    productTitle: assets.title,
    productDescription: assets.productDescription,
    productContext: {
      productId: assets.productId,
      productTitle: assets.title,
      productDescription: assets.productDescription,
      productUrl,
      shortlink,
    },
    isAuto: true, // standalone run
  };

  const startTime = Date.now();
  const sbResult = await generateStoryboard(baseDir, filePayloads, options);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n🎉 Storyboard Generation Completed in ${elapsed}s!`);
  console.log('   📁 Run ID:', sbResult.runId);
  console.log('   🖼️ Master Storyboard:', sbResult.masterStoryboardPath);
  console.log('   ✂️ Sliced Panels count:', sbResult.panels?.length);

  const session = getProductSession(sbResult.runId, baseDir);
  const analysis = session?.analysis?.analysis || {};
  const script = session?.analysis?.script || [];

  console.log('\n📊 INTELLIGENCE ANALYSIS:');
  console.log('   - Product Name:', analysis.productName);
  console.log('   - Category:', analysis.category, `(${analysis.categoryKey})`);
  console.log('   - Sales Mode:', analysis.salesMode);
  console.log('   - Sourcing Setting:', analysis.sourcingSetting);
  console.log('   - Audience Address:', analysis.audienceAddress, `(Self: ${analysis.selfReference})`);
  console.log('   - Hero Action:', analysis.affordances?.heroAction);

  console.log('\n📜 40S NATIVE-VOICE SCRIPT (5 CLIPS × 8 SECONDS):');
  script.forEach(clip => {
    const wCount = clip.dialogue ? clip.dialogue.split(/\s+/).filter(Boolean).length : 0;
    console.log(`   [Clip ${clip.clipIndex} - ${clip.phase}]: "${clip.dialogue}" (${wCount} từ)`);
    console.log(`     Beats: 0-4s: ${clip.visualBeats?.[0]?.action} | 4-8s: ${clip.visualBeats?.[1]?.action}`);
  });

  // 4. Test Flow Remake Panel 4 (Hero Proof Demo)
  console.log('\n👉 [BƯỚC 4/5] Testing Real Flow Remake for Panel 4 (Product Proof & Demo)...');
  const remakeRes = await executeProductRemakePanel(null, baseDir, sbResult.runId, 4, {
    customInstruction: 'Cận cảnh sắc nét tay presenter tháo lắp cối xay thủy tinh và cắm trục dao 4 cánh sáng bóng',
  });
  console.log('   ✅ Panel 4 remade successfully via Flow API!');
  console.log('   🖼️ New Panel 4 Path:', remakeRes.panelPath);
  console.log('   🖼️ Updated Master Storyboard Path:', remakeRes.masterStoryboardPath);

  // 5. Test Finalize Video Generation & 40s Concat
  console.log('\n👉 [BƯỚC 5/6] Finalizing 5x 8s Native Voice Videos & Concat (40.0s)...');
  const finalRes = await finalizeProductStoryboardAndGenerateVideos(null, baseDir, sbResult.runId);
  console.log('   ✅ Final 40s Video created successfully:', finalRes.mergedVideoPath);

  // 6. Cleanup temporary crawl dir
  try {
    fs.rmSync(tmpImagesDir, { recursive: true, force: true });
  } catch (_) {}

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('🎉 REAL FULL FLOW TEST FOR TPRODUCT COMPLETED 100% SUCCESSFULLY!');
  console.log('═══════════════════════════════════════════════════════════════════\n');
})().catch(err => {
  console.error('\n❌ REAL FLOW TEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
