const fs = require('fs-extra');
const {
  userData,
  loadUserData,
  saveUserData,
  getUserInfo,
  isUserReady,
  updateUserActivity,
  getAnswerQueue,
  enqueueAnswer,
  deleteUser,
  makeStorageKey
} = require('./src/core/user-store');
const EncounterAPI = require('./encounter-api');
const { createAnswerService } = require('./src/core/answer-service');
const { ensureAuthenticated, createAuthCallback } = require('./src/core/auth-manager');
const {
  registerTransport,
  sendMessage: sendPlatformMessage,
  editMessage: editPlatformMessage,
  deleteMessage: deletePlatformMessage,
  sendTyping: sendPlatformTyping,
  answerCallback: answerPlatformCallback
} = require('./src/core/messenger');
const { TelegramAdapter } = require('./src/platforms/telegram/telegram-adapter');
const { VkAdapter } = require('./src/platforms/vk');
const { PlatformEventType, OutboundMessageType } = require('./src/platforms/platform-types');

// Загрузка переменных окружения
require('dotenv').config();

// Токен Telegram бота из переменной окружения (обязателен)
const BOT_TOKEN = process.env.BOT_TOKEN;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!BOT_TOKEN) {
  console.error('❌ Не задан BOT_TOKEN. Добавьте токен бота в .env или переменные окружения.');
  process.exit(1);
}

if (!ENCRYPTION_KEY) {
  console.error('❌ Не задан ENCRYPTION_KEY. Добавьте уникальный ключ шифрования в .env или переменные окружения.');
  process.exit(1);
}

// Telegram адаптер и экземпляр бота
const telegramAdapter = new TelegramAdapter({ token: BOT_TOKEN });
let bot = null;
let sendToEncounterAPI = null;
let sendAnswerToEncounter = null;
let processAnswerQueue = null;
let vkAdapterInstance = null;
const TELEGRAM_PLATFORM = telegramAdapter.name;
const VK_GROUP_TOKEN = process.env.VK_GROUP_TOKEN || '';
const VK_GROUP_ID = process.env.VK_GROUP_ID ? Number(process.env.VK_GROUP_ID) : null;
const VK_PLATFORM = 'vk';

const BURST_WINDOW = 10000; // 10 секунд
const BURST_THRESHOLD = 3; // минимальное количество сообщений для пачки
const MESSAGE_INTERVAL_MAX = 2500; // максимальный интервал между сообщениями в пачке

const userStates = new Map();

const getStateKey = (platform, userId) => makeStorageKey(platform, userId);
const getUserState = (platform, userId) => userStates.get(getStateKey(platform, userId));
const setUserState = (platform, userId, state) => userStates.set(getStateKey(platform, userId), state);
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

const sendTyping = (platform, userId) =>
  sendPlatformTyping(platform, userId);

const answerCallback = (platform, data = {}) =>
  answerPlatformCallback(platform, data);

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

function createTelegramContext(msg, overrides = {}) {
  const chatId = String(msg.chat?.id ?? '');
  return {
    platform: TELEGRAM_PLATFORM,
    userId: chatId,
    text: msg.text ?? '',
    from: msg.from
      ? {
          id: msg.from.id,
          username: msg.from.username,
          firstName: msg.from.first_name,
          lastName: msg.from.last_name
        }
      : null,
    meta: {
      chatId: msg.chat?.id,
      messageId: msg.message_id,
      chatType: msg.chat?.type,
      chat: msg.chat,
      raw: msg
    },
    ...overrides
  };
}

function createTelegramCallbackContext(query, overrides = {}) {
  const chatId = query.message?.chat?.id ?? query.from?.id;
  const messageId = query.message?.message_id;
  return {
    platform: TELEGRAM_PLATFORM,
    userId: String(chatId ?? ''),
    text: query.data ?? '',
    payload: query.data,
    meta: {
      chatId,
      messageId,
      queryId: query.id,
      raw: query,
      from: query.from,
      message: query.message
    },
    ...overrides
  };
}

