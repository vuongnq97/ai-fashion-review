const fs = require('fs');
const path = require('path');
const { createFlowPage, closeFlowPage } = require('../services/browser');
const { generateImagesViaUI } = require('../services/image');
const { uploadImageDirectNetwork } = require('../services/playwright-direct/direct-flow-engine');

async function main() {
  const baseDir = path.resolve(__dirname, '..');
  const inputImg = path.join(baseDir, 'storyboard-review-runs/tg_-5348767040_1734439802095305968_1791293535299/inputs/input.png');
  const refBuf = fs.readFileSync(inputImg);

  const prompt = `LAYOUT — MANDATORY HORIZONTAL 16:9 MASTER STORYBOARD (4-PANEL SIDE-BY-SIDE COLLAGE):
The output image MUST BE a single horizontal 16:9 landscape still photograph containing exactly 4 equal-width vertical panels arranged side-by-side from left to right:
Column 1 (Panel 1: Hook) | Column 2 (Panel 2: Solution) | Column 3 (Panel 3: Proof) | Column 4 (Panel 4: Closing / CTA).
There are NO borders, NO dividers, NO gaps, NO black bars, NO frames, and NO split lines between panels.
PRODUCT: Nồi lẩu điện mini DKHOUSE đa năng màu kem be, thân dập nổi rãnh sọc dọc tinh xảo, núm xoay tròn viền đồng phía trước, hai quai cầm hai bên, nắp thủy tinh trong suốt.
Replicate the exact product identity, logo DKHOUSE, knob and ribbed texture from input.png.`;

  console.log('1. Connecting to Flow page...');
  const page = await createFlowPage(baseDir);

  try {
    console.log('2. Uploading reference image via direct maseQ RPC...');
    const mediaId = await uploadImageDirectNetwork(page, refBuf, 'input.png', 'image/png');
    console.log('✅ Uploaded via maseQ -> Media ID:', mediaId);

    console.log('3. Generating 4 candidates via route-intercepted Flow generation (16:9)...');
    const urls = await generateImagesViaUI({
      page,
      context: page.context(),
      prompt,
      outputCount: 4,
      aspectRatio: '16:9',
      imageInputUUIDs: [mediaId],
      filePayloads: [{ name: 'input.png', buffer: refBuf, mimeType: 'image/png' }]
    });

    console.log(`🎉 SUCCESS! Received ${urls?.length} candidate URLs:`, urls);
  } finally {
    await closeFlowPage(page);
  }
}

main().catch(console.error);
