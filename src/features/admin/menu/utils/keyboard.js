function chunkButtons(buttons, size) {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    return [];
  }

  const chunks = [];
  for (let i = 0; i < buttons.length; i += size) {
    chunks.push(buttons.slice(i, i + size));
  }
  return chunks;
}

module.exports = {
  chunkButtons
};
