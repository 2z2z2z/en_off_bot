# План реализации EN-Offline-Bot v2

---

## Фаза 0: Инициализация

- [ ] Создать проект: `pnpm init`, `git init`
- [ ] Настроить TypeScript: `tsconfig.json` (strict, ESM, paths alias)
- [ ] Настроить ESLint + Prettier + правило no-restricted-imports для границ модулей
- [ ] Настроить Vitest
- [ ] Создать структуру папок (см. 02-development-rules.md)
- [ ] Установить зависимости: `better-sqlite3 grammy vk-io zod pino dotenv`
- [ ] Создать `.env.example`
- [ ] Проверка: `pnpm build` работает

---

## Фаза 1: Infrastructure

### Database
- [ ] `src/infrastructure/database.ts`: SQLite connection, WAL mode
- [ ] SQL миграция: таблицы users, answer_queue, accumulated_answers, whitelist
- [ ] Функция `runMigrations()`

### Crypto
- [ ] `src/infrastructure/crypto.ts`: `encrypt()`, `decrypt()` — AES-256-GCM
- [ ] Тест: encrypt → decrypt = original

### Logger
- [ ] `src/infrastructure/logger.ts`: pino с pretty для dev

### Config
- [ ] `src/app/config.ts`: Zod схема, `loadConfig()` из .env

**Checkpoint:** DB создается, конфиг загружается.

---

## Фаза 2: Shared утилиты

- [ ] `src/shared/utils.ts`:
  - [ ] `parseGameUrl(url)` — извлечение domain + gameId
  - [ ] `sanitizeHtml(html)` — очистка для Telegram
  - [ ] `stripHtml(html)` — удаление тегов
  - [ ] `formatDuration(seconds)` — "5 мин 30 сек"
- [ ] Тесты для каждой функции

---

## Фаза 3: Platforms

### Types
- [ ] `src/platforms/types.ts`: интерфейс `IPlatformAdapter`, тип `PlatformEvent`

### Registry
- [ ] `src/platforms/registry.ts`: register, get, startAll, stopAll
- [ ] Runtime проверка адаптера при регистрации

### Telegram
- [ ] `src/platforms/telegram/adapter.ts`: реализация IPlatformAdapter на grammy
- [ ] Конвертация событий grammy → PlatformEvent

### VK
- [ ] `src/platforms/vk/adapter.ts`: реализация на vk-io
- [ ] Fallback для inline keyboard → текст с номерами

**Checkpoint:** Адаптеры отправляют сообщения.

---

## Фаза 4: User

### Repository
- [ ] `src/core/user/repository.ts`: findById, findByPlatformId, create, update, delete
- [ ] Автошифрование пароля при save
- [ ] `src/core/user/index.ts`: barrel export (только публичный API)
- [ ] Тесты CRUD

### State Machine
- [ ] `src/core/user/state-machine.ts`: transition(user, action) → newState
- [ ] Валидация переходов
- [ ] Тесты всех переходов

### Access Control
- [ ] `src/core/user/access.ts`: isWhitelisted, addToWhitelist, removeFromWhitelist
- [ ] isModerationEnabled()

---

## Фаза 5: Auth

- [ ] `src/core/auth/service.ts`:
  - [ ] Мьютекс: isAuthenticating + authPromise
  - [ ] `authenticate(login, password, domain)`
  - [ ] `waitForAuth(userId)` — ждет если уже авторизуется
- [ ] `src/core/auth/index.ts`: barrel export
- [ ] Тесты: параллельные запросы ждут один результат

---

## Фаза 6: Encounter API

### Events
- [ ] `src/services/encounter/events.ts`: enum EventCode, `isLevelChanged()`, `isAuthRequired()`

### Client
- [ ] `src/services/encounter/client.ts`:
  - [ ] Timeout 10 сек для всех запросов (AbortController)
  - [ ] Rate limiting: 1.2 сек между запросами на домен
  - [ ] Level cache: TTL 30 сек
  - [ ] `authenticate()`, `getGameState()`, `sendAnswer()`, `getGameInfo()`
  - [ ] Авто-реаутентификация при 401
  - [ ] Защита от смены уровня через expectedLevelId
- [ ] `src/services/encounter/index.ts`: barrel export
- [ ] Тесты: timeout, rate limiting, level change detection

---

## Фаза 7: Queue System

