const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { logger } = require('./src/infra/logger');
const {
  EncounterError,
  AuthRequiredError,
  NetworkError,
  LevelChangedError,
  RateLimitError
} = require('./src/core/encounter-errors');

const STATUS_MESSAGE_MAP = Object.freeze({
  default: {
    400: 'Некорректный запрос к Encounter',
    401: 'Требуется авторизация - cookies устарели',
    403: 'Доступ к ресурсу Encounter запрещен',
    404: 'Ресурс Encounter не найден - проверьте идентификатор',
    500: 'Ошибка сервера Encounter',
    503: 'Сервер Encounter временно недоступен'
  },
  getGameState: {
    400: context => {
      const gameId = context?.gameId ?? '?';
      return `Неправильный запрос HTTP 400. Возможные причины:
 - Неверный ID игры (${gameId})
 - Игра не существует или недоступна
 - Проблемы с авторизацией на домене
 - Неправильный формат запроса`;
    }
  },
  sendAnswer: {
    400: () =>
      'Encounter отклонил ответ: неверный формат данных или отсутствует обязательный параметр',
    409: () =>
      'Encounter вернул конфликт уровней при отправке ответа. Проверьте актуальность уровня',
    423: () => 'Encounter заблокировал уровень для приёма ответов (HTTP 423)'
  }
});

const NETWORK_CODE_MESSAGES = Object.freeze({
  ENOTFOUND: 'Домен не найден - проверьте правильность адреса',
  ECONNREFUSED: 'Подключение отклонено - сервер Encounter недоступен или блокирует IP',
  ECONNRESET: 'Соединение с Encounter было сброшено',
  ETIMEDOUT: 'Превышено время ожидания - сервер не отвечает',
  ECONNABORTED: 'Превышено время ожидания - сервер не отвечает'
});

// Класс для работы с API Encounter
class EncounterAPI {
  // Статический словарь для отслеживания последнего времени запроса к каждому домену
  static lastRequestTime = {};
  static requestQueues = {};

  // Кеш данных уровня для избежания лишних запросов getGameState
  // Структура: { "domain_gameId_user": { levelId, levelNumber, timestamp, isPassed } }
  static levelCache = {};

  constructor(domain, authCallback = null) {
    this.domain = domain.startsWith('http') ? domain : `https://${domain}`;
    this.timeout = 10000; // 10 секунд таймаут
    this.authCallback = authCallback; // Callback для централизованной авторизации с мьютексом
  }

  async _loadLevelContext({ gameId, authCookies, login, password, baseContext }) {
    let levelData = this._getLevelFromCache(gameId, login);
    let model = null;
    let newCookies = null;

    if (levelData) {
      this._log('info', 'Использую кеш Encounter уровня', {
        ...baseContext,
        levelId: levelData.levelId,
        levelNumber: levelData.levelNumber
      });
      return { levelData, model, newCookies };
    }

    this._log('info', 'Кеша Encounter нет, получаю состояние игры', baseContext);
    const gameState = await this.getGameState(gameId, authCookies, login, password);

    if (!gameState?.success) {
      throw new EncounterError('Не удалось получить состояние игры', { code: 'GAME_STATE_FAILED' });
    }

    model = gameState.data;
    newCookies = gameState.newCookies || null;

    const level = this._extractLevelFromModel(gameId, model, login, baseContext);

    this._saveLevelToCache(gameId, level, login);
    levelData = {
      levelId: level.LevelId,
      levelNumber: level.Number,
      isPassed: level.IsPassed
    };

    return { levelData, model, newCookies };
  }

