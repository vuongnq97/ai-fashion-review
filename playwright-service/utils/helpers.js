const path = require('path');
const fs = require('fs');

async function getGeneratedImageUrls(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('img'))
      .filter(img => img.src && img.src.includes('media.getMediaUrlRedirect') && !img.src.includes('THUMBNAIL'))
      .map(img => img.src);
  });
}

async function fetchImageAsBase64(page, imageUrl) {
  return page.evaluate(async (url) => {
    const res = await fetch(url);
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(',')[1]);
      reader.readAsDataURL(blob);
    });
  }, imageUrl);
}

function writeTempFiles(filePayloads, baseDir) {
  const tempPaths = [];
  filePayloads.forEach((fp, idx) => {
    const safeName = fp.name ? fp.name.replace(/[^a-zA-Z0-9.\-_]/g, '_') : `temp_${Date.now()}_${idx}.png`;
    const tempPath = path.join(baseDir, `uploads/${safeName}`);
    fs.writeFileSync(tempPath, fp.buffer);
    tempPaths.push(tempPath);
  });
  return tempPaths;
}

module.exports = {
  getGeneratedImageUrls,
  fetchImageAsBase64,
  writeTempFiles
};
