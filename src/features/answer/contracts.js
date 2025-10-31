/**
 * Контракт зависимостей и публичного API для доставки ответов.
 *
 * @typedef {Object} AnswerDeliveryDeps
 * @property {Function} ensureAuthenticated - Проверяет текущую авторизацию пользователя в Encounter.
 * @property {Function} createAuthCallback - Возвращает callback, выполняющий авторизацию и кэширование cookies.
 * @property {Function} getUserInfo - Возвращает профиль пользователя по паре (platform, userId).
 * @property {Function} sendMessage - Отправляет сообщение пользователю на платформе.
 * @property {Function} sendOrUpdateMessage - Отправляет новое или обновляет существующее сообщение.
 * @property {Function} saveUserData - Сохраняет user_data.json после модификаций.
 * @property {Function} enqueueAnswer - Добавляет ответ в офлайн-очередь пользователя.
 * @property {import('../../infra/logger').logger} logger - Структурированный логгер проекта.
 * @property {Function} EncounterAPI - Класс клиента Encounter API.
 */

/**
 * @typedef {Object} AnswerDeliveryAPI
 * @property {Function} sendAnswerToEncounter - Отправляет ответ в Encounter, учитывая блокировки и retry.
 * @property {Function} handleAccumulationComplete - Завершает режим буферизации и показывает выбор пользователю.
 * @property {Function} sendToEncounterAPI - Низкоуровневый вызов EncounterAPI, используемый queue-processor.
 */

module.exports = {};
