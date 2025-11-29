# Правила разработки EN-Offline-Bot v2

---

## Архитектура

```
┌─────────────────────────────────────────────────────────────────────┐
│                              APP                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
│  │   index.ts  │  │  config.ts  │  │ bootstrap.ts│                  │
│  └─────────────┘  └─────────────┘  └─────────────┘                  │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────────┐
│                          HANDLERS                                    │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐   │
│  │     start/       │  │     answer/      │  │      admin/      │   │
│  │  command, flow   │  │ message, decision│  │ command, callbacks│  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘   │
│  ┌──────────────────┐  ┌──────────────────┐                         │
│  │      test/       │  │      reset/      │                         │
│  └──────────────────┘  └──────────────────┘                         │
└───────────┬─────────────────────┬─────────────────────┬─────────────┘
            │                     │                     │
            ▼                     ▼                     ▼
┌───────────────────────────────────────────────────────────────────┐
│                             CORE                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────┐ │
│  │    user/    │  │    auth/    │  │   queue/    │  │   game/   │ │
│  │ repository  │  │   service   │  │  offline    │  │  service  │ │
│  │ state-mach. │  │   mutex     │  │  accumul.   │  │  answer   │ │
│  │ access      │  │             │  │  manager    │  │  level    │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └───────────┘ │
└───────────┬─────────────────────────────────┬─────────────────────┘
            │                                 │
            ▼                                 ▼
┌───────────────────────────┐   ┌───────────────────────────────────┐
│        PLATFORMS          │   │            SERVICES               │
│  ┌─────────┐ ┌─────────┐  │   │  ┌───────────────────────────┐    │
│  │telegram/│ │   vk/   │  │   │  │       encounter/          │    │
│  │ adapter │ │ adapter │  │   │  │  client (HTTP, rate limit,│    │
│  └─────────┘ └─────────┘  │   │  │  cache, timeout, reauth)  │    │
│  ┌─────────────────────┐  │   │  └───────────────────────────┘    │
│  │      registry       │  │   │                                   │
│  └─────────────────────┘  │   │                                   │
└───────────────────────────┘   └───────────────────────────────────┘
            │                                 │
            ▼                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        INFRASTRUCTURE                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
│  │ database.ts │  │  crypto.ts  │  │  logger.ts  │                  │
│  │   SQLite    │  │ AES-256-GCM │  │    pino     │                  │
│  └─────────────┘  └─────────────┘  └─────────────┘                  │
└─────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           SHARED                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  utils.ts: parseGameUrl, sanitizeHtml, formatDuration, ...  │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

**Поток обработки ответа:**

```
User Message
     │
     ▼
┌─────────┐    ┌──────────┐    ┌─────────────┐    ┌───────────────┐
│Platform │───▶│ Handlers │───▶│QueueManager │───▶│  GameService  │
│ Adapter │    │messages.ts    │ burst detect│    │ submitAnswer  │
└─────────┘    └──────────┘    └─────────────┘    └───────┬───────┘
                                     │                    │
                          ┌──────────┴──────────┐         │
                          ▼                     ▼         ▼
                    ┌───────────┐        ┌───────────┐ ┌──────────┐
                    │Accumulator│        │OfflineQ.  │ │Encounter │
                    │(burst mode│        │(network   │ │  Client  │
                    │ 5s timer) │        │  error)   │ │  (HTTP)  │
                    └───────────┘        └───────────┘ └──────────┘
```

**Тип архитектуры:** Modular Layered Architecture

---

## Стек

| Технология | Версия |
|------------|--------|
| Node.js | 20 LTS |
| TypeScript | 5.3+ |
| pnpm | 8+ |
| better-sqlite3 | - |
| grammy | - |
| vk-io | - |
| zod | - |
| pino | - |
| vitest | - |

---

## Структура проекта

```
src/
├── app/
│   ├── index.ts          # Entry point
│   ├── config.ts         # Zod-валидированный конфиг
│   └── bootstrap.ts      # Инициализация и DI
│
├── core/
│   ├── user/
│   │   ├── repository.ts     # CRUD + шифрование пароля
│   │   ├── state-machine.ts  # FSM переходов
│   │   └── access.ts         # Whitelist
│   ├── auth/
│   │   └── service.ts        # Мьютекс + реавторизация
│   ├── queue/
│   │   ├── offline.ts        # Офлайн очередь (SQLite)
│   │   ├── accumulator.ts    # Буфер накопления
│   │   └── manager.ts        # Фасад: burst detection + routing
│   └── game/
│       └── service.ts        # Отправка ответов, level tracking
│
├── platforms/
│   ├── types.ts          # IPlatformAdapter интерфейс
│   ├── registry.ts       # Регистрация и запуск
│   ├── telegram/
│   │   └── adapter.ts
│   └── vk/
│       └── adapter.ts
│
├── handlers/
│   ├── start/            # /start + FSM flow
│   │   ├── index.ts
│   │   ├── command.ts
│   │   └── flow.ts
│   ├── answer/           # ответы + decisions
│   │   ├── index.ts
│   │   ├── message.ts
│   │   └── decisions.ts
│   ├── test/             # /test
│   ├── reset/            # /reset
│   └── admin/            # /admin + callbacks
│       ├── index.ts
│       ├── command.ts
│       └── callbacks.ts
│
├── services/
│   └── encounter/
│       ├── client.ts     # HTTP + rate limiting + level cache
│       └── events.ts     # Event коды
│
├── infrastructure/
│   ├── database.ts       # SQLite connection + migrations
│   ├── crypto.ts         # AES-256-GCM
│   └── logger.ts         # Pino
│
└── shared/
    └── utils.ts          # URL parser, HTML sanitizer, formatters
