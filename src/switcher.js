const { loadConfig, getRecentHistory, recordActiveSession, shrinkPath } = require('./config');
const { switchToBookmark, getActiveBookmarkId } = require('./tmux');
const {
  STATUS_TYPES,
  loadManualStatuses,
  getPaneOutputForBookmark,
  getPaneProcessForBookmark,
  detectTerminalStatus
} = require('./monitor');
const { colors, truncate, padRight, drawLine, clearScreen, hideCursor, showCursor } = require('./ui');

class SwitcherApp {
  constructor() {
    this.config = loadConfig();
    this.bookmarks = this.config.bookmarks || [];
    this.recentHistory = getRecentHistory();
    this.manualStatuses = loadManualStatuses();

    // Order bookmarks by recency
    const ordered = [];
    const seen = new Set();

    for (const id of this.recentHistory) {
      const found = this.bookmarks.find(b => (b.id || b.name) === id);
      if (found && !seen.has(found.id || found.name)) {
        ordered.push(found);
        seen.add(found.id || found.name);
      }
    }
    for (const b of this.bookmarks) {
      const key = b.id || b.name;
      if (!seen.has(key)) {
        ordered.push(b);
        seen.add(key);
      }
    }

    this.items = ordered;

    // Like IntelliJ: pre-select index 1 (the PREVIOUS session) if available!
    if (this.items.length > 1) {
      this.selectedIndex = 1;
    } else {
      this.selectedIndex = 0;
    }
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
    process.on('exit', () => {
      showCursor();
    });

    this.render();
  }

  exit() {
    showCursor();
    process.exit(0);
  }

  handleKey(key) {
    if (key === '\u001b' || key === 'q' || key === 'Q') {
      // Escape or q: close popup
      this.exit();
      return;
    }

    // Ctrl+E (\x05) or Alt+E (\x1be): cycle selection
    if (key === '\x05' || key === '\u001be') {
      this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
      this.render();
      return;
    }

    // Enter
    if (key === '\r' || key === '\n') {
      const chosen = this.items[this.selectedIndex];
      if (chosen) {
        switchToBookmark(chosen, '', true);
      }
      this.exit();
      return;
    }

    // Arrows
    if (key === '\u001b[A' || key === 'k') {
      // Up
      this.selectedIndex = (this.selectedIndex - 1 + this.items.length) % this.items.length;
      this.render();
      return;
    }

    if (key === '\u001b[B' || key === 'j') {
      // Down
      this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
      this.render();
      return;
    }

    // Number keys 1-9
    if (key >= '1' && key <= '9') {
      const idx = parseInt(key, 10) - 1;
      if (idx < this.items.length) {
        const chosen = this.items[idx];
        if (chosen) {
          switchToBookmark(chosen, '', true);
        }
        this.exit();
        return;
      }
    }
  }

  getLiveStatus(bm) {
    const key = bm.id || bm.name;
    if (this.manualStatuses[key]) {
      const s = this.manualStatuses[key].status;
      return Object.values(STATUS_TYPES).find(t => t.id === s) || STATUS_TYPES.IDLE;
    }
    const activeId = getActiveBookmarkId() || this.recentHistory[0];
    const paneOutput = getPaneOutputForBookmark(key, activeId, 15);
    const procInfo = getPaneProcessForBookmark(key, activeId);
    return detectTerminalStatus(paneOutput, procInfo);
  }

  render() {
    const width = Math.max(30, process.stdout.columns || 52);
    const lines = [];

    lines.push(`${colors.bold}${colors.brightCyan} ⚡ RECENT SESSIONS (Ctrl+E)${colors.reset}`);
    lines.push(`${colors.dim}${colors.gray}${drawLine(width - 2, '─')}${colors.reset}`);

    const maxItems = Math.min(this.items.length, 8);
    for (let i = 0; i < maxItems; i++) {
      const bm = this.items[i];
      const isSelected = i === this.selectedIndex;
      const num = `${i + 1}.`;
      const isCurrent = i === 0;
      const isPrevious = i === 1 && this.items.length > 1;

      let tag = '';
      if (isCurrent) {
        tag = `${colors.gray}(Current)${colors.reset}`;
      } else if (isPrevious) {
        tag = `${colors.brightCyan}(Previous)${colors.reset}`;
      }

      const status = this.getLiveStatus(bm);
      let statusIcon = '';
      if (status.id === STATUS_TYPES.INPUT_REQUIRED.id) {
        statusIcon = `\x1b[43;30m${colors.bold} 🔔 ACTION \x1b[0m`;
      } else if (status.id === STATUS_TYPES.RUNNING.id) {
        statusIcon = `\x1b[46;30m${colors.bold} ⚡ RUN \x1b[0m`;
      } else if (status.id === STATUS_TYPES.DONE.id) {
        statusIcon = `${colors.brightGreen}✓ Done${colors.reset}`;
      } else if (status.id === STATUS_TYPES.ERROR.id) {
        statusIcon = `\x1b[41;37m${colors.bold} ✗ ERR \x1b[0m`;
      } else {
        statusIcon = `${colors.gray}● Idle${colors.reset}`;
      }

      const agent = `${colors.dim}[${bm.agent || 'claude'}]${colors.reset}`;
      const name = truncate(bm.name, 18).padEnd(19);

      if (isSelected) {
        lines.push(`${colors.brightGreen} ▶ ${num} ${colors.bold}${name}${colors.reset} ${agent} ${statusIcon} ${tag}`);
      } else {
        lines.push(`   ${colors.dim}${num}${colors.reset} ${name} ${agent} ${statusIcon} ${tag}`);
      }
    }

    lines.push(`${colors.dim}${colors.gray}${drawLine(width - 2, '─')}${colors.reset}`);
    lines.push(`${colors.dim} [Enter] Switch │ [Ctrl+E/↑↓] Choose │ [Esc] Close${colors.reset}`);

    clearScreen();
    process.stdout.write(lines.join('\n'));
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
