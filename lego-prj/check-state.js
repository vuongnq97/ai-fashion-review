const { chromium } = require('playwright');

async function checkState() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('flow.google.com'));

  const state = await page.evaluate(() => {
    const overlays = Array.from(document.querySelectorAll('.cdk-overlay-backdrop, .cdk-overlay-pane'));
    const btn = document.querySelector('.settings-trigger-button');
    const editor = document.querySelector('.ProseMirror');
    return {
      overlaysCount: overlays.length,
      settingsBtnText: btn ? btn.innerText.replace(/\n/g, ' ') : null,
      editorText: editor ? editor.innerText : null
    };
  });

  console.log('Current state:', state);

  // If overlays exist, press Escape to dismiss
  if (state.overlaysCount > 0) {
    console.log('Dismissing overlays...');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
  }

  await browser.close();
}

checkState();
