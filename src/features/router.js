const EncounterAPI = require('../../encounter-api');
const { logger } = require('../infra/logger');
const { parseGameUrl } = require('../utils/parse-game-url');
const { BURST_WINDOW } = require('./answer/burst-detector');
const { createBatchBuffer } = require('./answer/batch-buffer');
const {
  createInlineKeyboard,
  createReplyKeyboard
} = require('../presentation/keyboard-factory');
const {
  formatSectorsMessage,
  collectTaskFragments,
  collectHelps,
  formatTaskMessage,
  splitMessageBody,
  formatBatchProgress,
  formatStatusText,
  formatRemain
} = require('../presentation/message-formatter');
const { createAuthSetupHandler } = require('./auth/setup-handler');
const { createAdminMenu, WHITELIST_INPUT_STATE } = require('./admin/menu');
const { createTelegramContextFactory } = require('./router/context/telegram');
const { createWhitelistService } = require('../entities/user/service/whitelist-service');
const { createBatchSender } = require('./router/services/batch-sender');
const { createQueueCallbackHandler } = require('./router/callbacks/queue-handler');
const { createAnswerCallbackHandler } = require('./router/callbacks/answer-handler');
const { createBatchCallbackHandler } = require('./router/callbacks/batch-handler');
const { createAdminCallbackHandler } = require('./router/callbacks/admin-handler');
const { createReadyStateHandler } = require('./router/services/ready-state-handler');
const {
  userData,
  saveUserData,
  getUserInfo,
  isUserReady,
  updateUserActivity,
  getAnswerQueue,
  deleteUser,
  makeStorageKey
} = require('../core/user-store');
const {
  sendMessage: sendPlatformMessage,
  editMessage: editPlatformMessage,
  deleteMessage: deletePlatformMessage,
  answerCallback: answerPlatformCallback
} = require('../core/messenger');
const { LevelChangedError } = require('../core/encounter-errors');
const { ensureAuthenticated, createAuthCallback } = require('../core/auth-manager');
const { getAdminConfig, getWhitelistCache, saveAdminConfig } = require('../services/admin-config');

let TELEGRAM_PLATFORM = 'telegram';
let ROOT_USER_ID = 197924096;
let sendAnswerToEncounter = async () => {
  throw new Error('Answer service API не инициализирован');
};
let processAnswerQueue = async () => {
  throw new Error('Answer service API не инициализирован');
};

const STATES = {
  WAITING_FOR_LOGIN: 'waiting_for_login',
  WAITING_FOR_PASSWORD: 'waiting_for_password',
  WAITING_FOR_GAME_URL: 'waiting_for_game_url',
  READY: 'ready',
  WAITING_FOR_ANSWER: 'waiting_for_answer'
};

const MAIN_MENU_LAYOUT = [
  ['Задание', 'Задание (формат)'],
  ['Сектора'],
  ['🔗 Сменить игру', '👤 Сменить авторизацию'],
  ['🔄 Рестарт бота']
];

function createMainKeyboard(platform) {
  const buttons = MAIN_MENU_LAYOUT.map(row =>
    row.map(label => ({
      text: label,
      action: label,
      payload: { type: 'main_menu', value: label },
      color: 'secondary'
    }))
  );

  return createReplyKeyboard(platform, buttons, { resize: true, oneTime: false });
}

const setPlatformConfig = ({ telegram, vk: _vk, rootUserId } = {}) => {
  if (telegram) {
    TELEGRAM_PLATFORM = telegram;
  }
  if (rootUserId) {
    ROOT_USER_ID = rootUserId;
  }
};

const setAnswerServiceApi = api => {
  if (api?.sendAnswerToEncounter) {
    sendAnswerToEncounter = api.sendAnswerToEncounter;
  }
  if (api?.processAnswerQueue) {
    processAnswerQueue = api.processAnswerQueue;
  }
};

const userStates = new Map();

const getStateKey = (platform, userId) => makeStorageKey(platform, userId);
const getUserState = (platform, userId) => userStates.get(getStateKey(platform, userId));
const setUserState = (platform, userId, state) =>
  userStates.set(getStateKey(platform, userId), state);
const clearUserState = (platform, userId) => userStates.delete(getStateKey(platform, userId));

