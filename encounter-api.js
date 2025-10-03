const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

// Класс для работы с API Encounter
class EncounterAPI {
  // Статический словарь для отслеживания последнего времени запроса к каждому домену
  static lastRequestTime = {};

  // Кеш данных уровня для избежания лишних запросов getGameState
  // Структура: { "domain_gameId": { levelId, levelNumber, timestamp, isPassed } }
  static levelCache = {};

  constructor(domain) {
    this.domain = domain.startsWith('http') ? domain : `https://${domain}`;
    this.timeout = 10000; // 10 секунд таймаут
  }

  // Rate limiter: минимум 1.2 секунды между любыми запросами к одному домену
  async _waitRateLimit() {
    const now = Date.now();
    const lastTime = EncounterAPI.lastRequestTime[this.domain] || 0;
    const elapsed = now - lastTime;

    if (elapsed < 1200) {
      const waitTime = 1200 - elapsed;
      console.log(`⏱️ Rate limit: жду ${waitTime}ms перед запросом к ${this.domain}`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    EncounterAPI.lastRequestTime[this.domain] = Date.now();
  }

  // Сохранение HTML ошибок для анализа
  async _saveErrorHtml(htmlContent, prefix = 'error') {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${prefix}-${timestamp}.html`;
      const filepath = path.join(__dirname, 'error_logs', filename);

      await fs.ensureDir(path.join(__dirname, 'error_logs'));
      await fs.writeFile(filepath, htmlContent);

      console.log(`💾 HTML ошибка сохранена: ${filepath}`);
    } catch (error) {
      console.error('❌ Не удалось сохранить HTML ошибку:', error.message);
    }
  }

  // Получить данные уровня из кеша
  _getLevelFromCache(gameId) {
    const cacheKey = `${this.domain}_${gameId}`;
    const cached = EncounterAPI.levelCache[cacheKey];

    if (!cached) {
      return null;
    }

    // Кеш действителен 30 секунд
    const age = Date.now() - cached.timestamp;
    if (age > 30000) {
      console.log(`🗑️ Кеш уровня устарел (${Math.floor(age / 1000)}с), удаляем`);
      delete EncounterAPI.levelCache[cacheKey];
      return null;
    }

    return cached;
  }

  // Сохранить данные уровня в кеш
  _saveLevelToCache(gameId, levelData) {
    const cacheKey = `${this.domain}_${gameId}`;
    EncounterAPI.levelCache[cacheKey] = {
      levelId: levelData.LevelId,
      levelNumber: levelData.Number,
      isPassed: levelData.IsPassed || false,
      timestamp: Date.now()
    };
    console.log(`📦 Кеш уровня сохранён: №${levelData.Number} (LevelId: ${levelData.LevelId})`);
  }

  // Инвалидировать кеш уровня
  _invalidateLevelCache(gameId, reason = '') {
    const cacheKey = `${this.domain}_${gameId}`;
    if (EncounterAPI.levelCache[cacheKey]) {
      delete EncounterAPI.levelCache[cacheKey];
      console.log(`🗑️ Кеш уровня инвалидирован${reason ? ': ' + reason : ''}`);
    }
  }

  // Авторизация пользователя по официальному API Encounter
  async authenticate(login, password) {
    try {
      // Rate limiting: ждём минимум 1.2 сек с последнего запроса к этому домену
      await this._waitRateLimit();

      // Формируем данные в формате form-urlencoded
      const formData = new URLSearchParams();
      formData.append('Login', login);
      formData.append('Password', password);
      formData.append('ddlNetwork', '1');

      const response = await axios.post(`${this.domain}/login/signin?json=1`, formData, {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const result = response.data;

      // Валидация ответа: проверяем что это JSON объект, а не HTML страница
      if (typeof result !== 'object' || result === null) {
        console.error('❌ API вернул не объект:', typeof result);
        console.error('📄 Первые 500 символов ответа:', String(result).substring(0, 500));

        // Проверяем является ли это HTML страницей
        const resultStr = String(result);
        if (resultStr.includes('<html') || resultStr.includes('<!DOCTYPE')) {
          console.error('🚫 Encounter вернул HTML - IP заблокирован или требуется капча');
          await this._saveErrorHtml(resultStr, 'auth-blocked');
          throw new Error('IP заблокирован Encounter - слишком много запросов. Подождите 5-10 минут.');
        }

        throw new Error('API вернул некорректный формат данных (не JSON объект)');
      }

      if (result.Error === undefined || result.Error === null) {
        console.error('❌ API вернул ответ без поля Error');
        console.error('📄 Полный ответ:', JSON.stringify(result, null, 2).substring(0, 1000));
        throw new Error('Некорректный ответ от сервера - отсутствует поле Error');
      }

      if (result.Error === 0) {
        // Сохраняем куки для последующих запросов
        const cookies = response.headers['set-cookie'];
        let authCookies = {};
        
        if (cookies) {
          cookies.forEach(cookie => {
            const [nameValue] = cookie.split(';');
            const [name, value] = nameValue.split('=');
            if (['GUID', 'stoken', 'atoken'].includes(name)) {
              authCookies[name] = decodeURIComponent(value);
            }
          });
        }
        
        return {
          success: true,
          cookies: authCookies,
          message: 'Авторизация успешна'
        };
      } else {
        const errorMessages = {
          1: 'Требуется прохождение капчи. Авторизуйтесь через браузер на сайте и повторите попытку.',
          2: 'Неправильный логин или пароль',
          3: 'Пользователь заблокирован или не может авторизоваться с данного домена',
          4: 'IP адрес не в списке разрешенных',
          5: 'Ошибка на сервере',
          7: 'Пользователь заблокирован администратором',
          8: 'Новый пользователь не активирован',
          9: 'Действия расценены как брутфорс',
          10: 'E-Mail не подтвержден'
        };
        
        let message = errorMessages[result.Error] || `Ошибка авторизации (код ${result.Error})`;
        
        // Если есть URL капчи, добавляем его к сообщению
        if (result.Error === 1 && result.CaptchaUrl) {
          message += `\n\n🔗 Ссылка для прохождения капчи:\n${result.CaptchaUrl}`;
        }
        
        return {
          success: false,
          message: message
        };
      }
    } catch (error) {
      console.error('Ошибка авторизации:', error.message);
      
      // Детальная обработка HTTP ошибок
      if (error.response) {
        const status = error.response.status;
        const statusMessages = {
          400: 'Неправильный запрос - проверьте логин и пароль',
          401: 'Неверные данные авторизации',
          403: 'Доступ запрещен',
          404: 'Страница авторизации не найдена - проверьте домен',
          500: 'Ошибка сервера Encounter',
          503: 'Сервер Encounter временно недоступен'
        };
        
        return {
          success: false,
          message: statusMessages[status] || `HTTP ошибка ${status}: ${error.message}`
        };
      } else if (error.code === 'ENOTFOUND') {
        return {
          success: false,
          message: 'Домен не найден - проверьте правильность адреса'
        };
      } else if (error.code === 'ETIMEDOUT') {
        return {
          success: false,
          message: 'Превышено время ожидания - сервер не отвечает'
        };
      } else {
        return {
          success: false,
          message: error.message
        };
      }
    }
  }

  // Получение состояния игры
  async getGameState(gameId, authCookies) {
    try {
      // Rate limiting: ждём минимум 1.2 сек с последнего запроса к этому домену
      await this._waitRateLimit();

      const cookieString = Object.entries(authCookies)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');

      const url = `${this.domain}/GameEngines/Encounter/Play/${gameId}?json=1`;
      console.log(`🌐 Запрос состояния игры:`);
      console.log(`   URL: ${url}`);
      console.log(`   GameID: ${gameId}`);
      console.log(`   Domain: ${this.domain}`);
      console.log(`   Cookies: ${cookieString.substring(0, 100)}...`);

      const response = await axios.get(url, {
        timeout: this.timeout,
        headers: {
          'Cookie': cookieString,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      console.log(`✅ Успешный ответ от API, статус: ${response.status}`);

      const data = response.data;

      // Если сервер вернул HTML (страница логина) вместо JSON — сессия истекла/нет авторизации
      if (typeof data === 'string' && (data.includes('<html') || data.includes('<!DOCTYPE'))) {
        throw new Error('Требуется авторизация (сессия истекла)');
      }

      // Если явно пришел Event=4 — не авторизован
      if (data && typeof data === 'object' && data.Event === 4) {
        throw new Error('Требуется авторизация');
      }

      return {
        success: true,
        data
      };
    } catch (error) {
      console.error('❌ Ошибка получения состояния игры:', error.message);
      
      // Детальная обработка HTTP ошибок
      if (error.response) {
        const status = error.response.status;
        const data = error.response.data;
        
        console.log(`🔍 Детали HTTP ${status} ошибки:`);
        console.log(`   Статус: ${status}`);
        console.log(`   Данные ответа:`, JSON.stringify(data, null, 2));
        console.log(`   Заголовки:`, JSON.stringify(error.response.headers, null, 2));
        
        const statusMessages = {
          400: `Неправильный запрос HTTP 400. Возможные причины:
          - Неверный ID игры (${gameId})
          - Игра не существует или недоступна
          - Проблемы с авторизацией на домене
          - Неправильный формат запроса`,
          401: 'Требуется авторизация - cookies устарели',
          403: 'Доступ к игре запрещен - проверьте права участия',
          404: 'Игра не найдена - проверьте ID игры',
          500: 'Ошибка сервера Encounter'
        };
        
        throw new Error(statusMessages[status] || `HTTP ошибка ${status} при получении состояния игры`);
      } else if (error.code === 'ENOTFOUND') {
        throw new Error('Домен не найден - проверьте подключение к интернету');
      } else if (error.code === 'ETIMEDOUT') {
        throw new Error('Превышено время ожидания - сервер не отвечает');
      } else {
        throw new Error(`Ошибка получения состояния игры: ${error.message}`);
      }
    }
  }

  // Отправка ответа в игру по официальному API Encounter
  async sendAnswer(gameId, answer, authCookies) {
    try {
      // Проверяем наличие cookies авторизации
      if (!authCookies || Object.keys(authCookies).length === 0) {
        throw new Error('Отсутствуют данные авторизации. Необходимо повторно авторизоваться.');
      }

      // Пытаемся получить данные уровня из кеша
      let levelData = this._getLevelFromCache(gameId);
      let model = null;

      if (levelData) {
        // Используем кешированные данные
        console.log(`📦 Используем кеш уровня №${levelData.levelNumber} (ID: ${levelData.levelId})`);
      } else {
        // Кеша нет - получаем состояние игры
        console.log(`🔄 Кеша нет, получаем состояние игры для ${gameId}...`);
        const gameState = await this.getGameState(gameId, authCookies);

        if (!gameState.success) {
          throw new Error('Не удалось получить состояние игры');
        }

        model = gameState.data;

        // Проверяем если сервер вернул HTML вместо JSON (страница логина)
        if (typeof model === 'string' && (model.includes('<html>') || model.includes('<!DOCTYPE'))) {
          console.log(`🔒 Сервер перенаправил на страницу входа - сессия истекла`);
          throw new Error('Требуется повторная авторизация (сессия истекла)');
        }

        // Подробная проверка состояния игры согласно документации API
        console.log(`🎮 Состояние игры: Event=${model.Event}, GameId=${gameId}`);

        // Проверяем наличие Event в ответе
        if (model.Event === undefined || model.Event === null) {
          console.log(`❌ Некорректный ответ сервера: Event не определен`);
          console.log(`📄 Полный ответ (первые 500 символов):`, JSON.stringify(model, null, 2).substring(0, 500));
          throw new Error('Сервер вернул некорректные данные (Event не определен)');
        }

        if (model.Event !== 0) {
          const eventMessages = {
            1: 'Неизвестная ошибка',
            2: 'Игра с указанным ID не существует',
            3: 'Запрошенная игра не соответствует типу Encounter',
            4: 'Игрок не авторизован - требуется повторный вход',
            5: 'Игра не началась - ожидайте начала игры',
            6: 'Игра закончилась',
            7: 'Не подана заявка игроком - подайте заявку на участие',
            8: 'Не подана заявка командой - команда должна подать заявку',
            9: 'Игрок еще не принят в игру - ожидайте подтверждения',
            10: 'У игрока нет команды - вступите в команду',
            11: 'Игрок не активен в команде - активируйтесь в команде',
            12: 'В игре нет уровней',
            13: 'Превышено количество участников в команде',
            14: 'Игрок заблокирован',
            15: 'Команда заблокирована',
            16: 'Уровень изменился',
            17: 'Игра закончена'
          };

          const errorMsg = eventMessages[model.Event] || `Неизвестная ошибка игры (код ${model.Event})`;
          console.log(`❌ Проблема с игрой: ${errorMsg}`);

          // Если уровень изменился - инвалидируем кеш
          if (model.Event === 16) {
            this._invalidateLevelCache(gameId, 'уровень изменился');
          }

          throw new Error(errorMsg);
        }

        const level = model.Level;
        console.log(`📊 Состояние уровня: №${level.Number}, ID=${level.LevelId}, IsPassed=${level.IsPassed}`);

        // Подробная проверка состояния уровня согласно документации API
        if (level.IsPassed) {
          console.log(`✅ Уровень ${level.Number} уже пройден`);
          this._invalidateLevelCache(gameId, 'уровень пройден');
          throw new Error(`Уровень ${level.Number} уже пройден`);
        }

        if (level.Dismissed) {
          console.log(`🚫 Уровень ${level.Number} снят администратором`);
          this._invalidateLevelCache(gameId, 'уровень снят');
          throw new Error(`Уровень ${level.Number} снят администратором`);
        }

        // Сохраняем данные уровня в кеш
        this._saveLevelToCache(gameId, level);
        levelData = {
          levelId: level.LevelId,
          levelNumber: level.Number,
          isPassed: level.IsPassed
        };
      }

      // Проверка блокировки ответов (только если получали свежее состояние игры)
      if (model && model.Level && model.Level.HasAnswerBlockRule) {
        if (model.Level.BlockDuration > 0) {
          const minutes = Math.floor(model.Level.BlockDuration / 60);
          const seconds = model.Level.BlockDuration % 60;
          const timeStr = minutes > 0 ? `${minutes}м ${seconds}с` : `${seconds}с`;

          console.log(`⏰ Блокировка ответов на уровне ${levelData.levelNumber}: осталось ${timeStr}`);
          throw new Error(`⏰ Блокировка ответов на уровне ${levelData.levelNumber}. Осталось: ${timeStr}`);
        } else {
          console.log(`ℹ️ На уровне ${levelData.levelNumber} настроена блокировка ответов, но сейчас не активна`);
        }
      }

      console.log(`✅ Уровень ${levelData.levelNumber} готов к приему ответов`);

      // Формируем cookie строку
      const cookieString = Object.entries(authCookies)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');

      // Отправляем ответ согласно документации API
      console.log(`📤 Отправляем ответ "${answer}" на уровень ${levelData.levelNumber} (LevelId: ${levelData.levelId})`);

      // Rate limiting: ждём минимум 1.2 сек с последнего запроса к этому домену
      await this._waitRateLimit();

      const postData = new URLSearchParams({
        LevelId: levelData.levelId.toString(),
        LevelNumber: levelData.levelNumber.toString(),
        'LevelAction.Answer': answer
      });

      console.log(`🌐 POST URL: ${this.domain}/GameEngines/Encounter/Play/${gameId}?json=1`);
      console.log(`📦 POST данные: ${postData.toString()}`);

      const response = await axios.post(`${this.domain}/GameEngines/Encounter/Play/${gameId}?json=1`, 
        postData, {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json, text/html, */*',
          'Cookie': cookieString,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      console.log(`📥 Получен ответ от сервера: Event=${response.data.Event}`);

      const result = response.data;
      
      // Проверяем если сервер вернул HTML вместо JSON (страница логина)
      if (typeof result === 'string' && (result.includes('<html>') || result.includes('<!DOCTYPE'))) {
        console.log(`🔒 Сервер перенаправил на страницу входа - сессия истекла`);
        throw new Error('Требуется повторная авторизация (сессия истекла)');
      }
      
      // Проверяем результат
      if (result.Event === undefined || result.Event === null) {
        console.log(`⚠️ Ответ отправлен, но Event не определен - возможно ответ обработан`);
        // Продолжаем анализ LevelAction вместо ошибки
      } else if (result.Event !== 0) {
        // Если уровень изменился - это нормально
        if ([16, 18, 19, 20, 21, 22].includes(result.Event)) {
          console.log('Уровень изменился, получаем новое состояние...');
        } else {
          throw new Error(`Ошибка отправки ответа (код ${result.Event})`);
        }
      }

      // Проверяем результат ответа
      const engineAction = result.EngineAction;
      const levelAction = engineAction?.LevelAction;
      
      let isCorrect = false;
      let message = 'Ответ отправлен';
      
      if (levelAction) {
        // Проверяем правильность ответа согласно документации
        console.log(`📊 LevelAction.Answer: "${levelAction.Answer}"`);
        console.log(`📊 LevelAction.IsCorrectAnswer: ${levelAction.IsCorrectAnswer}`);
        
        if (levelAction.IsCorrectAnswer !== null) {
          isCorrect = levelAction.IsCorrectAnswer;
          message = isCorrect ? '✅ Правильный ответ!' : '❌ Неправильный ответ';
          
          console.log(`🎯 Результат ответа "${answer}": ${isCorrect ? 'правильный' : 'неправильный'}`);
        } else {
          console.log(`⚠️ Ответ НЕ БЫЛ ОБРАБОТАН (IsCorrectAnswer = null)`);
          message = '⚠️ Ответ не был обработан - проверьте правильность отправки';
        }
        
        // Проверяем был ли пройден уровень
        if (result.Level && result.Level.IsPassed) {
          message += ' 🎉 Уровень пройден!';
          console.log(`🏆 Уровень ${result.Level.Number} пройден!`);
          // Инвалидируем кеш - уровень изменился
          this._invalidateLevelCache(gameId, 'уровень пройден');
        }

        // Если Event изменился (уровень изменился) - инвалидируем кеш
        if (result.Event && [16, 18, 19, 20, 21, 22].includes(result.Event)) {
          this._invalidateLevelCache(gameId, `Event ${result.Event} - уровень изменился`);
        }
      } else {
        console.log(`❌ Нет данных LevelAction в ответе сервера`);
        message = '❌ Ответ не обработан - нет данных о результате';
      }

      return {
        success: true,
        correct: isCorrect,
        message: message,
        levelNumber: levelData.levelNumber,
        data: result,
        level: result.Level
      };

    } catch (error) {
      console.error('Ошибка отправки ответа в Encounter:', error.message);
      throw error;
    }
  }

  // Получение информации об игре
  async getGameInfo(gameId, authCookies) {
    try {
      const gameState = await this.getGameState(gameId, authCookies);
      
      if (gameState.success) {
        const model = gameState.data;
        return {
          success: true,
          data: {
            id: model.GameId || gameId,
            name: model.GameTitle || `Игра #${gameId}`,
            number: model.GameNumber,
            status: model.Event === 0 ? 'active' : 'inactive',
            level: model.Level ? {
              id: model.Level.LevelId,
              name: model.Level.Name,
              number: model.Level.Number,
              isPassed: model.Level.IsPassed,
              sectorsTotal: model.Level.RequiredSectorsCount,
              sectorsPassed: model.Level.PassedSectorsCount
            } : null,
            team: model.TeamName,
            login: model.Login
          }
        };
      } else {
        throw new Error('Не удалось получить состояние игры');
      }
    } catch (error) {
      console.error('Ошибка получения информации об игре:', error.message);
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Проверка соединения
  async checkConnection() {
    try {
      // Rate limiting: ждём минимум 1.2 сек с последнего запроса к этому домену
      await this._waitRateLimit();

      // Попробуем получить главную страницу
      const response = await axios.get(this.domain, {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      return response.status === 200;
    } catch (error) {
      console.log('Проверка соединения не удалась:', error.message);
      return false;
    }
  }

  // Получение списка игр домена
  async getGamesList() {
    try {
      // Rate limiting: ждём минимум 1.2 сек с последнего запроса к этому домену
      await this._waitRateLimit();

      const response = await axios.get(`${this.domain}/home/?json=1`, {
        timeout: this.timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      return {
        success: true,
        comingGames: response.data.ComingGames || [],
        activeGames: response.data.ActiveGames || []
      };
    } catch (error) {
      console.error('Ошибка получения списка игр:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = EncounterAPI;