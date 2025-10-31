const dotenv = require('dotenv');
const { logger } = require('../../infra/logger');
const {
  userData,
  loadUserData,
  saveUserData,
  setUserRepository
} = require('../../core/user-store');
const { loadAdminConfig } = require('../../services/admin-config');
const { TelegramAdapter } = require('../../platforms/telegram/telegram-adapter');
const { VkAdapter } = require('../../platforms/vk');
const { initializeSqlite } = require('../../infra/database/sqlite');
const { UserRepository } = require('../../entities/user/repository');
const { createRuntimeMaintenance } = require('../../processes/maintenance/runtime-maintenance');
const { createMetricsReporter } = require('../../processes/maintenance/metrics-reporter');

const CLEANUP_LOG_PREFIX = '[bootstrap]';

function resolveConfig() {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
  const VK_GROUP_TOKEN = process.env.VK_GROUP_TOKEN || '';
  const VK_GROUP_ID = process.env.VK_GROUP_ID ? Number(process.env.VK_GROUP_ID) : null;

  if (!BOT_TOKEN) {
    throw new Error('Не задан BOT_TOKEN. Добавьте токен бота в .env или переменные окружения.');
  }

  if (!ENCRYPTION_KEY) {
    throw new Error(
      'Не задан ENCRYPTION_KEY. Добавьте уникальный ключ шифрования в .env или переменные окружения.'
    );
  }

  return {
    encryptionKey: ENCRYPTION_KEY,
    telegram: {
      token: BOT_TOKEN
    },
    vk: {
      enabled: Boolean(VK_GROUP_TOKEN && VK_GROUP_ID),
      token: VK_GROUP_TOKEN,
      groupId: VK_GROUP_ID
    },
    rootUserId: Number(process.env.ROOT_USER_ID) || 197924096
  };
}

function cleanupStaleVkBuffers() {
  let clearedVkBuffers = 0;
  let clearedVkAnswers = 0;

  for (const user of userData.values()) {
    const isVkUser = user.platform === 'vk';
    const hasStaleAccumulation =
      user.isAccumulatingAnswers === true &&
      user.accumulationTimer == null &&
      Array.isArray(user.accumulatedAnswers) &&
      user.accumulatedAnswers.length > 0;

    if (!isVkUser || !hasStaleAccumulation) {
      continue;
    }

    const removed = user.accumulatedAnswers.length;
    user.accumulatedAnswers = [];
    user.isAccumulatingAnswers = false;
    user.accumulationStartLevel = null;
    user.accumulationTimer = null;
    user.recentMessageTimestamps = [];

    clearedVkBuffers += 1;
    clearedVkAnswers += removed;

    logger.info(
      `${CLEANUP_LOG_PREFIX} [vk] Очистка устаревшего буфера накопления для ${user.userId}: удалено ${removed} код(ов)`
    );
  }

  if (clearedVkBuffers > 0) {
    logger.info(
      `${CLEANUP_LOG_PREFIX} 🧹 Сброшено ${clearedVkBuffers} VK-буфер(ов) накопления (${clearedVkAnswers} кодов)`
    );
    return true;
  }

  return false;
}

async function bootstrap() {
  dotenv.config();

  const config = resolveConfig();

  await loadAdminConfig();

  const sqlite = await initializeSqlite({ log: logger });
  const userRepository = new UserRepository({ database: sqlite, logger });
  setUserRepository(userRepository);

  await loadUserData();

  const cleaned = cleanupStaleVkBuffers();
  if (cleaned) {
    await saveUserData();
  }

  const telegramAdapter = new TelegramAdapter({ token: config.telegram.token });
  const vkAdapter = config.vk.enabled
    ? new VkAdapter({ token: config.vk.token, groupId: config.vk.groupId })
    : null;

  const shutdownHandlers = [];

  const registerShutdown = handler => {
    if (typeof handler === 'function') {
      shutdownHandlers.push(handler);
    }
  };

  const maintenanceIntervalEnv = Number(process.env.RUNTIME_MAINTENANCE_INTERVAL_HOURS);
  const runtimeTtlEnv = Number(process.env.RUNTIME_STATE_TTL_HOURS);
  const inactiveDaysEnv = Number(process.env.RUNTIME_STATE_INACTIVE_DAYS);

  const maintenance = createRuntimeMaintenance({
    userRepository,
    logger,
    intervalHours:
      Number.isFinite(maintenanceIntervalEnv) && maintenanceIntervalEnv > 0
        ? maintenanceIntervalEnv
        : 6,
    timestampTtlMs:
      (Number.isFinite(runtimeTtlEnv) && runtimeTtlEnv > 0 ? runtimeTtlEnv : 24) * 60 * 60 * 1000,
    inactiveDays:
      Number.isFinite(inactiveDaysEnv) && inactiveDaysEnv > 0 ? inactiveDaysEnv : 30
  });
  maintenance.start();

  const metricsIntervalEnv = Number(process.env.METRICS_INTERVAL_MINUTES);
  const metricsReporter = createMetricsReporter({
    userData,
    logger,
    intervalMinutes:
      Number.isFinite(metricsIntervalEnv) && metricsIntervalEnv > 0 ? metricsIntervalEnv : 5
  });
  metricsReporter.start();

  const runShutdown = async signal => {
    logger.info(`\n🛑 Получен сигнал ${signal}, останавливаю бота...`);

    for (const handler of shutdownHandlers) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await handler();
      } catch (error) {
        logger.error('Ошибка при выполнении shutdown handler:', error);
      }
    }
  };

  process.once('SIGINT', async () => {
    await runShutdown('SIGINT');
    process.exit(0);
  });

  process.once('SIGTERM', async () => {
    await runShutdown('SIGTERM');
    process.exit(0);
  });

  registerShutdown(async () => {
    maintenance.stop();
    metricsReporter.stop();
    try {
      await saveUserData();
    } catch (error) {
      logger.error('Ошибка сохранения user_data при завершении:', error);
    }
    await telegramAdapter.stop().catch(() => {});
    if (vkAdapter) {
      await vkAdapter.stop().catch(() => {});
    }
    try {
      await sqlite.close();
    } catch (error) {
      logger.error('Ошибка закрытия SQLite при завершении:', error);
    }
  });

  return {
    config,
    adapters: {
      telegram: telegramAdapter,
      vk: vkAdapter
    },
    registerShutdown
  };
}

module.exports = {
  bootstrap
};
