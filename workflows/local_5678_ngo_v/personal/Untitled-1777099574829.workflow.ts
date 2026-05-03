import { workflow, node, links } from '@n8n-as-code/transformer';

// <workflow-map>
// Workflow : Fashion Virtual Try-On
// Nodes   : 22  |  Connections: 18
//
// NODE INDEX
// ──────────────────────────────────────────────────────────────────
// Property name                    Node type (short)         Flags
// TelegramTrigger                    telegramTrigger            [creds]
// SwitchTrigger                      switch
// SendLoginButton                    telegram                   [creds]
// GetPhotoFile                       telegram                   [creds]
// NotifyProcessing                   telegram                   [creds]
// ConvertBinaryToBase64              code
// NotifyStep1                        telegram                   [creds]
// ExtractOutfitGemini                httpRequest
// NotifyStep2                        telegram                   [creds]
// VirtualTryOnNanoBanana             httpRequest
// VeoGenerateExtendPlaywright        httpRequest
// ConvertFinalVideo                  convertToFile
// SendVideoToTelegram                telegram                   [creds]
// UploadToTiktok                     httpRequest
// LoginWebhook                       webhook
// GetAuthUrl                         httpRequest
// RedirectToTiktok                   respondToWebhook
// LoginSuccessWebhook                webhook
// NotifyLoginSuccess                 telegram                   [creds]
// CallbackWebhook                    webhook
// ExchangeToken                      httpRequest
// NotifyTiktokUpload                 telegram                   [creds]
//
// ROUTING MAP
// ──────────────────────────────────────────────────────────────────
// TelegramTrigger
//    → SwitchTrigger
//      → SendLoginButton
//     .out(1) → GetPhotoFile
//        → ConvertBinaryToBase64
//          → NotifyProcessing
//            → ExtractOutfitGemini
//              → NotifyStep1
//                → VirtualTryOnNanoBanana
//                  → NotifyStep2
//                    → VeoGenerateExtendPlaywright
//                      → ConvertFinalVideo
//                        → SendVideoToTelegram
//                          → UploadToTiktok
//                            → NotifyTiktokUpload
// LoginWebhook
//    → GetAuthUrl
//      → RedirectToTiktok
// LoginSuccessWebhook
//    → NotifyLoginSuccess
// CallbackWebhook
//    → ExchangeToken
// </workflow-map>

// =====================================================================
// METADATA DU WORKFLOW
// =====================================================================

@workflow({
    id: 'kSttdZ4bCfIiTbiK',
    name: 'Fashion Virtual Try-On',
    active: true,
    isArchived: false,
    settings: { executionOrder: 'v1', binaryMode: 'separate' },
})
export class FashionVirtualTryOnWorkflow {
    // =====================================================================
    // CONFIGURATION DES NOEUDS
    // =====================================================================

    @node({
        id: 'c0045092-c1ef-48ff-a040-4f0b7d2001e4',
        webhookId: 'dc131969-073d-4983-b4c6-8deff5733259',
        name: 'Telegram Trigger',
        type: 'n8n-nodes-base.telegramTrigger',
        version: 1.2,
        position: [0, 304],
        credentials: { telegramApi: { id: 'q4eKnklNsPTImkdX', name: 'Telegram account' } },
    })
    TelegramTrigger = {
        updates: ['message'],
        additionalFields: {},
    };

