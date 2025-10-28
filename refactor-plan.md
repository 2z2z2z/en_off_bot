# Отчёт о ревью мультиплатформенной архитектуры

Дата: 2025-10-28
Версия: 1.0
Статус: План рефакторинга после миграции на мультиплатформенную архитектуру

---

## ✅ Что выполнено успешно

**Архитектурные улучшения:**
- ✅ Чистое разделение на слои: core (user-store, messenger, answer-service) + adapters
- ✅ Правильная абстракция PlatformAdapter с типами событий
- ✅ Успешная миграция данных на схему `{ platform, userId }`
- ✅ Унифицированная система клавиатур с fallback для VK
- ✅ Rate limiting в Encounter API (1.2s между запросами)
- ✅ Кеширование уровней для оптимизации запросов
- ✅ Автореаутентификация при истечении сессии

---

## 🔴 КРИТИЧЕСКИЕ проблемы (требуют немедленного исправления)

### 1. Race condition в обработке очереди ответов

**Локация:** `src/core/answer-service.js:171-316`, `index.js:698`

**Проблема:**
```javascript
// В handleReadyStateInput (index.js:698)
if (result && user.answerQueue.length > 0) {
  setTimeout(() => processAnswerQueue(platform, userId), 1200);
}
```
При быстрой отправке нескольких ответов может запуститься несколько параллельных `processAnswerQueue`, которые одновременно модифицируют `answerQueue` через `queue.splice(i, 1)`.

**Последствия:**
- Двойная отправка ответов
- Некорректное удаление из очереди
- Race condition при записи в `user_data.json`
- Потенциальная потеря данных

**Решение:**
Добавить флаг блокировки в user object:
```javascript
// В user-store.js добавить поле
isProcessingQueue: false

// В answer-service.js перед обработкой
async function processAnswerQueue(platform, userId) {
  const user = getUserInfo(platform, userId);

  if (user.isProcessingQueue) {
    console.log('⏭️ Очередь уже обрабатывается, пропускаю');
    return;
  }

  user.isProcessingQueue = true;
  try {
    // ... существующий код обработки
  } finally {
    user.isProcessingQueue = false;
    await saveUserData();
  }
}
```

**Приоритет:** P0 (критический)

---

### 2. Безопасность: пароли в открытом виде

**Локация:** `user_data.json`, `src/core/user-store.js`

**Проблема:**
Пароли Encounter хранятся в plain text:
```json
{
  "telegram::12345": {
    "login": "user1",
    "password": "mypassword123"  // <- PLAIN TEXT
  }
}
```

**Последствия:**
- Компрометация всех аккаунтов пользователей при утечке файла
- Нарушение базовых требований безопасности
- В README.md:180 это упомянуто как "рекомендуется добавить", но это критическая уязвимость

**Решение:**
Шифрование AES-256 с ключом из environment:
```javascript
// src/utils/crypto.js
const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32);
const IV_LENGTH = 16;

function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
  const parts = text.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encryptedText = Buffer.from(parts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}
```

**Приоритет:** P0 (критический)

---

### 3. Memory leak в messageUpdateThrottle

**Локация:** `index.js:1430`

**Проблема:**
```javascript
const messageUpdateThrottle = new Map(); // строка 1430
// Добавляются записи при каждом редактировании сообщения
messageUpdateThrottle.set(throttleKey, {
  lastUpdate: Date.now(),
  // ...
});
// НО НИКОГДА НЕ УДАЛЯЮТСЯ!
```

Каждое редактирование сообщения создаёт запись вида `${platform}_${userId}_${messageId}`, которая никогда не очищается.

**Последствия:**
- При длительной работе бота Map может вырасти до сотен мегабайт/гигабайтов
- Деградация производительности
- Потенциальный crash при нехватке памяти

