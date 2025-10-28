const fs = require('fs-extra');

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
          console.warn(`Пропускаем запись без userId: ${rawKey}`);
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

      console.log(`Данные пользователей загружены (${userData.size} пользователей)`);
      if (migrationCount > 0) {
        console.log(`Выполнена миграция данных для ${migrationCount} полей`);
      }
    }
  } catch (error) {
    console.error('Ошибка загрузки данных пользователей:', error);
  }
}

async function saveUserData(customPath) {
  const targetPath = customPath || dataFilePath;
  try {
    const data = {};
    for (const [key, value] of userData.entries()) {
      data[key] = value;
    }
    await fs.writeJson(targetPath, data, { spaces: 2 });
  } catch (error) {
    console.error('Ошибка сохранения данных пользователей:', error);
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
