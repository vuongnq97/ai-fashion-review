const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { getExtensionArgs } = require('./utils/extension-loader');
const { adoptBrowserPage, PROJECT_URL } = require('./services/browser');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function recorderScript() {
  if (window.__flowXPathRecorderInstalled) return;
  window.__flowXPathRecorderInstalled = true;

  const MAX_TEXT = 180;

  function cleanText(value, max = MAX_TEXT) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  }

  function getXPath(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return '';
    if (element.id) return `//*[@id="${element.id}"]`;

    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.nodeName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }

      const sameTagSiblings = Array.from(parent.children)
        .filter(child => child.nodeName.toLowerCase() === tag);
      const index = sameTagSiblings.indexOf(node) + 1;
      parts.unshift(`${tag}[${index}]`);
      node = parent;
    }

    return `/${parts.join('/')}`;
  }

  function getCssPath(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return '';
    if (element.id) return `#${CSS.escape(element.id)}`;

    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      let selector = node.nodeName.toLowerCase();
      const classes = Array.from(node.classList || [])
        .filter(Boolean)
        .slice(0, 3);
      if (classes.length) {
        selector += classes.map(name => `.${CSS.escape(name)}`).join('');
      }

      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children)
          .filter(child => child.nodeName.toLowerCase() === node.nodeName.toLowerCase());
        if (siblings.length > 1) selector += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }

      parts.unshift(selector);
      node = parent;
    }

    return parts.join(' > ');
  }

  function getVisibleFloatingRootsSummary() {
    return Array.from(document.body.children)
      .map((el, index) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return null;
        return {
          index,
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          className: cleanText(el.className, 100),
          text: cleanText(el.textContent, 120),
          xpath: getXPath(el),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        };
      })
      .filter(Boolean)
      .slice(-10);
  }

  function describeElement(element) {
    const rect = element.getBoundingClientRect();
    const computed = window.getComputedStyle(element);
    const attrs = {};
    for (const name of ['id', 'class', 'role', 'aria-label', 'title', 'name', 'type', 'data-testid', 'data-test-id']) {
      const value = element.getAttribute?.(name);
      if (value) attrs[name] = value;
    }

    return {
      tag: element.tagName.toLowerCase(),
      text: cleanText(element.textContent),
      value: cleanText(element.value, 120),
      placeholder: cleanText(element.getAttribute?.('placeholder'), 120),
      attrs,
      xpath: getXPath(element),
      cssPath: getCssPath(element),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      visible: rect.width > 0 && rect.height > 0 && computed.display !== 'none' && computed.visibility !== 'hidden',
      outerHTML: cleanText(element.outerHTML, 500)
    };
  }

  function describeCompact(element, maxText = 140) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    const rect = element.getBoundingClientRect();
    const attrs = {};
    for (const name of ['id', 'class', 'role', 'aria-label', 'title', 'data-scroll-state', 'data-testid', 'data-test-id']) {
      const value = element.getAttribute?.(name);
      if (value) attrs[name] = cleanText(value, 120);
    }
    const img = element.querySelector?.('img');
    return {
      tag: element.tagName.toLowerCase(),
      text: cleanText(element.textContent, maxText),
      attrs,
      xpath: getXPath(element),
      cssPath: getCssPath(element),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      img: img ? {
        alt: cleanText(img.getAttribute('alt'), 120),
        src: cleanText(img.currentSrc || img.src, 180)
      } : null,
      html: cleanText(element.outerHTML, 650)
    };
  }

  function isVisible(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function collectSnapshot(label = '') {
    const visible = selector => Array.from(document.querySelectorAll(selector)).filter(isVisible);
    const assetCards = visible('[role="option"], div[data-index][data-item-index], li, button, div')
      .filter(el => {
        const text = cleanText(el.textContent, 160);
        const img = el.querySelector('img');
        const alt = cleanText(img?.getAttribute('alt'), 160);
        return img && (/\.(png|jpe?g|webp|gif|bmp|avif)/i.test(text + ' ' + alt) || text.includes('panel-') || alt.includes('panel-'));
      })
      .slice(0, 12)
      .map(el => describeCompact(el));

    const frameLike = visible('[data-scroll-state], [aria-label], div, button')
      .filter(el => {
        const text = cleanText(el.textContent, 120).toLowerCase();
        const aria = cleanText(el.getAttribute('aria-label'), 120).toLowerCase();
        const state = cleanText(el.getAttribute('data-scroll-state'), 60);
        const rect = el.getBoundingClientRect();
        const inComposerArea = rect.top > window.innerHeight * 0.35;
        return state || text.includes('bắt đầu') || text.includes('kết thúc') || text.includes('start') || text.includes('end') || aria.includes('frame') || inComposerArea;
      })
      .slice(0, 18)
      .map(el => describeCompact(el));

    const mediaSignals = visible('img, video, canvas, [style*="background-image"], button, [role="button"]')
      .filter(el => {
        const rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight * 0.25) return false;
        const text = cleanText(el.textContent, 80).toLowerCase();
        const aria = cleanText(el.getAttribute('aria-label'), 80).toLowerCase();
        const bg = window.getComputedStyle(el).backgroundImage || '';
        return el.matches('img, video, canvas') || /url\(/i.test(bg) || aria.includes('remove') || aria.includes('delete') || text === 'close' || text === 'cancel';
      })
      .slice(0, 20)
      .map(el => describeCompact(el, 90));

    return {
      recorder: 'flow-xpath',
      type: 'snapshot',
      label,
      at: new Date().toISOString(),
      url: location.href,
      activeElement: document.activeElement ? describeCompact(document.activeElement) : null,
      assetCards,
      frameLike,
      mediaSignals,
      floatingRoots: getVisibleFloatingRootsSummary()
    };
  }

  function emitSnapshot(label) {
    try {
      console.log(`[FLOW_RECORDER] ${JSON.stringify(collectSnapshot(label))}`);
    } catch (error) {
      console.log(`[FLOW_RECORDER] ${JSON.stringify({
        recorder: 'flow-xpath',
        type: 'snapshot-error',
        label,
        error: String(error?.message || error)
      })}`);
    }
  }

  function emit(type, event, extra = {}) {
    const target = event.target && event.target.nodeType === Node.ELEMENT_NODE
      ? event.target
      : event.target?.parentElement;
    if (!target) return;

    const payload = {
      recorder: 'flow-xpath',
      type,
      at: new Date().toISOString(),
      url: location.href,
      pointer: event.clientX !== undefined ? { x: Math.round(event.clientX), y: Math.round(event.clientY) } : null,
      target: describeElement(target),
      ancestors: [],
      floatingRoots: getVisibleFloatingRootsSummary(),
      ...extra
    };

    let node = target.parentElement;
    while (node && payload.ancestors.length < 5) {
      payload.ancestors.push({
        tag: node.tagName.toLowerCase(),
        text: cleanText(node.textContent, 120),
        attrs: {
          id: node.id || '',
          class: cleanText(node.className, 100),
          role: node.getAttribute('role') || '',
          ariaLabel: node.getAttribute('aria-label') || ''
        },
        xpath: getXPath(node),
        cssPath: getCssPath(node)
      });
      node = node.parentElement;
    }

    console.log(`[FLOW_RECORDER] ${JSON.stringify(payload)}`);
  }

  document.addEventListener('click', event => emit('click', event), true);
  document.addEventListener('click', event => {
    setTimeout(() => emitSnapshot('after-click-300ms'), 300);
    setTimeout(() => emitSnapshot('after-click-1200ms'), 1200);
  }, true);
  document.addEventListener('pointerdown', event => {
    emit('pointerdown', event);
    setTimeout(() => emitSnapshot('after-pointerdown-600ms'), 600);
  }, true);
  document.addEventListener('change', event => emit('change', event), true);
  document.addEventListener('input', event => emit('input', event), true);
  document.addEventListener('keydown', event => {
    if (['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
      emit('keydown', event, { key: event.key });
    }
  }, true);

  console.log('[FLOW_RECORDER] installed');
}

(async () => {
  const baseDir = __dirname;
  const args = parseArgs(process.argv.slice(2));
  const userDataDir = path.join(baseDir, 'chrome-data');
  const cookieFile = path.join(baseDir, 'labs.google.cookies.json');
  const outputDir = path.join(baseDir, 'debug-output', 'flow-xpath-recorder');
  fs.mkdirSync(outputDir, { recursive: true });

  const logPath = path.join(outputDir, `flow-xpath-${Date.now()}.jsonl`);
  const humanLogPath = path.join(outputDir, `flow-xpath-${Date.now()}.log`);
  const writeStream = fs.createWriteStream(logPath, { flags: 'a' });
  const humanStream = fs.createWriteStream(humanLogPath, { flags: 'a' });

  try { fs.unlinkSync(path.join(userDataDir, 'SingletonLock')); } catch (_) {}

  console.log(`[FlowXPath] JSONL: ${logPath}`);
  console.log(`[FlowXPath] Human log: ${humanLogPath}`);
  console.log('[FlowXPath] Thao tác thật trên Flow. Nhấn Ctrl+C khi xong.');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    acceptDownloads: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      ...getExtensionArgs(baseDir),
    ],
  });

  if (fs.existsSync(cookieFile)) {
    const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
    await context.addCookies(cookies);
    console.log(`[FlowXPath] Loaded ${cookies.length} cookies.`);
  }

  const page = await context.newPage();
  await page.addInitScript(recorderScript);

  page.on('console', msg => {
    const text = msg.text();
    if (!text.startsWith('[FLOW_RECORDER]')) {
      if (args.verbose) console.log(`[FlowConsole:${msg.type()}] ${text}`);
      return;
    }

    const raw = text.replace('[FLOW_RECORDER] ', '');
    if (raw === 'installed') {
      console.log('[FlowXPath] Recorder installed in page.');
      return;
    }

    try {
      const event = JSON.parse(raw);
      writeStream.write(`${JSON.stringify(event)}\n`);
      const line = event.type === 'snapshot'
        ? [
            'SNAPSHOT',
            event.label || '',
            `assets=${event.assetCards?.length || 0}`,
            `frames=${event.frameLike?.length || 0}`,
            `media=${event.mediaSignals?.length || 0}`,
          ].filter(Boolean).join(' | ')
        : [
            event.type.toUpperCase(),
            event.target?.tag || '',
            event.target?.text ? `"${event.target.text}"` : '',
            event.target?.attrs?.['aria-label'] ? `aria="${event.target.attrs['aria-label']}"` : '',
            event.target?.xpath || ''
          ].filter(Boolean).join(' | ');
      humanStream.write(`${line}\n`);
      console.log(`[FlowXPath] ${line}`);
    } catch (error) {
      console.log(`[FlowXPath] ${text}`);
    }
  });

  await page.goto(PROJECT_URL);
  await page.waitForTimeout(6000);
  await adoptBrowserPage(context, page);

  if (page.url().includes('accounts.google.com')) {
    throw new Error('Not authenticated for Google Flow. Run login.js first.');
  }

  await page.evaluate(recorderScript);
  console.log('[FlowXPath] Ready. Hãy thao tác: click frame slot, mở dropdown, chọn Newest, chọn ảnh, confirm...');

  await new Promise(() => {});
})().catch(error => {
  console.error('[FlowXPath] Fatal:', error);
  process.exit(1);
});
