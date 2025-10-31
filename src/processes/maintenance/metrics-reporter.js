const MINUTE_MS = 60 * 1000;

function createMetricsReporter(options) {
  const {
    userData,
    logger,
    intervalMinutes = 5
  } = options;

  let timerId = null;
  let running = false;

  function collectMetrics() {
    if (!userData || typeof userData.values !== 'function') {
      return null;
    }

    const snapshot = Array.from(userData.values());
    const totalUsers = snapshot.length;

    let onlineUsers = 0;
    let totalQueueSize = 0;
    let totalAccumulated = 0;
    let pendingDecisions = 0;
    let processingQueues = 0;
    let accumulating = 0;

    snapshot.forEach(user => {
      if (!user) {
        return;
      }

      if (user.isOnline) {
        onlineUsers += 1;
      }

      if (Array.isArray(user.answerQueue)) {
        totalQueueSize += user.answerQueue.length;
      }

      if (Array.isArray(user.accumulatedAnswers)) {
        totalAccumulated += user.accumulatedAnswers.length;
      }

      if (user.pendingQueueDecision || user.pendingAnswerDecision) {
        pendingDecisions += 1;
      }

      if (user.isProcessingQueue) {
        processingQueues += 1;
      }

      if (user.isAccumulatingAnswers) {
        accumulating += 1;
      }
    });

    return {
      totalUsers,
      onlineUsers,
      totalQueueSize,
      totalAccumulated,
      pendingDecisions,
      processingQueues,
      accumulating
    };
  }

  function formatMetrics(metrics) {
    return (
      `[metrics] users=${metrics.totalUsers} (online=${metrics.onlineUsers}) | ` +
      `queue=${metrics.totalQueueSize} | accumulated=${metrics.totalAccumulated} | ` +
      `pendingDecisions=${metrics.pendingDecisions} | processing=${metrics.processingQueues} | ` +
      `accumulating=${metrics.accumulating}`
    );
  }

  async function runCycle() {
    if (running) {
      return;
    }

    running = true;
    try {
      const metrics = collectMetrics();
      if (metrics) {
        logger.info(formatMetrics(metrics));
      }
    } catch (error) {
      logger.error('[metrics] Ошибка сбора метрик:', error);
    } finally {
      running = false;
    }
  }

  function start() {
    const interval = Math.max(intervalMinutes, 1) * MINUTE_MS;
    timerId = setInterval(runCycle, interval);
    timerId.unref?.();
    runCycle().catch(() => {});
  }

  function stop() {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
  }

  return {
    start,
    stop
  };
}

module.exports = {
  createMetricsReporter
};
