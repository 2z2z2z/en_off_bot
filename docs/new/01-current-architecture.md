# Спецификация поведения EN-Offline-Bot

> Полная спецификация для реализации с нуля.

---

## Encounter API

### Endpoints

```
BASE_URL = https://{domain}.en.cx

GET  /GameEngines/Encounter/Play/{gameId}?json=1    # Состояние игры
POST /GameEngines/Encounter/Play/{gameId}?json=1    # Отправка ответа
POST /Login.aspx                                     # Авторизация
```

### Авторизация

**Request:**
```
POST /Login.aspx
Content-Type: application/x-www-form-urlencoded

Login={login}&Password={password}&return=%2F
```

**Response cookies:** `GUID`, `stoken`, `atoken`

**Auth errors:**
| Code | Описание |
|------|----------|
| 1 | Требуется капча |
| 2 | Неверный логин/пароль |
| 3 | Пользователь заблокирован |
| 7 | Заблокирован админом |
| 9 | Брутфорс детектирован |

### Состояние игры (GET)

**Headers:**
```
Cookie: GUID=xxx; stoken=xxx; atoken=xxx
User-Agent: Mozilla/5.0...
```

**Response:**
```json
{
  "Event": 0,
  "Level": {
    "LevelId": 12345,
    "Number": 3,
    "IsPassed": false,
    "Dismissed": false,
    "HasAnswerBlockRule": false,
    "BlockDuration": 0
  },
  "GameTitle": "Название игры",
  "GameNumber": 1
}
```

### Отправка ответа (POST)

**Request:**
```
POST /GameEngines/Encounter/Play/{gameId}?json=1
Content-Type: application/x-www-form-urlencoded
Cookie: GUID=xxx; stoken=xxx; atoken=xxx

LevelId={levelId}&LevelNumber={levelNumber}&LevelAction.Answer={answer}
```

**Response:**
```json
{
  "Event": 0,
  "Level": { ... },
  "LevelAction": {
    "Answer": "код123",
    "IsCorrect": true
  }
}
```

### Event коды

| Code | Значение | Действие |
|------|----------|----------|
| 0 | OK | Продолжить |
| 1 | Неизвестная ошибка | Показать ошибку |
| 2 | Игра не существует | Критическая ошибка |
| 3 | Не тип Encounter | Критическая ошибка |
| 4 | Не авторизован | Реавторизация |
| 5 | Игра не началась | Показать ошибку |
| 6 | Игра закончилась | Финал |
| 7 | Нет заявки игрока | Показать ошибку |
| 8 | Нет заявки команды | Показать ошибку |
| 9 | Игрок не принят | Показать ошибку |
| 10 | Нет команды | Показать ошибку |
| 11 | Игрок не активен | Показать ошибку |
| 12 | Нет уровней | Показать ошибку |
| 13 | Превышен лимит участников | Показать ошибку |
| 14 | Игрок заблокирован | Критическая ошибка |
| 15 | Команда заблокирована | Критическая ошибка |
| 16-22 | Уровень изменился | Инвалидация кеша |

---

## Обработка ошибок

### Сетевые ошибки → offline queue

| Код | Сообщение |
|-----|-----------|
| ECONNREFUSED | (error.message) |
| ENOTFOUND | "Домен не найден" |
| ETIMEDOUT | "Превышено время ожидания" |
| 500 | "Ошибка сервера Encounter" |
| 503 | "Сервер временно недоступен" |

### Капча (Auth код 1)

→ Сообщение: "Требуется прохождение капчи..."
→ Если есть `CaptchaUrl` в ответе → добавить ссылку
→ НЕ добавлять в очередь

### Auth код 4 (не авторизован)

→ Попытка реавторизации
→ Если успех → повторить запрос

### Неизвестные ошибки

→ `failedAttempts++`
→ После 3 попыток → удалить из очереди

### Таймаут

`timeout = 10000` (10 сек)

---

## Структура данных пользователя (SQLite)

```sql
-- Персистентные поля
id, platform, platform_user_id,
login, password_encrypted, domain, game_id,
auth_cookies,                    -- JSON: { GUID, stoken, atoken }
state,                           -- FSM статус
is_online,
last_known_level_id,
last_known_level_number,
created_at, updated_at

-- Runtime (в памяти)
isProcessingQueue: boolean
isAuthenticating: boolean
authPromise: Promise | null
accumulationTimer: NodeJS.Timeout | null
pendingBurstTimer: NodeJS.Timeout | null
```

### SQL схема (SQLite)

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,             -- 'telegram' | 'vk'
  platform_user_id TEXT NOT NULL,
  login TEXT,
  password_encrypted TEXT,
  domain TEXT,
  game_id TEXT,
  auth_cookies TEXT,                  -- JSON: { GUID, stoken, atoken }
  state TEXT NOT NULL DEFAULT 'initial',
  is_online INTEGER NOT NULL DEFAULT 1,
  last_known_level_id INTEGER,
  last_known_level_number INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, platform_user_id)
);