    @node({
        id: 'switch-trigger',
        name: 'Switch Trigger',
        type: 'n8n-nodes-base.switch',
        version: 3,
        position: [120, 304],
    })
    SwitchTrigger = {
        mode: 'rules',
        rules: {
            values: [
                {
                    conditions: {
                        options: {
                            caseSensitive: true,
                            leftValue: '',
                            typeValidation: 'strict',
                        },
                        conditions: [
                            {
                                leftValue: '={{ $json.message.text }}',
                                rightValue: '/login',
                                operator: {
                                    type: 'string',
                                    operation: 'equals',
                                },
                            },
                        ],
                        combinator: 'and',
                    },
                    renameOutput: true,
                    outputKey: 'Login Command',
                },
                {
                    conditions: {
                        options: {
                            caseSensitive: true,
                            leftValue: '',
                            typeValidation: 'strict',
                        },
                        conditions: [
                            {
                                leftValue: '={{ $json.message.photo ? true : false }}',
                                rightValue: '={{ true }}',
                                operator: {
                                    type: 'boolean',
                                    operation: 'true',
                                },
                            },
                        ],
                        combinator: 'and',
                    },
                    renameOutput: true,
                    outputKey: 'Has Photo',
                },
            ],
        },
    };

    @node({
        id: 'telegram-login-button',
        webhookId: '79d24292-f317-4efa-93bb-a2f664329009',
        name: 'Send Login Button',
        type: 'n8n-nodes-base.telegram',
        version: 1.2,
        position: [320, 150],
        credentials: { telegramApi: { id: 'q4eKnklNsPTImkdX', name: 'Telegram account' } },
    })
    SendLoginButton = {
        chatId: '={{ $json.message.chat.id }}',
        text: `🔗 Hãy kết nối tài khoản TikTok để bot tự động đăng video cho bạn!

Bấm nút bên dưới để đăng nhập:`,
        replyMarkup: 'inlineKeyboard',
        inlineKeyboard: {
            rows: [
                {
                    row: {
                        buttons: [
                            {
                                text: '🔗 Đăng nhập TikTok',
                                additionalFields: {
                                    url: '={{ "https://raspiest-unprophetically-wan.ngrok-free.dev/webhook/tiktok-login?state=" + $json.message.chat.id }}',
                                },
                            },
                        ],
                    },
                },
            ],
        },
        additionalFields: {
            appendAttribution: false,
        },
    };

    @node({
        id: '5f0980f9-7418-44b9-92f7-58f2c29ac6db',
        webhookId: '5df57fb9-32fe-469c-8b76-dd1e395bfe1a',
        name: 'Get Photo File',
        type: 'n8n-nodes-base.telegram',
        version: 1.2,
        position: [224, 304],
        credentials: { telegramApi: { id: 'q4eKnklNsPTImkdX', name: 'Telegram account' } },
    })
    GetPhotoFile = {
        resource: 'file',
        fileId: '={{ $json.message.photo.slice(-1)[0].file_id }}',
        additionalFields: {},
    };

    @node({
        id: '8d61b698-f0e7-4ae4-9f28-7ccf8b47a78a',
        webhookId: '8be87496-1a40-4f31-8856-c51f936e54fd',
        name: 'Notify Processing',
        type: 'n8n-nodes-base.telegram',
        version: 1.2,
        position: [448, 304],
        credentials: { telegramApi: { id: 'q4eKnklNsPTImkdX', name: 'Telegram account' } },
    })
    NotifyProcessing = {
        chatId: '={{ $json.message?.chat?.id || $("Telegram Trigger").first().json.message.chat.id }}',
        text: '⏳ Đang xử lý ảnh của bạn... Vui lòng chờ trong vài phút.',
        additionalFields: {
            appendAttribution: false,
        },
    };

    @node({
        id: 'd9b7fc61-e009-4af7-9f45-bb780d603a11',
        name: 'Convert Binary to Base64',
        type: 'n8n-nodes-base.code',
        version: 2,
        position: [448, 304],
    })
    ConvertBinaryToBase64 = {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: `for (let i=0; i<$input.all().length; i++) {
  const item = $input.all()[i];
  if (item.binary && item.binary.data) {
    const buffer = await this.helpers.getBinaryDataBuffer(i, 'data');
    item.json.imageBase64 = buffer.toString('base64');
    item.json.imageMimeType = item.binary.data.mimeType;
  }
}
return $input.all();`,
    };

