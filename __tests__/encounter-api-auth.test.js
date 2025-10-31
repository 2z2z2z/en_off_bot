jest.mock('axios');

const axios = require('axios');
const EncounterAPI = require('../encounter-api');
const { logger } = require('../src/infra/logger');

describe('EncounterAPI.authenticate', () => {
  let api;
  let waitSpy;
  let saveSpy;

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
    waitSpy = jest.spyOn(api, '_waitRateLimit').mockResolvedValue();
    saveSpy = jest.spyOn(api, '_saveErrorHtml').mockResolvedValue();
    axios.post.mockReset();
  });

  afterEach(() => {
    waitSpy.mockRestore();
    saveSpy.mockRestore();
  });

  it('возвращает IP_BLOCKED и сохраняет HTML, если Encounter прислал HTML-ответ', async () => {
    const htmlPayload = '<html><body>Too many requests</body></html>';

    axios.post.mockResolvedValue({
      data: htmlPayload,
      headers: {}
    });

    const result = await api.authenticate('login', 'password');

    expect(result.success).toBe(false);
    expect(result.code).toBe('IP_BLOCKED');
    expect(api._saveErrorHtml).toHaveBeenCalledWith(htmlPayload, 'auth-blocked');
  });

  it('возвращает INVALID_RESPONSE и сохраняет HTML при HTML-ошибке в ответе', async () => {
    const htmlError = '<html><body>Error</body></html>';

    axios.post.mockRejectedValue({
      response: { data: htmlError }
    });

    const result = await api.authenticate('login', 'password');

    expect(result).toEqual({
      success: false,
      code: 'INVALID_RESPONSE',
      message: 'Encounter вернул HTML вместо JSON при авторизации'
    });
    expect(api._saveErrorHtml).toHaveBeenCalledWith(htmlError, 'auth-error');
  });
});
