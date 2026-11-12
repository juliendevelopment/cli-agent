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
const { sendToTerminalPane, focusPane, killSession, SESSION_NAME } = require('./tmux');
const {
  STATUS_TYPES,
  loadManualStatuses,
  saveManualStatus,
  getGitInfo,
  getPaneOutput,
  getPaneProcess,
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
  }

  start() {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    hideCursor();

    // Enable SGR mouse tracking
    process.stdout.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h');

    process.stdin.on('data', chunk => this.handleInput(chunk));
    process.stdout.on('resize', () => this.render());

    process.on('SIGINT', () => this.exit());
    process.on('SIGTERM', () => this.exit());
    process.on('exit', () => {
      showCursor();
      process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l');
      if (this.monitorTimer) clearInterval(this.monitorTimer);
    });

    // Start background monitor loop (every 1.5s)
    this.monitorTimer = setInterval(() => this.runMonitorCheck(), 1500);

    this.setStatus('Welcome to CLI-Agent! Use ↑/↓ to navigate and Enter to select.');
    this.runMonitorCheck(true);
    this.render();
  }

  runMonitorCheck(forceRender = false) {
    let changed = false;
    const manualStatuses = loadManualStatuses();

    // 1. Analyze active pane output for the current selected bookmark
    const current = this.getCurrentBookmark();
    if (current) {
      const paneOutput = getPaneOutput(`${SESSION_NAME}:0.1`, 25);
      const procInfo = getPaneProcess(`${SESSION_NAME}:0.1`);
      const detected = detectTerminalStatus(paneOutput, procInfo);

      const currentKey = current.id || current.name;
      const prev = this.bookmarkStatuses[currentKey];

      // If manual status exists for this bookmark, manual status takes precedence
      if (manualStatuses[currentKey] || manualStatuses[current.name]) {
        const m = manualStatuses[currentKey] || manualStatuses[current.name];
        const matchType = Object.values(STATUS_TYPES).find(t => t.id === m.status) || STATUS_TYPES.IDLE;
        if (!prev || prev.id !== matchType.id) {
          this.bookmarkStatuses[currentKey] = matchType;
          changed = true;
        }
      } else {
        if (!prev || prev.id !== detected.id) {
          this.bookmarkStatuses[currentKey] = detected;
          changed = true;
        }
      }
    }

    // 2. Check git info periodically (every 5 seconds)
    const now = Date.now();
    if (now - this.lastGitCheck > 5000) {
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
          `tmux set-option -t ${SESSION_NAME} status-right "#[bg=yellow,fg=black,bold] 🔔 ACTION REQUIRED #[default] Tab: Terminal │ Alt+← Menu"`,
          { stdio: 'ignore' }
        );
      } else {
        execSync(
          `tmux set-option -t ${SESSION_NAME} status-right "#[fg=#a6adc8]Tab/Alt+→: Terminal │ Alt+←: Menu │ F1/F2 #[default]"`,
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

  exit() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
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
    // Header is ~6 lines, bookmarks take ~3 lines each now with status
    const bookmarkStartRow = 7;
    const clickedIndex = Math.floor((row - bookmarkStartRow) / 3);

    if (clickedIndex >= 0 && clickedIndex < this.config.bookmarks.length) {
      this.selectedIndex = clickedIndex;
      this.config.selectedIndex = clickedIndex;
      saveConfig(this.config);
      this.render();
      this.launchCurrent('shell');
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
      // Enter: open bookmark in shell
      this.launchCurrent('shell');
    } else if (key === 'c' || key === 'C') {
      // Launch Claude Code
      this.launchCurrent('claude');
    } else if (key === 'p' || key === 'P') {
      // Launch Copilot
      this.launchCurrent('copilot');
    } else if (key === 's' || key === 'S') {
      // Launch Shell
      this.launchCurrent('shell');
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
      // Reset / refresh status
      const cur = this.getCurrentBookmark();
      if (cur) {
        const key = cur.id || cur.name;
        delete this.bookmarkStatuses[key];
        saveManualStatus(key, 'idle', '');
        this.setStatus('Status reset.');
        this.runMonitorCheck(true);
      }
    } else if (key === '\t' || key === '\u001b[C') {
      // Tab or Right Arrow: focus right terminal pane
      focusPane(1);
    } else if (key === 'q' || key === 'Q') {
      this.mode = 'quit_confirm';
      this.render();
    }
  }

  launchCurrent(agentId = 'shell') {
    const current = this.getCurrentBookmark();
    if (!current) {
      this.setStatus('⚠️ No bookmark selected.');
      return;
    }

    const agent = resolveAgent(agentId);
    let cmd = agent.cmd;

    // Check if target directory exists
    if (!fs.existsSync(current.path)) {
      this.setStatus(`⚠️ Directory not found: ${shrinkPath(current.path)}`);
      return;
    }

    // Set optimistic status
    const key = current.id || current.name;
    this.bookmarkStatuses[key] = agentId === 'shell' ? STATUS_TYPES.IDLE : STATUS_TYPES.RUNNING;

    sendToTerminalPane(current.path, cmd, true);
    const agentName = agent.name || 'Terminal';
    this.setStatus(`🚀 ${agentName} launched in ${shrinkPath(current.path)}`);
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
          // Name entered
          this.inputTemp.name = this.inputValue.trim() || 'Project';
          this.inputStep = 2;
          this.inputPrompt = 'Directory path (~/..., . for current):';
          this.inputValue = process.cwd();
          this.render();
          return;
        } else if (this.inputStep === 2) {
          // Path entered
          const enteredPath = this.inputValue.trim() || '.';
          const resolved = resolvePath(enteredPath);
          this.inputTemp.path = resolved;

          // Check directory
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
          this.setStatus(`✅ Bookmark updated successfully!`);
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
      this.config = loadConfig();
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.config.bookmarks.length - 1));
      this.mode = 'normal';
      this.setStatus(`🗑️ Bookmark "${removed ? removed.name : ''}" deleted.`);
      this.render();
    } else {
      this.mode = 'normal';
      this.setStatus('Deletion cancelled.');
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
      // Up
      this.agentMenuIndex = (this.agentMenuIndex - 1 + options.length) % options.length;
      this.render();
    } else if (key === '\u001b[B' || key === 'j') {
      // Down
      this.agentMenuIndex = (this.agentMenuIndex + 1) % options.length;
      this.render();
    } else if (key === '\r' || key === '\n') {
      const selectedAgent = options[this.agentMenuIndex];
      this.mode = 'normal';
      this.launchCurrent(selectedAgent.id);
    } else if (key === '\u001b' || key === 'q') {
      this.mode = 'normal';
      this.render();
    }
  }

  render() {
    const width = Math.max(32, process.stdout.columns || 38);
    const height = Math.max(15, process.stdout.rows || 24);

    let lines = [];

    // Header Box
    const headerBorder = drawLine(width - 2, '═');
    lines.push(`${colors.brightBlue}╔${headerBorder}╗${colors.reset}`);
    lines.push(
      `${colors.brightBlue}║${colors.reset} ${colors.bold}${colors.brightCyan}🤖 CLI-AGENT${colors.reset} ${colors.gray}v1.0.0${colors.reset}`.padEnd(width + 8) + `${colors.brightBlue}║${colors.reset}`
    );

    if (this.hasActiveAlert) {
      lines.push(
        `${colors.brightBlue}║${colors.reset} ${colors.bold}${colors.brightYellow}🔔 ACTION REQUIRED PENDING!${colors.reset}`.padEnd(width + 17) + `${colors.brightBlue}║${colors.reset}`
      );
    } else {
      lines.push(
        `${colors.brightBlue}║${colors.reset} ${colors.gray}AI Agent Workspace Manager${colors.reset}`.padEnd(width + 8) + `${colors.brightBlue}║${colors.reset}`
      );
    }
    lines.push(`${colors.brightBlue}╚${headerBorder}╝${colors.reset}`);

    // Section Bookmarks
    const count = this.config.bookmarks.length;
    lines.push(`${colors.bold}${colors.brightYellow} 📁 BOOKMARKS / PROJECTS (${count})${colors.reset}`);
    lines.push(`${colors.gray}${drawLine(width, '─')}${colors.reset}`);

    if (count === 0) {
      lines.push(`${colors.gray}  No bookmarks configured.${colors.reset}`);
      lines.push(`${colors.cyan}  Press [a] to add one.${colors.reset}`);
    } else {
      // Render bookmarks list (each bookmark takes 2-3 lines now)
      const maxDisplay = Math.max(2, Math.floor((height - 18) / 3) + 1);
      let startIdx = 0;
      if (this.selectedIndex >= maxDisplay) {
        startIdx = this.selectedIndex - maxDisplay + 1;
      }
      const endIdx = Math.min(count, startIdx + maxDisplay);

      for (let i = startIdx; i < endIdx; i++) {
        const bm = this.config.bookmarks[i];
        const isSelected = i === this.selectedIndex;
        const key = bm.id || bm.name;
        const status = this.bookmarkStatuses[key] || STATUS_TYPES.IDLE;
        const git = this.gitInfoCache[key];

        const prefix = isSelected ? `${colors.brightGreen} ▶ ${colors.reset}` : '   ';
        const num = `${i + 1}.`;
        const nameText = truncate(`${num} ${bm.name}`, width - 6);

        // Line 1: Bookmark Title
        if (isSelected) {
          lines.push(`${prefix}${colors.bold}${colors.brightGreen}${nameText}${colors.reset}`);
        } else {
          lines.push(`${prefix}${colors.white}${nameText}${colors.reset}`);
        }

        // Line 2: Path & Agent
        const shortPath = truncate(shrinkPath(bm.path), width - 12);
        const agentTag = `[${bm.agent || 'claude'}]`;
        if (isSelected) {
          lines.push(`     ${colors.cyan}${shortPath}${colors.reset} ${colors.dim}${colors.gray}${agentTag}${colors.reset}`);
        } else {
          lines.push(`     ${colors.gray}${shortPath}${colors.reset}`);
        }

        // Line 3: Live Status Badge + Git Info
        let statusBadge = '';
        if (status.id === STATUS_TYPES.INPUT_REQUIRED.id) {
          // Yellow eye-catching badge
          statusBadge = `\x1b[43;30m${colors.bold} 🔔 ACTION REQUIRED \x1b[0m`;
        } else if (status.id === STATUS_TYPES.RUNNING.id) {
          // Cyan running badge
          statusBadge = `\x1b[46;30m${colors.bold} ⚡ RUNNING... \x1b[0m`;
        } else if (status.id === STATUS_TYPES.DONE.id) {
          // Green completed badge
          statusBadge = `${colors.brightGreen}✓ Done${colors.reset}`;
        } else if (status.id === STATUS_TYPES.ERROR.id) {
          // Red error badge
          statusBadge = `\x1b[41;37m${colors.bold} ✗ ERROR \x1b[0m`;
        } else if (status.id === STATUS_TYPES.RATE_LIMIT.id) {
          // Magenta rate limit badge
          statusBadge = `\x1b[45;37m${colors.bold} ⏳ RATE LIMIT \x1b[0m`;
        } else {
          // Idle
          statusBadge = `${colors.gray}● Idle${colors.reset}`;
        }

        let gitTag = '';
        if (git) {
          if (git.isDirty) {
            gitTag = ` ${colors.brightYellow} ${git.summary}${colors.reset}`;
          } else {
            gitTag = ` ${colors.gray} ${git.branch}${colors.reset}`;
          }
        }

        lines.push(`     ${statusBadge}${gitTag}`);
      }
    }

    // Modal / Input Overlay or Shortcuts
    lines.push('');
    lines.push(`${colors.gray}${drawLine(width, '─')}${colors.reset}`);

    if (this.mode === 'add' || this.mode === 'edit') {
      lines.push(`${colors.bold}${colors.brightMagenta} ✍️  ${this.mode === 'add' ? 'ADD BOOKMARK' : 'EDIT BOOKMARK'}${colors.reset}`);
      lines.push(` ${colors.yellow}${this.inputPrompt}${colors.reset}`);
      lines.push(` ${colors.brightGreen}❯ ${this.inputValue}${colors.brightCyan}█${colors.reset}`);
      lines.push(`${colors.dim} [Enter] Confirm │ [Esc] Cancel${colors.reset}`);
    } else if (this.mode === 'delete_confirm') {
      const current = this.getCurrentBookmark();
      lines.push(`${colors.bold}${colors.brightRed} ⚠️  DELETE THIS BOOKMARK?${colors.reset}`);
      lines.push(` "${truncate(current ? current.name : '', width - 4)}"`);
      lines.push(` ${colors.yellow}Confirm deletion? (y/N)${colors.reset}`);
    } else if (this.mode === 'quit_confirm') {
      lines.push(`${colors.bold}${colors.brightYellow} ❓  QUIT CLI-AGENT?${colors.reset}`);
      lines.push(` ${colors.gray}Close session and terminals? (y/N)${colors.reset}`);
    } else if (this.mode === 'select_agent') {
      lines.push(`${colors.bold}${colors.brightCyan} 🤖  CHOOSE AGENT TO LAUNCH${colors.reset}`);
      this.agents.forEach((agent, idx) => {
        const isSel = idx === this.agentMenuIndex;
        const icon = isSel ? '▶ ' : '  ';
        const tag = agent.installed ? `${colors.green}✓${colors.reset}` : `${colors.gray}not installed${colors.reset}`;
        if (isSel) {
          lines.push(` ${colors.brightGreen}${icon}${agent.name}${colors.reset} ${tag}`);
        } else {
          lines.push(` ${icon}${colors.white}${agent.name}${colors.reset} ${tag}`);
        }
      });
      lines.push(`${colors.dim} [↑/↓] Select │ [Enter] Launch │ [Esc] Back${colors.reset}`);
    } else {
      // Normal Keyboard Legend
      lines.push(`${colors.bold}${colors.brightCyan} KEYBOARD SHORTCUTS${colors.reset}`);
      lines.push(` ${colors.brightGreen}[Enter]${colors.reset} Open folder (Shell)`);
      lines.push(` ${colors.brightGreen}[c]${colors.reset}      Launch Claude Code`);
      lines.push(` ${colors.brightGreen}[p]${colors.reset}      Launch GitHub Copilot`);
      lines.push(` ${colors.brightGreen}[a]${colors.reset}      New bookmark`);
      lines.push(` ${colors.brightGreen}[d]${colors.reset}      Delete bookmark`);
      lines.push(` ${colors.brightGreen}[r]${colors.reset}      Reset status`);
      lines.push(` ${colors.brightGreen}[Tab]${colors.reset}    Switch to terminal`);
      lines.push(` ${colors.brightGreen}[q]${colors.reset}      Quit`);
    }

    // Status Notification Message at the bottom
    if (this.statusMessage) {
      lines.push('');
      lines.push(`${colors.brightYellow}ℹ️  ${truncate(this.statusMessage, width - 5)}${colors.reset}`);
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
