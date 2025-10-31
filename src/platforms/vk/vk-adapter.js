'use strict';

const { VK, Keyboard } = require('vk-io');
const { PlatformAdapter, PlatformEventType, OutboundMessageType } = require('../platform-adapter');
const { logger } = require('../../infra/logger');

class VkAdapter extends PlatformAdapter {
  /**
   * @param {Object} options
   * @param {string} options.token - Токен сообщества (group access token)
   * @param {number} options.groupId - ID группы/сообщества
   * @param {string} [options.apiVersion] - Версия API
   * @param {Object} [options.pollingOptions] - Настройки long poll
   */
  constructor(options = {}) {
    const { token, groupId, apiVersion = '5.199', pollingOptions = {} } = options;

    super({ name: 'vk', displayName: 'VK' });

    if (!token) {
      throw new Error('VkAdapter: не задан token сообщества');
    }
    if (!groupId) {
      throw new Error('VkAdapter: не задан groupId');
    }

    this.groupId = groupId;
    this.vk = new VK({
      token,
      apiVersion,
      pollingGroupId: groupId
    });

    this.updates = this.vk.updates;
    this.updates.options.pollingGroupId = groupId;
    if (pollingOptions && Object.keys(pollingOptions).length > 0) {
      Object.assign(this.updates.options, pollingOptions);
    }

    this._bindListeners();
  }

  async start() {
    if (this._isRunning) {
      return;
    }
    this._isRunning = true;
    await this.updates.startPolling();
    logger.info('[vk] Long Poll запущен');
  }

  async stop() {
    if (!this._isRunning) {
      return;
    }
    this._isRunning = false;
    await this.updates.stopPolling();
    logger.info('[vk] Long Poll остановлен');
  }

  async sendMessage(context, message) {
    const peerIdRaw = context?.peerId ?? context?.rawUserId ?? context?.userId;
    const peerId = typeof peerIdRaw === 'number' ? peerIdRaw : Number(peerIdRaw);

    if (peerIdRaw == null || Number.isNaN(peerId) || peerId === 0) {
      throw new Error('vk.sendMessage: не указан peerId');
    }

    const payload = this._buildSendPayload(peerId, message);
    const response = await this._sendWithKeyboardFallback(payload);

    return {
      message_id: response,
      peer_id: peerId,
      conversation_message_id: payload.conversation_message_id ?? null
    };
  }

  async updateMessage(context, message) {
    const peerIdRaw = context?.peerId ?? context?.rawUserId ?? context?.userId;
    const peerId = typeof peerIdRaw === 'number' ? peerIdRaw : Number(peerIdRaw);
    const conversationMessageId = context?.conversationMessageId;
    const messageId = context?.messageId;

    if (peerIdRaw == null || Number.isNaN(peerId) || peerId === 0) {
      throw new Error('vk.updateMessage: требуется peerId');
    }

    if (!conversationMessageId && !messageId) {
      throw new Error('vk.updateMessage: требуется conversationMessageId или messageId');
    }

    const payload = this._buildSendPayload(peerId, message);

    if (conversationMessageId) {
      payload.conversation_message_id = conversationMessageId;
    } else {
      payload.message_id = messageId;
    }

    return this._editWithKeyboardFallback(payload);
  }

