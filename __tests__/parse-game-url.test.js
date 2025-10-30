const { parseGameUrl } = require('../src/utils/parse-game-url');

describe('parseGameUrl', () => {
  test('распознает GameDetails ссылку', () => {
    const result = parseGameUrl('https://tech.en.cx/GameDetails.aspx?gid=80646');

    expect(result).toEqual({
      success: true,
      domain: 'https://tech.en.cx',
      gameId: '80646',
      type: 'GameDetails'
    });
  });

  test('распознает play ссылку с завершающим слэшем', () => {
    const result = parseGameUrl('https://minsk.en.cx/gameengines/encounter/play/12345/');

    expect(result).toEqual({
      success: true,
      domain: 'https://minsk.en.cx',
      gameId: '12345',
      type: 'Play'
    });
  });

  test('отклоняет неподдерживаемый путь', () => {
    const result = parseGameUrl('https://tech.en.cx/some/other/path?gid=123');

    expect(result.success).toBe(false);
    expect(result.message).toContain('Неправильная ссылка');
  });

  test('обрабатывает невалидный формат URL', () => {
    const result = parseGameUrl('not-a-url');

    expect(result.success).toBe(false);
    expect(result.message).toContain('Неправильный формат');
  });
});
