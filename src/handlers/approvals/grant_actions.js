/**
 * Approve / deny / grant notification actions.
 */

import {
  buildAccessDeniedDm,
  buildAccessGrantedDm,
  buildApprovedCard,
  buildDeniedCard,
  buildLoadingCard,
  buildOneTimeShareDm,
  buildOwnerAlreadyHasAccessCard
} from '../../lib/cards/index.js';

import { isRecordOwnerError } from '../../lib/commander_errors.js';
import { getLogger } from '../../lib/logger.js';
import {
  ApprovalActionData,
  classicPermissionToNsfRole,
  decodeSearchItemValue,
  isFolderItemType,
  NSFPermissionRole,
  PERMANENT_ONLY_FOLDER_PERMISSIONS,
  PERMANENT_ONLY_NSF_ROLES,
  PERMANENT_ONLY_PERMISSIONS,
  PermissionLevel,
  RequestType
} from '../../lib/models.js';

import {
  formatDuration,
  isPamRecordType,
  isPamUserRecordType,
  parseDurationToSeconds
} from '../../lib/utils.js';

import { extractFormValue, extractFormValues } from './form_utils.js';
import { resolveFolderPamFlag, restoreApprovalCard } from './helpers.js';

export async function handleApproveSearchResult(
  actionData,
  approverName,
  approverEmail,
  messageName,
  event,
  chatClient,
  keeperClient,
) {
  const logger = getLogger();
  const forFolder = actionData.isFolderRequest;
  const forOts = actionData.isOneTimeShareRequest;
  const itemWord = forFolder ? 'folder' : 'record';

  const selectedRaw = extractFormValue(event, 'selected_record');
  if (!selectedRaw) {
    await chatClient.sendDm(
      approverName,
      `No ${itemWord} selected. Please select a ${itemWord} from the search results and try again.`,
    );
    return;
  }

  const [selectedUid, isNsf, encodedItemType] =
    decodeSearchItemValue(selectedRaw);

 // Safety net: selected item type must match request kind.
  if (forFolder && encodedItemType && !isFolderItemType(encodedItemType)) {
    await chatClient.sendDm(
      approverName,
      `Selected item \`${selectedUid}\` looks like a record, not a folder. ` +
        'Refine the folder search and select a folder, or use `/keeper-request-record` for records.',
    );
    return;
  }
  if (!forFolder && isFolderItemType(encodedItemType)) {
    await chatClient.sendDm(
      approverName,
      `Selected item \`${selectedUid}\` is a folder, not a record. ` +
        'Use `/keeper-request-folder` (or Search Folders) for folder access.',
    );
    return;
  }

  let recordType = encodedItemType || '';
  let isPamFolder = false;
  try {
    if (forFolder) {
      const folder = await keeperClient.getFolderByUid(selectedUid);
      if (folder) {
        recordType = folder.folderType || recordType;
      }
      isPamFolder = await resolveFolderPamFlag(keeperClient, selectedUid, isNsf);
    } else {
      const record = await keeperClient.getRecordByUid(selectedUid);
      if (record) {
        recordType = record.recordType || recordType;
      }
    }
  } catch {
 // continue with encoded type
  }

  if (forOts) {
    if (isNsf) {
      await chatClient.sendDm(
        approverName,
        'One-time share links are not supported for NSF records. Select a classic vault record.',
      );
      return;
    }
    if (isPamRecordType(recordType)) {
      await chatClient.sendDm(
        approverName,
        'One-time share links cannot be created for PAM records. Select a non-PAM record.',
      );
      return;
    }
  }

  const updatedActionData = new ApprovalActionData({
    approvalId: actionData.approvalId,
    requesterUserName: actionData.requesterUserName,
    requesterEmail: actionData.requesterEmail,
    requesterDisplayName: actionData.requesterDisplayName,
    identifier: selectedUid,
    isUid: true,
    requestType: forFolder
      ? RequestType.FOLDER
      : forOts
        ? RequestType.ONE_TIME_SHARE
        : actionData.requestType,
    justification: actionData.justification,
    duration: actionData.duration,
    isNsf,
    recordType,
    createSelfDestruct: actionData.createSelfDestruct,
    selfDestructDuration: actionData.selfDestructDuration,
    newlyCreatedUid: actionData.newlyCreatedUid,
    newlyCreatedTitle: actionData.newlyCreatedTitle,
    isPamFolder,
  });

  logger.debug(
    {
      approvalId: actionData.approvalId,
      selectedUid,
      isNsf,
      recordType,
      isPamFolder,
      requestType: actionData.requestType,
    },
    'Approving search result',
  );
  await grantAndNotify(
    updatedActionData,
    approverName,
    approverEmail,
    messageName,
    event,
    chatClient,
    keeperClient,
  );
}

