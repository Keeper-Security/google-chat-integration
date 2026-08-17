/**
 * Approval request status cards.
 */

import {
  BTN,
  buildRequestCard,
  permissionAndDurationWidgets,
  typedAwareAction
} from './shared.js';

import { formatPermissionName, isPamUserRecordType } from '../utils.js';

/**
 * @param {import('./models.js').ApprovalActionData} actionData
 * @param {import('./models.js').KeeperRecord|import('./models.js').KeeperFolder|{folder?: import('./models.js').KeeperFolder, record?: import('./models.js').KeeperRecord}|null} item
 * @param {{ error?: string|null, selectedPermission?: string|null, selectedDuration?: string|null }} [options]
 */
export function buildApprovalCard(actionData, item = null, options = {}) {
  const params = actionData.toParameters();
  const isUid = actionData.isUid;
  const forFolder = actionData.isFolderRequest;
  const forOts = actionData.isOneTimeShareRequest;
  const folder = item?.folder || (item?.name != null && item?.folderType != null ? item : null);
  const record = item?.record || (item?.title != null && item?.recordType != null ? item : null);
  const detailsItem = forFolder ? folder : record;
  const error = options.error ? String(options.error).trim() : '';

  const isNsf = !forOts && Boolean(detailsItem?.isNsf || actionData.isNsf);
  const showPamRotate = forOts
    ? false
    : forFolder
      ? Boolean(actionData.isPamFolder) && !isNsf
      : Boolean(record && isPamUserRecordType(record.recordType));
  const selectedDuration =
    options.selectedDuration ||
    actionData.duration ||
    (forFolder || forOts ? '5m' : '1h');
  const selectedPermission = options.selectedPermission || null;
  const bodySections = [];

  if (error) {
    const safeError = error
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .slice(0, 500);
    bodySections.push({
      widgets: [
        { divider: {} },
        {
          textParagraph: {
            text:
              `<font color="#D93838"><b>Action failed — please retry.</b></font><br>` +
              `<font color="#666666">${safeError}</font>`,
          },
        },
      ],
    });
  }

  if (isUid && detailsItem) {
    let details;
    if (forFolder) {
      const typeDisplay = String(detailsItem.folderType || 'folder').replaceAll(
        '_',
        ' ',
      );
      details =
        `<b>Title:</b> ${detailsItem.name}<br>` + `<b>Type:</b> ${typeDisplay}`;
      if (detailsItem.isNsf) {
        details += '<br><b>Share mode:</b> Nested Share Folder (NSF)';
      }
    } else {
      details =
        `<b>Title:</b> ${detailsItem.title}<br>` +
        `<b>Type:</b> ${String(detailsItem.recordType).replaceAll('_', ' ')}`;
      if (detailsItem.isNsf) {
        details += '<br><b>Share mode:</b> Nested Share Folder (NSF)';
      }
      if (detailsItem.notes) {
        details += `<br><b>Description:</b> ${String(detailsItem.notes).slice(0, 200)}`;
      } else {
        details += '<br><b>Description:</b> <i>No description</i>';
      }
    }
    bodySections.push({
      widgets: [
        { divider: {} },
        {
          textParagraph: {
            text: `<b>${forFolder ? 'Folder' : 'Record'} Details</b><br><br>${details}`,
          },
        },
      ],
    });
  }

  if (isUid) {
    bodySections.push(
      {
        widgets: [
          { divider: {} },
          ...permissionAndDurationWidgets({
            isNsf,
            showPamRotate,
            selectedDuration,
            selectedPermission,
            forFolder,
            forOneTimeShare: forOts,
            excludePermanent: showPamRotate,
            actionData,
          }),
        ],
      },
      {
        widgets: [
          {
            buttonList: {
              buttons: [
                {
                  text: 'Approve',
                  color: BTN.approve,
                  onClick: {
                    action: {
                      function: typedAwareAction('approve_request', actionData),
                      parameters: [
                        ...params,
                        {
                          key: '__action',
                          value: typedAwareAction('approve_request', actionData),
                        },
                      ],
                    },
                  },
                },
                {
                  text: 'Deny',
                  color: BTN.deny,
                  onClick: {
                    action: {
                      function: typedAwareAction('deny_request', actionData),
                      parameters: [
                        ...params,
                        {
                          key: '__action',
                          value: typedAwareAction('deny_request', actionData),
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    );
  } else {
    const searchAction = typedAwareAction('search_records', actionData);
    const searchLabel = forFolder
      ? '🔍 Search Folders'
      : forOts
        ? '🔍 Search Records'
        : '🔍 Search Records';
    const actionText = forFolder
      ? '<b>Action Required:</b> Approver must search for the correct folder'
      : forOts
        ? '<b>Action Required:</b> Approver must search for the correct record'
        : '<b>Action Required:</b> Approver must search for the correct record';

    bodySections.push(
      {
        widgets: [
          { divider: {} },
          {
            columns: {
              columnItems: [
                {
                  horizontalSizeStyle: 'FILL_AVAILABLE_SPACE',
                  horizontalAlignment: 'START',
                  verticalAlignment: 'CENTER',
                  widgets: [{ textParagraph: { text: actionText } }],
                },
                {
                  horizontalSizeStyle: 'FILL_AVAILABLE_SPACE',
                  horizontalAlignment: 'END',
                  verticalAlignment: 'CENTER',
                  widgets: [
                    {
                      buttonList: {
                        buttons: [
                          {
                            text: searchLabel,
                            color: BTN.search,
                            onClick: {
                              action: {
                                function: searchAction,
                                parameters: [
                                  ...params,
                                  { key: '__action', value: searchAction },
                                ],
                              },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
      {
        widgets: [
          {
            buttonList: {
              buttons: [
                {
                  text: 'Deny Request',
                  color: BTN.deny,
                  onClick: {
                    action: {
                      function: typedAwareAction('deny_request', actionData),
                      parameters: [
                        ...params,
                        {
                          key: '__action',
                          value: typedAwareAction('deny_request', actionData),
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    );
    return buildRequestCard(actionData, bodySections);
  }

  return buildRequestCard(actionData, bodySections);
}

/**
 * Loading card shown while a long-running action is in progress.
 * Uses the same shell as approval/search so the message footprint stays stable.
 *
 * @param {import('./models.js').ApprovalActionData} actionData
 * @param {{ title: string, detail: string }} options
 */
export function buildLoadingCard(actionData, { title, detail }) {
  return buildRequestCard(actionData, [
    {
      widgets: [
        { divider: {} },
        {
          textParagraph: {
            text:
              `⏳ <b>${title}</b><br>` +
              `<i>${detail}</i><br><br>` +
              '<font color="#888888">Please wait — this card will update when the action completes.</font>',
          },
        },
      ],
    },
  ]);
}

export function buildApprovedCard(actionData, approverEmail, permission, expiresAt, extras = {}) {
  const forFolder = actionData.isFolderRequest;
  const itemLabel = forFolder ? 'Folder UID' : 'Record UID';
  const rotateNote = extras.rotateOnExpire
    ? '<br><b>PAM credentials will rotate</b> when access expires'
    : '';
  const inviteNote = extras.invitationSent
    ? '<br><b>Status:</b> Invitation sent (pending acceptance)'
    : '';
  const selfDestructNote = extras.selfDestruct
    ? `<br><br><b>Self-Destruct Record</b><br>Record will auto-delete after ${extras.selfDestructDuration || 'the configured duration'}.`
    : '';

  const expiresStr = String(expiresAt || '');
  const isPermanent =
    !expiresStr ||
    /never|no expiration|permanent|n\/a/i.test(expiresStr) ||
    /pending invitation/i.test(expiresStr);

  let title = forFolder
    ? 'Folder Access Request Approved'
    : actionData.isOneTimeShareRequest
      ? 'External Share Request Approved'
      : 'Record Access Request Approved';
  if (extras.selfDestruct) {
    title = 'Self-Destruct Record Access Approved';
  }
  if (extras.oneTimeShare) {
    title = 'External Share Request Approved';
  }

  let statusBlock;
  if (extras.oneTimeShare) {
    statusBlock =
      `<font color="#2EA35B"><b>External Share Link Created</b></font><br>` +
      `Link sent to requester • Expires: ${expiresAt}`;
  } else if (isPermanent) {
    statusBlock =
      `<font color="#2EA35B"><b>Access Granted (No Expiration)</b></font><br>` +
      'Access remains active indefinitely';
  } else {
    statusBlock =
      `<font color="#2EA35B"><b>Temporary Access Granted</b></font><br>` +
      `Access will expire on <b>${expiresAt}</b>` +
      rotateNote;
  }

  return buildRequestCard(
    actionData,
    [
      {
        widgets: [
          { divider: {} },
          {
            textParagraph: {
              text:
                `<b>${itemLabel}:</b> <code>${actionData.identifier}</code><br>` +
                `<b>Approved by:</b> ${approverEmail}` +
                (extras.oneTimeShare
                  ? ''
                  : `<br><b>Permission:</b> ${formatPermissionName(permission)}`) +
                inviteNote +
                selfDestructNote +
                `<br><br>${statusBlock}`,
            },
          },
        ],
      },
    ],
    { title },
  );
}

export function buildDeniedCard(actionData, approverEmail) {
  const title = actionData.isOneTimeShareRequest
    ? 'External Share Request Denied ✗'
    : actionData.isFolderRequest
      ? 'Folder Access Request Denied ✗'
      : 'Record Access Request Denied ✗';
  return buildRequestCard(
    actionData,
    [
      {
        widgets: [
          { divider: {} },
          {
            textParagraph: {
              text:
                `<font color="#D93838"><b>Access request denied.</b></font><br><br>` +
                `<b>Denied by:</b> ${approverEmail}`,
            },
          },
        ],
      },
    ],
    { title },
  );
}

/**
 * Terminal approval status when the requester already owns the record 
 */
export function buildOwnerAlreadyHasAccessCard(actionData, approverEmail) {
  return buildRequestCard(
    actionData,
    [
      {
        widgets: [
          { divider: {} },
          {
            textParagraph: {
              text:
                `<font color="#D97706"><b>User Already Has Full Access (Owner)</b></font><br><br>` +
                `The requester already owns this record and has full access.<br>` +
                `No share change was applied.<br><br>` +
                `<b>Record:</b> <code>${actionData.identifier}</code><br>` +
                `<b>Reviewed by:</b> ${approverEmail}`,
            },
          },
        ],
      },
    ],
    { title: 'User Already Has Full Access (Owner)' },
  );
}
