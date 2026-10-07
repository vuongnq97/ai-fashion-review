'use strict';

const fs = require('fs');
const path = require('path');
const { Flow2ApiClient } = require('./flow2api-client');
const {
  analyzeProductTemplatePro,
  buildTemplateProMasterPrompt,
  sliceMasterStoryboardPro,
  composeMasterStoryboardPro,
} = require('../template-pro-storyboard');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Storyboard provider using Flow2API (pure HTTP REST API)
 * Tuân thủ 100% kiến trúc của Template Pro (/tpro):
 * 1. Phân tích sản phẩm qua 4 câu hỏi thương mại (Hook, Solution, Proof, Closing).
 * 2. Sinh duy nhất 1 bức Master Storyboard 16:9 chứa 4 Panels liên hoàn side-by-side.
 * 3. Tách (Slice) Master Storyboard thành 4 Panels tự nhiên 4:9 (480x1080) không biến dạng.
 * 4. Sinh Video Veo (I2V) cho từng Panel.
 */
async function generateStoryboard(baseDir, filePayloads, options = {}) {
  if (!filePayloads || filePayloads.length === 0) {
    throw new Error('At least one product image is required');
  }

  const client = new Flow2ApiClient({
    baseUrl: options.flow2ApiUrl || process.env.FLOW2API_BASE_URL,
    apiKey: options.flow2ApiKey || process.env.FLOW2API_API_KEY,
  });

  const progress = typeof options.onProgress === 'function' ? options.onProgress : async () => {};
  const runId = options.runId || `run-${Date.now()}`;
  const runDir = path.join(baseDir, 'uploads', 'flow2api-runs', runId);
  ensureDir(runDir);
  const panelsDir = path.join(runDir, 'panels');
  ensureDir(panelsDir);
  const videosDir = path.join(runDir, 'videos');
  ensureDir(videosDir);

  console.log(`[Flow2API Provider] Starting Template Pro flow for ${filePayloads.length} input image(s)...`);

  // ── BƯỚC 1: PHÂN TÍCH SẢN PHẨM THEO FRAMEWORK TEMPLATE PRO ───────────────────
  const productTitle = options.productMeta?.title || 'Sản phẩm cao cấp';
  let analysis = null;

  try {
    const analyzed = await analyzeProductTemplatePro(null, filePayloads, {
      productContext: { productTitle },
      template: 'template_pro',
      noText: true,
      hasVoice: true,
    });
    analysis = analyzed.analysis;
  } catch (err) {
    console.warn(`[Flow2API Provider] analyzeProductTemplatePro warning: ${err.message}`);
  }

  if (!analysis) {
    analysis = {
      productName: productTitle,
      fourAnswers: {
        hook: 'Khám phá ngay tính năng đột phá của sản phẩm!',
        solution: 'Thiết kế thông minh, giải pháp tối ưu cho gia đình.',
        proof: 'Chất liệu cao cấp, độ bền vượt trội kiểm chứng thực tế.',
        closing: 'Sản phẩm chính hãng, đặt mua ngay hôm nay!',
      },
      script: [
        { phase: 'Hook', visualDescription: `Cận cảnh sản phẩm ${productTitle} sang trọng`, techVFX: 'Cầm trên tay' },
        { phase: 'Solution', visualDescription: `Chi tiết công năng sử dụng của ${productTitle}`, techVFX: 'Thao tác thực tế' },
        { phase: 'Proof', visualDescription: `Cận cảnh bề mặt chất liệu cao cấp của ${productTitle}`, techVFX: 'Kiểm tra độ bền' },
        { phase: 'Closing', visualDescription: `Toàn cảnh ${productTitle} trong không gian hiện đại`, techVFX: 'Hoàn thiện' },
      ],
      sceneContext: {
        location: 'Không gian sống hiện đại sáng sủa',
        lighting: 'Ánh sáng tự nhiên dịu nhẹ ban ngày',
      },
    };
  }

  await progress({
    currentStep: 'product_analyzed',
    stepOrder: 2,
    progressPercent: 25,
    message: `Đã phân tích sản phẩm Template Pro: ${analysis.productName}`,
  });

  // ── BƯỚC 2: TẠO MASTER STORYBOARD 16:9 (4 PANELS SIDE-BY-SIDE) ────────────────
  console.log('[Flow2API Provider] Step 2: Building Master Storyboard Prompt & calling Flow2API (16:9 Landscape)...');
  const masterPrompt = buildTemplateProMasterPrompt(analysis, { noText: true, template: 'template_pro' });

  await progress({
    currentStep: 'generating_master_storyboard',
    stepOrder: 3,
    progressPercent: 35,
    message: 'Đang tạo Master Storyboard 16:9 (4 Panels liên hoàn) bằng Flow2API...',
  });

  const masterResult = await client.generateImage({
    prompt: masterPrompt,
    aspectRatio: '16:9',
    referenceImages: [filePayloads[0]],
  });

  const masterStoryboardPath = path.join(runDir, 'master-storyboard.png');
  fs.writeFileSync(masterStoryboardPath, masterResult.buffer);
  console.log(`[Flow2API Provider] ✅ Đã lưu Master Storyboard 16:9: ${masterStoryboardPath}`);

  // ── BƯỚC 3: TÁCH (SLICE) MASTER STORYBOARD THÀNH 4 PANELS TỰ NHIÊN 4:9 ───────
  console.log('[Flow2API Provider] Step 3: Slicing Master Storyboard into 4 native panels (480x1080)...');
  await progress({
    currentStep: 'slicing_panels',
    stepOrder: 4,
    progressPercent: 55,
    message: 'Đang tách Master Storyboard thành 4 panels tự nhiên 4:9...',
  });

  const panelBuffers = sliceMasterStoryboardPro(masterResult.buffer);
  const panels = [];
  const panelPhases = ['Hook', 'Solution', 'Proof', 'Closing'];

  for (let i = 0; i < panelBuffers.length; i++) {
    const pIdx = i + 1;
    const panelPath = path.join(panelsDir, `panel-${pIdx}.png`);
    fs.writeFileSync(panelPath, panelBuffers[i]);

    panels.push({
      index: pIdx,
      phase: panelPhases[i] || `Panel ${pIdx}`,
      imagePath: panelPath,
      imageBase64: panelBuffers[i].toString('base64'),
      buffer: panelBuffers[i],
      script: analysis.script?.[i] || null,
    });
  }

  console.log(`[Flow2API Provider] ✅ Đã tách thành công ${panels.length} panels từ Master Storyboard!`);

  await progress({
    currentStep: 'panels_ready',
    stepOrder: 4,
    progressPercent: 65,
    message: `Đã có đầy đủ 4 Panels từ Master Storyboard. Đang tiến hành tạo video Veo...`,
  });

  // ── BƯỚC 4: SINH VIDEO VEO (I2V) CHO CÁC PANELS ──────────────────────────────
  const videoCount = options.videoCount || 4; // Mặc định sinh đủ 4 clips cho 4 panels (hoặc options quy định)
  const videos = [];
  const videoDuration = options.videoDuration || 6;

  for (let i = 0; i < Math.min(panels.length, videoCount); i++) {
    const pIdx = i + 1;
    const p = panels[i];
    const s = p.script || {};
    const vPrompt = `Smooth cinematic camera push in, showcase ${analysis.productName}. ${s.visualDescription || ''}. ${s.techVFX || ''}`.trim();

    console.log(`[Flow2API Provider] [${pIdx}/${videoCount}] Generating Veo video for Panel ${pIdx} (${p.phase})...`);

    await progress({
      currentStep: 'generating_videos',
      stepOrder: 5,
      progressPercent: 65 + Math.round((i / videoCount) * 25),
      message: `Đang sinh Video Cảnh ${pIdx}/${videoCount} (${p.phase} - Veo ${videoDuration}s)...`,
    });

    try {
      const vidResult = await client.generateVideo({
        image: p.buffer,
        prompt: vPrompt,
        duration: videoDuration,
        aspectRatio: 'portrait',
        modelKey: options.videoModelKey || null,
      });

      const videoPath = path.join(videosDir, `panel-${pIdx}.mp4`);
      fs.writeFileSync(videoPath, vidResult.buffer);

      videos.push({
        panelIndex: pIdx,
        phase: p.phase,
        prompt: vPrompt,
        videoPath,
        videoBase64: vidResult.base64,
        video: { base64: vidResult.base64, mimeType: 'video/mp4' },
      });
      console.log(`[Flow2API Provider] ✅ Video Cảnh ${pIdx} (${p.phase}) hoàn tất: ${videoPath}`);
    } catch (vErr) {
      console.error(`[Flow2API Provider] ⚠️ Video Cảnh ${pIdx} thất bại:`, vErr.message);
      videos.push({
        panelIndex: pIdx,
        phase: p.phase,
        error: vErr.message,
      });
    }
  }

  await progress({
    currentStep: 'videos_generated',
    stepOrder: 6,
    progressPercent: 95,
    message: `Đã sinh xong ${videos.filter(v => !v.error).length}/${videos.length} video.`,
  });

  return {
    masterStoryboard: {
      imagePath: masterStoryboardPath,
      imageBase64: masterResult.base64,
      buffer: masterResult.buffer,
    },
    panels,
    videos,
    analysis,
    promptSource: 'template_pro_flow2api',
    runDir,
  };
}

module.exports = {
  generateStoryboard,
};
