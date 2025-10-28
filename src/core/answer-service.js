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

  async function sendToEncounterAPI(user, answer) {
    try {
      const api = new EncounterAPI(user.domain);

      if (!user.authCookies || Object.keys(user.authCookies).length === 0) {
        console.log(`🔐 Нет cookies, выполняем авторизацию для ${user.login}...`);
        console.log(`🎮 Данные игры: домен=${user.domain}, ID=${user.gameId}`);

        const authResult = await api.authenticate(user.login, user.password);
        if (authResult.success) {
          user.authCookies = authResult.cookies;
          await saveUserData();
          console.log(`✅ Авторизация успешна для ${user.login}`);
        } else {
          throw new Error(`Ошибка авторизации: ${authResult.message}`);
        }
      } else {
        console.log(`🔑 Используем сохраненные cookies для ${user.login}`);
      }

      const result = await api.sendAnswer(user.gameId, answer, user.authCookies, user.login, user.password);

      if (result.newCookies) {
        console.log('🔄 Cookies обновлены после автоматической реаутентификации');
        user.authCookies = result.newCookies;
        await saveUserData();
      }

      if (result.success) {
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
        enqueueAnswer(platform, userId, {
          answer,
          timestamp: Date.now()
        });
        user.isOnline = false;
        await saveUserData();

        await sendMessage(platform, userId, `🔄 Нет соединения. Ответ "${answer}" добавлен в очередь.`);
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

  async function processAnswerQueue(platform, userId) {
    const user = getUserInfo(platform, userId);
    const queue = getAnswerQueue(platform, userId);

    if (queue.length === 0) {
      return;
    }

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

    for (let i = 0; i < queue.length; i++) {
      const queueItem = queue[i];
      processed++;

      await sendOrUpdateMessage(platform, userId,
        `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n⏳ Отправляю "${queueItem.answer}"...`,
        queueMessage.message_id
      );

      try {
        const response = await sendToEncounterAPI(user, queueItem.answer);

        if (response.success) {
          successful++;
          queue.splice(i, 1);
          i--;

          await sendOrUpdateMessage(platform, userId,
            `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n✅ Ответ отправлен`,
            queueMessage.message_id
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

          await sendOrUpdateMessage(platform, userId,
            `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n⚠️ Пропущен устаревший ответ`,
            queueMessage.message_id
          );

          queue.splice(i, 1);
          i--;
        } else if (isAuthError) {
          console.log(`🔒 Проблема авторизации в очереди: ${error.message}`);

          await sendOrUpdateMessage(platform, userId,
            `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n🔒 Переавторизация для "${queueItem.answer}"...`,
            queueMessage.message_id
          );

          try {
            user.authCookies = null;
            await saveUserData();

            await new Promise(resolve => setTimeout(resolve, 2000));

            await sendOrUpdateMessage(platform, userId,
              `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n🔄 Повторяю "${queueItem.answer}"...`,
              queueMessage.message_id
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
          await sendOrUpdateMessage(platform, userId,
            `❌ Ошибка обработки очереди: ${error.message}\n📊 Обработано: ${successful}/${totalAnswers}`,
            queueMessage.message_id
          );
          break;
        }
      }

      if (i < queue.length - 1 || processed < totalAnswers) {
        console.log('⏱️ Задержка 1.2 секунды перед следующим ответом...');
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
    }

    if (queue.length === 0) {
      user.isOnline = true;

      let finalMessage = `✅ Обработка очереди завершена!\n📊 Результат: ${successful} отправлено`;
      if (skipped > 0) {
        finalMessage += `, ${skipped} пропущено`;
      }
      finalMessage += ` из ${totalAnswers}`;

      await sendOrUpdateMessage(platform, userId, finalMessage, queueMessage.message_id);
    }

    await saveUserData();
  }

  return {
    sendToEncounterAPI,
    sendAnswerToEncounter,
    processAnswerQueue
  };
}

module.exports = {
  createAnswerService
};




