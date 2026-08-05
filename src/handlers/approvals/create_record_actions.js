/**
 * Approver create-record card actions.
 */

import {
  buildCreateRecordCard,
  buildLoadingCard,
  buildSearchResultsCard,
  SEARCH_RESULT_DISPLAY_LIMIT
} from '../../lib/cards/index.js';

import { ApprovalActionData, encodeSearchItemValue, KeeperRecord } from '../../lib/models.js';
import { getLogger } from '../../lib/logger.js';
import {
  sanitizeMentions,
  sanitizeUserInput,
  MAX_IDENTIFIER_LENGTH,
  MAX_JUSTIFICATION_LENGTH,
} from '../../lib/utils.js';
import { collectCreateFormValues, extractFormValue, extractFormValues } from './form_utils.js';

/**
 * Open Create New Record form (in-place card).
 */
export async function handleCreateNewRecord(
  actionData,
  messageName,
  event,
  chatClient,
) {
  const currentQuery =
    extractFormValue(event, 'search_query') || actionData.identifier;

  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: `Create new record for ${actionData.requesterLabel}`,
      cardsV2: buildCreateRecordCard(actionData, {
        originalQuery: currentQuery,
        useClassic: false,
        showExpiration: false,
      }),
    });
  }
}

/**
 * Rebuild create form when Classic vault or self-destruct checkbox changes.
 */
export async function handleCreateRecordToggle(
  actionData,
  messageName,
  event,
  chatClient,
  { toggleClassic = false, toggleSelfDestruct = false } = {},
) {
  const params = event.action?.parameters || [];
  const paramMap = Object.fromEntries(params.map((p) => [p.key, p.value ?? '']));
  let useClassic =
    String(paramMap.create_use_classic || 'false').toLowerCase() === 'true';
  let showExpiration =
    String(paramMap.create_show_expiration || 'false').toLowerCase() ===
    'true';
  const originalQuery =
    paramMap.create_original_query ||
    extractFormValue(event, 'record_title') ||
    actionData.identifier;

  if (toggleClassic) {
    useClassic = extractFormValues(event, 'classic_vault').includes('classic');
    if (!useClassic) showExpiration = false;
  }
  if (toggleSelfDestruct) {
    useClassic = true;
    showExpiration = extractFormValues(event, 'self_destructive').includes(
      'enabled',
    );
  }

  const formValues = collectCreateFormValues(event);

  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: `Create new record for ${actionData.requesterLabel}`,
      cardsV2: buildCreateRecordCard(actionData, {
        originalQuery,
        useClassic,
        showExpiration: useClassic && showExpiration,
        formValues,
      }),
    });
  }
}

/**
 * Submit Create New Record form → Commander create → return to search with pre-select.
 */
