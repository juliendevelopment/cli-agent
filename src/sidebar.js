const readline = require('readline');
const fs = require('fs');
const path = require('path');
const {
  loadConfig,
  saveConfig,
  addBookmark,
  removeBookmark,
  updateBookmark,
  resolvePath,
  shrinkPath
} = require('./config');
const { getAgentsWithStatus, resolveAgent } = require('./agents');
const {
  SESSION_NAME,
  switchToBookmark,
  closeBookmarkSession,
  getActiveBookmarkId,
  setActiveBookmarkId,
  hasBookmarkWindow,
  resizeSidebar,
  setSidebarWidth,
  focusPane,
  killSession
} = require('./tmux');
const {
  STATUS_TYPES,
  loadManualStatuses,
  saveManualStatus,
  getGitInfo,
  getPaneOutputForBookmark,
  getPaneProcessForBookmark,
  detectTerminalStatus
} = require('./monitor');
const { colors, truncate, padRight, drawLine, clearScreen, hideCursor, showCursor, moveTo, stripAnsi } = require('./ui');
const { execSync } = require('child_process');

class SidebarApp {
  constructor() {
    this.config = loadConfig();
    this.selectedIndex = Math.min(
      Math.max(0, this.config.selectedIndex || 0),
      Math.max(0, this.config.bookmarks.length - 1)
    );
    this.mode = 'normal'; // 'normal' | 'add' | 'edit' | 'delete_confirm' | 'select_agent' | 'quit_confirm'
    this.inputPrompt = '';
    this.inputValue = '';
    this.inputStep = 0;
    this.inputTemp = {};
    this.statusMessage = '';
    this.statusTimer = null;
    this.monitorTimer = null;
    this.agents = getAgentsWithStatus();

    // Cache of statuses & git info
    this.bookmarkStatuses = {};
    this.gitInfoCache = {};
    this.lastGitCheck = 0;
    this.hasActiveAlert = false;

    // Track width presets: 24, 30, 38
    this.widthPresets = [24, 30, 38];
    this.widthPresetIndex = 0;
  }

  start() {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    hideCursor();

    // Enable SGR mouse tracking
    process.stdout.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h');

    process.stdin.on('data', chunk => this.handleInput(chunk));
    process.stdout.on('resize', () => {
      const currentWidth = process.stdout.columns;
      if (currentWidth && currentWidth >= 16) {
        this.persistSidebarWidth(currentWidth);
      }
      this.render();
    });

    process.on('SIGINT', () => this.exit());
    process.on('SIGTERM', () => this.exit());
    process.on('exit', () => {
      showCursor();
      process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l');
      if (this.monitorTimer) clearInterval(this.monitorTimer);
    });

    // Initialize first bookmark as active session
    const current = this.getCurrentBookmark();
    if (current) {
      setActiveBookmarkId(current.id || current.name);
    }

    // Start background monitor loop (every 1.5s)
    this.monitorTimer = setInterval(() => this.runMonitorCheck(), 1500);

    this.setStatus('CLI-Agent ready. Use ↑/↓ to navigate, Enter to open.');
    this.runMonitorCheck(true);
    this.render();
  }

