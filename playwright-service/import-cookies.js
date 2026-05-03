const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const userDataDir = path.join(__dirname, 'chrome-data');
  const cookiesPath = path.join(__dirname, 'labs.google.cookies.json');
  
  if (!fs.existsSync(cookiesPath)) {
    console.error('❌ Không tìm thấy file labs.google.cookies.json');
    return;
  }

  try {
    const cookiesStr = fs.readFileSync(cookiesPath, 'utf8');
    const cookies = JSON.parse(cookiesStr);

    console.log(`Đang nạp ${cookies.length} cookies vào hệ thống...`);

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      args: ['--disable-blink-features=AutomationControlled']
    });

    // Bơm cookies vào context
    await context.addCookies(cookies);
    console.log('✅ Đã nạp cookies thành công vào chrome-data!');
    
    // Test thử xem đã login được chưa
    console.log('Đang mở trang Google Labs để kiểm tra...');
    const page = await context.newPage();
    await page.goto('https://labs.google/fx/');
    
    // Đợi 5 giây cho trang load xong hẳn
    await page.waitForTimeout(5000); 
    
    const title = await page.title();
    console.log('Tiêu đề trang web hiện tại: ', title);
    
    await page.screenshot({ path: path.join(__dirname, 'login-verify.png') });
    console.log('📸 Đã chụp ảnh màn hình lưu tại playwright-service/login-verify.png. Bạn có thể mở ảnh này ra xem đã login thành công chưa!');

    await context.close();
  } catch (error) {
    console.error('❌ Có lỗi xảy ra:', error);
  }
})();
