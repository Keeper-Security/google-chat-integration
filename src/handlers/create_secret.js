/**
 * Handle /keeper-create-secret (— direct create, not an approval request).
 */

import {
  buildCreateSecretCancelledCard,
  buildCreateSecretFolderSelectCard,
  buildCreateSecretNotificationCard,
  buildCreateSecretRecordFormCard,
  buildCreateSecretSuccessCard,
} from '../lib/cards/index.js';
import { isPeerDmSpace } from '../lib/event_utils.js';
import { getLogger } from '../lib/logger.js';
import { decodeSearchItemValue } from '../lib/models.js';
import { sanitizeCommandInput, sanitizeHyperlinks } from '../lib/utils.js';

/**
 * Subfolders a user may pick. Access to a classic subfolder comes from its
 * shared folder. A nested share subfolder has its own permissions, so it is
 * offered only if share-report gives the user write access to it.
 * @param {Array<{ uid: string }>} subfolders
 * @param {boolean} parentIsNsf
 * @param {Set<string>} writableUids
 */
function selectableSubfolders(subfolders, parentIsNsf, writableUids) {
  return parentIsNsf
    ? subfolders.filter((s) => writableUids.has(s.uid))
    : subfolders;
}

/**
 * Whether a create-secret target subfolder is allowed, using metadata
 * Commander returns for that exact UID (never the card parameters).
 * @param {{ uid: string, is_nsf: boolean, shared_folder_uid: string|null }|null} target
 * @param {{ uid: string, is_nsf: boolean }} parentFolder - a folder the user can write to
 * @param {Set<string>} writableUids
 */
function canCreateInSubfolder(target, parentFolder, writableUids) {
  if (!target) return false;
  if (parentFolder.is_nsf) {
    return target.is_nsf && writableUids.has(target.uid);
  }
  return !target.is_nsf && target.shared_folder_uid === parentFolder.uid;
}

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
 * @param {import('../lib/approver_boundary.js').ApproverBoundary} [approverBoundary]
 */
export async function handleCreateSecretCardClick(
  event,
  config,
  chatClient,
  keeperClient,
  approverBoundary,
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
    await handleSubmit(event, config, chatClient, keeperClient, approverBoundary);
    return;
  }
  if (method === 'create_secret_cancel') {
    await handleCancel(event, chatClient);
    return;
  }

  getLogger().debug({ method }, 'Unhandled create-secret card action');
}

/**
 * Close the create-secret card (folder select or form).
 * @param {object} event
 * @param {import('../lib/chat_client.js').ChatClient} chatClient
 */
async function handleCancel(event, chatClient) {
  const messageName = event.message?.name;
  await patchCard(
    chatClient,
    messageName,
    buildCreateSecretCancelledCard(),
    'Create secret cancelled.',
  );
  getLogger().info(
    { email: event.user?.email, messageName },
    'Create-secret cancelled by user',
  );
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


  const [folderUid] = decodeSearchItemValue(selected);
  const { folders, writableUids } = email
    ? await keeperClient.getUserShareInfo(email)
    : { folders: [], writableUids: new Set() };
  const matched = folders.find((f) => f.uid === folderUid);

  if (!matched) {
    logger.warn(
      { email, folderUid },
      'Rejected create-secret folder selection: no write access',
    );
    await patchCard(
      chatClient,
      messageName,
      buildCreateSecretFolderSelectCard(folders, {
        error: 'You do not have write access to that folder. Please select another.',
      }),
      'You do not have write access to that folder.',
    );
    return;
  }

  const folderName = matched.name;
  const parentIsNsf = Boolean(matched.is_nsf);

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
    `Loading ${sanitizeHyperlinks(folderName)}…`,
  );

  try {
    const subfolders = selectableSubfolders(
      await keeperClient.listSubfolders(folderUid),
      parentIsNsf,
      writableUids,
    );
    await patchCard(
      chatClient,
      messageName,
      buildCreateSecretRecordFormCard({
        folderName,
        folderUid,
        parentIsNsf,
        subfolders: subfolders.length ? subfolders : null,
      }),
      `Creating record in ${sanitizeHyperlinks(folderName)}`,
    );
  } catch (error) {
    logger.error({ err: error }, 'Failed to load create-secret form');
    await patchCard(
      chatClient,
      messageName,
      buildCreateSecretRecordFormCard({
        folderName,
        folderUid,
        parentIsNsf,
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
async function handleSubmit(event, config, chatClient, keeperClient, approverBoundary) {
  const logger = getLogger();
  const messageName = event.message?.name;
  const params = Object.fromEntries(
    (event.action?.parameters || []).map((p) => [p.key, p.value]),
  );


  const folderUid = params.folder_uid || '';
  const email = event.user?.email || '';

  // Card parameters are client-supplied. Resolve the folder from the user's
  // own write-access list, so the name, type and access check all come from
  // Commander rather than the request.
  const { folders: writableFolders, writableUids } = email
    ? await keeperClient.getUserShareInfo(email)
    : { folders: [], writableUids: new Set() };
  const parentFolder = folderUid
    ? writableFolders.find((f) => f.uid === folderUid)
    : undefined;
  const folderName = parentFolder?.name || '';
  const parentIsNsf = Boolean(parentFolder?.is_nsf);

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
    const subfolders = parentFolder
      ? selectableSubfolders(
        await keeperClient.listSubfolders(folderUid),
        parentIsNsf,
        writableUids,
      )
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

  if (!parentFolder) {
    logger.warn(
      { email, folderUid },
      'Rejected create-secret submission: no write access to target folder',
    );
    await patchCard(
      chatClient,
      messageName,
      buildCreateSecretFolderSelectCard(writableFolders, {
        error: 'You do not have write access to that folder. Please select another.',
      }),
      'You do not have write access to that folder.',
    );
    return;
  }

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
  let targetPath = null;
  if (subfolderValue) {
    const [selUid] = decodeSearchItemValue(subfolderValue);
    if (selUid && selUid !== folderUid) {
      const target = await keeperClient.getFolderInfo(selUid);
      if (!canCreateInSubfolder(target, parentFolder, writableUids)) {
        logger.warn(
          { email, folderUid, subfolderUid: selUid },
          'Rejected create-secret submission: no write access to subfolder',
        );
        await restoreForm('You do not have write access to that subfolder. Please select another.');
        return;
      }
      targetFolderUid = target.uid;
      targetPath = target.path || `${folderName} / ${target.name}`;
    }
  }
  const targetIsNsf = parentIsNsf;

  const folderPath = targetPath || folderName;

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
    `Creating ${sanitizeHyperlinks(title)}…`,
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
        `Record created: ${sanitizeHyperlinks(title)}`,
      );

      const user = event.user || {};
      let approvalsSpace = config.chat?.approvalsSpaceId;
      if (approverBoundary) {
        try {
          approvalsSpace = await approverBoundary.resolveApprovalChannel(user.email || '');
        } catch (error) {
          logger.warn({ err: error }, 'Failed to resolve approval channel; using default');
        }
      }
      if (approvalsSpace) {
        const userLabel =
          user.displayName || user.email || user.name || 'Unknown user';
        try {
          await chatClient.postMessage({
            parent: approvalsSpace,
            message: {
              text: `User ${userLabel} added record ${recordUid} to ${sanitizeHyperlinks(folderPath)}`,
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

      const createdBy = event.user?.email || event.user?.name || 'unknown';
      logger.ok(
        `Record '${title}' (${recordUid}) created by ${createdBy} in ${folderPath}`,
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