  _extractLevelFromModel(gameId, model, login, baseContext) {
    if (!model || typeof model !== 'object') {
      this._log('error', 'Encounter вернул некорректный ответ (model отсутствует)', {
        ...baseContext,
        payload: this._serializePayloadSnippet(model)
      });
      throw new EncounterError('Не удалось получить состояние игры', { code: 'GAME_STATE_FAILED' });
    }

    this._log('info', 'Получено состояние Encounter', {
      ...baseContext,
      event: model.Event ?? null
    });

    if (model.Event === undefined || model.Event === null) {
      this._log('error', 'Encounter вернул состояние без Event', {
        ...baseContext,
        payload: this._serializePayloadSnippet(model)
      });
      throw new EncounterError('Сервер вернул некорректные данные (Event не определен)', {
        code: 'INVALID_EVENT'
      });
    }

    if (model.Event !== 0) {
      const eventMessages = {
        1: 'Неизвестная ошибка',
        2: 'Игра с указанным ID не существует',
        3: 'Запрошенная игра не соответствует типу Encounter',
        4: 'Игрок не авторизован - требуется повторный вход',
        5: 'Игра не началась - ожидайте начала игры',
        6: 'Игра закончилась',
        7: 'Не подана заявка игроком - подайте заявку на участие',
        8: 'Не подана заявка командой - команда должна подать заявку',
        9: 'Игрок еще не принят в игру - ожидайте подтверждения',
        10: 'У игрока нет команды - вступите в команду',
        11: 'Игрок не активен в команде - активируйтесь в команде',
        12: 'В игре нет уровней',
        13: 'Превышено количество участников в команде',
        14: 'Игрок заблокирован',
        15: 'Команда заблокирована',
        16: 'Уровень изменился',
        17: 'Игра закончена'
      };

      const errorMsg = eventMessages[model.Event] || `Неизвестная ошибка игры (код ${model.Event})`;
      this._log('warn', 'Encounter сообщил о событии в состоянии игры', {
        ...baseContext,
        event: model.Event,
        message: errorMsg
      });

      if (model.Event === 16) {
        this._invalidateLevelCache(gameId, 'уровень изменился', login);
      }

      throw new EncounterError(errorMsg, { code: 'LEVEL_STATE_ERROR' });
    }

    const level = model.Level;

    if (!level) {
      this._log('error', 'Encounter не вернул данные уровня', {
        ...baseContext,
        payload: this._serializePayloadSnippet(model)
      });
      throw new EncounterError('Не удалось получить данные уровня', { code: 'LEVEL_DATA_MISSING' });
    }

    this._log('info', 'Состояние Encounter уровня получено', {
      ...baseContext,
      levelId: level.LevelId,
      levelNumber: level.Number,
      levelPassed: level.IsPassed
    });

    if (level.IsPassed) {
      this._invalidateLevelCache(gameId, 'уровень пройден', login);
      throw new EncounterError(`Уровень ${level.Number} уже пройден`, {
        code: 'LEVEL_COMPLETED',
        retryable: false
      });
    }

    if (level.Dismissed) {
      this._invalidateLevelCache(gameId, 'уровень снят', login);
      throw new EncounterError(`Уровень ${level.Number} снят администратором`, {
        code: 'LEVEL_DISMISSED',
        retryable: false
      });
    }

    return level;
  }

  _ensureLevelNotBlocked(model, levelData, baseContext) {
    if (!model || !model.Level || !model.Level.HasAnswerBlockRule) {
      return;
    }

    if (model.Level.BlockDuration > 0) {
      const minutes = Math.floor(model.Level.BlockDuration / 60);
      const seconds = model.Level.BlockDuration % 60;
      const timeStr = minutes > 0 ? `${minutes}м ${seconds}с` : `${seconds}с`;

      this._log('warn', 'Encounter заблокировал ответы на уровне', {
        ...baseContext,
        levelId: levelData.levelId,
        levelNumber: levelData.levelNumber,
        blockDuration: model.Level.BlockDuration,
        blockTimeLeft: timeStr
      });
      throw new EncounterError(
        `⏰ Блокировка ответов на уровне ${levelData.levelNumber}. Осталось: ${timeStr}`,
        { code: 'LEVEL_LOCKED', retryable: true }
      );
    }

    this._log('info', 'Encounter сообщает о настройке блокировки (не активна)', {
      ...baseContext,
      levelId: levelData.levelId,
      levelNumber: levelData.levelNumber
    });
  }

  async _ensureLevelCurrentBeforeSend({
    gameId,
    authCookies,
    login,
    password,
    expectedLevelId,
    currentLevelIdFromState,
    currentLevelNumberFromState,
    answer,
    baseContext
  }) {
    const verifyState = await this.getGameState(gameId, authCookies, login, password);

    if (!verifyState.success || !verifyState.data || !verifyState.data.Level) {
      return;
    }

    const currentLevelId = verifyState.data.Level.LevelId;
    const currentLevelNumber = verifyState.data.Level.Number;

    this._log('info', 'Финальная проверка уровня перед отправкой ответа', {
      ...baseContext,
      expectedLevelId,
      currentLevelId,
      currentLevelNumber
    });

    if (currentLevelId !== expectedLevelId) {
      const expectedLevelNumber =
        expectedLevelId === currentLevelIdFromState ? currentLevelNumberFromState : '?';

      this._log('warn', 'Encounter сообщил о смене уровня перед отправкой', {
        ...baseContext,
        expectedLevelNumber,
        currentLevelNumber,
        currentLevelId,
        expectedLevelId
      });

      throw new LevelChangedError(
        `Уровень изменился (ожидался ${expectedLevelNumber}, текущий ${currentLevelNumber})`,
        {
          oldLevel: expectedLevelNumber,
          newLevel: currentLevelNumber,
          answer
        }
      );
    }

    this._log('info', 'Уровень актуален, продолжаем отправку', {
      ...baseContext,
      currentLevelId,
      currentLevelNumber
    });
  }

