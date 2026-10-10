const { chromium } = require('playwright');
const path = require('path');

async function testFileUpload() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('flow.google.com'));

  // Test with one of the downloaded images
  const testImg = path.join(__dirname, 'downloads/7277168939/01_hero.jpeg');

  console.log('Clicking add reference button...');
  const addBtn = page.locator('button[aria-label="Thêm thành phần vào ô nhập câu lệnh"]').first();
  await addBtn.click();
  await page.waitForTimeout(500);

  const uploadBtn = page.locator('.cdk-overlay-pane button', { hasText: /Tải nội dung nghe nhìn lên/i }).first();
  console.log('Listening for filechooser and clicking upload...');
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    uploadBtn.click()
  ]);

  console.log('Setting file to:', testImg);
  await fileChooser.setFiles(testImg);
  console.log('File set successfully! Waiting 3s for upload...');
  await page.waitForTimeout(3000);

  // Check if chip appeared in composer
  const chips = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.ProseMirror, [class*="chip"], [class*="tag"], [class*="pill"]')).map(el => ({
      class: el.className,
      text: el.innerText.trim()
    }));
  });
  console.log('Chips/Elements:', JSON.stringify(chips, null, 2));

  await browser.close();
}

testFileUpload();
