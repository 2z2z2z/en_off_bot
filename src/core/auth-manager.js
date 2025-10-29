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
  // Мьютекс авторизации: если уже идет авторизация, ждем её завершения
  if (user.isAuthenticating && user.authPromise) {
    console.log(`⏳ Ожидание завершения авторизации для ${user.login}...`);
    await user.authPromise;
    console.log(`✅ Авторизация завершена, используем обновленные cookies`);
    return user.authCookies;
  }

  if (!user.authCookies || Object.keys(user.authCookies).length === 0) {
    // Проверяем еще раз после ожидания
    if (user.isAuthenticating && user.authPromise) {
      await user.authPromise;
      // После ожидания cookies должны быть
      if (user.authCookies && Object.keys(user.authCookies).length > 0) {
        console.log(`🔑 Используем cookies после ожидания авторизации`);
        return user.authCookies;
      }
    }

    // Если все еще нет cookies, запускаем авторизацию
    if (!user.authCookies || Object.keys(user.authCookies).length === 0) {
      console.log(`🔐 Нет cookies, выполняем авторизацию для ${user.login}...`);
      console.log(`🎮 Данные игры: домен=${user.domain}, ID=${user.gameId}`);

      // Устанавливаем флаг авторизации
      user.isAuthenticating = true;
      let resolveAuth, rejectAuth;
      user.authPromise = new Promise((resolve, reject) => {
        resolveAuth = resolve;
        rejectAuth = reject;
      });

      try {
        // Создаем временный API только для авторизации
        const tempApi = new EncounterAPI(user.domain);
        const authResult = await tempApi.authenticate(user.login, user.password);

        if (authResult.success) {
          user.authCookies = authResult.cookies;
          await saveUserData();
          console.log(`✅ Авторизация успешна для ${user.login}`);
          resolveAuth();
          return user.authCookies;
        } else {
          const error = new Error(`Ошибка авторизации: ${authResult.message}`);
          rejectAuth(error);
          throw error;
        }
      } catch (authError) {
        rejectAuth(authError);
        throw authError;
      } finally {
        user.isAuthenticating = false;
        user.authPromise = null;
      }
    }
  } else {
    console.log(`🔑 Используем сохраненные cookies для ${user.login}`);
  }

  return user.authCookies;
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
