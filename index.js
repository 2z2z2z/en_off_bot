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

// Админ-конфигурация
let adminConfig = {
  moderationEnabled: false,
  whitelist: []
};

// Кеш whitelist для быстрой проверки
let whitelistCache = new Set();

// Файл для хранения данных пользователей
const DATA_FILE = process.env.DATA_FILE || 'user_data.json';

// Файл для хранения настроек админа
const ADMIN_CONFIG_FILE = 'admin_config.json';

// ID root пользователя (админа)
const ROOT_USER_ID = 197924096;

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
      const now = Date.now();
      let migrationCount = 0;

      for (const [userId, userInfo] of Object.entries(data)) {
        // Миграция: добавляем новые поля если их нет
        if (!userInfo.telegramUsername) {
          userInfo.telegramUsername = null;
          migrationCount++;
        }
        if (!userInfo.telegramFirstName) {
          userInfo.telegramFirstName = null;
        }
        if (!userInfo.firstActivity) {
          userInfo.firstActivity = now;
          migrationCount++;
        }
        if (!userInfo.lastActivity) {
          userInfo.lastActivity = now;
          migrationCount++;
        }

        userData.set(userId, userInfo);
      }

      console.log(`Данные пользователей загружены (${userData.size} пользователей)`);
      if (migrationCount > 0) {
        console.log(`Выполнена миграция данных для ${migrationCount} полей`);
        await saveUserData(); // Сохраняем мигрированные данные
      }
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

// Загрузка админ-конфигурации
async function loadAdminConfig() {
  try {
    if (await fs.pathExists(ADMIN_CONFIG_FILE)) {
      adminConfig = await fs.readJson(ADMIN_CONFIG_FILE);
      rebuildWhitelistCache();
      console.log('Админ-конфигурация загружена');
    } else {
      // Создаем файл с начальными настройками
      await saveAdminConfig();
      console.log('Создан файл админ-конфигурации');
    }
  } catch (error) {
    console.error('Ошибка загрузки админ-конфигурации:', error);
  }
}

// Сохранение админ-конфигурации
async function saveAdminConfig() {
  try {
    await fs.writeJson(ADMIN_CONFIG_FILE, adminConfig, { spaces: 2 });
    rebuildWhitelistCache();
  } catch (error) {
    console.error('Ошибка сохранения админ-конфигурации:', error);
  }
}

// Пересборка кеша whitelist
function rebuildWhitelistCache() {
  whitelistCache.clear();
  if (adminConfig.whitelist && Array.isArray(adminConfig.whitelist)) {
    adminConfig.whitelist.forEach(entry => {
      const key = `${entry.type}:${entry.value.toLowerCase()}`;
      whitelistCache.add(key);
    });
  }
  console.log(`Whitelist cache обновлен: ${whitelistCache.size} записей`);
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
    const now = Date.now();
    userData.set(userId, {
      login: null,
      password: null,
      domain: null,
      gameId: null,
      authCookies: null,
      answerQueue: [],
      isOnline: true,
      telegramUsername: null,
      telegramFirstName: null,
      firstActivity: now,
      lastActivity: now
    });
  }
  return userData.get(userId);
}

// Проверка готовности пользователя
function isUserReady(userId) {
  const user = getUserInfo(userId);
  return user.login && user.password && user.domain && user.gameId;
}

/**
 * Обновление активности пользователя
 * @param {string} userId - Telegram ID пользователя
 * @param {string} username - Telegram username (@username)
 * @param {string} firstName - Telegram имя пользователя
 */
function updateUserActivity(userId, username, firstName) {
  const user = getUserInfo(userId);
  const now = Date.now();

  // Обновляем username и firstName если они есть
  if (username && user.telegramUsername !== username) {
    user.telegramUsername = username;
  }
  if (firstName && user.telegramFirstName !== firstName) {
    user.telegramFirstName = firstName;
  }

  // Обновляем lastActivity
  user.lastActivity = now;
}

/**
 * Проверка пользователя в whitelist
 * @param {string} userId - Telegram ID пользователя
 * @returns {boolean} - true если пользователь в whitelist или модерация выключена
 */
