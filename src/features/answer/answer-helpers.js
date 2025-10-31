const { LevelChangedError } = require('../../core/encounter-errors');
const { createInlineKeyboard } = require('../../presentation/keyboard-factory');

const PLURAL_FORMS = ['ответ', 'ответа', 'ответов'];

function formatAnswersCount(count) {
  if (count === 1) {
    return PLURAL_FORMS[0];
  }
  if (count >= 2 && count <= 4) {
    return PLURAL_FORMS[1];
  }
  return PLURAL_FORMS[2];
}

function updateLastKnownLevel(user, levelData, logger) {
  if (levelData && levelData.levelId && levelData.levelNumber !== undefined) {
    user.lastKnownLevel = {
      levelId: levelData.levelId,
      levelNumber: levelData.levelNumber,
      timestamp: Date.now()
    };
    logger?.info?.(
      `📌 Сохранен уровень ${levelData.levelNumber} (ID: ${levelData.levelId})`
    );
  }
}

async function checkPendingDecisions({ user, platform, userId, sendMessage }) {
  if (!user) {
    throw new Error('user is required for pending decision check');
  }

  if (user.pendingQueueDecision) {
    const decision = user.pendingQueueDecision;
    await sendMessage(
      platform,
      userId,
      `⚠️ Сначала решите судьбу старой очереди!\n\n` +
        `У вас есть ${decision.queueSize} ${formatAnswersCount(decision.queueSize)} ` +
        `для уровня ${decision.oldLevelNumber}, а текущий уровень — ${decision.newLevelNumber}.\n\n` +
        `Используйте кнопки под сообщением с выбором.`
    );
    return { blocked: true, reason: 'queue' };
  }

  if (user.pendingAnswerDecision) {
    const decision = user.pendingAnswerDecision;
    await sendMessage(
      platform,
      userId,
      `⚠️ Сначала решите судьбу предыдущего ответа!\n\n` +
        `Ответ "${decision.answer}" готовился для уровня ${decision.oldLevel}, ` +
        `но текущий уровень — ${decision.newLevel}.\n\n` +
        `Используйте кнопки под сообщением с выбором.`
    );
    return { blocked: true, reason: 'answer' };
  }

  return { blocked: false };
}

async function detectLevelChange({
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
}) {
  const isLevelChange = error instanceof LevelChangedError || error?.isLevelChanged;

  if (!isLevelChange) {
    return false;
  }

  const oldLevel = error?.oldLevel ?? '?';
  const newLevel = error?.newLevel ?? '?';

  logger?.info(
    `⚠️ ЗАЩИТА СРАБОТАЛА: Уровень изменился (${oldLevel} → ${newLevel}) для ответа "${answer}"`
  );

  user.pendingAnswerDecision = {
    answer,
    oldLevel,
    newLevel
  };
  await saveUserData();

  const options = createInlineKeyboard(platform, [
    [
      { text: `Отправить в уровень ${newLevel}`, action: 'answer_send' },
      { text: 'Отменить', action: 'answer_cancel' }
    ]
  ]);

  const messageText =
    `⚠️ Уровень изменился (${oldLevel} → ${newLevel})\n\n` +
    `Ответ "${answer}" готовился для уровня ${oldLevel}, ` +
    `но текущий уровень — ${newLevel}.\n\n` +
    `Что делать?`;

  await updateProgressMessage({
    platform,
    userId,
    text: messageText,
    progressMessageId,
    options,
    sendMessage,
    sendOrUpdateMessage
  });

  return true;
}

async function retryWithBackoff({
  answer,
  retryCount,
  maxRetries,
  user,
  platform,
  userId,
  progressMessageId,
  saveUserData,
  sendMessage,
  sendOrUpdateMessage,
  logger,
  retryFn
}) {
  if (retryCount >= maxRetries) {
    logger?.error(`❌ Достигнут максимум попыток (${maxRetries}) для ответа "${answer}"`);
    await updateProgressMessage({
      platform,
      userId,
      text: `❌ Не удалось отправить ответ "${answer}" после ${maxRetries + 1} попыток. Попробуйте позже.`,
      progressMessageId,
      sendMessage,
      sendOrUpdateMessage
    });
    return null;
  }

  const attemptNumber = retryCount + 1;
  logger?.info(
    `🔒 Переавторизация для ответа "${answer}" (попытка ${attemptNumber}/${maxRetries + 1})`
  );

  if (progressMessageId) {
    await updateProgressMessage({
      platform,
      userId,
      text: `🔒 Переавторизация для "${answer}" (попытка ${attemptNumber})...`,
      progressMessageId,
      sendMessage,
      sendOrUpdateMessage
    });
  }

  try {
    user.authCookies = null;
    await saveUserData();

    const backoffDelay = Math.pow(2, retryCount) * 1000;
    logger?.info(
      `⏱️ Exponential backoff: ждём ${backoffDelay}ms перед попыткой ${attemptNumber + 1}`
    );
    await new Promise(resolve => setTimeout(resolve, backoffDelay));

    logger?.info(
      `🔄 Повторная попытка ${attemptNumber + 1} отправки "${answer}" после переавторизации`
    );

    if (progressMessageId) {
      await updateProgressMessage({
        platform,
        userId,
        text: `🔄 Повторяю отправку "${answer}" (попытка ${attemptNumber + 1})...`,
        progressMessageId,
        sendMessage,
        sendOrUpdateMessage
      });
    }

    return await retryFn(retryCount + 1);
  } catch (retryError) {
    logger?.error('Ошибка повторной попытки:', retryError);

    const isMessageNotModifiedError =
      retryError.code === 'ETELEGRAM' &&
      retryError.response?.body?.description?.includes('message is not modified');

    if (!isMessageNotModifiedError) {
      await updateProgressMessage({
        platform,
        userId,
        text: `❌ Не удалось переавторизоваться: ${retryError.message}`,
        progressMessageId,
        sendMessage,
        sendOrUpdateMessage
      });
    }

    return null;
  }
}

async function updateProgressMessage({
  platform,
  userId,
  text,
  progressMessageId,
  options,
  sendMessage,
  sendOrUpdateMessage
}) {
  if (progressMessageId) {
    return sendOrUpdateMessage(platform, userId, text, progressMessageId, options);
  }
  return sendMessage(platform, userId, text, options);
}

async function handleCookieUpdate({ result, user, saveUserData, logger }) {
  if (!result?.newCookies) {
    return false;
  }

  logger?.info('🔄 Cookies обновлены после автоматической реаутентификации');
  user.authCookies = {
    ...(user.authCookies || {}),
    ...(result.newCookies || {})
  };
  await saveUserData();
  return true;
}

module.exports = {
  checkPendingDecisions,
  detectLevelChange,
  retryWithBackoff,
  updateProgressMessage,
  handleCookieUpdate,
  updateLastKnownLevel
};
