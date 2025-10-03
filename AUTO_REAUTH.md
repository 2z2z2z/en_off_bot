# Автоматическая реаутентификация

## Описание

Реализована автоматическая реаутентификация при истечении сессии в Encounter API. Теперь бот **автоматически** переавторизуется без участия пользователя и повторяет запрос с новыми cookies.

## Как работает

### 1. Детектирование истечения сессии

API методы проверяют ответы от Encounter на признаки истечения сессии:

- **HTML страница входа** вместо JSON ответа
- **Event=4** (игрок не авторизован)
- **HTTP 401** (unauthorized)

При обнаружении устанавливается флаг `error.needsAuth = true`

### 2. Автоматическая реаутентификация

Если обнаружена ошибка авторизации (`needsAuth=true`) И переданы `login`/`password`:

1. Вызывается `authenticate(login, password)` автоматически
2. Получаются новые cookies
3. Запрос **автоматически повторяется** с новыми cookies
4. Пользователь **не видит** промежуточных ошибок

### 3. Обработка результата

**Успешная реаутентификация:**
- Запрос выполняется успешно
- Новые cookies возвращаются в `result.newCookies`
- Бот сохраняет новые cookies в `user_data.json`
- Пользователь видит только успешный результат

**Неудачная реаутентификация:**
- Пользователь получает **одно** уведомление с причиной
- Ошибка помечается флагом `error.reAuthFailed = true`
- Текст ошибки: `"Автоматическая реаутентификация не удалась: {причина}"`

## Обновленные методы API

### `getGameState(gameId, authCookies, login, password, isRetry)`

**Новые параметры:**
- `login` (optional) - логин для автореаутентификации
- `password` (optional) - пароль для автореаутентификации
- `isRetry` (optional) - флаг повторной попытки (защита от бесконечной рекурсии)

**Логика:**
```javascript
try {
  // Запрос к API
} catch (error) {
  if (error.needsAuth && login && password && !isRetry) {
    // Автоматическая реаутентификация
    const authResult = await this.authenticate(login, password);
    if (authResult.success) {
      // Повтор запроса с новыми cookies
      return await this.getGameState(gameId, authResult.cookies, login, password, true);
    }
  }
  throw error;
}
```

### `sendAnswer(gameId, answer, authCookies, login, password, isRetry)`

**Новые параметры:**
- `login` (optional) - логин для автореаутентификации
- `password` (optional) - пароль для автореаутентификации
- `isRetry` (optional) - флаг повторной попытки

**Возвращаемый объект:**
```javascript
{
  success: true,
  correct: boolean,
  message: string,
  levelNumber: number,
  data: object,
  level: object,
  newCookies: object | null  // ← НОВОЕ: обновленные cookies если была реаутентификация
}
```

**Логика:**
```javascript
try {
  // Отправка ответа
  const result = { success: true, ..., newCookies: null };
  return result;
} catch (error) {
  if (error.needsAuth && login && password && !isRetry) {
    // Автоматическая реаутентификация
    const authResult = await this.authenticate(login, password);
    if (authResult.success) {
      // Повтор отправки с новыми cookies
      const retryResult = await this.sendAnswer(gameId, answer, authResult.cookies, login, password, true);
      retryResult.newCookies = authResult.cookies; // ← Возвращаем новые cookies
      return retryResult;
    }
  }
  throw error;
}
```

### `getGameInfo(gameId, authCookies, login, password)`

**Новые параметры:**
- `login` (optional) - логин для автореаутентификации
- `password` (optional) - пароль для автореаутентификации

Внутри использует обновленный `getGameState()` с автореаутентификацией.

## Изменения в index.js

### `sendToEncounterAPI(user, answer)`

**Было:**
```javascript
const result = await api.sendAnswer(user.gameId, answer, user.authCookies);
// Ручная обработка ошибок авторизации, повторная авторизация, повторная отправка
```

**Стало:**
```javascript
// Передаем login/password для автореаутентификации
const result = await api.sendAnswer(user.gameId, answer, user.authCookies, user.login, user.password);

// Если были обновлены cookies - сохраняем
if (result.newCookies) {
  console.log(`🔄 Cookies обновлены после автоматической реаутентификации`);
  user.authCookies = result.newCookies;
  await saveUserData();
}

return result;
```

**Убрано:**
- ❌ Ручная проверка на ошибки авторизации
- ❌ Ручной вызов `authenticate()` при ошибке
- ❌ Ручной повтор `sendAnswer()` после реаутентификации
- ❌ ~40 строк дублирующего кода

## Преимущества

### ✅ UX улучшения
- **Прозрачность**: пользователь не видит промежуточных ошибок
- **Скорость**: автоматический retry без задержек на взаимодействие с пользователем
- **Простота**: не нужно вручную переавторизовываться

### ✅ Надежность
- **Защита от рекурсии**: флаг `isRetry` предотвращает бесконечные попытки
- **Одна попытка**: только 1 автореаутентификация на запрос
- **Graceful fallback**: при неудаче пользователь получает понятное сообщение

### ✅ Код
- **DRY**: логика реаутентификации в одном месте (API класс)
- **Меньше кода**: убрано ~40 строк дублирующей обработки
- **Единообразие**: все методы API поддерживают автореаутентификацию

