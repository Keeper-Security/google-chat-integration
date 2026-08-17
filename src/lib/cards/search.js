/**
 * Search results cards.
 */

import {
  BTN,
  SEARCH_RESULT_DISPLAY_LIMIT,
  buildRequestCard,
  permissionAndDurationWidgets,
  typedAwareAction
} from './shared.js';
import { encodeSearchItemValue } from '../models.js';
import { formatDuration, isPamUserRecordType } from '../utils.js';

/**
 * Search Records / Folders card — body only; keeps the shared approval shell
 * (same header + summary) so open/close does not resize the Chat message.
 *
 * @param {import('./models.js').ApprovalActionData} actionData
 * @param {Array<import('./models.js').KeeperRecord|import('./models.js').KeeperFolder>} results
 * @param {{ selectedValue?: string|null, selectedDuration?: string, selectedPermission?: string|null, currentQuery?: string, isPamFolder?: boolean }} [options]
 */
export function buildSearchResultsCard(actionData, results, options = {}) {
  const forFolder = actionData.isFolderRequest;
  const forOts = actionData.isOneTimeShareRequest;
  const selectedValue = options.selectedValue || null;
  const selectedDuration =
    options.selectedDuration ||
    actionData.duration ||
    (forFolder || forOts ? '5m' : '1h');
  const selectedPermission = options.selectedPermission || null;
  const currentQuery = options.currentQuery || actionData.identifier;
  const params = actionData.toParameters();
  const showCreateNew = !forFolder && !forOts && !actionData.isUid;
  const isSelfDestruct =
    !forFolder && !forOts && Boolean(actionData.createSelfDestruct);
  const itemWord = forFolder ? 'folder' : 'record';
  const totalFound = Array.isArray(results) ? results.length : 0;
  const displayResults = (results || []).slice(0, SEARCH_RESULT_DISPLAY_LIMIT);

  /** @type {object[]} */
  const actionButtons = [
    {
      text: '🔍 Refine Search',
      onClick: {
        action: {
          function: typedAwareAction('refine_search', actionData),
          parameters: [
            ...params,
            {
              key: '__action',
              value: typedAwareAction('refine_search', actionData),
            },
          ],
        },
      },
    },
  ];
  if (showCreateNew) {
    actionButtons.push({
      text: 'Create New Record',
      color: BTN.approve,
      onClick: {
        action: {
          function: 'create_new_record',
          parameters: [
            ...params,
            { key: '__action', value: 'create_new_record' },
          ],
        },
      },
    });
  }

  /** @type {object[]} */
  const bodySections = [
    {
      widgets: [
        { divider: {} },
        {
          textParagraph: {
            text: forFolder
              ? '<b>Search Folders</b>'
              : forOts
                ? '<b>Search Records (External Share)</b>'
                : '<b>Search Records</b>',
          },
        },
        {
          textInput: {
            name: 'search_query',
            label: 'Search Term',
            value: currentQuery,
            type: 'SINGLE_LINE',
            hintText:
              'Modify the search term and click the Refine button below.',
          },
        },
        { buttonList: { buttons: actionButtons } },
      ],
    },
  ];

  if (showCreateNew) {
    bodySections.push({
      widgets: [
        {
          textParagraph: {
            text: '<font color="#666666"><i>Or create a new record and share it</i></font>',
          },
        },
      ],
    });
  }

  const showingCount = displayResults.length;
  const countLabel =
    totalFound > SEARCH_RESULT_DISPLAY_LIMIT
      ? `Showing ${showingCount} of ${totalFound}`
      : `Showing ${showingCount}`;

  bodySections.push({
    widgets: [
      {
        columns: {
          columnItems: [
            {
              horizontalSizeStyle: 'FILL_AVAILABLE_SPACE',
              horizontalAlignment: 'START',
              verticalAlignment: 'CENTER',
              widgets: [
                {
                  textParagraph: {
                    text:
                      showingCount === 0
                        ? `⚠️ <i>Showing 0 result(s) for:</i> <font color="#c5221f"><code>${currentQuery}</code></font>`
                        : `<i>${countLabel} result(s) for:</i> <font color="#c5221f"><code>${currentQuery}</code></font>`,
                  },
                },
              ],
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
                        text: '↻ Re-sync Vault',
                        onClick: {
                          action: {
                            function: typedAwareAction('resync_vault', actionData),
                            parameters: [
                              ...params,
                              {
                                key: '__action',
                                value: typedAwareAction('resync_vault', actionData),
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
          ],
        },
      },
      { divider: {} },
    ],
  });

  if (!forFolder && actionData.newlyCreatedUid && actionData.newlyCreatedTitle) {
    bodySections.push({
      widgets: [
        {
          textParagraph: {
            text: `✅ New record <b>'${actionData.newlyCreatedTitle}'</b> created`,
          },
        },
      ],
    });
  }

  if (displayResults.length === 0) {
    bodySections.push({
      widgets: [
        {
          textParagraph: {
            text: forFolder
              ? `<b>No matching folders found.</b><br>` +
                '<font color="#666666">Try a different search term or re-sync the vault.</font>'
              : '<b>No matching records found.</b><br>' +
                '<font color="#666666">Try a different search term, re-sync the vault, or create a new record.</font>',
          },
        },
      ],
    });
  } else {
    const normalized = displayResults.map((item) => {
      const isFolderItem = Boolean(item.name != null && item.folderType != null);
      return {
        uid: item.uid,
        title: isFolderItem ? item.name : item.title,
        itemType: isFolderItem ? item.folderType : item.recordType,
        isNsf: Boolean(item.isNsf),
      };
    });

    const encodedValues = normalized.map((r) =>
      encodeSearchItemValue(r.uid, Boolean(r.isNsf), r.itemType),
    );
    let selectedIndex = 0;
    if (selectedValue) {
      const idx = encodedValues.indexOf(selectedValue);
      if (idx >= 0) {
        selectedIndex = idx;
      } else {
        const [selUid] = String(selectedValue).split('|');
        const byUid = normalized.findIndex((r) => r.uid === selUid);
        if (byUid >= 0) selectedIndex = byUid;
      }
    } else if (!forFolder && actionData.newlyCreatedUid) {
      const byNew = normalized.findIndex(
        (r) => r.uid === actionData.newlyCreatedUid,
      );
      if (byNew >= 0) selectedIndex = byNew;
    }

    const selectedItem = normalized[selectedIndex];
    const useNsfPermissions = !forOts && Boolean(selectedItem.isNsf);
    const showPamRotate = forOts
      ? false
      : forFolder
      ? !useNsfPermissions &&
        Boolean(
          options.isPamFolder != null
            ? options.isPamFolder
            : actionData.isPamFolder,
        )
      : !isSelfDestruct && isPamUserRecordType(selectedItem.itemType);
    const nsfFlags = normalized.map((r) => Boolean(r.isNsf));
    const isMixedResults = new Set(nsfFlags).size > 1;

    const recordItems = normalized.map((r, index) => {
      const text = forOts
        ? `${r.title} (${r.uid})`
        : `${r.isNsf ? '[NSF]' : '[Classic]'} ${r.title} (${r.uid})`;
      return {
        text,
        value: encodedValues[index],
        selected: index === selectedIndex,
      };
    });

    const selectionWidgets = [
      {
        selectionInput: {
          name: 'selected_record',
          label: `Select ${itemWord}:`,
          type: 'RADIO_BUTTON',
          items: recordItems,
          onChangeAction: {
            function: typedAwareAction('update_search_selection', actionData),
            parameters: [
              ...params,
              {
                key: '__action',
                value: typedAwareAction('update_search_selection', actionData),
              },
            ],
          },
        },
      },
    ];

    if (isMixedResults && !isSelfDestruct && !forOts) {
      selectionWidgets.push({
        textParagraph: {
          text:
            '<font color="#666666"><i>Results include both Classic and Nested Share Folder items. ' +
            'Pick one above to load the matching permission options.</i></font>',
        },
      });
    }

    if (!isSelfDestruct && !forOts) {
      selectionWidgets.push({
        textParagraph: {
          text: useNsfPermissions
            ? '📁 <b>Nested Share Folder</b> — role-based permissions'
            : '🔑 <b>Classic Share Folder</b> — standard share permissions',
        },
      });
    }

    bodySections.push({ widgets: selectionWidgets });

    if (isSelfDestruct) {
      bodySections.push({
        widgets: [
          {
            textParagraph: {
              text:
                `<b>Self-Destruct Record Settings</b><br><br>` +
                `Record will be shared directly to requester's vault<br>` +
                `Auto-deletes after: <b>${formatDuration(actionData.selfDestructDuration)}</b><br>` +
                `Access: View-Only`,
            },
          },
        ],
      });
    } else {
      bodySections.push({
        widgets: permissionAndDurationWidgets({
          isNsf: useNsfPermissions,
          showPamRotate,
          selectedDuration,
          selectedPermission,
          forFolder,
          forOneTimeShare: forOts,
          excludePermanent: showPamRotate,
          actionData,
        }),
      });
    }
  }

  /** @type {object[]} */
  const footerButtons = [
    {
      text: 'Close',
      onClick: {
        action: {
          function: typedAwareAction('back_to_approval', actionData),
          parameters: [
            ...params,
            {
              key: '__action',
              value: typedAwareAction('back_to_approval', actionData),
            },
          ],
        },
      },
    },
  ];
  if (displayResults.length > 0) {
    footerButtons.push({
      text: 'Approve Access',
      color: BTN.approve,
      onClick: {
        action: {
          function: typedAwareAction('approve_search_result', actionData),
          parameters: [
            ...params,
            {
              key: '__action',
              value: typedAwareAction('approve_search_result', actionData),
            },
          ],
        },
      },
    });
  }

  bodySections.push({
    widgets: [
      { divider: {} },
      { buttonList: { buttons: footerButtons } },
    ],
  });

 // Empty search stays compact — shared shell already stabilizes header/summary.
  return buildRequestCard(actionData, bodySections, {
    searchedQuery: currentQuery,
  });
}
