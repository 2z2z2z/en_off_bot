const { createAdminMenu, WHITELIST_INPUT_STATE } = require('../index');
const { createWhitelistService } = require('../../../../entities/user/service/whitelist-service');

const buildDeps = overrides => {
  const state = {
    adminConfig: {
      moderationEnabled: true,
      whitelist: []
    },
    messages: [],
    editedMessages: [],
    userState: new Map(),
    whitelistCache: new Set(),
    saved: false
  };

  const whitelistService = createWhitelistService({
    adminConfig: state.adminConfig,
    whitelistCache: state.whitelistCache,
    async saveAdminConfig() {
      state.saved = true;
    }
  });

  const baseDeps = {
    logger: { info: jest.fn(), error: jest.fn() },
    userData: new Map([
      [
        'telegram::1',
        {
          login: 'user1',
          telegramUsername: 'user1',
          firstActivity: Date.now(),
          lastActivity: Date.now()
        }
      ]
    ]),
    adminConfig: state.adminConfig,
    saveAdminConfig: jest.fn(async () => {
      state.saved = true;
    }),
    createInlineKeyboard: jest.fn(() => ({})),
    editTelegramMessage: jest.fn(async (text, options) => {
      state.editedMessages.push({ text, options });
    }),
    sendMessage: jest.fn(async (platform, chatId, text) => {
      state.messages.push({ platform, chatId, text });
    }),
    setUserState: jest.fn((platform, userId, value) => {
      state.userState.set(`${platform}:${userId}`, value);
    }),
    clearUserState: jest.fn((platform, userId) => {
      state.userState.delete(`${platform}:${userId}`);
    }),
    answerTelegramCallback: jest.fn(),
    getTelegramPlatform: () => 'telegram',
    whitelistService,
    ...overrides
  };

  return {
    menu: createAdminMenu(baseDeps),
    deps: baseDeps,
    state,
    whitelistService
  };
};

describe('admin menu', () => {
  test('showAdminMainMenu sends message', async () => {
    const { menu, deps } = buildDeps();

    await menu.showAdminMainMenu('chat');
    expect(deps.sendMessage).toHaveBeenCalled();
  });

  test('showUsersList handles empty users', async () => {
    const { menu, deps } = buildDeps({ userData: new Map() });
    await menu.showUsersList('chat', 1, 0);
    expect(deps.editTelegramMessage).toHaveBeenCalled();
  });

  test('handleWhitelistAdd sets state', async () => {
    const { menu, deps, state } = buildDeps();
    await menu.handleWhitelistAdd('chat', 1);
    expect(deps.setUserState).toHaveBeenCalled();
    expect(state.userState.get('telegram:chat')).toBe(WHITELIST_INPUT_STATE);
  });

  test('handleWhitelistManualEntry adds login', async () => {
    const { menu, whitelistService } = buildDeps();
    await menu.handleWhitelistManualEntry('telegram', 'owner', 'player1');
    expect(whitelistService.listEntries()).toHaveLength(1);
    expect(whitelistService.listEntries()[0].login).toBe('player1');
  });
});
