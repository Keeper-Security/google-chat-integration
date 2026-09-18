/**
 * Handle /keeper-external-share slash command 
 */

import { buildApprovalCard } from '../lib/cards/index.js';
import { getArgumentText } from '../lib/event_utils.js';
import { getLogger } from '../lib/logger.js';
import { ApprovalActionData, RequestType } from '../lib/models.js';
import {
  generateApprovalId,
  isPamRecordType,
  isValidUid,
  MAX_IDENTIFIER_LENGTH,
  MAX_JUSTIFICATION_LENGTH,
  parseCommandText,
  sanitizeUserInput,
} from '../lib/utils.js';
import { openRequestForm } from './request_form.js';
import {
  approvalsSpaceMissingMessage,
  EMAIL_MISSING_MESSAGE,
  replyPrivate,
  resolveApprovalSpaceId,
} from './request_shared.js';

/**
 * @param {object} event
 * @param {object} config
 * @param {import('../lib/chat_client.js').ChatClient} chatClient
 * @param {import('../lib/keeper/client.js').KeeperClient} keeperClient
 * @param {import('../lib/approver_boundary.js').ApproverBoundary} [approverBoundary]
 */
export async function handleOneTimeShare(event, config, chatClient, keeperClient, approverBoundary) {
  const message = event.message || {};
  const user = event.user || {};
  const space = event.space || {};
  const argumentText = getArgumentText(message);
  const requesterUserName = user.name || '';

  if (!argumentText) {
    await openRequestForm(chatClient, space, message, requesterUserName, 'one_time_share');
    return;
  }

  const [rawIdentifier, rawJustification] = parseCommandText(argumentText);
  if (!rawIdentifier) {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      'Please provide a record UID or description.',
    );
    return;
  }
  if (!rawJustification) {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      `Justification is required.\n\nUsage: \`/keeper-external-share "${rawIdentifier}" Your justification here\``,
    );
    return;
  }

  const [identifier, idValid, idError] = sanitizeUserInput(
    rawIdentifier,
    MAX_IDENTIFIER_LENGTH,
  );
  if (!idValid) {
    await replyPrivate(chatClient, space, message, requesterUserName, idError);
    return;
  }

  const [justification, justValid, justError] = sanitizeUserInput(
    rawJustification,
    MAX_JUSTIFICATION_LENGTH,
  );
  if (!justValid) {
    await replyPrivate(chatClient, space, message, requesterUserName, justError);
    return;
  }

  await processOneTimeShareRequest(identifier, justification, event, config, chatClient, keeperClient, approverBoundary);
}

/**
 * Shared core once identifier/justification are already sanitized —
 * used by both the inline-args slash command path above and the
 * request-form card submit handler (src/handlers/request_form.js).
 * @param {string} identifier
 * @param {string} justification
 * @param {object} event
 * @param {object} config
 * @param {import('../lib/chat_client.js').ChatClient} chatClient
 * @param {import('../lib/keeper/client.js').KeeperClient} keeperClient
 * @param {import('../lib/approver_boundary.js').ApproverBoundary} [approverBoundary]
 */
export async function processOneTimeShareRequest(
  identifier,
  justification,
  event,
  config,
  chatClient,
  keeperClient,
  approverBoundary,
) {
  const logger = getLogger();
  const message = event.message || {};
  const user = event.user || {};
  const space = event.space || {};
  const requesterEmail = user.email || '';
  const requesterUserName = user.name || '';
  const requesterDisplay = user.displayName || requesterEmail;

  const approvalsSpaceId = await resolveApprovalSpaceId(config, approverBoundary, requesterEmail);
  if (!approvalsSpaceId) {
    await replyPrivate(chatClient, space, message, requesterUserName, approvalsSpaceMissingMessage(config));
    return;
  }

  if (!requesterEmail) {
    await replyPrivate(chatClient, space, message, requesterUserName, EMAIL_MISSING_MESSAGE);
    return;
  }

  const isUid = isValidUid(identifier);
  if (isUid) {
    await handleUidOneTimeShare(
      identifier,
      justification,
      config,
      chatClient,
      keeperClient,
      logger,
      space,
      message,
      requesterUserName,
      requesterEmail,
      requesterDisplay,
      approvalsSpaceId,
    );
  } else {
    await handleDescriptionOneTimeShare(
      identifier,
      justification,
      config,
      chatClient,
      logger,
      space,
      message,
      requesterUserName,
      requesterEmail,
      requesterDisplay,
      approvalsSpaceId,
    );
  }
}