**Решение:**
Добавить периодическую очистку старых записей:
```javascript
const MESSAGE_THROTTLE_TTL = 10 * 60 * 1000; // 10 минут

// Периодическая очистка
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, value] of messageUpdateThrottle.entries()) {
    if (now - value.lastUpdate > MESSAGE_THROTTLE_TTL) {
      if (value.timeout) {
        clearTimeout(value.timeout);
      }
      messageUpdateThrottle.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Очищено ${cleaned} устаревших throttle записей`);
  }
}, 5 * 60 * 1000); // каждые 5 минут
```

**Приоритет:** P0 (критический)

---

### 4. Telegram rate limiting не обрабатывается для больших очередей

**Локация:** `src/core/answer-service.js:184-315`

**Проблема:**
При обработке очереди из 30+ ответов каждый ответ обновляет progress message:
```javascript
// В processAnswerQueue
for (let i = 0; i < queue.length; i++) {
  // ...
  await sendOrUpdateMessage(platform, userId,
    `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n⏳ Отправляю "${queueItem.answer}"...`,
    queueMessage.message_id
  );
  // <- вызывается для КАЖДОГО ответа
}
```

Telegram Bot API ограничения:
- Max 20 редактирований одного сообщения в минуту
- При превышении: HTTP 429 Too Many Requests

**Текущая обработка:**
Ошибка логируется, но игнорируется (index.js:1495):
```javascript
if (error.response?.statusCode === 429) {
  console.log('⚠️ Rate limit (429), пропускаю обновление сообщения');
  return messageId;
}
```

**Последствия:**
- Пользователь не видит прогресс обработки очереди
- Путаница: последнее видимое сообщение может быть "2/30", хотя обработано 30/30

**Решение:**
Обновлять progress message батчами:
```javascript
async function processAnswerQueue(platform, userId) {
  // ...
  const UPDATE_EVERY_N = 5; // обновлять каждые 5 ответов
  const MIN_UPDATE_INTERVAL = 3000; // минимум 3 секунды между обновлениями
  let lastUpdateTime = 0;

  for (let i = 0; i < queue.length; i++) {
    // ...
    processed++;

    const shouldUpdate =
      processed % UPDATE_EVERY_N === 0 ||
      i === queue.length - 1 || // последний
      Date.now() - lastUpdateTime > MIN_UPDATE_INTERVAL;

    if (shouldUpdate) {
      await sendOrUpdateMessage(platform, userId,
        `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}...`,
        queueMessage.message_id
      );
      lastUpdateTime = Date.now();
    }
  }
}
```

**Приоритет:** P0 (критический UX)

---

## 🟠 ВЫСОКИЕ риски (должны быть исправлены до production)

### 5. Race condition в Encounter API rate limiter

**Локация:** `encounter-api.js:20-32`

**Проблема:**
`lastRequestTime` - статическое поле класса, но проверка не атомарна:
```javascript
async _waitRateLimit() {
  const now = Date.now();
  const lastTime = EncounterAPI.lastRequestTime[this.domain] || 0;
  const elapsed = now - lastTime;
  // <- здесь может случиться context switch
  if (elapsed < 1200) {
    await new Promise(resolve => setTimeout(resolve, 1200 - elapsed));
  }
  EncounterAPI.lastRequestTime[this.domain] = Date.now();
  // <- два параллельных запроса могут записать одновременно
}
```

**Сценарий:**
1. Request A: читает lastTime = 0, elapsed = 1000ms
2. Request B: читает lastTime = 0, elapsed = 1001ms (параллельно)
3. Request A: ждёт 200ms, затем записывает lastTime = 1200
4. Request B: ждёт 199ms, затем записывает lastTime = 1200
5. Оба запроса отправляются с интервалом < 1200ms

**Последствия:**
- Нарушение rate limit
- Риск блокировки IP от Encounter
- Редко проявляется, но при высокой нагрузке критично

**Решение:**
Использовать Promise queue:
```javascript
class EncounterAPI {
  static requestQueues = {}; // domain -> Promise

  async _waitRateLimit() {
    const domain = this.domain;

    // Ждём завершения предыдущего запроса к этому домену
    if (EncounterAPI.requestQueues[domain]) {
      await EncounterAPI.requestQueues[domain];
    }

    const now = Date.now();
    const lastTime = EncounterAPI.lastRequestTime[domain] || 0;
    const elapsed = now - lastTime;

    if (elapsed < 1200) {
      const waitTime = 1200 - elapsed;
      console.log(`⏱️ Rate limit: жду ${waitTime}ms перед запросом к ${domain}`);

      // Создаём Promise для ожидания
      EncounterAPI.requestQueues[domain] = new Promise(resolve =>
        setTimeout(resolve, waitTime)
      );
      await EncounterAPI.requestQueues[domain];
    }

    EncounterAPI.lastRequestTime[domain] = Date.now();
    EncounterAPI.requestQueues[domain] = null;
  }
}
```

**Приоритет:** P1

---

### 6. Кеш уровней не thread-safe для одной игры

**Локация:** `encounter-api.js:11-88`

**Проблема:**
Если два пользователя играют в одну игру на одном домене:
```javascript
// Структура кеша
static levelCache = {}; // ключ: "domain_gameId"

