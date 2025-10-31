#!/usr/bin/env node

const path = require('path');
const fs = require('fs-extra');
const dotenv = require('dotenv');
const { logger } = require('../src/infra/logger');
const { initializeSqlite } = require('../src/infra/database/sqlite');
const { UserRepository } = require('../src/entities/user/repository');
const {
  loadUserData,
  saveUserData,
  setUserRepository,
  setDataFilePath,
  userData
} = require('../src/core/user-store');

async function ensureBackup(jsonPath) {
  if (!(await fs.pathExists(jsonPath))) {
    logger.warn(`Файл ${jsonPath} не найден — пропускаю создание резервной копии.`);
    return null;
  }

  const backupName = `${path.basename(jsonPath)}.bak-${Date.now()}`;
  const backupPath = path.join(path.dirname(jsonPath), backupName);
  await fs.copy(jsonPath, backupPath);
  logger.info(`Создан резервный JSON: ${backupPath}`);
  return backupPath;
}

async function runMigration() {
  dotenv.config();

  const dataFile = process.env.DATA_FILE || 'user_data.json';
  const sqlitePath = process.env.SQLITE_DB_PATH || 'bot_data.sqlite';

  setDataFilePath(dataFile);

  await ensureBackup(path.resolve(dataFile));

  const sqlite = await initializeSqlite({ filePath: sqlitePath, log: logger });
  const repository = new UserRepository({ database: sqlite, logger });
  setUserRepository(repository);

  await loadUserData(dataFile);
  await saveUserData(dataFile);

  const profiles = await repository.listProfiles();
  const sessionsCountRow = sqlite.get('SELECT COUNT(*) AS count FROM game_sessions');
  const runtimeCountRow = sqlite.get('SELECT COUNT(*) AS count FROM runtime_state');

  logger.info(
    `Миграция завершена: ${profiles.length} профилей, ${sessionsCountRow?.count || 0} игровых сессий, ${runtimeCountRow?.count || 0} runtime-состояний`
  );

  logger.info(`JSON и SQLite синхронизированы. user_data.json содержит ${userData.size} пользователей.`);

  await sqlite.close();
}

runMigration().catch(error => {
  logger.error('Ошибка миграции JSON → SQLite:', error);
  process.exit(1);
});
