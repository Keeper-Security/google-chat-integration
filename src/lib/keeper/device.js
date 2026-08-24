/**
 * Cloud SSO device approval Commander commands.
 * Uses: device-approve --reload / --approve / --deny
 */

/**
 * Safe device IDs for Commander CLI interpolation.
 * @param {string} deviceId
 */
export function isSafeDeviceId(deviceId) {
  const id = String(deviceId || '').trim();
  return /^[A-Za-z0-9_.-]{1,128}$/.test(id);
}

/**
 * Pending device approvals. Returns [] on failure (clears poller seen-set).
 * @param {import('./client.js').KeeperClient} client
 * @returns {Promise<object[]>}
 */
export async function getPendingDeviceApprovals(client) {
  try {
    const result = await client.executeCommandSafe(
      'device-approve --reload --format=json',
      30000,
    );
    if (!result.ok) {
      client.logger.error(
        { err: result.error },
        'Failed to submit device-approve command',
      );
      return [];
    }

    const payload = result.data || {};
    if (String(payload.status || '').toLowerCase() === 'error') {
      client.logger.error(
        { message: payload.message || payload.error },
        'Device approval command failed',
      );
      return [];
    }

    if (String(payload.status || '').toLowerCase() === 'success') {
      const data = payload.data;
      if (data == null) {
        client.logger.debug('No pending device approvals');
        return [];
      }
      if (Array.isArray(data)) {
        client.logger.debug(
          { count: data.length },
          'Retrieved pending device approval(s)',
        );
        return data;
      }
      client.logger.error(
        { type: typeof data },
        'Unexpected device approval data type',
      );
      return [];
    }

    return [];
  } catch (error) {
    client.logger.error({ err: error }, 'Exception fetching device approvals');
    return [];
  }
}

/**
 * @param {import('./client.js').KeeperClient} client
 * @param {string} deviceId
 * @param {'approve'|'deny'} action
 * @returns {Promise<{ success: boolean, error?: string, already_handled?: boolean }>}
 */
async function deviceApprovalAction(client, deviceId, action) {
  const id = String(deviceId || '').trim();
  if (!isSafeDeviceId(id)) {
    return { success: false, error: 'Invalid device ID' };
  }

  try {
    const flag = action === 'approve' ? '--approve' : '--deny';
    const command = `device-approve ${flag} ${id}`;
    client.logger.info(
      { deviceId: id },
      action === 'approve' ? 'Approving device' : 'Denying device',
    );

    const result = await client.executeCommandSafe(command, 10000);
    if (!result.ok) {
      return {
        success: false,
        error:
          result.error?.error ||
          result.error?.message ||
          'Commander command failed',
      };
    }

    const data = result.data || {};
    if (String(data.status || '').toLowerCase() === 'success') {
      const message = String(data.message || '');
      // Success payload can still mean "already processed"
      if (message.toLowerCase().includes('no pending devices')) {
        client.logger.warn(
          { deviceId: id },
          'Device was already processed',
        );
        return {
          success: false,
          already_handled: true,
          error: 'This device request was already processed',
        };
      }
      return { success: true };
    }

    let error = data.error || data.message || 'Unknown error';
    if (typeof error !== 'string') error = String(error);
    return { success: false, error };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
}

/**
 * @param {import('./client.js').KeeperClient} client
 * @param {string} deviceId
 */
export async function approveDevice(client, deviceId) {
  return deviceApprovalAction(client, deviceId, 'approve');
}

/**
 * @param {import('./client.js').KeeperClient} client
 * @param {string} deviceId
 */
export async function denyDevice(client, deviceId) {
  return deviceApprovalAction(client, deviceId, 'deny');
}
