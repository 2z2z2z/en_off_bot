const ACTIONS = new Set(['batch_send_all', 'batch_send_force', 'batch_cancel_all', 'batch_list']);

function buildCodesList(accumulated) {
  return accumulated
    .map((item, index) => `${index + 1}. "${item.answer}" (уровень ${item.levelNumber || '?'})`)
    .join('\n');
}

async function refreshLevelInfo(deps, user) {
  const { logger, saveUserData, createAuthCallback, EncounterAPI } = deps;

  try {
    const authCallback = await createAuthCallback(user, EncounterAPI, saveUserData);
    const api = new EncounterAPI(user.domain, authCallback);
    const gameState = await api.getGameState(
      user.gameId,
      user.authCookies,
      user.login,
      user.password
    );

    if (gameState.success && gameState.data?.Level) {
      user.lastKnownLevel = {
        levelId: gameState.data.Level.LevelId,
        levelNumber: gameState.data.Level.Number,
        timestamp: Date.now()
      };
      logger.info(
        `📌 Обновлен lastKnownLevel: уровень ${gameState.data.Level.Number} (ID: ${gameState.data.Level.LevelId})`
      );
    }
  } catch (error) {
    logger.error('⚠️ Ошибка обновления lastKnownLevel:', error.message);
  }
}

async function handleSendAll(deps, payload) {
  const { logger, processBatchSend } = deps;
  const { platform, userId, accumulated, queryId, answerCb } = payload;

  logger.info(`✅ Пользователь выбрал: отправить ${accumulated.length} накопленных кодов`);

  if (accumulated.length === 0) {
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
      text: `Отправка ${accumulated.length} ${accumulated.length === 1 ? 'кода' : 'кодов'}...`
    });
  }

  await processBatchSend(platform, userId);
}

async function handleSendForce(deps, payload) {
  const { logger, saveUserData, processBatchSend } = deps;
  const { platform, userId, user, accumulated, queryId, answerCb } = payload;

  logger.info('✅ Пользователь выбрал: принудительно отправить в новый уровень');

  if (accumulated.length === 0) {
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
      text: 'Принудительная отправка...'
    });
  }

  user.accumulationStartLevel = null;
  await saveUserData();

  await processBatchSend(platform, userId);
}

async function handleCancelAll(deps, payload) {
  const { logger, saveUserData, resetBurstState, sendMessage } = deps;
  const { platform, userId, user, accumulated, queryId, answerCb } = payload;
  const count = accumulated.length;

  logger.info(`🚫 Пользователь выбрал: отменить ${count} накопленных кодов`);

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

  await refreshLevelInfo(deps, user);

  user.accumulatedAnswers = [];
  user.isAccumulatingAnswers = false;
  user.accumulationStartLevel = null;
  if (user.accumulationTimer) {
    clearTimeout(user.accumulationTimer);
    user.accumulationTimer = null;
  }
  resetBurstState(user);
  await saveUserData();

  if (queryId) {
    await answerCb({
      queryId,
      text: '🚫 Все коды отменены'
    });
  }

  await sendMessage(
    platform,
    userId,
    `🚫 Отменено ${count} ${count === 1 ? 'код' : count < 5 ? 'кода' : 'кодов'}`
  );
}

async function handleList(deps, payload) {
  const { logger, sendMessage } = deps;
  const { platform, userId, accumulated, queryId, answerCb } = payload;

  logger.info('📋 Пользователь запросил список накопленных кодов');

  if (accumulated.length === 0) {
    if (queryId) {
      await answerCb({
        queryId,
        text: '⚠️ Нет накопленных кодов',
        show_alert: true
      });
    }
    return;
  }

  const allCodes = buildCodesList(accumulated);

  if (queryId) {
    await answerCb({ queryId });
  }

  await sendMessage(
    platform,
    userId,
    `📋 Полный список накопленных кодов (${accumulated.length}):\n\n${allCodes}`
  );
}

function createBatchCallbackHandler(deps) {
  const { getPlatformUser } = deps;

  return {
    matches(action) {
      return ACTIONS.has(action);
    },

    async handle(action, context) {
      const { platform, userId, queryId, answerCb } = context;
      const user = getPlatformUser(platform, userId);
      const accumulated = user.accumulatedAnswers || [];

      const payload = { platform, userId, user, accumulated, queryId, answerCb };

      switch (action) {
        case 'batch_send_all':
          await handleSendAll(deps, payload);
          break;
        case 'batch_send_force':
          await handleSendForce(deps, payload);
          break;
        case 'batch_cancel_all':
          await handleCancelAll(deps, payload);
          break;
        case 'batch_list':
          await handleList(deps, payload);
          break;
        default:
          break;
      }
    }
  };
}

module.exports = {
  createBatchCallbackHandler
};