    @node({
        id: 'notify-step-1',
        webhookId: 'df410cda-d721-43ca-bd54-ded90a5b93a7',
        name: 'Notify Step 1',
        type: 'n8n-nodes-base.telegram',
        version: 1.2,
        position: [672, 500],
        credentials: { telegramApi: { id: 'q4eKnklNsPTImkdX', name: 'Telegram account' } },
    })
    NotifyStep1 = {
        chatId: '={{ $("Telegram Trigger").first().json.message.chat.id }}',
        text: '✅ Đã tách outfit xong! Đang tiến hành thay đổi outfit lên người mẫu...',
        additionalFields: {
            appendAttribution: false,
        },
    };

    @node({
        id: 'bb0e9b5e-e8ab-4213-95d9-3125822ad0af',
        name: 'Extract Outfit (Gemini)',
        type: 'n8n-nodes-base.httpRequest',
        version: 4.4,
        position: [672, 304],
    })
    ExtractOutfitGemini = {
        method: 'POST',
        url: 'http://host.docker.internal:3000/api/generate',
        sendBody: true,
        contentType: 'raw',
        rawContentType: 'application/json',
        body: `={{ JSON.stringify({
  prompt: 'Tách hình lấy set đồ. Chỉ giữ lại quần áo, giày dép, túi xách, phụ kiện. Giữ nguyên chi tiết, màu sắc, chất liệu của từng món đồ. Nền trắng sạch, không có người.',
  base64Images: [ $("Convert Binary to Base64").first().json.imageBase64 ],
  fileNames: ['extracted_outfit.png'],
  mode: 'ingredients-to-image',
  imageModel: 'nano-banana-2',
  aspectRatio: '9:16',
  outputCount: 1
}) }}`,
        options: {
            timeout: 120000,
        },
    };

    @node({
        id: 'notify-step-2',
        webhookId: 'c0b64651-1f9c-4e7c-bf3c-4274069fe592',
        name: 'Notify Step 2',
        type: 'n8n-nodes-base.telegram',
        version: 1.2,
        position: [880, 500],
        credentials: { telegramApi: { id: 'q4eKnklNsPTImkdX', name: 'Telegram account' } },
    })
    NotifyStep2 = {
        chatId: '={{ $("Telegram Trigger").first().json.message.chat.id }}',
        text: '✅ Đã thay outfit xong! Bắt đầu tạo video (có thể mất 2-3 phút)...',
        additionalFields: {
            appendAttribution: false,
        },
    };

    @node({
        id: '34cef1c3-cc53-4e0b-b294-4a905e689d1a',
        name: 'Virtual Try-On (Nano Banana)',
        type: 'n8n-nodes-base.httpRequest',
        version: 4.4,
        position: [880, 304],
    })
    VirtualTryOnNanoBanana = {
        method: 'POST',
        url: 'http://host.docker.internal:3000/api/generate',
        sendBody: true,
        contentType: 'raw',
        rawContentType: 'application/json',
        body: `={{ JSON.stringify({
  prompt: 'Thay đổi set đồ của người mẫu trong hình thứ nhất (người thật) bằng set đồ trong hình thứ hai (quần áo). Giữ nguyên khuôn mặt, dáng người, tư thế, và hình nền của người. Chỉ thay đổi trang phục, giày dép, và phụ kiện theo hình ảnh set đồ đã cung cấp. Kết quả phải trông tự nhiên và chân thực.',
  base64Images: [ $("Extract Outfit (Gemini)").first().json.image.base64 ],
  fileNames: ['virtual_try_on.png'],
  imageSelection: ['name:model_inital', 'name:extracted_outfit'],
  mode: 'ingredients-to-image',
  imageModel: 'nano-banana-2',
  aspectRatio: '9:16',
  outputCount: 1
}) }}`,
        options: {},
    };

