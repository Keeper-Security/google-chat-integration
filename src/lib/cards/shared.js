/**
 * Shared card helpers (permissions, duration, request chrome).
 */

import { isPermanentOnlyPermission, NSFPermissionRole, PermissionLevel } from '../models.js';

import { formatTimestamp, sanitizeHyperlinks } from '../utils.js';

/** Filled button colors (RGB floats 0–1). Setting color forces FILLED style. */
export const BTN = {
  approve: { red: 0.18, green: 0.64, blue: 0.36 }, // green
  deny: { red: 0.85, green: 0.22, blue: 0.22 }, // red
  search: { red: 0.2, green: 0.45, blue: 0.9 }, // blue
  back: { red: 0.45, green: 0.45, blue: 0.5 }, // gray
};

/**
 * Cap search radios so approval ↔ search patches keep a similar vertical size.
 * Chat has no fixed-height cards; we approximate with a result cap.
 */
export const SEARCH_RESULT_DISPLAY_LIMIT = 6;

/**
 * Folder / OTS flows use distinct action method names so Chat click routing
 * stays correct even when card parameters drop `request_type`.
 *
 * @param {string} baseAction
 * @param {import('./models.js').ApprovalActionData} actionData
 */
export function typedAwareAction(baseAction, actionData) {
  if (actionData?.isFolderRequest) {
    const map = {
      approve_request: 'approve_request_folder',
      deny_request: 'deny_request_folder',
      refine_search: 'refine_search_folders',
      resync_vault: 'resync_vault_folders',
      update_search_selection: 'update_search_selection_folders',
      update_permission_selection: 'update_permission_selection_folders',
      back_to_approval: 'back_to_approval_folders',
      approve_search_result: 'approve_search_result_folders',
      search_records: 'search_folders',
    };
    return map[baseAction] || baseAction;
  }
  if (actionData?.isOneTimeShareRequest) {
    const map = {
      approve_request: 'approve_request_ots',
      deny_request: 'deny_request_ots',
      refine_search: 'refine_search_ots',
      resync_vault: 'resync_vault_ots',
      update_search_selection: 'update_search_selection_ots',
      update_permission_selection: 'update_permission_selection_ots',
      back_to_approval: 'back_to_approval_ots',
      approve_search_result: 'approve_search_result_ots',
      search_records: 'search_ots',
    };
    return map[baseAction] || baseAction;
  }
  return baseAction;
}

/** @deprecated use typedAwareAction */
export function folderAwareAction(baseAction, forFolder) {
  return typedAwareAction(baseAction, { isFolderRequest: forFolder });
}

export function markSelected(items, selectedValue) {
  const selected = selectedValue || items[0]?.value;
  return items.map((item) => ({
    text: item.text,
    value: item.value,
    selected: item.value === selected,
  }));
}

export function classicPermissionItems(selectedValue = PermissionLevel.VIEW_ONLY) {
  return markSelected(
    [
      { text: 'View Only', value: PermissionLevel.VIEW_ONLY },
      { text: 'Can Edit', value: PermissionLevel.CAN_EDIT },
      { text: 'Can Share', value: PermissionLevel.CAN_SHARE },
      { text: 'Edit and Share', value: PermissionLevel.EDIT_AND_SHARE },
      { text: 'Change Owner', value: PermissionLevel.CHANGE_OWNER },
    ],
    selectedValue,
  );
}

export function classicFolderPermissionItems(
  selectedValue = PermissionLevel.NO_PERMISSIONS,
) {
  return markSelected(
    [
      { text: 'No User Permissions', value: PermissionLevel.NO_PERMISSIONS },
      { text: 'Can Manage Users', value: PermissionLevel.MANAGE_USERS },
      { text: 'Can Manage Records', value: PermissionLevel.MANAGE_RECORDS },
      {
        text: 'Can Manage Records and Users',
        value: PermissionLevel.MANAGE_ALL,
      },
    ],
    selectedValue,
  );
}

export function nsfPermissionItems({
  forFolder = false,
  selectedValue = NSFPermissionRole.VIEWER,
} = {}) {
  const items = [
    { text: 'Viewer (read-only)', value: NSFPermissionRole.VIEWER },
    { text: 'Share Manager', value: NSFPermissionRole.SHARE_MANAGER },
    { text: 'Content Manager', value: NSFPermissionRole.CONTENT_MANAGER },
    {
      text: 'Content & Share Manager',
      value: NSFPermissionRole.CONTENT_SHARE_MANAGER,
    },
    { text: 'Full Manager', value: NSFPermissionRole.FULL_MANAGER },
  ];
  if (!forFolder) {
    items.push({
      text: 'Transfer Ownership',
      value: NSFPermissionRole.TRANSFER_OWNER,
    });
  }
  return markSelected(items, selectedValue);
}

