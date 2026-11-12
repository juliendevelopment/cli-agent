const fs = require('fs');
const path = require('path');
const os = require('os');

function getConfigDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'cli-agent');
}

function getConfigFile() {
  return path.join(getConfigDir(), 'bookmarks.json');
}

function resolvePath(inputPath) {
  if (!inputPath) return process.cwd();
  let expanded = inputPath.trim();
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

function getDefaultConfig() {
  const currentDir = process.cwd();
  return {
    version: 1,
    selectedIndex: 0,
    bookmarks: [
      {
        id: 'default-1',
        name: 'Current Project',
        path: currentDir,
        agent: 'claude',
        createdAt: new Date().toISOString()
      }
    ],
    agents: [
      { id: 'claude', name: 'Claude Code', command: 'claude' },
      { id: 'copilot', name: 'Copilot CLI', command: 'copilot' },
      { id: 'shell', name: 'Terminal Shell', command: '' }
    ]
  };
}

function loadConfig() {
  const file = getConfigFile();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.bookmarks)) {
        parsed.bookmarks = [];
      }
      return parsed;
    }
  } catch (err) {
    // Return default on parse failure
  }

  const def = getDefaultConfig();
  saveConfig(def);
  return def;
}

function saveConfig(config) {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const file = getConfigFile();
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8');
}

function addBookmark(name, targetPath, agent = 'claude') {
  const config = loadConfig();
  const resolved = resolvePath(targetPath);
  const newBookmark = {
    id: 'bm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: (name || path.basename(resolved) || 'Nouveau signet').trim(),
    path: resolved,
    agent: agent || 'claude',
    createdAt: new Date().toISOString()
  };

  config.bookmarks.push(newBookmark);
  config.selectedIndex = config.bookmarks.length - 1;
  saveConfig(config);
  return newBookmark;
}

function removeBookmark(indexOrId) {
  const config = loadConfig();
  if (typeof indexOrId === 'number') {
    if (indexOrId >= 0 && indexOrId < config.bookmarks.length) {
      const removed = config.bookmarks.splice(indexOrId, 1)[0];
      if (config.selectedIndex >= config.bookmarks.length) {
        config.selectedIndex = Math.max(0, config.bookmarks.length - 1);
      }
      saveConfig(config);
      return removed;
    }
  } else {
    const idx = config.bookmarks.findIndex(b => b.id === indexOrId);
    if (idx !== -1) {
      const removed = config.bookmarks.splice(idx, 1)[0];
      if (config.selectedIndex >= config.bookmarks.length) {
        config.selectedIndex = Math.max(0, config.bookmarks.length - 1);
      }
      saveConfig(config);
      return removed;
    }
  }
  return null;
}

function updateBookmark(index, updates) {
  const config = loadConfig();
  if (index >= 0 && index < config.bookmarks.length) {
    if (updates.path) {
      updates.path = resolvePath(updates.path);
    }
    config.bookmarks[index] = {
      ...config.bookmarks[index],
      ...updates
    };
    saveConfig(config);
    return config.bookmarks[index];
  }
  return null;
}

function getRecentHistory() {
  const config = loadConfig();
  if (!Array.isArray(config.recentHistory)) {
    config.recentHistory = [];
  }
  return config.recentHistory;
}

function recordActiveSession(sessionId) {
  if (!sessionId) return;
  const config = loadConfig();
  if (!Array.isArray(config.recentHistory)) {
    config.recentHistory = [];
  }
  config.recentHistory = config.recentHistory.filter(id => id !== sessionId);
  config.recentHistory.unshift(sessionId);
  config.recentHistory = config.recentHistory.slice(0, 20);
  config.activeBookmarkId = sessionId;
  saveConfig(config);
}

module.exports = {
  getConfigDir,
  getConfigFile,
  resolvePath,
  shrinkPath,
  loadConfig,
  saveConfig,
  addBookmark,
  removeBookmark,
  updateBookmark,
  getRecentHistory,
  recordActiveSession
};
