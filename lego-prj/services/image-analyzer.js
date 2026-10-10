'use strict';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { proxyManager } = require('./proxy-manager');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FALLBACK_MODELS = ['gemini-3.5-flash-lite', 'gemini-flash-latest', 'gemini-3.5-flash', 'gemini-3.8-flash'];

/**
 * Helper trích xuất kích thước chuẩn xác từ văn bản (nếu có)
 */
function parseDimensionsString(str) {
  if (!str || typeof str !== 'string') return null;

  const heightMatch = str.match(/([\d.]+)\s*(?:in\.|inches|inch)?\s*\(([\d.]+)\s*cm\)\s*(?:high|tall)|([\d.]+)\s*cm\s*\(([\d.]+)\s*in\)?\s*(?:high|tall)/i) ||
                      str.match(/(?:stands? over|measures? over|standing over)\s*([\d.]+)\s*in\.\s*\(([\d.]+)\s*cm\)\s*tall/i) ||
                      str.match(/height[:\s]+([\d.]+)\s*(?:cm|in)?/i);

  const lengthMatch = str.match(/([\d.]+)\s*(?:in\.|inches|inch)?\s*\(([\d.]+)\s*cm\)\s*long/i) ||
                      str.match(/length[:\s]+([\d.]+)\s*(?:cm|in)?/i);

  const widthMatch = str.match(/([\d.]+)\s*(?:in\.|inches|inch)?\s*\(([\d.]+)\s*cm\)\s*wide/i) ||
                     str.match(/width[:\s]+([\d.]+)\s*(?:cm|in)?/i);

  const res = {
    rawText: str,
    height_cm: null,
    height_inch: null,
    length_cm: null,
    length_inch: null,
    width_cm: null,
    width_inch: null,
    formatted: ''
  };

  if (heightMatch) {
    res.height_inch = heightMatch[1] ? parseFloat(heightMatch[1]) : (heightMatch[4] ? parseFloat(heightMatch[4]) : null);
    res.height_cm = heightMatch[2] ? parseFloat(heightMatch[2]) : (heightMatch[3] ? parseFloat(heightMatch[3]) : null);
  }
  if (lengthMatch) {
    res.length_inch = parseFloat(lengthMatch[1]);
    res.length_cm = parseFloat(lengthMatch[2]);
  }
  if (widthMatch) {
    res.width_inch = parseFloat(widthMatch[1]);
    res.width_cm = parseFloat(widthMatch[2]);
  }

  const parts = [];
  if (res.height_cm) parts.push(`Cao: ${res.height_cm} cm${res.height_inch ? ` (${res.height_inch} in)` : ''}`);
  if (res.length_cm) parts.push(`Dài: ${res.length_cm} cm${res.length_inch ? ` (${res.length_inch} in)` : ''}`);
  if (res.width_cm) parts.push(`Rộng: ${res.width_cm} cm${res.width_inch ? ` (${res.width_inch} in)` : ''}`);

  res.formatted = parts.length > 0 ? parts.join(' | ') : str;
  return res;
}

/**
 * Phân tích danh sách ảnh đã tải về bằng Gemini Vision để chọn ra bộ ảnh đa góc (Multi-Angle) và kích thước
 * 
 * @param {string} productFolder - Đường dẫn thư mục chứa các ảnh tải về
 * @param {object|string} productInfo - Tên sản phẩm hoặc object metadata sản phẩm từ Walmart scraper
 * @returns {Promise<object>} Kết quả phân loại, kích thước và các góc được chọn
 */
