const { createQueueProcessor } = require('../src/processes/queue/queue-processor');

describe('queue-processor', () => {
  const baseUser = {
    platform: 'telegram',
    userId: 'user-1',
    authCookies: { sid: 'cookie' },
    login: 'player',
    password: 'pass',
    domain: 'https://tech.en.cx',
    lastKnownLevel: { levelId: 1, levelNumber: 1 },
    pendingQueueDecision: null,
    isProcessingQueue: false,
    answerQueue: []
  };

  function createDeps(overrides = {}) {
    const user = { ...baseUser, pendingQueueDecision: null, answerQueue: [] };
    const queue = overrides.queue ? [...overrides.queue] : user.answerQueue;

    const sendMessage = jest.fn(async () => ({ message_id: 'msg-1' }));
    const sendOrUpdateMessage = jest.fn(async () => ({ message_id: 'msg-1' }));
    const saveUserData = jest.fn(async () => undefined);
    const updateLastKnownLevel = jest.fn();

    const FakeEncounterAPI = jest.fn(() => ({
      getGameState: overrides.getGameState || (async () => ({
        success: true,
        data: { Level: { LevelId: 1, Number: 1 } }
      }))
    }));

    const sendToEncounterAPI =
      overrides.sendToEncounterAPI ||
      jest.fn(async () => ({
        success: true,
        levelNumber: 1,
        message: 'ok'
      }));

    const deps = {
      createAuthCallback: jest.fn(async () => overrides.authCallback || (async () => ({}))),
      EncounterAPI: FakeEncounterAPI,
      sendMessage,
      sendOrUpdateMessage,
      saveUserData,
      getUserInfo: jest.fn(() => user),
      getAnswerQueue: jest.fn(() => queue),
      sendToEncounterAPI,
      updateLastKnownLevel,
      logger: {
        info: jest.fn(),
        error: jest.fn()
      }
    };

    return { deps, user, queue, sendToEncounterAPI, sendMessage, sendOrUpdateMessage, saveUserData };
  }

  test('detects level change before processing queue', async () => {
    const initialQueue = [{ answer: '111', levelId: 1, levelNumber: 1 }];
    const { deps, user, sendMessage } = createDeps({
      queue: initialQueue,
      getGameState: async () => ({
        success: true,
        data: { Level: { LevelId: 2, Number: 3 } }
      })
    });

    const { processAnswerQueue } = createQueueProcessor(deps);
    await processAnswerQueue('telegram', 'user-1');

    expect(user.pendingQueueDecision).toEqual({
      oldLevelNumber: 1,
      newLevelNumber: 3,
      queueSize: 1
    });
    expect(sendMessage).toHaveBeenCalledWith(
      'telegram',
      'user-1',
      expect.stringContaining('Уровень изменился'),
      expect.any(Object)
    );
  });

  test('processes queue items and empties queue on success', async () => {
    const initialQueue = [{ answer: 'AAA' }, { answer: 'BBB' }];
    const { deps, queue, sendToEncounterAPI, sendOrUpdateMessage } = createDeps({
      queue: initialQueue
    });

    const { processAnswerQueue } = createQueueProcessor(deps);
    await processAnswerQueue('telegram', 'user-1');

    expect(sendToEncounterAPI).toHaveBeenCalledTimes(2);
    expect(queue).toHaveLength(0);
    expect(sendOrUpdateMessage).toHaveBeenCalledWith(
      'telegram',
      'user-1',
      expect.stringContaining('Обработка очереди завершена'),
      'msg-1'
    );
  });
});