  runMonitorCheck(forceRender = false) {
    let changed = false;
    const manualStatuses = loadManualStatuses();
    const activeId = getActiveBookmarkId() || (this.getCurrentBookmark() ? this.getCurrentBookmark().id : null);

    // 1. Analyze terminal output for all open sessions (visible + background)
    for (const bm of this.config.bookmarks) {
      const bmId = bm.id || bm.name;
      const isOpen = (bmId === activeId) || hasBookmarkWindow(bmId);

      if (isOpen) {
        const paneOutput = getPaneOutputForBookmark(bmId, activeId, 25);
        const procInfo = getPaneProcessForBookmark(bmId, activeId);
        const detected = detectTerminalStatus(paneOutput, procInfo);
        const prev = this.bookmarkStatuses[bmId];

        if (manualStatuses[bmId] || manualStatuses[bm.name]) {
          const m = manualStatuses[bmId] || manualStatuses[bm.name];
          const matchType = Object.values(STATUS_TYPES).find(t => t.id === m.status) || STATUS_TYPES.IDLE;
          if (!prev || prev.id !== matchType.id) {
            this.bookmarkStatuses[bmId] = matchType;
            changed = true;
          }
        } else {
          if (!prev || prev.id !== detected.id) {
            this.bookmarkStatuses[bmId] = detected;
            changed = true;
          }
        }
      } else {
        if (!this.bookmarkStatuses[bmId]) {
          this.bookmarkStatuses[bmId] = STATUS_TYPES.IDLE;
        }
      }
    }

    // 2. Check git info periodically (every 6 seconds)
    const now = Date.now();
    if (now - this.lastGitCheck > 6000) {
      this.lastGitCheck = now;
      this.config.bookmarks.forEach(bm => {
        const key = bm.id || bm.name;
        const git = getGitInfo(bm.path);
        if (git) {
          this.gitInfoCache[key] = git;
        }
      });
      changed = true;
    }

    // 3. Update tmux status bar if any bookmark needs user action
    const anyInputRequired = Object.values(this.bookmarkStatuses).some(
      s => s && s.id === STATUS_TYPES.INPUT_REQUIRED.id
    );

    if (anyInputRequired !== this.hasActiveAlert) {
      this.hasActiveAlert = anyInputRequired;
      this.updateTmuxStatusBar(anyInputRequired);
      changed = true;
    }

    if (changed || forceRender) {
      if (this.mode === 'normal') {
        this.render();
      }
    }
  }

  updateTmuxStatusBar(hasAlert) {
    try {
      if (hasAlert) {
        execSync(
          `tmux set-option -t ${SESSION_NAME} status-right "#[bg=yellow,fg=black,bold] 🔔 ACTION REQUIRED #[default] Tab: Terminal │ Alt+←: Menu"`,
          { stdio: 'ignore' }
        );
      } else {
        execSync(
          `tmux set-option -t ${SESSION_NAME} status-right "#[fg=#a6adc8]Tab: Terminal │ Alt+←: Menu │ M-[: Shrink │ M-]: Grow #[default]"`,
          { stdio: 'ignore' }
        );
      }
    } catch (err) {
      // Ignore
    }
  }

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

  persistSidebarWidth(width) {
    if (this.saveWidthTimer) clearTimeout(this.saveWidthTimer);
    this.saveWidthTimer = setTimeout(() => {
      try {
        const config = loadConfig();
        if (config.sidebarWidth !== width) {
          config.sidebarWidth = width;
          saveConfig(config);
        }
      } catch (err) {
        // Ignore
      }
    }, 250);
  }

