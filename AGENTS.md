# Repository Guidelines

При ответах и общении используй русский язык.

## Project Structure & Module Organization
`index.js` поднимает оба адаптера (Telegram и VK), управляет состояниями пользователей, офлайн-очередью и буфером накопления. Encounter API живёт в `encounter-api.js`. Данные пользователей (`user_data.json`) и whitelist (`admin_config.json`) лежат в корне проекта; путь к данным можно переопределить через `DATA_FILE`. Дополнительные описания поведения и деплоя смотри в `docs/`.

## Build, Test, and Development Commands
- `npm install` — установка зависимостей;
- `npm start` — запуск бота в текущем окружении;
- `npm ci` — чистая установка (используется в CI, нужна перед обновлением lock-файла);
- `node -c index.js` — быстрый синтаксический чек;
- `docker-compose up -d` — поднять контейнер;
- см. `docs/testing.md` для sanity-чека.

## Coding Style & Naming Conventions
Node 18+, отступ 2 пробела, одинарные кавычки. Экспорт через `module.exports`. Файлы — в kebab-case. Используем async/await, избегаем промис-цепочек. Все платформенные различия выносим в `src/platforms/*`.

## Testing Guidelines
Unit-тестов нет, поэтому проверяем сценарии вручную по `docs/testing.md`: настройка пользователя, работа буфера, обработка уровней, VK callbacks. Для критических изменений обязательно запускать и Telegram, и VK (если есть токен).

## Commit & Pull Request Guidelines
Сообщения в императиве ≤72 символов (`fix: handle burst queue`). В PR описываем: что сделано, как проверяли, и влияет ли на деплой. При изменениях доков обновляем README и файлы в `docs/`.

## Configuration & Deployment Tips
Секреты не коммитим. Минимальный набор переменных: `BOT_TOKEN`, `ENCRYPTION_KEY`. Для VK добавляем `VK_GROUP_TOKEN` и `VK_GROUP_ID`. В Docker том `bot_data` содержит пользовательские данные, а `admin_config.json` редактируем прямо в контейнере (права на `/app` уже выданы в Dockerfile). Подробности в `docs/deployment.md`.

## Key Engineering Principles
- YAGNI, KISS, DRY и SOLID — обязательны при добавлении логики.
- Пишем модульно и функционально, избегаем лишних классов.
- Не оставляем TODO/заглушек, изменения сопровождаем JSDoc по необходимости.
- Не гадаем: если нет факта или результата, честно сообщаем.
- Любая правка — только после самостоятельной проверки (см. “Always Works™” философию в `CLAUDE.md`).
