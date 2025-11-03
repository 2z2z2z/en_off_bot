function buildModerationMenu({ platform, moderationEnabled, createInlineKeyboard }) {
  const status = moderationEnabled ? 'enabled' : 'disabled';
  const buttonText = moderationEnabled ? 'Disable' : 'Enable';

  const text =
    `<b>Moderation control</b>\n\n` +
    `Current status: ${status}\n\n` +
    `When moderation is enabled, only whitelist users can access the bot.`;

  const keyboard = createInlineKeyboard(platform, [
    [{ text: buttonText, action: 'moderation_toggle' }],
    [{ text: 'Back', action: 'admin_back' }]
  ]);

  return { text, keyboard };
}

module.exports = {
  buildModerationMenu
};
