/**
 * Keeper record/folder grant commands (Classic + NSF).
 */

import { mapGrantError, recordOwnerError } from '../commander_errors.js';
import {
  flattenMessage,
  folderInvitationPending,
  invitationPending,
} from '../commander_helpers.js';
import {
  NSFPermissionRole,
  PERMANENT_ONLY_FOLDER_PERMISSIONS,
  PERMANENT_ONLY_NSF_ROLES,
  PERMANENT_ONLY_PERMISSIONS,
  PermissionLevel,
} from '../models.js';
import {
  formatDurationFromSeconds,
  isPamUserRecordType,
  secondsToExpireFlag,
} from '../utils.js';

/**
 * NSF `--expire-in` args. Commander treats a missing flag as "leave existing
 * expiration unchanged"; Permanent must send `never` to clear it.
 *
 * @param {number|null|undefined} durationSeconds
 * @returns {string[]} e.g. ['--expire-in', 'never'] or ['--expire-in', '1h']
 */
export function nsfExpireInFlags(durationSeconds) {
  if (durationSeconds != null) {
    const expire = secondsToExpireFlag(durationSeconds);
    if (expire) return ['--expire-in', expire];
  }
  return ['--expire-in', 'never'];
}

/**
 * Grant access — routes to share-record or nsf-share-record.
 * @param {object} options
 */
export async function grantRecordAccess(client, {
  recordUid,
  userEmail,
  permission,
  durationSeconds = null,
  rotateOnExpire = false,
  isNsf = false,
  recordType = '',
}) {
  if (isNsf) {
    return client.grantNsfRecordAccess({
      recordUid,
      userEmail,
      role: permission,
      durationSeconds,
    });
  }
  return client.grantClassicRecordAccess({
    recordUid,
    userEmail,
    permission,
    durationSeconds,
    rotateOnExpire: rotateOnExpire && isPamUserRecordType(recordType),
  });
}

/**
 * Classic share-record grant 
 */
export async function grantClassicRecordAccess(client, {
  recordUid,
  userEmail,
  permission,
  durationSeconds = null,
  rotateOnExpire = false,
}) {
  const sync = await client.syncDown();
  if (sync.error) return sync.error;

  const owner = await client.getRecordOwner(recordUid);
  if (owner && userEmail && owner.toLowerCase() === userEmail.toLowerCase()) {
    return recordOwnerError(userEmail);
  }

  if (permission === PermissionLevel.CHANGE_OWNER) {
    const ownerResult = await client.executeCommandSafe(
      `share-record ${recordUid} -e ${userEmail} -a owner --force`,
    );
    if (!ownerResult.ok) return ownerResult.error;
    if (ownerResult.data?.status === 'success') {
      return {
        success: true,
        expires_at: 'N/A (Ownership Transfer)',
        permission,
        duration: 'permanent',
      };
    }
    return {
      success: false,
      error: `Failed to transfer ownership: ${flattenMessage(ownerResult.data?.message || ownerResult.data?.error)}`,
    };
  }

  try {
    await client.executeCommandSafe(
      `share-record ${recordUid} -e ${userEmail} -a revoke --force`,
      10000,
    );
  } catch {
 // ignore revoke failures
  }

  const flags = [];
  if (
    permission === PermissionLevel.CAN_EDIT ||
    permission === PermissionLevel.EDIT_AND_SHARE
  ) {
    flags.push('-w');
  }
  if (
    permission === PermissionLevel.CAN_SHARE ||
    permission === PermissionLevel.EDIT_AND_SHARE
  ) {
    flags.push('-s');
  }

  const parts = ['share-record', recordUid, '-e', userEmail, '-a', 'grant', ...flags];
  let expiresAtStr = 'Never (Permanent)';
  const permanentOnly = PERMANENT_ONLY_PERMISSIONS.has(permission);

  if (!permanentOnly && durationSeconds != null) {
    const expire = secondsToExpireFlag(durationSeconds);
    if (expire) {
      parts.push('--expire-in', expire);
      expiresAtStr = formatDurationFromSeconds(durationSeconds);
    }
    if (rotateOnExpire) {
      parts.push('--rotate-on-expiration');
    }
  }

  parts.push('--force');
  const grantResult = await client.executeCommandSafe(parts.join(' '));
  if (!grantResult.ok) return grantResult.error;

  const data = grantResult.data || {};
  if (data.status === 'success' || invitationPending(data)) {
    if (invitationPending(data)) {
      return {
        success: true,
        invitation_sent: true,
        expires_at: 'Pending Invitation',
        permission,
        duration: 'permanent',
        message:
          'Share invitation sent. User must accept the invitation and create a Keeper account ' +
          'before they can access this record.',
      };
    }
    return {
      success: true,
      expires_at: expiresAtStr,
      permission,
      rotate_on_expire: Boolean(
        rotateOnExpire && durationSeconds != null && !permanentOnly,
      ),
    };
  }

  return mapGrantError(flattenMessage(data.message || data.error));
}

/**
 * Nested Share Folder grant via nsf-share-record.
 */
