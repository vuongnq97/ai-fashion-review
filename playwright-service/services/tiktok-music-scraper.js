'use strict';

const { chromium } = require('playwright');
const axios = require('axios');
const https = require('https');
const path = require('path');
const fs = require('fs');

const DEFAULT_SEARCH_URL = 'https://www.tiktok.com/search?q=nh%E1%BA%A1c%20trend%20xu%20h%C6%B0%E1%BB%9Bng%202026%20viral%20viet%20nam&t=1788061586673';
const CACHE_FILE_NAME = 'trending-tracks-cache.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getMusicAssetsDir(baseDir = null) {
  const rootDir = baseDir || path.resolve(__dirname, '..');
  const dir = path.join(rootDir, 'assets', 'music');
  ensureDir(dir);
  return dir;
}

/**
 * Scrapes trending music tracks from TikTok search using Playwright session.
 */
async function scrapeTikTokTrendingMusic(queryOrUrl = DEFAULT_SEARCH_URL, options = {}) {
  const maxScrolls = options.maxScrolls || 4;
  const timeoutMs = options.timeoutMs || 35000;

  const targetUrl = queryOrUrl.startsWith('http')
    ? queryOrUrl
    : `https://www.tiktok.com/search?q=${encodeURIComponent(queryOrUrl)}`;

  console.log(`[TikTokMusicScraper] 🔍 Scraping TikTok trending music from: ${targetUrl}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'vi-VN',
  });

  const page = await context.newPage();
  const rawTracks = [];

  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/search/general/full/') || url.includes('/api/search/item/full/')) {
      try {
        const text = await res.text();
        if (text && text.length > 50) {
          const json = JSON.parse(text);
          const dataList = json.data || [];
          for (const entry of dataList) {
            const item = entry.item || entry;
            if (item && item.music) {
              const playUrl = item.music.playUrl || item.music.play_url?.uri || item.music.play_url?.url_list?.[0];
              if (playUrl) {
                rawTracks.push({
                  musicId: String(item.music.id || Date.now()),
                  title: item.music.title || 'Âm thanh xu hướng TikTok',
                  authorName: item.music.authorName || item.music.author || 'TikTok Creator',
                  duration: item.music.duration || 60,
                  playUrl,
                  coverUrl: item.music.coverLarge || item.music.coverMedium || '',
                  original: Boolean(item.music.original),
                  videoCaption: item.desc || '',
                  authorUniqueId: item.author?.uniqueId || '',
                  authorNickname: item.author?.nickname || '',
                  videoUrl: item.id ? `https://www.tiktok.com/@${item.author?.uniqueId || 'user'}/video/${item.id}` : '',
                  playCount: item.stats?.playCount || 0,
                  diggCount: item.stats?.diggCount || 0,
                  shareCount: item.stats?.shareCount || 0,
                });
              }
            }
          }
        }
      } catch (_) {}
    }
  });

  try {
    await page.goto('https://www.tiktok.com/explore', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2000);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(4000);

    for (let i = 0; i < maxScrolls; i++) {
      await page.evaluate(() => window.scrollBy(0, 1500));
      await page.waitForTimeout(2500);
    }
  } catch (err) {
    console.warn(`[TikTokMusicScraper] Warning: ${err.message}`);
  } finally {
    try { await browser.close(); } catch (_) {}
  }

  // Deduplicate
  const seen = new Set();
  const uniqueTracks = [];
  for (const t of rawTracks) {
    const key = `${t.title}___${t.authorName}`;
    if (!seen.has(key) && t.playUrl) {
      seen.add(key);
      uniqueTracks.push(t);
    }
  }

  console.log(`[TikTokMusicScraper] Extracted ${uniqueTracks.length} unique trending tracks.`);
  return uniqueTracks;
}

/**
 * Gets up to 20 cached trending tracks or scrapes fresh ones if cache is stale.
 */
async function getOrFetchTrendingTracks(baseDir = null, limit = 20, forceRefresh = false) {
  const musicDir = getMusicAssetsDir(baseDir);
  const cachePath = path.join(musicDir, CACHE_FILE_NAME);

  if (!forceRefresh && fs.existsSync(cachePath)) {
    try {
      const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const age = Date.now() - (cacheData.timestamp || 0);
      if (age < CACHE_TTL_MS && Array.isArray(cacheData.tracks) && cacheData.tracks.length > 0) {
        console.log(`[TikTokMusic] 🎵 Loaded ${cacheData.tracks.length} trending tracks from local cache (${Math.round(age / 60000)}m old)`);
        return cacheData.tracks.slice(0, limit);
      }
    } catch (_) {}
  }

  let tracks = [];
  try {
    tracks = await scrapeTikTokTrendingMusic(DEFAULT_SEARCH_URL, { maxScrolls: 4 });
  } catch (err) {
    console.error(`[TikTokMusic] Scrape error: ${err.message}`);
  }

  if (tracks.length === 0 && fs.existsSync(cachePath)) {
    try {
      const fallback = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (Array.isArray(fallback.tracks) && fallback.tracks.length > 0) {
        return fallback.tracks.slice(0, limit);
      }
    } catch (_) {}
  }

  if (tracks.length > 0) {
    fs.writeFileSync(cachePath, JSON.stringify({ timestamp: Date.now(), tracks }, null, 2), 'utf8');
  }

  return tracks.slice(0, limit);
}

/**
 * Downloads track audio MP3 to a local file.
 */
async function downloadTrackAudio(track, destPath) {
  ensureDir(path.dirname(destPath));
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 10000) {
    return destPath;
  }

  if (!track || !track.playUrl) {
    throw new Error('Track has no playUrl');
  }

  console.log(`[TikTokMusic] ⬇️ Downloading trending audio: "${track.title}" - ${track.authorName}...`);
  const response = await axios({
    method: 'GET',
    url: track.playUrl,
    responseType: 'arraybuffer',
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': 'https://www.tiktok.com/',
    },
    timeout: 30000,
  });

  fs.writeFileSync(destPath, Buffer.from(response.data));
  console.log(`[TikTokMusic] ✅ Audio downloaded: ${destPath} (${response.data.length} bytes)`);
  return destPath;
}

/**
 * Selects 1 random track from top 20 trending tracks and ensures the audio MP3 is downloaded locally.
 *
 * @param {string} [baseDir]
 * @returns {Promise<{musicId: string, title: string, authorName: string, duration: number, audioPath: string, playUrl: string, videoUrl: string}>}
 */
async function getRandomTrendingTrackAudio(baseDir = null) {
  const tracks = await getOrFetchTrendingTracks(baseDir, 20);
  if (!tracks || tracks.length === 0) {
    throw new Error('No trending music tracks available');
  }

  // Pick random 1 out of 20
  const randomIndex = Math.floor(Math.random() * tracks.length);
  const selected = tracks[randomIndex];
  console.log(`[TikTokMusic] 🎲 Selected random trending track [${randomIndex + 1}/${tracks.length}]: "${selected.title}" by ${selected.authorName}`);

  const musicDir = getMusicAssetsDir(baseDir);
  const safeId = String(selected.musicId || randomIndex).replace(/[^a-zA-Z0-9_-]/g, '');
  const audioPath = path.join(musicDir, `track-${safeId}.mp3`);

  await downloadTrackAudio(selected, audioPath);

  return {
    ...selected,
    audioPath,
  };
}

module.exports = {
  scrapeTikTokTrendingMusic,
  getOrFetchTrendingTracks,
  downloadTrackAudio,
  getRandomTrendingTrackAudio,
};
