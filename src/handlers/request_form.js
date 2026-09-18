/**
 * Card-click handling for the request-form cards opened by
 * /keeper-request-record, /keeper-request-folder, and /keeper-external-share
 * when run with no inline arguments.
 */

import {
  buildRequestFormCard,
  buildRequestFormSubmittedCard,
} from '../lib/cards/index.js';
import { getLogger } from '../lib/logger.js';
import {
  MAX_IDENTIFIER_LENGTH,
  MAX_JUSTIFICATION_LENGTH,
  sanitizeUserInput,
} from '../lib/utils.js';
import { extractFormValue } from './approvals/form_utils.js';


const SUBMIT_ACTIONS = {
  request_record_form_submit: {
    requestType: 'record',
    loadProcess: () => import('./request_record.js').then((m) => m.processRecordRequest),
  },
  request_folder_form_submit: {
    requestType: 'folder',
    loadProcess: () => import('./request_folder.js').then((m) => m.processFolderRequest),
  },
  one_time_share_form_submit: {
    requestType: 'one_time_share',
    loadProcess: () => import('./one_time_share.js').then((m) => m.processOneTimeShareRequest),
  },
};

/**
 * Post the request-input card to the requester's 1:1 bot DM.
 * @param {import('../lib/chat_client.js').ChatClient} chatClient
 * @param {object} space
 * @param {object} message
 * @param {string} requesterUserName
 * @param {'record'|'folder'|'one_time_share'} requestType
 */
export async function openRequestForm(chatClient, space, message, requesterUserName, requestType) {
  await chatClient.postMessage({
    parent: space.name,
    message: {
      text: 'Fill in the form below to submit your request.',
      cardsV2: buildRequestFormCard(requestType),
    },
    threadName: message.thread?.name || null,
    privateViewer: requesterUserName,
    space,
  });
}

/**
 * @param {object} event
 * @returns {boolean}
 */
export function isRequestFormCardAction(event) {
  const action = event?.action || {};
  const method =
    action.actionMethodName ||
    (action.parameters || []).find((p) => p.key === '__action')?.value ||
    '';
  return method === 'request_form_cancel' || method in SUBMIT_ACTIONS;
}

/**
 * @param {object} event
 * @param {object} config
 * @param {import('../lib/chat_client.js').ChatClient} chatClient
 * @param {import('../lib/keeper/client.js').KeeperClient} keeperClient
 * @param {import('../lib/approver_boundary.js').ApproverBoundary} [approverBoundary]
 */
export async function handleRequestFormCardClick(event, config, chatClient, keeperClient, approverBoundary) {
  const logger = getLogger();
  const action = event.action || {};
  const method =
    action.actionMethodName ||
    (action.parameters || []).find((p) => p.key === '__action')?.value ||
    '';
  const messageName = event.message?.name || '';

  if (method === 'request_form_cancel') {
    if (messageName) {
      await chatClient.patchMessage(messageName, {
        text: 'Request cancelled.',
        cardsV2: buildRequestFormSubmittedCard(
          'Request Cancelled',
          'You can run the command again anytime.',
        ),
      });
    }
    return;
  }

  const entry = SUBMIT_ACTIONS[method];
  if (!entry) return;

  const rawIdentifier = (extractFormValue(event, 'identifier_input') || '').trim();
  const rawJustification = (extractFormValue(event, 'justification_input') || '').trim();

  const rerenderWithError = async (errorText) => {
    if (!messageName) return;
    await chatClient.patchMessage(messageName, {
      text: errorText,
      cardsV2: buildRequestFormCard(entry.requestType, {
        identifierValue: rawIdentifier,
        justificationValue: rawJustification,
        error: errorText,
      }),
    });
  };

  if (!rawIdentifier) {
    await rerenderWithError(
      entry.requestType === 'folder'
        ? 'Please provide a folder UID or description.'
        : 'Please provide a record UID or description.',
    );
    return;
  }
  if (!rawJustification) {
    await rerenderWithError('Justification is required.');
    return;
  }

  const [identifier, idValid, idError] = sanitizeUserInput(
    rawIdentifier,
    MAX_IDENTIFIER_LENGTH,
    'Identifier',
  );
  if (!idValid) {
    await rerenderWithError(idError);
    return;
  }

  const [justification, justValid, justError] = sanitizeUserInput(
    rawJustification,
    MAX_JUSTIFICATION_LENGTH,
    'Justification',
  );
  if (!justValid) {
    await rerenderWithError(justError);
    return;
  }

  // Disable the form immediately so a slow lookup can't be double-submitted.
  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: 'Submitting your request…',
      cardsV2: buildRequestFormSubmittedCard(
        'Submitting…',
        'Please wait while your request is processed. Check your DM shortly for confirmation.',
      ),
    });
  }

  try {
    const process = await entry.loadProcess();
    await process(identifier, justification, event, config, chatClient, keeperClient, approverBoundary);
  } catch (error) {
    logger.error({ err: error, method }, 'Request form submit failed');
    if (messageName) {
      await chatClient.patchMessage(messageName, {
        text: 'Something went wrong submitting your request.',
        cardsV2: buildRequestFormSubmittedCard(
          'Something Went Wrong',
          `Failed to submit your request: ${error.message || 'Unknown error'}. Please run the command again.`,
        ),
      });
    }
  }
}
