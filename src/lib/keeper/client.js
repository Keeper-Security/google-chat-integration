/**
 * Keeper Commander Service Mode client.
 * Transport + facade; domain logic lives in ./search.js, ./grants.js, ./create.js.
 */

import { submitError } from '../commander_errors.js';
import { flattenMessage, sleep } from '../commander_helpers.js';
import { getLogger } from '../logger.js';
import * as create from './create.js';
import * as device from './device.js';
import * as epm from './epm.js';
import * as grants from './grants.js';
import * as search from './search.js';

export class KeeperClient {
  /**
 * @param {object} config
 */
  constructor(config) {
    this.config = config;
    this.logger = getLogger();
    this.baseUrl = String(config.serviceUrl || '').replace(/\/?$/, '/');
    this.apiKey = config.apiKey || '';
    /** @type {string|null} */
    this._serverDomain = null;
    /** @type {Promise<string>|null} */
    this._serverDomainPromise = null;
    /** @type {boolean} */
    this._serverDomainFromCommander = false;
  }

  /** Cached vault host (default until getServerDomain resolves). */
  get serverDomain() {
    return this._serverDomain || 'keepersecurity.com';
  }

  /**
 * Resolve Keeper vault host via Commander `server` (cached).
 * @returns {Promise<string>}
 */
  async getServerDomain() {
    if (this._serverDomain) return this._serverDomain;
    if (this._serverDomainPromise) return this._serverDomainPromise;

    this._serverDomainPromise = this._fetchServerDomain()
      .then((result) => {
        this._serverDomain = result.domain;
        this._serverDomainFromCommander = result.fromCommander;
        return result.domain;
      })
      .finally(() => {
        this._serverDomainPromise = null;
      });

    return this._serverDomainPromise;
  }

  /**
 * @returns {Promise<{ domain: string, fromCommander: boolean }>}
 */
  async _fetchServerDomain() {
    const defaultDomain = 'keepersecurity.com';
    try {
      const result = await this.executeCommandSafe('server', 10000);
      if (!result.ok) {
        const errorCode = result.error?.error_code || '';
        this.logger.warn(
          {
            err: result.error,
            hint:
              errorCode === 'command_not_allowed'
                ? 'Add `server` to the Commander Service Mode allowlist, then restart.'
                : undefined,
          },
          'Failed to fetch server domain via `server` — using default keepersecurity.com',
        );
        return { domain: defaultDomain, fromCommander: false };
      }

      const data = result.data || {};
      const status = String(data.status || '').toLowerCase();
      if (status === 'success') {
        const raw = flattenMessage(data.message).trim() || defaultDomain;
        const domain = raw
          .replace(/^https?:\/\//i, '')
          .replace(/\/$/, '')
          .split(/[\s/]/)[0];
        if (domain) {
          this.logger.info(
            { serverDomain: domain },
            'Resolved Keeper server domain from Commander `server`',
          );
          return { domain, fromCommander: true };
        }
      }

      this.logger.warn(
        { data },
        'Server command returned unexpected payload — using default keepersecurity.com',
      );
      return { domain: defaultDomain, fromCommander: false };
    } catch (error) {
      this.logger.warn(
        { err: error },
        'Exception fetching server domain — using default keepersecurity.com',
      );
      return { domain: defaultDomain, fromCommander: false };
    }
  }

  headers() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['api-key'] = this.apiKey;
    return headers;
  }

  /**
   * Slack parity: GET /api/v2/queue/status (requires valid API key).
   * Unlike /health, 401/403 means bad credentials → not "accessible".
   */
  async healthCheck() {
    try {
      const response = await fetch(`${this.baseUrl}queue/status`, {
        method: 'GET',
        headers: this.headers(),
      });
      return response.status === 200;
    } catch (error) {
      this.logger.warn({ err: error }, 'Keeper health check failed');
      return false;
    }
  }

