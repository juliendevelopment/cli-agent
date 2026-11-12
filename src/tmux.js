const { execSync, spawnSync } = require('child_process');
const path = require('path');
const { recordActiveSession, getBookmarkKey, loadConfig, saveConfig } = require('./config');

const SESSION_NAME = 'cli_agent';
const DEFAULT_SIDEBAR_WIDTH = 26;

let activeBookmarkId = null;

function isTmuxInstalled() {
  try {
    execSync('which tmux 2>/dev/null', { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function isInsideTmux() {
  return Boolean(process.env.TMUX);
}

function sessionExists(session = SESSION_NAME) {
  try {
    execSync(`tmux has-session -t ${session} 2>/dev/null`, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function runTmux(args) {
  return spawnSync('tmux', args, { stdio: 'inherit' });
}

function runTmuxQuiet(args) {
  try {
    return execSync(`tmux ${args.join(' ')} 2>/dev/null`, { encoding: 'utf-8' });
  } catch (err) {
    return null;
  }
}

function getActiveBookmarkId() {
  try {
    const val = execSync(`tmux show-options -t ${SESSION_NAME} -v @active_bookmark_id 2>/dev/null`, {
      encoding: 'utf-8'
    }).trim();
    if (val) return val;
  } catch (err) {
    // tmux session might not exist or option not set yet
  }
  if (activeBookmarkId) return activeBookmarkId;
  try {
    const cfg = loadConfig();
    return cfg.activeBookmarkId || (cfg.bookmarks[0] ? getBookmarkKey(cfg.bookmarks[0]) : null);
  } catch (err) {
    return null;
  }
}

function setActiveBookmarkId(id) {
  if (!id) return;
  activeBookmarkId = id;
  try {
    execSync(`tmux set-option -t ${SESSION_NAME} @active_bookmark_id "${id}" 2>/dev/null`, { stdio: 'ignore' });
  } catch (err) {
    // Ignore
  }
}

function hasBookmarkWindow(bookmarkKey) {
  try {
    const safeKey = typeof bookmarkKey === 'object' ? getBookmarkKey(bookmarkKey) : String(bookmarkKey).replace(/[^a-zA-Z0-9_-]/g, '_');
    const list = execSync(`tmux list-windows -t ${SESSION_NAME} -F '#{window_name}' 2>/dev/null`, {
      encoding: 'utf-8'
    });
    const targetName = `_pane_${safeKey}`;
    return list.split('\n').map(s => s.trim()).includes(targetName);
  } catch (err) {
    return false;
  }
}

function switchToBookmark(targetBookmark, agentCommand = '', focus = true) {
  if (!targetBookmark) return;
  const targetId = getBookmarkKey(targetBookmark);
  const currentId = getActiveBookmarkId();
  const shellCmd = process.env.SHELL || '/bin/bash';

  // If already visible in the right pane:
  if (targetId === currentId) {
    if (agentCommand && agentCommand.trim()) {
      execSync(`tmux send-keys -t ${SESSION_NAME}:0.1 '${agentCommand.trim()}' C-m`, { stdio: 'ignore' });
    }
    if (focus) focusPane(1);
    return;
  }

  // If we are switching from another bookmark:
  if (currentId) {
    // 1. Ensure the target bookmark's window exists or create it
    if (!hasBookmarkWindow(targetId)) {
      // First time opening this bookmark: create independent background window
      execSync(
        `tmux new-window -d -t ${SESSION_NAME} -n "_pane_${targetId}" -c "${targetBookmark.path}" "${shellCmd}"`,
        { stdio: 'ignore' }
      );
    }

    // 2. Swap visible right pane (0.1) with background window _pane_${targetId}.0
    execSync(`tmux swap-pane -s ${SESSION_NAME}:0.1 -t ${SESSION_NAME}:_pane_${targetId}.0`, { stdio: 'ignore' });

    // 3. Remove stale currentId window if any to avoid duplicate name collision
    if (hasBookmarkWindow(currentId)) {
      try {
        execSync(`tmux kill-window -t ${SESSION_NAME}:_pane_${currentId}`, { stdio: 'ignore' });
      } catch (err) {}
    }

    // 4. Rename background window (which now holds currentId's pane)
    execSync(`tmux rename-window -t ${SESSION_NAME}:_pane_${targetId} "_pane_${currentId}"`, { stdio: 'ignore' });
  }

  // 5. Send command to the active visible pane if requested
  if (agentCommand && agentCommand.trim()) {
    execSync(`tmux send-keys -t ${SESSION_NAME}:0.1 '${agentCommand.trim()}' C-m`, { stdio: 'ignore' });
  }

  // 6. Update active bookmark state in tmux and in config
  setActiveBookmarkId(targetId);
  recordActiveSession(targetId);

  // 7. Synchronize selectedIndex in config so sidebar cursor matches
  try {
    const cfg = loadConfig();
    const idx = cfg.bookmarks.findIndex(b => getBookmarkKey(b) === targetId);
    if (idx !== -1 && cfg.selectedIndex !== idx) {
      cfg.selectedIndex = idx;
      saveConfig(cfg);
    }
  } catch (err) {}

  if (focus) {
    focusPane(1);
  }
}

function closeBookmarkSession(bookmarkKeyOrObj) {
  try {
    const key = typeof bookmarkKeyOrObj === 'object'
      ? getBookmarkKey(bookmarkKeyOrObj)
      : String(bookmarkKeyOrObj).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (hasBookmarkWindow(key)) {
      execSync(`tmux kill-window -t ${SESSION_NAME}:_pane_${key}`, { stdio: 'ignore' });
    }
  } catch (err) {
    // Ignore
  }
}

function resizeSidebar(delta) {
  try {
    const dir = delta < 0 ? 'L' : 'R';
    const amount = Math.abs(delta);
    execSync(`tmux resize-pane -t ${SESSION_NAME}:0.0 -${dir} ${amount}`, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function setSidebarWidth(width) {
  try {
    execSync(`tmux resize-pane -t ${SESSION_NAME}:0.0 -x ${width}`, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function focusPane(paneIndex = 0) {
  try {
    execSync(`tmux select-pane -t ${SESSION_NAME}:0.${paneIndex}`, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function killSession(session = SESSION_NAME) {
  try {
    execSync(`tmux kill-session -t ${session} 2>/dev/null`, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function startWorkspace({ initialBookmark, scriptPath, initialWidth = DEFAULT_SIDEBAR_WIDTH }) {
  if (!isTmuxInstalled()) {
    console.error('Error: tmux is not installed on this system.');
    console.error('Please install tmux (e.g. sudo apt install tmux or sudo dnf install tmux).');
    process.exit(1);
  }

  const shellCmd = process.env.SHELL || '/bin/bash';
  const nodeBin = process.execPath;
  const sidebarScript = path.resolve(scriptPath);

  // If session already exists, attach to it
  if (sessionExists(SESSION_NAME)) {
    console.log(`Attaching to existing '${SESSION_NAME}' session...`);
    runTmux(['attach-session', '-t', SESSION_NAME]);
    return;
  }

  const envPrefix = process.env.XDG_CONFIG_HOME ? `XDG_CONFIG_HOME="${process.env.XDG_CONFIG_HOME}" ` : '';
  const sidebarCmd = `${envPrefix}${nodeBin} "${sidebarScript}" --sidebar`;
  const initialBookmarkObj = initialBookmark || (loadConfig().bookmarks[0] || null);
  const initialDir = initialBookmarkObj ? initialBookmarkObj.path : process.cwd();
  const initialId = getBookmarkKey(initialBookmarkObj);
  const safeWidth = Math.max(16, Math.min(60, initialWidth || DEFAULT_SIDEBAR_WIDTH));

  // Determine current terminal columns and rows so detached session matches client screen size
  const termCols = (process.stdout.columns && process.stdout.columns >= 40) ? process.stdout.columns : 180;
  const termRows = (process.stdout.rows && process.stdout.rows >= 10) ? process.stdout.rows : 40;

  // 1. Create detached session running sidebar in pane 0 with actual terminal dimensions
  execSync(`tmux new-session -d -s ${SESSION_NAME} -n "CLI-Agent" -x ${termCols} -y ${termRows} '${sidebarCmd}'`);

  // 2. Split horizontally: pane 1 on the right running shell in initialDir
  execSync(`tmux split-window -h -t ${SESSION_NAME}:0.0 -c "${initialDir}" "${shellCmd}"`);

  // 3. Set sidebar width (e.g. 26 columns or user-saved width)
  execSync(`tmux resize-pane -t ${SESSION_NAME}:0.0 -x ${safeWidth}`);

  // 4. Pin sidebar width when client attaches to prevent tmux auto-expand
  try {
    execSync(`tmux set-hook -t ${SESSION_NAME} client-attached "resize-pane -t ${SESSION_NAME}:0.0 -x ${safeWidth}"`);
  } catch (err) {}

  // 5. Configure mouse, clipboard, borders, and status line
  execSync(`tmux set-option -t ${SESSION_NAME} mouse on`);
  execSync(`tmux set-option -s set-clipboard on`);

  // Automatically pipe mouse drag selections into system clipboard (Wayland / X11 / macOS / OSC 52)
  const clipCmd = 'wl-copy 2>/dev/null || xclip -in -selection clipboard 2>/dev/null || pbcopy 2>/dev/null || true';
  try {
    execSync(`tmux bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "${clipCmd}"`);
    execSync(`tmux bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "${clipCmd}"`);
    execSync(`tmux bind-key -T copy-mode-vi DoubleClick1Pane select-pane \\; send-keys -X select-word \\; send-keys -X copy-pipe-and-cancel "${clipCmd}"`);
    execSync(`tmux bind-key -T copy-mode DoubleClick1Pane select-pane \\; send-keys -X select-word \\; send-keys -X copy-pipe-and-cancel "${clipCmd}"`);
    execSync(`tmux bind-key -T copy-mode-vi TripleClick1Pane select-pane \\; send-keys -X select-line \\; send-keys -X copy-pipe-and-cancel "${clipCmd}"`);
    execSync(`tmux bind-key -T copy-mode TripleClick1Pane select-pane \\; send-keys -X select-line \\; send-keys -X copy-pipe-and-cancel "${clipCmd}"`);
  } catch (err) {
    // Ignore binding failures on older tmux versions
  }

  execSync(`tmux set-option -t ${SESSION_NAME} status on`);
  execSync(`tmux set-option -t ${SESSION_NAME} status-style "bg=#1e1e2e,fg=#cdd6f4"`);
  execSync(`tmux set-option -t ${SESSION_NAME} status-left "#[bold,fg=#89b4fa] 🤖 CLI-AGENT #[default]│ "`);
  execSync(`tmux set-option -t ${SESSION_NAME} status-left-length 30`);
  execSync(
    `tmux set-option -t ${SESSION_NAME} status-right "#[fg=#a6adc8]Ctrl+E: Switcher │ Alt+←/Alt+h: Menu │ F3: Mouse #[default]"`
  );
  execSync(`tmux set-option -t ${SESSION_NAME} pane-border-style "fg=#313244"`);
  execSync(`tmux set-option -t ${SESSION_NAME} pane-active-border-style "fg=#89b4fa"`);

  // 5. Quick navigation, switcher & resize bindings
  const switcherCmd = `display-popup -w 56 -h 15 -b rounded -s "bg=#1e1e2e,fg=#cdd6f4" -S "fg=#89b4fa" -T " Recent Sessions (Ctrl+E) " -E '${envPrefix}${nodeBin} "${sidebarScript}" --switcher'`;
  execSync(`tmux bind-key -n C-e ${switcherCmd}`);
  execSync(`tmux bind-key -n M-e ${switcherCmd}`);

  execSync(`tmux bind-key -n M-Left select-pane -t ${SESSION_NAME}:0.0`);
  execSync(`tmux bind-key -n M-Right select-pane -t ${SESSION_NAME}:0.1`);
  execSync(`tmux bind-key -n M-h select-pane -t ${SESSION_NAME}:0.0`); // Alt+h jumps to sidebar
  execSync(`tmux bind-key -n M-l select-pane -t ${SESSION_NAME}:0.1`); // Alt+l jumps to terminal
  execSync(`tmux bind-key -n F1 select-pane -t ${SESSION_NAME}:0.0`);
  execSync(`tmux bind-key -n F2 select-pane -t ${SESSION_NAME}:0.1`);
  execSync(`tmux bind-key -n F3 set-option -g mouse`); // Toggle mouse on/off for easy native selection
  execSync(`tmux bind-key -n M-[ resize-pane -t ${SESSION_NAME}:0.0 -L 3`);
  execSync(`tmux bind-key -n M-] resize-pane -t ${SESSION_NAME}:0.0 -R 3`);

  // 6. Select sidebar pane initially
  execSync(`tmux select-pane -t ${SESSION_NAME}:0.0`);

  // 7. Record initial active bookmark ID
  setActiveBookmarkId(initialId);
  recordActiveSession(initialId);

  // 8. Attach session
  runTmux(['attach-session', '-t', SESSION_NAME]);
}

module.exports = {
  SESSION_NAME,
  DEFAULT_SIDEBAR_WIDTH,
  isTmuxInstalled,
  isInsideTmux,
  sessionExists,
  getActiveBookmarkId,
  setActiveBookmarkId,
  hasBookmarkWindow,
  switchToBookmark,
  closeBookmarkSession,
  resizeSidebar,
  setSidebarWidth,
  focusPane,
  killSession,
  startWorkspace
};
