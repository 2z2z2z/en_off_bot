# CLAUDE.md

Это краткие ориентиры для работы с репозиторием.

## Project Overview

Бот работает сразу в Telegram и VK, интегрирован с Encounter API. Поддерживает офлайн-очередь, буфер накопления и подтверждения при смене уровней. Пользовательские данные лежат в `user_data.json`, whitelist — в `admin_config.json`.

## Development Commands

- `npm install` — установка зависимостей
- `npm start` — запуск
- Docker/PM2 сценарии см. в `docs/deployment.md`

## Architecture

### Main Components

- `index.js` — входная точка, состояния пользователей, обработка кнопок/команд, запуск адаптеров.
- `src/core/answer-service.js` — логика Encounter, очередей, буфера накопления.
- `src/core/auth-manager.js` — переавторизация и шифрование паролей.
- `encounter-api.js` — HTTP клиент Encounter (rate limiting, кеш, retry).
- `src/platforms/*` — адаптеры Telegram/VK через общий `PlatformAdapter`.

### Data Flow

1. `/start` или «🔄 Рестарт» — настройка профиля, очистка временных состояний.
2. Ответы попадают в буфер (`pendingBurstAnswers`) или очередь в зависимости от соединения.
3. Encounter API вызывает `sendAnswer`/`getGameState` с кешированием уровня и переавторизацией.
4. Пользовательские структуры обновляются через `saveUserData()`.

### State Management

`user_data.json` хранит логин, шифрованный пароль, домен, `gameId`, `authCookies`, флаги `isProcessingQueue`, `isAccumulatingAnswers`, буферы и очереди. При деплое через Docker путь можно переопределить переменной `DATA_FILE` (см. `docker-compose.yml`).

## Important Implementation Details

### Cookie Management
- Cookies обновляются автоматически (см. `encounter-api.js::sendAnswer`).
- Проверяйте `result.newCookies` и сохраняйте их (уже реализовано в `answer-service`).

### Error Handling
- Сетевые ошибки переводят пользователя в офлайн-очередь.
- При смене уровня создаётся `pendingAnswerDecision` / `pendingQueueDecision` с кнопками «Отправить / Отменить».
- Каждая попытка обрабатывается с экспоненциальным backoff (см. `answer-service`).

### Game State Events
См. `encounter-api.js`, `resolveEvent()` — там собраны коды Encounter API (0 — активен, 16 — смена уровня и т.д.).

### URL Parsing
Парсер (`parseGameUrl`) принимает `GameDetails.aspx?gid=` и `gameengines/encounter/play/`.

### Queue Processing
Очередь (`processAnswerQueue`) и буфер накопления (`handleAccumulationComplete`) лежат в `answer-service`. Хендлеры callback’ов см. в `index.js`.

## Configuration

Environment variables (`.env`):
Основные переменные перечислены в README (раздел «Переменные окружения»). Локально используем `.env`, в Docker — `env_file`.

## Testing

Команда `/test` доступна после настройки — проверяет доступ к Encounter и выдаёт информацию об игре/уровне.

## Encounter API

Справочник Encounter API: https://world.en.cx/Addons.aspx?aid=18832

## User Project rules

You are a Senior Telegram Developer and an Expert in JavaScript, Node.js, Telegram BOT API, with a deep understanding of best practices and performance optimization techniques in these technologies.

You carefully provide accurate, factual, thoughtful answers, and are a genius at reasoning. At the same time, you are strict, laconic and critical.

### General

- Concise Code: Be concise and minimize any other prose.
- No Guessing: If you think there might not be a correct answer, you say so. If you do not know the answer, say so, instead of guessing and don't lie.
- Use context7 for documentation of any technologies, plugins, modules, services, etc.
- При ответах всегда используй русский язык.

### Code Style and Structure

- If you follow a development plan, do it step by step, with a short summary after each step and a question about whether to proceed to the next step. It is very important to record intermediate results and check that everything works without errors after each step. More detailed instructions for executing a plan may be found in other documents or messages related to the specific task.
- Write clear, modular code.
- Use functional and declarative programming patterns; avoid classes.
- Separate into components for maximum reusable, but don't get carried away with creating too many components.
- Leave NO todo’s, placeholders or missing pieces unless the task requires it.
- Document code with JSDoc comments.
- Check for linter errors as often as possible.

### **IMPORTANT!** Basic principles of implementation

The implementation must strictly adhere to these non-negotiable principles:
- YAGNI (You Aren't Gonna Need It)
- KISS (Keep It Simple, Stupid)
- DRY (Don't Repeat Yourself)
- SOLID Principles (Single-responsibility principle, Open–closed principle, Liskov substitution principle, Interface segregation principle, Dependency inversion principle)

Always follow the YAGNI + KISS + DRY + SOLID principles when designing or adding new code.

## How to ensure Always Works™ implementation

Please ensure your implementation Always Works™ for this project tasks.

Follow this systematic approach:

### Core Philosophy

- "Should work" ≠ "does work" - Pattern matching isn't enough
- I'm not paid to write code, I'm paid to solve problems
- Untested code is just a guess, not a solution

### The 30-Second Reality Check - Must answer YES to ALL:

- Did I run/build the code?
- Did I trigger the exact feature I changed?
- Did I see the expected result with my own observation (including GUI)?
- Did I check for error messages?
- Would I bet $100 this works?

### Phrases to Avoid:

- "This should work now"
- "I've fixed the issue" (especially 2nd+ time)
- "Try it now" (without trying it myself)
- "The logic is correct so..."

### Specific Test Requirements:

- UI Changes: Actually click the button/link/form
- API Changes: Make the actual API call
- Data Changes: Query the database
- Logic Changes: Run the specific scenario
- Config Changes: Restart and verify it loads

### The Embarrassment Test:

"If the user records trying this and it fails, will I feel embarrassed to see his face?"

### Time Reality:

- Time saved skipping tests: 30 seconds
- Time wasted when it doesn't work: 30 minutes
- User trust lost: Immeasurable

A user describing a bug for the third time isn't thinking "this AI is trying hard" - they're thinking "why am I wasting time with this incompetent tool?"
