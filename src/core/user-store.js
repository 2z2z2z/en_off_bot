const fs = require('fs-extra');
const { encryptSecret, decryptSecret, isEncryptedSecret } = require('../utils/crypto');
const { logger } = require('../infra/logger');

const DEFAULT_DATA_FILE = 'user_data.json';

const KEY_SEPARATOR = '::';

let fallbackPlatform = 'telegram';
let storageMode = 'dual';
let storageReadMode = 'sqlite';
let writeJsonEnabled = true;
let writeSqliteEnabled = true;
let readSqliteEnabled = true;

const userData = new Map();
let userRepository = null;
let dataFilePath = DEFAULT_DATA_FILE;

function refreshConfig() {
  dataFilePath = process.env.DATA_FILE || DEFAULT_DATA_FILE;
  fallbackPlatform = process.env.DEFAULT_PLATFORM || 'telegram';
  storageMode = (process.env.STORAGE_MODE || 'dual').toLowerCase();
  storageReadMode = (process.env.STORAGE_READ_MODE || 'sqlite').toLowerCase();

  writeJsonEnabled = storageMode === 'dual' || storageMode === 'json';
  writeSqliteEnabled = storageMode === 'dual' || storageMode === 'sqlite';
  readSqliteEnabled = storageReadMode !== 'json';
}

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
    accumulationTimerEnd: null,
    pendingBurstAnswers: [], // Временный буфер сообщений до решения о пачке
    pendingBurstTimer: null, // Таймер ожидания перед отправкой одиночного ответа
    _burstProcessing: false,
    _burstProcessingRequested: false,
    queueProgressMessageId: null,
    accumulationNoticeMessageId: null,
    lastLevelId: null,
    lastLevelNumber: null,
    lastLevelUpdatedAt: null,
    telegramUsername: null,
    telegramFirstName: null,
    firstActivity: now,
    lastActivity: now
  };
};

function makeStorageKey(platform, userId) {
  return `${String(platform)}${KEY_SEPARATOR}${String(userId)}`;
}