### Offline Queue
- [ ] `src/core/queue/offline.ts`: enqueue, dequeue, peek, clear (SQLite)
- [ ] failedAttempts tracking

### Accumulator
- [ ] `src/core/queue/accumulator.ts`: startAccumulation, addAnswer, complete, cancel
- [ ] Таймер тишины 5 сек → автозавершение

### Queue Manager
- [ ] `src/core/queue/manager.ts`: фасад
  - [ ] Burst detection: 3+ сообщений за 10 сек, интервал < 2.5 сек
  - [ ] `handleNewAnswer()` → { action: 'send' | 'accumulate' | 'queue' }
- [ ] `src/core/queue/index.ts`: barrel export
- [ ] Тесты burst detection

---

## Фаза 8: Game Service

- [ ] `src/core/game/service.ts`:
  - [ ] `submitAnswer(userId, answer)` — отправка через EncounterClient
  - [ ] Level tracking: сохранение lastKnownLevel
  - [ ] При смене уровня → pendingDecision
  - [ ] При сетевой ошибке/timeout → enqueue
  - [ ] `processQueue(userId)` — обработка офлайн очереди
  - [ ] `handleAccumulationComplete(userId)` — отправка накопленных
- [ ] `src/core/game/index.ts`: barrel export
- [ ] Тесты: успех, смена уровня, сетевая ошибка, timeout

---

## Фаза 9: Handlers

### start/
- [ ] `src/handlers/start/command.ts`: /start — точка входа
- [ ] `src/handlers/start/flow.ts`: FSM логика (логин → пароль → URL)
- [ ] `src/handlers/start/index.ts`: barrel export

### answer/
- [ ] `src/handlers/answer/message.ts`: обработка текста в ready state
- [ ] `src/handlers/answer/decisions.ts`: callbacks queue_send, queue_clear, answer_send_N, batch_*
- [ ] `src/handlers/answer/index.ts`: barrel export

### test/
- [ ] `src/handlers/test/command.ts`: /test — проверка подключения
- [ ] `src/handlers/test/index.ts`: barrel export

### reset/
- [ ] `src/handlers/reset/command.ts`: /reset — сброс настроек
- [ ] `src/handlers/reset/index.ts`: barrel export

### admin/
- [ ] `src/handlers/admin/command.ts`: /admin — меню
- [ ] `src/handlers/admin/callbacks.ts`: модерация, whitelist, список пользователей
- [ ] `src/handlers/admin/index.ts`: barrel export

---

## Фаза 10: Bootstrap

- [ ] `src/app/bootstrap.ts`:
  1. loadConfig()
  2. initDatabase() + migrations
  3. Создать repositories и services
  4. Создать adapters
  5. Подключить handlers к adapters
  6. registry.startAll()

- [ ] `src/app/index.ts`: main() + graceful shutdown (SIGTERM, SIGINT)

**Checkpoint:** Бот запускается и отвечает на команды.

---

## Фаза 11: Testing

- [ ] Unit-тесты core/ — покрытие >= 80%
- [ ] Integration-тесты handlers/:
  - [ ] /start flow (новый пользователь)
  - [ ] Отправка ответа (успех, смена уровня, offline)
  - [ ] Burst → accumulation

---

## Фаза 11.5: CI

- [ ] `.github/workflows/ci.yml`: lint, test, build

---

## Фаза 12: Deploy

- [ ] Dockerfile (Node 20 Alpine)
- [ ] docker-compose.yml
- [ ] Скрипт миграции из v1: user_data.json → SQLite

---

## Порядок зависимостей

```
Фаза 0 → Фаза 1 → Фаза 2 → Фаза 3 → Фаза 4 → Фаза 5
                              ↓
                          Фаза 6 → Фаза 7 → Фаза 8
                              ↓
                          Фаза 9 → Фаза 10 → Фаза 11 → Фаза 12
```

---

## Критерии готовности

- [ ] Все команды из v1 работают
- [ ] Три системы очередей работают
- [ ] Смена уровня обрабатывается корректно
- [ ] Timeout обрабатывается → offline queue
- [ ] TypeScript без ошибок, ESLint чистый
- [ ] ESLint no-restricted-imports без нарушений
- [ ] Все модули имеют barrel exports (index.ts)
- [ ] Тесты core/ >= 80%
- [ ] Данные мигрированы из v1
