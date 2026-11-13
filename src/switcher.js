const { loadConfig, getRecentHistory, getBookmarkKey } = require('./config');
const { switchToBookmark, getActiveBookmarkId, keyLabel } = require('./tmux');
const { getAgentProcessNames } = require('./agents');
const {
  STATUS_TYPES,
  statusBadge,
  loadManualStatuses,
  getManualStatus,
  getSessionPanes,
  computeBookmarkStatus
} = require('./monitor');
const { colors, truncate, drawLine, paint, hideCursor, showCursor } = require('./ui');

const MAX_ITEMS = 9;

class SwitcherApp {
  constructor() {
    this.config = loadConfig();
    this.bookmarks = this.config.bookmarks || [];
    this.recentHistory = getRecentHistory();
    this.activeId = getActiveBookmarkId();

    const ordered = [];
    const seen = new Set();
    const push = bm => {
      const k = getBookmarkKey(bm);
      if (!seen.has(k)) {
        ordered.push(bm);
        seen.add(k);
      }
    };

    // 1. Current session first, 2. recent history, 3. everything else
    const active = this.bookmarks.find(b => getBookmarkKey(b) === this.activeId);
    if (active) push(active);
    for (const id of this.recentHistory) {
      const found = this.bookmarks.find(b => getBookmarkKey(b) === id);
      if (found) push(found);
    }
    this.bookmarks.forEach(push);

    this.items = ordered;
    // Like IntelliJ: pre-select the previous session
    this.selectedIndex = this.items.length > 1 ? 1 : 0;
    this.statuses = this.computeStatuses();
  }

  /** Compute statuses once (not on every key press). */
  computeStatuses() {
    const statuses = {};
    const manual = loadManualStatuses();
    const agentNames = getAgentProcessNames(this.config);
    const { panes } = getSessionPanes();
    for (const bm of this.items.slice(0, MAX_ITEMS)) {
      const key = getBookmarkKey(bm);
      const entry = getManualStatus(manual, key) || getManualStatus(manual, bm.name);
      statuses[key] = computeBookmarkStatus(panes.get(key), entry, agentNames, 15).status;
    }
    return statuses;
  }

  start() {
    if (this.items.length === 0) {
      process.exit(0);
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    hideCursor();

    process.stdin.on('data', chunk => this.handleKey(chunk));
    process.on('SIGINT', () => this.exit());
    process.on('SIGTERM', () => this.exit());
    process.on('exit', () => showCursor());

    this.render();
  }

  exit() {
    showCursor();
    process.exit(0);
  }

  choose(index) {
    const chosen = this.items[index];
    if (chosen) switchToBookmark(chosen, '', true);
    this.exit();
  }

  handleKey(key) {
    const count = Math.min(this.items.length, MAX_ITEMS);
    if (key === '\x1b' || key === 'q' || key === 'Q') return this.exit();

    // Ctrl+E (\x05) or Alt+E (\x1be): cycle selection
    if (key === '\x05' || key === '\x1be' || key === '\x1b[B' || key === 'j' || key === '\t') {
      this.selectedIndex = (this.selectedIndex + 1) % count;
      return this.render();
    }
    if (key === '\x1b[A' || key === 'k') {
      this.selectedIndex = (this.selectedIndex - 1 + count) % count;
      return this.render();
    }
    if (key === '\r' || key === '\n') return this.choose(this.selectedIndex);

    if (key >= '1' && key <= '9' && key.length === 1) {
      const idx = parseInt(key, 10) - 1;
      if (idx < count) return this.choose(idx);
    }
    return undefined;
  }

  render() {
    const width = Math.max(30, process.stdout.columns || 52);
    const switcherKey = keyLabel(this.config.switcherKey || 'C-e');
    const lines = [];

    lines.push(`${colors.bold}${colors.brightCyan} ⚡ RECENT SESSIONS${colors.reset}`);
    lines.push(`${colors.dim}${colors.gray}${drawLine(width - 2)}${colors.reset}`);

    const count = Math.min(this.items.length, MAX_ITEMS);
    for (let i = 0; i < count; i++) {
      const bm = this.items[i];
      const isSelected = i === this.selectedIndex;
      const key = getBookmarkKey(bm);
      let tag = '';
      if (key === this.activeId) tag = `${colors.gray}(current)${colors.reset}`;
      else if (i === 1) tag = `${colors.brightCyan}(previous)${colors.reset}`;

      const badge = statusBadge(this.statuses[key] || STATUS_TYPES.IDLE);
      const name = truncate(bm.name, 20).padEnd(21);

      if (isSelected) {
        lines.push(`${colors.brightGreen} ▶ ${i + 1}. ${colors.bold}${name}${colors.reset} ${badge} ${tag}`);
      } else {
        lines.push(`   ${colors.dim}${i + 1}.${colors.reset} ${name} ${badge} ${tag}`);
      }
    }

    lines.push(`${colors.dim}${colors.gray}${drawLine(width - 2)}${colors.reset}`);
    lines.push(`${colors.dim} [Enter/1-9] Switch │ [${switcherKey}/↑↓] Move │ [Esc] Close${colors.reset}`);

    paint(lines);
  }
}

function runSwitcher() {
  const app = new SwitcherApp();
  app.start();
}

module.exports = { SwitcherApp, runSwitcher };

if (require.main === module) {
  runSwitcher();
}
