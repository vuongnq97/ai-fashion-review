'use strict';

const path = require('path');
const { generateOmni360Video } = require('./services/omni-video');

async function run() {
  const outputDir = path.resolve(__dirname, 'outputs/7277168939');
  const panelImagePath = path.join(outputDir, 'master_panel_9_16.png');
  const productName = 'LEGO Disney Moana 2 Heihei';

  console.log('🚀 Bắt đầu tạo Omni 360 Video cho Heihei...');
  const res = await generateOmni360Video({
    panelImagePath,
    productName,
    outputDir
  });

  console.log('🎉 Hoàn thành video:', res.videoPath);
}

run().catch(console.error);
