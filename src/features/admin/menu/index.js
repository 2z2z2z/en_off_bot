const { buildMainMenu } = require('./components/main-menu');
const { buildUsersList } = require('./components/users');
const { buildModerationMenu } = require('./components/moderation');
const { buildWhitelistMenu, buildWhitelistAddPrompt } = require('./components/whitelist');

const WHITELIST_INPUT_STATE = 'WAITING_FOR_WHITELIST_ENTRY';

function createAdminMenu(deps) {
  const {
    logger,
    userData,
    adminConfig,
    saveAdminConfig,
    createInlineKeyboard,
    editTelegramMessage,
    sendMessage,
    setUserState,
    clearUserState,
    answerTelegramCallback,
    getTelegramPlatform,
    whitelistService
  } = deps;

  const getPlatform = () => getTelegramPlatform();

  async function showAdminMainMenu(chatId) {
    const platform = getPlatform();
    const { text, keyboard } = buildMainMenu({
      platform,
      userCount: userData.size,
      moderationEnabled: adminConfig.moderationEnabled,
      whitelistCount: whitelistService.listEntries().length,
      createInlineKeyboard
    });

    await sendMessage(platform, chatId, text, {
      parse_mode: 'HTML',
      ...keyboard
    });
  }

  async function showUsersList(chatId, messageId, page = 0) {
    const platform = getPlatform();
    const USERS_PER_PAGE = 10;
    const allUsers = Array.from(userData.entries());
    const totalPages = Math.max(1, Math.ceil(allUsers.length / USERS_PER_PAGE));
    const start = page * USERS_PER_PAGE;
    const pageUsers = allUsers.slice(start, start + USERS_PER_PAGE).map(([storageKey, user]) => {
      const [keyPlatform, ...restKey] = storageKey.split('::');
      const resolvedPlatform = user.platform || keyPlatform || platform;
      const plainUserId = user.userId || (restKey.length > 0 ? restKey.join('::') : storageKey);
      return {
        displayName: user.telegramUsername
          ? `@${user.telegramUsername}`
          : user.telegramFirstName || 'No name',
        userId: plainUserId,
        platform: resolvedPlatform,
        login: user.login || 'N/A',
        firstActivity: user.firstActivity
          ? new Date(user.firstActivity).toLocaleDateString('en-GB')
          : 'N/A',
        lastActivity: user.lastActivity ? new Date(user.lastActivity).toLocaleString('en-GB') : 'N/A'
      };
    });

    const { text, keyboard } = buildUsersList({
      platform,
      users: pageUsers,
      page,
      totalPages,
      createInlineKeyboard
    });

    await editTelegramMessage(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      ...keyboard
    });
  }

  async function showModerationMenu(chatId, messageId) {
    const platform = getPlatform();
    const { text, keyboard } = buildModerationMenu({
      platform,
      moderationEnabled: adminConfig.moderationEnabled,
      createInlineKeyboard
    });

    await editTelegramMessage(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      ...keyboard
    });
  }

  async function showWhitelistMenu(chatId, messageId, page = 0) {
    const platform = getPlatform();
    const ITEMS_PER_PAGE = 10;
    const entries = whitelistService.listEntries();
    const totalPages = Math.max(1, Math.ceil(entries.length / ITEMS_PER_PAGE));
    const start = page * ITEMS_PER_PAGE;
    const pageEntries = entries.slice(start, start + ITEMS_PER_PAGE).map((entry, index) => ({
      index: start + index + 1,
      originalIndex: start + index,
      login: entry.login
    }));

    const { text, keyboard } = buildWhitelistMenu({
      platform,
      entries: pageEntries,
      page,
      totalPages,
      createInlineKeyboard
    });

    await editTelegramMessage(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      ...keyboard
    });
  }

  async function handleWhitelistAdd(chatId, messageId) {
    const platform = getPlatform();
    const { text, keyboard } = buildWhitelistAddPrompt({
      platform,
      createInlineKeyboard
    });

    await editTelegramMessage(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      ...keyboard
    });

    setUserState(platform, String(chatId), WHITELIST_INPUT_STATE);
  }

  async function handleWhitelistRemove(chatId, messageId, index, queryId = null) {
    const entries = whitelistService.listEntries();
    const entry = entries[index];

    if (!entry) {
      if (queryId) {
        await answerTelegramCallback(queryId, {
          text: 'Error: entry not found',
          show_alert: true
        });
      }
      return;
    }

    try {
      whitelistService.removeEntry(entry.login);
      await whitelistService.save();
      if (queryId) {
        await answerTelegramCallback(queryId, {
          text: 'Removed from whitelist'
        });
      }
      await showWhitelistMenu(chatId, messageId, 0);
    } catch (error) {
      logger.error('Failed to remove whitelist entry:', error);
      if (queryId) {
        await answerTelegramCallback(queryId, {
          text: `Error: ${error.message}`,
          show_alert: true
        });
      }
    }
  }

  async function handleWhitelistManualEntry(platform, userId, loginInput) {
    if (platform !== getPlatform()) {
      return;
    }

    const login = String(loginInput || '').trim();
    if (login.length < 2) {
      await sendMessage(platform, userId, 'Login must contain at least 2 characters');
      return;
    }

    try {
      whitelistService.addEntry({ login, addedBy: userId });
      await whitelistService.save();
      await sendMessage(platform, userId, `Added to whitelist:\n<code>${login}</code>`, {
        parse_mode: 'HTML'
      });
      clearUserState(platform, userId);
    } catch (error) {
      await sendMessage(platform, userId, `Error: ${error.message}`);
    }
  }

  async function toggleModeration(chatId, messageId) {
    adminConfig.moderationEnabled = !adminConfig.moderationEnabled;
    await saveAdminConfig();
    await showModerationMenu(chatId, messageId);
  }

  return {
    showAdminMainMenu,
    showUsersList,
    showModerationMenu,
    showWhitelistMenu,
    handleWhitelistAdd,
    handleWhitelistRemove,
    handleWhitelistManualEntry,
    toggleModeration
  };
}

module.exports = {
  createAdminMenu,
  WHITELIST_INPUT_STATE
};

