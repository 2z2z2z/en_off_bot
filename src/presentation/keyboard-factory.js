'use strict';

const TELEGRAM = 'telegram';
const VK = 'vk';
const DEFAULT_VK_COLOR = 'secondary';

/**
 * Преобразует произвольное описание кнопок в двумерный массив.
 * Допускаются строки (текст кнопки) или объекты.
 * @param {Array<Array|string|Object>} input
 * @returns {Array<Array<Object>>}
 */
function normalizeButtonMatrix(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map(row => {
      if (!Array.isArray(row)) {
        row = [row];
      }
      return row
        .map(item => {
          if (item == null) {
            return null;
          }

          if (typeof item === 'string') {
            return {
              text: item,
              action: item
            };
          }

          if (typeof item === 'object') {
            const text = item.text || item.label || '';
            const action =
              item.action ||
              item.callbackData ||
              (typeof item.payload === 'object' && item.payload?.action) ||
              item.value ||
              text;

            return {
              ...item,
              text,
              action,
              payload: item.payload,
              color: item.color || DEFAULT_VK_COLOR
            };
          }

          return null;
        })
        .filter(Boolean);
    })
    .filter(row => row.length > 0);
}

function mapVkColor(color) {
  if (!color) {
    return DEFAULT_VK_COLOR;
  }

  const normalized = String(color).toLowerCase();

  switch (normalized) {
    case 'primary':
    case 'blue':
      return 'primary';
    case 'positive':
    case 'success':
    case 'green':
      return 'positive';
    case 'negative':
    case 'danger':
    case 'red':
      return 'negative';
    default:
      return DEFAULT_VK_COLOR;
  }
}

function buildTelegramInline(buttons) {
  return {
    reply_markup: {
      inline_keyboard: buttons.map(row =>
        row.map(button => {
          const payload = button.callbackData || button.action || button.text || '';
          const item = {
            text: button.text || button.label || '',
            callback_data: String(payload).slice(0, 64)
          };

          if (button.url) {
            item.url = button.url;
          }

          if (button.switchInlineQuery) {
            item.switch_inline_query = button.switchInlineQuery;
          }

          if (button.switchInlineQueryCurrentChat) {
            item.switch_inline_query_current_chat = button.switchInlineQueryCurrentChat;
          }

          return item;
        })
      )
    }
  };
}

function buildTelegramReply(buttons, options = {}) {
  const { resize = true, oneTime = false, placeholder } = options;

  return {
    reply_markup: {
      keyboard: buttons.map(row => row.map(button => button.text || button.label || '')),
      resize_keyboard: Boolean(resize),
      one_time_keyboard: Boolean(oneTime),
      ...(placeholder ? { input_field_placeholder: placeholder } : {})
    }
  };
}

function buildVkInline(buttons) {
  return {
    keyboard: {
      type: 'inline',
      buttons: buttons.map(row =>
        row.map(button => ({
          label: button.text || button.label || '',
          payload:
            button.payload || (button.action ? { action: button.action } : undefined) || undefined,
          color: mapVkColor(button.color)
        }))
      )
    }
  };
}

function buildVkReply(buttons, options = {}) {
  const { oneTime = false } = options;

  return {
    keyboard: {
      type: 'reply',
      oneTime: Boolean(oneTime),
      buttons: buttons.map(row =>
        row.map(button => ({
          label: button.text || button.label || '',
          payload:
            button.payload || (button.action ? { action: button.action } : undefined) || undefined,
          color: mapVkColor(button.color)
        }))
      )
    }
  };
}

/**
 * Создаёт inline-клавиатуру для указанной платформы.
 * @param {'telegram'|'vk'} platform
 * @param {Array<Array|Object|string>} buttons
 * @returns {Object}
 */
function createInlineKeyboard(platform, buttons) {
  const matrix = normalizeButtonMatrix(buttons);

  if (!matrix.length) {
    return {};
  }

  if (platform === TELEGRAM) {
    return buildTelegramInline(matrix);
  }

  if (platform === VK) {
    return buildVkInline(matrix);
  }

  return {};
}

/**
 * Создаёт reply-клавиатуру для указанной платформы.
 * @param {'telegram'|'vk'} platform
 * @param {Array<Array|Object|string>} buttons
 * @param {Object} [options]
 * @param {boolean} [options.resize=true]
 * @param {boolean} [options.oneTime=false]
 * @param {string} [options.placeholder]
 * @returns {Object}
 */
function createReplyKeyboard(platform, buttons, options = {}) {
  const matrix = normalizeButtonMatrix(buttons);

  if (!matrix.length) {
    return {};
  }

  if (platform === TELEGRAM) {
    return buildTelegramReply(matrix, options);
  }

  if (platform === VK) {
    return buildVkReply(matrix, options);
  }

  return {};
}

module.exports = {
  createInlineKeyboard,
  createReplyKeyboard
};

