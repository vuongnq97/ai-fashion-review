const path = require('path');

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildAssetNames(imagePathsOrNames) {
  return Array.from(new Set((Array.isArray(imagePathsOrNames) ? imagePathsOrNames : [])
    .map(item => path.basename(String(item || '').trim()))
    .filter(name => /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(name))));
}

async function findActiveAssetTarget(extensionPage, assetNames) {
  if (!extensionPage || extensionPage.isClosed()) return null;
  if (!assetNames.length) return null;

  return extensionPage.evaluate((names) => {
    const items = Array.from(document.querySelectorAll('.queue-body .queue-group .queue-item'));
    const activeItems = items.filter(item => {
      return !item.classList.contains('completed') && !item.classList.contains('stopped');
    });
    const searchItems = activeItems.length > 0 ? activeItems : items;

    for (const item of searchItems) {
      const status = (item.querySelector('.status-text')?.textContent || '').trim();
      const text = `${status}\n${item.innerText || ''}`;
      const lowerText = text.toLowerCase();
      const matchedName = names.find(name => lowerText.includes(String(name).toLowerCase()));
      if (!matchedName) continue;

      return {
        targetName: matchedName,
        status,
        itemIndex: items.indexOf(item),
      };
    }

    return null;
  }, assetNames);
}

async function findAssetCandidate(flowPage, targetName) {
  if (!flowPage || flowPage.isClosed()) return null;

  return flowPage.evaluate((name) => {
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 20
        && rect.height >= 20
        && rect.right > 0
        && rect.bottom > 0
        && rect.left < window.innerWidth
        && rect.top < window.innerHeight;
    };

    const cleanFileName = (value) => {
      const text = String(value || '').trim();
      const panelMatch = text.match(/panel-\d+\.(png|jpe?g|webp|gif|bmp|avif)/i);
      if (panelMatch) return panelMatch[0];

      const fileMatch = text.match(/[\w .()-]+\.(png|jpe?g|webp|gif|bmp|avif)/i);
      return fileMatch ? fileMatch[0].trim() : text;
    };

    const getCardName = (card) => {
      const img = card.querySelector('img');
      const sources = [
        img?.getAttribute('alt'),
        img?.getAttribute('title'),
        card.getAttribute('aria-label'),
        card.getAttribute('title'),
        card.textContent,
      ];

      for (const source of sources) {
        const cleaned = cleanFileName(source);
        if (cleaned) return cleaned;
      }
      return '';
    };

    const targetKey = normalize(name);
    const modalRoots = Array.from(document.body.children).filter(el => {
      if (!isVisible(el)) return false;
      const rect = el.getBoundingClientRect();
      const text = normalize(el.textContent || '');
      const overlaySized = rect.width < window.innerWidth * 0.98 || rect.height < window.innerHeight * 0.98;
      const looksAssetPicker = text.includes('search for assets')
        || text.includes('search assets')
        || text.includes('recent')
        || text.includes('newest')
        || text.includes('tai len')
        || text.includes('upload');
      return overlaySized || looksAssetPicker;
    });
    const roots = modalRoots.length > 0 ? modalRoots : [document];

    const selectors = ['[role="option"]', 'button', '[role="button"]', 'li', 'div'];
    const cards = Array.from(new Set(roots.flatMap(root =>
      selectors.flatMap(selector => Array.from(root.querySelectorAll(selector)))
    )));

    const candidates = [];
    for (const card of cards) {
      if (!isVisible(card)) continue;
      const rect = card.getBoundingClientRect();
      if (rect.width > 420 || rect.height > 180) continue;

      const images = Array.from(card.querySelectorAll('img')).filter(isVisible);
      if (images.length !== 1) continue;

      const rawName = getCardName(card);
      if (normalize(rawName) !== targetKey) continue;

      let clickTarget = card;
      if (!card.matches('[role="option"], button, [role="button"]')) {
        clickTarget = card.closest('[role="option"], button, [role="button"]') || card;
      }
      if (!isVisible(clickTarget)) clickTarget = card;

      const clickRect = clickTarget.getBoundingClientRect();
      let score = 100;
      if (card.getAttribute('role') === 'option') score += 60;
      if (clickTarget.getAttribute('role') === 'option') score += 40;
      if (card.getAttribute('aria-selected') === 'true') score += 10;
      if (rect.width <= 280 && rect.height <= 90) score += 20;

      candidates.push({
        x: clickRect.left + clickRect.width / 2,
        y: clickRect.top + clickRect.height / 2,
        top: clickRect.top,
        left: clickRect.left,
        width: clickRect.width,
        height: clickRect.height,
        rawName,
        text: (clickTarget.textContent || rawName || '').trim().slice(0, 80),
        score,
      });
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (Math.abs(a.top - b.top) > 8) return a.top - b.top;
      return a.left - b.left;
    });

    return candidates[0] || null;
  }, targetName);
}

function startTrustedAssetWatchdog(flowPage, extensionPage, imagePathsOrNames, options = {}) {
  const assetNames = buildAssetNames(imagePathsOrNames);
  const label = options.label || 'FlowAssetWatchdog';
  const intervalMs = Math.max(250, Number(options.intervalMs) || 600);
  const retryAfterMs = Math.max(900, Number(options.retryAfterMs) || 1800);
  const clickedAtByName = new Map();
  let stopped = false;
  let clickCount = 0;

  if (assetNames.length === 0) {
    console.log(`[${label}] Disabled: no asset file names available.`);
    return {
      stop() { stopped = true; },
      getClickCount() { return clickCount; },
    };
  }

  const loop = async () => {
    if (stopped) return;

    try {
      const activeTarget = await findActiveAssetTarget(extensionPage, assetNames);
      if (activeTarget?.targetName) {
        const now = Date.now();
        const lastClickAt = clickedAtByName.get(activeTarget.targetName) || 0;
        if (now - lastClickAt >= retryAfterMs) {
          const candidate = await findAssetCandidate(flowPage, activeTarget.targetName);
          if (candidate) {
            clickedAtByName.set(activeTarget.targetName, now);
            clickCount += 1;
            console.log(
              `[${label}] Trusted asset click ${activeTarget.targetName} at (${Math.round(candidate.x)}, ${Math.round(candidate.y)}), ` +
              `card=${Math.round(candidate.width)}x${Math.round(candidate.height)} "${candidate.text || candidate.rawName}"`
            );
            await flowPage.bringToFront().catch(() => {});
            await flowPage.mouse.move(candidate.x, candidate.y).catch(() => {});
            await flowPage.mouse.down().catch(() => {});
            await flowPage.waitForTimeout(80).catch(() => {});
            await flowPage.mouse.up().catch(() => {});
          }
        }
      }
    } catch (error) {
      if (!stopped) {
        console.log(`[${label}] Warning: ${error.message}`);
      }
    }

    if (!stopped) {
      setTimeout(loop, intervalMs);
    }
  };

  setTimeout(loop, intervalMs);

  return {
    stop() { stopped = true; },
    getClickCount() { return clickCount; },
  };
}

module.exports = {
  buildAssetNames,
  startTrustedAssetWatchdog,
};
