const { chromium } = require('playwright');

async function checkFileInputs() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('flow.google.com'));

  const fileInputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input[type="file"]')).map(el => ({
      name: el.name,
      id: el.id,
      accept: el.accept,
      multiple: el.multiple,
      parent: el.parentElement?.tagName
    }));
  });

  console.log('FileInputs count:', fileInputs.length);
  console.log(fileInputs);

  await browser.close();
}

checkFileInputs();
