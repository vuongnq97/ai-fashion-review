'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function escapeConcatPath(filePath) {
  return String(filePath).replace(/'/g, "'\\''");
}

function getVideoDuration(filePath) {
  try {
    const out = execFileSync(ffmpegPath, ['-i', filePath], { stdio: 'pipe' }).toString();
    const match = out.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (match) {
      return parseFloat(match[1]) * 3600 + parseFloat(match[2]) * 60 + parseFloat(match[3]);
    }
  } catch (err) {
    const out = ((err.stderr ? err.stderr.toString() : '') + (err.stdout ? err.stdout.toString() : ''));
    const match = out.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (match) {
      return parseFloat(match[1]) * 3600 + parseFloat(match[2]) * 60 + parseFloat(match[3]);
    }
  }
  return 0;
}

function hasAudioStream(filePath) {
  try {
    const out = execFileSync(ffmpegPath, ['-i', filePath], { stdio: 'pipe' }).toString();
    return /Audio:\s*aac|Audio:\s*mp3|Audio:\s*pcm/i.test(out);
  } catch (err) {
    const out = ((err.stderr ? err.stderr.toString() : '') + (err.stdout ? err.stdout.toString() : ''));
    return /Audio:\s*aac|Audio:\s*mp3|Audio:\s*pcm/i.test(out);
  }
}

/**
 * Merges multiple vertical video panels into a final 1080x1920 9:16 video.
 * Supports muting original audio and overlaying trending background music.
 *
 * @param {Array<string>} videoPaths - Array of file paths to video panels
 * @param {string} outputPath - Output MP4 file path
 * @param {object} [options]
 * @param {string} [options.musicPath] - Path to background music MP3/WAV
 * @param {boolean} [options.muteAudio=false] - Whether to mute audio if no music is provided
 * @param {number} [options.timeoutMs=180000] - Process timeout in ms
 * @returns {Promise<string>} Path to merged output video
 */
function mergeVideos(videoPaths, outputPath, options = {}) {
  const inputs = (Array.isArray(videoPaths) ? videoPaths : [])
    .filter(Boolean)
    .filter(filePath => fs.existsSync(filePath));

  if (inputs.length === 0) {
    return Promise.reject(new Error('No video files found to merge'));
  }

  ensureDir(path.dirname(outputPath));

  // Compute exact total video duration from all panels
  let totalVideoDuration = 0;
  inputs.forEach(filePath => {
    totalVideoDuration += getVideoDuration(filePath);
  });
  console.log(`[VideoMerge] Merging ${inputs.length} video panels. Total video duration: ${totalVideoDuration.toFixed(2)}s`);

  const hasMusic = options.musicPath && fs.existsSync(options.musicPath);

  // Build explicit input arguments and filter_complex to enforce exact 1080x1920 (9:16)
  const inputArgs = [];
  inputs.forEach(filePath => {
    inputArgs.push('-i', path.resolve(filePath));
  });

  const filterParts = [];
  const vOutputs = [];
  inputs.forEach((_, idx) => {
    filterParts.push(`[${idx}:v]scale=1080:1920:force_original_aspect_ratio=disable,setsar=1[v${idx}]`);
    vOutputs.push(`[v${idx}]`);
  });

  let args = ['-y', ...inputArgs];

  if (hasMusic) {
    filterParts.push(`${vOutputs.join('')}concat=n=${inputs.length}:v=1:a=0[vout]`);
    const musicIdx = inputs.length;
    args.push('-i', path.resolve(options.musicPath));
    const fadeOutStart = Math.max(0, totalVideoDuration - 1.0);
    // aloop=-1 loop vô hạn → atrim cắt đúng totalVideoDuration → nhạc luôn đủ dài
    const audioFilter = totalVideoDuration > 0
      ? `[${musicIdx}:a]aloop=loop=-1:size=2000000000,volume=1.0,afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeOutStart.toFixed(2)}:d=1.0,atrim=0:${totalVideoDuration.toFixed(2)},asetpts=PTS-STARTPTS[aout]`
      : `[${musicIdx}:a]aloop=loop=-1:size=2000000000,volume=1.0,afade=t=in:st=0:d=0.5[aout]`;

    filterParts.push(audioFilter);
    args.push(
      '-filter_complex', filterParts.join(';'),
      '-map', '[vout]',
      '-map', '[aout]',
      '-aspect', '9:16'
    );
    if (totalVideoDuration > 0) {
      args.push('-t', totalVideoDuration.toFixed(2));
    }
    args.push(
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '22',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outputPath
    );

  } else if (options.muteAudio) {
    filterParts.push(`${vOutputs.join('')}concat=n=${inputs.length}:v=1:a=0[vout]`);
    args.push(
      '-filter_complex', filterParts.join(';'),
      '-map', '[vout]',
      '-aspect', '9:16'
    );
    if (totalVideoDuration > 0) {
      args.push('-t', totalVideoDuration.toFixed(2));
    }
    args.push(
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '22',
      '-an',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outputPath
    );
  } else {
    // Preserve original voice-over / panel audio
    const anyHasAudio = inputs.some(p => hasAudioStream(p));
    if (anyHasAudio) {
      console.log(`[VideoMerge] 🎙️ Preserving original panel audio (voice-over) across ${inputs.length} panels`);
      const concatInputs = [];
      inputs.forEach((p, idx) => {
        if (hasAudioStream(p)) {
          filterParts.push(`[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo[a${idx}]`);
        } else {
          const d = getVideoDuration(p) || 8.0;
          filterParts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${d.toFixed(2)}[a${idx}]`);
        }
        concatInputs.push(`[v${idx}][a${idx}]`);
      });
      filterParts.push(`${concatInputs.join('')}concat=n=${inputs.length}:v=1:a=1[vout][aout]`);

      args.push(
        '-filter_complex', filterParts.join(';'),
        '-map', '[vout]',
        '-map', '[aout]',
        '-aspect', '9:16'
      );
      if (totalVideoDuration > 0) {
        args.push('-t', totalVideoDuration.toFixed(2));
      }
      args.push(
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '22',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        outputPath
      );
    } else {
      filterParts.push(`${vOutputs.join('')}concat=n=${inputs.length}:v=1:a=0[vout]`);
      args.push(
        '-filter_complex', filterParts.join(';'),
        '-map', '[vout]',
        '-aspect', '9:16'
      );
      if (totalVideoDuration > 0) {
        args.push('-t', totalVideoDuration.toFixed(2));
      }
      args.push(
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '22',
        '-an',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        outputPath
      );
    }
  }

  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: options.timeoutMs || 180000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`ffmpeg merge failed: ${error.message}\n${stderr || stdout}`.trim()));
        return;
      }

      if (!fs.existsSync(outputPath)) {
        reject(new Error('ffmpeg concat finished but output file was not created'));
        return;
      }

      resolve(outputPath);
    });
  });
}

module.exports = {
  mergeVideos,
};