// User1 и User2 играют в game #12345
_getLevelFromCache(gameId) {
  const cacheKey = `${this.domain}_${gameId}`; // одинаковый для обоих!
  return EncounterAPI.levelCache[cacheKey];
}
```

**Сценарий:**
1. User1 отправляет ответ → кеш сохранён для уровня 5
2. User2 отправляет ответ → использует тот же кеш (уровень 5)
3. User1 проходит уровень 5 → кеш инвалидирован
4. User2 всё ещё на уровне 5, но кеш удалён
5. User2 делает лишний запрос `getGameState()`

**Последствия:**
- Лишние запросы к API (не критично благодаря rate limit)
- Некорректное поведение в командных играх
- Один игрок может "сбросить" кеш для другого

**Решение:**
Кеш по ключу `${domain}_${gameId}_${userId}`:
```javascript
_getLevelFromCache(gameId, userId) {
  const cacheKey = `${this.domain}_${gameId}_${userId}`;
  return EncounterAPI.levelCache[cacheKey];
}
```

**Приоритет:** P1 (если есть командные игры) / P2 (для личных игр)

---

### 7. Обработка очереди прерывается на неизвестной ошибке

**Локация:** `src/core/answer-service.js:289-294`

**Проблема:**
```javascript
} else {
  // Неизвестная ошибка - прерываем обработку
  await sendOrUpdateMessage(platform, userId,
    `❌ Ошибка обработки очереди: ${error.message}\n📊 Обработано: ${successful}/${totalAnswers}`,
    queueMessage.message_id
  );
  break;  // <- ВЫХОД! Остальные ответы остаются в очереди
}
```

**Сценарий:**
1. В очереди 10 ответов
2. При обработке 3-го ответа происходит network glitch (ETIMEDOUT)
3. Обработка прерывается
4. Ответы 4-10 остаются в очереди навсегда (пока пользователь не отправит новый ответ)

**Последствия:**
- Потеря ответов
- Путаница: пользователь думает, что все ответы отправлены
- Очередь "застревает"

**Решение:**
Логировать ошибку, но продолжать обработку:
```javascript
} else {
  // Неизвестная ошибка - логируем и продолжаем
  console.error(`❌ Неизвестная ошибка при обработке "${queueItem.answer}":`, error);

  await sendOrUpdateMessage(platform, userId,
    `🔄 Обрабатываю очередь: ${processed}/${totalAnswers}\n` +
    `⚠️ Ошибка для "${queueItem.answer}": ${error.message}`,
    queueMessage.message_id
  );

  // Помечаем ответ как failed, но НЕ удаляем из очереди
  queueItem.failedAttempts = (queueItem.failedAttempts || 0) + 1;

  // Если слишком много неудачных попыток - удаляем
  if (queueItem.failedAttempts >= 3) {
    console.log(`🗑️ Удаляю ответ "${queueItem.answer}" после 3 неудачных попыток`);
    queue.splice(i, 1);
    i--;
    skipped++;
  }

  // ПРОДОЛЖАЕМ обработку следующих ответов
  // break; <- УДАЛИТЬ
}
```

**Приоритет:** P1

---

## 🟡 СРЕДНИЕ риски (рекомендуется исправить)

### 8. VK peer_id: возможные проблемы с отрицательными значениями

**Локация:** `index.js:1915-1936`

**Контекст:**
VK использует отрицательные peer_id для групповых чатов (например, `-123456789` для беседы).

**Текущая реализация:**
```javascript
const toPeerId = (userId, options = {}) => {
  if (typeof userId === 'number') {
    return userId;
  }

  if (typeof userId === 'string' && userId.trim() !== '') {
    const parsed = Number(userId);
    if (!Number.isNaN(parsed) && parsed !== 0) {
      return parsed; // <- корректно обрабатывает отрицательные
    }
  }

  // ...
};
```

**Потенциальная проблема:**
Storage key формируется как `vk::${userId}`, где userId может быть отрицательным:
```javascript
makeStorageKey('vk', '-123456789') // => "vk::-123456789"
```

**Проверить:**
- Корректность работы с отрицательными userId в `user-store.js`
- Парсинг при загрузке из JSON
- Сравнение в whitelist (если будет учитывать platform)

**Решение:**
Добавить unit test:
```javascript
// test/user-store.test.js
test('handles negative VK peer_id correctly', () => {
  const user = getUserInfo('vk', '-123456789');
  expect(user.userId).toBe('-123456789');
  expect(user.platform).toBe('vk');

  const key = makeStorageKey('vk', '-123456789');
  expect(key).toBe('vk::-123456789');
});
```

**Приоритет:** P2 (низкий риск, но требует проверки)

---

### 9. Дублирование HTML санитизации

**Локация:** `index.js:1175-1332`

**Проблема:**
Три функции обработки HTML (всего 153 строки кода):
- `sanitizeHtmlForTelegram` (105 строк) - конвертация HTML → Telegram HTML
- `stripHtml` (43 строки) - удаление всех HTML тегов
- `escapeHtml` (5 строк) - экранирование спецсимволов

**Последствия:**
- Дублирование логики (обработка `<br>`, entity декодинг)
- Сложность тестирования
- Загромождение основного файла index.js

**Решение:**
Вынести в отдельный модуль:
```javascript
// src/utils/html-formatter.js
class HtmlFormatter {
  /**
   * Конвертирует HTML в Telegram-совместимый формат
   */
  static sanitizeForTelegram(html) {
    // ... текущая логика sanitizeHtmlForTelegram
  }

