'use strict';

/**
 * flow-queue.js
 *
 * Sequential job queue for storyboard full-flow execution.
 *
 * Design:
 *   - Photo collection (batching) happens independently and is always ready.
 *   - When a batch completes, a job is enqueued here.
 *   - Jobs are processed one at a time (maxConcurrent = 1 by default)
 *     to avoid shared-resource conflicts (browser page, uploads dir, etc.).
 *   - Each job gets a unique runId for file isolation.
 *   - Telegram status messages keep the user informed of queue position.
 */

const { sendTelegramMessage } = require('./telegram-send');

let jobCounter = 0;

class FlowQueue {
  /**
   * @param {object}  [opts]
   * @param {number}  [opts.maxConcurrent=1] - Max simultaneous jobs
   */
  constructor(opts = {}) {
    this.maxConcurrent = opts.maxConcurrent || 1;

    /** @type {Array<QueueJob>} */
    this.pending = [];

    /** @type {Map<string, QueueJob>} - runId → running job */
    this.running = new Map();
  }

  /**
   * Enqueue a new job.
   *
   * @param {object}   job
   * @param {string}   job.chatId
   * @param {Buffer[]} job.photos          - Array of photo payloads
   * @param {string}   job.baseDir
   * @param {object}   [job.templateOptions]
   * @param {Function} job.execute         - async (runId) => result
   * @param {string}   [job.label]         - Human-friendly label for messages
   * @returns {Promise<any>} resolves/rejects when the job finishes
   */
  enqueue(job) {
    jobCounter++;
    const runId = `run-${Date.now()}-${jobCounter}`;

    return new Promise((resolve, reject) => {
      /** @type {QueueJob} */
      const queueJob = {
        runId,
        chatId: job.chatId,
        label: job.label || `Album ${job.photos?.length || '?'} ảnh`,
        execute: job.execute,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      };

      this.pending.push(queueJob);

      const position = this.pending.length;
      const runningCount = this.running.size;

      if (runningCount >= this.maxConcurrent) {
        // There are jobs ahead — notify user about queue position
        console.log(`[FlowQueue] Enqueued ${runId} at position #${position} (${runningCount} running)`);
        sendTelegramMessage(
          job.chatId,
          `📋 Đã xếp hàng (vị trí #${position}). Đang chờ ${runningCount} luồng trước hoàn tất...`
        ).catch(() => {});
      } else {
        console.log(`[FlowQueue] Enqueued ${runId} — slot available, will start immediately`);
      }

      // Kick the processor (non-blocking)
      this._processNext();
    });
  }

  /**
   * Process as many pending jobs as allowed by maxConcurrent.
   * @private
   */
  _processNext() {
    while (this.running.size < this.maxConcurrent && this.pending.length > 0) {
      const job = this.pending.shift();
      this.running.set(job.runId, job);

      const waitedSec = Math.round((Date.now() - job.enqueuedAt) / 1000);
      const waitMsg = waitedSec > 2 ? ` (chờ ${waitedSec}s)` : '';

      console.log(`[FlowQueue] ▶️  Starting ${job.runId} — ${job.label}${waitMsg}`);

      // Run the job
      job.execute(job.runId)
        .then(result => {
          console.log(`[FlowQueue] ✅ Completed ${job.runId}`);
          job.resolve(result);
        })
        .catch(err => {
          console.error(`[FlowQueue] ❌ Failed ${job.runId}: ${err.message}`);
          job.reject(err);
        })
        .finally(() => {
          this.running.delete(job.runId);
          // Process next job in queue
          this._processNext();
        });
    }
  }

  /**
   * Returns a status snapshot of the queue.
   * @returns {{ running: Array, pending: Array, summary: string }}
   */
  getStatus() {
    const runningJobs = [...this.running.values()].map(j => ({
      runId: j.runId,
      chatId: j.chatId,
      label: j.label,
      runningSec: Math.round((Date.now() - j.enqueuedAt) / 1000),
    }));

    const pendingJobs = this.pending.map((j, i) => ({
      position: i + 1,
      chatId: j.chatId,
      label: j.label,
      waitingSec: Math.round((Date.now() - j.enqueuedAt) / 1000),
    }));

    let summary = '';
    if (runningJobs.length === 0 && pendingJobs.length === 0) {
      summary = '✅ Không có luồng nào đang chạy hoặc chờ xử lý.';
    } else {
      const parts = [];
      if (runningJobs.length > 0) {
        parts.push(`🔄 Đang chạy: ${runningJobs.length} luồng`);
        for (const j of runningJobs) {
          parts.push(`  • ${j.label} (${j.runningSec}s)`);
        }
      }
      if (pendingJobs.length > 0) {
        parts.push(`⏳ Đang chờ: ${pendingJobs.length} luồng`);
        for (const j of pendingJobs) {
          parts.push(`  #${j.position}: ${j.label} (đợi ${j.waitingSec}s)`);
        }
      }
      summary = parts.join('\n');
    }

    return { running: runningJobs, pending: pendingJobs, summary };
  }
}

// Singleton instance — shared across the application.
// Default: 3 concurrent flows. Override via FLOW_MAX_CONCURRENT env var.
const maxConcurrent = Math.max(1, parseInt(process.env.FLOW_MAX_CONCURRENT || '3', 10));
const flowQueue = new FlowQueue({ maxConcurrent });
console.log(`[FlowQueue] Initialized with maxConcurrent = ${maxConcurrent}`);

module.exports = {
  flowQueue,
  FlowQueue,
};
