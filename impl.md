# Фаза 0 — техническая реализация

## Логирование (pino)

- Добавлен модуль `src/infra/logger.js` с настройкой `pino` и обёрткой, совместимой с прежним API `console.*`. Обёртка поддерживает автоматическую обработку `Error`, форматирование сообщений через `util.format` и dev-транспорт `pino-pretty`.
- Во всех модулях, где использовался `console`, подключён `logger` и выполнена замена вызовов (`index.js`, `encounter-api.js`, `src/core/*`, адаптеры платформ).
- После ревью упрощён пайплайн логера: функция нормализации сведена к минимальному набору веток, удалён неиспользуемый `logger.child`, сохранились уровни `trace`–`fatal`.

## Тестовое покрытие

- Подключён Jest (`jest`, `@types/jest`) и создан `jest.config.js` с node-окружением и сбором покрытия для основных модулей.
- Вынесена функция `parseGameUrl` в `src/utils/parse-game-url.js`, добавлены юнит-тесты `__tests__/parse-game-url.test.js`.
- Вынесены константы и логика окна накопления в `src/core/burst-detector.js`, покрыто сценариями временных окон и порогов (`__tests__/burst-detector.test.js`).
- `answer-service` тестируется через новый хелпер `createAnswerServiceHarness` и обновлённый `FakeEncounterAPI`: юнит-тесты (`__tests__/answer-service.test.js`) закрывают обработку очереди, смену уровня, повторные ошибки, обновление cookies.
- Добавлена интеграционная связка (`__tests__/integration/answer-flow.test.js`), которая прогоняет реальные `ensureAuthenticated`/`createAuthCallback`: проверены сценарии авторизации при отправке ответа, автоматическая реавторизация в очереди и финальные сообщения.
- Разделён вспомогательный код по директории `__tests__/helpers/`, что упростило переиспользование фабрик в разных наборах тестов.
- Команда `npm test` прогоняет 4 набора (17 кейсов) и используется в качестве smoke-чека.

## ESLint + Prettier

- Установлены `eslint@8.57`, `eslint-plugin-jest`, `eslint-config-prettier`, `eslint-plugin-prettier`, `prettier`.
- `.eslintrc.js`: окружения node/jest, ECMA 2022, отлючены шумные правила (`no-inner-declarations`, `no-prototype-builtins`), `no-unused-vars` переведён в soft-режим, добавлены метрики `max-lines-per-function` и `complexity` как предупреждения. Из `.eslintignore` исключены `index.js`, `encounter-api.js` и другие критичные файлы — линтер теперь прогоняется по всей кодовой базе.
- Добавлен `.prettierignore` для служебных директорий и тяжёлых артефактов.
- Скрипты `package.json`: `lint`, `format`, `format:all`. Последний выполняет `prettier --write` по всему проекту; прогон выполнен, что унифицировало форматирование JS/JSON/MD файлов.

## Production-подобный датасет

- Сгенерирован `__tests__/fixtures/user_data_large.json` (150 пользователей): очереди по 5–15 ответов, буферы накопления, pending-решения, pendingBurst, разнотипные временные метки, смешение Telegram/VK. Датасет регулярно пересобирается скриптом `scripts/generate-user-fixture.js`.

## Целевая структура директорий

- Создан `docs/target-structure.md` с деревом каталогов и планом заполнения по фазам (infra/core/presentation/platforms). Документ служит эталоном при декомпозиции на следующих этапах.

## Дополнительно

- В `plan.md` отмечены чекбоксы Фазы 0; после ревью дополнительно зафиксированы интеграционные тесты, полное форматирование и расширенный датасет.
- `package.json` дополнен скриптами `test`, `lint`, `format`, `format:all` и `scripts/generate-user-fixture.js` для воспроизводимой генерации данных.
- Проведён `npm run format:all`, затем `npm run lint` (предупреждения по метрикам) и `npm test` — прогон завершился успешно.

## Фаза 1 — архитектурная сетка и декомпозиция точки входа

- Зафиксирована целевая FSD-схема (`docs/architecture-scheme.md`), на её основе созданы каркасные директории `src/app`, `src/features`, `src/entities`, `src/processes`, `src/shared`.
- Реализован `src/app/bootstrap/index.js`: загрузка `.env`, пользовательских данных и admin-config, очистка устаревших VK-буферов, регистрация graceful shutdown.
- Добавлен `src/app/providers/bot-engine.js`, отвечающий за запуск адаптеров, регистрацию транспортов и подписку на события Telegram/VK.
- Создан сервис `src/services/admin-config.js` для работы с whitelist и кешом ролей.
- Весь прикладной поток (команды, callback, текст) перенесён в `src/features/router.js`; модуль экспортирует `registerTelegramHandlers`, `handleCommand`, `handleCallback`, `handleTextMessage`, а также предоставляет `setPlatformConfig`/`setAnswerServiceApi`.
- Корневой `index.js` теперь только вызывает `main` из `src/app/index.js`; сам `main` занимается сборкой зависимостей, запуском `bot-engine` и инициализацией `answer-service`.
- Проверки: `npm run lint` (ожидаемые предупреждения о сложности в крупных модулях) и `npm test` (17 сценариев) — успешно.
