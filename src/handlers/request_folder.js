/**
 * Handle /keeper-request-folder slash command (Slack parity).
 */

import { buildApprovalCard } from '../lib/cards/index.js';
import { getArgumentText } from '../lib/event_utils.js';
import { getLogger } from '../lib/logger.js';
import { ApprovalActionData, RequestType } from '../lib/models.js';
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
export async function handleRequestFolder(event, config, chatClient, keeperClient) {
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
      'Usage: `/keeper-request-folder <folder-name-or-uid> <justification>`\n' +
        'Example: `/keeper-request-folder "Engineering Creds" Project onboarding`\n' +
        'Example: `/keeper-request-folder AbcDef1234567890AbCdEf Need access for onboarding`',
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
      'Please provide a folder UID or description.',
    );
    return;
  }
  if (!rawJustification) {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      `Justification is required.\n\nUsage: \`/keeper-request-folder "${rawIdentifier}" Your justification here\``,
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
      'Please provide a folder name or UID.',
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
    await handleUidFolderRequest(
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
    await handleDescriptionFolderRequest(
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

async function handleUidFolderRequest(
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
  let folder;
  try {
    folder = await keeperClient.getFolderByUid(identifier);
  } catch (error) {
    logger.error({ err: error, identifier }, 'Folder lookup failed');
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      `Failed to look up folder \`${identifier}\`:\n${error.message || 'Unknown error'}`,
    );
    return;
  }

  if (!folder) {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      `No folder found with UID \`${identifier}\`. Verify the UID and try again.`,
    );
    return;
  }

  if (folder.folderType === 'record') {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      `The UID \`${identifier}\` is a **record**, not a folder.\n\n` +
        `Please use \`/keeper-request-record ${identifier} ${justification}\` instead.`,
    );
    return;
  }

  let isPamFolder = false;
  try {
    const pam = await keeperClient.isPamUserFolder(identifier);
    if (pam.error?.error_code === 'commander_unauthorized' || pam.error) {
      const statusHint = pam.error?.error || 'Commander rejected the PAM folder check.';
      // Only block on auth/forbidden-style errors (Slack parity).
      if (
        String(statusHint).toLowerCase().includes('401') ||
        String(statusHint).toLowerCase().includes('403') ||
        String(statusHint).toLowerCase().includes('unauthorized') ||
        String(statusHint).toLowerCase().includes('forbidden') ||
        String(statusHint).toLowerCase().includes('command_not_allowed')
      ) {
        await replyPrivate(
          chatClient,
          space,
          message,
          requesterUserName,
          `*Folder request could not be submitted.*\n\n${statusHint}\n\n*Folder UID:* \`${identifier}\``,
        );
        return;
      }
    }
    isPamFolder = Boolean(pam.isPam);
  } catch (error) {
    logger.warn({ err: error, identifier }, 'isPamUserFolder detection failed');
    isPamFolder = false;
  }

  const approvalId = generateApprovalId();
  const actionData = new ApprovalActionData({
    approvalId,
    requesterUserName,
    requesterEmail: requesterEmail || requesterDisplay,
    requesterDisplayName: requesterDisplay,
    identifier,
    isUid: true,
    requestType: RequestType.FOLDER,
    justification,
    duration: '5m',
    isNsf: Boolean(folder.isNsf),
    recordType: folder.folderType || '',
    isPamFolder,
  });

  await replyPrivate(
    chatClient,
    space,
    message,
    requesterUserName,
    'Folder access request submitted.\n\n' +
      `Request ID: \`${approvalId}\`\n` +
      `Folder: \`${identifier}\`\n` +
      `Justification: ${justification}\n\n` +
      'Your request has been sent to the approval channel for approval.\n' +
      'Once approved, the details will be sent to you via DM.',
  );

  try {
    await chatClient.postMessage({
      parent: config.chat.approvalsSpaceId,
      message: {
        text: `Folder access request ${approvalId}`,
        cardsV2: buildApprovalCard(actionData, { folder }),
      },
    });
  } catch (error) {
    logger.error({ err: error, approvalId }, 'Failed to post folder approval card');
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
    { approvalId, identifier, isNsf: folder.isNsf, isPamFolder },
    'Created UID-based folder approval request',
  );
}

async function handleDescriptionFolderRequest(
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
    requestType: RequestType.FOLDER,
    justification,
    duration: '5m',
  });

  await replyPrivate(
    chatClient,
    space,
    message,
    requesterUserName,
    'Folder access request submitted!\n\n' +
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
        text: `Folder access request ${approvalId}`,
        cardsV2: buildApprovalCard(actionData, null),
      },
    });
  } catch (error) {
    logger.error({ err: error, approvalId }, 'Failed to post folder approval card');
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
    { approvalId, identifier, isUid: false },
    'Created description-based folder approval request',
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
