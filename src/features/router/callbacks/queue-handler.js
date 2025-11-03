const ACTIONS = new Set(['queue_send', 'queue_clear']);

function createQueueCallbackHandler(deps) {
  const { logger, getPlatformUser, getAnswerQueue, saveUserData, processAnswerQueue, sendMessage } =
    deps;

  return {
    matches(action) {
      return ACTIONS.has(action);
    },

    async handle(action, context) {
      const { platform, userId, queryId, answerCb } = context;

      const user = getPlatformUser(platform, userId);
      const queue = getAnswerQueue(platform, userId);

      if (!user.pendingQueueDecision) {
        if (queryId) {
          await answerCb({
            queryId,
            text: '⚠️ Нет активного выбора',
            show_alert: true
          });
        }
        return;
      }

      const decision = user.pendingQueueDecision;

      if (action === 'queue_send') {
        logger.info(`✅ Пользователь выбрал: отправить ${queue.length} ответов в новый уровень`);

        user.pendingQueueDecision = null;
        await saveUserData();

        if (queryId) {
          await answerCb({
            queryId,
            text: `Отправка ${queue.length} ${queue.length === 1 ? 'ответа' : 'ответов'} в уровень ${decision.newLevelNumber}...`
          });
        }

        await sendMessage(
          platform,
          userId,
          `Обработка очереди из ${queue.length} ${queue.length === 1 ? 'ответа' : 'ответов'}...`
        );

        await processAnswerQueue(platform, userId);
        return;
      }

      if (action === 'queue_clear') {
        const clearedAnswers = queue
          .slice(0, 5)
          .map(item => `"${item.answer}"`)
          .join(', ');
        const moreAnswers = queue.length > 5 ? ` и ещё ${queue.length - 5}` : '';

        logger.info(`🗑️ Пользователь выбрал: очистить ${queue.length} ответов`);

        queue.length = 0;
        user.pendingQueueDecision = null;
        await saveUserData();

        if (queryId) {
          await answerCb({
            queryId,
            text: '🗑️ Очередь очищена'
          });
        }

        await sendMessage(
          platform,
          userId,
          `🗑️ Очередь очищена (уровень ${decision.oldLevelNumber} → ${decision.newLevelNumber})\n\n` +
            `Пропущено ${decision.queueSize} ${decision.queueSize === 1 ? 'ответ' : decision.queueSize < 5 ? 'ответа' : 'ответов'}: ${clearedAnswers}${moreAnswers}`
        );
      }
    }
  };
}

module.exports = {
  createQueueCallbackHandler
};

