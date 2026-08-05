/**
 * Approval card click router.
 */

import { getLogger } from '../../lib/logger.js';
import { ApprovalActionData } from '../../lib/models.js';
import {
  handleCancelCreateRecord,
  handleCreateNewRecord,
  handleCreateRecordToggle,
  handleSubmitCreateRecord,
} from './create_record_actions.js';
import { grantAndNotify, handleApproveSearchResult, handleDeny } from './grant_actions.js';
import { resolveTypedAwareMethod } from './helpers.js';
import {
  handleBackToApproval,
  handleRefineSearch,
  handleResyncVault,
  handleSearchRecords,
  handleUpdatePermissionSelection,
  handleUpdateSearchSelection,
} from './search_actions.js';

export async function handleCardClicked(event, chatClient, keeperClient) {
  const logger = getLogger();
  const action = event.action || {};
  const params = action.parameters || [];
  let method =
    action.actionMethodName ||
    params.find((p) => p.key === '__action')?.value ||
    '';
  let actionData = ApprovalActionData.fromParameters(params);

  // Typed method names keep routing correct if request_type is dropped.
  const resolved = resolveTypedAwareMethod(method, actionData);
  method = resolved.method;
  actionData = resolved.actionData;

  const approver = event.user || {};
  const approverEmail = approver.email || approver.displayName || 'approver';
  const approverName = approver.name || '';
  const messageName = event.message?.name || '';

  if (method === 'deny_request') {
    await handleDeny(actionData, approverEmail, messageName, chatClient);
    return;
  }

  if (
    method === 'search_records' ||
    method === 'search_folders' ||
    method === 'search_ots'
  ) {
    await handleSearchRecords(
      actionData,
      approverName,
      messageName,
      chatClient,
      keeperClient,
    );
    return;
  }

  if (method === 'update_search_selection') {
    await handleUpdateSearchSelection(
      actionData,
      approverName,
      messageName,
      event,
      chatClient,
      keeperClient,
    );
    return;
  }

  if (method === 'update_permission_selection') {
    await handleUpdatePermissionSelection(
      actionData,
      approverName,
      messageName,
      event,
      chatClient,
      keeperClient,
    );
    return;
  }

  if (method === 'refine_search') {
    await handleRefineSearch(
      actionData,
      approverName,
      messageName,
      event,
      chatClient,
      keeperClient,
    );
    return;
  }

  if (method === 'resync_vault') {
    await handleResyncVault(
      actionData,
      approverName,
      messageName,
      event,
      chatClient,
      keeperClient,
    );
    return;
  }

  if (method === 'create_new_record') {
    if (actionData.isFolderRequest || actionData.isOneTimeShareRequest) {
      await chatClient.sendDm(
        approverName,
        actionData.isOneTimeShareRequest
          ? 'Create New Record is not available for one-time share requests.'
          : 'Create New Record is only available for record access requests.',
      );
      return;
    }
    await handleCreateNewRecord(
      actionData,
      messageName,
      event,
      chatClient,
    );
    return;
  }

  if (method === 'create_record_toggle_classic') {
    await handleCreateRecordToggle(actionData, messageName, event, chatClient, {
      toggleClassic: true,
    });
    return;
  }

  if (method === 'create_record_toggle_self_destruct') {
    await handleCreateRecordToggle(actionData, messageName, event, chatClient, {
      toggleSelfDestruct: true,
    });
    return;
  }

  if (method === 'submit_create_record') {
    await handleSubmitCreateRecord(
      actionData,
      approverName,
      messageName,
      event,
      chatClient,
      keeperClient,
    );
    return;
  }

  if (method === 'cancel_create_record') {
    await handleCancelCreateRecord(
      actionData,
      messageName,
      event,
      chatClient,
      keeperClient,
    );
    return;
  }

  if (method === 'back_to_approval') {
    await handleBackToApproval(
      actionData,
      messageName,
      chatClient,
      keeperClient,
    );
    return;
  }

  if (method === 'approve_search_result') {
    await handleApproveSearchResult(
      actionData,
      approverName,
      approverEmail,
      messageName,
      event,
      chatClient,
      keeperClient,
    );
    return;
  }

  if (method !== 'approve_request') {
    logger.warn({ method }, 'Unhandled card action');
    return;
  }

  if (!actionData.isUid) {
    const item = actionData.isFolderRequest
      ? 'folder'
      : actionData.isOneTimeShareRequest
        ? 'record'
        : 'record';
    await chatClient.sendDm(
      approverName,
      `This request does not include a UID. Use the Search button to find and approve a ${item}.`,
    );
    return;
  }

  await grantAndNotify(
    actionData,
    approverName,
    approverEmail,
    messageName,
    event,
    chatClient,
    keeperClient,
  );
}
