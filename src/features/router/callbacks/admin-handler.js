const ADMIN_ACTIONS = [
  'admin_moderation',
  'admin_back',
  'moderation_toggle',
  'whitelist_add'
];

const ADMIN_PREFIX_ACTIONS = ['admin_users_', 'admin_whitelist_', 'whitelist_remove_'];

const isAdminAction = action =>
  ADMIN_ACTIONS.includes(action) ||
  ADMIN_PREFIX_ACTIONS.some(prefix => action.startsWith(prefix));

async function handleUsersList(deps, context, action) {
  const { showUsersList } = deps;
  const { chatId, messageId, queryId, answerCb } = context;
  const page = parseInt(action.split('_')[2], 10) || 0;
  await showUsersList(chatId, messageId, page);
  if (queryId) await answerCb({ queryId });
}

async function handleModerationMenu(deps, context) {
  const { showModerationMenu } = deps;
  const { chatId, messageId, queryId, answerCb } = context;
  await showModerationMenu(chatId, messageId);
  if (queryId) await answerCb({ queryId });
}

async function handleWhitelistMenu(deps, context, action) {
  const { clearUserState, showWhitelistMenu, getTelegramPlatform } = deps;
  const { chatId, messageId, userId, queryId, answerCb } = context;
  const page = parseInt(action.split('_')[2], 10) || 0;
  clearUserState(getTelegramPlatform(), userId);
  await showWhitelistMenu(chatId, messageId, page);
  if (queryId) await answerCb({ queryId });
}

async function handleAdminBack(deps, context) {
  const { clearUserState, deleteMessage, showAdminMainMenu, getTelegramPlatform } = deps;
  const { chatId, messageId, userId, queryId, answerCb } = context;
  const platform = getTelegramPlatform();
  clearUserState(platform, userId);
  if (messageId) {
    await deleteMessage(platform, chatId, messageId);
  }
  await showAdminMainMenu(chatId);
  if (queryId) await answerCb({ queryId });
}

async function handleModerationToggle(deps, context) {
  const { adminConfig, saveAdminConfig, showModerationMenu } = deps;
  const { chatId, messageId, queryId, answerCb } = context;
  adminConfig.moderationEnabled = !adminConfig.moderationEnabled;
  await saveAdminConfig();
  await showModerationMenu(chatId, messageId);
  if (queryId) {
    await answerCb({
      queryId,
      text: adminConfig.moderationEnabled ? '✅ Модерация включена' : '❌ Модерация выключена'
    });
  }
}

async function handleWhitelistAddAction(deps, context) {
  const { handleWhitelistAdd } = deps;
  const { chatId, messageId, queryId, answerCb } = context;
  await handleWhitelistAdd(chatId, messageId);
  if (queryId) await answerCb({ queryId });
}

async function handleWhitelistRemoveAction(deps, context, action) {
  const { handleWhitelistRemove } = deps;
  const { chatId, messageId, queryId, answerCb } = context;
  const index = parseInt(action.split('_')[2], 10);
  await handleWhitelistRemove(chatId, messageId, index, queryId);
  if (queryId) {
    await answerCb({
      queryId,
      text: '🗑️ Удалено из белого списка'
    });
  }
}

function createAdminCallbackHandler(deps) {
  const { logger, getTelegramPlatform, getRootUserId } = deps;

  return {
    matches(action, context) {
      const platform = getTelegramPlatform();
      const rootUserId = getRootUserId();
      return (
        context.platform === platform &&
        isAdminAction(action) &&
        Number(context.chatId) === rootUserId
      );
    },

    async handle(action, context) {
      const { queryId, answerCb } = context;

      try {
        if (action.startsWith('admin_users_')) {
          await handleUsersList(deps, context, action);
        } else if (action === 'admin_moderation') {
          await handleModerationMenu(deps, context);
        } else if (action.startsWith('admin_whitelist_')) {
          await handleWhitelistMenu(deps, context, action);
        } else if (action === 'admin_back') {
          await handleAdminBack(deps, context);
        } else if (action === 'moderation_toggle') {
          await handleModerationToggle(deps, context);
        } else if (action === 'whitelist_add') {
          await handleWhitelistAddAction(deps, context);
        } else if (action.startsWith('whitelist_remove_')) {
          await handleWhitelistRemoveAction(deps, context, action);
        } else if (queryId) {
          await answerCb({ queryId });
        }
      } catch (error) {
        logger.error('Ошибка обработки admin callback:', error);
        if (queryId) {
          await answerCb({
            queryId,
            text: '❌ Ошибка обработки команды',
            show_alert: true
          });
        }
      }
    }
  };
}

module.exports = {
  createAdminCallbackHandler
};

