#!/usr/bin/env node
'use strict';

/**
 * broadcast-notification.js
 * 
 * Script gửi thông báo hàng loạt đến tất cả các Shop (Telegram Chat Groups) đang sử dụng Bot.
 * 
 * CÁCH SỬ DỤNG:
 * 1. Gửi tin nhắn mặc định được cài đặt sẵn trong file:
 *    node broadcast-notification.js
 * 
 * 2. Gửi tin nhắn tùy chỉnh truyền qua dòng lệnh:
 *    node broadcast-notification.js "Nội dung thông báo cần gửi tới tất cả các shop"
 *    hoặc:
 *    node broadcast-notification.js --msg="Nội dung thông báo"
 * 
 * 3. Chế độ chạy thử (Dry Run - chỉ kiểm tra danh sách shop và xem trước tin nhắn, không gửi):
 *    node broadcast-notification.js --dry-run
 *    hoặc:
 *    node broadcast-notification.js -d "Nội dung cần test"
 */

// Bỏ qua kiểm tra chứng chỉ SSL/TLS nếu có self-signed proxy
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Nạp biến môi trường từ .env
const envPath = path.resolve(__dirname, '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const { sendTelegramMessage } = require('./services/telegram-send');

// =============================================================================
// 📝 NỘI DUNG THÔNG BÁO MẶC ĐỊNH (Bạn có thể chỉnh sửa trực tiếp nội dung ở đây)
// Hỗ trợ định dạng HTML của Telegram: <b>in đậm</b>, <i>in nghiêng</i>, <code>code</code>
// =============================================================================
const DEFAULT_MESSAGE = `
📢 <b>THÔNG BÁO: HOÀN TẤT BẢO TRÌ HỆ THỐNG</b>

Kính gửi các Shop, 👋

Hệ thống Bot vừa hoàn tất quá trình bảo trì và nâng cấp kỹ thuật:
✅ Đã khởi động lại toàn bộ dịch vụ và tối ưu hiệu năng.
✅ Tất cả tính năng tạo video AI, gắn link giỏ hàng và đăng bài TikTok Shop đã hoạt động ổn định trở lại.

Mọi người có thể tiếp tục gửi link sản phẩm để tạo video như thường lệ nhé!
Cảm ơn các Shop đã đồng hành và kiên nhẫn chờ đợi. Chúc các Shop nổ thật nhiều đơn! 🚀🛒
`.trim();

/**
 * Đọc cấu hình danh sách các Shop / Channels từ config.json
 */
function getTargetShops() {
  const configFile = path.resolve(__dirname, 'config.json');
  if (!fs.existsSync(configFile)) {
    console.error(`❌ Không tìm thấy file cấu hình: ${configFile}`);
    return [];
  }

  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    console.error(`❌ Lỗi đọc JSON từ config.json:`, err.message);
    return [];
  }

  const shopsMap = new Map();

  // 1. Quét danh sách channels chính trong config.json
  if (config.channels && typeof config.channels === 'object') {
    for (const [chatId, data] of Object.entries(config.channels)) {
      if (!chatId || !chatId.trim()) continue;
      const label = data.label || data.tiktokCredentialName || `Shop ${chatId}`;
      const tiktokAcc = data.tiktokCredentialName ? `(${data.tiktokCredentialName})` : '';
      shopsMap.set(String(chatId), {
        chatId: String(chatId),
        name: `${label} ${tiktokAcc}`.trim(),
        status: data.status || 'active'
      });
    }
  }

  // 2. Bổ sung các chat ID từ cấu hình autoT3, autoT4, autoT5 nếu chưa có
  const autoKeys = ['autoT3Settings', 'autoT4Settings', 'autoT5Settings'];
  for (const key of autoKeys) {
    const s = config[key];
    if (s && s.chatId && !shopsMap.has(String(s.chatId))) {
      shopsMap.set(String(s.chatId), {
        chatId: String(s.chatId),
        name: `Shop Kênh ${key.replace('Settings', '')}`,
        status: 'active'
      });
    }
  }

  return Array.from(shopsMap.values());
}

/**
 * Trợ giúp phân tích tham số dòng lệnh
 */
