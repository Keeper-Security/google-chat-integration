/**
 * Keeper Endpoint Privilege Manager (EPM) Commander commands.
 * Uses: epm sync-down, epm approval list/action.
 */

import { isValidUid } from '../utils.js';

/**
 * @param {import('./client.js').KeeperClient} client
 * @returns {Promise<boolean>}
 */
export async function syncEpmData(client) {
  try {
    const result = await client.executeCommandSafe('epm sync-down', 30000);
    if (!result.ok) {
      client.logger.error({ err: result.error }, 'Failed to submit EPM sync command');
      return false;
    }
    const data = result.data || {};
    if (String(data.status || '').toLowerCase() === 'error') {
      client.logger.error(
        { message: data.message || data.error },
        'EPM sync failed',
      );
      return false;
    }
    if (String(data.status || '').toLowerCase() === 'success') {
      client.logger.info('EPM data synced from server');
      return true;
    }
    return false;
  } catch (error) {
    client.logger.error({ err: error }, 'Exception syncing EPM data');
    return false;
  }
}

/**
 * Pending EPM requests, or null on API failure (keep seen-list intact).
 * @param {import('./client.js').KeeperClient} client
 * @returns {Promise<object[]|null>}
 */
export async function getPendingEpmRequests(client) {
  try {
    const syncSuccess = await syncEpmData(client);
    if (!syncSuccess) {
      client.logger.warn('EPM sync failed, attempting to list anyway...');
    }

    const result = await client.executeCommandSafe(
      'epm approval list --type pending --format=json',
      30000,
    );
    if (!result.ok) {
      client.logger.error({ err: result.error }, 'Failed to submit EPM list command');
      return null;
    }

    const payload = result.data || {};
    if (String(payload.status || '').toLowerCase() === 'error') {
      client.logger.error(
        { message: payload.message || payload.error },
        'EPM list command failed',
      );
      return null;
    }

    if (String(payload.status || '').toLowerCase() === 'success') {
      const data = payload.data;
      if (data == null) {
        client.logger.debug('No EPM data returned (feature may not be enabled)');
        return [];
      }
      if (Array.isArray(data)) {
        client.logger.debug({ count: data.length }, 'Retrieved pending EPM request(s)');
        return data;
      }
      client.logger.error({ type: typeof data }, 'Unexpected EPM data type');
      return null;
    }

    return null;
  } catch (error) {
    client.logger.error({ err: error }, 'Exception fetching EPM requests');
    return null;
  }
}

/**
 * @param {string} error
 */
function isAlreadyProcessedError(error) {
  if (!error) return false;
  return (
    error.includes('does not exist or cannot be modified') ||
    error.includes('Approval request does not exist')
  );
}

/**
 * @param {import('./client.js').KeeperClient} client
 * @param {string} approvalUid
 * @param {'approve'|'deny'} action
 * @returns {Promise<{ success: boolean, error?: string, already_processed?: boolean }>}
 */
async function epmApprovalAction(client, approvalUid, action) {
  const uid = String(approvalUid || '').trim();
  if (!isValidUid(uid)) {
    return { success: false, error: 'Invalid EPM approval UID' };
  }

  try {
    const flag = action === 'approve' ? '--approve' : '--deny';
    const command = `epm approval action ${flag} ${uid}`;
    if (action === 'deny') {
      client.logger.info({ approvalUid: uid }, 'Denying EPM request');
    }

    const result = await client.executeCommandSafe(command, 10000);
    if (!result.ok) {
      return {
        success: false,
        error: result.error?.error || result.error?.message || 'Commander command failed',
      };
    }

    const data = result.data || {};
    if (String(data.status || '').toLowerCase() === 'success') {
      return { success: true };
    }

    let error = data.error || data.message || 'Unknown error';
    if (typeof error !== 'string') error = String(error);

    if (isAlreadyProcessedError(error)) {
      return { success: false, error, already_processed: true };
    }
    return { success: false, error };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
}

/**
 * @param {import('./client.js').KeeperClient} client
 * @param {string} approvalUid
 */
export async function approveEpmRequest(client, approvalUid) {
  return epmApprovalAction(client, approvalUid, 'approve');
}

/**
 * @param {import('./client.js').KeeperClient} client
 * @param {string} approvalUid
 */
export async function denyEpmRequest(client, approvalUid) {
  return epmApprovalAction(client, approvalUid, 'deny');
}
