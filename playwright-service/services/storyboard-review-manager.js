'use strict';

/**
 * storyboard-review-manager.js
 *
 * Quản lý trạng thái xem trước và phê duyệt Storyboard trước khi sinh video.
 * Mỗi chatId có tối đa 1 phiên Storyboard đang chờ duyệt.
 */

const pendingReviews = new Map();

/**
 * Lưu phiên chờ duyệt Storyboard cho chatId
 * @param {string|number} chatId
 * @param {object} reviewData
 */
function setPendingReview(chatId, reviewData) {
  const key = String(chatId);
  const data = {
    ...reviewData,
    chatId: key,
    updatedAt: new Date().toISOString(),
    createdAt: reviewData.createdAt || new Date().toISOString(),
  };
  pendingReviews.set(key, data);
  return data;
}

/**
 * Lấy thông tin phiên chờ duyệt Storyboard của chatId
 * @param {string|number} chatId
 * @returns {object|null}
 */
function getPendingReview(chatId) {
  const key = String(chatId);
  return pendingReviews.get(key) || null;
}

/**
 * Kiểm tra chatId có Storyboard đang chờ duyệt hay không
 * @param {string|number} chatId
 * @returns {boolean}
 */
function hasPendingReview(chatId) {
  const key = String(chatId);
  return pendingReviews.has(key);
}

/**
 * Xóa phiên chờ duyệt sau khi đã duyệt hoặc hủy
 * @param {string|number} chatId
 * @returns {boolean}
 */
function clearPendingReview(chatId) {
  const key = String(chatId);
  return pendingReviews.delete(key);
}

/**
 * Cập nhật một panel cụ thể sau khi remake ảnh
 * @param {string|number} chatId
 * @param {number} panelIndex
 * @param {object} updatedPanelProps
 * @returns {object|null}
 */
function updatePanel(chatId, panelIndex, updatedPanelProps) {
  const review = getPendingReview(chatId);
  if (!review || !Array.isArray(review.panels)) return null;

  const idx = review.panels.findIndex(p => Number(p.index || p.panelIndex) === Number(panelIndex));
  if (idx < 0) return null;

  review.panels[idx] = {
    ...review.panels[idx],
    ...updatedPanelProps,
    index: Number(panelIndex),
    panelIndex: Number(panelIndex),
  };
  review.updatedAt = new Date().toISOString();
  return review.panels[idx];
}

module.exports = {
  setPendingReview,
  getPendingReview,
  hasPendingReview,
  clearPendingReview,
  updatePanel,
  pendingReviews,
};
