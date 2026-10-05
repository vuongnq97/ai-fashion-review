'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

const DEFAULT_LIMIT = 16;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MIN_IMAGE_COUNT = 1;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getExtension(contentType, url) {
  const fromType = String(contentType || '').toLowerCase();
  if (fromType.includes('jpeg') || fromType.includes('jpg')) return '.jpg';
  if (fromType.includes('png')) return '.png';
  if (fromType.includes('webp')) return '.webp';
  if (fromType.includes('gif')) return '.gif';

  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return ext;
  } catch (_) {}

  return '.jpg';
}

function normalizeImageUrl(item) {
  const raw = typeof item === 'string' ? item : item?.url;
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  return parsed.toString();
}

async function downloadImage(url, targetDir, index, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const maxBytes = Number(options.maxBytesPerImage) || DEFAULT_MAX_BYTES;
  const defaultTlsReject = (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') ? 'false' : 'true';
  const rejectUnauthorized = String(
    options.tlsRejectUnauthorized ?? process.env.PRODUCT_IMAGE_TLS_REJECT_UNAUTHORIZED ?? defaultTlsReject
  ).toLowerCase() !== 'false';

  const response = await requestImage(url, {
    timeoutMs,
    rejectUnauthorized,
    maxRedirects: 5,
  });

  const contentType = response.contentType || '';
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`Invalid content-type: ${contentType || 'unknown'}`);
  }

  if (response.buffer.length > maxBytes) {
    throw new Error(`Image exceeds max size ${maxBytes} bytes`);
  }

  const buffer = response.buffer;
  const ext = getExtension(contentType, url);
  const fileName = `${String(index).padStart(2, '0')}${ext}`;
  const filePath = path.join(targetDir, fileName);
  fs.writeFileSync(filePath, buffer);

  return {
    name: fileName,
    path: filePath,
    mimeType: contentType.split(';')[0] || 'image/jpeg',
    size: buffer.length,
    buffer,
    sourceUrl: url,
  };
}

function requestImage(url, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? 5;
  const rejectUnauthorized = options.rejectUnauthorized !== false;

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.get({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      rejectUnauthorized,
      headers: {
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      },
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0;
      const redirect = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && redirect && maxRedirects > 0) {
        res.resume();
        const nextUrl = new URL(redirect, url).toString();
        requestImage(nextUrl, { ...options, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
        return;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        buffer: Buffer.concat(chunks),
        contentType: res.headers['content-type'] || '',
      }));
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

async function downloadProductImages(productImages, jobDir, options = {}) {
  const limit = Math.min(Number(options.limit) || DEFAULT_LIMIT, DEFAULT_LIMIT);
  const minImages = Number(options.minImages) || MIN_IMAGE_COUNT;
  const targetDir = path.join(jobDir, 'source-images');
  ensureDir(targetDir);

  const urls = [];
  for (const item of Array.isArray(productImages) ? productImages : []) {
    const url = normalizeImageUrl(item);
    if (url && !urls.includes(url)) urls.push(url);
    if (urls.length >= limit) break;
  }

  const downloaded = [];
  const errors = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      downloaded.push(await downloadImage(urls[i], targetDir, i + 1, options));
    } catch (error) {
      errors.push({ url: urls[i], error: error.message });
      console.warn(`[ProductAssets] Skipped image ${i + 1}: ${error.message}`);
    }
  }

  if (downloaded.length < minImages) {
    throw new Error(`Only downloaded ${downloaded.length}/${minImages} required product image(s)`);
  }

  return { files: downloaded, errors, dir: targetDir };
}

