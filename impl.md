# Техническая реализация фаз

## Фаза 0 — техническая реализация

### Логирование (pino)

- Добавлен модуль `src/infra/logger.js` с настройкой `pino` и обёрткой, совместимой с прежним API `console.*`. Обёртка поддерживает автоматическую обработку `Error`, форматирование сообщений через `util.format` и dev-транспорт `pino-pretty`.
- Во всех модулях, где использовался `console`, подключён `logger` и выполнена замена вызовов (`index.js`, `encounter-api.js`, `src/core/*`, адаптеры платформ).
- После ревью упрощён пайплайн логера: функция нормализации сведена к минимальному набору веток, удалён неиспользуемый `logger.child`, сохранились уровни `trace`–`fatal`.

### Тестовое покрытие

- Подключён Jest (`jest`, `@types/jest`) и создан `jest.config.js` с node-окружением и сбором покрытия для основных модулей.
- Вынесена функция `parseGameUrl` в `src/utils/parse-game-url.js`, добавлены юнит-тесты `__tests__/parse-game-url.test.js`.
- Вынесены константы и логика окна накопления в `src/features/answer/burst-detector.js`, покрыто сценариями временных окон и порогов (`__tests__/burst-detector.test.js`).
- `answer-service` тестируется через новый хелпер `createAnswerServiceHarness` и обновлённый `FakeEncounterAPI`: юнит-тесты (`__tests__/answer-service.test.js`) закрывают обработку очереди, смену уровня, повторные ошибки, обновление cookies.
- Добавлена интеграционная связка (`__tests__/integration/answer-flow.test.js`), которая прогоняет реальные `ensureAuthenticated`/`createAuthCallback`: проверены сценарии авторизации при отправке ответа, автоматическая реавторизация в очереди и финальные сообщения.
- Разделён вспомогательный код по директории `__tests__/helpers/`, что упростило переиспользование фабрик в разных наборах тестов.
- Команда `npm test` прогоняет 4 набора (17 кейсов) и используется в качестве smoke-чека.

### ESLint + Prettier

- Установлены `eslint@8.57`, `eslint-plugin-jest`, `eslint-config-prettier`, `eslint-plugin-prettier`, `prettier`.
- `.eslintrc.js`: окружения node/jest, ECMA 2022, отлючены шумные правила (`no-inner-declarations`, `no-prototype-builtins`), `no-unused-vars` переведён в soft-режим, добавлены метрики `max-lines-per-function` и `complexity` как предупреждения. Из `.eslintignore` исключены `index.js`, `encounter-api.js` и другие критичные файлы — линтер теперь прогоняется по всей кодовой базе.
- Добавлен `.prettierignore` для служебных директорий и тяжёлых артефактов.
- Скрипты `package.json`: `lint`, `format`, `format:all`. Последний выполняет `prettier --write` по всему проекту; прогон выполнен, что унифицировало форматирование JS/JSON/MD файлов.

### Production-подобный датасет

- Сгенерирован `__tests__/fixtures/user_data_large.json` (150 пользователей): очереди по 5–15 ответов, буферы накопления, pending-решения, pendingBurst, разнотипные временные метки, смешение Telegram/VK. Датасет регулярно пересобирается скриптом `scripts/generate-user-fixture.js`.

### Целевая структура директорий

- Создан `docs/target-structure.md` с деревом каталогов и планом заполнения по фазам (infra/core/presentation/platforms). Документ служит эталоном при декомпозиции на следующих этапах.

### Дополнительно

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

## Фаза 2.1 — декомпозиция sendAnswerToEncounter

- Создан вспомогательный модуль `src/features/answer/answer-helpers.js`, где реализованы функции `checkPendingDecisions`, `detectLevelChange`, `retryWithBackoff`, `updateProgressMessage` и `handleCookieUpdate`. Каждая принимает необходимые зависимости через параметры и не тянет глобальные состояния.
- `sendAnswerToEncounter` переписан с использованием новых хелперов: проверка pending-решений, обработка накоплений, формирование сообщений об успехе и ошибках теперь делегируются специализированным функциям. Логика повторных попыток стала плоской (без локальной рекурсии) и возвращает результат через `retryWithBackoff`.
- Логика обновления cookie вынесена из `sendToEncounterAPI` в `handleCookieUpdate`, что упростило тестирование и убрало дублирование.
- Для унифицированного обновления пользовательских сообщений внедрён `updateProgressMessage`, который прозрачно решает, создавать новое сообщение или редактировать существующее.
- Добавлены unit-тесты `__tests__/answer-service-helpers.test.js`, покрывающие все выделенные функции (ветки блокировки, смены уровня, успешного/неуспешного бэкоффа, обновления cookie).
- Актуализированы существующие тесты `__tests__/answer-service.test.js` и `__tests__/integration/answer-flow.test.js`, чтобы они проверяли финальные вызовы через `mock.calls.at(-1)` — это отражает появление промежуточных прогресс-сообщений.
- Проверки `npm run lint` (ожидаемые предупреждения по сложности крупных модулей) и `npm test` (27 сценариев) завершены успешно.

