'use strict';

/**
 * Generic Auto Template Scheduler Factory
 * Creates scheduler instances for /auto_t3, /auto_t4, /auto_t5, etc.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const axios = require('axios');

const { getConfig } = require('../utils/config-manager');
const { extractProductAssetsFromHtml } = require('./product-assets');
const { generationJobService } = require('./generation-job');
const { sendTelegramMessage } = require('./telegram-send');
const { FlowStepTracker } = require('./flow-step-tracker');
const { maybeRefreshCookies } = require('./gemini-cookie-refresher');
const { runWithShop, getShopNameForChat } = require('../utils/shop-context');

const tgHttp = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  proxy: false,
});

const DEFAULT_TIMES = ['09:00', '12:00', '15:00', '18:00', '21:00'];
const CHECK_INTERVAL_MS = 30000;
const schedulerRegistry = new Map();

function getLocalDateTime(timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Ho_Chi_Minh',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return {
    date: `${byType.year}-${byType.month}-${byType.day}`,
    time: `${byType.hour}:${byType.minute}`,
  };
}

function createAutoTemplateScheduler(configKey, commandName, defaults = {}) {
  if (schedulerRegistry.has(configKey)) return schedulerRegistry.get(configKey);

  const stateFileName = `${configKey.replace('Settings', '')}-state.json`;
  let schedulerTimer = null;
  let isRunningSlot = false;

  const getStatePath = (baseDir) => path.join(baseDir, stateFileName);
  const getLegacyStatePath = (baseDir) => (
    configKey === 'autoT3Settings' ? path.join(baseDir, 'auto-t3-state.json') : null
  );

  function readState(baseDir) {
    try {
      const p = getStatePath(baseDir);
      const legacyPath = getLegacyStatePath(baseDir);
      const statePath = fs.existsSync(p) ? p : (legacyPath && fs.existsSync(legacyPath) ? legacyPath : null);
      if (!statePath) return { lastRunSlots: {}, nextLinkIndex: 0, usedLinks: {} };
      const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!s.usedLinks) s.usedLinks = {};
      return s;
    } catch (_) { return { lastRunSlots: {}, nextLinkIndex: 0, usedLinks: {} }; }
  }

  function writeState(baseDir, state) {
    fs.writeFileSync(getStatePath(baseDir), JSON.stringify(state, null, 2));
  }

  function readRawConfig(baseDir) {
    const p = path.join(baseDir, 'config.json');
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  function writeRawConfig(baseDir, config) {
    fs.writeFileSync(path.join(baseDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  }

  function normalizeConfig(baseDir) {
    const config = getConfig(baseDir);
    const s = config[configKey] || {};
    const times = (Array.isArray(s.times) ? s.times : DEFAULT_TIMES)
      .map(v => String(v || '').trim()).filter(v => /^\d{2}:\d{2}$/.test(v)).slice(0, 5);
    const shortlinks = (Array.isArray(s.shortlinks) ? s.shortlinks : [])
      .map(v => String(v || '').trim()).filter(Boolean);
    const rawTags = s.hashtags || s.hashtag || [];
    const hashtags = (Array.isArray(rawTags) ? rawTags : [rawTags]).map(v => String(v || '').trim()).filter(Boolean);
    return {
      enabled: !!s.enabled,
      chatId: String(s.chatId || '').trim(),
      timezone: String(s.timezone || 'Asia/Ho_Chi_Minh').trim(),
      template: String(s.template || defaults.template || 'template3').trim(),
      times: times.length > 0 ? times : DEFAULT_TIMES,
      shortlinks,
      hashtags,
    };
  }

  function enableForChat(baseDir, chatId) {
    const raw = readRawConfig(baseDir);
    raw[configKey] = { ...(raw[configKey] || {}), enabled: true, chatId: String(chatId) };
    writeRawConfig(baseDir, raw);
    return normalizeConfig(baseDir);
  }

  function disable(baseDir) {
    const raw = readRawConfig(baseDir);
    raw[configKey] = { ...(raw[configKey] || {}), enabled: false };
    writeRawConfig(baseDir, raw);
    return normalizeConfig(baseDir);
  }

  function pickNextShortlink(baseDir, shortlinks) {
    const state = readState(baseDir);
    const usedLinks = state.usedLinks || {};

    // Tìm link chưa dùng, bắt đầu từ nextLinkIndex
    const startIndex = Math.max(0, Number(state.nextLinkIndex) || 0) % shortlinks.length;
    let picked = null;
    let pickedIndex = -1;

    for (let offset = 0; offset < shortlinks.length; offset++) {
      const idx = (startIndex + offset) % shortlinks.length;
      const link = shortlinks[idx];
      if (!usedLinks[link] || !usedLinks[link].uploadedAt) {
        picked = link;
        pickedIndex = idx;
        break;
      }
    }

    // Tất cả links đã dùng hết → reset và bắt đầu lại từ đầu
    if (picked === null) {
      console.log(`[${commandName}] 🔄 Tất cả ${shortlinks.length} link đã upload xong. Reset để bắt đầu lại.`);
      state.usedLinks = {};
      state.nextLinkIndex = 1;
      picked = shortlinks[0];
      pickedIndex = 0;
    } else {
      state.nextLinkIndex = (pickedIndex + 1) % shortlinks.length;
    }

    writeState(baseDir, state);
    return { shortlink: picked, index: pickedIndex };
  }

  function markLinkUploaded(baseDir, shortlink) {
    const state = readState(baseDir);
    if (!state.usedLinks) state.usedLinks = {};
    state.usedLinks[shortlink] = { uploadedAt: new Date().toISOString() };
    writeState(baseDir, state);
    console.log(`[${commandName}] ✅ Đã đánh dấu link đã upload: ${shortlink}`);
  }

  // ── Asset Cache ─────────────────────────────────────────────────────────────
  function getCachedAssets(baseDir, shortlink) {
    const state = readState(baseDir);
    return state.assetCache?.[shortlink] || null;
  }

  function setCachedAssets(baseDir, shortlink, assets) {
    const state = readState(baseDir);
    if (!state.assetCache) state.assetCache = {};
    state.assetCache[shortlink] = {
      productId: assets.productId,
      title: assets.title,
      productDescription: assets.productDescription,
      productImages: assets.productImages,
      hashtags: assets.hashtags || [],
      productUrl: assets.productUrl || shortlink,
      cachedAt: new Date().toISOString(),
    };
    writeState(baseDir, state);
    console.log(`[${commandName}] 💾 Cached assets for ${shortlink} (${assets.productImages.length} images, ${(assets.hashtags || []).length} hashtags)`);
  }

  function getTemplateDefaultHashtags(tmpl) {
    const t = String(tmpl || '').toLowerCase();
    if (t.includes('template4')) {
      return ['#GuocNu', '#GiayCaoGot', '#SandalNu', '#ReviewGiayNu', '#TikTokShopVN'];
    }
    if (t.includes('template3')) {
      return ['#GiaySneaker', '#GiayTheThao', '#ReviewGiay', '#SneakerVN', '#TikTokShopVN'];
    }
    return ['#review', '#sanphamchinhhang', '#lifestyle', '#trending', '#xuhuong', '#tiktokshop'];
  }

  async function fetchProductWithBrowser(productUrl, baseDir) {
    try {
      const { createFlowPage, closeFlowPage } = require('./browser');
      const page = await createFlowPage(baseDir);
      try {
        await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        const html = await page.content();
        return html;
      } finally {
        await closeFlowPage(page);
      }
    } catch (err) {
      console.warn(`[${commandName}] Browser fetch failed:`, err.message);
      return null;
    }
  }

  async function enqueueJob(baseDir, cfg, shortlink, slotLabel) {
    const tracker = new FlowStepTracker(cfg.chatId, { title: `Đang tải sản phẩm (${commandName})...` });
    await tracker.start(1);

    // ── Check cache trước ──────────────────────────────────────────────────────
    const cached = getCachedAssets(baseDir, shortlink);
    if (cached && cached.productImages?.length > 0) {
      console.log(`[${commandName}] ✅ Cache hit cho ${shortlink} — dùng ${cached.productImages.length} ảnh đã lưu.`);
      const cachedTags = (Array.isArray(cached.hashtags) && cached.hashtags.length > 0)
        ? cached.hashtags
        : getTemplateDefaultHashtags(cfg.template);

      if (cached.title) {
        await tracker.setTitle(cached.title);
      }

      const enqueueResult = generationJobService.enqueueJob({
        chatId: String(cfg.chatId),
        sourceMessageId: null,
        shortlink,
        productUrl: cached.productUrl || shortlink,
        template: cfg.template,
        productId: cached.productId || `${commandName}_${Date.now()}`,
        productTitle: cached.title,
        productDescription: cached.productDescription,
        productImages: cached.productImages.slice(0, 8),
        hashtags: cachedTags,
        stepTracker: tracker,
      }, baseDir);

      return enqueueResult.job || enqueueResult;
    }

    // ── Không có cache → fetch bình thường ─────────────────────────────────────
    const resp = await tgHttp.get(shortlink, {
      maxRedirects: 5, validateStatus: () => true,
      timeout: Number(process.env.AUTO_T3_SHORTLINK_TIMEOUT_MS || '20000'),
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });

    const productUrl = resp.request?.res?.responseUrl || shortlink;
    let assets = extractProductAssetsFromHtml(resp.data, productUrl);

    // ── Fallback 1: extract og_info từ redirect URL nếu HTML bị captcha ────────
    if (!assets.title && assets.productImages.length === 0 && productUrl !== shortlink) {
      try {
        const urlObj = new URL(productUrl);
        const ogInfoRaw = urlObj.searchParams.get('og_info');
        if (ogInfoRaw) {
          const ogInfo = JSON.parse(decodeURIComponent(ogInfoRaw));
          if (ogInfo.title || ogInfo.image) {
            console.log(`[${commandName}] Fallback 1: extracting from og_info in redirect URL`);
            assets = {
              productId: urlObj.pathname.split('/').pop() || `${commandName}_${Date.now()}`,
              title: ogInfo.title || '',
              productDescription: '',
              productImages: ogInfo.image
                ? [{ url: ogInfo.image.replace(/\\/g, ''), width: null, height: null }]
                : [],
              hashtags: [],
            };
            console.log(`[${commandName}] Fallback 1 result: title=${assets.title ? 'yes' : 'no'}, images=${assets.productImages.length}`);
          }
        }
      } catch (ogErr) {
        console.warn(`[${commandName}] og_info parse failed:`, ogErr.message);
      }
    }

    // ── Fallback 2: dùng Playwright browser để bypass captcha ────────────────
    if (assets.productImages.length <= 1 && productUrl !== shortlink) {
      console.log(`[${commandName}] Fallback 2: opening in Playwright browser to bypass captcha...`);
      const browserHtml = await fetchProductWithBrowser(productUrl, baseDir);
      if (browserHtml) {
        const browserAssets = extractProductAssetsFromHtml(browserHtml, productUrl);
        console.log(`[${commandName}] Browser extract: title=${browserAssets.title ? 'yes' : 'no'}, images=${browserAssets.productImages.length}`);
        if (browserAssets.productImages.length > assets.productImages.length) {
          console.log(`[${commandName}] Browser got ${browserAssets.productImages.length} images vs ${assets.productImages.length} — using browser result`);
          assets = browserAssets;
        }
      }
    }

    if (!assets.title && assets.productImages.length === 0) {
      throw new Error('Không thể lấy thông tin sản phẩm hoặc ảnh từ link cấu hình.');
    }
    if (!Array.isArray(assets.productImages) || assets.productImages.length === 0) {
      const titleInfo = assets.title ? ` Có title "${assets.title}" nhưng không có productImages.` : '';
      throw new Error(`Không lấy được ảnh sản phẩm từ link cấu hình.${titleInfo}`);
    }

    const effectiveHashtags = (Array.isArray(assets.hashtags) && assets.hashtags.length > 0)
      ? assets.hashtags
      : getTemplateDefaultHashtags(cfg.template);

    // ── Fetch thành công → lưu cache ─────────────────────────────────────────
    if (assets.productImages.length > 0) {
      setCachedAssets(baseDir, shortlink, { ...assets, hashtags: effectiveHashtags, productUrl });
    }

    if (assets.title) {
      await tracker.setTitle(assets.title);
    }

    const enqueueResult = generationJobService.enqueueJob({
      chatId: String(cfg.chatId),
      sourceMessageId: null,
      shortlink, productUrl,
      template: cfg.template,
      productId: assets.productId || `${commandName}_${Date.now()}`,
      productTitle: assets.title,
      productDescription: assets.productDescription,
      productImages: assets.productImages.slice(0, 8),
      hashtags: effectiveHashtags,
      stepTracker: tracker,
    }, baseDir);

    return enqueueResult.job || enqueueResult;
  }

  async function runDue(baseDir, forced = false) {
    const cfg = normalizeConfig(baseDir);
    if (!cfg.enabled && !forced) return null;
    if (!cfg.chatId) return null;

    const shopName = getShopNameForChat(cfg.chatId, baseDir);
    return runWithShop(shopName, async () => {
      if (cfg.shortlinks.length === 0) {
        if (forced) await sendTelegramMessage(cfg.chatId,
          `⚠️ /${commandName} chưa có shortlinks trong config.json → ${configKey}.shortlinks`);
        return null;
      }
      const now = getLocalDateTime(cfg.timezone);
      const matchedTime = forced ? now.time : cfg.times.find(t => t === now.time);
      if (!matchedTime) return null;
      const state = readState(baseDir);
      const slotKey = `${now.date} ${matchedTime}`;
      if (!forced && state.lastRunSlots?.[slotKey]) return null;
      if (isRunningSlot) return null;

      isRunningSlot = true;
      try {
        // Export Gemini cookies nếu cần (tối đa 1 lần/45 phút — chỉ scheduler đầu tiên mỗi khung giờ mới export)
        await maybeRefreshCookies(baseDir);

        const { shortlink } = pickNextShortlink(baseDir, cfg.shortlinks);
        const job = await enqueueJob(baseDir, cfg, shortlink, slotKey);
        const latestState = readState(baseDir);
        latestState.lastRunSlots = latestState.lastRunSlots || {};
        latestState.lastRunSlots[slotKey] = { jobId: job.jobId, shortlink, ranAt: new Date().toISOString(), forced };
        writeState(baseDir, latestState);
        return job;
      } catch (error) {
        console.error(`[${commandName}] Run failed:`, error.message);
        const cfg2 = normalizeConfig(baseDir);
        await sendTelegramMessage(cfg2.chatId, `⚠️ /${commandName} lỗi: ${error.message}`);
        return null;
      } finally {
        isRunningSlot = false;
      }
    });
  }

  function startScheduler(baseDir = path.resolve(__dirname, '..')) {
    if (schedulerTimer) return;
    schedulerTimer = setInterval(() => {
      runDue(baseDir).catch(err => console.error(`[${commandName}] Scheduler error:`, err.message));
    }, CHECK_INTERVAL_MS);
    runDue(baseDir).catch(err => console.error(`[${commandName}] Initial check error:`, err.message));
    console.log(`[${commandName}] ✅ Scheduler started (${configKey}).`);
  }

  function stopScheduler() {
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
  }

  async function handleCommand(botToken, chatId, text, baseDir = path.resolve(__dirname, '..')) {
    const shopName = getShopNameForChat(chatId, baseDir);
    return runWithShop(shopName, async () => {
      const raw = String(text || '').trim();
      const cmdRegex = new RegExp(`^\\/${commandName}(?:_([a-z0-9]+))?(?:@\\S+)?`, 'i');
      const match = raw.match(cmdRegex);
      let subAction = match && match[1] ? match[1].toLowerCase() : '';
      let remainder = raw.replace(cmdRegex, '').trim().toLowerCase();
      if (!subAction && remainder) {
        subAction = remainder.split(/\s+/)[0];
      }

      if (subAction === 'off' || subAction === 'stop') {
        const cfg = disable(baseDir);
        await sendTelegramMessage(chatId, `⏸️ Đã tắt /${commandName}. Chat ID: <code>${cfg.chatId || chatId}</code>.`, { parse_mode: 'HTML' });
        return;
      }
      if (subAction === 'run' || subAction === 'now') {
        enableForChat(baseDir, chatId);
        await sendTelegramMessage(chatId, `▶️ Đã bật /${commandName} và đang chạy thử ngay 1 link kế tiếp...`);
        await runDue(baseDir, true);
        return;
      }

      const cfg = enableForChat(baseDir, chatId);
      startScheduler(baseDir);
      const linksText = cfg.shortlinks.length > 0 ? `${cfg.shortlinks.length} link` : 'chưa có link';
      await sendTelegramMessage(chatId,
        `✅ <b>Đã kích hoạt /${commandName} cho chat này</b>\n\n` +
        `🎬 Template: <b>${cfg.template}</b>\n` +
        `⏰ Giờ chạy tự động: <code>${cfg.times.join(', ')}</code> (${cfg.timezone})\n` +
        `🔗 Danh sách sản phẩm: <b>${linksText}</b>\n\n` +
        `👉 Chạy thử ngay 1 video: /${commandName}_run\n` +
        `👉 Tắt tự động: /${commandName}_off\n\n` +
        `💡 Thêm danh sách shortlink vào <code>config.json → ${configKey}.shortlinks</code>.\n` +
        `👉 Bấm /start để xem toàn bộ danh sách lệnh.`,
        { parse_mode: 'HTML' }
      );
    });
  }

  const instance = { configKey, commandName, handleCommand, startScheduler, stopScheduler, runDue, normalizeConfig, enableForChat, disable, markLinkUploaded, readState };
  schedulerRegistry.set(configKey, instance);
  return instance;
}

const autoT3Scheduler = createAutoTemplateScheduler('autoT3Settings', 'auto_t3', { template: 'template3' });
const autoT4Scheduler = createAutoTemplateScheduler('autoT4Settings', 'auto_t4', { template: 'template4' });
const autoT5Scheduler = createAutoTemplateScheduler('autoT5Settings', 'auto_t5', { template: 'template5_2' });

/**
 * Sau khi upload TikTok thành công, gọi hàm này để đánh dấu shortlink đã dùng.
 * @param {string} shortlink - URL shortlink đã upload
 * @param {string} baseDir - Base directory
 */
function markShortlinkUploaded(shortlink, baseDir = path.resolve(__dirname, '..')) {
  // Tìm scheduler nào có shortlink này trong config
  const { getConfig } = require('../utils/config-manager');
  const config = getConfig(baseDir);
  for (const [configKey, scheduler] of schedulerRegistry.entries()) {
    const s = config[configKey] || {};
    const links = Array.isArray(s.shortlinks) ? s.shortlinks : [];
    if (links.includes(shortlink)) {
      scheduler.markLinkUploaded(baseDir, shortlink);
    }
  }
}

module.exports = {
  createAutoTemplateScheduler,
  autoT3Scheduler,
  autoT4Scheduler,
  autoT5Scheduler,
  markShortlinkUploaded,
};
