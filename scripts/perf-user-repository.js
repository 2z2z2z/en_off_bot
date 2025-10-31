#!/usr/bin/env node

const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { performance } = require('perf_hooks');
const { logger } = require('../src/infra/logger');
const { initializeSqlite } = require('../src/infra/database/sqlite');
const { UserRepository } = require('../src/entities/user/repository');

const TOTAL_USERS = 500;
const OPERATIONS = 1000;
const CONCURRENCY = 50;
const OPERATIONS_PER_WORKER = 20;

function createUserPayload(index) {
  const platform = index % 3 === 0 ? 'vk' : 'telegram';
  const userId = `${platform === 'telegram' ? 'tg' : 'vk'}${String(index + 1).padStart(6, '0')}`;
  const gameId = String(70000 + (index % 50));
  const levelNumber = (index % 60) + 1;

  return {
    platform,
    userId,
    login: `${platform}_user_${index + 1}`,
    password: `password_${index + 1}`,
    domain: `https://city${(index % 10) + 1}.en.cx`,
    activeGameId: gameId,
    telegramUsername: platform === 'telegram' ? `user_${index + 1}` : null,
    telegramFirstName: platform === 'telegram' ? `Name${index + 1}` : null,
    isOnline: index % 4 !== 0,
    firstActivity: Date.now() - index * 86_400_000,
    lastActivity: Date.now() - index * 3_600_000,
    session: {
      gameId,
      authCookies: {
        GUID: `guid-${index}`,
        stoken: `stoken-${index}`,
        atoken: `atoken-${index}`
      },
      lastLevelId: 100000 + levelNumber,
      lastLevelNumber: levelNumber,
      lastLevelUpdatedAt: Date.now() - (index % 120) * 60_000
    }
  };
}

function createRuntimeState(index) {
  const queueLength = (index % 8) + 1;
  const answerQueue = Array.from({ length: queueLength }, (_, idx) => ({
    answer: `code_${index}_${idx}`,
    timestamp: Date.now() - idx * 45_000,
    levelId: idx % 2 === 0 ? 1000 + idx : null,
    levelNumber: idx % 2 === 0 ? idx + 1 : null
  }));

  return {
    pendingAnswers: answerQueue,
    accumulatedAnswers:
      index % 5 === 0
        ? [
            {
              answer: `acc_${index}_1`,
              timestamp: Date.now() - 30_000
            }
          ]
        : [],
    pendingBurstAnswers: [],
    recentTimestamps: [Date.now() - 10_000, Date.now() - 5_000],
    pendingQueueDecision:
      index % 11 === 0
        ? {
            oldLevelNumber: 3,
            newLevelNumber: 4,
            queueSize: queueLength
          }
        : null,
    pendingAnswerDecision:
      index % 13 === 0
        ? {
            answer: `pending_${index}`,
            oldLevel: 5,
            newLevel: 6
          }
        : null,
    lastKnownLevel: {
      levelId: 1000 + index,
      levelNumber: (index % 50) + 1,
      timestamp: Date.now() - 120_000
    },
    accumulationStartLevel: null,
    isProcessingQueue: false,
    isAccumulating: false,
    isAuthenticating: false,
    accumulationTimerEnd: null,
    queueProgressMessageId: null,
    accumulationNoticeMessageId: null
  };
}

async function createTempDbPath() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'en-bot-perf-'));
  return path.join(tmpDir, 'perf.sqlite');
}

async function run() {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'perf-secret-key';

  const dbPath = await createTempDbPath();
  logger.info(`[perf] Использую временную БД: ${dbPath}`);

  const sqlite = await initializeSqlite({ filePath: dbPath, log: logger });
  const repository = new UserRepository({ database: sqlite, logger });

  const profiles = [];

  const seedStart = performance.now();
  for (let i = 0; i < TOTAL_USERS; i += 1) {
    const payload = createUserPayload(i);
    const profile = await repository.saveProfile(payload);
    profiles.push({
      id: profile.id,
      platform: profile.platform,
      userId: profile.userId
    });

    await repository.upsertGameSession(profile.id, payload.session);
    await repository.updateRuntimeState(profile.id, createRuntimeState(i));
  }
  const seedDuration = performance.now() - seedStart;

  const operationsStart = performance.now();
  for (let i = 0; i < OPERATIONS; i += 1) {
    const profile = profiles[i % profiles.length];

    if (i % 3 === 0) {
      await repository.getProfile(profile.platform, profile.userId);
    } else if (i % 3 === 1) {
      await repository.updateRuntimeState(profile.id, createRuntimeState(i));
    } else {
      await repository.upsertGameSession(profile.id, {
        gameId: `G${(i % 20) + 70000}`,
        authCookies: {
          GUID: `guid-op-${i}`,
          stoken: `stoken-op-${i}`,
          atoken: `atoken-op-${i}`
        },
        lastLevelId: 200000 + i,
        lastLevelNumber: (i % 60) + 1,
        lastLevelUpdatedAt: Date.now()
      });
    }
  }
  const operationsDuration = performance.now() - operationsStart;

  const concurrentStart = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, workerIdx) =>
      (async () => {
        const baseProfile = profiles[(workerIdx * 7) % profiles.length];
        for (let i = 0; i < OPERATIONS_PER_WORKER; i += 1) {
          const state = createRuntimeState(workerIdx * 100 + i);
          await repository.updateRuntimeState(baseProfile.id, state);
        }
      })()
    )
  );
  const concurrentDuration = performance.now() - concurrentStart;

  logger.info(
    `[perf] Seed ${TOTAL_USERS} пользователей занял ${(seedDuration / 1000).toFixed(2)} c (${(
      (TOTAL_USERS * 1000) /
      seedDuration
    ).toFixed(1)} оп/с)`
  );
  logger.info(
    `[perf] ${OPERATIONS} операций (чтение/запись) заняли ${(operationsDuration / 1000).toFixed(
      2
    )} c (${((OPERATIONS * 1000) / operationsDuration).toFixed(1)} оп/с)`
  );
  logger.info(
    `[perf] Конкурентные обновления (${CONCURRENCY} × ${OPERATIONS_PER_WORKER}) заняли ${(
      concurrentDuration / 1000
    ).toFixed(2)} c`
  );

  await sqlite.close();
  await fs.remove(path.dirname(dbPath));
}

run().catch(error => {
  logger.error('[perf] Ошибка бенчмарка UserRepository:', error);
  process.exit(1);
});
