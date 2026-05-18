const { chromium } = require('playwright');
const path = require('path');
const { EXTENSION_ID, getExtensionArgs } = require('./utils/extension-loader');

(async () => {
  const userDataDir = path.join(__dirname, 'chrome-data');
  console.log('----------------------------------------------------');
  console.log('Mở trình duyệt để bạn đăng nhập Google. Vui lòng không đóng trình duyệt cho đến khi đăng nhập xong.');
  console.log('----------------------------------------------------');
  
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      ...getExtensionArgs(__dirname),
    ]
  });

  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${EXTENSION_ID}/popup.html?skipIntro=1&tab=control-tab&mode=frame-to-video&defaults=1`);
  console.log('Đã mở extension ở Automation → Frame to Video.');

  const page = await context.newPage();
  await page.goto('https://labs.google.com/fx');
  
  console.log('1. Hãy đăng nhập vào Google.');
  console.log('2. Đợi giao diện Google Labs tải thành công.');
  console.log('3. Quay lại Terminal và nhấn Ctrl+C để kết thúc, HOẶC đóng trình duyệt.');
  console.log('Session của bạn sẽ được lưu lại trong thư mục chrome-data để Playwright chạy ngầm sau này!');
})();
