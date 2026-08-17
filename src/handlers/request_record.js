/**
 * Handle /keeper-request-record slash command.
 * Supports UID-based and description-based (search) requests �
 */

import { buildApprovalCard } from '../lib/cards/index.js';
import { getArgumentText } from '../lib/event_utils.js';
import { getLogger } from '../lib/logger.js';
import { ApprovalActionData } from '../lib/models.js';
import {
  generateApprovalId,
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
export async function handleRequestRecord(event, config, chatClient, keeperClient) {
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
      'Usage: `/keeper-request-record <record-name-or-uid> <justification>`\n' +
        'Example: `/keeper-request-record "AWS Production DB" Need access for deployment`\n' +
        'Example: `/keeper-request-record kR3cF9Xm2Lp8NqT1uV6w Need access for deployment`',
    );
    return;
  }

  const [rawIdentifier, rawJustification] = parseCommandText(argumentText);
  if (!rawIdentifier) {
    await replyPrivate(chatClient, space, message, requesterUserName, 'Please provide a record name or UID.');
    return;
  }
  if (!rawJustification) {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      `Justification is required.\n\nUsage: \`/keeper-request-record "${rawIdentifier}" Your justification here\``,
    );
    return;
  }

  const [identifier, idValid, idError] = sanitizeUserInput(
    rawIdentifier,
    MAX_IDENTIFIER_LENGTH,
    'Identifier',
  );
  if (!idValid) {
    await replyPrivate(chatClient, space, message, requesterUserName, idError);
    return;
  }
  if (!identifier) {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      'Please provide a record name or UID.',
    );
    return;
  }

  const [justification, justValid, justError] = sanitizeUserInput(
    rawJustification,
    MAX_JUSTIFICATION_LENGTH,
    'Justification',
  );
  if (!justValid) {
    await replyPrivate(chatClient, space, message, requesterUserName, justError);
    return;
  }
  if (!justification) {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      'Justification is required.',
    );
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
    await handleUidRequest(
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
    await handleDescriptionRequest(
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

async function handleUidRequest(
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
    logger.error({ err: error, identifier }, 'Record lookup failed');
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

  if (['folder', 'shared_folder', 'user_folder', 'nested_share_folder'].includes(record.recordType)) {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      `UID \`${identifier}\` is a folder, not a record.\n` +
        'Use `/keeper-request-folder` to request folder access.',
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
    requestType: 'record',
    justification,
    isNsf: Boolean(record.isNsf),
    recordType: record.recordType || '',
  });

 // confirm to requester immediately, then notify approvers
  await replyPrivate(
    chatClient,
    space,
    message,
    requesterUserName,
    'Record access request submitted.\n\n' +
      `Request ID: \`${approvalId}\`\n` +
      `Record: \`${identifier}\`\n` +
      `Justification: ${justification}\n\n` +
      'Your request has been sent to the approval channel for approval.\n' +
      'Once approved, the details will be sent to you via DM.',
  );

  try {
    await chatClient.postMessage({
      parent: config.chat.approvalsSpaceId,
      message: {
        text: `Record access request ${approvalId}`,
        cardsV2: buildApprovalCard(actionData, record),
      },
    });
  } catch (error) {
    logger.error({ err: error, approvalId }, 'Failed to post approval card');
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

  logger.debug(
    { approvalId, identifier, isNsf: record.isNsf, recordType: record.recordType },
    'Created UID-based approval request',
  );
}

async function handleDescriptionRequest(
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
    requestType: 'record',
    justification,
  });

 // confirm to requester immediately, then notify approvers
  await replyPrivate(
    chatClient,
    space,
    message,
    requesterUserName,
    'Record access request submitted!\n\n' +
      `Request ID: \`${approvalId}\`\n` +
      `Search term: \`${identifier}\`\n` +
      `Justification: ${justification}\n\n` +
      'Your request has been sent to the approval channel for approval.\n' +
      'Once approved, the details will be sent to you via DM.',
  );

  try {
    await chatClient.postMessage({
      parent: config.chat.approvalsSpaceId,
      message: {
        text: `Record access request ${approvalId}`,
        cardsV2: buildApprovalCard(actionData, null),
      },
    });
  } catch (error) {
    logger.error({ err: error, approvalId }, 'Failed to post approval card');
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

  logger.debug({ approvalId, identifier, isUid: false }, 'Created description-based approval request');
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
