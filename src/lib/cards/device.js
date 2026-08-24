/**
 * Cloud SSO device approval cards.
 */

import { BTN, escapeHtmlText } from './shared.js';
import {
  formatAdminConsoleTimestamp,
  parseCommanderUtcDate,
  sanitizeHyperlinks,
} from '../utils.js';

/**
 * Format Commander device `date` like Keeper Admin Console (GMT):
 * `Wed, Aug 12, 2026 @ 6:29:54 AM GMT`
 *
 * Commander emits UTC wall time; we convert to the display timezone.
 * Do not run sanitizeHyperlinks on the result — it strips `:` from the time.
 *
 * @param {unknown} value
 */
export function formatDeviceRequestDate(value) {
  if (value == null || value === '') return 'Unknown';
  const dt = parseCommanderUtcDate(value);
  if (!dt) return String(value);
  return formatAdminConsoleTimestamp(dt);
}

/**
 * @param {object} deviceData
 * @param {{ statusHtml?: string|null, includeActions?: boolean }} [options]
 */
export function buildDeviceApprovalCard(deviceData = {}, options = {}) {
  const includeActions = options.includeActions !== false;
  const statusHtml = options.statusHtml || null;

  const deviceId = String(deviceData.device_id || 'Unknown');
  const deviceName = String(deviceData.device_name || 'Unknown Device');
  const deviceType = String(deviceData.device_type || 'Unknown');
  const clientVersion = String(deviceData.client_version || 'Unknown');
  const email = String(deviceData.email || 'Unknown');
  const ipAddress = String(deviceData.ip_address || 'Unknown');
  const requestDate = formatDeviceRequestDate(deviceData.date);

  const safe = (value) =>
    escapeHtmlText(sanitizeHyperlinks(String(value ?? '')));

  /** @type {object[]} */
  const sections = [
    {
      widgets: [
        {
          textParagraph: {
            text:
              `<b>User Email:</b> ${safe(email)}<br>` +
              `<b>Device ID:</b> <code>${escapeHtmlText(deviceId)}</code><br>` +
              `<b>Device Name:</b> ${safe(deviceName)}<br>` +
              `<b>Device Type:</b> ${safe(deviceType)}<br>` +
              `<b>Client Version:</b> ${safe(clientVersion)}<br>` +
              `<b>IP Address:</b> <code>${escapeHtmlText(ipAddress)}</code>`,
          },
        },
      ],
    },
    {
      widgets: [
        {
          textParagraph: {
            // Escape only — sanitizeHyperlinks would strip `:` from the time.
            text: `<font color="#666666"><b>Requested:</b> ${escapeHtmlText(requestDate)}</font>`,
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
      { key: 'device_id', value: deviceId },
      { key: 'device_name', value: deviceName },
      { key: 'email', value: email },
    ];
    sections.push({
      widgets: [
        {
          buttonList: {
            buttons: [
              {
                text: 'Approve Device',
                color: BTN.approve,
                onClick: {
                  action: {
                    function: 'approve_device',
                    parameters: [
                      ...params,
                      { key: '__action', value: 'approve_device' },
                    ],
                  },
                },
              },
              {
                text: 'Deny Device',
                color: BTN.deny,
                onClick: {
                  action: {
                    function: 'deny_device',
                    parameters: [
                      ...params,
                      { key: '__action', value: 'deny_device' },
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
      cardId: `device-${deviceId}`,
      card: {
        header: { title: 'Cloud SSO Device Approval Request' },
        sections,
      },
    },
  ];
}

/**
 * @param {object} deviceData
 * @param {string} statusHtml
 */
export function buildDeviceStatusCard(deviceData, statusHtml) {
  return buildDeviceApprovalCard(deviceData, {
    includeActions: false,
    statusHtml,
  });
}
