const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_SIDEBAR_WIDTH = 26;
const MIN_SIDEBAR_WIDTH = 16;
const MAX_SIDEBAR_WIDTH = 60;

function getConfigDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'cli-agent');
}

function getConfigFile() {
  return path.join(getConfigDir(), 'bookmarks.json');
}

function resolvePath(inputPath) {
  if (!inputPath) return process.cwd();
  let expanded = String(inputPath).trim();
  if (expanded === '~') {
    return os.homedir();
  }
  if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  return path.resolve(process.cwd(), expanded);
}

function shrinkPath(fullPath) {
  const home = os.homedir();
  if (fullPath === home) return '~';
  if (fullPath.startsWith(home + path.sep)) {
    return '~' + fullPath.slice(home.length);
  }
  return fullPath;
}

function clampWidth(width) {
  const n = Number(width);
  if (!Number.isFinite(n) || n < MIN_SIDEBAR_WIDTH || n > MAX_SIDEBAR_WIDTH) {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  return Math.round(n);
}

function getDefaultConfig() {
  return {
    version: 1,
    selectedIndex: 0,
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    switcherKey: 'C-e',
    bookmarks: [
      {
        id: 'default-1',
        name: 'Current Project',
        path: process.cwd(),
        agent: 'claude',
        createdAt: new Date().toISOString()
      }
    ],
    // Extra / overridden agents: { id, name, command, shortcut }
    agents: []
  };
}

function getBookmarkKey(bm) {
  if (!bm) return 'default';
  const raw = bm.id || bm.name || 'default';
  return String(raw).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Write JSON atomically: write to a temp file in the same directory, then
 * rename. Readers never observe a half-written file.
 */
function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

/** Keep a copy of an unreadable config so the user never loses data. */
function backupCorruptFile(file, raw) {
  const backup = `${file}.corrupt`;
  try {
    const existing = fs.existsSync(backup) ? fs.readFileSync(backup, 'utf-8') : null;
    if (existing !== raw) {
      fs.writeFileSync(backup, raw, 'utf-8');
      process.stderr.write(
        `cli-agent: ${file} is not valid JSON. A copy was saved to ${backup}. ` +
        'Fix the file or delete it to start fresh.\n'
      );
    }
  } catch (err) {
    // best effort
  }
}

function normalizeConfig(config) {
  let changed = false;
  if (!Array.isArray(config.bookmarks)) {
    config.bookmarks = [];
    changed = true;
  }
  config.bookmarks.forEach((bm, i) => {
    if (!bm.id) {
      bm.id = 'bm_' + i + '_' + Date.now().toString(36);
      changed = true;
    }
  });

  const width = clampWidth(config.sidebarWidth);
  if (width !== config.sidebarWidth) {
    config.sidebarWidth = width;
    changed = true;
  }
  return changed;
}

function loadConfig() {
  const file = getConfigFile();
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (raw === null) {
    // First run: create the default config.
    const def = getDefaultConfig();
    saveConfig(def);
    return def;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
  } catch (err) {
    // Never overwrite an unreadable config: back it up and work in memory.
    backupCorruptFile(file, raw);
    const def = getDefaultConfig();
    def.bookmarks = [];
    Object.defineProperty(def, '__corrupt', { value: true, enumerable: false });
    return def;
  }

  if (normalizeConfig(parsed)) {
    saveConfig(parsed);
  }
  return parsed;
}

function saveConfig(config) {
  if (config && config.__corrupt) {
    // Refuse to clobber a file the user may be fixing by hand.
    const file = getConfigFile();
    try {
      JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      return false;
    }
  }
  writeJsonAtomic(getConfigFile(), config);
  return true;
}

/** Update the config with a read-modify-write to minimise lost updates. */
function updateConfig(mutator) {
  const config = loadConfig();
  const result = mutator(config);
  saveConfig(config);
  return result;
}

function isPathInside(child, parent) {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Find a bookmark index by 1-based index, id, name (case-insensitive) or
 * filesystem path (the deepest bookmark containing that path).
 */
function findBookmarkIndex(bookmarks, target) {
  if (target === undefined || target === null || target === '') return -1;
  const str = String(target).trim();

  if (/^\d+$/.test(str)) {
    const n = parseInt(str, 10);
    if (n >= 1 && n <= bookmarks.length) return n - 1;
  }

  let idx = bookmarks.findIndex(b => b.id === str);
  if (idx !== -1) return idx;

  idx = bookmarks.findIndex(b => String(b.name).toLowerCase() === str.toLowerCase());
  if (idx !== -1) return idx;

  if (str.includes('/') || str === '.' || str.startsWith('~')) {
    const resolved = resolvePath(str);
    let best = -1;
    let bestLen = -1;
    bookmarks.forEach((b, i) => {
      if (b.path && isPathInside(resolved, b.path) && b.path.length > bestLen) {
        best = i;
        bestLen = b.path.length;
      }
    });
    return best;
  }
  return -1;
}

function findBookmark(config, target) {
  const idx = findBookmarkIndex(config.bookmarks, target);
  return idx === -1 ? null : config.bookmarks[idx];
}

function addBookmark(name, targetPath, agent = 'claude') {
  const resolved = resolvePath(targetPath);
  const newBookmark = {
    id: 'bm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: (name || path.basename(resolved) || 'New bookmark').trim(),
    path: resolved,
    agent: agent || 'claude',
    createdAt: new Date().toISOString()
  };

  updateConfig(config => {
    config.bookmarks.push(newBookmark);
    config.selectedIndex = config.bookmarks.length - 1;
  });
  return newBookmark;
}

/**
 * Remove a bookmark. Accepts a 0-based numeric index or any target accepted
 * by findBookmarkIndex (1-based index string, id, name, path).
 */
function removeBookmark(indexOrTarget) {
  return updateConfig(config => {
    const idx = typeof indexOrTarget === 'number'
      ? indexOrTarget
      : findBookmarkIndex(config.bookmarks, indexOrTarget);
    if (idx < 0 || idx >= config.bookmarks.length) return null;
    const removed = config.bookmarks.splice(idx, 1)[0];
    if (config.selectedIndex >= config.bookmarks.length) {
      config.selectedIndex = Math.max(0, config.bookmarks.length - 1);
    }
    return removed;
  });
}

function updateBookmark(index, updates) {
  return updateConfig(config => {
    if (index < 0 || index >= config.bookmarks.length) return null;
    const next = { ...updates };
    if (next.path) next.path = resolvePath(next.path);
    config.bookmarks[index] = { ...config.bookmarks[index], ...next };
    return config.bookmarks[index];
  });
}

function getRecentHistory() {
  const config = loadConfig();
  return Array.isArray(config.recentHistory) ? config.recentHistory : [];
}

function recordActiveSession(sessionId) {
  if (!sessionId) return;
  updateConfig(config => {
    const history = Array.isArray(config.recentHistory) ? config.recentHistory : [];
    config.recentHistory = [sessionId, ...history.filter(id => id !== sessionId)].slice(0, 20);
    config.activeBookmarkId = sessionId;
    const idx = config.bookmarks.findIndex(b => getBookmarkKey(b) === sessionId);
    if (idx !== -1) config.selectedIndex = idx;
  });
}

module.exports = {
  DEFAULT_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  clampWidth,
  getConfigDir,
  getConfigFile,
  resolvePath,
  shrinkPath,
  getBookmarkKey,
  writeJsonAtomic,
  loadConfig,
  saveConfig,
  updateConfig,
  findBookmarkIndex,
  findBookmark,
  addBookmark,
  removeBookmark,
  updateBookmark,
  getRecentHistory,
  recordActiveSession
};
