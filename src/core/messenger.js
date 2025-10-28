'use strict';

const transports = new Map();

function registerTransport(platform, transport) {
  if (!platform) {
    throw new Error('registerTransport: platform is required');
  }
  transports.set(platform, transport);
}

function getTransport(platform) {
  if (!transports.has(platform)) {
    throw new Error(`Transport for platform "${platform}" не зарегистрирован`);
  }
  return transports.get(platform);
}

async function sendMessage(platform, userId, text, options = {}) {
  const transport = getTransport(platform);
  if (!transport.sendMessage) {
    throw new Error(`Transport "${platform}" не поддерживает sendMessage`);
  }
  return transport.sendMessage(userId, text, options);
}

async function editMessage(platform, userId, messageId, text, options = {}) {
  const transport = getTransport(platform);
  if (!transport.editMessage) {
    throw new Error(`Transport "${platform}" не поддерживает editMessage`);
  }
  return transport.editMessage(userId, messageId, text, options);
}

async function deleteMessage(platform, userId, messageId) {
  const transport = getTransport(platform);
  if (!transport.deleteMessage) {
    throw new Error(`Transport "${platform}" не поддерживает deleteMessage`);
  }
  return transport.deleteMessage(userId, messageId);
}

async function sendTyping(platform, userId) {
  const transport = getTransport(platform);
  if (!transport.sendTyping) {
    return;
  }
  return transport.sendTyping(userId);
}

async function answerCallback(platform, data) {
  const transport = getTransport(platform);
  if (!transport.answerCallback) {
    return;
  }
  return transport.answerCallback(data);
}

module.exports = {
  registerTransport,
  sendMessage,
  editMessage,
  deleteMessage,
  sendTyping,
  answerCallback
};