const getPlatformUser = (platform, userId) => getUserInfo(platform, userId);
const isPlatformUserReady = (platform, userId) => isUserReady(platform, userId);
const updatePlatformActivity = (platform, userId, username, firstName) =>
  updateUserActivity(platform, userId, username, firstName);

const sendMessage = (platform, userId, text, options = {}) =>
  sendPlatformMessage(platform, userId, text, options);

const editMessage = (platform, userId, messageId, text, options = {}) =>
  editPlatformMessage(platform, userId, messageId, text, options);

const deleteMessage = (platform, userId, messageId) =>
  deletePlatformMessage(platform, userId, messageId);

const answerCallback = (platform, data = {}) => answerPlatformCallback(platform, data);
const adminConfig = getAdminConfig();
const whitelistCache = getWhitelistCache();
const whitelistService = createWhitelistService({
  adminConfig,
  saveAdminConfig,
  whitelistCache
});

const batchBuffer = createBatchBuffer({
  getPlatformUser,
  getSendAnswerToEncounter: () => sendAnswerToEncounter,
  logger
});

const { queueAnswerForProcessing, resetBurstState } = batchBuffer;
const executeBatchSend = createBatchSender({
  logger,
  getPlatformUser,
  createAuthCallback,
  EncounterAPI,
  saveUserData,
  sendMessage,
  sendOrUpdateMessage,
  createInlineKeyboard,
  formatBatchProgress,
  formatStatusText,
  LevelChangedError
});
const queueCallbackHandler = createQueueCallbackHandler({
  logger,
  getPlatformUser,
  getAnswerQueue,
  saveUserData,
  processAnswerQueue: (platform, userId) => processAnswerQueue(platform, userId),
  sendMessage
});
const answerCallbackHandler = createAnswerCallbackHandler({
  logger,
  getPlatformUser,
  saveUserData,
  createAuthCallback,
  EncounterAPI,
  sendMessage
});
const batchCallbackHandler = createBatchCallbackHandler({
  logger,
  getPlatformUser,
  saveUserData,
  processBatchSend: (platform, userId) => processBatchSend(platform, userId),
  sendMessage,
  createAuthCallback,
  EncounterAPI,
  resetBurstState
});
const {
  showAdminMainMenu,
  showUsersList,
  showModerationMenu,
  showWhitelistMenu,
  handleWhitelistAdd,
  handleWhitelistRemove,
  handleWhitelistManualEntry,
  toggleModeration
} = createAdminMenu({
  logger,
  userData,
  adminConfig,
  saveAdminConfig,
  createInlineKeyboard,
  editTelegramMessage,
  sendMessage,
  setUserState,
  clearUserState,
  answerTelegramCallback,
  getTelegramPlatform: () => TELEGRAM_PLATFORM,
  whitelistService
});
const {
  createMessageContext: createTelegramContext,
  createCallbackContext: createTelegramCallbackContext
} = createTelegramContextFactory(() => TELEGRAM_PLATFORM);
const adminCallbackHandler = createAdminCallbackHandler({
  logger,
  getTelegramPlatform: () => TELEGRAM_PLATFORM,
  getRootUserId: () => ROOT_USER_ID,
  adminConfig,
  saveAdminConfig,
  clearUserState,
  deleteMessage,
  showAdminMainMenu,
  showModerationMenu,
  showUsersList,
  showWhitelistMenu,
  handleWhitelistAdd,
  handleWhitelistRemove,
  toggleModeration
});
const { handleReadyStateInput } = createReadyStateHandler({
  handleStartCommand,
  checkGameAccess,
  sendMessage,
  sendOrUpdateMessage,
  editMessage,
  ensureAuthenticated,
  createAuthCallback,
  EncounterAPI,
  saveUserData,
  collectTaskFragments,
  collectHelps,
  formatRemain,
  formatTaskMessage,
  formatSectorsMessage,
  splitMessageBody,
  getTelegramPlatform: () => TELEGRAM_PLATFORM,
  setUserState,
  getStates: () => STATES,
  resetUserRuntimeState,
  queueAnswerForProcessing,
  processAnswerQueue: (platform, userId) => processAnswerQueue(platform, userId)
});
const { handleLoginInput, handlePasswordInput, handleGameUrlInput } = createAuthSetupHandler({
  sendMessage,
  setUserState,
  saveUserData,
  checkGameAccess,
  parseGameUrl,
  createMainKeyboard,
  logger,
  STATES,
  EncounterAPI
});

