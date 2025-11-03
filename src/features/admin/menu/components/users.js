function buildUsersList({ platform, users, page, totalPages, createInlineKeyboard }) {
  if (users.length === 0) {
    const keyboard = createInlineKeyboard(platform, [[{ text: 'Back', action: 'admin_back' }]]);
    return { text: '<b>Users</b>\n\nNo users found', keyboard };
  }

  let text = `<b>Users</b> (page ${page + 1}/${totalPages})\n\n`;
  users.forEach(user => {
    text += `<b>${user.displayName}</b>\n`;
    text += `ID: <code>${user.userId}</code>\n`;
    text += `Platform: ${user.platform}\n`;
    text += `Encounter login: <code>${user.login}</code>\n`;
    text += `First activity: ${user.firstActivity}\n`;
    text += `Last activity: ${user.lastActivity}\n\n`;
  });

  const buttons = [];
  const navButtons = [];
  if (page > 0) {
    navButtons.push({ text: 'Back', action: `admin_users_${page - 1}` });
  }
  if (page < totalPages - 1) {
    navButtons.push({ text: 'Next', action: `admin_users_${page + 1}` });
  }

  if (navButtons.length > 0) {
    buttons.push(navButtons);
  }

  buttons.push([{ text: 'Main menu', action: 'admin_back' }]);

  const keyboard = createInlineKeyboard(platform, buttons);

  return { text, keyboard };
}

module.exports = {
  buildUsersList
};