function isUserAllowed(userId) {
  // Если модерация выключена - разрешаем всем
  if (!adminConfig.moderationEnabled) {
    return true;
  }

  const user = getUserInfo(userId);

  // Проверяем по Telegram username
  if (user.telegramUsername) {
    const telegramKey = `telegram:${user.telegramUsername.toLowerCase().replace('@', '')}`;
    if (whitelistCache.has(telegramKey)) {
      return true;
    }
  }

  // Проверяем по Encounter login
  if (user.login) {
    const encounterKey = `encounter:${user.login.toLowerCase()}`;
    if (whitelistCache.has(encounterKey)) {
      return true;
    }
  }

  return false;
}

/**
 * Проверка доступа к игровым функциям
 * @param {string} userId - Telegram ID пользователя
 * @returns {boolean} - true если доступ разрешен
 */
async function checkGameAccess(userId) {
  if (isUserAllowed(userId)) {
    return true;
  }

  // Доступ запрещен - отправляем сообщение
  await bot.sendMessage(userId, '🚫 Доступ к боту не разрешен. Свяжитесь с @seo2z');
  return false;
}

// Throttling для обновлений Telegram сообщений (защита от rate limiting)
const telegramUpdateThrottle = new Map(); // userId -> { lastUpdate: timestamp, pendingText: string, timeout: NodeJS.Timeout }

