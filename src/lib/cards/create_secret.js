/**
 * Create-secret interactive cards.
 */

import { BTN, escapeHtmlText, truncateLabel } from './shared.js';
import { encodeSearchItemValue } from '../models.js';

const CANCEL_BUTTON = {
  text: 'Cancel',
  color: BTN.back,
  onClick: {
    action: {
      function: 'create_secret_cancel',
      parameters: [{ key: '__action', value: 'create_secret_cancel' }],
    },
  },
};

/**
 * Step 1 — pick a shared folder for /keeper-create-secret.
 * @param {Array<{ uid: string, name: string, is_nsf?: boolean }>} sharedFolders
 * @param {{ error?: string|null }} [options]
 */
export function buildCreateSecretFolderSelectCard(sharedFolders, options = {}) {
  const error = options.error || null;
  const items = (sharedFolders || []).slice(0, 100).map((folder) => ({
    text: truncateLabel(folder.name || 'Untitled', 75),
    value: encodeSearchItemValue(folder.uid, Boolean(folder.is_nsf)),
  }));

  /** @type {object[]} */
  const widgets = [];
  if (error) {
    widgets.push({
      textParagraph: {
        text: `<font color="#D93838"><b>${escapeHtmlText(error)}</b></font>`,
      },
    });
    widgets.push({ divider: {} });
  }

  widgets.push({
    textParagraph: {
      text:
        '<b>Create a new secret record</b><br><br>' +
        'Select the shared folder where you want to create the record.',
    },
  });
  widgets.push({ divider: {} });
  widgets.push({
    selectionInput: {
      name: 'shared_folder',
      label: 'Shared Folder',
      type: 'DROPDOWN',
      items,
    },
  });

  return [
    {
      cardId: 'create-secret-folder',
      card: {
        header: { title: 'Create Secret' },
        sections: [
          { widgets },
          {
            widgets: [
              {
                buttonList: {
                  buttons: [
                    CANCEL_BUTTON,
                    {
                      text: 'Next',
                      onClick: {
                        action: {
                          function: 'create_secret_next',
                          parameters: [
                            { key: '__action', value: 'create_secret_next' },
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
  ];
}

/**
 * Step 2 — record details form for /keeper-create-secret.
 * @param {{
 * folderName: string,
 * folderUid: string,
 * parentIsNsf?: boolean,
 * subfolders?: Array<{ uid: string, name: string, path?: string, is_nsf?: boolean }>|null,
 * error?: string|null,
 * formValues?: object,
 * }} options
 */
export function buildCreateSecretRecordFormCard(options) {
  const folderName = options.folderName || 'Shared Folder';
  const folderUid = options.folderUid || '';
  const parentIsNsf = Boolean(options.parentIsNsf);
  const subfolders = options.subfolders || [];
  const error = options.error || null;
  const form = options.formValues || {};

  const params = [
    { key: 'folder_uid', value: folderUid },
    { key: 'folder_name', value: folderName },
    { key: 'parent_is_nsf', value: String(parentIsNsf) },
    { key: '__action', value: 'create_secret_submit' },
  ];

  /** @type {object[]} */
  const sections = [];

  if (error) {
    sections.push({
      widgets: [
        {
          textParagraph: {
            text: `<font color="#D93838"><b>Could not create record</b></font><br><code>${escapeHtmlText(error)}</code>`,
          },
        },
        { divider: {} },
      ],
    });
  }

  /** @type {object[]} */
  const formWidgets = [
    {
      textParagraph: {
        text: `<b>Creating record in:</b> <code>${escapeHtmlText(folderName)}</code>`,
      },
    },
    {
      textParagraph: {
        text:
          '\u26A0\uFE0F  Auto-generate password to keep it fully private. Generated passwords stay in your Keeper Vault ' +
          '(zero-knowledge), while manually entered passwords pass through Google Chat.',
      },
    },
    { divider: {} },
  ];

  if (subfolders.length) {
    const subfolderItems = [
      {
        text: '(Parent folder)',
        value: encodeSearchItemValue(folderUid, parentIsNsf),
        selected: !form.subfolder,
      },
      ...subfolders.slice(0, 99).map((sf) => {
        const value = encodeSearchItemValue(sf.uid, Boolean(sf.is_nsf));
        return {
          text: truncateLabel(sf.path || sf.name || 'Untitled', 75),
          value,
          selected: form.subfolder === value,
        };
      }),
    ];
    formWidgets.push({
      selectionInput: {
        name: 'subfolder',
        label: 'Subfolder (optional)',
        type: 'DROPDOWN',
        items: subfolderItems,
      },
    });
  }

  formWidgets.push(
    {
      textInput: {
        name: 'secret_title',
        label: 'Title (Required)',
        value: form.secret_title || '',
        type: 'SINGLE_LINE',
        hintText: 'Record title',
      },
    },
    {
      textInput: {
        name: 'secret_login',
        label: 'Login (optional)',
        value: form.secret_login || '',
        type: 'SINGLE_LINE',
        hintText: 'Email or username',
      },
    },
    {
      selectionInput: {
        name: 'auto_gen_password',
        label: 'Password Generation',
        type: 'CHECK_BOX',
        items: [
          {
            text: '\u{1F3B2} Auto-generate password',
            value: 'auto_gen',
            selected: Boolean(form.auto_gen),
          },
        ],
      },
    },
    {
      textInput: {
        name: 'secret_password',
        label: 'Password (optional)',
        type: 'SINGLE_LINE',
        hintText: 'Enter password (or check auto-generate above)',
      },
    },
    {
      textInput: {
        name: 'secret_url',
        label: 'Website Address (optional)',
        value: form.secret_url || '',
        type: 'SINGLE_LINE',
        hintText: 'https://',
      },
    },
    {
      textInput: {
        name: 'secret_notes',
        label: 'Notes (optional)',
        value: form.secret_notes || '',
        type: 'MULTIPLE_LINE',
        hintText: 'Additional notes',
      },
    },
  );

  sections.push({ widgets: formWidgets });
  sections.push({
    widgets: [
      {
        buttonList: {
          buttons: [
            CANCEL_BUTTON,
            {
              text: 'Create Record',
              onClick: {
                action: {
                  function: 'create_secret_submit',
                  parameters: params,
                },
              },
            },
          ],
        },
      },
    ],
  });

  return [
    {
      cardId: 'create-secret-form',
      card: {
        header: { title: 'Create Secret' },
        sections,
      },
    },
  ];
}

/**
 * Cancelled / closed create-secret flow (no interactive controls).
 */
export function buildCreateSecretCancelledCard() {
  return [
    {
      cardId: 'create-secret-cancelled',
      card: {
        header: { title: 'Create Secret' },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text:
                    '<b>Create secret cancelled.</b><br><br>' +
                    'No record was created. Run <code>/keeper-create-secret</code> again to start over.',
                },
              },
            ],
          },
        ],
      },
    },
  ];
}

/**
 * Success card after /keeper-create-secret creates a record.
 */
export function buildCreateSecretSuccessCard({
  title,
  recordUid,
  folderPath,
}) {
  return [
    {
      cardId: 'create-secret-success',
      card: {
        header: { title: 'Create Secret' },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text:
                    '<b>Record Created Successfully!</b><br><br>' +
                    `<b>Title:</b> ${escapeHtmlText(title)}<br>` +
                    `<b>Record UID:</b> <code>${escapeHtmlText(recordUid)}</code><br>` +
                    `<b>Folder:</b> ${escapeHtmlText(folderPath)}<br><br>` +
                    'The record has been created in the Keeper vault.',
                },
              },
            ],
          },
        ],
      },
    },
  ];
}

/**
 * Approvals-space notification (no secrets) when a user creates a record.
 */
export function buildCreateSecretNotificationCard({
  userLabel,
  recordUid,
  recordTitle,
  folderPath,
}) {
  return [
    {
      cardId: 'create-secret-notify',
      card: {
        header: { title: 'New Secret Record Created' },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text:
                    `<b>User:</b> ${escapeHtmlText(userLabel)}<br>` +
                    `<b>Record UID:</b> <code>${escapeHtmlText(recordUid)}</code><br>` +
                    `<b>Title:</b> ${escapeHtmlText(recordTitle)}<br>` +
                    `<b>Folder:</b> ${escapeHtmlText(folderPath)}`,
                },
              },
              {
                textParagraph: {
                  text: `<font color="#666666"><i>Created via /keeper-create-secret</i></font>`,
                },
              },
            ],
          },
        ],
      },
    },
  ];
}
