function parseGameUrl(url) {
  try {
    const urlObj = new URL(url);
    const domain = `${urlObj.protocol}//${urlObj.hostname}`;

    if (urlObj.pathname.includes('/GameDetails.aspx') && urlObj.searchParams.has('gid')) {
      const gameId = urlObj.searchParams.get('gid');
      return {
        success: true,
        domain,
        gameId,
        type: 'GameDetails'
      };
    }

    const playMatch = urlObj.pathname.match(/\/gameengines\/encounter\/play\/(\d+)\/?$/);
    if (playMatch) {
      return {
        success: true,
        domain,
        gameId: playMatch[1],
        type: 'Play'
      };
    }

    return {
      success: false,
      message:
        'Неправильная ссылка на игру. Поддерживаются только:\n• https://domain.en.cx/GameDetails.aspx?gid=XXXXX\n• https://domain.en.cx/gameengines/encounter/play/XXXXX/'
    };
  } catch (error) {
    return {
      success: false,
      message: 'Неправильный формат ссылки. Пример: https://tech.en.cx/GameDetails.aspx?gid=80646'
    };
  }
}

module.exports = { parseGameUrl };
