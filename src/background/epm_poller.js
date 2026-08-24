/**
 * Background polling for EPM elevation approval requests.
 */

import { buildEpmApprovalCard } from '../lib/cards/epm.js';
import { EpmRequest } from '../lib/models.js';
import { getLogger } from '../lib/logger.js';

export class EpmPoller {
  /**
 * @param {object} options
 * @param {import('../lib/chat_client.js').ChatClient} options.chatClient
 * @param {import('../lib/keeper/client.js').KeeperClient} options.keeperClient
 * @param {ReturnType<import('../lib/config.js').loadConfig>} options.config
 * @param {number} [options.intervalSec]
 */
  constructor({ chatClient, keeperClient, config, intervalSec = 120 }) {
    this.chatClient = chatClient;
    this.keeperClient = keeperClient;
    this.config = config;
    this.intervalSec = Math.max(15, Number(intervalSec) || 120);
    /** @type {Set<string>} */
    this.seenApprovalUids = new Set();
    this.running = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._timer = null;
    this.logger = getLogger();
  }

  start() {
    if (this.running) {
      this.logger.warn('EPM poller already running');
      return;
    }
    this.logger.info('Starting EPM poller (background)...');
    this.running = true;
    this._schedule(0);
    this.logger.ok(`EPM poller started (interval: ${this.intervalSec}s)`);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.logger.info('EPM poller stopped');
  }

  /**
 * @param {number} delayMs
 */
  _schedule(delayMs) {
    if (!this.running) return;
    this._timer = setTimeout(() => this._tick(), delayMs);
  }

  async _tick() {
    if (!this.running) return;
    try {
      await this._checkAndPostNewRequests();
      this._consecutiveErrors = 0;
    } catch (error) {
      this._consecutiveErrors = (this._consecutiveErrors || 0) + 1;
      const maxErrors = 3;
      this.logger.error(
        {
          err: error,
          consecutive: this._consecutiveErrors,
          maxErrors,
        },
        'EPM polling error',
      );
      if (this._consecutiveErrors >= maxErrors) {
        this.logger.warn(
          'EPM polling stopped (feature may not be available or configured)',
        );
        this.running = false;
        return;
      }
    }
    this._schedule(this.intervalSec * 1000);
  }

  async _checkAndPostNewRequests() {
    const pending = await this.keeperClient.getPendingEpmRequests();

 // null = API failure/timeout — keep seen list intact 
    if (pending == null) {
      this.logger.debug('EPM API failed/timed out, keeping seen list intact');
      return;
    }

    if (pending.length === 0) {
      if (this.seenApprovalUids.size) {
        this.logger.debug('No pending EPM requests, clearing seen list');
        this.seenApprovalUids.clear();
      }
      return;
    }

    const currentUids = new Set();
    /** @type {object[]} */
    const newRequests = [];

    for (const requestData of pending) {
      const approvalUid = requestData?.approval_uid;
      if (!approvalUid) continue;
      currentUids.add(approvalUid);
      if (!this.seenApprovalUids.has(approvalUid)) {
        newRequests.push(requestData);
        this.seenApprovalUids.add(approvalUid);
        this.logger.info({ approvalUid }, 'New EPM request detected');
      }
    }

    if (newRequests.length) {
      this.logger.info(
        { count: newRequests.length },
        'Posting new EPM request(s) to Google Chat',
      );
      for (const requestData of newRequests) {
        try {
          await this._postRequest(requestData);
        } catch (error) {
          this.logger.error(
            { err: error, approvalUid: requestData?.approval_uid },
            'Failed to post EPM request',
          );
        }
      }
    }

    for (const uid of [...this.seenApprovalUids]) {
      if (!currentUids.has(uid)) this.seenApprovalUids.delete(uid);
    }
  }

  /**
 * @param {object} requestData
 */
  async _postRequest(requestData) {
    const approvalsSpace = this.config.chat?.approvalsSpaceId;
    if (!approvalsSpace) {
      this.logger.error(
        'Cannot post EPM request — chat.approvals_space_id is not configured',
      );
      return;
    }

    const request = EpmRequest.fromDict(requestData);
    if (!request.approvalUid) {
      this.logger.error('EPM request missing approval_uid');
      return;
    }

    await this.chatClient.postMessage({
      parent: approvalsSpace,
      message: {
        text: `EPM Approval Request from ${request.username || 'Unknown'}`,
        cardsV2: buildEpmApprovalCard(request),
      },
    });
    this.logger.info(
      { approvalUid: request.approvalUid },
      'Posted EPM request to Google Chat',
    );
  }
}
