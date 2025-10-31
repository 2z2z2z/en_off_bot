/** @typedef {import('./contracts').AnswerDeliveryDeps} AnswerDeliveryDeps */
/** @typedef {import('./contracts').AnswerDeliveryAPI} AnswerDeliveryAPI */

const {
  detectLevelChange,
  retryWithBackoff,
  updateProgressMessage,
  handleCookieUpdate,
  updateLastKnownLevel
} = require('./answer-helpers');
const {
  AuthRequiredError,
  NetworkError,
  LevelChangedError,
  EncounterError
} = require('../../core/encounter-errors');
const { createInlineKeyboard } = require('../../presentation/keyboard-factory');

const ACCUMULATION_TIMEOUT_MS = 5000;
const MAX_RETRIES = 2;

function formatQueueDecisionText(decision) {
  const { queueSize, oldLevelNumber, newLevelNumber } = decision;
  return (
    `⚠️ Сначала решите судьбу старой очереди!\n\n` +
    `У вас есть ${queueSize} ${
      queueSize === 1 ? 'ответ' : queueSize < 5 ? 'ответа' : 'ответов'
    } ` +
    `для уровня ${oldLevelNumber}, а текущий уровень — ${newLevelNumber}.\n\n` +
    `Используйте кнопки под сообщением с выбором.`
  );
}

function formatAnswerDecisionText(decision) {
  return (
    `⚠️ Сначала решите судьбу предыдущего ответа!\n\n` +
    `Ответ "${decision.answer}" готовился для уровня ${decision.oldLevel}, ` +
    `но текущий уровень — ${decision.newLevel}.\n\n` +
    `Используйте кнопки под сообщением с выбором.`
  );
}

function buildSuccessMessage(answer, response) {
  let message = `📤 Ответ "${answer}" отправлен на уровень №${response.levelNumber}\n${response.message}`;

  if (response.level?.Name) {
    message += `\n📝 Уровень: ${response.level.Name}`;
    if (
      response.level.PassedSectorsCount !== undefined &&
      response.level.RequiredSectorsCount !== undefined
    ) {
      message += `\n📊 Сектора: ${response.level.PassedSectorsCount}/${response.level.RequiredSectorsCount}`;
    }
  }

  return message;
}

function createAccumulationNotice(answer, count) {
  return `📦 Код "${answer}" добавлен в буфер (${count})`;
}

function classifyError(error) {
  if (error instanceof LevelChangedError) {
    return 'level-change';
  }

  if (error instanceof AuthRequiredError) {
    return 'auth';
  }

  if (error instanceof NetworkError) {
    if (error.code === 'IP_BLOCKED') {
      return 'critical';
    }
    return 'network';
  }

  if (error instanceof EncounterError && error.code === 'IP_BLOCKED') {
    return 'critical';
  }

  const normalizedMessage = error.message?.toLowerCase?.() || '';

  if (
    normalizedMessage.includes('ip заблокирован') ||
    normalizedMessage.includes('слишком много запросов')
  ) {
    return 'critical';
  }

  if (
    normalizedMessage.includes('econnrefused') ||
    normalizedMessage.includes('enotfound') ||
    normalizedMessage.includes('etimedout') ||
    normalizedMessage.includes('network') ||
    normalizedMessage.includes('timeout')
  ) {
    return 'network';
  }

  if (
    normalizedMessage.includes('повторная авторизация') ||
    normalizedMessage.includes('сессия истекла')
  ) {
    return 'auth';
  }

  return 'generic';
}

function createDecisionButtons(platform, levelNumber) {
  return createInlineKeyboard(platform, [
    [
      { text: `Отправить в уровень ${levelNumber}`, action: 'queue_send' },
      { text: 'Очистить очередь', action: 'queue_clear' }
    ]
  ]);
}

function createAccumulationButtons(platform) {
  return createInlineKeyboard(platform, [
    [
      { text: '✅ Отправить все', action: 'batch_send_all' },
      { text: '🚫 Отменить все', action: 'batch_cancel_all' }
    ],
    [{ text: '📋 Список', action: 'batch_list' }]
  ]);
}

/**
 * @param {AnswerDeliveryDeps} deps
 * @returns {AnswerDeliveryAPI}
 */
