'use strict';

/**
 * test/test-proxy-rotation.js
 *
 * Kiểm tra toàn diện quy trình xoay proxy ưu tiên mặc định (DIRECT-first) với cooldown 1 tiếng:
 * 1. Khởi động mặc định là DIRECT (Không dùng proxy).
 * 2. Khi DIRECT bị lỗi -> kích hoạt cooldown 1 tiếng, chuyển sang dùng Proxy.
 * 3. Trong 1 tiếng đó -> tiếp tục dùng proxy (nếu proxy lỗi thì xoay tiếp 1, 2... 20).
 * 4. Đủ 1 tiếng -> tự động quay lại thử DIRECT, ghi nhớ vị trí proxy vừa dùng (proxy 20).
 * 5. Nếu DIRECT bị lỗi tiếp -> kích hoạt 1 tiếng mới, tiếp tục proxy 21.
 * 6. Nếu DIRECT không lỗi -> giữ nguyên DIRECT.
 * 7. Đang dùng DIRECT mà sau này lỗi -> tiếp tục proxy 22.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Thiết lập môi trường test
const originalCooldown = process.env.DIRECT_COOLDOWN_MS;
process.env.DIRECT_COOLDOWN_MS = '3600000'; // 1 tiếng chuẩn (3,600,000 ms)

const proxyBridge = require('../services/proxy-bridge');

console.log('🧪 Starting Direct-First Proxy Rotation Test Suite...\n');

// Reset trạng thái về DIRECT sạch ban đầu
const statePath = path.join(__dirname, '../assets/proxy-state.json');
fs.writeFileSync(statePath, JSON.stringify({
  isDirect: true,
  lastProxyIndex: 0,
  hasUsedProxy: false,
  directFailedAt: null,
  directCooldownMs: 3600000,
  host: 'DIRECT (No Proxy)',
  port: 0,
  proxyCount: 50,
  total: 51,
  updatedAt: new Date().toISOString(),
}, null, 2), 'utf8');
proxyBridge.switchToDirect();

// ── Test 1: Khởi động ưu tiên MẶC ĐỊNH (DIRECT) ───────────────────────────
console.log('--- Test 1: Khởi động mặc định là DIRECT ---');
const initial = proxyBridge.getActiveProxy();
assert.strictEqual(initial.isDirect, true, 'Ban đầu phải là DIRECT (isDirect = true)');
assert.strictEqual(initial.host, 'DIRECT (No Proxy)', 'Host ban đầu phải là DIRECT');
console.log('✅ Test 1 Passed: Hệ thống khởi động mặc định ở chế độ DIRECT (Không dùng proxy)');

// ── Test 2: DIRECT bị lỗi -> Bắt đầu 1 tiếng cooldown, chuyển sang Proxy #1 ──
console.log('\n--- Test 2: DIRECT bị lỗi lần đầu -> Cooldown 1 tiếng, dùng Proxy #1 ---');
const afterDirectFail = proxyBridge.rotateProxy();
assert.strictEqual(afterDirectFail.isDirect, false, 'Khi DIRECT lỗi, phải chuyển sang PROXY');
assert.strictEqual(afterDirectFail.index, 0, 'Lần đầu tiên lỗi phải dùng Proxy #1 (index 0)');
console.log(`✅ Test 2 Passed: DIRECT lỗi -> Chuyển sang Proxy #${afterDirectFail.index + 1}/${afterDirectFail.proxyCount} (${afterDirectFail.host}:${afterDirectFail.port})`);

// ── Test 3: Trong 1 tiếng cooldown, proxy lỗi thì tiếp tục xoay tới Proxy #20 ──
console.log('\n--- Test 3: Xoay proxy tuần tự trong thời gian cooldown tới Proxy #20 ---');
for (let i = 1; i < 20; i++) {
  const p = proxyBridge.rotateProxy();
  assert.strictEqual(p.isDirect, false, 'Vẫn phải đang ở chế độ PROXY trong thời gian cooldown');
  assert.strictEqual(p.index, i, `Phải chuyển tuần tự tới index ${i}`);
}
const p20 = proxyBridge.getActiveProxy();
assert.strictEqual(p20.index, 19, 'Đang sử dụng Proxy #20 (index 19)');
console.log(`✅ Test 3 Passed: Đang sử dụng Proxy #${p20.index + 1} (index ${p20.index}) đúng như kịch bản`);

// ── Test 4: Đủ 1 tiếng kể từ lúc DIRECT lỗi -> Tự động quay lại MẶC ĐỊNH (DIRECT) ──
console.log('\n--- Test 4: Đủ 1 tiếng -> Tự động quay lại MẶC ĐỊNH (DIRECT), ghi nhớ Proxy #20 ---');
// Giả lập trôi qua 1 tiếng 1 phút (3,660,000 ms)
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.directFailedAt = Date.now() - 3660000; // đã qua 61 phút
fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

// Khi có request kiểm tra hoặc lấy proxy:
const activeAfter1Hour = proxyBridge.getActiveProxy();
assert.strictEqual(activeAfter1Hour.isDirect, true, 'Sau 1 tiếng phải tự động quay lại MẶC ĐỊNH (DIRECT)');
assert.strictEqual(activeAfter1Hour.index, 19, 'Vị trí Proxy #20 (index 19) phải được ghi nhớ');
console.log('✅ Test 4 Passed: Đủ 1 tiếng -> Tự động quay lại MẶC ĐỊNH (DIRECT), vị trí Proxy #20 được ghi nhớ');

// ── Test 5: Nếu MẶC ĐỊNH bị lỗi tiếp -> Quay lại tiếp tục Proxy #21 ─────────
console.log('\n--- Test 5: MẶC ĐỊNH bị lỗi tiếp -> Kích hoạt cooldown 1 tiếng mới, tiếp tục Proxy #21 ---');
const afterDirectFailAgain = proxyBridge.rotateProxy();
assert.strictEqual(afterDirectFailAgain.isDirect, false, 'DIRECT bị lỗi tiếp phải quay lại PROXY');
assert.strictEqual(afterDirectFailAgain.index, 20, 'Phải tiếp tục sang Proxy #21 (index 20), KHÔNG được quay về Proxy #1');
console.log(`✅ Test 5 Passed: DIRECT lỗi tiếp -> Tự động kích hoạt 1 tiếng cooldown mới và chuyển sang Proxy #${afterDirectFailAgain.index + 1}/${afterDirectFailAgain.proxyCount}`);

// ── Test 6: Đủ 1 tiếng nữa -> Quay lại MẶC ĐỊNH (DIRECT) ───────────────────
console.log('\n--- Test 6: Đủ 1 tiếng thứ hai -> Quay lại MẶC ĐỊNH (DIRECT) ---');
const state2 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state2.directFailedAt = Date.now() - 3660000;
fs.writeFileSync(statePath, JSON.stringify(state2, null, 2), 'utf8');

const activeAfter2ndHour = proxyBridge.getActiveProxy();
assert.strictEqual(activeAfter2ndHour.isDirect, true, 'Đã đủ 1 tiếng -> Quay lại DIRECT');
assert.strictEqual(activeAfter2ndHour.index, 20, 'Ghi nhớ Proxy #21 (index 20)');
console.log('✅ Test 6 Passed: Đủ 1 tiếng -> Quay lại DIRECT thành công');

// ── Test 7: MẶC ĐỊNH KHÔNG LỖI -> Tiếp tục sử dụng MẶC ĐỊNH ───────────────
console.log('\n--- Test 7: MẶC ĐỊNH không lỗi -> Tiếp tục giữ nguyên MẶC ĐỊNH ---');
const req1 = proxyBridge.getActiveProxy();
const req2 = proxyBridge.getActiveProxy();
assert.strictEqual(req1.isDirect, true);
assert.strictEqual(req2.isDirect, true);
console.log('✅ Test 7 Passed: Mặc định không lỗi -> Các request tiếp theo tiếp tục chạy trên DIRECT');

// ── Test 8: Đang dùng MẶC ĐỊNH mà sau này bị lỗi -> Tiếp tục Proxy #22 ────
console.log('\n--- Test 8: Đang dùng MẶC ĐỊNH mà bị lỗi -> Tiếp tục Proxy #22 (index 21) ---');
const afterLaterFail = proxyBridge.rotateProxy();
assert.strictEqual(afterLaterFail.isDirect, false, 'Chuyển sang PROXY');
assert.strictEqual(afterLaterFail.index, 21, 'Phải tiếp tục sang Proxy #22 (index 21)');
console.log(`✅ Test 8 Passed: Mặc định lỗi -> Tiếp tục chuyển sang Proxy #${afterLaterFail.index + 1}/${afterLaterFail.proxyCount}`);

// Dọn dẹp trạng thái test
proxyBridge.switchToDirect();
if (originalCooldown) {
  process.env.DIRECT_COOLDOWN_MS = originalCooldown;
} else {
  delete process.env.DIRECT_COOLDOWN_MS;
}

console.log('\n🎉 ALL 8 ROTATE PROXY DIRECT-FIRST TESTS PASSED 100% SUCCESSFULLY!');
