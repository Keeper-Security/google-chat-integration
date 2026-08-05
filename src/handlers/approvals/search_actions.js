/**
 * Search / refine / selection card actions.
 */

import { buildApprovalCard, buildLoadingCard, buildSearchResultsCard } from '../../lib/cards/index.js';

import { decodeSearchItemValue } from '../../lib/models.js';
import { getLogger } from '../../lib/logger.js';

import { extractFormValue } from './form_utils.js';
import {
  resolveFolderPamFlag,
  restoreApprovalCard,
  searchVaultItems,
} from './helpers.js';

export async function handleSearchRecords(
  actionData,
  approverName,
  messageName,
  chatClient,
  keeperClient,
) {
  const logger = getLogger();
  const query = actionData.identifier;
  const itemWord = actionData.isFolderRequest ? 'folders' : 'records';
  logger.debug(
    { approvalId: actionData.approvalId, query, requestType: actionData.requestType },
    'Searching vault for approval',
  );

  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: `Searching for "${query}"…`,
      cardsV2: buildLoadingCard(actionData, {
        title: `Searching Keeper Vault for "${query}"…`,
        detail: `Please wait while ${itemWord} are being fetched.`,
      }),
    });
  }

  let items = [];
  let error = null;
  try {
    const result = await searchVaultItems(actionData, query, keeperClient);
    items = result.items;
    error = result.error;
  } catch (err) {
    logger.error({ err, query }, 'Search failed');
    const errText = err.message || 'Unknown error';
    await restoreApprovalCard(actionData, messageName, chatClient, keeperClient, {
      error: `Search failed for "${query}": ${errText}`,
    });
    await chatClient.sendDm(
      approverName,
      `Search failed for "${query}": ${errText}`,
    );
    return;
  }

  if (error) {
    const errText = error.error || 'Unknown Commander error';
    await restoreApprovalCard(actionData, messageName, chatClient, keeperClient, {
      error: `Search failed for "${query}": ${errText}`,
    });
    await chatClient.sendDm(
      approverName,
      `Search failed for "${query}":\n${errText}`,
    );
    return;
  }

  let isPamFolder = actionData.isPamFolder;
  if (actionData.isFolderRequest && items.length) {
    const first = items[0];
    isPamFolder = await resolveFolderPamFlag(
      keeperClient,
      first.uid,
      Boolean(first.isNsf),
    );
  }

  logger.debug(
    { approvalId: actionData.approvalId, resultCount: items.length },
    'Search completed',
  );

  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: `Search results for "${query}" (${items.length} found)`,
      cardsV2: buildSearchResultsCard(actionData, items, { isPamFolder }),
    });
  }
}

/**
 * Rebuild search card when the selected radio changes so NSF permissions
 * and PAM rotate options match the selected record (Slack parity).
 */
export async function handleUpdateSearchSelection(
  actionData,
  approverName,
  messageName,
  event,
  chatClient,
  keeperClient,
) {
  const logger = getLogger();
  const query =
    extractFormValue(event, 'search_query') || actionData.identifier;
  const selectedValue = extractFormValue(event, 'selected_record');
  const defaultDuration =
    actionData.isFolderRequest || actionData.isOneTimeShareRequest ? '5m' : '1h';
  const selectedDuration =
    extractFormValue(event, 'duration') || actionData.duration || defaultDuration;
  const selectedPermission = extractFormValue(event, 'permission');

  let items = [];
  try {
    const result = await searchVaultItems(actionData, query, keeperClient);
    items = result.items;
    if (result.error) {
      await chatClient.sendDm(
        approverName,
        `Unable to refresh options for "${query}":\n${result.error.error || 'Unknown Commander error'}`,
      );
      return;
    }
  } catch (err) {
    logger.error({ err, query }, 'Failed to refresh search selection');
    await chatClient.sendDm(
      approverName,
      `Unable to refresh options for "${query}": ${err.message || 'Unknown error'}`,
    );
    return;
  }

  let isPamFolder = actionData.isPamFolder;
  if (actionData.isFolderRequest && selectedValue) {
    const [uid, isNsf] = decodeSearchItemValue(selectedValue);
    isPamFolder = await resolveFolderPamFlag(keeperClient, uid, isNsf);
  }

  logger.debug(
    {
      approvalId: actionData.approvalId,
      selectedValue,
      resultCount: items.length,
      isPamFolder,
      selectedPermission,
    },
    'Updating search selection options',
  );

  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: `Search results for "${query}" (${items.length} found)`,
      cardsV2: buildSearchResultsCard(actionData, items, {
        selectedValue,
        selectedDuration,
        selectedPermission,
        currentQuery: query,
        isPamFolder,
      }),
    });
  }
}