  /**
   * Удаляет все HTML теги, оставляет только текст
   */
  static stripTags(html) {
    // ... текущая логика stripHtml
  }

  /**
   * Экранирует HTML спецсимволы
   */
  static escape(text) {
    // ... текущая логика escapeHtml
  }

  /**
   * Декодирует HTML entities
   */
  static decodeEntities(text) {
    return text
      .replace(/&nbsp;/gi, ' ')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, '\'')
      .replace(/&apos;/gi, '\'')
      .replace(/&ndash;/gi, '-')
      .replace(/&mdash;/gi, '-')
      .replace(/&hellip;/gi, '...')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&');
  }
}

module.exports = { HtmlFormatter };
```

```javascript
// В index.js
const { HtmlFormatter } = require('./src/utils/html-formatter');

// Использование
const sanitized = HtmlFormatter.sanitizeForTelegram(html);
const stripped = HtmlFormatter.stripTags(html);
const escaped = HtmlFormatter.escape(text);
```

**Бонус:** Легко добавить unit tests:
```javascript
// test/html-formatter.test.js
test('sanitizeForTelegram preserves allowed tags', () => {
  const input = '<b>Bold</b> <i>Italic</i> <script>alert()</script>';
  const output = HtmlFormatter.sanitizeForTelegram(input);
  expect(output).toBe('<b>Bold</b> <i>Italic</i> ');
});
```

**Приоритет:** P2 (улучшение архитектуры)

---

### 10. Отсутствие rate limiting на уровне пользователей

**Проблема:**
Нет ограничений на количество ответов от одного пользователя.

**Сценарий атаки:**
1. Злоумышленник создаёт скрипт, отправляющий 1000 ответов в минуту
2. Бот пытается отправить все ответы в Encounter
3. Encounter блокирует IP бота (слишком много запросов)
4. ВСЕ пользователи бота теряют доступ

**Текущая защита:**
- Rate limit на уровне домена (1.2s между запросами)
- НО: один пользователь может заполнить очередь тысячами ответов

**Решение:**
Добавить лимиты на уровне пользователя:
```javascript
// src/core/answer-service.js

const USER_RATE_LIMITS = {
  maxAnswersPerMinute: 30,
  maxQueueSize: 60
};

