const fs = require('fs-extra');
const { encryptSecret, decryptSecret, isEncryptedSecret } = require('../utils/crypto');
const { logger } = require('../infra/logger');

const DEFAULT_DATA_FILE = process.env.DATA_FILE || 'user_data.json';

const KEY_SEPARATOR = '::';
const FALLBACK_PLATFORM = process.env.DEFAULT_PLATFORM || 'telegram';

const userData = new Map();

const createEmptyUser = (platform, userId) => {
  const now = Date.now();
  return {
    platform,
    userId,
    login: null,
    password: null,
    domain: null,
    gameId: null,
    authCookies: null,
    answerQueue: [],
    isOnline: true,
    isProcessingQueue: false,
    isAuthenticating: false,
    authPromise: null,
    pendingQueueDecision: null,
    pendingAnswerDecision: null,
    lastKnownLevel: null, // Последний известный уровень { levelId, levelNumber, timestamp }
    // Система накопления кодов для детекта оффлайн-пачки
    recentMessageTimestamps: [], // Временные метки последних сообщений для детекта всплеска
    isAccumulatingAnswers: false, // Флаг режима накопления
    accumulatedAnswers: [], // Буфер накопленных кодов { answer, timestamp, levelId, levelNumber }
    accumulationStartLevel: null, // Уровень на момент начала накопления { levelId, levelNumber }
    accumulationTimer: null, // ID таймера для завершения накопления
    pendingBurstAnswers: [], // Временный буфер сообщений до решения о пачке
    pendingBurstTimer: null, // Таймер ожидания перед отправкой одиночного ответа
    _burstProcessing: false,
    _burstProcessingRequested: false,
    telegramUsername: null,
    telegramFirstName: null,
    firstActivity: now,
    lastActivity: now
  };
};

let dataFilePath = DEFAULT_DATA_FILE;

function makeStorageKey(platform, userId) {
  return `${String(platform)}${KEY_SEPARATOR}${String(userId)}`;
}

function getUserInfo(platform, userId) {
  const storageKey = makeStorageKey(platform, userId);
  if (!userData.has(storageKey)) {
    userData.set(storageKey, createEmptyUser(platform, userId));
  }
  return userData.get(storageKey);
}

function isUserReady(platform, userId) {
  const user = getUserInfo(platform, userId);
  return Boolean(user.login && user.password && user.domain && user.gameId);
}

function updateUserActivity(platform, userId, username, firstName) {
  const user = getUserInfo(platform, userId);
  const now = Date.now();

  if (username && user.telegramUsername !== username) {
    user.telegramUsername = username;
  }
  if (firstName && user.telegramFirstName !== firstName) {
    user.telegramFirstName = firstName;
  }

  user.lastActivity = now;
}

