const fs = require('fs');
const path = require('path');
const { processVideo } = require('./services/video-resize');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

(async () => {
  const baseDir = __dirname;
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(baseDir, args.input || 'test.mp4');
  const outputDir = path.resolve(baseDir, args.outputDir || path.join('debug-output', 'video-crop'));
  const aspectRatio = args.aspect || '9:16';

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input video not found: ${inputPath}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const options = { aspectRatio };
  let cropLabel = '';
  if (args.percent !== undefined) {
    options.cropPercent = Number(args.percent);
    cropLabel = `percent-${String(args.percent).replace('.', '_')}`;
  } else if (args.px !== undefined) {
    options.cropPx = Number(args.px);
    cropLabel = `px-${args.px}`;
  } else {
    options.cropPercent = 0.03;
    cropLabel = 'percent-0_03';
  }

  const parsed = path.parse(inputPath);
  const outputPath = path.join(outputDir, `${parsed.name}-crop-${cropLabel}-${aspectRatio.replace(':', 'x')}.mp4`);

  console.log(`[TestCrop] Input : ${inputPath}`);
  console.log(`[TestCrop] Output: ${outputPath}`);
  console.log(`[TestCrop] Options: ${JSON.stringify(options)}`);

  const inputBuffer = fs.readFileSync(inputPath);
  const outputBuffer = await processVideo(inputBuffer, options);
  fs.writeFileSync(outputPath, outputBuffer);

  console.log(`[TestCrop] Done. ${(outputBuffer.length / 1024 / 1024).toFixed(1)} MB`);
})().catch(error => {
  console.error('[TestCrop] Fatal:', error.message);
  process.exit(1);
});
