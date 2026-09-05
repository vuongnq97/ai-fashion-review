'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

const DEFAULT_LIMIT = 8;
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
  const rejectUnauthorized = String(
    options.tlsRejectUnauthorized ?? process.env.PRODUCT_IMAGE_TLS_REJECT_UNAUTHORIZED ?? 'true'
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

function addImage(images, url, width = null, height = null) {
  const normalized = normalizeExtractedImageUrl(url);
  if (!normalized) return;
  if (images.some(item => item.url === normalized)) return;
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
      if (!/(ibyteimg|byteimg|tiktokcdn|tiktok)/i.test(host)) continue;
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
  const model = parseProductModelFromHtml(html);
  const productId = model?.product_id || extractProductIdFromUrl(productUrl);
  const title = model?.name || getMetaContent(html, 'og:title').replace(/\s+-\s+TikTok Shop.*$/i, '');
  let descriptionText = '';
  const images = [];

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
  if (images.length === 0) {
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

module.exports = {
  downloadProductImages,
  extractProductAssetsFromHtml,
  extractProductIdFromUrl,
};
