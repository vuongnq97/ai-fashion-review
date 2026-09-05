'use strict';

/**
 * n8n-workflow-sync.js
 * 
 * Tự động hoá quản lý Credentials và Workflow trong n8n cho từng Shop:
 * 1. Mã hóa và lưu credential `tiktokApi` trực tiếp vào SQLite của n8n (credentials_entity).
 * 2. Tự động inject 3 nodes cho Shop mới vào Workflow n8n ("TikTok Upload Only"):
 *    - Get Link Affiliate (${ShopName})
 *    - Get Link Affiliate (${ShopName} - P2)
 *    - TikTok Upload (${ShopName})
 * 3. Cập nhật các node Switch (`Switch TikTok Channel` & `Switch Upload Channel`).
 * 4. Đồng bộ file workflows/TIKTOK UPLOAD ONLY.json và khởi động lại n8n (chỉ mất ~0.7s)
 *    để n8n nạp cấu hình mới ngay lập tức.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DOCKER_CONTAINER_NAME = process.env.N8N_CONTAINER_NAME || 'n8n';
const WORKSPACE_WORKFLOW_FILE = path.resolve(__dirname, '..', '..', 'workflows', 'TIKTOK UPLOAD ONLY.json');

const DOCKER_NODE_SCRIPT = `
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(input);
    const { credentialId, credentialName, cookies, workflowId } = payload;
    
    // 1. Đọc encryption key từ config của n8n
    const config = JSON.parse(fs.readFileSync('/home/node/.n8n/config', 'utf8'));
    const encryptionKey = config.encryptionKey;
    
    function encryptOpenSSL(plainText, password) {
      const salt = crypto.randomBytes(8);
      let keyAndIv = Buffer.alloc(0);
      let currentHash = Buffer.alloc(0);
      while (keyAndIv.length < 48) {
        const hash = crypto.createHash('md5');
        hash.update(currentHash);
        hash.update(password);
        hash.update(salt);
        currentHash = hash.digest();
        keyAndIv = Buffer.concat([keyAndIv, currentHash]);
      }
      const key = keyAndIv.subarray(0, 32);
      const iv = keyAndIv.subarray(32, 48);
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      let encrypted = cipher.update(Buffer.from(plainText, 'utf8'));
      encrypted = Buffer.concat([encrypted, cipher.final()]);
      return Buffer.concat([Buffer.from('Salted__', 'utf8'), salt, encrypted]).toString('base64');
    }

    const db = new DatabaseSync('/home/node/.n8n/database.sqlite');
    
    // Lọc sạch cookies
    const cleanCookies = {};
    for (const [k, v] of Object.entries(cookies || {})) {
      if (typeof v === 'string' && v.trim() && !['updatedAt', 'label', 'credentialName', 'username', 'screenName', 'id', 'name', 'userId', 'nickname'].includes(k)) {
        cleanCookies[k] = v.trim();
      }
    }

    // Đóng gói payload tiktokSession theo chuẩn của n8n-nodes-social-tiktok
    const sessionObj = {
      http: {
        type: 'xmlhttprequest',
        url: 'https://www.tiktok.com/api/user/settings/?WebIdLastTime=1786930206&aid=1988&app_language=en&app_name=tiktok_web&browser_language=en-US&browser_name=Mozilla&browser_online=true&browser_platform=MacIntel&browser_version=5.0%20(Macintosh%3B%20Intel%20Mac%20OS%20X%2010_15_7)%20AppleWebKit%2F537.36%20(KHTML%2C%20like%20Gecko)%20Chrome%2F125.0.0.0%20Safari%2F537.36',
        method: 'GET',
        timestamp: new Date().toISOString(),
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'referer': 'https://www.tiktok.com/'
        },
        params: {},
        cookies: cleanCookies,
        body: ''
      }
    };

    const encData = encryptOpenSSL(JSON.stringify({ tiktokSession: JSON.stringify(sessionObj, null, 2) }), encryptionKey);

    // Lưu vào bảng credentials_entity
    const existingCred = db.prepare('SELECT id FROM credentials_entity WHERE id = ?').get(credentialId);
    if (existingCred) {
      db.prepare("UPDATE credentials_entity SET name = ?, data = ?, updatedAt = STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW') WHERE id = ?")
        .run(credentialName, encData, credentialId);
    } else {
      db.prepare("INSERT INTO credentials_entity (id, name, type, data, createdAt, updatedAt) VALUES (?, ?, 'tiktokApi', ?, STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'), STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))")
        .run(credentialId, credentialName, encData);
    }

    // Liên kết quyền truy cập project trong shared_credentials
    const defaultProject = db.prepare('SELECT id FROM project LIMIT 1').get();
    if (defaultProject) {
      const existingShared = db.prepare('SELECT credentialsId FROM shared_credentials WHERE credentialsId = ?').get(credentialId);
      if (!existingShared) {
        db.prepare("INSERT INTO shared_credentials (credentialsId, projectId, role, createdAt, updatedAt) VALUES (?, ?, 'credential:owner', STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'), STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))")
          .run(credentialId, defaultProject.id);
      }
    }

    // 2. Cập nhật Workflow n8n
    const targetWfId = workflowId || '0e2fc3f8b32d4b0d';
    const wf = db.prepare('SELECT id, name, nodes, connections FROM workflow_entity WHERE id = ?').get(targetWfId);
    if (!wf) {
      console.log(JSON.stringify({ success: true, updatedCredOnly: true, message: 'Workflow not found in db' }));
      return;
    }

    const nodes = JSON.parse(wf.nodes);
    const conns = JSON.parse(wf.connections);

    const switch1 = nodes.find(n => n.name === 'Switch TikTok Channel');
    const switch2 = nodes.find(n => n.name === 'Switch Upload Channel');
    const findNode = nodes.find(n => n.name === 'Find Product By product_id');

    if (!switch1 || !switch2) {
      console.log(JSON.stringify({ success: true, updatedCredOnly: true, message: 'Switch nodes not found in workflow' }));
      return;
    }

    const safeSuffix = credentialName.replace(/[^a-zA-Z0-9_\\u00C0-\\u1EF9 -]/g, '').trim() || credentialId;
    const nodeAff1Name = 'Get Link Affiliate (' + safeSuffix + ')';
    const nodeAff2Name = 'Get Link Affiliate (' + safeSuffix + ' - P2)';
    const nodeUploadName = 'TikTok Upload (' + safeSuffix + ')';

    // Kiểm tra xem credentialId này đã có rule trong switch1 chưa
    let ruleIndex = switch1.parameters?.rules?.values?.findIndex(r => 
      r.conditions?.conditions?.some(c => c.rightValue === credentialId)
    );

    let addedNodes = false;
    if (ruleIndex === -1 || ruleIndex === undefined) {
      const existingRulesCount = switch1.parameters.rules.values.length;
      const yOffset = (existingRulesCount + 1) * 200;

      // Node Affiliate Page 1
      const aff1Node = {
        parameters: { resource: 'product', count: 100, offset: 0 },
        type: 'n8n-nodes-social-tiktok.tiktokAll',
        typeVersion: 1,
        position: [1440, 850 + yOffset],
        id: 'node-aff-' + Math.random().toString(36).slice(2, 10),
        name: nodeAff1Name,
        credentials: { tiktokApi: { id: credentialId, name: credentialName } }
      };

      // Node Affiliate Page 2
      const aff2Node = {
        parameters: { resource: 'product', count: 100, offset: 100 },
        type: 'n8n-nodes-social-tiktok.tiktokAll',
        typeVersion: 1,
        position: [1680, 850 + yOffset],
        id: 'node-aff2-' + Math.random().toString(36).slice(2, 10),
        name: nodeAff2Name,
        credentials: { tiktokApi: { id: credentialId, name: credentialName } }
      };

      // Node Upload with Product
      const uploadNode = {
        parameters: {
          postSettings: {
            text: "={{ $('Find Product By product_id').item.json.caption }}",
            visibilityType: 0,
            allowComment: 1,
            scheduleTime: "=0",
            anchors: {
              anchor: [
                {
                  type: 'product',
                  productId: "={{ $('Find Product By product_id').item.json.productId }}",
                  displayName: "={{ $('Find Product By product_id').item.json.cartAnchorText || $('Find Product By product_id').item.json.productTitle }}"
                }
              ]
            }
          }
        },
        type: 'n8n-nodes-social-tiktok.tikTokUpload',
        typeVersion: 1,
        position: [2880, 800 + yOffset],
        id: 'node-up-' + Math.random().toString(36).slice(2, 10),
        name: nodeUploadName,
        credentials: { tiktokApi: { id: credentialId, name: credentialName } }
      };

      nodes.push(aff1Node, aff2Node, uploadNode);

      // Thêm Rule rẽ nhánh cho Switch 1 & Switch 2
      const newRule = {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              leftValue: "={{ $('Parse Telegram Message').item.json.tiktokCredentialId }}",
              rightValue: credentialId,
              operator: { type: 'string', operation: 'equals' }
            }
          ],
          combinator: 'and'
        }
      };
      switch1.parameters.rules.values.push(newRule);
      switch2.parameters.rules.values.push(newRule);

      // Cập nhật Connections cho Switch 1
      if (!conns['Switch TikTok Channel']) conns['Switch TikTok Channel'] = { main: [] };
      const s1Main = conns['Switch TikTok Channel'].main || [];
      const fallbackS1 = s1Main.length > existingRulesCount ? s1Main.pop() : [{ node: 'Get Link Affiliate', type: 'main', index: 0 }];
      s1Main.push([{ node: nodeAff1Name, type: 'main', index: 0 }]);
      s1Main.push(fallbackS1);
      conns['Switch TikTok Channel'].main = s1Main;

      // Cập nhật Connections cho Switch 2
      if (!conns['Switch Upload Channel']) conns['Switch Upload Channel'] = { main: [] };
      const s2Main = conns['Switch Upload Channel'].main || [];
      const fallbackS2 = s2Main.length > existingRulesCount ? s2Main.pop() : [{ node: 'TikTok Upload With Product', type: 'main', index: 0 }];
      s2Main.push([{ node: nodeUploadName, type: 'main', index: 0 }]);
      s2Main.push(fallbackS2);
      conns['Switch Upload Channel'].main = s2Main;

      // Nối dây: Aff1 -> Aff2 -> Find Product By product_id
      conns[nodeAff1Name] = { main: [[{ node: nodeAff2Name, type: 'main', index: 0 }]] };
      conns[nodeAff2Name] = { main: [[{ node: 'Find Product By product_id', type: 'main', index: 0 }]] };

      // Nối dây: UploadNode -> Save Publish Result
      conns[nodeUploadName] = { main: [[{ node: 'Save Publish Result', type: 'main', index: 0 }]] };

      // Cập nhật code JS gom sản phẩm trong Find Product By product_id
      if (findNode && findNode.parameters?.jsCode) {
        let code = findNode.parameters.jsCode;
        if (!code.includes(nodeAff1Name)) {
          const insertMarker = "...getProductsFromNode('Get Link Affiliate'),";
          if (code.includes(insertMarker)) {
            code = code.replace(
              insertMarker,
              "...getProductsFromNode('" + nodeAff1Name + "'),\\n  ...getProductsFromNode('" + nodeAff2Name + "'),\\n  " + insertMarker
            );
            findNode.parameters.jsCode = code;
          }
        }
      }

      addedNodes = true;
    } else {
      // Nếu rule đã tồn tại, cập nhật lại tên credential trên các node tương ứng
      for (const node of nodes) {
        if (node.credentials?.tiktokApi?.id === credentialId) {
          node.credentials.tiktokApi.name = credentialName;
        }
      }
    }

    // Lưu workflow đã update vào database
    db.prepare("UPDATE workflow_entity SET nodes = ?, connections = ?, updatedAt = STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW') WHERE id = ?")
      .run(JSON.stringify(nodes), JSON.stringify(conns), targetWfId);

    console.log(JSON.stringify({
      success: true,
      credentialId,
      credentialName,
      addedNodes,
      workflowId: targetWfId,
      nodesCount: nodes.length,
      fullWorkflowJson: { nodes, connections: conns }
    }));
  } catch (err) {
    console.error(JSON.stringify({ success: false, error: err.message, stack: err.stack }));
  }
});
`;

/**
 * Đảm bảo container n8n đang hoạt động
 */
