'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

function safeAssetName(value, fallback) {
  return String(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || fallback;
}

function readSource(image) {
  if (Buffer.isBuffer(image.buffer)) return image.buffer;
  if (image.uri && fs.existsSync(image.uri)) return fs.readFileSync(image.uri);
  return null;
}

function probeDimensions(filePath) {
  try {
    execFileSync(ffmpegPath, ['-i', filePath], { stdio: 'pipe', timeout: 10000 });
  } catch (error) {
    const output = `${error.stderr || ''}${error.stdout || ''}`;
    const match = output.match(/Video:.*?\s(\d{2,5})x(\d{2,5})(?:[\s,])/s);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  }
  return null;
}

function normalizeWorkingImages(input, runDir, options = {}) {
  const originalsDir = path.join(runDir, 'input-originals');
  const workingDir = path.join(runDir, 'working-assets');
  fs.mkdirSync(originalsDir, { recursive: true });
  fs.mkdirSync(workingDir, { recursive: true });
  const minimumSide = Math.max(64, Number(options.minimumImageSide || process.env.STORYBOARD_MIN_IMAGE_SIDE || 256));
  const seenHashes = new Map();
  const accepted = [];
  const rejected = [];

  for (const [index, image] of input.images.entries()) {
    const source = readSource(image);
    if (!source || source.length < 32) {
      rejected.push({ imageId: image.imageId, reason: 'unreadable_source' });
      continue;
    }
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    if (seenHashes.has(hash)) {
      rejected.push({ imageId: image.imageId, reason: 'exact_duplicate', duplicateOf: seenHashes.get(hash) });
      continue;
    }
    seenHashes.set(hash, image.imageId);

    const basename = safeAssetName(image.imageId, `img-${index + 1}`);
    const extension = path.extname(image.name || '') || '.bin';
    const originalPath = path.join(originalsDir, `${basename}${extension}`);
    const workingPath = path.join(workingDir, `${basename}.png`);
    fs.writeFileSync(originalPath, source);
    try {
      // FFmpeg applies EXIF display rotation while decoding. The original file is kept separately.
      execFileSync(ffmpegPath, ['-y', '-i', originalPath, '-frames:v', '1', workingPath], { stdio: 'pipe', timeout: 30000 });
      const dimensions = probeDimensions(workingPath);
      if (!dimensions) throw new Error('normalized image dimensions are unreadable');
      if (Math.min(dimensions.width, dimensions.height) < minimumSide) {
        rejected.push({ imageId: image.imageId, reason: 'too_small', dimensions });
        try { fs.unlinkSync(workingPath); } catch (_) {}
        continue;
      }
      accepted.push({
        ...image,
        buffer: fs.readFileSync(workingPath),
        mimeType: 'image/png',
        uri: workingPath,
        workingPath,
        originalPath,
        dimensions,
        sha256: hash,
      });
    } catch (error) {
      rejected.push({ imageId: image.imageId, reason: 'decode_failed', message: error.message });
      try { fs.unlinkSync(workingPath); } catch (_) {}
    }
  }

  if (accepted.length === 0) {
    const reasons = rejected.map(item => `${item.imageId}:${item.reason}`).join(', ');
    throw new Error(`No valid product image remains after normalization (${reasons})`);
  }
  return {
    input: { ...input, images: accepted },
    report: {
      accepted: accepted.map(image => ({ imageId: image.imageId, dimensions: image.dimensions, workingPath: image.workingPath, originalPath: image.originalPath, sha256: image.sha256 })),
      rejected,
      minimumImageSide: minimumSide,
    },
  };
}

module.exports = { normalizeWorkingImages, probeDimensions, safeAssetName };
