const { sendTelegramMessage, editTelegramMessage } = require('./telegram-send');

/**
 * Manages the live 5-step progress template message on Telegram.
 * 
 * Steps:
 * 1. Tải thông tin & hình ảnh sản phẩm
 * 2. Phân tích sản phẩm & lên kịch bản review
 * 3. Tạo Master Storyboard & tách panel 2 cảnh
 * 4. Sinh 2 video chuyển động AI (Google Flow)
 * 5. Xử lý hậu kỳ & tối ưu khung hình video (Crop 12%)
 * 
 * Icons:
 * - ⏳ : Đang diễn ra (running / loading)
 * - ✅ : Đã hoàn thành (completed / done)
 * - ⚪ : Đang chờ (pending)
 * - ❌ : Lỗi (failed)
 */
class FlowStepTracker {
  constructor(chatId, options = {}) {
    this.chatId = String(chatId);
    this.title = options.title || '';
    this.messageId = null;
    this.startPromise = null;
    this.steps = [
      { id: 1, name: 'Tải thông tin & hình ảnh sản phẩm', status: 'pending' },
      { id: 2, name: 'Phân tích sản phẩm & lên kịch bản review', status: 'pending' },
      { id: 3, name: 'Tạo storyboard', status: 'pending' },
      { id: 4, name: 'Tạo video', status: 'pending' },
      { id: 5, name: 'Xử lý hậu kỳ', status: 'pending' },
    ];
  }

  formatMessage() {
    const iconMap = {
      pending: '⚪',
      running: '⏳',
      completed: '✅',
      failed: '❌',
    };

    let text = '';
    if (this.title) {
      text += `📦 <b>${this.title}</b>\n`;
    }
    for (const s of this.steps) {
      const icon = iconMap[s.status] || '⚪';
      text += `${s.id}. ${icon} ${s.name}\n`;
    }
    return text.trim();
  }

  async start(initialStep = 1, detail = '') {
    if (this.messageId) return this.messageId;
    if (this.startPromise) return this.startPromise;

    const idx = initialStep - 1;
    if (this.steps[idx]) {
      this.steps[idx].status = 'running';
      if (detail) this.steps[idx].detail = detail;
    }

    this.startPromise = (async () => {
      const text = this.formatMessage();
      const res = await sendTelegramMessage(this.chatId, text, { parse_mode: 'HTML' });
      this.messageId = (typeof res === 'object' && res?.message_id) ? res.message_id : (typeof res === 'number' ? res : null);
      return this.messageId;
    })();

    return this.startPromise;
  }

  async setTitle(title) {
    if (!title || this.title === title) return;
    this.title = title;
    await this.render();
  }

  async setStep(stepIndex, status, detail = '') {
    const idx = stepIndex - 1;
    if (!this.steps[idx]) return;

    this.steps[idx].status = status;
    if (detail !== undefined) this.steps[idx].detail = detail;

    // If step is running, ensure all previous steps are marked completed
    if (status === 'running') {
      for (let i = 0; i < idx; i++) {
        if (this.steps[i].status !== 'completed') {
          this.steps[i].status = 'completed';
          this.steps[i].detail = '';
        }
      }
    }

    await this.render();
  }

  async render() {
    if (this.startPromise) await this.startPromise;
    if (!this.messageId) return;

    const text = this.formatMessage();
    await editTelegramMessage(this.chatId, this.messageId, text, { parse_mode: 'HTML' });
  }

  async completeAll() {
    for (const s of this.steps) {
      s.status = 'completed';
      s.detail = '';
    }
    await this.render();
  }

  async fail(stepIndex, errorMessage) {
    const idx = (stepIndex ? stepIndex : 1) - 1;
    if (this.steps[idx]) {
      this.steps[idx].status = 'failed';
      this.steps[idx].detail = errorMessage ? errorMessage.slice(0, 80) : 'Lỗi';
    }
    await this.render();
  }
}

module.exports = {
  FlowStepTracker,
};
