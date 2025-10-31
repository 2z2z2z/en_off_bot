const DEFAULT_ERROR_CODE = 'ENCOUNTER_ERROR';

class EncounterError extends Error {
  constructor(message, options = {}) {
    super(message);

    Object.setPrototypeOf(this, new.target.prototype);

    this.name = new.target.name;
    this.code = options.code || DEFAULT_ERROR_CODE;
    this.details = options.details || null;
    this.retryable = Boolean(options.retryable);
    this.status = options.status || null;
    this.context = options.context || null;
  }
}

class AuthRequiredError extends EncounterError {
  constructor(message = 'Требуется повторная авторизация', options = {}) {
    super(message, {
      ...options,
      code: options.code || 'AUTH_REQUIRED',
      retryable: false
    });
    this.needsAuth = true;
  }
}

class NetworkError extends EncounterError {
  constructor(message = 'Сетевая ошибка Encounter', options = {}) {
    super(message, {
      ...options,
      code: options.code || 'NETWORK',
      retryable: true,
      status: options.status || null,
      context: options.context || null
    });
    this.original = options.original || null;
  }
}

class LevelChangedError extends EncounterError {
  constructor(message = 'Уровень игры изменился', options = {}) {
    super(message, {
      ...options,
      code: options.code || 'LEVEL_CHANGED',
      retryable: false
    });
    this.oldLevel = options.oldLevel || null;
    this.newLevel = options.newLevel || null;
    this.answer = options.answer || null;
    this.isLevelChanged = true;
  }
}

class RateLimitError extends EncounterError {
  constructor(message = 'Превышен лимит запросов', options = {}) {
    super(message, {
      ...options,
      code: options.code || 'RATE_LIMIT',
      retryable: true
    });
    this.retryAfter = options.retryAfter || null;
  }
}

module.exports = {
  EncounterError,
  AuthRequiredError,
  NetworkError,
  LevelChangedError,
  RateLimitError
};