  /**
 * @param {string} command
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: true, data: object } | { ok: false, error: object }>}
 */
  async executeCommandSafe(command, timeoutMs = 15000) {
    const response = await fetch(`${this.baseUrl}executecommand-async`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ command }),
    });
    if (response.status !== 202 && !response.ok) {
      return { ok: false, error: submitError(response.status) };
    }
    if (response.status !== 202 && response.status !== 200) {
      return { ok: false, error: submitError(response.status) };
    }
    const payload = await response.json();
    const requestId = payload.request_id || payload.requestId;
    if (!requestId) {
      return {
        ok: false,
        error: { success: false, error: 'Commander response missing request_id' },
      };
    }
    try {
      const data = await this.pollResult(requestId, timeoutMs);
      return { ok: true, data };
    } catch (error) {
      return {
        ok: false,
        error: { success: false, error: error.message || String(error) },
      };
    }
  }

  /**
 * @param {string} command
 * @param {number} [timeoutMs]
 */
  async executeCommand(command, timeoutMs = 15000) {
    const result = await this.executeCommandSafe(command, timeoutMs);
    if (!result.ok) {
      throw new Error(result.error?.error || 'Commander command failed');
    }
    return result.data;
  }

  async pollResult(requestId, timeoutMs = 15000) {
    const started = Date.now();
    let delay = 300;
    while (Date.now() - started < timeoutMs) {
      const statusResponse = await fetch(`${this.baseUrl}status/${requestId}`, {
        method: 'GET',
        headers: this.headers(),
      });

      if (statusResponse.status === 404 || statusResponse.status === 202) {
        await sleep(delay);
        delay = Math.min(delay * 2, 2000);
        continue;
      }
      if (!statusResponse.ok) {
        throw new Error(`Commander status failed: HTTP ${statusResponse.status}`);
      }

      const status = await statusResponse.json();
      const state = String(status.status || status.state || '').toLowerCase();
      const errMsg = String(status.error_message || status.error || '');
      const notReadyYet =
        !status.completed_at &&
        (state === 'queued' ||
          state === 'running' ||
          state === 'pending' ||
          state === 'in_progress' ||
          /not found/i.test(errMsg));

      if (notReadyYet) {
        await sleep(delay);
        delay = Math.min(delay * 2, 2000);
        continue;
      }

      if (state === 'error' || status.error_message) {
        const resultResponse = await fetch(`${this.baseUrl}result/${requestId}`, {
          method: 'GET',
          headers: this.headers(),
        });
        if (resultResponse.status === 202 || resultResponse.status === 404) {
          return {
            status: 'error',
            message: errMsg || 'Commander command failed',
            error: errMsg || 'Commander command failed',
          };
        }
        return this._parseCommanderResultBody(
          resultResponse,
          errMsg || 'Commander command failed',
        );
      }

      const resultResponse = await fetch(`${this.baseUrl}result/${requestId}`, {
        method: 'GET',
        headers: this.headers(),
      });
      if (resultResponse.status === 202 || resultResponse.status === 404) {
        await sleep(delay);
        delay = Math.min(delay * 2, 2000);
        continue;
      }
 // 400/500 often include the real Commander error JSON for grant conflict mapping.
      if (!resultResponse.ok) {
        return this._parseCommanderResultBody(
          resultResponse,
          `Commander result failed: HTTP ${resultResponse.status}`,
        );
      }
      return resultResponse.json();
    }
    throw new Error(`Commander command timed out after ${timeoutMs}ms`);
  }

  /**
 * Parse /result body on success or error HTTP status.
 * @param {Response} resultResponse
 * @param {string} fallbackMessage
 */
  async _parseCommanderResultBody(resultResponse, fallbackMessage) {
    const httpStatus = resultResponse.status;
    try {
      const body = await resultResponse.json();
      if (body && typeof body === 'object') {
        if (body.http_status == null) body.http_status = httpStatus;
        if (!body.status && (httpStatus >= 400 || body.error || body.message)) {
          body.status = 'error';
        }
        if (!body.message && !body.error) {
          body.message = fallbackMessage;
          body.error = fallbackMessage;
        }
        return body;
      }
    } catch {
 // non-JSON body
    }
    return {
      status: 'error',
      error: fallbackMessage,
      message: fallbackMessage,
      http_status: httpStatus,
    };
  }

  async syncDown() {
    const result = await this.executeCommandSafe('sync-down', 45000);
    if (!result.ok) {
      return { success: false, error: result.error };
    }
    if (result.data?.status === 'error') {
      this.logger.warn({ message: result.data?.message }, 'sync-down failed');
      return { success: false, error: null };
    }
    return { success: result.data?.status === 'success', error: null };
  }

  async getRecordOwner(recordUid) {
    return search.getRecordOwner(this, recordUid);
  }

  async getRecordByUid(uid) {
    return search.getRecordByUid(this, uid);
  }

  async searchRecords(query, limit = 10, options = {}) {
    return search.searchRecords(this, query, limit, options);
  }

  parseSearchRecords(result, limit = 10, options = {}) {
    return search.parseSearchRecords(this, result, limit, options);
  }

  extractRecords(result) {
    return search.extractRecords(this, result);
  }

  async searchFolders(query, limit = 10) {
    return search.searchFolders(this, query, limit);
  }

  async getFolderByUid(folderUid) {
    return search.getFolderByUid(this, folderUid);
  }

  async isPamUserFolder(folderUid) {
    return search.isPamUserFolder(this, folderUid);
  }

  parseSearchFolders(result, limit = 10) {
    return search.parseSearchFolders(this, result, limit);
  }

  async grantRecordAccess({
    recordUid,
    userEmail,
    permission,
    durationSeconds = null,
    rotateOnExpire = false,
    isNsf = false,
    recordType = '',
  }) {
    return grants.grantRecordAccess(this, {
      recordUid,
      userEmail,
      permission,
      durationSeconds,
      rotateOnExpire,
      isNsf,
      recordType,
    });
  }

  async grantClassicRecordAccess({
    recordUid,
    userEmail,
    permission,
    durationSeconds = null,
    rotateOnExpire = false,
  }) {
    return grants.grantClassicRecordAccess(this, {
      recordUid,
      userEmail,
      permission,
      durationSeconds,
      rotateOnExpire,
    });
  }

  async grantNsfRecordAccess({
    recordUid,
    userEmail,
    role,
    durationSeconds = null,
    rotateOnExpire = false,
  }) {
    return grants.grantNsfRecordAccess(this, {
      recordUid,
      userEmail,
      role,
      durationSeconds,
      rotateOnExpire,
    });
  }

  async grantFolderAccess({
    folderUid,
    userEmail,
    permission,
    durationSeconds = null,
    rotateOnExpire = false,
  }) {
    return grants.grantFolderAccess(this, {
      folderUid,
      userEmail,
      permission,
      durationSeconds,
      rotateOnExpire,
    });
  }

  async grantNsfFolderAccess({
    folderUid,
    userEmail,
    role,
    durationSeconds = null,
    rotateOnExpire = false,
  }) {
    return grants.grantNsfFolderAccess(this, {
      folderUid,
      userEmail,
      role,
      durationSeconds,
      rotateOnExpire,
    });
  }

  async createOneTimeShare({
    recordUid,
    durationSeconds = 300,
    editable = false,
  }) {
    return create.createOneTimeShare(this, {
      recordUid,
      durationSeconds,
      editable,
    });
  }

  async getUserSharedFolders(userEmail) {
    return create.getUserSharedFolders(this, userEmail);
  }

  async listSubfolders(sharedFolderUid) {
    return create.listSubfolders(this, sharedFolderUid);
  }

  async createRecord({
    title,
    login = null,
    password = null,
    url = null,
    notes = null,
    generatePassword = false,
    selfDestructDuration = null,
    folderUid = null,
  }) {
    return create.createRecord(this, {
      title,
      login,
      password,
      url,
      notes,
      generatePassword,
      selfDestructDuration,
      folderUid,
    });
  }

  async createNsfRecord({
    title,
    login = null,
    password = null,
    url = null,
    notes = null,
    generatePassword = false,
    folderUid = null,
  }) {
    return create.createNsfRecord(this, {
      title,
      login,
      password,
      url,
      notes,
      generatePassword,
      folderUid,
    });
  }

  async parseCreateRecordResult(resultData, meta) {
    return create.parseCreateRecordResult(this, resultData, meta);
  }

  async syncEpmData() {
    return epm.syncEpmData(this);
  }

  async getPendingEpmRequests() {
    return epm.getPendingEpmRequests(this);
  }

  async approveEpmRequest(approvalUid) {
    return epm.approveEpmRequest(this, approvalUid);
  }

  async denyEpmRequest(approvalUid) {
    return epm.denyEpmRequest(this, approvalUid);
  }

  async getPendingDeviceApprovals() {
    return device.getPendingDeviceApprovals(this);
  }

  async approveDevice(deviceId) {
    return device.approveDevice(this, deviceId);
  }

  async denyDevice(deviceId) {
    return device.denyDevice(this, deviceId);
  }
}
