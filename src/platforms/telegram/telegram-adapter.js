'use strict';

const TelegramBot = require('node-telegram-bot-api');
const { PlatformAdapter, PlatformEventType, OutboundMessageType } = require('../platform-adapter');
const { logger } = require('../../infra/logger');

class TelegramAdapter extends PlatformAdapter {
  /**
   * @param {Object} options
   * @param {string} options.token
   * @param {Object} [options.botOptions]
   */
  constructor(options = {}) {
    super({ name: 'telegram', displayName: 'Telegram' });

    const { token, botOptions } = options;

    if (!token) {
      throw new Error('TelegramAdapter требует token');
    }

    this.token = token;
    this.botOptions = botOptions || { polling: true };
    this.bot = null;
  }

  async start() {
    if (this._isRunning) {
      return;
    }

    this.bot = new TelegramBot(this.token, this.botOptions);
    this._bindListeners();
    this._isRunning = true;

    // Принудительно запрашиваем информацию о боте, чтобы убедиться в корректности токена
    try {
      await this.bot.getMe();
    } catch (error) {
      logger.error('[telegram] Не удалось получить профиль бота:', error.message);
      throw error;
    }
  }

  async stop() {
    if (!this._isRunning) {
      return;
    }

    try {
      await this.bot.stopPolling();
    } catch (error) {
      logger.error('[telegram] Ошибка остановки polling:', error.message);
    } finally {
      this._isRunning = false;
    }
  }

  /**
   * Вернуть оригинальный экземпляр node-telegram-bot-api.
   */
  getBot() {
    return this.bot;
  }

  async sendMessage(context, message) {
    if (!this.bot) {
      throw new Error('TelegramAdapter не запущен');
    }

    const chatId = context.chatId;
    if (!chatId) {
      throw new Error('sendMessage: не указан chatId');
    }

    const options = this._buildSendOptions(message);

    switch (message.type) {
      case OutboundMessageType.TEXT:
      case OutboundMessageType.REPLY:
      default:
        return this.bot.sendMessage(chatId, message.text, options);
    }
  }

  async updateMessage(context, message) {
    if (!this.bot) {
      throw new Error('TelegramAdapter не запущен');
    }

    const chatId = context.chatId;
    const messageId = context.messageId;
    if (!chatId || !messageId) {
      throw new Error('updateMessage: не указаны chatId и messageId');
    }

    const options = this._buildSendOptions(message);

    switch (message.type) {
      case OutboundMessageType.EDIT:
      case OutboundMessageType.TEXT:
      default:
        return this.bot.editMessageText(message.text, {
          chat_id: chatId,
          message_id: messageId,
          ...options
        });
    }
  }

  _bindListeners() {
    this.bot.on('message', msg => {
      if (!msg) return;

      const text = msg.text || '';
      const isCommand = typeof text === 'string' && text.startsWith('/');
      const commandParts = isCommand ? text.trim().split(/\s+/) : [];
      const command = isCommand ? commandParts[0] : null;

      const event = {
        platform: this.name,
        rawUserId: msg.chat?.id,
        type: isCommand ? PlatformEventType.COMMAND : PlatformEventType.TEXT,
        text: text,
        payload: null,
        meta: {
          chatId: msg.chat?.id,
          messageId: msg.message_id,
          chatType: msg.chat?.type,
          from: msg.from,
          chat: msg.chat,
          raw: msg
        },
        isGroup: msg.chat?.type !== 'private'
      };

      if (isCommand) {
        event.meta.command = command;
        event.meta.commandName = command.replace(/^\//, '').toLowerCase();
        event.meta.args = text.slice(command.length).trim();
      }

      this._safeEmit(event);
    });

    this.bot.on('callback_query', query => {
      const event = {
        platform: this.name,
        rawUserId: query.from?.id || query.message?.chat?.id,
        type: PlatformEventType.CALLBACK,
        text: query.data || '',
        payload: query.data,
        meta: {
          chatId: query.message?.chat?.id,
          messageId: query.message?.message_id,
          queryId: query.id,
          from: query.from,
          message: query.message,
          raw: query
        },
        isGroup: query.message?.chat?.type !== 'private'
      };

      this._safeEmit(event);
    });

    this.bot.on('polling_error', error => {
      logger.error('[telegram] polling_error:', error.message);
    });

    this.bot.on('error', error => {
      logger.error('[telegram] error:', error.message);
    });
  }

  async _safeEmit(event) {
    try {
      await this.emitEvent(event);
    } catch (error) {
      logger.error('[telegram] Ошибка обработчика события:', error);
    }
  }

  _buildSendOptions(message) {
    const options = { ...(message.meta || {}) };

    if (message.keyboard?.type === 'reply') {
      options.reply_markup = {
        keyboard: message.keyboard.buttons,
        resize_keyboard: message.keyboard.resize ?? true,
        one_time_keyboard: message.keyboard.oneTime ?? false
      };
    } else if (message.keyboard?.type === 'inline') {
      options.reply_markup = {
        inline_keyboard: message.keyboard.buttons
      };
    } else if (message.meta?.reply_markup) {
      options.reply_markup = message.meta.reply_markup;
    }

    if (message.meta?.parse_mode) {
      options.parse_mode = message.meta.parse_mode;
    }

    if (message.meta?.disable_web_page_preview !== undefined) {
      options.disable_web_page_preview = message.meta.disable_web_page_preview;
    }

    return options;
  }
}

module.exports = {
  TelegramAdapter
};
