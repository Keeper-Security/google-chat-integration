/**
 * EPM privilege-elevation approval cards.
 */

import { BTN, escapeHtmlText } from './shared.js';
import {
  formatAdminConsoleTimestamp,
  sanitizeHyperlinks,
} from '../utils.js';

/**
 * @param {string} text
 * @param {number} [maxLength]
 */
function truncateText(text, maxLength = 150) {
  if (!text) return text || '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

/**
 * @param {string|null|undefined} iso
 */
function formatIsoTimestamp(iso) {
  if (!iso) return formatAdminConsoleTimestamp(new Date());
  try {
    const dt = new Date(String(iso).replace('Z', '+00:00'));
    if (Number.isNaN(dt.getTime())) return String(iso);
    return formatAdminConsoleTimestamp(dt);
  } catch {
    return String(iso);
  }
}

/**
 * @param {import('../models.js').EpmRequest} request
 */
function formatExpires(request) {
  try {
    const createdDt = new Date(String(request.created).replace('Z', '+00:00'));
    if (Number.isNaN(createdDt.getTime())) {
      return `${request.expireIn} minutes from creation`;
    }
    const expiresDt = new Date(createdDt.getTime() + request.expireIn * 60 * 1000);
    return formatAdminConsoleTimestamp(expiresDt);
  } catch {
    return `${request.expireIn} minutes from creation`;
  }
}

/**
 * Command details as separate widgets so Chat HTML does not swallow
 * hyphenated args (e.g. `google-dir-main`).
 * @param {import('../models.js').EpmRequest} request
 */
function buildCommandDetailWidgets(request) {
  const codeLine = (label, value) => ({
    textParagraph: {
      text: `<b>${label}:</b><br><code>${escapeHtmlText(value || '')}</code>`,
    },
  });
  const textLine = (label, value) => ({
    textParagraph: {
      text: `<b>${label}:</b> ${escapeHtmlText(value || '')}`,
    },
  });

  if (request.approvalType === 'CommandLine') {
    return [
      codeLine('Executable', request.fileName),
      codeLine('Path', request.filePath),
      codeLine('Command', request.command),
      textLine('Description', request.description),
    ];
  }

  let fullPath = 'Unknown';
  if (request.filePath && request.fileName) {
    const pathSeparator =
      request.filePath.includes('\\') || request.filePath.includes(':') ? '\\' : '/';
    fullPath = `${request.filePath}${pathSeparator}${request.fileName}`;
  } else if (request.command) {
    fullPath = request.command;
  }

  return [
    codeLine('Executable', truncateText(request.fileName)),
    codeLine('Path', truncateText(request.filePath)),
    codeLine('Full Path', truncateText(fullPath)),
    textLine('Description', truncateText(request.description)),
  ];
}

/**
 * @param {import('../models.js').EpmRequest} request
 * @param {{ statusHtml?: string|null, includeActions?: boolean }} [options]
 */
export function buildEpmApprovalCard(request, options = {}) {
  const includeActions = options.includeActions !== false;
  const statusHtml = options.statusHtml || null;

  const safeUid = escapeHtmlText(request.approvalUid);
  const safeUser = escapeHtmlText(request.username || 'Unknown');
  const safeType = escapeHtmlText(request.approvalType || 'Unknown');
  const safeAgent = escapeHtmlText(request.agentUid || '');
  const expiresStr = escapeHtmlText(formatExpires(request));
  const createdStr = escapeHtmlText(formatIsoTimestamp(request.created));

  const commandWidgets = buildCommandDetailWidgets(request);

  const rawJustification = request.justification
    ? sanitizeHyperlinks(request.justification)
    : '';
  const justificationHtml = rawJustification
    ? escapeHtmlText(rawJustification)
    : '<i>No justification provided</i>';

  /** @type {object[]} */
  const sections = [
    {
      widgets: [
        {
          textParagraph: {
            text:
              `<b>User:</b> ${safeUser}<br>` +
              `<b>Request ID:</b> <code>${safeUid}</code><br>` +
              `<b>Type:</b> ${safeType}<br>` +
              `<b>Expires:</b> ${expiresStr}<br>` +
              `<b>Created:</b> ${createdStr}<br>` +
              `<b>Agent UID:</b> <code>${safeAgent}</code>`,
          },
        },
      ],
    },
    {
      header: 'Command Details',
      widgets: commandWidgets,
    },
    {
      widgets: [
        {
          textParagraph: {
            text: `<b>Justification:</b><br>${justificationHtml}`,
          },
        },
      ],
    },
  ];

  if (statusHtml) {
    sections.push({
      widgets: [{ textParagraph: { text: statusHtml } }],
    });
  }

  if (includeActions) {
    const params = [
      { key: 'approval_uid', value: request.approvalUid },
      { key: 'username', value: request.username || '' },
      { key: 'approval_type', value: request.approvalType || '' },
    ];
    sections.push({
      widgets: [
        {
          buttonList: {
            buttons: [
              {
                text: 'Approve',
                color: BTN.approve,
                onClick: {
                  action: {
                    function: 'approve_epm_request',
                    parameters: [
                      ...params,
                      { key: '__action', value: 'approve_epm_request' },
                    ],
                  },
                },
              },
              {
                text: 'Deny',
                color: BTN.deny,
                onClick: {
                  action: {
                    function: 'deny_epm_request',
                    parameters: [
                      ...params,
                      { key: '__action', value: 'deny_epm_request' },
                    ],
                  },
                },
              },
            ],
          },
        },
      ],
    });
  }

  return [
    {
      cardId: `epm-${request.approvalUid}`,
      card: {
        header: { title: 'Privilege Elevation Approval Request' },
        sections,
      },
    },
  ];
}

/**
 * @param {import('../models.js').EpmRequest} request
 * @param {string} statusHtml
 */
export function buildEpmStatusCard(request, statusHtml) {
  return buildEpmApprovalCard(request, {
    includeActions: false,
    statusHtml,
  });
}