async function loadUserData(customPath) {
  if (customPath) {
    dataFilePath = customPath;
  }

  try {
    if (await fs.pathExists(dataFilePath)) {
      const rawData = await fs.readJson(dataFilePath);
      const now = Date.now();
      let migrationCount = 0;
      userData.clear();

      for (const [rawKey, userInfoRaw] of Object.entries(rawData)) {
        const userInfo = userInfoRaw || {};

        let platformFromKey = null;
        let userIdFromKey = null;
        if (rawKey.includes(KEY_SEPARATOR)) {
          const [platform, ...rest] = rawKey.split(KEY_SEPARATOR);
          platformFromKey = platform || null;
          userIdFromKey = rest.join(KEY_SEPARATOR) || null;
        }

        let platform = userInfo.platform || platformFromKey || FALLBACK_PLATFORM;
        let userId = userInfo.userId || userIdFromKey || rawKey;

        // Обновляем счётчик миграций, если добавляем недостающие поля
        if (!userInfo.platform) {
          migrationCount++;
        }
        if (!userInfo.userId) {
          migrationCount++;
        }

        platform = String(platform || '').trim();
        userId = String(userId || '').trim();

        if (!platform) {
          platform = FALLBACK_PLATFORM;
          migrationCount++;
        }

        if (!userId) {
          logger.warn(`Пропускаем запись без userId: ${rawKey}`);
          migrationCount++;
          continue;
        }

        if (!userInfo.telegramUsername) {
          userInfo.telegramUsername = null;
          migrationCount++;
        }
        if (!userInfo.telegramFirstName) {
          userInfo.telegramFirstName = null;
        }
        if (!userInfo.firstActivity) {
          userInfo.firstActivity = now;
          migrationCount++;
        }
        if (!userInfo.lastActivity) {
          userInfo.lastActivity = now;
          migrationCount++;
        }
        if (typeof userInfo.password === 'string' && userInfo.password) {
          if (!isEncryptedSecret(userInfo.password)) {
            migrationCount++;
          }
          try {
            userInfo.password = decryptSecret(userInfo.password);
          } catch (error) {
            throw new Error(`Не удалось расшифровать пароль для ${rawKey}: ${error.message}`);
          }
        }
        if (!userInfo.hasOwnProperty('isProcessingQueue')) {
          userInfo.isProcessingQueue = false;
          migrationCount++;
        } else if (userInfo.isProcessingQueue) {
          userInfo.isProcessingQueue = false;
        }
        if (!userInfo.hasOwnProperty('pendingQueueDecision')) {
          userInfo.pendingQueueDecision = null;
          migrationCount++;
        }
        if (!userInfo.hasOwnProperty('pendingAnswerDecision')) {
          userInfo.pendingAnswerDecision = null;
          migrationCount++;
        }
        if (!userInfo.hasOwnProperty('isAuthenticating')) {
          userInfo.isAuthenticating = false;
          migrationCount++;
        }

        const storageKey = makeStorageKey(platform, userId);

        userData.set(storageKey, {
          ...createEmptyUser(platform, userId),
          ...userInfo,
          platform,
          userId
        });
      }

      if (migrationCount > 0) {
        await saveUserData();
      }

      logger.info(`Данные пользователей загружены (${userData.size} пользователей)`);
      if (migrationCount > 0) {
        logger.info(`Выполнена миграция данных для ${migrationCount} полей`);
      }
    }
  } catch (error) {
    logger.error('Ошибка загрузки данных пользователей:', error);
  }
}

async function saveUserData(customPath) {
  const targetPath = customPath || dataFilePath;
  try {
    const data = {};
    for (const [key, value] of userData.entries()) {
      const sanitizedUser = { ...value };
      delete sanitizedUser.isProcessingQueue;
      delete sanitizedUser.isAuthenticating;
      delete sanitizedUser.authPromise;
      delete sanitizedUser.pendingQueueDecision;
      delete sanitizedUser.pendingAnswerDecision;
      delete sanitizedUser.accumulationTimer; // Не сохраняем таймер
      delete sanitizedUser.pendingBurstAnswers;
      delete sanitizedUser.pendingBurstTimer;
      delete sanitizedUser._burstProcessing;
      delete sanitizedUser._burstProcessingRequested;
      if (typeof sanitizedUser.password === 'string' && sanitizedUser.password) {
        sanitizedUser.password = encryptSecret(sanitizedUser.password);
      }
      data[key] = sanitizedUser;
    }
    await fs.writeJson(targetPath, data, { spaces: 2 });
  } catch (error) {
    logger.error('Ошибка сохранения данных пользователей:', error);
    throw error;
  }
}

function setDataFilePath(nextPath) {
  dataFilePath = nextPath || DEFAULT_DATA_FILE;
}

function getAnswerQueue(platform, userId) {
  return getUserInfo(platform, userId).answerQueue;
}

function enqueueAnswer(platform, userId, payload) {
  const queue = getAnswerQueue(platform, userId);
  queue.push(payload);
}

function clearAnswerQueue(platform, userId) {
  const queue = getAnswerQueue(platform, userId);
  queue.length = 0;
}

function deleteUser(platform, userId) {
  const storageKey = makeStorageKey(platform, userId);
  return userData.delete(storageKey);
}

module.exports = {
  userData,
  loadUserData,
  saveUserData,
  getUserInfo,
  isUserReady,
  updateUserActivity,
  setDataFilePath,
  getAnswerQueue,
  enqueueAnswer,
  clearAnswerQueue,
  deleteUser,
  makeStorageKey
};