  _bindListeners() {
    this.updates.on('message_new', async (context, next) => {
      if (!this._eventHandler) {
        return next();
      }

      if (context.isOutbox) {
        return next();
      }

      const text = context.text || '';
      const isCommand = text.trim().startsWith('/');
      const payload = context.messagePayload
        ? this._safeParsePayload(context.messagePayload)
        : null;
      const peerId = context.peerId ?? context.senderId ?? null;

      const event = {
        platform: this.name,
        rawUserId: peerId,
        type: isCommand ? PlatformEventType.COMMAND : PlatformEventType.TEXT,
        text,
        payload,
        meta: {
          peerId: peerId,
          conversationMessageId: context.conversationMessageId ?? null,
          messageId: context.id ?? null,
          fromId: context.senderId ?? null,
          text,
          attachments: context.attachments,
          isOutbox: context.isOutbox,
          raw: context
        },
        isGroup: context.peerType !== 'user'
      };

      if (isCommand) {
        const command = text.trim().split(/\s+/)[0];
        event.meta.command = command;
        event.meta.commandName = command.replace(/^\//, '').toLowerCase();
        event.meta.args = text.slice(command.length).trim();
      }

      await this.emitEvent(event);
      return next();
    });

    this.updates.on('message_event', async (context, next) => {
      if (!this._eventHandler) {
        return next();
      }

      const rawPayload = context.eventPayload ?? context.payload ?? null;

      const event = {
        platform: this.name,
        rawUserId: context.peerId,
        type: PlatformEventType.CALLBACK,
        text: '',
        payload: this._safeParsePayload(rawPayload),
        meta: {
          peerId: context.peerId,
          userId: context.userId,
          eventId: context.eventId,
          conversationMessageId: context.conversationMessageId ?? null,
          raw: context
        },
        isGroup: context.peerType !== 'user'
      };

      await this.emitEvent(event);
      return next();
    });
  }

  _buildSendPayload(peerId, message) {
    const payload = {
      peer_id: peerId,
      random_id: this._generateRandomId(),
      message: message.text || ''
    };

    if (message.type === OutboundMessageType.EDIT || message.type === OutboundMessageType.TEXT) {
      // текст уже установлен
    }

    if (message.keyboard) {
      payload.keyboard = this._buildKeyboard(message.keyboard);
    }

    if (message.meta) {
      const { attachment, attachments, disableMentions } = message.meta;
      if (attachment) {
        payload.attachment = attachment;
      }
      if (attachments) {
        payload.attachment = attachments;
      }
      if (typeof disableMentions === 'boolean') {
        payload.disable_mentions = disableMentions;
      }
    }

    return payload;
  }

  _generateRandomId() {
    // Используем диапазон 32-битного знакового int, как требует VK API
    return Math.floor(Math.random() * 2_000_000_000);
  }

  _buildKeyboard(keyboard) {
    if (
      keyboard &&
      typeof keyboard === 'object' &&
      typeof keyboard.toString === 'function' &&
      typeof keyboard.toJSON === 'function'
    ) {
      return keyboard;
    }

    if (keyboard.builder && typeof keyboard.builder === 'object') {
      return keyboard.builder;
    }

    if (keyboard.type === 'inline') {
      const builder = Keyboard.builder().inline();
      this._fillBuilderWithButtons(builder, keyboard.buttons || [], true); // true = inline mode
      return builder;
    }

    if (keyboard.type === 'reply') {
      const builder = Keyboard.builder().oneTime(Boolean(keyboard.oneTime));
      this._fillBuilderWithButtons(builder, keyboard.buttons || [], false); // false = reply mode
      return builder;
    }

    if (Array.isArray(keyboard)) {
      const builder = Keyboard.builder();
      this._fillBuilderWithButtons(builder, keyboard, false);
      return builder;
    }

    return keyboard;
  }

  _fillBuilderWithButtons(builder, buttonsMatrix, isInline = false) {
    if (!builder || !Array.isArray(buttonsMatrix)) {
      return;
    }

    buttonsMatrix.forEach((row, rowIndex) => {
      if (!Array.isArray(row)) {
        return;
      }

      row.forEach(button => {
        if (!button) {
          return;
        }

        const action = button.action || {};
        const label = action.label || button.label || '';
        if (!label) {
          return;
        }

        let payload = action.payload ?? button.payload ?? null;
        if (payload && typeof payload !== 'object') {
          try {
            payload = JSON.parse(payload);
          } catch (_) {
            payload = String(payload);
          }
        }

        const color = this._mapButtonColor(button.color);

        // Для inline клавиатур используем callbackButton, для обычных - textButton
        if (isInline) {
          builder.callbackButton({
            label,
            payload: payload || undefined,
            color
          });
        } else {
          builder.textButton({
            label,
            payload: payload || undefined,
            color
          });
        }
      });

      if (rowIndex < buttonsMatrix.length - 1) {
        builder.row();
      }
    });
  }

  _mapButtonColor(color) {
    switch ((color || '').toLowerCase()) {
      case 'primary':
        return Keyboard.PRIMARY_COLOR;
      case 'positive':
      case 'success':
        return Keyboard.POSITIVE_COLOR;
      case 'negative':
      case 'danger':
        return Keyboard.NEGATIVE_COLOR;
      default:
        return Keyboard.SECONDARY_COLOR;
    }
  }

  async _sendWithKeyboardFallback(payload) {
    try {
      return await this.vk.api.messages.send(payload);
    } catch (error) {
      if (this._isKeyboardUnsupportedError(error) && payload.keyboard) {
        const { keyboard: _keyboard, ...rest } = payload;
        logger.warn('[vk] Keyboard unsupported for peer, retrying without keyboard');
        return this.vk.api.messages.send(rest);
      }
      throw error;
    }
  }

  async _editWithKeyboardFallback(payload) {
    try {
      return await this.vk.api.messages.edit(payload);
    } catch (error) {
      if (this._isKeyboardUnsupportedError(error) && payload.keyboard) {
        const { keyboard: _keyboard, ...rest } = payload;
        logger.warn('[vk] Keyboard unsupported for peer on edit, retrying without keyboard');
        return this.vk.api.messages.edit(rest);
      }
      throw error;
    }
  }

  _isKeyboardUnsupportedError(error) {
    const code = error?.code ?? error?.error_code;
    return code === 911 || code === 912;
  }

  _safeParsePayload(payload) {
    if (!payload) {
      return null;
    }
    if (typeof payload === 'object') {
      return payload;
    }
    try {
      return JSON.parse(payload);
    } catch (_) {
      return { raw: payload };
    }
  }
}

module.exports = {
  VkAdapter,
  PlatformEventType,
  OutboundMessageType
};
