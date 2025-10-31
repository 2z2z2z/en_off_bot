const HOUR_MS = 60 * 60 * 1000;

function createRuntimeMaintenance(options) {
  const {
    userRepository,
    logger,
    intervalHours = 6,
    timestampTtlMs = 24 * HOUR_MS,
    inactiveDays = 30
  } = options;

  let timerId = null;
  let running = false;

  async function runCleanupCycle() {
    if (running) {
      return;
    }

    running = true;
    try {
      const cleaned = await userRepository.cleanupOldTimestamps(timestampTtlMs);
      const deleted = await userRepository.deleteInactiveStates(inactiveDays);

      if (cleaned > 0 || deleted > 0) {
        logger.info(
          `[runtime-maintenance] Очистка завершена: обновлено ${cleaned}, удалено ${deleted} записей`
        );
      }
    } catch (error) {
      logger.error('[runtime-maintenance] Ошибка при очистке runtime-state:', error);
    } finally {
      running = false;
    }
  }

  function start() {
    const interval = Math.max(intervalHours, 1) * HOUR_MS;
    timerId = setInterval(runCleanupCycle, interval);
    timerId.unref?.();
    // Первая очистка без ожидания.
    runCleanupCycle().catch(() => {});
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
  createRuntimeMaintenance
};
