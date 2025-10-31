const {
  ensureAuthenticated,
  createAuthCallback: createAuthCallbackHelper
} = require('./auth-manager');
const { logger } = require('../infra/logger');
const { updateLastKnownLevel } = require('../features/answer/answer-helpers');
const { createAnswerDelivery } = require('../features/answer/answer-delivery');
const { createQueueProcessor } = require('../processes/queue/queue-processor');

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

  async function createAuthCallback(user) {
    return createAuthCallbackHelper(user, EncounterAPI, saveUserData);
  }

  const {
    sendAnswerToEncounter,
    handleAccumulationComplete,
    sendToEncounterAPI
  } = createAnswerDelivery({
    ensureAuthenticated,
    createAuthCallback,
    getUserInfo,
    sendMessage,
    sendOrUpdateMessage,
    saveUserData,
    enqueueAnswer,
    logger,
    EncounterAPI
  });

  const { processAnswerQueue } = createQueueProcessor({
    createAuthCallback,
    EncounterAPI,
    sendMessage,
    sendOrUpdateMessage,
    saveUserData,
    getUserInfo,
    getAnswerQueue,
    sendToEncounterAPI,
    updateLastKnownLevel,
    logger
  });

  return {
    sendAnswerToEncounter,
    processAnswerQueue,
    handleAccumulationComplete
  };
}

module.exports = {
  createAnswerService
};
