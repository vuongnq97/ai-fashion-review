import { workflow, node, links } from '@n8n-as-code/transformer';

// <workflow-map>
// Workflow : ReviewAI
// Nodes   : 15  |  Connections: 11
//
// NODE INDEX
// ──────────────────────────────────────────────────────────────────
// Property name                    Node type (short)         Flags
// TelegramTrigger                    telegramTrigger            [creds]
// CheckMessageType                   code
// IsPhotoMessage                     if
// PreparePhotoForGeneration          code
// AckPhoto                           telegram                   [creds]
// RetrieveStoredPhoto                code
// GetPhotoFile                       telegram                   [creds]
// ConvertToBase64                    code
// BuildStoryboardPrompt              code
// GenerateStoryboard                 httpRequest
// GenerateAllPanels                  code
// GenerateAllVideos                  code
// ResizeVideo                        httpRequest
// PrepareResizedVideo                code
// SendVideoToTelegram                telegram                   [creds]
//
// ROUTING MAP
// ──────────────────────────────────────────────────────────────────
// TelegramTrigger
//    → CheckMessageType
//      → IsPhotoMessage
//        → PreparePhotoForGeneration
//          → GetPhotoFile
//            → ConvertToBase64
//              → BuildStoryboardPrompt
//                → GenerateStoryboard
//                  → GenerateAllVideos
//                    → ResizeVideo
//                      → PrepareResizedVideo
//                        → SendVideoToTelegram
// </workflow-map>

// =====================================================================
// METADATA DU WORKFLOW
// =====================================================================

@workflow({
    id: 'dNCki6C703CUsRUH',
    name: 'ReviewAI',
    active: true,
    isArchived: false,
    settings: { executionOrder: 'v1' },
})
export class ReviewaiWorkflow {
    // =====================================================================
    // CONFIGURATION DES NOEUDS
    // =====================================================================

    @node({
        id: '1520a91e-305b-4645-8eca-3403da408c12',
        webhookId: '87b40377-7bf2-4f7d-ae02-366ff60fcfb4',
        name: 'Telegram Trigger',
        type: 'n8n-nodes-base.telegramTrigger',
        version: 1.2,
        position: [0, 304],
        credentials: { telegramApi: { id: 'bDHVW2MV7u967Djo', name: 'Telegram Bot B' } },
    })
    TelegramTrigger = {
        updates: ['message'],
        additionalFields: {},
    };

    @node({
        id: '8bf78fb9-3c76-4dd6-bfce-ab23956f7fb0',
        name: 'Check Message Type',
        type: 'n8n-nodes-base.code',
        version: 2,
        position: [220, 304],
    })
    CheckMessageType = {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: `
const message = $input.first().json.message;
const chatId = message.chat.id;
const hasPhoto = message.photo && message.photo.length > 0;

const text = message.caption || message.text || '';
const hasJson = /\\[[\\s\\S]*\\]/.test(text);

let frameData = [];
if (hasJson) {
  try {
    const match = text.match(/\\[[\\s\\S]*\\]/);
    frameData = JSON.parse(match[0]);
  } catch(e) {}
}

// Extract photo file_id (highest resolution)
let photoFileId = null;
if (hasPhoto) {
  photoFileId = message.photo.slice(-1)[0].file_id;
}

return [{
  json: {
    chatId,
    hasPhoto,
    hasJson,
    frameData,
    message,
    photoFileId
  }
}];
`,
    };

    @node({
        id: '5b3f6bfb-703a-437c-b7a9-1dae6740f443',
        name: 'Is Photo Message',
        type: 'n8n-nodes-base.if',
        version: 2.2,
        position: [440, 304],
    })
    IsPhotoMessage = {
        conditions: {
            options: {
                caseSensitive: true,
                leftValue: '',
                typeValidation: 'strict',
            },
            conditions: [
                {
                    leftValue: '={{ $json.hasPhoto }}',
                    rightValue: true,
                    operator: {
                        type: 'boolean',
                        operation: 'equals',
                    },
                },
            ],
            combinator: 'and',
        },
        options: {},
    };

