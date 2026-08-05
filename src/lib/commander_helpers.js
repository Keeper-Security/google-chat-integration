/**
 * Pure helpers for Keeper Commander Service Mode responses and CLI building.
 * Kept separate from KeeperClient so the client file stays command/transport focused.
 */

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function flattenMessage(message) {
  if (Array.isArray(message)) return message.map(String).join('\n');
  return String(message || '');
}

export function invitationPending(resultData) {
  const message = flattenMessage(resultData?.message).toLowerCase();
  const error = String(resultData?.error || '').toLowerCase();
  const combined = `${message} ${error}`;
  return (
    combined.includes('invitation has been sent') ||
    combined.includes('repeat this command when invitation is accepted')
  );
}

export function recordIsNsf(details) {
  if (!details) return false;
  for (const part of String(details).split(', ')) {
    if (part.startsWith('Record Category: ')) {
      const cat = part.replace(/^Record Category:\s*/i, '').trim().toLowerCase();
      return cat === 'keeperdrive' || cat === 'nested';
    }
  }
  return false;
}

export const FOLDER_ITEM_TYPES = new Set([
  'shared_folder',
  'nested_share_folder',
  'user_folder',
  'folder',
]);

export function folderIsNsf(folderType) {
  return String(folderType || '').trim().toLowerCase() === 'nested_share_folder';
}

export function folderInvitationPending(resultData) {
  // share-folder sometimes returns invitation text with http_status 400
  return invitationPending(resultData);
}

/**
 * Extract one-time share URL from Commander async result (Slack parity).
 * @param {object} resultData
 * @returns {string|null}
 */
export function extractOneTimeShareUrl(resultData) {
  if (!resultData || typeof resultData !== 'object') return null;

  const direct =
    resultData.url || resultData.share_url || resultData.link || resultData.shareUrl;
  if (typeof direct === 'string' && direct.startsWith('http')) {
    return direct.trim();
  }

  const message = resultData.message;
  if (typeof message === 'string') {
    if (message.trim().startsWith('http')) return message.trim();
    const match = message.match(/https:\/\/[^\s]+/);
    if (match) return match[0];
  }
  if (Array.isArray(message)) {
    for (const msg of message) {
      const text = String(msg || '');
      const keeperMatch = text.match(
        /https:\/\/keepersecurity\.com\/vault\/share[^\s]+/,
      );
      if (keeperMatch) return keeperMatch[0];
      const anyMatch = text.match(/https:\/\/[^\s]+/);
      if (anyMatch) return anyMatch[0];
    }
  }
  return null;
}

/**
 * Quote a value for Commander CLI (same rules as Slack `shlex.quote` for common cases).
 * @param {unknown} value
 */
export function shellQuote(value) {
  const s = String(value ?? '');
  if (!/[^\w@%+=:,./-]/.test(s)) return s;
  return `'${s.replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * @param {object} resultData
 * @returns {string|null}
 */
export function extractUidFromCreateResponse(resultData) {
  if (!resultData) return null;
  let uid = resultData.uid || resultData.record_uid || null;
  if (uid) return String(uid);

  const data = resultData.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    uid = data.uid || data.record_uid || null;
    if (uid) return String(uid);
  } else if (typeof data === 'string' && data.trim().length === 22) {
    return data.trim();
  }

  const message = flattenMessage(resultData.message);
  const match = message.match(/[A-Za-z0-9_-]{22}/);
  return match ? match[0] : null;
}

export function sanitizeCommanderError(errorMsg) {
  return String(errorMsg || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}
