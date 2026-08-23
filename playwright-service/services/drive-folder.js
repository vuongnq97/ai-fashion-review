const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { runStoryboardFullFlow } = require('./storyboard-fullflow');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);

function extractDriveFolderId(value) {
  const raw = String(value || '').trim();
  if (/^[a-zA-Z0-9_-]{10,}$/.test(raw) && !raw.includes('/')) {
    return raw;
  }
  const match = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function isDriveUrl(value) {
  return typeof value === 'string' && value.includes('drive.google.com');
}

function normalizeFolderName(folderName) {
  const name = String(folderName || '').trim().replace(/^\/+/, '');
  return /^\d+$/.test(name) ? `p${name}` : name;
}

function folderEnvKey(folderName) {
  return `DRIVE_FOLDER_${normalizeFolderName(folderName).replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase()}`;
}

function getDriveApiKey() {
  const apiKey = (process.env.GOOGLE_DRIVE_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error(
      '[DriveFolder] GOOGLE_DRIVE_API_KEY is required to use Google Drive.\n' +
      '  -> Get a free key: https://console.cloud.google.com/apis/credentials\n' +
      '  -> Enable "Google Drive API" then create an API key.'
    );
  }
  return apiKey;
}

function escapeDriveQueryValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function resolveFolderConfig(folderName) {
  const normalizedName = normalizeFolderName(folderName);

  // Per-folder override, for example DRIVE_FOLDER_P1 or DRIVE_FOLDER_M2.
  const specificVal = (process.env[folderEnvKey(normalizedName)] || '').trim();
  if (specificVal) {
    if (isDriveUrl(specificVal) || extractDriveFolderId(specificVal)) {
      return { type: 'drive-api', value: specificVal };
    }
    return { type: 'local', value: specificVal };
  }

  // Parent Drive folder: command name maps to a direct child folder name.
  const parentFolder = (
    process.env.DRIVE_PARENT_FOLDER_ID ||
    process.env.DRIVE_PARENT_FOLDER_URL ||
    process.env.DRIVE_PARENT_FOLDER ||
    ''
  ).trim();
  if (parentFolder) {
    const parentFolderId = extractDriveFolderId(parentFolder);
    if (!parentFolderId) {
      throw new Error(`[DriveFolder] Cannot extract parent folder ID from: ${parentFolder}`);
    }
    return { type: 'drive-child', value: parentFolderId, folderName: normalizedName };
  }

  // Local parent directory fallback.
  const syncRoot = (process.env.DRIVE_SYNC_ROOT || '').trim();
  if (syncRoot && !isDriveUrl(syncRoot)) {
    return { type: 'local', value: path.join(syncRoot, normalizedName) };
  }

  return { type: 'local', value: path.join(process.cwd(), normalizedName) };
}

async function listDriveFiles(params) {
  const apiKey = getDriveApiKey();
  const listRes = await axios.get('https://www.googleapis.com/drive/v3/files', {
    params: {
      ...params,
      key: apiKey,
    },
    timeout: 30000,
  });
  return listRes.data.files || [];
}

async function findDriveChildFolder(parentFolderId, folderName) {
  const safeName = escapeDriveQueryValue(folderName);
  const folderMimeType = 'application/vnd.google-apps.folder';

  console.log(`[DriveFolder] Searching child folder "${folderName}" in parent: ${parentFolderId}`);

  const folders = await listDriveFiles({
    q: `'${parentFolderId}' in parents and name='${safeName}' and mimeType='${folderMimeType}' and trashed=false`,
    fields: 'files(id,name,mimeType)',
    pageSize: 10,
    orderBy: 'name',
  });

  if (folders.length === 0) {
    throw new Error(`[DriveFolder] Folder "${folderName}" was not found under parent folder "${parentFolderId}".`);
  }
  if (folders.length > 1) {
    console.warn(`[DriveFolder] Found ${folders.length} folders named "${folderName}". Using first: ${folders[0].id}`);
  }

  console.log(`[DriveFolder] Matched child folder "${folders[0].name}": ${folders[0].id}`);
  return folders[0].id;
}

async function listDriveChildFolders(parentFolderId) {
  const folderMimeType = 'application/vnd.google-apps.folder';

  const folders = await listDriveFiles({
    q: `'${parentFolderId}' in parents and mimeType='${folderMimeType}' and trashed=false`,
    fields: 'files(id,name,mimeType)',
    pageSize: 100,
    orderBy: 'name_natural',
  });

  return folders
    .filter(folder => folder && folder.id && folder.name)
    .map(folder => ({ id: folder.id, name: folder.name }));
}

async function downloadFromDriveFolder(folderId) {
  console.log(`[DriveFolder] Listing files in Google Drive folder: ${folderId}`);

  const allFiles = await listDriveFiles({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id,name,mimeType)',
    pageSize: 100,
    orderBy: 'name',
  });
  const imageFiles = allFiles.filter(f => IMAGE_MIME_TYPES.has(f.mimeType));

  if (imageFiles.length === 0) {
    throw new Error(
      `[DriveFolder] No image files found in Drive folder "${folderId}". ` +
      `(Found ${allFiles.length} total files, none are images.)`
    );
  }

  console.log(`[DriveFolder] Found ${imageFiles.length} image(s) in Drive folder.`);

  const apiKey = getDriveApiKey();
  const filePayloads = [];
  for (const file of imageFiles) {
    console.log(`[DriveFolder] -> Downloading: ${file.name}`);
    const dlRes = await axios.get(
      `https://www.googleapis.com/drive/v3/files/${file.id}`,
      {
        params: { alt: 'media', key: apiKey },
        responseType: 'arraybuffer',
        timeout: 60000,
      }
    );
    const buffer = Buffer.from(dlRes.data);
    console.log(`[DriveFolder]    OK ${file.name} (${buffer.length} bytes)`);
    filePayloads.push({ name: file.name, mimeType: file.mimeType, buffer });
  }

  return filePayloads;
}

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
      ext === '.png' ? 'image/png' :
      ext === '.webp' ? 'image/webp' :
      ext === '.gif' ? 'image/gif' :
      'image/jpeg';
    const buffer = fs.readFileSync(path.join(folderPath, filename));
    console.log(`[DriveFolder] -> Loaded: ${filename} (${buffer.length} bytes)`);
    return { name: filename, mimeType, buffer };
  });
}

