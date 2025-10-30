const { logger } = require('./src/infra/logger');
const { main } = require('./src/app');

main().catch(error => {
  logger.error('❌ Критическая ошибка запуска:', error);
  process.exit(1);
});
