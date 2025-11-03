async function withGameAccess(deps, platform, userId, fn) {
  if (!(await deps.checkGameAccess(platform, userId))) {
    return;
  }
  await fn();
}

/* eslint-disable-next-line complexity */
async function executeTaskRequest(deps, payload) {
  const { platform, userId, user, formatted } = payload;

  const waitText = formatted
    ? '🔄 Получаю форматированное задание текущего уровня...'
    : '🔄 Получаю задание текущего уровня...';

  const waitMsg = await deps.sendMessage(platform, userId, waitText);

  try {
    const authCallback = await deps.createAuthCallback(user, deps.EncounterAPI, deps.saveUserData);
    const api = new deps.EncounterAPI(user.domain, authCallback);

    await deps.ensureAuthenticated(user, deps.EncounterAPI, deps.saveUserData);

    let gameState;
    try {
      gameState = await api.getGameState(
        user.gameId,
        user.authCookies,
        user.login,
        user.password
      );
    } catch (error) {
      const msg = String(error.message || '').toLowerCase();
      if (msg.includes('требуется авторизация') || msg.includes('сессия истекла')) {
        const reauth = await api.authenticate(user.login, user.password);
        if (!reauth.success) {
          throw new Error(reauth.message || 'Не удалось авторизоваться');
        }
        user.authCookies = reauth.cookies;
        await deps.saveUserData();
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
          await deps.sendOrUpdateMessage(
            platform,
            userId,
            '⚠️ Игра неактивна или недоступна сейчас.',
            waitMsg?.message_id
          );
          return;
        }
        model = gameState.data;
      } else {
        await deps.sendOrUpdateMessage(
          platform,
          userId,
          '⚠️ Игра неактивна или недоступна сейчас.',
          waitMsg?.message_id
        );
        return;
      }
    }

    const level = model.Level;
    if (!level) {
      await deps.sendOrUpdateMessage(
        platform,
        userId,
        '⚠️ Активный уровень не найден.',
        waitMsg?.message_id
      );
      return;
    }

    const taskFragments = deps.collectTaskFragments(level.Tasks, { formatted });
    const helps = deps.collectHelps(level.Helps, { formatted });
    const timeoutRemain = deps.formatRemain(level.TimeoutSecondsRemain);

    const taskMessage = deps.formatTaskMessage({
      platform,
      telegramPlatform: deps.getTelegramPlatform(),
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
        await deps.editMessage(platform, userId, waitMsg.message_id, taskMessage.text, editOptions);
      } else {
        await deps.editMessage(platform, userId, waitMsg.message_id, taskMessage.header, editOptions);
        for (const chunk of deps.splitMessageBody(taskMessage.body, 4000)) {
          await deps.sendMessage(platform, userId, chunk, taskMessage.options);
        }
      }
    } else {
      await deps.sendMessage(platform, userId, taskMessage.text, taskMessage.options);
    }
  } catch (error) {
    const errorPrefix = formatted
      ? '❌ Не удалось получить форматированное задание'
      : '❌ Не удалось получить задание';
    await deps.sendOrUpdateMessage(
      platform,
      userId,
      `${errorPrefix}: ${error.message}`,
      waitMsg?.message_id
    );
  }
}

/* eslint-disable-next-line complexity */
async function executeSectorsRequest(deps, payload) {
  const { platform, userId, user } = payload;

  const waitMsg = await deps.sendMessage(platform, userId, '🔄 Получаю список секторов...');
  try {
    const authCallback = await deps.createAuthCallback(user, deps.EncounterAPI, deps.saveUserData);
    const api = new deps.EncounterAPI(user.domain, authCallback);

    await deps.ensureAuthenticated(user, deps.EncounterAPI, deps.saveUserData);

    let gameState;
    try {
      gameState = await api.getGameState(
        user.gameId,
        user.authCookies,
        user.login,
        user.password
      );
    } catch (error) {
      const msg = String(error.message || '').toLowerCase();
      if (msg.includes('требуется авторизация') || msg.includes('сессия истекла')) {
        const reauth = await api.authenticate(user.login, user.password);
        if (!reauth.success) {
          throw new Error(reauth.message || 'Не удалось авторизоваться');
        }
        user.authCookies = reauth.cookies;
        await deps.saveUserData();
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
          await deps.sendOrUpdateMessage(
            platform,
            userId,
            '⚠️ Игра неактивна или недоступна сейчас.',
            waitMsg?.message_id
          );
          return;
        }
        model = gameState.data;
      } else {
        await deps.sendOrUpdateMessage(
          platform,
          userId,
          '⚠️ Игра неактивна или недоступна сейчас.',
          waitMsg?.message_id
        );
        return;
      }
    }

    const level = model.Level;
    if (!level) {
      await deps.sendOrUpdateMessage(
        platform,
        userId,
        '⚠️ Активный уровень не найден.',
        waitMsg?.message_id
      );
      return;
    }

    const sectors = Array.isArray(level.Sectors) ? level.Sectors : [];
    const totalRequired = Number(level.RequiredSectorsCount) || 0;
    const passedCount = Number(level.PassedSectorsCount) || 0;
    const leftToClose = Math.max(totalRequired - passedCount, 0);

    const sectorsMessage = deps.formatSectorsMessage({
      platform,
      telegramPlatform: deps.getTelegramPlatform(),
      sectors,
      totalRequired,
      totalCount: sectors.length,
      passedCount,
      leftToClose
    });

    if (waitMsg?.message_id) {
      if (sectorsMessage.text.length <= 4000) {
        await deps.editMessage(
          platform,
          userId,
          waitMsg.message_id,
          sectorsMessage.text,
          sectorsMessage.options
        );
      } else {
        await deps.editMessage(
          platform,
          userId,
          waitMsg.message_id,
          sectorsMessage.header,
          sectorsMessage.options
        );
        for (const chunk of deps.splitMessageBody(sectorsMessage.body, 4000)) {
          await deps.sendMessage(platform, userId, chunk, sectorsMessage.options);
        }
      }
    } else {
      await deps.sendMessage(platform, userId, sectorsMessage.text, sectorsMessage.options);
    }
  } catch (error) {
    await deps.sendOrUpdateMessage(
      platform,
      userId,
      `❌ Не удалось получить сектора: ${error.message}`,
      waitMsg?.message_id
    );
  }
}

