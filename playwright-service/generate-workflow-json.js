'use strict';

const fs = require('fs');
const path = require('path');

const SERVICE_HOST = 'http://host.docker.internal:3000';

function createWorkflow() {
  const nodes = [
    // ═══════════════════════════════════════════════════════════════
    // Group A: Webhook Intake & Action Routing
    // ═══════════════════════════════════════════════════════════════
    {
      parameters: {
        httpMethod: 'POST',
        path: 'tiktok-task',
        responseMode: 'onReceived',
        responseData: 'allEntries',
        options: {}
      },
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 0],
      id: 'node-webhook-trigger',
      name: 'Webhook — Telegram Event'
    },
    {
      parameters: {
        jsCode: `
const data = $json.body || $json;
const text = String(data.text || '').trim();
const chatId = String(data.chatId || '');
const messageId = data.messageId || null;

if (!text && !data.shortlink && !data.targetJobId) {
  return { json: { route: 'invalid', chatId, messageId, error: 'Tin nhắn không có nội dung hợp lệ' } };
}

// 1. Check if command is /upload [jobId] / /remake <panels> [instruction] / /templateX
if (data.route === 'upload' || text.startsWith('/upload')) {
  const parts = text.split(/\\s+/);
  const targetJobId = data.targetJobId || parts[1] || null;
  return {
    json: {
      route: 'command',
      command: 'upload',
      chatId,
      messageId,
      targetJobId,
      rawText: text
    }
  };
}

if (data.route === 'remake' || text.startsWith('/remake')) {
  let panels = [];
  let instruction = '';
  const underscoreMatch = text.match(/^\\/remake_([0-9_]+)(?:@\\w+)?(?:\\s+(.*))?$/i);
  if (underscoreMatch) {
    panels = underscoreMatch[1].split('_').map(d => parseInt(d, 10)).filter(n => !Number.isNaN(n) && n > 0 && n <= 10);
    instruction = (underscoreMatch[2] || '').trim();
  } else {
    const parts = text.replace(/^\\/remake(?:@\\w+)?\\s*/i, '').trim();
    const tokens = parts ? parts.split(/\\s+/) : [];
    const remaining = [];
    for (const token of tokens) {
      const n = parseInt(token, 10);
      if (!Number.isNaN(n) && n > 0 && n <= 10 && remaining.length === 0) {
        panels.push(n);
      } else if (token) {
        remaining.push(token);
      }
    }
    instruction = remaining.join(' ').trim();
  }
  if (panels.length === 0) panels = [1];
  return {
    json: {
      route: 'command',
      command: 'remake',
      chatId,
      messageId,
      targetJobId: data.targetJobId || null,
      panels,
      instruction,
      rawText: text
    }
  };
}

const commandTemplateMatch = text.match(/^\\/(template[0-9_]+)/i);
if (data.route === 'template' || commandTemplateMatch) {
  return {
    json: {
      route: 'command',
      command: 'template',
      chatId,
      messageId,
      targetJobId: data.targetJobId || null,
      template: data.template || commandTemplateMatch?.[1] || null,
      rawText: text
    }
  };
}

// 2. Check if message contains TikTok shortlink or URL
const urlMatch = data.shortlink || text.match(/(https?:\\/\\/(?:vt\\.tiktok\\.com|www\\.tiktok\\.com|shop\\.tiktok\\.com)\\/[^\\s]+)/i)?.[1];
if (urlMatch) {
  let template = data.template || 'template3';
  const templateMatch = text.match(/\\/(template[0-9_]+)/i);
  if (templateMatch) {
    template = templateMatch[1];
  }
  return {
    json: {
      route: 'generate',
      chatId,
      messageId,
      shortlink: urlMatch,
      template,
      rawText: text
    }
  };
}

return {
  json: {
    route: 'invalid',
    chatId,
    messageId,
    error: 'Vui lòng gửi shortlink TikTok Shop (vd: https://vt.tiktok.com/...) để tạo video, hoặc gõ /upload để đăng video hoàn tất gần nhất.'
  }
};
`
      },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [240, 0],
      id: 'node-parse-telegram',
      name: 'Parse Telegram Message'
    },
    {
      parameters: {
        conditions: {
          options: {
            caseSensitive: true,
            leftValue: '',
            typeValidation: 'strict',
            version: 2
          },
          conditions: [
            {
              leftValue: '={{ $json.route }}',
              rightValue: 'generate',
              operator: {
                type: 'string',
                operation: 'equals'
              }
            }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [480, 0],
      id: 'node-if-generate',
      name: 'Is Generation Request?'
    },
    {
      parameters: {
        conditions: {
          options: {
            caseSensitive: true,
            leftValue: '',
            typeValidation: 'strict',
            version: 2
          },
          conditions: [
            {
              leftValue: '={{ $json.route }}',
              rightValue: 'command',
              operator: {
                type: 'string',
                operation: 'equals'
              }
            }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [480, 400],
      id: 'node-if-upload',
      name: 'Is Control Command?'
    },
    {
      parameters: {
        method: 'POST',
        url: `${SERVICE_HOST}/api/jobs/command`,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ chatId: $json.chatId, command: $json.command, targetJobId: $json.targetJobId, panels: $json.panels || [], instruction: $json.instruction || "", template: $json.template || null, rawText: $json.rawText || "" }) }}',
        options: {}
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [720, 350],
      id: 'node-http-signal-command',
      name: 'Signal User Command'
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { leftValue: '={{ $json.delivery }}', rightValue: 'delivered', operator: { type: 'string', operation: 'equals' } }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [960, 350],
      id: 'node-if-execution-waiting',
      name: 'Is Execution Waiting?'
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { leftValue: '={{ $json.command }}', rightValue: 'upload', operator: { type: 'string', operation: 'equals' } }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [1200, 450],
      id: 'node-if-direct-upload',
      name: 'Is Direct Upload?'
    },
    {
      parameters: {
        chatId: '={{ $(\'Parse Telegram Message\').item.json.chatId }}',
        text: '={{ $json.command === "upload" ? "✅ Đã nhận /upload. Workflow đang chờ sẽ ghép final video 9:16, kiểm tra giỏ hàng và upload TikTok." : ($json.command === "remake" ? "✅ Đã nhận /remake. Workflow đang chờ sẽ tạo lại panel được chọn." : "✅ Đã nhận lệnh. Workflow đang chờ sẽ xử lý tiếp.") }}',
        additionalFields: {
          appendAttribution: false,
          parse_mode: 'HTML'
        }
      },
      type: 'n8n-nodes-base.telegram',
      typeVersion: 1.2,
      position: [1200, 250],
      id: 'node-tg-command-accepted',
      name: 'Telegram — Command Accepted',
      credentials: {
        telegramApi: {
          id: 'telegramAccount',
          name: 'Telegram account'
        }
      }
    },
    {
      parameters: {
        chatId: '={{ $json.chatId }}',
        text: '={{ $json.error || "⚠️ Lệnh không hợp lệ. Hãy gửi link TikTok Shop để tạo video hoặc /upload để đăng." }}',
        additionalFields: {
          appendAttribution: false,
          parse_mode: 'HTML'
        }
      },
      type: 'n8n-nodes-base.telegram',
      typeVersion: 1.2,
      position: [720, 600],
      id: 'node-tg-invalid-command',
      name: 'Telegram — Invalid Command',
      credentials: {
        telegramApi: {
          id: 'telegramAccount',
          name: 'Telegram account'
        }
      }
    },

    // ═══════════════════════════════════════════════════════════════
    // Group A: Intake Pipeline (Resolve -> PDP -> Extract -> Enqueue)
    // ═══════════════════════════════════════════════════════════════
    {
      parameters: {
        url: '={{ $json.shortlink }}',
        options: {
          redirect: {
            redirect: {
              followRedirects: true,
              maxRedirects: 5
            }
          },
          response: {
            response: {
              fullResponse: true,
              responseFormat: 'text'
            }
          }
        }
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [720, -100],
      id: 'node-http-resolve-pdp',
      name: 'Resolve TikTok Shortlink'
    },
    {
      parameters: {
        method: 'POST',
        url: `${SERVICE_HOST}/api/product-assets/extract`,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ html: $json.body || $json.data || $response.body, productUrl: $response?.url || $json.headers?.location || $json.shortlink }) }}',
        options: {}
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [960, -100],
      id: 'node-http-extract-assets',
      name: 'Extract Product Assets'
    },
    {
      parameters: {
        conditions: {
          options: {
            caseSensitive: true,
            leftValue: '',
            typeValidation: 'strict',
            version: 2
          },
          conditions: [
            {
              leftValue: '={{ $json.productId }}',
              rightValue: '',
              operator: {
                type: 'string',
                operation: 'notEquals'
              }
            },
            {
              leftValue: '={{ ($json.productImages || []).length }}',
              rightValue: 1,
              operator: {
                type: 'number',
                operation: 'gte'
              }
            }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [1200, -100],
      id: 'node-if-valid-assets',
      name: 'Validate Product Assets'
    },
    {
      parameters: {
        chatId: '={{ $(\'Parse Telegram Message\').item.json.chatId }}',
        text: '⚠️ Không thể lấy thông tin sản phẩm hoặc ảnh từ link TikTok Shop này. Vui lòng kiểm tra lại shortlink.',
        additionalFields: {
          appendAttribution: false,
          parse_mode: 'HTML'
        }
      },
      type: 'n8n-nodes-base.telegram',
      typeVersion: 1.2,
      position: [1440, -300],
      id: 'node-tg-invalid-assets',
      name: 'Telegram — Invalid Product Assets',
      credentials: {
        telegramApi: {
          id: 'telegramAccount',
          name: 'Telegram account'
        }
      }
    },
    {
      parameters: {
        method: 'POST',
        url: `${SERVICE_HOST}/api/jobs/enqueue`,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: `={{
JSON.stringify({
  chatId: $('Parse Telegram Message').item.json.chatId,
  sourceMessageId: $('Parse Telegram Message').item.json.messageId,
  shortlink: $('Parse Telegram Message').item.json.shortlink,
  productUrl: $('Resolve TikTok Shortlink').item.json.headers?.location || $('Parse Telegram Message').item.json.shortlink,
  template: $('Parse Telegram Message').item.json.template || 'template3',
  productId: $json.productId,
  productTitle: $json.title,
  productDescription: $json.productDescription,
  productImages: ($json.productImages || []).slice(0, 8)
})
}}`,
        options: {}
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1440, -100],
      id: 'node-http-enqueue-job',
      name: 'Enqueue Generation Job'
    },
    {
      parameters: {
        chatId: '={{ $(\'Parse Telegram Message\').item.json.chatId }}',
        text: '={{ "✅ Đã tiếp nhận sản phẩm [" + ($(\'Extract Product Assets\').item.json.title || "TikTok Shop") + "].\\nĐang khởi tạo pipeline tạo video... (Job: " + $json.jobId + ")" }}',
        additionalFields: {
          appendAttribution: false,
          parse_mode: 'HTML'
        }
      },
      type: 'n8n-nodes-base.telegram',
      typeVersion: 1.2,
      position: [1680, -100],
      id: 'node-tg-job-accepted',
      name: 'Telegram — Job Accepted',
      credentials: {
        telegramApi: {
          id: 'telegramAccount',
          name: 'Telegram account'
        }
      }
    },

    // ═══════════════════════════════════════════════════════════════
    // Group B: Generation Checkpoints (01 -> 07)
    // ═══════════════════════════════════════════════════════════════

    // Checkpoint 01: Product Assets Extracted
    {
      parameters: {
        url: `={{ "${SERVICE_HOST}/api/jobs/" + $('Enqueue Generation Job').item.json.jobId }}`,
        options: {}
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1920, -100],
      id: 'node-http-chk-01',
      name: '01 — Product Assets Extracted'
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { leftValue: '={{ $json.status }}', rightValue: 'failed', operator: { type: 'string', operation: 'equals' } }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [2140, -250],
      id: 'node-if-failed-01',
      name: 'Job Failed 01?'
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { leftValue: '={{ $json.stepOrder }}', rightValue: 1, operator: { type: 'number', operation: 'gte' } }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [2140, -100],
      id: 'node-if-step-01',
      name: 'Step 01 Reached?'
    },
    {
      parameters: {
        amount: 8,
        unit: 'seconds'
      },
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      position: [2140, 100],
      id: 'node-wait-01',
      name: 'Wait — Product Assets Extracted'
    },

    // Checkpoint 02: Product Analyzed
    {
      parameters: {
        url: `={{ "${SERVICE_HOST}/api/jobs/" + $('Enqueue Generation Job').item.json.jobId }}`,
        options: {}
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [2380, -100],
      id: 'node-http-chk-02',
      name: '02 — Product Analyzed'
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { leftValue: '={{ $json.status }}', rightValue: 'failed', operator: { type: 'string', operation: 'equals' } }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [2600, -250],
      id: 'node-if-failed-02',
      name: 'Job Failed 02?'
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { leftValue: '={{ $json.stepOrder }}', rightValue: 2, operator: { type: 'number', operation: 'gte' } }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [2600, -100],
      id: 'node-if-step-02',
      name: 'Step 02 Reached?'
    },
    {
      parameters: {
        amount: 10,
        unit: 'seconds'
      },
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      position: [2600, 100],
      id: 'node-wait-02',
      name: 'Wait — Product Analyzed'
    },

    // Checkpoint 03: Storyboard Generated
    {
      parameters: {
        url: `={{ "${SERVICE_HOST}/api/jobs/" + $('Enqueue Generation Job').item.json.jobId }}`,
        options: {}
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [2840, -100],
      id: 'node-http-chk-03',
      name: '03 — Storyboard Generated'
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { leftValue: '={{ $json.status }}', rightValue: 'failed', operator: { type: 'string', operation: 'equals' } }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [3060, -250],
      id: 'node-if-failed-03',
      name: 'Job Failed 03?'
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { leftValue: '={{ $json.stepOrder }}', rightValue: 3, operator: { type: 'number', operation: 'gte' } }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [3060, -100],
      id: 'node-if-step-03',
      name: 'Step 03 Reached?'
    },
    {
      parameters: {
        amount: 10,
        unit: 'seconds'
      },
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      position: [3060, 100],
      id: 'node-wait-03',
      name: 'Wait — Storyboard Generated'
    },

    // Checkpoint 04: Panels Generated
    {
      parameters: {
        url: `={{ "${SERVICE_HOST}/api/jobs/" + $('Enqueue Generation Job').item.json.jobId }}`,
        options: {}
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [3300, -100],
      id: 'node-http-chk-04',
      name: '04 — Panels Generated'
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { leftValue: '={{ $json.status }}', rightValue: 'failed', operator: { type: 'string', operation: 'equals' } }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [3520, -250],
      id: 'node-if-failed-04',
      name: 'Job Failed 04?'
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { leftValue: '={{ $json.stepOrder }}', rightValue: 4, operator: { type: 'number', operation: 'gte' } }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [3520, -100],
      id: 'node-if-step-04',
      name: 'Step 04 Reached?'
    },
    {
      parameters: {
        amount: 10,
        unit: 'seconds'
      },
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      position: [3520, 100],
      id: 'node-wait-04',
      name: 'Wait — Panels Generated'
    },

    // Checkpoint 05: Videos Generated (waits for all 4 Veo 3 panel videos)
    {
      parameters: {
        url: `={{ "${SERVICE_HOST}/api/jobs/" + $('Enqueue Generation Job').item.json.jobId }}`,
        options: {}
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [3760, -100],
      id: 'node-http-chk-05',
      name: '05 — Videos Generated'
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { leftValue: '={{ $json.status }}', rightValue: 'failed', operator: { type: 'string', operation: 'equals' } }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [3980, -250],
      id: 'node-if-failed-05',
      name: 'Job Failed 05?'
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { leftValue: '={{ $json.stepOrder }}', rightValue: 6, operator: { type: 'number', operation: 'gte' } }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [3980, -100],
      id: 'node-if-step-05',
      name: 'Step 05 Reached?'
    },
    {
      parameters: {
        amount: 10,
        unit: 'seconds'
      },
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      position: [3980, 100],
      id: 'node-wait-05',
      name: 'Wait — Videos Generated'
    },

    // Result node
    {
      parameters: {
        url: `={{ "${SERVICE_HOST}/api/jobs/" + $('Enqueue Generation Job').item.json.jobId + "/result" }}`,
        options: {}
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [4220, -100],
      id: 'node-http-get-result',
      name: 'Get Generation Result'
    },
    {
      parameters: {
        chatId: '={{ $(\'Parse Telegram Message\').item.json.chatId }}',
        text: '={{ "🎬 Đã tạo xong các video panel và gửi về chat để bạn kiểm tra.\\n\\n📌 Tên sản phẩm: " + ($json.product?.title || $json.analysis?.productName || $json.productName || "TikTok Shop") + "\\n💬 Caption: " + ($json.caption || "") + "\\n\\n👉 Nhấn lệnh để làm lại từng cảnh nếu cần:\\n  • Cảnh 1: /remake_1\\n  • Cảnh 2: /remake_2\\n  • Cảnh 3: /remake_3\\n  • Cảnh 4: /remake_4\\n\\n👉 Gõ /upload để ghép final video 9:16, xác minh giỏ hàng và đăng lên TikTok." }}',
        additionalFields: {
          appendAttribution: false,
          parse_mode: 'HTML'
        }
      },
      type: 'n8n-nodes-base.telegram',
      typeVersion: 1.2,
      position: [4460, -100],
      id: 'node-tg-gen-completed',
      name: 'Telegram — Generation Completed',
      credentials: {
        telegramApi: {
          id: 'telegramAccount',
          name: 'Telegram account'
        }
      }
    },

    // ═══════════════════════════════════════════════════════════════
    // Interactive Command Loop: Wait for /upload, /remake, /template
    // ═══════════════════════════════════════════════════════════════
    {
      parameters: {
        url: `={{ "${SERVICE_HOST}/api/jobs/" + $('Enqueue Generation Job').item.json.jobId + "/wait-command?timeout=10" }}`,
        options: {}
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [5620, -100],
      id: 'node-http-wait-command',
      name: 'Wait For User Command'
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { leftValue: '={{ $json.command }}', rightValue: 'wait', operator: { type: 'string', operation: 'notEquals' } }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [5860, -100],
      id: 'node-if-command-received',
      name: 'Is Command Received?'
    },
    {
      parameters: {
        amount: 5,
        unit: 'seconds'
      },
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      position: [5860, 100],
      id: 'node-wait-for-cmd',
      name: 'Wait 5s Before Checking Command'
    },
    {
      parameters: {
        rules: {
          values: [
            {
              conditions: {
                options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
                conditions: [
                  { leftValue: '={{ $json.command }}', rightValue: 'upload', operator: { type: 'string', operation: 'equals' } }
                ],
                combinator: 'and'
              }
            },
            {
              conditions: {
                options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
                conditions: [
                  { leftValue: '={{ $json.command }}', rightValue: 'remake', operator: { type: 'string', operation: 'equals' } }
                ],
                combinator: 'and'
              }
            },
            {
              conditions: {
                options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
                conditions: [
                  { leftValue: '={{ $json.command }}', rightValue: 'template', operator: { type: 'string', operation: 'equals' } }
                ],
                combinator: 'and'
              }
            }
          ]
        }
      },
      type: 'n8n-nodes-base.switch',
      typeVersion: 3.2,
      position: [6100, -100],
      id: 'node-switch-user-cmd',
      name: 'Route User Command'
    },
    {
      parameters: {
        method: 'POST',
        url: `={{ "${SERVICE_HOST}/api/jobs/" + $('Enqueue Generation Job').item.json.jobId + "/remake" }}`,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ panels: $json.panels || [], instruction: $json.instruction || "" }) }}',
        options: {}
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [6380, 100],
      id: 'node-http-remake-panels',
      name: 'Execute Remake Panels'
    },
    {
      parameters: {
        chatId: '={{ $(\'Parse Telegram Message\').item.json.chatId }}',
        text: '={{ "🎬 Đã hoàn thành remake cảnh " + ($json.remadePanels || []).join(", ") + "!\\n\\n👉 Nhấn để tạo lại tiếp nếu cần: " + ($json.remadePanels || [1]).map(p => "/remake_" + p).join(" ") + "\\n👉 Gõ /upload để ghép final video 9:16 và đăng TikTok." }}',
        additionalFields: {
          appendAttribution: false,
          parse_mode: 'HTML'
        }
      },
      type: 'n8n-nodes-base.telegram',
      typeVersion: 1.2,
      position: [6620, 100],
      id: 'node-tg-remake-completed',
      name: 'Telegram — Remake Completed',
      credentials: {
        telegramApi: {
          id: 'telegramAccount',
          name: 'Telegram account'
        }
      }
    },
    {
      parameters: {
        method: 'POST',
        url: `={{ "${SERVICE_HOST}/api/jobs/" + $('Enqueue Generation Job').item.json.jobId + "/change-template" }}`,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ template: $json.template }) }}',
        options: {}
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [6380, 300],
      id: 'node-http-change-template',
      name: 'Execute Change Template'
    },

    // Common Error Notification
    {
      parameters: {
        chatId: '={{ $(\'Parse Telegram Message\').item.json.chatId }}',
        text: '={{ "⚠️ Pipeline thất bại tại bước [" + ($json.error?.failedStep || $json.currentStep || "unknown") + "]:\\n" + ($json.error?.message || $json.message || "Lỗi không xác định") }}',
        additionalFields: {
          appendAttribution: false,
          parse_mode: 'HTML'
        }
      },
      type: 'n8n-nodes-base.telegram',
      typeVersion: 1.2,
      position: [3520, -450],
      id: 'node-tg-job-failed',
      name: 'Telegram — Job Failed',
      credentials: {
        telegramApi: {
          id: 'telegramAccount',
          name: 'Telegram account'
        }
      }
    },

    // ═══════════════════════════════════════════════════════════════
    // Group C & D & E: Upload Pipeline (/upload)
    // ═══════════════════════════════════════════════════════════════
    {
      parameters: {
        url: `={{
$json.targetJobId
  ? ("${SERVICE_HOST}/api/jobs/" + $json.targetJobId)
  : ($('Parse Telegram Message').item.json.targetJobId
      ? ("${SERVICE_HOST}/api/jobs/" + $('Parse Telegram Message').item.json.targetJobId)
      : ("${SERVICE_HOST}/api/jobs/latest?chatId=" + $('Parse Telegram Message').item.json.chatId))
}}`,
        options: {}
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [720, 400],
      id: 'node-http-find-completed-job',
      name: 'Find Completed Job For Chat'
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { leftValue: '={{ $json.jobId }}', rightValue: '', operator: { type: 'string', operation: 'notEquals' } },
            { leftValue: '={{ $json.status }}', rightValue: 'completed', operator: { type: 'string', operation: 'equals' } }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [960, 400],
      id: 'node-if-valid-job-found',
      name: 'Validate Job Found'
    },
    {
      parameters: {
        chatId: '={{ $(\'Parse Telegram Message\').item.json.chatId }}',
        text: '⚠️ Không tìm thấy video đã hoàn tất gần đây của bạn. Vui lòng gửi shortlink TikTok Shop để tạo video trước.',
        additionalFields: {
          appendAttribution: false,
          parse_mode: 'HTML'
        }
      },
      type: 'n8n-nodes-base.telegram',
      typeVersion: 1.2,
      position: [1200, 550],
      id: 'node-tg-no-job',
      name: 'Telegram — No Completed Job',
      credentials: {
        telegramApi: {
          id: 'telegramAccount',
          name: 'Telegram account'
        }
      }
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { leftValue: '={{ $json.upload?.status }}', rightValue: 'published', operator: { type: 'string', operation: 'equals' } }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [1200, 350],
      id: 'node-if-idempotency',
      name: 'Check Upload Idempotency'
    },
    {
      parameters: {
        chatId: '={{ $(\'Parse Telegram Message\').item.json.chatId }}',
        text: '={{ "ℹ️ Video này đã được đăng thành công trước đó (Publish ID: " + ($json.upload?.publishId || "OK") + "). Bỏ qua để tránh đăng trùng." }}',
        additionalFields: {
          appendAttribution: false,
          parse_mode: 'HTML'
        }
      },
      type: 'n8n-nodes-base.telegram',
      typeVersion: 1.2,
      position: [1440, 500],
      id: 'node-tg-already-published',
      name: 'Telegram — Already Published',
      credentials: {
        telegramApi: {
          id: 'telegramAccount',
          name: 'Telegram account'
        }
      }
    },
    {
      parameters: {
        resource: 'product'
      },
      type: 'n8n-nodes-social-tiktok.tiktokAll',
      typeVersion: 1,
      position: [1440, 250],
      id: 'node-tiktok-get-affiliate',
      name: 'Get Link Affiliate',
      credentials: {
        tiktokApi: {
          id: 'cJDNuW2i1tFFXivi',
          name: 'TikTok Credential account'
        }
      }
    },
    {
      parameters: {
        jsCode: `
const job = $('Validate Job Found').item.json;
const affiliateData = $input.item.json;
const products = Array.isArray(affiliateData.products) ? affiliateData.products : (Array.isArray(affiliateData) ? affiliateData : []);
const matched = products.find(p => String(p.product_id) === String(job.product?.productId));

return {
  json: {
    jobId: job.jobId,
    chatId: job.chatId,
    productId: job.product?.productId,
    productTitle: matched ? (matched.title || job.product?.title) : (job.product?.title || 'Sản phẩm TikTok Shop'),
    caption: job.caption || job.product?.title || 'Review sản phẩm #review #tiktokshop',
    canAttachCart: Boolean(matched),
    matchedProduct: matched || null
  }
};
`
      },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1680, 250],
      id: 'node-code-match-product',
      name: 'Find Product By product_id'
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { leftValue: '={{ $json.canAttachCart }}', rightValue: true, operator: { type: 'boolean', operation: 'equals' } }
          ],
          combinator: 'and'
        }
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [1920, 250],
      id: 'node-if-can-attach',
      name: 'Product Can Attach Cart?'
    },
    {
      parameters: {
        chatId: '={{ $json.chatId }}',
        text: '={{ "⚠️ Sản phẩm (ID: " + $json.productId + " - " + $json.productTitle + ") không nằm trong danh sách affiliate/showcase của tài khoản TikTok. Dừng upload để tránh mất liên kết giỏ hàng." }}',
        additionalFields: {
          appendAttribution: false,
          parse_mode: 'HTML'
        }
      },
      type: 'n8n-nodes-base.telegram',
      typeVersion: 1.2,
      position: [2160, 400],
      id: 'node-tg-cannot-attach',
      name: 'Telegram — Product Cannot Attach Cart',
      credentials: {
        telegramApi: {
          id: 'telegramAccount',
          name: 'Telegram account'
        }
      }
    },
    {
      parameters: {
        method: 'POST',
        url: `={{ "${SERVICE_HOST}/api/jobs/" + $json.jobId + "/prepare-upload" }}`,
        options: {}
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [2160, 200],
      id: 'node-http-prepare-upload',
      name: 'Prepare Final Video For Upload'
    },
    {
      parameters: {
        url: `={{ "${SERVICE_HOST}/api/jobs/" + $json.jobId + "/final-video" }}`,
        options: {
          response: {
            response: {
              responseFormat: 'file'
            }
          }
        }
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [2400, 200],
      id: 'node-http-download-final-video',
      name: 'Download Final Generated Video'
    },
    {
      parameters: {
        postSettings: {
          text: '={{ $(\'Find Product By product_id\').item.json.caption }}',
          visibilityType: 0,
          allowComment: 1,
          scheduleTime: '=0',
          anchors: {
            anchor: [
              {
                type: 'product',
                productId: '={{ $(\'Find Product By product_id\').item.json.productId }}',
                displayName: '={{ $(\'Find Product By product_id\').item.json.productTitle }}'
              }
            ]
          }
        }
      },
      type: 'n8n-nodes-social-tiktok.tikTokUpload',
      typeVersion: 1,
      position: [2640, 200],
      id: 'node-tiktok-upload',
      name: 'TikTok Upload With Product',
      credentials: {
        tiktokApi: {
          id: 'cJDNuW2i1tFFXivi',
          name: 'TikTok Credential account'
        }
      }
    },
    {
      parameters: {
        method: 'POST',
        url: `={{ "${SERVICE_HOST}/api/jobs/" + $('Find Product By product_id').item.json.jobId + "/upload-state" }}`,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ status: "published", publishId: $json.publish_id || $json.id || "published" }) }}',
        options: {}
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [2880, 200],
      id: 'node-http-save-publish-state',
      name: 'Save Publish Result'
    },
    {
      parameters: {
        method: 'DELETE',
        url: `={{ "${SERVICE_HOST}/api/jobs/" + $('Find Product By product_id').item.json.jobId }}`,
        options: {}
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [3120, 200],
      id: 'node-http-cleanup-job',
      name: 'Cleanup Generation Job'
    },
    {
      parameters: {
        chatId: '={{ $(\'Find Product By product_id\').item.json.chatId }}',
        text: '={{ "🎉 Video đã upload thành công lên TikTok!\\n\\n🛒 Sản phẩm gắn giỏ: " + $(\'Find Product By product_id\').item.json.productTitle + "\\n🆔 Publish ID: " + ($(\'TikTok Upload With Product\').item.json.publish_id || "OK") }}',
        additionalFields: {
          appendAttribution: false,
          parse_mode: 'HTML'
        }
      },
      type: 'n8n-nodes-base.telegram',
      typeVersion: 1.2,
      position: [3360, 200],
      id: 'node-tg-upload-completed',
      name: 'Telegram — Upload Completed',
      credentials: {
        telegramApi: {
          id: 'telegramAccount',
          name: 'Telegram account'
        }
      }
    }
  ];

  const connections = {
    'Webhook — Telegram Event': {
      main: [
        [{ node: 'Parse Telegram Message', type: 'main', index: 0 }]
      ]
    },
    'Parse Telegram Message': {
      main: [
        [{ node: 'Is Generation Request?', type: 'main', index: 0 }]
      ]
    },
    'Is Generation Request?': {
      main: [
        // True: Generation pipeline
        [{ node: 'Resolve TikTok Shortlink', type: 'main', index: 0 }],
        // False: Check interactive command request
        [{ node: 'Is Control Command?', type: 'main', index: 0 }]
      ]
    },
    'Is Control Command?': {
      main: [
        // True: signal the long-running generation execution
        [{ node: 'Signal User Command', type: 'main', index: 0 }],
        // False: Invalid command
        [{ node: 'Telegram — Invalid Command', type: 'main', index: 0 }]
      ]
    },
    'Signal User Command': {
      main: [
        [{ node: 'Is Execution Waiting?', type: 'main', index: 0 }]
      ]
    },
    'Is Execution Waiting?': {
      main: [
        [{ node: 'Telegram — Command Accepted', type: 'main', index: 0 }],
        [{ node: 'Is Direct Upload?', type: 'main', index: 0 }]
      ]
    },
    'Is Direct Upload?': {
      main: [
        [{ node: 'Find Completed Job For Chat', type: 'main', index: 0 }],
        [{ node: 'Telegram — Command Accepted', type: 'main', index: 0 }]
      ]
    },

    // Generation intake
    'Resolve TikTok Shortlink': {
      main: [
        [{ node: 'Extract Product Assets', type: 'main', index: 0 }]
      ]
    },
    'Extract Product Assets': {
      main: [
        [{ node: 'Validate Product Assets', type: 'main', index: 0 }]
      ]
    },
    'Validate Product Assets': {
      main: [
        // True: Enqueue
        [{ node: 'Enqueue Generation Job', type: 'main', index: 0 }],
        // False: Error
        [{ node: 'Telegram — Invalid Product Assets', type: 'main', index: 0 }]
      ]
    },
    'Enqueue Generation Job': {
      main: [
        [{ node: 'Telegram — Job Accepted', type: 'main', index: 0 }]
      ]
    },
    'Telegram — Job Accepted': {
      main: [
        [{ node: '01 — Product Assets Extracted', type: 'main', index: 0 }]
      ]
    },

    // Checkpoint 01
    '01 — Product Assets Extracted': {
      main: [
        [{ node: 'Job Failed 01?', type: 'main', index: 0 }]
      ]
    },
    'Job Failed 01?': {
      main: [
        // True: failed
        [{ node: 'Telegram — Job Failed', type: 'main', index: 0 }],
        // False: check step reached
        [{ node: 'Step 01 Reached?', type: 'main', index: 0 }]
      ]
    },
    'Step 01 Reached?': {
      main: [
        // True: next checkpoint
        [{ node: '02 — Product Analyzed', type: 'main', index: 0 }],
        // False: wait and retry
        [{ node: 'Wait — Product Assets Extracted', type: 'main', index: 0 }]
      ]
    },
    'Wait — Product Assets Extracted': {
      main: [
        [{ node: '01 — Product Assets Extracted', type: 'main', index: 0 }]
      ]
    },

    // Checkpoint 02
    '02 — Product Analyzed': {
      main: [
        [{ node: 'Job Failed 02?', type: 'main', index: 0 }]
      ]
    },
    'Job Failed 02?': {
      main: [
        [{ node: 'Telegram — Job Failed', type: 'main', index: 0 }],
        [{ node: 'Step 02 Reached?', type: 'main', index: 0 }]
      ]
    },
    'Step 02 Reached?': {
      main: [
        [{ node: '03 — Storyboard Generated', type: 'main', index: 0 }],
        [{ node: 'Wait — Product Analyzed', type: 'main', index: 0 }]
      ]
    },
    'Wait — Product Analyzed': {
      main: [
        [{ node: '02 — Product Analyzed', type: 'main', index: 0 }]
      ]
    },

    // Checkpoint 03
    '03 — Storyboard Generated': {
      main: [
        [{ node: 'Job Failed 03?', type: 'main', index: 0 }]
      ]
    },
    'Job Failed 03?': {
      main: [
        [{ node: 'Telegram — Job Failed', type: 'main', index: 0 }],
        [{ node: 'Step 03 Reached?', type: 'main', index: 0 }]
      ]
    },
    'Step 03 Reached?': {
      main: [
        [{ node: '04 — Panels Generated', type: 'main', index: 0 }],
        [{ node: 'Wait — Storyboard Generated', type: 'main', index: 0 }]
      ]
    },
    'Wait — Storyboard Generated': {
      main: [
        [{ node: '03 — Storyboard Generated', type: 'main', index: 0 }]
      ]
    },

    // Checkpoint 04
    '04 — Panels Generated': {
      main: [
        [{ node: 'Job Failed 04?', type: 'main', index: 0 }]
      ]
    },
    'Job Failed 04?': {
      main: [
        [{ node: 'Telegram — Job Failed', type: 'main', index: 0 }],
        [{ node: 'Step 04 Reached?', type: 'main', index: 0 }]
      ]
    },
    'Step 04 Reached?': {
      main: [
        [{ node: '05 — Videos Generated', type: 'main', index: 0 }],
        [{ node: 'Wait — Panels Generated', type: 'main', index: 0 }]
      ]
    },
    'Wait — Panels Generated': {
      main: [
        [{ node: '04 — Panels Generated', type: 'main', index: 0 }]
      ]
    },

    // Checkpoint 05
    '05 — Videos Generated': {
      main: [
        [{ node: 'Job Failed 05?', type: 'main', index: 0 }]
      ]
    },
    'Job Failed 05?': {
      main: [
        [{ node: 'Telegram — Job Failed', type: 'main', index: 0 }],
        [{ node: 'Step 05 Reached?', type: 'main', index: 0 }]
      ]
    },
    'Step 05 Reached?': {
      main: [
        [{ node: 'Get Generation Result', type: 'main', index: 0 }],
        [{ node: 'Wait — Videos Generated', type: 'main', index: 0 }]
      ]
    },
    'Wait — Videos Generated': {
      main: [
        [{ node: '05 — Videos Generated', type: 'main', index: 0 }]
      ]
    },
    'Get Generation Result': {
      main: [
        [{ node: 'Telegram — Generation Completed', type: 'main', index: 0 }]
      ]
    },
    'Telegram — Generation Completed': {
      main: [
        [{ node: 'Wait For User Command', type: 'main', index: 0 }]
      ]
    },
    'Wait For User Command': {
      main: [
        [{ node: 'Is Command Received?', type: 'main', index: 0 }]
      ]
    },
    'Is Command Received?': {
      main: [
        [{ node: 'Route User Command', type: 'main', index: 0 }],
        [{ node: 'Wait 5s Before Checking Command', type: 'main', index: 0 }]
      ]
    },
    'Wait 5s Before Checking Command': {
      main: [
        [{ node: 'Wait For User Command', type: 'main', index: 0 }]
      ]
    },
    'Route User Command': {
      main: [
        [{ node: 'Find Completed Job For Chat', type: 'main', index: 0 }],
        [{ node: 'Execute Remake Panels', type: 'main', index: 0 }],
        [{ node: 'Execute Change Template', type: 'main', index: 0 }]
      ]
    },
    'Execute Remake Panels': {
      main: [
        [{ node: 'Telegram — Remake Completed', type: 'main', index: 0 }]
      ]
    },
    'Telegram — Remake Completed': {
      main: [
        [{ node: 'Wait For User Command', type: 'main', index: 0 }]
      ]
    },
    'Execute Change Template': {
      main: [
        [{ node: '02 — Product Analyzed', type: 'main', index: 0 }]
      ]
    },

    // Upload Flow
    'Find Completed Job For Chat': {
      main: [
        [{ node: 'Validate Job Found', type: 'main', index: 0 }]
      ]
    },
    'Validate Job Found': {
      main: [
        [{ node: 'Check Upload Idempotency', type: 'main', index: 0 }],
        [{ node: 'Telegram — No Completed Job', type: 'main', index: 0 }]
      ]
    },
    'Check Upload Idempotency': {
      main: [
        [{ node: 'Telegram — Already Published', type: 'main', index: 0 }],
        [{ node: 'Get Link Affiliate', type: 'main', index: 0 }]
      ]
    },
    'Get Link Affiliate': {
      main: [
        [{ node: 'Find Product By product_id', type: 'main', index: 0 }]
      ]
    },
    'Find Product By product_id': {
      main: [
        [{ node: 'Product Can Attach Cart?', type: 'main', index: 0 }]
      ]
    },
    'Product Can Attach Cart?': {
      main: [
        [{ node: 'Prepare Final Video For Upload', type: 'main', index: 0 }],
        [{ node: 'Telegram — Product Cannot Attach Cart', type: 'main', index: 0 }]
      ]
    },
    'Prepare Final Video For Upload': {
      main: [
        [{ node: 'Download Final Generated Video', type: 'main', index: 0 }]
      ]
    },
    'Download Final Generated Video': {
      main: [
        [{ node: 'TikTok Upload With Product', type: 'main', index: 0 }]
      ]
    },
    'TikTok Upload With Product': {
      main: [
        [{ node: 'Save Publish Result', type: 'main', index: 0 }]
      ]
    },
    'Save Publish Result': {
      main: [
        [{ node: 'Cleanup Generation Job', type: 'main', index: 0 }]
      ]
    },
    'Cleanup Generation Job': {
      main: [
        [{ node: 'Telegram — Upload Completed', type: 'main', index: 0 }]
      ]
    }
  };

  return {
    id: 'Ee08wOLENOWeHplf',
    name: 'TELEGRAM GEN VIDEO + AUTO UPLOAD TIKTOK',
    nodes,
    connections,
    pinData: {},
    active: false,
    settings: {
      executionOrder: 'v1',
      binaryMode: 'separate'
    },
    versionId: '10000000-0000-0000-0000-000000000003',
    meta: {
      templateCredsSetupCompleted: true,
      instanceId: 'dea97fbe9bb9b26f154b560d4e59b92e5847b07b97005bbe5e516f9705157079'
    },
    nodeGroups: [],
    tags: []
  };
}

const targetPath = path.resolve(__dirname, '..', 'workflows', 'TELEGRAM GEN VIDEO + AUTO UPLOAD TIKTOK.json');
const wf = createWorkflow();
fs.writeFileSync(targetPath, JSON.stringify(wf, null, 2), 'utf8');
console.log(`✅ Generated workflow at ${targetPath} (${wf.nodes.length} nodes)`);
