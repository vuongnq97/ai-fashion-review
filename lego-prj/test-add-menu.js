const { chromium } = require('playwright');

async function testAddReference() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('flow.google.com'));

  console.log('Clicking add reference button...');
  const addBtn = page.locator('button[aria-label="Thêm thành phần vào ô nhập câu lệnh"]').first();
  await addBtn.click();
  await page.waitForTimeout(600);

  const menuItems = await page.evaluate(() => {
    const pane = document.querySelector('.cdk-overlay-pane, [role="menu"]');
    if (!pane) return [];
    return Array.from(pane.querySelectorAll('button, [role="menuitem"], [role="option"]')).map(el => ({
      text: el.innerText.trim().replace(/\n/g, ' '),
      role: el.getAttribute('role')
    }));
  });

  console.log('Menu items after clicking Add:', JSON.stringify(menuItems, null, 2));

  await page.keyboard.press('Escape');
  await browser.close();
}

testAddReference();
