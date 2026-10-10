const { chromium } = require('playwright');

async function inspectComposer() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('flow.google.com'));

  // Get composer container elements
  const info = await page.evaluate(() => {
    const editor = document.querySelector('.ProseMirror');
    const container = editor ? editor.closest('form, [class*="composer"], [class*="input"], div:has(button)') : null;
    
    // Find all buttons inside bottom bar
    const bottomButtons = Array.from(document.querySelectorAll('button')).map(b => ({
      text: b.innerText.trim(),
      aria: b.getAttribute('aria-label'),
      title: b.getAttribute('title'),
      class: b.className
    })).filter(b => b.text || b.aria || b.title);

    return {
      editorText: editor ? editor.innerText : null,
      bottomButtons: bottomButtons.slice(-15) // last 15 buttons (usually composer area)
    };
  });

  console.log('Composer info:', JSON.stringify(info, null, 2));
  await browser.close();
}

inspectComposer();
