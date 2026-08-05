/**
 * Shared Commander Service Mode error helpers (Slack parity).
 */

export const COMMAND_NOT_ALLOWED = 'command_not_allowed';
export const COMMANDER_UNAUTHORIZED = 'commander_unauthorized';
export const COMMANDER_SUBMIT_FAILED = 'commander_submit_failed';
export const PAM_ROTATION_NOT_CONFIGURED = 'pam_rotation_not_configured';
export const RECORD_OWNER = 'record_owner';

export const COMMAND_NOT_ALLOWED_MESSAGE =
  'Commander rejected the command (HTTP 403).\n\n' +
  'This usually means a required command is not registered in Commander Service Mode. ' +
  'Re-run the Google Chat / Commander setup to refresh the allowlist, then restart the app.';

export const RECORD_OWNER_MESSAGE =
  'Cannot grant access to record owner. ' +
  'The user already owns this record and has access to it.';

/**
 * @param {number} statusCode
 * @returns {{ success: false, error_code: string, error: string }}
 */
export function submitError(statusCode) {
  if (statusCode === 403) {
    return {
      success: false,
      error_code: COMMAND_NOT_ALLOWED,
      error: COMMAND_NOT_ALLOWED_MESSAGE,
    };
  }
  if (statusCode === 401) {
    return {
      success: false,
      error_code: COMMANDER_UNAUTHORIZED,
      error:
        'Commander rejected the request (HTTP 401). Verify the Commander Service Mode ' +
        'API key / credentials and restart the app.',
    };
  }
  return {
    success: false,
    error_code: COMMANDER_SUBMIT_FAILED,
    error: `Failed to submit command: HTTP ${statusCode}`,
  };
}

/**
 * @param {string} userEmail
 * @returns {{ success: false, error_code: string, error: string }}
 */
export function recordOwnerError(userEmail) {
  const email = String(userEmail || '').trim();
  return {
    success: false,
    error_code: RECORD_OWNER,
    error: email
      ? `Cannot grant access to record owner (${email}). ` +
        'The user already owns this record and has access to it.'
      : RECORD_OWNER_MESSAGE,
  };
}

/**
 * Detect owner-conflict failures from structured codes or Commander text (Slack parity).
 * @param {{ error_code?: string, error?: string }|string|null|undefined} resultOrMessage
 */
export function isRecordOwnerError(resultOrMessage) {
  if (!resultOrMessage) return false;
  if (typeof resultOrMessage === 'object') {
    if (resultOrMessage.error_code === RECORD_OWNER) return true;
    return isRecordOwnerError(resultOrMessage.error || '');
  }
  const errorLower = String(resultOrMessage).toLowerCase();
  return (
    errorLower.includes('already owns this record') ||
    errorLower.includes('cannot grant access to record owner') ||
    (errorLower.includes('record owner') && errorLower.includes('already'))
  );
}

/**
 * Map Commander grant failure text into a user-facing error.
 * @param {string} errorMsg
 * @returns {{ success: false, error_code?: string, error: string }}
 */
export function mapGrantError(errorMsg) {
  const errorLower = String(errorMsg || '').toLowerCase();

  if (isRecordOwnerError(errorMsg)) {
    return {
      success: false,
      error_code: RECORD_OWNER,
      error: String(errorMsg || RECORD_OWNER_MESSAGE),
    };
  }

  const isRotationNotConfigured =
    errorLower.includes('rotation must be already set') ||
    (errorLower.includes('rotate') &&
      errorLower.includes('expiration') &&
      errorLower.includes('set on the record')) ||
    (errorLower.includes('--rotate-on-expiration') &&
      (errorLower.includes('requires') || errorLower.includes('ineligible')));

  if (isRotationNotConfigured) {
    return {
      success: false,
      error_code: PAM_ROTATION_NOT_CONFIGURED,
      error:
        'Rotation is not configured on this PAM User record.\n\n' +
        'Set up rotation (Gateway + rotation settings) on the record in the Keeper Vault first, ' +
        'or uncheck "Rotate credentials when access expires" and approve again.',
    };
  }

  if (errorLower.includes('time-limited access') && errorLower.includes('re-share')) {
    return {
      success: false,
      error:
        'Unable to grant record access. This user already has temporary access to this record ' +
        'which conflicts with the selected permission level.\n\n' +
        'First remove the user\'s existing access, then grant the new permission.',
    };
  }

  // Folder: time-limited share cannot be upgraded to manage-users / manage-all.
  if (
    errorLower.includes('time-limited access') &&
    (errorLower.includes('manage') ||
      errorLower.includes('managing users') ||
      errorLower.includes('restricted from managing'))
  ) {
    return {
      success: false,
      error:
        'Unable to grant folder access. This user already has temporary access to this folder ' +
        'which conflicts with the selected permission level.\n\n' +
        "First remove the user's existing access, then grant the new permission.",
    };
  }

  if (
    errorLower.includes('user share') &&
    errorLower.includes('failed') &&
    (errorLower.includes('time-limited') || errorLower.includes('manage'))
  ) {
    return {
      success: false,
      error:
        'Unable to grant folder access. This user already has temporary access to this folder ' +
        'which conflicts with the selected permission level.\n\n' +
        "First remove the user's existing access, then grant the new permission.",
    };
  }

  if (
    errorLower.includes('already') &&
    (errorLower.includes('shared') || errorLower.includes('access'))
  ) {
    return {
      success: false,
      error:
        'Unable to update record access. This user already has existing permissions ' +
        'that conflict with the requested permission level.\n\n' +
        'First revoke the user\'s existing access, then grant the new permission.',
    };
  }

  return {
    success: false,
    error: `Failed to grant access: ${errorMsg || 'Unknown error'}`,
  };
}

export const EDITABLE_OTS_RESTRICTED = 'editable_ots_restricted';

export const EDITABLE_OTS_RESTRICTED_MESSAGE =
  'Editable One-Time Share not allowed.\n' +
  'Your Keeper administrator has disabled editable one-time shares.\n' +
  'Retry with View Only permission, or ask your admin to allow editable external shares.';

/**
 * Map one-time-share Commander failures to clear user-facing copy.
 * @param {string} errorMsg
 * @returns {{ success: false, error_code?: string, error: string }}
 */
export function mapOneTimeShareError(errorMsg) {
  const raw = String(errorMsg || '').trim();
  const errorLower = raw.toLowerCase();

  if (
    errorLower.includes('restrict_can_edit_external_shares') ||
    (errorLower.includes('restricted') &&
      errorLower.includes('editable') &&
      errorLower.includes('one-time'))
  ) {
    return {
      success: false,
      error_code: EDITABLE_OTS_RESTRICTED,
      error: EDITABLE_OTS_RESTRICTED_MESSAGE,
    };
  }

  // Strip noisy "Unexpected error:" prefix when present.
  const cleaned = raw.replace(/^unexpected error:\s*/i, '').trim() || 'Unknown error';
  return {
    success: false,
    error: `Failed to create one-time share: ${cleaned}`,
  };
}