    @node({
        id: 'new-playwright-veo-id',
        name: 'Veo Generate & Extend (Playwright)',
        type: 'n8n-nodes-base.httpRequest',
        version: 4.4,
        position: [1104, 304],
    })
    VeoGenerateExtendPlaywright = {
        method: 'POST',
        url: 'http://host.docker.internal:3000/api/generate-video',
        sendBody: true,
        contentType: 'raw',
        rawContentType: 'application/json',
        body: `={{ JSON.stringify({
  prompt: "Tạo một video thực tế về cùng một người dựa trên ảnh tham chiếu đã tải lên.\\n\\nSử dụng ảnh đã tải lên làm ảnh tham chiếu chính xác, giữ nguyên khuôn mặt, đặc điểm khuôn mặt và kiểu tóc; không tạo ra một khuôn mặt mới\\n\\nKhóa người mẫu\\n\\nKhóa hình nền\\n\\nKhóa trang phục\\n\\nStyle video: gợi cảm nhưng thanh lịch, ngôn ngữ cơ thể nữ tính, chuyển động gợi cảm tinh tế, lắc hông tự nhiên, giao tiếp bằng mắt tán tỉnh\\n\\nChuyển động:\\nNgười mẫu bắt đầu với tư thế đứng thẳng, ánh nhìn hướng về phía trước, sau đó bước nhẹ một bước nhỏ để tạo chuyển động tự nhiên.\\n\\nThực hiện chuyển trọng tâm cơ thể từ chân này sang chân kia, đồng thời xoay thân trên một góc nhỏ để lộ form trang phục từ góc nghiêng.\\n\\nDùng tay vuốt nhẹ phần hông hoặc thân váy để làm nổi bật chất liệu và độ rũ của vải.\\n\\nThực hiện xoay chậm 30 độ, không được xoay quá 30 độ., tay trái vẫn luôn cầm điện thoại, dừng lại giữa chừng để tạo điểm nhấn ở góc 30 độ, sau đó xoay chậm ngược lại.\\n\\nTay đưa lên chạm nhẹ vào tóc hoặc sau gáy, kết hợp với ánh mắt thay đổi hướng nhìn (nhìn sang ngang hoặc xuống nhẹ).",
  extendPrompt: "Cảnh 2\\n\\nChân trái hơi đưa về phía trước, đầu gối thả lỏng, tạo ảo giác chân dài hơn.\\n\\nXoay nhẹ thân người về phía gương, vai thả lỏng tự nhiên, dây đeo túi được điều chỉnh nhẹ nhàng.\\n\\nThay đổi tư thế nhẹ nhàng, các ngón tay thả lỏng, cổ tay hơi cong, chuyển động thanh thoát nữ tính.\\n\\nChuyển động nhỏ: lắc hông nhẹ, điều chỉnh tư thế nhẹ nhàng, tạo dáng tự nhiên như người có ảnh hưởng trên mạng xã hội.\\n\\nGiữ tư thế cuối cùng một cách tự tin, nghiêng đầu nhẹ, biểu cảm bình tĩnh, chuyển động tối thiểu.",
  base64Images: [ $("Virtual Try-On (Nano Banana)").first().json.image.base64 ],
  fileNames: ['virtual_try_on.png'],
  imageSelection: ['name:virtual_try_on'],
  aspectRatio: '9:16'
}) }}`,
        options: {
            timeout: 1200000,
        },
    };

    @node({
        id: 'ca6b678d-0939-4bb0-9d9a-d62005f456c5',
        name: 'Convert Final Video',
        type: 'n8n-nodes-base.convertToFile',
        version: 1.1,
        position: [1328, 304],
    })
    ConvertFinalVideo = {
        operation: 'toBinary',
        sourceProperty: 'video.base64',
        binaryPropertyName: 'video',
        options: {
            fileName: 'fashion_video_16s.mp4',
            mimeType: 'video/mp4',
        },
    };