async function handleResetCommand(context) {
  const { platform, userId } = context;
  deleteUser(platform, userId);
  clearUserState(platform, userId);
  await saveUserData();

  await sendMessage(platform, userId,
    '🔄 Данные сброшены!\n\n' +
    'Все настройки удалены. Используйте /start для повторной настройки.'
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
      console.log('📋 Используем сохраненную авторизацию для /test');
      authResult = { success: true, cookies: user.authCookies };
    } else {
      console.log('🔐 Выполняем новую авторизацию для /test');
      authResult = await api.authenticate(user.login, user.password);
      if (authResult.success) {
        user.authCookies = authResult.cookies;
        await saveUserData();
      }
    }

    if (!authResult.success) {
      await sendMessage(platform, userId, `⚠️ Подключение есть, но ошибка авторизации: ${authResult.message}`);
      return;
    }

    const gameInfo = await api.getGameInfo(user.gameId, user.authCookies, user.login, user.password);

    if (!gameInfo.success) {
      await sendMessage(platform, userId,
        `✅ Подключение и авторизация успешны!\n` +
        `⚠️ Не удалось получить информацию об игре: ${gameInfo.error}\n\n` +
        `Попробуйте отправить тестовый ответ.`
      );
      return;
    }

    const data = gameInfo.data;
    await sendMessage(platform, userId,
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
    await sendMessage(platform, userId, '❌ Админ-панель доступна только в Telegram');
    return;
  }

  const numericId = Number(userId);
  if (numericId !== ROOT_USER_ID) {
    await sendMessage(platform, userId, '❌ У вас нет доступа к админ-панели');
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

  await sendMessage(platform, userId,
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

  await sendMessage(platform, userId,
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

  clearBurstTimer(user);
  if (Array.isArray(user.pendingBurstAnswers)) {
    user.pendingBurstAnswers.length = 0;
  } else {
    user.pendingBurstAnswers = [];
  }
  user._burstProcessing = false;
  user._burstProcessingRequested = false;

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

async function handleCommand(context) {
  const command = (context.commandName || '').toLowerCase();

  switch (command) {
    case 'reset':
      await handleResetCommand(context);
      break;
    case 'test':
      await handleTestCommand(context);
      break;
    case 'admin':
      await handleAdminCommand(context);
      break;
    case 'list':
      await handleListCommand(context);
      break;
    case 'clear':
      await handleClearCommand(context);
      break;
    case 'cancel':
      await handleCancelCommand(context);
      break;
    case 'start':
      await handleStartCommand(context);
      break;
    default:
      break;
  }
}

async function handleCallback(context) {
  const { platform, userId, payload = '', meta = {} } = context;

  const chatId = meta.chatId ?? userId;
  const messageId = meta.messageId;
  // Для Telegram используем queryId, для VK - eventId
  const queryId = meta.queryId || meta.eventId;

  // Helper для answerCallback (работает для Telegram и VK)
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

  // Универсальная обработка payload для Telegram (строка) и VK (объект)
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

  // Обработка кнопок выбора очереди (доступно для всех платформ)
  if (data === 'queue_send' || data === 'queue_clear') {
    try {
      const user = getPlatformUser(platform, userId);
      const queue = getAnswerQueue(platform, userId);

      if (!user.pendingQueueDecision) {
        if (queryId) {
          await answerCb({
            queryId,
            text: '⚠️ Нет активного выбора',
            show_alert: true
          });
        }
        return;
      }

      const decision = user.pendingQueueDecision;

      if (data === 'queue_send') {
        // Отправить очередь в новый уровень
        console.log(`✅ Пользователь выбрал: отправить ${queue.length} ответов в новый уровень`);

        user.pendingQueueDecision = null;
        await saveUserData();

        if (queryId) {
          await answerCb({
            queryId,
            text: `Отправка ${queue.length} ${queue.length === 1 ? 'ответа' : 'ответов'} в уровень ${decision.newLevelNumber}...`
          });
        }

        await sendMessage(platform, userId, `Обработка очереди из ${queue.length} ${queue.length === 1 ? 'ответа' : 'ответов'}...`);

        // Запускаем обработку очереди
        await processAnswerQueue(platform, userId);
      } else if (data === 'queue_clear') {
        // Очистить очередь
        const clearedAnswers = queue.slice(0, 5).map(item => `"${item.answer}"`).join(', ');
        const moreAnswers = queue.length > 5 ? ` и ещё ${queue.length - 5}` : '';

        console.log(`🗑️ Пользователь выбрал: очистить ${queue.length} ответов`);

        queue.length = 0;
        user.pendingQueueDecision = null;
        await saveUserData();

        if (queryId) {
          await answerCb({
            queryId,
            text: '🗑️ Очередь очищена'
          });
        }

        await sendMessage(platform, userId,
          `🗑️ Очередь очищена (уровень ${decision.oldLevelNumber} → ${decision.newLevelNumber})\n\n` +
          `Пропущено ${decision.queueSize} ${decision.queueSize === 1 ? 'ответ' : decision.queueSize < 5 ? 'ответа' : 'ответов'}: ${clearedAnswers}${moreAnswers}`
        );
      }

      return;
    } catch (error) {
      console.error('Ошибка обработки выбора очереди:', error);
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

  // Обработка кнопок выбора для одиночного ответа (доступно для всех платформ)
  if (data === 'answer_send' || data === 'answer_cancel') {
    try {
      const user = getPlatformUser(platform, userId);

      if (!user.pendingAnswerDecision) {
        if (queryId) {
          await answerCb({
            queryId,
            text: '⚠️ Нет активного выбора',
            show_alert: true
          });
        }
        return;
      }

      const decision = user.pendingAnswerDecision;

      if (data === 'answer_send') {
        // Отправить ответ в новый уровень
        console.log(`Пользователь выбрал: отправить "${decision.answer}" в уровень ${decision.newLevel}`);

        user.pendingAnswerDecision = null;
        await saveUserData();

        if (queryId) {
          await answerCb({
            queryId,
            text: `Отправка ответа в уровень ${decision.newLevel}...`
          });
        }

        // Отправляем ответ напрямую через API с централизованной авторизацией
        const authCallback = await createAuthCallback(user, EncounterAPI, saveUserData);
        const api = new EncounterAPI(user.domain, authCallback);

        try {
          const result = await api.sendAnswer(user.gameId, decision.answer, user.authCookies, user.login, user.password);

          if (result.success) {
            let levelInfo = null;
            if (result.level && result.level.LevelId) {
              levelInfo = result.level;
            } else if (result.data?.Level && result.data.Level.LevelId) {
              levelInfo = result.data.Level;
            }

            if (!levelInfo) {
              try {
                const state = await api.getGameState(user.gameId, user.authCookies, user.login, user.password);
                if (state.success && state.data?.Level && state.data.Level.LevelId) {
                  levelInfo = state.data.Level;
                }
              } catch (stateError) {
                console.error('⚠️ Не удалось обновить lastKnownLevel после подтверждения:', stateError.message);
              }
            }

            if (levelInfo && levelInfo.LevelId) {
              user.lastKnownLevel = {
                levelId: levelInfo.LevelId,
                levelNumber: levelInfo.Number,
                timestamp: Date.now()
              };
              console.log(`📌 Обновлен lastKnownLevel после подтверждения: уровень ${levelInfo.Number} (ID: ${levelInfo.LevelId})`);
            }

            await saveUserData();

            await sendMessage(platform, userId,
              `Ответ "${decision.answer}" отправлен в уровень ${decision.newLevel}\n${result.message}`
            );
          } else {
            await sendMessage(platform, userId,
              `❌ Ошибка при отправке: ${result.message || 'Неизвестная ошибка'}`
            );
          }

          if (result.newCookies) {
            user.authCookies = { ...(user.authCookies || {}), ...(result.newCookies || {}) };
            await saveUserData();
          }
        } catch (error) {
          console.error('Ошибка отправки ответа после подтверждения:', error);
          await sendMessage(platform, userId,
            `❌ Ошибка отправки: ${error.message}`
          );
        }
      } else if (data === 'answer_cancel') {
        // Отменить отправку
        console.log(`🚫 Пользователь выбрал: отменить отправку "${decision.answer}"`);

        user.pendingAnswerDecision = null;

        // Обновляем lastKnownLevel до актуального состояния игры
        try {
          const authCallback = await createAuthCallback(user, EncounterAPI, saveUserData);
          const api = new EncounterAPI(user.domain, authCallback);
          const gameState = await api.getGameState(user.gameId, user.authCookies, user.login, user.password);

          if (gameState.success && gameState.data?.Level) {
            user.lastKnownLevel = {
              levelId: gameState.data.Level.LevelId,
              levelNumber: gameState.data.Level.Number,
              timestamp: Date.now()
            };
            console.log(`📌 Обновлен lastKnownLevel после отмены ответа: уровень ${gameState.data.Level.Number} (ID: ${gameState.data.Level.LevelId})`);
          }
        } catch (error) {
          console.error('⚠️ Ошибка обновления lastKnownLevel при отмене:', error.message);
        }

        await saveUserData();

        if (queryId) {
          await answerCb({
            queryId,
            text: '🚫 Ответ отменён'
          });
        }

        await sendMessage(platform, userId,
          `🚫 Ответ "${decision.answer}" отменён\n\n` +
          `(Был подготовлен для уровня ${decision.oldLevel}, текущий уровень — ${decision.newLevel})`
        );
      }

      return;
    } catch (error) {
      console.error('Ошибка обработки выбора ответа:', error);
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

  // Обработка кнопок управления накопленными кодами (доступно для всех платформ)
  if (data === 'batch_send_all' || data === 'batch_send_force' || data === 'batch_cancel_all' || data === 'batch_list') {
    try {
      const user = getPlatformUser(platform, userId);

      if (data === 'batch_send_all') {
        // Отправить все накопленные коды
        console.log(`✅ Пользователь выбрал: отправить ${user.accumulatedAnswers?.length || 0} накопленных кодов`);

        if (!user.accumulatedAnswers || user.accumulatedAnswers.length === 0) {
          if (queryId) {
            await answerCb({
              queryId,
              text: '⚠️ Нет накопленных кодов',
              show_alert: true
            });
          }
          return;
        }

        if (queryId) {
          await answerCb({
            queryId,
            text: `Отправка ${user.accumulatedAnswers.length} ${user.accumulatedAnswers.length === 1 ? 'кода' : 'кодов'}...`
          });
        }

        // Вызываем функцию отправки пачки с защитой
        await processBatchSend(platform, userId);

      } else if (data === 'batch_send_force') {
        // Принудительная отправка (когда уровень изменился, но пользователь хочет отправить в новый)
        console.log(`✅ Пользователь выбрал: принудительно отправить в новый уровень`);

        if (!user.accumulatedAnswers || user.accumulatedAnswers.length === 0) {
          if (queryId) {
            await answerCb({
              queryId,
              text: '⚠️ Нет накопленных кодов',
              show_alert: true
            });
          }
          return;
        }

        if (queryId) {
          await answerCb({
            queryId,
            text: `Принудительная отправка...`
          });
        }

        // Сбрасываем accumulationStartLevel чтобы обойти первую проверку
        user.accumulationStartLevel = null;
        await saveUserData();

        // Вызываем отправку пачки
        await processBatchSend(platform, userId);

      } else if (data === 'batch_cancel_all') {
        // Отменить все накопленные коды
        const count = user.accumulatedAnswers?.length || 0;
        console.log(`🚫 Пользователь выбрал: отменить ${count} накопленных кодов`);

        if (count === 0) {
          if (queryId) {
            await answerCb({
              queryId,
              text: '⚠️ Нет накопленных кодов',
              show_alert: true
            });
          }
          return;
        }

        // Обновляем lastKnownLevel до актуального состояния игры
        try {
          const authCallback = await createAuthCallback(user, EncounterAPI, saveUserData);
          const api = new EncounterAPI(user.domain, authCallback);
          const gameState = await api.getGameState(user.gameId, user.authCookies, user.login, user.password);

          if (gameState.success && gameState.data?.Level) {
            user.lastKnownLevel = {
              levelId: gameState.data.Level.LevelId,
              levelNumber: gameState.data.Level.Number,
              timestamp: Date.now()
            };
            console.log(`📌 Обновлен lastKnownLevel после отмены пачки: уровень ${gameState.data.Level.Number} (ID: ${gameState.data.Level.LevelId})`);
          }
        } catch (error) {
          console.error('⚠️ Ошибка обновления lastKnownLevel при отмене:', error.message);
        }

        // Очищаем буфер накопления
        user.accumulatedAnswers = [];
        user.isAccumulatingAnswers = false;
        user.accumulationStartLevel = null;
        if (user.accumulationTimer) {
          clearTimeout(user.accumulationTimer);
          user.accumulationTimer = null;
        }
        clearBurstTimer(user);
        user.pendingBurstAnswers = [];
        await saveUserData();

        if (queryId) {
          await answerCb({
            queryId,
            text: '🚫 Все коды отменены'
          });
        }

        await sendMessage(platform, userId,
          `🚫 Отменено ${count} ${count === 1 ? 'код' : count < 5 ? 'кода' : 'кодов'}`
        );

      } else if (data === 'batch_list') {
        // Показать полный список накопленных кодов
        console.log(`📋 Пользователь запросил список накопленных кодов`);

        if (!user.accumulatedAnswers || user.accumulatedAnswers.length === 0) {
          if (queryId) {
            await answerCb({
              queryId,
              text: '⚠️ Нет накопленных кодов',
              show_alert: true
            });
          }
          return;
        }

        const allCodes = user.accumulatedAnswers
          .map((item, index) => `${index + 1}. "${item.answer}" (уровень ${item.levelNumber || '?'})`)
          .join('\n');

        if (queryId) {
          await answerCb({ queryId });
        }

        await sendMessage(platform, userId,
          `📋 Полный список накопленных кодов (${user.accumulatedAnswers.length}):\n\n${allCodes}`
        );

      }

      return;
    } catch (error) {
      console.error('Ошибка обработки накопленных кодов:', error);
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

  // Telegram-специфичные callback'и (админ-панель)
  if (platform !== TELEGRAM_PLATFORM) {
    return;
  }

  if (data.startsWith('admin_') && Number(chatId) !== ROOT_USER_ID) {
    if (queryId) {
      await answerCb({
        queryId,
        text: '❌ У вас нет доступа',
        show_alert: true
      });
    }
    return;
  }

  try {
    if (data.startsWith('admin_users_')) {
      const page = parseInt(data.split('_')[2], 10) || 0;
      await showUsersList(chatId, messageId, page);
      if (queryId) await answerCb({ queryId });
    } else if (data === 'admin_moderation') {
      await showModerationMenu(chatId, messageId);
      if (queryId) await answerCb({ queryId });
    } else if (data.startsWith('admin_whitelist_')) {
      const page = parseInt(data.split('_')[2], 10) || 0;
      clearUserState(platform, userId);
      await showWhitelistMenu(chatId, messageId, page);
      if (queryId) await answerCb({ queryId });
    } else if (data === 'admin_back') {
      clearUserState(platform, userId);
      if (messageId) {
        await deleteMessage(platform, chatId, messageId);
      }
      await showAdminMainMenu(chatId);
      if (queryId) await answerCb({ queryId });
    } else if (data === 'moderation_toggle') {
      adminConfig.moderationEnabled = !adminConfig.moderationEnabled;
      await saveAdminConfig();
      await showModerationMenu(chatId, messageId);
      if (queryId) {
        await answerCb({
          queryId,
          text: adminConfig.moderationEnabled ? '✅ Модерация включена' : '❌ Модерация выключена'
        });
      }
    } else if (data === 'whitelist_add') {
      await handleWhitelistAdd(chatId, messageId);
      if (queryId) await answerCb({ queryId });
    } else if (data.startsWith('whitelist_remove_')) {
      const index = parseInt(data.split('_')[2], 10);
      await handleWhitelistRemove(chatId, messageId, index, queryId);
      if (queryId) {
        await answerCb({
          queryId,
          text: '🗑️ Удалено из белого списка'
        });
      }
    } else if (queryId) {
      await answerCb({ queryId });
    }
  } catch (error) {
    console.error('Ошибка обработки callback_query:', error);
    if (queryId) {
      await answerCb({
        queryId,
        text: '❌ Ошибка обработки команды',
        show_alert: true
      });
    }
  }
}

/**
 * Отправка пачки накопленных кодов с двухуровневой защитой
 * 1. Проверка уровня ПЕРЕД началом отправки
 * 2. Проверка уровня ПОСЛЕ каждого отправленного кода
 */
async function processBatchSend(platform, userId) {
  const user = getPlatformUser(platform, userId);

  if (!user.accumulatedAnswers || user.accumulatedAnswers.length === 0) {
    console.log(`⚠️ Нет накопленных кодов для отправки`);
    await sendMessage(platform, userId, '⚠️ Нет накопленных кодов');
    return;
  }

  const totalCodes = user.accumulatedAnswers.length;
  const startLevel = user.accumulationStartLevel;

  console.log(`📤 Начало отправки пачки: ${totalCodes} кодов (уровень на момент накопления: ${startLevel?.levelNumber || '?'})`);

  try {
    // 🛡️ ЗАЩИТА УРОВЕНЬ 1: Проверка ПЕРЕД началом отправки
    console.log(`🔍 Проверка уровня ПЕРЕД отправкой пачки...`);

    const authCallback = await createAuthCallback(user, EncounterAPI, saveUserData);
    const api = new EncounterAPI(user.domain, authCallback);

    const gameState = await api.getGameState(user.gameId, user.authCookies, user.login, user.password);

    if (!gameState.success || !gameState.data || !gameState.data.Level) {
      throw new Error('Не удалось получить состояние игры');
    }

    const currentLevelId = gameState.data.Level.LevelId;
    const currentLevelNumber = gameState.data.Level.Number;

    console.log(`📋 Уровень на момент накопления: ${startLevel?.levelNumber} (ID: ${startLevel?.levelId})`);
    console.log(`📋 Текущий уровень: ${currentLevelNumber} (ID: ${currentLevelId})`);

    // Если уровень изменился - предупреждаем
    if (startLevel?.levelId && currentLevelId !== startLevel.levelId) {
      console.log(`⚠️ Уровень изменился (${startLevel.levelNumber} → ${currentLevelNumber}), спрашиваем пользователя`);

      const codesList = user.accumulatedAnswers
        .slice(0, 5)
        .map((item, index) => `${index + 1}. "${item.answer}"`)
        .join('\n');
      const moreCodesText = totalCodes > 5 ? `\n... и ещё ${totalCodes - 5}` : '';

      const messageText =
        `⚠️ Уровень изменился (${startLevel.levelNumber} → ${currentLevelNumber})\n\n` +
        `Накоплено ${totalCodes} ${totalCodes === 1 ? 'код' : totalCodes < 5 ? 'кода' : 'кодов'}:\n${codesList}${moreCodesText}\n\n` +
        `Что делать?`;

      let options = {};
      if (platform === 'telegram') {
        options = {
          reply_markup: {
            inline_keyboard: [[
              { text: `✅ Отправить в уровень ${currentLevelNumber}`, callback_data: 'batch_send_force' },
              { text: '🚫 Отменить', callback_data: 'batch_cancel_all' }
            ]]
          }
        };
      } else if (platform === 'vk') {
        options = {
          keyboard: {
            type: 'inline',
            buttons: [[
              { label: `✅ Отправить в уровень ${currentLevelNumber}`, payload: { action: 'batch_send_force' } },
              { label: '🚫 Отменить', payload: { action: 'batch_cancel_all' } }
            ]]
          }
        };
      }

      await sendMessage(platform, userId, messageText, options);
      return;
    }

    console.log(`✅ Уровень не изменился, начинаем отправку`);

    const normalizeCount = value => {
      if (value === undefined || value === null) {
        return null;
      }
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    };

    const formatSectors = (passed, required) => {
      if (passed === null || required === null) {
        return '—';
      }
      return `${passed}/${required}`;
    };

    const buildBatchProgressMessage = ({ progress, total, answer, statusText, levelNumber, sectorsText }) => {
      const levelDisplay = levelNumber ?? '—';
      const safeAnswer = answer ?? '—';
      const lines = [
        `📤 Отправка пачки: ${progress}/${total}`,
        `💬 "${safeAnswer}": ${statusText}`,
        `🎯 Уровень: ${levelDisplay}`
      ];
      if (sectorsText && sectorsText !== '—') {
        lines.push(`📊 Сектора: ${sectorsText}`);
      }
      return lines.join('\n');
    };

    const buildStatusText = rawMessage => {
      const message = rawMessage || 'Отправлен';
      const lower = message.toLowerCase();
      const isNegative = lower.includes('невер') || lower.includes('ошиб');
      const emoji = isNegative ? '👎' : '👍';
      return `${emoji} ${message}`;
    };

    let latestLevelNumber = currentLevelNumber ?? null;
    let latestPassed = normalizeCount(gameState.data.Level?.PassedSectorsCount);
    let latestRequired = normalizeCount(gameState.data.Level?.RequiredSectorsCount);

    // Начинаем отправку
    let sent = 0;
    let stopped = false;
    const batchCopy = [...user.accumulatedAnswers];
    const sentCodes = []; // Статистика отправленных кодов

    const initialMessage = buildBatchProgressMessage({
      progress: 0,
      total: totalCodes,
      answer: batchCopy[0]?.answer ?? '—',
      statusText: '⏳ Подготовка...',
      levelNumber: latestLevelNumber,
      sectorsText: formatSectors(latestPassed, latestRequired)
    });

    const progressMsg = await sendMessage(platform, userId, initialMessage);

    for (let i = 0; i < batchCopy.length; i++) {
      const item = batchCopy[i];
      const processed = i + 1;

      console.log(`📤 Отправка кода ${i + 1}/${totalCodes}: "${item.answer}"`);

      const sendingMessage = buildBatchProgressMessage({
        progress: processed,
        total: totalCodes,
        answer: item.answer,
        statusText: '⏳ Отправляю...',
        levelNumber: latestLevelNumber,
        sectorsText: formatSectors(latestPassed, latestRequired)
      });

      await sendOrUpdateMessage(platform, userId, sendingMessage, progressMsg.message_id);

      try {
        const result = await api.sendAnswer(user.gameId, item.answer, user.authCookies, user.login, user.password, false, currentLevelId);

        if (result.success) {
          sent++;
          console.log(`✅ Код "${item.answer}" отправлен (${sent}/${totalCodes})`);

          if (result.level) {
            latestLevelNumber = result.level.Number ?? latestLevelNumber;
            latestPassed = normalizeCount(result.level.PassedSectorsCount);
            latestRequired = normalizeCount(result.level.RequiredSectorsCount);
          }

          const statusText = buildStatusText(result.message);
          const statusMessage = buildBatchProgressMessage({
            progress: processed,
            total: totalCodes,
            answer: item.answer,
            statusText,
            levelNumber: latestLevelNumber,
            sectorsText: formatSectors(latestPassed, latestRequired)
          });

          await sendOrUpdateMessage(platform, userId, statusMessage, progressMsg.message_id);

          // Собираем детальную статистику
          const codeStats = {
            answer: item.answer,
            statusText,
            levelNumber: latestLevelNumber ?? currentLevelNumber,
            levelName: result.level?.Name || 'N/A',
            sectors: formatSectors(latestPassed, latestRequired)
          };
          sentCodes.push(codeStats);

          // 🛡️ ЗАЩИТА УРОВЕНЬ 2: Проверка ПОСЛЕ отправки кода
          if (result.level && result.level.LevelId !== currentLevelId) {
            console.log(`⚠️ Уровень изменился во время отправки (${currentLevelNumber} → ${result.level.Number})`);
            stopped = true;

            // Удаляем отправленные коды из буфера
            user.accumulatedAnswers.splice(0, sent);
            await saveUserData();

            const remaining = totalCodes - sent;
            const remainingList = user.accumulatedAnswers
              .slice(0, 5)
              .map(code => `"${code.answer}"`)
              .join(', ');
            const moreText = remaining > 5 ? ` и ещё ${remaining - 5}` : '';

            const messageText =
              `⚠️ Уровень изменился во время отправки!\n\n` +
              `📊 Отправлено: ${sent}/${totalCodes}\n` +
              `📦 Осталось: ${remaining}\n\n` +
              `Оставшиеся коды: ${remainingList}${moreText}\n\n` +
              `Что делать с оставшимися кодами?`;

            let options = {};
            if (platform === 'telegram') {
              options = {
                reply_markup: {
                  inline_keyboard: [[
                    { text: `✅ Отправить в уровень ${result.level.Number}`, callback_data: 'batch_send_force' },
                    { text: '🚫 Отменить', callback_data: 'batch_cancel_all' }
                  ]]
                }
              };
            } else if (platform === 'vk') {
              options = {
                keyboard: {
                  type: 'inline',
                  buttons: [[
                    { label: `✅ Отправить в уровень ${result.level.Number}`, payload: { action: 'batch_send_force' } },
                    { label: '🚫 Отменить', payload: { action: 'batch_cancel_all' } }
                  ]]
                }
              };
            }

            await sendMessage(platform, userId, messageText, options);
            break;
          }

          if (result.newCookies) {
            user.authCookies = { ...(user.authCookies || {}), ...(result.newCookies || {}) };
            await saveUserData();
          }
        } else {
          const statusText = `❌ ${result.message || 'Не отправлен'}`;
          const statusMessage = buildBatchProgressMessage({
            progress: processed,
            total: totalCodes,
            answer: item.answer,
            statusText,
            levelNumber: latestLevelNumber,
            sectorsText: formatSectors(latestPassed, latestRequired)
          });

          await sendOrUpdateMessage(platform, userId, statusMessage, progressMsg.message_id);

          sentCodes.push({
            answer: item.answer,
            statusText,
            levelNumber: latestLevelNumber ?? currentLevelNumber,
            levelName: result.level?.Name || 'N/A',
            sectors: formatSectors(latestPassed, latestRequired)
          });
        }
      } catch (error) {
        console.error(`❌ Ошибка отправки кода "${item.answer}":`, error.message);

        // Если уровень изменился - прерываем
        if (error.isLevelChanged) {
          stopped = true;

          user.accumulatedAnswers.splice(0, sent);
          await saveUserData();

          await sendMessage(platform, userId,
            `⚠️ Уровень изменился во время отправки!\n\n` +
            `📊 Отправлено: ${sent}/${totalCodes}\n` +
            `📦 Осталось: ${totalCodes - sent}\n\n` +
            `Используйте кнопки выше для выбора.`
          );
          break;
        }

        // Для других ошибок - продолжаем
        const statusText = `❌ Ошибка: ${error.message}`;
        const statusMessage = buildBatchProgressMessage({
          progress: processed,
          total: totalCodes,
          answer: item.answer,
          statusText,
          levelNumber: latestLevelNumber,
          sectorsText: formatSectors(latestPassed, latestRequired)
        });

        await sendOrUpdateMessage(platform, userId, statusMessage, progressMsg.message_id);

        sentCodes.push({
          answer: item.answer,
          statusText,
          levelNumber: latestLevelNumber ?? currentLevelNumber,
          levelName: 'N/A',
          sectors: formatSectors(latestPassed, latestRequired)
        });
      }

      // Задержка между отправками
      if (i < batchCopy.length - 1) {
        console.log('⏱️ Задержка 1.2 секунды перед следующим кодом...');
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
    }

    if (!stopped) {
      // Все коды отправлены успешно
      user.accumulatedAnswers = [];
      user.isAccumulatingAnswers = false;
      user.accumulationStartLevel = null;
      if (user.accumulationTimer) {
        clearTimeout(user.accumulationTimer);
        user.accumulationTimer = null;
      }
      await saveUserData();

      // Формируем детальный итоговый отчет
      let finalReport = `✅ Пачка отправлена!\n\n📊 Отправлено: ${sent}/${totalCodes}`;

      if (sentCodes.length > 0) {
        finalReport += `\n\n📋 Детальный отчет:\n\n`;
        sentCodes.forEach((code, index) => {
          const num = index + 1;
          finalReport += `${num}. "${code.answer}"\n`;
          const levelDisplay = code.levelNumber ?? '—';
          finalReport += `   ${code.statusText} | Уровень: ${levelDisplay}\n`;
          if (index < sentCodes.length - 1) {
            finalReport += `\n`;
          }
        });

        // Показываем текущее состояние игры
        const lastCode = sentCodes[sentCodes.length - 1];
        const levelSummary = lastCode.levelNumber ?? '—';
        finalReport += `\n📍 Текущий уровень: ${levelSummary}`;
        if (lastCode.sectors && lastCode.sectors !== '—') {
          finalReport += `\n📊 Текущие сектора: ${lastCode.sectors}`;
        }
      }

      await sendOrUpdateMessage(platform, userId, finalReport, progressMsg.message_id);
    }

  } catch (error) {
    console.error('Ошибка отправки пачки:', error);
    await sendMessage(platform, userId, `❌ Ошибка отправки пачки: ${error.message}`);
  }
}

async function handleTextMessage(context) {
  const { platform, userId, text = '', from } = context;
  const messageText = text != null ? String(text) : '';

  updatePlatformActivity(platform, userId, from?.username, from?.firstName);

  if (messageText.startsWith('/')) {
    return;
  }

  // Обработка кнопки "Начать" в VK как эквивалента /start
  if (platform === VK_PLATFORM && messageText.trim() === 'Начать') {
    await handleStartCommand(context);
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
    timestamp => (now - timestamp) < BURST_WINDOW
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

  if (
    currentState === 'WAITING_FOR_WHITELIST_ENTRY' &&
    platform === TELEGRAM_PLATFORM &&
    Number(userId) === ROOT_USER_ID
  ) {
    await handleWhitelistManualEntry(platform, userId, messageText.trim());
    return;
  }

  await processStateInput(platform, userId, user, currentState, messageText, context);
}

async function handleWhitelistManualEntry(platform, userId, loginInput) {
  if (platform !== TELEGRAM_PLATFORM) {
    return;
  }

  const login = loginInput.trim();

  if (login.length < 2) {
    await sendMessage(platform, userId, '❌ Логин должен содержать минимум 2 символа');
    return;
  }

  const exists = adminConfig.whitelist.some(item => {
    const itemLogin = item.login || (item.type === 'encounter' ? item.value : null);
    return itemLogin && itemLogin.toLowerCase() === login.toLowerCase();
  });

  if (exists) {
    await sendMessage(platform, userId, '⚠️ Этот логин уже есть в белом списке');
    clearUserState(platform, userId);
    return;
  }

  adminConfig.whitelist.push({
    login,
    addedBy: userId,
    addedAt: Date.now()
  });

  await saveAdminConfig();
  await sendMessage(platform, userId, `✅ Добавлено в белый список:\n🎮 <code>${login}</code>`, {
    parse_mode: 'HTML'
  });

  clearUserState(platform, userId);
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
      await sendMessage(platform, userId, '⚠️ Неизвестное состояние. Используйте /start для повторной настройки.');
      setUserState(platform, userId, STATES.WAITING_FOR_LOGIN);
      break;
  }
}

async function handleLoginInput(platform, userId, user, text) {
  user.login = text;
  setUserState(platform, userId, STATES.WAITING_FOR_PASSWORD);
  await sendMessage(platform, userId, `Логин сохранен: ${text}\nТеперь введите пароль:`);
}

async function handlePasswordInput(platform, userId, user, text) {
  user.password = text;

  if (!user.login || !user.password || user.login.length < 2 || user.password.length < 2) {
    setUserState(platform, userId, STATES.WAITING_FOR_LOGIN);
    await sendMessage(platform, userId, '❌ Логин и пароль должны содержать минимум 2 символа.\nВведите логин еще раз:');
    return;
  }

  await sendMessage(platform, userId, '🔄 Проверяю данные авторизации...');

  try {
    const authResult = await checkAuthentication(user.login, user.password);

    if (authResult.success) {
      user.authCookies = authResult.cookies;
      await saveUserData();
      setUserState(platform, userId, STATES.WAITING_FOR_GAME_URL);
      await sendMessage(platform, userId,
        '✅ Авторизация успешна!\nТеперь пришлите ссылку на игру Encounter.\n\n' +
        'Поддерживаемые форматы:\n' +
        '• https://domain.en.cx/GameDetails.aspx?gid=XXXXX\n' +
        '• https://domain.en.cx/gameengines/encounter/play/XXXXX/'
      );
    } else {
      setUserState(platform, userId, STATES.WAITING_FOR_LOGIN);
      await sendMessage(platform, userId, `❌ ${authResult.message}\nВведите логин еще раз:`);
    }
  } catch (error) {
    setUserState(platform, userId, STATES.WAITING_FOR_LOGIN);
    await sendMessage(platform, userId, `❌ Ошибка проверки авторизации: ${error.message}\nВведите логин еще раз:`);
  }
}

async function handleGameUrlInput(platform, userId, user, text) {
  if (!(await checkGameAccess(platform, userId))) {
    return;
  }

  const gameUrlResult = parseGameUrl(text);

  if (!gameUrlResult.success) {
    await sendMessage(platform, userId, `❌ ${gameUrlResult.message}\n\nПопробуйте еще раз:`);
    return;
  }

  if (user.domain && user.domain !== gameUrlResult.domain) {
    console.log(`🔄 Домен изменился с ${user.domain} на ${gameUrlResult.domain}, сбрасываем cookies`);
    user.authCookies = null;
  }

  user.domain = gameUrlResult.domain;
  user.gameId = gameUrlResult.gameId;
  setUserState(platform, userId, STATES.READY);
  await saveUserData();

  const message =
    '🎉 Настройка завершена!\n\n' +
    `👤 Логин: ${user.login}\n` +
    `🌐 Домен: ${user.domain}\n` +
    `🎮 ID игры: ${user.gameId}\n` +
    `🔗 Тип ссылки: ${gameUrlResult.type}\n\n` +
    'Теперь вы можете отправлять ответы! Просто напишите ответ в чат.';

  const keyboardOptions = createMainKeyboard(platform);
  await sendMessage(platform, userId, message, keyboardOptions);
}

function ensureBurstBuffer(user) {
  if (!Array.isArray(user.pendingBurstAnswers)) {
    user.pendingBurstAnswers = [];
  }
}

function clearBurstTimer(user) {
  if (user.pendingBurstTimer) {
    clearTimeout(user.pendingBurstTimer);
    user.pendingBurstTimer = null;
  }
}

function scheduleBurstTimer(platform, userId, user, delay) {
  clearBurstTimer(user);
  const timeout = Math.max(delay, 0);
  user.pendingBurstTimer = setTimeout(() => {
    user.pendingBurstTimer = null;
    triggerBurstProcessing(platform, userId).catch((error) => {
      console.error('[burst] Ошибка повторной обработки:', error);
    });
  }, timeout);
}

function getAccumulationSlice(pending) {
  if (!pending || pending.length < BURST_THRESHOLD) {
    return null;
  }

  const slice = pending.slice(-BURST_THRESHOLD);
  const firstTs = slice[0].timestamp;
  const lastTs = slice[slice.length - 1].timestamp;
  if ((lastTs - firstTs) > BURST_WINDOW) {
    return null;
  }

  for (let i = 1; i < slice.length; i++) {
    if ((slice[i].timestamp - slice[i - 1].timestamp) > MESSAGE_INTERVAL_MAX) {
      return null;
    }
  }

  return slice;
}

/**
 * Обрабатывает один entry из буфера pendingBurstAnswers.
 * Результат обработки не возвращается - уведомления отправляются в sendAnswerToEncounter.
 * @param {string} platform
 * @param {string} userId
 * @param {Object} entry
 */
async function processPendingEntry(platform, userId, entry) {
  if (!entry) {
    return;
  }

  try {
    await sendAnswerToEncounter(platform, userId, entry.answer, entry.progressMessageId);
  } catch (error) {
    console.error('[burst] Ошибка обработки ответа из буфера:', error);
  }
  // entry.resolve больше не используется - результат не ожидается синхронно
}

async function drainAllPending(platform, userId, user) {
  clearBurstTimer(user);
  while (user.pendingBurstAnswers && user.pendingBurstAnswers.length > 0) {
    const entry = user.pendingBurstAnswers.shift();
    await processPendingEntry(platform, userId, entry);
  }
}

async function triggerBurstProcessing(platform, userId) {
  const user = getPlatformUser(platform, userId);
  if (!user) {
    return;
  }

  ensureBurstBuffer(user);

  if (user._burstProcessing) {
    user._burstProcessingRequested = true;
    return;
  }

  user._burstProcessing = true;

  try {
    while (true) {
      if (!user.pendingBurstAnswers || user.pendingBurstAnswers.length === 0) {
        clearBurstTimer(user);
        break;
      }

      if (user.isAccumulatingAnswers) {
        await drainAllPending(platform, userId, user);
        continue;
      }

      const accumulationSlice = getAccumulationSlice(user.pendingBurstAnswers);
      if (accumulationSlice) {
        const spanMs = accumulationSlice[accumulationSlice.length - 1].timestamp - accumulationSlice[0].timestamp;
        console.log(`🔍 Детект оффлайн-пачки: ${accumulationSlice.length} сообщений за ${(spanMs / 1000).toFixed(2)}с`);

        user.isAccumulatingAnswers = true;
        user.accumulatedAnswers = user.accumulatedAnswers || [];
        user.accumulationStartLevel = user.accumulationStartLevel || user.lastKnownLevel || null;
        console.log(`📦 Режим накопления активирован (уровень: ${user.accumulationStartLevel?.levelNumber || '?'})`);

        await drainAllPending(platform, userId, user);
        continue;
      }

      const oldest = user.pendingBurstAnswers[0];
      const now = Date.now();
      const elapsed = now - oldest.timestamp;

      if (elapsed >= MESSAGE_INTERVAL_MAX) {
        const entry = user.pendingBurstAnswers.shift();
        await processPendingEntry(platform, userId, entry);
        continue;
      }

      scheduleBurstTimer(platform, userId, user, MESSAGE_INTERVAL_MAX - elapsed);
      break;
    }
  } finally {
    user._burstProcessing = false;
    if (user._burstProcessingRequested) {
      user._burstProcessingRequested = false;
      await triggerBurstProcessing(platform, userId);
    }
  }
}

/**
 * Добавляет ответ в буфер для обработки.
 * Возвращается СРАЗУ, не блокируя VK Long Poll.
 * Обработка происходит асинхронно через triggerBurstProcessing.
 * @param {string} platform
 * @param {string} userId
 * @param {Object} user
 * @param {string} answer
 * @param {string|null} progressMessageId
 * @returns {{ queued: boolean, answer: string }}
 */
async function queueAnswerForProcessing(platform, userId, user, answer, progressMessageId) {
  ensureBurstBuffer(user);
  const timestamp = Date.now();

  // Добавляем entry в буфер БЕЗ блокирующего ожидания
  user.pendingBurstAnswers.push({
    answer,
    timestamp,
    progressMessageId
    // resolve больше не нужен - не ждём результат синхронно
  });

  // Запускаем обработку асинхронно (не ждём завершения)
  triggerBurstProcessing(platform, userId).catch((error) => {
    console.error('[burst] Ошибка запуска обработки:', error);
  });

  // Возвращаем сразу - не блокируем VK Long Poll
  return { queued: true, answer };
}

async function handleReadyStateInput(platform, userId, user, text, context) {
  if (text === '🔄 Рестарт бота') {
    await handleStartCommand(context);
    return;
  }

  if (text === 'Задание' || text === 'Задание (формат)') {
    const formatted = text === 'Задание (формат)';
    await sendLevelTask(platform, userId, user, formatted);
    return;
  }

  if (text === 'Сектора') {
    if (!(await checkGameAccess(platform, userId))) {
      return;
    }

    const waitMsg = await sendMessage(platform, userId, '🔄 Получаю список секторов...');
    try {
      // Используем централизованную авторизацию с мьютексом
      const authCallback = await createAuthCallback(user, EncounterAPI, saveUserData);
      const api = new EncounterAPI(user.domain, authCallback);

      // Предварительная авторизация если нет cookies
      await ensureAuthenticated(user, EncounterAPI, saveUserData);

      let gameState;
      try {
        gameState = await api.getGameState(user.gameId, user.authCookies, user.login, user.password);
      } catch (e) {
        const msg = String(e.message || '').toLowerCase();
        if (msg.includes('требуется авторизация') || msg.includes('сессия истекла')) {
          const reauth = await api.authenticate(user.login, user.password);
          if (!reauth.success) {
            throw new Error(reauth.message || 'Не удалось авторизоваться');
          }
          user.authCookies = reauth.cookies;
          await saveUserData();
          gameState = await api.getGameState(user.gameId, user.authCookies);
        } else {
          throw e;
        }
      }

      if (!gameState || !gameState.success) {
        throw new Error('Не удалось получить состояние игры');
      }

      let model = gameState.data;
      if (model.Event !== 0) {
        if (model.Event === 16) {
          gameState = await api.getGameState(user.gameId, user.authCookies);
          if (!gameState.success || gameState.data.Event !== 0) {
            await sendOrUpdateMessage(platform, userId, '⚠️ Игра неактивна или недоступна сейчас.', waitMsg?.message_id);
            return;
          }
          model = gameState.data;
        } else {
          await sendOrUpdateMessage(platform, userId, '⚠️ Игра неактивна или недоступна сейчас.', waitMsg?.message_id);
          return;
        }
      }

      const level = model.Level;
      if (!level) {
        await sendOrUpdateMessage(platform, userId, '⚠️ Активный уровень не найден.', waitMsg?.message_id);
        return;
      }

      const sectors = Array.isArray(level.Sectors) ? level.Sectors : [];
      const totalRequired = Number(level.RequiredSectorsCount) || 0;
      const passedCount = Number(level.PassedSectorsCount) || 0;
      const leftToClose = Math.max(totalRequired - passedCount, 0);

      const sectorsMessage = buildSectorsMessage(platform, {
        sectors,
        totalRequired,
        totalCount: sectors.length,
        passedCount,
        leftToClose
      });

      if (waitMsg?.message_id) {
        if (sectorsMessage.text.length <= 4000) {
          await editMessage(platform, userId, waitMsg.message_id, sectorsMessage.text, sectorsMessage.options);
        } else {
          await editMessage(platform, userId, waitMsg.message_id, sectorsMessage.header, sectorsMessage.options);
          for (const chunk of splitMessageBody(sectorsMessage.body, 4000)) {
            await sendMessage(platform, userId, chunk, sectorsMessage.options);
          }
        }
      } else {
        await sendMessage(platform, userId, sectorsMessage.text, sectorsMessage.options);
      }
    } catch (error) {
      await sendOrUpdateMessage(platform, userId, `❌ Не удалось получить сектора: ${error.message}`, waitMsg?.message_id);
    }
    return;
  }

  if (text === '📊 Статус очереди') {
    const queueLength = user.answerQueue.length;
    const status = user.isOnline ? '🟢 Онлайн' : '🔴 Оффлайн';
    const queueText = queueLength > 0
      ? 'Очередь:\n' + user.answerQueue.map((item, index) =>
          `${index + 1}. "${item.answer}" (${new Date(item.timestamp).toLocaleTimeString()})`
        ).join('\n')
      : 'Очередь пуста';

    await sendMessage(platform, userId,
      `Статус: ${status}\n` +
      `Ответов в очереди: ${queueLength}\n\n` +
      queueText
    );
    return;
  }

  if (text === '🔗 Сменить игру') {
    if (!(await checkGameAccess(platform, userId))) {
      return;
    }

    resetUserRuntimeState(user);
    user.authCookies = null;
    await saveUserData();
    setUserState(platform, userId, STATES.WAITING_FOR_GAME_URL);
    await sendMessage(platform, userId,
      'Пришлите новую ссылку на игру:\n\n' +
      '• https://domain.en.cx/GameDetails.aspx?gid=XXXXX\n' +
      '• https://domain.en.cx/gameengines/encounter/play/XXXXX/'
    );
    return;
  }

  if (text === '👤 Сменить авторизацию') {
    resetUserRuntimeState(user);
    user.authCookies = null;
    await saveUserData();
    setUserState(platform, userId, STATES.WAITING_FOR_LOGIN);
    await sendMessage(platform, userId, 'Введите новый логин:');
    return;
  }

  if (!(await checkGameAccess(platform, userId))) {
    return;
  }

  const progressMessage = await sendMessage(platform, userId, `⏳ Отправляю ответ "${text}"...`);
  const progressMessageId = progressMessage?.message_id ?? progressMessage?.conversation_message_id ?? null;

  // Не блокируем - queueAnswerForProcessing возвращается сразу
  await queueAnswerForProcessing(platform, userId, user, text, progressMessageId);

  // Запуск processAnswerQueue независимо от результата queueAnswerForProcessing
  if (user.answerQueue.length > 0) {
    setTimeout(() => processAnswerQueue(platform, userId), 1200);
  }
}

async function sendLevelTask(platform, userId, user, formatted) {
  if (!(await checkGameAccess(platform, userId))) {
    return;
  }

  const waitText = formatted
    ? '🔄 Получаю форматированное задание текущего уровня...'
    : '🔄 Получаю задание текущего уровня...';

  const waitMsg = await sendMessage(platform, userId, waitText);

  try {
    // Используем централизованную авторизацию с мьютексом
    const authCallback = await createAuthCallback(user, EncounterAPI, saveUserData);
    const api = new EncounterAPI(user.domain, authCallback);

    // Предварительная авторизация если нет cookies
    await ensureAuthenticated(user, EncounterAPI, saveUserData);

    let gameState;
    try {
      gameState = await api.getGameState(user.gameId, user.authCookies, user.login, user.password);
    } catch (error) {
      const msg = String(error.message || '').toLowerCase();
      if (msg.includes('требуется авторизация') || msg.includes('сессия истекла')) {
        const reauth = await api.authenticate(user.login, user.password);
        if (!reauth.success) {
          throw new Error(reauth.message || 'Не удалось авторизоваться');
        }
        user.authCookies = reauth.cookies;
        await saveUserData();
        gameState = await api.getGameState(user.gameId, user.authCookies);
      } else {
        throw error;
      }
    }

    if (!gameState || !gameState.success) {
      throw new Error('Не удалось получить состояние игры');
    }

    let model = gameState.data;
    if (model.Event !== 0) {
      if (model.Event === 16) {
        gameState = await api.getGameState(user.gameId, user.authCookies);
        if (!gameState.success || gameState.data.Event !== 0) {
          await sendOrUpdateMessage(platform, userId, '⚠️ Игра неактивна или недоступна сейчас.', waitMsg?.message_id);
          return;
        }
        model = gameState.data;
      } else {
        await sendOrUpdateMessage(platform, userId, '⚠️ Игра неактивна или недоступна сейчас.', waitMsg?.message_id);
        return;
      }
    }

    const level = model.Level;
    if (!level) {
      await sendOrUpdateMessage(platform, userId, '⚠️ Активный уровень не найден.', waitMsg?.message_id);
      return;
    }

    const taskFragments = collectTaskFragments(level.Tasks, { formatted });
    const helps = collectHelps(level.Helps, { formatted });
    const timeoutRemain = formatRemain(level.TimeoutSecondsRemain);

    const taskMessage = buildTaskMessage(platform, {
      level,
      taskFragments,
      helps,
      timeoutRemain,
      formatted
    });

    if (waitMsg?.message_id) {
      const editOptions = { ...taskMessage.options };
      if (waitMsg?.conversation_message_id != null) {
        editOptions.conversationMessageId = waitMsg.conversation_message_id;
      }

      if (taskMessage.text.length <= 4000) {
        await editMessage(platform, userId, waitMsg.message_id, taskMessage.text, editOptions);
      } else {
        await editMessage(platform, userId, waitMsg.message_id, taskMessage.header, editOptions);
        for (const chunk of splitMessageBody(taskMessage.body, 4000)) {
          await sendMessage(platform, userId, chunk, taskMessage.options);
        }
      }
    } else {
      await sendMessage(platform, userId, taskMessage.text, taskMessage.options);
    }
  } catch (error) {
    const errorPrefix = formatted
      ? '❌ Не удалось получить форматированное задание'
      : '❌ Не удалось получить задание';
    await sendOrUpdateMessage(platform, userId, `${errorPrefix}: ${error.message}`, waitMsg?.message_id);
  }
}

// Админ-конфигурация
let adminConfig = {
  moderationEnabled: false,
  whitelist: []
};

// Кеш whitelist для быстрой проверки
let whitelistCache = new Set();

// Файл для хранения настроек админа
const ADMIN_CONFIG_FILE = 'admin_config.json';

// ID root пользователя (админа)
const ROOT_USER_ID = 197924096;

// Состояния бота
const STATES = {
  WAITING_FOR_LOGIN: 'waiting_for_login',
  WAITING_FOR_PASSWORD: 'waiting_for_password',
  WAITING_FOR_GAME_URL: 'waiting_for_game_url',
  READY: 'ready',
  WAITING_FOR_ANSWER: 'waiting_for_answer'
};

// Загрузка данных пользователей при запуске
// Загрузка админ-конфигурации
async function loadAdminConfig() {
  try {
    if (await fs.pathExists(ADMIN_CONFIG_FILE)) {
      adminConfig = await fs.readJson(ADMIN_CONFIG_FILE);

      // Миграция старого формата whitelist
      let migrationCount = 0;
      if (adminConfig.whitelist && Array.isArray(adminConfig.whitelist)) {
        adminConfig.whitelist = adminConfig.whitelist.map(item => {
          // Если уже новый формат - оставляем как есть
          if (item.login) {
            return item;
          }
          // Если старый формат с type === 'encounter'
          if (item.type === 'encounter' && item.value) {
            migrationCount++;
            return {
              login: item.value,
              addedBy: item.addedBy,
              addedAt: item.addedAt
            };
          }
          // Если старый формат с type === 'telegram' - игнорируем
          if (item.type === 'telegram') {
            migrationCount++;
            return null;
          }
          return item;
        }).filter(Boolean); // Удаляем null значения

        if (migrationCount > 0) {
          console.log(`Выполнена миграция whitelist: обработано ${migrationCount} записей`);
          await saveAdminConfig();
        }
      }

      rebuildWhitelistCache();
      console.log('Админ-конфигурация загружена');
    } else {
      // Создаем файл с начальными настройками
      await saveAdminConfig();
      console.log('Создан файл админ-конфигурации');
    }
  } catch (error) {
    console.error('Ошибка загрузки админ-конфигурации:', error);
  }
}

// Сохранение админ-конфигурации
async function saveAdminConfig() {
  try {
    await fs.writeJson(ADMIN_CONFIG_FILE, adminConfig, { spaces: 2 });
    rebuildWhitelistCache();
  } catch (error) {
    console.error('Ошибка сохранения админ-конфигурации:', error);
  }
}

// Пересборка кеша whitelist
function rebuildWhitelistCache() {
  whitelistCache.clear();
  if (adminConfig.whitelist && Array.isArray(adminConfig.whitelist)) {
    adminConfig.whitelist.forEach(entry => {
      // Новый формат: entry.login или старый формат: entry.type + entry.value
      const login = entry.login || (entry.type === 'encounter' ? entry.value : null);
      if (login) {
        whitelistCache.add(login.toLowerCase());
      }
    });
  }
  console.log(`Whitelist cache обновлен: ${whitelistCache.size} записей`);
}

// Создание клавиатуры для главного меню
const MAIN_MENU_LAYOUT = [
  ['Задание', 'Задание (формат)'],
  ['Сектора'],
  ['🔗 Сменить игру', '👤 Сменить авторизацию'],
  ['🔄 Рестарт бота']
];

function createMainKeyboard(platform) {
  if (platform === TELEGRAM_PLATFORM) {
    return {
      reply_markup: {
        keyboard: MAIN_MENU_LAYOUT.map(row => [...row]),
        resize_keyboard: true,
        one_time_keyboard: false
      }
    };
  }

  if (platform === VK_PLATFORM) {
    const buttons = MAIN_MENU_LAYOUT.map(row =>
      row.map(label => ({
        action: {
          type: 'text',
          label,
          payload: JSON.stringify({ type: 'main_menu', value: label })
        },
        color: 'secondary'
      }))
    );

    return {
      keyboard: {
        type: 'reply',
        buttons,
        oneTime: false
      }
    };
  }

  return {};
}

function buildSectorsMessage(platform, { sectors, totalRequired, totalCount, passedCount, leftToClose }) {
  const isTelegram = platform === TELEGRAM_PLATFORM;
  const options = isTelegram
    ? { parse_mode: 'HTML', disable_web_page_preview: true }
    : {};

  if (!Array.isArray(sectors) || sectors.length === 0) {
    const header = isTelegram ? '<b>🗄 Секторы</b>' : '🗄 Секторы';
    const text = `${header}\n\nНет данных о секторах.`;
    return {
      text,
      header,
      body: '',
      options
    };
  }

  const lines = sectors.map(s => {
    const order = s?.Order ?? '';
    const nameRaw = s?.Name ?? '';
    const name = isTelegram ? escapeHtml(nameRaw) : nameRaw;
    const isAnswered = s?.IsAnswered === true;
    const answerTextRaw = s?.Answer;
    const answerText = extractSectorAnswerText(answerTextRaw);

    if (isTelegram) {
      const safeAnswer = answerText ? `<code>${escapeHtml(answerText)}</code>` : '<code>—</code>';
      const condition = isAnswered ? `${safeAnswer} ✅` : '<i>...</i>';
      return `#${order} (${name}) — ${condition}`;
    }

    const safeAnswer = answerText ? `«${answerText}»` : '—';
    const condition = isAnswered ? `${safeAnswer} ✅` : '…';
    return `#${order} (${name}) — ${condition}`;
  });

  const header = isTelegram
    ? `<b>🗄 Секторы (обязательных ${totalRequired} из ${totalCount})</b>`
    : `🗄 Секторы (обязательных ${totalRequired} из ${totalCount})`;

  const summary = isTelegram
    ? `Закрыто — <b>${passedCount}</b>, осталось — <b>${leftToClose}</b>`
    : `Закрыто — ${passedCount}, осталось — ${leftToClose}`;

  const body = lines.join('\n');
  const text = `${header}\n\n${summary}\n\n${body}`;

  return {
    text,
    header,
    body,
    options
  };
}

function collectTaskFragments(tasks, { formatted = false } = {}) {
  const fragments = [];
  const field = formatted ? 'TaskTextFormatted' : 'TaskText';

  const addFragment = (rawValue) => {
    if (rawValue == null) {
      return;
    }
    const raw = String(rawValue);
    const presenceCheck = stripHtml(raw).trim();
    if (presenceCheck.length === 0) {
      return;
    }
    fragments.push(formatted ? raw : raw.trim());
  };

  if (Array.isArray(tasks)) {
    for (const task of tasks) {
      const rawValue = task?.[field] ?? task?.TaskText;
      addFragment(rawValue);
    }
  } else if (tasks && typeof tasks === 'object') {
    const rawValue = tasks[field] ?? tasks.TaskText;
    addFragment(rawValue);
  }

  return fragments;
}

function collectHelps(helps, { formatted = false } = {}) {
  const result = [];
  if (!Array.isArray(helps)) {
    return result;
  }

  const field = formatted ? 'HelpTextFormatted' : 'HelpText';

  for (const help of helps) {
    const rawValue = help?.[field] ?? help?.HelpText ?? '';
    const raw = String(rawValue);
    const trimmed = stripHtml(raw).trim();
    const remainSeconds = help?.RemainSeconds ?? null;

    if (trimmed.length === 0 && (remainSeconds == null || remainSeconds <= 0)) {
      // Если текста нет и подсказка не ожидается, пропускаем
      continue;
    }

    result.push({
      number: help?.Number ?? '',
      text: formatted ? raw : raw.trim(),
      remainSeconds
    });
  }

  return result;
}

function buildTaskMessage(platform, { level, taskFragments, helps, timeoutRemain, formatted = false }) {
  const isTelegram = platform === TELEGRAM_PLATFORM;
  const normalizedHelps = Array.isArray(helps) ? helps : [];
  const options = isTelegram
    ? { parse_mode: 'HTML', disable_web_page_preview: true }
    : {};

  const levelNumber = level?.Number ?? '';
  const levelNameRaw = String(level?.Name || '').trim();
  const levelName = isTelegram ? escapeHtml(levelNameRaw) : levelNameRaw;
  const header = isTelegram
    ? `<b>📜 Задание уровня №${levelNumber}${levelName ? ` — ${levelName}` : ''}</b>`
    : `📜 Задание уровня №${levelNumber}${levelName ? ` — ${levelName}` : ''}`;

  const timeoutLine = timeoutRemain
    ? (isTelegram
      ? `<i>До автоперехода осталось: ${escapeHtml(timeoutRemain)}</i>`
      : `До автоперехода осталось: ${timeoutRemain}`)
    : '';

  const renderTaskFragment = (text) => {
    if (formatted) {
      if (isTelegram) {
        return sanitizeHtmlForTelegram(text);
      }
      return stripHtml(text);
    }
    return isTelegram ? escapeHtml(text) : text;
  };

  let bodyMain;
  if (taskFragments.length > 0) {
    if (!formatted && isTelegram) {
      bodyMain = taskFragments
        .map(fragment => `<blockquote>${renderTaskFragment(fragment)}</blockquote>`)
        .join('\n\n');
    } else {
      const rendered = taskFragments.map(fragment => renderTaskFragment(fragment));
      bodyMain = rendered.join('\n\n');
    }
  } else {
    bodyMain = formatted
      ? (isTelegram ? '<i>Текст задания недоступен.</i>' : 'Текст задания недоступен.')
      : (isTelegram ? '<blockquote>Текст задания недоступен.</blockquote>' : 'Текст задания недоступен.');
  }

  const helpsSections = [];
  for (const help of normalizedHelps) {
    const number = help.number;
    const label = number ? `💡 Подсказка ${number}` : '💡 Подсказка';
    const remainStr = formatRemain(help.remainSeconds);
    const helpContent = formatted
      ? (isTelegram ? sanitizeHtmlForTelegram(help.text) : stripHtml(help.text))
      : (isTelegram ? escapeHtml(help.text) : help.text);

    if (isTelegram) {
      if (formatted) {
        const remainLine = remainStr ? `\n<i>До подсказки осталось: ${escapeHtml(remainStr)}</i>` : '';
        helpsSections.push(
          `<b>${label}</b>\n${helpContent}${remainLine}`
        );
      } else {
        const remainLine = remainStr ? `\n<i>До подсказки осталось: ${escapeHtml(remainStr)}</i>` : '';
        helpsSections.push(
          `<b>${label}</b>\n<blockquote>${helpContent}</blockquote>${remainLine}`
        );
      }
    } else {
      let section = `${label}\n${helpContent}`;
      if (remainStr) {
        section += `\nДо подсказки осталось: ${remainStr}`;
      }
      helpsSections.push(section);
    }
  }

  const helpsBlock = helpsSections.length > 0
    ? helpsSections.join('\n\n')
    : '';

  const sections = [header];
  if (timeoutLine) {
    sections.push(timeoutLine);
  }
  if (bodyMain) {
    sections.push(bodyMain);
  }
  if (helpsBlock) {
    sections.push(helpsBlock);
  }

  const text = sections.join('\n\n');
  const body = sections.slice(1).join('\n\n');

  return {
    text,
    header,
    body,
    options
  };
}

function splitMessageBody(text, maxLength) {
  if (!text) {
    return [];
  }

  const segments = String(text).split('\n\n');
  const chunks = [];
  let current = '';

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = '';
    }
  };

  const wrapMatch = segment => {
    const m = segment.match(/^(<blockquote(?:\s[^>]*)?>)([\s\S]*)(<\/blockquote>)$/i);
    if (m) {
      return { open: m[1], inner: m[2], close: m[3] };
    }
    return null;
  };

  const pushHardSplit = (segment) => {
    const wrap = wrapMatch(segment);
    const open = wrap ? wrap.open : '';
    const close = wrap ? wrap.close : '';
    const overhead = open.length + close.length;
    const innerLimit = Math.max(64, maxLength - overhead);
    let remaining = wrap ? wrap.inner : segment;

    while (remaining.length + overhead > maxLength) {
      const slice = remaining.slice(0, innerLimit);
      const breakAt = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
      const cut = breakAt > innerLimit * 0.5 ? breakAt : innerLimit;
      chunks.push(`${open}${remaining.slice(0, cut)}${close}`);
      remaining = remaining.slice(cut).replace(/^\s+/, '');
    }
    if (remaining.length > 0) {
      current = `${open}${remaining}${close}`;
    }
  };

  for (const segment of segments) {
    if (segment.length === 0) {
      continue;
    }

    const candidate = current.length === 0 ? segment : `${current}\n\n${segment}`;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    flush();

    if (segment.length <= maxLength) {
      current = segment;
    } else {
      pushHardSplit(segment);
    }
  }

  flush();
  return chunks;
}

function sanitizeHtmlForTelegram(html) {
  if (!html) {
    return '';
  }

  let text = String(html);

  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<p[^>]*>/gi, '');
  text = text.replace(/<\/?div[^>]*>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '\n• ');
  text = text.replace(/<\/li>/gi, '');
  text = text.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
  text = text.replace(/<blockquote[^>]*>/gi, '\n');
  text = text.replace(/<\/blockquote>/gi, '\n');
  text = text.replace(/<h([1-6])[^>]*>/gi, '\n<b>');
  text = text.replace(/<\/h[1-6]>/gi, '</b>\n');

  const replacements = [
    { from: /<strong[^>]*>/gi, to: '<b>' },
    { from: /<\/strong>/gi, to: '</b>' },
    { from: /<em[^>]*>/gi, to: '<i>' },
    { from: /<\/em>/gi, to: '</i>' },
    { from: /<ins[^>]*>/gi, to: '<u>' },
    { from: /<\/ins>/gi, to: '</u>' },
    { from: /<u[^>]*>/gi, to: '<u>' },
    { from: /<\/u>/gi, to: '</u>' },
    { from: /<(?:strike|del)[^>]*>/gi, to: '<s>' },
    { from: /<\/(?:strike|del)>/gi, to: '</s>' },
    { from: /<span[^>]*>/gi, to: '' },
    { from: /<\/span>/gi, to: '' },
    { from: /<font[^>]*>/gi, to: '' },
    { from: /<\/font>/gi, to: '' },
    { from: /<pre[^>]*>/gi, to: '\n<pre>' },
    { from: /<\/pre>/gi, to: '</pre>\n' },
    { from: /<code[^>]*>/gi, to: '<code>' },
    { from: /<\/code>/gi, to: '</code>' }
  ];
  for (const { from, to } of replacements) {
    text = text.replace(from, to);
  }

  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi, '<a href="$1">');
  text = text.replace(/<\/a>/gi, '</a>');

  const allowedTags = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a']);
  text = text.replace(/<([^>]+)>/gi, (match, inner) => {
    const content = inner.trim();
    if (!content) {
      return '';
    }

    const isClosing = content.startsWith('/');
    let tagBody = isClosing ? content.slice(1).trim() : content;
    const isSelfClosing = tagBody.endsWith('/');
    if (isSelfClosing) {
      tagBody = tagBody.slice(0, -1).trim();
    }
    const tagNameMatch = tagBody.match(/^([a-z0-9]+)/i);
    if (!tagNameMatch) {
      return '';
    }
    const tagName = tagNameMatch[1].toLowerCase();

    if (tagName === 'br') {
      return '\n';
    }

    if (!allowedTags.has(tagName)) {
      return '';
    }

    if (isClosing) {
      return `</${tagName}>`;
    }

    if (tagName === 'a') {
      const hrefMatch = tagBody.match(/href\s*=\s*['"]([^'"]+)['"]/i);
      const href = hrefMatch ? hrefMatch[1] : null;
      if (!href) {
        return '';
      }
      return `<a href="${href}">`;
    }

    return `<${tagName}>`;
  });

  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'').replace(/&apos;/gi, '\'')
    .replace(/&ndash;/gi, '-')
    .replace(/&mdash;/gi, '-')
    .replace(/&hellip;/gi, '...')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');

  text = text.replace(/\t+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

function stripHtml(input) {
  if (!input) {
    return '';
  }

  let text = String(input);

  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<p[^>]*>/gi, '');
  text = text.replace(/<li[^>]*>/gi, '\n• ');
  text = text.replace(/<\/li>/gi, '');
  text = text.replace(/<\/?ul[^>]*>/gi, '\n');
  text = text.replace(/<\/?ol[^>]*>/gi, '\n');
  text = text.replace(/<\/?blockquote[^>]*>/gi, '\n');
  text = text.replace(/<\/?strong[^>]*>/gi, '');
  text = text.replace(/<\/?em[^>]*>/gi, '');
  text = text.replace(/<\/?span[^>]*>/gi, '');
  text = text.replace(/<\/?div[^>]*>/gi, '\n');
  text = text.replace(/<\/?h\d[^>]*>/gi, '\n');
  text = text.replace(/<\/?table[^>]*>/gi, '\n');
  text = text.replace(/<\/?tr[^>]*>/gi, '\n');
  text = text.replace(/<\/?td[^>]*>/gi, '\t');
  text = text.replace(/<\/?th[^>]*>/gi, '\t');
  text = text.replace(/<[^>]+>/g, '');

  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'').replace(/&apos;/gi, '\'')
    .replace(/&ndash;/gi, '-')
    .replace(/&mdash;/gi, '-')
    .replace(/&hellip;/gi, '...')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');

  text = text.replace(/\t+/g, ' ');
  text = text.replace(/\r/g, '');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

// Удалён форматтер HTML, показ оригинального текста задания TaskText
function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Форматирование секунд в д/ч/м/с без нулевых единиц
function formatRemain(seconds) {
  const total = Number(seconds) || 0;
  if (total <= 0) return '';
  let s = Math.floor(total);
  const days = Math.floor(s / 86400); s %= 86400;
  const hours = Math.floor(s / 3600); s %= 3600;
  const minutes = Math.floor(s / 60); s %= 60;
  const parts = [];
  if (days > 0) parts.push(`${days}д`);
  if (hours > 0) parts.push(`${hours}ч`);
  if (minutes > 0) parts.push(`${minutes}м`);
  if (s > 0) parts.push(`${s}с`);
  return parts.join(' ');
}

// Попытка извлечь человекочитаемый текст ответа сектора из разных возможных структур
function extractSectorAnswerText(rawAnswer) {
  if (rawAnswer == null) return '';
  if (typeof rawAnswer === 'string') return rawAnswer.trim();
  if (typeof rawAnswer === 'number' || typeof rawAnswer === 'boolean') return String(rawAnswer);
  if (Array.isArray(rawAnswer)) {
    const parts = rawAnswer
      .map(item => extractSectorAnswerText(item))
      .filter(v => v && v.trim().length > 0);
    return parts.join(', ');
  }
  // Объект: пробуем типичные поля
  const candidates = [
    rawAnswer.Value,
    rawAnswer.Text,
    rawAnswer.Answer,
    rawAnswer.Display,
    rawAnswer.StringValue,
    rawAnswer.Name,
    rawAnswer.Title,
    rawAnswer.Content
  ].filter(v => v != null);
  if (candidates.length > 0) {
    const first = candidates.find(v => typeof v === 'string') ?? candidates[0];
    return extractSectorAnswerText(first);
  }
  // Последняя попытка: сериализуем простые плоские значения
  try {
    const flat = Object.values(rawAnswer)
      .map(v => (typeof v === 'string' || typeof v === 'number' ? String(v) : ''))
      .filter(Boolean)
      .join(' ')
      .trim();
    return flat;
  } catch (_) {
    return '';
  }
}

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
  await sendMessage(platform, userId, '🚫 Доступ к боту не разрешен. Свяжитесь с @seo2z');
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
          console.log(`⏳ Throttle: откладываю обновление сообщения (прошло ${elapsed}ms < 2000ms)`);

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
              await editPlatformMessage(platform, userId, messageId, throttle.pendingText, throttle.pendingOptions || {});
              throttle.lastUpdate = Date.now();
              throttle.pendingText = null;
              throttle.pendingOptions = null;
              throttle.timeout = null;
              console.log('✅ Отложенное обновление сообщения выполнено');
              scheduleThrottleCleanup(throttleKey, throttle);
            } catch (err) {
              if (err.code === 'ETELEGRAM' && err.response?.body?.description?.includes('message is not modified')) {
                console.log('⏭️ Отложенное обновление: сообщение не изменилось');
              } else if (err.response?.statusCode === 429) {
                console.log('⚠️ Rate limit при отложенном обновлении, пропускаем');
              } else {
                console.error('❌ Ошибка отложенного обновления:', err.message);
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
    if (error.code === 'ETELEGRAM' && error.response?.body?.description?.includes('message is not modified')) {
      console.log('⏭️ Сообщение не изменилось, пропускаем обновление');
      return messageId;
    }

    if (error.response?.statusCode === 429) {
      console.log('⚠️ Rate limit (429), пропускаем обновление сообщения');
      return messageId;
    }

    if (messageId && /не поддерживает editMessage/i.test(error.message || '')) {
      console.log(`[${platform}] Транспорт не поддерживает обновление сообщений, отправляю новое`);
      return await sendPlatformMessage(platform, userId, text, options);
    }

    if (messageId && error.response?.status === 400) {
      console.log('📤 Отправляем новое сообщение вместо обновления');
      return await sendPlatformMessage(platform, userId, text, options);
    }

    throw error;
  }
}

// Отправка ответа в игру Encounter
// Функция для парсинга ссылки на игру
function parseGameUrl(url) {
  try {
    // Проверяем правильность ссылки и извлекаем домен и ID игры
    const urlObj = new URL(url);
    const domain = `${urlObj.protocol}//${urlObj.hostname}`;
    
    // Тип 1: https://tech.en.cx/GameDetails.aspx?gid=80646
    if (urlObj.pathname.includes('/GameDetails.aspx') && urlObj.searchParams.has('gid')) {
      const gameId = urlObj.searchParams.get('gid');
      return {
        success: true,
        domain: domain,
        gameId: gameId,
        type: 'GameDetails'
      };
    }
    
    // Тип 2: https://tech.en.cx/gameengines/encounter/play/80646/
    const playMatch = urlObj.pathname.match(/\/gameengines\/encounter\/play\/(\d+)\/?$/);
    if (playMatch) {
      return {
        success: true,
        domain: domain,
        gameId: playMatch[1],
        type: 'Play'
      };
    }
    
    return {
      success: false,
      message: 'Неправильная ссылка на игру. Поддерживаются только:\n• https://domain.en.cx/GameDetails.aspx?gid=XXXXX\n• https://domain.en.cx/gameengines/encounter/play/XXXXX/'
    };
    
  } catch (error) {
    return {
      success: false,
      message: 'Неправильный формат ссылки. Пример: https://tech.en.cx/GameDetails.aspx?gid=80646'
    };
  }
}

// Проверка авторизации
async function checkAuthentication(login, password, domain = 'https://world.en.cx') {
  try {
    const api = new EncounterAPI(domain);
    const result = await api.authenticate(login, password);
    return result; // Возвращаем полный результат, а не только success
  } catch (error) {
    console.error('Ошибка проверки авторизации:', error.message);
    // Если нет домена, принимаем базовую проверку
    return {
      success: login.length > 0 && password.length > 0,
      message: login.length > 0 && password.length > 0 ? 'Базовая проверка пройдена' : 'Логин или пароль не могут быть пустыми'
    };
  }
}

/**
 * Показать список пользователей с пагинацией
 */
async function showUsersList(chatId, messageId, page = 0) {
  const USERS_PER_PAGE = 10;
  const users = Array.from(userData.entries());
  const totalPages = Math.ceil(users.length / USERS_PER_PAGE);
  const start = page * USERS_PER_PAGE;
  const end = start + USERS_PER_PAGE;
  const pageUsers = users.slice(start, end);

  if (users.length === 0) {
    const message = '👥 <b>Пользователи</b>\n\nПользователей пока нет';
    const keyboard = {
      inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'admin_back' }]]
    };

    await editTelegramMessage(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
    return;
  }

  let message = `👥 <b>Пользователи</b> (страница ${page + 1}/${totalPages})\n\n`;

  for (const [storageKey, user] of pageUsers) {
    const [keyPlatform, ...restKey] = storageKey.split('::');
    const platform = user.platform || keyPlatform || TELEGRAM_PLATFORM;
    const plainUserId = user.userId || (restKey.length > 0 ? restKey.join('::') : storageKey);
    const username = user.telegramUsername ? `@${user.telegramUsername}` : user.telegramFirstName || 'Без имени';
    const login = user.login || '—';
    const firstActivity = user.firstActivity ? new Date(user.firstActivity).toLocaleDateString('ru-RU') : '—';
    const lastActivity = user.lastActivity ? new Date(user.lastActivity).toLocaleString('ru-RU') : '—';

    message += `<b>${username}</b>\n`;
    message += `ID: <code>${plainUserId}</code>\n`;
    message += `Платформа: ${platform}\n`;
    message += `Логин EN: <code>${login}</code>\n`;
    message += `Первый вход: ${firstActivity}\n`;
    message += `Последний: ${lastActivity}\n\n`;
  }

  // Кнопки навигации
  const keyboard = { inline_keyboard: [] };
  const navButtons = [];

  if (page > 0) {
    navButtons.push({ text: '◀️ Назад', callback_data: `admin_users_${page - 1}` });
  }
  if (page < totalPages - 1) {
    navButtons.push({ text: 'Вперед ▶️', callback_data: `admin_users_${page + 1}` });
  }

  if (navButtons.length > 0) {
    keyboard.inline_keyboard.push(navButtons);
  }

  keyboard.inline_keyboard.push([{ text: '🏠 Главное меню', callback_data: 'admin_back' }]);

  await editTelegramMessage(message, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

/**
 * Показать меню управления модерацией
 */
async function showModerationMenu(chatId, messageId) {
  const status = adminConfig.moderationEnabled ? 'включена ✅' : 'выключена ❌';
  const buttonText = adminConfig.moderationEnabled ? '❌ Выключить' : '✅ Включить';

  const message = `🔐 <b>Управление модерацией</b>\n\n` +
    `Текущий статус: ${status}\n\n` +
    `Когда модерация включена, доступ к боту имеют только пользователи из белого списка.`;

  const keyboard = {
    inline_keyboard: [
      [{ text: buttonText, callback_data: 'moderation_toggle' }],
      [{ text: '◀️ Назад', callback_data: 'admin_back' }]
    ]
  };

  await editTelegramMessage(message, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

/**
 * Показать меню управления белым списком
 */
async function showWhitelistMenu(chatId, messageId, page = 0) {
  const ITEMS_PER_PAGE = 10;
  const whitelist = adminConfig.whitelist || [];
  const totalPages = Math.ceil(whitelist.length / ITEMS_PER_PAGE);
  const start = page * ITEMS_PER_PAGE;
  const end = start + ITEMS_PER_PAGE;
  const pageItems = whitelist.slice(start, end);

  let message = `📋 <b>Белый список</b>\n\n`;

  if (whitelist.length === 0) {
    message += 'Белый список пуст\n\n';
    message += 'Нажмите "Добавить", чтобы добавить пользователя';
  } else {
    message += `Страница ${page + 1}/${totalPages}\n\n`;

    for (let i = 0; i < pageItems.length; i++) {
      const item = pageItems[i];
      const globalIndex = start + i;
      // Получаем логин из нового или старого формата
      const login = item.login || (item.type === 'encounter' ? item.value : item.value);
      message += `${globalIndex + 1}. 🎮 <code>${login}</code>\n`;
    }
  }

  // Кнопки
  const keyboard = { inline_keyboard: [] };

  // Кнопки удаления (только первые 5 на странице для экономии места)
  const removeButtons = [];
  for (let i = 0; i < Math.min(pageItems.length, 5); i++) {
    const globalIndex = start + i;
    removeButtons.push({
      text: `🗑️ ${globalIndex + 1}`,
      callback_data: `whitelist_remove_${globalIndex}`
    });
  }

  if (removeButtons.length > 0) {
    // Разбиваем по 3 кнопки в ряд
    for (let i = 0; i < removeButtons.length; i += 3) {
      keyboard.inline_keyboard.push(removeButtons.slice(i, i + 3));
    }
  }

  // Навигация
  const navButtons = [];
  if (page > 0) {
    navButtons.push({ text: '◀️', callback_data: `admin_whitelist_${page - 1}` });
  }
  navButtons.push({ text: '➕ Добавить', callback_data: 'whitelist_add' });
  if (page < totalPages - 1) {
    navButtons.push({ text: '▶️', callback_data: `admin_whitelist_${page + 1}` });
  }

  keyboard.inline_keyboard.push(navButtons);
  keyboard.inline_keyboard.push([{ text: '◀️ Назад', callback_data: 'admin_back' }]);

  await editTelegramMessage(message, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

/**
 * Обработка добавления в whitelist
 */
async function handleWhitelistAdd(chatId, messageId) {
  const message = `➕ <b>Добавление в белый список</b>\n\n` +
    `Отправьте Encounter логин пользователя:\n\n` +
    `Пример: <code>player123</code>`;

  const keyboard = {
    inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_whitelist_0' }]]
  };

  await editTelegramMessage(message, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });

  // Устанавливаем состояние ожидания ввода
  setUserState(TELEGRAM_PLATFORM, String(chatId), 'WAITING_FOR_WHITELIST_ENTRY');
}

/**
 * Обработка удаления из whitelist
 */
async function showAdminMainMenu(chatId) {
  const usersCount = userData.size;
  const moderationStatus = adminConfig.moderationEnabled ? 'включена ✅' : 'выключена ❌';
  const whitelistCount = adminConfig.whitelist ? adminConfig.whitelist.length : 0;

  const message = `👑 <b>Админ-панель</b>\n\n` +
    `👥 Пользователей: ${usersCount}\n` +
    `🔐 Модерация: ${moderationStatus}\n` +
    `📋 Белый список: ${whitelistCount} записей`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '👥 Пользователи', callback_data: 'admin_users_0' }],
      [{ text: '🔐 Модерация', callback_data: 'admin_moderation' }],
      [{ text: '📋 Белый список', callback_data: 'admin_whitelist_0' }]
    ]
  };

  try {
    await sendMessage(TELEGRAM_PLATFORM, chatId, message, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  } catch (error) {
    console.error('Ошибка отправки админ-меню:', error);
    await sendMessage(TELEGRAM_PLATFORM, chatId, '❌ Ошибка отображения админ-панели');
  }
}

async function handleWhitelistRemove(chatId, messageId, index, queryId = null) {
  if (!adminConfig.whitelist || index < 0 || index >= adminConfig.whitelist.length) {
    if (queryId) {
      await answerTelegramCallback(queryId, {
        text: '❌ Ошибка: запись не найдена',
        show_alert: true
      });
    }
    return;
  }

  // Удаляем запись
  adminConfig.whitelist.splice(index, 1);
  await saveAdminConfig();

  // Обновляем меню
  await showWhitelistMenu(chatId, messageId, 0);
}

let handlersRegistered = false;
function registerTelegramHandlers() {
  if (handlersRegistered) {
    return;
  }
  if (!bot) {
    throw new Error('Telegram бот не инициализирован для регистрации обработчиков');
  }
  handlersRegistered = true;

  const commandList = ['reset', 'test', 'admin', 'cancel', 'start'];

  commandList.forEach((command) => {
    const regex = new RegExp(`\\/${command}(?:\\s+(.*))?$`, 'i');
    bot.onText(regex, async (msg, match) => {
      // Игнорируем групповые чаты
      if (msg.chat?.type !== 'private') {
        bot.sendMessage(msg.chat.id, 'Бот работает только в личных сообщениях.');
        return;
      }

      const args = match && match[1] ? match[1].trim() : '';
      const context = createTelegramContext(msg, {
        commandName: command,
        args
      });

      try {
        await handleCommand(context);
      } catch (error) {
        console.error(`[telegram] Ошибка обработки команды /${command}:`, error);
      }
    });
  });

  bot.on('callback_query', async (query) => {
    // Игнорируем callback из групповых чатов
    if (query.message?.chat?.type !== 'private') {
      bot.answerCallbackQuery(query.id);
      return;
    }

    const context = createTelegramCallbackContext(query);
    try {
      await handleCallback(context);
    } catch (error) {
      console.error('[telegram] Ошибка обработчика callback_query:', error);
    }
  });

  bot.on('message', async (msg) => {
    // Игнорируем групповые чаты (ответ на команды отправляется в onText)
    if (msg.chat?.type !== 'private') {
      return;
    }

    const context = createTelegramContext(msg);
    try {
      await handleTextMessage(context);
    } catch (error) {
      console.error('[telegram] Ошибка обработки сообщения:', error);
    }
  });
}

// Обработка ошибок
// Запуск бота
async function startBot() {
  await loadUserData();

  let clearedVkBuffers = 0;
  let clearedVkAnswers = 0;

  for (const user of userData.values()) {
    const isVkUser = user.platform === VK_PLATFORM;
    const hasStaleAccumulation = user.isAccumulatingAnswers === true &&
      (user.accumulationTimer == null) &&
      Array.isArray(user.accumulatedAnswers) &&
      user.accumulatedAnswers.length > 0;

    if (isVkUser && hasStaleAccumulation) {
      const removed = user.accumulatedAnswers.length;
      user.accumulatedAnswers = [];
      user.isAccumulatingAnswers = false;
      user.accumulationStartLevel = null;
      user.accumulationTimer = null;
      user.recentMessageTimestamps = [];

      clearedVkBuffers += 1;
      clearedVkAnswers += removed;

      console.log(`[vk] Очистка устаревшего буфера накопления для ${user.userId}: удалено ${removed} код(ов)`);
    }
  }

  if (clearedVkBuffers > 0) {
    await saveUserData();
    console.log(`🧹 Сброшено ${clearedVkBuffers} VK-буфер(ов) накопления (${clearedVkAnswers} кодов)`);
  }

  await loadAdminConfig();
  await telegramAdapter.start();
  bot = telegramAdapter.getBot();

  bot.on('error', (error) => {
    console.error('Ошибка бота:', error);
  });

  bot.on('polling_error', (error) => {
    console.error('Ошибка polling:', error);
  });

  registerTransport(TELEGRAM_PLATFORM, {
    sendMessage: (userId, text, options = {}) => bot.sendMessage(userId, text, options),
    editMessage: (userId, messageId, text, options = {}) => bot.editMessageText(text, {
      chat_id: userId,
      message_id: messageId,
      ...(options || {})
    }),
    deleteMessage: (userId, messageId) => bot.deleteMessage(userId, messageId),
    sendTyping: (userId) => bot.sendChatAction ? bot.sendChatAction(userId, 'typing') : Promise.resolve(),
    answerCallback: ({ queryId, ...options }) => bot.answerCallbackQuery(queryId, options)
  });

  ({
    sendToEncounterAPI,
    sendAnswerToEncounter,
    processAnswerQueue
  } = createAnswerService({
    EncounterAPI,
    sendMessage: sendPlatformMessage,
    sendOrUpdateMessage,
    saveUserData,
    getUserInfo,
    getAnswerQueue,
    enqueueAnswer
  }));

  registerTelegramHandlers();
  console.log('🤖 Telegram-бот en_off_bot запущен!');
  console.log('📱 Готов к приему сообщений...');

  if (VK_GROUP_TOKEN && VK_GROUP_ID) {
    try {
      vkAdapterInstance = new VkAdapter({
        token: VK_GROUP_TOKEN,
        groupId: VK_GROUP_ID
      });

      await vkAdapterInstance.start();

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
          const response = await vkAdapterInstance.sendMessage(
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
            conversation_message_id: response.conversation_message_id ?? conversationMessageId ?? null
          };
        },
        editMessage: async (userId, messageId, text, options = {}) => {
          const peerId = toPeerId(userId, options);
          const safeText = text == null ? '' : String(text);
          const { keyboard, conversationMessageId, ...meta } = options || {};

          await vkAdapterInstance.updateMessage(
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
            await vkAdapterInstance.vk.api.messages.sendActivity({
              peer_id: peerId,
              type: 'typing'
            });
          } catch (_) {
            // ignore typing capabilities absence
          }
        },
        answerCallback: async (data = {}) => {
          try {
            const { eventId, peerId, userId, text } = data;

            if (!eventId) {
              console.warn('[vk] answerCallback: eventId не указан');
              return;
            }

            const payload = {
              event_id: eventId,
              peer_id: peerId || userId,
              user_id: userId
            };

            // Если есть текст, показываем его как всплывающее уведомление
            if (text) {
              payload.event_data = JSON.stringify({
                type: 'show_snackbar',
                text: text
              });
            }

            await vkAdapterInstance.vk.api.messages.sendMessageEventAnswer(payload);
          } catch (error) {
            console.error('[vk] Ошибка answerCallback:', error.message);
          }
        }
      });

      vkAdapterInstance.onEvent(async (event) => {
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
          console.error('[vk] Ошибка обработки события:', error);
        }
      });

      console.log('🌐 VK-платформа подключена и готова к работе');
    } catch (error) {
      console.error('❌ Не удалось запустить VK адаптер:', error);
    }
  } else {
    console.log('ℹ️ VK платформа отключена (нет VK_GROUP_TOKEN или VK_GROUP_ID)');
  }
}

startBot();

// Грациозное завершение работы
process.on('SIGINT', async () => {
  console.log('\n🛑 Остановка бота...');
  await saveUserData();
  await telegramAdapter.stop().catch(() => {});
  if (vkAdapterInstance) {
    await vkAdapterInstance.stop().catch(() => {});
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Остановка бота...');
  await saveUserData();
  await telegramAdapter.stop().catch(() => {});
  if (vkAdapterInstance) {
    await vkAdapterInstance.stop().catch(() => {});
  }
  process.exit(0);
});
