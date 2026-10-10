function parseBatchExecute(rawText, rpcId = 'ogiZ0b') {
  if (!rawText || typeof rawText !== 'string') return null;
  const cleaned = rawText.replace(/^\)\]\}'\s*/, '').trim();
  const lines = cleaned.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (Array.isArray(item) && item[1] === rpcId && typeof item[2] === 'string') {
            return JSON.parse(item[2]);
          }
        }
      }
    } catch (_) {}
  }
  return null;
}

function extractFullImageUrl(respText) {
  const parsed = parseBatchExecute(respText, 'ogiZ0b');
  if (!parsed) return null;
  
  let signedUrl = null;
  function search(node) {
    if (!node || signedUrl) return;
    if (typeof node === 'string' && (node.startsWith('https://flow-content.google') || node.startsWith('https://storage.googleapis.com'))) {
      signedUrl = node;
      return;
    }
    if (Array.isArray(node)) {
      for (const el of node) search(el);
    } else if (typeof node === 'object') {
      for (const k of Object.keys(node)) search(node[k]);
    }
  }
  search(parsed);
  return signedUrl;
}

console.log('Parser functions defined successfully.');