function createAnswerDelivery(deps) {
  const {
    ensureAuthenticated,
    createAuthCallback,
    getUserInfo,
    sendMessage,
    sendOrUpdateMessage,
    saveUserData,
    enqueueAnswer,
    logger,
    EncounterAPI
  } = deps;

  async function sendToEncounterAPI(user, answer) {
    const authCallback = await createAuthCallback(user);
    const api = new EncounterAPI(user.domain, authCallback);

    await ensureAuthenticated(user, EncounterAPI, saveUserData);

    const expectedLevelId = user.lastKnownLevel?.levelId || null;
    logger.info(
      `📌 Ожидаемый уровень для ответа "${answer}": ${
        expectedLevelId ? `ID=${expectedLevelId}` : 'не установлен'
      }`
    );

    const result = await api.sendAnswer(
      user.gameId,
      answer,
      user.authCookies,
      user.login,
      user.password,
      false,
      expectedLevelId
    );

    await handleCookieUpdate({
      result,
      user,
      saveUserData,
      logger
    });

    if (result.success) {
      if (result.level) {
        updateLastKnownLevel(
          user,
          {
            levelId: result.level.LevelId,
            levelNumber: result.level.Number
          },
          logger
        );
      }
      logger.info(`✅ Ответ "${answer}" отправлен в игру ${user.gameId}. ${result.message}`);
      return result;
    }

    throw new Error(result.error || 'Не удалось отправить ответ');
  }

  async function handlePendingDecisions(platform, userId, user) {
    if (user.pendingQueueDecision) {
      await sendMessage(
        platform,
        userId,
        formatQueueDecisionText(user.pendingQueueDecision),
        createDecisionButtons(platform, user.pendingQueueDecision.newLevelNumber)
      );
      return true;
    }

    if (user.pendingAnswerDecision) {
      await sendMessage(
        platform,
        userId,
        formatAnswerDecisionText(user.pendingAnswerDecision)
      );
      return true;
    }

    return false;
  }

  function scheduleAccumulationCompletion(platform, userId, user) {
    if (user.accumulationTimer) {
      clearTimeout(user.accumulationTimer);
      logger.info(`⏱️ Таймер накопления сброшен`);
    }

    user.accumulationTimer = setTimeout(async () => {
      logger.info(`⏱️ Таймер накопления истёк - показываем кнопки`);
      await handleAccumulationComplete(platform, userId);
    }, ACCUMULATION_TIMEOUT_MS);
  }

  async function appendToAccumulation(platform, userId, user, answer, progressMessageId) {
    user.accumulatedAnswers = user.accumulatedAnswers || [];
    user.accumulatedAnswers.push({
      answer,
      timestamp: Date.now(),
      levelId: user.lastKnownLevel?.levelId || null,
      levelNumber: user.lastKnownLevel?.levelNumber || null
    });

    logger.info(`📦 Накопление: добавлен код "${answer}" (всего: ${user.accumulatedAnswers.length})`);

    scheduleAccumulationCompletion(platform, userId, user);

    await saveUserData();

    await updateProgressMessage({
      platform,
      userId,
      text: createAccumulationNotice(answer, user.accumulatedAnswers.length),
      progressMessageId,
      sendMessage,
      sendOrUpdateMessage
    });
  }

  async function handleSuccess(platform, userId, answer, response, progressMessageId) {
    await updateProgressMessage({
      platform,
      userId,
      text: buildSuccessMessage(answer, response),
      progressMessageId,
      sendMessage,
      sendOrUpdateMessage
    });
    return response;
  }

  async function handleCriticalError(platform, userId, error, progressMessageId) {
    logger.error(`🚫 Критическая ошибка блокировки: ${error.message}`);
    await updateProgressMessage({
      platform,
      userId,
      text: `🚫 ${error.message}\n\nБот временно заблокирован. Повторите попытку через 5-10 минут.`,
      progressMessageId,
      sendMessage,
      sendOrUpdateMessage
    });
    return null;
  }

  async function handleNetworkError(platform, userId, user, answer, error) {
    logger.warn(`🌐 Потеря соединения: ${error.message}`);

    if (user.pendingQueueDecision) {
      const oldQueueSize = user.answerQueue.length;
      const decision = user.pendingQueueDecision;

      logger.info(
        `🗑️ Автоочистка старой очереди (${oldQueueSize} ответов) из-за повторной потери связи`
      );

      user.answerQueue.length = 0;
      user.pendingQueueDecision = null;

      await sendMessage(
        platform,
        userId,
        `🗑️ Старая очередь автоматически очищена (потеря связи)\n\n` +
          `Было ${oldQueueSize} ${
            oldQueueSize === 1 ? 'ответ' : oldQueueSize < 5 ? 'ответа' : 'ответов'
          } ` +
          `для уровня ${decision.oldLevelNumber}.`
      );
    }

    const lastLevel = user.lastKnownLevel;

    enqueueAnswer(platform, userId, {
      answer,
      timestamp: Date.now(),
      levelId: lastLevel?.levelId || null,
      levelNumber: lastLevel?.levelNumber || null
    });
    user.isOnline = false;
    await saveUserData();

    let message = `🔄 Нет соединения. Ответ "${answer}" добавлен в очередь`;
    if (lastLevel?.levelNumber) {
      message += ` (Уровень ${lastLevel.levelNumber})`;
    }
    message +=
      '.\n⚠️ Если уровень сменится, нужно будет решить: отправить в новый уровень или очистить.';

    await sendMessage(platform, userId, message);
    return null;
  }

  async function handleAuthError(options) {
    const { retryFn, ...rest } = options;
    return retryWithBackoff({
      ...rest,
      maxRetries: MAX_RETRIES,
      retryFn: nextRetryCount => retryFn(nextRetryCount)
    });
  }

  async function handleGenericError(platform, userId, error, progressMessageId) {
    await updateProgressMessage({
      platform,
      userId,
      text: `❌ Ошибка: ${error.message}`,
      progressMessageId,
      sendMessage,
      sendOrUpdateMessage
    });
    return null;
  }

  async function handleErrorScenario({
    platform,
    userId,
    answer,
    progressMessageId,
    retryCount,
    user,
    error
  }) {
    const levelChangeHandled = await detectLevelChange({
      error,
      user,
      answer,
      platform,
      userId,
      progressMessageId,
      saveUserData,
      sendMessage,
      sendOrUpdateMessage,
      logger
    });

    if (levelChangeHandled) {
      return null;
    }

    const type = classifyError(error);

    if (type === 'critical') {
      return handleCriticalError(platform, userId, error, progressMessageId);
    }

    if (type === 'network') {
      return handleNetworkError(platform, userId, user, answer, error);
    }

    if (type === 'auth') {
      return handleAuthError({
        answer,
        retryCount,
        user,
        platform,
        userId,
        progressMessageId,
        saveUserData,
        sendMessage,
        sendOrUpdateMessage,
        logger,
        retryFn: nextRetryCount =>
          sendAnswerToEncounter(platform, userId, answer, progressMessageId, nextRetryCount)
      });
    }

    return handleGenericError(platform, userId, error, progressMessageId);
  }

  async function handleAccumulationComplete(platform, userId) {
    const user = getUserInfo(platform, userId);

    if (!user.accumulatedAnswers || user.accumulatedAnswers.length === 0) {
      logger.info(`⚠️ Нет накопленных кодов для ${platform}:${userId}`);
      user.isAccumulatingAnswers = false;
      user.accumulationTimer = null;
      await saveUserData();
      return;
    }

    const totalCodes = user.accumulatedAnswers.length;
    const startLevel = user.accumulationStartLevel;

    logger.info(
      `📋 Показываю пользователю ${totalCodes} накопленных кодов (уровень: ${
        startLevel?.levelNumber || '?'
      })`
    );

    const codesList = user.accumulatedAnswers
      .slice(0, 10)
      .map((item, index) => `${index + 1}. "${item.answer}"`)
      .join('\n');
    const moreCodesText = totalCodes > 10 ? `\n... и ещё ${totalCodes - 10}` : '';

    const messageText =
      `📦 Накоплено ${totalCodes} ${
        totalCodes === 1 ? 'код' : totalCodes < 5 ? 'кода' : 'кодов'
      }\n\n` +
      `${codesList}${moreCodesText}\n\n` +
      `Уровень на момент накопления: ${startLevel?.levelNumber || '?'}\n\n` +
      `Что делать с накопленными кодами?`;

    await sendMessage(platform, userId, messageText, createAccumulationButtons(platform));
  }

  async function sendAnswerToEncounter(
    platform,
    userId,
    answer,
    progressMessageId = null,
    retryCount = 0
  ) {
    const user = getUserInfo(platform, userId);

    const hasBlockingDecisions = await handlePendingDecisions(platform, userId, user);
    if (hasBlockingDecisions) {
      return null;
    }

    if (user.isAccumulatingAnswers) {
      await appendToAccumulation(platform, userId, user, answer, progressMessageId);
      return null;
    }

    try {
      const response = await sendToEncounterAPI(user, answer);
      return handleSuccess(platform, userId, answer, response, progressMessageId);
    } catch (error) {
      logger.error('Ошибка отправки ответа:', error);
      return handleErrorScenario({
        platform,
        userId,
        answer,
        progressMessageId,
        retryCount,
        user,
        error
      });
    }
  }

  return {
    sendAnswerToEncounter,
    handleAccumulationComplete,
    sendToEncounterAPI
  };
}

module.exports = {
  createAnswerDelivery
};
