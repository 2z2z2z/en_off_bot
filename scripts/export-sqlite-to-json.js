#!/usr/bin/env node

const path = require('path');
const fs = require('fs-extra');
const dotenv = require('dotenv');
const { logger } = require('../src/infra/logger');
const { initializeSqlite } = require('../src/infra/database/sqlite');
const { UserRepository } = require('../src/entities/user/repository');

function resolveOutputPath(defaultPath) {
  const cliArg = process.argv.slice(2).find(arg => !arg.startsWith('--'));
  if (cliArg) {
    return path.resolve(cliArg);
  }
  return path.resolve(defaultPath);
}

// eslint-disable-next-line complexity
function buildUserRecord(profile, session, runtime) {
  const record = {
    platform: profile.platform,
    userId: profile.userId,
    login: profile.login || null,
    password: profile.password || null,
    domain: profile.domain || null,
    gameId: profile.activeGameId || session?.gameId || null,
    authCookies: session?.authCookies || null,
    answerQueue: runtime?.pendingAnswers || [],
    isOnline: profile.isOnline,
    isProcessingQueue: runtime?.isProcessingQueue || false,
    isAuthenticating: runtime?.isAuthenticating || false,
    pendingQueueDecision: runtime?.pendingQueueDecision || null,
    pendingAnswerDecision: runtime?.pendingAnswerDecision || null,
    lastKnownLevel: runtime?.lastKnownLevel || null,
    recentMessageTimestamps: runtime?.recentTimestamps || [],
    isAccumulatingAnswers: runtime?.isAccumulating || false,
    accumulatedAnswers: runtime?.accumulatedAnswers || [],
    accumulationStartLevel: runtime?.accumulationStartLevel || null,
    accumulationTimer: null,
    accumulationTimerEnd: runtime?.accumulationTimerEnd || null,
    pendingBurstAnswers: runtime?.pendingBurstAnswers || [],
    pendingBurstTimer: null,
    _burstProcessing: false,
    _burstProcessingRequested: false,
    queueProgressMessageId: runtime?.queueProgressMessageId || null,
    accumulationNoticeMessageId: runtime?.accumulationNoticeMessageId || null,
    telegramUsername: profile.telegramUsername || null,
    telegramFirstName: profile.telegramFirstName || null,
    firstActivity: profile.firstActivity || Date.now(),
    lastActivity: profile.lastActivity || Date.now(),
    lastLevelId: runtime?.lastKnownLevel?.levelId || null,
    lastLevelNumber: runtime?.lastKnownLevel?.levelNumber || null,
    lastLevelUpdatedAt: runtime?.lastKnownLevel?.timestamp || null,
    staleAnswers: [],
    answerQueueVersion: 1
  };

  return record;
}

async function run() {
  dotenv.config();

  const sqlitePath = process.env.SQLITE_DB_PATH || 'bot_data.sqlite';
  const outputPath = resolveOutputPath(process.env.EXPORT_JSON_PATH || 'user_data_export.json');

  if (!(await fs.pathExists(sqlitePath))) {
    throw new Error(`SQLite база не найдена по пути ${sqlitePath}`);
  }

  const sqlite = await initializeSqlite({ filePath: sqlitePath, log: logger });
  const repository = new UserRepository({ database: sqlite, logger });

  const profiles = await repository.listProfiles();
  const result = {};

  for (const profile of profiles) {
    const runtime = await repository.getRuntimeState(profile.id);
    const sessions = await repository.listGameSessions(profile.id);
    const activeGameId = profile.activeGameId || runtime?.lastKnownLevel?.gameId || null;
    const session =
      sessions.find(item => item.gameId === activeGameId) || sessions[0] || null;

    const record = buildUserRecord(profile, session, runtime);
    const storageKey = `${profile.platform}::${profile.userId}`;
    result[storageKey] = record;
  }

  await fs.writeJson(outputPath, result, { spaces: 2 });
  logger.info(`[export] Экспорт завершён: ${profiles.length} пользователей → ${outputPath}`);

  await sqlite.close();
}

run().catch(error => {
  logger.error('[export] Ошибка экспорта SQLite → JSON:', error);
  process.exit(1);
});
