PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  login TEXT,
  encrypted_password TEXT,
  domain TEXT,
  active_game_id TEXT,
  telegram_username TEXT,
  telegram_first_name TEXT,
  is_online INTEGER DEFAULT 1,
  first_activity INTEGER,
  last_activity INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_profiles_user_platform
  ON profiles(user_id, platform);

CREATE TABLE IF NOT EXISTS game_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  auth_cookies TEXT,
  last_level_id TEXT,
  last_level_number INTEGER,
  last_level_updated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
  UNIQUE(profile_id, game_id)
);

CREATE INDEX IF NOT EXISTS idx_game_sessions_game_id
  ON game_sessions(game_id);

CREATE INDEX IF NOT EXISTS idx_game_sessions_profile_game
  ON game_sessions(profile_id, game_id);

CREATE TABLE IF NOT EXISTS runtime_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  pending_answers TEXT,
  accumulated_answers TEXT,
  pending_burst_answers TEXT,
  recent_timestamps TEXT,
  pending_queue_decision TEXT,
  pending_answer_decision TEXT,
  last_known_level TEXT,
  accumulation_start_level TEXT,
  is_processing_queue INTEGER DEFAULT 0,
  is_accumulating INTEGER DEFAULT 0,
  is_authenticating INTEGER DEFAULT 0,
  accumulation_timer_end INTEGER,
  queue_progress_message_id TEXT,
  accumulation_notice_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
  UNIQUE(profile_id)
);

CREATE INDEX IF NOT EXISTS idx_runtime_state_profile
  ON runtime_state(profile_id);