    @node({
        id: 'b7a5f90d-d124-4e94-aee6-bff94d0184b2',
        name: 'Prepare Photo For Generation',
        type: 'n8n-nodes-base.code',
        version: 2,
        position: [660, 180],
    })
    PreparePhotoForGeneration = {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: `
const item = $input.first().json;
const chatId = item.chatId;
const photoFileId = item.photoFileId;

if (!photoFileId) {
  throw new Error('No photo file ID found');
}

// Send status notification
try {
  const creds = await this.getCredentials('telegramApi');
  await this.helpers.httpRequest({
    method: 'POST',
    url: 'https://api.telegram.org/bot' + creds.accessToken + '/sendMessage',
    body: { chat_id: chatId, text: '📸 Đã nhận ảnh sản phẩm!\\n⏳ Đang bắt đầu tạo storyboard & video...\\n\\nQuá trình này có thể mất 5-15 phút.' },
    headers: { 'Content-Type': 'application/json' },
  });
} catch(e) { console.log('Notify error:', e.message); }

return [{
  json: {
    chatId,
    photoFileId,
    frameData: item.frameData || [],
  }
}];
`,
    };

    @node({
        id: 'f6303e31-6621-4291-a20a-16d0a135cd83',
        webhookId: 'd1322c43-83e1-4c26-8d6b-8d826db5f4e8',
        name: 'Ack Photo',
        type: 'n8n-nodes-base.telegram',
        version: 1.2,
        position: [880, 180],
        credentials: { telegramApi: { id: 'bDHVW2MV7u967Djo', name: 'Telegram Bot B' } },
    })
    AckPhoto = {
        operation: 'sendMessage',
        chatId: '={{ $json.chatId }}',
        text: '✅ Đã nhận ảnh sản phẩm! Workflow đang bắt đầu tạo storyboard và video.',
        additionalFields: {
            appendAttribution: false,
        },
    };

    @node({
        id: '598c467a-1381-4cdb-b8b7-f471cb14e619',
        name: 'Retrieve Stored Photo',
        type: 'n8n-nodes-base.code',
        version: 2,
        position: [660, 440],
    })
    RetrieveStoredPhoto = {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: `
const item = $input.first().json;
const chatId = item.chatId;
const frameData = item.frameData;

// Retrieve stored photo from static data
const staticData = $getWorkflowStaticData('global');
const stored = staticData[String(chatId)];

if (!stored || !stored.photoFileId) {
  throw new Error('⚠️ Chưa có ảnh sản phẩm! Vui lòng gửi ảnh sản phẩm trước, sau đó gửi script JSON.');
}

// Clean up stored photo
delete staticData[String(chatId)];

return [{ json: { chatId, photoFileId: stored.photoFileId, frameData } }];
`,
    };

    @node({
        id: 'e2bb0357-efe2-4c93-b9c6-6da6e1f0ebd8',
        webhookId: '46495936-5dd0-4806-a497-4dfecdd66ae2',
        name: 'Get Photo File',
        type: 'n8n-nodes-base.telegram',
        version: 1.2,
        position: [880, 440],
        credentials: { telegramApi: { id: 'bDHVW2MV7u967Djo', name: 'Telegram Bot B' } },
    })
    GetPhotoFile = {
        resource: 'file',
        fileId: '={{ $json.photoFileId }}',
        additionalFields: {},
    };

    @node({
        id: 'de5317d9-9c39-4627-9b3f-629c3455cc7d',
        name: 'Convert To Base64',
        type: 'n8n-nodes-base.code',
        version: 2,
        position: [1100, 440],
    })
    ConvertToBase64 = {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: `
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const item = items[i];
  if (item.binary && item.binary.data) {
    const buffer = await this.helpers.getBinaryDataBuffer(i, 'data');
    item.json.imageBase64 = buffer.toString('base64');
  }
}
return items;
`,
    };

    @node({
        id: '2bc41fe1-9f5d-43b4-a329-843b12e2f641',
        name: 'Build Storyboard Prompt',
        type: 'n8n-nodes-base.code',
        version: 2,
        position: [1320, 440],
    })
    BuildStoryboardPrompt = {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: `
const item = $input.first().json;
const imageBase64 = item.imageBase64;
// GetPhotoFile replaces JSON, so get chatId from a node that definitely has it
const chatId = $('Prepare Photo For Generation').first().json.chatId;
const frameData = item.frameData || $('Prepare Photo For Generation').first().json.frameData || [];

return [{ json: { imageBase64, chatId, frameData } }];
`,
    };

