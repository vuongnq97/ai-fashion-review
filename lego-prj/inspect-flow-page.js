const { chromium } = require('playwright');

async function inspectFlow() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const pages = context.pages();
  const flowPage = pages.find(p => p.url().includes('flow.google.com'));

  if (!flowPage) {
    console.error('Flow page not found');
    await browser.close();
    return;
  }

  console.log('Flow URL:', flowPage.url());

  // Check buttons and inputs
  const buttons = await flowPage.$$eval('button', btns => 
    btns.map(b => ({
      text: b.innerText.trim().replace(/\n/g, ' '),
      aria: b.getAttribute('aria-label'),
      role: b.getAttribute('role')
    })).filter(b => b.text || b.aria)
  );

  console.log('--- Buttons on page (filtered) ---');
  buttons.forEach(b => {
    if (b.text.includes('Hình ảnh') || b.text.includes('Video') || b.text.includes('arrow') || b.aria || b.text.includes('Tạo') || b.text.includes('Generate') || b.text.includes('Tỷ lệ')) {
      console.log(`[Button] text: "${b.text}" | aria: "${b.aria}"`);
    }
  });

  // Check inputs
  const inputs = await flowPage.$$eval('input, textarea, [contenteditable="true"]', elements =>
    elements.map(el => ({
      tag: el.tagName.toLowerCase(),
      type: el.type,
      placeholder: el.placeholder,
      contentEditable: el.getAttribute('contenteditable'),
      class: el.className
    }))
  );

  console.log('\n--- Input elements ---');
  inputs.forEach(inp => console.log(inp));

  await browser.close();
}

inspectFlow();
