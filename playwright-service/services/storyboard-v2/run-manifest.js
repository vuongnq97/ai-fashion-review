'use strict';

const fs = require('fs');
const path = require('path');

function redact(value, key = '') {
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (/token|cookie|authorization|base64|signedurl/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}`;
    } catch (_) { return '[URL]'; }
  }
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([childKey]) => childKey !== 'original')
      .map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  }
  return value;
}

class RunManifest {
  constructor(runId, root, config) {
    this.runId = runId;
    this.root = root;
    this.path = path.join(root, 'run-manifest.json');
    this.data = {
      runId,
      pipelineVersion: 'v2',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      config,
      stages: {},
      panels: [],
      clips: [],
      warnings: [],
    };
    fs.mkdirSync(root, { recursive: true });
    this.save();
  }

  stage(name, status, data = null) {
    this.data.stages[name] = { status, updatedAt: new Date().toISOString(), data: redact(data) };
    this.save();
  }

  warning(message) {
    this.data.warnings.push(String(message));
    this.save();
  }

  finish(status) {
    this.data.status = status;
    this.data.updatedAt = new Date().toISOString();
    this.save();
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.path, `${JSON.stringify(redact(this.data), null, 2)}\n`, 'utf8');
  }
}

module.exports = { RunManifest, redact };
