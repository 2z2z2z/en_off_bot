# Deployment Guide

Этот проект можно запускать локально, через Docker или под управлением PM2 на VPS. Ниже приведены минимально необходимые шаги для каждого сценария и подсказки по обновлениям.

## Требования

- Node.js 18+
- npm 9+
- Для Docker: Docker Engine 23+ и Docker Compose v2+
- Для продакшн-развёртывания задайте `ENCRYPTION_KEY` (используется для шифрования паролей Encounter)

## Локальная разработка

```bash
git clone https://github.com/your-org/en-offline-bot.git
cd en-offline-bot
cp config.env.example .env
npm install
npm start
```

Основные переменные в `.env`:

| Переменная                    | Назначение                                                         | Обязательна |
| ----------------------------- | ------------------------------------------------------------------ | ----------- |
| `BOT_TOKEN`                   | Telegram bot token                                                 | да          |
| `ENCRYPTION_KEY`              | Ключ для AES-256-GCM                                               | да          |
| `VK_GROUP_TOKEN`              | Токен сообщества ВК                                                | нет         |
| `VK_GROUP_ID`                 | Числовой ID группы ВК                                              | нет         |
| `LOG_LEVEL`                   | Варианты: `info`, `debug`, `error`                                 | нет         |
| `SQLITE_DB_PATH`              | Путь к SQLite-базе (по умолчанию `bot_data.sqlite`)                | нет         |
| `STORAGE_MODE`                | `dual` (по умолчанию), `sqlite` или `json` — какие хранилища писать | нет         |
| `STORAGE_READ_MODE`           | `sqlite` (по умолчанию) или `json` — приоритет загрузки данных     | нет         |
| `RUNTIME_MAINTENANCE_INTERVAL_HOURS` | Период очистки runtime-state (дефолт 6 часов)                  | нет         |
| `RUNTIME_STATE_TTL_HOURS`     | TTL для временных отметок (дефолт 24 часа)                         | нет         |
| `METRICS_INTERVAL_MINUTES`    | Частота логирования метрик (дефолт 5 минут)                        | нет         |

Файлы данных:

- `user_data.json` — состояние пользователей (шифрованные пароли, очереди и т.д.)
- `admin_config.json` — whitelist и административные настройки

## Docker

1. Создайте `.env` рядом с `docker-compose.yml`.
2. Запустите контейнер:
   ```bash
   docker-compose up -d --build
   ```

Важные детали:

- Том `bot_data` монтируется в `/app/data`, куда пишет `user_data.json`.
- `admin_config.json` остаётся в `/app`; Dockerfile выдаёт права пользователю `botuser`, поэтому файл можно редактировать в рантайме (например через `docker exec -it en_offline_bot sh`).
- Healthcheck выполняет `node -e "console.log('Bot is running')"` каждые 30 секунд.

Команды управления:

```bash
docker-compose logs -f            # просмотр логов
docker-compose restart            # мягкий перезапуск
docker-compose down               # остановка
docker-compose up -d --build      # обновление после изменений
```

## PM2 / VPS

```bash
ssh user@server
sudo apt update && sudo apt install -y nodejs npm git
git clone https://github.com/your-org/en-offline-bot.git
cd en-offline-bot
cp config.env.example .env   # заполните переменные
npm install
sudo npm install -g pm2
pm2 start index.js --name en-offline-bot
pm2 save
pm2 startup                  # включить автозапуск
```

Быстрые команды PM2:

```bash
pm2 status
pm2 logs en-offline-bot --lines 100
pm2 restart en-offline-bot
pm2 stop en-offline-bot
```

## Обновления и откаты

1. Обновите код (`git pull` или поставьте новый образ).
2. При необходимости синхронизируйте данные: `npm run migrate:sqlite` создаёт резервную копию JSON и переносит профили в SQLite.
3. Пересоберите/перезапустите:
   - Docker: `docker-compose up -d --build`
   - PM2: `pm2 restart en-offline-bot`
4. Проверьте логи (Telegram и VK адаптеры выводят статус старта).

### Хранилище и режимы записи

- По умолчанию используется dual-write (`STORAGE_MODE=dual`), т.е. записи выполняются и в JSON, и в SQLite.
- После обкатки можно перейти на `STORAGE_MODE=sqlite`, чтобы отключить запись в `user_data.json` (файл остаётся только для отката).
- Для финализации выполните `npm run archive:json` (перемещает `user_data.json` в `backups/…`) и выставьте `STORAGE_MODE=sqlite` — JSON больше не будет изменяться.
- Для полного возврата к JSON установите `STORAGE_MODE=json` и `STORAGE_READ_MODE=json`, затем при необходимости восстановите файл из `backups/`.
- Экспорт из SQLite обратно в JSON: `npm run export:json ./user_data.rollback.json`.
- Регулярно копируйте файл базы (`SQLITE_DB_PATH`, по умолчанию `bot_data.sqlite`) перед крупными обновлениями.

Для отката вернитесь на предыдущий commit, выполните `npm run export:json`, замените `user_data.json` и перезапустите бота.

## Мониторинг и диагностика

- Журналы находятся в `log.log`/`log2.log` (ротация по месту вызова). Для Docker удобнее читать `docker-compose logs`.
- Для API Encounter бот логирует все сетевые ошибки и предупреждает о блокировках.
- На SIGINT/SIGTERM выполняется `saveUserData()`, поэтому корректно завершайте процессы (`pm2 stop`, `docker-compose down`, `Ctrl+C`).
- Модуль метрик (`METRICS_INTERVAL_MINUTES`, дефолт 5 мин) логирует агрегированную статистику: количество пользователей, объём очередей/накоплений и активные процессы.
- Для стресс-тестов локально используйте `npm run test:perf` (временная БД, 500 профилей) перед выкатыванием крупных изменений.

## Частые проблемы

| Симптом                             | Решение                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Бот не отвечает                     | Проверьте токен в `.env`, убедитесь что аккаунт активен                   |
| Ошибка записи `admin_config.json`   | При собственных Dockerfile убедитесь, что выдаёте права `chown -R`        |
| Очередь не очищается после рестарта | Убедитесь, что кнопки «Рестарт» или `/start` были нажаты после обновления |
| Encounter блокирует запросы         | Не запускайте несколько экземпляров бота с одинаковыми кредами            |

## Полезные ссылки

- [README](../README.md) — обзор функциональности и UI
- [docs/testing.md](testing.md) — быстрый sanity-чек после выката
- [docs/platforms.md](platforms.md) — особенности поведения Telegram и VK адаптеров
