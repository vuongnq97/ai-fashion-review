'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const axios = require('axios');
const { execSync } = require('child_process');

let ffmpegPath = 'ffmpeg';
try {
  ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
} catch (_) {
  try {
    ffmpegPath = require('/Users/macbook_196/Workspace/something/playwright-service/node_modules/ffmpeg-static') || 'ffmpeg';
  } catch (__) {
    ffmpegPath = 'ffmpeg';
  }
}

/**
 * Danh sách model TTS theo thứ tự ưu tiên (Primary -> Fallbacks)
 */
const TTS_MODELS_FALLBACK = [
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts',
];

/**
 * Danh sách API key/token dự phòng cho Gemini TTS khi gặp rate limit hoặc hết quota.
 * Ưu tiên cấu hình trong .env qua GEMINI_TTS_FALLBACK_KEYS.
 */
const DEFAULT_TTS_TOKENS = [
  // KHÔNG hardcode key ở đây. Khai báo trong .env: GEMINI_TTS_FALLBACK_KEYS=key1,key2,...
];

// Lưu index của token đang hoạt động tốt nhất trong runtime
let activeTokenIndex = 0;

/**
 * Lấy danh sách các tokens khả dụng theo thứ tự ưu tiên
 * @param {object} [options]
 * @returns {string[]}
 */
function resolveTtsTokens(options = {}) {
  // Nếu truyền mảng apiKeys cụ thể (vd: trong unit test), ưu tiên trả về danh sách đó
  if (Array.isArray(options.apiKeys) && options.apiKeys.length > 0) {
    return Array.from(new Set(options.apiKeys.map(t => String(t || '').trim()).filter(Boolean)));
  }

  const tokenList = [];

  if (options.apiKey) {
    tokenList.push(options.apiKey);
  }

  // Nếu cờ disableFallbackTokens được bật (thường dùng trong unit test), chỉ dùng tokens truyền vào
  if (options.disableFallbackTokens) {
    return Array.from(new Set(tokenList.map(t => String(t || '').trim()).filter(Boolean)));
  }

  // Key chính trong file .env
  const primaryEnvKey = (process.env.GEMINI_API_KEY || '').trim();
  if (primaryEnvKey) {
    tokenList.push(primaryEnvKey);
  }

  // Lấy danh sách token dự phòng từ biến môi trường nếu có
  const envFallback = process.env.GEMINI_TTS_FALLBACK_KEYS || process.env.GEMINI_API_KEYS || '';
  if (envFallback) {
    tokenList.push(...envFallback.split(',').map(s => s.trim()).filter(Boolean));
  }

  // Danh sách default fallback tokens do user cung cấp
  tokenList.push(...DEFAULT_TTS_TOKENS);

  return Array.from(new Set(tokenList.map(t => String(t || '').trim()).filter(Boolean)));
}

function getActiveTokenIndex() {
  return activeTokenIndex;
}

function setActiveTokenIndex(index) {
  activeTokenIndex = Math.max(0, parseInt(index || 0, 10));
}

/**
 * Hàm gắn RIFF/WAVE header chuẩn cho dữ liệu PCM 24kHz từ Gemini
 * Cho phép mở file trực tiếp trên CapCut, Premiere, hoặc trình nghe nhạc
 * @param {Buffer} pcmData - Dữ liệu raw PCM 24000Hz s16le mono
 * @param {number} [sampleRate=24000] - Tần số lấy mẫu (mặc định 24kHz)
 * @param {number} [channels=1] - Kênh âm thanh (1 = mono)
 * @param {number} [bitDepth=16] - Độ sâu bit (16-bit)
 * @returns {Buffer} Buffer WAV hoàn chỉnh có header chuẩn RIFF WAVE
 */
function pcmToWav(pcmData, sampleRate = 24000, channels = 1, bitDepth = 16) {
  const header = Buffer.alloc(44);
  const dataSize = pcmData.length;
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmData]);
}