function ensureN8nContainerRunning() {
  try {
    const status = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', DOCKER_CONTAINER_NAME], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();

    if (status !== 'true') {
      console.log(`[n8nSync] 🚀 Khởi động container ${DOCKER_CONTAINER_NAME}...`);
      execFileSync('docker', ['start', DOCKER_CONTAINER_NAME], { stdio: 'inherit' });
      execFileSync('sleep', ['2']);
    }
  } catch (err) {
    console.warn(`[n8nSync] ⚠️ Không thể kiểm tra/khởi động Docker container ${DOCKER_CONTAINER_NAME}:`, err.message);
  }
}

/**
 * Đồng bộ Shop mới vào n8n:
 * - Thêm / Update credential `tiktokApi` trong n8n SQLite
 * - Tự động thêm nhánh node cho Shop vào workflow n8n
 * - Restart n8n container (~0.7s) để áp dụng ngay lập tức
 * 
 * @param {string} credentialId - ID tài khoản (VD: "shop_1788597123" hoặc "cJDNuW2i1tFFXivi")
 * @param {object} cookies - Object cookies đăng nhập từ QR scan
 * @param {string} shopLabel - Tên shop hiển thị
 * @returns {Promise<{ success: boolean, addedNodes: boolean, message: string }>}
 */
