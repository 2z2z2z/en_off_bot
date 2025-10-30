const { registerTransport } = require('../../core/messenger');
const { PlatformEventType, OutboundMessageType } = require('../../platforms/platform-types');

function createBotEngine({ adapters, logger, platforms }) {
  const { telegram: telegramAdapter, vk: vkAdapter } = adapters;
  const { telegram: TELEGRAM_PLATFORM, vk: VK_PLATFORM } = platforms;

  if (!telegramAdapter) {
    throw new Error('Telegram adapter обязателен для запуска bot-engine');
  }

  const startTelegram = async handlers => {
    const { registerTelegramHandlers, handleCommand, handleCallback, handleTextMessage } = handlers;

    await telegramAdapter.start();
    const bot = telegramAdapter.getBot();

    bot.on('error', error => {
      logger.error('Ошибка бота:', error);
    });

    bot.on('polling_error', error => {
      logger.error('Ошибка polling:', error);
    });

    registerTransport(TELEGRAM_PLATFORM, {
      sendMessage: (userId, text, options = {}) => bot.sendMessage(userId, text, options),
      editMessage: (userId, messageId, text, options = {}) =>
        bot.editMessageText(text, {
          chat_id: userId,
          message_id: messageId,
          ...(options || {})
        }),
      deleteMessage: (userId, messageId) => bot.deleteMessage(userId, messageId),
      sendTyping: userId =>
        bot.sendChatAction ? bot.sendChatAction(userId, 'typing') : Promise.resolve(),
      answerCallback: ({ queryId, ...options }) => bot.answerCallbackQuery(queryId, options)
    });

    registerTelegramHandlers(bot, { handleCommand, handleCallback, handleTextMessage });

    logger.info('🤖 Telegram-бот en_off_bot запущен!');
    logger.info('📱 Готов к приему сообщений...');

    return bot;
  };

  const startVk = async handlers => {
    if (!vkAdapter) {
      logger.info('ℹ️ VK платформа отключена (нет VK_GROUP_TOKEN или VK_GROUP_ID)');
      return null;
    }

    const { handleCommand, handleCallback, handleTextMessage } = handlers;

    await vkAdapter.start();

    const toPeerId = (userId, options = {}) => {
      if (typeof userId === 'number') {
        return userId;
      }

      if (typeof userId === 'string' && userId.trim() !== '') {
        const parsed = Number(userId);
        if (!Number.isNaN(parsed) && parsed !== 0) {
          return parsed;
        }
      }

      const fromOptions = options.peerId ?? options.peer_id ?? options.meta?.peerId;
      if (fromOptions != null) {
        const parsed = Number(fromOptions);
        if (!Number.isNaN(parsed) && parsed !== 0) {
          return parsed;
        }
      }

      throw new Error('[vk] Не удалось определить peerId');
    };

    registerTransport(VK_PLATFORM, {
      sendMessage: async (userId, text, options = {}) => {
        const peerId = toPeerId(userId, options);
        const safeText = text == null ? '' : String(text);
        const { keyboard, conversationMessageId, messageId, ...meta } = options || {};
        const response = await vkAdapter.sendMessage(
          { peerId, conversationMessageId, messageId },
          {
            type: OutboundMessageType.TEXT,
            text: safeText,
            keyboard,
            meta
          }
        );
        return {
          message_id: response.message_id ?? response,
          peer_id: response.peer_id ?? peerId,
          conversation_message_id:
            response.conversation_message_id ?? conversationMessageId ?? null
        };
      },
      editMessage: async (userId, messageId, text, options = {}) => {
        const peerId = toPeerId(userId, options);
        const safeText = text == null ? '' : String(text);
        const { keyboard, conversationMessageId, ...meta } = options || {};

        await vkAdapter.updateMessage(
          { peerId, messageId, conversationMessageId },
          {
            type: OutboundMessageType.EDIT,
            text: safeText,
            keyboard,
            meta
          }
        );

        return {
          message_id: messageId,
          peer_id: peerId,
          conversation_message_id: conversationMessageId ?? null
        };
      },
      sendTyping: async (userId, options = {}) => {
        try {
          const peerId = toPeerId(userId, options);
          await vkAdapter.vk.api.messages.sendActivity({
            peer_id: peerId,
            type: 'typing'
          });
        } catch (error) {
          logger.debug('[vk] Ошибка sendTyping:', error.message);
        }
      },
      answerCallback: async (data = {}) => {
        try {
          const { eventId, peerId, userId, text } = data;

          if (!eventId) {
            logger.warn('[vk] answerCallback: eventId не указан');
            return;
          }

          const payload = {
            event_id: eventId,
            peer_id: peerId || userId,
            user_id: userId
          };

          if (text) {
            payload.event_data = JSON.stringify({
              type: 'show_snackbar',
              text
            });
          }

          await vkAdapter.vk.api.messages.sendMessageEventAnswer(payload);
        } catch (error) {
          logger.error('[vk] Ошибка answerCallback:', error.message);
        }
      }
    });

    vkAdapter.onEvent(async event => {
      try {
        if (event.type === PlatformEventType.COMMAND) {
          await handleCommand({
            platform: event.platform,
            userId: event.userId,
            text: event.text || '',
            commandName: event.meta?.commandName || '',
            args: event.meta?.args || '',
            meta: event.meta || {},
            from: event.meta?.from || {
              id: event.meta?.fromId
            }
          });
        } else if (event.type === PlatformEventType.CALLBACK) {
          await handleCallback({
            platform: event.platform,
            userId: event.userId,
            payload: event.payload,
            meta: event.meta || {}
          });
        } else {
          await handleTextMessage({
            platform: event.platform,
            userId: event.userId,
            text: event.text || '',
            meta: event.meta || {},
            from: event.meta?.from || {
              id: event.meta?.fromId
            }
          });
        }
      } catch (error) {
        logger.error('[vk] Ошибка обработки события:', error);
      }
    });

    logger.info('🌐 VK-платформа подключена и готова к работе');
    return vkAdapter;
  };

  const start = async handlers => {
    const telegramBot = await startTelegram(handlers);
    const vkInstance = await startVk(handlers).catch(error => {
      logger.error('❌ Не удалось запустить VK адаптер:', error);
      return null;
    });

    return {
      telegramBot,
      vkAdapter: vkInstance
    };
  };

  return {
    start
  };
}

module.exports = {
  createBotEngine
};
