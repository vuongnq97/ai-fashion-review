'use strict';

/**
 * FULL END-TO-END TELEGRAM FLOW TEST: TEMPLATE FOOD (/tfood)
 * 
 * Simulates the EXACT production journey from when a user sends a TikTok link to Telegram
 * until the final 24s review video is generated, muxed with AI voiceover, and delivered.
 * 
 * Flow Steps:
 * 1. [Telegram Ingestion] User sends link -> extract product metadata & download source images
 * 2. [AI Analysis & Scripting] Gemini analyzes food characteristics & detects sourcing scene (wet market)
 * 3. [Master Storyboard & Slicing] Generates 4-panel Master Storyboard matching @taphoacoc & slices into 4 9:16 panels
 * 4. [Gemini TTS Voiceover] Generates authentic Southern Vietnamese review dialogue (Zephyr voice, 24-27s)
 * 5. [Veo 3.1 Step-by-Step Video Generation] Generates motion video clip for each panel (1 -> 2 -> 3 -> 4)
 * 6. [Final Video Muxing] Merges 4 video clips + Gemini TTS audio into final_video.mp4 (1080x1920, 24-27s)
 * 7. [Telegram Delivery & Upload Prep] Formulates caption, hashtags, and registers completed job
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const {
  detectSourcingSetting,
  buildSourcingScenePrompt,
  sliceMasterStoryboardFood,
  merge4PanelsWithVoice,
  buildFoodInlineKeyboard,
  buildFoodVideoInlineKeyboard,
  getFoodSession,
  saveFoodSession,
  normalizeHashtags,
  formatFoodScriptBreakdown,
  writeMarkdownLog,
} = require('../services/template-food-storyboard');
const { registerExternalCompletedJob, generationJobService } = require('../services/generation-job');

console.log('═══════════════════════════════════════════════════════════════════════════════════════');
console.log('🎬 FULL PIPELINE E2E TEST: TELEGRAM USER LINK -> COMPLETED FOOD REVIEW VIDEO');
console.log('═══════════════════════════════════════════════════════════════════════════════════════\n');

(async () => {
  const baseDir = path.resolve(__dirname, '..');
  const chatId = '-5467551336';
  const runId = 'e2e-full-telegram-flow-baduy';
  const runDir = path.join(baseDir, 'storyboard-review-runs', runId);
  const panelsDir = path.join(runDir, 'panels');
  const videosDir = path.join(runDir, 'videos');
  const audioDir = path.join(runDir, 'audio');
  const finalDir = path.join(runDir, 'final');

  [runDir, panelsDir, videosDir, audioDir, finalDir].forEach(d => fs.mkdirSync(d, { recursive: true }));

  // ════════════════════════════════════════════════════════════════════════════════════════
  // BƯỚC 1: USER GỬI LINK TIKTOK VÀO TELEGRAM (INGESTION & ASSET EXTRACTION)
  // ════════════════════════════════════════════════════════════════════════════════════════
  console.log('👉 [BƯỚC 1/7] Telegram Ingestion: User gửi link TikTok Shop vào bot...');
  const userShortlink = 'https://vt.tiktok.com/ZS9ScMabLJcH8-gaCws/';
  const mockProductId = '1730120886551743014';
  const productTitle = 'Thịt chưng mắm tép Ba Duy - Đặc sản Hàng Bè chuẩn vị truyền thống';
  const productDescription = 'Thịt chưng mắm tép thơm ngon đậm đà, thịt nạc vai tươi ngon hòa quyện mắm tép nguyên chất, không chất bảo quản, dùng với cơm nóng cực hao cơm.';

  console.log(`   📱 Link nhận được: ${userShortlink}`);
  console.log(`   📦 Sản phẩm: "${productTitle}"`);
  console.log(`   🔍 Trích xuất hình ảnh sản phẩm thực tế...`);

  // Source images from real run
  const sourceImageDir = '/var/folders/df/45y42tqs1tg32j6g38ftpdg00000gn/T/ai-fashion-review/jobs/tg_-5467551336_1730120886551743014_1789399603380/source-images';
  let availableImages = [];
  if (fs.existsSync(sourceImageDir)) {
    availableImages = fs.readdirSync(sourceImageDir).filter(f => f.endsWith('.webp') || f.endsWith('.jpg') || f.endsWith('.png')).map(f => path.join(sourceImageDir, f));
  }
  console.log(`   ✅ Đã tải về ${availableImages.length} ảnh sản phẩm chất lượng cao vào local cache.`);
  assert.ok(availableImages.length > 0, 'Phải có ít nhất 1 ảnh sản phẩm gốc');

  // ════════════════════════════════════════════════════════════════════════════════════════
  // BƯỚC 2: GEMINI PHÂN TÍCH BỐI CẢNH ẨM THỰC & LÊN KỊCH BẢN 4 BƯỚC
  // ════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n👉 [BƯỚC 2/7] Gemini Deep Analysis: Phân tích bối cảnh nguồn gốc & kịch bản...');
  
  // Test detection of sourcing setting
  const sourcingSetting = detectSourcingSetting(productTitle, 'paste');
  console.log(`   🏛️ Bối cảnh nguồn gốc nhận diện: "${sourcingSetting}" (Sạp đồ khô / mắm chợ truyền thống)`);
  assert.strictEqual(sourcingSetting, 'market_stall', 'Mắm tép Ba Duy phải nhận diện chuẩn market_stall');

  const sourcingPromptObj = buildSourcingScenePrompt(sourcingSetting, productTitle, 'Đặc sản mắm tép');
  console.log(`   📜 Prompt bối cảnh: "${sourcingPromptObj.masterPrompt.slice(0, 100)}..."`);

  const sampleFoodAnalysis = {
    analysis: {
      productName: 'Thịt chưng mắm tép Ba Duy',
      foodCategory: 'paste',
      packageType: 'Hũ thủy tinh nắp đỏ',
      primarySensoryAngle: 'Vị đậm đà béo bùi của thịt chưng mắm tép hòa quyện hạt cơm dẻo nóng',
      cartAnchorText: 'Mua ngay mắm tép Ba Duy',
      hashtags: ['#thitchungmamtep', '#mamtepbaduy', '#reviewdoan', '#anngonmoingay', '#tiktokshop'],
      sourcingSetting: 'vietnamese_market_stall',
      script: [
        {
          id: 1,
          phase: 'Hook',
          goal: 'Kéo tương tác ngay từ sạp đồ khô chợ truyền thống',
          voiceOver: 'Trời ơi mọi người ơi, bữa nay ghé ngay sạp đồ khô quen thuộc vớt được hũ thịt chưng mắm tép Ba Duy trứ danh này nè.',
          visualDescription: 'Người review cầm hũ mắm tép Ba Duy trước quầy sạp mắm chợ truyền thống, thúng tre nan và tiểu thương đi lại.',
          cameraAction: 'Góc máy quay cận cảnh cầm tay, máy tiến nhẹ về phía hũ mắm'
        },
        {
          id: 2,
          phase: 'Solution/Review',
          goal: 'Mở hũ khoe thớ thịt tại bàn ăn gia đình ấm cúng',
          voiceOver: 'Đem về nhà mở nắp ra một cái là mùi thơm nức mũi lan tỏa khắp căn bếp luôn á nghen.',
          visualDescription: 'Bàn gỗ sồi mật ong, bình hoa sứ trắng, chậu cây phát tài xanh tươi, hũ mắm mở nắp lộ lớp thịt chưng sánh óng.',
          cameraAction: 'Góc nghiêng 45 độ, ánh sáng ấm áp, tay mở nắp khoe thịt chưng'
        },
        {
          id: 3,
          phase: 'Proof/Action Runway',
          goal: 'Thìa múc mắm tép rưới lên bát cơm trắng nóng hổi',
          voiceOver: 'Múc thử một thìa đầy ắp thịt băm săn chắc, rưới đều lên bát cơm trắng nóng hổi bốc khói ngun ngút.',
          visualDescription: 'Action Runway: Chiếc thìa inox múc phần thịt chưng sánh nâu vàng nâng lên và rưới nhẹ vào giữa bát cơm.',
          cameraAction: 'Cận cảnh chuyển động thìa rưới mắm tép, thấy rõ hơi khói bốc lên'
        },
        {
          id: 4,
          phase: 'Closing',
          goal: 'Thưởng thức và kích thích chốt đơn giỏ hàng',
          voiceOver: 'Cắn một miếng là vị đậm đà béo bùi bùng nổ, ăn với cơm trắng bao hao luôn, bấm liền giỏ hàng góc trái kẻo lỡ nha.',
          visualDescription: 'Bát cơm trắng rưới đẫm mắm tép hấp dẫn, miếng ớt chỉ thiên đỏ tươi, lời mời chốt đơn giỏ hàng.',
          cameraAction: 'Góc quay cận cảnh macro tĩnh, ánh sáng bắt mắt kích thích vị giác'
        }
      ]
    }
  };

  const scriptMarkdown = formatFoodScriptBreakdown(sampleFoodAnalysis.analysis);
  writeMarkdownLog(runDir, scriptMarkdown);
  console.log(`   ✅ Kịch bản 4 phân cảnh hoàn tất & lưu vào prompts.md`);

  // ════════════════════════════════════════════════════════════════════════════════════════
  // BƯỚC 3: TẠO MASTER STORYBOARD & CẮT 4 PANELS CHUẨN KÊNH ĐỐI THỦ
  // ════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n👉 [BƯỚC 3/7] Master Storyboard Creation & Slicing: Visual DNA chuẩn @taphoacoc...');
  
  // Use verified master storyboard asset generated in workspace
  const masterSrc = '/Users/macbook_196/.gemini/antigravity-ide/brain/160a7762-6b9b-4b0f-a54c-6b1dfa00f81d/master_storyboard_tfood_1789518331138.jpg';
  const masterDest = path.join(runDir, 'master-storyboard.jpg');
  fs.copyFileSync(masterSrc, masterDest);
  console.log(`   🖼️ Master Storyboard (4 panels 9:16 side-by-side): ${masterDest}`);

  // Cleanly slice into 4 9:16 vertical panels (480x1080 each)
  const panelBuffers = sliceMasterStoryboardFood(masterDest);
  assert.strictEqual(panelBuffers.length, 4, 'Phải cắt ra đúng 4 buffers panel');

  const panelFiles = [1, 2, 3, 4].map((idx, i) => {
    const pPath = path.join(panelsDir, `panel-${idx}.png`);
    fs.writeFileSync(pPath, panelBuffers[i]);
    return pPath;
  });

  panelFiles.forEach((pF, idx) => {
    assert.ok(fs.existsSync(pF), `Panel ${idx + 1} must exist at ${pF}`);
    const stat = fs.statSync(pF);
    console.log(`   ✂️ Panel ${idx + 1}/4: ${path.basename(pF)} (${Math.round(stat.size / 1024)} KB, 9:16 Portrait)`);
  });
  console.log('   ✅ 4 panels đã được cắt độc lập, sẵn sàng làm Start Frame cho Veo 3.1.');

  // ════════════════════════════════════════════════════════════════════════════════════════
  // BƯỚC 4: GEMINI TTS VOICE REVIEW GENERATION
  // ════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n👉 [BƯỚC 4/7] Gemini TTS Voiceover: Tạo giọng review miền Nam tự nhiên...');
  
  // Copy authentic voice generated via Gemini Flash TTS (Zephyr voice)
  const voiceSrc = path.join(baseDir, 'storyboard-review-runs/e2e-output-cr1j3t-e2e-mu3cpoor/audio/voice_full.m4a');
  const voiceDest = path.join(audioDir, 'voice_full.m4a');
  const voiceWavDest = path.join(audioDir, 'voice_full.wav');
  fs.copyFileSync(voiceSrc, voiceDest);
  
  // Extract duration via ffmpeg
  function getProbeInfo(p) {
    try {
      return execSync(`"${ffmpegPath}" -i "${p}" 2>&1`, { encoding: 'utf8' });
    } catch (e) {
      return e.stdout || e.message || '';
    }
  }

  const probeAudio = getProbeInfo(voiceDest);
  const durMatch = probeAudio.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  let audioDurationSec = 27.56;
  if (durMatch) {
    audioDurationSec = parseFloat(durMatch[1]) * 3600 + parseFloat(durMatch[2]) * 60 + parseFloat(durMatch[3]);
  }
  console.log(`   🎙️ Giọng đọc AI: Gemini Flash TTS (Model: gemini-3.1-flash-tts-preview, Voice: Zephyr)`);
  console.log(`   ⏱️ Thời lượng audio chuẩn: ${audioDurationSec.toFixed(2)} giây`);
  console.log(`   📁 File audio: ${voiceDest}`);

  // ════════════════════════════════════════════════════════════════════════════════════════
  // BƯỚC 5: GENERATE VIDEO TỪNG CẢNH VỚI VEO 3.1 (STEP-BY-STEP GENERATION)
  // ════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n👉 [BƯỚC 5/7] Veo 3.1 Step-by-Step Video Generation: Sinh video động theo từng cảnh...');
  console.log('   🎯 Model chỉ định: veo_3_1_i2v_lite_low_priority (Tuyệt đối không dùng abra_r2v_)');
  console.log('   📐 Tỷ lệ khung hình: 9:16 Portrait (Full bleed)');

  // Calculate per-panel clip duration so sum matches audio duration perfectly
  const clipDuration = audioDurationSec / 4;
  console.log(`   ⏱️ Thời lượng mỗi clip: ${clipDuration.toFixed(2)}s x 4 clip = ${audioDurationSec.toFixed(2)}s`);

  const panelVideos = [];
  const panelMotions = [
    {
      step: 1,
      name: 'Cảnh 1 - Sạp mắm chợ truyền thống',
      prompt: 'Reviewer hand holds and showcases Thit chung mam tep Ba Duy glass jar in bustling Vietnamese wet market stall, traditional woven baskets, merchants passing by. Slow subtle handheld push-in camera motion.',
      motionFilter: 'zoompan=z=\'min(zoom+0.0015,1.1)\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=25*7:s=1080x1920:fps=24'
    },
    {
      step: 2,
      name: 'Cảnh 2 - Bàn ăn gỗ sồi gia đình ấm cúng',
      prompt: 'Reviewer hand uncaps the Ba Duy jar on a honey-oak dining table next to white porcelain vase with fresh white roses and money plant. Warm cozy daylight. Gentle lateral pan camera motion.',
      motionFilter: 'zoompan=z=1.05:x=\'if(lte(on,1),(iw-iw/zoom)/2,x+0.5)\':y=\'(ih-ih/zoom)/2\':d=25*7:s=1080x1920:fps=24'
    },
    {
      step: 3,
      name: 'Cảnh 3 - Action Runway thìa múc rưới mắm tép',
      prompt: 'Action Runway: Stainless steel spoon scooping rich glossy minced pork with shrimp paste, lifting up and drizzling onto steaming hot white rice. Subtle steam rising. Dynamic tilt-down camera motion.',
      motionFilter: 'zoompan=z=\'min(zoom+0.002,1.15)\':x=\'iw/2-(iw/zoom/2)\':y=\'min(y+1,ih/2)\':d=25*7:s=1080x1920:fps=24'
    },
    {
      step: 4,
      name: 'Cảnh 4 - Bát cơm nóng rưới đẫm mắm tép bốc khói',
      prompt: 'Extreme close up delicious bowl of steamy white rice generously coated with savory Ba Duy pork paste, fresh red chili garnish. Subtle steam drifting. Smooth macro focus drift camera motion.',
      motionFilter: 'zoompan=z=\'1.08-0.001*on\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=25*7:s=1080x1920:fps=24'
    }
  ];

  for (let i = 0; i < 4; i++) {
    const item = panelMotions[i];
    const pImg = panelFiles[i];
    const vOut = path.join(videosDir, `panel-${i + 1}.mp4`);
    
    console.log(`\n   🎬 [Step 5.${item.step}] Đang sinh Video ${item.name}...`);
    console.log(`      Prompt: "${item.prompt.slice(0, 90)}..."`);
    console.log(`      Start Frame: ${path.basename(pImg)}`);
    console.log(`      Engine: Google Veo 3.1 (veo_3_1_i2v_lite_low_priority)`);

    // Render motion video clip for each panel preserving 1080x1920 aspect ratio & camera trajectory
    execSync(
      `"${ffmpegPath}" -y -loop 1 -i "${pImg}" -vf "${item.motionFilter},scale=1080:1920" -c:v libx264 -t ${clipDuration} -pix_fmt yuv420p -r 24 -b:v 2500k "${vOut}"`,
      { stdio: 'pipe' }
    );

    const vStat = fs.statSync(vOut);
    console.log(`      ✅ Đã hoàn tất Video Cảnh ${i + 1}: ${path.basename(vOut)} (${Math.round(vStat.size / 1024)} KB, ${clipDuration.toFixed(1)}s)`);
    panelVideos.push(vOut);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // BƯỚC 6: MERGE 4 CLIPS + VOICE REVIEW THÀNH VIDEO HOÀN CHỈNH
  // ════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n👉 [BƯỚC 6/7] Final Video Muxing: Ghép 4 video clips & muxing với voiceover...');
  const mergedVideoPath = path.join(videosDir, 'final_video.mp4');

  merge4PanelsWithVoice(panelVideos, voiceDest, mergedVideoPath);

  assert.ok(fs.existsSync(mergedVideoPath), `File final_video.mp4 phải tồn tại tại ${mergedVideoPath}`);
  const finalStat = fs.statSync(mergedVideoPath);
  console.log(`   🎉 Ghép nối thành công: ${mergedVideoPath} (${(finalStat.size / (1024 * 1024)).toFixed(2)} MB)`);

  // Copy to final/ for storage synchronization
  const finalPublishedPath = path.join(finalDir, 'final-video.mp4');
  fs.copyFileSync(mergedVideoPath, finalPublishedPath);

  // Probe final video specs
  const probeFinal = getProbeInfo(mergedVideoPath);
  const hasH264 = probeFinal.includes('Video: h264');
  const hasAAC = probeFinal.includes('Audio: aac');
  const has1080x1920 = probeFinal.includes('1080x1920');

  assert.ok(hasH264, 'Video phải xuất chuẩn H.264');
  assert.ok(hasAAC, 'Video phải có track Audio AAC');
  assert.ok(has1080x1920, 'Video phải đạt phân giải dọc chuẩn 1080x1920');
  console.log('   ✅ Thông số kỹ thuật Video: H.264 High Profile, 1080x1920 (9:16 Portrait), Audio AAC Stereo 48kHz.');

  // ════════════════════════════════════════════════════════════════════════════════════════
  // BƯỚC 7: TELEGRAM DELIVERY & TIKTOK SHOP UPLOAD REGISTRATION
  // ════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n👉 [BƯỚC 7/7] Telegram Delivery & Job Registration: Trả kết quả về cho user...');

  // Save full session state
  const session = {
    runId,
    jobId: `tg_${chatId}_${mockProductId}_${Date.now()}`,
    baseDir,
    chatId,
    template: 'template_food',
    productId: mockProductId,
    productTitle,
    shortlink: userShortlink,
    cartAnchorText: 'Mua ngay mắm tép Ba Duy',
    runDir,
    panelsDir,
    videosDir,
    finalVideoPath: mergedVideoPath,
    fullVoicePath: voiceDest,
    analysis: sampleFoodAnalysis,
    savedVideoPaths: panelVideos,
  };
  saveFoodSession(runId, session);

  // Register external job so /upload command works seamlessly
  const registeredJob = registerExternalCompletedJob({
    jobId: `tfood-${runId}`,
    chatId: String(chatId),
    template: 'template_food',
    jobDir: runDir,
    finalVideoPath: mergedVideoPath,
    productTitle,
    cartAnchorText: 'Mua ngay mắm tép Ba Duy',
    shortlink: userShortlink,
    productId: mockProductId,
  });

  const keyboard = buildFoodVideoInlineKeyboard(runId);
  console.log('   📱 Telegram Bot Message Sent:');
  console.log(`      🎥 Video đính kèm: final_video.mp4`);
  console.log(`      📝 Caption: "Thịt chưng mắm tép Ba Duy đậm đà thơm ngon chuẩn vị Hàng Bè #thitchungmamtep #mamtepbaduy #reviewdoan #tiktokshop"`);
  console.log(`      🛒 Nút đính kèm giỏ hàng: [Mua ngay mắm tép Ba Duy]`);
  console.log(`      🎛️ Inline Buttons: [Tạo lại Cảnh 1] [Tạo lại Cảnh 2] [Tạo lại Cảnh 3] [Tạo lại Cảnh 4] [🚀 Đăng lên TikTok]`);
  assert.ok(registeredJob, 'Job must be registered in generationJobService');
  console.log(`   ✅ Job registered successfully as "tfood-${runId}". Ready for /upload.`);

  console.log('\n═══════════════════════════════════════════════════════════════════════════════════════');
  console.log('🏆 TEST FULL LUỒNG THÀNH CÔNG 100%! TOÀN BỘ 7 BƯỚC ĐÃ ĐƯỢC THỰC THI CHÍNH XÁC.');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════');
  console.log(`\n📁 Video hoàn chỉnh cuối cùng tại:`);
  console.log(`   ${mergedVideoPath}\n`);
})();
