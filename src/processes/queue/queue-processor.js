const MAX_UNKNOWN_ERROR_ATTEMPTS = 3;
const INITIAL_DELAY_MS = 3000;
const ITEM_DELAY_MS = 1200;
const PROGRESS_UPDATE_EVERY = 4;
const PROGRESS_UPDATE_MIN_INTERVAL = 5000;

/**
 * @typedef {Object} QueueProcessorDeps
 * @property {Function} createAuthCallback
 * @property {Function} EncounterAPI
 * @property {Function} sendMessage
 * @property {Function} sendOrUpdateMessage
 * @property {Function} saveUserData
 * @property {Function} getUserInfo
 * @property {Function} getAnswerQueue
 * @property {Function} sendToEncounterAPI
 * @property {Function} updateLastKnownLevel
 * @property {import('../../infra/logger').logger} logger
 */

function createDecisionOptions(platform, levelNumber) {
  if (platform === 'telegram') {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `Отправить в уровень ${levelNumber}`,
              callback_data: 'queue_send'
            },
            { text: 'Очистить очередь', callback_data: 'queue_clear' }
          ]
        ]
      }
    };
  }

  if (platform === 'vk') {
    return {
      keyboard: {
        type: 'inline',
        buttons: [
          [
            {
              label: `Отправить в уровень ${levelNumber}`,
              payload: { action: 'queue_send' }
            },
            { label: 'Очистить очередь', payload: { action: 'queue_clear' } }
          ]
        ]
      }
    };
  }

  return {};
}

function formatDecisionMessage(queue, queuedLevelNumber, currentLevelNumber) {
  const answersList = queue
    .slice(0, 5)
    .map(item => `• "${item.answer}"`)
    .join('\n');
  const moreAnswers = queue.length > 5 ? `\n... и ещё ${queue.length - 5}` : '';
  const noun =
    queue.length === 1 ? 'ответ' : queue.length < 5 ? 'ответа' : 'ответов';

  return (
    `⚠️ Уровень изменился${
      queuedLevelNumber ? ` (${queuedLevelNumber} → ${currentLevelNumber})` : ''
    }\n\n` +
    `В очереди ${queue.length} ${noun}:\n${answersList}${moreAnswers}\n\n` +
    `Что делать?`
  );
}

function createProgressReporter({ platform, userId, messageId, sendOrUpdateMessage }) {
  let progressUpdatesSinceLastSend = 0;
  let lastProgressUpdateAt = Date.now();
  let pendingProgressText = null;

  async function push(text, { force = false } = {}) {
    pendingProgressText = text;
    progressUpdatesSinceLastSend += 1;

    const now = Date.now();
    const shouldSend =
      force ||
      now - lastProgressUpdateAt >= PROGRESS_UPDATE_MIN_INTERVAL ||
      progressUpdatesSinceLastSend >= PROGRESS_UPDATE_EVERY;

    if (!shouldSend) {
      return;
    }

    await sendOrUpdateMessage(platform, userId, pendingProgressText, messageId);
    lastProgressUpdateAt = Date.now();
    progressUpdatesSinceLastSend = 0;
    pendingProgressText = null;
  }

  async function flush() {
    if (pendingProgressText) {
      await push(pendingProgressText, { force: true });
    }
  }

  return {
    push,
    flush
  };
}

