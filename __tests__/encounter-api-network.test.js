jest.mock('axios');

const axios = require('axios');
const EncounterAPI = require('../encounter-api');
const { RateLimitError, NetworkError } = require('../src/core/encounter-errors');
const { logger } = require('../src/infra/logger');

describe('EncounterAPI network errors', () => {
  let api;

  beforeAll(() => {
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    if (typeof logger.debug === 'function') {
      jest.spyOn(logger, 'debug').mockImplementation(() => {});
    }
  });

  afterAll(() => {
    logger.error.mockRestore();
    logger.warn.mockRestore();
    logger.info.mockRestore();
    if (logger.debug && logger.debug.mockRestore) {
      logger.debug.mockRestore();
    }
  });

  beforeEach(() => {
    api = new EncounterAPI('example.com');
    jest.spyOn(api, '_waitRateLimit').mockResolvedValue();
    axios.get.mockReset();
    axios.post.mockReset();
  });

  afterEach(() => {
    api._waitRateLimit.mockRestore();
  });

  it('преобразует HTTP 429 в RateLimitError и возвращает retryAfter', () => {
    const rawError = {
      response: {
        status: 429,
        headers: { 'retry-after': '120' },
        data: { message: 'Too many requests' }
      }
    };

    const normalized = api._normalizeNetworkError(rawError, {
      operation: 'sendAnswer',
      context: { gameId: 42 }
    });

    expect(normalized).toBeInstanceOf(RateLimitError);
    expect(normalized.retryAfter).toBe(120);
    expect(normalized.context).toEqual({ gameId: 42 });
    expect(normalized.retryable).toBe(true);
    expect(normalized.code).toBe('RATE_LIMIT');
  });

  it('преобразует таймауты ETIMEDOUT в retryable NetworkError', () => {
    const timeoutError = new Error('timeout');
    timeoutError.code = 'ETIMEDOUT';

    const normalized = api._normalizeNetworkError(timeoutError, {
      operation: 'getGameState',
      context: { gameId: 7 }
    });

    expect(normalized).toBeInstanceOf(NetworkError);
    expect(normalized.code).toBe('ETIMEDOUT');
    expect(normalized.retryable).toBe(true);
    expect(normalized.context).toEqual({ gameId: 7 });
    expect(normalized.message).toMatch(/Превышено время ожидания/i);
  });
});
