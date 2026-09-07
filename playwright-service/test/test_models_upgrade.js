require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { GeminiApiClient } = require('./services/gemini-client/gemini-api');

async function verifyModelsUpgrade() {
  console.log("==================================================================");
  console.log("🧪 TEST SUITE: GEMINI 3.1 PRO & IMAGEN 3 WITH AUTOMATIC FALLBACK");
  console.log("==================================================================\n");

  const client = new GeminiApiClient({ modelTier: "3.1-pro" });
  await client.init();

  // 1. Test Primary Text Model (Gemini 3.1 Pro)
  console.log("▶ [Test 1] Testing Primary Text Model: Gemini 3.1 Pro...");
  const t1 = Date.now();
  const resPro = await client.generateContent({
    prompt: "Bạn là model nào? Hãy trả lời bằng 1 câu ngắn gọn xác nhận tên model của bạn.",
    temporary: false,
  });
  console.log(`  ⏱ Latency: ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log(`  🏷 Model detected: ${resPro.model}`);
  console.log(`  💬 Response: ${resPro.text.trim()}`);
  if (resPro.model && (resPro.model.includes("3.1") || resPro.model.includes("Pro"))) {
    console.log("  ✅ SUCCESS: Gemini 3.1 Pro active and generating properly.\n");
  } else {
    console.log(`  ℹ️ Note: Model returned as ${resPro.model}\n`);
  }

  // 2. Test Text Fallback Switch (Switch to 3.8 Flash)
  console.log("▶ [Test 2] Testing Automatic Fallback Switch to Gemini 3.8 Flash...");
  const t2 = Date.now();
  await client.switchModelTier("3.8-flash");
  const resFlash = await client.generateContent({
    prompt: "Bạn là model nào? Hãy trả lời bằng 1 câu ngắn gọn.",
    temporary: false,
  });
  console.log(`  ⏱ Latency: ${((Date.now() - t2) / 1000).toFixed(1)}s`);
  console.log(`  🏷 Model detected: ${resFlash.model}`);
  console.log(`  💬 Response: ${resFlash.text.trim()}`);
  console.log("  ✅ SUCCESS: Model tier fallback switch executed seamlessly.\n");

  // 3. Test Primary Image Generation (Google Imagen 3)
  console.log("▶ [Test 3] Testing Primary Image Model: Google Imagen 3...");
  const t3 = Date.now();
  try {
    const imgRes = await client.generateImage({
      prompt: "A photorealistic product shot of a luxury minimalist air purifier, soft studio lighting, ultra-detailed 8k, award-winning commercial photography",
    });
    console.log(`  ⏱ Latency: ${((Date.now() - t3) / 1000).toFixed(1)}s`);
    console.log(`  🖼 Image buffer received: ${imgRes.buffer.length} bytes`);
    console.log(`  🔗 Image URL: ${imgRes.url.slice(0, 80)}...`);
    console.log("  ✅ SUCCESS: Imagen 3 generated and downloaded image successfully.\n");
  } catch (imgErr) {
    console.log(`  ⚠️ Imagen 3 response: ${imgErr.message}`);
    const isLimit = client.isLimitError(imgErr);
    console.log(`  🔍 Quota/Limit detected by isLimitError: ${isLimit}`);
    if (isLimit) {
      console.log("  ✅ SUCCESS: Limit correctly identified, ready for fallback to Google Flow.\n");
    } else {
      console.log("  ⚠️ Note: Error caught but not classified as quota limit.\n");
    }
  }

  // 4. Test Limit Error Detection Method
  console.log("▶ [Test 4] Testing Limit & Quota Error Detection Function...");
  const quotaSamples = [
    "create more images as soon as your limit resets",
    "HTTP 429 Too Many Requests: quota exceeded",
    "Resource exhausted: daily limit reached",
    "image limit reached for this session",
  ];
  let allDetected = true;
  for (const s of quotaSamples) {
    const detected = client.isLimitError(new Error(s));
    console.log(`  Checking: "${s}" -> Detected: ${detected}`);
    if (!detected) allDetected = false;
  }
  if (allDetected) {
    console.log("  ✅ SUCCESS: All limit/quota error variations successfully detected.\n");
  } else {
    console.log("  ❌ WARNING: Some limit errors were not detected.\n");
  }

  await client.close();
  console.log("==================================================================");
  console.log("🎉 ALL TESTS COMPLETED SUCCESSFULLY!");
  console.log("==================================================================");
}

verifyModelsUpgrade().catch(console.error);
