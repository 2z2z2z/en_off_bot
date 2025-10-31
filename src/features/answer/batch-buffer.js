const {
  MESSAGE_INTERVAL_MAX,
  getAccumulationSlice
} = require('./burst-detector');

/**
 * @typedef {Object} BatchBufferDeps
 * @property {Function} getPlatformUser
 * @property {Function} getSendAnswerToEncounter
 * @property {import('../../infra/logger').logger} logger
 */

/**
 * Управляет буфером быстрых ответов (burst) и их отложенной обработкой.
 * @param {BatchBufferDeps} deps
 */
function createBatchBuffer(deps) {
  const { getPlatformUser, getSendAnswerToEncounter, logger } = deps;

  function ensureBurstBuffer(user) {
    if (!Array.isArray(user.pendingBurstAnswers)) {
      user.pendingBurstAnswers = [];
    }
  }

  function clearBurstTimer(user) {
    if (user.pendingBurstTimer) {
      clearTimeout(user.pendingBurstTimer);
      user.pendingBurstTimer = null;
    }
  }

  function resetBurstState(user) {
    if (!user) {
      return;
    }
    clearBurstTimer(user);
    if (Array.isArray(user.pendingBurstAnswers)) {
      user.pendingBurstAnswers.length = 0;
    } else {
      user.pendingBurstAnswers = [];
    }
    user._burstProcessing = false;
    user._burstProcessingRequested = false;
  }

  function scheduleBurstTimer(platform, userId, user, delay, triggerBurstProcessing) {
    clearBurstTimer(user);
    const timeout = Math.max(delay, 0);
    user.pendingBurstTimer = setTimeout(() => {
      user.pendingBurstTimer = null;
      triggerBurstProcessing(platform, userId).catch(error => {
        logger.error('[burst] Ошибка повторной обработки:', error);
      });
    }, timeout);
  }

  async function processPendingEntry(platform, userId, entry) {
    if (!entry) {
      return;
    }

    try {
      const sendAnswerToEncounter = getSendAnswerToEncounter();
      const result = await sendAnswerToEncounter(
        platform,
        userId,
        entry.answer,
        entry.progressMessageId
      );
      entry.resolve?.(result);
    } catch (error) {
      logger.error('[burst] Ошибка обработки ответа из буфера:', error);
      entry.resolve?.(null);
    }
  }

  async function drainAllPending(platform, userId, user) {
    clearBurstTimer(user);
    while (user.pendingBurstAnswers && user.pendingBurstAnswers.length > 0) {
      const entry = user.pendingBurstAnswers.shift();
      // eslint-disable-next-line no-await-in-loop
      await processPendingEntry(platform, userId, entry);
    }
  }

  function createTriggerBurstProcessing() {
    const trigger = async function triggerBurstProcessing(platform, userId) {
      const user = getPlatformUser(platform, userId);
      if (!user) {
        return;
      }

      ensureBurstBuffer(user);

      if (user._burstProcessing) {
        user._burstProcessingRequested = true;
        return;
      }

      user._burstProcessing = true;

      try {
        while (user.pendingBurstAnswers && user.pendingBurstAnswers.length > 0) {
          if (user.isAccumulatingAnswers) {
            await drainAllPending(platform, userId, user);
            continue;
          }

          const accumulationSlice = getAccumulationSlice(user.pendingBurstAnswers);
          if (accumulationSlice) {
            const spanMs =
              accumulationSlice[accumulationSlice.length - 1].timestamp -
              accumulationSlice[0].timestamp;
            logger.info(
              `🔍 Детект оффлайн-пачки: ${
                accumulationSlice.length
              } сообщений за ${(spanMs / 1000).toFixed(2)}с`
            );

            user.isAccumulatingAnswers = true;
            user.accumulatedAnswers = user.accumulatedAnswers || [];
            user.accumulationStartLevel =
              user.accumulationStartLevel || user.lastKnownLevel || null;
            logger.info(
              `📦 Режим накопления активирован (уровень: ${user.accumulationStartLevel?.levelNumber || '?'})`
            );

            await drainAllPending(platform, userId, user);
            continue;
          }

          const oldest = user.pendingBurstAnswers[0];
          const now = Date.now();
          const elapsed = now - oldest.timestamp;

          if (elapsed >= MESSAGE_INTERVAL_MAX) {
            const entry = user.pendingBurstAnswers.shift();
            // eslint-disable-next-line no-await-in-loop
            await processPendingEntry(platform, userId, entry);
            continue;
          }

          scheduleBurstTimer(
            platform,
            userId,
            user,
            MESSAGE_INTERVAL_MAX - elapsed,
            triggerBurstProcessing
          );
          break;
        }

        if (!user.pendingBurstAnswers || user.pendingBurstAnswers.length === 0) {
          clearBurstTimer(user);
        }
      } finally {
        user._burstProcessing = false;
        if (user._burstProcessingRequested) {
          user._burstProcessingRequested = false;
          await triggerBurstProcessing(platform, userId);
        }
      }
    };

    return trigger;
  }

  const triggerBurstProcessing = createTriggerBurstProcessing();

  function queueAnswerForProcessing(platform, userId, user, answer, progressMessageId) {
    ensureBurstBuffer(user);
    const timestamp = Date.now();

    return new Promise(resolve => {
      user.pendingBurstAnswers.push({
        answer,
        timestamp,
        progressMessageId,
        resolve
      });

      triggerBurstProcessing(platform, userId).catch(error => {
        logger.error('[burst] Ошибка запуска обработки:', error);
        resolve(null);
      });
    });
  }

  return {
    queueAnswerForProcessing,
    resetBurstState,
    clearBurstTimer
  };
}

module.exports = {
  createBatchBuffer
};