async function sendAnswerToEncounter(platform, userId, answer, progressMessageId = null) {
  const user = getUserInfo(platform, userId);

  // Проверка размера очереди
  if (user.answerQueue.length >= USER_RATE_LIMITS.maxQueueSize) {
    await sendOrUpdateMessage(platform, userId,
      `⚠️ Очередь переполнена (${user.answerQueue.length} ответов).\n` +
      `Максимум: ${USER_RATE_LIMITS.maxQueueSize}. Подождите обработки.`,
      progressMessageId
    );
    return null;
  }

  // Проверка rate limit (ответов в минуту)
  const oneMinuteAgo = Date.now() - 60000;
  const recentAnswers = (user.recentAnswers || []).filter(t => t > oneMinuteAgo);

  if (recentAnswers.length >= USER_RATE_LIMITS.maxAnswersPerMinute) {
    await sendOrUpdateMessage(platform, userId,
      `⏱️ Слишком много ответов.\n` +
      `Лимит: ${USER_RATE_LIMITS.maxAnswersPerMinute} ответов в минуту.\n` +
      `Подождите ${Math.ceil((recentAnswers[0] + 60000 - Date.now()) / 1000)}с`,
      progressMessageId
    );
    return null;
  }

  // Добавляем timestamp текущего ответа
  user.recentAnswers = [...recentAnswers, Date.now()];

  // ... существующая логика отправки
}
```

**Приоритет:** P2 (защита от злоупотреблений)

---

## 🟢 Оптимизации (не критично, но улучшит качество)

### 11. Избыточные запросы к Encounter при получении задания/секторов

**Локация:** `index.js:702-803` (sendLevelTask), `index.js:557-646` (Сектора)

**Проблема:**
Дублирование логики авторизации и получения состояния:
```javascript
async function sendLevelTask(platform, userId, user, formatted) {
  // ...

  // 1. Проверка cookies
  if (!user.authCookies || Object.keys(user.authCookies).length === 0) {
    const auth = await api.authenticate(user.login, user.password);
    if (!auth.success) throw new Error(auth.message);
    user.authCookies = auth.cookies;
    await saveUserData();
  }

  // 2. Получение состояния
  let gameState;
  try {
    gameState = await api.getGameState(user.gameId, user.authCookies);
  } catch (error) {
    // 3. Повторная авторизация при ошибке
    if (msg.includes('требуется авторизация')) {
      const reauth = await api.authenticate(user.login, user.password);
      if (!reauth.success) throw new Error(reauth.message);
      user.authCookies = reauth.cookies;
      await saveUserData();
      gameState = await api.getGameState(user.gameId, user.authCookies);
    }
  }
}
```

Эта же логика повторяется в:
- Обработчике "Сектора" (index.js:557)
- Возможно будет в других местах

**Решение:**
Использовать унифицированный метод `sendToEncounterAPI` из answer-service:
```javascript
// src/core/answer-service.js - добавить метод
async function getGameStateWithAuth(user) {
  const api = new EncounterAPI(user.domain);

  if (!user.authCookies || Object.keys(user.authCookies).length === 0) {
    const authResult = await api.authenticate(user.login, user.password);
    if (!authResult.success) {
      throw new Error(`Ошибка авторизации: ${authResult.message}`);
    }
    user.authCookies = authResult.cookies;
    await saveUserData();
  }

  // getGameState уже имеет встроенную автореаутентификацию
  const gameState = await api.getGameState(
    user.gameId,
    user.authCookies,
    user.login,
    user.password
  );

  // Сохраняем обновлённые cookies, если были
  if (gameState.newCookies) {
    user.authCookies = gameState.newCookies;
    await saveUserData();
  }

  return gameState;
}

// Экспортируем
module.exports = {
  createAnswerService,
  getGameStateWithAuth // <- новый метод
};
```

```javascript
// В index.js
const { createAnswerService, getGameStateWithAuth } = require('./src/core/answer-service');