    @node({
        id: 'f1d1c68c-54c3-4a55-9824-45cdd7340964',
        webhookId: '7eeb1e56-9f7b-49a4-bda1-7e881de50a4e',
        name: 'Send Video to Telegram',
        type: 'n8n-nodes-base.telegram',
        version: 1.2,
        position: [1552, 304],
        credentials: { telegramApi: { id: 'q4eKnklNsPTImkdX', name: 'Telegram account' } },
    })
    SendVideoToTelegram = {
        operation: 'sendVideo',
        chatId: '={{ $("Telegram Trigger").first().json.message.chat.id }}',
        binaryData: true,
        binaryPropertyName: 'video',
        additionalFields: {
            appendAttribution: false,
            caption: '✅ Video đã hoàn thành!',
            parse_mode: 'Markdown',
        },
    };

    @node({
        id: 'tiktok-upload-node',
        name: 'Upload to TikTok',
        type: 'n8n-nodes-base.httpRequest',
        version: 4.4,
        position: [1776, 304],
    })
    UploadToTiktok = {
        method: 'POST',
        url: 'http://host.docker.internal:3000/api/tiktok/upload',
        sendBody: true,
        contentType: 'raw',
        rawContentType: 'application/json',
        body: `={{ JSON.stringify({
            telegram_id: $("Telegram Trigger").first().json.message.chat.id.toString(),
            base64Video: $("Veo Generate & Extend (Playwright)").first().json.video.base64,
            title: "Ai Fashion Transform ✨ #aivideo #fashion #aifashion",
            privacyLevel: "SELF_ONLY"
        }) }}`,
        options: {
            timeout: 120000,
        },
    };

    @node({
        id: '9aabf5c3-f9b1-4412-8b10-346139533c38',
        webhookId: '1e1098bf-3ae8-4d7b-8f04-8bbeac8cf50f',
        name: 'Login Webhook',
        type: 'n8n-nodes-base.webhook',
        version: 2.1,
        position: [0, 700],
    })
    LoginWebhook = {
        httpMethod: 'GET',
        path: 'tiktok-login',
        responseMode: 'responseNode',
        options: {},
    };

    @node({
        id: '967aeec8-7769-4d18-ac60-6301a289671f',
        name: 'Get Auth URL',
        type: 'n8n-nodes-base.httpRequest',
        version: 4.4,
        position: [220, 700],
    })
    GetAuthUrl = {
        method: 'GET',
        url: '={{ "http://host.docker.internal:3000/api/tiktok/auth?state=" + $json.query.state }}',
        options: {},
    };

    @node({
        id: 'af82577c-6bf1-4cd7-b076-529bd519c50f',
        name: 'Redirect To TikTok',
        type: 'n8n-nodes-base.respondToWebhook',
        version: 1.5,
        position: [440, 700],
    })
    RedirectToTiktok = {
        respondWith: 'redirect',
        redirectURL: '={{ $json.authUrl }}',
        options: {},
    };

    @node({
        id: '59cf29a4-8206-4f27-b5cb-6105f989f9dc',
        webhookId: '940897d0-3852-47dc-afd4-eacf5995c669',
        name: 'Login Success Webhook',
        type: 'n8n-nodes-base.webhook',
        version: 2.1,
        position: [0, 950],
    })
    LoginSuccessWebhook = {
        httpMethod: 'POST',
        path: 'tiktok-login-success',
        responseMode: 'onReceived',
        options: {},
    };

    @node({
        id: '21cb9b2d-7384-4a89-97aa-25d697568b59',
        webhookId: 'd10e0f86-eb3d-4c8c-a6b6-0f81eb406511',
        name: 'Notify Login Success',
        type: 'n8n-nodes-base.telegram',
        version: 1.2,
        position: [220, 950],
        credentials: { telegramApi: { id: 'q4eKnklNsPTImkdX', name: 'Telegram account' } },
    })
    NotifyLoginSuccess = {
        chatId: '={{ $json.body.chat_id }}',
        text: `✅ Kết nối TikTok thành công!

Từ giờ mỗi khi bot tạo xong video, nó sẽ tự động đăng lên TikTok cho bạn. 🎉`,
        additionalFields: {
            appendAttribution: false,
        },
    };

