'use strict';

const { PlatformEventType, OutboundMessageType } = require('./platform-types');

class PlatformAdapter {
  /**
   * @param {Object} options
   * @param {string} options.name - Уникальное имя платформы (например, `telegram`)
   * @param {string} [options.displayName] - Человекочитаемое имя
   */
  constructor(options = {}) {
    const { name, displayName } = options;

    if (!name) {
      throw new Error('PlatformAdapter требует указать name');
    }

    this.name = name;
    this.displayName = displayName || name;
    this._eventHandler = null;
    this._isRunning = false;
  }

  /**
   * Запуск long-polling/подписок платформы.
   * Должен быть переопределён в наследнике.
   */
  async start() {
    throw new Error(`${this.name}: метод start() не реализован`);
  }

  /**
   * Остановка long-polling/подписок.
   * Наследники могут переопределить при необходимости.
   */
  async stop() {
    this._isRunning = false;
  }

  /**
   * Регистрирует обработчик входящих платформенных событий.
   * @param {(event: PlatformEvent) => Promise<void>|void} handler
   */
  onEvent(handler) {
    this._eventHandler = handler;
    return () => {
      this._eventHandler = null;
    };
  }

  /**
   * Локальная отправка события наверх по стеку.
   * Наследники должны вызывать emitEvent() когда получают update.
   * @param {PlatformEvent} event
   */
  async emitEvent(event) {
    if (!this._eventHandler) {
      return;
    }

    const normalized = this._normalizeEvent(event);
    await this._eventHandler(normalized);
  }

  /**
   * Отправка сообщения пользователю/чату.
   * @param {Object} context - Данные для идентификации чата/сообщения
   * @param {OutboundMessage} message - Унифицированное описание сообщения
   */
  async sendMessage(context, message) {
    throw new Error(`${this.name}: метод sendMessage() не реализован`);
  }

  /**
   * Обновление ранее отправленного сообщения (если платформа поддерживает).
   * @param {Object} context
   * @param {OutboundMessage} message
   */
  async updateMessage(context, message) {
    throw new Error(`${this.name}: метод updateMessage() не реализован`);
  }

  /**
   * Унифицированная нормализация user id (строка по умолчанию).
   * Наследники могут переопределить при необходимости.
   */
  normalizeUserId(rawUserId) {
    return rawUserId == null ? '' : String(rawUserId);
  }

  /**
   * Базовая проверка и установка полей события.
   * @param {PlatformEvent} event
   * @returns {PlatformEvent}
   * @private
   */
  _normalizeEvent(event) {
    if (!event || typeof event !== 'object') {
      throw new Error(`${this.name}: передан некорректный event`);
    }

    if (!event.platform) {
      event.platform = this.name;
    }

    if (!event.type) {
      event.type = PlatformEventType.TEXT;
    }

    if (!event.receivedAt) {
      event.receivedAt = new Date();
    }

    if (!event.meta) {
      event.meta = {};
    }

    event.rawUserId = event.rawUserId ?? event.userId;
    event.userId = this.normalizeUserId(event.rawUserId);
    event.isGroup = Boolean(event.isGroup);

    return event;
  }
}

module.exports = {
  PlatformAdapter,
  PlatformEventType,
  OutboundMessageType
};
