const assert = require('node:assert/strict');
const { encryptSecret, decryptSecret } = require('../../../utils/crypto');

const MAX_PENDING_ANSWERS = 100;

function ensureArray(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function ensureObject(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'object') {
    return value;
  }
  return null;
}

function serializeJson(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return JSON.stringify(value);
}

function deserializeJson(value) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function booleanToInt(value) {
  return value ? 1 : 0;
}

function intToBoolean(value) {
  return value === 1;
}

class UserRepository {
  /**
   * @param {Object} options
   * @param {import('../../../infra/database/sqlite').initializeSqlite} options.database
   * @param {import('../../../infra/logger').logger} options.logger
   */
  constructor({ database, logger }) {
    assert(database, 'database instance required');
    this.database = database;
    this.logger = logger;
  }

  /**
   * Возвращает профиль пользователя по паре (platform, userId).
   * @param {string} platform
   * @param {string} userId
   */
  async getProfile(platform, userId) {
    const row = this.database.get(
      `SELECT *
       FROM profiles
       WHERE platform = ? AND user_id = ?`,
      [platform, userId]
    );

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      platform: row.platform,
      userId: row.user_id,
      login: row.login,
      password: row.encrypted_password ? decryptSecret(row.encrypted_password) : null,
      domain: row.domain,
      activeGameId: row.active_game_id || null,
      telegramUsername: row.telegram_username,
      telegramFirstName: row.telegram_first_name,
      isOnline: intToBoolean(row.is_online),
      firstActivity: row.first_activity || null,
      lastActivity: row.last_activity || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /**
   * Создаёт или обновляет профиль пользователя.
   * @param {Object} payload
   * @returns {Promise<Object>}
   */
  async saveProfile(payload) {
    const now = Date.now();
    const profileData = {
      platform: payload.platform,
      userId: payload.userId,
      login: payload.login || null,
      password: payload.password || null,
      domain: payload.domain || null,
      activeGameId: payload.activeGameId || payload.gameId || null,
      telegramUsername: payload.telegramUsername || null,
      telegramFirstName: payload.telegramFirstName || null,
      isOnline: payload.isOnline !== undefined ? payload.isOnline : true,
      firstActivity: payload.firstActivity || now,
      lastActivity: payload.lastActivity || now
    };

    return this.database.runInTransaction(async ({ run, get }) => {
      const existing = get(
        `SELECT id, created_at
         FROM profiles
         WHERE platform = ? AND user_id = ?`,
        [profileData.platform, profileData.userId]
      );

      const encryptedPassword = profileData.password
        ? encryptSecret(profileData.password)
        : null;

      if (existing) {
        run(
          `UPDATE profiles
             SET login = ?,
                 encrypted_password = ?,
                 domain = ?,
                 active_game_id = ?,
                 telegram_username = ?,
                 telegram_first_name = ?,
                 is_online = ?,
                 first_activity = ?,
                 last_activity = ?,
                 updated_at = ?
           WHERE id = ?`,
          [
            profileData.login,
            encryptedPassword,
            profileData.domain,
            profileData.activeGameId,
            profileData.telegramUsername,
            profileData.telegramFirstName,
            booleanToInt(profileData.isOnline),
            profileData.firstActivity,
            profileData.lastActivity,
            now,
            existing.id
          ]
        );

        return {
          id: existing.id,
          createdAt: existing.created_at,
          updatedAt: now,
          ...profileData
        };
      }

      run(
        `INSERT INTO profiles (
           user_id,
           platform,
           login,
           encrypted_password,
           domain,
           active_game_id,
           telegram_username,
           telegram_first_name,
           is_online,
           first_activity,
           last_activity,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          profileData.userId,
          profileData.platform,
          profileData.login,
          encryptedPassword,
          profileData.domain,
          profileData.activeGameId,
          profileData.telegramUsername,
          profileData.telegramFirstName,
          booleanToInt(profileData.isOnline),
          profileData.firstActivity,
          profileData.lastActivity,
          now,
          now
        ]
      );

      const idRow = get('SELECT last_insert_rowid() AS id');
      return {
        id: idRow.id,
        createdAt: now,
        updatedAt: now,
        ...profileData
      };
    });
  }

  async getGameSession(profileId, gameId) {
    const row = this.database.get(
      `SELECT *
       FROM game_sessions
       WHERE profile_id = ? AND game_id = ?`,
      [profileId, String(gameId)]
    );

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      profileId: row.profile_id,
      gameId: row.game_id,
      authCookies: deserializeJson(row.auth_cookies),
      lastLevelId: row.last_level_id || null,
      lastLevelNumber: row.last_level_number || null,
      lastLevelUpdatedAt: row.last_level_updated_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async updateAuthCookies(sessionId, cookies) {
    const now = Date.now();

    return this.database.runInTransaction(async ({ run }) => {
      run(
        `UPDATE game_sessions
           SET auth_cookies = ?,
               updated_at = ?
         WHERE id = ?`,
        [serializeJson(cookies), now, sessionId]
      );
    });
  }

  async upsertGameSession(profileId, payload) {
    const now = Date.now();
    const gameId = String(payload.gameId);

    return this.database.runInTransaction(async ({ run, get }) => {
      const existing = get(
        `SELECT id, created_at
         FROM game_sessions
         WHERE profile_id = ? AND game_id = ?`,
        [profileId, gameId]
      );

      if (existing) {
        run(
          `UPDATE game_sessions
             SET auth_cookies = ?,
                 last_level_id = ?,
                 last_level_number = ?,
                 last_level_updated_at = ?,
                 updated_at = ?
           WHERE id = ?`,
          [
            serializeJson(payload.authCookies || null),
            payload.lastLevelId || null,
            payload.lastLevelNumber || null,
            payload.lastLevelUpdatedAt || null,
            now,
            existing.id
          ]
        );

        return {
          id: existing.id,
          profileId,
          gameId,
          createdAt: existing.created_at,
          updatedAt: now,
          authCookies: payload.authCookies || null,
          lastLevelId: payload.lastLevelId || null,
          lastLevelNumber: payload.lastLevelNumber || null,
          lastLevelUpdatedAt: payload.lastLevelUpdatedAt || null
        };
      }

      run(
        `INSERT INTO game_sessions (
           profile_id,
           game_id,
           auth_cookies,
           last_level_id,
           last_level_number,
           last_level_updated_at,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          profileId,
          gameId,
          serializeJson(payload.authCookies || null),
          payload.lastLevelId || null,
          payload.lastLevelNumber || null,
          payload.lastLevelUpdatedAt || null,
          now,
          now
        ]
      );

      const idRow = get('SELECT last_insert_rowid() AS id');

      return {
        id: idRow.id,
        profileId,
        gameId,
        createdAt: now,
        updatedAt: now,
        authCookies: payload.authCookies || null,
        lastLevelId: payload.lastLevelId || null,
        lastLevelNumber: payload.lastLevelNumber || null,
        lastLevelUpdatedAt: payload.lastLevelUpdatedAt || null
      };
    });
  }

  async getRuntimeState(profileId) {
    const row = this.database.get(
      `SELECT *
       FROM runtime_state
       WHERE profile_id = ?`,
      [profileId]
    );

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      profileId: row.profile_id,
      pendingAnswers: ensureArray(deserializeJson(row.pending_answers)),
      accumulatedAnswers: ensureArray(deserializeJson(row.accumulated_answers)),
      pendingBurstAnswers: ensureArray(deserializeJson(row.pending_burst_answers)),
      recentTimestamps: ensureArray(deserializeJson(row.recent_timestamps)),
      pendingQueueDecision: ensureObject(deserializeJson(row.pending_queue_decision)),
      pendingAnswerDecision: ensureObject(deserializeJson(row.pending_answer_decision)),
      lastKnownLevel: ensureObject(deserializeJson(row.last_known_level)),
      accumulationStartLevel: ensureObject(deserializeJson(row.accumulation_start_level)),
      isProcessingQueue: intToBoolean(row.is_processing_queue),
      isAccumulating: intToBoolean(row.is_accumulating),
      isAuthenticating: intToBoolean(row.is_authenticating),
      accumulationTimerEnd: row.accumulation_timer_end || null,
      queueProgressMessageId: row.queue_progress_message_id || null,
      accumulationNoticeMessageId: row.accumulation_notice_message_id || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async updateRuntimeState(profileId, state) {
    const now = Date.now();
    const sanitizeQueue = ensureArray(state.pendingAnswers).slice(-MAX_PENDING_ANSWERS);
    const accumulated = ensureArray(state.accumulatedAnswers);
    const burst = ensureArray(state.pendingBurstAnswers);
    const timestamps = ensureArray(state.recentTimestamps);

    return this.database.runInTransaction(async ({ run, get }) => {
      const existing = get(
        `SELECT id, created_at
         FROM runtime_state
         WHERE profile_id = ?`,
        [profileId]
      );

      const payload = {
        pendingAnswers: sanitizeQueue,
        accumulatedAnswers: accumulated,
        pendingBurstAnswers: burst,
        recentTimestamps: timestamps,
        pendingQueueDecision: ensureObject(state.pendingQueueDecision),
        pendingAnswerDecision: ensureObject(state.pendingAnswerDecision),
        lastKnownLevel: ensureObject(state.lastKnownLevel),
        accumulationStartLevel: ensureObject(state.accumulationStartLevel),
        isProcessingQueue: booleanToInt(state.isProcessingQueue),
        isAccumulating: booleanToInt(state.isAccumulating),
        isAuthenticating: booleanToInt(state.isAuthenticating),
        accumulationTimerEnd: state.accumulationTimerEnd || null,
        queueProgressMessageId: state.queueProgressMessageId || null,
        accumulationNoticeMessageId: state.accumulationNoticeMessageId || null
      };

      if (existing) {
        run(
          `UPDATE runtime_state
             SET pending_answers = ?,
                 accumulated_answers = ?,
                 pending_burst_answers = ?,
                 recent_timestamps = ?,
                 pending_queue_decision = ?,
                 pending_answer_decision = ?,
                 last_known_level = ?,
                 accumulation_start_level = ?,
                 is_processing_queue = ?,
                 is_accumulating = ?,
                 is_authenticating = ?,
                 accumulation_timer_end = ?,
                 queue_progress_message_id = ?,
                 accumulation_notice_message_id = ?,
                 updated_at = ?
           WHERE id = ?`,
          [
            serializeJson(payload.pendingAnswers),
            serializeJson(payload.accumulatedAnswers),
            serializeJson(payload.pendingBurstAnswers),
            serializeJson(payload.recentTimestamps),
            serializeJson(payload.pendingQueueDecision),
            serializeJson(payload.pendingAnswerDecision),
            serializeJson(payload.lastKnownLevel),
            serializeJson(payload.accumulationStartLevel),
            payload.isProcessingQueue,
            payload.isAccumulating,
            payload.isAuthenticating,
            payload.accumulationTimerEnd,
            payload.queueProgressMessageId,
            payload.accumulationNoticeMessageId,
            now,
            existing.id
          ]
        );

        return {
          id: existing.id,
          profileId,
          createdAt: existing.created_at,
          updatedAt: now,
          ...payload
        };
      }

      run(
        `INSERT INTO runtime_state (
           profile_id,
           pending_answers,
           accumulated_answers,
           pending_burst_answers,
           recent_timestamps,
           pending_queue_decision,
           pending_answer_decision,
           last_known_level,
           accumulation_start_level,
           is_processing_queue,
           is_accumulating,
           is_authenticating,
           accumulation_timer_end,
           queue_progress_message_id,
           accumulation_notice_message_id,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          profileId,
          serializeJson(payload.pendingAnswers),
          serializeJson(payload.accumulatedAnswers),
          serializeJson(payload.pendingBurstAnswers),
          serializeJson(payload.recentTimestamps),
          serializeJson(payload.pendingQueueDecision),
          serializeJson(payload.pendingAnswerDecision),
          serializeJson(payload.lastKnownLevel),
          serializeJson(payload.accumulationStartLevel),
          payload.isProcessingQueue,
          payload.isAccumulating,
          payload.isAuthenticating,
          payload.accumulationTimerEnd,
          payload.queueProgressMessageId,
          payload.accumulationNoticeMessageId,
          now,
          now
        ]
      );

      const idRow = get('SELECT last_insert_rowid() AS id');

      return {
        id: idRow.id,
        profileId,
        createdAt: now,
        updatedAt: now,
        ...payload
      };
    });
  }

  async listProfiles() {
    const rows = this.database.all(
      `SELECT *
         FROM profiles
         ORDER BY created_at ASC`
    );

    return rows.map(row => ({
      id: row.id,
      platform: row.platform,
      userId: row.user_id,
      login: row.login,
      password: row.encrypted_password ? decryptSecret(row.encrypted_password) : null,
      domain: row.domain,
      activeGameId: row.active_game_id || null,
      telegramUsername: row.telegram_username,
      telegramFirstName: row.telegram_first_name,
      isOnline: intToBoolean(row.is_online),
      firstActivity: row.first_activity || null,
      lastActivity: row.last_activity || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  async listGameSessions(profileId) {
    const rows = this.database.all(
      `SELECT *
         FROM game_sessions
         WHERE profile_id = ?
         ORDER BY updated_at DESC`,
      [profileId]
    );

    return rows.map(row => ({
      id: row.id,
      profileId: row.profile_id,
      gameId: row.game_id,
      authCookies: deserializeJson(row.auth_cookies),
      lastLevelId: row.last_level_id || null,
      lastLevelNumber: row.last_level_number || null,
      lastLevelUpdatedAt: row.last_level_updated_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  async cleanupOldTimestamps(maxAgeMs) {
    const threshold = Date.now() - maxAgeMs;
    let affected = 0;

    await this.database.runInTransaction(async ({ all, run }) => {
      const rows = all(
        `SELECT id, profile_id, recent_timestamps, accumulated_answers
         FROM runtime_state`
      );

      rows.forEach(row => {
        const timestamps = ensureArray(deserializeJson(row.recent_timestamps));
        const filteredTimestamps = timestamps.filter(value => Number(value) >= threshold);

        const accumulated = ensureArray(deserializeJson(row.accumulated_answers));
        const filteredAccumulated = accumulated.filter(entry => {
          if (!entry || typeof entry !== 'object') {
            return false;
          }
          if (!entry.timestamp) {
            return true;
          }
          return Number(entry.timestamp) >= threshold;
        });

        if (
          filteredTimestamps.length !== timestamps.length ||
          filteredAccumulated.length !== accumulated.length
        ) {
          run(
            `UPDATE runtime_state
               SET recent_timestamps = ?,
                   accumulated_answers = ?,
                   updated_at = ?
             WHERE id = ?`,
            [
              serializeJson(filteredTimestamps),
              serializeJson(filteredAccumulated),
              Date.now(),
              row.id
            ]
          );
          affected += 1;
        }
      });
    });

    return affected;
  }

  async deleteInactiveStates(days) {
    const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
    let deleted = 0;

    await this.database.runInTransaction(async ({ run, get }) => {
      run('DELETE FROM runtime_state WHERE updated_at < ?', [threshold]);
      const row = get('SELECT changes() AS count');
      deleted = row ? row.count || 0 : 0;
    });

    return deleted;
  }
}

module.exports = {
  UserRepository
};
