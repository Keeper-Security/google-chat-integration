/**
 * Google Chat API client (service-account / chat.bot scope).
 */

import { ChatServiceClient, protos } from '@google-apps/chat';
import { isDmSpace } from './event_utils.js';
import { getLogger } from './logger.js';

const MessageReplyOption =
  protos.google.chat.v1.CreateMessageRequest.MessageReplyOption;

export class ChatClient {
  /**
   * @param {string} credentialsFile
   */
  constructor(credentialsFile) {
    this.logger = getLogger();
    // Use keyFilename so google-gax owns auth. Passing GoogleAuth as
    // authClient breaks gRPC metadata (headers.forEach is not a function).
    this.client = new ChatServiceClient({
      keyFilename: credentialsFile,
    });
  }

  /**
   * @param {object} options
   * @param {string} options.parent
   * @param {object} options.message
   * @param {string} [options.threadName]
   * @param {string} [options.privateViewer]
   * @param {object} [options.space]
   */
  async postMessage({
    parent,
    message,
    threadName = null,
    privateViewer = null,
    space = null,
  }) {
    const payload = { ...message };
    if (threadName) {
      payload.thread = { name: threadName };
    }

    const usePrivate = Boolean(privateViewer) && !isDmSpace(space || {});
    const request = {
      parent,
      message: payload,
    };

    if (usePrivate) {
      request.messageReplyOption = MessageReplyOption.REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD;
      payload.privateMessageViewer = { name: privateViewer };
    } else if (threadName) {
      request.messageReplyOption = MessageReplyOption.REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD;
    }

    try {
      const [created] = await this.client.createMessage(request);
      this.logger.debug({ parent }, 'Posted message');
      return created;
    } catch (error) {
      if (!usePrivate) throw error;
      this.logger.warn({ err: error }, 'Private reply failed; retrying as normal message');
      delete payload.privateMessageViewer;
      const [created] = await this.client.createMessage({
        parent,
        message: payload,
        messageReplyOption: MessageReplyOption.REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD,
      });
      this.logger.debug({ parent }, 'Posted fallback message');
      return created;
    }
  }

  /**
   * @param {string} messageName
   * @param {object} message
   */
  async patchMessage(messageName, message) {
    const payload = { ...message, name: messageName };
    const [updated] = await this.client.updateMessage({
      message: payload,
      updateMask: {
        paths: ['text', 'cards_v2'],
      },
    });
    this.logger.debug({ messageName }, 'Updated message');
    return updated;
  }

  /**
   * @param {string} userName
   * @param {string} text
   * @param {object[]} [cardsV2]
   */
  async sendDm(userName, text, cardsV2 = null) {
    const dmSpace = await this.findOrCreateDmSpace(userName);
    const message = { text };
    if (cardsV2) message.cardsV2 = cardsV2;
    return this.postMessage({ parent: dmSpace, message });
  }

  /**
   * Find or create a 1:1 DM space between the Chat app and the given user.
   * Uses findDirectMessage (listSpaces does not support single_user_filter).
   * @param {string} userName - Resource name, e.g. users/123…
   */
  async findOrCreateDmSpace(userName) {
    try {
      const [existing] = await this.client.findDirectMessage({ name: userName });
      if (existing?.name) {
        return existing.name;
      }
    } catch (error) {
      // 5 = NOT_FOUND — no DM yet; create one below.
      if (error?.code !== 5) {
        this.logger.warn({ err: error, userName }, 'findDirectMessage failed; trying setupSpace');
      }
    }

    const [space] = await this.client.setupSpace({
      space: { spaceType: 'DIRECT_MESSAGE' },
      memberships: [
        {
          member: {
            name: userName,
            type: 'HUMAN',
          },
        },
      ],
    });
    return space.name;
  }
}
