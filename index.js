const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const EncounterAPI = require('./encounter-api');

// Загрузка переменных окружения
require('dotenv').config();

// Токен Telegram бота из переменной окружения
const BOT_TOKEN = process.env.BOT_TOKEN || '8239956764:AAH78W5Vvc47a_EhnL7XcLtRwVhmj8s5Q4Y';

// Тестовый бот
// const BOT_TOKEN = process.env.BOT_TOKEN || '7729425234:AAFp-r5wN8fOANx5DVU1xJ94L5sW0rAjxeU';

// Создаем экземпляр бота
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Состояния пользователей
const userStates = new Map();
const userData = new Map();

// Файл для хранения данных пользователей
const DATA_FILE = process.env.DATA_FILE || 'user_data.json';

// Состояния бота
const STATES = {
  WAITING_FOR_LOGIN: 'waiting_for_login',
  WAITING_FOR_PASSWORD: 'waiting_for_password',
  WAITING_FOR_GAME_URL: 'waiting_for_game_url',
  READY: 'ready',
  WAITING_FOR_ANSWER: 'waiting_for_answer'
};

// Загрузка данных пользователей при запуске
async function loadUserData() {
  try {
    if (await fs.pathExists(DATA_FILE)) {
      const data = await fs.readJson(DATA_FILE);
      for (const [userId, userInfo] of Object.entries(data)) {
        userData.set(userId, userInfo);
      }
      console.log('Данные пользователей загружены');
    }
  } catch (error) {
    console.error('Ошибка загрузки данных пользователей:', error);
  }
}

// Сохранение данных пользователей
async function saveUserData() {
  try {
    const data = Object.fromEntries(userData);
    await fs.writeJson(DATA_FILE, data, { spaces: 2 });
  } catch (error) {
    console.error('Ошибка сохранения данных пользователей:', error);
  }
}

// Создание клавиатуры для главного меню
function createMainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ['Задание'],
        ['Сектора'],
        ['📊 Статус очереди', '🔗 Сменить игру'],
        ['👤 Сменить авторизацию']
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}

// Удалён форматтер HTML, показ оригинального текста задания TaskText
function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Форматирование секунд в д/ч/м/с без нулевых единиц
function formatRemain(seconds) {
  const total = Number(seconds) || 0;
  if (total <= 0) return '';
  let s = Math.floor(total);
  const days = Math.floor(s / 86400); s %= 86400;
  const hours = Math.floor(s / 3600); s %= 3600;
  const minutes = Math.floor(s / 60); s %= 60;
  const parts = [];
  if (days > 0) parts.push(`${days}д`);
  if (hours > 0) parts.push(`${hours}ч`);
  if (minutes > 0) parts.push(`${minutes}м`);
  if (s > 0) parts.push(`${s}с`);
  return parts.join(' ');
}

// Попытка извлечь человекочитаемый текст ответа сектора из разных возможных структур
function extractSectorAnswerText(rawAnswer) {
  if (rawAnswer == null) return '';
  if (typeof rawAnswer === 'string') return rawAnswer.trim();
  if (typeof rawAnswer === 'number' || typeof rawAnswer === 'boolean') return String(rawAnswer);
  if (Array.isArray(rawAnswer)) {
    const parts = rawAnswer
      .map(item => extractSectorAnswerText(item))
      .filter(v => v && v.trim().length > 0);
    return parts.join(', ');
  }
  // Объект: пробуем типичные поля
  const candidates = [
    rawAnswer.Value,
    rawAnswer.Text,
    rawAnswer.Answer,
    rawAnswer.Display,
    rawAnswer.StringValue,
    rawAnswer.Name,
    rawAnswer.Title,
    rawAnswer.Content
  ].filter(v => v != null);
  if (candidates.length > 0) {
    const first = candidates.find(v => typeof v === 'string') ?? candidates[0];
    return extractSectorAnswerText(first);
  }
  // Последняя попытка: сериализуем простые плоские значения
  try {
    const flat = Object.values(rawAnswer)
      .map(v => (typeof v === 'string' || typeof v === 'number' ? String(v) : ''))
      .filter(Boolean)
      .join(' ')
      .trim();
    return flat;
  } catch (_) {
    return '';
  }
}

// Получение информации о пользователе
function getUserInfo(userId) {
  if (!userData.has(userId)) {
    userData.set(userId, {
      login: null,
      password: null,
      domain: null,
      gameId: null,
      authCookies: null,
      answerQueue: [],
      isOnline: true
    });
  }
  return userData.get(userId);
}

// Проверка готовности пользователя
function isUserReady(userId) {
  const user = getUserInfo(userId);
  return user.login && user.password && user.domain && user.gameId;
}

