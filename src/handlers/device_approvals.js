/**
 * Cloud SSO device Approve & Deny card handlers.
 *
 * Status updates keep the original card body and only remove action buttons.
 */

import { isSafeDeviceId } from '../lib/keeper/device.js';
import { formatAdminConsoleTimestamp } from '../lib/utils.js';
import { getLogger } from '../lib/logger.js';

/**
 * @param {object[]} parameters
 * @param {string} key
 */
function paramValue(parameters, key) {
  const entry = (parameters || []).find((p) => p.key === key);
  return entry?.value == null ? '' : String(entry.value);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * @param {object[]} cardsV2
 * @param {string} statusHtml
 * @param {string} deviceId
 */
function withStatus(cardsV2, statusHtml, deviceId) {
  const source = Array.isArray(cardsV2) && cardsV2.length ? cardsV2 : null;
  if (!source) {
    return [
      {
        cardId: `device-${deviceId || 'unknown'}`,
        card: {
          header: { title: 'Cloud SSO Device Approval Request' },
          sections: [
            { widgets: [{ textParagraph: { text: statusHtml } }] },
          ],
        },
      },
    ];
  }

  return source.map((entry) => {
    const card = entry?.card || {};
    const sections = Array.isArray(card.sections) ? card.sections : [];
    const cleanedSections = sections
      .map((section) => {
        const widgets = Array.isArray(section.widgets) ? section.widgets : [];
        const withoutButtons = widgets.filter((w) => !w.buttonList);
        if (!withoutButtons.length && widgets.some((w) => w.buttonList)) {
          return null;
        }
        return { ...section, widgets: withoutButtons };
      })
      .filter(Boolean);

    cleanedSections.push({
      widgets: [{ textParagraph: { text: statusHtml } }],
    });

    return {
      ...entry,
      card: {
        ...card,
        sections: cleanedSections,
      },
    };
  });
}

/**
 * @param {object} event
 * @param {import('../lib/chat_client.js').ChatClient} chatClient
 * @param {import('../lib/keeper/client.js').KeeperClient} keeperClient
 * @param {'approve'|'deny'} action
 */
async function handleDeviceAction(event, chatClient, keeperClient, action) {
  const logger = getLogger();
  const parameters = event.action?.parameters || [];
  const deviceId = paramValue(parameters, 'device_id').trim();
  const approver = event.user || {};
  const approverLabel =
    approver.email || approver.displayName || approver.name || 'approver';
  const messageName = event.message?.name || '';
  const existingCards = event.message?.cardsV2 || [];

  logger.info(
    { action, deviceId, approver: approverLabel },
    'Device approval action',
  );

  const updated = formatAdminConsoleTimestamp(new Date());

  if (!isSafeDeviceId(deviceId)) {
    logger.error({ deviceId }, 'Invalid device ID');
    if (messageName) {
      const label = action === 'approve' ? 'Approval' : 'Denial';
      await chatClient.patchMessage(messageName, {
        text: 'Device action failed — invalid device ID',
        cardsV2: withStatus(
          existingCards,
          `<b>Status:</b> ${label} failed - Invalid device ID`,
          deviceId,
        ),
      });
    }
    return;
  }

  const result =
    action === 'approve'
      ? await keeperClient.approveDevice(deviceId)
      : await keeperClient.denyDevice(deviceId);

  let statusHtml;
  let text;

  if (result.success) {
    const verb = action === 'approve' ? 'Approved' : 'Denied';
    statusHtml =
      `<b>Status:</b> ${verb} by ${escapeHtml(approverLabel)}<br>` +
      `<b>Updated:</b> ${escapeHtml(updated)}`;
    text = `Device ${verb.toLowerCase()} by ${approverLabel}`;
    logger.info({ deviceId, action }, `Device ${verb.toLowerCase()}`);
  } else if (result.already_handled) {
    statusHtml =
      `<b>Status:</b> Already processed (approved/denied elsewhere)<br>` +
      `<b>Checked by:</b> ${escapeHtml(approverLabel)}<br>` +
      `<b>Updated:</b> ${escapeHtml(updated)}`;
    text = 'Device request already processed elsewhere';
    logger.warn({ deviceId }, 'Device was already processed');
  } else {
    const errorMsg = result.error || 'Unknown error';
    const label = action === 'approve' ? 'Approval' : 'Denial';
    statusHtml = `<b>Status:</b> ${label} failed - ${escapeHtml(errorMsg)}`;
    text = `Device ${label.toLowerCase()} failed`;
    logger.error(
      { deviceId, error: errorMsg },
      `Failed to ${action} device`,
    );
  }

  if (!messageName) {
    logger.warn({ deviceId }, 'Device action missing message name; cannot patch card');
    return;
  }

  await chatClient.patchMessage(messageName, {
    text,
    cardsV2: withStatus(existingCards, statusHtml, deviceId),
  });
}

/**
 * @param {object} event
 * @param {import('../lib/chat_client.js').ChatClient} chatClient
 * @param {import('../lib/keeper/client.js').KeeperClient} keeperClient
 */
export async function handleApproveDevice(event, chatClient, keeperClient) {
  await handleDeviceAction(event, chatClient, keeperClient, 'approve');
}

/**
 * @param {object} event
 * @param {import('../lib/chat_client.js').ChatClient} chatClient
 * @param {import('../lib/keeper/client.js').KeeperClient} keeperClient
 */
export async function handleDenyDevice(event, chatClient, keeperClient) {
  await handleDeviceAction(event, chatClient, keeperClient, 'deny');
}

/**
 * @param {object} event
 */
export function isDeviceCardAction(event) {
  const action = event?.action || {};
  const params = action.parameters || [];
  const method =
    action.actionMethodName ||
    params.find((p) => p.key === '__action')?.value ||
    '';
  return method === 'approve_device' || method === 'deny_device';
}
