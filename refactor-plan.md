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