// Функция для отправки или обновления сообщения
async function sendOrUpdateMessage(userId, text, messageId = null) {
  try {
    if (messageId) {
      // Пытаемся обновить существующее сообщение
      await bot.editMessageText(text, {
        chat_id: userId,
        message_id: messageId
      });
      return messageId;
    } else {
      // Отправляем новое сообщение
      const sentMessage = await bot.sendMessage(userId, text);
      return sentMessage.message_id;
    }
  } catch (error) {
    // Игнорируем ошибки "message is not modified" - это нормально
    if (error.code === 'ETELEGRAM' && error.response?.body?.description?.includes('message is not modified')) {
      console.log(`⏭️ Сообщение не изменилось, пропускаем обновление`);
      return messageId; // Возвращаем тот же messageId
    }
    
    // Для других 400 ошибок отправляем новое сообщение
    if (messageId && error.response?.status === 400) {
      console.log(`📤 Отправляем новое сообщение вместо обновления`);
      const sentMessage = await bot.sendMessage(userId, text);
      return sentMessage.message_id;
    }
    
    throw error;
  }
}

// Отправка ответа в игру Encounter
async function sendAnswerToEncounter(userId, answer, progressMessageId = null) {
  const user = getUserInfo(userId);
  
  try {
    const response = await sendToEncounterAPI(user, answer);
    
    if (response.success) {
      // Показываем детальный результат согласно документации
      let message = `📤 Ответ "${answer}" отправлен на уровень №${response.levelNumber}\n${response.message}`;
      
      // Дополнительная информация об уровне (если есть)
      if (response.level && response.level.Name) {
        message += `\n📝 Уровень: ${response.level.Name}`;
        if (response.level.PassedSectorsCount !== undefined && response.level.RequiredSectorsCount !== undefined) {
          message += `\n📊 Сектора: ${response.level.PassedSectorsCount}/${response.level.RequiredSectorsCount}`;
        }
      }
      
      // Обновляем сообщение или отправляем новое
      await sendOrUpdateMessage(userId, message, progressMessageId);
      return response;
    } else {
      throw new Error(response.error || 'Ошибка отправки ответа');
    }
  } catch (error) {
    console.error('Ошибка отправки ответа:', error);
    
    // Проверяем типы ошибок для решения о добавлении в очередь
    const networkErrors = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'network', 'timeout'];
    const isNetworkError = networkErrors.some(errType => 
      error.code === errType || error.message.toLowerCase().includes(errType.toLowerCase())
    );
    
    const authErrors = ['Требуется повторная авторизация', 'сессия истекла'];
    const isAuthError = authErrors.some(errType => 
      error.message.toLowerCase().includes(errType.toLowerCase())
    );
    
    if (isNetworkError) {
      user.answerQueue.push({
        answer: answer,
        timestamp: Date.now()
      });
      user.isOnline = false;
      await saveUserData();
      
      bot.sendMessage(userId, `🔄 Нет соединения. Ответ "${answer}" добавлен в очередь.`);
      return null;
    } else if (isAuthError) {
      console.log(`🔒 Переавторизация для ответа "${answer}"`);
      
      // Обновляем сообщение о переавторизации если есть прогресс-сообщение
      if (progressMessageId) {
        await sendOrUpdateMessage(userId, `🔒 Переавторизация для "${answer}"...`, progressMessageId);
      }
      
      try {
        // Сбрасываем куки и повторяем
        user.authCookies = null;
        await saveUserData();
        
        // Задержка и повторная попытка
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        console.log(`🔄 Повторная попытка отправки "${answer}" после переавторизации`);
        
        // Обновляем статус повторной попытки
        if (progressMessageId) {
          await sendOrUpdateMessage(userId, `🔄 Повторяю отправку "${answer}"...`, progressMessageId);
        }
        
        return await sendAnswerToEncounter(userId, answer, progressMessageId);
      } catch (retryError) {
        console.error('Ошибка повторной попытки:', retryError);
        
        // Проверяем не является ли ошибка снова ошибкой "message is not modified"
        const isMessageNotModifiedError = retryError.code === 'ETELEGRAM' && 
          retryError.response?.body?.description?.includes('message is not modified');
        
        if (!isMessageNotModifiedError) {
          await sendOrUpdateMessage(userId, `❌ Не удалось переавторизоваться: ${retryError.message}`, progressMessageId);
        }
        return null;
      }
    } else {
      await sendOrUpdateMessage(userId, `❌ Ошибка: ${error.message}`, progressMessageId);
      return null;
    }
  }
}