/**
 * Rebuild approval/search card when permission changes so permanent-only
 * roles hide the duration dropdown (Slack parity).
 */
export async function handleUpdatePermissionSelection(
  actionData,
  approverName,
  messageName,
  event,
  chatClient,
  keeperClient,
) {
  const logger = getLogger();
  const selectedPermission = extractFormValue(event, 'permission');
  const selectedRecord = extractFormValue(event, 'selected_record');
  const searchQuery = extractFormValue(event, 'search_query');
  const onSearchCard = selectedRecord != null || searchQuery != null;

  logger.debug(
    {
      approvalId: actionData.approvalId,
      selectedPermission,
      onSearchCard,
    },
    'Updating permission selection (duration visibility)',
  );

  if (onSearchCard) {
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

  // UID approval card — rebuild in place with selected permission.
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

  const defaultDuration =
    actionData.isFolderRequest || actionData.isOneTimeShareRequest ? '5m' : '1h';
  const selectedDuration =
    extractFormValue(event, 'duration') || actionData.duration || defaultDuration;

  if (messageName) {
    const label = actionData.isFolderRequest
      ? 'Folder'
      : actionData.isOneTimeShareRequest
        ? 'One-Time Share'
        : 'Record';
    await chatClient.patchMessage(messageName, {
      text: `${label} request ${actionData.approvalId}`,
      cardsV2: buildApprovalCard(actionData, item, {
        selectedPermission,
        selectedDuration,
      }),
    });
  }
}

/**
 * Re-sync Keeper vault then re-run the current search term (Slack parity).
 */
export async function handleResyncVault(
  actionData,
  approverName,
  messageName,
  event,
  chatClient,
  keeperClient,
) {
  const logger = getLogger();
  const query =
    extractFormValue(event, 'search_query') || actionData.identifier;
  const selectedValue = extractFormValue(event, 'selected_record');
  const selectedDuration =
    extractFormValue(event, 'duration') ||
    actionData.duration ||
    (actionData.isFolderRequest || actionData.isOneTimeShareRequest ? '5m' : '1h');

  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: `Re-syncing vault, then searching for "${query}"…`,
      cardsV2: buildLoadingCard(actionData, {
        title: 'Re-syncing Keeper Vault…',
        detail: `Then searching for "${query}".`,
      }),
    });
  }

  try {
    const sync = await keeperClient.syncDown();
    if (!sync.success) {
      await chatClient.sendDm(
        approverName,
        'Vault re-sync failed. Try again, or refine the search without syncing.',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Vault re-sync failed');
    await chatClient.sendDm(
      approverName,
      `Vault re-sync failed: ${err.message || 'Unknown error'}`,
    );
  }

  let items = [];
  try {
    const result = await searchVaultItems(actionData, query, keeperClient);
    items = result.items;
    if (result.error) {
      await chatClient.sendDm(
        approverName,
        `Search after re-sync failed for "${query}":\n${result.error.error || 'Unknown Commander error'}`,
      );
      await restoreApprovalCard(actionData, messageName, chatClient, keeperClient, {
        error: `Search after re-sync failed for "${query}": ${result.error.error || 'Unknown Commander error'}`,
      });
      return;
    }
  } catch (err) {
    logger.error({ err, query }, 'Search after re-sync failed');
    const errText = err.message || 'Unknown error';
    await restoreApprovalCard(actionData, messageName, chatClient, keeperClient, {
      error: `Search after re-sync failed for "${query}": ${errText}`,
    });
    await chatClient.sendDm(
      approverName,
      `Search after re-sync failed for "${query}": ${errText}`,
    );
    return;
  }

  let isPamFolder = actionData.isPamFolder;
  if (actionData.isFolderRequest && selectedValue) {
    const [uid, isNsf] = decodeSearchItemValue(selectedValue);
    isPamFolder = await resolveFolderPamFlag(keeperClient, uid, isNsf);
  } else if (actionData.isFolderRequest && items.length) {
    isPamFolder = await resolveFolderPamFlag(
      keeperClient,
      items[0].uid,
      Boolean(items[0].isNsf),
    );
  }

  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: `Search results for "${query}" (${items.length} found)`,
      cardsV2: buildSearchResultsCard(actionData, items, {
        selectedValue,
        selectedDuration,
        currentQuery: query,
        isPamFolder,
      }),
    });
  }
}

