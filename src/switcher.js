const { loadConfig, getRecentHistory, getBookmarkKey } = require('./config');
const {
  switchToBookmark,
  getActiveBookmarkId,
  keyLabel,
  tabsOf,
  rememberedTab,
  recentTabs,
  tabLabelText,
  cellWidth,
  fitText
} = require('./tmux');
const { getAgentProcessNames } = require('./agents');
const {
  STATUS_TYPES,
  statusBadge,
  loadManualStatuses,
  getManualStatus,
  getSessionPanes,
  computeBookmarkStatus
} = require('./monitor');
const { colors, truncate, stripAnsi, drawLine, paint, hideCursor, showCursor } = require('./ui');

const MAX_ITEMS = 9;

/**
 * Pick the row pre-selected when opening the switcher: the last used tab
 * (so Ctrl+E -> Enter toggles between the last 2 tabs), falling back to the
 * previous bookmark when no other open tab exists yet.
 */
function findInitialSelection(rows, recentTabIds = []) {
  const activeTab = rows.find(r => r.type === 'tab' && r.tab && r.tab.visible);
  const activePaneId = activeTab ? activeTab.tab.paneId : null;

  for (const paneId of recentTabIds) {
    if (paneId === activePaneId) continue;
    const idx = rows.findIndex(r => r.type === 'tab' && r.tab && r.tab.paneId === paneId);
    if (idx !== -1) return { index: idx, previousTabId: paneId };
  }

  const prevBookmark = rows.findIndex(r => r.type === 'bookmark' && r.index === 1);
  if (prevBookmark !== -1) return { index: prevBookmark, previousTabId: null };

  const otherTab = rows.findIndex(r => r.type === 'tab' && r.tab && r.tab.paneId !== activePaneId);
  if (otherTab !== -1) return { index: otherTab, previousTabId: rows[otherTab].tab.paneId };

  return { index: 0, previousTabId: null };
}

class SwitcherApp {
  constructor(deps = {}) {
    this.config = deps.config || loadConfig();
    this.bookmarks = this.config.bookmarks || [];
    this.recentHistory = deps.recentHistory || getRecentHistory();
    this.recentTabs = deps.recentTabs || recentTabs();
    this.activeId = deps.activeId !== undefined ? deps.activeId : getActiveBookmarkId();
    this.deps = {
      getSessionPanes: deps.getSessionPanes || getSessionPanes,
      loadManualStatuses: deps.loadManualStatuses || loadManualStatuses,
      rememberedTab: deps.rememberedTab || rememberedTab,
      switchToBookmark: deps.switchToBookmark || switchToBookmark
    };

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
    const initial = findInitialSelection(this.rows, this.recentTabs);
    this.selectedIndex = initial.index;
    this.previousTabId = initial.previousTabId;
    this.scroll = 0;
  }

  /**
   * One row per bookmark followed by one row per open tab. Statuses are
   * computed once (not on every key press).
   */
  buildRows() {
    const rows = [];
    const manual = this.deps.loadManualStatuses();
    const agentNames = getAgentProcessNames(this.config);
    const { panes } = this.deps.getSessionPanes();
    this.items.forEach((bm, index) => {
      const key = getBookmarkKey(bm);
      const tabs = tabsOf([...(panes.get(key) || [])], key);
      const entry = getManualStatus(manual, key) || getManualStatus(manual, bm.name);
      const { status, tabStatuses } = computeBookmarkStatus(tabs, entry, agentNames, 15);
      this.statuses[key] = status;
      rows.push({ type: 'bookmark', bm, index });
      // The tab shown when switching to this bookmark
      const current = key === this.activeId ? (tabs.find(t => t.visible) || {}).paneId : this.deps.rememberedTab(key);
      tabs.forEach((tab, n) => {
        rows.push({
          type: 'tab',
          bm,
          tab,
          n,
          last: n === tabs.length - 1,
          isCurrent: tab.paneId === current,
          label: tabLabelText(tab, bm.path),
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
    if (row && row.type === 'tab') this.deps.switchToBookmark(row.bm, '', true, row.tab.paneId);
    else if (row) this.deps.switchToBookmark(row.bm, '', true);
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
    else if (!this.previousTabId && index === 1) tag = `${colors.brightCyan}(previous)${colors.reset}`;
    const badge = statusBadge(this.statuses[key] || STATUS_TYPES.IDLE);
    const name = truncate(bm.name, 22).padEnd(23);
    return isSelected
      ? `${colors.brightGreen} ▶ ${index + 1}. ${colors.bold}${name}${colors.reset} ${badge} ${tag}`
      : `   ${colors.dim}${index + 1}.${colors.reset} ${name} ${badge} ${tag}`;
  }

  tabLine(row, isSelected, width = 62) {
    const branch = row.last ? '└' : '├';
    const badge = row.status.id === STATUS_TYPES.IDLE.id ? '' : ` ${statusBadge(row.status)}`;
    const mark = row.isCurrent ? ` ${colors.gray}●${colors.reset}` : '';
    const prev = this.previousTabId && row.tab.paneId === this.previousTabId
      ? ` ${colors.brightCyan}(previous)${colors.reset}`
      : '';
    const suffixLen = cellWidth(stripAnsi(`${badge}${mark}${prev}`));
    const padTarget = Math.min(35, Math.max(9, width - 9 - suffixLen));
    const labelMax = Math.max(8, Math.min(34, padTarget - 1));
    const truncated = fitText(`${row.n + 1} ${row.label}`, labelMax);
    const label = truncated + ' '.repeat(Math.max(0, padTarget - cellWidth(truncated)));
    return isSelected
      ? `${colors.brightGreen} ▶    ${branch} ${colors.bold}${label}${colors.reset}${badge}${mark}${prev}`
      : `      ${colors.gray}${branch}${colors.reset} ${label}${badge}${mark}${prev}`;
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
      lines.push(row.type === 'tab' ? this.tabLine(row, isSelected, width) : this.bookmarkLine(row, isSelected));
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

module.exports = { SwitcherApp, runSwitcher, findInitialSelection };

if (require.main === module) {
  runSwitcher();
}