const ADMIN_ACTIONS = new Set(['admin_moderation', 'admin_back', 'moderation_toggle', 'whitelist_add']);
const ADMIN_ACTION_PREFIXES = ['admin_users_', 'admin_whitelist_', 'whitelist_remove_'];

const isAdminAction = action =>
  ADMIN_ACTIONS.has(action) || ADMIN_ACTION_PREFIXES.some(prefix => action.startsWith(prefix));

async function handleAdminAction(data, callbackContext, answerCb) {
  if (!isAdminAction(data)) {
    return false;
  }

  const { platform, chatId, queryId } = callbackContext;

  if (platform !== TELEGRAM_PLATFORM) {
    return true;
  }

  if (Number(chatId) !== ROOT_USER_ID) {
    if (queryId) {
      await answerCb({
        queryId,
        text: 'Access denied',
        show_alert: true
      });
    }
    return true;
  }

  if (adminCallbackHandler.matches(data, callbackContext)) {
    await adminCallbackHandler.handle(data, callbackContext);
  } else if (queryId) {
    await answerCb({ queryId });
  }

  return true;
}


const editTelegramMessage = (arg1, arg2, arg3, arg4) => {
  if (typeof arg3 === 'undefined' && typeof arg2 === 'object') {
    const options = arg2 || {};
    return editMessage(TELEGRAM_PLATFORM, options.chat_id, options.message_id, arg1, options);
  }
  const options = arg4 || {};
  return editMessage(TELEGRAM_PLATFORM, arg1, arg2, arg3, options);
};

const answerTelegramCallback = (queryId, options = {}) =>
  answerCallback(TELEGRAM_PLATFORM, { queryId, ...options });

async function handleResetCommand(context) {
  const { platform, userId } = context;
  deleteUser(platform, userId);
  clearUserState(platform, userId);
  await saveUserData();

  await sendMessage(
    platform,
    userId,
    '🔄 Данные сброшены!\n\n' + 'Все настройки удалены. Используйте /start для повторной настройки.'
  );
}

async function handleTestCommand(context) {
  const { platform, userId } = context;
  const user = getPlatformUser(platform, userId);

  if (!isPlatformUserReady(platform, userId)) {
    await sendMessage(platform, userId, '❌ Сначала настройте бота командой /start');
    return;
  }

  await sendMessage(platform, userId, '🔄 Тестирую подключение...');

  try {
    // Используем централизованную авторизацию с мьютексом
    const authCallback = await createAuthCallback(user, EncounterAPI, saveUserData);
    const api = new EncounterAPI(user.domain, authCallback);
    const isConnected = await api.checkConnection();

    if (!isConnected) {
      await sendMessage(platform, userId, `❌ Не удается подключиться к домену ${user.domain}`);
      return;
    }

    let authResult = { success: false };

    if (user.authCookies && Object.keys(user.authCookies).length > 0) {
      logger.info('📋 Используем сохраненную авторизацию для /test');
      authResult = { success: true, cookies: user.authCookies };
    } else {
      logger.info('🔐 Выполняем новую авторизацию для /test');
      authResult = await api.authenticate(user.login, user.password);
      if (authResult.success) {
        user.authCookies = authResult.cookies;
        await saveUserData();
      }
    }

    if (!authResult.success) {
      await sendMessage(
        platform,
        userId,
        `⚠️ Подключение есть, но ошибка авторизации: ${authResult.message}`
      );
      return;
    }

    const gameInfo = await api.getGameInfo(
      user.gameId,
      user.authCookies,
      user.login,
      user.password
    );

    if (!gameInfo.success) {
      await sendMessage(
        platform,
        userId,
        `✅ Подключение и авторизация успешны!\n` +
          `⚠️ Не удалось получить информацию об игре: ${gameInfo.error}\n\n` +
          `Попробуйте отправить тестовый ответ.`
      );
      return;
    }

    const data = gameInfo.data;
    await sendMessage(
      platform,
      userId,
      `✅ Тест успешен!\n\n` +
        `🌐 Подключение: ОК\n` +
        `🔐 Авторизация: ОК\n` +
        `🎮 Игра: ${data.name} (№${data.number})\n` +
        `👤 Игрок: ${data.login}\n` +
        `👥 Команда: ${data.team || 'Личная игра'}\n` +
        `📊 Статус: ${data.status === 'active' ? 'Активна' : 'Неактивна'}\n` +
        (data.level
          ? `🏆 Уровень: ${data.level.name} (№${data.level.number})\n` +
            `📈 Сектора: ${data.level.sectorsPassed}/${data.level.sectorsTotal}\n`
          : '') +
        `\nГотов к отправке ответов!`
    );
  } catch (error) {
    await sendMessage(platform, userId, `❌ Ошибка тестирования: ${error.message}`);
  }
}

