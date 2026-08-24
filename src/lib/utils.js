/**
 * Shared string/duration/UID/PAM utilities.
 */

import { randomUUID } from 'node:crypto';

export const MAX_IDENTIFIER_LENGTH = 200;
export const MAX_JUSTIFICATION_LENGTH = 500;

const UID_PATTERN = /^[A-Za-z0-9_-]{20,24}$/;

/**
 * Shell / injection chars for slash-command input.
 * Note: `/` is intentionally kept so path-like search terms still work.
 */
const COMMAND_UNSAFE_CHARS = /[;|&$`(){}[\]!\\\n\r\x00:]/g;

/**
 * Unsafe characters stripped from search queries.
 */
const SEARCH_UNSAFE_CHARS = /[;|&$`(){}[\]!\\\n\r\x00<>"']/g;

const DURATION_SECONDS = {
  '2m': 2 * 60,
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
 // Strip markdown wrappers from identifiers (*, _, ~, `).
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
 * Mention sanitization for Chat text.
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
 * Prevent URL injection in displayed text.
 * Removes `:` and `/` so values cannot become clickable links.
 * @param {string} text
 */
export function sanitizeHyperlinks(text) {
  if (!text) return text || '';
  return String(text).replace(/:/g, '').replace(/\//g, '');
}

/**
 * Strip shell special chars from command input.
 * Keeps `/` for path-like identifiers; strips `:` (URL scheme).
 * @param {string} text
 */
export function sanitizeCommandInput(text) {
  if (!text) return text || '';
  return String(text).replace(COMMAND_UNSAFE_CHARS, '').trim();
}

/**
 * Sanitize Commander search terms.
 * @param {string} query
 */
export function sanitizeSearchQuery(query) {
  if (!query) return '';
  return String(query).replace(SEARCH_UNSAFE_CHARS, '').trim();
}

/**
 * Input length validation.
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
 * Full slash-command sanitization.
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
 // Strip markdown wrappers before UID check.
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
  const key = String(duration || '5m').toLowerCase();
  if (key === 'permanent' || key === 'no expiration') return null;
  return DURATION_SECONDS[key] ?? 300;
}

export function formatDuration(duration) {
  const key = String(duration || '5m').toLowerCase();
  if (key === 'permanent') return 'No Expiration';
  const labels = {
    '2m': '2 minutes',
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
 * Human-readable label for a duration in seconds 
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

/**
 * Single-line value for audit logs (Slack `_collapse_for_log` parity).
 * @param {unknown} value
 * @param {string} [fallback]
 */
export function collapseForLog(value, fallback = 'N/A') {
  if (value == null) return fallback;
  const text = String(value).split(/\s+/).join(' ').trim();
  return text || fallback;
}

/**
 * Slack-style approval audit line after a successful grant / OTS create.
 * Example:
 * `Approval APR-…: Granted record access, (UID: …), for user a@x.com, approved by b@x.com, with View Only permission, for 1 hour`
 *
 * @param {{
 *   approvalId: string,
 *   requestType: string,
 *   identifier: string,
 *   requesterEmail: string,
 *   approverEmail: string,
 *   permission: string,
 *   durationText: string,
 *   rotateOnExpire?: boolean,
 *   isPam?: boolean,
 * }} opts
 */
export function formatApprovalAuditLog({
  approvalId,
  requestType,
  identifier,
  requesterEmail,
  approverEmail,
  permission,
  durationText,
  rotateOnExpire = false,
  isPam = false,
}) {
  const requestTypeText = collapseForLog(requestType).replace(/_/g, ' ');
  const action =
    requestType === 'one_time_share'
      ? 'Created one-time share'
      : `Granted ${requestTypeText} access`;

  const details = [
    `Approval ${collapseForLog(approvalId)}: ${action}`,
    `(UID: ${collapseForLog(identifier)})`,
    `for user ${collapseForLog(requesterEmail)}`,
    `approved by ${collapseForLog(approverEmail)}`,
    `with ${formatPermissionName(collapseForLog(permission, ''))} permission`,
    `for ${collapseForLog(durationText)}`,
  ];

  if (isPam && rotateOnExpire) {
    details.push('auto-rotate enabled');
  }

  return details.join(', ');
}

/**
 * Slack-style denial audit line.
 * Example:
 * `Denied [approval_id=APR-…]: record request (UID: …), requester a@x.com, denied by b@x.com, justification "…"`
 *
 * @param {{
 *   approvalId: string,
 *   requestType: string,
 *   identifier: string,
 *   requesterEmail: string,
 *   approverEmail: string,
 *   justification?: string,
 * }} opts
 */
export function formatDenialAuditLog({
  approvalId,
  requestType,
  identifier,
  requesterEmail,
  approverEmail,
  justification = '',
}) {
  const requestTypeText = collapseForLog(requestType).replace(/_/g, ' ');
  const justificationText = collapseForLog(justification, 'No justification provided');
  return (
    `Denied [approval_id=${collapseForLog(approvalId)}]: ${requestTypeText} request ` +
    `(UID: ${collapseForLog(identifier)}), requester ${collapseForLog(requesterEmail)}, ` +
    `denied by ${collapseForLog(approverEmail)}, justification "${justificationText}"`
  );
}

export function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Keeper Admin Console style in GMT (USA / Commander server time):
 * `Wed, Aug 12, 2026 @ 6:29:54 AM GMT`
 *
 * @param {Date} [date]
 */
export function formatAdminConsoleTimestamp(date = new Date()) {
  const dt = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(dt.getTime())) return String(date ?? '');

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).formatToParts(dt);

    const map = {};
    for (const part of parts) {
      if (part.type !== 'literal') map[part.type] = part.value;
    }

    return (
      `${map.weekday || ''}, ${map.month || ''} ${map.day || ''}, ${map.year || ''} @ ` +
      `${map.hour || ''}:${map.minute || '00'}:${map.second || '00'} ${map.dayPeriod || ''} GMT`
    )
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return formatTimestamp(dt);
  }
}

/**
 * Parse Commander device `date` (UTC wall time without zone) or epoch ms.
 * @param {unknown} value
 * @returns {Date|null}
 */
export function parseCommanderUtcDate(value) {
  if (value == null || value === '') return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const dt = new Date(ms);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  const raw = String(value).trim();

  // Commander table/json: "2026-08-12 06:29:54" (UTC via gmtime)
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (match) {
    const dt = new Date(
      Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6]),
      ),
    );
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  // Compact HHMMSS: "2026-08-12 062448"
  match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T]?(\d{2})(\d{2})(\d{2})$/);
  if (match) {
    const dt = new Date(
      Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6]),
      ),
    );
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    const ms = n > 1e12 ? n : n * 1000;
    const dt = new Date(ms);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  try {
    const dt = new Date(raw.replace('Z', '+00:00'));
    return Number.isNaN(dt.getTime()) ? null : dt;
  } catch {
    return null;
  }
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