function extractProductIdFromUrl(productUrl) {
  if (!productUrl) return null;
  try {
    const parsed = new URL(productUrl);
    const match = parsed.pathname.match(/\/pdp\/(?:[^/]+\/)?(\d{10,})/);
    return match ? match[1] : null;
  } catch (_) {
    const match = String(productUrl).match(/\/pdp\/(?:[^/?#]+\/)?(\d{10,})/);
    return match ? match[1] : null;
  }
}

function getMetaContent(html, propertyName) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${propertyName}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${propertyName}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${propertyName}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${propertyName}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return '';
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeExtractedImageUrl(value) {
  let raw = decodeHtml(String(value || '').trim())
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\&/g, '&');

  raw = raw.replace(/^["']+|["']+$/g, '');
  if (raw.startsWith('//')) raw = `https:${raw}`;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

function extractImageHash(url) {
  if (!url) return '';
  const m = String(url).match(/\/([a-f0-9]{32})(?:~|[?]|$)/i);
  return m ? m[1].toLowerCase() : url;
}

function addImage(images, url, width = null, height = null) {
  const normalized = normalizeExtractedImageUrl(url);
  if (!normalized) return;
  const hash = extractImageHash(normalized);
  if (images.some(item => (extractImageHash(item.url) === hash) || item.url === normalized)) return;
  images.push({ url: normalized, width, height });
}

function collectImagesFromObject(value, images, seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value.url_list)) {
    for (const url of value.url_list) addImage(images, url, value.width || null, value.height || null);
  }
  if (Array.isArray(value.urlList)) {
    for (const url of value.urlList) addImage(images, url, value.width || null, value.height || null);
  }
  if (typeof value.url === 'string') {
    addImage(images, value.url, value.width || null, value.height || null);
  }
  if (typeof value.image === 'string') {
    addImage(images, value.image, value.width || null, value.height || null);
  }
  if (typeof value.cover === 'string') {
    addImage(images, value.cover, value.width || null, value.height || null);
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectImagesFromObject(child, images, seen);
  }
}

function collectMetaImages(html, images) {
  const properties = [
    'og:image',
    'og:image:url',
    'og:image:secure_url',
    'twitter:image',
    'twitter:image:src',
  ];

  for (const property of properties) {
    addImage(images, getMetaContent(html, property));
  }
}

function collectCdnImagesFromHtml(html, images) {
  const text = String(html || '');
  const matches = text.match(/https?:\\?\/\\?\/[^"'<>\s]+?(?:\.jpg|\.jpeg|\.png|\.webp)(?:[^"'<>\s]*)?/gi) || [];

  for (const match of matches) {
    const cleaned = normalizeExtractedImageUrl(match);
    if (!cleaned) continue;
    try {
      const host = new URL(cleaned).hostname.toLowerCase();
      if (host.includes('tiktok.com')) continue; // Exclude tiktok.com web pages
      if (!/(ibyteimg|byteimg|tiktokcdn)/i.test(host)) continue;
      addImage(images, cleaned);
    } catch (_) {}
  }
}

function parseProductModelFromHtml(html) {
  const scripts = [...String(html || '').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(script => script.includes('product_model'));

  for (const script of scripts) {
    try {
      const data = JSON.parse(script);
      const stack = [data];
      while (stack.length) {
        const current = stack.pop();
        if (!current || typeof current !== 'object') continue;
        if (current.product_id && current.name && current.description) return current;
        for (const value of Object.values(current)) {
          if (value && typeof value === 'object') stack.push(value);
        }
      }
    } catch (_) {}
  }
  return null;
}

function extractProductAssetsFromHtml(html, productUrl = '') {
  let urlTitle = '';
  let urlImage = '';
  if (productUrl) {
    try {
      const parsedUrl = new URL(productUrl);
      const ogInfoRaw = parsedUrl.searchParams.get('og_info');
      if (ogInfoRaw) {
        const parsed = JSON.parse(ogInfoRaw);
        if (parsed.title) urlTitle = parsed.title;
        if (parsed.image) urlImage = parsed.image;
      }
    } catch (_) {}
  }

  const model = parseProductModelFromHtml(html);
  const productId = model?.product_id || extractProductIdFromUrl(productUrl);
  const metaTitle = getMetaContent(html, 'og:title').replace(/\s+-\s+TikTok Shop.*$/i, '');
  const title = model?.name || metaTitle || urlTitle;
  let descriptionText = '';
  const images = [];

  if (urlImage) {
    addImage(images, urlImage);
  }

  if (model?.description) {
    try {
      const blocks = typeof model.description === 'string' ? JSON.parse(model.description) : model.description;
      for (const block of Array.isArray(blocks) ? blocks : []) {
        if (block?.type === 'text' && block.text) {
          descriptionText += `${descriptionText ? '\n' : ''}${String(block.text).trim()}`;
        }
        if (block?.type === 'image' && block.image) {
          const url = block.image.url_list?.[0];
          addImage(images, url, block.image.width || null, block.image.height || null);
        }
      }
    } catch (error) {
      console.warn(`[ProductAssets] Could not parse product_model.description: ${error.message}`);
    }
  }

  if (model) {
    collectImagesFromObject(model, images);
  }
  collectMetaImages(html, images);
  if (images.length < DEFAULT_LIMIT) {
    collectCdnImagesFromHtml(html, images);
  }

  const hashtags = [...new Set((descriptionText.match(/#[\p{L}\p{N}_-]+/gu) || []))];

  return {
    productId,
    title,
    productDescription: descriptionText,
    productImages: images.slice(0, DEFAULT_LIMIT),
    hashtags,
  };
}

/**
 * Dùng Playwright page để lấy ảnh sản phẩm từ TikTok:
 * 1. Intercept TikTok product API responses (url_list chứa full gallery)
 * 2. Fallback: page.evaluate() để access window.__NEXT_DATA__ / window state
 * 3. Fallback: DOM img elements với tiktokcdn URLs
 *
 * @param {import('playwright').Page} page - page đã navigate đến product URL
 * @returns {Promise<{url: string, width: number|null, height: number|null}[]>}
 */
async function extractProductImagesFromBrowser(page) {
  const collected = [];
  const seen = new Set();

  function addImg(url, width = null, height = null) {
    if (!url || typeof url !== 'string') return;
    let u = url.trim().replace(/\\\//g, '/').replace(/\\u002F/gi, '/');
    if (u.startsWith('//')) u = `https:${u}`;
    if (!u.startsWith('https://')) return;
    try { new URL(u); } catch (_) { return; }
    if (seen.has(u)) return;
    seen.add(u);
    collected.push({ url: u, width, height });
  }

  function walkObj(obj, depth = 0) {
    if (!obj || depth > 10 || typeof obj !== 'object') return;
    if (Array.isArray(obj.url_list)) { obj.url_list.forEach(u => addImg(u, obj.width || null, obj.height || null)); }
    if (Array.isArray(obj.urlList))  { obj.urlList.forEach(u  => addImg(u, obj.width || null, obj.height || null)); }
    if (typeof obj.url === 'string') addImg(obj.url, obj.width || null, obj.height || null);
    if (Array.isArray(obj)) { for (const el of obj) walkObj(el, depth + 1); }
    else { for (const v of Object.values(obj)) { if (v && typeof v === 'object') walkObj(v, depth + 1); } }
  }

  // 1. Intercept network API responses (TikTok product detail API)
  const apiImages = [];
  const onResponse = async (resp) => {
    try {
      const url = resp.url();
      if (!/(product\/detail|item\/detail|shop.*product|api.*pdp)/i.test(url)) return;
      if (resp.status() < 200 || resp.status() >= 300) return;
      const ct = resp.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const json = await resp.json().catch(() => null);
      if (json) walkObj(json);
      apiImages.push(...collected.slice(apiImages.length)); // mark all as from API
    } catch (_) {}
  };
  page.on('response', onResponse);

  // 2. Try window state via evaluate (works after JS execution)
  try {
    const fromWindow = await page.evaluate(() => {
      const res = [];
      const seenHash = new Set(); // dedupe by URL hash (image ID), not full URL

      function extractHash(url) {
        // TikTok CDN: .../tos-alisg-i-xxx/{hash}~tplv-... or /{hash}?...
        const m = url.match(/\/([a-f0-9]{32})(?:~|[?]|$)/i);
        return m ? m[1] : url;
      }

      function addUrl(url, w, h, priority = 10) {
        if (!url || typeof url !== 'string') return;
        let u = url.trim().split('\\/').join('/');
        if (u.startsWith('//')) u = 'https:' + u;
        if (!u.startsWith('https://')) return;
        if (!/(ibyteimg|tiktokcdn|byteimg)/i.test(u)) return;
        const hash = extractHash(u);
        if (seenHash.has(hash)) return;
        seenHash.add(hash);
        // Normalize to 800x800 version for best quality
        u = u.replace(/~tplv-[^?]+/, '~tplv-aphluv4xwc-resize-webp:800:800.webp');
        res.push({ url: u, width: w || null, height: h || null, priority });
      }

      // Priority 1: Product gallery carousel images (.slick-slide)
      const slickImgs = document.querySelectorAll('.slick-slide img[src], .slick-track img[src], [data-index] img[src]');
      slickImgs.forEach(img => {
        const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
        addUrl(src, img.naturalWidth || null, img.naturalHeight || null, 1);
      });

      // Priority 2: Main product picture elements (source srcset)
      document.querySelectorAll('picture source[srcset]').forEach(src => {
        const s = src.getAttribute('srcset') || '';
        const url = s.split(',')[0].trim().split(' ')[0];
        addUrl(url, null, null, 2);
      });

      // Priority 3: Thumbnail strip images
      document.querySelectorAll('img[title][src]').forEach(img => {
        const src = img.getAttribute('src') || '';
        if (/(ibyteimg|tiktokcdn)/i.test(src)) addUrl(src, null, null, 3);
      });

      // Priority 4: data-fmp main display images
      document.querySelectorAll('img[data-fmp][src]').forEach(img => {
        const src = img.getAttribute('src') || '';
        addUrl(src, null, null, 4);
      });

      // Priority 5: All remaining CDN images (product description photos etc)
      // Only if gallery found < 3 images
      if (res.length < 3) {
        document.querySelectorAll('img[src]').forEach(img => {
          const src = img.getAttribute('src') || '';
          if (/(ibyteimg|tiktokcdn|byteimg)/i.test(src)) addUrl(src, null, null, 5);
        });
      }

      // Sort by priority then return
      res.sort((a, b) => (a.priority || 9) - (b.priority || 9));
      return res;
    });
    if (fromWindow) fromWindow.forEach(({ url, width, height }) => addImg(url, width, height));
  } catch (_) {}

  page.off('response', onResponse);
  return collected;
}

/**
 * Scrapes full product gallery and title using an isolated headless Chromium page.
 * Fast (~4s), safe, and completely decoupled from Google Flow session.
 */
async function scrapeTikTokWithBrowser(productUrl) {
  if (!productUrl || !productUrl.startsWith('http')) {
    return { title: '', productImages: [] };
  }
  const { chromium } = require('playwright');
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3500);

    const productImages = await extractProductImagesFromBrowser(page);
    let title = '';
    const rawTitle = await page.title().catch(() => '');
    if (rawTitle && !rawTitle.toLowerCase().includes('security check')) {
      title = rawTitle.replace(/\s+-\s+TikTok Shop.*$/i, '').trim();
    }
    return { title, productImages };
  } catch (err) {
    console.warn(`[ProductAssets] scrapeTikTokWithBrowser error: ${err.message}`);
    return { title: '', productImages: [] };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  downloadProductImages,
  extractProductAssetsFromHtml,
  extractProductIdFromUrl,
  extractProductImagesFromBrowser,
  scrapeTikTokWithBrowser,
};
