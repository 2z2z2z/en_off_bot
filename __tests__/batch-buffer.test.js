const { createBatchBuffer } = require('../src/features/answer/batch-buffer');

describe('batch-buffer', () => {
  let logger;

  beforeEach(() => {
    jest.useFakeTimers();
    logger = {
      info: jest.fn(),
      error: jest.fn()
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('queueAnswerForProcessing сразу отправляет ответ, когда нет накопления', async () => {
    const user = {};
    const sendAnswerToEncounter = jest.fn().mockResolvedValue('ok');
    const buffer = createBatchBuffer({
      getPlatformUser: jest.fn(() => user),
      getSendAnswerToEncounter: () => sendAnswerToEncounter,
      logger
    });

    const resultPromise = buffer.queueAnswerForProcessing(
      'telegram',
      'user-1',
      user,
      'CODE-1',
      'progress-1'
    );

    jest.runOnlyPendingTimers();
    await Promise.resolve();

    const result = await resultPromise;

    expect(result).toBe('ok');
    expect(sendAnswerToEncounter).toHaveBeenCalledWith('telegram', 'user-1', 'CODE-1', 'progress-1');
  });

  test('повторная постановка в очередь запускается после завершения текущей обработки', async () => {
    const user = {};
    let resolveFirst;
    const sendAnswerToEncounter = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce('second');

    const buffer = createBatchBuffer({
      getPlatformUser: jest.fn(() => user),
      getSendAnswerToEncounter: () => sendAnswerToEncounter,
      logger
    });

    const firstPromise = buffer.queueAnswerForProcessing(
      'telegram',
      'user-1',
      user,
      'CODE-1',
      'progress-1'
    );
    const secondPromise = buffer.queueAnswerForProcessing(
      'telegram',
      'user-1',
      user,
      'CODE-2',
      'progress-2'
    );

    expect(user.pendingBurstAnswers).toHaveLength(2);

    jest.runOnlyPendingTimers();
    await Promise.resolve();
    resolveFirst('first');
    await Promise.resolve();
    jest.runOnlyPendingTimers();
    await Promise.resolve();

    await expect(firstPromise).resolves.toBe('first');
    await expect(secondPromise).resolves.toBe('second');

    expect(sendAnswerToEncounter).toHaveBeenCalledTimes(2);
    expect(user.pendingBurstAnswers).toHaveLength(0);
    expect(user._burstProcessing).toBe(false);
    expect(user._burstProcessingRequested).toBeFalsy();
  });
});
