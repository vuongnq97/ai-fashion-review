/**
 * window-config.js
 * Centralized Playwright/Chromium window sizing and positioning helper.
 * Supports BROWSER_MINI_WINDOW, preset positions (bottom-left, bottom-right, top-left, top-right),
 * config.json integration, pre-seeding Chrome profile Preferences, and exact window coordinates via CDP.
 */

const path = require("path");
const fs = require("fs");

function loadConfigFile(baseDir) {
  try {
    const p = path.join(baseDir || path.resolve(__dirname, ".."), "config.json");
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  } catch (_) {}
  return {};
}

/**
 * Reads browser window configuration with priority:
 * 1. process.env
 * 2. config.json (systemSettings.browserWindow or browserSettings)
 * 3. Default: miniWindow = true, position = "bottom-left", width = 360, height = 260
 */
function getWindowLaunchConfig(baseDir) {
  const fileConfig = loadConfigFile(baseDir);
  const sysConfig = fileConfig.systemSettings || {};
  const browserConfig = sysConfig.browserWindow || fileConfig.browserSettings || sysConfig.browserSettings || {};

  // isMiniWindow: defaults to true unless explicitly disabled in .env or config.json
  let isMiniWindow = true;
  if (process.env.BROWSER_MINI_WINDOW !== undefined) {
    isMiniWindow = process.env.BROWSER_MINI_WINDOW === "true" || process.env.BROWSER_MINI_WINDOW === "1";
  } else if (browserConfig.miniWindow !== undefined) {
    isMiniWindow = Boolean(browserConfig.miniWindow);
  }

  const width = process.env.BROWSER_WINDOW_WIDTH
    || browserConfig.width
    || sysConfig.browserWidth
    || (isMiniWindow ? "360" : null);

  const height = process.env.BROWSER_WINDOW_HEIGHT
    || browserConfig.height
    || sysConfig.browserHeight
    || (isMiniWindow ? "260" : null);

  const position = process.env.BROWSER_WINDOW_POSITION
    || browserConfig.position
    || sysConfig.browserPosition
    || (isMiniWindow ? "bottom-left" : null);

  const windowArgs = [];
  if (width && height) {
    windowArgs.push(`--window-size=${width},${height}`);
  }

  let cliPos = position;
  if (position) {
    const pos = String(position).toLowerCase().trim();
    if (pos === "bottom-left" || pos === "bottom_left") {
      cliPos = "0,1500";
    } else if (pos === "bottom-right" || pos === "bottom_right") {
      cliPos = "3000,1500";
    } else if (pos === "top-left" || pos === "top_left") {
      cliPos = "0,0";
    } else if (pos === "top-right" || pos === "top_right") {
      cliPos = "3000,0";
    }
    windowArgs.push(`--window-position=${cliPos}`);
  }

  if (process.env.BROWSER_START_MINIMIZED === "true") {
    windowArgs.push("--start-minimized");
  }

  return {
    isMiniWindow,
    width,
    height,
    position,
    windowArgs,
    viewport: null, // CRITICAL: null ensures Playwright does not force its 1280x720 default viewport
  };
}

/**
 * Pre-seeds Chrome profile Preferences with the mini-window bounds so Chrome starts
 * directly in the mini-window from the native OS level without any full-screen flash.
 */
function ensureProfileWindowPlacement(userDataDir, customConfig = null) {
  if (!userDataDir) return;
  const config = customConfig || getWindowLaunchConfig();
  if (!config.isMiniWindow) return;

  try {
    const defaultDir = path.join(userDataDir, "Default");
    fs.mkdirSync(defaultDir, { recursive: true });
    const prefPath = path.join(defaultDir, "Preferences");
    let pref = {};
    if (fs.existsSync(prefPath)) {
      try {
        pref = JSON.parse(fs.readFileSync(prefPath, "utf8"));
      } catch (_) { pref = {}; }
    }
    if (!pref.browser) pref.browser = {};

    pref.browser.window_placement = {
      bottom: 812,
      top: 437,
      left: 0,
      right: 500,
      maximized: false,
      work_area_bottom: 812,
      work_area_left: 0,
      work_area_right: 1440,
      work_area_top: 30
    };

    fs.writeFileSync(prefPath, JSON.stringify(pref), "utf8");
  } catch (err) {
    // Non-critical: continue even if Preferences cannot be pre-seeded
  }
}

/**
 * Forcefully set window bounds and position via Chrome DevTools Protocol (CDP)
 * to override any saved OS / profile window geometry and place it at the exact screen corner.
 */