async function analyzeAndSelectAngles(productFolder, productInfo = 'LEGO Model') {
  if (!fs.existsSync(productFolder)) {
    throw new Error(`Thư mục không tồn tại: ${productFolder}`);
  }

  const productName = typeof productInfo === 'object' ? (productInfo.name || 'LEGO Model') : productInfo;
  const dimensionsText = typeof productInfo === 'object' ? (productInfo.dimensionsText || null) : null;

  const files = fs.readdirSync(productFolder)
    .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
    .sort();

  if (files.length === 0) {
    throw new Error(`Không tìm thấy ảnh trong: ${productFolder}`);
  }

  console.log(`[ImageAnalyzer] 🔍 Đang chuẩn bị phân tích ${files.length} ảnh cho sản phẩm: "${productName}"...`);
  if (dimensionsText) {
    console.log(`[ImageAnalyzer] 📏 Thông tin kích thước từ nhà sản xuất: "${dimensionsText}"`);
  }

  // Chuẩn bị payload gửi Gemini Vision
  const parts = [];

  for (const filename of files) {
    const fullPath = path.join(productFolder, filename);
    const buf = fs.readFileSync(fullPath);
    parts.push({
      inlineData: {
        data: buf.toString('base64'),
        mimeType: 'image/jpeg'
      }
    });
    parts.push({
      text: `[Filename: ${filename}]`
    });
  }

  const promptText = `Bạn là chuyên gia phân tích 3D và thị giác máy tính chuyên về đồ chơi LEGO.
Hãy kiểm tra kỹ lưỡng ${files.length} bức ảnh được cung cấp của sản phẩm: "${productName}".

THÔNG TIN KÍCH THƯỚC SẢN PHẨM TỪ NHÀ SẢN XUẤT (NẾU CÓ):
"${dimensionsText || 'Chưa có chuỗi mô tả, hãy kiểm tra các ảnh bao bì/hộp/thước đo để trích xuất số đo'}"

MỤC TIÊU:
1. Xác định KÍCH THƯỚC CHUẨN XÁC của mô hình (Dimensions: Chiều cao, chiều dài, chiều rộng theo cm và inch).
2. CHỌN RA BỘ ẢNH ĐA GÓC (MULTI-ANGLE REFERENCE SET) gồm 2 đến 4 góc nhìn chuẩn xác nhất của MÔ HÌNH LẮP RÁP THẬT để phục vụ việc tạo video xoay 360 độ (không lấy người che, không lấy hộp carton).

QUY TẮC LỌC VÀ CHỌN GÓC:
1. "heroAngle" (Góc chính diện / 3/4 perspective): Ảnh toàn cảnh bao quát nhất của mô hình hoàn thiện, thấy rõ khuôn mặt/đầu và thân trước.
2. "altAngle" (Góc phụ - Mặt sau / Mặt bên): Ảnh thể hiện được phần lưng, đuôi, hông hoặc phía sau của mô hình.
3. "featureAngle" (Góc chi tiết / khớp động): Ảnh phóng to chi tiết, tính năng chuyển động (ví dụ: xoay đầu, mở cửa, cánh cử động).
4. "excluded": Các ảnh có người/trẻ em cầm che mất mô hình, sơ đồ kích thước thước đo, hoặc ảnh trùng lặp chất lượng kém.

Hãy trả về định dạng JSON thuần túy (không bọc markdown, không thêm giải thích ngoài JSON):
{
  "dimensions": {
    "height_cm": 27,
    "height_inch": 10.5,
    "width_cm": null,
    "width_inch": null,
    "length_cm": null,
    "length_inch": null,
    "formatted": "Cao: 27 cm (10.5 in)",
    "rawText": "${dimensionsText ? dimensionsText.replace(/"/g, '\\"') : ''}"
  },
  "analyzedImages": [
    {
      "filename": "tên_file.jpeg",
      "category": "hero_build | side_back_build | feature_detail | box_front | box_back | lifestyle_human | dimension_diagram",
      "angle": "front | three_quarters | side | back | close_up | n/a",
      "showsCompleteModel": true,
      "hasHumansOrHands": false,
      "description": "Mô tả ngắn gọn nội dung ảnh"
    }
  ],
  "selectedAngles": {
    "heroAngle": {
      "filename": "tên_file_1.jpeg",
      "reason": "Lý do chọn góc chính"
    },
    "altAngle": {
      "filename": "tên_file_2.jpeg",
      "reason": "Lý do chọn góc bên/sau"
    },
    "featureAngle": {
      "filename": "tên_file_3.jpeg",
      "reason": "Lý do chọn góc chi tiết"
    }
  },
  "legoVisualProfile": {
    "mainSubject": "Tên nhân vật / xe / công trình",
    "primaryColors": ["màu 1", "màu 2"],
    "keyStructuralFeatures": ["đặc điểm 1", "đặc điểm 2"]
  }
}`;

  parts.push({ text: promptText });

  const agent = proxyManager.getHttpsAgent();
  let responseData = null;

  for (const model of FALLBACK_MODELS) {
    try {
      console.log(`[ImageAnalyzer] 🚀 Đang gửi dữ liệu đến Gemini Vision API (${model})...`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await axios.post(url, {
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json'
        }
      }, {
        httpsAgent: agent,
        timeout: 60000
      });

      const rawText = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (rawText) {
        responseData = rawText;
        console.log(`[ImageAnalyzer] ✅ Phân tích thành công với model: ${model}`);
        break;
      }
    } catch (err) {
      console.warn(`[ImageAnalyzer] ⚠️ Model ${model} gặp lỗi: ${err.message}. Thử model tiếp theo...`);
    }
  }

  if (!responseData) {
    throw new Error('Tất cả các model Gemini Vision đều không phản hồi.');
  }

  const cleanJson = responseData.replace(/```json/g, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleanJson);

  // Đảm bảo trường dimensions luôn có và chính xác
  if (!parsed.dimensions || (!parsed.dimensions.height_cm && dimensionsText)) {
    const fallbackDim = parseDimensionsString(dimensionsText);
    parsed.dimensions = Object.assign(fallbackDim || {}, parsed.dimensions || {});
  } else if (dimensionsText && !parsed.dimensions.rawText) {
    parsed.dimensions.rawText = dimensionsText;
  }

  // Bổ sung đường dẫn tuyệt đối cho các ảnh được chọn
  if (parsed.selectedAngles) {
    for (const key of Object.keys(parsed.selectedAngles)) {
      const item = parsed.selectedAngles[key];
      if (item && item.filename) {
        item.fullPath = path.join(productFolder, item.filename);
        item.relativePath = path.relative(path.resolve(__dirname, '..'), item.fullPath);
      }
    }
  }

  return parsed;
}

module.exports = {
  analyzeAndSelectAngles
};