## Фаза 2.2 — answer-delivery (часть 1)

- Вынесена доменная логика отправки ответов в модуль `src/features/answer/answer-delivery.js`. Он инкапсулирует обработку накоплений, повторные попытки, реакции на смену уровня и сетевые ошибки, предоставляя API `sendAnswerToEncounter`, `handleAccumulationComplete`, `sendToEncounterAPI`.
- Определён контракт зависимостей/возвращаемых методов в `src/features/answer/contracts.js`, что описывает требования к userStore/messenger и упрощает дальнейшее реиспользование.
- Вынесена обработка офлайн-очереди в `src/processes/queue/queue-processor.js`: проверка актуальности уровня, прогресс-уведомления, retry-политики и финальное резюме теперь живут в процессе, а не в корневом сервисе.
- `createAnswerService` теперь служит оркестратором: подключает `answer-delivery` и `queue-processor`, передавая им зависимости. Вызовы обновления уровня переведены на `updateLastKnownLevel` из хелперов.
- Логика burst-накопления перенесена в `src/features/answer/batch-buffer.js`, сам детектор — в `src/features/answer/burst-detector.js`; обновлены router и тесты для работы с новыми путями.
- Все тесты (`npm test`) прогнаны на обновлённой архитектуре — 29 сценариев проходят без регрессий.

## Фаза 2.3 — упрощение answer-delivery и queue-processor

- `answer-delivery` декомпозирован: отправка в Encounter, накопление кодов, обработка успеха/ошибок вынесены в отдельные функции. Основной процесс — лёгкая композиция из подготовленных шагов.
- `queue-processor` поделён на этапы (проверка уровня, инициализация прогресса, обработка элемента, финализация). Повторяемые шаги вынесены в вспомогательные утилиты (`initializeProcessing`, `handleQueueItem`, `buildFinalMessage`).
- Линтер больше не сигналит об избыточной длине/сложности для этих функций; предупреждения остались только для исторически крупных модулей (router, encounter-api), что зафиксировано в плане.
- Добавлен модульный тест `__tests__/queue-processor.test.js`, покрывающий смену уровня перед обработкой и успешный сценарий очереди.

## Фаза 3 — миграция на SQLite (dual write стадия)

