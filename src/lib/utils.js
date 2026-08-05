/**
 * Shared string/duration/UID/PAM utilities.
 */

import { randomUUID } from 'node:crypto';

export const MAX_IDENTIFIER_LENGTH = 200;
export const MAX_JUSTIFICATION_LENGTH = 500;

const UID_PATTERN = /^[A-Za-z0-9_-]{20,24}$/;

/**
 * Shell / injection chars for slash-command input (Slack `sanitize_command_input`).
 * Note: `/` is intentionally kept so path-like search terms still work.
 */
const COMMAND_UNSAFE_CHARS = /[;|&$`(){}[\]!\\\n\r\x00:]/g;

/**
 * Search-query chars (Slack `KeeperClient._sanitize_search_query`).
 */
const SEARCH_UNSAFE_CHARS = /[;|&$`(){}[\]!\\\n\r\x00<>"']/g;

const DURATION_SECONDS = {
  '5m': 5 * 60,
  '10m': 10 * 60,
  '30m': 30 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '8h': 8 * 60 * 60,
  '24h': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
  '90d': 90 * 24 * 60 * 60,
};

/**
 * @param {string} argumentText
 * @returns {[string, string]}
 */
export function parseCommandText(argumentText) {
  const text = (argumentText || '').trim();
  if (!text) return ['', ''];

  const quoted = text.match(/^["']([^"']+)["']\s*(.*)$/s);
  if (quoted) {
    let identifier = quoted[1].trim();
    // Slack strips markdown wrappers from identifiers (*, _, ~, `).
    identifier = identifier.replace(/^[*_~`]+|[*_~`]+$/g, '');
    return [identifier, (quoted[2] || '').trim()];
  }

  const parts = text.split(/\s+/);
  let identifier = parts.shift() || '';
  identifier = identifier.replace(/^[*_~`]+|[*_~`]+$/g, '');
  const justification = parts.join(' ').trim();
  return [identifier, justification];
}

/**
 * Strip mention spam (@here / @channel / @everyone / @all).
 * Slack `sanitize_slack_mentions` parity (plain-text form used in Chat).
 * @param {string} text
 */
export function sanitizeMentions(text) {
  if (!text) return text || '';
  let sanitized = String(text);
  const patterns = [
    /@here\b/gi,
    /@channel\b/gi,
    /@everyone\b/gi,
    /@all\b/gi,
  ];
  for (const pattern of patterns) {
    sanitized = sanitized.replace(pattern, '');
  }
  return sanitized.trim();
}

/**
 * Prevent URL injection in displayed text (Slack `sanitize_hyperlinks`).
 * Removes `:` and `/` so values cannot become clickable links.
 * @param {string} text
 */
export function sanitizeHyperlinks(text) {
  if (!text) return text || '';
  return String(text).replace(/:/g, '').replace(/\//g, '');
}

/**
 * Strip shell special chars from command input (Slack `sanitize_command_input`).
 * Keeps `/` for path-like identifiers; strips `:` (URL scheme).
 * @param {string} text
 */
export function sanitizeCommandInput(text) {
  if (!text) return text || '';
  return String(text).replace(COMMAND_UNSAFE_CHARS, '').trim();
}

/**
 * Sanitize Commander search terms (Slack `_sanitize_search_query`).
 * @param {string} query
 */
export function sanitizeSearchQuery(query) {
  if (!query) return '';
  return String(query).replace(SEARCH_UNSAFE_CHARS, '').trim();
}

/**
 * Length check (Slack `validate_input_length`).
 * @param {string} text
 * @param {number} maxLength
 * @param {string} [fieldName]
 * @returns {[boolean, string]}
 */
export function validateInputLength(text, maxLength, fieldName = 'Input') {
  if (!text) return [true, ''];
  if (String(text).length > maxLength) {
    return [
      false,
      `${fieldName} is too long. Maximum ${maxLength} characters allowed (you have ${String(text).length}).`,
    ];
  }
  return [true, ''];
}

/**
 * Full slash-command sanitization (Slack `sanitize_user_input`).
 * Mentions → command chars → length validated first.
 * @param {string} value
 * @param {number} maxLength
 * @param {string} [fieldName]
 * @returns {[string, boolean, string]}
 */
export function sanitizeUserInput(value, maxLength, fieldName = 'Input') {
  if (!value) {
    return [value || '', true, ''];
  }
  const [lengthOk, lengthError] = validateInputLength(value, maxLength, fieldName);
  if (!lengthOk) {
    return [String(value), false, lengthError];
  }
  let cleaned = sanitizeMentions(String(value));
  cleaned = sanitizeCommandInput(cleaned);
  return [cleaned, true, ''];
}

export function isValidUid(uid) {
  // Slack strips markdown wrappers before UID check.
  const cleaned = String(uid || '').replace(/^[*_~`]+|[*_~`]+$/g, '');
  return UID_PATTERN.test(cleaned);
}

export function generateApprovalId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = randomUUID().replace(/-/g, '').slice(0, 5);
  return `APR-${date}-${suffix}`;
}

/**
 * @param {string} duration
 * @returns {number|null}
 */
export function parseDurationToSeconds(duration) {
  const key = String(duration || '1h').toLowerCase();
  if (key === 'permanent' || key === 'no expiration') return null;
  return DURATION_SECONDS[key] ?? 3600;
}

export function formatDuration(duration) {
  const key = String(duration || '1h').toLowerCase();
  if (key === 'permanent') return 'No Expiration';
  const labels = {
    '5m': '5 minutes',
    '10m': '10 minutes',
    '30m': '30 minutes',
    '1h': '1 hour',
    '4h': '4 hours',
    '8h': '8 hours',
    '24h': '24 hours',
    '7d': '7 days',
    '30d': '30 days',
    '90d': '90 days',
  };
  return labels[key] || key;
}

/**
 * Human-readable label for a duration in seconds (Slack parity).
 * @param {number|null|undefined} seconds
 */
export function formatDurationFromSeconds(seconds) {
  if (seconds == null) return 'No Expiration';
  const entry = Object.entries(DURATION_SECONDS).find(
    ([, value]) => value === seconds,
  );
  if (entry) return formatDuration(entry[0]);
  if (seconds < 3600) {
    const minutes = Math.max(1, Math.floor(seconds / 60));
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  if (seconds < 86400) {
    const hours = Math.max(1, Math.floor(seconds / 3600));
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.max(1, Math.floor(seconds / 86400));
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function formatPermissionName(permission) {
  const labels = {
    view_only: 'View Only',
    can_edit: 'Can Edit',
    can_share: 'Can Share',
    edit_and_share: 'Edit and Share',
    change_owner: 'Change Owner',
    no_permissions: 'No User Permissions',
    manage_users: 'Can Manage Users',
    manage_records: 'Can Manage Records',
    manage_all: 'Can Manage Records and Users',
    viewer: 'Viewer (read-only)',
    'share-manager': 'Share Manager',
    'content-manager': 'Content Manager',
    'content-share-manager': 'Content & Share Manager',
    'full-manager': 'Full Manager',
    owner: 'Transfer Ownership',
  };
  return labels[permission] || permission;
}

export function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Convert Commander seconds into expire/timeout flags.
 * Valid units (Keeper): years/y, months/mo, days/d, hours/h, minutes/mi.
 * @param {number|null} seconds
 */
export function secondsToExpireFlag(seconds) {
  if (seconds == null) return null;
  if (seconds % (24 * 60 * 60) === 0) return `${seconds / (24 * 60 * 60)}d`;
  if (seconds % (60 * 60) === 0) return `${seconds / (60 * 60)}h`;
  // Minutes must be "mi" — "m" is rejected ("m is not allowed as a unit")
  if (seconds % 60 === 0) return `${seconds / 60}mi`;
  return `${seconds}s`;
}

/**
 * Same unit rules as `--expire-in` (minutes = `mi`).
 * @param {number|null} seconds
 */
export function secondsToSelfDestructFlag(seconds) {
  return secondsToExpireFlag(seconds);
}

/** True if record type is any PAM type (pamUser, pamMachine, …). */
export function isPamRecordType(recordType) {
  return Boolean(recordType) && String(recordType).toLowerCase().includes('pam');
}

/** True only for pamUser (rotation flow target). */
export function isPamUserRecordType(recordType) {
  return Boolean(recordType) && String(recordType).trim().toLowerCase() === 'pamuser';
}
