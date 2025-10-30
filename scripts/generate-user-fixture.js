const fs = require('fs');
const path = require('path');

const totalUsers = 150;
const now = Date.now();

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const data = {};

for (let i = 1; i <= totalUsers; i += 1) {
  const platform = i % 3 === 0 ? 'vk' : 'telegram';
  const userId = `${platform === 'telegram' ? 'tg' : 'vk'}${String(i).padStart(6, '0')}`;
  const key = `${platform}::${userId}`;
  const baseLevel = (i % 50) + 1;
  const baseLevelId = 100000 + i;

  const queue = [];
  if (i % 7 === 0) {
    const queueSize = randomInt(5, 15);
    for (let q = 0; q < queueSize; q += 1) {
      const entry = {
        answer: `queue-${i}-${q + 1}`,
        timestamp: now - q * 60000,
        levelId: q % 2 === 0 ? baseLevelId : null,
        levelNumber: q % 2 === 0 ? baseLevel : null
      };

      if (q % 6 === 0) {
        entry.failedAttempts = q % 3;
        entry.lastError = 'Сетевая ошибка';
      }

      queue.push(entry);
    }
  }

  const accumulatedAnswers = [];
  if (i % 9 === 0) {
    const accSize = randomInt(2, 6);
    for (let a = 0; a < accSize; a += 1) {
      accumulatedAnswers.push({
        answer: `acc-${i}-${a + 1}`,
        timestamp: now - a * 45000
      });
    }
  }

  const pendingBurstAnswers = [];
  if (i % 10 === 0) {
    const burstSize = randomInt(3, 5);
    for (let b = 0; b < burstSize; b += 1) {
      pendingBurstAnswers.push({
        answer: `burst-${i}-${b + 1}`,
        timestamp: now - b * 3000,
        progressMessageId: `msg-${i}-${b + 1}`
      });
    }
  }

  const recentMessageTimestamps = Array.from(
    { length: randomInt(0, 5) },
    (_, idx) => now - idx * 2000
  );

  const user = {
    platform,
    userId,
    login: `${platform}_user_${i}`,
    password: `enc:v1:dummy:${i}:payload`,
    domain: `https://city${(i % 10) + 1}.en.cx`,
    gameId: String(50000 + i),
    authCookies:
      i % 5 === 0 ? {} : { GUID: `guid-${i}`, stoken: `stoken-${i}`, atoken: `atoken-${i}` },
    answerQueue: queue,
    accumulatedAnswers,
    pendingBurstAnswers,
    lastKnownLevel: {
      levelId: baseLevelId,
      levelNumber: baseLevel,
      timestamp: now - randomInt(60_000, 600_000)
    },
    accumulationStartLevel: accumulatedAnswers.length
      ? { levelId: baseLevelId, levelNumber: baseLevel }
      : null,
    recentMessageTimestamps,
    isOnline: i % 4 !== 0,
    createdAt: now - i * 86_400_000,
    updatedAt: now - i * 3600000
  };

  if (i % 13 === 0) {
    user.pendingAnswerDecision = {
      answer: `pending-${i}`,
      oldLevel: baseLevel,
      newLevel: baseLevel + 1
    };
  }

  if (i % 11 === 0) {
    user.pendingQueueDecision = {
      oldLevelNumber: baseLevel,
      newLevelNumber: baseLevel + 1,
      queueSize: queue.length || randomInt(3, 8)
    };
  }

  data[key] = user;
}

const targetPath = path.join(__dirname, '..', '__tests__', 'fixtures', 'user_data_large.json');
fs.writeFileSync(targetPath, JSON.stringify(data, null, 2));
console.log(`Generated ${totalUsers} users into ${targetPath}`);