export function otsPermissionItems(selectedValue = PermissionLevel.VIEW_ONLY) {
  return markSelected(
    [
      { text: 'View Only', value: PermissionLevel.VIEW_ONLY },
      { text: 'Can Edit', value: PermissionLevel.CAN_EDIT },
    ],
    selectedValue,
  );
}

export function defaultPermissionValue({
  forFolder = false,
  isNsf = false,
  forOneTimeShare = false,
} = {}) {
  if (forOneTimeShare) return PermissionLevel.VIEW_ONLY;
  if (isNsf) return NSFPermissionRole.VIEWER;
  if (forFolder) return PermissionLevel.NO_PERMISSIONS;
  return PermissionLevel.VIEW_ONLY;
}

export function permissionAndDurationWidgets({
  isNsf = false,
  showPamRotate = false,
  selectedDuration = '5m',
  selectedPermission = null,
  forFolder = false,
  forOneTimeShare = false,
  excludePermanent = false,
  actionData = null,
} = {}) {
  const permissionValue =
    selectedPermission ||
    defaultPermissionValue({ forFolder, isNsf, forOneTimeShare });

  let permissionItems;
  if (forOneTimeShare) {
    permissionItems = otsPermissionItems(permissionValue);
  } else if (isNsf) {
    permissionItems = nsfPermissionItems({
      forFolder,
      selectedValue: permissionValue,
    });
  } else if (forFolder) {
    permissionItems = classicFolderPermissionItems(permissionValue);
  } else {
    permissionItems = classicPermissionItems(permissionValue);
  }

  const hideDuration = isPermanentOnlyPermission(permissionValue, {
    forFolder,
    isNsf,
    forOneTimeShare,
  });

  /** @type {object[]} */
  const widgets = [
    {
      selectionInput: {
        name: 'permission',
        label: isNsf
          ? 'Select Permission Level (Nested Share Folder)'
          : 'Select Permission Level',
        type: 'DROPDOWN',
        items: permissionItems,
        ...(actionData
          ? {
              onChangeAction: {
                function: typedAwareAction(
                  'update_permission_selection',
                  actionData,
                ),
                parameters: [
                  ...actionData.toParameters(),
                  {
                    key: '__action',
                    value: typedAwareAction(
                      'update_permission_selection',
                      actionData,
                    ),
                  },
                ],
              },
            }
          : {}),
      },
    },
  ];

  if (hideDuration) {
    widgets.push({
      textParagraph: {
        text:
          'ℹ️ <b>Permanent Access:</b> The selected permission does not support time limits. ' +
          'Expiration is ignored.',
      },
    });
    return widgets;
  }

  widgets.push(
    {
      selectionInput: {
        name: 'duration',
        label: 'Grant Access For (optional)',
        type: 'DROPDOWN',
        items: durationItems(selectedDuration, { excludePermanent }),
      },
    },
    {
      textParagraph: {
        text: forOneTimeShare
          ? '<font color="#666666"><i>Select how long the external share link should remain active. ' +
            'View Only or Can Edit only. Permanent maps to a 7-day Keeper default.</i></font>'
          : forFolder
            ? '<font color="#666666"><i>Select how long access should remain active. ' +
              '<b>Can Manage Users</b> and <b>Can Manage Records and Users</b> are permanent only — expiration is ignored.</i></font>'
            : isNsf
              ? '<font color="#666666"><i>Select how long access should remain active. ' +
                'Transfer Ownership is permanent only — expiration is ignored.</i></font>'
              : '<font color="#666666"><i>Select how long the access should remain active. ' +
                '<b>Can Share</b>, <b>Edit and Share</b>, and <b>Change Owner</b> are permanent only.</i></font>',
      },
    },
  );

  if (showPamRotate) {
    widgets.push(pamRotateWidget({ forFolder }));
    widgets.push({
      textParagraph: {
        text: forFolder
          ? '<i>PAM User folder: credentials in this folder will rotate when time-limited access expires ' +
            '(rotation must be configured on the underlying records).</i>'
          : '<i>Rotate applies only to PAM User records with time-limited access. ' +
            'Rotation must already be configured on the record in Keeper Vault.</i>',
      },
    });
  }
  return widgets;
}

