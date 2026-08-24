/**
 * EPM Approve & Deny card handlers.
 *
 * Status updates keep the original card body and only remove action buttons.
 */

import { formatAdminConsoleTimestamp, isValidUid } from '../lib/utils.js';
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
 * Remove Approve/Deny button widgets from a cardsV2 payload and append status.
 * @param {object[]} cardsV2
 * @param {string} statusHtml
 * @param {string} approvalUid
 */
function withStatus(cardsV2, statusHtml, approvalUid) {
  const source = Array.isArray(cardsV2) && cardsV2.length ? cardsV2 : null;
  if (!source) {
    return [
      {
        cardId: `epm-${approvalUid || 'unknown'}`,
        card: {
          header: { title: 'Privilege Elevation Approval Request' },
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
async function handleEpmAction(event, chatClient, keeperClient, action) {
  const logger = getLogger();
  const parameters = event.action?.parameters || [];
  const approvalUid = paramValue(parameters, 'approval_uid').trim();
  const approver = event.user || {};
  const approverLabel =
    approver.email || approver.displayName || approver.name || 'approver';
  const messageName = event.message?.name || '';
  const existingCards = event.message?.cardsV2 || [];

  logger.info(
    { action, approvalUid, approver: approverLabel },
    'EPM approval action',
  );

  const updated = formatAdminConsoleTimestamp(new Date());

  if (!isValidUid(approvalUid)) {
    logger.error({ approvalUid }, 'Invalid EPM approval UID');
    if (messageName) {
      const label = action === 'approve' ? 'Approval' : 'Denial';
      await chatClient.patchMessage(messageName, {
        text: `EPM action failed — invalid request ID`,
        cardsV2: withStatus(
          existingCards,
          `<b>Status:</b> ${label} failed - Invalid EPM approval UID`,
          approvalUid,
        ),
      });
    }
    return;
  }

  const result =
    action === 'approve'
      ? await keeperClient.approveEpmRequest(approvalUid)
      : await keeperClient.denyEpmRequest(approvalUid);

  let statusHtml;
  let text;

  if (result.success) {
    const verb = action === 'approve' ? 'Approved' : 'Denied';
    statusHtml =
      `<b>Status:</b> ${verb} by ${escapeHtml(approverLabel)}<br>` +
      `<b>Updated:</b> ${escapeHtml(updated)}`;
    text = `EPM request ${verb.toLowerCase()} by ${approverLabel}`;
    logger.info({ approvalUid, action }, `EPM request ${verb.toLowerCase()}`);
  } else if (result.already_processed) {
    statusHtml =
      `<b>Status:</b> Already processed (approved/denied elsewhere)<br>` +
      `<b>Checked by:</b> ${escapeHtml(approverLabel)}<br>` +
      `<b>Updated:</b> ${escapeHtml(updated)}`;
    text = 'EPM request already processed elsewhere';
    logger.warn({ approvalUid }, 'EPM request was already processed');
  } else {
    const errorMsg = result.error || 'Unknown error';
    const label = action === 'approve' ? 'Approval' : 'Denial';
    statusHtml = `<b>Status:</b> ${label} failed - ${escapeHtml(errorMsg)}`;
    text = `EPM ${label.toLowerCase()} failed`;
    logger.error(
      { approvalUid, error: errorMsg },
      `Failed to ${action} EPM request`,
    );
  }

  if (!messageName) {
    logger.warn(
      { approvalUid },
      'EPM action missing message name; cannot patch card',
    );
    return;
  }

  await chatClient.patchMessage(messageName, {
    text,
    cardsV2: withStatus(existingCards, statusHtml, approvalUid),
  });
}

/**
 * @param {object} event
 * @param {import('../lib/chat_client.js').ChatClient} chatClient
 * @param {import('../lib/keeper/client.js').KeeperClient} keeperClient
 */
export async function handleApproveEpmRequest(event, chatClient, keeperClient) {
  await handleEpmAction(event, chatClient, keeperClient, 'approve');
}

/**
 * @param {object} event
 * @param {import('../lib/chat_client.js').ChatClient} chatClient
 * @param {import('../lib/keeper/client.js').KeeperClient} keeperClient
 */
export async function handleDenyEpmRequest(event, chatClient, keeperClient) {
  await handleEpmAction(event, chatClient, keeperClient, 'deny');
}

/**
 * @param {object} event
 */
export function isEpmCardAction(event) {
  const action = event?.action || {};
  const params = action.parameters || [];
  const method =
    action.actionMethodName ||
    params.find((p) => p.key === '__action')?.value ||
    '';
  return method === 'approve_epm_request' || method === 'deny_epm_request';
}
