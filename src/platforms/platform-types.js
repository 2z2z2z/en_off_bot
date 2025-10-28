'use strict';

const PlatformEventType = Object.freeze({
  START: 'start',
  COMMAND: 'command',
  TEXT: 'text',
  BUTTON: 'button',
  CALLBACK: 'callback',
  SYSTEM: 'system'
});

const OutboundMessageType = Object.freeze({
  TEXT: 'text',
  EDIT: 'edit',
  DELETE: 'delete',
  REPLY: 'reply'
});

/**
 * @typedef {Object} PlatformEvent
 * @property {string} platform - Идентификатор платформы (`telegram`, `vk` и т.д.)
 * @property {string} userId - Нормализованный идентификатор пользователя внутри платформы
 * @property {string} rawUserId - Исходный id пользователя (может быть number в Telegram, peer_id в VK)
 * @property {PlatformEventType} type - Тип события (команда, обычный текст, нажатие кнопки и т.д.)
 * @property {string|null} text - Основной текст сообщения (если есть)
 * @property {Object|null} payload - Дополнительные данные (например, JSON payload кнопки)
 * @property {Object} meta - Вспомогательные сведения: chatId, messageId, username, raw update и т.д.
 * @property {boolean} isGroup - Флаг группового чата
 * @property {Date} receivedAt - Время получения события
 */

/**
 * @typedef {Object} OutboundMessage
 * @property {OutboundMessageType} type - Тип операции отправки
 * @property {string} text - Текст сообщения
 * @property {Object|null} keyboard - Описание клавиатуры/кнопок в платформенно-нейтральном виде
 * @property {Object} meta - Дополнительные параметры (parseMode, disablePreview и т.д.)
 */

module.exports = {
  PlatformEventType,
  OutboundMessageType
};
