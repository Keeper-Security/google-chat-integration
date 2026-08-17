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
   * @param {boolean} [options.preferInPlace] - Keep interactive replies in the
   *   invoking space/DM (e.g. create-secret). Default routes private replies
   *   to a 1:1 bot DM so peers never see request confirmations.
   */
  async postMessage({
    parent,
    message,
    threadName = null,
    privateViewer = null,
    space = null,
    preferInPlace = false,
  }) {
    // Default Slack-ephemeral style: requester-only text/cards go to bot DM.
    // Exception: preferInPlace (create-secret multi-step UI stays in context).
    if (privateViewer && !preferInPlace) {
      this.logger.debug(
        { privateViewer, parent, spaceType: space?.spaceType || space?.type },
        'Routing private reply to bot 1:1 DM',
      );
      return this.sendDm(
        privateViewer,
        message.text || '',
        message.cardsV2 || null,
      );
    }

    const payload = { ...message };
    if (threadName) {
      payload.thread = { name: threadName };
    }

    // In spaces, hide in-place private replies from other members.
    // In DMs, privateMessageViewer is not used (post in the same DM).
    const usePrivate =
      Boolean(privateViewer) && preferInPlace && !isDmSpace(space || {});

    const request = {
      parent,
      message: payload,
    };

    if (usePrivate) {
      request.messageReplyOption =
        MessageReplyOption.REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD;
      payload.privateMessageViewer = { name: privateViewer };
    } else if (threadName) {
      request.messageReplyOption =
        MessageReplyOption.REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD;
    }

    try {
      const [created] = await this.client.createMessage(request);
      this.logger.debug({ parent, preferInPlace, usePrivate }, 'Posted message');
      return created;
    } catch (error) {
      if (!usePrivate) throw error;
      // Prefer bot DM over leaking a public channel message.
      this.logger.warn(
        { err: error },
        'In-place private reply failed; falling back to bot 1:1 DM',
      );
      return this.sendDm(
        privateViewer,
        message.text || '',
        message.cardsV2 || null,
      );
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
        this.logger.warn(
          { err: error, userName },
          'findDirectMessage failed; trying setupSpace',
        );
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