async function handleAdminCommand(context) {
  const { platform, userId } = context;

  if (platform !== TELEGRAM_PLATFORM) {
    await sendMessage(platform, userId, 'Admin panel is available only in Telegram');
    return;
  }

  const numericId = Number(userId);
  if (numericId !== ROOT_USER_ID) {
    await sendMessage(platform, userId, 'Access denied to admin panel');
    return;
  }

  await showAdminMainMenu(userId);
}

async function handleListCommand(context) {
  const { platform, userId } = context;
  const user = getPlatformUser(platform, userId);

  if (!user.accumulatedAnswers || user.accumulatedAnswers.length === 0) {
    await sendMessage(platform, userId, '📋 Буфер пуст\n\nНет накопленных кодов.');
    return;
  }

  const totalCodes = user.accumulatedAnswers.length;
  const startLevel = user.accumulationStartLevel;

  const allCodes = user.accumulatedAnswers
    .map((item, index) => `${index + 1}. "${item.answer}" (уровень ${item.levelNumber || '?'})`)
    .join('\n');

  await sendMessage(
    platform,
    userId,
    `📋 Список накопленных кодов (${totalCodes}):\n\n` +
      `${allCodes}\n\n` +
      `Уровень на момент накопления: ${startLevel?.levelNumber || '?'}`
  );
}

async function handleClearCommand(context) {
  const { platform, userId } = context;
  const user = getPlatformUser(platform, userId);

  if (!user.accumulatedAnswers || user.accumulatedAnswers.length === 0) {
    await sendMessage(platform, userId, '🧹 Буфер уже пуст\n\nНет накопленных кодов.');
    return;
  }

  const count = user.accumulatedAnswers.length;

  // Очищаем буфер
  user.accumulatedAnswers = [];
  user.isAccumulatingAnswers = false;
  user.accumulationStartLevel = null;
  if (user.accumulationTimer) {
    clearTimeout(user.accumulationTimer);
    user.accumulationTimer = null;
  }
  await saveUserData();

  await sendMessage(
    platform,
    userId,
    `🧹 Буфер очищен\n\n` +
      `Удалено ${count} ${count === 1 ? 'код' : count < 5 ? 'кода' : 'кодов'}.`
  );
}

async function handleCancelCommand(context) {
  const { platform, userId } = context;
  const currentState = getUserState(platform, userId);

  if (currentState) {
    clearUserState(platform, userId);
    await sendMessage(platform, userId, '❌ Действие отменено');
  } else {
    await sendMessage(platform, userId, 'Нет активных действий для отмены');
  }
}

function resetUserRuntimeState(user) {
  if (!user) {
    return;
  }

  if (Array.isArray(user.answerQueue)) {
    user.answerQueue.length = 0;
  } else {
    user.answerQueue = [];
  }

  user.pendingQueueDecision = null;
  user.pendingAnswerDecision = null;
  user.isProcessingQueue = false;

  if (Array.isArray(user.accumulatedAnswers)) {
    user.accumulatedAnswers.length = 0;
  } else {
    user.accumulatedAnswers = [];
  }

  user.isAccumulatingAnswers = false;
  user.accumulationStartLevel = null;
  if (user.accumulationTimer) {
    clearTimeout(user.accumulationTimer);
    user.accumulationTimer = null;
  }

  resetBurstState(user);

  user.recentMessageTimestamps = [];
  user.isOnline = true;
}

