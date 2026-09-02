'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const axios = require('axios');

const { getConfig } = require('../utils/config-manager');
const { extractProductAssetsFromHtml } = require('./product-assets');
const { generationJobService } = require('./generation-job');
const { sendTelegramMessage } = require('./telegram-send');

const tgHttp = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  proxy: false,
});

const DEFAULT_TIMES = ["09:00", "12:00", "15:00", "18:00", "21:00"];
const CHECK_INTERVAL_MS = 30000;

let schedulerTimer = null;
let isRunningSlot = false;

function getStatePath(baseDir) {
  return path.join(baseDir, 'auto-t3-state.json');
}

function readState(baseDir) {
  try {
    const statePath = getStatePath(baseDir);
    if (!fs.existsSync(statePath)) return { lastRunSlots: {}, nextLinkIndex: 0 };
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (_) {
    return { lastRunSlots: {}, nextLinkIndex: 0 };
  }
}

function writeState(baseDir, state) {
  fs.writeFileSync(getStatePath(baseDir), JSON.stringify(state, null, 2));
}

function readRawConfig(baseDir) {
  const configPath = path.join(baseDir, 'config.json');
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function writeRawConfig(baseDir, config) {
  const configPath = path.join(baseDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

function normalizeAutoT3Config(baseDir) {
  const config = getConfig(baseDir);
  const auto = config.autoT3Settings || {};
  const times = (Array.isArray(auto.times) ? auto.times : DEFAULT_TIMES)
    .map(value => String(value || '').trim())
    .filter(value => /^\d{2}:\d{2}$/.test(value))
    .slice(0, 5);
  const shortlinks = (Array.isArray(auto.shortlinks) ? auto.shortlinks : [])
    .map(value => String(value || '').trim())
    .filter(Boolean);

  return {
    enabled: !!auto.enabled,
    chatId: String(auto.chatId || '').trim(),
    timezone: String(auto.timezone || 'Asia/Ho_Chi_Minh').trim(),
    times: times.length > 0 ? times : DEFAULT_TIMES,
    shortlinks,
  };
}

function getLocalDateTime(timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    date: `${byType.year}-${byType.month}-${byType.day}`,
    time: `${byType.hour}:${byType.minute}`,
  };
}

function enableAutoT3ForChat(baseDir, chatId) {
  const raw = readRawConfig(baseDir);
  raw.autoT3Settings = {
    ...(raw.autoT3Settings || {}),
    enabled: true,
    chatId: String(chatId),
    timezone: raw.autoT3Settings?.timezone || 'Asia/Ho_Chi_Minh',
    times: raw.autoT3Settings?.times || DEFAULT_TIMES,
    shortlinks: raw.autoT3Settings?.shortlinks || [],
  };
  writeRawConfig(baseDir, raw);
  return normalizeAutoT3Config(baseDir);
}

function disableAutoT3(baseDir) {
  const raw = readRawConfig(baseDir);
  raw.autoT3Settings = {
    ...(raw.autoT3Settings || {}),
    enabled: false,
  };
  writeRawConfig(baseDir, raw);
  return normalizeAutoT3Config(baseDir);
}

function pickNextShortlink(baseDir, shortlinks) {
  const state = readState(baseDir);
  const index = Math.max(0, Number(state.nextLinkIndex) || 0) % shortlinks.length;
  state.nextLinkIndex = (index + 1) % shortlinks.length;
  writeState(baseDir, state);
  return { shortlink: shortlinks[index], index };
}

async function enqueueAutoT3Job(baseDir, autoConfig, shortlink, slotLabel) {
  await sendTelegramMessage(autoConfig.chatId, `🤖 /auto_t3 đến lịch ${slotLabel}. Đang lấy sản phẩm từ link cấu hình...`);

  const resp = await tgHttp.get(shortlink, {
    maxRedirects: 5,
    validateStatus: () => true,
    timeout: Number(process.env.AUTO_T3_SHORTLINK_TIMEOUT_MS || '20000'),
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  const productUrl = resp.request?.res?.responseUrl || shortlink;
  const assets = extractProductAssetsFromHtml(resp.data, productUrl);
  if (!assets.title && assets.productImages.length === 0) {
    throw new Error('Không thể lấy thông tin sản phẩm hoặc ảnh từ link cấu hình.');
  }

  const enqueueResult = generationJobService.enqueueJob({
    chatId: String(autoConfig.chatId),
    sourceMessageId: null,
    shortlink,
    productUrl,
    template: 'template3',
    productId: assets.productId || `auto_t3_${Date.now()}`,
    productTitle: assets.title,
    productDescription: assets.productDescription,
    productImages: assets.productImages.slice(0, 8),
  }, baseDir);
  const job = enqueueResult.job || enqueueResult;

  await sendTelegramMessage(
    autoConfig.chatId,
    `✅ /auto_t3 đã queue template3 cho [${assets.title || 'TikTok Shop'}]. Job ID: ${job.jobId}`
  );
  return job;
}

async function runDueAutoT3(baseDir, forced = false) {
  const autoConfig = normalizeAutoT3Config(baseDir);
  if (!autoConfig.enabled && !forced) return null;
  if (!autoConfig.chatId) return null;
  if (autoConfig.shortlinks.length === 0) {
    if (forced) {
      await sendTelegramMessage(autoConfig.chatId, '⚠️ /auto_t3 chưa có shortlinks trong config.json.');
    }
    return null;
  }

  const now = getLocalDateTime(autoConfig.timezone);
  const matchedTime = forced ? now.time : autoConfig.times.find(time => time === now.time);
  if (!matchedTime) return null;

  const state = readState(baseDir);
  const slotKey = `${now.date} ${matchedTime}`;
  if (!forced && state.lastRunSlots?.[slotKey]) return null;
  if (isRunningSlot) return null;

  isRunningSlot = true;
  try {
    const { shortlink } = pickNextShortlink(baseDir, autoConfig.shortlinks);
    const job = await enqueueAutoT3Job(baseDir, autoConfig, shortlink, slotKey);
    const latestState = readState(baseDir);
    latestState.lastRunSlots = latestState.lastRunSlots || {};
    latestState.lastRunSlots[slotKey] = {
      jobId: job.jobId,
      shortlink,
      ranAt: new Date().toISOString(),
      forced,
    };
    writeState(baseDir, latestState);
    return job;
  } catch (error) {
    console.error('[AutoT3] Run failed:', error.message);
    await sendTelegramMessage(autoConfig.chatId, `⚠️ /auto_t3 lỗi ở lịch ${slotKey}: ${error.message}`);
    return null;
  } finally {
    isRunningSlot = false;
  }
}

function startAutoT3Scheduler(baseDir = path.resolve(__dirname, '..')) {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    runDueAutoT3(baseDir).catch(err => console.error('[AutoT3] Scheduler error:', err.message));
  }, CHECK_INTERVAL_MS);
  runDueAutoT3(baseDir).catch(err => console.error('[AutoT3] Initial check error:', err.message));
  console.log('[auto_t3] ✅ Scheduler started (autoT3Settings).');
}

function stopAutoT3Scheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
}

async function handleAutoT3Command(botToken, chatId, text, baseDir = path.resolve(__dirname, '..')) {
  const arg = String(text || '').replace(/^\/auto_t3(?:@\S+)?/i, '').trim().toLowerCase();
  if (arg === 'off' || arg === 'stop') {
    const cfg = disableAutoT3(baseDir);
    await sendTelegramMessage(chatId, `⏸️ Đã tắt /auto_t3. Chat nhận lịch hiện tại: ${cfg.chatId || 'chưa cấu hình'}.`);
    return;
  }

  if (arg === 'run' || arg === 'now') {
    const cfg = enableAutoT3ForChat(baseDir, chatId);
    await sendTelegramMessage(chatId, '▶️ Đã bật /auto_t3 và chạy thử ngay 1 link kế tiếp.');
    await runDueAutoT3(baseDir, true);
    return;
  }

  const cfg = enableAutoT3ForChat(baseDir, chatId);
  startAutoT3Scheduler(baseDir);
  const linksText = cfg.shortlinks.length > 0 ? `${cfg.shortlinks.length} link` : 'chưa có link';
  await sendTelegramMessage(
    chatId,
    `✅ Đã bật /auto_t3 cho chat này.\n` +
    `⏰ Giờ chạy: ${cfg.times.join(', ')} (${cfg.timezone})\n` +
    `🔗 Danh sách config: ${linksText}\n\n` +
    `Thêm link vào playwright-service/config.json → autoT3Settings.shortlinks. Dùng /auto_t3 run để chạy thử ngay, /auto_t3 off để tắt.`
  );
}

module.exports = {
  startAutoT3Scheduler,
  stopAutoT3Scheduler,
  handleAutoT3Command,
  normalizeAutoT3Config,
  runDueAutoT3,
};
