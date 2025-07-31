# 🌐 Развертывание на VPS серверах

## 🚀 Быстрое развертывание (One-liner)

### DigitalOcean / Ubuntu 22.04

```bash
# Полная автоматическая установка
curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/en_off_bot/main/deploy.sh | bash
```

### Пошаговая установка

```bash
# 1. Обновляем систему
sudo apt update && sudo apt upgrade -y

# 2. Устанавливаем Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. Устанавливаем PM2
sudo npm install -g pm2

# 4. Клонируем проект
git clone https://github.com/YOUR_USERNAME/en_off_bot.git
cd en_off_bot

# 5. Настраиваем переменные окружения
cp config.env.example .env
nano .env  # Укажите ваш BOT_TOKEN

# 6. Устанавливаем зависимости
npm install

# 7. Запускаем через PM2
pm2 start index.js --name en-offline-bot
pm2 save
pm2 startup
```

## 🐳 Docker развертывание

### Все провайдеры с Docker

```bash
# 1. Установка Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# 2. Установка Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/download/v2.20.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# 3. Клонирование и запуск
git clone https://github.com/YOUR_USERNAME/en_off_bot.git
cd en_off_bot

# 4. Настройка переменных
echo "BOT_TOKEN=your_bot_token_here" > .env

# 5. Запуск
docker-compose up -d
```

## 🖥️ Специфичные инструкции для провайдеров

### AWS EC2 (Amazon Linux 2)

```bash
# Обновление системы
sudo yum update -y

# Установка Node.js
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# Установка Git
sudo yum install -y git

# Далее как обычно...
```

### Google Cloud Platform (Debian 11)

```bash
# Обновление
sudo apt update && sudo apt upgrade -y

# Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Далее стандартная установка...
```

### Hetzner (Ubuntu 20.04)

```bash
# Стандартная установка Ubuntu
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs npm git
sudo npm install -g pm2

# Клонирование и настройка...
```

## 🔧 Команды управления

### PM2 команды

```bash
# Просмотр статуса
pm2 status

# Просмотр логов
pm2 logs en-offline-bot

# Перезапуск
pm2 restart en-offline-bot

# Остановка
pm2 stop en-offline-bot

# Удаление
pm2 delete en-offline-bot

# Мониторинг в реальном времени
pm2 monit
```

### Docker команды

```bash
# Просмотр контейнеров
docker ps

# Просмотр логов
docker-compose logs -f

# Перезапуск
docker-compose restart

# Остановка
docker-compose down

# Обновление после изменений кода
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

## 🔍 Проверка работоспособности

### После развертывания проверьте:

```bash
# 1. Процесс запущен
ps aux | grep node

# 2. Порты (если используется)
sudo netstat -tlnp | grep :3000

# 3. Логи приложения
pm2 logs en-offline-bot --lines 20

# 4. Системные ресурсы
free -h
df -h
```

### Тестирование бота

1. Найдите бота в Telegram
2. Отправьте `/start`
3. Пройдите настройку
4. Отправьте тестовый ответ

## 🛡️ Безопасность

### Базовая настройка firewall

```bash
# Ubuntu/Debian
sudo ufw enable
sudo ufw allow ssh
sudo ufw allow out 443  # HTTPS для Telegram API
sudo ufw allow out 80   # HTTP

# CentOS/RHEL
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --permanent --add-port=443/tcp
sudo firewall-cmd --reload
```

### Автоматические обновления

```bash
# Ubuntu/Debian
sudo apt install unattended-upgrades
sudo dpkg-reconfigure unattended-upgrades

# Настройка автообновления для безопасности
echo 'Unattended-Upgrade::Automatic-Reboot "false";' | sudo tee -a /etc/apt/apt.conf.d/50unattended-upgrades
```

## 💰 Рекомендуемые конфигурации VPS

### Минимальная (тестирование)
- **RAM**: 512 MB
- **CPU**: 1 vCPU  
- **Диск**: 10 GB SSD
- **Цена**: ~$5-7/месяц

### Рекомендуемая (продакшн)
- **RAM**: 1 GB
- **CPU**: 1 vCPU
- **Диск**: 20 GB SSD
- **Цена**: ~$10-12/месяц

### Провайдеры
- 🥇 **DigitalOcean**: простота + документация
- 🥈 **Hetzner**: лучшая цена/качество
- 🥉 **Vultr**: стабильность
- **AWS**: масштабируемость (дороже)

## 🔄 Автоматическое обновление

### GitHub Webhooks (продвинутый вариант)

```bash
# Создание скрипта автообновления
cat > update.sh << 'EOF'
#!/bin/bash
cd /path/to/en_off_bot
git pull origin main
npm install
pm2 restart en-offline-bot
EOF

chmod +x update.sh
```

## 📞 Поддержка

При проблемах с развертыванием:

1. Проверьте логи: `pm2 logs` или `docker-compose logs`
2. Убедитесь что BOT_TOKEN правильный
3. Проверьте доступность интернета: `ping api.telegram.org`
4. Создайте Issue в GitHub репозитории