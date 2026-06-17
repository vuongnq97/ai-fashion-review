'use strict';
/**
 * smoke-test-gemini-client.js
 * Quick test: init GeminiApiClient, verify token extraction.
 * Run with: node smoke-test-gemini-client.js
 *
 * Requires: GEMINI_SECURE_1PSID in .env or environment
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { GeminiApiClient } = require('./services/gemini-client/gemini-api');
const path = require('path');

async function main() {
  const secure1Psid = (process.env.GEMINI_SECURE_1PSID || '').trim();
  const secure1Psidts = (process.env.GEMINI_SECURE_1PSIDTS || '').trim();

  if (!secure1Psid) {
    console.error('[SmokeTest] ❌ GEMINI_SECURE_1PSID not set in .env');
    process.exit(1);
  }

  console.log('[SmokeTest] Initializing GeminiApiClient...');
  const cookieFilePath = process.env.GEMINI_COOKIE_PATH
    ? path.resolve(__dirname, process.env.GEMINI_COOKIE_PATH)
    : null;
  const client = new GeminiApiClient({ secure1Psid, secure1Psidts, cookieFilePath });

  try {
    await client.init();
    console.log('[SmokeTest] ✅ Init success!');
    console.log(`  accessToken: ${client.accessToken ? client.accessToken.slice(0, 20) + '...' : 'null'}`);
    console.log(`  buildLabel:  ${client.buildLabel || 'null'}`);
    console.log(`  sessionId:   ${client.sessionId ? client.sessionId.slice(0, 20) + '...' : 'null'}`);
    console.log(`  language:    ${client.language}`);
    console.log(`  pushId:      ${client.pushId}`);

    console.log('\n[SmokeTest] Sending a simple text prompt...');
    const result = await client.generateContent({
      prompt: 'Say "Hello from Node.js Gemini client" in exactly those words.',
      temporary: true,
    });

    console.log(`[SmokeTest] ✅ Response text (${result.text.length} chars): "${result.text.slice(0, 300)}"`);
    console.log(`[SmokeTest]    Images returned: ${result.images.length}`);

  } catch (err) {
    console.error('[SmokeTest] ❌ Error:', err.message);
    process.exit(1);
  } finally {
    await client.close();
    console.log('[SmokeTest] Client closed.');
  }
}

main();
