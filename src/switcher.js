const { loadConfig, getRecentHistory, getBookmarkKey } = require('./config');
const { switchToBookmark, getActiveBookmarkId, keyLabel, tabsOf, rememberedTab } = require('./tmux');
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

    this.items = ordered.slice(0, MAX_ITEMS);
    this.statuses = {};
    this.rows = this.buildRows();
    // Like IntelliJ: pre-select the previous session
    const previous = this.rows.findIndex(r => r.type === 'bookmark' && r.index === 1);
    this.selectedIndex = previous === -1 ? 0 : previous;
    this.scroll = 0;
  }

  /**
   * One row per bookmark followed by one row per open tab. Statuses are
   * computed once (not on every key press).
   */
  buildRows() {
    const rows = [];
    const manual = loadManualStatuses();
    const agentNames = getAgentProcessNames(this.config);
    const { panes } = getSessionPanes();
    this.items.forEach((bm, index) => {
      const key = getBookmarkKey(bm);
      const tabs = tabsOf([...(panes.get(key) || [])], key);
      const entry = getManualStatus(manual, key) || getManualStatus(manual, bm.name);
      const { status, tabStatuses } = computeBookmarkStatus(tabs, entry, agentNames, 15);
      this.statuses[key] = status;
      rows.push({ type: 'bookmark', bm, index });
      // The tab shown when switching to this bookmark
      const current = key === this.activeId ? (tabs.find(t => t.visible) || {}).paneId : rememberedTab(key);
      tabs.forEach((tab, n) => {
        rows.push({
          type: 'tab',
          bm,
          tab,
          n,
          last: n === tabs.length - 1,
          isCurrent: tab.paneId === current,
          status: tabStatuses.get(tab.paneId) || STATUS_TYPES.IDLE
        });
      });
    });
    return rows;
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
    process.stdout.on('resize', () => this.render());
    process.on('SIGINT', () => this.exit());
    process.on('SIGTERM', () => this.exit());
    process.on('exit', () => showCursor());

    this.render();
  }

  exit() {
    showCursor();
    process.exit(0);
  }

  choose(row) {
    if (row && row.type === 'tab') switchToBookmark(row.bm, '', true, row.tab.paneId);
    else if (row) switchToBookmark(row.bm, '', true);
    this.exit();
  }

  move(delta) {
    const count = this.rows.length;
    this.selectedIndex = (this.selectedIndex + delta + count) % count;
    this.render();
  }

  handleKey(key) {
    if (key === '\x1b' || key === 'q' || key === 'Q') return this.exit();

    // Ctrl+E (\x05) or Alt+E (\x1be): cycle selection (bookmarks and tabs)
    if (key === '\x05' || key === '\x1be' || key === '\x1b[B' || key === 'j' || key === '\t') return this.move(1);
    if (key === '\x1b[A' || key === 'k' || key === '\x1b[Z') return this.move(-1);
    if (key === '\r' || key === '\n') return this.choose(this.rows[this.selectedIndex]);

    if (key >= '1' && key <= '9' && key.length === 1) {
      const idx = parseInt(key, 10) - 1;
      const row = this.rows.find(r => r.type === 'bookmark' && r.index === idx);
      if (row) return this.choose(row);
    }
    return undefined;
  }

  bookmarkLine(row, isSelected) {
    const { bm, index } = row;
    const key = getBookmarkKey(bm);
    let tag = '';
    if (key === this.activeId) tag = `${colors.gray}(current)${colors.reset}`;
    else if (index === 1) tag = `${colors.brightCyan}(previous)${colors.reset}`;
    const badge = statusBadge(this.statuses[key] || STATUS_TYPES.IDLE);
    const name = truncate(bm.name, 22).padEnd(23);
    return isSelected
      ? `${colors.brightGreen} ▶ ${index + 1}. ${colors.bold}${name}${colors.reset} ${badge} ${tag}`
      : `   ${colors.dim}${index + 1}.${colors.reset} ${name} ${badge} ${tag}`;
  }

  tabLine(row, isSelected) {
    const branch = row.last ? '└' : '├';
    const label = truncate(`${row.n + 1} ${row.tab.command || 'shell'}`, 20).padEnd(21);
    const badge = row.status.id === STATUS_TYPES.IDLE.id ? '' : ` ${statusBadge(row.status)}`;
    const mark = row.isCurrent ? ` ${colors.gray}●${colors.reset}` : '';
    return isSelected
      ? `${colors.brightGreen} ▶    ${branch} ${colors.bold}${label}${colors.reset}${badge}${mark}`
      : `      ${colors.gray}${branch}${colors.reset} ${label}${badge}${mark}`;
  }

  render() {
    const width = Math.max(30, process.stdout.columns || 52);
    const height = Math.max(6, process.stdout.rows || 15);
    const switcherKey = keyLabel(this.config.switcherKey || 'C-e');
    const lines = [];

    lines.push(`${colors.bold}${colors.brightCyan} ⚡ RECENT SESSIONS${colors.reset}`);
    lines.push(`${colors.dim}${colors.gray}${drawLine(width - 2)}${colors.reset}`);

    // Scroll so the selected row stays visible
    const room = Math.max(1, height - 4);
    if (this.selectedIndex < this.scroll) this.scroll = this.selectedIndex;
    if (this.selectedIndex >= this.scroll + room) this.scroll = this.selectedIndex - room + 1;
    const visible = this.rows.slice(this.scroll, this.scroll + room);
    visible.forEach((row, i) => {
      const isSelected = this.scroll + i === this.selectedIndex;
      lines.push(row.type === 'tab' ? this.tabLine(row, isSelected) : this.bookmarkLine(row, isSelected));
    });

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
