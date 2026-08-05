/**
 * Pub/Sub event router for Google Chat.
 * Normalizes Workspace add-on event shapes into the legacy Chat event model.
 */

import { handleCardClicked } from './handlers/approvals/index.js';
import { handleCreateSecret, handleCreateSecretCardClick } from './handlers/create_secret.js';
import { handleOneTimeShare } from './handlers/one_time_share.js';
import { handleRequestFolder } from './handlers/request_folder.js';
import { handleRequestRecord } from './handlers/request_record.js';
import { ChatClient } from './lib/chat_client.js';
import {
  isCreateSecretCardAction,
  isCreateSecretCommand,
  isOneTimeShareCommand,
  isRequestFolderCommand,
  isRequestRecordCommand,
} from './lib/event_utils.js';
import { KeeperClient } from './lib/keeper/client.js';
import { getLogger } from './lib/logger.js';

export class KeeperGoogleChatApp {
  /**
   * @param {ReturnType<import('../lib/config.js').loadConfig>} config
   * @param {{ chatClient?: ChatClient, keeperClient?: KeeperClient }} [deps]
   */
  constructor(config, deps = {}) {
    this.config = config;
    this.logger = getLogger();
    this.chatClient = deps.chatClient || new ChatClient(config.google.credentialsFile);
    this.keeperClient = deps.keeperClient || new KeeperClient(config.keeper);
  }

  /**
   * @param {object} event
   */
  async handleEvent(rawEvent) {
    const event = normalizeEvent(rawEvent);
    const eventType = event.type || '';
    this.logger.debug({ eventType }, 'Received Chat event');

    try {
      if (eventType === 'MESSAGE') {
        await this.handleMessage(event);
        return;
      }
      if (eventType === 'CARD_CLICKED') {
        if (isCreateSecretCardAction(event)) {
          await handleCreateSecretCardClick(
            event,
            this.config,
            this.chatClient,
            this.keeperClient,
          );
          return;
        }
        await handleCardClicked(event, this.chatClient, this.keeperClient);
        return;
      }
      if (eventType === 'ADDED_TO_SPACE') {
        await this.handleAddedToSpace(event);
        return;
      }
      this.logger.debug({ eventType }, 'Ignoring unsupported event type');
    } catch (error) {
      this.logger.error({ err: error, eventType }, 'Handler failed');
      await this.sendErrorReply(
        event,
        'Something went wrong while processing your request. Please try again.',
      );
      throw error;
    }
  }

  async handleMessage(event) {
    const message = event.message || {};
    if (isRequestRecordCommand(message, this.config.chat.commandRequestRecordId)) {
      await handleRequestRecord(event, this.config, this.chatClient, this.keeperClient);
      return;
    }
    if (isRequestFolderCommand(message, this.config.chat.commandRequestFolderId)) {
      await handleRequestFolder(event, this.config, this.chatClient, this.keeperClient);
      return;
    }
    if (isOneTimeShareCommand(message, this.config.chat.commandOneTimeShareId)) {
      await handleOneTimeShare(event, this.config, this.chatClient, this.keeperClient);
      return;
    }
    if (isCreateSecretCommand(message, this.config.chat.commandCreateSecretId)) {
      await handleCreateSecret(event, this.config, this.chatClient, this.keeperClient);
      return;
    }
    this.logger.debug(
      { text: (message.text || '').trim().slice(0, 80) },
      'Unhandled message',
    );
  }

  async handleAddedToSpace(event) {
    const spaceName = event.space?.name || '';
    if (!spaceName || event.message) return;
    await this.chatClient.postMessage({
      parent: spaceName,
      message: {
        text:
          'Keeper Security is ready.\n\n' +
          'Request record access:\n' +
          '`/keeper-request-record <record-name-or-uid> <justification>`\n\n' +
          'Request folder access:\n' +
          '`/keeper-request-folder <folder-name-or-uid> <justification>`\n\n' +
          'Create a one-time share link:\n' +
          '`/keeper-one-time-share <record-name-or-uid> <justification>`\n\n' +
          'Create a secret in a shared folder:\n' +
          '`/keeper-create-secret`\n\n' +
          'Examples:\n' +
          '`/keeper-request-record "AWS Production DB" Need access for deployment`\n' +
          '`/keeper-request-folder "Engineering Creds" Project onboarding`\n' +
          '`/keeper-one-time-share "AWS Production DB" Need temporary share link`',
      },
    });
  }

  async sendErrorReply(event, text) {
    const spaceName = event.space?.name;
    if (!spaceName) return;
    try {
      await this.chatClient.postMessage({
        parent: spaceName,
        message: { text },
        threadName: event.message?.thread?.name || null,
        privateViewer: event.user?.name || null,
        space: event.space || {},
      });
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to send error reply');
    }
  }
}

/**
 * Convert Workspace add-on Chat events into the legacy interaction shape.
 * @param {object} event
 */
export function normalizeEvent(event) {
  const chat = event?.chat;
  if (!chat || typeof chat !== 'object') {
    return event;
  }

  const commonEvent = event.commonEventObject || {};
  const user = chat.user || {};

  if (chat.appCommandPayload) {
    const payload = chat.appCommandPayload || {};
    const message = { ...(payload.message || {}) };
    const metadata = payload.appCommandMetadata || {};
    const commandId = metadata.appCommandId;
    if (commandId != null && !message.slashCommand) {
      message.slashCommand = { commandId: String(commandId) };
    }
    return {
      type: 'MESSAGE',
      user,
      space: payload.space || {},
      message,
    };
  }

  if (chat.messagePayload) {
    const payload = chat.messagePayload || {};
    return {
      type: 'MESSAGE',
      user,
      space: payload.space || {},
      message: payload.message || {},
    };
  }

  if (chat.buttonClickedPayload) {
    const payload = chat.buttonClickedPayload || {};
    const parametersMap = { ...(commonEvent.parameters || {}) };

    // Some Chat clients also send parameters on the action object.
    const actionParams = payload.action?.parameters;
    if (Array.isArray(actionParams)) {
      for (const entry of actionParams) {
        if (entry?.key == null) continue;
        if (parametersMap[entry.key] == null) {
          parametersMap[entry.key] = entry.value ?? '';
        }
      }
    }

    const parameterList = Object.entries(parametersMap).map(([key, value]) => ({
      key,
      value: value == null ? '' : String(value),
    }));
    const methodName =
      parametersMap.__action ||
      payload.action?.actionMethodName ||
      payload.action?.function ||
      '';
    return {
      type: 'CARD_CLICKED',
      user,
      space: payload.space || {},
      message: payload.message || {},
      action: {
        actionMethodName: methodName,
        parameters: parameterList,
      },
      common: {
        formInputs: commonEvent.formInputs || {},
      },
    };
  }

  if (chat.addedToSpacePayload) {
    const payload = chat.addedToSpacePayload || {};
    return {
      type: 'ADDED_TO_SPACE',
      user,
      space: payload.space || {},
    };
  }

  return event;
}
