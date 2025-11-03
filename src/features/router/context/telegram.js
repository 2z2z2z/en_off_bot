function createTelegramContextFactory(getTelegramPlatform) {
  const resolvePlatform = () => getTelegramPlatform();

  function createMessageContext(msg, overrides = {}) {
    const chatId = String(msg.chat?.id ?? '');
    return {
      platform: resolvePlatform(),
      userId: chatId,
      text: msg.text ?? '',
      from: msg.from
        ? {
            id: msg.from.id,
            username: msg.from.username,
            firstName: msg.from.first_name,
            lastName: msg.from.last_name
          }
        : null,
      meta: {
        chatId: msg.chat?.id,
        messageId: msg.message_id,
        chatType: msg.chat?.type,
        chat: msg.chat,
        raw: msg
      },
      ...overrides
    };
  }

  function createCallbackContext(query, overrides = {}) {
    const chatId = query.message?.chat?.id ?? query.from?.id;
    const messageId = query.message?.message_id;
    return {
      platform: resolvePlatform(),
      userId: String(chatId ?? ''),
      text: query.data ?? '',
      payload: query.data,
      meta: {
        chatId,
        messageId,
        queryId: query.id,
        raw: query,
        from: query.from,
        message: query.message
      },
      ...overrides
    };
  }

  return {
    createMessageContext,
    createCallbackContext
  };
}

module.exports = {
  createTelegramContextFactory
};

