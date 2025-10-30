const { createFakeEncounterAPI } = require('./fake-encounter-api');
const { createAnswerService } = require('../../src/core/answer-service');

function createAnswerServiceHarness({
  queue = [],
  userOverrides = {},
  depsOverrides = {},
  handlerOverrides = {}
} = {}) {
  const { FakeEncounterAPI, handlers } = createFakeEncounterAPI(handlerOverrides);
  const user = {
    platform: 'telegram',
    userId: 'user-1',
    authCookies: { sid: 'abc' },
    login: 'player',
    password: 'pass',
    domain: 'https://tech.en.cx',
    lastKnownLevel: { levelId: 1, levelNumber: 1 },
    accumulatedAnswers: [],
    pendingAnswerDecision: null,
    pendingQueueDecision: null,
    isProcessingQueue: false,
    isOnline: true,
    ...userOverrides
  };

  const queueRef = Array.isArray(queue) ? [...queue] : queue;

  const sendMessage = jest.fn(async () => ({ message_id: 'msg-1', chat_id: user.userId }));
  const sendOrUpdateMessage = jest.fn(async () => ({ message_id: 'msg-1', chat_id: user.userId }));
  const saveUserData = jest.fn(async () => undefined);
  const enqueueAnswer = jest.fn((platform, userId, payload) => {
    queueRef.push(payload);
  });

  const service = createAnswerService({
    EncounterAPI: FakeEncounterAPI,
    sendMessage,
    sendOrUpdateMessage,
    saveUserData,
    getUserInfo: jest.fn(() => user),
    getAnswerQueue: jest.fn(() => queueRef),
    enqueueAnswer,
    ...depsOverrides
  });

  return {
    service,
    user,
    queueRef,
    handlers,
    mocks: {
      sendMessage,
      sendOrUpdateMessage,
      saveUserData,
      enqueueAnswer
    }
  };
}

module.exports = { createAnswerServiceHarness };
