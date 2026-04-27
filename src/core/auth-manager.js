/**
 * Централизованный модуль управления авторизацией с мьютексом
 * Используется для предотвращения параллельных авторизаций
 */

/**
 * Централизованная функция авторизации с мьютексом
 * Используется для ВСЕХ вызовов API (sendAnswer, getGameState, и т.д.)
 * @param {Object} user - объект пользователя
 * @param {Object} EncounterAPI - класс EncounterAPI
 * @param {Function} saveUserData - функция сохранения данных
 * @returns {Promise<Object>} - cookies после успешной авторизации
 */
async function ensureAuthenticated(user, EncounterAPI, saveUserData) {
  // Если уже идёт авторизация - ждём её, не запуская параллельную
  if (user.authPromise) {
    console.log(`⏳ Ожидание завершения авторизации для ${user.login}...`);
    try {
      await user.authPromise;
    } catch (waitError) {
      console.log(`⚠️ Параллельная авторизация для ${user.login} упала: ${waitError.message}. Пробуем заново.`);
    }

    if (user.authCookies && Object.keys(user.authCookies).length > 0) {
      return user.authCookies;
    }
  }

  if (user.authCookies && Object.keys(user.authCookies).length > 0) {
    console.log(`🔑 Используем сохраненные cookies для ${user.login}`);
    return user.authCookies;
  }

  console.log(`🔐 Нет cookies, выполняем авторизацию для ${user.login}...`);
  console.log(`🎮 Данные игры: домен=${user.domain}, ID=${user.gameId}`);

  // Атомарно (синхронный участок до await) фиксируем промис, чтобы конкурирующие вызовы видели его
  const authPromise = (async () => {
    const tempApi = new EncounterAPI(user.domain);
    const authResult = await tempApi.authenticate(user.login, user.password);

    if (!authResult.success) {
      throw new Error(`Ошибка авторизации: ${authResult.message}`);
    }

    user.authCookies = authResult.cookies;
    if (user.notifications) {
      user.notifications.needsReauth = false;
    }
    await saveUserData();
    console.log(`✅ Авторизация успешна для ${user.login}`);
    return user.authCookies;
  })();

  user.authPromise = authPromise;
  user.isAuthenticating = true;

  // Подавляем unhandled rejection: если ожидающие ещё не успели подключить await,
  // ошибка может всплыть как unhandled. Финальная await ниже всё равно её пробросит наверх.
  authPromise.catch(() => {});

  try {
    return await authPromise;
  } finally {
    user.isAuthenticating = false;
    user.authPromise = null;
  }
}

/**
 * Создает callback для автоматической реаутентификации из EncounterAPI
 * Вызывается когда API обнаруживает истекшую сессию
 * @param {Object} user - объект пользователя
 * @param {Object} EncounterAPI - класс EncounterAPI
 * @param {Function} saveUserData - функция сохранения данных
 * @returns {Promise<Function>} - callback функция
 */
async function createAuthCallback(user, EncounterAPI, saveUserData) {
  return async () => {
    console.log(`🔄 Запрос на реаутентификацию через callback для ${user.login}...`);
    const cookies = await ensureAuthenticated(user, EncounterAPI, saveUserData);
    return { success: true, cookies };
  };
}

module.exports = {
  ensureAuthenticated,
  createAuthCallback
};
