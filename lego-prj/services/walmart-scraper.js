'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { proxyManager } = require('./proxy-manager');

/**
 * Scrapes product metadata and high-resolution images from Walmart product URLs
 * Bypasses PerimeterX / Akamai anti-bot protection via reader proxy.
 * 
 * @param {string} walmartUrl 
 * @returns {Promise<{itemId: string, name: string, brand: string, price: object, shortDescription: string, images: Array<{id: string, url: string, zoomable: boolean}>}>}
 */
async function scrapeWalmartProduct(walmartUrl) {
  const cleanUrl = walmartUrl.split('?')[0];
  const jinaUrl = 'https://r.jina.ai/' + cleanUrl;

  const html = await new Promise((resolve, reject) => {
    https.get(jinaUrl, {
      rejectUnauthorized: false,
      headers: {
        'X-Return-Format': 'html'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Reader returned HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
  if (!html || typeof html !== 'string') {
    throw new Error('Empty response received from reader.');
  }

  const nextDataMatch = html.match(/id=\"__NEXT_DATA__\"[^>]*>([^<]+)<\/script>/);
  if (!nextDataMatch) {
    throw new Error('Could not locate __NEXT_DATA__ payload in page HTML.');
  }

  const payload = JSON.parse(nextDataMatch[1]);
  const product = payload?.props?.pageProps?.initialData?.data?.product;
  const idml = payload?.props?.pageProps?.initialData?.data?.idml;

  if (!product) {
    throw new Error('Product data not found in page payload.');
  }

  const rawImages = product.imageInfo?.allImages || [];
  const images = rawImages.map(img => ({
    id: img.id,
    url: img.url.split('?')[0], // Original clean high-res URL
    zoomable: img.zoomable
  }));

  // Trích xuất kích thước sản phẩm từ IDML hoặc mô tả
  const fullText = [
    idml?.longDescription || '',
    idml?.shortDescription || '',
    product?.shortDescription || '',
    JSON.stringify(idml?.productHighlights || '')
  ].join('\n');

  const cleanLines = fullText
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  const dimensionsText = cleanLines.find(p => 
    /(?:dimensions?|measurements?|measures over|stands over|standing over)/i.test(p) && 
    /\d+\s*(?:cm|in\.|inch)/i.test(p)
  ) || null;

  return {
    itemId: product.usItemId || cleanUrl.split('/').pop(),
    name: product.name,
    brand: product.brand || 'LEGO',
    price: product.priceInfo?.currentPrice || null,
    shortDescription: product.shortDescription || '',
    dimensionsText,
    images
  };
}

/**
 * Downloads all product images into a specified folder using proxy / secure agents
 * 
 * @param {Array<{url: string, id: string}>} images 
 * @param {string} targetDir 
 * @returns {Promise<Array<{filename: string, path: string, url: string}>>}
 */
async function downloadImages(images, targetDir) {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const downloadedFiles = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const filename = `${i + 1}_${img.id}.jpeg`;
    const dest = path.join(targetDir, filename);

    let res = null;
    if (proxyManager.useProxy) {
      try {
        const agent = proxyManager.getHttpsAgent();
        res = await axios.get(img.url, { responseType: 'arraybuffer', httpsAgent: agent, timeout: 15000 });
      } catch (_) {}
    }
    if (!res) {
      res = await axios.get(img.url, {
        responseType: 'arraybuffer',
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        timeout: 20000
      });
    }

    fs.writeFileSync(dest, Buffer.from(res.data));
    downloadedFiles.push({ filename, path: dest, url: img.url });
  }

  return downloadedFiles;
}

module.exports = {
  scrapeWalmartProduct,
  downloadImages
};
