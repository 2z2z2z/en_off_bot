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
    getTelegramPlatform
  } = deps;

  const getPlatform = () => getTelegramPlatform();

  async function showAdminMainMenu(chatId) {
    const platform = getPlatform();
    const usersCount = userData.size;
    const moderationStatus = adminConfig.moderationEnabled ? 'включена ✅' : 'выключена ❌';
    const whitelistCount = adminConfig.whitelist ? adminConfig.whitelist.length : 0;

    const message =
      `👑 <b>Админ-панель</b>\n\n` +
      `👥 Пользователей: ${usersCount}\n` +
      `🔐 Модерация: ${moderationStatus}\n` +
      `📋 Белый список: ${whitelistCount} записей`;

    const keyboardOptions = createInlineKeyboard(platform, [
      [{ text: '👥 Пользователи', action: 'admin_users_0' }],
      [{ text: '🔐 Модерация', action: 'admin_moderation' }],
      [{ text: '📋 Белый список', action: 'admin_whitelist_0' }]
    ]);

    try {
      await sendMessage(platform, chatId, message, {
        parse_mode: 'HTML',
        ...keyboardOptions
      });
    } catch (error) {
      logger.error('Ошибка отправки админ-меню:', error);
      await sendMessage(platform, chatId, '❌ Ошибка отображения админ-панели');
    }
  }

  async function showUsersList(chatId, messageId, page = 0) {
    const platform = getPlatform();
    const USERS_PER_PAGE = 10;
    const users = Array.from(userData.entries());
    const totalPages = Math.ceil(users.length / USERS_PER_PAGE);
    const start = page * USERS_PER_PAGE;
    const end = start + USERS_PER_PAGE;
    const pageUsers = users.slice(start, end);

    if (users.length === 0) {
      const message = '👥 <b>Пользователи</b>\n\nПользователей пока нет';
      const keyboardOptions = createInlineKeyboard(platform, [
        [{ text: '◀️ Назад', action: 'admin_back' }]
      ]);

      await editTelegramMessage(message, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        ...keyboardOptions
      });
      return;
    }

    let message = `👥 <b>Пользователи</b> (страница ${page + 1}/${totalPages})\n\n`;

    for (const [storageKey, user] of pageUsers) {
      const [keyPlatform, ...restKey] = storageKey.split('::');
      const resolvedPlatform = user.platform || keyPlatform || platform;
      const plainUserId = user.userId || (restKey.length > 0 ? restKey.join('::') : storageKey);
      const username = user.telegramUsername
        ? `@${user.telegramUsername}`
        : user.telegramFirstName || 'Без имени';
      const login = user.login || '—';
      const firstActivity = user.firstActivity
        ? new Date(user.firstActivity).toLocaleDateString('ru-RU')
        : '—';
      const lastActivity = user.lastActivity
        ? new Date(user.lastActivity).toLocaleString('ru-RU')
        : '—';

      message += `<b>${username}</b>\n`;
      message += `ID: <code>${plainUserId}</code>\n`;
      message += `Платформа: ${resolvedPlatform}\n`;
      message += `Логин EN: <code>${login}</code>\n`;
      message += `Первый вход: ${firstActivity}\n`;
      message += `Последний: ${lastActivity}\n\n`;
    }

    const buttons = [];
    const navButtons = [];

    if (page > 0) {
      navButtons.push({ text: '◀️ Назад', action: `admin_users_${page - 1}` });
    }
    if (page < totalPages - 1) {
      navButtons.push({ text: 'Вперед ▶️', action: `admin_users_${page + 1}` });
    }

    if (navButtons.length > 0) {
      buttons.push(navButtons);
    }

    buttons.push([{ text: '🏠 Главное меню', action: 'admin_back' }]);

    const keyboardOptions = createInlineKeyboard(platform, buttons);

    await editTelegramMessage(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      ...keyboardOptions
    });
  }

  async function showModerationMenu(chatId, messageId) {
    const platform = getPlatform();
    const status = adminConfig.moderationEnabled ? 'включена ✅' : 'выключена ❌';
    const buttonText = adminConfig.moderationEnabled ? '❌ Выключить' : '✅ Включить';

    const message =
      `🔐 <b>Управление модерацией</b>\n\n` +
      `Текущий статус: ${status}\n\n` +
      `Когда модерация включена, доступ к боту имеют только пользователи из белого списка.`;

    const keyboardOptions = createInlineKeyboard(platform, [
      [{ text: buttonText, action: 'moderation_toggle' }],
      [{ text: '◀️ Назад', action: 'admin_back' }]
    ]);

    await editTelegramMessage(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      ...keyboardOptions
    });
  }

  async function showWhitelistMenu(chatId, messageId, page = 0) {
    const platform = getPlatform();
    const ITEMS_PER_PAGE = 10;
    const whitelist = adminConfig.whitelist || [];
    const totalPages = Math.ceil(whitelist.length / ITEMS_PER_PAGE);
    const start = page * ITEMS_PER_PAGE;
    const end = start + ITEMS_PER_PAGE;
    const pageItems = whitelist.slice(start, end);

    let message = `📋 <b>Белый список</b>\n\n`;

    if (whitelist.length === 0) {
      message += 'Белый список пуст\n\n';
      message += 'Нажмите "Добавить", чтобы добавить пользователя';
    } else {
      message += `Страница ${page + 1}/${totalPages}\n\n`;

      for (let i = 0; i < pageItems.length; i++) {
        const item = pageItems[i];
        const globalIndex = start + i;
        const login = item.login || (item.type === 'encounter' ? item.value : item.value);
        message += `${globalIndex + 1}. 🎮 <code>${login}</code>\n`;
      }
    }

    const keyboardButtons = [];

    const removeButtons = [];
    for (let i = 0; i < Math.min(pageItems.length, 5); i++) {
      const globalIndex = start + i;
      removeButtons.push({
        text: `🗑️ ${globalIndex + 1}`,
        action: `whitelist_remove_${globalIndex}`
      });
    }

    if (removeButtons.length > 0) {
      for (let i = 0; i < removeButtons.length; i += 3) {
        keyboardButtons.push(removeButtons.slice(i, i + 3));
      }
    }

    const navButtons = [];
    if (page > 0) {
      navButtons.push({ text: '◀️', action: `admin_whitelist_${page - 1}` });
    }
    navButtons.push({ text: '➕ Добавить', action: 'whitelist_add' });
    if (page < totalPages - 1) {
      navButtons.push({ text: '▶️', action: `admin_whitelist_${page + 1}` });
    }

    keyboardButtons.push(navButtons);
    keyboardButtons.push([{ text: '◀️ Назад', action: 'admin_back' }]);

    const keyboardOptions = createInlineKeyboard(platform, keyboardButtons);

    await editTelegramMessage(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      ...keyboardOptions
    });
  }

  async function handleWhitelistAdd(chatId, messageId) {
    const platform = getPlatform();
    const message =
      `➕ <b>Добавление в белый список</b>\n\n` +
      `Отправьте Encounter логин пользователя:\n\n` +
      `Пример: <code>player123</code>`;

    const keyboardOptions = createInlineKeyboard(platform, [
      [{ text: '❌ Отмена', action: 'admin_whitelist_0' }]
    ]);

    await editTelegramMessage(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      ...keyboardOptions
    });

    setUserState(platform, String(chatId), WHITELIST_INPUT_STATE);
  }

  async function handleWhitelistRemove(chatId, messageId, index, queryId = null) {
    if (!adminConfig.whitelist || index < 0 || index >= adminConfig.whitelist.length) {
      if (queryId) {
        await answerTelegramCallback(queryId, {
          text: '❌ Ошибка: запись не найдена',
          show_alert: true
        });
      }
      return;
    }

    adminConfig.whitelist.splice(index, 1);
    await saveAdminConfig();

    await showWhitelistMenu(chatId, messageId, 0);
  }

  async function handleWhitelistManualEntry(platform, userId, loginInput) {
    const telegramPlatform = getPlatform();
    if (platform !== telegramPlatform) {
      return;
    }

    const login = loginInput.trim();

    if (login.length < 2) {
      await sendMessage(platform, userId, '❌ Логин должен содержать минимум 2 символа');
      return;
    }

    const exists = adminConfig.whitelist.some(item => {
      const itemLogin = item.login || (item.type === 'encounter' ? item.value : null);
      return itemLogin && itemLogin.toLowerCase() === login.toLowerCase();
    });

    if (exists) {
      await sendMessage(platform, userId, '⚠️ Этот логин уже есть в белом списке');
      clearUserState(platform, userId);
      return;
    }

    adminConfig.whitelist.push({
      login,
      addedBy: userId,
      addedAt: Date.now()
    });

    await saveAdminConfig();
    await sendMessage(platform, userId, `✅ Добавлено в белый список:\n🎮 <code>${login}</code>`, {
      parse_mode: 'HTML'
    });

    clearUserState(platform, userId);
  }

  return {
    showAdminMainMenu,
    showUsersList,
    showModerationMenu,
    showWhitelistMenu,
    handleWhitelistAdd,
    handleWhitelistRemove,
    handleWhitelistManualEntry
  };
}

module.exports = {
  createAdminMenu,
  WHITELIST_INPUT_STATE
};

