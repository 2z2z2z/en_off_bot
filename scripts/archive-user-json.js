#!/usr/bin/env node

const path = require('path');
const fs = require('fs-extra');
const dotenv = require('dotenv');
const { logger } = require('../src/infra/logger');

async function run() {
  dotenv.config();

  const dataFile = process.env.DATA_FILE || 'user_data.json';
  const resolvedPath = path.resolve(dataFile);

  if (!(await fs.pathExists(resolvedPath))) {
    logger.warn(`[archive] Файл ${resolvedPath} не найден, архивировать нечего.`);
    return;
  }

  const backupDir = path.resolve('backups');
  await fs.ensureDir(backupDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDir, `user_data.${timestamp}.json`);

  await fs.move(resolvedPath, target, { overwrite: false });
  logger.info(`[archive] user_data.json перемещён в ${target}`);
}

run().catch(error => {
  logger.error('[archive] Ошибка перемещения user_data.json:', error);
  process.exit(1);
});
