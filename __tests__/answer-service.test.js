jest.mock('../src/core/auth-manager', () => ({
  ensureAuthenticated: jest.fn(() => Promise.resolve()),
  createAuthCallback: jest.fn(() => Promise.resolve(async () => ({})))
}));

const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  fatal: jest.fn(),
  child: jest.fn(() => mockLogger)
};

jest.mock('../src/infra/logger', () => ({
  logger: mockLogger
}));

const { createAnswerServiceHarness } = require('./helpers/answer-service-harness');

describe('answer-service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(global, 'setTimeout').mockImplementation((callback, _ms, ...args) => {
      const handle = {
        hasRef: () => false,
        ref: () => handle,
        unref: () => handle
      };
      if (typeof callback === 'function') {
        callback(...args);
      }
      return handle;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('processAnswerQueue выявляет смену уровня и сохраняет решение', async () => {
    const initialQueue = [{ answer: '111', levelId: 1, levelNumber: 1 }];
    const { service, user, mocks } = createAnswerServiceHarness({
      queue: initialQueue,
      handlerOverrides: {
        getGameState: async () => ({
          success: true,
          data: { Level: { LevelId: 2, Number: 3 } }
        })
      }
    });

    await service.processAnswerQueue('telegram', 'user-1');

    expect(user.pendingQueueDecision).toEqual({
      oldLevelNumber: 1,
      newLevelNumber: 3,
      queueSize: 1
    });
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'telegram',
      'user-1',
      expect.stringContaining('Уровень изменился'),
      expect.any(Object)
    );
    expect(user.isProcessingQueue).toBe(false);
  });

  test('processAnswerQueue успешно обрабатывает очередь и очищает её', async () => {
    const initialQueue = [{ answer: '111' }, { answer: '222' }];
    const { service, queueRef, user, mocks } = createAnswerServiceHarness({ queue: initialQueue });

    await service.processAnswerQueue('telegram', 'user-1');

    expect(queueRef).toHaveLength(0);
    expect(user.isProcessingQueue).toBe(false);
    expect(mocks.sendOrUpdateMessage).toHaveBeenCalledWith(
      'telegram',
      'user-1',
      expect.stringContaining('Обработка очереди завершена'),
      'msg-1'
    );
  });

  test('processAnswerQueue оставляет ответы при повторяющихся ошибках и накапливает счётчики', async () => {
    const initialQueue = [{ answer: 'AAA' }];
    const { service, queueRef, user, mocks } = createAnswerServiceHarness({
      queue: initialQueue,
      handlerOverrides: {
        sendAnswer: async () => {
          throw new Error('Временная ошибка');
        }
      }
    });

    await service.processAnswerQueue('telegram', 'user-1');

    expect(queueRef).toHaveLength(1);
    expect(queueRef[0].failedAttempts).toBe(1);
    expect(queueRef[0].lastError).toBe('Временная ошибка');
    expect(mocks.sendOrUpdateMessage).toHaveBeenCalledWith(
      'telegram',
      'user-1',
      expect.stringContaining('Обработка очереди завершена с ошибками'),
      'msg-1'
    );
    expect(user.isProcessingQueue).toBe(false);
  });

  test('sendAnswerToEncounter сохраняет pendingAnswerDecision при смене уровня', async () => {
    const levelError = new Error('Level changed');
    levelError.isLevelChanged = true;
    levelError.oldLevel = 2;
    levelError.newLevel = 3;

    const { service, user, mocks } = createAnswerServiceHarness({
      handlerOverrides: {
        sendAnswer: async () => {
          throw levelError;
        }
      }
    });

    await service.sendAnswerToEncounter('telegram', 'user-1', 'CODE-1', 'progress-1');

    expect(user.pendingAnswerDecision).toEqual({
      answer: 'CODE-1',
      oldLevel: 2,
      newLevel: 3
    });
    expect(mocks.sendOrUpdateMessage).toHaveBeenCalledWith(
      'telegram',
      'user-1',
      expect.stringContaining('Уровень изменился'),
      'progress-1',
      expect.any(Object)
    );
  });

  test('sendAnswerToEncounter обновляет cookies при возвращаемых значениях', async () => {
    const { service, user, mocks } = createAnswerServiceHarness({
      handlerOverrides: {
        sendAnswer: async () => ({
          success: true,
          message: 'ok',
          levelNumber: 10,
          level: { LevelId: 55, Number: 10 },
          newCookies: { auth: 'new-cookie' }
        })
      }
    });
    user.authCookies = { sid: 'old-cookie' };

    await service.sendAnswerToEncounter('telegram', 'user-1', 'CODE-42', 'progress-1');

    expect(user.authCookies).toEqual({ sid: 'old-cookie', auth: 'new-cookie' });
    expect(mocks.saveUserData).toHaveBeenCalled();
    expect(mocks.sendOrUpdateMessage).toHaveBeenCalledWith(
      'telegram',
      'user-1',
      expect.stringContaining('Ответ "CODE-42" отправлен'),
      'progress-1'
    );
  });
});
