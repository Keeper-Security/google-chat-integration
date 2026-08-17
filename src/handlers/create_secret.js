/**
 * Handle /keeper-create-secret (— direct create, not an approval request).
 */

import {
  buildCreateSecretFolderSelectCard,
  buildCreateSecretNotificationCard,
  buildCreateSecretRecordFormCard,
  buildCreateSecretSuccessCard,
} from '../lib/cards/index.js';
import { isPeerDmSpace } from '../lib/event_utils.js';
import { getLogger } from '../lib/logger.js';
import { decodeSearchItemValue } from '../lib/models.js';
import { sanitizeCommandInput } from '../lib/utils.js';

/**
 * Slash command: load shared folders and show folder-select card.
 * @param {object} event
 * @param {object} config
 * @param {import('../lib/chat_client.js').ChatClient} chatClient
 * @param {import('../lib/keeper/client.js').KeeperClient} keeperClient
 */
export async function handleCreateSecret(event, config, chatClient, keeperClient) {
  const logger = getLogger();
  const message = event.message || {};
  const user = event.user || {};
  const space = event.space || {};
  const requesterEmail = user.email || '';
  const requesterUserName = user.name || '';
  const requesterDisplay = user.displayName || requesterEmail;

  // Peer DMs cannot hide messages from the other person; block the interactive
  // create-secret UI there. Spaces (privateMessageViewer) and bot 1:1 DMs are OK.
  if (isPeerDmSpace(space)) {
    logger.info(
      { space: space.name, email: requesterEmail || null },
      'Rejected create-secret in peer DM',
    );
    await chatClient.postMessage({
      parent: space.name,
      message: {
        text:
          'For privacy, `/keeper-create-secret` cannot be used in a DM with another person.\n\n' +
          'Message the Keeper bot directly, or run the command in a space.',
      },
      threadName: message.thread?.name || null,
      privateViewer: requesterUserName || null,
      space,
    });
    return;
  }

  if (!requesterEmail) {
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      'Unable to determine your email address. Please try again from a Google Workspace account.',
    );
    return;
  }

  await replyPrivate(
    chatClient,
    space,
    message,
    requesterUserName,
    'Loading shared folders…',
  );

  try {
    const sharedFolders = await keeperClient.getUserSharedFolders(requesterEmail);

    if (!sharedFolders.length) {
      await replyPrivate(
        chatClient,
        space,
        message,
        requesterUserName,
        'No shared folders found for your account.\n\n' +
          'Please ensure you have been granted access to at least one shared folder by your administrator.',
      );
      return;
    }

    await chatClient.postMessage({
      parent: space.name,
      message: {
        text: 'Create a new secret record',
        cardsV2: buildCreateSecretFolderSelectCard(sharedFolders),
      },
      threadName: message.thread?.name || null,
      privateViewer: requesterUserName,
      space,
      preferInPlace: true,
    });

    logger.info(
      { email: requesterEmail, folders: sharedFolders.length },
      'Opened create-secret folder select',
    );
  } catch (error) {
    logger.error({ err: error }, 'Failed to open create secret flow');
    await replyPrivate(
      chatClient,
      space,
      message,
      requesterUserName,
      'Failed to open the create secret form. Please try again.',
    );
  }
}

/**
 * CARD_CLICKED routing for create_secret_* actions.
 * @param {object} event
 * @param {object} config
 * @param {import('../lib/chat_client.js').ChatClient} chatClient
 * @param {import('../lib/keeper/client.js').KeeperClient} keeperClient
 */
export async function handleCreateSecretCardClick(
  event,
  config,
  chatClient,
  keeperClient,
) {
  const action = event.action || {};
  const params = action.parameters || [];
  const method =
    action.actionMethodName ||
    params.find((p) => p.key === '__action')?.value ||
    '';

  if (method === 'create_secret_next') {
    await handleFolderNext(event, chatClient, keeperClient);
    return;
  }
  if (method === 'create_secret_submit') {
    await handleSubmit(event, config, chatClient, keeperClient);
    return;
  }

  getLogger().debug({ method }, 'Unhandled create-secret card action');
}

/**
 * @param {object} event
 * @param {import('../lib/chat_client.js').ChatClient} chatClient
 * @param {import('../lib/keeper/client.js').KeeperClient} keeperClient
 */
