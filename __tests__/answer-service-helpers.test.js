const {
  checkPendingDecisions,
  detectLevelChange,
  retryWithBackoff,
  updateProgressMessage,
  handleCookieUpdate
} = require('../src/features/answer/answer-helpers');

describe('answer-service helpers', () => {
  beforeEach(() => {
    jest.useFakeTimers();
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
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('checkPendingDecisions блокирует пользователя при незакрытой очереди', async () => {
    const sendMessage = jest.fn();
    const result = await checkPendingDecisions({
      user: {
        pendingQueueDecision: { queueSize: 3, oldLevelNumber: 2, newLevelNumber: 4 }
      },
      platform: 'telegram',
      userId: 'user-1',
      sendMessage
    });

    expect(result).toEqual({ blocked: true, reason: 'queue' });
    expect(sendMessage).toHaveBeenCalledWith(
      'telegram',
      'user-1',
      expect.stringContaining('решите судьбу старой очереди!')
    );
  });

  test('checkPendingDecisions разрешает отправку при отсутствии решений', async () => {
    const sendMessage = jest.fn();
    const result = await checkPendingDecisions({
      user: {},
      platform: 'telegram',
      userId: 'user-1',
      sendMessage
    });

    expect(result).toEqual({ blocked: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('detectLevelChange сохраняет pendingAnswerDecision и показывает кнопки', async () => {
    const user = {};
    const saveUserData = jest.fn();
    const sendMessage = jest.fn();
    const sendOrUpdateMessage = jest.fn();
    const logger = { info: jest.fn() };

    const handled = await detectLevelChange({
      error: { isLevelChanged: true, oldLevel: 2, newLevel: 3 },
      user,
      answer: '123',
      platform: 'telegram',
      userId: 'user-1',
      progressMessageId: 'progress-1',
      saveUserData,
      sendMessage,
      sendOrUpdateMessage,
      logger
    });

    expect(handled).toBe(true);
    expect(user.pendingAnswerDecision).toEqual({
      answer: '123',
      oldLevel: 2,
      newLevel: 3
    });
    expect(saveUserData).toHaveBeenCalled();
    expect(sendOrUpdateMessage).toHaveBeenCalledWith(
      'telegram',
      'user-1',
      expect.stringContaining('Уровень изменился'),
      'progress-1',
      expect.objectContaining({
        reply_markup: expect.any(Object)
      })
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('⚠️ ЗАЩИТА СРАБОТАЛА')
    );
  });

  test('detectLevelChange возвращает false без флага', async () => {
    const result = await detectLevelChange({
      error: new Error('no change'),
      user: {},
      answer: 'CODE',
      platform: 'vk',
      userId: 'user-1',
      progressMessageId: null,
      saveUserData: jest.fn(),
      sendMessage: jest.fn(),
      sendOrUpdateMessage: jest.fn()
    });

    expect(result).toBe(false);
  });

  test('retryWithBackoff ограничивает число попыток и сообщает пользователю', async () => {
    const sendMessage = jest.fn();
    const sendOrUpdateMessage = jest.fn();
    const logger = { error: jest.fn(), info: jest.fn() };

    const result = await retryWithBackoff({
      answer: 'CODE',
      retryCount: 2,
      maxRetries: 1,
      user: {},
      platform: 'telegram',
      userId: 'user-1',
      progressMessageId: 'progress-1',
      saveUserData: jest.fn(),
      sendMessage,
      sendOrUpdateMessage,
      logger,
      retryFn: jest.fn()
    });

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      '❌ Достигнут максимум попыток (1) для ответа "CODE"'
    );
    expect(sendOrUpdateMessage).toHaveBeenCalledWith(
      'telegram',
      'user-1',
      expect.stringContaining('Не удалось отправить ответ "CODE"'),
      'progress-1',
      undefined
    );
  });

  test('retryWithBackoff очищает cookies, ждёт backoff и повторяет попытку', async () => {
    const sendMessage = jest.fn();
    const sendOrUpdateMessage = jest.fn();
    const logger = { error: jest.fn(), info: jest.fn() };
    const retryFn = jest.fn(async () => 'ok');
    const user = { authCookies: { sid: '123' } };
    const saveUserData = jest.fn();

    const result = await retryWithBackoff({
      answer: 'CODE',
      retryCount: 0,
      maxRetries: 2,
      user,
      platform: 'telegram',
      userId: 'user-1',
      progressMessageId: 'progress-1',
      saveUserData,
      sendMessage,
      sendOrUpdateMessage,
      logger,
      retryFn
    });

    expect(result).toBe('ok');
    expect(user.authCookies).toBeNull();
    expect(saveUserData).toHaveBeenCalled();
    expect(retryFn).toHaveBeenCalledWith(1);
    expect(sendOrUpdateMessage).toHaveBeenCalledWith(
      'telegram',
      'user-1',
      expect.stringContaining('Переавторизация'),
      'progress-1',
      undefined
    );
    expect(sendOrUpdateMessage).toHaveBeenCalledWith(
      'telegram',
      'user-1',
      expect.stringContaining('Повторяю отправку'),
      'progress-1',
      undefined
    );
  });

  test('updateProgressMessage использует sendOrUpdateMessage при наличии progressMessageId', async () => {
    const sendMessage = jest.fn();
    const sendOrUpdateMessage = jest.fn();

    await updateProgressMessage({
      platform: 'telegram',
      userId: 'user-1',
      text: 'hello',
      progressMessageId: 'msg-1',
      options: { foo: 'bar' },
      sendMessage,
      sendOrUpdateMessage
    });

    expect(sendOrUpdateMessage).toHaveBeenCalledWith(
      'telegram',
      'user-1',
      'hello',
      'msg-1',
      { foo: 'bar' }
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('updateProgressMessage отправляет новое сообщение при отсутствии progressMessageId', async () => {
    const sendMessage = jest.fn();
    const sendOrUpdateMessage = jest.fn();

    await updateProgressMessage({
      platform: 'vk',
      userId: 'user-1',
      text: 'hello',
      progressMessageId: null,
      options: { bar: 'baz' },
      sendMessage,
      sendOrUpdateMessage
    });

    expect(sendMessage).toHaveBeenCalledWith('vk', 'user-1', 'hello', { bar: 'baz' });
    expect(sendOrUpdateMessage).not.toHaveBeenCalled();
  });

  test('handleCookieUpdate объединяет куки и сохраняет данные', async () => {
    const user = { authCookies: { sid: 'old' } };
    const saveUserData = jest.fn();
    const logger = { info: jest.fn() };

    const changed = await handleCookieUpdate({
      result: { newCookies: { auth: 'new' } },
      user,
      saveUserData,
      logger
    });

    expect(changed).toBe(true);
    expect(user.authCookies).toEqual({ sid: 'old', auth: 'new' });
    expect(saveUserData).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      '🔄 Cookies обновлены после автоматической реаутентификации'
    );
  });

  test('handleCookieUpdate пропускает обновление при отсутствии куков', async () => {
    const saveUserData = jest.fn();
    const changed = await handleCookieUpdate({
      result: {},
      user: {},
      saveUserData
    });

    expect(changed).toBe(false);
    expect(saveUserData).not.toHaveBeenCalled();
  });
});
