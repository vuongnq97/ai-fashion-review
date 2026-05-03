require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════
// TikTok Content Posting API Service
// Handles OAuth flow + Video upload via Direct Post
// ═══════════════════════════════════════════════════════════════

const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const TIKTOK_REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI;

const TIKTOK_AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2';

// ── Token store (persist to file) ────
const TOKEN_FILE = path.join(__dirname, '..', 'tokens.json');
let tokenStore = {};

// Load tokens on startup
if (fs.existsSync(TOKEN_FILE)) {
    try {
        tokenStore = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        console.log(`[TikTok] Loaded ${Object.keys(tokenStore).length} tokens from file.`);
    } catch (e) {
        console.error('[TikTok] Error loading tokens.json', e);
    }
}

function saveTokens() {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenStore, null, 2));
}

/**
 * Build the TikTok OAuth authorization URL.
 * User visits this URL → logs in → redirected back with auth code.
 *
 * @param {string} state - CSRF protection string
 * @returns {string} Authorization URL
 */
function getAuthUrl(state = 'random_state') {
    const scopes = 'user.info.basic,video.publish,video.upload';
    const params = new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        response_type: 'code',
        scope: scopes,
        redirect_uri: TIKTOK_REDIRECT_URI,
        state: state,
    });
    return `${TIKTOK_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access + refresh tokens.
 *
 * @param {string} code The authorization code from TikTok.
 * @param {string} [state] The state passed to the auth URL (used as telegram_id alias).
 * @returns {object} { open_id, access_token, refresh_token, expires_at }
 */
async function exchangeCodeForToken(code, state) {
    console.log('[TikTok] Exchanging auth code for access token...');

    const response = await axios.post(TIKTOK_TOKEN_URL, new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: TIKTOK_REDIRECT_URI,
    }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const data = response.data;
    if (data.error) {
        throw new Error(`[TikTok] Token exchange failed: ${data.error} - ${data.error_description}`);
    }

    const tokenData = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        open_id: data.open_id,
        expires_in: data.expires_in,
        expires_at: Date.now() + (data.expires_in * 1000),
    };

    // Save to store and persist
    tokenStore[tokenData.open_id] = tokenData;
    if (state && !state.startsWith('state_')) {
        // If state is not our default random state, assume it's a telegram user ID
        tokenStore[state] = tokenData;
        console.log(`[TikTok] ✅ Token alias created for Telegram ID: ${state}`);
    }
    saveTokens();
    console.log(`[TikTok] ✅ Token acquired for user: ${tokenData.open_id}`);

    return tokenData;
}

/**
 * Refresh an expired access token.
 *
 * @param {string} refreshToken - The refresh token
 * @returns {object} Updated token data
 */
async function refreshAccessToken(refreshToken) {
    console.log('[TikTok] Refreshing access token...');

    const response = await axios.post(TIKTOK_TOKEN_URL, new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
    }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const data = response.data;
    if (data.error) {
        throw new Error(`[TikTok] Token refresh failed: ${data.error}`);
    }

    const tokenData = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        open_id: data.open_id,
        expires_in: data.expires_in,
        expires_at: Date.now() + (data.expires_in * 1000),
    };

    tokenStore[tokenData.open_id] = tokenData;
    saveTokens();
    console.log(`[TikTok] ✅ Token refreshed for user: ${tokenData.open_id}`);

    return tokenData;
}

/**
 * Get a valid access token for a user (auto-refresh if expired).
 *
 * @param {string} openId - TikTok user open_id
 * @returns {string} Valid access token
 */
async function getValidToken(openId) {
    const stored = tokenStore[openId];
    if (!stored) {
        throw new Error(`[TikTok] No token found for user: ${openId}. Re-authorize required.`);
    }

    // Refresh if token expires within 5 minutes
    if (Date.now() > stored.expires_at - 5 * 60 * 1000) {
        const refreshed = await refreshAccessToken(stored.refresh_token);
        return refreshed.access_token;
    }

    return stored.access_token;
}

/**
 * Query creator info to get available privacy options.
 *
 * @param {string} accessToken - Valid access token
 * @returns {object} Creator info data
 */
async function queryCreatorInfo(accessToken) {
    console.log('[TikTok] Querying creator info...');

    const response = await axios.post(
        `${TIKTOK_API_BASE}/post/publish/creator_info/query/`,
        {},
        {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json; charset=UTF-8',
            },
        }
    );

    const data = response.data;
    if (data.error?.code !== 'ok') {
        throw new Error(`[TikTok] Creator info query failed: ${JSON.stringify(data.error)}`);
    }

    console.log(`[TikTok] ✅ Creator info retrieved. Privacy options:`, data.data?.privacy_level_options);
    return data.data;
}

/**
 * Upload a video to TikTok via Direct Post (FILE_UPLOAD).
 *
 * Flow:
 *   1. Initialize upload → get upload_url
 *   2. PUT video binary to upload_url
 *   3. Check publish status
 *
 * @param {string} accessToken - Valid access token
 * @param {Buffer} videoBuffer - MP4 video buffer
 * @param {object} options
 * @param {string} [options.title]         - Video title/caption
 * @param {string} [options.privacyLevel]  - 'SELF_ONLY' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'PUBLIC_TO_EVERYONE'
 * @param {boolean} [options.disableComment] - Disable comments
 * @param {boolean} [options.disableDuet]    - Disable duets
 * @param {boolean} [options.disableStitch]  - Disable stitches
 * @returns {object} { publish_id, upload_url, status }
 */
async function uploadVideo(accessToken, videoBuffer, options = {}) {
    const {
        title = 'AI Fashion Video ✨ #fashion #ai #tryon',
        privacyLevel = 'SELF_ONLY',
        disableComment = false,
        disableDuet = false,
        disableStitch = false,
    } = options;

    const videoSize = videoBuffer.length;
    console.log(`[TikTok] Initiating video upload (${(videoSize / 1024 / 1024).toFixed(1)} MB)...`);

    // ── Step 1: Initialize the post ──
    let initResponse;
    try {
        initResponse = await axios.post(
            `${TIKTOK_API_BASE}/post/publish/video/init/`,
            {
                post_info: {
                    title: title,
                    privacy_level: privacyLevel,
                    disable_comment: disableComment,
                    disable_duet: disableDuet,
                    disable_stitch: disableStitch,
                },
                source_info: {
                    source: 'FILE_UPLOAD',
                    video_size: videoSize,
                    chunk_size: videoSize, // Single chunk upload
                    total_chunk_count: 1,
                },
                post_mode: 'DIRECT_POST',
            },
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json; charset=UTF-8',
                },
            }
        );
    } catch (error) {
        console.error(`[TikTok] Upload init failed (HTTP error):`, error.response?.data || error.message);
        throw error;
    }

    const initData = initResponse.data;
    if (initData.error?.code !== 'ok') {
        throw new Error(`[TikTok] Upload init failed: ${JSON.stringify(initData.error)}`);
    }

    const { publish_id, upload_url } = initData.data;
    console.log(`[TikTok] ✅ Upload initialized. publish_id: ${publish_id}`);

    // ── Step 2: Upload video binary ──
    console.log(`[TikTok] Uploading video to TikTok servers...`);

    await axios.put(upload_url, videoBuffer, {
        headers: {
            'Content-Type': 'video/mp4',
            'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
    });

    console.log(`[TikTok] ✅ Video uploaded successfully!`);

    // ── Step 3: Check publish status ──
    const status = await checkPublishStatus(accessToken, publish_id);

    return {
        publish_id,
        status,
    };
}

/**
 * Upload video from base64 string (convenience wrapper).
 *
 * @param {string} accessToken - Valid access token
 * @param {string} base64Video - Base64-encoded MP4 video
 * @param {object} options     - Same as uploadVideo options
 * @returns {object} Upload result
 */
async function uploadVideoBase64(accessToken, base64Video, options = {}) {
    const videoBuffer = Buffer.from(base64Video, 'base64');
    return await uploadVideo(accessToken, videoBuffer, options);
}

/**
 * Check the publish status of an uploaded video.
 * Polls until the video is published or fails.
 *
 * @param {string} accessToken - Valid access token
 * @param {string} publishId   - The publish_id from upload init
 * @param {number} maxAttempts  - Max polling attempts
 * @returns {object} Status data
 */
async function checkPublishStatus(accessToken, publishId, maxAttempts = 15) {
    console.log(`[TikTok] Checking publish status for: ${publishId}...`);

    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s between checks

        const response = await axios.post(
            `${TIKTOK_API_BASE}/post/publish/status/fetch/`,
            { publish_id: publishId },
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json; charset=UTF-8',
                },
            }
        );

        const data = response.data;
        if (data.error?.code !== 'ok') {
            console.error(`[TikTok] Status check error:`, data.error);
            continue;
        }

        const status = data.data?.status;
        console.log(`[TikTok] Publish status (attempt ${i + 1}/${maxAttempts}): ${status}`);

        if (status === 'PUBLISH_COMPLETE') {
            console.log(`[TikTok] ✅ Video published successfully!`);
            return data.data;
        }

        if (status === 'FAILED') {
            const reason = data.data?.fail_reason || 'Unknown';
            throw new Error(`[TikTok] ❌ Video publish failed: ${reason}`);
        }

        // PROCESSING_UPLOAD, PROCESSING_DOWNLOAD, SENDING_TO_USER_INBOX → keep polling
    }

    console.log(`[TikTok] ⚠️ Publish status still processing after ${maxAttempts} attempts.`);
    return { status: 'PROCESSING', publish_id: publishId };
}

/**
 * Get user info for the authenticated user.
 *
 * @param {string} accessToken - Valid access token
 * @returns {object} User info
 */
async function getUserInfo(accessToken) {
    const response = await axios.get(
        `${TIKTOK_API_BASE}/user/info/?fields=open_id,union_id,avatar_url,display_name`,
        {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
            },
        }
    );

    const data = response.data;
    if (data.error?.code !== 'ok') {
        throw new Error(`[TikTok] User info failed: ${JSON.stringify(data.error)}`);
    }

    return data.data?.user;
}

// ── Utility: get all stored tokens ──
function getTokenStore() {
    return { ...tokenStore };
}

module.exports = {
    getAuthUrl,
    exchangeCodeForToken,
    refreshAccessToken,
    getValidToken,
    queryCreatorInfo,
    uploadVideo,
    uploadVideoBase64,
    checkPublishStatus,
    getUserInfo,
    getTokenStore,
};
