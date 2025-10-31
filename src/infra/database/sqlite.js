const path = require('path');
const fs = require('fs-extra');
const initSqlJs = require('sql.js');
const { logger } = require('../logger');

const DEFAULT_DB_FILE = process.env.SQLITE_DB_PATH || 'bot_data.sqlite';

const migrations = [
  {
    version: 1,
    name: 'initial_schema',
    file: path.join(__dirname, 'migrations', '001_init.sql')
  }
];

async function loadSqlModule() {
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const wasmDir = path.dirname(wasmPath);

  return initSqlJs({
    locateFile: file => path.join(wasmDir, file)
  });
}

async function readMigrationSql(filePath) {
  const sql = await fs.readFile(filePath, 'utf8');
  return sql;
}

function prepareHelpers(db) {
  const run = (sql, params = []) => {
    const stmt = db.prepare(sql);
    try {
      if (params && params.length > 0) {
        stmt.bind(params);
      }
      stmt.step();
    } finally {
      stmt.free();
    }
  };

  const get = (sql, params = []) => {
    const stmt = db.prepare(sql);
    try {
      if (params && params.length > 0) {
        stmt.bind(params);
      }
      if (stmt.step()) {
        return stmt.getAsObject();
      }
      return null;
    } finally {
      stmt.free();
    }
  };

  const all = (sql, params = []) => {
    const stmt = db.prepare(sql);
    const rows = [];

    try {
      if (params && params.length > 0) {
        stmt.bind(params);
      }

      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
    } finally {
      stmt.free();
    }

    return rows;
  };

  return { run, get, all };
}

function ensureTransaction(db, fn) {
  db.exec('BEGIN TRANSACTION;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK;');
    } catch (rollbackError) {
      logger.error('Ошибка отката транзакции SQLite:', rollbackError);
    }
    throw error;
  }
}

async function applyMigrations(db, dbHelpers) {
  const { run, get } = dbHelpers;
  run('PRAGMA foreign_keys = ON;');

  let currentVersion = 0;
  try {
    const row = get('SELECT MAX(version) AS version FROM schema_version');
    if (row && typeof row.version === 'number') {
      currentVersion = row.version;
    }
  } catch (error) {
    logger.info('[sqlite] Таблица schema_version не найдена, инициализация...');
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const sql = await readMigrationSql(migration.file);

    ensureTransaction(db, () => {
      db.exec(sql);

      const appliedAt = Date.now();
      run('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);');
      run('INSERT INTO schema_version(version, name, applied_at) VALUES (?, ?, ?);', [
        migration.version,
        migration.name,
        appliedAt
      ]);
    });

    logger.info(
      `[sqlite] Применена миграция #${migration.version} (${migration.name}), версия схемы теперь ${migration.version}`
    );
    currentVersion = migration.version;
  }
}

async function initializeSqlite(options = {}) {
  const {
    filePath = DEFAULT_DB_FILE,
    log = logger
  } = options;

  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
  await fs.ensureDir(path.dirname(resolvedPath));

  const SQL = await loadSqlModule();

  const hasExistingFile = await fs.pathExists(resolvedPath);
  const fileBuffer = hasExistingFile ? await fs.readFile(resolvedPath) : null;
  const db = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');

  const persist = async () => {
    const data = db.export();
    await fs.writeFile(resolvedPath, Buffer.from(data));
  };

  const helpers = prepareHelpers(db);

  await applyMigrations(db, helpers);
  await persist();

  let transactionChain = Promise.resolve();

  const runInTransaction = callback => {
    const task = async () => {
      db.exec('BEGIN TRANSACTION;');
      const txHelpers = prepareHelpers(db);

      try {
        const result = await callback(txHelpers);
        db.exec('COMMIT;');
        await persist();
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK;');
        } catch (rollbackError) {
          log.error('Ошибка отката транзакции SQLite:', rollbackError);
        }
        throw error;
      }
    };

    transactionChain = transactionChain.then(task, task);
    return transactionChain;
  };

  const close = async () => {
    await persist();
    db.close();
  };

  return {
    db,
    ...helpers,
    runInTransaction,
    persist,
    close,
    path: resolvedPath
  };
}

module.exports = {
  initializeSqlite
};
