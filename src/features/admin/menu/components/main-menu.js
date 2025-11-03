function buildMainMenu({
  platform,
  userCount,
  moderationEnabled,
  whitelistCount,
  createInlineKeyboard
}) {
  const moderationStatus = moderationEnabled ? 'enabled' : 'disabled';

  const text =
    `<b>Admin panel</b>\n\n` +
    `Users: ${userCount}\n` +
    `Moderation: ${moderationStatus}\n` +
    `Whitelist: ${whitelistCount} records`;

  const keyboard = createInlineKeyboard(platform, [
    [{ text: 'Users', action: 'admin_users_0' }],
    [{ text: 'Moderation', action: 'admin_moderation' }],
    [{ text: 'Whitelist', action: 'admin_whitelist_0' }]
  ]);

  return { text, keyboard };
}

module.exports = {
  buildMainMenu
};
