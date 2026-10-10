const path = require('path');
const { analyzeAndSelectAngles } = require('./services/image-analyzer');

async function test() {
  const folder = path.join(__dirname, 'downloads/7277168939');
  const name = 'LEGO Disney Moana 2 Heihei (43272)';

  console.log('Testing ImageAnalyzer on HeiHei LEGO set...');
  try {
    const result = await analyzeAndSelectAngles(folder, name);
    console.log('\n📊 KẾT QUẢ PHÂN TÍCH VÀ CHỌN GÓC:');
    console.log('--- Selected Angles ---');
    console.log(JSON.stringify(result.selectedAngles, null, 2));

    console.log('\n--- LEGO Visual Profile ---');
    console.log(JSON.stringify(result.legoVisualProfile, null, 2));

    console.log('\n--- Từng ảnh chi tiết ---');
    result.analyzedImages.forEach(img => {
      console.log(`[${img.filename}] -> Category: ${img.category} | Angle: ${img.angle} | ShowsComplete: ${img.showsCompleteModel}`);
    });
  } catch (err) {
    console.error('Lỗi phân tích:', err.message);
  }
}

test();
