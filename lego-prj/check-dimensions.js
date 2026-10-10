'use strict';

const https = require('https');

const products = [
  { name: 'LEGO Disney Moana 2 Heihei (43272)', url: 'https://r.jina.ai/https://www.walmart.com/ip/LEGO-Disney-Princess-43272/7277168939' },
  { name: 'LEGO Disney Stitch & Scrump (43296)', url: 'https://r.jina.ai/https://www.walmart.com/ip/LEGO-Disney-Classic-43296/18653173022' },
  { name: 'LEGO Technic Mercedes-Benz G 500 (42177 / 5249239271)', url: 'https://r.jina.ai/https://www.walmart.com/ip/LEGO-Technic-Mercedes-Benz-G-500-PROFESSIONAL-Line-Car-Building-Set-G-Wagon-Model-Car-Gift-Adults-4X4-Off-Road-Vehicle-Mercedes-Benz-Collectibles-Mer/5249239271' }
];

async function fetchProduct(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      rejectUnauthorized: false,
      headers: { 'X-Return-Format': 'html' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const match = data.match(/id=\"__NEXT_DATA__\"[^>]*>([^<]+)<\/script>/);
          if (!match) return resolve(null);
          const parsed = JSON.parse(match[1]);
          const prod = parsed?.props?.pageProps?.initialData?.data?.product;
          resolve(prod);
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  for (const item of products) {
    console.log('\n======================================================');
    console.log('📦 SẢN PHẨM:', item.name);
    try {
      const prod = await fetchProduct(item.url);
      if (!prod) {
        console.log('❌ Không tìm thấy payload');
        continue;
      }

      console.log('🔹 Tên hiển thị:', prod.name);
      
      // 1. Kiểm tra trong shortDescription / detailedDescription / description
      const desc = (prod.shortDescription || '') + ' ' + (prod.detailedDescription || '');
      console.log('\n--- 1. TÌM TRONG MÔ TẢ (Description) ---');
      const descMatches = desc.match(/[^.!?\n]*(?:measure|dimension|high|tall|wide|long|deep|cm|in\.|inch|height|width|length)[^.!?\n]*/gi);
      if (descMatches && descMatches.length > 0) {
        // Lọc bớt thẻ HTML
        const cleanMatches = descMatches.map(m => m.replace(/<[^>]+>/g, '').trim()).filter(m => m.length > 10);
        console.log(cleanMatches.join('\n• '));
      } else {
        console.log('Không có câu nào nhắc kích thước trong mô tả ngắn');
      }

      // 2. Kiểm tra trong specifications
      console.log('\n--- 2. THÔNG SỐ KỸ THUẬT (Specifications / Attributes) ---');
      const specs = prod.specifications || [];
      const specTable = prod.specificationsTable || [];
      let foundSpecs = false;
      for (const s of [...specs, ...specTable]) {
        const name = (s.name || s.displayName || '').toLowerCase();
        if (name.includes('dimension') || name.includes('size') || name.includes('weight') || name.includes('height') || name.includes('width') || name.includes('depth')) {
          console.log(`• ${s.name || s.displayName}: ${s.value || (s.values && s.values.join(', '))}`);
          foundSpecs = true;
        }
      }
      if (!foundSpecs) {
        console.log('Chưa tìm thấy mục Dimension trong specs, liệt kê tất cả specs:');
        for (const s of [...specs, ...specTable].slice(0, 10)) {
          console.log(`  - ${s.name || s.displayName}: ${s.value || (s.values && s.values.join(', '))}`);
        }
      }

      // 3. IDML (Interactive digital media / Rich product content từ nhà sản xuất LEGO)
      if (prod.idml) {
        console.log('\n--- 3. NỘI DUNG TỪ HÃNG LEGO (IDML) ---');
        const idmlStr = JSON.stringify(prod.idml);
        const idmlMatches = idmlStr.match(/[^"\\n]*(?:measure|standing over|high|tall|wide|long|deep|\bcm\b|\bin\.)[^"\\n]*/gi);
        if (idmlMatches && idmlMatches.length > 0) {
          const uniqueIdml = Array.from(new Set(idmlMatches.map(m => m.trim()))).slice(0, 10);
          console.log(uniqueIdml.join('\n• '));
        }
      }

    } catch (err) {
      console.error('Lỗi:', err.message);
    }
  }
}

main();
