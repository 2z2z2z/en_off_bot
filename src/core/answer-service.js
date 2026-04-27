const { ensureAuthenticated, createAuthCallback: createAuthCallbackHelper } = require('./auth-manager');

function createAnswerService(deps) {
  const {
    EncounterAPI,
    sendMessage,
    sendOrUpdateMessage,
    saveUserData,
    getUserInfo,
    getAnswerQueue,
    enqueueAnswer
  } = deps;

  /**
   * Обертка для createAuthCallback с передачей зависимостей
   */
  async function createAuthCallback(user) {
    return createAuthCallbackHelper(user, EncounterAPI, saveUserData);
  }

  /**
   * Обновление lastKnownLevel после успешного получения данных игры
   */
  function updateLastKnownLevel(user, levelData) {
    if (levelData && levelData.levelId && levelData.levelNumber !== undefined) {
      user.lastKnownLevel = {
        levelId: levelData.levelId,
        levelNumber: levelData.levelNumber,
        timestamp: Date.now()
      };
      console.log(`📌 Сохранен уровень ${levelData.levelNumber} (ID: ${levelData.levelId})`);
    }
  }

  async function sendToEncounterAPI(user, answer) {
    try {
      // Создаем API с callback авторизации
      const authCallback = await createAuthCallback(user);
      const api = new EncounterAPI(user.domain, authCallback);

      // Предварительная авторизация если нет cookies
      await ensureAuthenticated(user, EncounterAPI, saveUserData);

      // Передаем ожидаемый levelId для защиты от смены уровня
      const expectedLevelId = user.lastKnownLevel?.levelId || null;
      console.log(`📌 Ожидаемый уровень для ответа "${answer}": ${expectedLevelId ? `ID=${expectedLevelId}` : 'не установлен'}`);

      const result = await api.sendAnswer(user.gameId, answer, user.authCookies, user.login, user.password, false, expectedLevelId);

      if (result.newCookies) {
        console.log('🔄 Cookies обновлены после автоматической реаутентификации');
        user.authCookies = {
          ...(user.authCookies || {}),
          ...(result.newCookies || {})
        };
        await saveUserData();
      }

      if (result.success) {
        // Обновляем lastKnownLevel после успешной отправки
        if (result.level) {
          updateLastKnownLevel(user, {
            levelId: result.level.LevelId,
            levelNumber: result.level.Number
          });
        }
        console.log(`✅ Ответ "${answer}" отправлен в игру ${user.gameId}. ${result.message}`);
        return result;
      }

      throw new Error('Не удалось отправить ответ');
    } catch (error) {
      console.error('Ошибка API Encounter:', error.message);
      throw error;
    }
  }

  async function sendAnswerToEncounter(platform, userId, answer, progressMessageId = null, retryCount = 0) {
    const user = getUserInfo(platform, userId);
    const MAX_RETRIES = 2;

    // Блокируем новые ответы, если ожидается решение по старой очереди
    if (user.pendingQueueDecision) {
      const decision = user.pendingQueueDecision;
      await sendMessage(platform, userId,
        `⚠️ Сначала решите судьбу старой очереди!\n\n` +
        `У вас есть ${decision.queueSize} ${decision.queueSize === 1 ? 'ответ' : decision.queueSize < 5 ? 'ответа' : 'ответов'} ` +
        `для уровня ${decision.oldLevelNumber}, а текущий уровень — ${decision.newLevelNumber}.\n\n` +
        `Используйте кнопки под сообщением с выбором.`
      );
      return null;
    }

    // Блокируем новые ответы, если ожидается решение по текущему ответу
    if (user.pendingAnswerDecision) {
      const decision = user.pendingAnswerDecision;
      await sendMessage(platform, userId,
        `⚠️ Сначала решите судьбу предыдущего ответа!\n\n` +
        `Ответ "${decision.answer}" готовился для уровня ${decision.oldLevel}, ` +
        `но текущий уровень — ${decision.newLevel}.\n\n` +
        `Используйте кнопки под сообщением с выбором.`
      );
      return null;
    }

    // Режим накопления кодов (детект оффлайн-пачки)
    if (user.isAccumulatingAnswers) {
      // Добавляем код в буфер накопления
      user.accumulatedAnswers = user.accumulatedAnswers || [];
      user.accumulatedAnswers.push({
        answer,
        timestamp: Date.now(),
        levelId: user.lastKnownLevel?.levelId || null,
        levelNumber: user.lastKnownLevel?.levelNumber || null
      });

      console.log(`📦 Накопление: добавлен код "${answer}" (всего: ${user.accumulatedAnswers.length})`);

      // Сбрасываем и перезапускаем таймер завершения накопления
      if (user.accumulationTimer) {
        clearTimeout(user.accumulationTimer);
        console.log(`⏱️ Таймер накопления сброшен`);
      }

      // Устанавливаем таймер на 5 секунд тишины
      user.accumulationTimer = setTimeout(async () => {
        console.log(`⏱️ Таймер накопления истёк - показываем кнопки`);
        await handleAccumulationComplete(platform, userId);
      }, 5000);

      await saveUserData();

      // Уведомляем пользователя
      const accumulationNotice = `📦 Код "${answer}" добавлен в буфер (${user.accumulatedAnswers.length})`;
      if (progressMessageId) {
        await sendOrUpdateMessage(platform, userId, accumulationNotice, progressMessageId);
      } else {
        await sendMessage(platform, userId, accumulationNotice);
      }

      return null;
    }

    try {
      const response = await sendToEncounterAPI(user, answer);

      if (response.success) {
        let message = `📤 Ответ "${answer}" отправлен на уровень №${response.levelNumber}\n${response.message}`;

        if (response.level && response.level.Name) {
          message += `\n📝 Уровень: ${response.level.Name}`;
          if (response.level.PassedSectorsCount !== undefined && response.level.RequiredSectorsCount !== undefined) {
            message += `\n📊 Сектора: ${response.level.PassedSectorsCount}/${response.level.RequiredSectorsCount}`;
          }
        }

        await sendOrUpdateMessage(platform, userId, message, progressMessageId);
        return response;
      }

      throw new Error(response.error || 'Ошибка отправки ответа');
    } catch (error) {
      console.error('Ошибка отправки ответа:', error);

      // Приоритетная проверка: изменился ли уровень
      if (error.isLevelChanged) {
        console.log(`⚠️ ЗАЩИТА СРАБОТАЛА: Уровень изменился (${error.oldLevel} → ${error.newLevel}) для ответа "${answer}"`);

        // Сохраняем данные для выбора пользователя
        user.pendingAnswerDecision = {
          answer: answer,
          oldLevel: error.oldLevel,
          newLevel: error.newLevel
        };
        await saveUserData();

        const messageText =
          `⚠️ Уровень изменился (${error.oldLevel} → ${error.newLevel})\n\n` +
          `Ответ "${answer}" готовился для уровня ${error.oldLevel}, ` +
          `но текущий уровень — ${error.newLevel}.\n\n` +
          `Что делать?`;

        // Формируем кнопки выбора (универсальный формат для Telegram и VK)
        let options = {};

        if (platform === 'telegram') {
          options = {
            reply_markup: {
              inline_keyboard: [[
                { text: `Отправить в уровень ${error.newLevel}`, callback_data: 'answer_send' },
                { text: 'Отменить', callback_data: 'answer_cancel' }
              ]]
            }
          };
        } else if (platform === 'vk') {
          options = {
            keyboard: {
              type: 'inline',
              buttons: [[
                { label: `Отправить в уровень ${error.newLevel}`, payload: { action: 'answer_send' } },
                { label: 'Отменить', payload: { action: 'answer_cancel' } }
              ]]
            }
          };
        }

        await sendOrUpdateMessage(platform, userId, messageText, progressMessageId, options);
        return null;
      }

      const networkErrors = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'network', 'timeout'];
      const isNetworkError = networkErrors.some(errType =>
        error.code === errType || error.message.toLowerCase().includes(errType.toLowerCase())
      );

      const authErrors = ['Требуется повторная авторизация', 'сессия истекла'];
      const isAuthError = authErrors.some(errType =>
        error.message.toLowerCase().includes(errType.toLowerCase())
      );

      const criticalErrors = ['IP заблокирован', 'слишком много запросов'];
      const isCriticalError = criticalErrors.some(errType =>
        error.message.toLowerCase().includes(errType.toLowerCase())
      );

      if (isCriticalError) {
        console.error(`🚫 Критическая ошибка блокировки: ${error.message}`);
        await sendOrUpdateMessage(platform, userId,
          `🚫 ${error.message}\n\nБот временно заблокирован. Повторите попытку через 5-10 минут.`,
          progressMessageId
        );
        return null;
      }

      if (isNetworkError) {
        // Если есть нерешённая судьба старой очереди - автоочистка
        if (user.pendingQueueDecision) {
          const oldQueueSize = user.answerQueue.length;
          const decision = user.pendingQueueDecision;

          console.log(`🗑️ Автоочистка старой очереди (${oldQueueSize} ответов) из-за повторной потери связи`);

          user.answerQueue.length = 0; // Очищаем старую очередь
          user.pendingQueueDecision = null;

          await sendMessage(platform, userId,
            `🗑️ Старая очередь автоматически очищена (потеря связи)\n\n` +
            `Было ${oldQueueSize} ${oldQueueSize === 1 ? 'ответ' : oldQueueSize < 5 ? 'ответа' : 'ответов'} ` +
            `для уровня ${decision.oldLevelNumber}.`
          );
        }

        // Используем последний известный уровень вместо кеша
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
        message += '.\n⚠️ Если уровень сменится, нужно будет решить: отправить в новый уровень или очистить.';

        await sendMessage(platform, userId, message);
        return null;
      }

      if (isAuthError) {
        if (retryCount >= MAX_RETRIES) {
          console.error(`❌ Достигнут максимум попыток (${MAX_RETRIES}) для ответа "${answer}"`);
          await sendOrUpdateMessage(platform, userId,
            `❌ Не удалось отправить ответ "${answer}" после ${MAX_RETRIES + 1} попыток. Попробуйте позже.`,
            progressMessageId
          );
          return null;
        }

        console.log(`🔒 Переавторизация для ответа "${answer}" (попытка ${retryCount + 1}/${MAX_RETRIES + 1})`);

        if (progressMessageId) {
          await sendOrUpdateMessage(platform, userId,
            `🔒 Переавторизация для "${answer}" (попытка ${retryCount + 1})...`,
            progressMessageId
          );
        }

        try {
          user.authCookies = null;
          await saveUserData();

          const backoffDelay = Math.pow(2, retryCount) * 1000;
          console.log(`⏱️ Exponential backoff: ждём ${backoffDelay}ms перед попыткой ${retryCount + 2}`);
          await new Promise(resolve => setTimeout(resolve, backoffDelay));

          console.log(`🔄 Повторная попытка ${retryCount + 2} отправки "${answer}" после переавторизации`);

          if (progressMessageId) {
            await sendOrUpdateMessage(platform, userId,
              `🔄 Повторяю отправку "${answer}" (попытка ${retryCount + 2})...`,
              progressMessageId
            );
          }

          return await sendAnswerToEncounter(platform, userId, answer, progressMessageId, retryCount + 1);
        } catch (retryError) {
          console.error('Ошибка повторной попытки:', retryError);

          const isMessageNotModifiedError = retryError.code === 'ETELEGRAM' &&
            retryError.response?.body?.description?.includes('message is not modified');

          if (!isMessageNotModifiedError) {
            await sendOrUpdateMessage(platform, userId,
              `❌ Не удалось переавторизоваться: ${retryError.message}`,
              progressMessageId
            );
          }
          return null;
        }
      }

      await sendOrUpdateMessage(platform, userId, `❌ Ошибка: ${error.message}`, progressMessageId);
      return null;
    }
  }

  /**
   * Обработка завершения режима накопления кодов
   * Показывает пользователю список накопленных кодов и кнопки выбора
   */
  async function handleAccumulationComplete(platform, userId) {
    const user = getUserInfo(platform, userId);

    if (!user.accumulatedAnswers || user.accumulatedAnswers.length === 0) {
      console.log(`⚠️ Нет накопленных кодов для ${platform}:${userId}`);
      user.isAccumulatingAnswers = false;
      user.accumulationTimer = null;
      await saveUserData();
      return;
    }

    const totalCodes = user.accumulatedAnswers.length;
    const startLevel = user.accumulationStartLevel;

    console.log(`📋 Показываю пользователю ${totalCodes} накопленных кодов (уровень: ${startLevel?.levelNumber || '?'})`);

    // Формируем список кодов (показываем до 10 штук)
    const codesList = user.accumulatedAnswers
      .slice(0, 10)
      .map((item, index) => `${index + 1}. "${item.answer}"`)
      .join('\n');
    const moreCodesText = totalCodes > 10 ? `\n... и ещё ${totalCodes - 10}` : '';

    const messageText =
      `📦 Накоплено ${totalCodes} ${totalCodes === 1 ? 'код' : totalCodes < 5 ? 'кода' : 'кодов'}\n\n` +
      `${codesList}${moreCodesText}\n\n` +
      `Уровень на момент накопления: ${startLevel?.levelNumber || '?'}\n\n` +
      `Что делать с накопленными кодами?`;

    // Формируем кнопки выбора (универсальный формат для Telegram и VK)
    let options = {};

    if (platform === 'telegram') {
      options = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Отправить все', callback_data: 'batch_send_all' },
              { text: '🚫 Отменить все', callback_data: 'batch_cancel_all' }
            ],
            [
              { text: '📋 Список', callback_data: 'batch_list' }
            ]
          ]
        }
      };
    } else if (platform === 'vk') {
      options = {
        keyboard: {
          type: 'inline',
          buttons: [
            [
              { label: '✅ Отправить все', payload: { action: 'batch_send_all' } },
              { label: '🚫 Отменить все', payload: { action: 'batch_cancel_all' } }
            ],
            [
              { label: '📋 Список', payload: { action: 'batch_list' } }
            ]
          ]
        }
      };
    }

    await sendMessage(platform, userId, messageText, options);
  }

  async function processAnswerQueue(platform, userId) {
    const user = getUserInfo(platform, userId);
    const queue = getAnswerQueue(platform, userId);
    const MAX_UNKNOWN_ERROR_ATTEMPTS = 3;
    const MAX_AUTH_RETRY_ATTEMPTS = 2;

    if (!queue || queue.length === 0) {
      return;
    }

    if (user.isProcessingQueue) {
      console.log(`⏭️ Очередь уже обрабатывается для ${platform}:${userId}`);
      return;
    }

    user.isProcessingQueue = true;

    try {
      // Проверяем актуальность уровня перед обработкой очереди
      if (queue.length > 0 && queue[0].levelId !== undefined) {
        console.log(`🔍 Проверка актуальности очереди (сохранён levelId: ${queue[0].levelId})`);

        try {
          // Создаем API с callback авторизации для проверки уровня
          const authCallback = await createAuthCallback(user);
          const api = new EncounterAPI(user.domain, authCallback);
          const gameState = await api.getGameState(user.gameId, user.authCookies, user.login, user.password);

          if (gameState.success && gameState.data && gameState.data.Level) {
            const currentLevelId = gameState.data.Level.LevelId;
            const currentLevelNumber = gameState.data.Level.Number;
            const queuedLevelId = queue[0].levelId;
            const queuedLevelNumber = queue[0].levelNumber;

            // Обновляем lastKnownLevel после успешного получения состояния игры
            updateLastKnownLevel(user, {
              levelId: currentLevelId,
              levelNumber: currentLevelNumber
            });

            console.log(`🎯 Текущий уровень: ${currentLevelNumber} (ID: ${currentLevelId})`);
            console.log(`📦 Уровень в очереди: ${queuedLevelNumber || '?'} (ID: ${queuedLevelId || 'null'})`);

            // Если уровень сменился ИЛИ в очереди был null
            if (queuedLevelId === null || currentLevelId !== queuedLevelId) {
              console.log(`⚠️ Уровень изменился! Требуется решение пользователя.`);

              // Сохраняем данные для выбора
              user.pendingQueueDecision = {
                oldLevelNumber: queuedLevelNumber || '?',
                newLevelNumber: currentLevelNumber,
                queueSize: queue.length
              };
              user.isProcessingQueue = false;
              await saveUserData();

              // Формируем список ответов для показа
              const answersList = queue.slice(0, 5).map(item => `• "${item.answer}"`).join('\n');
              const moreAnswers = queue.length > 5 ? `\n... и ещё ${queue.length - 5}` : '';

              const messageText =
                `⚠️ Уровень изменился${queuedLevelNumber ? ` (${queuedLevelNumber} → ${currentLevelNumber})` : ''}\n\n` +
                `В очереди ${queue.length} ${queue.length === 1 ? 'ответ' : queue.length < 5 ? 'ответа' : 'ответов'}:\n${answersList}${moreAnswers}\n\n` +
                `Что делать?`;

              // Формируем кнопки выбора (универсальный формат для Telegram и VK)
              let options = {};

              if (platform === 'telegram') {
                options = {
                  reply_markup: {
                    inline_keyboard: [[
                      { text: `Отправить в уровень ${currentLevelNumber}`, callback_data: 'queue_send' },
                      { text: 'Очистить очередь', callback_data: 'queue_clear' }
                    ]]
                  }
                };
              } else if (platform === 'vk') {
                options = {
                  keyboard: {
                    type: 'inline',
                    buttons: [[
                      { label: `Отправить в уровень ${currentLevelNumber}`, payload: { action: 'queue_send' } },
                      { label: 'Очистить очередь', payload: { action: 'queue_clear' } }
                    ]]
                  }
                };
              }

              await sendMessage(platform, userId, messageText, options);

              return;
            }

            console.log(`✅ Уровень не изменился, продолжаем обработку`);
          }
        } catch (error) {
          console.error('⚠️ Ошибка проверки актуальности уровня:', error.message);
          // Продолжаем обработку несмотря на ошибку проверки
        }
      }
    } catch (error) {
      user.isProcessingQueue = false;
      throw error;
    }

    try {
      const totalAnswers = queue.length;
      let processed = 0;
      let successful = 0;
      let skipped = 0;

      const queueMessage = await sendMessage(platform,
        userId,
        `🔄 Подготовка к обработке очереди из ${totalAnswers} ответов...`
      );

      console.log('⏱️ Задержка 3 секунды перед началом обработки очереди...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      await sendOrUpdateMessage(platform, userId,
        `🔄 Обрабатываю очередь из ${totalAnswers} ответов...`,
        queueMessage.message_id
      );

      const PROGRESS_UPDATE_EVERY = 4;
      const PROGRESS_UPDATE_MIN_INTERVAL = 5000;
      let progressUpdatesSinceLastSend = 0;
      let lastProgressUpdateAt = Date.now();
      let pendingProgressText = null;

      async function pushProgress(text, { force = false } = {}) {
        pendingProgressText = text;
        progressUpdatesSinceLastSend += 1;

        const now = Date.now();
        const shouldSend =
          force ||
          (now - lastProgressUpdateAt) >= PROGRESS_UPDATE_MIN_INTERVAL ||
          progressUpdatesSinceLastSend >= PROGRESS_UPDATE_EVERY;

        if (!shouldSend) {
          return;
        }

        await sendOrUpdateMessage(platform, userId, pendingProgressText, queueMessage.message_id);
        lastProgressUpdateAt = Date.now();
        progressUpdatesSinceLastSend = 0;
        pendingProgressText = null;
      }

      for (let i = 0; i < queue.length; i++) {
        const queueItem = queue[i];
        processed++;

        await pushProgress(
          `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n⏳ Отправляю "${queueItem.answer}"...`,
          { force: processed === 1 }
        );

        try {
          const response = await sendToEncounterAPI(user, queueItem.answer);

          if (response.success) {
            successful++;
            queue.splice(i, 1);
            i--;

            await pushProgress(
              `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n✅ Ответ отправлен`
            );
          } else {
            throw new Error('Ошибка отправки');
          }
        } catch (error) {
          console.error('Ошибка обработки очереди:', error);

          const ignorableErrors = [
            'Event не определен',
            'Неизвестная ошибка игры',
            'Уровень изменился',
            'некорректные данные'
          ];

          const authErrors = [
            'Требуется повторная авторизация',
            'сессия истекла'
          ];

          const errorMessage = error.message?.toLowerCase?.() || '';
          const isIgnorableError = ignorableErrors.some(errType => errorMessage.includes(errType.toLowerCase()));
          const isAuthError = authErrors.some(errType => errorMessage.includes(errType.toLowerCase()));

          if (isIgnorableError) {
            console.log(`⚠️ Пропускаем ответ "${queueItem.answer}" из-за устаревших данных`);
            skipped++;

            await pushProgress(
              `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n⚠️ Пропущен устаревший ответ`,
              { force: true }
            );

            queue.splice(i, 1);
            i--;
          } else if (isAuthError) {
            queueItem.authRetries = (queueItem.authRetries || 0) + 1;

            if (queueItem.authRetries > MAX_AUTH_RETRY_ATTEMPTS) {
              console.log(`🚫 Переавторизация для "${queueItem.answer}" не удалась после ${MAX_AUTH_RETRY_ATTEMPTS} попыток - удаляем из очереди`);
              skipped++;

              await pushProgress(
                `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n🚫 Не удалось переавторизоваться для "${queueItem.answer}" - ответ удалён`,
                { force: true }
              );

              queue.splice(i, 1);
              i--;
              continue;
            }

            console.log(`🔒 Проблема авторизации в очереди (попытка ${queueItem.authRetries}/${MAX_AUTH_RETRY_ATTEMPTS}): ${error.message}`);

            await pushProgress(
              `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n🔒 Переавторизация для "${queueItem.answer}" (${queueItem.authRetries}/${MAX_AUTH_RETRY_ATTEMPTS})...`,
              { force: true }
            );

            try {
              user.authCookies = null;
              await saveUserData();

              await new Promise(resolve => setTimeout(resolve, 2000));

              await pushProgress(
                `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n🔄 Повторяю "${queueItem.answer}"...`,
                { force: true }
              );

              i--;
              processed--;

              console.log(`🔄 Повторяем отправку ответа "${queueItem.answer}" после переавторизации`);
            } catch (authError) {
              console.error('Ошибка переавторизации в очереди:', authError);

              const isMessageNotModifiedError = authError.code === 'ETELEGRAM' &&
                authError.response?.body?.description?.includes('message is not modified');

              if (!isMessageNotModifiedError) {
                console.log(`⚠️ Пропускаем ответ "${queueItem.answer}" из-за ошибки переавторизации`);
              }

              skipped++;
              queue.splice(i, 1);
              i--;
            }
          } else {
            const errorDetails = error.message || 'Неизвестная ошибка';
            queueItem.failedAttempts = (queueItem.failedAttempts || 0) + 1;
            queueItem.lastError = errorDetails;

            if (queueItem.failedAttempts >= MAX_UNKNOWN_ERROR_ATTEMPTS) {
              console.log(`🗑️ Удаляем ответ "${queueItem.answer}" после ${MAX_UNKNOWN_ERROR_ATTEMPTS} неудачных попыток`);
              skipped++;

              await pushProgress(
                `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n⚠️ Ошибка для "${queueItem.answer}": ${errorDetails}\n🗑️ Ответ удалён после ${MAX_UNKNOWN_ERROR_ATTEMPTS} неудачных попыток`,
                { force: true }
              );

              queue.splice(i, 1);
              i--;
            } else {
              await pushProgress(
                `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n⚠️ Ошибка для "${queueItem.answer}": ${errorDetails}\n🔁 Попытка ${queueItem.failedAttempts}/${MAX_UNKNOWN_ERROR_ATTEMPTS} — оставляю в очереди`,
                { force: true }
              );
            }
          }
        }

        if (i < queue.length - 1 || processed < totalAnswers) {
          console.log('⏱️ Задержка 1.2 секунды перед следующим ответом...');
          await new Promise(resolve => setTimeout(resolve, 1200));

          if (pendingProgressText) {
            await pushProgress(pendingProgressText);
          }
        }
      }

      if (pendingProgressText) {
        await pushProgress(pendingProgressText, { force: true });
      }

      if (queue.length === 0) {
        user.isOnline = true;

        let finalMessage = `✅ Обработка очереди завершена!\n📊 Результат: ${successful} отправлено`;
        if (skipped > 0) {
          finalMessage += `, ${skipped} пропущено`;
        }
        finalMessage += ` из ${totalAnswers}`;

        await sendOrUpdateMessage(platform, userId, finalMessage, queueMessage.message_id);
      } else {
        const remainingWithErrors = queue.filter(item => item.failedAttempts);
        let finalMessage = `⚠️ Обработка очереди завершена с ошибками.\n📊 Отправлено: ${successful}/${totalAnswers}`;
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

        await sendOrUpdateMessage(platform, userId, finalMessage, queueMessage.message_id);
      }
    } finally {
      user.isProcessingQueue = false;
      await saveUserData();
    }
  }

  return {
    sendToEncounterAPI,
    sendAnswerToEncounter,
    processAnswerQueue,
    handleAccumulationComplete
  };
}

module.exports = {
  createAnswerService
};
