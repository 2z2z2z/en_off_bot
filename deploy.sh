#!/bin/bash

# Скрипт развертывания EN Offline Bot на удаленном сервере

echo "🚀 Начинаем развертывание EN Offline Bot..."

# Проверяем наличие Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js не найден! Устанавливаем..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Проверяем версию Node.js
NODE_VERSION=$(node -v)
echo "✅ Node.js версия: $NODE_VERSION"

# Проверяем наличие npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm не найден!"
    exit 1
fi

# Проверяем наличие PM2 для управления процессами
if ! command -v pm2 &> /dev/null; then
    echo "📦 Устанавливаем PM2..."
    sudo npm install -g pm2
fi

# Устанавливаем зависимости
echo "📦 Устанавливаем зависимости..."
npm install

# Проверяем наличие .env файла
if [ ! -f .env ]; then
    echo "⚠️  Файл .env не найден!"
    echo "📝 Создайте файл .env на основе config.env.example"
    echo "💡 Пример команды: cp config.env.example .env"
    echo "🔑 Не забудьте указать ваш BOT_TOKEN!"
    exit 1
fi

# Создаем директорию для данных если её нет
mkdir -p data

# Запускаем бота через PM2
echo "🚀 Запускаем бота через PM2..."
pm2 stop en-offline-bot 2>/dev/null || true
pm2 delete en-offline-bot 2>/dev/null || true
pm2 start index.js --name en-offline-bot

# Сохраняем конфигурацию PM2
pm2 save

# Настраиваем автозапуск PM2
pm2 startup

echo "✅ Развертывание завершено!"
echo "📊 Проверить статус: pm2 status"
echo "📋 Просмотр логов: pm2 logs en-offline-bot"
echo "🔄 Перезапуск: pm2 restart en-offline-bot"
echo "⏹️  Остановка: pm2 stop en-offline-bot"