export async function grantAndNotify(
  actionData,
  approverName,
  approverEmail,
  messageName,
  event,
  chatClient,
  keeperClient,
) {
  const logger = getLogger();
  const forFolder = actionData.isFolderRequest;
  const forOts = actionData.isOneTimeShareRequest;
  const defaultPermission =
    forFolder
      ? PermissionLevel.NO_PERMISSIONS
      : PermissionLevel.VIEW_ONLY;
  const defaultDuration = forFolder || forOts ? '5m' : '1h';

  let permissionRaw =
    extractFormValue(event, 'permission') || defaultPermission;
  let duration =
    extractFormValue(event, 'duration') || actionData.duration || defaultDuration;
  const rotateSelected = extractFormValues(event, 'pam_rotate').includes(
    'rotate_on_expire',
  );

 // Self-destruct records: always view-only with creation duration (Classic-only).
  const isSelfDestruct = !forFolder && !forOts && Boolean(actionData.createSelfDestruct);
  if (isSelfDestruct) {
    permissionRaw = PermissionLevel.VIEW_ONLY;
    duration = actionData.selfDestructDuration || '5m';
  }

  const isNsf = Boolean(actionData.isNsf) && !isSelfDestruct && !forOts;
  let permission = permissionRaw;
  if (forOts) {
    if (
      permission !== PermissionLevel.VIEW_ONLY &&
      permission !== PermissionLevel.CAN_EDIT
    ) {
      permission = PermissionLevel.VIEW_ONLY;
    }
  } else if (isNsf) {
    if (!Object.values(NSFPermissionRole).includes(permission)) {
      permission = classicPermissionToNsfRole(permissionRaw);
    }
  } else if (!Object.values(PermissionLevel).includes(permission)) {
    permission = defaultPermission;
  }

  let durationSeconds = null;
  let durationText = 'No Expiration';
  let permanentOnly = false;
  if (!forOts) {
    if (isNsf) {
      permanentOnly = PERMANENT_ONLY_NSF_ROLES.has(permission);
    } else if (forFolder) {
      permanentOnly = PERMANENT_ONLY_FOLDER_PERMISSIONS.has(permission);
    } else {
      permanentOnly = PERMANENT_ONLY_PERMISSIONS.has(permission);
    }
  }

  if (!permanentOnly) {
    durationSeconds = parseDurationToSeconds(duration);
    durationText = formatDuration(duration);
  }

 // OTS: "permanent" maps to Keeper's 7-day default (null durationSeconds).
  if (forOts && durationSeconds == null) {
    durationText = 'Never (7 days default)';
  }

  const rotateOnExpire =
    !forOts &&
    rotateSelected &&
    !isNsf &&
    !isSelfDestruct &&
    !permanentOnly &&
    durationSeconds != null &&
    (forFolder
      ? Boolean(actionData.isPamFolder)
      : isPamUserRecordType(actionData.recordType));

  if (forOts) {
    if (isNsf || actionData.isNsf) {
      await chatClient.sendDm(
        approverName,
        'One-time share links are not supported for NSF records.',
      );
      return;
    }
    if (isPamRecordType(actionData.recordType)) {
      await chatClient.sendDm(
        approverName,
        'One-time share links cannot be created for PAM records.',
      );
      return;
    }
  }

  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: forOts
        ? `Creating external share for ${actionData.identifier}…`
        : `Approving access for ${actionData.identifier}…`,
      cardsV2: buildLoadingCard(actionData, {
        title: forOts
          ? `Creating external share for "${actionData.identifier}"…`
          : `Approving access for "${actionData.identifier}"…`,
        detail: forOts
          ? 'Please wait while Keeper creates the external share link.'
          : forFolder
            ? 'Please wait while Keeper grants folder access.'
            : 'Please wait while Keeper grants record access.',
      }),
    });
  }

  let result;
  try {
    if (forOts) {
      result = await keeperClient.createOneTimeShare({
        recordUid: actionData.identifier,
        durationSeconds,
        editable: permission === PermissionLevel.CAN_EDIT,
      });
    } else if (forFolder) {
      if (isNsf) {
        result = await keeperClient.grantNsfFolderAccess({
          folderUid: actionData.identifier,
          userEmail: actionData.requesterEmail,
          role: permission,
          durationSeconds: permanentOnly ? null : durationSeconds,
        });
      } else {
        result = await keeperClient.grantFolderAccess({
          folderUid: actionData.identifier,
          userEmail: actionData.requesterEmail,
          permission,
          durationSeconds: permanentOnly ? null : durationSeconds,
          rotateOnExpire,
        });
      }
    } else {
      result = await keeperClient.grantRecordAccess({
        recordUid: actionData.identifier,
        userEmail: actionData.requesterEmail,
        permission,
        durationSeconds: permanentOnly ? null : durationSeconds,
        rotateOnExpire,
        isNsf,
        recordType: actionData.recordType,
      });
    }
  } catch (error) {
    logger.error({ err: error, approvalId: actionData.approvalId }, 'Grant access failed');
    const errText = error.message || 'Unknown error';
    await handleGrantFailure({
      actionData,
      approverName,
      approverEmail,
      messageName,
      chatClient,
      keeperClient,
      errText,
      result: { error: errText },
    });
    return;
  }

  if (!result?.success) {
    const errText = result?.error || 'Unknown error';
    await handleGrantFailure({
      actionData,
      approverName,
      approverEmail,
      messageName,
      chatClient,
      keeperClient,
      errText,
      result,
    });
    return;
  }

  const expiresAt = isSelfDestruct
    ? durationText
    : result.expires_at || durationText;
  const extras = {
    rotateOnExpire: Boolean(result.rotate_on_expire),
    isNsf,
    invitationSent: Boolean(result.invitation_sent),
    selfDestruct: isSelfDestruct,
    selfDestructDuration: isSelfDestruct ? durationText : null,
    forFolder,
    oneTimeShare: forOts,
    shareUrl: forOts ? result.share_url || null : null,
    serverDomain: await keeperClient.getServerDomain(),
    itemTitle: actionData.identifier,
  };

  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: `Approved by ${approverEmail}`,
      cardsV2: buildApprovedCard(
        actionData,
        approverEmail,
        permission,
        expiresAt,
        extras,
      ),
    });
  }

  if (forOts) {
    await chatClient.sendDm(
      actionData.requesterUserName,
      `Your external share request ${actionData.approvalId} was approved.`,
      buildOneTimeShareDm(
        actionData.approvalId,
        actionData.identifier,
        permission,
        expiresAt,
        result.share_url,
      ),
    );
  } else {
    const dmText = result.invitation_sent
      ? `Your access request ${actionData.approvalId} was approved (invitation sent).`
      : `Your access request ${actionData.approvalId} was approved.`;

    await chatClient.sendDm(
      actionData.requesterUserName,
      dmText,
      buildAccessGrantedDm(
        actionData.approvalId,
        actionData.identifier,
        permission,
        expiresAt,
        extras,
      ),
    );
  }

  logger.info(
    {
      approvalId: actionData.approvalId,
      requester: actionData.requesterEmail,
      identifier: actionData.identifier,
      permission,
      isNsf,
      forFolder,
      forOts,
      rotateOnExpire: extras.rotateOnExpire,
    },
    forOts ? 'Approved external share request' : 'Approved access request',
  );
}