    @node({
        id: '7552ea96-f9d4-458d-911f-10ef2a189404',
        name: 'Generate Storyboard',
        type: 'n8n-nodes-base.httpRequest',
        version: 4.4,
        position: [1540, 440],
    })
    GenerateStoryboard = {
        method: 'POST',
        url: 'http://host.docker.internal:3000/api/generate-storyboard',
        sendBody: true,
        contentType: 'raw',
        rawContentType: 'application/json',
        body: `={{ JSON.stringify({
  base64Images: [ $json.imageBase64 ],
  fileNames: ['product_image.png'],
  batchKey: String($json.chatId),
  aspectRatio: '9:16',
  includeVideoBase64: true,
  generateVideos: true
}) }}`,
        options: {
            timeout: 1800000,
        },
    };

    @node({
        id: 'b2f29088-fc92-43c8-950f-9c44e52a5977',
        name: 'Generate All Panels',
        type: 'n8n-nodes-base.code',
        version: 2,
        position: [2000, 440],
    })
    GenerateAllPanels = {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: `
const storyboardBase64 = $input.first().json.image.base64;
const chatId = $('Build Storyboard Prompt').first().json.chatId;

const basePrompt = (panelName) => \`Hãy sử dụng hình ảnh bảng phân cảnh đính kèm làm nguồn thông tin duy nhất.

Nhiệm vụ:
Chỉ trích xuất khung hình có tiêu đề "\${panelName}" thành một hình ảnh độc lập mới.

Các quy tắc nghiêm ngặt:
1. Giữ nguyên khung hình đã cắt ban đầu CHÍNH XÁC như trong bảng phân cảnh.
2. Giữ nguyên tất cả các pixel ban đầu bên trong vùng được trích xuất.
3. Duy trì chính xác hình dạng giày, vị trí tay, phối cảnh, góc độ, ánh sáng, bóng, kết cấu, đường khâu, kiểu lưới, chi tiết đế, vị trí logo, văn bản và màu sắc.
4. KHÔNG được tạo lại, vẽ lại, thiết kế lại, cải thiện, cách điệu, diễn giải lại hoặc thay đổi giày hoặc bàn tay.
5. KHÔNG được sửa đổi tỷ lệ, thương hiệu, kết cấu vật liệu hoặc chi tiết sản phẩm.
6. KHÔNG được tạo ra các tính năng sản phẩm mới.
7. KHÔNG được thay thế giày bằng một phiên bản tương tự.

Chỉ được phép thực hiện:
- Mở rộng khung vẽ ra ngoài ranh giới khung hình ban đầu (chỉ vẽ tràn).
- Chỉ tạo nội dung mới trong khu vực bên ngoài được mở rộng.
- Mở rộng nền tự nhiên một cách nhất quán dựa trên ngữ cảnh của hình ảnh gốc.
- Xóa tiêu đề góc trái trên của panel.

Yêu cầu đầu ra:
- Hình ảnh được trích xuất ban đầu phải giữ nguyên hình ảnh gốc (chính xác đến từng pixel).
- Kết quả phải trông giống như hình ảnh gốc được mở rộng ra một khung cảnh rộng hơn mà không bị cắt xén.
- Giữ chất lượng ảnh chụp sản phẩm chân thực.
- Độ phân giải cao, chi tiết sắc nét, ảnh sản phẩm rõ nét.

Quan trọng:
Nếu xảy ra bất kỳ xung đột nào, hãy ưu tiên giữ nguyên hình ảnh được trích xuất ban đầu một cách chính xác hơn là tạo nội dung mới.\`;

const panels = ['Panel1', 'Panel2', 'Panel3', 'Panel4', 'Panel5'];

async function generatePanel(panelName, idx, payload) {
  const data = await this.helpers.httpRequest({
    method: 'POST',
    url: 'http://host.docker.internal:3000/api/generate',
    body: payload,
    headers: { 'Content-Type': 'application/json' },
    timeout: 600000,
  });

  if (!data.success) {
    throw new Error(panelName + ' failed: ' + JSON.stringify(data.error).substring(0, 200));
  }

  console.log('[Panels] ' + panelName + ' done!');

  return {
    json: {
      panelName,
      panelIndex: idx + 1,
      chatId,
      imageBase64: data.image.base64,
    },
    binary: {
      data: await this.helpers.prepareBinaryData(
        Buffer.from(data.image.base64, 'base64'),
        panelName.toLowerCase() + '.png',
        'image/png'
      )
    }
  };
}

// Step 1: Panel1 goes FIRST (uploads story_board image)
console.log('[Panels] Step 1: Generating Panel1 (with upload)...');
const panel1Result = await generatePanel('Panel1', 0, {
  prompt: basePrompt('Panel1'),
  base64Images: [storyboardBase64],
  fileNames: ['story_board.png'],
  imageSelection: ['name:story_board'],
  mode: 'text-to-image',
  imageModel: 'nano-banana-2',
  aspectRatio: '9:16',
  outputCount: 1
});

// Step 2: Panels 2-5 fire in parallel (story_board already uploaded)
console.log('[Panels] Step 2: Firing Panels 2-5 in parallel...');
const remaining = await Promise.all(
  ['Panel2', 'Panel3', 'Panel4', 'Panel5'].map((panelName, i) =>
    generatePanel(panelName, i + 1, {
      prompt: basePrompt(panelName),
      imageSelection: ['name:story_board'],
      mode: 'text-to-image',
      imageModel: 'nano-banana-2',
      aspectRatio: '9:16',
      outputCount: 1
    })
  )
);

const results = [panel1Result, ...remaining];
console.log('[Panels] All 5 panels generated!');
return results;
`,
    };

