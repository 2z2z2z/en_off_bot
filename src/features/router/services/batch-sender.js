const DEFAULT_DELAY_MS = 1200;

async function buildApi(deps, user) {
  const authCallback = await deps.createAuthCallback(user, deps.EncounterAPI, deps.saveUserData);
  return new deps.EncounterAPI(user.domain, authCallback);
}

async function fetchCurrentLevel(api, user) {
  const state = await api.getGameState(
    user.gameId,
    user.authCookies,
    user.login,
    user.password
  );

  if (!state.success || !state.data?.Level) {
    throw new Error('Не удалось получить состояние игры');
  }

  const level = state.data.Level;
  const normalizeCount = value => {
    if (value === undefined || value === null) {
      return null;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };

  return {
    id: level.LevelId,
    number: level.Number,
    passed: normalizeCount(level.PassedSectorsCount),
    required: normalizeCount(level.RequiredSectorsCount)
  };
}

async function promptOnLevelChange(deps, payload) {
  const { platform, userId, totalCodes, startLevel, currentLevel } = payload;
  const codesList = startLevel.codes
    .slice(0, 5)
    .map((item, index) => `${index + 1}. "${item.answer}"`)
    .join('\n');
  const moreCodesText = totalCodes > 5 ? `\n... и ещё ${totalCodes - 5}` : '';

  const messageText =
    `⚠️ Уровень изменился (${startLevel.levelNumber} → ${currentLevel.number})\n\n` +
    `Накоплено ${totalCodes} ${
      totalCodes === 1 ? 'код' : totalCodes < 5 ? 'кода' : 'кодов'
    }:\n${codesList}${moreCodesText}\n\n` +
    `Что делать?`;

  const options = deps.createInlineKeyboard(platform, [
    [
      { text: `✅ Отправить в уровень ${currentLevel.number}`, action: 'batch_send_force' },
      { text: '🚫 Отменить', action: 'batch_cancel_all' }
    ]
  ]);

  await deps.sendMessage(platform, userId, messageText, options);
}

async function ensureLevelBeforeSend(deps, payload) {
  const { platform, userId, user, api, startLevel, totalCodes } = payload;
  deps.logger.info('🔍 Проверка уровня ПЕРЕД отправкой пачки...');
  const currentLevel = await fetchCurrentLevel(api, user);

  deps.logger.info(
    `📋 Уровень на момент накопления: ${startLevel?.levelNumber} (ID: ${startLevel?.levelId})`
  );
  deps.logger.info(`📋 Текущий уровень: ${currentLevel.number} (ID: ${currentLevel.id})`);

  if (startLevel?.levelId && currentLevel.id !== startLevel.levelId) {
    deps.logger.info(
      `⚠️ Уровень изменился (${startLevel.levelNumber} → ${currentLevel.number}), спрашиваем пользователя`
    );

    await promptOnLevelChange(deps, {
      platform,
      userId,
      totalCodes,
      startLevel: { ...startLevel, codes: user.accumulatedAnswers },
      currentLevel
    });

    return { status: 'abort' };
  }

  return {
    status: 'ready',
    currentLevel,
    latestPassed: currentLevel.passed,
    latestRequired: currentLevel.required
  };
}

function buildProgressMessage(deps, payload) {
  const { progress, total, answer, statusText, levelNumber, passed, required } = payload;
  const sectorsText = passed === null || required === null ? '—' : `${passed}/${required}`;
  return deps.formatBatchProgress({
    progress,
    total,
    answer,
    statusText,
    levelNumber,
    sectorsText
  });
}

function normalizeLevelCounters(level) {
  if (!level) {
    return { passed: null, required: null };
  }

  const normalize = value => {
    if (value === undefined || value === null) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };

  return {
    passed: normalize(level.PassedSectorsCount),
    required: normalize(level.RequiredSectorsCount)
  };
}

async function finalizeSuccess(deps, payload) {
  const { platform, userId, progressMessageId, sentCodes, sent, total } = payload;

  let finalReport = `✅ Пачка отправлена!\n\n📊 Отправлено: ${sent}/${total}`;

  if (sentCodes.length > 0) {
    finalReport += `\n\n📋 Детальный отчет:\n\n`;
    sentCodes.forEach((code, index) => {
      const num = index + 1;
      finalReport += `${num}. "${code.answer}"\n`;
      const levelDisplay = code.levelNumber ?? '—';
      finalReport += `   ${code.statusText} | Уровень: ${levelDisplay}\n`;
      if (index < sentCodes.length - 1) {
        finalReport += `\n`;
      }
    });

    const lastCode = sentCodes[sentCodes.length - 1];
    const levelSummary = lastCode.levelNumber ?? '—';
    finalReport += `\n📍 Текущий уровень: ${levelSummary}`;
    if (lastCode.sectors && lastCode.sectors !== '—') {
      finalReport += `\n📊 Текущие сектора: ${lastCode.sectors}`;
    }
  }

  await deps.sendOrUpdateMessage(platform, userId, finalReport, progressMessageId);
}

async function updateUserAfterSend(deps, user) {
  user.accumulatedAnswers = [];
  user.isAccumulatingAnswers = false;
  user.accumulationStartLevel = null;
  if (user.accumulationTimer) {
    clearTimeout(user.accumulationTimer);
    user.accumulationTimer = null;
  }
  await deps.saveUserData();
}

function buildSentCodeStats({ answer, statusText, level, passed, required }) {
  const sectors = passed === null || required === null ? '—' : `${passed}/${required}`;
  return {
    answer,
    statusText,
    levelNumber: level?.Number ?? null,
    levelName: level?.Name || 'N/A',
    sectors
  };
}

/* eslint-disable-next-line complexity */
async function sendAccumulatedCodes(deps, payload) {
  const { platform, userId, user, api, currentLevel, progressMessage } = payload;

  let latestLevelNumber = currentLevel.number;
  let latestPassed = currentLevel.passed;
  let latestRequired = currentLevel.required;
  let sent = 0;
  let stopped = false;
  const sentCodes = [];
  const buffer = [...user.accumulatedAnswers];

  for (let index = 0; index < buffer.length; index += 1) {
    const item = buffer[index];
    const processed = index + 1;

    deps.logger.info(`📤 Отправка кода ${processed}/${buffer.length}: "${item.answer}"`);

    const progressMessageBody = buildProgressMessage(deps, {
      progress: processed,
      total: buffer.length,
      answer: item.answer,
      statusText: '⏳ Отправляю...',
      levelNumber: latestLevelNumber,
      passed: latestPassed,
      required: latestRequired
    });

    await deps.sendOrUpdateMessage(platform, userId, progressMessageBody, progressMessage.message_id);

    try {
      const result = await api.sendAnswer(
        user.gameId,
        item.answer,
        user.authCookies,
        user.login,
        user.password,
        false,
        currentLevel.id
      );

      const statusText = result.success
        ? deps.formatStatusText(result.message)
        : `❌ ${result.message || 'Не отправлен'}`;

      if (result.success) {
        sent += 1;

        if (result.level) {
          latestLevelNumber = result.level.Number ?? latestLevelNumber;
          const { passed, required } = normalizeLevelCounters(result.level);
          latestPassed = passed;
          latestRequired = required;
        }

        if (result.newCookies) {
          user.authCookies = { ...(user.authCookies || {}), ...(result.newCookies || {}) };
          await deps.saveUserData();
        }
      }

      const statusMessage = buildProgressMessage(deps, {
        progress: processed,
        total: buffer.length,
        answer: item.answer,
        statusText,
        levelNumber: latestLevelNumber,
        passed: latestPassed,
        required: latestRequired
      });

      await deps.sendOrUpdateMessage(platform, userId, statusMessage, progressMessage.message_id);

      sentCodes.push(
        buildSentCodeStats({
          answer: item.answer,
          statusText,
          level: result.level,
          passed: latestPassed,
          required: latestRequired
        })
      );

      if (result.level && result.level.LevelId !== currentLevel.id) {
        deps.logger.info(
          `⚠️ Уровень изменился во время отправки (${currentLevel.number} → ${result.level.Number})`
        );
        stopped = true;
        user.accumulatedAnswers.splice(0, sent);
        await deps.saveUserData();

        const remaining = buffer.length - sent;
        const remainingList = user.accumulatedAnswers
          .slice(0, 5)
          .map(code => `"${code.answer}"`)
          .join(', ');
        const moreText = remaining > 5 ? ` и ещё ${remaining - 5}` : '';

        const messageText =
          `⚠️ Уровень изменился во время отправки!\n\n` +
          `📊 Отправлено: ${sent}/${buffer.length}\n` +
          `📦 Осталось: ${remaining}\n\n` +
          `Оставшиеся коды: ${remainingList}${moreText}\n\n` +
          `Что делать с оставшимися кодами?`;

        const options = deps.createInlineKeyboard(platform, [
          [
            { text: `✅ Отправить в уровень ${result.level.Number}`, action: 'batch_send_force' },
            { text: '🚫 Отменить', action: 'batch_cancel_all' }
          ]
        ]);

        await deps.sendMessage(platform, userId, messageText, options);
        break;
      }
    } catch (error) {
      deps.logger.error(`❌ Ошибка отправки кода "${item.answer}":`, error.message);

      if (error instanceof deps.LevelChangedError || error.isLevelChanged) {
        stopped = true;
        user.accumulatedAnswers.splice(0, sent);
        await deps.saveUserData();

        await deps.sendMessage(
          platform,
          userId,
          `⚠️ Уровень изменился во время отправки!\n\n` +
            `📊 Отправлено: ${sent}/${buffer.length}\n` +
            `📦 Осталось: ${buffer.length - sent}\n\n` +
            `Используйте кнопки выше для выбора.`
        );
        break;
      }

      const statusText = `❌ Ошибка: ${error.message}`;
      const statusMessage = buildProgressMessage(deps, {
        progress: processed,
        total: buffer.length,
        answer: item.answer,
        statusText,
        levelNumber: latestLevelNumber,
        passed: latestPassed,
        required: latestRequired
      });

      await deps.sendOrUpdateMessage(platform, userId, statusMessage, progressMessage.message_id);

      sentCodes.push(
        buildSentCodeStats({
          answer: item.answer,
          statusText,
          level: null,
          passed: latestPassed,
          required: latestRequired
        })
      );
    }

    if (index < buffer.length - 1) {
      deps.logger.info('⏱️ Задержка 1.2 секунды перед следующим кодом...');
      await new Promise(resolve => setTimeout(resolve, DEFAULT_DELAY_MS));
    }
  }

  return { stopped, sent, total: buffer.length, sentCodes };
}

function createBatchSender(deps) {
  const { logger, getPlatformUser } = deps;

  return async function processBatchSend(platform, userId) {
    const user = getPlatformUser(platform, userId);

    if (!Array.isArray(user.accumulatedAnswers) || user.accumulatedAnswers.length === 0) {
      logger.info('⚠️ Нет накопленных кодов для отправки');
      await deps.sendMessage(platform, userId, '⚠️ Нет накопленных кодов');
      return;
    }

    const totalCodes = user.accumulatedAnswers.length;
    const startLevel = user.accumulationStartLevel;

    logger.info(
      `📤 Начало отправки пачки: ${totalCodes} кодов (уровень на момент накопления: ${
        startLevel?.levelNumber || '?'
      })`
    );

    try {
      const api = await buildApi(deps, user);

      const checkResult = await ensureLevelBeforeSend(deps, {
        platform,
        userId,
        user,
        api,
        startLevel,
        totalCodes
      });

      if (checkResult.status === 'abort') {
        return;
      }

      logger.info('✅ Уровень не изменился, начинаем отправку');

      const initialMessage = buildProgressMessage(deps, {
        progress: 0,
        total: totalCodes,
        answer: user.accumulatedAnswers[0]?.answer ?? '—',
        statusText: '⏳ Подготовка...',
        levelNumber: checkResult.currentLevel.number,
        passed: checkResult.latestPassed,
        required: checkResult.latestRequired
      });

      const progressMessage = await deps.sendMessage(platform, userId, initialMessage);

      const sendResult = await sendAccumulatedCodes(deps, {
        platform,
        userId,
        user,
        api,
        currentLevel: checkResult.currentLevel,
        progressMessage
      });

      if (sendResult.stopped) {
        return;
      }

      await updateUserAfterSend(deps, user);

      await finalizeSuccess(deps, {
        platform,
        userId,
        progressMessageId: progressMessage.message_id,
        sentCodes: sendResult.sentCodes,
        sent: sendResult.sent,
        total: sendResult.total
      });
    } catch (error) {
      logger.error('Ошибка отправки пачки:', error);
      await deps.sendMessage(platform, userId, `❌ Ошибка отправки пачки: ${error.message}`);
    }
  };
}

module.exports = {
  createBatchSender
};


