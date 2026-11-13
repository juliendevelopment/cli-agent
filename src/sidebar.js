const fs = require('fs');
const path = require('path');
const {
  loadConfig,
  updateConfig,
  getConfigDir,
  addBookmark,
  removeBookmark,
  updateBookmark,
  getBookmarkKey,
  resolvePath,
  shrinkPath,
  clampWidth
} = require('./config');
const { getAgentsWithStatus, getAgentProcessNames } = require('./agents');
const {
  switchToBookmark,
  closeBookmarkSession,
  getActiveBookmarkId,
  setActiveBookmarkId,
  getMainWindowPaneCount,
  ensureTerminalPane,
  newTab,
  refreshTabBar,
  setPaneStatus,
  newTabKeyOf,
  resizeSidebar,
  setSidebarWidth,
  getPaneWidths,
  focusPane,
  setStatusRight,
  statusRight,
  killSession
} = require('./tmux');
const {
  STATUS_TYPES,
  statusBadge,
  loadManualStatuses,
  clearManualStatus,
  getManualStatus,
  getSessionPanes,
  computeBookmarkStatus,
  getGitInfoAsync
} = require('./monitor');
const { colors, truncate, drawLine, paint, hideCursor, showCursor, visibleLength } = require('./ui');
const { VERSION } = require('./version');