    @node({
        id: 'f57bc8d9-e058-4186-a233-8751389eb5d8',
        name: 'Generate All Videos',
        type: 'n8n-nodes-base.code',
        version: 2,
        position: [2260, 440],
    })
    GenerateAllVideos = {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: `
const response = $input.first().json;
const chatId = $('Prepare Photo For Generation').first().json.chatId;

// Helper to send Telegram notification
async function notify(text) {
  try {
    const creds = await this.getCredentials('telegramApi');
    await this.helpers.httpRequest({
      method: 'POST',
      url: 'https://api.telegram.org/bot' + creds.accessToken + '/sendMessage',
      body: { chat_id: chatId, text },
      headers: { 'Content-Type': 'application/json' },
    });
  } catch(e) { console.log('Notify error:', e.message); }
}
const sendNotify = notify.bind(this);

// Only the primary execution (first in the batch) proceeds
if (response.isPrimary === false) {
  console.log('[Videos] Non-primary execution, skipping...');
  return [];
}

const results = response.results || response;
const videos = Array.isArray(results.videos) ? results.videos : [];
const panels = Array.isArray(results.panels) ? results.panels : [];

if (!response.success) {
  await sendNotify('❌ Lỗi tạo storyboard: ' + (response.error || 'Unknown error').toString().substring(0, 200));
  throw new Error('AI Studio storyboard/video generation failed: ' + JSON.stringify(response.error || response).substring(0, 500));
}

if (videos.length === 0) {
  await sendNotify('⚠️ Storyboard xong nhưng không có video nào được tạo.');
  throw new Error('No videos returned from AI Studio/Flow service.');
}

const failed = videos.filter(video => video.error);
if (failed.length > 0) {
  await sendNotify('⚠️ ' + failed.length + ' video bị lỗi. Đang tiếp tục với ' + (videos.length - failed.length) + ' video thành công.');
}

await sendNotify('🎨 Storyboard & ' + videos.length + ' video đã tạo xong!\\n⏳ Đang resize video...');

return await Promise.all(videos.filter(v => !v.error).map(async (video, index) => {
  const panelIndex = video.panelIndex || index + 1;
  const panel = panels.find(item => item.index === panelIndex) || panels[index] || {};
  const base64 = video.video?.base64 || video.videoBase64;

  if (!base64) {
    throw new Error('Video ' + panelIndex + ' is missing base64. Ensure includeVideoBase64=true is sent to /api/generate-storyboard.');
  }

  return {
    json: {
      panelName: 'Panel' + panelIndex,
      panelIndex,
      chatId,
      prompt: video.prompt || panel.prompt || null,
      panelImagePath: panel.imagePath || null,
      videoPath: video.videoPath || null,
      videoBase64: base64,
    },
    binary: {
      data: await this.helpers.prepareBinaryData(
        Buffer.from(base64, 'base64'),
        'panel' + panelIndex + '.mp4',
        'video/mp4'
      )
    }
  };
}));
`,
    };