async function handleUidOneTimeShare(
  identifier,
  justification,
  config,
  chatClient,
  keeperClient,
  logger,
  space,
  message,
  requesterUserName,
  requesterEmail,
  requesterDisplay,
  approvalsSpaceId,
) {
  let record;
  try {
    record = await keeperClient.getRecordByUid(identifier);
  } catch (error) {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      `Failed to look up record \`${identifier}\`:\n${error.message || 'Unknown error'}`,
    );
    return;
  }

  if (!record) {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      `No record found with UID \`${identifier}\`. Verify the UID and try again.`,
    );
    return;
  }

  if (
    ['folder', 'shared_folder', 'user_folder', 'nested_share_folder'].includes(
      record.recordType,
    )
  ) {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      `The UID \`${identifier}\` is a **folder**, not a record.\n\n` +
        'One-time share links can only be created for records.\n' +
        'Use `/keeper-request-folder` for folder access.',
    );
    return;
  }

  if (isPamRecordType(record.recordType)) {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      `The record \`${identifier}\` is a **PAM record**.\n\n` +
        'One-time share links cannot be created for PAM records.\n' +
        'Please contact your administrator for PAM access.',
    );
    return;
  }

  if (record.isNsf) {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      `The record \`${identifier}\` is in a **Nested Share Folder**.\n\n` +
        'One-time share links are not supported for NSF records.',
    );
    return;
  }

  const approvalId = generateApprovalId();
  const actionData = new ApprovalActionData({
    approvalId,
    requesterUserName,
    requesterEmail: requesterEmail || requesterDisplay,
    requesterDisplayName: requesterDisplay,
    identifier,
    isUid: true,
    requestType: RequestType.ONE_TIME_SHARE,
    justification,
    duration: '5m',
    isNsf: false,
    recordType: record.recordType || '',
  });

  await replyPrivate(
    chatClient,
    space,
    message,
    requesterUserName,
    'External Share request submitted.\n\n' +
      `Request ID: \`${approvalId}\`\n` +
      `Record: \`${identifier}\`\n` +
      `Justification: ${justification}\n\n` +
      'Approvers have been notified. Once approved, the external share link will be sent to you via DM.',
  );

  try {
    await chatClient.postMessage({
      parent: approvalsSpaceId,
      message: {
        text: `External Share request ${approvalId}`,
        cardsV2: buildApprovalCard(actionData, record),
      },
    });
  } catch (error) {
    logger.error({ err: error, approvalId }, 'Failed to post OTS approval card');
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      `⚠️ Your request \`${approvalId}\` was recorded, but posting to the approvals space failed. ` +
        'Please contact an admin — verify the app is a member of that space.',
    );
    return;
  }

  logger.info(
    { approvalId, identifier, recordType: record.recordType },
    'Created UID-based external share approval request',
  );
}

async function handleDescriptionOneTimeShare(
  identifier,
  justification,
  config,
  chatClient,
  logger,
  space,
  message,
  requesterUserName,
  requesterEmail,
  requesterDisplay,
  approvalsSpaceId,
) {
  const approvalId = generateApprovalId();
  const actionData = new ApprovalActionData({
    approvalId,
    requesterUserName,
    requesterEmail: requesterEmail || requesterDisplay,
    requesterDisplayName: requesterDisplay,
    identifier,
    isUid: false,
    requestType: RequestType.ONE_TIME_SHARE,
    justification,
    duration: '5m',
  });

  await replyPrivate(
    chatClient,
    space,
    message,
    requesterUserName,
    'External Share request submitted.\n\n' +
      `Request ID: \`${approvalId}\`\n` +
      `Search term: \`${identifier}\`\n` +
      `Justification: ${justification}\n\n` +
      'An approver will search and select the correct record.\n' +
      'Once approved, the external share link will be sent to you via DM.',
  );

  try {
    await chatClient.postMessage({
      parent: approvalsSpaceId,
      message: {
        text: `External Share request ${approvalId}`,
        cardsV2: buildApprovalCard(actionData, null),
      },
    });
  } catch (error) {
    logger.error({ err: error, approvalId }, 'Failed to post OTS approval card');
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      `⚠️ Your request \`${approvalId}\` was recorded, but posting to the approvals space failed. ` +
        'Please contact an admin — verify the app is a member of that space.',
    );
    return;
  }

  logger.info(
    { approvalId, identifier, isUid: false },
    'Created description-based external share approval request',
  );
}
