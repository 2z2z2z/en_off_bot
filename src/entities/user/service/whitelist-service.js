const ROLE = {
  ADMIN: 'admin',
  USER: 'user'
};

function createWhitelistService(deps) {
  const { adminConfig, saveAdminConfig, whitelistCache } = deps;

  function ensureWhitelistArray() {
    if (!Array.isArray(adminConfig.whitelist)) {
      adminConfig.whitelist = [];
    }
    return adminConfig.whitelist;
  }

  function getEntries() {
    return ensureWhitelistArray();
  }

  function findEntry(login) {
    const normalized = normalizeLogin(login);
    return getEntries().find(entry => entry.login.toLowerCase() === normalized);
  }

  function normalizeLogin(login) {
    return String(login || '').trim().toLowerCase();
  }

  function addEntry({ login, role = ROLE.USER, addedBy }) {
    const normalized = normalizeLogin(login);
    if (!normalized) {
      throw new Error('Login cannot be empty');
    }

    if (findEntry(normalized)) {
      throw new Error(`Login ${normalized} already in whitelist`);
    }

    const entry = {
      login: normalized,
      role,
      addedBy,
      addedAt: Date.now()
    };

    ensureWhitelistArray().push(entry);
    whitelistCache.add(normalized);
    return entry;
  }

  function removeEntry(login) {
    const normalized = normalizeLogin(login);
    const whitelist = ensureWhitelistArray();
    const index = whitelist.findIndex(entry => entry.login === normalized);
    if (index === -1) {
      throw new Error('Entry not found');
    }

    whitelist.splice(index, 1);
    whitelistCache.delete(normalized);
  }

  function listEntries() {
    return getEntries();
  }

  function hasAccess(login) {
    if (!adminConfig.moderationEnabled) {
      return true;
    }

    if (!login) {
      return false;
    }

    return whitelistCache.has(normalizeLogin(login));
  }

  async function save() {
    await saveAdminConfig();
  }

  return {
    addEntry,
    removeEntry,
    listEntries,
    hasAccess,
    save,
    ROLE
  };
}

function createWhitelistServiceWithConfig({ getAdminConfig, saveAdminConfig, getWhitelistCache }) {
  return createWhitelistService({
    adminConfig: getAdminConfig(),
    saveAdminConfig,
    whitelistCache: getWhitelistCache()
  });
}

module.exports = {
  createWhitelistService,
  createWhitelistServiceWithConfig,
  ROLE
};
