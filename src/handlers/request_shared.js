/**
 * Shared helpers for the /keeper-request-record, /keeper-request-folder,
 * and /keeper-external-share request handlers.
 */

import { getLogger } from '../lib/logger.js';

export const EMAIL_MISSING_MESSAGE =
  'Could not resolve your email address from Google Chat. ' +
  'Ensure the Chat app can read your profile, then try again.';

/**
 * Resolve the approval space for a request (team-specific via multi-channel
 * approver, falling back to the configured default on failure or when the
 * feature is disabled).
 * @param {object} config
 * @param {import('../lib/approver_boundary.js').ApproverBoundary} [approverBoundary]
 * @param {string} requesterEmail
 * @returns {Promise<string>}
 */
export async function resolveApprovalSpaceId(config, approverBoundary, requesterEmail) {
  let approvalsSpaceId = config.chat.approvalsSpaceId;
  if (approverBoundary) {
    try {
      approvalsSpaceId = await approverBoundary.resolveApprovalChannel(requesterEmail);
    } catch (error) {
      getLogger().warn({ err: error }, 'Failed to resolve approval channel; using default');
    }
  }
  return approvalsSpaceId;
}

/**
 * Config-source-aware hint for a missing approvals space.
 * @param {object} config
 * @returns {string}
 */
export function approvalsSpaceMissingMessage(config) {
  return config.ksmLoaded
    ? 'Approvals space is not configured. Set `chat_approval_space_id` (or `chat_approvals_space_id`) in the GCHAT_RECORD KSM record.'
    : 'Approvals space is not configured. Set `chat.approvals_space_id` in config.yaml.';
}

/**
 * Post a private (requester-only) reply — routes to the requester's 1:1
 * bot DM via ChatClient.postMessage's privateViewer handling.
 * @param {import('../lib/chat_client.js').ChatClient} chatClient
 * @param {object} space
 * @param {object} message
 * @param {string} viewerName
 * @param {string} text
 */
export async function replyPrivate(chatClient, space, message, viewerName, text) {
  await chatClient.postMessage({
    parent: space.name,
    message: { text },
    threadName: message.thread?.name || null,
    privateViewer: viewerName,
    space,
  });
}
