const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

// ═══════════════════════════════════════════════════════════════
// Video post-processing with ffmpeg
// Crops borders and scales to target resolution
// ═══════════════════════════════════════════════════════════════

/**
 * Process a video buffer: crop borders + scale to target resolution.
 *
 * @param {Buffer} inputBuffer  - Raw MP4 video buffer
 * @param {object} options
 * @param {number} [options.cropPx=46]       - Pixels to crop from each edge
 * @param {number} [options.cropPercent]     - Fraction to crop from each edge, e.g. 0.03 = 3%
 * @param {number} [options.width=1080]      - Target width
 * @param {number} [options.height=1920]     - Target height
 * @param {string} [options.aspectRatio]     - '9:16' | '16:9' | '1:1' — auto-sets width/height
 * @returns {Promise<Buffer>} Processed MP4 buffer
 */
async function processVideo(inputBuffer, options = {}) {
    const {
        cropPx = 46,
        cropPercent = null,
        aspectRatio = '9:16',
    } = options;

    // Auto-resolve dimensions from aspect ratio
    let { width, height } = options;
    if (!width || !height) {
        switch (aspectRatio) {
            case '16:9':
                width = 1920; height = 1080; break;
            case '1:1':
                width = 1080; height = 1080; break;
            case '9:16':
            default:
                width = 1080; height = 1920; break;
        }
    }

    const tmpDir = path.resolve(__dirname, '..', 'uploads');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inputPath = path.join(tmpDir, `input-${id}.mp4`);
    const outputPath = path.join(tmpDir, `output-${id}.mp4`);

    try {
        // Write input buffer to temp file
        fs.writeFileSync(inputPath, inputBuffer);
        console.log(`[VideoResize] Input written: ${inputPath} (${(inputBuffer.length / 1024 / 1024).toFixed(1)} MB)`);

        // Build ffmpeg filter: crop borders then scale.
        // cropPercent preserves the source aspect ratio because x/y crops are
        // calculated from their own dimensions instead of using one fixed px value.
        let vf;
        let cropLog;
        if (Number.isFinite(Number(cropPercent)) && Number(cropPercent) > 0) {
            const pct = Math.min(Number(cropPercent), 0.45);
            const cropX = `trunc(iw*${pct}/2)*2`;
            const cropY = `trunc(ih*${pct}/2)*2`;
            vf = `crop=iw-2*${cropX}:ih-2*${cropY}:${cropX}:${cropY},scale=${width}:${height}:force_original_aspect_ratio=disable`;
            cropLog = `${(pct * 100).toFixed(2)}% each side`;
        } else {
            const cropW = cropPx * 2;
            const cropH = cropPx * 2;
            vf = `crop=in_w-${cropW}:in_h-${cropH}:${cropPx}:${cropPx},scale=${width}:${height}:force_original_aspect_ratio=disable`;
            cropLog = `${cropPx}px each side`;
        }

        // Compute SAR/DAR string for -aspect flag (e.g. '9:16', '16:9', '1:1')
        const aspectFlag = `${width}:${height}`;

        const args = [
            '-y',                    // Overwrite output
            '-i', inputPath,         // Input file
            '-vf', vf,               // Video filter: crop + scale + force dimensions
            '-aspect', aspectFlag,   // Force correct aspect ratio metadata (fixes Telegram 1:1 issue)
            '-c:v', 'libx264',       // H.264 codec (Telegram compatible)
            '-preset', 'fast',       // Encoding speed
            '-crf', '23',            // Quality (lower = better, 18-28 range)
            '-c:a', 'aac',           // Audio codec
            '-b:a', '128k',          // Audio bitrate
            '-movflags', '+faststart', // Web-optimized MP4
            outputPath
        ];

        console.log(`[VideoResize] Running ffmpeg: crop=${cropLog}, scale=${width}x${height}`);
        console.log(`[VideoResize] ffmpeg path: ${ffmpegPath}`);

        // Execute ffmpeg
        await new Promise((resolve, reject) => {
            const proc = execFile(ffmpegPath, args, { timeout: 120000 }, (error, stdout, stderr) => {
                if (error) {
                    console.error(`[VideoResize] ffmpeg error:`, error.message);
                    console.error(`[VideoResize] ffmpeg stderr:`, stderr);
                    reject(new Error(`ffmpeg failed: ${error.message}`));
                } else {
                    console.log(`[VideoResize] ffmpeg completed successfully`);
                    resolve();
                }
            });
        });

        // Read processed video
        const outputBuffer = fs.readFileSync(outputPath);
        const reduction = ((1 - outputBuffer.length / inputBuffer.length) * 100).toFixed(1);
        console.log(`[VideoResize] Output: ${(outputBuffer.length / 1024 / 1024).toFixed(1)} MB (${reduction}% size ${reduction > 0 ? 'reduction' : 'increase'})`);

        return outputBuffer;

    } finally {
        // Cleanup temp files
        [inputPath, outputPath].forEach(p => {
            try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { }
        });
    }
}

/**
 * Process a base64-encoded video string.
 * Convenience wrapper around processVideo().
 *
 * @param {string} base64Video - Base64-encoded MP4
 * @param {object} options     - Same options as processVideo()
 * @returns {Promise<string>}  Processed video as base64 string
 */
async function processVideoBase64(base64Video, options = {}) {
    const inputBuffer = Buffer.from(base64Video, 'base64');
    const outputBuffer = await processVideo(inputBuffer, options);
    return outputBuffer.toString('base64');
}

module.exports = {
    processVideo,
    processVideoBase64,
};