async function applyWindowBounds(context, customConfig = null, targetPage = null) {
  if (!context) return;
  const config = customConfig || getWindowLaunchConfig();
  const { isMiniWindow, width, height, position } = config;
  if (!isMiniWindow && !position && !width && !height) return;

  try {
    const pages = context.pages();
    const page = targetPage || (pages.length > 0 ? pages[0] : await context.newPage());
    const session = await context.newCDPSession(page);
    const { windowId } = await session.send("Browser.getWindowForTarget");

    // 1. Query display screen dimensions
    const scr = await page.evaluate(() => ({
      availWidth: window.screen.availWidth || window.screen.width || 1280,
      availHeight: window.screen.availHeight || window.screen.height || 720
    })).catch(() => ({ availWidth: 1280, availHeight: 720 }));

    const targetW = width ? parseInt(width, 10) : 360;
    const targetH = height ? parseInt(height, 10) : 260;

    // 2. Set requested dimensions
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        width: targetW,
        height: targetH,
        windowState: "normal"
      }
    });

    // 3. Inspect actual window bounds after resize (Chrome clamps min size on macOS)
    const current = await session.send("Browser.getWindowForTarget");
    const actualW = (current.bounds && current.bounds.width) || targetW;
    const actualH = (current.bounds && current.bounds.height) || targetH;

    // 4. Calculate corner coordinates dynamically based on display resolution
    let left = 0;
    let top = 0;
    const pos = (position || "bottom-left").toLowerCase().trim();

    if (pos === "bottom-left" || pos === "bottom_left") {
      left = 0;
      top = Math.max(0, scr.availHeight - actualH);
    } else if (pos === "bottom-right" || pos === "bottom_right") {
      left = Math.max(0, scr.availWidth - actualW);
      top = Math.max(0, scr.availHeight - actualH);
    } else if (pos === "top-left" || pos === "top_left") {
      left = 0;
      top = 0;
    } else if (pos === "top-right" || pos === "top_right") {
      left = Math.max(0, scr.availWidth - actualW);
      top = 0;
    } else if (pos.includes(",")) {
      const parts = pos.split(",");
      left = parseInt(parts[0], 10) || 0;
      top = parseInt(parts[1], 10) || 0;
    }

    // 5. Pin to target corner with exact coordinates
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        left,
        top,
        width: actualW,
        height: actualH,
        windowState: "normal"
      }
    });

    try { await session.detach(); } catch (_) { }
    console.log(`[Browser] 🪟 Cửa sổ Playwright đã thu nhỏ ở góc: ${pos} (${actualW}x${actualH}, x=${left}, y=${top})`);
  } catch (err) {
    console.log(`[Browser] ⚠️ applyWindowBounds warning: ${err.message}`);
  }
}

/**
 * Phóng to CỬA SỔ THẬT của Chrome để vùng hiển thị (viewport) đạt tối thiểu minW x minH,
 * thay vì dùng page.setViewportSize() (giả lập viewport lớn hơn cửa sổ thật → phần dưới/phải
 * của trang, ví dụ thanh cấu hình Model/số lượng/nút gửi của Flow, bị cắt mất).
 * - Không giả lập viewport: trang hiển thị y hệt trình duyệt thật.
 * - Kích thước bị giới hạn theo màn hình (availWidth/availHeight).
 * - Headless: bỏ qua (không có cửa sổ thật).
 * @param {import('playwright').Page} page
 * @param {{minW?: number, minH?: number}} [opts]
 * @returns {Promise<{innerWidth: number, innerHeight: number}|null>}
 */
async function ensureWorkWindow(page, opts = {}) {
  const minW = opts.minW || 1280;
  const minH = opts.minH || 800;
  if (!page || page.isClosed() || process.env.HEADLESS === 'true') return null;

  let session = null;
  try {
    const measure = () => page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      availWidth: window.screen.availWidth || window.screen.width,
      availHeight: window.screen.availHeight || window.screen.height
    }));

    let m = await measure();
    // Đủ lớn rồi (hoặc đã bằng mức tối đa màn hình cho phép) thì không làm gì
    const wantW = Math.min(minW, m.availWidth);
    const wantH = Math.min(minH, m.availHeight - (m.outerHeight - m.innerHeight));
    if (m.innerWidth >= wantW - 4 && m.innerHeight >= wantH - 4) {
      return { innerWidth: m.innerWidth, innerHeight: m.innerHeight };
    }

    const chromeW = Math.max(0, m.outerWidth - m.innerWidth);
    const chromeH = Math.max(0, m.outerHeight - m.innerHeight);
    const width = Math.min(m.availWidth, minW + chromeW);
    const height = Math.min(m.availHeight, minH + chromeH);

    session = await page.context().newCDPSession(page);
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 0, top: 0, width, height, windowState: 'normal' }
    });
    await page.waitForTimeout(400);

    m = await measure();
    console.log(`[Browser] 🪟 Phóng to cửa sổ làm việc: viewport thực ${m.innerWidth}x${m.innerHeight} (màn hình ${m.availWidth}x${m.availHeight})`);
    return { innerWidth: m.innerWidth, innerHeight: m.innerHeight };
  } catch (err) {
    console.log(`[Browser] ⚠️ ensureWorkWindow warning: ${err.message}`);
    return null;
  } finally {
    if (session) { try { await session.detach(); } catch (_) { } }
  }
}

module.exports = {
  getWindowLaunchConfig,
  ensureProfileWindowPlacement,
  applyWindowBounds,
  ensureWorkWindow,
};
