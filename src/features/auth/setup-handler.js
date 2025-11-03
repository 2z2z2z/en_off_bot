function createCheckAuthentication({ EncounterAPI, logger, defaultDomain = 'https://world.en.cx' }) {
  return async function checkAuthentication(login, password, domain = defaultDomain) {
    try {
      const api = new EncounterAPI(domain);
      return await api.authenticate(login, password);
    } catch (error) {
      logger.error('Ошибка проверки авторизации:', error.message);
      const hasBasicCredentials = login.length > 0 && password.length > 0;
      return {
        success: hasBasicCredentials,
        message: hasBasicCredentials
          ? 'Базовая проверка пройдена'
          : 'Логин или пароль не могут быть пустыми'
      };
    }
  };
}

function createAuthSetupHandler(deps) {
  const {
    sendMessage,
    setUserState,
    saveUserData,
    checkGameAccess,
    parseGameUrl,
    createMainKeyboard,
    logger,
    STATES,
    EncounterAPI,
    defaultDomain
  } = deps;

  const checkAuthentication = createCheckAuthentication({
    EncounterAPI,
    logger,
    defaultDomain
  });

  async function handleLoginInput(platform, userId, user, text) {
    user.login = text;
    setUserState(platform, userId, STATES.WAITING_FOR_PASSWORD);
    await sendMessage(platform, userId, `Логин сохранен: ${text}\nТеперь введите пароль:`);
  }

  async function handlePasswordInput(platform, userId, user, text) {
    user.password = text;

    if (!user.login || !user.password || user.login.length < 2 || user.password.length < 2) {
      setUserState(platform, userId, STATES.WAITING_FOR_LOGIN);
      await sendMessage(
        platform,
        userId,
        '❌ Логин и пароль должны содержать минимум 2 символа.\nВведите логин еще раз:'
      );
      return;
    }

    await sendMessage(platform, userId, '🔄 Проверяю данные авторизации...');

    try {
      const authResult = await checkAuthentication(user.login, user.password);

      if (authResult.success) {
        user.authCookies = authResult.cookies;
        await saveUserData();
        setUserState(platform, userId, STATES.WAITING_FOR_GAME_URL);
        await sendMessage(
          platform,
          userId,
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
      await sendMessage(
        platform,
        userId,
        `❌ Ошибка проверки авторизации: ${error.message}\nВведите логин еще раз:`
      );
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
      logger.info(`🔄 Домен изменился с ${user.domain} на ${gameUrlResult.domain}, сбрасываем cookies`);
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

  return {
    handleLoginInput,
    handlePasswordInput,
    handleGameUrlInput,
    checkAuthentication
  };
}

module.exports = {
  createAuthSetupHandler,
  createCheckAuthentication
};