    @node({
        id: '79d00c52-56b4-4b40-baa6-624dc5c94f64',
        webhookId: '8b8f80e0-104a-4178-a7a0-80dada0398ef',
        name: 'Callback Webhook',
        type: 'n8n-nodes-base.webhook',
        version: 2.1,
        position: [0, 1200],
    })
    CallbackWebhook = {
        httpMethod: 'POST',
        path: 'tiktok-callback',
        responseMode: 'lastNode',
        options: {},
    };

    @node({
        id: '07e4aca8-46c9-46f5-8d73-aaa6ea44ea3d',
        name: 'Exchange Token',
        type: 'n8n-nodes-base.httpRequest',
        version: 4.4,
        position: [220, 1200],
    })
    ExchangeToken = {
        method: 'POST',
        url: 'http://host.docker.internal:3000/api/tiktok/callback',
        sendBody: true,
        contentType: 'raw',
        rawContentType: 'application/json',
        body: '={{ JSON.stringify({ code: $json.body.code, state: $json.body.state }) }}',
        options: {},
    };

    @node({
        id: '35729f2b-bab8-4b30-a5c8-f64f55dd5f24',
        webhookId: 'bc4130b1-2754-4fd6-9f66-cbef0d889365',
        name: 'Notify TikTok Upload',
        type: 'n8n-nodes-base.telegram',
        version: 1.2,
        position: [2000, 304],
        credentials: { telegramApi: { id: 'q4eKnklNsPTImkdX', name: 'Telegram account' } },
    })
    NotifyTiktokUpload = {
        chatId: '={{ $("Telegram Trigger").first().json.message.chat.id }}',
        text: '={{ $json.success ? "🎉 Video đã được đăng lên TikTok thành công!" : "⚠️ Không thể đăng lên TikTok: " + ($json.error || "Chưa kết nối TikTok. Gõ /login để kết nối.") }}',
        additionalFields: {
            appendAttribution: false,
        },
    };

    // =====================================================================
    // ROUTAGE ET CONNEXIONS
    // =====================================================================

    @links()
    defineRouting() {
        this.TelegramTrigger.out(0).to(this.SwitchTrigger.in(0));
        this.SwitchTrigger.out(0).to(this.SendLoginButton.in(0));
        this.SwitchTrigger.out(1).to(this.GetPhotoFile.in(0));
        this.GetPhotoFile.out(0).to(this.ConvertBinaryToBase64.in(0));
        this.ConvertBinaryToBase64.out(0).to(this.NotifyProcessing.in(0));
        this.NotifyProcessing.out(0).to(this.ExtractOutfitGemini.in(0));
        this.ExtractOutfitGemini.out(0).to(this.NotifyStep1.in(0));
        this.NotifyStep1.out(0).to(this.VirtualTryOnNanoBanana.in(0));
        this.VirtualTryOnNanoBanana.out(0).to(this.NotifyStep2.in(0));
        this.NotifyStep2.out(0).to(this.VeoGenerateExtendPlaywright.in(0));
        this.VeoGenerateExtendPlaywright.out(0).to(this.ConvertFinalVideo.in(0));
        this.ConvertFinalVideo.out(0).to(this.SendVideoToTelegram.in(0));
        this.SendVideoToTelegram.out(0).to(this.UploadToTiktok.in(0));
        this.UploadToTiktok.out(0).to(this.NotifyTiktokUpload.in(0));
        this.LoginWebhook.out(0).to(this.GetAuthUrl.in(0));
        this.GetAuthUrl.out(0).to(this.RedirectToTiktok.in(0));
        this.LoginSuccessWebhook.out(0).to(this.NotifyLoginSuccess.in(0));
        this.CallbackWebhook.out(0).to(this.ExchangeToken.in(0));
    }
}
