const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { runStoryboardFullFlow } = require('./storyboard-fullflow');

// Supported local image extensions
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

// Supported Drive image MIME types
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif',
]);

// ─── Google Drive helpers ─────────────────────────────────────────────────────

/**
 * Extract the folder ID from a Google Drive URL.
 * Supports:
 *   https://drive.google.com/drive/folders/FOLDER_ID
 *   https://drive.google.com/drive/folders/FOLDER_ID?usp=sharing
 */
function extractDriveFolderId(url) {
  const match = String(url || '').match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Check if a string looks like a Google Drive URL (not a local path).
 */
function isDriveUrl(value) {
  return typeof value === 'string' && value.includes('drive.google.com');
}

/**
 * Resolve the source configuration for -p <folderName>.
 *
 * Priority:
 *   1. DRIVE_FOLDER_P{n}  env var  (Drive URL or local path)
 *   2. DRIVE_SYNC_ROOT     env var  (only if it's a local path, not a URL)
 *   3. ./p{n}              relative fallback
 *
 * Returns: { type: 'drive-api' | 'local', value: string }
 */
function resolveFolderConfig(folderName) {
  // 1. Per-folder env var: DRIVE_FOLDER_P1, DRIVE_FOLDER_P2, ...
  const specificKey = `DRIVE_FOLDER_P${folderName}`;
  const specificVal = (process.env[specificKey] || '').trim();
  if (specificVal) {
    if (isDriveUrl(specificVal)) {
      return { type: 'drive-api', value: specificVal };
    }
    return { type: 'local', value: specificVal };
  }

  // 2. DRIVE_SYNC_ROOT — only use if it's a real local path (not a Drive URL)
  const syncRoot = (process.env.DRIVE_SYNC_ROOT || '').trim();
  if (syncRoot && !isDriveUrl(syncRoot)) {
    return { type: 'local', value: path.join(syncRoot, `p${folderName}`) };
  }

  // 3. Default: ./p{n} relative to playwright-service directory
  return { type: 'local', value: path.join(process.cwd(), `p${folderName}`) };
}

// ─── Google Drive API download ────────────────────────────────────────────────

/**
 * Download all images from a public Google Drive folder using Drive API v3.
 * Requires GOOGLE_DRIVE_API_KEY in .env (free, no OAuth needed for public folders).
 *
 * @param {string} folderId  - Google Drive folder ID
 * @returns {Promise<Array<{name, mimeType, buffer}>>}
 */
async function downloadFromDriveFolder(folderId) {
  const apiKey = (process.env.GOOGLE_DRIVE_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error(
      '[DriveFolder] GOOGLE_DRIVE_API_KEY is required to download from Google Drive.\n' +
      '  → Get a free key: https://console.cloud.google.com/apis/credentials\n' +
      '  → Enable "Google Drive API" then create an API key.'
    );
  }

  console.log(`[DriveFolder] Listing files in Google Drive folder: ${folderId}`);

  // List image files in the folder
  const listRes = await axios.get('https://www.googleapis.com/drive/v3/files', {
    params: {
      q: `'${folderId}' in parents and trashed=false`,
      key: apiKey,
      fields: 'files(id,name,mimeType)',
      pageSize: 100,
      orderBy: 'name',
    },
    timeout: 30000,
  });

  const allFiles = listRes.data.files || [];
  const imageFiles = allFiles.filter(f => IMAGE_MIME_TYPES.has(f.mimeType));

  if (imageFiles.length === 0) {
    throw new Error(
      `[DriveFolder] No image files found in Drive folder "${folderId}". ` +
      `(Found ${allFiles.length} total files, none are images.)`
    );
  }

  console.log(`[DriveFolder] Found ${imageFiles.length} image(s) in Drive folder.`);

  const filePayloads = [];
  for (const file of imageFiles) {
    console.log(`[DriveFolder]   → Downloading: ${file.name}`);
    const dlRes = await axios.get(
      `https://www.googleapis.com/drive/v3/files/${file.id}`,
      {
        params: { alt: 'media', key: apiKey },
        responseType: 'arraybuffer',
        timeout: 60000,
      }
    );
    const buffer = Buffer.from(dlRes.data);
    console.log(`[DriveFolder]     ✅ ${file.name} (${buffer.length} bytes)`);
    filePayloads.push({ name: file.name, mimeType: file.mimeType, buffer });
  }

  return filePayloads;
}

// ─── Local folder load ────────────────────────────────────────────────────────

/**
 * Read all supported image files from a local directory.
 *
 * @param {string} folderPath - Absolute local path
 * @returns {Array<{name, mimeType, buffer}>}
 */
function loadImagesFromFolder(folderPath) {
  if (!fs.existsSync(folderPath)) {
    throw new Error(`[DriveFolder] Folder not found: ${folderPath}`);
  }

  const entries = fs.readdirSync(folderPath);
  const imageFiles = entries.filter(e => IMAGE_EXTENSIONS.has(path.extname(e).toLowerCase()));

  if (imageFiles.length === 0) {
    throw new Error(`[DriveFolder] No supported image files found in: ${folderPath}`);
  }

  console.log(`[DriveFolder] Found ${imageFiles.length} image(s) in "${folderPath}"`);

  return imageFiles.map(filename => {
    const ext = path.extname(filename).toLowerCase();
    const mimeType =
      ext === '.png'  ? 'image/png'  :
      ext === '.webp' ? 'image/webp' :
      ext === '.gif'  ? 'image/gif'  : 'image/jpeg';
    const buffer = fs.readFileSync(path.join(folderPath, filename));
    console.log(`[DriveFolder]   → Loaded: ${filename} (${buffer.length} bytes)`);
    return { name: filename, mimeType, buffer };
  });
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Entry point for `node server.js -p <folderName>`.
 *
 * Auto-detects whether to download from Google Drive or read from local disk.
 * Configure via .env:
 *   DRIVE_FOLDER_P1=https://drive.google.com/drive/folders/FOLDER_ID   ← Drive URL
 *   DRIVE_FOLDER_P1=/path/to/local/folder                              ← Local path
 *   GOOGLE_DRIVE_API_KEY=...                                            ← Needed for Drive URL
 *
 * @param {string} folderName - The value after -p (e.g. "1")
 * @param {string} baseDir    - Absolute path to playwright-service root
 */
async function runFromDriveFolder(folderName, baseDir) {
  const config = resolveFolderConfig(folderName);
  console.log(`[DriveFolder] Source type : ${config.type}`);
  console.log(`[DriveFolder] Source value: ${config.value}`);

  const chatId = process.env.DEFAULT_TELEGRAM_CHAT_ID
    ? String(process.env.DEFAULT_TELEGRAM_CHAT_ID)
    : `local-p${folderName}`;
  console.log(`[DriveFolder] Using chatId: ${chatId}`);

  let filePayloads;
  try {
    if (config.type === 'drive-api') {
      const folderId = extractDriveFolderId(config.value);
      if (!folderId) {
        throw new Error(`[DriveFolder] Cannot extract folder ID from URL: ${config.value}`);
      }
      console.log(`[DriveFolder] Drive folder ID: ${folderId}`);
      filePayloads = await downloadFromDriveFolder(folderId);
    } else {
      filePayloads = loadImagesFromFolder(config.value);
    }
  } catch (err) {
    console.error(`[DriveFolder] ❌ Failed to load images: ${err.message}`);
    throw err;
  }

  console.log(`[DriveFolder] 🚀 Starting storyboard full flow with ${filePayloads.length} image(s)...`);
  const result = await runStoryboardFullFlow(chatId, filePayloads, baseDir);
  console.log(`[DriveFolder] ✅ Full flow completed. Sent ${result.sentCount ?? '?'} video(s).`);
  return result;
}

module.exports = {
  runFromDriveFolder,
  loadImagesFromFolder,
  downloadFromDriveFolder,
  extractDriveFolderId,
  resolveFolderConfig,
};
