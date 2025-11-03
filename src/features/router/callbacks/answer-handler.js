async function resolveLevelInfo(deps, user, api, result) {
  if (result.level?.LevelId) {
    return result.level;
  }

  if (result.data?.Level?.LevelId) {
    return result.data.Level;
  }

  try {
    const state = await api.getGameState(
      user.gameId,
      user.authCookies,
      user.login,
      user.password
    );

    if (state.success && state.data?.Level?.LevelId) {
      return state.data.Level;
    }
  } catch (stateError) {
    deps.logger.error(
      '⚠️ Не удалось обновить lastKnownLevel после подтверждения:',
      stateError.message
    );
  }

  return null;
}

function buildLevelUpdate(levelInfo) {
  if (!levelInfo?.LevelId) {
    return null;
  }

  return {
    levelId: levelInfo.LevelId,
    levelNumber: levelInfo.Number,
    timestamp: Date.now()
  };
}

async function notifySendOutcome(deps, payload) {
  const { platform, userId, decision, result } = payload;

  if (result.success) {
    await deps.sendMessage(
      platform,
      userId,
      `Ответ "${decision.answer}" отправлен в уровень ${decision.newLevel}\n${result.message}`
    );
  } else {
    await deps.sendMessage(
      platform,
      userId,
      `❌ Ошибка при отправке: ${result.message || 'Неизвестная ошибка'}`
    );
  }
}

async function sendAnswerDecision(deps, payload) {
  const { logger, saveUserData, createAuthCallback, EncounterAPI, sendMessage } = deps;
  const { platform, userId, user, decision, queryId, answerCb } = payload;

  logger.info(
    `Пользователь выбрал: отправить "${decision.answer}" в уровень ${decision.newLevel}`
  );

  user.pendingAnswerDecision = null;
  await saveUserData();

  if (queryId) {
    await answerCb({
      queryId,
      text: `Отправка ответа в уровень ${decision.newLevel}...`
    });
  }

  const authCallback = await createAuthCallback(user, EncounterAPI, saveUserData);
  const api = new EncounterAPI(user.domain, authCallback);

  try {
    const result = await api.sendAnswer(
      user.gameId,
      decision.answer,
      user.authCookies,
      user.login,
      user.password
    );

    if (result.success) {
      const levelInfo = await resolveLevelInfo(deps, user, api, result);
      const update = buildLevelUpdate(levelInfo);

      if (update) {
        user.lastKnownLevel = update;
        logger.info(
          `📌 Обновлен lastKnownLevel после подтверждения: уровень ${update.levelNumber} (ID: ${update.levelId})`
        );
      }

      await saveUserData();
    }

    await notifySendOutcome(deps, { platform, userId, decision, result });

    if (result.newCookies) {
      user.authCookies = { ...(user.authCookies || {}), ...(result.newCookies || {}) };
      await saveUserData();
    }
  } catch (error) {
    logger.error('Ошибка отправки ответа после подтверждения:', error);
    await sendMessage(platform, userId, `❌ Ошибка отправки: ${error.message}`);
  }
}

async function cancelAnswerDecision(deps, payload) {
  const { logger, saveUserData, createAuthCallback, EncounterAPI, sendMessage } = deps;
  const { platform, userId, user, decision, queryId, answerCb } = payload;

  logger.info(`🚫 Пользователь выбрал: отменить отправку "${decision.answer}"`);

  user.pendingAnswerDecision = null;

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
        `📌 Обновлен lastKnownLevel после отмены ответа: уровень ${gameState.data.Level.Number} (ID: ${gameState.data.Level.LevelId})`
      );
    }
  } catch (error) {
    logger.error('⚠️ Ошибка обновления lastKnownLevel при отмене:', error.message);
  }

  await saveUserData();

  if (queryId) {
    await answerCb({
      queryId,
      text: '🚫 Ответ отменён'
    });
  }

  await sendMessage(
    platform,
    userId,
    `🚫 Ответ "${decision.answer}" отменён\n\n` +
      `(Был подготовлен для уровня ${decision.oldLevel}, текущий уровень — ${decision.newLevel})`
  );
}

function createAnswerCallbackHandler(deps) {
  const { getPlatformUser } = deps;

  return {
    matches(action) {
      return action === 'answer_send' || action === 'answer_cancel';
    },

    async handle(action, context) {
      const { platform, userId, queryId, answerCb } = context;

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

      if (action === 'answer_send') {
        await sendAnswerDecision(deps, {
          platform,
          userId,
          user,
          decision,
          queryId,
          answerCb
        });
        return;
      }

      await cancelAnswerDecision(deps, {
        platform,
        userId,
        user,
        decision,
        queryId,
        answerCb
      });
    }
  };
}

module.exports = {
  createAnswerCallbackHandler
};