// Отправка ответов из очереди
async function processAnswerQueue(userId) {
  const user = getUserInfo(userId);
  
  if (user.answerQueue.length === 0) {
    return;
  }
  
  const totalAnswers = user.answerQueue.length;
  let processed = 0;
  let successful = 0;
  let skipped = 0;
  
  // Отправляем начальное сообщение
  const queueMessage = await bot.sendMessage(userId, `🔄 Подготовка к обработке очереди из ${totalAnswers} ответов...`);
  
  // Задержка перед началом обработки для стабилизации соединения
  console.log('⏱️ Задержка 3 секунды перед началом обработки очереди...');
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Обновляем сообщение
  await sendOrUpdateMessage(userId, `🔄 Обрабатываю очередь из ${totalAnswers} ответов...`, queueMessage.message_id);
  
  for (let i = 0; i < user.answerQueue.length; i++) {
    const queueItem = user.answerQueue[i];
    processed++;
    
    // Обновляем прогресс
    await sendOrUpdateMessage(userId, 
      `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n⏳ Отправляю "${queueItem.answer}"...`, 
      queueMessage.message_id
    );
    
    try {
      const response = await sendToEncounterAPI(user, queueItem.answer);
      
      if (response.success) {
        successful++;
        user.answerQueue.splice(i, 1);
        i--; // Корректируем индекс после удаления
        
        // Показываем успешную отправку кратко
        await sendOrUpdateMessage(userId, 
          `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n✅ Ответ отправлен`, 
          queueMessage.message_id
        );
      } else {
        throw new Error('Ошибка отправки');
      }
    } catch (error) {
      console.error('Ошибка обработки очереди:', error);
      
      // Проверяем тип ошибки
      const ignorableErrors = [
        'Event не определен',
        'Неизвестная ошибка игры',
        'Уровень изменился',
        'некорректные данные'
      ];
      
      const authErrors = [
        'Требуется повторная авторизация',
        'сессия истекла'
      ];
      
      const isIgnorableError = ignorableErrors.some(errType => 
        error.message.toLowerCase().includes(errType.toLowerCase())
      );
      
      const isAuthError = authErrors.some(errType => 
        error.message.toLowerCase().includes(errType.toLowerCase())
      );
      
      if (isIgnorableError) {
        console.log(`⚠️ Пропускаем ответ "${queueItem.answer}" из-за устаревших данных`);
        skipped++;
        
        // Кратко обновляем статус
        await sendOrUpdateMessage(userId, 
          `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n⚠️ Пропущен устаревший ответ`, 
          queueMessage.message_id
        );
        
        // Удаляем проблемный ответ и продолжаем
        user.answerQueue.splice(i, 1);
        i--; // Корректируем индекс после удаления
        
      } else if (isAuthError) {
        console.log(`🔒 Проблема авторизации в очереди: ${error.message}`);
        
        // Показываем переавторизацию с конкретным ответом
        await sendOrUpdateMessage(userId, 
          `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n🔒 Переавторизация для "${queueItem.answer}"...`, 
          queueMessage.message_id
        );
        
        try {
          // Сбрасываем куки и повторяем
          user.authCookies = null;
          await saveUserData();
          
          // Задержка перед повторной попыткой
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Показываем повторную попытку
          await sendOrUpdateMessage(userId, 
            `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n🔄 Повторяю "${queueItem.answer}"...`, 
            queueMessage.message_id
          );
          
          // Возвращаемся к тому же ответу (не удаляем из очереди)
          i--; // Возвращаемся к тому же элементу
          processed--; // Корректируем счетчик
          
          console.log(`🔄 Повторяем отправку ответа "${queueItem.answer}" после переавторизации`);
        } catch (authError) {
          console.error('Ошибка переавторизации в очереди:', authError);
          
          // Проверяем не является ли ошибка "message is not modified"
          const isMessageNotModifiedError = authError.code === 'ETELEGRAM' && 
            authError.response?.body?.description?.includes('message is not modified');
          
          if (!isMessageNotModifiedError) {
            console.log(`⚠️ Пропускаем ответ "${queueItem.answer}" из-за ошибки переавторизации`);
          }
          
          skipped++;
          user.answerQueue.splice(i, 1);
          i--; // Корректируем индекс после удаления
        }
        
      } else {
        // Серьезная ошибка - останавливаем обработку
        await sendOrUpdateMessage(userId, 
          `❌ Ошибка обработки очереди: ${error.message}\n📊 Обработано: ${successful}/${totalAnswers}`, 
          queueMessage.message_id
        );
        break;
      }
    }
    
    // Универсальная задержка между ответами (независимо от результата)
    if (i < user.answerQueue.length - 1 || processed < totalAnswers) {
      console.log(`⏱️ Задержка 1.2 секунды перед следующим ответом...`);
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  }
  
  if (user.answerQueue.length === 0) {
    user.isOnline = true;
    
    // Финальное сообщение с итогами
    let finalMessage = `✅ Обработка очереди завершена!\n📊 Результат: ${successful} отправлено`;
    if (skipped > 0) {
      finalMessage += `, ${skipped} пропущено`;
    }
    finalMessage += ` из ${totalAnswers}`;
    
    await sendOrUpdateMessage(userId, finalMessage, queueMessage.message_id);
  }
  
  await saveUserData();
}

// Функция для отправки запроса к API Encounter
async function sendToEncounterAPI(user, answer) {
  try {
    const api = new EncounterAPI(user.domain);
    
    // Всегда проверяем действительность авторизации перед отправкой ответа
    console.log(`🔐 Проверяем авторизацию для ${user.login}...`);
    console.log(`🎮 Данные игры: домен=${user.domain}, ID=${user.gameId}`);
    
    const authResult = await api.authenticate(user.login, user.password);
    if (authResult.success) {
      user.authCookies = authResult.cookies;
      await saveUserData();
      console.log(`✅ Авторизация подтверждена для ${user.login}`);
    } else {
      throw new Error(`Ошибка авторизации: ${authResult.message}`);
    }
    
    // Отправляем ответ
    try {
      const result = await api.sendAnswer(user.gameId, answer, user.authCookies);
      
      if (result.success) {
        console.log(`✅ Ответ "${answer}" отправлен в игру ${user.gameId}. ${result.message}`);
        return result;
      } else {
        throw new Error('Не удалось отправить ответ');
      }
    } catch (error) {
      // Если ошибка авторизации (401), сбрасываем cookies и пробуем еще раз
      if (error.message.includes('Требуется авторизация') || error.message.includes('cookies устарели')) {
        console.log(`🔄 Cookies устарели, выполняем повторную авторизацию для ${user.login}...`);
        user.authCookies = null;
        
        const authResult = await api.authenticate(user.login, user.password);
        if (authResult.success) {
          user.authCookies = authResult.cookies;
          await saveUserData();
          console.log(`✅ Повторная авторизация после сбоя успешна для ${user.login}`);
          
          // Повторная попытка отправки ответа
          const result = await api.sendAnswer(user.gameId, answer, user.authCookies);
          if (result.success) {
            console.log(`✅ Ответ "${answer}" отправлен в игру ${user.gameId} после повторной авторизации. ${result.message}`);
            return result;
          }
        }
      }
      throw error;
    }
  } catch (error) {
    console.error('Ошибка API Encounter:', error.message);
    throw error;
  }
}

// Функция для парсинга ссылки на игру
function parseGameUrl(url) {
  try {
    // Проверяем правильность ссылки и извлекаем домен и ID игры
    const urlObj = new URL(url);
    const domain = `${urlObj.protocol}//${urlObj.hostname}`;
    
    // Тип 1: https://tech.en.cx/GameDetails.aspx?gid=80646
    if (urlObj.pathname.includes('/GameDetails.aspx') && urlObj.searchParams.has('gid')) {
      const gameId = urlObj.searchParams.get('gid');
      return {
        success: true,
        domain: domain,
        gameId: gameId,
        type: 'GameDetails'
      };
    }
    
    // Тип 2: https://tech.en.cx/gameengines/encounter/play/80646/
    const playMatch = urlObj.pathname.match(/\/gameengines\/encounter\/play\/(\d+)\/?$/);
    if (playMatch) {
      return {
        success: true,
        domain: domain,
        gameId: playMatch[1],
        type: 'Play'
      };
    }
    
    return {
      success: false,
      message: 'Неправильная ссылка на игру. Поддерживаются только:\n• https://domain.en.cx/GameDetails.aspx?gid=XXXXX\n• https://domain.en.cx/gameengines/encounter/play/XXXXX/'
    };
    
  } catch (error) {
    return {
      success: false,
      message: 'Неправильный формат ссылки. Пример: https://tech.en.cx/GameDetails.aspx?gid=80646'
    };
  }
}

// Проверка авторизации
async function checkAuthentication(login, password, domain = 'https://world.en.cx') {
  try {
    const api = new EncounterAPI(domain);
    const result = await api.authenticate(login, password);
    return result; // Возвращаем полный результат, а не только success
  } catch (error) {
    console.error('Ошибка проверки авторизации:', error.message);
    // Если нет домена, принимаем базовую проверку
    return {
      success: login.length > 0 && password.length > 0,
      message: login.length > 0 && password.length > 0 ? 'Базовая проверка пройдена' : 'Логин или пароль не могут быть пустыми'
    };
  }
}

// Обработчик команды /reset - сброс всех данных пользователя
bot.onText(/\/reset/, async (msg) => {
  const chatId = msg.chat.id;
  
  // Удаляем данные пользователя
  userData.delete(chatId);
  userStates.delete(chatId);
  await saveUserData();
  
  bot.sendMessage(chatId, 
    `🔄 Данные сброшены!\n\n` +
    `Все настройки удалены. Используйте /start для повторной настройки.`
  );
});

// Обработчик команды /test
bot.onText(/\/test/, async (msg) => {
  const chatId = msg.chat.id;
  const user = getUserInfo(chatId);
  
  if (!isUserReady(chatId)) {
    bot.sendMessage(chatId, '❌ Сначала настройте бота командой /start');
    return;
  }
  
  bot.sendMessage(chatId, '🔄 Тестирую подключение...');
  
  try {
    const api = new EncounterAPI(user.domain);
    
    // Проверка подключения
    const isConnected = await api.checkConnection();
    
    if (isConnected) {
      // Проверка авторизации (используем сохраненную, если есть)
      let authResult = { success: false };
      
      if (user.authCookies && Object.keys(user.authCookies).length > 0) {
        console.log('📋 Используем сохраненную авторизацию для /test');
        authResult = { success: true, cookies: user.authCookies };
      } else {
        console.log('🔐 Выполняем новую авторизацию для /test');
        authResult = await api.authenticate(user.login, user.password);
        if (authResult.success) {
          user.authCookies = authResult.cookies;
          await saveUserData();
        }
      }
      
      if (authResult.success) {
        
        // Получение информации об игре
        const gameInfo = await api.getGameInfo(user.gameId, user.authCookies);
        
        if (gameInfo.success) {
          const data = gameInfo.data;
          bot.sendMessage(chatId, 
            `✅ Тест успешен!\n\n` +
            `🌐 Подключение: ОК\n` +
            `🔐 Авторизация: ОК\n` +
            `🎮 Игра: ${data.name} (№${data.number})\n` +
            `👤 Игрок: ${data.login}\n` +
            `👥 Команда: ${data.team || 'Личная игра'}\n` +
            `📊 Статус: ${data.status === 'active' ? 'Активна' : 'Неактивна'}\n` +
            (data.level ? 
              `🏆 Уровень: ${data.level.name} (№${data.level.number})\n` +
              `📈 Сектора: ${data.level.sectorsPassed}/${data.level.sectorsTotal}\n` : '') +
            `\nГотов к отправке ответов!`
          );
        } else {
          bot.sendMessage(chatId, 
            `✅ Подключение и авторизация успешны!\n` +
            `⚠️ Не удалось получить информацию об игре: ${gameInfo.error}\n\n` +
            `Попробуйте отправить тестовый ответ.`
          );
        }
      } else {
        bot.sendMessage(chatId, `⚠️ Подключение есть, но ошибка авторизации: ${authResult.message}`);
      }
    } else {
      bot.sendMessage(chatId, `❌ Не удается подключиться к домену ${user.domain}`);
    }
  } catch (error) {
    bot.sendMessage(chatId, `❌ Ошибка тестирования: ${error.message}`);
  }
});

// Обработчик команды /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const user = getUserInfo(chatId);
  
  if (isUserReady(chatId)) {
    userStates.set(chatId, STATES.READY);
    bot.sendMessage(chatId, 
      `Добро пожаловать в en_off_bot! 🎮\n\n` +
      `Вы уже настроили бота:\n` +
      `👤 Логин: ${user.login}\n` +
      `🌐 Домен: ${user.domain}\n` +
      `🎯 ID игры: ${user.gameId}\n\n` +
      `Теперь вы можете отправлять ответы!`,
      createMainKeyboard()
    );
  } else {
    userStates.set(chatId, STATES.WAITING_FOR_LOGIN);
    bot.sendMessage(chatId, 
      `Добро пожаловать в en_off_bot! 🎮\n\n` +
      `Этот бот поможет вам отправлять ответы в игру Encounter, ` +
      `даже если у вас временно нет интернета.\n\n` +
      `Для начала мне нужно настроить авторизацию.\n` +
      `Введите ваш логин:`
    );
  }
});