// Функция для отправки или обновления сообщения
async function sendOrUpdateMessage(userId, text, messageId = null) {
  try {
    if (messageId) {
      // Проверяем throttle: максимум 1 обновление в 2 секунды на сообщение
      const throttleKey = `${userId}_${messageId}`;
      const now = Date.now();
      const throttle = telegramUpdateThrottle.get(throttleKey);

      if (throttle) {
        const elapsed = now - throttle.lastUpdate;

        if (elapsed < 2000) {
          // Слишком рано для обновления - откладываем
          console.log(`⏳ Throttle: откладываю обновление сообщения (прошло ${elapsed}ms < 2000ms)`);

          // Отменяем предыдущий отложенный апдейт если есть
          if (throttle.timeout) {
            clearTimeout(throttle.timeout);
          }

          // Сохраняем текст для отложенного обновления
          throttle.pendingText = text;

          // Планируем обновление через оставшееся время
          const waitTime = 2000 - elapsed;
          throttle.timeout = setTimeout(async () => {
            try {
              await bot.editMessageText(throttle.pendingText, {
                chat_id: userId,
                message_id: messageId
              });
              throttle.lastUpdate = Date.now();
              throttle.pendingText = null;
              throttle.timeout = null;
              console.log(`✅ Отложенное обновление сообщения выполнено`);
            } catch (err) {
              if (err.code === 'ETELEGRAM' && err.response?.body?.description?.includes('message is not modified')) {
                console.log(`⏭️ Отложенное обновление: сообщение не изменилось`);
              } else if (err.response?.statusCode === 429) {
                console.log(`⚠️ Telegram rate limit при отложенном обновлении, пропускаем`);
              } else {
                console.error(`❌ Ошибка отложенного обновления:`, err.message);
              }
            }
          }, waitTime);

          return messageId;
        }
      }

      // Обновляем сообщение
      await bot.editMessageText(text, {
        chat_id: userId,
        message_id: messageId
      });

      // Обновляем throttle
      telegramUpdateThrottle.set(throttleKey, {
        lastUpdate: Date.now(),
        pendingText: null,
        timeout: null
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

    // Игнорируем Telegram rate limit (429) - уже обработано throttle
    if (error.response?.statusCode === 429) {
      console.log(`⚠️ Telegram rate limit (429), пропускаем обновление сообщения`);
      return messageId;
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
async function sendAnswerToEncounter(userId, answer, progressMessageId = null, retryCount = 0) {
  const user = getUserInfo(userId);
  const MAX_RETRIES = 2; // Максимум 2 повторные попытки (всего 3 попытки)

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

    // Критические ошибки - IP блокировка (не retry!)
    const criticalErrors = ['IP заблокирован', 'слишком много запросов'];
    const isCriticalError = criticalErrors.some(errType =>
      error.message.toLowerCase().includes(errType.toLowerCase())
    );

    if (isCriticalError) {
      console.error(`🚫 Критическая ошибка блокировки: ${error.message}`);
      await sendOrUpdateMessage(userId, `🚫 ${error.message}\n\nБот временно заблокирован. Повторите попытку через 5-10 минут.`, progressMessageId);
      return null;
    }

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
      // Проверяем не превысили ли лимит retry
      if (retryCount >= MAX_RETRIES) {
        console.error(`❌ Достигнут максимум попыток (${MAX_RETRIES}) для ответа "${answer}"`);
        await sendOrUpdateMessage(userId, `❌ Не удалось отправить ответ "${answer}" после ${MAX_RETRIES + 1} попыток. Попробуйте позже.`, progressMessageId);
        return null;
      }

      console.log(`🔒 Переавторизация для ответа "${answer}" (попытка ${retryCount + 1}/${MAX_RETRIES + 1})`);

      // Обновляем сообщение о переавторизации если есть прогресс-сообщение
      if (progressMessageId) {
        await sendOrUpdateMessage(userId, `🔒 Переавторизация для "${answer}" (попытка ${retryCount + 1})...`, progressMessageId);
      }

      try {
        // Сбрасываем куки и повторяем
        user.authCookies = null;
        await saveUserData();

        // Exponential backoff: 1s, 2s, 4s
        const backoffDelay = Math.pow(2, retryCount) * 1000;
        console.log(`⏱️ Exponential backoff: ждём ${backoffDelay}ms перед попыткой ${retryCount + 2}`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));

        console.log(`🔄 Повторная попытка ${retryCount + 2} отправки "${answer}" после переавторизации`);

        // Обновляем статус повторной попытки
        if (progressMessageId) {
          await sendOrUpdateMessage(userId, `🔄 Повторяю отправку "${answer}" (попытка ${retryCount + 2})...`, progressMessageId);
        }

        // Рекурсивный вызов с увеличенным счётчиком retry
        return await sendAnswerToEncounter(userId, answer, progressMessageId, retryCount + 1);
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

    // Авторизуемся ТОЛЬКО если нет cookies или они пустые
    if (!user.authCookies || Object.keys(user.authCookies).length === 0) {
      console.log(`🔐 Нет cookies, выполняем авторизацию для ${user.login}...`);
      console.log(`🎮 Данные игры: домен=${user.domain}, ID=${user.gameId}`);

      const authResult = await api.authenticate(user.login, user.password);
      if (authResult.success) {
        user.authCookies = authResult.cookies;
        await saveUserData();
        console.log(`✅ Авторизация успешна для ${user.login}`);
      } else {
        throw new Error(`Ошибка авторизации: ${authResult.message}`);
      }
    } else {
      console.log(`🔑 Используем сохраненные cookies для ${user.login}`);
    }

    // Отправляем ответ с автоматической реаутентификацией (передаем login/password)
    const result = await api.sendAnswer(user.gameId, answer, user.authCookies, user.login, user.password);

    // Если были обновлены cookies (автореаутентификация сработала) - сохраняем новые
    if (result.newCookies) {
      console.log(`🔄 Cookies обновлены после автоматической реаутентификации`);
      user.authCookies = result.newCookies;
      await saveUserData();
    }

    if (result.success) {
      console.log(`✅ Ответ "${answer}" отправлен в игру ${user.gameId}. ${result.message}`);
      return result;
    } else {
      throw new Error('Не удалось отправить ответ');
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

/**
 * Показать список пользователей с пагинацией
 */
async function showUsersList(chatId, messageId, page = 0) {
  const USERS_PER_PAGE = 10;
  const users = Array.from(userData.entries());
  const totalPages = Math.ceil(users.length / USERS_PER_PAGE);
  const start = page * USERS_PER_PAGE;
  const end = start + USERS_PER_PAGE;
  const pageUsers = users.slice(start, end);

  if (users.length === 0) {
    const message = '👥 <b>Пользователи</b>\n\nПользователей пока нет';
    const keyboard = {
      inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'admin_back' }]]
    };

    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
    return;
  }

  let message = `👥 <b>Пользователи</b> (страница ${page + 1}/${totalPages})\n\n`;

  for (const [userId, user] of pageUsers) {
    const username = user.telegramUsername ? `@${user.telegramUsername}` : user.telegramFirstName || 'Без имени';
    const login = user.login || '—';
    const firstActivity = user.firstActivity ? new Date(user.firstActivity).toLocaleDateString('ru-RU') : '—';
    const lastActivity = user.lastActivity ? new Date(user.lastActivity).toLocaleString('ru-RU') : '—';

    message += `<b>${username}</b>\n`;
    message += `Логин EN: <code>${login}</code>\n`;
    message += `Первый вход: ${firstActivity}\n`;
    message += `Последний: ${lastActivity}\n\n`;
  }

  // Кнопки навигации
  const keyboard = { inline_keyboard: [] };
  const navButtons = [];

  if (page > 0) {
    navButtons.push({ text: '◀️ Назад', callback_data: `admin_users_${page - 1}` });
  }
  if (page < totalPages - 1) {
    navButtons.push({ text: 'Вперед ▶️', callback_data: `admin_users_${page + 1}` });
  }

  if (navButtons.length > 0) {
    keyboard.inline_keyboard.push(navButtons);
  }

  keyboard.inline_keyboard.push([{ text: '🏠 Главное меню', callback_data: 'admin_back' }]);

  await bot.editMessageText(message, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

/**
 * Показать меню управления модерацией
 */
async function showModerationMenu(chatId, messageId) {
  const status = adminConfig.moderationEnabled ? 'включена ✅' : 'выключена ❌';
  const buttonText = adminConfig.moderationEnabled ? '❌ Выключить' : '✅ Включить';

  const message = `🔐 <b>Управление модерацией</b>\n\n` +
    `Текущий статус: ${status}\n\n` +
    `Когда модерация включена, доступ к боту имеют только пользователи из белого списка.`;

  const keyboard = {
    inline_keyboard: [
      [{ text: buttonText, callback_data: 'moderation_toggle' }],
      [{ text: '◀️ Назад', callback_data: 'admin_back' }]
    ]
  };

  await bot.editMessageText(message, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

/**
 * Показать меню управления белым списком
 */
async function showWhitelistMenu(chatId, messageId, page = 0) {
  const ITEMS_PER_PAGE = 10;
  const whitelist = adminConfig.whitelist || [];
  const totalPages = Math.ceil(whitelist.length / ITEMS_PER_PAGE);
  const start = page * ITEMS_PER_PAGE;
  const end = start + ITEMS_PER_PAGE;
  const pageItems = whitelist.slice(start, end);

  let message = `📋 <b>Белый список</b>\n\n`;

  if (whitelist.length === 0) {
    message += 'Белый список пуст\n\n';
    message += 'Нажмите "Добавить", чтобы добавить пользователя';
  } else {
    message += `Страница ${page + 1}/${totalPages}\n\n`;

    for (let i = 0; i < pageItems.length; i++) {
      const item = pageItems[i];
      const globalIndex = start + i;
      const typeIcon = item.type === 'encounter' ? '🎮' : '📱';
      message += `${globalIndex + 1}. ${typeIcon} <code>${item.value}</code>\n`;
    }
  }

  // Кнопки
  const keyboard = { inline_keyboard: [] };

  // Кнопки удаления (только первые 5 на странице для экономии места)
  const removeButtons = [];
  for (let i = 0; i < Math.min(pageItems.length, 5); i++) {
    const globalIndex = start + i;
    removeButtons.push({
      text: `🗑️ ${globalIndex + 1}`,
      callback_data: `whitelist_remove_${globalIndex}`
    });
  }

  if (removeButtons.length > 0) {
    // Разбиваем по 3 кнопки в ряд
    for (let i = 0; i < removeButtons.length; i += 3) {
      keyboard.inline_keyboard.push(removeButtons.slice(i, i + 3));
    }
  }

  // Навигация
  const navButtons = [];
  if (page > 0) {
    navButtons.push({ text: '◀️', callback_data: `admin_whitelist_${page - 1}` });
  }
  navButtons.push({ text: '➕ Добавить', callback_data: 'whitelist_add' });
  if (page < totalPages - 1) {
    navButtons.push({ text: '▶️', callback_data: `admin_whitelist_${page + 1}` });
  }

  keyboard.inline_keyboard.push(navButtons);
  keyboard.inline_keyboard.push([{ text: '◀️ Назад', callback_data: 'admin_back' }]);

  await bot.editMessageText(message, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

/**
 * Обработка добавления в whitelist
 */
async function handleWhitelistAdd(chatId, messageId) {
  const message = `➕ <b>Добавление в белый список</b>\n\n` +
    `Отправьте данные в формате:\n\n` +
    `<code>telegram:username</code>\n` +
    `или\n` +
    `<code>encounter:login</code>\n\n` +
    `Пример:\n` +
    `<code>telegram:johndoe</code>\n` +
    `<code>encounter:player123</code>`;

  const keyboard = {
    inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_whitelist_0' }]]
  };

  await bot.editMessageText(message, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });

  // Устанавливаем состояние ожидания ввода
  userStates.set(chatId, 'WAITING_FOR_WHITELIST_ENTRY');
}

/**
 * Обработка удаления из whitelist
 */
async function handleWhitelistRemove(chatId, messageId, index) {
  if (!adminConfig.whitelist || index < 0 || index >= adminConfig.whitelist.length) {
    await bot.answerCallbackQuery(query.id, {
      text: '❌ Ошибка: запись не найдена',
      show_alert: true
    });
    return;
  }

  // Удаляем запись
  adminConfig.whitelist.splice(index, 1);
  await saveAdminConfig();

  // Обновляем меню
  await showWhitelistMenu(chatId, messageId, 0);
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
        
        // Получение информации об игре (с автореаутентификацией)
        const gameInfo = await api.getGameInfo(user.gameId, user.authCookies, user.login, user.password);

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

// Обработчик команды /admin
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;

  // Проверка root user
  if (chatId !== ROOT_USER_ID) {
    bot.sendMessage(chatId, '❌ У вас нет доступа к админ-панели');
    return;
  }

  // Отправляем главное меню админа
  await showAdminMainMenu(chatId);
});

// Обработчик команды /cancel - отмена текущего действия
bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  const currentState = userStates.get(chatId);

  if (currentState) {
    userStates.delete(chatId);
    bot.sendMessage(chatId, '❌ Действие отменено');
  } else {
    bot.sendMessage(chatId, 'Нет активных действий для отмены');
  }
});

/**
 * Показать главное меню админ-панели
 */
async function showAdminMainMenu(chatId) {
  const usersCount = userData.size;
  const moderationStatus = adminConfig.moderationEnabled ? 'включена ✅' : 'выключена ❌';
  const whitelistCount = adminConfig.whitelist ? adminConfig.whitelist.length : 0;

  const message = `👑 <b>Админ-панель</b>\n\n` +
    `👥 Пользователей: ${usersCount}\n` +
    `🔐 Модерация: ${moderationStatus}\n` +
    `📋 Белый список: ${whitelistCount} записей`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '👥 Пользователи', callback_data: 'admin_users_0' }
      ],
      [
        { text: '🔐 Модерация', callback_data: 'admin_moderation' }
      ],
      [
        { text: '📋 Белый список', callback_data: 'admin_whitelist_0' }
      ]
    ]
  };

  try {
    await bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  } catch (error) {
    console.error('Ошибка отправки админ-меню:', error);
    bot.sendMessage(chatId, '❌ Ошибка отображения админ-панели');
  }
}

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

// Обработчик callback_query (нажатия на inline кнопки)
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  // Проверка root user для админ-команд
  if (data.startsWith('admin_') && chatId !== ROOT_USER_ID) {
    await bot.answerCallbackQuery(query.id, {
      text: '❌ У вас нет доступа',
      show_alert: true
    });
    return;
  }

  try {
    // Обработка админ-команд
    if (data.startsWith('admin_users_')) {
      const page = parseInt(data.split('_')[2]) || 0;
      await showUsersList(chatId, messageId, page);
      await bot.answerCallbackQuery(query.id);
    } else if (data === 'admin_moderation') {
      await showModerationMenu(chatId, messageId);
      await bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('admin_whitelist_')) {
      const page = parseInt(data.split('_')[2]) || 0;
      userStates.delete(chatId); // Сброс состояния при переходе в whitelist меню
      await showWhitelistMenu(chatId, messageId, page);
      await bot.answerCallbackQuery(query.id);
    } else if (data === 'admin_back') {
      userStates.delete(chatId); // Сброс состояния при возврате в главное меню
      await bot.deleteMessage(chatId, messageId);
      await showAdminMainMenu(chatId);
      await bot.answerCallbackQuery(query.id);
    } else if (data === 'moderation_toggle') {
      // Переключение модерации
      adminConfig.moderationEnabled = !adminConfig.moderationEnabled;
      await saveAdminConfig();
      await showModerationMenu(chatId, messageId);
      await bot.answerCallbackQuery(query.id, {
        text: adminConfig.moderationEnabled ? '✅ Модерация включена' : '❌ Модерация выключена'
      });
    } else if (data === 'whitelist_add') {
      await handleWhitelistAdd(chatId, messageId);
      await bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('whitelist_remove_')) {
      const index = parseInt(data.split('_')[2]);
      await handleWhitelistRemove(chatId, messageId, index);
      await bot.answerCallbackQuery(query.id, { text: '🗑️ Удалено из белого списка' });
    } else {
      await bot.answerCallbackQuery(query.id);
    }
  } catch (error) {
    console.error('Ошибка обработки callback_query:', error);
    await bot.answerCallbackQuery(query.id, {
      text: '❌ Ошибка обработки команды',
      show_alert: true
    });
  }
});

// Обработчик текстовых сообщений
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Обновляем активность пользователя
  updateUserActivity(chatId, msg.from.username, msg.from.first_name);

  // Пропускаем команды
  if (text && text.startsWith('/')) {
    return;
  }

  const user = getUserInfo(chatId);

  // Определяем текущее состояние
  let currentState = userStates.get(chatId);

  // Если состояние не установлено, проверяем готовность пользователя
  if (!currentState) {
    if (isUserReady(chatId)) {
      currentState = STATES.READY;
      userStates.set(chatId, STATES.READY);
    } else {
      currentState = STATES.WAITING_FOR_LOGIN;
    }
  }

  // Обработка ввода для whitelist (только для админа)
  if (currentState === 'WAITING_FOR_WHITELIST_ENTRY' && chatId === ROOT_USER_ID) {
    const input = text.trim();
    const parts = input.split(':');

    if (parts.length !== 2 || !['telegram', 'encounter'].includes(parts[0])) {
      bot.sendMessage(chatId, '❌ Неправильный формат. Используйте:\ntelegram:username или encounter:login');
      return;
    }

    const type = parts[0];
    const value = parts[1].toLowerCase().replace('@', '');

    // Проверяем дубликаты
    const exists = adminConfig.whitelist.some(item =>
      item.type === type && item.value.toLowerCase() === value
    );

    if (exists) {
      bot.sendMessage(chatId, '⚠️ Эта запись уже есть в белом списке');
      userStates.delete(chatId);
      return;
    }

    // Добавляем в whitelist
    adminConfig.whitelist.push({
      type,
      value,
      addedBy: chatId,
      addedAt: Date.now()
    });

    await saveAdminConfig();
    await bot.sendMessage(chatId, `✅ Добавлено в белый список:\n${type === 'telegram' ? '📱' : '🎮'} <code>${value}</code>`, {
      parse_mode: 'HTML'
    });

    userStates.delete(chatId);
    return;
  }

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
      // Проверка доступа к игре
      if (!(await checkGameAccess(chatId))) {
        return;
      }

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
        // Проверка доступа к игре
        if (!(await checkGameAccess(chatId))) {
          return;
        }

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
        // Проверка доступа к игре
        if (!(await checkGameAccess(chatId))) {
          return;
        }

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
        // Проверка доступа к игре
        if (!(await checkGameAccess(chatId))) {
          return;
        }

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
        // Проверка доступа к игре перед отправкой ответа
        if (!(await checkGameAccess(chatId))) {
          return;
        }

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
  await loadAdminConfig();
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