/**
 * Xây dựng prompt chỉ dẫn tốc độ và ngữ điệu để căn đúng 65 từ / 16 giây
 * @param {object} analysisData - Dữ liệu phân tích sản phẩm (productName, script, voicePersona...)
 * @param {object} [options] - Tùy chọn bổ sung (voice, customInstruction...)
 * @returns {{ prompt: string, voice: string, scriptText: string }} Prompt hoàn chỉnh và giọng đọc tương ứng
 */
function buildGeminiTtsPrompt(analysisData = {}, options = {}) {
  const prodName = analysisData.productName || 'sản phẩm';

  // Chỉ sử dụng giọng nữ: Mặc định Zephyr (Hà Vy GenZ) hoặc từ biến môi trường/options
  const defaultVoice = process.env.GEMINI_TTS_DEFAULT_VOICE || 'Zephyr';
  const voice = options.voice || defaultVoice;

  // Trích xuất các câu thoại từ 4 cảnh (hỗ trợ cả analysisData.script và analysisData.scenes)
  const scriptItems = Array.isArray(analysisData.script)
    ? analysisData.script
    : (Array.isArray(analysisData.scenes) ? analysisData.scenes : []);
  const s1 = (scriptItems[0]?.voiceOver || scriptItems[0]?.voiceScript || '').trim();
  const s2 = (scriptItems[1]?.voiceOver || scriptItems[1]?.voiceScript || '').trim();
  const s3 = (scriptItems[2]?.voiceOver || scriptItems[2]?.voiceScript || '').trim();
  const s4 = (scriptItems[3]?.voiceOver || scriptItems[3]?.voiceScript || '').trim();

  let scriptText = '';
  if (s1 || s2 || s3 || s4) {
    scriptText = [s1, s2, s3, s4].filter(Boolean).join(' ');
  } else if (options.rawScript) {
    scriptText = options.rawScript.trim();
  } else {
    scriptText = `Trời ơi mọi người ơi, lướt tóp tóp thấy em ${prodName} này rần rần bữa giờ nên tui phải săn ngay về test thử cho cả nhà đây! Đập hộp ra nhìn cái packing thôi là thấy ưng bụng liền rồi đó, cưng xỉu luôn á! Chất liệu xịn xò, xài thử êm ru tiện lợi vô cùng. Chấm 9 trên 10 điểm, mọi người săn liền nha!`;
  }

  // Prompt chỉ dẫn tốc độ và ngữ điệu để căn đúng 65-70 từ (min 65, max 70 từ) / 16 giây chuẩn TikTok GenZ (Thuần giọng nữ)
  const targetUser = analysisData.targetUser || '';
  const buyerAngle = analysisData.buyerAngle || '';
  let personaInstruction = 'Giọng nữ GenZ Hà Vy cực kỳ hào hứng, tự nhiên, nhịp điệu dồn dập bắt trend TikTok';

  if (buyerAngle === 'gift_for_partner') {
    personaInstruction += ', góc nhìn tinh tế tâm lý khi sắm quà cho người thương';
  } else if (buyerAngle === 'for_kids' || /bé|trẻ em/i.test(targetUser)) {
    personaInstruction += ', góc nhìn chăm sóc bé an toàn, tươi vui, gần gũi';
  } else if (buyerAngle === 'for_parents' || /bố mẹ|ông bà|người lớn/i.test(targetUser)) {
    personaInstruction += ', góc nhìn con cái hiếu thảo, êm ái, chu đáo';
  }

  const prompt = `[Chỉ dẫn ngữ điệu & tốc độ: ${personaInstruction}. Tốc độ đọc nhanh, phát âm dứt khoát, không kéo dài nguyên âm, đọc toàn bộ kịch bản 65 đến 70 từ này (tối thiểu 65 từ, tối đa 70 từ) trong đúng 15 đến 16 giây]:\n${scriptText}`;

  return {
    prompt,
    voice,
    scriptText,
    toString: () => prompt,
    valueOf: () => prompt,
  };
}

