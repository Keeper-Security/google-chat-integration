/**
 * Request-form cards for /keeper-request-record, /keeper-request-folder,
 * and /keeper-external-share when run with no inline arguments.
 */

import { BTN, escapeHtmlText } from './shared.js';

const CANCEL_BUTTON = {
  text: 'Cancel',
  color: BTN.back,
  onClick: {
    action: {
      function: 'request_form_cancel',
      parameters: [{ key: '__action', value: 'request_form_cancel' }],
    },
  },
};

const REQUEST_FORM_CONFIG = {
  record: {
    title: 'Request Record Access',
    header: 'Request access to a record. Fill in the details below to submit your request for approval.',
    identifierLabel: 'Record UID or Description',
    identifierHint: 'Record UID, Title or Description',
    submitAction: 'request_record_form_submit',
  },
  folder: {
    title: 'Request Folder Access',
    header: 'Request access to a folder. Fill in the details below to submit your request for approval.',
    identifierLabel: 'Folder UID or Description',
    identifierHint: 'Folder UID, Folder Name or Description',
    submitAction: 'request_folder_form_submit',
  },
  one_time_share: {
    title: 'One-Time Share',
    header: 'Request a one-time share link. Fill in the details below to submit your request for approval.',
    identifierLabel: 'Record UID or Description',
    identifierHint: 'Record UID or Description',
    submitAction: 'one_time_share_form_submit',
  },
};

/**
 * Build the request-input card (record / folder / one_time_share).
 * @param {'record'|'folder'|'one_time_share'} requestType
 * @param {{ identifierValue?: string, justificationValue?: string, error?: string|null }} [options]
 */
export function buildRequestFormCard(requestType, options = {}) {
  const cfg = REQUEST_FORM_CONFIG[requestType];
  const identifierValue = options.identifierValue || '';
  const justificationValue = options.justificationValue || '';
  const error = options.error || null;

  const widgets = [{ textParagraph: { text: cfg.header } }];

  if (error) {
    widgets.push({
      textParagraph: {
        text: `<font color="#D93838"><b>${escapeHtmlText(error)}</b></font>`,
      },
    });
  }

  widgets.push(
    { divider: {} },
    {
      textInput: {
        name: 'identifier_input',
        label: cfg.identifierLabel,
        value: identifierValue,
        type: 'SINGLE_LINE',
        hintText: cfg.identifierHint,
      },
    },
    {
      textInput: {
        name: 'justification_input',
        label: 'Justification',
        value: justificationValue,
        type: 'MULTIPLE_LINE',
        hintText: 'Justification or Ticket Number',
      },
    },
    {
      buttonList: {
        buttons: [
          CANCEL_BUTTON,
          {
            text: 'Submit Request',
            color: BTN.search,
            onClick: {
              action: {
                function: cfg.submitAction,
                parameters: [{ key: '__action', value: cfg.submitAction }],
              },
            },
          },
        ],
      },
    },
  );

  return [
    {
      cardId: `request-form-${requestType}`,
      card: {
        header: { title: cfg.title },
        sections: [{ widgets }],
      },
    },
  ];
}

/**
 * Terminal, non-interactive card shown once the form has been submitted or
 * cancelled. Google Chat has no way to literally close an interactive card
 * (unlike a Slack modal), so the card is replaced with a static message
 * instead — same end result, different mechanism.
 * @param {string} title
 * @param {string} bodyText
 */
export function buildRequestFormSubmittedCard(title, bodyText) {
  return [
    {
      cardId: 'request-form-submitted',
      card: {
        header: { title },
        sections: [{ widgets: [{ textParagraph: { text: bodyText } }] }],
      },
    },
  ];
}
