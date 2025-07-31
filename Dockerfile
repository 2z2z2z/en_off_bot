# Используем официальный образ Node.js
FROM node:18-alpine

# Создаем директорию приложения
WORKDIR /app

# Копируем файлы package.json и package-lock.json
COPY package*.json ./

# Устанавливаем зависимости
RUN npm ci --only=production

# Копируем исходный код
COPY . .

# Создаем пользователя для безопасности
RUN addgroup -g 1001 -S nodejs
RUN adduser -S botuser -u 1001

# Создаем директорию для данных и устанавливаем права
RUN mkdir -p /app/data && chown botuser:nodejs /app/data

# Переключаемся на непривилегированного пользователя
USER botuser

# Устанавливаем переменную окружения для файла данных
ENV DATA_FILE=/app/data/user_data.json

# Открываем порт (если нужен для healthcheck)
EXPOSE 3000

# Запускаем приложение
CMD ["node", "index.js"]