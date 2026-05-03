const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

(async () => {
  const userDataDir = path.join(__dirname, 'chrome-data');
  const cookiesPath = path.join(__dirname, 'labs.google.cookies.json');

  console.log('🚀 Đang mở browser để update cookies...');
  console.log('📂 Profile: chrome-data');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const page = await context.newPage();
  await page.goto('https://labs.google/fx/tools/image-fx');

  console.log('');
  console.log('===========================================');
  console.log('🔑 Browser đã mở tại labs.google');
  console.log('   - Nếu đã login rồi → nhấn Enter để export cookies');
  console.log('   - Nếu chưa login → đăng nhập xong rồi nhấn Enter');
  console.log('===========================================');
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  await new Promise(resolve => {
    rl.question('👉 Nhấn Enter khi đã sẵn sàng export cookies... ', () => {
      rl.close();
      resolve();
    });
  });

  // Export cookies for labs.google domain
  const allCookies = await context.cookies(['https://labs.google']);
  
  // Filter relevant cookies
  const relevantCookies = allCookies.map(c => {
    const cookie = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
    };
    if (c.sameSite && c.sameSite !== 'None') {
      cookie.sameSite = c.sameSite;
    }
    return cookie;
  });

  // Backup old cookies
  if (fs.existsSync(cookiesPath)) {
    const backupPath = cookiesPath.replace('.json', `.backup-${Date.now()}.json`);
    fs.copyFileSync(cookiesPath, backupPath);
    console.log(`📦 Đã backup cookies cũ tại: ${path.basename(backupPath)}`);
  }

  // Write new cookies
  fs.writeFileSync(cookiesPath, JSON.stringify(relevantCookies, null, 2));
  console.log(`✅ Đã export ${relevantCookies.length} cookies vào labs.google.cookies.json`);

  // Show summary
  const sessionCookie = relevantCookies.find(c => c.name === '__Secure-next-auth.session-token');
  if (sessionCookie) {
    const expDate = new Date(sessionCookie.expires * 1000);
    console.log(`🔐 Session token expires: ${expDate.toLocaleString()}`);
  } else {
    console.log('⚠️  Không tìm thấy session token - có thể chưa đăng nhập!');
  }

  await context.close();
  console.log('🏁 Done!');
})();