export async function handleDeny(actionData, approverEmail, messageName, chatClient) {
  const logger = getLogger();
  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: `Denied by ${approverEmail}`,
      cardsV2: buildDeniedCard(actionData, approverEmail),
    });
  }

  await chatClient.sendDm(
    actionData.requesterUserName,
    actionData.isOneTimeShareRequest
      ? `Your external share request ${actionData.approvalId} was denied.`
      : `Your access request ${actionData.approvalId} was denied.`,
    buildAccessDeniedDm(actionData.approvalId, actionData.identifier, {
      forFolder: actionData.isFolderRequest,
      forOneTimeShare: actionData.isOneTimeShareRequest,
      approverEmail,
      approverName: approverEmail,
    }),
  );

  logger.info({ approvalId: actionData.approvalId }, 'Denied access request');
}

/**
 * Handle grant failures with owner conflict UX.
 */
export async function handleGrantFailure({
  actionData,
  approverName,
  approverEmail,
  messageName,
  chatClient,
  keeperClient,
  errText,
  result,
}) {
  const logger = getLogger();

  if (isRecordOwnerError(result) || isRecordOwnerError(errText)) {
    const itemWord = actionData.isFolderRequest ? 'folder' : 'record';
    if (messageName) {
      await chatClient.patchMessage(messageName, {
        text: `User Already Has Full Access (Owner) — ${actionData.approvalId}`,
        cardsV2: buildOwnerAlreadyHasAccessCard(actionData, approverEmail),
      });
    }
    await chatClient.sendDm(
      approverName,
      `Access grant failed:\n\n` +
        `The selected user is the current owner of this ${itemWord} and already has full permissions.\n\n` +
        `Request ID: ${actionData.approvalId}\n` +
        `${itemWord === 'folder' ? 'Folder' : 'Record'}: ${actionData.identifier}`,
    );
    logger.info(
      { approvalId: actionData.approvalId, identifier: actionData.identifier },
      'Blocked grant — requester is record owner',
    );
    return;
  }

  await restoreApprovalCard(actionData, messageName, chatClient, keeperClient, {
    error: errText,
  });
  await chatClient.sendDm(
    approverName,
    `Approval failed for ${actionData.approvalId}:\n${errText}`,
  );
}