async function handleFolderNext(event, chatClient, keeperClient) {
  const logger = getLogger();
  const messageName = event.message?.name;
  const selected = extractFormValue(event, 'shared_folder');
  const email = event.user?.email || '';

  if (!selected) {
    const folders = email ? await keeperClient.getUserSharedFolders(email) : [];
    await patchCard(
      chatClient,
      messageName,
      buildCreateSecretFolderSelectCard(folders, {
        error: 'Please select a shared folder.',
      }),
      'Please select a shared folder.',
    );
    return;
  }

  const [folderUid, parentIsNsf] = decodeSearchItemValue(selected);
  const folders = email ? await keeperClient.getUserSharedFolders(email) : [];
  const matched = folders.find((f) => f.uid === folderUid);
  const folderName = matched?.name || folderUid;

  await patchCard(
    chatClient,
    messageName,
    [
      {
        cardId: 'create-secret-loading',
        card: {
          header: { title: 'Create Secret' },
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text: `Loading <b>${escapeText(folderName)}</b>…`,
                  },
                },
              ],
            },
          ],
        },
      },
    ],
    `Loading ${folderName}…`,
  );

  try {
    const subfolders = await keeperClient.listSubfolders(folderUid);
    await patchCard(
      chatClient,
      messageName,
      buildCreateSecretRecordFormCard({
        folderName,
        folderUid,
        parentIsNsf: matched ? Boolean(matched.is_nsf) : parentIsNsf,
        subfolders: subfolders.length ? subfolders : null,
      }),
      `Creating record in ${folderName}`,
    );
  } catch (error) {
    logger.error({ err: error }, 'Failed to load create-secret form');
    await patchCard(
      chatClient,
      messageName,
      buildCreateSecretRecordFormCard({
        folderName,
        folderUid,
        parentIsNsf: matched ? Boolean(matched.is_nsf) : parentIsNsf,
        error: 'Failed to load folder details. Please try again.',
      }),
      'Failed to load folder details.',
    );
  }
}

/**
 * @param {object} event
 * @param {object} config
 * @param {import('../lib/chat_client.js').ChatClient} chatClient
 * @param {import('../lib/keeper/client.js').KeeperClient} keeperClient
 */