CREATE TABLE answer_queue (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  answer TEXT NOT NULL,
  level_id INTEGER,
  level_number INTEGER,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE accumulated_answers (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  answer TEXT NOT NULL,
  level_id INTEGER,
  level_number INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE whitelist (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  added_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, platform_user_id)
);

CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Индексы для очередей
CREATE INDEX idx_answer_queue_user ON answer_queue(user_id, created_at);
CREATE INDEX idx_accumulated_user ON accumulated_answers(user_id, created_at);
```

---

## FSM состояний

```
INITIAL
    │ /start
    ▼
WAITING_LOGIN
    │ текст (логин)
    ▼
WAITING_PASSWORD
    │ текст (пароль) → авторизация
    ▼
WAITING_GAME_URL
    │ текст (URL) → парсинг + проверка игры
    ▼
READY ◄──────────────────────────┐
    │ ответ                      │
    ▼                            │
[QueueManager] ─── send ────────►│
    │                            │
    ├── accumulate ──► Accumulator (5s) ──► pendingDecision
    │                            │
    └── queue ──► OfflineQueue ──┘
```

---

## Три системы очередей

### 1. Burst Detection (в памяти)

**Константы:**
- `BURST_WINDOW = 10000` (10 сек)
- `BURST_THRESHOLD = 3` (минимум сообщений)
- `MESSAGE_INTERVAL_MAX = 2500` (макс интервал)

**Алгоритм:**
```
каждый ответ → добавить { text, timestamp } в буфер
если 3+ сообщений за 10 сек И все интервалы < 2.5 сек:
  → включить режим накопления
```

### 2. Accumulator (SQLite + таймер)

**Триггер:** Burst detection активировал накопление.

**Поведение:**
- Все ответы добавляются в accumulated_answers
- Таймер 5 сек сбрасывается при каждом новом ответе
- По истечении таймера → показать кнопки

**Кнопки:**
```
[Отправить все N шт.] [Отменить] [Показать список]
```

### 3. Offline Queue (SQLite)

**Триггер:** Сетевая ошибка (ECONNREFUSED, ETIMEDOUT, timeout).

**Обработка при восстановлении:**
1. Получить текущий уровень
2. Сравнить с levelId первого элемента очереди
3. Если изменился → pendingQueueDecision

---

## Обработка смены уровня

### При отправке ответа

```
sendAnswer(expectedLevelId)
    │
    ├── проверить текущий уровень ПЕРЕД отправкой
    │
    └── если levelId != expectedLevelId:
            → НЕ отправлять
            → создать pendingAnswerDecision = { answer, oldLevel, newLevel }
            → показать кнопки
```

**Кнопки:**
```
[Отправить в уровень {newLevel}] [Отменить]
```

### При обработке очереди

```
processQueue()
    │
    ├── getGameState() → текущий уровень
    │
    └── если levelId != queue[0].levelId:
            → остановить обработку
            → создать pendingQueueDecision = { queueSize, oldLevel, newLevel }
            → показать кнопки
```

**Кнопки:**
```
[Отправить {N} шт. в уровень {newLevel}] [Очистить очередь]
```

---

## Главное меню (reply keyboard)

```
┌─────────────┬──────────────────┐
│   Задание   │ Задание (формат) │
├─────────────┴──────────────────┤
│           Сектора              │
├─────────────┬──────────────────┤
│ 🔗 Сменить  │ 👤 Сменить       │
│    игру     │   авторизацию    │
├─────────────┴──────────────────┤
│        🔄 Рестарт бота         │
└────────────────────────────────┘
```

**Действия кнопок:**
- `Задание` → /task (текст + HTML)
- `Задание (формат)` → /task с форматированием для Telegram
- `Сектора` → показать секторы уровня
- `Сменить игру` → WAITING_GAME_URL
- `Сменить авторизацию` → WAITING_LOGIN (сброс login/password)
- `Рестарт бота` → полный сброс, INITIAL

---

## Callback data паттерны

### Answer decisions
```
answer_send_{levelNumber}    # Отправить в указанный уровень
answer_cancel                # Отменить отправку
```

### Queue decisions
```
queue_send                   # Отправить очередь в новый уровень
queue_clear                  # Очистить очередь
```

### Batch (accumulation)
```
batch_send_all               # Отправить все накопленные
batch_send_force             # Отправить принудительно (уровень изменился)
batch_cancel_all             # Отменить все
batch_show_list              # Показать список накопленных
```

### Admin
```
admin_back                   # Назад в главное меню
admin_users_{page}           # Список пользователей, страница N
admin_moderation             # Меню модерации
moderation_toggle            # Вкл/выкл модерацию
admin_whitelist_{page}       # Whitelist, страница N
whitelist_add                # Режим добавления в whitelist
whitelist_remove_{index}     # Удалить из whitelist
```

---

## Rate Limiting & Caching

**Rate Limit:** 1.2 сек между запросами к одному домену.

**Level Cache:** TTL 30 сек. Инвалидация при Event 16-22.

**Message Throttle:** 2 сек между обновлениями одного сообщения.

---

## Retry Logic

**Авторизация:**
```
delay = 2^retryCount * 1000мс
maxRetries = 3
```

**Очередь:**
```
failedAttempts++ при каждой ошибке
if failedAttempts >= 3 → удалить из очереди
```

---

## Шифрование паролей

**Алгоритм:** AES-256-GCM

**Формат:** `enc:v1:{base64_iv}:{base64_encrypted}:{base64_authTag}`

**Ключ:** Из `ENCRYPTION_KEY` (hex 64 символа / base64 / passphrase → SHA256)

---

## URL парсинг

**Поддерживаемые форматы:**
```
https://{domain}.en.cx/GameDetails.aspx?gid={gameId}
https://{domain}.en.cx/gameengines/encounter/play/{gameId}/
```

**Результат:** `{ domain: string, gameId: string }`