async function syncShopToN8n(credentialId, cookies, shopLabel) {
  if (!credentialId || !cookies) {
    throw new Error('credentialId và cookies là bắt buộc để đồng bộ n8n');
  }

  ensureN8nContainerRunning();

  const payload = {
    credentialId,
    credentialName: shopLabel || credentialId,
    cookies,
    workflowId: '0e2fc3f8b32d4b0d'
  };

  console.log(`[n8nSync] 🔄 Đang đồng bộ Shop "${shopLabel}" (${credentialId}) vào n8n...`);

  let rawOutput = '';
  try {
    rawOutput = execFileSync('docker', ['exec', '-i', DOCKER_CONTAINER_NAME, 'node', '-e', DOCKER_NODE_SCRIPT], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (err) {
    console.error('[n8nSync] ❌ Lỗi khi gọi docker exec n8n:', err.message);
    return { success: false, error: err.message };
  }

  let result = {};
  try {
    result = JSON.parse(rawOutput.trim());
  } catch (err) {
    console.error('[n8nSync] ❌ Không thể parse output từ n8n docker:', rawOutput);
    return { success: false, error: 'Parse error: ' + rawOutput };
  }

  if (result.success) {
    console.log(`[n8nSync] ✅ Đã lưu credential n8n thành công. (Nodes mới: ${result.addedNodes ? 'Có' : 'Đã có sẵn'})`);

    // Lưu bản sao workflow vào thư mục repository nếu có thay đổi
    if (result.fullWorkflowJson && fs.existsSync(WORKSPACE_WORKFLOW_FILE)) {
      try {
        const fileContent = JSON.parse(fs.readFileSync(WORKSPACE_WORKFLOW_FILE, 'utf8'));
        fileContent.nodes = result.fullWorkflowJson.nodes;
        fileContent.connections = result.fullWorkflowJson.connections;
        fs.writeFileSync(WORKSPACE_WORKFLOW_FILE, JSON.stringify(fileContent, null, 2), 'utf8');
        console.log(`[n8nSync] 💾 Đã cập nhật file ${path.basename(WORKSPACE_WORKFLOW_FILE)}`);
      } catch (fErr) {
        console.warn('[n8nSync] ⚠️ Lỗi ghi file workflow vào workspace:', fErr.message);
      }
    }

    // Khởi động lại n8n container chỉ khi có thêm node mới hoặc cần refresh
    if (result.addedNodes) {
      try {
        console.log('[n8nSync] 🔄 Khởi động lại container n8n để nạp cấu hình mới...');
        execFileSync('docker', ['restart', DOCKER_CONTAINER_NAME], { stdio: 'ignore' });
        console.log('[n8nSync] ⚡ Container n8n đã sẵn sàng với các node mới cho shop!');
      } catch (rErr) {
        console.warn('[n8nSync] ⚠️ Không thể restart container n8n:', rErr.message);
      }
    }
  }

  return result;
}

module.exports = {
  syncShopToN8n,
  ensureN8nContainerRunning
};