async function handleTaskRequest(deps, payload) {
  const { platform, userId, user, formatted } = payload;

  await withGameAccess(deps, platform, userId, () =>
    executeTaskRequest(deps, { platform, userId, user, formatted })
  );
}

async function handleSectorsRequest(deps, payload) {
  const { platform, userId, user } = payload;

  await withGameAccess(deps, platform, userId, () =>
    executeSectorsRequest(deps, { platform, userId, user })
  );
}

async function handleQueueStatus(deps, payload) {
  const { platform, userId, user } = payload;
  const queueLength = user.answerQueue.length;
  const status = user.isOnline ? '🟢 Онлайн' : '🔴 Оффлайн';
  const queueText =
    queueLength > 0
      ? 'Очередь:\n' +
        user.answerQueue
          .map(
            (item, index) =>
              `${index + 1}. "${item.answer}" (${new Date(item.timestamp).toLocaleTimeString()})`
          )
          .join('\n')
      : 'Очередь пуста';

  await deps.sendMessage(
    platform,
    userId,
    `Статус: ${status}\n` + `Ответов в очереди: ${queueLength}\n\n` + queueText
  );
}

async function handleChangeGame(deps, payload) {
  const { platform, userId, user } = payload;
  await withGameAccess(deps, platform, userId, async () => {
    const STATES = deps.getStates();
    deps.resetUserRuntimeState(user);
    user.authCookies = null;
    await deps.saveUserData();
    deps.setUserState(platform, userId, STATES.WAITING_FOR_GAME_URL);
    await deps.sendMessage(
      platform,
      userId,
      'Пришлите новую ссылку на игру:\n\n' +
        '• https://domain.en.cx/GameDetails.aspx?gid=XXXXX\n' +
        '• https://domain.en.cx/gameengines/encounter/play/XXXXX/'
    );
  });
}

async function handleChangeAuth(deps, payload) {
  const { platform, userId, user } = payload;
  const STATES = deps.getStates();
  deps.resetUserRuntimeState(user);
  user.authCookies = null;
  await deps.saveUserData();
  deps.setUserState(platform, userId, STATES.WAITING_FOR_LOGIN);
  await deps.sendMessage(platform, userId, 'Введите новый логин:');
}

async function handleAnswerInput(deps, payload) {
  const { platform, userId, user, text } = payload;
  await withGameAccess(deps, platform, userId, async () => {
    const progressMessage = await deps.sendMessage(
      platform,
      userId,
      `⏳ Отправляю ответ "${text}"...`
    );
    const progressMessageId =
      progressMessage?.message_id ?? progressMessage?.conversation_message_id ?? null;
    const result = await deps.queueAnswerForProcessing(
      platform,
      userId,
      user,
      text,
      progressMessageId
    );

    if (result && user.answerQueue.length > 0) {
      setTimeout(() => deps.processAnswerQueue(platform, userId), 1200);
    }
  });
}

function createReadyStateHandler(deps) {
  async function handleReadyStateInput(platform, userId, user, text, context) {
    if (text === '🔄 Рестарт бота') {
      await deps.handleStartCommand(context);
      return;
    }

    if (text === 'Задание' || text === 'Задание (формат)') {
      await handleTaskRequest(deps, {
        platform,
        userId,
        user,
        formatted: text === 'Задание (формат)'
      });
      return;
    }

    if (text === 'Сектора') {
      await handleSectorsRequest(deps, { platform, userId, user });
      return;
    }

    if (text === '📊 Статус очереди') {
      await handleQueueStatus(deps, { platform, userId, user });
      return;
    }

    if (text === '🔗 Сменить игру') {
      await handleChangeGame(deps, { platform, userId, user });
      return;
    }

    if (text === '👤 Сменить авторизацию') {
      await handleChangeAuth(deps, { platform, userId, user });
      return;
    }

    await handleAnswerInput(deps, { platform, userId, user, text });
  }

  return {
    handleReadyStateInput
  };
}

module.exports = {
  createReadyStateHandler
};


