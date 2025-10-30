# Архитектурная схема (FSD-ориентированное деление)

Документ фиксирует целевую структуру проекта в терминах Feature-Sliced Design, адаптированную для бота. Используется как ориентир при миграции и ревью кода.

```
src/
├── app/                 # Точка входа, bootstrap, DI, конфиги окружения
│   ├── index.js         # Главный entry-point приложения (сборка зависимостей, запуск)
│   ├── bootstrap/       # Загрузка env, данных, graceful shutdown
│   └── providers/       # Регистрация платформ, сервисов, DI-контейнер
├── processes/           # Сквозные процессы (например, офлайн-очередь)
│   └── queue/           # (план) управление обработкой очередей
├── features/            # Пользовательские сценарии (flows)
│   ├── router.js        # Общий event-router (команды, тексты, callback'и)
│   ├── answer/…         # (план) сценарии отправки ответов, буфера и очередей
│   ├── admin/…          # (план) админ-панель, whitelist, модерация
│   └── auth/…           # (план) авторизация Encounter, смена игры
├── entities/            # Доменные сущности, хранят данные и правила
│   ├── user/
│   │   ├── repository/  # user-store с миграцией на БД
│   │   └── model.js     # Предварительно: структура профиля/состояния
│   └── encounter/       # API и модель игры
├── shared/              # Общие инструменты без знания домена
│   ├── infra/           # logger, http-клиенты, crypto
│   ├── lib/             # Утилиты (parseGameUrl и пр.)
│   └── config/          # Константы, схемы конфигураций
└── platforms/           # Адаптеры Telegram/VK (presentation layer)
    ├── telegram/
    └── vk/
```

## Ключевые принципы
- **app/** не содержит бизнес-логики: только сборка зависимостей и запуск.
- **features/** оперирует сценариями (команды, callback-и). Использует сущности и shared.
- **entities/** инкапсулируют состояние и доменные операции (user, encounter).
- **processes/** собирают длительные сценарии (например, офлайн-очередь), переиспользуя несколько features.
- **shared/** — чистые утилиты, инфраструктура, конфиги.
- **platforms/** — presentation-уровень: адаптеры Telegram/VK, нормализация событий.

## Маппинг текущего кода

| Текущее положение                          | Целевой слой/папка                       |
|-------------------------------------------|------------------------------------------|
| `index.js`                                | `src/app/index.js`, `src/app/bootstrap/`, `src/features/*` |
| `src/core/user-store.js`                  | `src/entities/user/repository/`          |
| `src/core/answer-service.js`              | `src/features/answer/*`, частично `processes/queue` |
| `src/core/auth-manager.js`                | `src/features/auth/`                     |
| `encounter-api.js`                        | `src/entities/encounter/` + shared HTTP  |
| `src/core/messenger.js`                   | `src/app/providers/messenger`            |
| `docs/target-structure.md` (структура)    | Синхронизировать с данным документом     |

## Текущее состояние (после Фазы 1)
- `src/app/bootstrap/` загружает окружение, пользовательские данные и admin-config, управляет graceful shutdown.
- `src/app/providers/bot-engine.js` отвечает за запуск адаптеров и регистрацию транспортов.
- Основной event-router (`src/features/router.js`) агрегирует обработчики команд/текстов/callback'ов. Последующее дробление по фичам (`features/answer`, `features/admin`, `features/auth`) выполняется в следующих фазах.
- Корневой `index.js` делегирует запуск `src/app/index.js`, который собирает зависимости и инициализирует `answer-service`.

## Следующие шаги миграции
1. Разделить текущий `features/router.js` на отдельные фичи (`answer`, `admin`, `auth`), используя единый event router как композицию.
2. Переместить бизнес-логику из `src/core/answer-service.js` и `src/core/user-store.js` в `features/answer` и `entities/user`.
3. Вынести долгоживущие процессы (офлайн-очередь, накопление пачек) в `src/processes`.
4. Постепенно переводить вспомогательные утилиты в `shared/infra` и `shared/lib`, чтобы eliminate прямые require между слоями.

Документ обновляется при изменении архитектурных решений, чтобы служить актуальным справочником.
