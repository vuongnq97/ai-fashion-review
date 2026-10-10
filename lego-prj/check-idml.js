'use strict';

const https = require('https');

const products = [
  { name: 'LEGO Disney Moana 2 Heihei (43272)', url: 'https://r.jina.ai/https://www.walmart.com/ip/LEGO-Disney-Princess-43272/7277168939' },
  { name: 'LEGO Disney Stitch & Scrump (43296)', url: 'https://r.jina.ai/https://www.walmart.com/ip/LEGO-Disney-Classic-43296/18653173022' },
  { name: 'LEGO Technic Mercedes-Benz G 500 (42177 / 5249239271)', url: 'https://r.jina.ai/https://www.walmart.com/ip/LEGO-Technic-Mercedes-Benz-G-500-PROFESSIONAL-Line-Car-Building-Set-G-Wagon-Model-Car-Gift-Adults-4X4-Off-Road-Vehicle-Mercedes-Benz-Collectibles-Mer/5249239271' }
];

function fetchIdml(url) {
  return new Promise((resolve) => {
    https.get(url, { rejectUnauthorized: false, headers: { 'X-Return-Format': 'html' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const match = data.match(/id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
          const parsed = JSON.parse(match[1]);
          const idml = parsed?.props?.pageProps?.initialData?.data?.idml;
          resolve(idml);
        } catch(e) {
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });
  });
}

async function run() {
  for (const p of products) {
    console.log('\n======================================================');
    console.log('📦 SẢN PHẨM:', p.name);
    const idml = await fetchIdml(p.url);
    if (!idml) {
      console.log('Không lấy được idml');
      continue;
    }

    console.log('\n--- 1. SPECIFICATIONS ---');
    const specsV2 = idml.specificationsV2 || [];
    for (const group of specsV2) {
      for (const s of (group.specifications || [])) {
        if (/dimension|size|weight|height|width|depth|assembled/i.test(s.name)) {
          console.log(`  • ${s.name}: ${s.value}`);
        }
      }
    }

    console.log('\n--- 2. LONG DESCRIPTION & HIGHLIGHTS ---');
    const fullText = (idml.longDescription || '') + ' ' + (idml.shortDescription || '') + ' ' + JSON.stringify(idml.productHighlights || '');
    // Regex tìm các câu có số đo (cm, in, inch, measure, high, tall, wide, long, deep)
    const matches = fullText.match(/[^.!?\n<>]*(?:\d+\s*(?:cm|in\.|inches|inch)|measure|standing over|high|tall|wide|long|deep)[^.!?\n<>]*/gi) || [];
    const cleanSentences = Array.from(new Set(matches.map(s => s.replace(/<[^>]+>/g, '').trim()))).filter(s => s.length > 15);
    for (const s of cleanSentences) {
      console.log(`  👉 ${s}`);
    }
  }
}

run();
