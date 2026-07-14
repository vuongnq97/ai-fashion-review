const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const userDataDir = path.join(__dirname, 'chrome-data');
const outDir = path.join(__dirname, 'debug-network');
const url = process.argv[2] ||
  'https://ai.studio/apps/67340c71-44d0-4210-a324-33525f7e1ecb?fullscreenApplet=true';

function redactHeaders(headers = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    result[key] = ['authorization', 'cookie', 'x-goog-api-key', 'x-goog-authuser'].includes(lower)
      ? '[REDACTED]'
      : value;
  }
  return result;
}

function redactText(text = '') {
  return String(text)
    .replace(/("token"\s*:\s*")[^"]{20,}(")/g, '$1[REDACTED_TOKEN]$2')
    .replace(/0cAFcWeA[0-9A-Za-z_-]{20,}/g, '[REDACTED_RECAPTCHA_TOKEN]')
    .replace(/([?&]at=)[^&\s]+/g, '$1[REDACTED_AT_TOKEN]')
    .replace(/\bat=[^&\s]+/g, 'at=[REDACTED_AT_TOKEN]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/AQ\.[0-9A-Za-z_-]{20,}/g, '[REDACTED_AISTUDIO_TOKEN]')
    .replace(/AD1_[0-9A-Za-z_-]{20,}/g, '[REDACTED_GEMINI_TOKEN]')
    .replace(/__Secure-[^=;\s]+=[^;\s]+/g, '[REDACTED_COOKIE]')
    .slice(0, 50000);
}

function shouldLog(rawUrl) {
  return /gemini\.google\.com|content-push\.googleapis\.com|aistudio\.google\.com|ai\.studio|labs\.google|aisandbox-pa\.googleapis\.com|generativelanguage\.googleapis\.com|alkalimakersuite|MakerSuiteService|batchexecute|StreamGenerate|streamGenerate|run\.app|googleusercontent\.com/i.test(rawUrl);
}

function append(file, entry) {
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const logFile = path.join(outDir, `network-${Date.now()}.jsonl`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  context.on('request', (request) => {
    const requestUrl = request.url();
    if (!shouldLog(requestUrl)) return;
    append(logFile, {
      type: 'request',
      at: new Date().toISOString(),
      method: request.method(),
      url: requestUrl,
      resourceType: request.resourceType(),
      headers: redactHeaders(request.headers()),
      postData: redactText(request.postData() || ''),
    });
  });

  context.on('requestfailed', (request) => {
    const requestUrl = request.url();
    if (!shouldLog(requestUrl)) return;
    append(logFile, {
      type: 'requestfailed',
      at: new Date().toISOString(),
      method: request.method(),
      url: requestUrl,
      resourceType: request.resourceType(),
      failure: request.failure(),
    });
  });

  context.on('response', async (response) => {
    const responseUrl = response.url();
    if (!shouldLog(responseUrl)) return;
    const headers = response.headers();
    let bodySnippet = '';
    const contentType = headers['content-type'] || '';
    if (/json|text|javascript|protobuf/i.test(contentType) || /MakerSuiteService|batchexecute|streamGenerate/i.test(responseUrl)) {
      try {
        bodySnippet = redactText(await response.text());
      } catch (error) {
        bodySnippet = `[unreadable: ${error.message}]`;
      }
    }
    append(logFile, {
      type: 'response',
      at: new Date().toISOString(),
      status: response.status(),
      url: responseUrl,
      headers: redactHeaders(headers),
      bodySnippet,
    });
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

  console.log('[Browser] Opened:', url);
  console.log('[Browser] Network log:', logFile);
  console.log('[Browser] Use this window normally. Close it when done.');
  console.log('[Browser] Sensitive headers/cookies/tokens are redacted before saving.');

  await new Promise((resolve) => context.on('close', resolve));
  console.log('[Browser] Closed. Network log saved:', logFile);
})();