function setUserRepository(repository) {
  userRepository = repository;
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

async function loadUsersFromRepository() {
  if (!userRepository || !readSqliteEnabled) {
    return false;
  }

  try {
    const profiles = await userRepository.listProfiles();
    if (!profiles.length) {
      return false;
    }

    userData.clear();

    for (const profile of profiles) {
      const storageKey = makeStorageKey(profile.platform, profile.userId);
      const user = createEmptyUser(profile.platform, profile.userId);

      user.login = profile.login || null;
      user.password = profile.password || null;
      user.domain = profile.domain || null;
      user.gameId = profile.activeGameId || null;
      user.isOnline = profile.isOnline;
      user.firstActivity = profile.firstActivity || user.firstActivity;
      user.lastActivity = profile.lastActivity || user.lastActivity;
      user.telegramUsername = profile.telegramUsername || null;
      user.telegramFirstName = profile.telegramFirstName || null;

      if (profile.activeGameId) {
        const session = await userRepository.getGameSession(profile.id, profile.activeGameId);
        if (session) {
          user.authCookies = session.authCookies || null;
          user.lastLevelId = session.lastLevelId || null;
          user.lastLevelNumber = session.lastLevelNumber || null;
          user.lastLevelUpdatedAt = session.lastLevelUpdatedAt || null;
          if (session.lastLevelId || session.lastLevelNumber) {
            user.lastKnownLevel = {
              levelId: session.lastLevelId || null,
              levelNumber: session.lastLevelNumber || null,
              timestamp: session.lastLevelUpdatedAt || Date.now()
            };
          }
        }
      }

      const runtime = await userRepository.getRuntimeState(profile.id);
      if (runtime) {
        user.answerQueue = Array.isArray(runtime.pendingAnswers)
          ? [...runtime.pendingAnswers]
          : [];
        user.accumulatedAnswers = Array.isArray(runtime.accumulatedAnswers)
          ? [...runtime.accumulatedAnswers]
          : [];
        user.pendingBurstAnswers = Array.isArray(runtime.pendingBurstAnswers)
          ? [...runtime.pendingBurstAnswers]
          : [];
        user.recentMessageTimestamps = Array.isArray(runtime.recentTimestamps)
          ? [...runtime.recentTimestamps]
          : [];
        user.pendingQueueDecision = runtime.pendingQueueDecision
          ? { ...runtime.pendingQueueDecision }
          : null;
        user.pendingAnswerDecision = runtime.pendingAnswerDecision
          ? { ...runtime.pendingAnswerDecision }
          : null;
        user.lastKnownLevel = runtime.lastKnownLevel
          ? { ...runtime.lastKnownLevel }
          : user.lastKnownLevel;
        user.accumulationStartLevel = runtime.accumulationStartLevel
          ? { ...runtime.accumulationStartLevel }
          : null;
        user.isProcessingQueue = runtime.isProcessingQueue;
        user.isAccumulatingAnswers = runtime.isAccumulating;
        user.isAuthenticating = runtime.isAuthenticating;
        user.accumulationTimerEnd = runtime.accumulationTimerEnd || null;
        user.queueProgressMessageId = runtime.queueProgressMessageId || null;
        user.accumulationNoticeMessageId = runtime.accumulationNoticeMessageId || null;
      }

      userData.set(storageKey, user);
    }

    logger.info(`Данные пользователей загружены из SQLite (${userData.size} профилей)`);
    return true;
  } catch (error) {
    logger.error('Ошибка загрузки данных из SQLite:', error);
    return false;
  }
}

async function persistToRepository() {
  if (!userRepository || !writeSqliteEnabled) {
    return;
  }

  for (const user of userData.values()) {
    try {
      const profileRecord = await userRepository.saveProfile({
        platform: user.platform,
        userId: user.userId,
        login: user.login,
        password: user.password,
        domain: user.domain,
        activeGameId: user.gameId,
        telegramUsername: user.telegramUsername,
        telegramFirstName: user.telegramFirstName,
        isOnline: user.isOnline,
        firstActivity: user.firstActivity,
        lastActivity: user.lastActivity
      });

      if (user.gameId) {
        await userRepository.upsertGameSession(profileRecord.id, {
          gameId: user.gameId,
          authCookies: user.authCookies,
          lastLevelId: user.lastKnownLevel?.levelId || user.lastLevelId || null,
          lastLevelNumber: user.lastKnownLevel?.levelNumber || user.lastLevelNumber || null,
          lastLevelUpdatedAt:
            user.lastKnownLevel?.timestamp || user.lastLevelUpdatedAt || Date.now()
        });
      }

      await userRepository.updateRuntimeState(profileRecord.id, {
        pendingAnswers: user.answerQueue,
        accumulatedAnswers: user.accumulatedAnswers,
        pendingBurstAnswers: user.pendingBurstAnswers,
        recentTimestamps: user.recentMessageTimestamps,
        pendingQueueDecision: user.pendingQueueDecision,
        pendingAnswerDecision: user.pendingAnswerDecision,
        lastKnownLevel: user.lastKnownLevel,
        accumulationStartLevel: user.accumulationStartLevel,
        isProcessingQueue: user.isProcessingQueue,
        isAccumulating: user.isAccumulatingAnswers,
        isAuthenticating: user.isAuthenticating,
        accumulationTimerEnd: user.accumulationTimerEnd || null,
        queueProgressMessageId: user.queueProgressMessageId || null,
        accumulationNoticeMessageId: user.accumulationNoticeMessageId || null
      });
    } catch (error) {
      logger.error(
        `Ошибка синхронизации пользователя ${user.platform}::${user.userId} с SQLite:`,
        error
      );
    }
  }
}

async function loadUserData(customPath) {
  if (customPath) {
    dataFilePath = customPath;
  }

  if (userRepository && readSqliteEnabled) {
    const loadedFromDb = await loadUsersFromRepository();
    if (loadedFromDb) {
      return;
    }
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

        let platform = userInfo.platform || platformFromKey || fallbackPlatform;
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
          platform = fallbackPlatform;
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
        if (!userInfo.hasOwnProperty('queueProgressMessageId')) {
          userInfo.queueProgressMessageId = null;
          migrationCount++;
        }
        if (!userInfo.hasOwnProperty('accumulationNoticeMessageId')) {
          userInfo.accumulationNoticeMessageId = null;
          migrationCount++;
        }
        if (!userInfo.hasOwnProperty('accumulationTimerEnd')) {
          userInfo.accumulationTimerEnd = null;
        }
        if (!userInfo.hasOwnProperty('lastLevelId')) {
          userInfo.lastLevelId = null;
        }
        if (!userInfo.hasOwnProperty('lastLevelNumber')) {
          userInfo.lastLevelNumber = null;
        }
        if (!userInfo.hasOwnProperty('lastLevelUpdatedAt')) {
          userInfo.lastLevelUpdatedAt = null;
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

      if (migrationCount === 0 && userRepository && writeSqliteEnabled) {
        await persistToRepository();
      }
    }
  } catch (error) {
    logger.error('Ошибка загрузки данных пользователей:', error);
  }
}

async function saveUserData(customPath) {
  const targetPath = customPath || dataFilePath;
  try {
    if (userRepository && writeSqliteEnabled) {
      await persistToRepository();
    }

    if (!writeJsonEnabled) {
      return;
    }

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
      delete sanitizedUser.queueProgressMessageId;
      delete sanitizedUser.accumulationNoticeMessageId;
      delete sanitizedUser.accumulationTimerEnd;
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

refreshConfig();

module.exports = {
  userData,
  loadUserData,
  saveUserData,
  setUserRepository,
  getUserInfo,
  isUserReady,
  updateUserActivity,
  setDataFilePath,
  getAnswerQueue,
  enqueueAnswer,
  clearAnswerQueue,
  deleteUser,
  makeStorageKey,
  refreshConfig
};