export async function grantNsfRecordAccess(client, {
  recordUid,
  userEmail,
  role,
  durationSeconds = null,
}) {
  const nsfRole = Object.values(NSFPermissionRole).includes(role)
    ? role
    : NSFPermissionRole.VIEWER;

  const sync = await client.syncDown();
  if (sync.error) return sync.error;

  const owner = await client.getRecordOwner(recordUid);
  if (owner && userEmail && owner.toLowerCase() === userEmail.toLowerCase()) {
    return recordOwnerError(userEmail);
  }

  if (nsfRole === NSFPermissionRole.TRANSFER_OWNER) {
    const ownerResult = await client.executeCommandSafe(
      `nsf-share-record ${recordUid} -e ${userEmail} -a owner -f`,
    );
    if (!ownerResult.ok) return ownerResult.error;
    if (ownerResult.data?.status === 'success') {
      return {
        success: true,
        expires_at: 'N/A (Ownership Transfer)',
        permission: nsfRole,
        duration: 'permanent',
        is_nsf: true,
      };
    }
    return {
      success: false,
      error: `Failed to transfer ownership: ${flattenMessage(ownerResult.data?.message || ownerResult.data?.error)}`,
    };
  }

  try {
    await client.executeCommandSafe(
      `nsf-share-record ${recordUid} -e ${userEmail} -a revoke -f`,
      10000,
    );
  } catch {
 // ignore
  }

  const parts = [
    'nsf-share-record',
    recordUid,
    '-e',
    userEmail,
    '-a',
    'grant',
    '-r',
    nsfRole,
  ];

  let expiresAtStr = 'Never (Permanent)';
  const permanentOnly = PERMANENT_ONLY_NSF_ROLES.has(nsfRole);
  if (!permanentOnly) {
    parts.push(...nsfExpireInFlags(durationSeconds));
    if (durationSeconds != null) {
      expiresAtStr = new Date(Date.now() + durationSeconds * 1000).toISOString();
    }
  }
  parts.push('-f');

  const grantResult = await client.executeCommandSafe(parts.join(' '));
  if (!grantResult.ok) return grantResult.error;

  const data = grantResult.data || {};
  if (invitationPending(data)) {
    return {
      success: true,
      invitation_sent: true,
      expires_at: 'Pending Invitation',
      permission: nsfRole,
      duration: 'permanent',
      is_nsf: true,
      message:
        'Share invitation sent. User must accept the invitation and create a Keeper account ' +
        'before they can access this record.',
    };
  }
  if (data.status === 'success') {
    return {
      success: true,
      expires_at: expiresAtStr,
      permission: nsfRole,
      is_nsf: true,
    };
  }
  return {
    success: false,
    error: `Failed to grant NSF access: ${flattenMessage(data.message || data.error)}`,
  };
}

/**
 * Classic share-folder grant.
 */