- Добавлен инфраструктурный слой `src/infra/database/sqlite.js`, использующий `sql.js`. Реализован загрузчик wasm, вспомогательные обёртки `run/get/all`, транзакции и применение миграций. Первая миграция `001_init.sql` создаёт `profiles`, `game_sessions`, `runtime_state`, фиксирует индексы и таблицу `schema_version`.
- Создан `UserRepository` (`src/entities/user/repository/user-repository.js`): поддерживаются операции чтения/записи профилей, игровых сессий и runtime-состояний, обновление cookies, очистка старых timestamp'ов и удаление неактивных записей. Все записи проходят через транзакции, массивы валидируются и урезаются до 100 элементов.
- `user-store` научился работать в dual-read/dual-write режиме: при старте пытается загрузиться из SQLite (с откатом к JSON), синхронизирует изменения обратно через `persistToRepository`, а `saveUserData` теперь обновляет БД и очищает JSON от эфемерных полей.
- `bootstrap` инициализирует SQLite, передаёт репозиторий в `user-store`, запускает фоновые процессы `runtime-maintenance` (очистка старых timestamp'ов и неактивных runtime-state) и `metrics-reporter` (агрегированные показатели по пользователям/очередям) и закрывает БД в graceful shutdown.
- Добавлен сценарий миграции `scripts/migrate-json-to-sqlite.js`: создаёт резервный JSON, переносит данные, выводит сводку по профилям/сессиям/runtime.
- Поддержаны режимы хранения: `STORAGE_MODE` (`dual`/`sqlite`/`json`) и `STORAGE_READ_MODE` (позволяет переключать порядок загрузки). При `STORAGE_MODE=sqlite` JSON перестаёт записываться, но доступен для отката.
- Добавлен экспорт `scripts/export-sqlite-to-json.js` (`npm run export:json`) для обратного преобразования SQLite → JSON и обновлены инструкции (`docs/deployment.md`, `docs/testing.md`) по бэкапам и rollback. Для финального выключения JSON предусмотрен скрипт `npm run archive:json`, перемещающий `user_data.json` в `backups/`.
- Создан бенчмарк `scripts/perf-user-repository.js` (`npm run test:perf`), который на временной БД прогоняет 500 профилей, 1000 смешанных операций и конкурентные обновления (50×20). Итоговые показатели: засев ≈1.61 c (310 оп/с), цикл из 1000 операций ≈0.88 c (≈1137 оп/с), конкурентный блок ≈1.30 c. Скрипт удаляет временные артефакты и использует общий логгер.
- Актуализированы `docs/target-structure.md` и `plan.md` (отмечены выполненные подпункты Фазы 3, добавлено описание новых директорий).

## Фаза 4 — Encounter API (часть 1)

- Добавлен модуль `src/core/encounter-errors.js` с иерархией `EncounterError` → `AuthRequiredError`, `NetworkError`, `LevelChangedError`, `RateLimitError`, отражающих причины и retry-политику.
  - Начата переработка `encounter-api.js`: метод `authenticate` использует `_normalizeAuthResponse/_normalizeAuthError`, сохраняет HTML-блокировки через `_saveErrorHtml` и возвращает унифицированные коды ошибок вместо ручной обработки. Добавлены Jest-тесты `__tests__/encounter-api-auth.test.js`, проверяющие сценарии IP_BLOCKED и HTML-ошибок.
  - Добавлен вспомогательный `_log` с маскированием логина и базовым контекстом (domain/gameId). `authenticate`, `getGameState`, `sendAnswer` и сценарии реаутентизации перешли на структурированные логи pino (`info|warn|error`) и теперь пишут идентификаторы уровня, события и retry-флаги.
  - `_normalizeNetworkError` расширен: общий маппинг HTTP/сетевых кодов применяется во всех публичных методах Encounter API (`getGameState`, `sendAnswer`, `getGameInfo`, `getGamesList`, `checkConnection`), а логи фиксируют payload-сниппеты и retry-политику.
  - Снижен технический долг Encounter API: `getGameState` и `sendAnswer` декомпозированы на хелперы (`_loadLevelContext`, `_ensureLevelCurrentBeforeSend`, `_interpretAnswerResponse` и др.), повторная авторизация вынесена в `_performReauthentication`, а рискованные ветки покрыты модульным тестом `__tests__/encounter-api-network.test.js` (HTTP 429 → `RateLimitError`, `ETIMEDOUT` → `NetworkError`).
  - `src/core/user-store.js` разбит на небольшие функции: добавлены хелперы загрузки профилей/сессий, нормализации JSON (`normalizeUserFromJson`, `resolveUserIdentity`, `normalizeRuntimeFlags` и др.), что снизило сложность `loadUsersFromRepository`, `persistToRepository` и упростило миграции пользовательских данных.
  - Следующий целевой блок техдолга — `src/features/router.js`: требуется вынести обработчики callback'ов (`handleCallback`, `processBatchSend`, `handleReadyStateInput`, `sendLevelTask`, `buildTaskMessage`) в специализированные модули. План: выделить хелперы (`handleQueueCallback`, `handleAnswerConfirmationCallback`, `handleBatchCallback`, `handleAdminCallback`) и общий контекст, после чего перераспределить presentation-логику в отдельный слой.
- Логирование Encounter API улучшено: ошибки теперь пишутся через структурированный логгер с объектами `{ error, gameId }`, сохранение HTML ошибок возвращено к исходной семантике.
- `answer-delivery` обновлён для работы с типизированными ошибками (`LevelChangedError`, `AuthRequiredError`, `NetworkError`), классификация ошибок вынесена в отдельную функцию и использует instanceof вместо строковых сравнений.

## Фаза 5 — presentation-слой

- Создан модуль `src/presentation/keyboard-factory.js` с фабриками `createInlineKeyboard` и `createReplyKeyboard`. Фабрика нормализует описание кнопок (label/action/payload) и возвращает готовые опции (`reply_markup` для Telegram и `keyboard` для VK), что позволило убрать десятки `if (platform === 'telegram')` в `answer-delivery`, `queue-processor`, `answer-helpers` и `router`. Дублирующая логика клавиатур в VK адаптере устранена: он теперь получает унифицированную структуру и только преобразует её в `Keyboard.builder()`.
- Добавлен `src/presentation/message-formatter.js`, собравший форматирование сообщений: `formatTaskMessage`, `formatSectorsMessage`, `formatBatchProgress`, а также вспомогательные хелперы (`collectTaskFragments`, `collectHelps`, `splitMessageBody`, `formatStatusText`). Внутри модуля размещены утилиты очистки/экранирования HTML и форматирования таймеров.
- `src/features/router.js` разгружен: вынесены presentation-функции, batch-процесс теперь опирается на `formatBatchProgress/formatStatusText`, а обработчик заданий работает через `formatTaskMessage`. Файл потерял 350+ строк вспомогательного форматирующего кода, упростились блоки `handleSendBuffer` и `handleSendTask`.
- Админские сценарии (`showUsersList`, `showModerationMenu`, `showWhitelistMenu`) переведены на фабрику клавиатур, что устранило ручное построение `reply_markup` и сокращает риск расхождений при изменениях UI.
- Обновлены `plan.md` (закрыты чекбоксы фазы 5 и техдолга по router/vk-keyboard) и `impl.md` текущим описанием, чтобы рефлексировать состояние рефакторинга.