// Обработчик текстовых сообщений
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const currentState = userStates.get(chatId) || STATES.WAITING_FOR_LOGIN;
  
  // Пропускаем команды
  if (text && text.startsWith('/')) {
    return;
  }
  
  const user = getUserInfo(chatId);
  
  switch (currentState) {
    case STATES.WAITING_FOR_LOGIN:
      user.login = text;
      userStates.set(chatId, STATES.WAITING_FOR_PASSWORD);
      bot.sendMessage(chatId, `Логин сохранен: ${text}\nТеперь введите пароль:`);
      break;
      
    case STATES.WAITING_FOR_PASSWORD:
      user.password = text;
      
      // Проверяем базовые требования
      if (!user.login || !user.password || user.login.length < 2 || user.password.length < 2) {
        userStates.set(chatId, STATES.WAITING_FOR_LOGIN);
        bot.sendMessage(chatId, `❌ Логин и пароль должны содержать минимум 2 символа.\nВведите логин еще раз:`);
        break;
      }
      
      // Проверяем правильность логина и пароля (один раз)
      bot.sendMessage(chatId, `🔄 Проверяю данные авторизации...`);
      
      try {
        const authResult = await checkAuthentication(user.login, user.password);
        
        if (authResult.success) {
          // Сохраняем результат авторизации для дальнейшего использования
          user.authCookies = authResult.cookies;
          await saveUserData();
          
          userStates.set(chatId, STATES.WAITING_FOR_GAME_URL);
          bot.sendMessage(chatId, `✅ Авторизация успешна!\nТеперь пришлите ссылку на игру Encounter.\n\nПоддерживаемые форматы:\n• https://domain.en.cx/GameDetails.aspx?gid=XXXXX\n• https://domain.en.cx/gameengines/encounter/play/XXXXX/`);
        } else {
          userStates.set(chatId, STATES.WAITING_FOR_LOGIN);
          bot.sendMessage(chatId, `❌ ${authResult.message}\nВведите логин еще раз:`);
        }
      } catch (error) {
        userStates.set(chatId, STATES.WAITING_FOR_LOGIN);
        bot.sendMessage(chatId, `❌ Ошибка проверки авторизации: ${error.message}\nВведите логин еще раз:`);
      }
      break;
      
    case STATES.WAITING_FOR_GAME_URL:
      const gameUrlResult = parseGameUrl(text);
      
      if (gameUrlResult.success) {
        // Если домен изменился, сбрасываем старые cookies авторизации
        if (user.domain && user.domain !== gameUrlResult.domain) {
          console.log(`🔄 Домен изменился с ${user.domain} на ${gameUrlResult.domain}, сбрасываем cookies`);
          user.authCookies = null;
        }
        
        user.domain = gameUrlResult.domain;
        user.gameId = gameUrlResult.gameId;
        userStates.set(chatId, STATES.READY);
        await saveUserData();
        
        bot.sendMessage(chatId, 
          `🎉 Настройка завершена!\n\n` +
          `👤 Логин: ${user.login}\n` +
          `🌐 Домен: ${user.domain}\n` +
          `🎮 ID игры: ${user.gameId}\n` +
          `🔗 Тип ссылки: ${gameUrlResult.type}\n\n` +
          `Теперь вы можете отправлять ответы! Просто напишите ответ в чат.`,
          createMainKeyboard()
        );
        
        // Подключение будет проверено при первой отправке ответа
      } else {
        bot.sendMessage(chatId, `❌ ${gameUrlResult.message}\n\nПопробуйте еще раз:`);
      }
      break;
      
    case STATES.READY:
      // Обработка кнопок главного меню
      if (text === 'Задание') {
        // Получаем текст задания текущего уровня
        const waitMsg = await bot.sendMessage(chatId, '🔄 Получаю задание текущего уровня...');
        try {
          const api = new EncounterAPI(user.domain);

          // Обеспечиваем актуальную авторизацию
          if (!user.authCookies || Object.keys(user.authCookies).length === 0) {
            const auth = await api.authenticate(user.login, user.password);
            if (!auth.success) {
              throw new Error(auth.message || 'Не удалось авторизоваться');
            }
            user.authCookies = auth.cookies;
            await saveUserData();
          }

          let gameState;
          try {
            gameState = await api.getGameState(user.gameId, user.authCookies);
          } catch (e) {
            const msg = String(e.message || '').toLowerCase();
            if (msg.includes('требуется авторизация') || msg.includes('сессия истекла')) {
              const reauth = await api.authenticate(user.login, user.password);
              if (!reauth.success) throw new Error(reauth.message || 'Не удалось авторизоваться');
              user.authCookies = reauth.cookies;
              await saveUserData();
              gameState = await api.getGameState(user.gameId, user.authCookies);
            } else {
              throw e;
            }
          }

          if (!gameState || !gameState.success) {
            throw new Error('Не удалось получить состояние игры');
          }

          const model = gameState.data;
          if (model.Event !== 0) {
            // Если уровень изменился — попробуем ещё раз получить актуальное состояние
            if (model.Event === 16) {
              gameState = await api.getGameState(user.gameId, user.authCookies);
              if (!gameState.success || gameState.data.Event !== 0) {
                await sendOrUpdateMessage(chatId, '⚠️ Игра неактивна или недоступна сейчас.', waitMsg.message_id);
                break;
              }
            } else {
              await sendOrUpdateMessage(chatId, '⚠️ Игра неактивна или недоступна сейчас.', waitMsg.message_id);
              break;
            }
          }

          const level = model.Level;
          if (!level) {
            await sendOrUpdateMessage(chatId, '⚠️ Активный уровень не найден.', waitMsg.message_id);
            break;
          }

          const tasks = level.Tasks;
          let parts = [];
          if (Array.isArray(tasks)) {
            parts = tasks
              .map(t => escapeHtml(String(t?.TaskText || '').trim()))
              .filter(p => p.length > 0);
          } else if (tasks && typeof tasks === 'object') {
            const single = escapeHtml(String(tasks.TaskText || '').trim());
            if (single.length > 0) parts = [single];
          }

          const header = `<b>📜 Задание уровня №${level.Number}${level.Name ? ` — ${escapeHtml(level.Name)}` : ''}</b>`;
          const timeoutRemain = formatRemain(level.TimeoutSecondsRemain);
          const timeoutLine = timeoutRemain ? `\n<i>До автоперехода осталось: ${timeoutRemain}</i>` : '';
          // Текст задания как цитата
          const body = parts.length > 0 
            ? parts.map(p => `<blockquote>${p}</blockquote>`).join('\n\n') 
            : '<blockquote>Текст задания недоступен.</blockquote>';

          // Формируем блок подсказок
          let helpsBlock = '';
          const helps = Array.isArray(level.Helps) ? level.Helps : [];
          if (helps.length > 0) {
            // Функция форматирования секунд в д/ч/м/с без нулевых единиц
            const formatRemain = (seconds) => {
              const total = Number(seconds) || 0;
              if (total <= 0) return '';
              let s = Math.floor(total);
              const days = Math.floor(s / 86400); s %= 86400;
              const hours = Math.floor(s / 3600); s %= 3600;
              const minutes = Math.floor(s / 60); s %= 60;
              const parts = [];
              if (days > 0) parts.push(`${days}д`);
              if (hours > 0) parts.push(`${hours}ч`);
              if (minutes > 0) parts.push(`${minutes}м`);
              if (s > 0) parts.push(`${s}с`);
              return parts.join(' ');
            };

            const helpSections = helps.map(h => {
              const number = h?.Number ?? '';
              const helpText = escapeHtml(h?.HelpText || '');
              const remainStr = formatRemain(h?.RemainSeconds);
              const remainLine = remainStr ? `\n<i>До подсказки осталось: ${remainStr}</i>` : '';
              return `<b>💡 Подсказка ${number}</b>\n<blockquote>${helpText}</blockquote>${remainLine}`;
            });
            helpsBlock = `\n\n${helpSections.join('\n\n')}`;
          }

          const fullHtml = `${header}${timeoutLine}\n\n${body}${helpsBlock}`;

          // Отправляем с форматированием HTML
          if (fullHtml.length <= 4000) {
            await bot.editMessageText(fullHtml, {
              chat_id: chatId,
              message_id: waitMsg.message_id,
              parse_mode: 'HTML',
              disable_web_page_preview: true
            });
          } else {
            await bot.editMessageText(header, {
              chat_id: chatId,
              message_id: waitMsg.message_id,
              parse_mode: 'HTML',
              disable_web_page_preview: true
            });
            // Отправляем оставшуюся часть кусками
            const rest = `\n\n${body}${helpsBlock}`;
            for (let i = 0; i < rest.length; i += 4000) {
              await bot.sendMessage(chatId, rest.slice(i, i + 4000), { parse_mode: 'HTML', disable_web_page_preview: true });
            }
          }
        } catch (error) {
          await sendOrUpdateMessage(chatId, `❌ Не удалось получить задание: ${error.message}`, waitMsg.message_id);
        }
      } else if (text === 'Сектора') {
        const waitMsg = await bot.sendMessage(chatId, '🔄 Получаю список секторов...');
        try {
          const api = new EncounterAPI(user.domain);

          if (!user.authCookies || Object.keys(user.authCookies).length === 0) {
            const auth = await api.authenticate(user.login, user.password);
            if (!auth.success) throw new Error(auth.message || 'Не удалось авторизоваться');
            user.authCookies = auth.cookies;
            await saveUserData();
          }

          let gameState;
          try {
            gameState = await api.getGameState(user.gameId, user.authCookies);
          } catch (e) {
            const msg = String(e.message || '').toLowerCase();
            if (msg.includes('требуется авторизация') || msg.includes('сессия истекла')) {
              const reauth = await api.authenticate(user.login, user.password);
              if (!reauth.success) throw new Error(reauth.message || 'Не удалось авторизоваться');
              user.authCookies = reauth.cookies;
              await saveUserData();
              gameState = await api.getGameState(user.gameId, user.authCookies);
            } else {
              throw e;
            }
          }

          if (!gameState || !gameState.success) throw new Error('Не удалось получить состояние игры');
          let model = gameState.data;
          if (model.Event !== 0) {
            if (model.Event === 16) {
              gameState = await api.getGameState(user.gameId, user.authCookies);
              if (!gameState.success || gameState.data.Event !== 0) {
                await sendOrUpdateMessage(chatId, '⚠️ Игра неактивна или недоступна сейчас.', waitMsg.message_id);
                return;
              }
              model = gameState.data;
            } else {
              await sendOrUpdateMessage(chatId, '⚠️ Игра неактивна или недоступна сейчас.', waitMsg.message_id);
              return;
            }
          }

          const level = model.Level;
          if (!level) {
            await sendOrUpdateMessage(chatId, '⚠️ Активный уровень не найден.', waitMsg.message_id);
            return;
          }

          const sectors = Array.isArray(level.Sectors) ? level.Sectors : [];
          const totalRequired = Number(level.RequiredSectorsCount) || 0;
          const passedCount = Number(level.PassedSectorsCount) || 0;
          const leftToClose = Math.max(totalRequired - passedCount, 0);
          if (sectors.length === 0) {
            await bot.editMessageText('<b>🗄 Секторы</b>\n\nНет данных о секторах.', {
              chat_id: chatId,
              message_id: waitMsg.message_id,
              parse_mode: 'HTML'
            });
            return;
          }

          const lines = sectors.map(s => {
            const order = s?.Order ?? '';
            const name = escapeHtml(s?.Name ?? '');
            const isAnswered = s?.IsAnswered === true;
            const answerTextRaw = s?.Answer;
            const answerText = extractSectorAnswerText(answerTextRaw);
            const condition = isAnswered
              ? (answerText ? `<code>${escapeHtml(answerText)}</code> ✅` : `<code>—</code> ✅`)
              : `<i>...</i>`;
            return `#${order} (${name}) — ${condition}`;
          });

          const totalCount = sectors.length;
          const header = `<b>🗄 Секторы (обязательных ${totalRequired} из ${totalCount})</b>`;
          const summary = `Закрыто — <b>${passedCount}</b>, осталось — <b>${leftToClose}</b>`;
          const body = lines.join('\n');
          const full = `${header}\n\n${summary}\n\n${body}`;

          if (full.length <= 4000) {
            await bot.editMessageText(full, {
              chat_id: chatId,
              message_id: waitMsg.message_id,
              parse_mode: 'HTML',
              disable_web_page_preview: true
            });
          } else {
            await bot.editMessageText(header, {
              chat_id: chatId,
              message_id: waitMsg.message_id,
              parse_mode: 'HTML',
              disable_web_page_preview: true
            });
            for (let i = 0; i < body.length; i += 4000) {
              await bot.sendMessage(chatId, body.slice(i, i + 4000), { parse_mode: 'HTML', disable_web_page_preview: true });
            }
          }
        } catch (error) {
          await sendOrUpdateMessage(chatId, `❌ Не удалось получить сектора: ${error.message}`, waitMsg.message_id);
        }
      } else if (text === '📊 Статус очереди') {
        const queueLength = user.answerQueue.length;
        const status = user.isOnline ? '🟢 Онлайн' : '🔴 Оффлайн';
        bot.sendMessage(chatId, 
          `Статус: ${status}\n` +
          `Ответов в очереди: ${queueLength}\n\n` +
          `${queueLength > 0 ? 'Очередь:\n' + user.answerQueue.map((item, index) => 
            `${index + 1}. "${item.answer}" (${new Date(item.timestamp).toLocaleTimeString()})`
          ).join('\n') : 'Очередь пуста'}`
        );
      } else if (text === '🔗 Сменить игру') {
        // Сбрасываем cookies при смене игры
        user.authCookies = null;
        await saveUserData();
        
        userStates.set(chatId, STATES.WAITING_FOR_GAME_URL);
        bot.sendMessage(chatId, 'Пришлите новую ссылку на игру:\n\n• https://domain.en.cx/GameDetails.aspx?gid=XXXXX\n• https://domain.en.cx/gameengines/encounter/play/XXXXX/');
      } else if (text === '👤 Сменить авторизацию') {
        // Сбрасываем cookies при смене авторизации
        user.authCookies = null;
        await saveUserData();
        
        userStates.set(chatId, STATES.WAITING_FOR_LOGIN);
        bot.sendMessage(chatId, 'Введите новый логин:');
      } else {
        // Это ответ для игры
        const progressMessage = await bot.sendMessage(chatId, `⏳ Отправляю ответ "${text}"...`);
        const result = await sendAnswerToEncounter(chatId, text, progressMessage.message_id);
        
        if (result && user.answerQueue.length > 0) {
          // Если есть очередь ответов, обрабатываем её
          setTimeout(() => processAnswerQueue(chatId), 1200);
        }
      }
      break;
  }
});

// Обработка ошибок
bot.on('error', (error) => {
  console.error('Ошибка бота:', error);
});

bot.on('polling_error', (error) => {
  console.error('Ошибка polling:', error);
});

// Запуск бота
async function startBot() {
  await loadUserData();
  console.log('🤖 Telegram-бот en_off_bot запущен!');
  console.log('📱 Готов к приему сообщений...');
}

startBot();

// Грациозное завершение работы
process.on('SIGINT', async () => {
  console.log('\n🛑 Остановка бота...');
  await saveUserData();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Остановка бота...');
  await saveUserData();
  process.exit(0);
});