export async function grantFolderAccess(client, {
  folderUid,
  userEmail,
  permission,
  durationSeconds = null,
  rotateOnExpire = false,
}) {
  const sync = await client.syncDown();
  if (sync.error) return sync.error;

  const permissionFlags = [];
  if (permission === PermissionLevel.NO_PERMISSIONS) {
    permissionFlags.push('-o', 'off', '-p', 'off');
  } else if (permission === PermissionLevel.MANAGE_USERS) {
    permissionFlags.push('-o', 'on', '-p', 'off');
  } else if (permission === PermissionLevel.MANAGE_RECORDS) {
    permissionFlags.push('-o', 'off', '-p', 'on');
  } else if (permission === PermissionLevel.MANAGE_ALL) {
    permissionFlags.push('-o', 'on', '-p', 'on');
  } else {
    permissionFlags.push('-o', 'off', '-p', 'off');
  }

  const parts = [
    'share-folder',
    folderUid,
    '-e',
    userEmail,
    '-a',
    'grant',
    ...permissionFlags,
  ];

  let expiresAtStr = 'Never (Permanent)';
  const permanentOnly = PERMANENT_ONLY_FOLDER_PERMISSIONS.has(permission);
  if (!permanentOnly && durationSeconds != null) {
    const expire = secondsToExpireFlag(durationSeconds);
    if (expire) {
      parts.push('--expire-in', expire);
      expiresAtStr = formatDurationFromSeconds(durationSeconds);
    }
    if (rotateOnExpire) {
      parts.push('--rotate-on-expiration');
    }
  }
  parts.push('-f');

  const grantResult = await client.executeCommandSafe(parts.join(' '), 20000);
  if (!grantResult.ok) {
    const errText = grantResult.error?.error || 'Commander command failed';
    const mapped = mapGrantError(errText);
    if (
      mapped.error &&
      !String(mapped.error).startsWith('Failed to grant access:')
    ) {
      return mapped;
    }
    return grantResult.error;
  }

  const data = grantResult.data || {};
  if (invitationPending(data) || folderInvitationPending(data)) {
    return {
      success: true,
      invitation_sent: true,
      expires_at: 'Pending Invitation',
      permission,
      duration: 'permanent',
      message:
        'Share invitation sent. User must accept the invitation and create a Keeper account ' +
        'before they can access this folder.',
    };
  }

  if (data.status === 'success') {
    return {
      success: true,
      expires_at: expiresAtStr,
      permission,
      duration: durationSeconds != null && !permanentOnly ? 'temporary' : 'permanent',
      rotate_on_expire: Boolean(
        rotateOnExpire && durationSeconds != null && !permanentOnly,
      ),
    };
  }

  const errorMsg = flattenMessage(data.message || data.error);
  const errorLower = errorMsg.toLowerCase();
  if (
    errorLower.includes('rotation must be already set') ||
    (errorLower.includes('rotate') &&
      errorLower.includes('expiration') &&
      errorLower.includes('set on the record'))
  ) {
    return {
      success: false,
      error_code: 'pam_rotation_not_configured',
      error:
        'Rotation is not configured for this PAM User folder.\n\n' +
        'Set up rotation (Gateway + rotation settings) on the records in this folder ' +
        'in the Keeper Vault first, or uncheck Rotate credentials when access expires ' +
        'and approve again.',
    };
  }

  const isTimeLimitedConflict =
    errorLower.includes('time-limited access') &&
    (errorLower.includes('manage') ||
      errorLower.includes('re-share') ||
      errorLower.includes('managing users') ||
      errorLower.includes('restricted from managing'));
  const isUserShareFailed =
    errorLower.includes('user share') && errorLower.includes('failed');
  const managePermission = [
    PermissionLevel.MANAGE_USERS,
    PermissionLevel.MANAGE_RECORDS,
    PermissionLevel.MANAGE_ALL,
  ].includes(permission);

  if (isTimeLimitedConflict || isUserShareFailed) {
    return {
      success: false,
      error:
        'Unable to grant folder access. This user already has temporary access to this folder ' +
        'which conflicts with the selected permission level.\n\n' +
        "First remove the user's existing access, then grant the new permission.",
    };
  }
  if (data.http_status === 400 && managePermission) {
    return {
      success: false,
      error:
        'Unable to grant folder access. This user already has temporary access to this folder ' +
        'which conflicts with the selected permission level.\n\n' +
        "First remove the user's existing access, then grant the new permission.",
    };
  }

  if (data.http_status === 400) {
    return {
      success: false,
      error:
        'Unable to grant folder access. This user may have conflicting access to this folder.\n\n' +
        "First remove the user's existing access, then grant the new permission.",
    };
  }

  return mapGrantError(errorMsg);
}

/**
 * Nested Share Folder grant via nsf-share-folder.
 */
export async function grantNsfFolderAccess(client, {
  folderUid,
  userEmail,
  role,
  durationSeconds = null,
}) {
  const nsfRole = Object.values(NSFPermissionRole).includes(role)
    ? role
    : NSFPermissionRole.VIEWER;

  const sync = await client.syncDown();
  if (sync.error) return sync.error;

  const parts = [
    'nsf-share-folder',
    folderUid,
    '-e',
    userEmail,
    '-a',
    'grant',
    '-r',
    nsfRole,
  ];

  let expiresAtStr = 'Never (Permanent)';
  const permanentOnly = PERMANENT_ONLY_NSF_ROLES.has(nsfRole);
  if (!permanentOnly) {
    parts.push(...nsfExpireInFlags(durationSeconds));
    if (durationSeconds != null) {
      expiresAtStr = formatDurationFromSeconds(durationSeconds);
    }
  }

  const grantResult = await client.executeCommandSafe(parts.join(' '), 20000);
  if (!grantResult.ok) return grantResult.error;

  const data = grantResult.data || {};
  if (invitationPending(data)) {
    return {
      success: true,
      invitation_sent: true,
      expires_at: 'Pending Invitation',
      permission: nsfRole,
      duration: 'permanent',
      is_nsf: true,
      message:
        'Share invitation sent. User must accept the invitation and create a Keeper account ' +
        'before they can access this folder.',
    };
  }
  if (data.status === 'success') {
    return {
      success: true,
      expires_at: expiresAtStr,
      permission: nsfRole,
      is_nsf: true,
      duration: durationSeconds != null && !permanentOnly ? 'temporary' : 'permanent',
    };
  }

  const errorMsg = flattenMessage(data.message || data.error);
  const errorLower = errorMsg.toLowerCase();
  const isTimeLimitedConflict =
    errorLower.includes('time-limited access') &&
    (errorLower.includes('manage') ||
      errorLower.includes('re-share') ||
      errorLower.includes('share'));
  const isUserShareFailed =
    errorLower.includes('user share') && errorLower.includes('failed');
  const isAlreadyShared =
    errorLower.includes('already') &&
    (errorLower.includes('shared') || errorLower.includes('access'));

  if (isTimeLimitedConflict || isUserShareFailed || isAlreadyShared) {
    return {
      success: false,
      error:
        'Unable to grant folder access. This user already has existing access to this folder ' +
        'which conflicts with the selected permission level.\n\n' +
        "First remove the user's existing access, then grant the new permission.",
    };
  }

  return {
    success: false,
    error: `Failed to grant NSF folder access: ${errorMsg}`,
  };
}

