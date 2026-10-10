const { chromium } = require('playwright');

async function testCDP() {
  try {
    console.log('Connecting to Chrome CDP at http://127.0.0.1:9222 ...');
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const contexts = browser.contexts();
    console.log('Contexts count:', contexts.length);
    
    const defaultContext = contexts[0];
    const pages = defaultContext.pages();
    console.log('Pages count:', pages.length);
    
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      console.log(`Page [${i}]: ${await p.title()} (${p.url()})`);
    }

    // Tìm trang Flow
    const flowPage = pages.find(p => p.url().includes('flow.google.com'));
    if (flowPage) {
      console.log('Found Flow Page! Title:', await flowPage.title());
    } else {
      console.log('Flow Page not found in open pages');
    }

    await browser.close();
    console.log('Disconnected CDP cleanly.');
  } catch (err) {
    console.error('CDP Error:', err.message);
  }
}

testCDP();
