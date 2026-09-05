/**
 * gemini-cookie-refresher.js
 * Shared singleton: export Gemini cookies 1 lần mỗi khung giờ (hour).
 * Scheduler đầu tiên mỗi round (VD: :00) sẽ export, các shop chạy sau (:10, :20) skip.
 */

const path = require('path');
const { autoExportCookies } = require('./auto-cookie-exporter');

// Timestamp lần export cuối (dùng chung cho tất cả schedulers)
let lastExportedAt = 0;
let isExporting = false;

/**
 * Export Gemini cookies nếu chưa export trong giờ hiện tại.
 * Ví dụ: export lúc 06:00 → skip 06:10, 06:20 → export lại 08:00
 * @param {string} [baseDir] - thư mục gốc của playwright-service
 * @returns {Promise<boolean>} true nếu đã export, false nếu bỏ qua
 */
async function maybeRefreshCookies(baseDir = path.resolve(__dirname, '..')) {
  const now = Date.now();
  const currentHour = new Date().getHours();
  const lastExportHour = lastExportedAt > 0 ? new Date(lastExportedAt).getHours() : -1;
  const elapsed = now - lastExportedAt;

  // Skip nếu đã export trong cùng giờ này (và cách đây < 2 tiếng để tránh edge case qua ngày)
  if (lastExportHour === currentHour && elapsed < 2 * 60 * 60 * 1000) {
    const minutesAgo = Math.round(elapsed / 60000);
    console.log(`[CookieRefresher] Bỏ qua export — đã export ${minutesAgo} phút trước (cùng giờ ${currentHour}h).`);
    return false;
  }

  // Nếu đang có export chạy, đợi nó xong
  if (isExporting) {
    console.log('[CookieRefresher] Đang có export chạy, đợi...');
    await new Promise(resolve => {
      const check = setInterval(() => {
        if (!isExporting) { clearInterval(check); resolve(); }
      }, 1000);
    });
    return false; // đã được refresh bởi instance khác
  }

  return runExport(baseDir);
}

/**
 * Chạy autoExportCookies tự động từ chrome-data (headless, 3-5s).
 */
async function runExport(baseDir) {
  isExporting = true;
  console.log('[CookieRefresher] 🍪 Đang export Gemini cookies tự động từ chrome-data...');

  try {
    const ok = await autoExportCookies(baseDir);
    lastExportedAt = Date.now();
    isExporting = false;
    if (ok) {
      console.log('[CookieRefresher] ✅ Export Gemini cookies tự động thành công.');
    } else {
      console.warn('[CookieRefresher] ⚠️ Auto-cookie export không tìm thấy cookie mới (dùng cookie hiện tại).');
    }
    return ok;
  } catch (err) {
    lastExportedAt = Date.now();
    isExporting = false;
    console.warn('[CookieRefresher] ❌ Lỗi export cookie:', err.message);
    return false;
  }
}

/**
 * Đánh dấu đã export (dùng khi startup đã export rồi)
 */
function markExportedNow() {
  lastExportedAt = Date.now();
}

module.exports = { maybeRefreshCookies, markExportedNow };