async function runFromDriveFolder(folderName, baseDir, options = {}) {
  const normalizedName = normalizeFolderName(folderName);
  const config = resolveFolderConfig(normalizedName);
  console.log(`[DriveFolder] Folder name : ${normalizedName}`);
  console.log(`[DriveFolder] Source type : ${config.type}`);
  console.log(`[DriveFolder] Source value: ${config.value}`);

  const chatId = process.env.DEFAULT_TELEGRAM_CHAT_ID
    ? String(process.env.DEFAULT_TELEGRAM_CHAT_ID)
    : `local-${normalizedName}`;
  console.log(`[DriveFolder] Using chatId: ${chatId}`);

  let filePayloads;
  try {
    if (config.type === 'drive-api') {
      const folderId = extractDriveFolderId(config.value);
      if (!folderId) {
        throw new Error(`[DriveFolder] Cannot extract folder ID from: ${config.value}`);
      }
      console.log(`[DriveFolder] Drive folder ID: ${folderId}`);
      filePayloads = await downloadFromDriveFolder(folderId);
    } else if (config.type === 'drive-child') {
      const folderId = await findDriveChildFolder(config.value, config.folderName);
      filePayloads = await downloadFromDriveFolder(folderId);
    } else {
      filePayloads = loadImagesFromFolder(config.value);
    }
  } catch (err) {
    console.error(`[DriveFolder] Failed to load images: ${err.message}`);
    throw err;
  }

  const templateLabel = options.template ? ` (${options.template})` : '';
  console.log(`[DriveFolder] Starting storyboard full flow${templateLabel} with ${filePayloads.length} image(s)...`);
  const result = await runStoryboardFullFlow(chatId, filePayloads, baseDir, options);
  console.log(`[DriveFolder] Full flow completed. Sent ${result.sentCount ?? '?'} video(s).`);
  return result;
}

module.exports = {
  runFromDriveFolder,
  loadImagesFromFolder,
  downloadFromDriveFolder,
  findDriveChildFolder,
  listDriveChildFolders,
  extractDriveFolderId,
  normalizeFolderName,
  resolveFolderConfig,
};