## Примеры логов

### Успешная автореаутентификация

```
📦 Используем кеш уровня №13 (ID: 1534356)
✅ Уровень 13 готов к приему ответов
📤 Отправляем ответ "42" на уровень 13 (LevelId: 1534356)
⏱️ Rate limit: жду 1157ms перед запросом к https://tech.en.cx
📥 Получен ответ от сервера: Event=undefined
🔒 Event=4: игрок не авторизован
🔄 Сессия истекла при отправке ответа, выполняю автоматическую реаутентификацию для aleshka...
⏱️ Rate limit: жду 203ms перед запросом к https://tech.en.cx
✅ Автоматическая реаутентификация успешна, повторяю отправку ответа...
📦 Используем кеш уровня №13 (ID: 1534356)
✅ Уровень 13 готов к приему ответов
📤 Отправляем ответ "42" на уровень 13 (LevelId: 1534356)
⏱️ Rate limit: жду 1189ms перед запросом к https://tech.en.cx
📥 Получен ответ от сервера: Event=0
🎯 Результат ответа "42": правильный
✅ Ответ "42" отправлен в игру 80646. ✅ Правильный ответ!
🔄 Cookies обновлены после автоматической реаутентификации
```

### Неудачная реаутентификация

```
🔒 Event=4: игрок не авторизован
🔄 Сессия истекла при отправке ответа, выполняю автоматическую реаутентификацию для aleshka...
⏱️ Rate limit: жду 1043ms перед запросом к https://tech.en.cx
❌ API вернул ответ с Error=2
❌ Ошибка отправки ответа в Encounter: Автоматическая реаутентификация не удалась: Неправильный логин или пароль
🔴 Ошибка: Автоматическая реаутентификация не удалась: Неправильный логин или пароль
```

## Обратная совместимость

Все изменения **обратно совместимы**:

- Параметры `login`, `password`, `isRetry` - **опциональные**
- Если не переданы - автореаутентификация не срабатывает
- Старые вызовы без новых параметров продолжают работать

## Миграция существующего кода

### Было
```javascript
const api = new EncounterAPI(domain);
const result = await api.sendAnswer(gameId, answer, cookies);
```

### Стало
```javascript
const api = new EncounterAPI(domain);
const result = await api.sendAnswer(gameId, answer, cookies, login, password);

// Проверяем обновление cookies
if (result.newCookies) {
  user.authCookies = result.newCookies;
  await saveUserData();
}
```

## Тестирование

### Сценарий 1: Нормальная работа (сессия активна)
1. Отправить ответ с валидными cookies
2. ✅ Ответ отправлен успешно
3. ✅ `result.newCookies === null`

### Сценарий 2: Истекшая сессия (успешная реаутентификация)
1. Отправить ответ с устаревшими cookies
2. ✅ Автоматическая реаутентификация
3. ✅ Ответ отправлен успешно
4. ✅ `result.newCookies` содержит новые cookies
5. ✅ Пользователь видит только успех

### Сценарий 3: Истекшая сессия (неудачная реаутентификация)
1. Отправить ответ с устаревшими cookies
2. ✅ Автоматическая реаутентификация
3. ❌ Реаутентификация не удалась (неверный пароль)
4. ✅ Пользователь видит: "Автоматическая реаутентификация не удалась: Неправильный логин или пароль"

### Сценарий 4: Без login/password (старое поведение)
1. Вызвать `sendAnswer()` без `login`/`password`
2. ✅ Ошибка авторизации пробрасывается как обычно
3. ✅ Автореаутентификация НЕ срабатывает

## Технические детали

### Флаги ошибок

```javascript
// Ошибка требует авторизации
error.needsAuth = true;

// Реаутентификация не удалась
error.reAuthFailed = true;
error.authMessage = "Неправильный логин или пароль";
```

### Защита от бесконечной рекурсии

```javascript
// isRetry предотвращает повторную автореаутентификацию
if (error.needsAuth && login && password && !isRetry) {
  // Только ОДНА попытка реаутентификации
  return await sendAnswer(gameId, answer, newCookies, login, password, true); // isRetry=true
}
```

### Обновление cookies

```javascript
// В sendToEncounterAPI (index.js)
const result = await api.sendAnswer(gameId, answer, user.authCookies, user.login, user.password);

if (result.newCookies) {
  user.authCookies = result.newCookies;  // Обновляем в памяти
  await saveUserData();                   // Сохраняем на диск
}
```

## Совместимость с очередью

Автореаутентификация полностью совместима с системой очереди ответов:

- При обработке очереди login/password передаются в каждый запрос
- Новые cookies автоматически сохраняются
- Следующий элемент очереди использует обновленные cookies
- Нет конфликтов с существующей логикой retry

## Будущие улучшения

Возможные расширения:

1. **Кеширование сессий**: не реаутентифицироваться если недавно обновляли cookies
2. **Множественные попытки**: 2-3 попытки реаутентификации с экспоненциальным backoff
3. **Уведомления**: опциональное уведомление пользователя "🔄 Сессия обновлена автоматически"
4. **Метрики**: подсчет количества автореаутентификаций для мониторинга
