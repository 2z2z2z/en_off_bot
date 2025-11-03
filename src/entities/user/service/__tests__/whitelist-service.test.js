const { createWhitelistService } = require('../whitelist-service');

describe('whitelist-service', () => {
  const buildDeps = (overrides = {}) => {
    const state = {
      adminConfig: {
        moderationEnabled: true,
        whitelist: []
      },
      whitelistCache: new Set(),
      saved: false
    };

    const deps = {
      adminConfig: state.adminConfig,
      whitelistCache: state.whitelistCache,
      async saveAdminConfig() {
        state.saved = true;
      },
      ...overrides
    };

    return { service: createWhitelistService(deps), state };
  };

  test('adds entry and populates cache', async () => {
    const { service, state } = buildDeps();

    const entry = service.addEntry({ login: 'PlayerOne', addedBy: 'admin' });
    await service.save();

    expect(entry.login).toBe('playerone');
    expect(state.adminConfig.whitelist).toHaveLength(1);
    expect(state.whitelistCache.has('playerone')).toBe(true);
    expect(state.saved).toBe(true);
  });

  test('prevent duplicates', () => {
    const { service } = buildDeps();
    service.addEntry({ login: 'PlayerOne' });

    expect(() => service.addEntry({ login: 'playerone' })).toThrow(
      'Login playerone already in whitelist'
    );
  });

  test('removes entry and updates cache', () => {
    const { service, state } = buildDeps();
    service.addEntry({ login: 'PlayerOne' });

    service.removeEntry('PlayerOne');

    expect(state.adminConfig.whitelist).toHaveLength(0);
    expect(state.whitelistCache.has('playerone')).toBe(false);
  });

  test('hasAccess respects moderation flag', () => {
    const { service, state } = buildDeps();
    state.adminConfig.moderationEnabled = false;
    expect(service.hasAccess('anyone')).toBe(true);

    state.adminConfig.moderationEnabled = true;
    service.addEntry({ login: 'PlayerOne' });

    expect(service.hasAccess('playerone')).toBe(true);
    expect(service.hasAccess('other')).toBe(false);
    expect(service.hasAccess(null)).toBe(false);
  });
});