export async function handleSubmitCreateRecord(
  actionData,
  approverName,
  messageName,
  event,
  chatClient,
  keeperClient,
) {
  const logger = getLogger();
  const params = event.action?.parameters || [];
  const paramMap = Object.fromEntries(params.map((p) => [p.key, p.value ?? '']));
  const useClassic =
    extractFormValues(event, 'classic_vault').includes('classic') ||
    String(paramMap.create_use_classic || 'false').toLowerCase() === 'true';
  const showExpiration =
    useClassic &&
    (extractFormValues(event, 'self_destructive').includes('enabled') ||
      String(paramMap.create_show_expiration || 'false').toLowerCase() ===
        'true');

  const titleRaw = (extractFormValue(event, 'record_title') || '').trim();
  const loginRaw = (extractFormValue(event, 'record_login') || '').trim();
  const password = (extractFormValue(event, 'record_password') || '').trim();
  const urlRaw = (extractFormValue(event, 'record_url') || '').trim();
  const notesRaw = (extractFormValue(event, 'record_notes') || '').trim();
  const autoGen = extractFormValues(event, 'auto_gen_password').includes(
    'auto_gen',
  );
  const selfDestructDuration =
    extractFormValue(event, 'link_expiration') || '5m';
  const formValues = collectCreateFormValues(event);
  const originalQuery =
    paramMap.create_original_query || titleRaw || actionData.identifier;

  // Slack command-input sanitization for free-text fields (shell injection).
  // URL keeps : / so website addresses still work; only strip shell metacharacters.
  const [title, titleOk, titleErr] = sanitizeUserInput(
    titleRaw,
    MAX_IDENTIFIER_LENGTH,
    'Title',
  );
  const [login, loginOk, loginErr] = sanitizeUserInput(
    loginRaw,
    MAX_IDENTIFIER_LENGTH,
    'Login',
  );
  const [notes] = sanitizeUserInput(notesRaw, MAX_JUSTIFICATION_LENGTH, 'Notes');
  const url = sanitizeMentions(urlRaw)
    .replace(/[;|&$`(){}[\]!\\\n\r\x00]/g, '')
    .trim();

  if (!titleOk) {
    if (messageName) {
      await chatClient.patchMessage(messageName, {
        text: `Create new record for ${actionData.requesterLabel}`,
        cardsV2: buildCreateRecordCard(actionData, {
          originalQuery,
          useClassic,
          showExpiration,
          formValues,
          error: titleErr,
        }),
      });
    }
    return;
  }
  if (!loginOk) {
    if (messageName) {
      await chatClient.patchMessage(messageName, {
        text: `Create new record for ${actionData.requesterLabel}`,
        cardsV2: buildCreateRecordCard(actionData, {
          originalQuery,
          useClassic,
          showExpiration,
          formValues,
          error: loginErr,
        }),
      });
    }
    return;
  }

  if (!title) {
    if (messageName) {
      await chatClient.patchMessage(messageName, {
        text: `Create new record for ${actionData.requesterLabel}`,
        cardsV2: buildCreateRecordCard(actionData, {
          originalQuery,
          useClassic,
          showExpiration,
          formValues,
          error: 'Title is required',
        }),
      });
    }
    return;
  }

  if (!login) {
    if (messageName) {
      await chatClient.patchMessage(messageName, {
        text: `Create new record for ${actionData.requesterLabel}`,
        cardsV2: buildCreateRecordCard(actionData, {
          originalQuery,
          useClassic,
          showExpiration,
          formValues,
          error: 'Login is required',
        }),
      });
    }
    return;
  }

  if (autoGen && password && password.toUpperCase() !== '$GEN') {
    if (messageName) {
      await chatClient.patchMessage(messageName, {
        text: `Create new record for ${actionData.requesterLabel}`,
        cardsV2: buildCreateRecordCard(actionData, {
          originalQuery,
          useClassic,
          showExpiration,
          formValues,
          error:
            'Please either enter a password or check auto-generate, not both.',
        }),
      });
    }
    return;
  }

  const generatePassword =
    autoGen || (password ? password.toUpperCase() === '$GEN' : false);

  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: `Creating record "${title}"…`,
      cardsV2: buildLoadingCard(actionData, {
        title: `Creating record "${title}"…`,
        detail: useClassic
          ? 'Creating Classic record in Keeper Vault.'
          : 'Creating Nested Share Folder record in Keeper Vault.',
      }),
    });
  }

  let createResult;
  try {
    if (useClassic) {
      createResult = await keeperClient.createRecord({
        title,
        login: login || null,
        password: generatePassword ? null : password || null,
        url: url || null,
        notes: notes || null,
        generatePassword,
        selfDestructDuration: showExpiration ? selfDestructDuration : null,
      });
    } else {
      createResult = await keeperClient.createNsfRecord({
        title,
        login: login || null,
        password: generatePassword ? null : password || null,
        url: url || null,
        notes: notes || null,
        generatePassword,
      });
    }
  } catch (err) {
    logger.error({ err, title }, 'Create record failed');
    if (messageName) {
      await chatClient.patchMessage(messageName, {
        text: `Create new record for ${actionData.requesterLabel}`,
        cardsV2: buildCreateRecordCard(actionData, {
          originalQuery: title,
          useClassic,
          showExpiration,
          formValues,
          error: err.message || 'Unknown error',
        }),
      });
    }
    return;
  }

  if (!createResult?.success) {
    if (messageName) {
      await chatClient.patchMessage(messageName, {
        text: `Create new record for ${actionData.requesterLabel}`,
        cardsV2: buildCreateRecordCard(actionData, {
          originalQuery: title,
          useClassic,
          showExpiration,
          formValues,
          error: createResult?.error || 'Unknown error',
        }),
      });
    }
    return;
  }

  const recordUid = createResult.record_uid;
  if (!recordUid || recordUid === 'Unknown') {
    await chatClient.sendDm(
      approverName,
      `Record "${title}" was created but its UID could not be retrieved. ` +
        'Use Re-sync Vault and Refine Search to find it.',
    );
    if (messageName) {
      await chatClient.patchMessage(messageName, {
        text: `Search results for "${title}"`,
        cardsV2: buildSearchResultsCard(actionData, [], {
          currentQuery: title,
        }),
      });
    }
    return;
  }

  const isNsf = Boolean(createResult.is_nsf || !useClassic);
  const isSelfDestruct = Boolean(createResult.self_destruct);
  const updatedActionData = new ApprovalActionData({
    approvalId: actionData.approvalId,
    requesterUserName: actionData.requesterUserName,
    requesterEmail: actionData.requesterEmail,
    requesterDisplayName: actionData.requesterDisplayName,
    identifier: actionData.identifier,
    isUid: actionData.isUid,
    requestType: actionData.requestType,
    justification: actionData.justification,
    duration: actionData.duration,
    isNsf,
    recordType: 'login',
    createSelfDestruct: isSelfDestruct,
    selfDestructDuration: isSelfDestruct
      ? createResult.self_destruct_duration || selfDestructDuration
      : '5m',
    newlyCreatedUid: recordUid,
    newlyCreatedTitle: title,
  });

  const newlyCreatedRecord = new KeeperRecord({
    uid: recordUid,
    title,
    recordType: 'login',
    notes: notes || null,
    isNsf,
  });

  logger.info(
    {
      approvalId: actionData.approvalId,
      recordUid,
      isNsf,
      isSelfDestruct,
    },
    'Created record for approval',
  );

  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: `Search results for "${title}" (1 found)`,
      cardsV2: buildSearchResultsCard(
        updatedActionData,
        [newlyCreatedRecord],
        {
          currentQuery: title,
          selectedValue: encodeSearchItemValue(recordUid, isNsf, 'login'),
        },
      ),
    });
  }
}

/**
 * Cancel create form → return to search with prior query.
 */
export async function handleCancelCreateRecord(
  actionData,
  messageName,
  event,
  chatClient,
  keeperClient,
) {
  const logger = getLogger();
  const params = event.action?.parameters || [];
  const paramMap = Object.fromEntries(params.map((p) => [p.key, p.value ?? '']));
  const query =
    paramMap.create_original_query ||
    extractFormValue(event, 'record_title') ||
    actionData.identifier;

  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: `Searching for "${query}"…`,
      cardsV2: buildLoadingCard(actionData, {
        title: `Searching Keeper Vault for "${query}"…`,
        detail: 'Please wait while records are being fetched.',
      }),
    });
  }

  let records = [];
  try {
    const result = await keeperClient.searchRecords(query, SEARCH_RESULT_DISPLAY_LIMIT);
    records = result.records || [];
  } catch (err) {
    logger.error({ err, query }, 'Search after cancel create failed');
  }

  if (messageName) {
    await chatClient.patchMessage(messageName, {
      text: `Search results for "${query}" (${records.length} found)`,
      cardsV2: buildSearchResultsCard(actionData, records, {
        currentQuery: query,
      }),
    });
  }
}
