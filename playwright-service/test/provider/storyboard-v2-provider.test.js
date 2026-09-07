'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { generateStoryboardV2 } = require('../../services/storyboard-v2');

const smokeEnabled = process.env.STORYBOARD_PROVIDER_SMOKE === '1';

test('V2 live provider produces four QA-approved panels', { skip: !smokeEnabled }, async () => {
  const fixturePath = process.env.STORYBOARD_PROVIDER_FIXTURE;
  if (!fixturePath || !fs.existsSync(fixturePath)) {
    throw new Error('Set STORYBOARD_PROVIDER_FIXTURE to a readable product image before running the provider smoke test');
  }
  const baseDir = path.resolve(__dirname, '../..');
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-v2-provider-'));
  const result = await generateStoryboardV2(baseDir, [{
    name: path.basename(fixturePath),
    mimeType: 'image/png',
    buffer: fs.readFileSync(fixturePath),
  }], {
    template: 'template5_1',
    pipelineVersion: 'v2',
    qualityMode: 'balanced',
    generateVideos: false,
    runDir,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.panels.length, 4);
  assert.ok(result.panels.every(panel => panel.status === 'approved'));
});