    @node({
        id: 'resize-video-node-id',
        name: 'Resize Video',
        type: 'n8n-nodes-base.httpRequest',
        version: 4.2,
        position: [2480, 440],
    })
    ResizeVideo = {
        method: 'POST',
        url: 'http://host.docker.internal:3000/api/resize-video',
        sendBody: true,
        contentType: 'raw',
        rawContentType: 'application/json',
        body: `={{ JSON.stringify({
  videoBase64: $json.videoBase64,
  cropPercent: 0.04,
  aspectRatio: '9:16'
}) }}`,
        options: {
            timeout: 600000,
        },
    };

    @node({
        id: 'prepare-resized-video-id',
        name: 'Prepare Resized Video',
        type: 'n8n-nodes-base.code',
        version: 2,
        position: [2700, 440],
    })
    PrepareResizedVideo = {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: `
const items = $input.all();
const chatId = $('Prepare Photo For Generation').first().json.chatId;
const originalVideos = $('Generate All Videos').all();

// Send status notification
try {
  const creds = await this.getCredentials('telegramApi');
  await this.helpers.httpRequest({
    method: 'POST',
    url: 'https://api.telegram.org/bot' + creds.accessToken + '/sendMessage',
    body: { chat_id: chatId, text: '🎬 ' + items.length + ' video đã resize xong!\\n📤 Đang gửi video về Telegram...' },
    headers: { 'Content-Type': 'application/json' },
  });
} catch(e) { console.log('Notify error:', e.message); }

return await Promise.all(items.map(async (item, index) => {
  const data = item.json;
  const base64 = data.videoBase64;
  const original = originalVideos[index] ? originalVideos[index].json : {};
  const panelName = original.panelName || ('Panel' + (index + 1));
  
  if (!base64) {
    throw new Error('Missing resized videoBase64 for ' + panelName);
  }

  return {
    json: {
      panelName,
      panelIndex: original.panelIndex || (index + 1),
      chatId,
    },
    binary: {
      data: await this.helpers.prepareBinaryData(
        Buffer.from(base64, 'base64'),
        panelName.toLowerCase().replace(/\\s+/g, '_') + '_resized.mp4',
        'video/mp4'
      )
    }
  };
}));
`,
    };

    @node({
        id: 'send-video-telegram-id',
        webhookId: 'send-video-tg-webhook',
        name: 'Send Video To Telegram',
        type: 'n8n-nodes-base.telegram',
        version: 1.2,
        position: [2920, 440],
        credentials: { telegramApi: { id: 'bDHVW2MV7u967Djo', name: 'Telegram Bot B' } },
    })
    SendVideoToTelegram = {
        operation: 'sendVideo',
        chatId: '={{ $json.chatId || $("Prepare Photo For Generation").first().json.chatId }}',
        binaryData: true,
        binaryPropertyName: 'data',
        additionalFields: {
            caption: '={{ $json.panelName }} đã sẵn sàng!',
            appendAttribution: false,
        },
    };

    // =====================================================================
    // ROUTAGE ET CONNEXIONS
    // =====================================================================

    @links()
    defineRouting() {
        this.TelegramTrigger.out(0).to(this.CheckMessageType.in(0));
        this.CheckMessageType.out(0).to(this.IsPhotoMessage.in(0));
        this.IsPhotoMessage.out(0).to(this.PreparePhotoForGeneration.in(0));
        this.PreparePhotoForGeneration.out(0).to(this.GetPhotoFile.in(0));
        this.GetPhotoFile.out(0).to(this.ConvertToBase64.in(0));
        this.ConvertToBase64.out(0).to(this.BuildStoryboardPrompt.in(0));
        this.BuildStoryboardPrompt.out(0).to(this.GenerateStoryboard.in(0));
        this.GenerateStoryboard.out(0).to(this.GenerateAllVideos.in(0));
        this.GenerateAllVideos.out(0).to(this.ResizeVideo.in(0));
        this.ResizeVideo.out(0).to(this.PrepareResizedVideo.in(0));
        this.PrepareResizedVideo.out(0).to(this.SendVideoToTelegram.in(0));
    }
}