async function handleStartCommand(context) {
  const { platform, userId } = context;
  const user = getPlatformUser(platform, userId);

  resetUserRuntimeState(user);
  await saveUserData();

  if (isPlatformUserReady(platform, userId)) {
    setUserState(platform, userId, STATES.READY);
    const message =
      'Добро пожаловать в en_off_bot! 🎮\n\n' +
      'Вы уже настроили бота:\n' +
      `👤 Логин: ${user.login}\n` +
      `🌐 Домен: ${user.domain}\n` +
      `🎯 ID игры: ${user.gameId}\n\n` +
      'Теперь вы можете отправлять ответы!';
    const keyboardOptions = createMainKeyboard(platform);
    await sendMessage(platform, userId, message, keyboardOptions);
  } else {
    setUserState(platform, userId, STATES.WAITING_FOR_LOGIN);
    const message =
      'Добро пожаловать в en_off_bot! 🎮\n\n' +
      'Этот бот поможет вам отправлять ответы в игру Encounter, даже если у вас временно нет интернета.\n\n' +
      'Для начала мне нужно настроить авторизацию.\n' +
      'Введите ваш логин:';
    await sendMessage(platform, userId, message);
  }
}

const COMMAND_HANDLERS = {
  reset: handleResetCommand,
  test: handleTestCommand,
  admin: handleAdminCommand,
  list: handleListCommand,
  clear: handleClearCommand,
  cancel: handleCancelCommand,
  start: handleStartCommand
};

async function handleCommand(context) {
  const command = (context.commandName || '').toLowerCase();

  const handler = COMMAND_HANDLERS[command];
  if (!handler) {
    return;
  }

  await handler(context);
}

async function handleCallback(context) {
  const { platform, userId, payload = '', meta = {} } = context;

  const chatId = meta.chatId ?? userId;
  const messageId = meta.messageId;
  const queryId = meta.queryId || meta.eventId;

  const answerCb = async (options = {}) => {
    if (!queryId) return;
    await answerCallback(platform, {
      queryId,
      eventId: meta.eventId,
      peerId: meta.peerId || chatId,
      userId,
      ...options
    });
  };

  let data = '';
  if (typeof payload === 'string') {
    data = payload;
  } else if (payload && typeof payload === 'object' && payload.action) {
    data = payload.action;
  }

  if (!data) {
    await answerCb();
    return;
  }

  const callbackContext = {
    platform,
    userId,
    chatId,
    messageId,
    queryId,
    answerCb
  };

  const callbackHandlers = [
    { handler: queueCallbackHandler, logPrefix: 'Ошибка обработки выбора очереди' },
    { handler: answerCallbackHandler, logPrefix: 'Ошибка обработки выбора ответа' },
    { handler: batchCallbackHandler, logPrefix: 'Ошибка обработки накопленных кодов' }
  ];

  for (const { handler, logPrefix } of callbackHandlers) {
    try {
      if (handler.matches(data, callbackContext)) {
        await handler.handle(data, callbackContext);
        return;
      }
    } catch (error) {
      logger.error(`${logPrefix}:`, error);
      if (queryId) {
        await answerCb({
          queryId,
          text: '❌ Ошибка обработки',
          show_alert: true
        });
      }
      return;
    }
  }

  if (await handleAdminAction(data, callbackContext, answerCb)) {
    return;
  }

  await answerCb();
}

/**
 * Отправка пачки накопленных кодов с двухуровневой защитой
 * 1. Проверка уровня ПЕРЕД началом отправки
 * 2. Проверка уровня ПОСЛЕ каждого отправленного кода
 */
async function processBatchSend(platform, userId) {
  return executeBatchSend(platform, userId);
}


async function handleTextMessage(context) {
  const { platform, userId, text = '', from } = context;
  const messageText = text != null ? String(text) : '';

  updatePlatformActivity(platform, userId, from?.username, from?.firstName);

  if (messageText.startsWith('/')) {
    return;
  }

  const user = getPlatformUser(platform, userId);

  // Детект всплеска сообщений (оффлайн-пачка)
  const now = Date.now();

  // Добавляем текущую метку
  user.recentMessageTimestamps = user.recentMessageTimestamps || [];
  user.recentMessageTimestamps.push(now);

  // Очищаем старые метки (> 10 секунд)
  user.recentMessageTimestamps = user.recentMessageTimestamps.filter(
    timestamp => now - timestamp < BURST_WINDOW
  );

  let currentState = getUserState(platform, userId);

  if (!currentState) {
    if (isPlatformUserReady(platform, userId)) {
      currentState = STATES.READY;
      setUserState(platform, userId, STATES.READY);
    } else {
      currentState = STATES.WAITING_FOR_LOGIN;
    }
  }

  if (currentState === WHITELIST_INPUT_STATE && platform === TELEGRAM_PLATFORM && Number(userId) === ROOT_USER_ID) {
    await handleWhitelistManualEntry(platform, userId, messageText.trim());
    return;
  }

  await processStateInput(platform, userId, user, currentState, messageText, context);
}

