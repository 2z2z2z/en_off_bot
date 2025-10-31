let initialized = false;
let bootstrapPromise = null;

async function ensureAppInitialized() {
  if (initialized) {
    return bootstrapPromise;
  }

  initialized = true;

  bootstrapPromise = (async () => {
    const {
      saveUserData,
      getUserInfo,
      getAnswerQueue,
      enqueueAnswer,
      refreshConfig
    } = require('../core/user-store');
    const EncounterAPI = require('../../encounter-api');
    const { logger } = require('../infra/logger');
    const { createAnswerService } = require('../core/answer-service');
    const { bootstrap } = require('./bootstrap');
    const { createBotEngine } = require('./providers/bot-engine');
    const {
      setPlatformConfig,
      setAnswerServiceApi,
      registerTelegramHandlers,
      handleCommand,
      handleCallback,
      handleTextMessage,
      sendOrUpdateMessage
    } = require('../features/router');
    const { sendMessage: sendPlatformMessage } = require('../core/messenger');

    let TELEGRAM_PLATFORM = 'telegram';
    let VK_PLATFORM = 'vk';
    let ROOT_USER_ID = 197924096;

    refreshConfig();
    const { config, adapters } = await bootstrap();

    TELEGRAM_PLATFORM = adapters.telegram?.name || TELEGRAM_PLATFORM;
    VK_PLATFORM = adapters.vk?.name || VK_PLATFORM;
    ROOT_USER_ID = config.rootUserId || ROOT_USER_ID;

    setPlatformConfig({
      telegram: TELEGRAM_PLATFORM,
      vk: VK_PLATFORM,
      rootUserId: ROOT_USER_ID
    });

    const botEngine = createBotEngine({
      adapters,
      logger,
      platforms: { telegram: TELEGRAM_PLATFORM, vk: VK_PLATFORM }
    });

    await botEngine.start({
      registerTelegramHandlers,
      handleCommand,
      handleCallback,
      handleTextMessage
    });

    const answerServiceApi = createAnswerService({
      EncounterAPI,
      sendMessage: sendPlatformMessage,
      sendOrUpdateMessage,
      saveUserData,
      getUserInfo,
      getAnswerQueue,
      enqueueAnswer
    });

    setAnswerServiceApi(answerServiceApi);

    logger.info('📱 Готов к приему сообщений...');
  })();

  return bootstrapPromise;
}

async function main() {
  await ensureAppInitialized();
}

module.exports = { main, ensureAppInitialized };