async function sleep(ms) {
  if (ms <= 0) {
    return;
  }
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @param {QueueProcessorDeps} deps
 */
function createQueueProcessor(deps) {
  const {
    createAuthCallback,
    EncounterAPI,
    sendMessage,
    sendOrUpdateMessage,
    saveUserData,
    getUserInfo,
    getAnswerQueue,
    sendToEncounterAPI,
    updateLastKnownLevel,
    logger
  } = deps;

  async function ensureQueueLevelConsistency({ platform, userId, user, queue }) {
    if (!queue.length || queue[0].levelId === undefined) {
      return { shouldStop: false };
    }

    logger.info(`🔍 Проверка актуальности очереди (сохранён levelId: ${queue[0].levelId})`);

    try {
      const authCallback = await createAuthCallback(user);
      const api = new EncounterAPI(user.domain, authCallback);
      const gameState = await api.getGameState(
        user.gameId,
        user.authCookies,
        user.login,
        user.password
      );

      if (!gameState.success || !gameState.data?.Level) {
        return { shouldStop: false };
      }

      const currentLevelId = gameState.data.Level.LevelId;
      const currentLevelNumber = gameState.data.Level.Number;
      const queuedLevelId = queue[0].levelId;
      const queuedLevelNumber = queue[0].levelNumber;

      updateLastKnownLevel(
        user,
        {
          levelId: currentLevelId,
          levelNumber: currentLevelNumber
        },
        logger
      );

      logger.info(`🎯 Текущий уровень: ${currentLevelNumber} (ID: ${currentLevelId})`);
      logger.info(
        `📦 Уровень в очереди: ${queuedLevelNumber || '?'} (ID: ${queuedLevelId || 'null'})`
      );

      if (queuedLevelId === null || currentLevelId !== queuedLevelId) {
        logger.info(`⚠️ Уровень изменился! Требуется решение пользователя.`);

        user.pendingQueueDecision = {
          oldLevelNumber: queuedLevelNumber || '?',
          newLevelNumber: currentLevelNumber,
          queueSize: queue.length
        };
        user.isProcessingQueue = false;
        await saveUserData();

        await sendMessage(
          platform,
          userId,
          formatDecisionMessage(queue, queuedLevelNumber, currentLevelNumber),
          createDecisionOptions(platform, currentLevelNumber)
        );

        return { shouldStop: true };
      }
    } catch (error) {
      logger.error('⚠️ Ошибка проверки актуальности уровня:', error.message);
    }

    return { shouldStop: false };
  }

  async function initializeProcessing({ platform, userId, queue }) {
    const queueMessage = await sendMessage(
      platform,
      userId,
      `🔄 Подготовка к обработке очереди из ${queue.length} ответов...`
    );

    logger.info('⏱️ Задержка 3 секунды перед началом обработки очереди...');
    await sleep(INITIAL_DELAY_MS);

    await sendOrUpdateMessage(
      platform,
      userId,
      `🔄 Обрабатываю очередь из ${queue.length} ответов...`,
      queueMessage.message_id
    );

    const reporter = createProgressReporter({
      platform,
      userId,
      messageId: queueMessage.message_id,
      sendOrUpdateMessage
    });

    return { queueMessage, reporter };
  }

  function isIgnorableError(message) {
    const patterns = [
      'event не определен',
      'неизвестная ошибка игры',
      'уровень изменился',
      'некорректные данные'
    ];

    return patterns.some(pattern => message.includes(pattern));
  }

  function isAuthError(message) {
    const patterns = ['требуется повторная авторизация', 'сессия истекла'];
    return patterns.some(pattern => message.includes(pattern));
  }

  async function handleAuthError({ user, queueItem, reporter }) {
    logger.info(`🔒 Проблема авторизации в очереди: ${queueItem.answer}`);

    await reporter.push(
      `🔄 Обрабатываю очередь: ${queueItem.processed}/${queueItem.total}\n🔒 Переавторизация для "${queueItem.answer}"...`,
      { force: true }
    );

    user.authCookies = null;
    await saveUserData();
    await sleep(2000);

    await reporter.push(
      `🔄 Обрабатываю очередь: ${queueItem.processed}/${queueItem.total}\n🔄 Повторяю "${queueItem.answer}"...`,
      { force: true }
    );
  }

  async function handleQueueItem({ context, queue, index, metrics, reporter }) {
    const { user } = context;
    const queueItem = queue[index];
    const totalAnswers = metrics.total;

    metrics.processed += 1;

    await reporter.push(
      `🔄 Обрабатываю очередь: ${metrics.processed}/${totalAnswers}\n⏳ Отправляю "${queueItem.answer}"...`,
      { force: metrics.processed === 1 }
    );

    try {
      const response = await sendToEncounterAPI(user, queueItem.answer);

      if (!response.success) {
        throw new Error('Ошибка отправки');
      }

      metrics.successful += 1;
      queue.splice(index, 1);

      await reporter.push(
        `🔄 Обрабатываю очередь: ${metrics.processed}/${totalAnswers}\n✅ Ответ отправлен`
      );

      return { adjustIndex: -1 };
    } catch (error) {
      logger.error('Ошибка обработки очереди:', error);
      const normalized = error.message?.toLowerCase?.() || '';

      if (isIgnorableError(normalized)) {
        logger.info(`⚠️ Пропускаем ответ "${queueItem.answer}" из-за устаревших данных`);
        metrics.skipped += 1;
        queue.splice(index, 1);

        await reporter.push(
          `🔄 Обрабатываю очередь: ${metrics.processed}/${totalAnswers}\n⚠️ Пропущен устаревший ответ`,
          { force: true }
        );

        return { adjustIndex: -1 };
      }

      if (isAuthError(normalized)) {
        await handleAuthError({
          user,
          queueItem: { answer: queueItem.answer, processed: metrics.processed, total: totalAnswers },
          reporter
        });
        metrics.processed -= 1; // откатываем счётчик для повторной попытки
        return { adjustIndex: 0, retry: true };
      }

      const errorDetails = error.message || 'Неизвестная ошибка';
      queueItem.failedAttempts = (queueItem.failedAttempts || 0) + 1;
      queueItem.lastError = errorDetails;

      if (queueItem.failedAttempts >= MAX_UNKNOWN_ERROR_ATTEMPTS) {
        logger.info(
          `🗑️ Удаляем ответ "${queueItem.answer}" после ${MAX_UNKNOWN_ERROR_ATTEMPTS} неудачных попыток`
        );
        metrics.skipped += 1;
        queue.splice(index, 1);

        await reporter.push(
          `🔄 Обрабатываю очередь: ${metrics.processed}/${totalAnswers}\n⚠️ Ошибка для "${queueItem.answer}": ${errorDetails}\n🗑️ Ответ удалён после ${MAX_UNKNOWN_ERROR_ATTEMPTS} неудачных попыток`,
          { force: true }
        );

        return { adjustIndex: -1 };
      }

      await reporter.push(
        `🔄 Обрабатываю очередь: ${metrics.processed}/${totalAnswers}\n⚠️ Ошибка для "${queueItem.answer}": ${errorDetails}\n🔁 Попытка ${queueItem.failedAttempts}/${MAX_UNKNOWN_ERROR_ATTEMPTS} — оставляю в очереди`,
        { force: true }
      );

      return { adjustIndex: 0 };
    }
  }

  function buildFinalMessage({ successful, skipped, total, queue }) {
    if (queue.length === 0) {
      let finalMessage = `✅ Обработка очереди завершена!\n📊 Результат: ${successful} отправлено`;
      if (skipped > 0) {
        finalMessage += `, ${skipped} пропущено`;
      }
      finalMessage += ` из ${total}`;
      return finalMessage;
    }

    const remainingWithErrors = queue.filter(item => item.failedAttempts);
    let finalMessage = `⚠️ Обработка очереди завершена с ошибками.\n📊 Отправлено: ${successful}/${total}`;
    if (skipped > 0) {
      finalMessage += `, удалено: ${skipped}`;
    }
    finalMessage += `\n⏳ В очереди осталось: ${queue.length}`;
    if (remainingWithErrors.length > 0) {
      const failedList = remainingWithErrors
        .map(item => `"${item.answer}" (${item.failedAttempts} попыток)`)
        .join(', ');
      finalMessage += `\n⚠️ Требуют внимания: ${failedList}`;
    }

    return finalMessage;
  }

  async function processQueueItems(context) {
    const { platform, userId, queue } = context;
    const metrics = {
      total: queue.length,
      processed: 0,
      successful: 0,
      skipped: 0
    };

    const { queueMessage, reporter } = await initializeProcessing(context);

    let index = 0;
    while (index < queue.length) {
      const result = await handleQueueItem({
        context,
        queue,
        index,
        metrics,
        reporter
      });

      if (result.retry) {
        // повторяем тот же индекс
        await reporter.flush();
        continue;
      }

      index += 1 + (result.adjustIndex || 0);
      if (index < queue.length) {
        await reporter.flush();
        await sleep(ITEM_DELAY_MS);
      }
    }

    await reporter.flush();

    const finalMessage = buildFinalMessage({
      successful: metrics.successful,
      skipped: metrics.skipped,
      total: metrics.total,
      queue
    });

    await sendOrUpdateMessage(platform, userId, finalMessage, queueMessage.message_id);

    return metrics;
  }

  async function processAnswerQueue(platform, userId) {
    const user = getUserInfo(platform, userId);
    const queue = getAnswerQueue(platform, userId);

    if (!queue || queue.length === 0) {
      return;
    }

    if (user.isProcessingQueue) {
      logger.info(`⏭️ Очередь уже обрабатывается для ${platform}:${userId}`);
      return;
    }

    user.isProcessingQueue = true;

    try {
      const levelCheck = await ensureQueueLevelConsistency({ platform, userId, user, queue });
      if (levelCheck.shouldStop) {
        return;
      }

      await processQueueItems({ platform, userId, user, queue });
    } finally {
      user.isProcessingQueue = false;
      await saveUserData();
    }
  }

  return {
    processAnswerQueue
  };
}

module.exports = {
  createQueueProcessor
};