async function sendLevelTask(platform, userId, user, formatted) {
  // ...
  try {
    const gameState = await getGameStateWithAuth(user);

    if (!gameState.success) {
      throw new Error('Не удалось получить состояние игры');
    }

    // ... остальная логика без дублирования авторизации
  }
}
```

**Приоритет:** P3 (DRY принцип)

---

## 📋 Корректность флоу

### ✅ Что работает правильно:

1. **Автореаутентификация**
   - Локация: `encounter-api.js:219-328` (getGameState), `encounter-api.js:331-594` (sendAnswer)
   - Корректно обрабатывает истечение сессии через флаг `error.needsAuth`
   - Повторяет запрос с новыми cookies после реаутентификации
   - Флаг `isRetry` предотвращает бесконечную рекурсию

2. **Event=16 handling**
   - Локация: `encounter-api.js:397-399`, `encounter-api.js:540-542`
   - Правильно инвалидирует кеш при смене уровня
   - Обрабатывает коды 16, 18, 19, 20, 21, 22 (различные варианты смены уровня)

3. **Миграция user_data.json**
   - Локация: `user-store.js:62-148`
   - Корректно добавляет недостающие поля (`platform`, `userId`, `telegramUsername`, и т.д.)
   - Не теряет существующие данные
   - Логирует количество обновлённых записей

4. **Throttling редактирования сообщений**
   - Локация: `index.js:1430-1512`
   - Предотвращает слишком частые обновления одного сообщения (< 2s)
   - Буферизует pending обновления
   - Корректно обрабатывает ошибку "message is not modified"

5. **VK keyboard fallback**
   - Локация: `vk-adapter.js:306-330`
   - Корректно обрабатывает коды ошибок 911/912
   - Повторяет отправку без клавиатуры
   - Работает для sendMessage и editMessage

6. **Platform adapter архитектура**
   - Локация: `src/platforms/platform-adapter.js`
   - Правильное наследование и полиморфизм
   - Нормализация событий через `_normalizeEvent()`
   - Единый интерфейс для всех платформ

7. **Rate limiting в Encounter API**
   - Локация: `encounter-api.js:20-32`
   - Соблюдает минимальный интервал 1.2s между запросами
   - Работает на уровне домена (не блокирует разные домены)
   - Логирует время ожидания

### ⚠️ Что требует проверки в реальных условиях:

1. **Одновременная игра двух пользователей в одну игру**
   - Локация: `encounter-api.js:51-88` (кеш уровней)
   - Протестировать сценарий с 2+ пользователями в одной игре
   - Проверить корректность инвалидации кеша
   - Замерить количество лишних запросов к API

2. **Большая очередь (50+ ответов)**
   - Локация: `answer-service.js:171-316`
   - Протестировать обработку очереди из 50-100 ответов
   - Проверить Telegram rate limiting (429 ошибки)
   - Убедиться, что прогресс-сообщение обновляется корректно

3. **Смена domain в VK**
   - Локация: `index.js:527-530` (handleGameUrlInput)
   - Проверить, что cookies сбрасываются при смене домена
   - Протестировать переход с одного домена Encounter на другой
   - Убедиться, что старые cookies не используются

4. **Параллельная отправка ответов**
   - Сценарий: пользователь быстро отправляет 5 ответов подряд
   - Проверить, что все ответы попадают в очередь
   - Убедиться, что нет гонок при записи в `user_data.json`
   - Протестировать с включённым rate limiting

---

## 💡 Рекомендации по архитектуре

### ✅ Что хорошо:

1. **Чистое разделение слоёв**
   - Core логика (user-store, messenger, answer-service) отделена от платформ
   - Никаких прямых зависимостей от Telegram/VK в core
   - Инъекция зависимостей через параметры функций

2. **Использование адаптеров для платформ**
   - Базовый класс `PlatformAdapter` с единым интерфейсом
   - Каждая платформа реализует свои специфичные методы
   - Нормализация событий через `_normalizeEvent()`

3. **Единый интерфейс messenger**
   - Абстракция над различными API платформ
   - Регистрация транспортов через `registerTransport()`
   - Скрывает различия между Telegram и VK

4. **Инъекция зависимостей в answer-service**
   - createAnswerService принимает все зависимости как параметры
   - Легко тестировать с моками
   - Нет глобальных зависимостей

5. **Унифицированная система клавиатур**
   - Общий формат описания клавиатур
   - Автоматическая конвертация для каждой платформы
   - Fallback при неподдержке

### 🔄 Что можно улучшить:

1. **Добавить типы (TypeScript или JSDoc)**
   ```javascript
   /**
    * @typedef {Object} User
    * @property {string} platform - Платформа пользователя
    * @property {string} userId - ID пользователя
    * @property {string|null} login - Логин Encounter
    * @property {string|null} password - Пароль Encounter
    * @property {Object|null} authCookies - Cookies авторизации
    * @property {Array<AnswerQueueItem>} answerQueue - Очередь ответов
    */

   /**
    * Получает информацию о пользователе
    * @param {string} platform - Идентификатор платформы
    * @param {string} userId - ID пользователя
    * @returns {User}
    */
   function getUserInfo(platform, userId) { /* ... */ }
   ```

2. **Вынести конфигурацию в отдельный модуль**
   ```javascript
   // src/config/index.js
   const config = {
     telegram: {
       token: process.env.BOT_TOKEN
     },
     vk: {
       token: process.env.VK_GROUP_TOKEN,
       groupId: process.env.VK_GROUP_ID
     },
     encounter: {
       rateLimitMs: 1200,
       levelCacheTTL: 30000
     },
     moderation: {
       enabled: false,
       whitelist: []
     },
     admin: {
       users: parseAdminUsers(process.env.ADMIN_USERS)
     },
     storage: {
       userDataFile: process.env.DATA_FILE || 'user_data.json',
       adminConfigFile: 'admin_config.json'
     },
     limits: {
       maxAnswersPerMinute: 10,
       maxQueueSize: 50,
       maxRetries: 2
     }
   };

   module.exports = config;
   ```

3. **Добавить unit-тесты для критических функций**
   ```javascript
   // test/answer-service.test.js
   describe('processAnswerQueue', () => {
     it('should not process queue if already processing', async () => {
       const user = { isProcessingQueue: true, answerQueue: [/* ... */] };
       await processAnswerQueue('telegram', '12345');
       expect(user.answerQueue.length).toBe(3); // не изменилась
     });

     it('should handle network errors gracefully', async () => {
       // Mock ETIMEDOUT error
       // Проверить, что ответ добавлен в очередь
     });
   });

   // test/rate-limit.test.js
   describe('Encounter API rate limiting', () => {
     it('should wait 1.2s between requests', async () => {
       const api = new EncounterAPI('https://test.en.cx');
       const start = Date.now();

       await api._waitRateLimit();
       await api._waitRateLimit();

       const elapsed = Date.now() - start;
       expect(elapsed).toBeGreaterThanOrEqual(1200);
     });
   });
   ```

4. **Использовать Event Emitter для связи между слоями**
   ```javascript
   // src/core/events.js
   const EventEmitter = require('events');
   const botEvents = new EventEmitter();

   // События
   botEvents.on('user:registered', ({ platform, userId }) => {
     logger.info('Новый пользователь', { platform, userId });
   });

   botEvents.on('answer:sent', ({ platform, userId, answer, result }) => {
     // Логирование, аналитика, webhook
   });

   botEvents.on('queue:processed', ({ platform, userId, stats }) => {
     // Уведомление админам о завершении очереди
   });

   // В коде
   botEvents.emit('answer:sent', { platform, userId, answer, result });
   ```

5. **Добавить middleware/interceptors**
   ```javascript
   // src/middleware/moderation.js
   function moderationMiddleware(context, next) {
     if (adminConfig.moderationEnabled && !isUserAllowed(context.platform, context.userId)) {
       return sendMessage(context.platform, context.userId,
         '🚫 Доступ запрещён');
     }
     return next();
   }

   // src/middleware/rate-limit.js
   function rateLimitMiddleware(context, next) {
     if (isRateLimited(context.platform, context.userId)) {
       return sendMessage(context.platform, context.userId,
         '⏱️ Слишком много запросов');
     }
     return next();
   }

   // Использование
   const middlewares = [
     moderationMiddleware,
     rateLimitMiddleware,
     loggingMiddleware
   ];

   async function handleTextMessage(context) {
     for (const middleware of middlewares) {
       const shouldContinue = await middleware(context, () => true);
       if (!shouldContinue) return;
     }

     // Основная обработка
   }
   ```

---

## 🔗 Связанные документы

- `plan.md` - План рефакторинга (выполнен)
- `docs/telegram-behavior.md` - Описание поведения Telegram бота
- `docs/testing-checklist.md` - Чеклист для тестирования
- `CLAUDE.md` - Инструкции для разработки

---