export function durationItems(selectedDuration = '5m', { excludePermanent = false } = {}) {
  const selected = selectedDuration || '5m';
  const items = [
    { text: '2 minutes', value: '2m', selected: selected === '2m' },
    { text: '5 minutes', value: '5m', selected: selected === '5m' },
    { text: '10 minutes', value: '10m', selected: selected === '10m' },
    { text: '30 minutes', value: '30m', selected: selected === '30m' },
    { text: '1 hour', value: '1h', selected: selected === '1h' },
    { text: '4 hours', value: '4h', selected: selected === '4h' },
    { text: '8 hours', value: '8h', selected: selected === '8h' },
    { text: '24 hours', value: '24h', selected: selected === '24h' },
    { text: '7 days', value: '7d', selected: selected === '7d' },
    { text: '30 days', value: '30d', selected: selected === '30d' },
  ];
  if (!excludePermanent) {
    items.push({
      text: 'No Expiration',
      value: 'permanent',
      selected: selected === 'permanent',
    });
  }
  if (excludePermanent && selected === 'permanent' && items.length) {
    items.forEach((item, idx) => {
      item.selected = idx === 0;
    });
  }
  return items;
}

export function pamRotateWidget({ forFolder = false } = {}) {
  return {
    selectionInput: {
      name: 'pam_rotate',
      label: forFolder ? 'PAM folder rotation' : 'PAM credential rotation',
      type: 'CHECK_BOX',
      items: [
        {
          text: 'Rotate credentials when access expires',
          value: 'rotate_on_expire',
          selected: true,
        },
      ],
    },
  };
}

export function fieldWidget(label, value) {
  return {
    decoratedText: {
      topLabel: label,
      text: String(value || ''),
      wrapText: true,
    },
  };
}

/**
 * Two-column request summary for approval / loading / search cards.
 * Kept identical across those cards so width stays stable.
 *
 * @param {import('./models.js').ApprovalActionData} actionData
 * @param {{ searchedQuery?: string }} [options]
 */
export function requestSummaryColumns(actionData, options = {}) {
  const searchedQuery = options.searchedQuery || '';
  const itemLabel = actionData.isFolderRequest
    ? 'Folder'
    : actionData.isOneTimeShareRequest
      ? 'Record'
      : 'Record';
  // Identifier / justification are sanitized to prevent URL injection.
  const safeIdentifier = sanitizeHyperlinks(actionData.identifier);
  const safeJustification = sanitizeHyperlinks(actionData.justification);
  const leftWidgets = [
    fieldWidget('Requester', actionData.requesterLabel),
    fieldWidget(itemLabel, `<code>${safeIdentifier}</code>`),
  ];
  if (searchedQuery && searchedQuery !== actionData.identifier) {
    leftWidgets.push(
      fieldWidget('Searched', `<code>${sanitizeHyperlinks(searchedQuery)}</code>`),
    );
  }
  leftWidgets.push(fieldWidget('Requested', formatTimestamp()));

  return {
    columns: {
      columnItems: [
        {
          horizontalSizeStyle: 'FILL_AVAILABLE_SPACE',
          horizontalAlignment: 'START',
          verticalAlignment: 'TOP',
          widgets: leftWidgets,
        },
        {
          horizontalSizeStyle: 'FILL_AVAILABLE_SPACE',
          horizontalAlignment: 'START',
          verticalAlignment: 'TOP',
          widgets: [
            fieldWidget('Request ID', `<code>${actionData.approvalId}</code>`),
            fieldWidget('Justification', safeJustification),
          ],
        },
      ],
    },
  };
}

/**
 * Shared card shell — same cardId + header + summary on every interactive step
 * so Google Chat does not jump when we patch loader / search / create / back.
 *
 * Keep the header title stable during interactive flows; only approved/denied
 * should override it via options.title.
 *
 * @param {import('./models.js').ApprovalActionData} actionData
 * @param {object[]} bodySections - sections below the summary
 * @param {{ title?: string, searchedQuery?: string }} [options]
 */
export function buildRequestCard(actionData, bodySections, options = {}) {
  const title =
    options.title ||
    (actionData.isOneTimeShareRequest
      ? 'External Share Request'
      : actionData.isFolderRequest
        ? 'Folder Access Request'
        : 'Record Access Request');
  return [
    {
      cardId: `approval-${actionData.approvalId}`,
      card: {
        header: { title },
        sections: [
          {
            widgets: [
              requestSummaryColumns(actionData, {
                searchedQuery: options.searchedQuery,
              }),
            ],
          },
          ...bodySections,
        ],
      },
    },
  ];
}

export function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function truncateLabel(value, maxLen) {
  const text = String(value || '');
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

export function escapeHtmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
