const fs = require('fs-extra');
const { logger } = require('../infra/logger');

const ADMIN_CONFIG_FILE = process.env.ADMIN_CONFIG_FILE || 'admin_config.json';

let adminConfig = {
  moderationEnabled: false,
  whitelist: []
};

const whitelistCache = new Set();

function rebuildWhitelistCache() {
  whitelistCache.clear();

  if (Array.isArray(adminConfig.whitelist)) {
    adminConfig.whitelist.forEach(entry => {
      const login = entry?.login || (entry?.type === 'encounter' ? entry.value : null);
      if (login) {
        whitelistCache.add(String(login).toLowerCase());
      }
    });
  }

  logger.info(`Whitelist cache обновлен: ${whitelistCache.size} записей`);
}

async function loadAdminConfig() {
  try {
    if (await fs.pathExists(ADMIN_CONFIG_FILE)) {
      adminConfig = await fs.readJson(ADMIN_CONFIG_FILE);

      if (Array.isArray(adminConfig.whitelist)) {
        let migrationCount = 0;
        adminConfig.whitelist = adminConfig.whitelist
          .map(item => {
            if (!item) {
              return null;
            }

            if (item.login) {
              return item;
            }

            if (item.type === 'encounter' && item.value) {
              migrationCount += 1;
              return {
                login: item.value,
                addedBy: item.addedBy,
                addedAt: item.addedAt
              };
            }

            if (item.type === 'telegram') {
              migrationCount += 1;
              return null;
            }

            return item;
          })
          .filter(Boolean);

        if (migrationCount > 0) {
          logger.info(`Выполнена миграция whitelist: обработано ${migrationCount} записей`);
          await saveAdminConfig();
        }
      } else {
        adminConfig.whitelist = [];
      }
    } else {
      await saveAdminConfig();
      logger.info('Создан файл admin_config.json с настройками по умолчанию');
    }

    rebuildWhitelistCache();
  } catch (error) {
    logger.error('Ошибка загрузки admin_config.json:', error);
    adminConfig = {
      moderationEnabled: false,
      whitelist: []
    };
    rebuildWhitelistCache();
  }
}

async function saveAdminConfig() {
  await fs.writeJson(ADMIN_CONFIG_FILE, adminConfig, { spaces: 2 });
  rebuildWhitelistCache();
}

function getAdminConfig() {
  return adminConfig;
}

function getWhitelistCache() {
  return whitelistCache;
}

module.exports = {
  ADMIN_CONFIG_FILE,
  loadAdminConfig,
  saveAdminConfig,
  rebuildWhitelistCache,
  getAdminConfig,
  getWhitelistCache
};