const MONITOR_INTERVAL_MS = 1500;
const GIT_INTERVAL_MS = 6000;
const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1000l\x1b[?1002l\x1b[?1006l';

class SidebarApp {
  constructor() {
    this.config = loadConfig();
    this.selectedIndex = this.clampIndex(this.config.selectedIndex || 0);
    this.mode = 'normal'; // normal | add | edit | delete_confirm | select_agent | quit_confirm
    this.inputPrompt = '';
    this.inputValue = '';
    this.inputStep = 0;
    this.inputTemp = {};
    this.statusMessage = '';
    this.statusTimer = null;
    this.monitorTimer = null;
    this.reloadAgents();

    this.bookmarkStatuses = {};
    this.gitInfoCache = {};
    this.lastGitCheck = 0;
    this.gitInFlight = 0;
    this.hasActiveAlert = false;
    this.lastActiveId = null;
    this.rowMap = {};
    this.tabCounts = {};
    this.paneStatusCache = {};
    this.missingTerminalTicks = 0;

    this.widthPresets = [24, 30, 38];
    this.widthPresetIndex = 0;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start() {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    hideCursor();
    process.stdout.write(MOUSE_ON);
    setSidebarWidth(this.config.sidebarWidth);

    process.stdin.on('data', chunk => this.handleInput(chunk));
    process.stdout.on('resize', () => this.handleResize());

    process.on('SIGINT', () => this.exit());
    process.on('SIGTERM', () => this.exit());
    process.on('exit', () => {
      showCursor();
      process.stdout.write(MOUSE_OFF);
      if (this.monitorTimer) clearInterval(this.monitorTimer);
      if (this.configWatcher) this.configWatcher.close();
    });

    this.watchConfigDir();

    const current = this.getCurrentBookmark();
    if (current && !getActiveBookmarkId()) {
      setActiveBookmarkId(getBookmarkKey(current));
    }

    this.monitorTimer = setInterval(() => this.runMonitorCheck(), MONITOR_INTERVAL_MS);
    this.setStatus('Ready. ↑/↓ to navigate, Enter to open.');
    this.runMonitorCheck(true);
  }

  /** Watch the config directory (robust to atomic renames). */
  watchConfigDir() {
    try {
      const dir = getConfigDir();
      fs.mkdirSync(dir, { recursive: true });
      this.configWatcher = fs.watch(dir, (event, filename) => {
        if (filename !== 'bookmarks.json' && filename !== 'statuses.json') return;
        clearTimeout(this.watchDebounce);
        this.watchDebounce = setTimeout(() => {
          if (filename === 'bookmarks.json') this.reloadConfig();
          this.runMonitorCheck(true);
        }, 120);
      });
    } catch (err) {
      // fs.watch unsupported: the periodic monitor still runs.
    }
  }

  reloadConfig() {
    this.config = loadConfig();
    this.selectedIndex = this.clampIndex(this.selectedIndex);
    this.reloadAgents();
  }

  reloadAgents() {
    this.agents = getAgentsWithStatus(this.config);
    this.agentNames = getAgentProcessNames(this.config);
    this.agentByShortcut = {};
    for (const agent of this.agents) {
      if (agent.shortcut) this.agentByShortcut[agent.shortcut] = agent;
    }
  }

  clampIndex(index) {
    const max = Math.max(0, (this.config.bookmarks || []).length - 1);
    return Math.min(Math.max(0, index || 0), max);
  }

  exit() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.saveWidthTimer) clearTimeout(this.saveWidthTimer);

    const realWidth = this.getRealSidebarWidth();
    if (realWidth) {
      try {
        updateConfig(config => { config.sidebarWidth = realWidth; });
      } catch (err) {
        // ignore
      }
    }

    showCursor();
    process.stdout.write(`${MOUSE_OFF}\x1b[2J\x1b[H`);
    killSession();
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Monitoring
  // -------------------------------------------------------------------------

  findBookmarkByKey(key) {
    return this.config.bookmarks.find(b => getBookmarkKey(b) === key) || null;
  }

  runMonitorCheck(forceRender = false) {
    let changed = false;

    // The visible tab was closed (user typed `exit`): the pane-exited hook shows
    // the next tab. Fallback if it did not run: same thing, one tick later.
    const paneCount = getMainWindowPaneCount();
    if (paneCount >= 2) {
      this.seenTerminalPane = true;
      this.missingTerminalTicks = 0;
    } else if (paneCount === 1 && this.seenTerminalPane && ++this.missingTerminalTicks >= 2) {
      this.missingTerminalTicks = 0;
      if (ensureTerminalPane()) this.setStatus('Terminal restarted.');
    }

    const activeId = getActiveBookmarkId() || (this.getCurrentBookmark() ? getBookmarkKey(this.getCurrentBookmark()) : null);

    // Active session changed elsewhere (e.g. Ctrl+E switcher): follow it.
    if (activeId && activeId !== this.lastActiveId) {
      this.lastActiveId = activeId;
      this.reloadConfig();
      const idx = this.config.bookmarks.findIndex(b => getBookmarkKey(b) === activeId);
      if (idx !== -1) this.selectedIndex = idx;
      changed = true;
    }

    // 1. Statuses: one tmux call for all panes, one capture per tab
    const manual = loadManualStatuses();
    const { panes, all } = getSessionPanes();
    for (const bm of this.config.bookmarks) {
      const key = getBookmarkKey(bm);
      const tabs = panes.get(key) || [];
      const manualEntry = getManualStatus(manual, key) || getManualStatus(manual, bm.name);
      const { status, tabStatuses } = computeBookmarkStatus(tabs, manualEntry, this.agentNames);
      for (const tab of tabs) this.updatePaneStatus(tab, tabStatuses.get(tab.paneId));
      if (this.tabCounts[key] !== tabs.length) {
        this.tabCounts[key] = tabs.length;
        changed = true;
      }
      const prev = this.bookmarkStatuses[key];
      if (!prev || prev.id !== status.id) {
        this.bookmarkStatuses[key] = status;
        changed = true;
      }
    }

    // Tab bar: names follow the running command, icons follow the status
    refreshTabBar(all);

    // 2. Git info, asynchronously (never blocks key handling)
    const now = Date.now();
    if (now - this.lastGitCheck > GIT_INTERVAL_MS && this.gitInFlight === 0) {
      this.lastGitCheck = now;
      this.refreshGitInfo();
    }

    // 3. tmux status bar alert
    const anyInputRequired = this.config.bookmarks.some(bm => {
      const s = this.bookmarkStatuses[getBookmarkKey(bm)];
      return s && s.id === STATUS_TYPES.INPUT_REQUIRED.id;
    });
    if (anyInputRequired !== this.hasActiveAlert) {
      this.hasActiveAlert = anyInputRequired;
      setStatusRight(statusRight(this.config.switcherKey || 'C-e', anyInputRequired, newTabKeyOf(this.config)));
      changed = true;
    }

    if (changed || forceRender) this.render();
  }

  /** Store a tab's status on its tmux pane (read by the tab bar). */
  updatePaneStatus(tab, status) {
    const id = status && status.id !== STATUS_TYPES.IDLE.id ? status.id : '';
    if (this.paneStatusCache[tab.paneId] !== id) {
      this.paneStatusCache[tab.paneId] = id;
      setPaneStatus(tab.paneId, id);
    }
    tab.status = id;
  }

  refreshGitInfo() {
    for (const bm of this.config.bookmarks) {
      const key = getBookmarkKey(bm);
      this.gitInFlight++;
      getGitInfoAsync(bm.path, git => {
        this.gitInFlight--;
        const prev = this.gitInfoCache[key];
        const prevSummary = prev ? prev.summary : null;
        const nextSummary = git ? git.summary : null;
        if (git) this.gitInfoCache[key] = git;
        else delete this.gitInfoCache[key];
        if (prevSummary !== nextSummary && this.mode === 'normal') this.render();
      });
    }
  }

  // -------------------------------------------------------------------------
  // Status line & sizing
  // -------------------------------------------------------------------------

  setStatus(msg, timeoutMs = 3500) {
    this.statusMessage = msg;
    if (this.statusTimer) clearTimeout(this.statusTimer);
    if (timeoutMs > 0) {
      this.statusTimer = setTimeout(() => {
        this.statusMessage = '';
        this.render();
      }, timeoutMs);
    }
    this.render();
  }

  getRealSidebarWidth() {
    const w = getPaneWidths();
    if (!w || w.panes < 2) return null;
    // Must be a legitimate split sidebar (16-60 cols, at most half the window)
    if (w.paneWidth >= 16 && w.paneWidth <= 60 && (!w.windowWidth || w.paneWidth <= Math.floor(w.windowWidth * 0.5))) {
      return w.paneWidth;
    }
    return null;
  }

  handleResize() {
    const realWidth = this.getRealSidebarWidth();
    if (realWidth) this.persistSidebarWidth(realWidth);
    refreshTabBar();
    this.render();
  }

  persistSidebarWidth(width) {
    if (clampWidth(width) !== width) return;
    if (this.saveWidthTimer) clearTimeout(this.saveWidthTimer);
    this.saveWidthTimer = setTimeout(() => {
      try {
        updateConfig(config => { config.sidebarWidth = width; });
      } catch (err) {
        // ignore
      }
    }, 200);
  }

  scheduleSelectionSave() {
    if (this.saveSelectionTimer) clearTimeout(this.saveSelectionTimer);
    this.saveSelectionTimer = setTimeout(() => {
      try {
        updateConfig(config => { config.selectedIndex = this.selectedIndex; });
      } catch (err) {
        // ignore
      }
    }, 300);
  }

  getCurrentBookmark() {
    if (!this.config.bookmarks || this.config.bookmarks.length === 0) return null;
    return this.config.bookmarks[this.selectedIndex] || null;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(chunk) {
    // SGR mouse: \x1b[<btn;col;row(M|m)
    if (chunk.startsWith('\x1b[<')) {
      const match = chunk.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (match && this.mode === 'normal') {
        const btn = parseInt(match[1], 10);
        const row = parseInt(match[3], 10);
        const isPress = match[4] === 'M';
        if (btn === 0 && isPress) this.handleMouseClick(row);
        else if (btn === 64) this.moveSelection(-1);
        else if (btn === 65) this.moveSelection(1);
      }
      return;
    }

    switch (this.mode) {
      case 'normal': return this.handleNormalKey(chunk);
      case 'add':
      case 'edit': return this.handleInputMode(chunk);
      case 'delete_confirm': return this.handleDeleteConfirm(chunk);
      case 'quit_confirm': return this.handleQuitConfirm(chunk);
      case 'select_agent': return this.handleAgentSelectorKey(chunk);
      default: return undefined;
    }
  }

  handleMouseClick(row) {
    const index = this.rowMap[row];
    if (index === undefined) return;
    this.selectedIndex = index;
    this.scheduleSelectionSave();
    this.activateSelectedBookmark('');
  }

  moveSelection(delta) {
    const next = this.clampIndex(this.selectedIndex + delta);
    if (next !== this.selectedIndex) {
      this.selectedIndex = next;
      this.scheduleSelectionSave();
      this.render();
    }
  }

  handleNormalKey(key) {
    if (key === '\x1b[A' || key === 'k') return this.moveSelection(-1);
    if (key === '\x1b[B' || key === 'j') return this.moveSelection(1);
    if (key === '\r' || key === '\n') return this.activateSelectedBookmark('');
    if (key === '\t' || key === '\x1b[C') return focusPane(1);

    if (key.length !== 1) return undefined;
    const k = key.toLowerCase();

    // Agent shortcuts (configurable)
    if (this.agentByShortcut[k]) return this.activateSelectedBookmark(this.agentByShortcut[k].id);

    switch (k) {
      case 's':
        return this.activateSelectedBookmark('');
      case ' ':
      case 'o':
        if (this.config.bookmarks.length > 0) {
          this.mode = 'select_agent';
          this.agentMenuIndex = 0;
          this.render();
        }
        return undefined;
      case 'a':
        return this.startAddBookmark();
      case 't':
        return this.openNewTab();
      case 'd':
        if (this.config.bookmarks.length > 0) {
          this.mode = 'delete_confirm';
          this.render();
        }
        return undefined;
      case 'e':
        if (this.config.bookmarks.length > 0) this.startEditBookmark();
        return undefined;
      case 'r': {
        const cur = this.getCurrentBookmark();
        if (cur) {
          const bmKey = getBookmarkKey(cur);
          delete this.bookmarkStatuses[bmKey];
          clearManualStatus(bmKey);
          clearManualStatus(cur.name);
          this.setStatus('Status reset.');
          this.runMonitorCheck(true);
        }
        return undefined;
      }
      case '<':
      case '[':
      case '-':
        resizeSidebar(-2);
        setTimeout(() => this.handleResize(), 60);
        return undefined;
      case '>':
      case ']':
      case '+':
        resizeSidebar(2);
        setTimeout(() => this.handleResize(), 60);
        return undefined;
      case 'w': {
        this.widthPresetIndex = (this.widthPresetIndex + 1) % this.widthPresets.length;
        const targetWidth = this.widthPresets[this.widthPresetIndex];
        setSidebarWidth(targetWidth);
        this.persistSidebarWidth(targetWidth);
        this.setStatus(`Sidebar: ${targetWidth} cols`);
        return undefined;
      }
      case 'q':
        this.mode = 'quit_confirm';
        this.render();
        return undefined;
      default:
        return undefined;
    }
  }

  activateSelectedBookmark(agentId = '') {
    const current = this.getCurrentBookmark();
    if (!current) {
      this.setStatus('⚠️ No bookmark selected.');
      return;
    }

    if (!fs.existsSync(current.path)) {
      this.setStatus(`⚠️ Directory not found: ${shrinkPath(current.path)}`);
      return;
    }

    let cmd = '';
    if (agentId) {
      const agent = this.agents.find(a => a.id === agentId);
      if (agent && agent.cmd) {
        if (!agent.installed) {
          this.setStatus(`⚠️ ${agent.name}: "${agent.cmd.split(' ')[0]}" not found in PATH`);
          return;
        }
        cmd = agent.cmd;
      }
    }

    switchToBookmark(current, cmd, true);
    this.lastActiveId = getBookmarkKey(current);
    this.setStatus(`Switched to "${current.name}"`);
  }

  /** New tab (shell) for the selected bookmark, shown on the right. */
  openNewTab() {
    const current = this.getCurrentBookmark();
    if (!current) {
      this.setStatus('⚠️ No bookmark selected.');
      return;
    }
    if (!fs.existsSync(current.path)) {
      this.setStatus(`⚠️ Directory not found: ${shrinkPath(current.path)}`);
      return;
    }
    newTab(current);
    this.lastActiveId = getBookmarkKey(current);
    this.runMonitorCheck(true);
    this.setStatus(`New tab in "${current.name}"`);
  }

  startAddBookmark() {
    this.mode = 'add';
    this.inputStep = 1;
    this.inputTemp = { name: '', path: '', agent: 'claude' };
    this.inputPrompt = 'Bookmark name:';
    this.inputValue = '';
    this.render();
  }

  startEditBookmark() {
    const current = this.getCurrentBookmark();
    if (!current) return;
    this.mode = 'edit';
    this.inputStep = 1;
    this.inputTemp = { name: current.name, path: current.path, agent: current.agent || 'claude' };
    this.inputPrompt = `New name [${current.name}]:`;
    this.inputValue = current.name;
    this.render();
  }

  finishAdd() {
    addBookmark(this.inputTemp.name, this.inputTemp.path, this.inputTemp.agent);
    this.reloadConfig();
    this.selectedIndex = this.config.bookmarks.length - 1;
    this.mode = 'normal';
    this.setStatus(`✅ Bookmark "${this.inputTemp.name}" created!`);
  }

  handleInputMode(key) {
    // Step 3 of "add": confirm creation of a missing directory
    if (this.mode === 'add' && this.inputStep === 3) {
      if (key === 'y' || key === 'Y') {
        try {
          fs.mkdirSync(this.inputTemp.path, { recursive: true });
        } catch (err) {
          this.mode = 'normal';
          this.setStatus(`⚠️ Cannot create directory: ${err.message}`);
          return;
        }
        this.finishAdd();
      } else {
        // Back to the path step
        this.inputStep = 2;
        this.inputPrompt = 'Path (~/..., . for current):';
        this.inputValue = this.inputTemp.path;
        this.render();
      }
      return;
    }

    if (key === '\x1b') {
      this.mode = 'normal';
      this.setStatus('Action cancelled.');
      return;
    }

    if (key === '\r' || key === '\n') {
      this.submitInputStep();
      return;
    }

    // Backspace
    if (key === '\x08' || key === '\x7f') {
      if (this.inputValue.length > 0) {
        this.inputValue = Array.from(this.inputValue).slice(0, -1).join('');
        this.render();
      }
      return;
    }

    // Ctrl+U: clear the field
    if (key === '\x15') {
      this.inputValue = '';
      this.render();
      return;
    }

    // Typing or pasting (bracketed paste markers removed, control chars dropped)
    const text = key.replace(/\x1b\[20[01]~/g, '');
    if (text.startsWith('\x1b')) return; // arrows / other escape sequences
    const printable = Array.from(text).filter(ch => ch >= ' ' && ch !== '\x7f').join('');
    if (printable) {
      this.inputValue += printable;
      this.render();
    }
  }

  submitInputStep() {
    if (this.mode === 'add') {
      if (this.inputStep === 1) {
        this.inputTemp.name = this.inputValue.trim() || 'Project';
        this.inputStep = 2;
        this.inputPrompt = 'Path (~/..., . for current):';
        this.inputValue = process.cwd();
        this.render();
        return;
      }
      if (this.inputStep === 2) {
        this.inputTemp.path = resolvePath(this.inputValue.trim() || '.');
        if (!fs.existsSync(this.inputTemp.path)) {
          this.inputStep = 3;
          this.inputPrompt = `Create ${shrinkPath(this.inputTemp.path)}? (y/N)`;
          this.render();
          return;
        }
        this.finishAdd();
      }
      return;
    }

    if (this.mode === 'edit') {
      if (this.inputStep === 1) {
        if (this.inputValue.trim()) this.inputTemp.name = this.inputValue.trim();
        this.inputStep = 2;
        this.inputPrompt = `Path [${shrinkPath(this.inputTemp.path)}]:`;
        this.inputValue = this.inputTemp.path;
        this.render();
        return;
      }
      if (this.inputStep === 2) {
        if (this.inputValue.trim()) this.inputTemp.path = resolvePath(this.inputValue.trim());
        updateBookmark(this.selectedIndex, { name: this.inputTemp.name, path: this.inputTemp.path });
        this.reloadConfig();
        this.mode = 'normal';
        const warn = fs.existsSync(this.inputTemp.path) ? '' : ' (⚠️ directory does not exist)';
        this.setStatus(`✅ Bookmark updated!${warn}`);
      }
    }
  }

  handleDeleteConfirm(key) {
    if (key !== 'y' && key !== 'Y') {
      this.mode = 'normal';
      this.setStatus('Cancelled.');
      return;
    }

    const target = this.getCurrentBookmark();
    const removedKey = target ? getBookmarkKey(target) : null;
    const wasActive = removedKey && removedKey === getActiveBookmarkId();
    const removed = removeBookmark(this.selectedIndex);
    this.reloadConfig();
    this.selectedIndex = this.clampIndex(this.selectedIndex);

    if (removed) {
      if (wasActive && this.config.bookmarks.length > 0) {
        // Show another bookmark first: the deleted session then lives in a
        // background window that can be closed.
        const next = this.getCurrentBookmark();
        switchToBookmark(next, '', false);
        this.lastActiveId = getBookmarkKey(next);
      }
      closeBookmarkSession(removedKey);
      clearManualStatus(removedKey);
    }

    this.mode = 'normal';
    this.setStatus(`🗑️ Deleted "${removed ? removed.name : ''}".`);
  }

  handleQuitConfirm(key) {
    if (key === 'y' || key === 'Y' || key === '\r' || key === '\n') {
      this.exit();
    } else {
      this.mode = 'normal';
      this.render();
    }
  }

  handleAgentSelectorKey(key) {
    const options = this.agents;
    if (key === '\x1b[A' || key === 'k') {
      this.agentMenuIndex = (this.agentMenuIndex - 1 + options.length) % options.length;
      this.render();
    } else if (key === '\x1b[B' || key === 'j') {
      this.agentMenuIndex = (this.agentMenuIndex + 1) % options.length;
      this.render();
    } else if (key === '\r' || key === '\n') {
      const selectedAgent = options[this.agentMenuIndex];
      this.mode = 'normal';
      this.activateSelectedBookmark(selectedAgent.id);
    } else if (key === '\x1b' || key === 'q') {
      this.mode = 'normal';
      this.render();
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** Lay out "[key] Label" hints over as many lines as needed. */
  legendLines(width) {
    const items = [['Enter', 'Open']];
    for (const agent of this.agents) {
      if (agent.shortcut) items.push([agent.shortcut, agent.name.split(' ')[0]]);
    }
    items.push(['t', 'New tab'], ['a', 'Add'], ['e', 'Edit'], ['d', 'Delete'], ['o', 'Agents'], ['< >', 'Size'], ['Tab', 'Term'], ['q', 'Quit']);

    const lines = [];
    let current = '';
    for (const [key, label] of items) {
      const token = `${colors.brightGreen}[${key}]${colors.reset} ${label}`;
      const candidate = current ? `${current}  ${token}` : token;
      if (current && visibleLength(candidate) > width) {
        lines.push(current);
        current = token;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  bottomSection(width) {
    const lines = [];
    if (this.mode === 'add' || this.mode === 'edit') {
      lines.push(`${colors.bold}${colors.brightMagenta}${this.mode === 'add' ? 'ADD BOOKMARK' : 'EDIT'}${colors.reset}`);
      lines.push(`${colors.yellow}${truncate(this.inputPrompt, width - 2)}${colors.reset}`);
      if (!(this.mode === 'add' && this.inputStep === 3)) {
        // Show the end of long values (paths)
        const max = Math.max(1, width - 3);
        const chars = Array.from(this.inputValue);
        const shown = chars.length > max ? '…' + chars.slice(-(max - 1)).join('') : this.inputValue;
        lines.push(`${colors.brightGreen}❯ ${shown}█${colors.reset}`);
        lines.push(`${colors.dim}[Enter] Next │ [Esc] Cancel${colors.reset}`);
      }
    } else if (this.mode === 'delete_confirm') {
      const current = this.getCurrentBookmark();
      lines.push(`${colors.bold}${colors.brightRed}DELETE BOOKMARK?${colors.reset}`);
      lines.push(`"${truncate(current ? current.name : '', width - 4)}"`);
      lines.push(`${colors.yellow}Its terminal will be closed. (y/N)${colors.reset}`);
    } else if (this.mode === 'quit_confirm') {
      lines.push(`${colors.bold}${colors.brightYellow}QUIT CLI-AGENT?${colors.reset}`);
      lines.push(`${colors.gray}All sessions will close. (y/N)${colors.reset}`);
    } else if (this.mode === 'select_agent') {
      lines.push(`${colors.bold}${colors.brightCyan}CHOOSE AGENT${colors.reset}`);
      this.agents.forEach((agent, idx) => {
        const isSel = idx === this.agentMenuIndex;
        const label = truncate(`${agent.name}${agent.installed ? '' : ' (missing)'}`, width - 4);
        lines.push(isSel ? `${colors.brightGreen}▶ ${label}${colors.reset}` : `  ${colors.white}${label}${colors.reset}`);
      });
      lines.push(`${colors.dim}[Enter] Launch │ [Esc] Back${colors.reset}`);
    } else {
      lines.push(...this.legendLines(width));
    }
    return lines;
  }

  render() {
    const width = Math.max(16, process.stdout.columns || 26);
    const height = Math.max(10, process.stdout.rows || 24);
    const lines = [];
    this.rowMap = {};

    lines.push(`${colors.bold}${colors.brightCyan}🤖 CLI-AGENT${colors.reset} ${colors.gray}v${VERSION}${colors.reset}`);
    if (this.hasActiveAlert) {
      lines.push(`${colors.bold}${colors.brightYellow}🔔 ACTION REQUIRED!${colors.reset}`);
    }
    lines.push(`${colors.dim}${colors.gray}${drawLine(width)}${colors.reset}`);

    const count = this.config.bookmarks.length;
    lines.push(`${colors.bold}${colors.brightYellow}PROJECTS (${count})${colors.reset}`);

    const bottom = [`${colors.dim}${colors.gray}${drawLine(width)}${colors.reset}`, ...this.bottomSection(width)];
    const statusLines = this.statusMessage
      ? ['', `${colors.brightYellow}ℹ️ ${truncate(this.statusMessage, width - 4)}${colors.reset}`]
      : [];

    if (count === 0) {
      lines.push(`${colors.gray}No bookmarks yet.${colors.reset}`);
      lines.push(`${colors.cyan}[a] to add one.${colors.reset}`);
    } else {
      const activeId = getActiveBookmarkId();
      const available = height - lines.length - bottom.length - statusLines.length;
      const maxDisplay = Math.max(1, Math.floor(available / 2));
      let startIdx = 0;
      if (this.selectedIndex >= maxDisplay) startIdx = this.selectedIndex - maxDisplay + 1;
      const endIdx = Math.min(count, startIdx + maxDisplay);

      for (let i = startIdx; i < endIdx; i++) {
        const bm = this.config.bookmarks[i];
        const isSelected = i === this.selectedIndex;
        const key = getBookmarkKey(bm);
        const isActiveView = key === activeId;
        const status = this.bookmarkStatuses[key] || STATUS_TYPES.IDLE;
        const git = this.gitInfoCache[key];

        const prefix = isSelected ? `${colors.brightGreen}▶ ${colors.reset}` : (isActiveView ? `${colors.brightCyan}• ${colors.reset}` : '  ');
        const nameText = truncate(`${i + 1}. ${bm.name}`, width - 3);
        const style = isSelected ? `${colors.bold}${colors.brightGreen}` : (isActiveView ? `${colors.bold}${colors.white}` : `${colors.dim}${colors.white}`);

        // Rows are 1-based in terminal mouse coordinates
        this.rowMap[lines.length + 1] = i;
        lines.push(`${prefix}${style}${nameText}${colors.reset}`);

        let gitTag = '';
        if (git) {
          const room = width - 3 - visibleLength(statusBadge(status)) - 1 - (this.tabCounts[key] > 1 ? 3 : 0);
          const branch = git.branch ? truncate(git.branch, Math.max(0, room - 2)) : '';
          gitTag = room > 4 && branch
            ? ` ${colors.gray}${branch}${colors.reset}${git.isDirty ? `${colors.brightYellow}*${colors.reset}` : ''}`
            : (git.isDirty ? ` ${colors.brightYellow}*${colors.reset}` : '');
        }
        const tabCount = this.tabCounts[key] || 0;
        const tabTag = tabCount > 1 ? ` ${colors.brightCyan}⧉${tabCount}${colors.reset}` : '';
        this.rowMap[lines.length + 1] = i;
        lines.push(`   ${statusBadge(status)}${tabTag}${gitTag}`);
      }

      if (endIdx < count || startIdx > 0) {
        // Replace nothing: scroll hint folded into the title line
        lines[lines.findIndex(l => l.includes('PROJECTS ('))] =
          `${colors.bold}${colors.brightYellow}PROJECTS (${count})${colors.reset} ${colors.gray}${startIdx + 1}-${endIdx}${colors.reset}`;
      }
    }

    const output = [...lines, ...bottom, ...statusLines].slice(0, height);
    paint(output);
  }
}

function runSidebar() {
  const app = new SidebarApp();
  app.start();
}

module.exports = {
  SidebarApp,
  runSidebar
};

if (require.main === module) {
  runSidebar();
}
