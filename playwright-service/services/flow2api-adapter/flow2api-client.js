'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Flow2ApiClient
 * Client giao tiếp với Flow2API Gateway (chuẩn OpenAI & Google Flow)
 */
class Flow2ApiClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || process.env.FLOW2API_BASE_URL || 'http://127.0.0.1:38000').replace(/\/+$/, '');
    this.apiKey = options.apiKey || process.env.FLOW2API_API_KEY || 'han1234';
    this.timeout = options.timeout || 300000; // 5 phút

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeout,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Kiểm tra Flow2API server có sẵn sàng không
   */
  async isHealthy() {
    try {
      const res = await this.http.get('/health', { timeout: 3000 });
      return res.status === 200;
    } catch (_) {
      try {
        const res = await this.http.get('/v1/models', { timeout: 3000 });
        return res.status === 200;
      } catch (err) {
        return false;
      }
    }
  }

  /**
   * Lấy danh sách các model khả dụng từ Flow2API
   */
  async listModels() {
    const res = await this.http.get('/v1/models');
    return res.data?.data || [];
  }

  /**
   * Sinh ảnh bằng Flow2API
   * Sử dụng chuẩn model Gemini 3.0 Pro (GEM_PIX_2 / nano-banana-pro) theo chuẩn Template Pro
   * @param {object} params
   * @param {string} params.prompt
   * @param {string} [params.aspectRatio='landscape'] - 'landscape' (16:9), 'portrait' (9:16), 'square' (1:1)
   * @param {Array<{name?: string, buffer?: Buffer, base64?: string, mimeType?: string}>} [params.referenceImages=[]]
   * @param {string} [params.modelKey] - Chỉ định model cụ thể (mặc định gemini-3.0-pro-image-landscape cho 16:9)
   * @returns {Promise<{base64: string, buffer: Buffer, url?: string}>}
   */
  async generateImage({ prompt, aspectRatio = 'landscape', referenceImages = [], modelKey = null }) {
    const normRatio = String(aspectRatio || '').toLowerCase();
    let defaultModel = 'gemini-3.0-pro-image-landscape'; // GEM_PIX_2 / nano-banana-pro
    if (normRatio === '9:16' || normRatio === 'portrait') {
      defaultModel = 'gemini-3.0-pro-image-portrait';
    } else if (normRatio === '1:1' || normRatio === 'square') {
      defaultModel = 'gemini-3.0-pro-image-square';
    }

    const model = modelKey || defaultModel;

    const content = [];
    // Thêm các ảnh tham chiếu (nếu có)
    for (const ref of referenceImages) {
      let b64 = ref.base64;
      if (!b64 && ref.buffer) {
        b64 = ref.buffer.toString('base64');
      }
      if (b64) {
        const mime = ref.mimeType || 'image/png';
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:${mime};base64,${b64}`,
          },
        });
      }
    }

    // Thêm prompt text
    content.push({
      type: 'text',
      text: prompt,
    });

    console.log(`[Flow2API Client] Calling image generation (model: ${model} [GEM_PIX_2 / nano-banana-pro], ratio: ${normRatio || 'landscape'})...`);
    const payload = {
      model,
      messages: [
        {
          role: 'user',
          content: content.length === 1 && content[0].type === 'text' ? prompt : content,
        },
      ],
    };

    const res = await this.http.post('/v1/chat/completions', payload);
    const reply = res.data?.choices?.[0]?.message?.content || '';

    // Flow2API trả về ảnh dưới dạng markdown: ![image](data:image/png;base64,...) hoặc URL
    return this._extractMediaFromReply(reply, 'image');
  }

  /**
   * Sinh video từ ảnh bằng Flow2API
   * Sử dụng chuẩn model abra_r2v_4s (Omni 1.1 Flash 4s portrait) theo chuẩn Template Pro
   * @param {object} params
   * @param {Buffer|string} params.image - Buffer hoặc Base64 của ảnh nguồn
   * @param {string} params.prompt - Mô tả chuyển động cho video
   * @param {number} [params.duration=4] - 4 giây theo chuẩn Template Pro (4 panels x 4s = 16s)
   * @param {string} [params.aspectRatio='portrait'] - 'portrait' (9:16) hoặc 'landscape' (16:9)
   * @param {string} [params.modelKey] - Tùy chọn chỉ định model (mặc định omni-1.1-flash-4s-portrait / abra_r2v_4s)
   * @returns {Promise<{base64: string, buffer: Buffer, url?: string}>}
   */
  async generateVideo({ image, prompt, duration = 4, aspectRatio = 'portrait', modelKey = null }) {
    let b64 = '';
    if (Buffer.isBuffer(image)) {
      b64 = image.toString('base64');
    } else if (typeof image === 'string') {
      b64 = image.replace(/^data:image\/\w+;base64,/, '');
    } else if (image && image.buffer) {
      b64 = image.buffer.toString('base64');
    }

    const ratio = (aspectRatio === '16:9' || aspectRatio === 'landscape') ? 'landscape' : 'portrait';
    const dur = Number(duration) === 6 ? 6 : 4; // Mặc định 4s cho Template Pro

    let resolvedModel;
    if (modelKey) {
      if (modelKey === 'abra_r2v_4s' || modelKey === 'abra_i2v_4s') {
        resolvedModel = `omni-1.1-flash-4s-${ratio}`;
      } else {
        resolvedModel = modelKey;
      }
    } else {
      // Model chuẩn TPro cho 4s Start Frame: omni-1.1-flash-4s-portrait (upstream abra_r2v_4s)
      resolvedModel = `omni-1.1-flash-${dur}s-${ratio}`;
    }

    console.log(`[Flow2API Client] Calling video generation (model: ${resolvedModel} [upstream: abra_r2v_${dur}s], duration: ${dur}s)...`);

    const content = [];
    if (b64) {
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${b64}`,
        },
      });
    }
    content.push({
      type: 'text',
      text: prompt,
    });

    const payload = {
      model: resolvedModel,
      messages: [
        {
          role: 'user',
          content: content.length === 1 && content[0].type === 'text' ? prompt : content,
        },
      ],
    };

    const res = await this.http.post('/v1/chat/completions', payload);
    const reply = res.data?.choices?.[0]?.message?.content || '';

    return this._extractMediaFromReply(reply, 'video');
  }

  /**
   * Helper trích xuất Base64 hoặc download URL từ phản hồi markdown của Flow2API
   */
  async _extractMediaFromReply(reply, type = 'video') {
    // Trường hợp 1: Base64 data URI
    const dataUriMatch = reply.match(/data:(?:image|video)\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
    if (dataUriMatch) {
      const b64 = dataUriMatch[1];
      return {
        base64: b64,
        buffer: Buffer.from(b64, 'base64'),
      };
    }

    // Trường hợp 2: HTML video / img / source tags: <video src='...'>, <img src='...'>, <source src='...'>
    const htmlTagMatch = reply.match(/<(?:video|img|source)[^>]+src=['"](https?:\/\/[^'"]+)['"]/i);
    let targetUrl = htmlTagMatch ? htmlTagMatch[1] : null;

    // Trường hợp 3: Markdown URL: ![alt](http...) hoặc [link](http...)
    if (!targetUrl) {
      const urlMatch = reply.match(/(?:!\[[^\]]*\]\((https?:\/\/[^\s\)]+)\)|\[[^\]]*\]\((https?:\/\/[^\s\)]+)\))/i);
      targetUrl = urlMatch ? (urlMatch[1] || urlMatch[2]) : null;
    }

    // Trường hợp 4: Direct URL hoặc Google flow-content CDN URL
    if (!targetUrl) {
      const directUrlMatch = reply.match(/https?:\/\/(?:flow-content\.google\/(?:video|image)\/[^\s<>'"`]+|[^\s<>'"`]+\.(?:mp4|webm|png|jpg|webp)(?:\?[^\s<>'"`]*)?)/i);
      targetUrl = directUrlMatch ? directUrlMatch[0] : null;
    }

    if (targetUrl) {
      console.log(`[Flow2API Client] Downloading media from URL: ${targetUrl}...`);
      const resp = await axios.get(targetUrl, {
        responseType: 'arraybuffer',
        timeout: 120000,
      });
      const buf = Buffer.from(resp.data);
      return {
        url: targetUrl,
        buffer: buf,
        base64: buf.toString('base64'),
      };
    }

    // Trường hợp 5: Trả về chuỗi base64 raw
    if (reply.length > 500 && /^[A-Za-z0-9+/=\s]+$/.test(reply.trim())) {
      const cleanB64 = reply.trim().replace(/\s/g, '');
      return {
        base64: cleanB64,
        buffer: Buffer.from(cleanB64, 'base64'),
      };
    }

    throw new Error(`Flow2API did not return valid ${type} payload. Response preview: ${reply.slice(0, 300)}`);
  }
}

module.exports = {
  Flow2ApiClient,
};