/**
 * Gọi API Gemini TTS qua REST API chính thức với cơ chế tự động thử lại (Retry) và chuyển sang model dự phòng (Fallback Chain)
 * @param {string|object} promptText - Nội dung prompt chỉ dẫn ngữ điệu & kịch bản (hoặc object từ buildGeminiTtsPrompt)
 * @param {object} [options] - Tùy chọn (apiKey, voice, models, maxRetriesPerModel)
 * @returns {Promise<{ pcmBuffer: Buffer, modelUsed: string, voiceUsed: string, latencyMs: number, durationSec: number }>}
 */
async function generateSpeechWithGemini(promptText, options = {}) {
  const tokens = resolveTtsTokens(options);
  if (!tokens || tokens.length === 0) {
    throw new Error('GEMINI_API_KEY is not configured in .env or options!');
  }

  const actualPrompt = (typeof promptText === 'object' && promptText?.prompt) ? promptText.prompt : String(promptText);
  const voice = options.voice || (typeof promptText === 'object' && promptText?.voice) || process.env.GEMINI_TTS_DEFAULT_VOICE || 'Zephyr';
  const models = Array.isArray(options.models) && options.models.length > 0
    ? options.models
    : TTS_MODELS_FALLBACK;

  const maxRetries = Math.max(1, parseInt(options.maxRetriesPerModel || '3', 10));
  const maxCycles = Math.max(1, parseInt(options.maxTokenCycles || (options.disableFallbackTokens ? 1 : 2), 10));
  let lastError = null;
  const totalTokens = tokens.length;

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    if (cycle > 1) {
      console.log(`[GeminiTTS] 🔄 Limit hết ${totalTokens} tokens, đang quay vòng chạy lại từ đầu (Vòng ${cycle}/${maxCycles})... Chờ 4s để hồi phục quota...`);
      await new Promise(r => setTimeout(r, 4000));
      activeTokenIndex = 0; // Reset chạy lại từ đầu
    }

    for (let tOffset = 0; tOffset < totalTokens; tOffset++) {
      const currentTokenIdx = (activeTokenIndex + tOffset) % totalTokens;
      const currentApiKey = tokens[currentTokenIdx];
      const maskedKey = currentApiKey.length > 10
        ? `${currentApiKey.slice(0, 6)}...${currentApiKey.slice(-4)}`
        : '***';

      console.log(`[GeminiTTS] 🔑 Using API Token [${currentTokenIdx + 1}/${totalTokens}] (${maskedKey})...`);

      for (const model of models) {
        console.log(`[GeminiTTS] 🎙️ Trying TTS model: "${model}" (Voice: "${voice}", Token: ${maskedKey})...`);

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          const startTime = Date.now();
          try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentApiKey}`;
            const body = {
              contents: [
                {
                  parts: [
                    { text: actualPrompt }
                  ]
                }
              ],
              generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: {
                      voiceName: voice
                    }
                  }
                }
              }
            };

            const agent = new https.Agent({ rejectUnauthorized: false });
            const res = await axios.post(url, body, {
              headers: { 'Content-Type': 'application/json' },
              httpsAgent: agent,
              timeout: 45000,
            });

            const audioBase64 = res.data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (!audioBase64) {
              const errMsg = res.data?.error?.message || (res.data?.candidates?.[0]?.finishReason ? `Finish reason: ${res.data.candidates[0].finishReason}` : 'No audio data in candidates[0].content.parts[0].inlineData.data');
              throw new Error(errMsg);
            }

            const pcmBuffer = Buffer.from(audioBase64, 'base64');
            const latencyMs = Date.now() - startTime;
            const durationSec = parseFloat((pcmBuffer.length / 48000).toFixed(2));
            console.log(`[GeminiTTS] ✅ Successfully generated audio via "${model}" (token [${currentTokenIdx + 1}/${totalTokens}] ${maskedKey}) in ${(latencyMs / 1000).toFixed(2)}s (~${durationSec}s audio, ${(pcmBuffer.length / 1024).toFixed(1)} KB PCM)`);

            // Ghi nhận token thành công để duy trì cho các lần gọi sau
            activeTokenIndex = currentTokenIdx;

            return {
              pcmBuffer,
              modelUsed: model,
              voiceUsed: voice,
              tokenUsed: maskedKey,
              latencyMs,
              durationSec,
            };
          } catch (err) {
            lastError = err;
            const status = err.response?.status;
            const errMsg = err.response?.data?.error?.message || err.message;
            console.warn(`[GeminiTTS] ⚠️ Token ${maskedKey} - Model "${model}" attempt ${attempt}/${maxRetries} failed: ${errMsg}`);

            // Nếu dính lỗi Quota/Limit (429 hoặc Resource Exhausted), bỏ qua các lần retry vô ích trên model này
            const isQuotaExceeded = status === 429 || /quota|resource_exhausted|rate limit/i.test(errMsg);
            if (isQuotaExceeded) {
              console.warn(`[GeminiTTS] ⚠️ Model "${model}" hit quota limit on token ${maskedKey}. Moving to next option...`);
              break;
            }

            if (attempt < maxRetries) {
              const delay = attempt * 1500;
              await new Promise(r => setTimeout(r, delay));
            }
          }
        }

        console.warn(`[GeminiTTS] 🔄 Model "${model}" failed on token ${maskedKey}. Trying next model...`);
      }

      // Khi token này thất bại, chuyển activeTokenIndex sang token kế tiếp (xoay vòng về 0 khi hết 10 tokens)
      activeTokenIndex = (currentTokenIdx + 1) % totalTokens;

      if (totalTokens > 1) {
        const nextMasked = tokens[activeTokenIndex].length > 10
          ? `${tokens[activeTokenIndex].slice(0, 6)}...${tokens[activeTokenIndex].slice(-4)}`
          : '***';
        console.warn(`[GeminiTTS] ⚠️ All models failed for token [${currentTokenIdx + 1}/${totalTokens}] (${maskedKey}). Falling back to next token [${activeTokenIndex + 1}/${totalTokens}] (${nextMasked})...`);
      }
    }
  }

  // Nếu đã thử qua toàn bộ các vòng và limit hết 10 tokens, reset lại từ đầu (token 1) cho các request tiếp theo
  activeTokenIndex = 0;

  throw new Error(`All TTS models across all ${totalTokens} tokens in fallback chain failed! Last error: ${lastError?.response?.data?.error?.message || lastError?.message || 'Unknown'}`);
}

/**
 * Chuyển đổi dữ liệu PCM thô (24kHz mono s16le) sang chuẩn M4A/AAC (48kHz stereo) và căn chỉnh thời lượng
 * @param {Buffer} pcmBuffer - Dữ liệu raw PCM 24000Hz s16le mono
 * @param {string} outM4aPath - Đường dẫn lưu file M4A đích
 * @param {number} [targetDuration=16.0] - Thời lượng mục tiêu cần căn chỉnh (mặc định 16 giây)
 * @param {object} [options] - Tùy chọn (pitchShift, speed...)
 * @returns {string} Đường dẫn file m4a đã tạo
 */
function convertPcmToM4a(pcmBuffer, outM4aPath, targetDuration = 16.0, options = {}) {
  const tempPcmPath = path.join(os.tmpdir(), `tts_${Date.now()}_${Math.random().toString(36).slice(2)}.pcm`);
  fs.writeFileSync(tempPcmPath, pcmBuffer);

  const outDir = path.dirname(outM4aPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  try {
    // 1. Chuyển đổi PCM 24kHz mono sang AAC 48kHz stereo
    const tempM4a = path.join(os.tmpdir(), `tts_temp_${Date.now()}.m4a`);
    execSync(`"${ffmpegPath}" -y -f s16le -ar 24000 -ac 1 -i "${tempPcmPath}" -c:a aac -b:a 192k -ar 48000 -ac 2 "${tempM4a}"`, { stdio: 'ignore' });

    // 2. Đo thời lượng thực tế
    let duration = 0;
    try {
      const probe = execSync(`"${ffmpegPath}" -i "${tempM4a}" 2>&1`, { stdio: 'pipe' }).toString();
      const match = probe.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
      if (match) {
        duration = parseFloat(match[1]) * 3600 + parseFloat(match[2]) * 60 + parseFloat(match[3]);
      }
    } catch (_) {}

    // 2B. Nếu ưu tiên giữ nguyên thời lượng tự nhiên của voice (preserveAudioDuration)
    if (options.preserveAudioDuration) {
      fs.copyFileSync(tempM4a, outM4aPath);
      try { fs.unlinkSync(tempM4a); } catch (_) {}
      return outM4aPath;
    }

    // 3. Nếu chênh lệch so với targetDuration (16.0s), dùng apad / atempo để căn chỉnh mượt mà
    const pitchFactor = typeof options.pitchShift === 'number'
      ? options.pitchShift
      : (process.env.GEMINI_TTS_PITCH_SHIFT ? parseFloat(process.env.GEMINI_TTS_PITCH_SHIFT) : 1.0);

    if (targetDuration && targetDuration > 0) {
      if (duration > targetDuration + 0.1) {
        const speed = Math.max(1.0, Math.min(2.0, duration / targetDuration));
        if (pitchFactor && pitchFactor > 0 && Math.abs(pitchFactor - 1.0) > 0.005) {
          const totalAtempo = Math.max(0.5, Math.min(2.0, speed / pitchFactor));
          execSync(`"${ffmpegPath}" -y -i "${tempM4a}" -filter:a "asetrate=48000*${pitchFactor.toFixed(3)},atempo=${totalAtempo.toFixed(4)}" -t ${targetDuration} -c:a aac -b:a 192k -ar 48000 -ac 2 "${outM4aPath}"`, { stdio: 'ignore' });
        } else {
          execSync(`"${ffmpegPath}" -y -i "${tempM4a}" -filter:a "atempo=${speed.toFixed(3)}" -t ${targetDuration} -c:a aac -b:a 192k -ar 48000 -ac 2 "${outM4aPath}"`, { stdio: 'ignore' });
        }
      } else {
        if (pitchFactor && pitchFactor > 0 && Math.abs(pitchFactor - 1.0) > 0.005) {
          const totalAtempo = (1 / pitchFactor).toFixed(4);
          execSync(`"${ffmpegPath}" -y -i "${tempM4a}" -filter:a "asetrate=48000*${pitchFactor.toFixed(3)},atempo=${totalAtempo},apad=whole_dur=${targetDuration}" -t ${targetDuration} -c:a aac -b:a 192k -ar 48000 -ac 2 "${outM4aPath}"`, { stdio: 'ignore' });
        } else {
          execSync(`"${ffmpegPath}" -y -i "${tempM4a}" -af "apad=whole_dur=${targetDuration}" -t ${targetDuration} -c:a aac -b:a 192k -ar 48000 -ac 2 "${outM4aPath}"`, { stdio: 'ignore' });
        }
      }
    } else {
      fs.copyFileSync(tempM4a, outM4aPath);
    }

    try { fs.unlinkSync(tempM4a); } catch (_) {}
  } finally {
    try { fs.unlinkSync(tempPcmPath); } catch (_) {}
  }

  return outM4aPath;
}

/**
 * Hàm tích hợp cấp cao cho Template Pro: Sinh file voice review 16s qua Gemini TTS
 * Đồng thời xuất cả file .wav chuẩn RIFF 24kHz và file .m4a 48kHz đồng bộ thời lượng 16s
 * @param {object} analysisData - Dữ liệu phân tích sản phẩm từ Bước 1
 * @param {string} outVoicePath - Đường dẫn file m4a hoàn chỉnh (audio/voice_full.m4a)
 * @param {object} [options] - Tùy chọn (voice, targetDuration: 16.0)
 * @returns {Promise<{ success: boolean, voicePath: string, audioPath: string, wavPath: string, modelUsed: string, voiceUsed: string, latencyMs: number }>}
 */
async function generateTemplateProVoiceReview(analysisData, outVoicePath, options = {}) {
  const voice = options.voice || process.env.GEMINI_TTS_DEFAULT_VOICE || 'Zephyr';
  const targetDuration = options.targetDuration || 16.0;

  console.log(`[TemplatePro] 🎙️ Generating 16s Voice Review via Gemini TTS (Voice: "${voice}")...`);
  const ttsPrompt = buildGeminiTtsPrompt(analysisData, { ...options, voice });

  try {
    const res = await generateSpeechWithGemini(ttsPrompt, { ...options, voice });

    // 1. Xuất file WAV 24kHz bằng pcmToWav (dùng cho CapCut / Premiere / nghe trực tiếp)
    const outWavPath = outVoicePath.replace(/\.[^.]+$/, '.wav');
    const wavBuffer = pcmToWav(res.pcmBuffer, 24000, 1, 16);
    fs.writeFileSync(outWavPath, wavBuffer);

    // 2. Chuyển đổi sang chuẩn M4A để mux vào video 16s
    convertPcmToM4a(res.pcmBuffer, outVoicePath, targetDuration, options);

    console.log(`[TemplatePro] 🎉 Voice Review successfully created:`);
    console.log(`  * M4A track: ${outVoicePath}`);
    console.log(`  * WAV track: ${outWavPath} (${(wavBuffer.length / 1024).toFixed(1)} KB)`);

    return {
      success: true,
      voicePath: outVoicePath,
      audioPath: outVoicePath,
      wavPath: outWavPath,
      modelUsed: res.modelUsed,
      voiceUsed: res.voiceUsed,
      tokenUsed: res.tokenUsed,
      latencyMs: res.latencyMs,
      prompt: ttsPrompt,
    };
  } catch (err) {
    console.error(`[TemplatePro] ❌ Gemini TTS failed: ${err.message}. Falling back to emergency audio track.`);
    // Fallback khẩn cấp: Sinh file âm thanh im lặng 16s để pipeline không bị crash
    try {
      const outDir = path.dirname(outVoicePath);
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      execSync(`"${ffmpegPath}" -y -f lavfi -i anullsrc=r=48000:cl=stereo -t ${targetDuration} -c:a aac -b:a 192k "${outVoicePath}"`, { stdio: 'ignore' });
    } catch (_) {}

    return {
      success: false,
      voicePath: outVoicePath,
      audioPath: outVoicePath,
      error: err.message,
      prompt: ttsPrompt,
    };
  }
}

/**
 * Xây dựng prompt đạo diễn TTS chuyên biệt cho Kênh Food Review (24s / 4 cảnh 6s)
 * Áp dụng đúng đặc tả Section 29 trong FOOD_REVIEW_TEMPLATE_PRO_MIGRATION_SPEC.md
 * @param {object} analysisData - Dữ liệu phân tích sản phẩm và kịch bản 4 cảnh
 * @param {object} [options] - Tùy chọn (voice, rawScript...)
 * @returns {{ prompt: string, voice: string, scriptText: string }}
 */
function buildFoodReviewTtsPrompt(analysisData = {}, options = {}) {
  const prodName = analysisData.productName || 'món này';
  const defaultVoice = process.env.GEMINI_TTS_FOOD_VOICE || process.env.GEMINI_TTS_DEFAULT_VOICE || 'Zephyr';
  const voice = options.voice || defaultVoice;

  const scriptItems = Array.isArray(analysisData.script)
    ? analysisData.script
    : (Array.isArray(analysisData.scenes) ? analysisData.scenes : []);

  const s1 = (scriptItems[0]?.voiceOver || scriptItems[0]?.voiceScript || '').trim();
  const s2 = (scriptItems[1]?.voiceOver || scriptItems[1]?.voiceScript || '').trim();
  const s3 = (scriptItems[2]?.voiceOver || scriptItems[2]?.voiceScript || '').trim();
  const s4 = (scriptItems[3]?.voiceOver || scriptItems[3]?.voiceScript || '').trim();

  let scriptText = '';
  if (s1 || s2 || s3 || s4) {
    scriptText = [s1, s2, s3, s4].filter(Boolean).join(' ');
  } else if (options.rawScript) {
    scriptText = options.rawScript.trim();
  } else {
    scriptText = `Lần đầu tui thấy ${prodName} này nên mua thử coi sao nè. Cầm lên khá chắc tay, một bịch nhìn đầy đặn chứ không bị ít. Bẻ đôi ra mới thấy bên trong nó mềm dẻo, nhìn cái ruột là muốn ăn liền. Vị khá vừa miệng béo thơm nhẹ, ăn vặt nhâm nhi thì đúng bài, ai mê kiểu này thử nghen.`;
  }

  const prompt = [
    `### AUDIO PROFILE`,
    ``,
    `You are a young Vietnamese female food reviewer.`,
    `Your voice is bright, warm, friendly and naturally expressive.`,
    `Your conversational style is Southern Vietnamese with a subtle Mekong Delta flavor.`,
    `You sound like a real person showing a snack, local specialty, dessert, food or drink she has just bought and is genuinely trying.`,
    `You are NOT a commercial announcer.`,
    `You are NOT a professional food critic.`,
    `You are NOT an aggressive affiliate salesperson.`,
    `Use a natural vocal smile.`,
    ``,
    `### SCENE`,
    ``,
    `You are filming a short vertical food-review video on your phone.`,
    `The food is physically in front of you.`,
    `While speaking, you may be opening it, holding it toward the camera, breaking it, pulling it, showing the filling, dipping it, pouring it, or tasting it.`,
    `Your reaction should sound synchronized with the physical action.`,
    ``,
    `### LANGUAGE CHARACTER`,
    ``,
    `Speak natural Vietnamese.`,
    `Use casual Southern Vietnamese sentence construction with a subtle Mekong Delta conversational flavor.`,
    `Keep the pronoun system stable. Default self-reference is "tui" when self-reference is needed.`,
    `Use audience addresses such as "cả nhà", "mọi người", "mấy bạn", or "ai..." sparingly and naturally.`,
    `Conversational particles such as "nè", "nha", "nghen", "á", "chứ", "ha/hen" may appear naturally when appropriate.`,
    `Never stuff regional particles into every sentence. Never exaggerate the dialect.`,
    ``,
    `### DIRECTOR'S NOTES`,
    ``,
    `Energy: 7/10. Excitement: 6.5/10. Warmth: 8/10. Friendliness: 9/10. Sales pressure: 3/10.`,
    `Vocal smile: noticeable but natural.`,
    `Pacing: Fast conversational. Target approximately 3.8–4.3 Vietnamese words per second. Total spoken audio duration must fit exactly around 22.5 to 24.0 seconds.`,
    `Keep the delivery flowing. Use short thought groups. Use very short micro-pauses. Avoid long pauses.`,
    `Prosody: Frequent small pitch changes. Emphasize sensory words naturally. React slightly more when the visual reveals texture, filling or an unexpected detail.`,
    `Articulation: Clear but conversational. Never over-enunciate like a presenter.`,
    `Do NOT: shout, sound like a TV commercial, sound like a newsreader, sound like an audiobook, sound excessively cute, use fake laughter, overstretch vowels, insert theatrical pauses, sound desperate to sell.`,
    `Most importantly: sound like you are genuinely looking at, touching and tasting the food while talking to viewers.`,
    ``,
    `### TRANSCRIPT`,
    ``,
    scriptText
  ].join('\n');

  return {
    prompt,
    voice,
    scriptText,
    toString: () => prompt,
    valueOf: () => prompt,
  };
}

