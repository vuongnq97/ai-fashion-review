'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('path');

const shopStorage = new AsyncLocalStorage();

/**
 * Strips brackets and trims a shop name string
 * @param {string} name 
 * @returns {string}
 */
function sanitizeShopName(name) {
  if (!name) return '';
  return String(name).trim().replace(/^\[+|\]+$/g, '').trim();
}

/**
 * Resolves shop name for a given chatId from config-manager channels
 * @param {string|number} chatId 
 * @param {string} baseDir 
 * @returns {string|null}
 */
function getShopNameForChat(chatId, baseDir = path.resolve(__dirname, '..')) {
  if (!chatId) return null;
  try {
    const { getRawChannelForChat, getChannelForChat } = require('./config-manager');
    const raw = getRawChannelForChat(baseDir, chatId);
    if (raw && raw.label) {
      return sanitizeShopName(raw.label);
    }
    const ch = getChannelForChat(baseDir, chatId);
    if (ch && ch.label) {
      return sanitizeShopName(ch.label);
    }
  } catch (_) {}
  return `Chat-${chatId}`;
}

/**
 * Returns currently active shop name in execution context, or null
 * @returns {string|null}
 */
function getActiveShopName() {
  const store = shopStorage.getStore();
  return store?.shopName || null;
}

/**
 * Runs a function within the context of a given shop name
 * @param {string|{shopName?: string, chatId?: string|number}} shop 
 * @param {Function} fn 
 * @returns {*}
 */
function runWithShop(shop, fn) {
  let shopName = null;
  if (typeof shop === 'string') {
    shopName = sanitizeShopName(shop);
  } else if (shop && typeof shop === 'object') {
    shopName = sanitizeShopName(shop.shopName || (shop.chatId ? getShopNameForChat(shop.chatId) : null));
  }

  if (!shopName) {
    return fn();
  }

  return shopStorage.run({ shopName }, fn);
}

// Global console patching
const CONSOLE_PATCHED = Symbol.for('__shop_console_patched__');

function patchGlobalConsole() {
  if (console[CONSOLE_PATCHED]) return;
  console[CONSOLE_PATCHED] = true;

  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  for (const method of methods) {
    const original = console[method];
    console[method] = function(...args) {
      const shopName = getActiveShopName();
      if (shopName) {
        const prefix = `[${shopName}]`;
        if (args.length === 0) {
          return original.apply(console, [prefix]);
        }
        if (typeof args[0] === 'string') {
          if (!args[0].includes(prefix)) {
            if (/^\s*\[/.test(args[0])) {
              args[0] = args[0].replace(/^(\s*)(\[)/, `$1${prefix}$2`);
            } else {
              args[0] = `${prefix} ${args[0]}`;
            }
          }
        } else {
          args.unshift(prefix);
        }
      }
      return original.apply(console, args);
    };
  }
}

// Auto-patch console when this module is imported
patchGlobalConsole();

module.exports = {
  shopStorage,
  sanitizeShopName,
  getShopNameForChat,
  getActiveShopName,
  runWithShop,
  patchGlobalConsole,
};