function parseArgs() {
  const args = process.argv.slice(2);
  let isDryRun = false;
  let customMessage = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run' || arg === '-d') {
      isDryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Hướng dẫn sử dụng broadcast-notification.js:
  node broadcast-notification.js                           # Gửi tin nhắn mặc định
  node broadcast-notification.js "Nội dung thông báo"      # Gửi tin nhắn tùy biến
  node broadcast-notification.js --dry-run                 # Chạy thử (không gửi tin nhắn thật)
  node broadcast-notification.js -d "Nội dung"             # Chạy thử với tin nhắn tùy biến
      `);
      process.exit(0);
    } else if (arg.startsWith('--msg=')) {
      customMessage = arg.substring(6);
    } else if (arg === '-m' && i + 1 < args.length) {
      customMessage = args[++i];
    } else if (!arg.startsWith('-')) {
      if (customMessage) {
        customMessage += ' ' + arg;
      } else {
        customMessage = arg;
      }
    }
  }

  return {
    isDryRun,
    message: (customMessage || DEFAULT_MESSAGE).replace(/\\n/g, '\n').trim()
  };
}

/**
 * Hàm sleep nhẹ giữa các lần gửi để tránh chạm Rate Limit của Telegram (429 Too Many Requests)
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Thực thi gửi thông báo
 */
async function run() {
  const { isDryRun, message } = parseArgs();
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    console.error('❌ Lỗi: TELEGRAM_BOT_TOKEN chưa được cấu hình trong file .env');
    process.exit(1);
  }

  const shops = getTargetShops();

  console.log('='.repeat(65));
  console.log('📢 BẮT ĐẦU CHƯƠNG TRÌNH GỬI THÔNG BÁO TỚI TẤT CẢ CÁC SHOP');
  console.log('='.repeat(65));
  console.log(`🔹 Tổng số shop phát hiện: ${shops.length}`);
  console.log(`🔹 Chế độ: ${isDryRun ? '🧪 DRY-RUN (Chỉ kiểm tra, KHÔNG gửi thật)' : '🚀 THỰC TẾ (Sẽ gửi tin nhắn đến các nhóm)'}`);
  console.log('-'.repeat(65));
  console.log('📄 NỘI DUNG SẼ GỬI:');
  console.log(message);
  console.log('-'.repeat(65));

  if (shops.length === 0) {
    console.log('⚠️ Không tìm thấy shop nào trong config.json.');
    return;
  }

  if (isDryRun) {
    console.log('📋 DANH SÁCH CÁC SHOP SẼ NHẬN ĐƯỢC TIN NHẮN:');
    shops.forEach((shop, index) => {
      console.log(`  ${index + 1}. [${shop.chatId}] ${shop.name} (${shop.status})`);
    });
    console.log('\n✅ Kết thúc kiểm tra Dry-run. Bỏ cờ --dry-run để thực hiện gửi thật.');
    return;
  }

  let successCount = 0;
  let failCount = 0;
  const failedShops = [];

  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];
    const prefix = `[${i + 1}/${shops.length}] ${shop.name} (${shop.chatId})`;

    process.stdout.write(`⏳ Đang gửi tới ${prefix}... `);
    try {
      const res = await sendTelegramMessage(shop.chatId, message, { parse_mode: 'HTML' });
      if (res) {
        console.log('✅ Thành công');
        successCount++;
      } else {
        console.log('❌ Thất bại (bot có thể chưa được add vào nhóm hoặc bị block)');
        failCount++;
        failedShops.push({ ...shop, reason: 'Gửi thất bại (sendTelegramMessage trả về false)' });
      }
    } catch (err) {
      console.log(`❌ Lỗi: ${err.message}`);
      failCount++;
      failedShops.push({ ...shop, reason: err.message });
    }

    // Delay 300ms giữa mỗi shop để giữ an toàn tuyệt đối với giới hạn của Telegram API
    if (i < shops.length - 1) {
      await sleep(300);
    }
  }

  console.log('\n' + '='.repeat(65));
  console.log('🏁 KẾT QUẢ GỬI THÔNG BÁO:');
  console.log(`  - ✅ Gửi thành công: ${successCount}/${shops.length} shop`);
  console.log(`  - ❌ Thất bại:        ${failCount}/${shops.length} shop`);

  if (failedShops.length > 0) {
    console.log('\nDanh sách shop gửi không thành công:');
    failedShops.forEach(f => {
      console.log(`  • ${f.name} (${f.chatId}): ${f.reason}`);
    });
  }
  console.log('='.repeat(65));
}

// Chạy script
run().catch(err => {
  console.error('❌ Lỗi không xác định khi thực thi script:', err);
  process.exit(1);
});
