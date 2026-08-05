/**
 * Approver create-record form card.
 */

import { BTN, buildRequestCard } from './shared.js';

/**
 * Create New Record card (Chat in-place form; no stacked modal API).
 *
 * @param {import('./models.js').ApprovalActionData} actionData
 * @param {{
 *   originalQuery?: string,
 *   useClassic?: boolean,
 *   showExpiration?: boolean,
 *   error?: string|null,
 *   formValues?: Record<string, string|boolean>,
 * }} [options]
 */
export function buildCreateRecordCard(actionData, options = {}) {
  const useClassic = Boolean(options.useClassic);
  const showExpiration = Boolean(options.showExpiration) && useClassic;
  const originalQuery = options.originalQuery || actionData.identifier || '';
  const error = options.error || null;
  const form = options.formValues || {};
  const params = [
    ...actionData.toParameters(),
    { key: 'create_use_classic', value: String(useClassic) },
    { key: 'create_show_expiration', value: String(showExpiration) },
    { key: 'create_original_query', value: originalQuery },
  ];

  /** @type {object[]} */
  const sections = [];

  if (error) {
    sections.push({
      widgets: [
        {
          textParagraph: {
            text: `<font color="#D93838"><b>Could not create record</b></font><br><code>${error}</code>`,
          },
        },
        { divider: {} },
      ],
    });
  }

  sections.push({
    widgets: [
      {
        textParagraph: {
          text:
            `<b>Creating record for:</b> ${actionData.requesterLabel}<br>` +
            `<font color="#666666"><i>After creation, you'll be able to review and approve sharing</i></font>`,
        },
      },
      {
        textParagraph: {
          text:
            '⚠️ Auto-generate password to keep it fully private. Generated passwords stay in your Keeper Vault ' +
            '(zero-knowledge), while manually entered passwords pass through Google Chat.',
        },
      },
      { divider: {} },
    ],
  });

  sections.push({
    widgets: [
      {
        selectionInput: {
          name: 'classic_vault',
          label: 'Vault Type (optional)',
          type: 'CHECK_BOX',
          items: [
            {
              text: 'Use Classic permission model',
              value: 'classic',
              selected: useClassic,
            },
          ],
          onChangeAction: {
            function: 'create_record_toggle_classic',
            parameters: [
              ...params,
              { key: '__action', value: 'create_record_toggle_classic' },
            ],
          },
        },
      },
      {
        textParagraph: {
          text: useClassic
            ? '<font color="#666666"><i>Classic share permissions. Self-destruct is available below.</i></font>'
            : '<font color="#666666"><i>Unchecked = Nested Share Folder record (role-based sharing). Self-destruct is Classic-only.</i></font>',
        },
      },
      { divider: {} },
    ],
  });

  sections.push({
    widgets: [
      {
        textInput: {
          name: 'record_title',
          label: 'Title (Required)',
          value: form.record_title || originalQuery,
          type: 'SINGLE_LINE',
          hintText: 'Title',
        },
      },
      {
        textInput: {
          name: 'record_login',
          label: 'Login (Required)',
          value: form.record_login || '',
          type: 'SINGLE_LINE',
          hintText: 'Email or Username',
        },
      },
      {
        selectionInput: {
          name: 'auto_gen_password',
          label: 'Password Generation',
          type: 'CHECK_BOX',
          items: [
            {
              text: '🎲 Auto-generate password',
              value: 'auto_gen',
              selected: Boolean(form.auto_gen),
            },
          ],
        },
      },
      {
        textInput: {
          name: 'record_password',
          label: 'Password',
          value: form.record_password || '',
          type: 'SINGLE_LINE',
          hintText: 'Enter password (or check auto-generate above)',
        },
      },
      {
        textInput: {
          name: 'record_url',
          label: 'Website Address',
          value: form.record_url || '',
          type: 'SINGLE_LINE',
          hintText: 'https://',
        },
      },
      {
        textInput: {
          name: 'record_notes',
          label: 'Notes',
          value: form.record_notes || '',
          type: 'MULTIPLE_LINE',
          hintText: 'Notes',
        },
      },
      { divider: {} },
    ],
  });

  if (useClassic) {
    const selfDestructWidgets = [
      {
        selectionInput: {
          name: 'self_destructive',
          label: 'Self-Destruct (optional)',
          type: 'CHECK_BOX',
          items: [
            {
              text: 'Enable self-destruct',
              value: 'enabled',
              selected: showExpiration,
            },
          ],
          onChangeAction: {
            function: 'create_record_toggle_self_destruct',
            parameters: [
              ...params,
              { key: '__action', value: 'create_record_toggle_self_destruct' },
            ],
          },
        },
      },
    ];

    if (showExpiration) {
      const selectedExp = form.link_expiration || '5m';
      selfDestructWidgets.push({
        selectionInput: {
          name: 'link_expiration',
          label: 'Link Expires In',
          type: 'DROPDOWN',
          items: [
            { text: '5 minutes', value: '5m', selected: selectedExp === '5m' },
            { text: '10 minutes', value: '10m', selected: selectedExp === '10m' },
            { text: '30 minutes', value: '30m', selected: selectedExp === '30m' },
            { text: '1 hour', value: '1h', selected: selectedExp === '1h' },
            { text: '24 hours', value: '24h', selected: selectedExp === '24h' },
            { text: '1 week', value: '7d', selected: selectedExp === '7d' },
            { text: '30 days', value: '30d', selected: selectedExp === '30d' },
            { text: '90 days', value: '90d', selected: selectedExp === '90d' },
          ],
        },
      });
    }

    sections.push({ widgets: selfDestructWidgets });
  }

  sections.push({
    widgets: [
      { divider: {} },
      {
        buttonList: {
          buttons: [
            {
              text: 'Cancel',
              color: BTN.back,
              onClick: {
                action: {
                  function: 'cancel_create_record',
                  parameters: [
                    ...params,
                    { key: '__action', value: 'cancel_create_record' },
                  ],
                },
              },
            },
            {
              text: 'Create Record',
              color: BTN.approve,
              onClick: {
                action: {
                  function: 'submit_create_record',
                  parameters: [
                    ...params,
                    { key: '__action', value: 'submit_create_record' },
                  ],
                },
              },
            },
          ],
        },
      },
    ],
  });

  sections.unshift({
    widgets: [
      { divider: {} },
      {
        textParagraph: {
          text: '<b>Create New Record</b>',
        },
      },
    ],
  });

  return buildRequestCard(actionData, sections, {
    searchedQuery: originalQuery,
  });
}
