const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  fatal: jest.fn(),
  child: jest.fn(() => mockLogger)
};

jest.mock('../../src/infra/logger', () => ({
  logger: mockLogger
}));

const { createAnswerServiceHarness } = require('../helpers/answer-service-harness');

describe('Answer flow integration', () => {
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

  test('отправка ответа выполняет авторизацию и уведомляет пользователя', async () => {
    const authenticateMock = jest.fn(async () => ({
      success: true,
      cookies: { sid: 'cookie-new' }
    }));
    const sendAnswerMock = jest.fn(async () => ({
      success: true,
      message: 'Принят',
      levelNumber: 5,
      level: { LevelId: 42, Number: 5, Name: 'Level 5' }
    }));

    const { service, user, mocks } = createAnswerServiceHarness({
      userOverrides: { authCookies: null },
      handlerOverrides: {
        authenticate: authenticateMock,
        sendAnswer: sendAnswerMock
      }
    });

    const expectedLevelId = user.lastKnownLevel?.levelId || null;
    await service.sendAnswerToEncounter('telegram', 'user-1', 'CODE-55', 'progress-1');

    expect(authenticateMock).toHaveBeenCalledTimes(1);
    expect(user.authCookies).toEqual({ sid: 'cookie-new' });
    const callArgs = sendAnswerMock.mock.calls[0];
    expect(callArgs[0]).toBe(user.gameId);
    expect(callArgs[1]).toBe('CODE-55');
    expect(callArgs[2]).toEqual({ sid: 'cookie-new' });
    expect(callArgs[3]).toBe(user.login);
    expect(callArgs[4]).toBe(user.password);
    expect(callArgs[6]).toBe(expectedLevelId);
    const lastSendCall =
      mocks.sendOrUpdateMessage.mock.calls[mocks.sendOrUpdateMessage.mock.calls.length - 1];
    expect(lastSendCall[0]).toBe('telegram');
    expect(lastSendCall[1]).toBe('user-1');
    expect(lastSendCall[2]).toContain('Ответ "CODE-55" отправлен');
    expect(lastSendCall[3]).toBe('progress-1');
    expect(mocks.saveUserData).toHaveBeenCalled();
    expect(user.lastKnownLevel).toEqual({
      levelId: 42,
      levelNumber: 5,
      timestamp: expect.any(Number)
    });
  });

  test('очередь повторяет отправку после авторизации и завершается успехом', async () => {
    const authenticateMock = jest.fn(async () => ({
      success: true,
      cookies: { sid: 'cookie-new' }
    }));
    const sendAnswerMock = jest
      .fn()
      .mockImplementationOnce(async () => {
        const error = new Error('Сессия истекла');
        error.message = 'сессия истекла';
        throw error;
      })
      .mockImplementation(async () => ({
        success: true,
        message: 'Принят',
        levelNumber: 6,
        level: { LevelId: 99, Number: 6 }
      }));

    const { service, queueRef, user, mocks } = createAnswerServiceHarness({
      queue: [{ answer: 'AAA' }, { answer: 'BBB' }],
      userOverrides: { authCookies: { sid: 'old-cookie' } },
      handlerOverrides: {
        authenticate: authenticateMock,
        sendAnswer: sendAnswerMock
      }
    });

    await service.processAnswerQueue('telegram', 'user-1');

    expect(sendAnswerMock).toHaveBeenCalledTimes(3);
    expect(authenticateMock).toHaveBeenCalledTimes(1);
    expect(queueRef).toHaveLength(0);
    expect(user.authCookies).toEqual({ sid: 'cookie-new' });
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'telegram',
      'user-1',
      expect.stringContaining('Подготовка к обработке очереди')
    );
    const finalQueueCall =
      mocks.sendOrUpdateMessage.mock.calls[mocks.sendOrUpdateMessage.mock.calls.length - 1];
    expect(finalQueueCall[0]).toBe('telegram');
    expect(finalQueueCall[1]).toBe('user-1');
    expect(finalQueueCall[2]).toContain('Обработка очереди завершена');
    expect(finalQueueCall[3]).toBe('msg-1');
  });
});