async function processStateInput(platform, userId, user, currentState, text, context) {
  switch (currentState) {
    case STATES.WAITING_FOR_LOGIN:
      await handleLoginInput(platform, userId, user, text);
      break;
    case STATES.WAITING_FOR_PASSWORD:
      await handlePasswordInput(platform, userId, user, text);
      break;
    case STATES.WAITING_FOR_GAME_URL:
      await handleGameUrlInput(platform, userId, user, text);
      break;
    case STATES.READY:
      await handleReadyStateInput(platform, userId, user, text, context);
      break;
    default:
      await sendMessage(
        platform,
        userId,
        '⚠️ Неизвестное состояние. Используйте /start для повторной настройки.'
      );
      setUserState(platform, userId, STATES.WAITING_FOR_LOGIN);
      break;
  }
}

module.exports = {
  setPlatformConfig,
  setAnswerServiceApi,
  registerTelegramHandlers,
  handleCommand,
  handleCallback,
  handleTextMessage,
  sendOrUpdateMessage
};
/**
 * Проверка пользователя в whitelist
 * @param {string} platform - идентификатор платформы
 * @param {string} userId - ID пользователя внутри платформы
 * @returns {boolean} - true если пользователь в whitelist или модерация выключена
 */
function isUserAllowed(platform, userId) {
  // Если модерация выключена - разрешаем всем
  if (!adminConfig.moderationEnabled) {
    return true;
  }

  const user = getPlatformUser(platform, userId);

  // Проверяем только по Encounter login
  if (user.login) {
    if (whitelistCache.has(user.login.toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Проверка доступа к игровым функциям
 * @param {string} platform - идентификатор платформы
 * @param {string} userId - ID пользователя
 * @returns {boolean} - true если доступ разрешен
 */
async function checkGameAccess(platform, userId) {
  if (isUserAllowed(platform, userId)) {
    return true;
  }

  // Доступ запрещен - отправляем сообщение
  await sendMessage(platform, userId, 'Access to the bot is not allowed. Contact @seo2z');
  return false;
}

// Throttling для обновлений сообщений (защита от rate limiting)
const MESSAGE_THROTTLE_TTL = 60_000;
const messageUpdateThrottle = new Map(); // `${platform}_${userId}_${messageId}` -> { lastUpdate, pendingText, pendingOptions, timeout, cleanupTimeout }

function scheduleThrottleCleanup(throttleKey, entry) {
  if (!entry) {
    return;
  }

  if (entry.cleanupTimeout) {
    clearTimeout(entry.cleanupTimeout);
    entry.cleanupTimeout = null;
  }

  entry.cleanupTimeout = setTimeout(() => {
    const current = messageUpdateThrottle.get(throttleKey);
    if (!current) {
      return;
    }

    if (!current.timeout && (current.pendingText === null || current.pendingText === undefined)) {
      messageUpdateThrottle.delete(throttleKey);
    } else {
      // Было отложенное обновление — попробуем ещё раз позже
      scheduleThrottleCleanup(throttleKey, current);
    }
  }, MESSAGE_THROTTLE_TTL);
}

async function sendOrUpdateMessage(platform, userId, text, messageId = null, options = {}) {
  try {
    if (messageId) {
      const throttleKey = `${platform}_${userId}_${messageId}`;
      const now = Date.now();
      const throttle = messageUpdateThrottle.get(throttleKey);

      if (throttle) {
        const elapsed = now - throttle.lastUpdate;

        if (elapsed < 2000) {
          logger.info(
            `⏳ Throttle: откладываю обновление сообщения (прошло ${elapsed}ms < 2000ms)`
          );

          if (throttle.timeout) {
            clearTimeout(throttle.timeout);
          }

          throttle.pendingText = text;
          throttle.pendingOptions = options;

          const waitTime = 2000 - elapsed;
          if (throttle.cleanupTimeout) {
            clearTimeout(throttle.cleanupTimeout);
            throttle.cleanupTimeout = null;
          }

          throttle.timeout = setTimeout(async () => {
            try {
              await editPlatformMessage(
                platform,
                userId,
                messageId,
                throttle.pendingText,
                throttle.pendingOptions || {}
              );
              throttle.lastUpdate = Date.now();
              throttle.pendingText = null;
              throttle.pendingOptions = null;
              throttle.timeout = null;
              logger.info('✅ Отложенное обновление сообщения выполнено');
              scheduleThrottleCleanup(throttleKey, throttle);
            } catch (err) {
              if (
                err.code === 'ETELEGRAM' &&
                err.response?.body?.description?.includes('message is not modified')
              ) {
                logger.info('⏭️ Отложенное обновление: сообщение не изменилось');
              } else if (err.response?.statusCode === 429) {
                logger.info('⚠️ Rate limit при отложенном обновлении, пропускаем');
              } else {
                logger.error('❌ Ошибка отложенного обновления:', err.message);
              }
              throttle.pendingText = null;
              throttle.pendingOptions = null;
              throttle.timeout = null;
              scheduleThrottleCleanup(throttleKey, throttle);
            }
          }, waitTime);

          return messageId;
        }
      }

      await editPlatformMessage(platform, userId, messageId, text, options);

      messageUpdateThrottle.set(throttleKey, {
        lastUpdate: Date.now(),
        pendingText: null,
        pendingOptions: null,
        timeout: null,
        cleanupTimeout: null
      });
      scheduleThrottleCleanup(throttleKey, messageUpdateThrottle.get(throttleKey));

      return messageId;
    }

    return await sendPlatformMessage(platform, userId, text, options);
  } catch (error) {
    if (
      error.code === 'ETELEGRAM' &&
      error.response?.body?.description?.includes('message is not modified')
    ) {
      logger.info('⏭️ Сообщение не изменилось, пропускаем обновление');
      return messageId;
    }

    if (error.response?.statusCode === 429) {
      logger.info('⚠️ Rate limit (429), пропускаем обновление сообщения');
      return messageId;
    }

    if (messageId && /не поддерживает editMessage/i.test(error.message || '')) {
      logger.info(`[${platform}] Транспорт не поддерживает обновление сообщений, отправляю новое`);
      return await sendPlatformMessage(platform, userId, text, options);
    }

    if (messageId && error.response?.status === 400) {
      logger.info('📤 Отправляем новое сообщение вместо обновления');
      return await sendPlatformMessage(platform, userId, text, options);
    }

    throw error;
  }
}

let handlersRegistered = false;
function registerTelegramHandlers(botInstance) {
  if (handlersRegistered) {
    return;
  }
  if (!botInstance) {
    throw new Error('Telegram бот не инициализирован для регистрации обработчиков');
  }
  handlersRegistered = true;

  const commandList = Object.keys(COMMAND_HANDLERS);

  commandList.forEach(command => {
    const regex = new RegExp(`\\/${command}(?:\\s+(.*))?$`, 'i');
    botInstance.onText(regex, async (msg, match) => {
      const args = match && match[1] ? match[1].trim() : '';
      const context = createTelegramContext(msg, {
        commandName: command,
        args
      });

      try {
        await handleCommand(context);
      } catch (error) {
        logger.error(`[telegram] Ошибка обработки команды /${command}:`, error);
      }
    });
  });

  botInstance.on('callback_query', async query => {
    const context = createTelegramCallbackContext(query);
    try {
      await handleCallback(context);
    } catch (error) {
      logger.error('[telegram] Ошибка обработчика callback_query:', error);
    }
  });
  botInstance.on('message', async msg => {
    const context = createTelegramContext(msg);
    try {
      await handleTextMessage(context);
    } catch (error) {
      logger.error('[telegram] Ошибка обработки сообщения:', error);
    }
  });
}

module.exports = {
  setPlatformConfig,
  setAnswerServiceApi,
  registerTelegramHandlers,
  handleCommand,
  handleCallback,
  handleTextMessage,
  sendOrUpdateMessage
};
