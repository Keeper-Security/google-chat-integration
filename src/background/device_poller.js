/**
 * Background polling for Cloud SSO device approval requests.
 */

import { buildDeviceApprovalCard } from '../lib/cards/device.js';
import { getLogger } from '../lib/logger.js';

export class DeviceApprovalPoller {
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
    this.seenDeviceIds = new Set();
    this.running = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._timer = null;
    this.logger = getLogger();
  }

  start() {
    if (this.running) {
      this.logger.warn('Device approval poller already running');
      return;
    }
    this.logger.info('Starting Cloud SSO Device Approval poller (background)...');
    this.running = true;
    this._schedule(0);
    this.logger.ok(
      `Cloud SSO Device Approval poller started (interval: ${this.intervalSec}s)`,
    );
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.logger.info('Cloud SSO Device Approval poller stopped');
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
        'Device approval polling error',
      );
      if (this._consecutiveErrors >= maxErrors) {
        this.logger.warn(
          'Device approval polling stopped (feature may not be available)',
        );
        this.running = false;
        return;
      }
    }
    this._schedule(this.intervalSec * 1000);
  }

  async _checkAndPostNewRequests() {
    const pending = await this.keeperClient.getPendingDeviceApprovals();

    // Empty / falsy (including API failure returning []) clears seen list
    if (!pending || pending.length === 0) {
      if (this.seenDeviceIds.size) {
        this.logger.debug('No pending device approvals, clearing seen list');
        this.seenDeviceIds.clear();
      }
      return;
    }

    const currentIds = new Set();
    /** @type {object[]} */
    const newRequests = [];

    for (const deviceData of pending) {
      const deviceId = deviceData?.device_id;
      if (!deviceId) continue;
      currentIds.add(deviceId);
      if (!this.seenDeviceIds.has(deviceId)) {
        newRequests.push(deviceData);
        this.seenDeviceIds.add(deviceId);
        this.logger.info(
          {
            deviceId,
            deviceName: deviceData?.device_name || 'Unknown',
          },
          'New device approval request',
        );
      }
    }

    if (newRequests.length) {
      this.logger.info(
        { count: newRequests.length },
        'Posting new device approval(s) to Google Chat',
      );
      for (const deviceData of newRequests) {
        try {
          await this._postRequest(deviceData);
        } catch (error) {
          this.logger.error(
            { err: error, deviceId: deviceData?.device_id },
            'Failed to post device approval',
          );
        }
      }
    }

    for (const id of [...this.seenDeviceIds]) {
      if (!currentIds.has(id)) this.seenDeviceIds.delete(id);
    }
  }

  /**
   * @param {object} deviceData
   */
  async _postRequest(deviceData) {
    const approvalsSpace = this.config.chat?.approvalsSpaceId;
    if (!approvalsSpace) {
      this.logger.error(
        'Cannot post device approval — chat.approvals_space_id is not configured',
      );
      return;
    }

    const deviceId = deviceData?.device_id;
    if (!deviceId) {
      this.logger.error('Device approval missing device_id');
      return;
    }

    const email = deviceData.email || 'Unknown';
    const deviceName = deviceData.device_name || 'Unknown Device';

    await this.chatClient.postMessage({
      parent: approvalsSpace,
      message: {
        text: `Cloud SSO Device Approval Request from ${email} - ${deviceName}`,
        cardsV2: buildDeviceApprovalCard(deviceData),
      },
    });
    this.logger.info(
      { deviceId },
      'Posted device approval request to Google Chat',
    );
  }
}