/**
 * Hàm tích hợp cho Kênh Food Review: Sinh file voice review 24s qua Gemini TTS
 * Xuất cả file .wav chuẩn RIFF 24kHz và file .m4a 48kHz đồng bộ thời lượng 24s
 * @param {object} analysisData - Dữ liệu phân tích món ăn từ Bước 1
 * @param {string} outVoicePath - Đường dẫn file m4a hoàn chỉnh (audio/voice_full.m4a)
 * @param {object} [options] - Tùy chọn (voice, targetDuration: 24.0)
 * @returns {Promise<{ success: boolean, voicePath: string, audioPath: string, wavPath: string, modelUsed: string, voiceUsed: string, latencyMs: number }>}
 */
async function generateTemplateFoodVoiceReview(analysisData, outVoicePath, options = {}) {
  const voice = options.voice || process.env.GEMINI_TTS_FOOD_VOICE || process.env.GEMINI_TTS_DEFAULT_VOICE || 'Zephyr';
  const targetDuration = options.targetDuration || 24.0;

  console.log(`[TemplateFood] 🎙️ Generating 24s Food Review Voice via Gemini TTS (Voice: "${voice}")...`);
  const ttsPrompt = buildFoodReviewTtsPrompt(analysisData, { ...options, voice });

  try {
    const res = await generateSpeechWithGemini(ttsPrompt, { ...options, voice });

    // 1. Xuất file WAV 24kHz
    const outWavPath = outVoicePath.replace(/\.[^.]+$/, '.wav');
    const wavBuffer = pcmToWav(res.pcmBuffer, 24000, 1, 16);
    fs.writeFileSync(outWavPath, wavBuffer);

    // 2. Chuyển đổi sang chuẩn M4A để mux vào video 24s (ưu tiên giữ nguyên thời lượng tự nhiên của voice)
    convertPcmToM4a(res.pcmBuffer, outVoicePath, targetDuration, { preserveAudioDuration: true, ...options });

    console.log(`[TemplateFood] 🎉 Food Voice Review successfully created:`);
    console.log(`  * M4A track: ${outVoicePath}`);
    console.log(`  * WAV track: ${outWavPath} (${(wavBuffer.length / 1024).toFixed(1)} KB)`);

    return {
      success: true,
      voicePath: outVoicePath,
      audioPath: outVoicePath,
      wavPath: outWavPath,
      modelUsed: res.modelUsed,
      voiceUsed: res.voiceUsed,
      tokenUsed: res.tokenUsed,
      latencyMs: res.latencyMs,
      prompt: ttsPrompt,
    };
  } catch (err) {
    console.error(`[TemplateFood] ❌ Gemini TTS failed: ${err.message}. Falling back to emergency 24s audio track.`);
    try {
      const outDir = path.dirname(outVoicePath);
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      execSync(`"${ffmpegPath}" -y -f lavfi -i anullsrc=r=48000:cl=stereo -t ${targetDuration} -c:a aac -b:a 192k "${outVoicePath}"`, { stdio: 'ignore' });
    } catch (_) {}

    return {
      success: false,
      voicePath: outVoicePath,
      audioPath: outVoicePath,
      error: err.message,
      prompt: ttsPrompt,
    };
  }
}

module.exports = {
  TTS_MODELS_FALLBACK,
  DEFAULT_TTS_TOKENS,
  resolveTtsTokens,
  getActiveTokenIndex,
  setActiveTokenIndex,
  pcmToWav,
  buildGeminiTtsPrompt,
  buildFoodReviewTtsPrompt,
  generateSpeechWithGemini,
  convertPcmToM4a,
  generateTemplateProVoiceReview,
  generateTemplateFoodVoiceReview,
};
