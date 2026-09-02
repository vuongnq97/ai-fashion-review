/**
 * gemini-cookie-refresher.js
 * Shared singleton: export Gemini cookies tối đa 1 lần mỗi 45 phút.
 * Được gọi trước khi scheduler chạy để đảm bảo cookies còn hạn.
 */

const path = require('path');
const { spawn } = require('child_process');

// Thời gian tối thiểu giữa 2 lần export (ms)
const MIN_REFRESH_INTERVAL_MS = 45 * 60 * 1000; // 45 phút

// Timestamp lần export cuối (dùng chung cho tất cả schedulers)
let lastExportedAt = 0;
let isExporting = false;

/**
 * Export Gemini cookies nếu đã quá MIN_REFRESH_INTERVAL_MS từ lần cuối.
 * Nếu đang export thì đợi cho đến khi xong.
 * @param {string} [baseDir] - thư mục gốc của playwright-service
 * @returns {Promise<boolean>} true nếu đã export, false nếu bỏ qua
 */
async function maybeRefreshCookies(baseDir = path.resolve(__dirname, '..')) {
  const now = Date.now();
  const elapsed = now - lastExportedAt;

  if (elapsed < MIN_REFRESH_INTERVAL_MS) {
    const minutesAgo = Math.round(elapsed / 60000);
    console.log(`[CookieRefresher] Bỏ qua export — lần cuối ${minutesAgo} phút trước (< 45 phút).`);
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
 * Chạy export-gemini-cookies.js, timeout 30s.
 */
async function runExport(baseDir) {
  isExporting = true;
  const exportScript = path.join(baseDir, 'export-gemini-cookies.js');
  console.log('[CookieRefresher] 🍪 Đang export Gemini cookies (timeout 30s)...');

  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [exportScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: baseDir,
      env: { ...process.env },
    });

    let output = '';
    proc.stdout?.on('data', d => { output += d; });
    proc.stderr?.on('data', d => { output += d; });

    const timeout = setTimeout(() => {
      console.log('[CookieRefresher] ⏱️ Timeout 30s — tiếp tục mà không kill.');
      proc.kill('SIGTERM');
      lastExportedAt = Date.now();
      isExporting = false;
      resolve(true);
    }, 30000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      lastExportedAt = Date.now();
      isExporting = false;
      if (code === 0) {
        console.log('[CookieRefresher] ✅ Export Gemini cookies thành công.');
      } else {
        console.warn(`[CookieRefresher] ⚠️ Export thoát với code ${code}.`);
        if (output.trim()) console.warn('[CookieRefresher] Output:', output.slice(-300));
      }
      resolve(code === 0);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      isExporting = false;
      console.warn('[CookieRefresher] ❌ Lỗi chạy export:', err.message);
      resolve(false);
    });
  });
}

/**
 * Đánh dấu đã export (dùng khi startup đã export rồi)
 */
function markExportedNow() {
  lastExportedAt = Date.now();
}

module.exports = { maybeRefreshCookies, markExportedNow };
