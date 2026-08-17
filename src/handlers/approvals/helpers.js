/**
 * Shared helpers for approval card routing and vault lookups.
 */

import { buildApprovalCard, SEARCH_RESULT_DISPLAY_LIMIT } from '../../lib/cards/index.js';
import { getLogger } from '../../lib/logger.js';
import { ApprovalActionData, RequestType } from '../../lib/models.js';

/**
 * Map typed Chat action names (folder / OTS suffixes) back to shared handlers
 * and force requestType so search/grant cannot silently fall back to records.
 *
 * @param {string} method
 * @param {ApprovalActionData} actionData
 */
export function resolveTypedAwareMethod(method, actionData) {
  const aliases = {
    search_folders: 'search_folders',
    refine_search_folders: 'refine_search',
    resync_vault_folders: 'resync_vault',
    update_search_selection_folders: 'update_search_selection',
    update_permission_selection_folders: 'update_permission_selection',
    approve_search_result_folders: 'approve_search_result',
    back_to_approval_folders: 'back_to_approval',
    approve_request_folder: 'approve_request',
    deny_request_folder: 'deny_request',
    search_ots: 'search_ots',
    refine_search_ots: 'refine_search',
    resync_vault_ots: 'resync_vault',
    update_search_selection_ots: 'update_search_selection',
    update_permission_selection_ots: 'update_permission_selection',
    approve_search_result_ots: 'approve_search_result',
    back_to_approval_ots: 'back_to_approval',
    approve_request_ots: 'approve_request',
    deny_request_ots: 'deny_request',
  };

  const folderMethods = new Set([
    'search_folders',
    'refine_search_folders',
    'resync_vault_folders',
    'update_search_selection_folders',
    'update_permission_selection_folders',
    'approve_search_result_folders',
    'back_to_approval_folders',
    'approve_request_folder',
    'deny_request_folder',
  ]);

  const otsMethods = new Set([
    'search_ots',
    'refine_search_ots',
    'resync_vault_ots',
    'update_search_selection_ots',
    'update_permission_selection_ots',
    'approve_search_result_ots',
    'back_to_approval_ots',
    'approve_request_ots',
    'deny_request_ots',
  ]);

  let nextData = actionData;
  if (folderMethods.has(method) || method === 'search_folders') {
    nextData = withRequestType(actionData, RequestType.FOLDER);
  } else if (otsMethods.has(method) || method === 'search_ots') {
    nextData = withRequestType(actionData, RequestType.ONE_TIME_SHARE);
  } else if (method === 'search_records') {
    nextData = withRequestType(actionData, RequestType.RECORD);
  }

  return {
    method: aliases[method] || method,
    actionData: nextData,
  };
}

/**
 * @param {ApprovalActionData} actionData
 * @param {string} requestType
 */
export function withRequestType(actionData, requestType) {
  if (actionData.requestType === requestType) return actionData;
  return new ApprovalActionData({
    approvalId: actionData.approvalId,
    requesterUserName: actionData.requesterUserName,
    requesterEmail: actionData.requesterEmail,
    requesterDisplayName: actionData.requesterDisplayName,
    identifier: actionData.identifier,
    isUid: actionData.isUid,
    requestType,
    justification: actionData.justification,
    duration: actionData.duration,
    isNsf: actionData.isNsf,
    recordType: actionData.recordType,
    createSelfDestruct: actionData.createSelfDestruct,
    selfDestructDuration: actionData.selfDestructDuration,
    newlyCreatedUid: actionData.newlyCreatedUid,
    newlyCreatedTitle: actionData.newlyCreatedTitle,
    isPamFolder: actionData.isPamFolder,
  });
}

/**
 * Search Keeper vault for records or folders based on request type.
 * @returns {Promise<{ items: Array, error: object|null }>}
 */
export async function searchVaultItems(actionData, query, keeperClient, limit = SEARCH_RESULT_DISPLAY_LIMIT) {
  if (actionData.isFolderRequest) {
    const result = await keeperClient.searchFolders(query, limit);
    return { items: result.folders || [], error: result.error || null };
  }
  const result = await keeperClient.searchRecords(query, limit, {
    forOneTimeShare: actionData.isOneTimeShareRequest,
  });
  return { items: result.records || [], error: result.error || null };
}

/**
 * Probe PAM eligibility for a selected classic folder.
 */
export async function resolveFolderPamFlag(keeperClient, folderUid, isNsf) {
  if (!folderUid || isNsf) return false;
  try {
    const pam = await keeperClient.isPamUserFolder(folderUid);
    return Boolean(pam?.isPam);
  } catch {
    return false;
  }
}

/**
 * Rebuild the interactive approval card (optionally with an error banner).
 * Used for Close navigation and to escape loading-card "black holes" on failure.
 *
 * @param {import('../lib/models.js').ApprovalActionData} actionData
 * @param {string} messageName
 * @param {import('../lib/chat_client.js').ChatClient} chatClient
 * @param {import('../lib/keeper/client.js').KeeperClient} keeperClient
 * @param {{ error?: string|null }} [options]
 */
export async function restoreApprovalCard(
  actionData,
  messageName,
  chatClient,
  keeperClient,
  options = {},
) {
  const logger = getLogger();
  logger.debug(
    { approvalId: actionData.approvalId, hasError: Boolean(options.error) },
    'Restoring approval card',
  );

  let item = null;
  if (actionData.isUid) {
    try {
      if (actionData.isFolderRequest) {
        const folder = await keeperClient.getFolderByUid(actionData.identifier);
        item = folder ? { folder } : null;
      } else {
        item = await keeperClient.getRecordByUid(actionData.identifier);
      }
    } catch {
 // continue without details
    }
  }

  const label = actionData.isFolderRequest
    ? 'Folder'
    : actionData.isOneTimeShareRequest
      ? 'External Share'
      : 'Record';
  const error = options.error ? String(options.error).trim() : '';
  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: error
        ? `${label} request ${actionData.approvalId} — action failed`
        : `${label} request ${actionData.approvalId}`,
      cardsV2: buildApprovalCard(actionData, item, { error: error || null }),
    });
  }
}