  async _executeSendAnswerRequest({ gameId, levelData, answer, cookieString, baseContext }) {
    const endpoint = `${this.domain}/GameEngines/Encounter/Play/${gameId}?json=1`;
    const postData = new URLSearchParams({
      LevelId: levelData.levelId.toString(),
      LevelNumber: levelData.levelNumber.toString(),
      'LevelAction.Answer': answer
    });

    this._log('debug', 'POST запрос к Encounter для отправки ответа', {
      ...baseContext,
      endpoint,
      levelId: levelData.levelId,
      levelNumber: levelData.levelNumber
    });

    const response = await axios.post(endpoint, postData, {
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json, text/html, */*',
        Cookie: cookieString,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    this._log('info', 'Ответ Encounter на отправку ответа получен', {
      ...baseContext,
      status: response.status,
      event: response.data?.Event ?? null
    });

    return response;
  }

  _analyzeLevelAction({ result, levelData, baseContext, gameId, login }) {
    const engineAction = result.EngineAction;
    const levelAction = engineAction?.LevelAction;

    if (!levelAction) {
      this._log('warn', 'Encounter не вернул LevelAction', {
        ...baseContext,
        payload: this._serializePayloadSnippet(result)
      });
      return {
        isCorrect: false,
        message: '❌ Ответ не обработан - нет данных о результате',
        level: result.Level,
        engineAction,
        levelAction
      };
    }

    this._log('debug', 'Encounter LevelAction получен', {
      ...baseContext,
      levelId: levelData.levelId,
      levelNumber: levelData.levelNumber,
      answerEcho: levelAction.Answer,
      isCorrectAnswer: levelAction.IsCorrectAnswer
    });

    let isCorrect = false;
    let message = 'Ответ отправлен';

    if (levelAction.IsCorrectAnswer !== null) {
      isCorrect = levelAction.IsCorrectAnswer;
      message = isCorrect ? '✅ Правильный ответ!' : '❌ Неправильный ответ';

      this._log('info', 'Encounter оценил ответ', {
        ...baseContext,
        levelId: levelData.levelId,
        levelNumber: levelData.levelNumber,
        isCorrect
      });
    } else {
      this._log('warn', 'Encounter не обработал ответ (IsCorrectAnswer = null)', baseContext);
      message = '⚠️ Ответ не был обработан - проверьте правильность отправки';
    }

    if (result.Level && result.Level.IsPassed) {
      message += ' 🎉 Уровень пройден!';
      this._log('info', 'Encounter сообщает о прохождении уровня', {
        ...baseContext,
        levelNumber: result.Level.Number,
        levelId: result.Level.LevelId
      });
      this._invalidateLevelCache(gameId, 'уровень пройден', login);
      isCorrect = true;
    }

    if (result.Event && [16, 18, 19, 20, 21, 22].includes(result.Event)) {
      this._invalidateLevelCache(gameId, `Event ${result.Event} - уровень изменился`, login);
    }

    return {
      isCorrect,
      message,
      level: result.Level,
      engineAction,
      levelAction
    };
  }

  _interpretAnswerResponse({ result, levelData, baseContext, answer, gameId, login }) {
    if (
      typeof result === 'string' &&
      (result.includes('<html') || result.includes('<!DOCTYPE'))
    ) {
      this._log('warn', 'Encounter вернул HTML при отправке ответа (сессия истекла)', baseContext);
      throw new AuthRequiredError('Требуется повторная авторизация (сессия истекла)');
    }

    if (result.Event === 4) {
      this._log('warn', 'Encounter сообщает об отсутствии авторизации при отправке', baseContext);
      throw new AuthRequiredError('Игрок не авторизован');
    }

    if (result.Event === undefined || result.Event === null) {
      this._log('warn', 'Encounter вернул ответ без Event', {
        ...baseContext,
        payload: this._serializePayloadSnippet(result)
      });
    } else if (result.Event !== 0) {
      if ([16, 18, 19, 20, 21, 22].includes(result.Event)) {
        this._log('info', 'Encounter сообщил о смене уровня после отправки', {
          ...baseContext,
          event: result.Event
        });
      } else {
        throw new EncounterError(`Ошибка отправки ответа (код ${result.Event})`, {
          code: 'ANSWER_FAILED',
          retryable: true
        });
      }
    }

    const analysis = this._analyzeLevelAction({
      result,
      levelData,
      baseContext,
      gameId,
      login
    });

    return {
      isCorrect: analysis.isCorrect,
      message: analysis.message,
      level: analysis.level,
      engineAction: analysis.engineAction,
      levelAction: analysis.levelAction
    };
  }

  _log(level, message, context = {}) {
    const logLevel = typeof logger[level] === 'function' ? level : 'info';
    const payload = { domain: this.domain, ...context };
    if (Object.keys(payload).length > 0) {
      logger[logLevel](payload, message);
    } else {
      logger[logLevel](message);
    }
  }

  _isHtmlPayload(payload) {
    if (!payload) {
      return false;
    }
    const text = String(payload);
    return text.includes('<html') || text.includes('<!DOCTYPE');
  }

  _extractAuthCookies(setCookieHeader = []) {
    if (!Array.isArray(setCookieHeader)) {
      return {};
    }

    const cookies = {};
    setCookieHeader.forEach(cookie => {
      const [nameValue] = cookie.split(';');
      const [name, value] = nameValue.split('=');
      if (['GUID', 'stoken', 'atoken'].includes(name)) {
        cookies[name] = decodeURIComponent(value);
      }
    });
    return cookies;
  }

  _maskLogin(login) {
    if (!login) {
      return null;
    }

    const value = String(login);

    if (value.length <= 3) {
      return `${value[0] ?? '*'}***`;
    }

    return `${value.slice(0, 2)}***${value.slice(-1)}`;
  }

  _serializePayloadSnippet(payload, maxLength = 500) {
    if (payload === null || payload === undefined) {
      return null;
    }

    try {
      const raw =
        typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);

      if (!raw) {
        return null;
      }

      return raw.length > maxLength ? `${raw.slice(0, maxLength)}...` : raw;
    } catch (err) {
      logger.warn('Не удалось сериализовать payload Encounter', { error: err });
      return '[unserializable payload]';
    }
  }

  _buildCookieString(cookies = {}) {
    return Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  _shouldAttemptAuthRetry(error, login, password, isRetry) {
    return error instanceof AuthRequiredError && login && password && !isRetry;
  }

  async _performReauthentication(login, password, authCookies = {}, baseContext = {}) {
    this._log('info', 'Запускаю попытку реаутентификации Encounter', {
      login: this._maskLogin(login),
      ...baseContext
    });

    let authResult;

    if (this.authCallback) {
      this._log('info', 'Использую централизованную авторизацию с мьютексом', {
        login: this._maskLogin(login),
        ...baseContext
      });
      authResult = await this.authCallback();
    } else {
      this._log('warn', 'Fallback: прямая авторизация без мьютекса', {
        login: this._maskLogin(login),
        ...baseContext
      });
      authResult = await this.authenticate(login, password);
    }

    if (!authResult?.success) {
      const message = authResult?.message || 'Не удалось выполнить авторизацию';
      throw Object.assign(
        new AuthRequiredError(`Автоматическая реаутентификация не удалась: ${message}`),
        { reAuthFailed: true, authMessage: message }
      );
    }

    return {
      ...authResult,
      cookies: {
        ...(authCookies || {}),
        ...(authResult.cookies || {})
      }
    };
  }

  async _fetchGameState(gameId, cookieString, baseContext) {
    const url = `${this.domain}/GameEngines/Encounter/Play/${gameId}?json=1`;

    this._log('info', 'Запрос состояния игры', {
      ...baseContext,
      url,
      cookiesPreview: cookieString.substring(0, 80)
    });

    const response = await axios.get(url, {
      timeout: this.timeout,
      headers: {
        Cookie: cookieString,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    this._log('info', 'Ответ Encounter на запрос состояния игры получен', {
      ...baseContext,
      status: response.status
    });

    return response;
  }

  _ensureGameStateAuthorized(data, baseContext) {
    if (typeof data === 'string' && (data.includes('<html') || data.includes('<!DOCTYPE'))) {
      this._log('warn', 'Encounter вернул HTML вместо JSON для состояния игры', baseContext);
      throw new AuthRequiredError('Требуется авторизация (сессия истекла)');
    }

    if (data && typeof data === 'object' && data.Event === 4) {
      this._log('warn', 'Encounter сообщает, что игрок не авторизован (Event 4)', baseContext);
      throw new AuthRequiredError('Требуется авторизация');
    }
  }

  _resolveStatusMessage(status, operation, context = {}) {
    const operationMap = STATUS_MESSAGE_MAP[operation] || {};
    const resolver = operationMap[status] || STATUS_MESSAGE_MAP.default[status];

    if (typeof resolver === 'function') {
      return resolver(context);
    }

    if (resolver) {
      return resolver;
    }

    return `HTTP ошибка ${status} при выполнении операции ${operation}`;
  }

  _normalizeNetworkError(error, meta = {}) {
    if (error instanceof EncounterError) {
      return error;
    }

    const { operation = 'request', context = {} } = meta;

    if (error.response) {
      const { status, headers = {}, data } = error.response;
      const payloadSnippet = this._serializePayloadSnippet(data);

      logger.warn('Encounter API вернул HTTP ошибку', {
        operation,
        status,
        context,
        payload: payloadSnippet
      });

      if (status === 429) {
        const retryAfterHeader = headers['retry-after'] ?? headers['Retry-After'];
        const retryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : null;
        return new RateLimitError('Encounter ограничил частоту запросов (HTTP 429)', {
          retryAfter,
          context
        });
      }

      const message = this._resolveStatusMessage(status, operation, context);

      return new NetworkError(message, {
        status,
        context,
        retryable: status >= 500,
        original: error
      });
    }

    if (error.code && NETWORK_CODE_MESSAGES[error.code]) {
      const retryable = error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED';
      return new NetworkError(NETWORK_CODE_MESSAGES[error.code], {
        code: error.code,
        retryable,
        context,
        original: error
      });
    }

    return new NetworkError(error.message || 'Сетевая ошибка Encounter', {
      context,
      retryable: true,
      original: error
    });
  }

  _normalizeAuthResponse(response) {
    const result = response.data;

    if (!result || typeof result !== 'object') {
      if (this._isHtmlPayload(result)) {
        return {
          success: false,
          code: 'IP_BLOCKED',
          message: 'IP заблокирован Encounter — слишком много запросов. Подождите 5-10 минут.'
        };
      }

      return {
        success: false,
        code: 'INVALID_RESPONSE',
        message: 'API вернул некорректный формат данных (не JSON объект)'
      };
    }

    if (result.Error === undefined || result.Error === null) {
      return {
        success: false,
        code: 'INVALID_RESPONSE',
        message: 'Некорректный ответ от сервера - отсутствует поле Error'
      };
    }

    if (result.Error === 0) {
      return {
        success: true,
        cookies: this._extractAuthCookies(response.headers['set-cookie']),
        message: 'Авторизация успешна'
      };
    }

    const errorMessages = {
      1: 'Требуется прохождение капчи. Авторизуйтесь через браузер на сайте и повторите попытку.',
      2: 'Неправильный логин или пароль',
      3: 'Пользователь заблокирован или не может авторизоваться с данного домена',
      4: 'IP адрес не в списке разрешенных',
      5: 'Ошибка на сервере',
      7: 'Пользователь заблокирован администратором',
      8: 'Новый пользователь не активирован',
      9: 'Действия расценены как брутфорс',
      10: 'E-Mail не подтвержден'
    };

    let message = errorMessages[result.Error] || `Ошибка авторизации (код ${result.Error})`;
    if (result.Error === 1 && result.CaptchaUrl) {
      message += `\n\n🔗 Ссылка для прохождения капчи:\n${result.CaptchaUrl}`;
    }

    return {
      success: false,
      code: 'AUTH_FAILED',
      errorCode: result.Error,
      message
    };
  }

  _normalizeAuthError(error) {
    if (error instanceof EncounterError) {
      return { success: false, code: error.code, message: error.message };
    }

    if (error.response) {
      const status = error.response.status;
      const statusMessages = {
        400: 'Неправильный запрос - проверьте логин и пароль',
        401: 'Неверные данные авторизации',
        403: 'Доступ запрещен',
        404: 'Страница авторизации не найдена - проверьте домен',
        500: 'Ошибка сервера Encounter',
        503: 'Сервер Encounter временно недоступен'
      };

      return {
        success: false,
        code: 'HTTP_ERROR',
        message: statusMessages[status] || `HTTP ошибка ${status}: ${error.message}`
      };
    }

    if (error.code === 'ENOTFOUND') {
      return {
        success: false,
        code: 'DNS',
        message: 'Домен не найден - проверьте правильность адреса'
      };
    }

    if (error.code === 'ETIMEDOUT') {
      return {
        success: false,
        code: 'TIMEOUT',
        message: 'Превышено время ожидания - сервер не отвечает'
      };
    }

    return {
      success: false,
      code: 'UNKNOWN',
      message: error.message || 'Неизвестная ошибка авторизации'
    };
  }

  // Rate limiter: минимум 1.2 секунды между любыми запросами к одному домену
  async _waitRateLimit() {
    const domain = this.domain;
    const queueTail = EncounterAPI.requestQueues[domain] || Promise.resolve();

    let releaseQueue;
    const queueSlot = new Promise(resolve => {
      releaseQueue = resolve;
    });

    EncounterAPI.requestQueues[domain] = queueTail.then(() => queueSlot);

    await queueTail;

    try {
      const now = Date.now();
      const lastTime = EncounterAPI.lastRequestTime[domain] || 0;
      const elapsed = now - lastTime;

      if (elapsed < 1200) {
        const waitTime = 1200 - elapsed;
        this._log('debug', 'Encounter rate limit ожидание', {
          waitTime,
          lastRequestElapsed: elapsed
        });
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      EncounterAPI.lastRequestTime[domain] = Date.now();
    } finally {
      if (typeof releaseQueue === 'function') {
        releaseQueue();
      }

      // После завершения цепочки возвращаемся к resolved promise,
      // чтобы избежать роста цепочки промисов в памяти
      if (EncounterAPI.requestQueues[domain] === queueSlot) {
        EncounterAPI.requestQueues[domain] = Promise.resolve();
      }
    }
  }

  // Сохранение HTML ошибок для анализа
  async _saveErrorHtml(htmlContent, prefix = 'error') {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${prefix}-${timestamp}.html`;
      const filepath = path.join(__dirname, 'error_logs', filename);

      await fs.ensureDir(path.join(__dirname, 'error_logs'));
      await fs.writeFile(filepath, htmlContent);

      this._log('info', 'Encounter HTML ошибка сохранена', { filepath });
    } catch (error) {
      this._log('error', 'Не удалось сохранить HTML ошибку Encounter', { err: error });
    }
  }

  _makeLevelCacheKey(gameId, login = null) {
    const base = `${this.domain}_${gameId}`;
    if (!login) {
      return `${base}__shared`;
    }
    const normalized = String(login).trim().toLowerCase();
    return normalized ? `${base}_${normalized}` : `${base}__shared`;
  }

  // Получить данные уровня из кеша
  _getLevelFromCache(gameId, login = null) {
    const cacheKey = this._makeLevelCacheKey(gameId, login);
    let cached = EncounterAPI.levelCache[cacheKey];

    if (!cached) {
      const legacyKey = `${this.domain}_${gameId}`;
      if (EncounterAPI.levelCache[legacyKey]) {
        cached = EncounterAPI.levelCache[legacyKey];
        delete EncounterAPI.levelCache[legacyKey];
        EncounterAPI.levelCache[cacheKey] = cached;
      }
    }

    if (!cached) {
      return null;
    }

    // Кеш действителен 30 секунд
    const age = Date.now() - cached.timestamp;
    if (age > 30000) {
      this._log('debug', 'Encounter кеш уровня устарел, инвалидируем', {
        gameId,
        login: this._maskLogin(login),
        ageMs: age,
        levelId: cached.levelId,
        levelNumber: cached.levelNumber
      });
      delete EncounterAPI.levelCache[cacheKey];
      return null;
    }

    return cached;
  }

  // Сохранить данные уровня в кеш
  _saveLevelToCache(gameId, levelData, login = null) {
    const cacheKey = this._makeLevelCacheKey(gameId, login);
    EncounterAPI.levelCache[cacheKey] = {
      levelId: levelData.LevelId,
      levelNumber: levelData.Number,
      isPassed: levelData.IsPassed || false,
      timestamp: Date.now()
    };
    this._log('debug', 'Encounter кеш уровня обновлён', {
      gameId,
      login: this._maskLogin(login),
      levelId: levelData.LevelId,
      levelNumber: levelData.Number
    });
  }

  // Инвалидировать кеш уровня
  _invalidateLevelCache(gameId, reason = '', login = null) {
    const baseKey = `${this.domain}_${gameId}`;
    const keysToRemove = [];

    if (login) {
      keysToRemove.push(this._makeLevelCacheKey(gameId, login));
    } else {
      for (const key of Object.keys(EncounterAPI.levelCache)) {
        if (key === baseKey || key.startsWith(`${baseKey}_`) || key.startsWith(`${baseKey}__`)) {
          keysToRemove.push(key);
        }
      }
    }

    if (keysToRemove.length === 0) {
      return;
    }

    for (const key of keysToRemove) {
      delete EncounterAPI.levelCache[key];
    }

    this._log('debug', 'Encounter кеш уровня инвалидирован', {
      gameId,
      login: this._maskLogin(login),
      reason,
      keysRemoved: keysToRemove.length
    });
  }

  // Авторизация пользователя по официальному API Encounter
  async authenticate(login, password) {
    try {
      await this._waitRateLimit();

      const formData = new URLSearchParams();
      formData.append('Login', login);
      formData.append('Password', password);
      formData.append('ddlNetwork', '1');

      const maskedLogin = this._maskLogin(login);
      this._log('info', 'Запрос авторизации Encounter', { login: maskedLogin });

      const response = await axios.post(`${this.domain}/login/signin?json=1`, formData, {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const normalized = this._normalizeAuthResponse(response);

      if (!normalized.success && normalized.code === 'IP_BLOCKED' && this._isHtmlPayload(response.data)) {
        await this._saveErrorHtml(response.data, 'auth-blocked');
      }

      if (normalized.success) {
        this._log('info', 'Encounter авторизация успешна', {
          login: maskedLogin,
          cookies: Object.keys(normalized.cookies || {})
        });
      } else {
        this._log('warn', 'Encounter авторизация завершилась с ошибкой', {
          login: maskedLogin,
          code: normalized.code,
          errorCode: normalized.errorCode || null,
          message: normalized.message
        });
      }

      return normalized;
    } catch (error) {
      this._log('error', 'Ошибка авторизации Encounter', { login: this._maskLogin(login), err: error });

      if (error.response && this._isHtmlPayload(error.response.data)) {
        await this._saveErrorHtml(error.response.data, 'auth-error');
        return {
          success: false,
          code: 'INVALID_RESPONSE',
          message: 'Encounter вернул HTML вместо JSON при авторизации'
        };
      }

      return this._normalizeAuthError(error);
    }
  }

  // Получение состояния игры с автоматической реаутентификацией
  async getGameState(gameId, authCookies, login = null, password = null, isRetry = false) {
    try {
      // Rate limiting: ждём минимум 1.2 сек с последнего запроса к этому домену
      await this._waitRateLimit();

      const baseContext = {
        gameId,
        login: this._maskLogin(login)
      };
      const cookieString = this._buildCookieString(authCookies);
      const response = await this._fetchGameState(gameId, cookieString, baseContext);

      const data = response.data;
      this._ensureGameStateAuthorized(data, baseContext);

      return {
        success: true,
        data
      };
    } catch (error) {
      // Если сессия истекла И есть данные для реаутентификации И это не повторная попытка
      if (this._shouldAttemptAuthRetry(error, login, password, isRetry)) {
        try {
          const authResult = await this._performReauthentication(login, password, authCookies, {
            gameId,
            login: this._maskLogin(login)
          });
          const retryState = await this.getGameState(
            gameId,
            authResult.cookies,
            login,
            password,
            true
          );
          if (retryState && retryState.success) {
            retryState.newCookies = authResult.cookies;
          }
          return retryState;
        } catch (authError) {
          if (!(authError instanceof AuthRequiredError) || !authError.reAuthFailed) {
            throw authError;
          }
          throw authError;
        }
      }

      this._log('error', 'Ошибка получения состояния игры', {
        gameId,
        login: this._maskLogin(login),
        err: error
      });

      throw this._normalizeNetworkError(error, {
        operation: 'getGameState',
        context: { gameId }
      });
    }
  }

  // Отправка ответа в игру по официальному API Encounter с автоматической реаутентификацией
  async sendAnswer(
    gameId,
    answer,
    authCookies,
    login = null,
    password = null,
    isRetry = false,
    expectedLevelId = null
  ) {
    const baseContext = {
      gameId,
      login: this._maskLogin(login),
      expectedLevelId
    };

    try {
      if (!authCookies || Object.keys(authCookies).length === 0) {
        throw new AuthRequiredError(
          'Отсутствуют данные авторизации. Необходимо повторно авторизоваться.'
        );
      }

      const { levelData, model, newCookies } = await this._loadLevelContext({
        gameId,
        authCookies,
        login,
        password,
        baseContext
      });
      const effectiveCookies = newCookies || authCookies;

      this._ensureLevelNotBlocked(model, levelData, baseContext);

      const currentLevelIdFromState = levelData.levelId;
      const currentLevelNumberFromState = levelData.levelNumber;
      const expectedLevelIdForCheck = expectedLevelId || currentLevelIdFromState;

      this._log('info', 'Проверяю соответствие уровня перед отправкой ответа', {
        ...baseContext,
        expectedLevelId: expectedLevelIdForCheck,
        currentLevelId: currentLevelIdFromState
      });

      const cookieString = this._buildCookieString(effectiveCookies);

      this._log('info', 'Отправляю ответ в Encounter', {
        ...baseContext,
        levelId: levelData.levelId,
        levelNumber: levelData.levelNumber,
        answerLength: answer?.length ?? 0
      });

      this._log('info', 'Повторная проверка актуальности уровня перед отправкой', baseContext);
      await this._ensureLevelCurrentBeforeSend({
        gameId,
        authCookies: effectiveCookies,
        login,
        password,
        expectedLevelId: expectedLevelIdForCheck,
        currentLevelIdFromState,
        currentLevelNumberFromState,
        answer,
        baseContext
      });

      await this._waitRateLimit();

      const response = await this._executeSendAnswerRequest({
        gameId,
        levelData,
        answer,
        cookieString,
        baseContext
      });

      const result = response.data;
      const analysis = this._interpretAnswerResponse({
        result,
        levelData,
        baseContext,
        answer,
        gameId,
        login
      });

      return {
        success: true,
        correct: analysis.isCorrect,
        message: analysis.message,
        levelNumber: levelData.levelNumber,
        data: result,
        level: analysis.level,
        newCookies: newCookies || null
      };
    } catch (error) {
      if (!isRetry) {
        this._invalidateLevelCache(gameId, 'ошибка отправки ответа', login);
      }

      if (this._shouldAttemptAuthRetry(error, login, password, isRetry)) {
        this._log('info', 'Сессия Encounter истекла при отправке ответа, выполняю реаутентизацию', {
          ...baseContext,
          err: error
        });

        try {
          const authResult = await this._performReauthentication(
            login,
            password,
            authCookies,
            baseContext
          );
          this._log('info', 'Автоматическая реаутентификация успешна, повторяю отправку ответа', baseContext);

          const retryResult = await this.sendAnswer(
            gameId,
            answer,
            authResult.cookies,
            login,
            password,
            true,
            expectedLevelId
          );
          if (retryResult && retryResult.success) {
            retryResult.newCookies = authResult.cookies;
          }
          return retryResult;
        } catch (authError) {
          if (!(authError instanceof AuthRequiredError) || !authError.reAuthFailed) {
            throw authError;
          }
          throw authError;
        }
      }

      this._log('error', 'Ошибка отправки ответа в Encounter', {
        ...baseContext,
        err: error
      });

      throw this._normalizeNetworkError(error, {
        operation: 'sendAnswer',
        context: { gameId, expectedLevelId }
      });
    }
  }

  // Получение информации об игре с автоматической реаутентификацией
  async getGameInfo(gameId, authCookies, login = null, password = null) {
    try {
      const gameState = await this.getGameState(gameId, authCookies, login, password);

      if (gameState.success) {
        const model = gameState.data;
        return {
          success: true,
          data: {
            id: model.GameId || gameId,
            name: model.GameTitle || `Игра #${gameId}`,
            number: model.GameNumber,
            status: model.Event === 0 ? 'active' : 'inactive',
            level: model.Level
              ? {
                  id: model.Level.LevelId,
                  name: model.Level.Name,
                  number: model.Level.Number,
                  isPassed: model.Level.IsPassed,
                  sectorsTotal: model.Level.RequiredSectorsCount,
                  sectorsPassed: model.Level.PassedSectorsCount
                }
              : null,
            team: model.TeamName,
            login: model.Login
          }
        };
      } else {
        throw new EncounterError('Не удалось получить состояние игры', { code: 'GAME_STATE_FAILED' });
      }
    } catch (error) {
      const normalized = this._normalizeNetworkError(error, {
        operation: 'getGameInfo',
        context: { gameId }
      });

      this._log('error', 'Ошибка получения информации об игре', {
        gameId,
        err: normalized
      });

      return {
        success: false,
        error: normalized.message
      };
    }
  }

  // Проверка соединения
  async checkConnection() {
    try {
      // Rate limiting: ждём минимум 1.2 сек с последнего запроса к этому домену
      await this._waitRateLimit();

      // Попробуем получить главную страницу
      const response = await axios.get(this.domain, {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      return response.status === 200;
    } catch (error) {
      const normalized = this._normalizeNetworkError(error, {
        operation: 'checkConnection'
      });
      this._log('warn', 'Encounter проверка соединения не удалась', {
        err: normalized,
        message: normalized.message
      });
      return false;
    }
  }

  // Получение списка игр домена
  async getGamesList() {
    try {
      // Rate limiting: ждём минимум 1.2 сек с последнего запроса к этому домену
      await this._waitRateLimit();

      const response = await axios.get(`${this.domain}/home/?json=1`, {
        timeout: this.timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      return {
        success: true,
        comingGames: response.data.ComingGames || [],
        activeGames: response.data.ActiveGames || []
      };
    } catch (error) {
      const normalized = this._normalizeNetworkError(error, {
        operation: 'getGamesList'
      });

      this._log('error', 'Ошибка получения списка игр Encounter', { err: normalized });
      return {
        success: false,
        error: normalized.message
      };
    }
  }
}

module.exports = EncounterAPI;