/**
 * Refine search: approver typed a new query in the text input and clicked
 * "Refine Search". Re-search with the new term (Slack parity).
 * The original requester's identifier is preserved for "Back" navigation.
 */
export async function handleRefineSearch(
  actionData,
  approverName,
  messageName,
  event,
  chatClient,
  keeperClient,
) {
  const logger = getLogger();
  const newQuery =
    extractFormValue(event, 'search_query') || actionData.identifier;

  logger.debug(
    { approvalId: actionData.approvalId, newQuery },
    'Refine search with new query',
  );

  const itemWord = actionData.isFolderRequest ? 'folders' : 'records';
  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: `Searching for "${newQuery}"…`,
      cardsV2: buildLoadingCard(actionData, {
        title: `Searching Keeper Vault for "${newQuery}"…`,
        detail: `Please wait while ${itemWord} are being fetched.`,
      }),
    });
  }

  let items = [];
  let error = null;
  try {
    const result = await searchVaultItems(actionData, newQuery, keeperClient);
    items = result.items;
    error = result.error;
  } catch (err) {
    logger.error({ err, newQuery }, 'Refine search failed');
    const errText = err.message || 'Unknown error';
    await restoreApprovalCard(actionData, messageName, chatClient, keeperClient, {
      error: `Search failed for "${newQuery}": ${errText}`,
    });
    await chatClient.sendDm(
      approverName,
      `Search failed for "${newQuery}": ${errText}`,
    );
    return;
  }

  if (error) {
    const errText = error.error || 'Unknown Commander error';
    await restoreApprovalCard(actionData, messageName, chatClient, keeperClient, {
      error: `Search failed for "${newQuery}": ${errText}`,
    });
    await chatClient.sendDm(
      approverName,
      `Search failed for "${newQuery}":\n${errText}`,
    );
    return;
  }

  let isPamFolder = actionData.isPamFolder;
  if (actionData.isFolderRequest && items.length) {
    isPamFolder = await resolveFolderPamFlag(
      keeperClient,
      items[0].uid,
      Boolean(items[0].isNsf),
    );
  }

  logger.debug(
    { approvalId: actionData.approvalId, resultCount: items.length },
    'Refine search completed',
  );

  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: `Search results for "${newQuery}" (${items.length} found)`,
      cardsV2: buildSearchResultsCard(actionData, items, {
        currentQuery: newQuery,
        isPamFolder,
      }),
    });
  }
}

/**
 * Go back from search results to the original approval card.
 */
export async function handleBackToApproval(
  actionData,
  messageName,
  chatClient,
  keeperClient,
) {
  await restoreApprovalCard(actionData, messageName, chatClient, keeperClient);
}