  exit() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.saveWidthTimer) clearTimeout(this.saveWidthTimer);

    try {
      const currentWidth = process.stdout.columns;
      if (currentWidth && currentWidth >= 16) {
        const config = loadConfig();
        config.sidebarWidth = currentWidth;
        saveConfig(config);
      }
    } catch (err) {
      // Ignore
    }

    showCursor();
    process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[2J\x1b[H');
    killSession(SESSION_NAME);
    process.exit(0);
  }

  getCurrentBookmark() {
    if (!this.config.bookmarks || this.config.bookmarks.length === 0) return null;
    return this.config.bookmarks[this.selectedIndex] || null;
  }

  handleInput(chunk) {
    // SGR Mouse handling: \x1b[<0;X;YM (click)
    if (chunk.startsWith('\x1b[<')) {
      const match = chunk.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (match) {
        const btn = parseInt(match[1], 10);
        const col = parseInt(match[2], 10);
        const row = parseInt(match[3], 10);
        const isRelease = match[4] === 'm';

        if (btn === 0 && !isRelease && this.mode === 'normal') {
          this.handleMouseClick(row, col);
          return;
        }
      }
      return;
    }

    if (this.mode === 'normal') {
      this.handleNormalKey(chunk);
    } else if (this.mode === 'add' || this.mode === 'edit') {
      this.handleInputMode(chunk);
    } else if (this.mode === 'delete_confirm') {
      this.handleDeleteConfirm(chunk);
    } else if (this.mode === 'quit_confirm') {
      this.handleQuitConfirm(chunk);
    } else if (this.mode === 'select_agent') {
      this.handleAgentSelectorKey(chunk);
    }
  }

  handleMouseClick(row, col) {
    // Bookmarks start around row 5 in compact layout, 2 lines per bookmark
    const bookmarkStartRow = 5;
    const clickedIndex = Math.floor((row - bookmarkStartRow) / 2);

    if (clickedIndex >= 0 && clickedIndex < this.config.bookmarks.length) {
      this.selectedIndex = clickedIndex;
      this.config.selectedIndex = clickedIndex;
      saveConfig(this.config);
      this.render();
      this.activateSelectedBookmark('');
    }
  }

  handleNormalKey(key) {
    // Arrows & navigation
    if (key === '\u001b[A' || key === 'k') {
      // Up
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.config.selectedIndex = this.selectedIndex;
        saveConfig(this.config);
        this.render();
      }
    } else if (key === '\u001b[B' || key === 'j') {
      // Down
      if (this.selectedIndex < this.config.bookmarks.length - 1) {
        this.selectedIndex++;
        this.config.selectedIndex = this.selectedIndex;
        saveConfig(this.config);
        this.render();
      }
    } else if (key === '\r' || key === '\n') {
      // Enter: switch right terminal to this independent bookmark session
      this.activateSelectedBookmark('');
    } else if (key === 'c' || key === 'C') {
      // Launch Claude Code in this bookmark session
      this.activateSelectedBookmark('claude');
    } else if (key === 'p' || key === 'P') {
      // Launch Copilot in this bookmark session
      this.activateSelectedBookmark('copilot');
    } else if (key === 's' || key === 'S') {
      // Switch to standard Shell
      this.activateSelectedBookmark('');
    } else if (key === ' ' || key === 'o' || key === 'O') {
      // Open Agent selector modal
      if (this.config.bookmarks.length > 0) {
        this.mode = 'select_agent';
        this.agentMenuIndex = 0;
        this.render();
      }
    } else if (key === 'a' || key === 'A') {
      // Add bookmark
      this.startAddBookmark();
    } else if (key === 'd' || key === 'D') {
      // Delete bookmark
      if (this.config.bookmarks.length > 0) {
        this.mode = 'delete_confirm';
        this.render();
      }
    } else if (key === 'e' || key === 'E') {
      // Edit bookmark
      if (this.config.bookmarks.length > 0) {
        this.startEditBookmark();
      }
    } else if (key === 'r' || key === 'R') {
      // Reset live status
      const cur = this.getCurrentBookmark();
      if (cur) {
        const key = cur.id || cur.name;
        delete this.bookmarkStatuses[key];
        saveManualStatus(key, 'idle', '');
        this.setStatus('Status reset.');
        this.runMonitorCheck(true);
      }
    } else if (key === '<' || key === '[' || key === '-') {
      // Shrink sidebar width
      resizeSidebar(-2);
    } else if (key === '>' || key === ']' || key === '+') {
      // Expand sidebar width
      resizeSidebar(2);
    } else if (key === 'w' || key === 'W') {
      // Cycle width presets
      this.widthPresetIndex = (this.widthPresetIndex + 1) % this.widthPresets.length;
      setSidebarWidth(this.widthPresets[this.widthPresetIndex]);
    } else if (key === '\t' || key === '\u001b[C') {
      // Tab or Right Arrow: focus right terminal pane
      focusPane(1);
    } else if (key === 'q' || key === 'Q') {
      this.mode = 'quit_confirm';
      this.render();
    }
  }

  activateSelectedBookmark(agentCommand = '') {
    const current = this.getCurrentBookmark();
    if (!current) {
      this.setStatus('⚠️ No bookmark selected.');
      return;
    }

    // Verify directory exists
    if (!fs.existsSync(current.path)) {
      this.setStatus(`⚠️ Directory not found: ${shrinkPath(current.path)}`);
      return;
    }

    let cmd = agentCommand;
    if (cmd) {
      const agent = resolveAgent(cmd);
      cmd = agent.cmd;
    }

    // Switch right terminal to target bookmark (swaps background windows seamlessly!)
    switchToBookmark(current, cmd, true);

    const title = current.name;
    this.setStatus(`Switched to "${title}"`);
    this.render();
  }

  startAddBookmark() {
    this.mode = 'add';
    this.inputStep = 1;
    this.inputTemp = {
      name: '',
      path: '',
      agent: 'claude'
    };
    this.inputPrompt = 'Bookmark name:';
    this.inputValue = '';
    this.render();
  }

  startEditBookmark() {
    const current = this.getCurrentBookmark();
    if (!current) return;
    this.mode = 'edit';
    this.inputStep = 1;
    this.inputTemp = {
      name: current.name,
      path: current.path,
      agent: current.agent || 'claude'
    };
    this.inputPrompt = `New name [${current.name}]:`;
    this.inputValue = current.name;
    this.render();
  }

  handleInputMode(key) {
    if (key === '\u001b') {
      // Escape: cancel
      this.mode = 'normal';
      this.setStatus('Action cancelled.');
      this.render();
      return;
    }

    if (key === '\r' || key === '\n') {
      // Submit step
      if (this.mode === 'add') {
        if (this.inputStep === 1) {
          this.inputTemp.name = this.inputValue.trim() || 'Project';
          this.inputStep = 2;
          this.inputPrompt = 'Path (~/..., . for current):';
          this.inputValue = process.cwd();
          this.render();
          return;
        } else if (this.inputStep === 2) {
          const enteredPath = this.inputValue.trim() || '.';
          const resolved = resolvePath(enteredPath);
          this.inputTemp.path = resolved;

          if (!fs.existsSync(resolved)) {
            try {
              fs.mkdirSync(resolved, { recursive: true });
            } catch (err) {
              // Ignore
            }
          }

          addBookmark(this.inputTemp.name, this.inputTemp.path, this.inputTemp.agent);
          this.config = loadConfig();
          this.selectedIndex = this.config.bookmarks.length - 1;
          this.mode = 'normal';
          this.setStatus(`✅ Bookmark "${this.inputTemp.name}" created!`);
          this.render();
          return;
        }
      } else if (this.mode === 'edit') {
        if (this.inputStep === 1) {
          if (this.inputValue.trim()) {
            this.inputTemp.name = this.inputValue.trim();
          }
          this.inputStep = 2;
          this.inputPrompt = `Path [${shrinkPath(this.inputTemp.path)}]:`;
          this.inputValue = this.inputTemp.path;
          this.render();
          return;
        } else if (this.inputStep === 2) {
          if (this.inputValue.trim()) {
            this.inputTemp.path = resolvePath(this.inputValue.trim());
          }
          updateBookmark(this.selectedIndex, {
            name: this.inputTemp.name,
            path: this.inputTemp.path
          });
          this.config = loadConfig();
          this.mode = 'normal';
          this.setStatus(`✅ Bookmark updated!`);
          this.render();
          return;
        }
      }
      return;
    }

    // Backspace
    if (key === '\u0008' || key === '\u007f') {
      if (this.inputValue.length > 0) {
        this.inputValue = this.inputValue.slice(0, -1);
        this.render();
      }
      return;
    }

    // Regular typing
    if (key.length === 1 && key >= ' ') {
      this.inputValue += key;
      this.render();
    }
  }

  handleDeleteConfirm(key) {
    if (key === 'o' || key === 'O' || key === 'y' || key === 'Y') {
      const removed = removeBookmark(this.selectedIndex);
      if (removed) {
        closeBookmarkSession(removed.id || removed.name);
      }
      this.config = loadConfig();
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.config.bookmarks.length - 1));
      this.mode = 'normal';
      this.setStatus(`🗑️ Deleted "${removed ? removed.name : ''}".`);
      this.render();
    } else {
      this.mode = 'normal';
      this.setStatus('Cancelled.');
      this.render();
    }
  }

  handleQuitConfirm(key) {
    if (key === 'o' || key === 'O' || key === 'y' || key === 'Y' || key === '\r' || key === '\n') {
      this.exit();
    } else {
      this.mode = 'normal';
      this.render();
    }
  }

  handleAgentSelectorKey(key) {
    const options = this.agents;
    if (key === '\u001b[A' || key === 'k') {
      this.agentMenuIndex = (this.agentMenuIndex - 1 + options.length) % options.length;
      this.render();
    } else if (key === '\u001b[B' || key === 'j') {
      this.agentMenuIndex = (this.agentMenuIndex + 1) % options.length;
      this.render();
    } else if (key === '\r' || key === '\n') {
      const selectedAgent = options[this.agentMenuIndex];
      this.mode = 'normal';
      this.activateSelectedBookmark(selectedAgent.id);
    } else if (key === '\u001b' || key === 'q') {
      this.mode = 'normal';
      this.render();
    }
  }

  render() {
    const width = Math.max(20, process.stdout.columns || 26);
    const height = Math.max(12, process.stdout.rows || 24);

    let lines = [];

    // Clean, compact Header
    lines.push(`${colors.bold}${colors.brightCyan}🤖 CLI-AGENT${colors.reset} ${colors.gray}v1.0${colors.reset}`);
    if (this.hasActiveAlert) {
      lines.push(`${colors.bold}${colors.brightYellow}🔔 ACTION REQUIRED!${colors.reset}`);
    }
    lines.push(`${colors.dim}${colors.gray}${drawLine(width, '─')}${colors.reset}`);

    // Section Bookmarks
    const count = this.config.bookmarks.length;
    lines.push(`${colors.bold}${colors.brightYellow}PROJECTS (${count})${colors.reset}`);

    if (count === 0) {
      lines.push(`${colors.gray}No bookmarks yet.${colors.reset}`);
      lines.push(`${colors.cyan}[a] to add one.${colors.reset}`);
    } else {
      // Calculate max items to display: 2 lines per bookmark
      const activeId = getActiveBookmarkId();
      const maxDisplay = Math.max(2, Math.floor((height - 14) / 2));
      let startIdx = 0;
      if (this.selectedIndex >= maxDisplay) {
        startIdx = this.selectedIndex - maxDisplay + 1;
      }
      const endIdx = Math.min(count, startIdx + maxDisplay);

      for (let i = startIdx; i < endIdx; i++) {
        const bm = this.config.bookmarks[i];
        const isSelected = i === this.selectedIndex;
        const bmId = bm.id || bm.name;
        const isActiveView = bmId === activeId;
        const status = this.bookmarkStatuses[bmId] || STATUS_TYPES.IDLE;
        const git = this.gitInfoCache[bmId];

        const prefix = isSelected ? `${colors.brightGreen}▶ ${colors.reset}` : '  ';
        const num = `${i + 1}.`;
        const nameText = truncate(`${num} ${bm.name}`, width - 4);

        // Line 1: Title
        if (isSelected) {
          lines.push(`${prefix}${colors.bold}${colors.brightGreen}${nameText}${colors.reset}`);
        } else if (isActiveView) {
          lines.push(`${prefix}${colors.bold}${colors.white}${nameText}${colors.reset}`);
        } else {
          lines.push(`${prefix}${colors.dim}${colors.white}${nameText}${colors.reset}`);
        }

        // Line 2: Status Badge + Agent tag
        let statusBadge = '';
        if (status.id === STATUS_TYPES.INPUT_REQUIRED.id) {
          statusBadge = `\x1b[43;30m${colors.bold} 🔔 ACTION \x1b[0m`;
        } else if (status.id === STATUS_TYPES.RUNNING.id) {
          statusBadge = `\x1b[46;30m${colors.bold} ⚡ RUN \x1b[0m`;
        } else if (status.id === STATUS_TYPES.DONE.id) {
          statusBadge = `${colors.brightGreen}✓ Done${colors.reset}`;
        } else if (status.id === STATUS_TYPES.ERROR.id) {
          statusBadge = `\x1b[41;37m${colors.bold} ✗ ERR \x1b[0m`;
        } else if (status.id === STATUS_TYPES.RATE_LIMIT.id) {
          statusBadge = `\x1b[45;37m${colors.bold} ⏳ LIMIT \x1b[0m`;
        } else {
          statusBadge = `${colors.gray}● Idle${colors.reset}`;
        }

        const agentTag = `${colors.gray}[${bm.agent || 'claude'}]${colors.reset}`;
        let gitTag = '';
        if (git && width > 28) {
          gitTag = git.isDirty ? ` ${colors.brightYellow}*${colors.reset}` : '';
        }

        lines.push(`   ${statusBadge} ${agentTag}${gitTag}`);
      }
    }

    // Modal / Input Overlay or Shortcuts
    lines.push(`${colors.dim}${colors.gray}${drawLine(width, '─')}${colors.reset}`);

    if (this.mode === 'add' || this.mode === 'edit') {
      lines.push(`${colors.bold}${colors.brightMagenta}${this.mode === 'add' ? 'ADD BOOKMARK' : 'EDIT'}${colors.reset}`);
      lines.push(`${colors.yellow}${truncate(this.inputPrompt, width - 2)}${colors.reset}`);
      lines.push(`${colors.brightGreen}❯ ${truncate(this.inputValue, width - 5)}█${colors.reset}`);
      lines.push(`${colors.dim}[Enter] Save │ [Esc] Back${colors.reset}`);
    } else if (this.mode === 'delete_confirm') {
      const current = this.getCurrentBookmark();
      lines.push(`${colors.bold}${colors.brightRed}DELETE BOOKMARK?${colors.reset}`);
      lines.push(`"${truncate(current ? current.name : '', width - 4)}"`);
      lines.push(`${colors.yellow}Confirm? (y/N)${colors.reset}`);
    } else if (this.mode === 'quit_confirm') {
      lines.push(`${colors.bold}${colors.brightYellow}QUIT CLI-AGENT?${colors.reset}`);
      lines.push(`${colors.gray}Close session? (y/N)${colors.reset}`);
    } else if (this.mode === 'select_agent') {
      lines.push(`${colors.bold}${colors.brightCyan}CHOOSE AGENT${colors.reset}`);
      this.agents.forEach((agent, idx) => {
        const isSel = idx === this.agentMenuIndex;
        const icon = isSel ? '▶ ' : '  ';
        if (isSel) {
          lines.push(`${colors.brightGreen}${icon}${truncate(agent.name, width - 4)}${colors.reset}`);
        } else {
          lines.push(`${icon}${colors.white}${truncate(agent.name, width - 4)}${colors.reset}`);
        }
      });
      lines.push(`${colors.dim}[Enter] Launch │ [Esc] Back${colors.reset}`);
    } else {
      // Compact Keyboard Legend
      lines.push(`${colors.brightGreen}[Enter]${colors.reset} Switch  ${colors.brightGreen}[c]${colors.reset} Claude`);
      lines.push(`${colors.brightGreen}[p]${colors.reset} Copilot  ${colors.brightGreen}[a]${colors.reset} Add`);
      lines.push(`${colors.brightGreen}[d]${colors.reset} Delete   ${colors.brightGreen}[< >]${colors.reset} Size`);
      lines.push(`${colors.brightGreen}[Tab]${colors.reset} Term    ${colors.brightGreen}[q]${colors.reset} Quit`);
    }

    // Status Notification Message at the bottom
    if (this.statusMessage) {
      lines.push('');
      lines.push(`${colors.brightYellow}ℹ️ ${truncate(this.statusMessage, width - 4)}${colors.reset}`);
    }

    // Clear and output to terminal
    clearScreen();
    process.stdout.write(lines.join('\n'));
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
