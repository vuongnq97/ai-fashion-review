/**
 * window-config.js
 * Centralized Playwright/Chromium window sizing and positioning helper.
 * Supports BROWSER_MINI_WINDOW, preset positions (bottom-left, bottom-right, top-left, top-right),
 * and applies exact window coordinates via Chrome DevTools Protocol (CDP).
 */

function getWindowLaunchConfig() {
  const isMiniWindow = process.env.BROWSER_MINI_WINDOW === 'true';
  const width = process.env.BROWSER_WINDOW_WIDTH || (isMiniWindow ? '400' : null);
  const height = process.env.BROWSER_WINDOW_HEIGHT || (isMiniWindow ? '300' : null);
  const position = process.env.BROWSER_WINDOW_POSITION || (isMiniWindow ? 'bottom-left' : null);

  const windowArgs = [];
  if (width && height) {
    windowArgs.push(`--window-size=${width},${height}`);
  }

  let cliPos = position;
  if (position) {
    const pos = position.toLowerCase().trim();
    if (pos === 'bottom-left' || pos === 'bottom_left') {
      cliPos = '0,1500';
    } else if (pos === 'bottom-right' || pos === 'bottom_right') {
      cliPos = '3000,1500';
    } else if (pos === 'top-left' || pos === 'top_left') {
      cliPos = '0,0';
    } else if (pos === 'top-right' || pos === 'top_right') {
      cliPos = '3000,0';
    }
    windowArgs.push(`--window-position=${cliPos}`);
  }

  if (process.env.BROWSER_START_MINIMIZED === 'true') {
    windowArgs.push('--start-minimized');
  }

  const viewport = (width && height)
    ? { width: parseInt(width, 10), height: parseInt(height, 10) }
    : null;

  return {
    isMiniWindow,
    width,
    height,
    position,
    windowArgs,
    viewport,
  };
}

/**
 * Forcefully set window bounds and position via Chrome DevTools Protocol (CDP)
 * to override any saved OS / profile window geometry.
 */
async function applyWindowBounds(context, customConfig = null) {
  if (!context) return;
  const config = customConfig || getWindowLaunchConfig();
  const { width, height, position } = config;
  if (!position && !width && !height) return;

  try {
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();
    const session = await context.newCDPSession(page);
    const { windowId } = await session.send('Browser.getWindowForTarget');

    let left = 0;
    let top = 0;
    const w = width ? parseInt(width, 10) : 400;
    const h = height ? parseInt(height, 10) : 300;

    const pos = (position || '').toLowerCase().trim();
    if (pos === 'bottom-left' || pos === 'bottom_left') {
      left = 0;
      top = 1500; // Clamped by macOS/Windows window manager to screen bottom-left
    } else if (pos === 'bottom-right' || pos === 'bottom_right') {
      left = 3000;
      top = 1500;
    } else if (pos === 'top-left' || pos === 'top_left') {
      left = 0;
      top = 0;
    } else if (pos === 'top-right' || pos === 'top_right') {
      left = 3000;
      top = 0;
    } else if (pos.includes(',')) {
      const parts = pos.split(',');
      left = parseInt(parts[0], 10) || 0;
      top = parseInt(parts[1], 10) || 0;
    }

    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: {
        left,
        top,
        width: w,
        height: h,
        windowState: 'normal'
      }
    });
    try { await session.detach(); } catch (_) { }
    console.log(`[Browser] 🪟 Cửa sổ đã được định vị tại: ${pos || `${left},${top}`} (${w}x${h})`);
  } catch (err) {
    // Non-critical: continue even if CDP bounds can't be set
  }
}

module.exports = {
  getWindowLaunchConfig,
  applyWindowBounds,
};
