const { chunkButtons } = require('../utils/keyboard');

function buildWhitelistMenu({ platform, entries, page, totalPages, createInlineKeyboard }) {
  let text = `<b>Whitelist</b>\n\n`;

  if (entries.length === 0) {
    text += 'Whitelist is empty\n\n';
    text += 'Press "Add" to insert a user';
  } else {
    text += `Page ${page + 1}/${totalPages}\n\n`;
    entries.forEach(entry => {
      text += `${entry.index}. <code>${entry.login}</code>\n`;
    });
  }

  const buttons = [];

  if (entries.length > 0) {
    const removeButtons = entries.slice(0, 5).map(entry => ({
      text: `${entry.index}`,
      action: `whitelist_remove_${entry.originalIndex}`
    }));
    buttons.push(...chunkButtons(removeButtons, 3));
  }

  const navButtons = [];
  if (page > 0) {
    navButtons.push({ text: 'Back', action: `admin_whitelist_${page - 1}` });
  }
  navButtons.push({ text: 'Add', action: 'whitelist_add' });
  if (page < totalPages - 1) {
    navButtons.push({ text: 'Next', action: `admin_whitelist_${page + 1}` });
  }
  buttons.push(navButtons);
  buttons.push([{ text: 'Main menu', action: 'admin_back' }]);

  const keyboard = createInlineKeyboard(platform, buttons);
  return { text, keyboard };
}

function buildWhitelistAddPrompt({ platform, createInlineKeyboard }) {
  const text =
    `<b>Add to whitelist</b>\n\n` +
    `Send Encounter login of the user:\n\n` +
    `Example: <code>player123</code>`;

  const keyboard = createInlineKeyboard(platform, [[{ text: 'Cancel', action: 'admin_whitelist_0' }]]);

  return { text, keyboard };
}

module.exports = {
  buildWhitelistMenu,
  buildWhitelistAddPrompt
};
