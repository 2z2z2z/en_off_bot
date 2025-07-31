# 🚀 Создание GitHub репозитория en_off_bot

## 📝 Пошаговая инструкция

### 1. Создание репозитория на GitHub

1. Откройте [GitHub.com](https://github.com) и войдите в аккаунт
2. Нажмите **"New repository"** или перейдите по [прямой ссылке](https://github.com/new)
3. Заполните форму:
   - **Repository name**: `en_off_bot`
   - **Description**: `Telegram-бот для отправки ответов в игру Encounter с поддержкой offline режима`
   - **Visibility**: Public ✅ (рекомендуется) или Private
   - **Initialize with README**: ❌ НЕ ставьте галочку (у нас уже есть README)
   - **Add .gitignore**: ❌ НЕ выбирайте (у нас уже есть)
   - **Add license**: можете выбрать MIT

4. Нажмите **"Create repository"**

### 2. Загрузка проекта в репозиторий

После создания репозитория выполните команды в терминале:

```bash
# Инициализируем Git (если ещё не сделано)
git init

# Добавляем все файлы проекта
git add .

# Создаем первый коммит
git commit -m "🎉 Initial commit: EN Offline Bot v1.0

- ✅ Telegram bot для игры Encounter
- ✅ Поддержка offline режима
- ✅ Мультипользовательский бот
- ✅ Docker & PM2 поддержка
- ✅ Автоматическая переавторизация
- ✅ Готов для серверного развертывания"

# Подключаем удаленный репозиторий (замените YOUR_USERNAME на ваш логин GitHub)
git remote add origin https://github.com/YOUR_USERNAME/en_off_bot.git

# Отправляем код в GitHub
git branch -M main
git push -u origin main
```

### 3. Настройка репозитория

#### 🔐 Secrets для GitHub Actions

Если планируете использовать автоматическое развертывание:

1. Перейдите в **Settings** → **Secrets and variables** → **Actions**
2. Добавьте секреты:
   - `BOT_TOKEN` - ваш Telegram Bot Token
   - `DOCKERHUB_USERNAME` - логин Docker Hub (опционально)
   - `DOCKERHUB_TOKEN` - токен Docker Hub (опционально)

#### 📝 Настройка Description

В настройках репозитория добавьте:
- **Description**: `🤖 Telegram бот для Encounter с offline поддержкой`
- **Website**: ссылка на Encounter (опционально)
- **Topics**: `telegram-bot`, `encounter`, `nodejs`, `offline-support`

### 4. Защита main ветки (рекомендуется)

1. **Settings** → **Branches**
2. **Add rule** для ветки `main`:
   - ✅ Require pull request reviews
   - ✅ Require status checks to pass (если используете GitHub Actions)

### 5. Готовые команды для копирования

Замените `YOUR_USERNAME` на ваш логин GitHub:

```bash
git init
git add .
git commit -m "🎉 Initial commit: EN Offline Bot v1.0"
git remote add origin https://github.com/YOUR_USERNAME/en_off_bot.git
git branch -M main
git push -u origin main
```

## 🎯 Результат

После выполнения всех шагов у вас будет:

✅ Публичный GitHub репозиторий `en_off_bot`  
✅ Автоматические тесты через GitHub Actions  
✅ Готовность к клонированию на любой сервер  
✅ Docker поддержка из коробки  
✅ Документация по развертыванию  
✅ Безопасное хранение конфиденциальных данных

## 🔗 Полезные ссылки

- [GitHub Desktop](https://desktop.github.com/) - графический интерфейс для Git
- [Git командная строка](https://git-scm.com/downloads) - консольная версия Git  
- [Документация GitHub](https://docs.github.com/) - официальная документация