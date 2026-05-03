import { workflow, node, links } from '@n8n-as-code/transformer';

// <workflow-map>
// Workflow : TikTok Login Proxy
// Nodes   : 5  |  Connections: 3
//
// NODE INDEX
// ──────────────────────────────────────────────────────────────────
// Property name                    Node type (short)         Flags
// Webhook                            webhook
// GetAuthUrl                         httpRequest
// RedirectToTiktok                   respondToWebhook
// LoginSuccessWebhook                webhook
// NotifyLoginSuccess                 telegram                   [creds]
//
// ROUTING MAP
// ──────────────────────────────────────────────────────────────────
// Webhook
//    → GetAuthUrl
//      → RedirectToTiktok
// LoginSuccessWebhook
//    → NotifyLoginSuccess
// </workflow-map>

// =====================================================================
// METADATA DU WORKFLOW
// =====================================================================

@workflow({
    id: 'mXOwd0bsUidvkjM0',
    name: 'TikTok Login Proxy',
    active: true,
    isArchived: false,
    settings: { executionOrder: 'v1' },
})
export class TiktokLoginProxyWorkflow {
    // =====================================================================
    // CONFIGURATION DES NOEUDS
    // =====================================================================

    @node({
        id: '4021be8d-1000-47e1-81ec-89dbe64d36af',
        webhookId: 'e4f78822-0b22-40a9-a4c8-a42a4d4e4d68',
        name: 'Webhook',
        type: 'n8n-nodes-base.webhook',
        version: 2.1,
        position: [0, 0],
    })
    Webhook = {
        httpMethod: 'GET',
        path: 'tiktok-login',
        responseMode: 'responseNode',
        options: {},
    };

    @node({
        id: 'b2c806b0-0d61-4ba6-bbe2-490abebd6a12',
        name: 'Get Auth URL',
        type: 'n8n-nodes-base.httpRequest',
        version: 4.4,
        position: [220, 0],
    })
    GetAuthUrl = {
        method: 'GET',
        url: '={{ "http://host.docker.internal:3000/api/tiktok/auth?state=" + $json.query.state }}',
        options: {},
    };

    @node({
        id: '718e1117-6498-4c8d-9f16-d3b20d945ed2',
        name: 'Redirect To TikTok',
        type: 'n8n-nodes-base.respondToWebhook',
        version: 1.5,
        position: [440, 0],
    })
    RedirectToTiktok = {
        respondWith: 'redirect',
        redirectURL: '={{ $json.authUrl }}',
        options: {},
    };

    @node({
        id: '8b9b083b-5fab-48bb-a813-134f0b9be462',
        webhookId: 'f9026d85-2be4-4a00-8f6b-45805eff1945',
        name: 'Login Success Webhook',
        type: 'n8n-nodes-base.webhook',
        version: 2.1,
        position: [0, 250],
    })
    LoginSuccessWebhook = {
        httpMethod: 'POST',
        path: 'tiktok-login-success',
        responseMode: 'onReceived',
        options: {},
    };

    @node({
        id: '5ae6e5cc-e334-44aa-9419-e433b4829b43',
        webhookId: '129ad978-8da6-44a8-867c-b1ac21b2c3f2',
        name: 'Notify Login Success',
        type: 'n8n-nodes-base.telegram',
        version: 1.2,
        position: [220, 250],
        credentials: { telegramApi: { id: 'q4eKnklNsPTImkdX', name: 'Telegram account' } },
    })
    NotifyLoginSuccess = {
        chatId: '={{ $json.body.chat_id }}',
        text: `✅ Kết nối TikTok thành công!

Từ giờ mỗi khi bot tạo xong video, nó sẽ tự động đăng lên TikTok cho bạn. 🎉`,
        additionalFields: {},
    };

    // =====================================================================
    // ROUTAGE ET CONNEXIONS
    // =====================================================================

    @links()
    defineRouting() {
        this.Webhook.out(0).to(this.GetAuthUrl.in(0));
        this.GetAuthUrl.out(0).to(this.RedirectToTiktok.in(0));
        this.LoginSuccessWebhook.out(0).to(this.NotifyLoginSuccess.in(0));
    }
}
