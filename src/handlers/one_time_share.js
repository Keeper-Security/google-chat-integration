/**
 * Handle /keeper-one-time-share slash command (Slack parity).
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

/**
 * @param {object} event
 * @param {object} config
 * @param {import('../lib/chat_client.js').ChatClient} chatClient
 * @param {import('../lib/keeper/client.js').KeeperClient} keeperClient
 */
export async function handleOneTimeShare(event, config, chatClient, keeperClient) {
  const logger = getLogger();
  const message = event.message || {};
  const user = event.user || {};
  const space = event.space || {};
  const argumentText = getArgumentText(message);
  const requesterEmail = user.email || '';
  const requesterUserName = user.name || '';
  const requesterDisplay = user.displayName || requesterEmail;

  if (!argumentText) {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      'Usage: `/keeper-one-time-share <record-name-or-uid> <justification>`\n' +
        'Example: `/keeper-one-time-share "AWS Production DB" Need temporary share link`\n' +
        'Example: `/keeper-one-time-share kR3cF9Xm2Lp8NqT1uV6w Need temporary share link`',
    );
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
      `Justification is required.\n\nUsage: \`/keeper-one-time-share "${rawIdentifier}" Your justification here\``,
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

  if (!config.chat.approvalsSpaceId) {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      'Approvals space is not configured. Set `chat.approvals_space_id` in config.yaml.',
    );
    return;
  }

  if (!requesterEmail) {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      'Could not resolve your email address from Google Chat. ' +
        'Ensure the Chat app can read your profile, then try again.',
    );
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
    'One-Time Share request submitted.\n\n' +
      `Request ID: \`${approvalId}\`\n` +
      `Record: \`${identifier}\`\n` +
      `Justification: ${justification}\n\n` +
      'Approvers have been notified. Once approved, the one-time share link will be sent to you via DM.',
  );

  try {
    await chatClient.postMessage({
      parent: config.chat.approvalsSpaceId,
      message: {
        text: `One-Time Share request ${approvalId}`,
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
    'Created UID-based one-time share approval request',
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
    'One-Time Share request submitted.\n\n' +
      `Request ID: \`${approvalId}\`\n` +
      `Search term: \`${identifier}\`\n` +
      `Justification: ${justification}\n\n` +
      'An approver will search and select the correct record.\n' +
      'Once approved, the one-time share link will be sent to you via DM.',
  );

  try {
    await chatClient.postMessage({
      parent: config.chat.approvalsSpaceId,
      message: {
        text: `One-Time Share request ${approvalId}`,
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
    'Created description-based one-time share approval request',
  );
}

async function replyPrivate(chatClient, space, message, viewerName, text) {
  await chatClient.postMessage({
    parent: space.name,
    message: { text },
    threadName: message.thread?.name || null,
    privateViewer: viewerName,
    space,
  });
}