async function handleSubmit(event, config, chatClient, keeperClient) {
  const logger = getLogger();
  const messageName = event.message?.name;
  const params = Object.fromEntries(
    (event.action?.parameters || []).map((p) => [p.key, p.value]),
  );

  const folderUid = params.folder_uid || '';
  const folderName = params.folder_name || 'Shared Folder';
  const parentIsNsf = String(params.parent_is_nsf || 'false').toLowerCase() === 'true';

  const rawTitle = (extractFormValue(event, 'secret_title') || '').trim();
  const rawLogin = (extractFormValue(event, 'secret_login') || '').trim();
  const rawPassword = (extractFormValue(event, 'secret_password') || '').trim();
  const rawUrl = (extractFormValue(event, 'secret_url') || '').trim();
  const rawNotes = (extractFormValue(event, 'secret_notes') || '').trim();
  const autoGen = extractFormValues(event, 'auto_gen_password').includes('auto_gen');
  const subfolderValue = extractFormValue(event, 'subfolder');

  const title = sanitizeCommandInput(rawTitle);
  const login = sanitizeCommandInput(rawLogin);
  const url = sanitizeCommandInput(rawUrl);
  const notes = sanitizeCommandInput(rawNotes);
 // Passwords keep special characters; only shell-quoted at CLI build time.
  const password = rawPassword;

  const formValues = {
    secret_title: title,
    secret_login: login,
    secret_password: password,
    secret_url: url,
    secret_notes: notes,
    auto_gen: autoGen,
    subfolder: subfolderValue || '',
  };

  const restoreForm = async (error) => {
    const subfolders = folderUid
      ? await keeperClient.listSubfolders(folderUid)
      : [];
    await patchCard(
      chatClient,
      messageName,
      buildCreateSecretRecordFormCard({
        folderName,
        folderUid,
        parentIsNsf,
        subfolders: subfolders.length ? subfolders : null,
        error,
        formValues,
      }),
      error || 'Create secret',
    );
  };

  if (!title) {
    await restoreForm('Title is required');
    return;
  }

  if (autoGen && password && password.toUpperCase() !== '$GEN') {
    await restoreForm(
      'Please either enter a password or check auto-generate, not both.',
    );
    return;
  }

  let targetFolderUid = folderUid;
  let targetIsNsf = parentIsNsf;
  let subfolderPath = null;
  if (subfolderValue) {
    const [selUid, selIsNsf] = decodeSearchItemValue(subfolderValue);
    if (selUid && selUid !== folderUid) {
      targetFolderUid = selUid;
      targetIsNsf = selIsNsf;
      const knownSubs = folderUid
        ? await keeperClient.listSubfolders(folderUid)
        : [];
      const matchSub = knownSubs.find((s) => s.uid === selUid);
      subfolderPath = matchSub?.path || matchSub?.name || selUid;
    }
  }

  const folderPath = subfolderPath
    ? `${folderName} / ${subfolderPath}`
    : folderName;

  await patchCard(
    chatClient,
    messageName,
    [
      {
        cardId: 'create-secret-creating',
        card: {
          header: { title: 'Create Secret' },
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text:
                      '<b>Creating your secret…</b><br><br>' +
                      `<b>Title:</b> ${escapeText(title)}<br>` +
                      `<b>Folder:</b> ${escapeText(folderPath)}<br><br>` +
                      'Please wait, this may take a few seconds.',
                  },
                },
              ],
            },
          ],
        },
      },
    ],
    `Creating ${title}…`,
  );

  const generatePassword =
    autoGen || (password ? password.toUpperCase() === '$GEN' : false);

  try {
    const createFn = targetIsNsf
      ? keeperClient.createNsfRecord.bind(keeperClient)
      : keeperClient.createRecord.bind(keeperClient);

    const result = await createFn({
      title,
      login: login || null,
      password: generatePassword ? null : password || null,
      url: url || null,
      notes: notes || null,
      generatePassword,
      folderUid: targetFolderUid,
    });

    if (result?.success) {
      const recordUid = result.record_uid || 'Unknown';
      await patchCard(
        chatClient,
        messageName,
        buildCreateSecretSuccessCard({
          title,
          recordUid,
          folderPath,
        }),
        `Record created: ${title}`,
      );

      const approvalsSpace = config.chat?.approvalsSpaceId;
      if (approvalsSpace) {
        const user = event.user || {};
        const userLabel =
          user.displayName || user.email || user.name || 'Unknown user';
        try {
          await chatClient.postMessage({
            parent: approvalsSpace,
            message: {
              text: `User ${userLabel} added record ${recordUid} to ${folderPath}`,
              cardsV2: buildCreateSecretNotificationCard({
                userLabel,
                recordUid,
                recordTitle: title,
                folderPath,
              }),
            },
          });
        } catch (notifyErr) {
          logger.error(
            { err: notifyErr },
            'Failed to post create-secret notification',
          );
        }
      }

      logger.info(
        {
          title,
          recordUid,
          folder: folderPath,
          isNsf: targetIsNsf,
          email: event.user?.email,
        },
        'Create-secret record created',
      );
      return;
    }

    const errorMsg = result?.error || 'Unknown error';
    logger.error({ errorMsg }, 'Failed to create secret record');
    await restoreForm(errorMsg);
  } catch (error) {
    logger.error({ err: error }, 'Exception in create secret submit');
    await restoreForm(
      error?.message || 'An unexpected error occurred. Please try again.',
    );
  }
}

function extractFormValue(event, fieldName) {
  const values = extractFormValues(event, fieldName);
  return values.length ? values[0] : null;
}

function extractFormValues(event, fieldName) {
  const formInputs = event.common?.formInputs || {};
  const field = formInputs[fieldName] || {};
  return field.stringInputs?.value || [];
}

async function patchCard(chatClient, messageName, cardsV2, text) {
  if (!messageName) return;
  await chatClient.patchMessage(messageName, {
    text: text || '',
    cardsV2,
  });
}

async function replyPrivate(chatClient, space, message, viewerName, text) {
  await chatClient.postMessage({
    parent: space.name,
    message: { text },
    threadName: message.thread?.name || null,
    privateViewer: viewerName,
    space,
    // Multi-step create-secret UI must stay in the invoking conversation.
    preferInPlace: true,
  });
}

function escapeText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
