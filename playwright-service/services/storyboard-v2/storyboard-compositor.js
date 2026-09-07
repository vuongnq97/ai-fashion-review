'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

function panelBuffer(panel) {
  if (Buffer.isBuffer(panel.buffer)) return panel.buffer;
  if (panel.imageBase64) return Buffer.from(panel.imageBase64, 'base64');
  if (panel.imagePath && fs.existsSync(panel.imagePath)) return fs.readFileSync(panel.imagePath);
  throw new Error(`Panel ${panel.sceneNumber || panel.index || '?'} has no readable image`);
}

function composeStoryboardDeterministically(panels, outputPath, options = {}) {
  if (!Array.isArray(panels) || panels.length !== 4) throw new Error('Exactly four panels are required');
  const width = Number(options.panelWidth || 1080);
  const height = Number(options.panelHeight || 1920);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-v2-compose-'));
  const normalized = [];
  try {
    for (let index = 0; index < panels.length; index++) {
      const inputPath = path.join(tmpDir, `input-${index + 1}.png`);
      const normalizedPath = path.join(tmpDir, `panel-${index + 1}.png`);
      fs.writeFileSync(inputPath, panelBuffer(panels[index]));
      execFileSync(ffmpegPath, [
        '-y', '-i', inputPath,
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:white,setsar=1`,
        '-frames:v', '1', normalizedPath,
      ], { stdio: 'pipe', timeout: 30000 });
      normalized.push(normalizedPath);
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    execFileSync(ffmpegPath, [
      '-y',
      ...normalized.flatMap(file => ['-i', file]),
      '-filter_complex', '[0:v][1:v][2:v][3:v]hstack=inputs=4[out]',
      '-map', '[out]', '-frames:v', '1', outputPath,
    ], { stdio: 'pipe', timeout: 30000 });
    if (!fs.existsSync(outputPath)) throw new Error('Storyboard compositor did not create output');
    return { outputPath, width: width * 4, height, aspectRatio: '9:4' };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function splitMasterStoryboard(masterBuffer, outputDir, options = {}, attempt = 1) {
  if (!Buffer.isBuffer(masterBuffer) || masterBuffer.length < 1000) throw new Error('Master storyboard image is invalid');
  const width = Number(options.panelWidth || 1080);
  const height = Number(options.panelHeight || 1920);
  fs.mkdirSync(outputDir, { recursive: true });
  const sourcePath = path.join(outputDir, `master-attempt-${attempt}.png`);
  fs.writeFileSync(sourcePath, masterBuffer);
  const panels = [];
  for (let index = 0; index < 4; index++) {
    const outputPath = path.join(outputDir, `panel-${index + 1}-master-attempt-${attempt}.png`);
    execFileSync(ffmpegPath, [
      '-y', '-i', sourcePath,
      '-vf', `crop=iw/4:ih:${index}*iw/4:0,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:white,setsar=1`,
      '-frames:v', '1', outputPath,
    ], { stdio: 'pipe', timeout: 30000 });
    panels.push({ sceneNumber: index + 1, imagePath: outputPath, buffer: fs.readFileSync(outputPath), mimeType: 'image/png' });
  }
  return { sourcePath, panels };
}

function composeEvidenceBoard(images, outputPath, options = {}) {
  const usable = (Array.isArray(images) ? images : []).filter(image => Buffer.isBuffer(image.buffer));
  if (!usable.length) throw new Error('At least one image is required for the evidence board');
  const cellWidth = Number(options.evidenceCellWidth || 540);
  const cellHeight = Number(options.evidenceCellHeight || 720);
  const columns = Math.min(4, Math.ceil(Math.sqrt(usable.length)));
  const rows = Math.ceil(usable.length / columns);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-v2-evidence-'));
  try {
    const inputs = usable.map((image, index) => {
      const inputPath = path.join(tmpDir, `evidence-${index + 1}.png`);
      fs.writeFileSync(inputPath, image.buffer);
      return inputPath;
    });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (usable.length === 1) {
      execFileSync(ffmpegPath, [
        '-y', '-i', inputs[0],
        '-vf', `scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:white,setsar=1`,
        '-frames:v', '1', outputPath,
      ], { stdio: 'pipe', timeout: 30000 });
      return { outputPath, width: cellWidth, height: cellHeight, imageCount: 1 };
    }
    const filters = inputs.map((_, index) => `[${index}:v]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:white,setsar=1[v${index}]`);
    const layout = usable.map((_, index) => `${(index % columns) * cellWidth}_${Math.floor(index / columns) * cellHeight}`).join('|');
    filters.push(`${usable.map((_, index) => `[v${index}]`).join('')}xstack=inputs=${usable.length}:layout=${layout}:fill=white[out]`);
    execFileSync(ffmpegPath, [
      '-y', ...inputs.flatMap(file => ['-i', file]),
      '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', outputPath,
    ], { stdio: 'pipe', timeout: 60000 });
    return { outputPath, width: columns * cellWidth, height: rows * cellHeight, imageCount: usable.length };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { composeEvidenceBoard, composeStoryboardDeterministically, panelBuffer, splitMasterStoryboard };