```

---

## Правила слоёв

| Слой | Может импортировать |
|------|---------------------|
| app/ | Всё |
| handlers/ | core/, services/, platforms/, shared/ |
| core/ | shared/ |
| services/ | shared/ |
| platforms/ | shared/ |
| infrastructure/ | shared/ |
| shared/ | Ничего |

**Импорт только через index.ts:**
```typescript
// Правильно
import { UserRepository } from '@/core/user';

// Запрещено (ESLint error)
import { UserRepository } from '@/core/user/repository';
```

---

## Barrel exports

Каждый модуль экспортирует публичный API через `index.ts`:

```
src/core/user/
├── index.ts         # export { UserRepository, transition, type User }
├── repository.ts    # internal
└── state-machine.ts # internal
```

ESLint правило:
```javascript
'no-restricted-imports': ['error', {
  patterns: [
    { group: ['@/core/*/**'], message: 'Import from @/core/* only' },
    { group: ['@/services/*/**'], message: 'Import from @/services/* only' },
    { group: ['@/platforms/*/**'], message: 'Import from @/platforms/* only' }
  ]
}]
```

---

## Конфигурация (.env)

**Обязательные:**
```
BOT_TOKEN=              # Telegram bot token
ENCRYPTION_KEY=         # 64 hex символа
```

**Опциональные:**
```
VK_GROUP_TOKEN=         # VK community token
VK_GROUP_ID=            # VK community ID (number)
DATA_FILE=./data/bot.db # путь к SQLite (v1: user_data.json)
LOG_LEVEL=info
ADMIN_IDS=              # telegram:123,vk:456 (новое в v2)
```

---

## Интерфейс платформы

```typescript
interface IPlatformAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(userId: string, text: string, keyboard?: Keyboard): Promise<string>;
  editMessage(userId: string, messageId: string, text: string, keyboard?: Keyboard): Promise<void>;
  deleteMessage(userId: string, messageId: string): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  onEvent(handler: (event: PlatformEvent) => Promise<void>): void;
}

type Keyboard = {
  inline?: Array<Array<{ label: string; action: string }>>;
  reply?: string[][];
  remove?: boolean;
};

type PlatformEvent =
  | {
      type: 'command';
      platform: string;
      userId: string;
      command: string;           // "start", "test", "admin"
      messageId: string;
    }
  | {
      type: 'message';
      platform: string;
      userId: string;
      text: string;
      messageId: string;
    }
  | {
      type: 'callback';
      platform: string;
      userId: string;
      data: string;              // "batch_send_all", "admin_users_0"
      callbackId: string;
      messageId: string;
    };
```

---

## VK ограничения

При ошибках 911/912 (клавиатура не поддерживается):
→ Автоматически переотправить сообщение БЕЗ клавиатуры

```typescript
function isKeyboardUnsupportedError(error: unknown): boolean {
  const code = (error as any)?.code ?? (error as any)?.error_code;
  return code === 911 || code === 912;
}
```

---

## Типы

```typescript
// Result для операций которые могут упасть
type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// FSM состояния (status хранится в DB, остальное вычисляется)
type UserState =
  | { status: 'initial' }
  | { status: 'waiting_login' }
  | { status: 'waiting_password' }
  | { status: 'waiting_game_url' }
  | { status: 'ready' }
  | { status: 'waiting_decision'; decision: PendingDecision };

type PendingDecision =
  | { type: 'answer'; answer: string; oldLevel: number; newLevel: number }
  | { type: 'queue'; queueSize: number; oldLevel: number; newLevel: number }
  | { type: 'batch'; count: number; levelChanged: boolean; newLevel?: number };
```

---

## Принципы

**KISS:** Один класс/функция на модуль. Без factory, без абстракций "на будущее".

**YAGNI:** Реализовывать только то, что нужно сейчас. Без generic решений.

**DRY:** Повторяющийся код → функция в shared/utils.ts.

**SRP:** Каждый модуль — одна ответственность.

---

## Лимиты

| Элемент | Максимум |
|---------|----------|
| Файл | 300 строк |
| Функция | 50 строк |
| Строка | 100 символов |

---

## Правила кода

1. **Явные типы** для публичных функций
2. **Result<T,E>** вместо throw для бизнес-ошибок
3. **Zod** для валидации внешних данных
4. **pino** для логов, без console.log
5. **Тесты** для core/ модулей
6. **Таймауты** для всех внешних HTTP запросов
7. **Маскировать пароли** в логах

---

## Таймауты

Все HTTP запросы к внешним сервисам должны иметь таймаут:

```typescript
const TIMEOUT = 10_000; // 10 сек (как в v1)

async function fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
```

При таймауте → `Result.error({ type: 'timeout' })` → enqueue в офлайн очередь.

---

## Тесты

```
src/core/**/__tests__/*.test.ts  # Unit
src/__tests__/integration/       # Integration
```

Покрытие core/ >= 80%.

---

## Git

```
feat(scope): description
fix(scope): description
refactor(scope): description
```

---

## Checklist перед коммитом

- [ ] `pnpm build` — без ошибок
- [ ] `pnpm lint` — без ошибок
- [ ] `pnpm test` — проходят
- [ ] Нет `any`, `console.log`, `@ts-ignore`
