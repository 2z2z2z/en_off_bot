function createFakeEncounterAPI(initialHandlers = {}) {
  const handlers = {
    authenticate: async () => ({ success: true, cookies: {} }),
    getGameState: async () => ({
      success: true,
      data: { Level: { LevelId: 1, Number: 1 } }
    }),
    sendAnswer: async () => ({
      success: true,
      message: 'ok',
      levelNumber: 1,
      level: { LevelId: 1, Number: 1 }
    }),
    ...initialHandlers
  };

  class FakeEncounterAPI {
    constructor() {
      this.handlers = handlers;
    }

    authenticate(...args) {
      return this.handlers.authenticate(...args);
    }

    getGameState(...args) {
      return this.handlers.getGameState(...args);
    }

    sendAnswer(...args) {
      return this.handlers.sendAnswer(...args);
    }
  }

  return { FakeEncounterAPI, handlers };
}

module.exports = { createFakeEncounterAPI };
