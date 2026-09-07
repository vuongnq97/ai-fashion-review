'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { mergeVideos } = require('../video-merge');

function resolveFontPath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.STORYBOARD_FONT_PATH,
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function escapeFilterPath(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function applyPostProductionCopy(inputPath, outputPath, copy, options = {}) {
  const text = String(copy || '').trim();
  if (!text) {
    fs.copyFileSync(inputPath, outputPath);
    return { outputPath, copyApplied: false, reason: 'empty_copy' };
  }
  const fontPath = resolveFontPath(options.fontPath);
  if (!fontPath) {
    if (options.requireCopy) throw new Error('No Unicode font found for deterministic post-production copy');
    fs.copyFileSync(inputPath, outputPath);
    return { outputPath, copyApplied: false, reason: 'font_unavailable' };
  }
  const textPath = `${outputPath}.txt`;
  fs.writeFileSync(textPath, text, 'utf8');
  try {
    const filter = [
      `drawtext=fontfile='${escapeFilterPath(fontPath)}'`,
      `textfile='${escapeFilterPath(textPath)}'`,
      'fontcolor=white',
      'fontsize=h/24',
      'box=1',
      'boxcolor=black@0.55',
      'boxborderw=18',
      'x=(w-text_w)/2',
      'y=h*0.14',
    ].join(':');
    execFileSync(ffmpegPath, ['-y', '-i', inputPath, '-vf', filter, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'copy', outputPath], { stdio: 'pipe', timeout: 180000 });
    return { outputPath, copyApplied: true };
  } catch (error) {
    if (options.requireCopy) throw error;
    try { fs.unlinkSync(outputPath); } catch (_) {}
    fs.copyFileSync(inputPath, outputPath);
    return { outputPath, copyApplied: false, reason: 'drawtext_unavailable' };
  } finally {
    try { fs.unlinkSync(textPath); } catch (_) {}
  }
}

function applyStoryboardCopy(inputPath, outputPath, copies, options = {}) {
  const usableCopies = (Array.isArray(copies) ? copies : [])
    .slice(0, 4)
    .map((copy, index) => ({ index, text: String(copy || '').trim() }))
    .filter(item => item.text);
  if (usableCopies.length === 0) {
    fs.copyFileSync(inputPath, outputPath);
    return { outputPath, copyApplied: false, reason: 'empty_copy' };
  }
  const fontPath = resolveFontPath(options.fontPath);
  if (!fontPath) {
    if (options.requireCopy) throw new Error('No Unicode font found for deterministic storyboard copy');
    fs.copyFileSync(inputPath, outputPath);
    return { outputPath, copyApplied: false, reason: 'font_unavailable' };
  }

  const textPaths = usableCopies.map(item => {
    const textPath = `${outputPath}.scene-${item.index + 1}.txt`;
    fs.writeFileSync(textPath, item.text, 'utf8');
    return { ...item, textPath };
  });
  try {
    const filter = textPaths.map(({ index, textPath }) => [
      `drawtext=fontfile='${escapeFilterPath(fontPath)}'`,
      `textfile='${escapeFilterPath(textPath)}'`,
      'fontcolor=white',
      'fontsize=h/32',
      'box=1',
      'boxcolor=black@0.55',
      'boxborderw=14',
      `x=${index}*w/4+(w/4-text_w)/2`,
      'y=h*0.14',
    ].join(':')).join(',');
    execFileSync(ffmpegPath, ['-y', '-i', inputPath, '-vf', filter, '-frames:v', '1', outputPath], { stdio: 'pipe', timeout: 180000 });
    return { outputPath, copyApplied: true };
  } catch (error) {
    if (options.requireCopy) throw error;
    try { fs.unlinkSync(outputPath); } catch (_) {}
    fs.copyFileSync(inputPath, outputPath);
    return { outputPath, copyApplied: false, reason: 'drawtext_unavailable' };
  } finally {
    textPaths.forEach(({ textPath }) => { try { fs.unlinkSync(textPath); } catch (_) {} });
  }
}

async function postProcessFinalVideo(clips, outputPath, options = {}) {
  const preparedCopies = [];
  const copyResults = [];
  const clipPaths = clips.map((clip, index) => {
    const copy = options.copyByScene?.[index];
    if (!copy) return clip.videoPath;
    const copiedPath = path.join(path.dirname(outputPath), `.scene-${index + 1}-with-copy.mp4`);
    const copyResult = applyPostProductionCopy(clip.videoPath, copiedPath, copy, options);
    copyResults.push(copyResult);
    preparedCopies.push(copiedPath);
    return copiedPath;
  }).filter(Boolean);
  if (clipPaths.length !== clips.length) throw new Error('All approved clips need a readable videoPath');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const voicePath = options.voicePath && fs.existsSync(options.voicePath) ? options.voicePath : null;
  if (!voicePath) {
    try {
      await mergeVideos(clipPaths, outputPath, { muteAudio: options.preserveClipAudio !== true });
      return { outputPath, voiceApplied: options.preserveClipAudio === true, voiceSource: options.preserveClipAudio === true ? 'provider_clips' : null, copyApplied: copyResults.some(result => result.copyApplied), copyResults };
    } finally {
      preparedCopies.forEach(file => { try { fs.unlinkSync(file); } catch (_) {} });
    }
  }

  const silentPath = path.join(path.dirname(outputPath), '.silent-video.mp4');
  try {
    await mergeVideos(clipPaths, silentPath, { muteAudio: true });
    const duration = Number(options.finalVideoDurationSeconds || clips.reduce((sum, clip) => sum + Number(clip.durationSeconds || 4), 0));
    execFileSync(ffmpegPath, [
      '-y', '-i', silentPath, '-i', voicePath,
      '-filter_complex', `[1:a]loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=0:${duration}[voice]`,
      '-map', '0:v:0', '-map', '[voice]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
      '-t', String(duration), '-movflags', '+faststart', outputPath,
    ], { stdio: 'pipe', timeout: 180000 });
    return { outputPath, voiceApplied: true, copyApplied: copyResults.some(result => result.copyApplied), copyResults };
  } finally {
    try { fs.unlinkSync(silentPath); } catch (_) {}
    preparedCopies.forEach(file => { try { fs.unlinkSync(file); } catch (_) {} });
  }
}

module.exports = { applyPostProductionCopy, applyStoryboardCopy, postProcessFinalVideo, resolveFontPath };
